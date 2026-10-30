"""Thin async data-access layer over an asyncpg connection pool."""
from typing import Dict, List, Optional, Sequence

import asyncpg

PRODUCT_COLUMNS = "id, sku, title, description, category_id, stock, rating, image_url"


class Database:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool
        self.queries = 0

    @classmethod
    async def connect(cls, dsn: str, min_size: int = 2, max_size: int = 8) -> "Database":
        pool = await asyncpg.create_pool(dsn, min_size=min_size, max_size=max_size, command_timeout=5)
        return cls(pool)

    async def close(self) -> None:
        await self.pool.close()

    async def fetch_categories(self) -> List[Dict[str, object]]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, name, parent_id FROM categories ORDER BY id")
        self.queries += 1
        return [dict(r) for r in rows]

    async def fetch_product(self, product_id: int) -> Optional[Dict[str, object]]:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                f"SELECT {PRODUCT_COLUMNS} FROM products WHERE id = $1", product_id
            )
        self.queries += 1
        return dict(row) if row is not None else None

    async def fetch_many(self, product_ids: Sequence[int]) -> List[Dict[str, object]]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT {PRODUCT_COLUMNS} FROM products WHERE id = ANY($1::int[])",
                list(product_ids),
            )
        self.queries += 1
        return [dict(r) for r in rows]

    async def search_products(self, query: str, limit: int = 40) -> List[Dict[str, object]]:
        sql = (
            f"SELECT {PRODUCT_COLUMNS}, ts_rank(search_vec, q) AS rank "
            "FROM products, plainto_tsquery('english', $1) q "
            "WHERE search_vec @@ q ORDER BY rank DESC LIMIT $2"
        )
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(sql, query, limit)
        self.queries += 1
        return [dict(r) for r in rows]

    async def insert_order(self, user: str, cart: Sequence[int], total: float) -> int:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                order_id = await conn.fetchval(
                    "INSERT INTO orders (user_name, total) VALUES ($1, $2) RETURNING id",
                    user,
                    total,
                )
                await conn.executemany(
                    "INSERT INTO order_items (order_id, product_id) VALUES ($1, $2)",
                    [(order_id, pid) for pid in cart],
                )
        self.queries += 2
        return order_id

    async def hot_product_ids(self, limit: int = 200) -> List[int]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT product_id FROM product_views_1h ORDER BY views DESC LIMIT $1", limit
            )
        self.queries += 1
        return [r["product_id"] for r in rows]
