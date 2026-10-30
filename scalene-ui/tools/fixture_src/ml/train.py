"""Train a small GPT-style language model on a pre-tokenized corpus.

Usage:
    python train.py --config configs/gpt-small.json --max-steps 200

The loop uses bf16 autocast, gradient clipping and AdamW with a cosine
learning-rate schedule (linear warmup & cosine decay).
"""
import argparse
import json
import math
import os
import time
from dataclasses import asdict, dataclass

import numpy as np
import torch
import torch.nn.functional as F
from torch.cuda.amp import GradScaler

from data.loader import PackedTokenDataset, ThreadedPrefetcher
from data.tokenizer import BPETokenizer
from model.transformer import GPT, GPTConfig
from utils.metrics import MetricTracker, perplexity


@dataclass
class TrainConfig:
    data_dir: str = "data/openwebtext-mini"
    out_dir: str = "checkpoints"
    batch_size: int = 16
    block_size: int = 512
    n_layer: int = 8
    n_head: int = 8
    n_embd: int = 512
    dropout: float = 0.1
    lr: float = 6e-4
    min_lr: float = 6e-5
    weight_decay: float = 0.1
    beta1: float = 0.9
    beta2: float = 0.95
    warmup_steps: int = 20
    max_steps: int = 200
    eval_interval: int = 50
    eval_batches: int = 8
    max_grad_norm: float = 1.0
    num_workers: int = 3
    seed: int = 1337


def parse_args() -> TrainConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=str, default=None)
    parser.add_argument("--max-steps", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=None)
    args = parser.parse_args()
    cfg = TrainConfig()
    if args.config:
        with open(args.config) as f:
            overrides = json.load(f)
        for key, value in overrides.items():
            setattr(cfg, key, value)
    if args.max_steps is not None:
        cfg.max_steps = args.max_steps
    if args.batch_size is not None:
        cfg.batch_size = args.batch_size
    return cfg


def get_lr(step: int, cfg: TrainConfig) -> float:
    """Linear warmup followed by cosine decay down to min_lr."""
    if step < cfg.warmup_steps:
        return cfg.lr * (step + 1) / cfg.warmup_steps
    progress = (step - cfg.warmup_steps) / max(1, cfg.max_steps - cfg.warmup_steps)
    coeff = 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))
    return cfg.min_lr + coeff * (cfg.lr - cfg.min_lr)


def configure_optimizer(model: torch.nn.Module, cfg: TrainConfig) -> torch.optim.Optimizer:
    decay, no_decay = [], []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if param.dim() >= 2:
            decay.append(param)
        else:
            no_decay.append(param)
    groups = [
        {"params": decay, "weight_decay": cfg.weight_decay},
        {"params": no_decay, "weight_decay": 0.0},
    ]
    return torch.optim.AdamW(groups, lr=cfg.lr, betas=(cfg.beta1, cfg.beta2), foreach=True)


@torch.no_grad()
def evaluate(model, loader, device, cfg: TrainConfig) -> float:
    model.eval()
    losses = torch.zeros(cfg.eval_batches)
    for i in range(cfg.eval_batches):
        batch = next(loader)
        x = batch["input_ids"].to(device, non_blocking=True)
        y = batch["targets"].to(device, non_blocking=True)
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            logits = model(x)
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1))
        losses[i] = loss.item()
    model.train()
    return losses.mean().item()


def save_checkpoint(model, optimizer, step: int, cfg: TrainConfig) -> str:
    os.makedirs(cfg.out_dir, exist_ok=True)
    path = os.path.join(cfg.out_dir, f"ckpt_{step:06d}.pt")
    state = {
        "model": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "step": step,
        "config": asdict(cfg),
    }
    torch.save(state, path)
    return path


def train(cfg: TrainConfig) -> None:
    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)
    device = torch.device("cuda")
    torch.backends.cuda.matmul.allow_tf32 = True

    tokenizer = BPETokenizer.from_directory(cfg.data_dir)
    train_set = PackedTokenDataset(os.path.join(cfg.data_dir, "train.bin"), cfg.block_size)
    val_set = PackedTokenDataset(os.path.join(cfg.data_dir, "val.bin"), cfg.block_size)
    train_loader = ThreadedPrefetcher(train_set, cfg.batch_size, num_workers=cfg.num_workers)
    val_loader = ThreadedPrefetcher(val_set, cfg.batch_size, num_workers=1, seed=1)

    model_cfg = GPTConfig(
        vocab_size=tokenizer.vocab_size,
        block_size=cfg.block_size,
        n_layer=cfg.n_layer,
        n_head=cfg.n_head,
        n_embd=cfg.n_embd,
        dropout=cfg.dropout,
    )
    model = GPT(model_cfg)
    model = model.to(device)
    optimizer = configure_optimizer(model, cfg)
    scaler = GradScaler()
    tracker = MetricTracker(log_every=10)

    print(f"model has {model.num_parameters() / 1e6:.1f}M parameters")
    t0 = time.perf_counter()
    for step in range(cfg.max_steps):
        lr = get_lr(step, cfg)
        for group in optimizer.param_groups:
            group["lr"] = lr

        batch = next(train_loader)
        x = batch["input_ids"].to(device, non_blocking=True)
        y = batch["targets"].to(device, non_blocking=True)

        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            logits = model(x)
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1))

        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), cfg.max_grad_norm)
        scaler.step(optimizer)
        scaler.update()
        optimizer.zero_grad(set_to_none=True)

        # .item() forces a host/device sync every step.
        loss_value = loss.item()
        tracker.update(step, loss_value, logits, y, grad_norm=grad_norm)

        if step % tracker.log_every == 0:
            elapsed = time.perf_counter() - t0
            tokens_per_sec = (step + 1) * cfg.batch_size * cfg.block_size / elapsed
            print(f"step {step:5d} | loss {loss_value:.4f} | lr {lr:.2e} | {tokens_per_sec:,.0f} tok/s")

        if step > 0 and step % cfg.eval_interval == 0:
            val_loss = evaluate(model, val_loader, device, cfg)
            print(f"step {step:5d} | val loss {val_loss:.4f} | ppl {perplexity(val_loss):.2f}")
            tracker.log_eval(step, val_loss)

    save_checkpoint(model, optimizer, cfg.max_steps, cfg)
    tracker.write_summary(os.path.join(cfg.out_dir, "metrics.json"))
    train_loader.close()
    val_loader.close()


if __name__ == "__main__":
    train(parse_args())
