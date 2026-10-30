"""A minimal byte-pair-encoding tokenizer compatible with GPT-2 vocab files."""
import json
import os
import re
from functools import lru_cache
from typing import Dict, List, Tuple

PAT = re.compile(r"""'s|'t|'re|'ve|'m|'ll|'d| ?\w+| ?\d+| ?[^\s\w\d]+|\s+(?!\S)|\s+""")


@lru_cache()
def bytes_to_unicode() -> Dict[int, str]:
    """Map every byte to a printable unicode character (the GPT-2 trick)."""
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("\xa1"), ord("\xac") + 1))
    bs += list(range(ord("\xae"), ord("\xff") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, (chr(c) for c in cs)))


def get_pairs(word: Tuple[str, ...]) -> set:
    return {(a, b) for a, b in zip(word, word[1:])}


class BPETokenizer:
    def __init__(self, encoder: Dict[str, int], merges: List[Tuple[str, str]]):
        self.encoder = encoder
        self.decoder = {v: k for k, v in encoder.items()}
        self.byte_encoder = bytes_to_unicode()
        self.byte_decoder = {v: k for k, v in self.byte_encoder.items()}
        self.bpe_ranks = dict(zip(merges, range(len(merges))))
        self.cache: Dict[str, str] = {}

    @classmethod
    def from_directory(cls, path: str) -> "BPETokenizer":
        with open(os.path.join(path, "encoder.json")) as f:
            encoder = json.load(f)
        with open(os.path.join(path, "vocab.bpe"), encoding="utf-8") as f:
            lines = f.read().split("\n")[1:-1]
        merges = [tuple(line.split()) for line in lines]
        return cls(encoder, merges)

    @property
    def vocab_size(self) -> int:
        # Round up to a multiple of 64 for faster matmuls.
        return (len(self.encoder) + 63) // 64 * 64

    def bpe(self, token: str) -> str:
        if token in self.cache:
            return self.cache[token]
        word = tuple(token)
        pairs = get_pairs(word)
        while pairs:
            bigram = min(pairs, key=lambda p: self.bpe_ranks.get(p, float("inf")))
            if bigram not in self.bpe_ranks:
                break
            first, second = bigram
            new_word: List[str] = []
            i = 0
            while i < len(word):
                if i < len(word) - 1 and word[i] == first and word[i + 1] == second:
                    new_word.append(first + second)
                    i += 2
                else:
                    new_word.append(word[i])
                    i += 1
            word = tuple(new_word)
            pairs = get_pairs(word)
        out = " ".join(word)
        self.cache[token] = out
        return out

    def encode(self, text: str) -> List[int]:
        ids: List[int] = []
        for token in PAT.findall(text):
            token = "".join(self.byte_encoder[b] for b in token.encode("utf-8"))
            ids.extend(self.encoder[t] for t in self.bpe(token).split(" "))
        return ids

    def decode(self, ids: List[int]) -> str:
        text = "".join(self.decoder[i] for i in ids)
        return bytearray(self.byte_decoder[c] for c in text).decode("utf-8", errors="replace")
