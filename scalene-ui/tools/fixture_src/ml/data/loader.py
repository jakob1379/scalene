"""Memory-mapped token datasets and a thread-based prefetching batch loader."""
import queue
import threading
from typing import Dict, Iterator, List

import numpy as np
import torch

Batch = Dict[str, torch.Tensor]


class PackedTokenDataset:
    """A contiguous uint16 token stream, sliced into (input, target) blocks."""

    def __init__(self, path: str, block_size: int):
        self.path = path
        self.block_size = block_size
        self.tokens = np.fromfile(path, dtype=np.uint16)
        self.n_blocks = (len(self.tokens) - 1) // block_size
        self._cache: Dict[int, Batch] = {}
        self.hits = 0
        self.misses = 0

    def __len__(self) -> int:
        return self.n_blocks

    def __getitem__(self, idx: int) -> Batch:
        if idx in self._cache:
            self.hits += 1
            return self._cache[idx]
        self.misses += 1
        start = idx * self.block_size
        chunk = self.tokens[start : start + self.block_size + 1].astype(np.int64)
        sample = {
            "input_ids": torch.from_numpy(chunk[:-1]),
            "targets": torch.from_numpy(chunk[1:]),
        }
        # FIXME: unbounded cache -- every block ever read stays alive.
        self._cache[idx] = sample
        return sample

    def stats(self) -> Dict[str, float]:
        total = self.hits + self.misses
        return {
            "blocks": float(self.n_blocks),
            "cached": float(len(self._cache)),
            "hit_rate": self.hits / total if total else 0.0,
        }


def collate(samples: List[Batch]) -> Batch:
    return {
        "input_ids": torch.stack([s["input_ids"] for s in samples]),
        "targets": torch.stack([s["targets"] for s in samples]),
    }


def random_token_dropout(batch: Batch, rate: float, rng: np.random.Generator) -> Batch:
    """Replace a small fraction of input tokens with the <unk> id (regularization)."""
    if rate <= 0:
        return batch
    mask = rng.random(batch["input_ids"].shape) < rate
    batch["input_ids"][torch.from_numpy(mask)] = 0
    return batch


class ThreadedPrefetcher:
    """Assemble batches on background threads and hand them to the training loop."""

    def __init__(
        self,
        dataset: PackedTokenDataset,
        batch_size: int,
        num_workers: int = 2,
        prefetch: int = 4,
        dropout: float = 0.02,
        seed: int = 0,
    ):
        self.dataset = dataset
        self.batch_size = batch_size
        self.dropout = dropout
        self.queue: "queue.Queue[Batch]" = queue.Queue(maxsize=prefetch)
        self._stop = threading.Event()
        self._rng = np.random.default_rng(seed)
        self._lock = threading.Lock()
        self._workers = [
            threading.Thread(target=self._worker, name=f"prefetch-{i}", daemon=True)
            for i in range(num_workers)
        ]
        for w in self._workers:
            w.start()

    def _next_indices(self) -> np.ndarray:
        with self._lock:
            return self._rng.integers(0, len(self.dataset), size=self.batch_size)

    def _worker(self) -> None:
        while not self._stop.is_set():
            indices = self._next_indices()
            samples = [self.dataset[int(i)] for i in indices]
            batch = collate(samples)
            batch = random_token_dropout(batch, self.dropout, self._rng)
            batch = {k: v.pin_memory() for k, v in batch.items()}
            while not self._stop.is_set():
                try:
                    self.queue.put(batch, timeout=0.1)
                    break
                except queue.Full:
                    continue

    def __iter__(self) -> Iterator[Batch]:
        return self

    def __next__(self) -> Batch:
        return self.queue.get()

    def close(self) -> None:
        self._stop.set()
        for w in self._workers:
            w.join(timeout=1.0)
