#!/usr/bin/env python3
"""Validate the Scalene JSON fixtures in fixtures/.

    python3 tools/validate_fixtures.py [--upstream DIR] [--check-convert] [FILE ...]

Two layers:

1. Schema (when pydantic is importable and the upstream checkout is present):
   the pydantic classes are lifted out of upstream ``scalene/scalene_json.py``
   with ``ast`` (importing the module itself would pull in cloudpickle and the
   rest of Scalene) and every current-format fixture is validated with
   ``ScaleneJSONSchema.model_validate``. That runs upstream's own validators
   (py+c+sys <= 100 per line, avg <= peak, GPU avg <= peak, ...). The two
   legacy samples (example.json, basic.json) predate required fields such as
   ``start_time_perf``; for them only "missing field" errors are tolerated.

2. Invariants (stdlib, always): the semantic contract the UI relies on, which
   the schema does not check -- per-file CPU sums, files sum <= 100, dense line
   numbering, sorted sparklines within the run, cpu_samples_list inside the
   perf_counter window, valid region bounds, timeline order / stack_index /
   per-index count <= hits, frame shape (py before native), memory_stacks <=
   allocation volume, leaks keyed by valid line numbers, async await % summing
   to ~100, Neuron merge consistency, the memory=false / gpu=false zero
   contract, and the &/</> escaping of source lines.

Exit status is non-zero if anything fails.
"""
from __future__ import annotations

import argparse
import ast
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURES = ROOT / "fixtures"
DEFAULT_UPSTREAM = Path(os.environ.get("SCALENE_SRC", ROOT.parent))  # scalene-ui/ sits in a Scalene checkout
LEGACY = {"example.json", "basic.json"}
EPS = 1e-6

LINE_FIELDS = [
    "line", "lineno", "memory_samples", "n_avg_mb", "n_copy_mb_s", "n_cpu_percent_c", "n_cpu_percent_python",
    "n_gpu_percent", "n_growth_mb", "n_malloc_mb", "n_mallocs", "n_peak_mb", "n_python_fraction", "n_sys_percent",
    "n_usage_fraction",
]
MODERN_LINE_FIELDS = LINE_FIELDS + [
    "cpu_samples_list", "n_core_utilization", "n_gpu_avg_memory_mb", "n_gpu_peak_memory_mb",
    "n_async_await_percent", "n_async_concurrency_mean", "n_async_concurrency_peak", "async_task_names",
    "is_coroutine", "start_region_line", "end_region_line", "start_outermost_loop", "end_outermost_loop",
    "start_function_line", "end_function_line",
]
REGION_FIELDS = {"start_region_line", "end_region_line", "start_outermost_loop", "end_outermost_loop",
                 "start_function_line", "end_function_line"}
MODERN_TOP = [
    "alloc_samples", "args", "async_profile", "combined_stacks", "combined_stacks_timeline", "elapsed_time_sec",
    "entrypoint_dir", "filename", "files", "gpu", "gpu_device", "growth_rate", "main_thread_id",
    "max_footprint_fname", "max_footprint_lineno", "max_footprint_mb", "max_footprint_python_fraction", "memory",
    "memory_stacks", "native_allocations_mb", "program", "samples", "stacks", "start_time_absolute",
    "start_time_perf",
]
FRAME_KEYS = {"kind", "display_name", "filename_or_module", "line", "ip", "offset"}


# ---------------------------------------------------------------------------
# Upstream pydantic schema, extracted with ast
# ---------------------------------------------------------------------------

SCHEMA_NAMES = [
    "CombinedStackTimelineEvent", "CombinedStackFrame", "GPUDevice", "FunctionDetail", "LineDetail",
    "LeakInfo", "FileDetail", "CombinedStackEntry", "MemoryStackEntry", "ScaleneJSONSchema",
]


