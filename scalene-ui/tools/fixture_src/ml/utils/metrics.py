"""Running training metrics: loss EMA, token accuracy, gradient norms."""
import json
import math
import time
from collections import defaultdict
from typing import Dict, List, Optional

import torch


def perplexity(loss: float) -> float:
    return math.exp(min(loss, 20.0))


class MetricTracker:
    def __init__(self, log_every: int = 10, ema_beta: float = 0.98):
        self.log_every = log_every
        self.ema_beta = ema_beta
        self.ema_loss: Optional[float] = None
        self.history: Dict[str, List[float]] = defaultdict(list)
        self.eval_history: List[Dict[str, float]] = []
        # Kept for the end-of-run calibration plot.
        self.last_token_logits: List[torch.Tensor] = []
        self.started = time.time()

    def update(
        self,
        step: int,
        loss: float,
        logits: torch.Tensor,
        targets: torch.Tensor,
        grad_norm: Optional[torch.Tensor] = None,
    ) -> None:
        if self.ema_loss is None:
            self.ema_loss = loss
        else:
            self.ema_loss = self.ema_beta * self.ema_loss + (1 - self.ema_beta) * loss
        preds = logits.argmax(dim=-1)
        accuracy = (preds == targets).float().mean().item()
        # BUG: copies the full vocab distribution of the last position to host memory
        # every step and never releases it.
        self.last_token_logits.append(logits[:, -1, :].detach().float().cpu())
        self.history["loss"].append(loss)
        self.history["ema_loss"].append(self.ema_loss)
        self.history["accuracy"].append(accuracy)
        if grad_norm is not None:
            self.history["grad_norm"].append(float(grad_norm))
        self.history["step"].append(step)

    def log_eval(self, step: int, val_loss: float) -> None:
        self.eval_history.append(
            {"step": step, "val_loss": val_loss, "val_ppl": perplexity(val_loss)}
        )

    def summary(self) -> Dict[str, float]:
        losses = self.history["loss"]
        if not losses:
            return {}
        tail = losses[-self.log_every :]
        return {
            "steps": float(len(losses)),
            "final_loss": tail[-1],
            "mean_tail_loss": sum(tail) / len(tail),
            "best_val_loss": min((e["val_loss"] for e in self.eval_history), default=float("nan")),
            "wall_time_s": time.time() - self.started,
        }

    def write_summary(self, path: str) -> None:
        payload = {
            "summary": self.summary(),
            "history": dict(self.history),
            "eval": self.eval_history,
        }
        with open(path, "w") as f:
            json.dump(payload, f, indent=2)
