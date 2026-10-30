"""In-process load test for the catalog API.

Starts the service against the staging database and cache, then drives it
with N concurrent synthetic clients for a fixed duration and prints
latency percentiles.

    python bench_server.py --clients 12 --duration 15
"""
import argparse
import asyncio
import random
import statistics
import time
from typing import Dict, List

from catalog.cache import ResponseCache
from catalog.db import Database
from catalog.handlers import CatalogService

QUERIES = [
    f"{material} {item}"
    for material in ("oak", "walnut", "steel", "linen", "rattan", "velvet", "marble", "glass")
    for item in ("lamp", "desk", "chair", "rug", "shelf", "sofa", "bed", "mirror")
]
ROUTES = (
    ("GET /products/{id}", 0.60),
    ("GET /search", 0.25),
    ("POST /checkout", 0.15),
)


def pick_route(rng: random.Random) -> str:
    x = rng.random()
    acc = 0.0
    for route, weight in ROUTES:
        acc += weight
        if x < acc:
            return route
    return ROUTES[-1][0]


async def client(service: CatalogService, client_id: int, deadline: float, latencies: Dict[str, List[float]]) -> int:
    rng = random.Random(client_id)
    sent = 0
    token = service.issue_token(f"user-{client_id}")
    while time.monotonic() < deadline:
        route = pick_route(rng)
        started = time.perf_counter()
        if route == "GET /products/{id}":
            await service.get_product(rng.randint(1, 50_000), token)
        elif route == "GET /search":
            await service.search(rng.choice(QUERIES), token)
        else:
            cart = [rng.randint(1, 50_000) for _ in range(rng.randint(1, 6))]
            await service.checkout(cart, token)
        latencies[route].append((time.perf_counter() - started) * 1000.0)
        sent += 1
        # Think time between requests.
        await asyncio.sleep(rng.uniform(0.005, 0.025))
    return sent


def report(latencies: Dict[str, List[float]], elapsed: float, total: int) -> None:
    print(f"{total} requests in {elapsed:.1f}s ({total / elapsed:.0f} req/s)")
    for route, values in sorted(latencies.items()):
        if len(values) < 2:
            continue
        q = statistics.quantiles(values, n=100)
        print(f"  {route:<22} n={len(values):6d}  p50={q[49]:7.2f}ms  p95={q[94]:7.2f}ms  p99={q[98]:7.2f}ms")


async def main(args: argparse.Namespace) -> None:
    db = await Database.connect(args.dsn, min_size=4, max_size=args.pool_size)
    cache = ResponseCache(args.redis_url, ttl=30, local_size=256)
    service = CatalogService(db, cache)
    await service.warm_up()
    refresher = asyncio.create_task(cache.refresh_hot_keys(db), name="cache-refresher")
    flusher = asyncio.create_task(service.flush_metrics(), name="metrics-flusher")
    latencies: Dict[str, List[float]] = {route: [] for route, _ in ROUTES}
    deadline = time.monotonic() + args.duration
    started = time.perf_counter()
    counts = await asyncio.gather(
        *(client(service, i, deadline, latencies) for i in range(args.clients))
    )
    elapsed = time.perf_counter() - started
    refresher.cancel()
    flusher.cancel()
    await db.close()
    report(latencies, elapsed, sum(counts))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clients", type=int, default=12)
    parser.add_argument("--duration", type=float, default=15.0)
    parser.add_argument("--pool-size", type=int, default=8)
    parser.add_argument("--dsn", default="postgresql://catalog@db.staging.internal/catalog")
    parser.add_argument("--redis-url", default="redis://cache.staging.internal:6379/0")
    asyncio.run(main(parser.parse_args()))