def load_upstream_schema(upstream: Path) -> Optional[Dict[str, Any]]:
    try:
        import pydantic  # noqa: F401
    except ImportError:
        print("note: pydantic not importable; skipping upstream schema validation")
        return None
    path = upstream / "scalene" / "scalene_json.py"
    if not path.exists():
        print(f"note: {path} not found; skipping upstream schema validation")
        return None
    tree = ast.parse(path.read_text(encoding="utf-8"))
    keep: List[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name in SCHEMA_NAMES:
            keep.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in SCHEMA_NAMES for t in node.targets
        ):
            keep.append(node)
    found = {n.name if isinstance(n, ast.ClassDef) else n.targets[0].id for n in keep}  # type: ignore[union-attr]
    missing = set(SCHEMA_NAMES) - found
    if missing:
        print(f"warning: upstream schema lacks {sorted(missing)}; skipping")
        return None
    prelude = (
        "import math\n"
        "from enum import Enum\n"
        "from typing import Any, Dict, List, NewType, Optional, Tuple\n"
        "from pydantic import BaseModel, Field, NonNegativeFloat, NonNegativeInt, PositiveInt, StrictBool, model_validator\n"
        "Filename = NewType('Filename', str)\n"
        "LineNumber = NewType('LineNumber', PositiveInt)\n"
    )
    import types

    mod = types.ModuleType("scalene_json_schema_extract")
    sys.modules[mod.__name__] = mod  # pydantic resolves annotations through sys.modules
    ns = mod.__dict__
    # dont_inherit: this file's `from __future__ import annotations` must not turn
    # the upstream annotations into strings.
    exec(compile(prelude, "<schema-prelude>", "exec", dont_inherit=True), ns)  # noqa: S102 - trusted upstream source
    module = ast.Module(body=keep, type_ignores=[])
    exec(compile(module, str(path), "exec", dont_inherit=True), ns)  # noqa: S102
    return ns


def schema_check(name: str, data: Dict[str, Any], ns: Dict[str, Any], errors: List[str]) -> str:
    from pydantic import ValidationError

    if not data:
        return "skipped (empty profile)"
    try:
        ns["ScaleneJSONSchema"].model_validate(data)
        return "ok"
    except ValidationError as exc:
        errs = exc.errors()
        if name in LEGACY:
            other = [e for e in errs if e.get("type") != "missing"]
            if other:
                for e in other[:10]:
                    errors.append(f"schema: {e.get('loc')}: {e.get('msg')}")
                return f"FAILED ({len(other)} non-missing errors)"
            fields = sorted({".".join(str(x) for x in e["loc"] if not isinstance(x, int)) for e in errs})
            shown = ", ".join(f.split(".")[-1] for f in fields[:6])
            return f"legacy: {len(errs)} missing-field errors as expected ({shown}{', ...' if len(fields) > 6 else ''})"
        for e in errs[:15]:
            errors.append(f"schema: {e.get('loc')}: {e.get('msg')}")
        return f"FAILED ({len(errs)} errors)"


# ---------------------------------------------------------------------------
# Invariants
# ---------------------------------------------------------------------------


