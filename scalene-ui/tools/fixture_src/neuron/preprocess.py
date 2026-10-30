"""Streaming review reader and tokenization helpers."""
import json
import re
import unicodedata
from typing import Dict, Iterator, List

import torch

_TAGS = re.compile(r"<[^>]+>")
_SPACES = re.compile(r"\s+")


def normalize(text: str) -> str:
    text = _TAGS.sub(" ", text)
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("&amp;", "&").replace("&quot;", '"')
    return _SPACES.sub(" ", text).strip().lower()


class ReviewStream:
    """Cycle through a JSONL file of reviews, yielding lists of normalized texts."""

    def __init__(self, path: str, batch_size: int):
        self.path = path
        self.batch_size = batch_size
        self._iter = self._read()

    def _read(self) -> Iterator[str]:
        while True:
            with open(self.path, encoding="utf-8") as f:
                for line in f:
                    record = json.loads(line)
                    if record.get("lang", "en") != "en":
                        continue
                    yield normalize(record["text"])

    def __iter__(self) -> "ReviewStream":
        return self

    def __next__(self) -> List[str]:
        return [next(self._iter) for _ in range(self.batch_size)]


def encode_batch(tokenizer, texts: List[str], seq_len: int) -> Dict[str, torch.Tensor]:
    enc = tokenizer(
        texts,
        padding="max_length",
        truncation=True,
        max_length=seq_len,
        return_tensors="pt",
    )
    return {"input_ids": enc["input_ids"], "attention_mask": enc["attention_mask"]}


def length_histogram(texts: List[str], bucket: int = 32) -> Dict[int, int]:
    hist: Dict[int, int] = {}
    for t in texts:
        b = (len(t.split()) // bucket) * bucket
        hist[b] = hist.get(b, 0) + 1
    return dict(sorted(hist.items()))
