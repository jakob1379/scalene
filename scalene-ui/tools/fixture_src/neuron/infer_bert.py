"""Batch sentiment inference with a BERT encoder compiled for AWS Inferentia2.

    python infer_bert.py --batches 240 --batch-size 16
"""
import argparse
import os
import time

import numpy as np
import torch
import torch_neuronx
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from preprocess import ReviewStream, encode_batch

MODEL_ID = "distilbert-base-uncased-finetuned-sst-2-english"
SEQ_LEN = 128


def compile_model(model, tokenizer, batch_size: int, cache_dir: str):
    path = os.path.join(cache_dir, f"bert_b{batch_size}_s{SEQ_LEN}.pt")
    if os.path.exists(path):
        return torch.jit.load(path)
    example = tokenizer(
        ["warm-up sentence"] * batch_size,
        padding="max_length",
        truncation=True,
        max_length=SEQ_LEN,
        return_tensors="pt",
    )
    inputs = (example["input_ids"], example["attention_mask"])
    neuron_model = torch_neuronx.trace(model, inputs, compiler_args=["--auto-cast", "matmult"])
    torch.jit.save(neuron_model, path)
    return neuron_model


def softmax(logits: np.ndarray) -> np.ndarray:
    z = logits - logits.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batches", type=int, default=240)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--cache-dir", default="/var/tmp/neuron-cache")
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID, torchscript=True)
    model.eval()
    neuron_model = compile_model(model, tokenizer, args.batch_size, args.cache_dir)

    stream = ReviewStream("data/reviews.jsonl", batch_size=args.batch_size)
    for _ in range(8):
        warm = encode_batch(tokenizer, next(stream), SEQ_LEN)
        neuron_model(warm["input_ids"], warm["attention_mask"])

    positives = 0
    seen = 0
    started = time.perf_counter()
    for _ in range(args.batches):
        texts = next(stream)
        enc = encode_batch(tokenizer, texts, SEQ_LEN)
        logits = neuron_model(enc["input_ids"], enc["attention_mask"])[0]
        probs = softmax(logits.detach().numpy())
        positives += int((probs[:, 1] > 0.5).sum())
        seen += len(texts)
    elapsed = time.perf_counter() - started
    print(f"{seen} reviews in {elapsed:.2f}s -> {seen / elapsed:.0f}/s, {positives / seen:.1%} positive")


if __name__ == "__main__":
    main()
