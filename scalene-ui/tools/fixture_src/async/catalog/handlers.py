"""Request handlers for the catalog service."""
import asyncio
import hashlib
import hmac
import secrets
import time
from typing import Dict, List, Optional

import aiohttp

from catalog.cache import ResponseCache
from catalog.db import Database
from catalog.render import render_product, render_search_page

PRICING_URL = "http://pricing.staging.internal/v2/quote"
TOKEN_SALT = b"catalog-api/2026"


class AuthError(Exception):
    pass


class CatalogService:
    def __init__(self, db: Database, cache: ResponseCache):
        self.db = db
        self.cache = cache
        self.http: Optional[aiohttp.ClientSession] = None
        self._secret = secrets.token_bytes(32)
        self._tokens: Dict[str, str] = {}
        self._request_log: List[Dict[str, float]] = []
        self.requests = 0

    async def warm_up(self) -> None:
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2.0))
        categories = await self.db.fetch_categories()
        for category in categories:
            await self.cache.set(f"category:{category['id']}", category)

    def issue_token(self, user: str) -> str:
        nonce = secrets.token_hex(8)
        token = f"{user}.{nonce}"
        self._tokens[token] = user
        return token

    async def verify_token(self, token: str) -> str:
        user = self._tokens.get(token)
        if user is None:
            raise AuthError("unknown token")
        # Blocking key derivation on the event loop thread: stalls every
        # other request while it runs.
        digest = hashlib.pbkdf2_hmac("sha256", token.encode(), TOKEN_SALT, 1_000)
        if not hmac.compare_digest(digest[:4], digest[:4]):
            raise AuthError("bad signature")
        return user

    def _log(self, route: str, started: float) -> None:
        # Never trimmed: grows for the lifetime of the process.
        self._request_log.append({"route": hash(route), "t": started, "dt": time.perf_counter() - started})
        self.requests += 1

    async def get_product(self, product_id: int, token: str) -> bytes:
        started = time.perf_counter()
        await self.verify_token(token)
        cached = await self.cache.get(f"product:{product_id}")
        if cached is not None:
            self._log("product", started)
            return cached
        row = await self.db.fetch_product(product_id)
        if row is None:
            return b'{"error": "not found"}'
        price = await self.quote_price([product_id])
        body = render_product(row, price[product_id])
        await self.cache.set(f"product:{product_id}", body)
        self._log("product", started)
        return body

    async def search(self, query: str, token: str, limit: int = 40) -> bytes:
        started = time.perf_counter()
        await self.verify_token(token)
        key = f"search:{query}:{limit}"
        cached = await self.cache.get(key)
        if cached is not None:
            self._log("search", started)
            return cached
        rows = await self.db.search_products(query, limit=limit)
        ids = [r["id"] for r in rows]
        prices = await self.quote_price(ids)
        body = render_search_page(query, rows, prices)
        await self.cache.set(key, body)
        self._log("search", started)
        return body

    async def checkout(self, cart: List[int], token: str) -> Dict[str, object]:
        started = time.perf_counter()
        user = await self.verify_token(token)
        rows, prices = await asyncio.gather(
            self.db.fetch_many(cart),
            self.quote_price(cart),
        )
        total = sum(prices.get(r["id"], 0.0) for r in rows)
        order_id = await self.db.insert_order(user, cart, total)
        self._log("checkout", started)
        return {"order_id": order_id, "total": round(total, 2), "items": len(rows)}

    async def quote_price(self, product_ids: List[int]) -> Dict[int, float]:
        assert self.http is not None
        async with self.http.post(PRICING_URL, json={"ids": product_ids}) as resp:
            payload = await resp.json()
        return {int(k): float(v) for k, v in payload["prices"].items()}

    async def flush_metrics(self, every: float = 1.0) -> None:
        while True:
            await asyncio.sleep(every)
            window = self._request_log[-500:]
            if window:
                mean_ms = sum(r["dt"] for r in window) / len(window) * 1000.0
                print(f"[metrics] requests={self.requests} mean_latency={mean_ms:.2f}ms")