class Checker:
    def __init__(self, name: str, data: Dict[str, Any]):
        self.name = name
        self.d = data
        self.errors: List[str] = []
        self.warnings: Dict[str, int] = {}
        self.legacy = name in LEGACY

    def err(self, msg: str) -> None:
        if len(self.errors) < 60:
            self.errors.append(msg)

    def expect(self, cond: bool, msg: str) -> None:
        if not cond:
            self.err(msg)

    def quirk(self, cond: bool, kind: str, msg: str) -> None:
        """Hard error for current-format fixtures; counted legacy quirk for upstream's old samples."""
        if cond:
            return
        if self.legacy:
            self.warnings[kind] = self.warnings.get(kind, 0) + 1
        else:
            self.err(msg)

    def num(self, v: Any) -> bool:
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

    def run(self) -> List[str]:
        d = self.d
        if d == {}:
            return []
        for k in ["elapsed_time_sec", "memory", "gpu", "growth_rate", "max_footprint_mb", "samples", "files"]:
            self.expect(k in d, f"top-level field {k!r} missing")
        if not self.legacy:
            for k in MODERN_TOP:
                self.expect(k in d, f"top-level field {k!r} missing")
        elapsed = d.get("elapsed_time_sec", 0)
        self.expect(self.num(elapsed) and elapsed > 0, "elapsed_time_sec must be > 0")
        self.expect(isinstance(d.get("memory"), bool) and isinstance(d.get("gpu"), bool), "memory/gpu must be booleans")
        if "gpu_device" in d:
            self.expect(d["gpu_device"] in ("GPU", "Neuron", ""), f"gpu_device {d['gpu_device']!r}")
        maxfp = d.get("max_footprint_mb", 0)
        self.expect(self.num(maxfp) and maxfp >= 0, "max_footprint_mb must be >= 0")
        if "max_footprint_python_fraction" in d:
            self.expect(0 <= d["max_footprint_python_fraction"] <= 1, "max_footprint_python_fraction in [0,1]")
        t_max_ns = elapsed * 1e9
        self.check_samples(d.get("samples", []), "samples", maxfp, t_max_ns, cap=None if self.legacy else 100)
        if not d.get("memory"):
            self.expect(d.get("samples") == [], "memory=false but samples non-empty")
            self.expect(d.get("max_footprint_mb") == 0, "memory=false but max_footprint_mb != 0")
            self.expect(d.get("growth_rate") == 0, "memory=false but growth_rate != 0")
            self.expect(not d.get("memory_stacks"), "memory=false but memory_stacks non-empty")
        fname = d.get("max_footprint_fname")
        if fname is not None:
            self.expect(fname in d["files"], f"max_footprint_fname {fname!r} not in files")
            ln = d.get("max_footprint_lineno")
            if ln is not None and fname in d["files"]:
                self.expect(any(l["lineno"] == ln for l in d["files"][fname]["lines"]), "max_footprint_lineno not a line")
        neuron = any(
            ("nrt_time_ms" in l or "cpu_samples_nc_overlap_percent" in l)
            for f in d["files"].values() for l in f["lines"]
        )
        total_cpu = 0.0
        usage = 0.0
        malloc_total = 0.0
        await_total = 0.0
        for fn, f in d["files"].items():
            pc, us, ma, aw = self.check_file(fn, f, maxfp, elapsed, neuron)
            total_cpu += f["percent_cpu_time"]
            usage += us
            malloc_total += ma
            await_total += aw
        self.expect(total_cpu <= 100 + 1e-6, f"files sum to {total_cpu:.6f}% > 100")
        self.expect(usage <= 1 + 1e-6, f"n_usage_fraction sums to {usage} > 1")
        if d.get("async_profile"):
            self.expect(abs(await_total - 100) < 0.5, f"await % sums to {await_total:.3f}, expected ~100")
        self.check_stacks(d, elapsed, malloc_total)
        if neuron:
            self.check_neuron_top(d)
        return self.errors

    def check_samples(self, samples: Any, where: str, maxfp: float, t_max_ns: float, cap: Optional[int]) -> None:
        if not isinstance(samples, list):
            self.err(f"{where}: not a list")
            return
        if cap is not None:
            self.expect(len(samples) <= cap, f"{where}: {len(samples)} samples > {cap}")
        prev = -1.0
        for s in samples:
            if not (isinstance(s, list) and len(s) == 2 and self.num(s[0]) and self.num(s[1])):
                self.err(f"{where}: malformed sample {s!r}")
                return
            t, v = s
            self.quirk(t >= prev, "unsorted memory_samples", f"{where}: samples not sorted by time")
            prev = max(prev, t)
            self.expect(t >= 0, f"{where}: negative time")
            self.quirk(t <= t_max_ns + 1e6, "sample time past elapsed", f"{where}: sample at {t} ns past elapsed {t_max_ns:.0f}")
            self.quirk(0 <= v <= maxfp + EPS, "footprint outside [0, max_footprint_mb]",
                       f"{where}: footprint {v} outside [0, max_footprint_mb={maxfp}]")

    def check_metrics(self, where: str, l: Dict[str, Any], maxfp: float, elapsed: float, is_func: bool) -> None:
        d = self.d
        for k in ("n_cpu_percent_c", "n_cpu_percent_python", "n_sys_percent", "n_gpu_percent"):
            self.expect(self.num(l[k]) and -EPS <= l[k] <= 100 + EPS, f"{where}: {k}={l[k]} not in [0,100]")
        tot = l["n_cpu_percent_c"] + l["n_cpu_percent_python"] + l["n_sys_percent"]
        self.expect(math.floor(tot) <= 100, f"{where}: py+c+sys = {tot} > 100")
        for k in ("n_python_fraction", "n_usage_fraction"):
            self.expect(self.num(l[k]) and -EPS <= l[k] <= 1 + EPS, f"{where}: {k}={l[k]} not in [0,1]")
        for k in ("n_avg_mb", "n_peak_mb", "n_growth_mb", "n_malloc_mb", "n_copy_mb_s"):
            self.expect(self.num(l[k]) and l[k] >= 0, f"{where}: {k}={l[k]} negative")
        self.expect(isinstance(l["n_mallocs"], int) and l["n_mallocs"] >= 0, f"{where}: n_mallocs not a non-negative int")
        self.expect(l["n_avg_mb"] <= l["n_peak_mb"] + EPS, f"{where}: n_avg_mb > n_peak_mb")
        if not self.legacy:
            self.expect(abs(l["n_growth_mb"] - l["n_peak_mb"]) < EPS, f"{where}: n_growth_mb != n_peak_mb")
            self.expect(l["n_peak_mb"] <= maxfp + EPS, f"{where}: n_peak_mb {l['n_peak_mb']} > max_footprint_mb")
            self.expect(0 <= l["n_core_utilization"] <= 1, f"{where}: n_core_utilization out of [0,1]")
            self.expect(l["n_gpu_avg_memory_mb"] <= l["n_gpu_peak_memory_mb"] + EPS, f"{where}: gpu avg > peak")
            self.expect(l["n_gpu_avg_memory_mb"] >= 0, f"{where}: gpu avg negative")
            self.expect(0 <= l["n_async_await_percent"] <= 100 + EPS, f"{where}: await % out of range")
            self.expect(l["n_async_concurrency_mean"] <= l["n_async_concurrency_peak"] + EPS, f"{where}: concurrency mean > peak")
            names = l["async_task_names"]
            self.expect(isinstance(names, list) and names == sorted(names) and len(names) <= 100,
                        f"{where}: async_task_names must be a sorted list of <= 100")
            self.expect(isinstance(l["is_coroutine"], bool), f"{where}: is_coroutine must be bool")
            if not d.get("async_profile"):
                self.expect(l["n_async_await_percent"] == 0 and not names, f"{where}: async data without async_profile")
            if l["n_malloc_mb"] == 0:
                self.expect(l["n_peak_mb"] == 0 and l["n_mallocs"] == 0, f"{where}: peak/mallocs without allocation")
        if not d.get("memory"):
            for k in ("n_avg_mb", "n_peak_mb", "n_malloc_mb", "n_mallocs", "n_usage_fraction", "n_copy_mb_s"):
                self.expect(l[k] == 0, f"{where}: memory=false but {k}={l[k]}")
            self.expect(l["memory_samples"] == [], f"{where}: memory=false but memory_samples")
        if not d.get("gpu"):
            self.expect(l["n_gpu_percent"] == 0, f"{where}: gpu=false but n_gpu_percent={l['n_gpu_percent']}")
            if not self.legacy:
                self.expect(l["n_gpu_peak_memory_mb"] == 0, f"{where}: gpu=false but GPU memory")
        self.check_samples(l["memory_samples"], f"{where}.memory_samples", maxfp, elapsed * 1e9,
                           None if self.legacy else 100)
        if not self.legacy:
            csl = l["cpu_samples_list"]
            if is_func:
                self.expect(csl == [], f"{where}: functions must have empty cpu_samples_list")
            else:
                self.expect(len(csl) <= 500, f"{where}: cpu_samples_list longer than 500")
                self.expect(csl == sorted(csl), f"{where}: cpu_samples_list not sorted")
                if self.num(d.get("start_time_perf")):
                    lo, hi = d["start_time_perf"], d["start_time_perf"] + elapsed
                    self.expect(all(lo <= x <= hi for x in csl), f"{where}: cpu_samples_list outside [start_time_perf, +elapsed]")

    def check_file(self, fn: str, f: Dict[str, Any], maxfp: float, elapsed: float, neuron: bool) -> Tuple[float, float, float, float]:
        for k in ("functions", "imports", "lines", "percent_cpu_time") + (() if self.legacy else ("leaks",)):
            self.expect(k in f, f"{fn}: field {k!r} missing")
        lines = f["lines"]
        fields = LINE_FIELDS if self.legacy else MODERN_LINE_FIELDS
        prev = 0
        cpu = usage = malloc = await_ = 0.0
        n = len(lines)
        for i, l in enumerate(lines):
            where = f"{fn}:{l.get('lineno')}"
            missing = [k for k in fields if k not in l]
            if missing:
                self.err(f"{where}: missing {missing}")
                continue
            self.expect(isinstance(l["lineno"], int) and l["lineno"] > prev, f"{where}: line numbers must increase")
            prev = l["lineno"]
            if not self.legacy:
                self.expect(l["lineno"] == i + 1, f"{where}: current-format lines must be dense (lineno == index+1)")
                for ch in "<>&":
                    self.expect(ch not in l["line"], f"{where}: raw {ch!r} in source text (must be \\u escaped)")
                self.check_regions(where, l, n)
            self.check_metrics(where, l, maxfp, elapsed, False)
            cpu += l["n_cpu_percent_c"] + l["n_cpu_percent_python"] + l["n_sys_percent"]
            usage += l["n_usage_fraction"]
            malloc += l["n_malloc_mb"]
            await_ += l.get("n_async_await_percent", 0)
            if neuron:
                self.check_neuron_line(where, l)
        pct = f["percent_cpu_time"]
        self.expect(0 <= pct <= 100 + EPS, f"{fn}: percent_cpu_time {pct} out of range")
        self.expect(abs(cpu - pct) < 1e-6 * max(1, pct) + 1e-6, f"{fn}: lines sum to {cpu:.9f} but percent_cpu_time={pct:.9f}")
        prevf = (0, "")
        for fx in f["functions"]:
            where = f"{fn}::{fx.get('line')}"
            missing = [k for k in fields if k not in fx and k not in REGION_FIELDS]
            if missing:
                self.err(f"{where}: missing {missing}")
                continue
            self.expect(not (REGION_FIELDS & fx.keys()), f"{where}: functions carry no region fields")
            self.expect("\n" not in fx["line"], f"{where}: function name with newline")
            self.expect(fx["lineno"] >= prevf[0], f"{where}: functions not sorted by lineno")
            prevf = (fx["lineno"], fx["line"])
            self.check_metrics(where, fx, maxfp, elapsed, True)
        linenos = {l["lineno"] for l in lines}
        for key, leak in (f.get("leaks") or {}).items():
            self.expect(key.isdigit() and int(key) in linenos, f"{fn}: leak key {key!r} is not a line number")
            self.expect(0.95 <= leak["likelihood"] < 1, f"{fn}:{key}: leak likelihood {leak['likelihood']}")
            self.expect(leak["velocity_mb_s"] >= 0, f"{fn}:{key}: negative leak velocity")
        if f.get("leaks"):
            self.expect(self.d["growth_rate"] >= 1 and self.d["max_footprint_mb"] > 100,
                        f"{fn}: leaks reported although the detector would not fire")
        self.expect(all(isinstance(s, str) and (s.startswith("import ") or s.startswith("from ")) for s in f["imports"]),
                    f"{fn}: imports must be import statements")
        return cpu, usage, malloc, await_

    def check_regions(self, where: str, l: Dict[str, Any], n: int) -> None:
        ln = l["lineno"]
        for a, b in (("start_region_line", "end_region_line"), ("start_outermost_loop", "end_outermost_loop")):
            s, e = l[a], l[b]
            self.expect(1 <= s <= ln <= e <= n, f"{where}: {a}/{b}=({s},{e}) does not enclose the line")
        s, e = l["start_function_line"], l["end_function_line"]
        self.expect((s, e) == (0, 0) or 1 <= s <= ln <= e <= n, f"{where}: function bounds ({s},{e})")

    def check_frame(self, where: str, fr: Dict[str, Any], py_only: bool = False) -> str:
        if set(fr) - {"code_line"} != FRAME_KEYS:
            self.err(f"{where}: frame keys {sorted(fr)}")
            return "?"
        kind = fr["kind"]
        if kind == "py":
            self.expect(isinstance(fr["line"], int) and fr["line"] >= 1, f"{where}: py frame needs line >= 1")
            self.expect(fr["ip"] is None and fr["offset"] is None, f"{where}: py frame with ip/offset")
            self.expect(bool(fr["display_name"]) and bool(fr["filename_or_module"]), f"{where}: py frame needs name+file")
        elif kind == "native":
            self.expect(not py_only, f"{where}: native frame in memory_stacks")
            self.expect(fr["line"] is None, f"{where}: native frame with line")
            self.expect(isinstance(fr["ip"], int) and 0 <= fr["ip"] < 2**53, f"{where}: native ip")
            self.expect(isinstance(fr["offset"], int) and fr["offset"] >= 0, f"{where}: native offset")
        else:
            self.err(f"{where}: frame kind {kind!r}")
        return kind

    def check_stacks(self, d: Dict[str, Any], elapsed: float, malloc_total: float) -> None:
        cs = d.get("combined_stacks", [])
        for i, entry in enumerate(cs):
            where = f"combined_stacks[{i}]"
            if not (isinstance(entry, list) and len(entry) == 2 and isinstance(entry[0], list)):
                self.err(f"{where}: must be [frames, hits]")
                continue
            frames, hits = entry
            self.expect(isinstance(hits, int) and hits >= 1, f"{where}: hits {hits!r}")
            self.expect(len(frames) >= 1, f"{where}: empty stack")
            seen_native = False
            for j, fr in enumerate(frames):
                kind = self.check_frame(f"{where}[{j}]", fr)
                if kind == "native":
                    seen_native = True
                elif kind == "py" and seen_native:
                    self.err(f"{where}: py frame after a native frame")
        tl = d.get("combined_stacks_timeline", [])
        prev = 0.0
        counts: Dict[int, int] = {}
        tids = set()
        for i, ev in enumerate(tl):
            where = f"timeline[{i}]"
            if set(ev) - {"thread_id"} != {"t_sec", "stack_index", "count"}:
                self.err(f"{where}: keys {sorted(ev)}")
                continue
            self.expect(ev["t_sec"] >= prev - 1e-9, f"{where}: t_sec goes backwards")
            prev = ev["t_sec"]
            self.expect(0 <= ev["t_sec"] <= elapsed, f"{where}: t_sec {ev['t_sec']} outside [0, elapsed]")
            idx = ev["stack_index"]
            self.expect(isinstance(idx, int) and 0 <= idx < len(cs), f"{where}: stack_index {idx} out of range")
            self.expect(isinstance(ev["count"], int) and ev["count"] >= 1, f"{where}: count {ev['count']!r}")
            counts[idx] = counts.get(idx, 0) + ev["count"]
            tids.add(ev.get("thread_id"))
        for idx, c in counts.items():
            if 0 <= idx < len(cs):
                self.expect(c <= cs[idx][1], f"timeline: sum(count) {c} for stack {idx} exceeds hits {cs[idx][1]}")
        if tl and not self.legacy:
            self.expect(d.get("main_thread_id") in tids, "timeline: no event carries main_thread_id")
        ms = d.get("memory_stacks", [])
        total = 0.0
        for i, entry in enumerate(ms):
            where = f"memory_stacks[{i}]"
            frames, mb = entry
            self.expect(self.num(mb) and mb > 0, f"{where}: mb {mb!r}")
            total += mb
            for j, fr in enumerate(frames):
                self.check_frame(f"{where}[{j}]", fr, py_only=True)
        if ms:
            self.expect(total <= malloc_total + 1e-3, f"memory_stacks total {total:.3f} MB > sum of n_malloc_mb {malloc_total:.3f}")
        for i, entry in enumerate(d.get("stacks", [])[:2000]):
            frames, stats = entry
            self.expect(all(isinstance(s, str) and s.endswith(";") for s in frames), f"stacks[{i}]: frame strings")
            if isinstance(stats, dict):
                self.expect(all(0 <= stats[k] <= 1 + EPS for k in ("python_time", "c_time", "cpu_samples")),
                            f"stacks[{i}]: fractions out of [0,1]")

    def check_neuron_line(self, where: str, l: Dict[str, Any]) -> None:
        for k in ("cpu_samples_nc_overlap_count", "cpu_samples_total_count", "cpu_samples_nc_overlap_percent"):
            self.expect(k in l, f"{where}: Neuron merge field {k} missing")
        if "cpu_samples_total_count" in l:
            self.expect(l["cpu_samples_total_count"] == len(l["cpu_samples_list"]), f"{where}: cpu_samples_total_count")
            tot, ov = l["cpu_samples_total_count"], l["cpu_samples_nc_overlap_count"]
            self.expect(0 <= ov <= tot, f"{where}: overlap count")
            pct = ov / tot * 100 if tot else 0.0
            self.expect(abs(pct - l["cpu_samples_nc_overlap_percent"]) < 1e-9, f"{where}: overlap percent")
        if "nrt_time_ms" in l:
            for k in ("nrt_percent", "nrt_execute_count", "nrt_events", "nrt_source_code", "nc_time_ms", "nc_percent",
                      "nc_execute_count", "nc_events", "nc_nrt_ratio", "neuron_time_ms"):
                self.expect(k in l, f"{where}: {k} missing")
            self.expect(abs(sum(e["duration_ms"] for e in l["nrt_events"]) - l["nrt_time_ms"]) < 1e-6, f"{where}: nrt_time_ms")
            self.expect(abs(sum(e["duration_ms"] for e in l["nc_events"]) - l["nc_time_ms"]) < 1e-6, f"{where}: nc_time_ms")
            self.expect(l["nrt_execute_count"] == len(l["nrt_events"]), f"{where}: nrt_execute_count")
            self.expect(l["nc_execute_count"] == len(l["nc_events"]), f"{where}: nc_execute_count")
            ratio = l["nc_time_ms"] / l["nrt_time_ms"] if l["nrt_time_ms"] else 0
            self.expect(abs(ratio - l["nc_nrt_ratio"]) < 1e-9, f"{where}: nc_nrt_ratio")
            self.expect(l["neuron_time_ms"] == l["nrt_time_ms"], f"{where}: neuron_time_ms")

    def check_neuron_top(self, d: Dict[str, Any]) -> None:
        lines = [l for f in d["files"].values() for l in f["lines"]]
        nrt = sum(l.get("nrt_time_ms", 0) for l in lines)
        nc = sum(l.get("nc_time_ms", 0) for l in lines)
        if "neuron_total_time_ms" in d:
            self.expect(nrt <= d["neuron_total_time_ms"] + 1e-6, "neuron: line NRT time exceeds total")
            self.expect(nc <= d["neuron_total_nc_time_ms"] + 1e-6, "neuron: line NC time exceeds total")
            pct = sum(l.get("nrt_percent", 0) for l in lines)
            self.expect(abs(pct - 100 * nrt / d["neuron_total_time_ms"]) < 1e-6, "neuron: nrt_percent sum")
            ov = sum(l.get("cpu_samples_nc_overlap_count", 0) for l in lines)
            tot = sum(l.get("cpu_samples_total_count", 0) for l in lines)
            self.expect(d["cpu_samples_total_with_nc_overlap"] == ov, "neuron: cpu_samples_total_with_nc_overlap")
            self.expect(d["cpu_samples_total"] == tot, "neuron: cpu_samples_total")
            self.expect(abs(d["cpu_samples_nc_overlap_percent_overall"] - (100 * ov / tot if tot else 0)) < 1e-9,
                        "neuron: overall overlap percent")
            self.expect(d["gpu_device"] == "Neuron", "neuron: gpu_device must be 'Neuron'")


