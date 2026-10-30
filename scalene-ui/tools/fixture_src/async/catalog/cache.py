"""Read-through response cache backed by Redis, with a small local LRU in front."""
import asyncio
import pickle
from collections import OrderedDict
from typing import Any, Optional

import redis.asyncio as redis


class ResponseCache:
    def __init__(self, url: str, ttl: int = 30, local_size: int = 4096):
        self.client = redis.from_url(url, decode_responses=False)
        self.ttl = ttl
        self.local: "OrderedDict[str, Any]" = OrderedDict()
        self.local_size = local_size
        self.hits = 0
        self.misses = 0

    async def get(self, key: str) -> Optional[Any]:
        if key in self.local:
            self.local.move_to_end(key)
            self.hits += 1
            return self.local[key]
        raw = await self.client.get(key)
        if raw is None:
            self.misses += 1
            return None
        value = pickle.loads(raw)
        self._remember(key, value)
        self.hits += 1
        return value

    async def set(self, key: str, value: Any) -> None:
        self._remember(key, value)
        await self.client.set(key, pickle.dumps(value), ex=self.ttl)

    def _remember(self, key: str, value: Any) -> None:
        self.local[key] = value
        self.local.move_to_end(key)
        while len(self.local) > self.local_size:
            self.local.popitem(last=False)

    async def refresh_hot_keys(self, db, every: float = 2.0) -> None:
        """Background task: keep the most viewed products warm."""
        while True:
            ids = await db.hot_product_ids()
            for product_id in ids:
                if f"product:{product_id}" not in self.local:
                    row = await db.fetch_product(product_id)
                    if row is not None:
                        self._remember(f"product:{product_id}", row)
            await asyncio.sleep(every)

    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0