def check_convert(upstream: Path) -> List[str]:
    """Node converter and the Python fallback tokenizer must agree."""
    import shutil
    import subprocess

    sys.path.insert(0, str(HERE))
    from gen_fixtures import js_literal_to_json  # noqa: E402

    js = upstream / "scalene" / "scalene-gui" / "example-profile.js"
    if not js.exists():
        return [f"{js} not found"]
    py = js_literal_to_json(js.read_text(encoding="utf-8"))
    node = shutil.which("node")
    if not node:
        return []
    out = subprocess.run([node, str(HERE / "convert_example.mjs"), str(js), "-"], check=True, capture_output=True, text=True)
    return [] if json.loads(out.stdout) == py else ["node and Python conversions of example-profile.js differ"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--upstream", default=os.environ.get("SCALENE_UPSTREAM", str(DEFAULT_UPSTREAM)))
    ap.add_argument("--check-convert", action="store_true", help="also cross-check the example.js converters")
    args = ap.parse_args()
    files = [Path(f) for f in args.files] or sorted(FIXTURES.glob("*.json"))
    ns = load_upstream_schema(Path(args.upstream))
    failed = 0
    for path in files:
        text = path.read_text(encoding="utf-8")
        try:
            data = json.loads(text, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(f"non-JSON constant {c}")))
        except ValueError as exc:
            print(f"FAIL {path.name}: {exc}")
            failed += 1
            continue
        checker = Checker(path.name, data)
        try:
            errors = checker.run()
        except Exception as exc:  # malformed beyond what the checks anticipate
            errors = checker.errors + [f"validator could not finish: {type(exc).__name__}: {exc}"]
        schema = schema_check(path.name, data, ns, errors) if ns else "n/a"
        status = "ok" if not errors else "FAIL"
        files_n = len(data.get("files", {}))
        lines_n = sum(len(f["lines"]) for f in data.get("files", {}).values())
        print(f"{status:4} {path.name:20} files={files_n:<3} lines={lines_n:<6} stacks={len(data.get('combined_stacks', [])):<5} "
              f"timeline={len(data.get('combined_stacks_timeline', [])):<6} schema: {schema}")
        for e in errors:
            print(f"       - {e}")
        for kind, n in sorted(checker.warnings.items()):
            print(f"       ~ legacy quirk (tolerated, the UI must cope): {kind} x{n}")
        failed += bool(errors)
    if args.check_convert:
        errs = check_convert(Path(args.upstream))
        print("convert: " + ("ok (node == python fallback)" if not errs else "; ".join(errs)))
        failed += bool(errs)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
