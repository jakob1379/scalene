"""Simulation engine behind tools/gen_fixtures.py (see that file's docstring).

Models what Scalene's samplers observe for a scheduled program run and emits
a profile dict with the exact wire shape of scalene/scalene_json.py.
"""
from __future__ import annotations

import ast
import bisect
import calendar
import datetime
import hashlib
import heapq
import json
import random
import re
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
SRC = HERE / "fixture_src"

DT = 0.01  # Scalene's default --cpu-sampling-rate
CPU_SAMPLES_RESERVOIR = 500
SPARKLINE_RESERVOIR = 100
TASK_NAME_CAP = 100

Key = Tuple[str, int]  # (filename, lineno)


def epoch(y: int, mo: int, d: int, h: int, mi: int, s: float) -> float:
    return calendar.timegm(datetime.datetime(y, mo, d, h, mi, int(s)).timetuple()) + (s - int(s))


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if x < lo else hi if x > hi else x


def h64(*parts: Any) -> int:
    digest = hashlib.sha1("\x1f".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(digest[:8], "big")


# ---------------------------------------------------------------------------
# Port of scalene/scalene_analysis.py (find_regions, find_functions,
# find_outermost_loop) -- kept verbatim in behaviour so the region fields match
# what Scalene would emit for these sources.
# ---------------------------------------------------------------------------


def find_regions(src: str) -> Dict[int, Tuple[int, int]]:
    srclines = src.split("\n")
    tree = ast.parse(src)
    regions: Dict[int, Tuple[int, int]] = {}
    loops: Dict[int, Tuple[int, int]] = {}
    functions: Dict[int, Tuple[int, int]] = {}
    classes: Dict[int, Tuple[int, int]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for line in range(node.lineno, node.end_lineno + 1):
                classes[line] = (node.lineno, node.end_lineno)
        if isinstance(node, (ast.For, ast.While)):
            for line in range(node.lineno, node.end_lineno + 1):
                loops[line] = (node.lineno, node.end_lineno)
        if isinstance(node, ast.FunctionDef):
            for line in range(node.lineno, node.end_lineno + 1):
                functions[line] = (node.lineno, node.end_lineno)
    for lineno, _ in enumerate(srclines, 1):
        if lineno in loops:
            regions[lineno] = loops[lineno]
        elif lineno in functions:
            regions[lineno] = functions[lineno]
        elif lineno in classes:
            regions[lineno] = classes[lineno]
        else:
            regions[lineno] = (lineno, lineno)
    return regions


def find_functions(src: str) -> Dict[int, Tuple[int, int]]:
    srclines = src.split("\n")
    tree = ast.parse(src)
    functions: Dict[int, Tuple[int, int]] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for line in range(node.lineno, node.end_lineno + 1):
                if line in functions:
                    s, e = functions[line]
                    if node.end_lineno - node.lineno < e - s:
                        functions[line] = (node.lineno, node.end_lineno)
                else:
                    functions[line] = (node.lineno, node.end_lineno)
    for lineno, _ in enumerate(srclines, 1):
        if lineno not in functions:
            functions[lineno] = (0, 0)
    return functions


def find_outermost_loop(src: str) -> Dict[int, Tuple[int, int]]:
    srclines = src.split("\n")
    tree = ast.parse(src)
    regions: Dict[int, Tuple[int, int]] = {}

    def walk(node: ast.AST, current_outermost_region: Any, outer_class: Any) -> None:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) or (
            isinstance(node, (ast.For, ast.While, ast.AsyncFor, ast.If))
            and (
                outer_class is ast.FunctionDef
                or outer_class is ast.AsyncFunctionDef
                or outer_class is ast.ClassDef
                or outer_class is None
            )
        ):
            current_outermost_region = (node.lineno, node.end_lineno)
            outer_class = node.__class__
        for child_node in ast.iter_child_nodes(node):
            walk(child_node, current_outermost_region, outer_class)
        if isinstance(node, ast.stmt):
            outermost_is_loop = outer_class in [ast.For, ast.AsyncFor, ast.While]
            curr_is_block_not_loop = node.__class__ in [
                ast.With,
                ast.If,
                ast.ClassDef,
                ast.FunctionDef,
                ast.AsyncFunctionDef,
            ]
            for line in range(node.lineno, node.end_lineno + 1):
                if line not in regions:
                    if current_outermost_region and outermost_is_loop:
                        regions[line] = current_outermost_region
                    elif curr_is_block_not_loop and len(srclines[line - 1].strip()) > 0:
                        regions[line] = (node.lineno, node.end_lineno)
                    else:
                        regions[line] = (line, line)

    walk(tree, None, None)
    for lineno, _line in enumerate(srclines, 1):
        regions[lineno] = regions.get(lineno, (lineno, lineno))
    return regions


# Packages ScaleneAnalysis.is_native() reports as native: C-extension packages,
# builtins, and (a quirk of its os.walk over the stdlib root, which contains
# lib-dynload/*.so) every single-file stdlib module. Stdlib *packages* such as
# json/asyncio/importlib walk only their own directory and are not native.
NATIVE_TOP = {
    "torch", "numpy", "sys", "time", "math", "os", "re", "argparse", "random", "statistics",
    "queue", "threading", "dataclasses", "typing", "functools", "hashlib", "hmac", "secrets",
    "pickle", "html", "unicodedata", "collections", "itertools", "heapq", "bisect", "struct",
    "zlib", "gc", "orjson", "asyncpg", "aiohttp", "torch_neuronx", "contextlib", "operator",
    "pathlib", "copy", "abc", "enum", "weakref", "socket", "select", "signal", "array",
    "datetime", "decimal", "fractions", "textwrap", "string", "uuid", "base64", "binascii",
    "csv", "sqlite3", "io", "shutil", "tempfile", "glob", "fnmatch", "traceback", "warnings",
    "inspect", "dis", "types", "numbers", "cmath", "zipfile", "tarfile", "gzip", "lzma",
}
NOT_NATIVE_SUBMODULES = {"torch.nn", "torch.nn.functional", "torch.cuda.amp", "torch.utils.data", "redis.asyncio"}


def is_native(module: Optional[str]) -> bool:
    if not module:
        return False
    if module in NOT_NATIVE_SUBMODULES:
        return False
    top = module.split(".")[0]
    if "." in module and top == "torch":
        return False  # torch.* subpackages hold no .so files of their own
    return top in NATIVE_TOP


def native_imports(tree: ast.AST) -> List[str]:
    out: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if is_native(alias.name):
                    out.append(ast.unparse(node))
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and is_native(node.module):
                out.append(ast.unparse(node))
    return out


_DEF_RE = re.compile(r"^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(")


class Scope:
    __slots__ = ("qualname", "firstline", "defline", "end", "is_async", "kind")

    def __init__(self, qualname: str, firstline: int, defline: int, end: int, is_async: bool, kind: str):
        self.qualname = qualname
        self.firstline = firstline
        self.defline = defline
        self.end = end
        self.is_async = is_async
        self.kind = kind  # "module" | "function" | "class"


class Source:
    """A Python source file plus the static analysis Scalene performs on it."""

    def __init__(self, path: str, text: str):
        if not text.endswith("\n"):
            text += "\n"
        self.path = path
        self.text = text
        self.lines = text.splitlines(keepends=True)
        self.n = len(self.lines)
        tree = ast.parse(text)
        self.regions = find_regions(text)
        self.outer = find_outermost_loop(text)
        self.fbounds = find_functions(text)
        self.imports = native_imports(tree)
        self.module_scope = Scope("<module>", 0, 0, self.n, False, "module")
        self.scope: List[Scope] = [self.module_scope] * (self.n + 2)
        self.funcs: Dict[str, Scope] = {}
        self._visit(tree, "")
        self._bare_cache: Dict[int, str] = {}

    def _visit(self, node: ast.AST, prefix: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                qual = prefix + child.name
                first = min([d.lineno for d in child.decorator_list] + [child.lineno])
                kind = "class" if isinstance(child, ast.ClassDef) else "function"
                sc = Scope(qual, first, child.lineno, child.end_lineno, isinstance(child, ast.AsyncFunctionDef), kind)
                self.funcs[qual] = sc
                for ln in range(child.body[0].lineno, child.end_lineno + 1):
                    self.scope[ln] = sc
                self._visit(child, qual + ("." if kind == "class" else ".<locals>."))
            else:
                self._visit(child, prefix)

    def find(self, needle: str, func: Optional[str] = None, nth: Optional[int] = None) -> int:
        """Line number of the line containing `needle` (inside `func` if given).
        The match must be unique unless `nth` picks one."""
        hits = [
            i for i, text in enumerate(self.lines, 1)
            if needle in text and (func is None or self.scope[i].qualname == func)
        ]
        if not hits:
            raise KeyError(f"{self.path}: needle {needle!r} (func={func}) not found")
        if nth is None:
            if len(hits) > 1:
                raise KeyError(f"{self.path}: needle {needle!r} is ambiguous ({hits}); pass func= or nth=")
            return hits[0]
        return hits[nth]

    def escaped(self, lineno: int) -> str:
        line = self.lines[lineno - 1]
        return line.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")

    def bare_name(self, lineno: int) -> str:
        """Enclosing `def` name by source-text scan (scalene_json._enclosing_function)."""
        if lineno in self._bare_cache:
            return self._bare_cache[lineno]
        result = "<module>"
        lines = self.lines
        if 1 <= lineno <= len(lines):
            target = lines[lineno - 1]
            stripped = target.lstrip()
            if stripped and not stripped.startswith("#"):
                indent = len(target) - len(stripped)
                if indent > 0:
                    for i in range(lineno - 2, -1, -1):
                        line = lines[i]
                        m = _DEF_RE.match(line)
                        if m:
                            if len(m.group(1)) < indent:
                                result = m.group(2)
                                break
                            continue
                        ls = line.lstrip()
                        if not ls or ls.startswith("#"):
                            continue
                        ind = len(line) - len(ls)
                        if ind < indent:
                            if ind == 0:
                                break
                            indent = ind
        self._bare_cache[lineno] = result
        return result


# ---------------------------------------------------------------------------
# Simulation model
# ---------------------------------------------------------------------------

NativeFrame = Tuple[str, str]  # (symbol, module path); "" symbol = unresolved
NativeTail = Tuple[NativeFrame, ...]


class Act:
    """One source line executing on some thread (a schedulable activity)."""

    __slots__ = (
        "key", "pyf", "util", "core", "native", "gpu", "gpu_mb", "sleeping", "pins",
        "copy_mb", "idle_loop", "_chains", "_native_cum", "name", "fixed_chain",
    )

    def __init__(
        self,
        key: Optional[Key],
        *,
        pyf: float = 0.5,
        util: float = 0.95,
        core: Optional[float] = None,
        native: Optional[Sequence[Tuple[float, NativeTail]]] = None,
        gpu: float = 0.0,
        gpu_mb: float = 0.0,
        sleeping: bool = False,
        pins: Optional[Dict[Tuple[str, str], Key]] = None,
        copy_mb: float = 0.0,
        idle_loop: bool = False,
        name: str = "",
        chain: Optional[Sequence[Tuple[str, str, int]]] = None,
    ):
        self.key = key
        self.fixed_chain = tuple(chain) if chain else None
        self.pyf = pyf
        self.util = util
        self.core = core
        self.native = list(native) if native else [(1.0, ())]
        self.gpu = gpu
        self.gpu_mb = gpu_mb
        self.sleeping = sleeping
        self.pins = pins or {}
        self.copy_mb = copy_mb
        self.idle_loop = idle_loop
        self._chains: Optional[List[Tuple[float, Tuple[Tuple[str, str, int], ...]]]] = None
        self._native_cum: Optional[List[float]] = None
        self.name = name


class Suspension:
    """An asyncio task suspended at an await between t0 and t1."""

    __slots__ = ("t0", "t1", "task", "order", "root", "chain")

    def __init__(self, t0: float, t1: float, task: str, order: int, root: Key, chain: Sequence[Tuple[str, int, str]]):
        self.t0, self.t1, self.task, self.order, self.root = t0, t1, task, order, root
        self.chain = tuple(chain)  # (filename, lineno, co_name), outermost first


class MemEvent:
    __slots__ = ("t", "delta", "key", "pyf", "ep", "act")

    def __init__(self, t: float, delta: float, key: Optional[Key], pyf: float, ep: Any, act: Optional[Act]):
        self.t, self.delta, self.key, self.pyf, self.ep, self.act = t, delta, key, pyf, ep, act


def weighted_choice(rng: random.Random, cum: List[float], items: Sequence[Any]) -> Any:
    if len(items) == 1:
        return items[0]
    x = rng.random() * cum[-1]
    return items[bisect.bisect_right(cum, x)]


def reservoir(rng: random.Random, items: List[Any], k: int, keep: Iterable[Any] = ()) -> List[Any]:
    if len(items) <= k:
        return sorted(items)
    keep = sorted({x for x in keep if x in items})
    kept = set(keep)
    rest = [x for x in items if x not in kept] if keep else items
    picked = rng.sample(rest, k - len(keep))
    return sorted(picked + keep)


class Prog:
    """A simulated program run plus everything needed to emit its profile."""

    def __init__(
        self,
        name: str,
        *,
        program: str,
        entrypoint_dir: str,
        program_path: str,
        args: Optional[List[str]],
        start_time_absolute: float,
        start_time_perf: float,
        main_tid: int,
        memory: bool = True,
        gpu: bool = False,
        gpu_device: str = "",
        async_profile: bool = False,
        n_cpus: int = 16,
        stacks: bool = True,
    ):
        self.name = name
        self.stacks_enabled = stacks
        self.rng = random.Random(f"scalene-fixture:{name}")
        self.program = program
        self.entrypoint_dir = entrypoint_dir
        self.program_path = program_path
        self.args = args
        self.start_abs = start_time_absolute
        self.start_perf = start_time_perf
        self.main_tid = main_tid
        self.memory = memory
        self.gpu = gpu
        self.gpu_device = gpu_device
        self.async_profile = async_profile
        self.n_cpus = n_cpus
        self.sources: Dict[str, Source] = {}
        self.reported: List[str] = []
        self.calls: Dict[Tuple[str, str], List[Tuple[float, Key]]] = defaultdict(list)
        self.windows: Dict[int, List[Tuple[float, float, Act]]] = defaultdict(list)
        self.thread_order: List[int] = [main_tid]
        self.act_windows: Dict[int, List[Tuple[float, float, int]]] = defaultdict(list)
        self.acts: Dict[int, Act] = {}
        self.suspensions: List[Suspension] = []
        self.mem_events: List[MemEvent] = []
        self.mem_episode_seq = 0
        self.leak_acts: Dict[int, float] = {}
        self.gpu_persist: List[Tuple[float, float]] = []  # (t, delta MiB) on the device
        self.elapsed = 0.0
        self.extra_top: Dict[str, Any] = {}
        self.module_bases: Dict[str, int] = {}

    # -- sources and call graph -------------------------------------------
    def add_source(self, path: str, text: str, reported: bool = True) -> Source:
        src = Source(path, text)
        self.sources[path] = src
        if reported:
            self.reported.append(path)
        return src

    def L(self, path: str, needle: str, func: Optional[str] = None, nth: Optional[int] = None) -> Key:
        return (path, self.sources[path].find(needle, func=func, nth=nth))

    def call(self, path: str, qualname: str, caller: Key, weight: float = 1.0) -> None:
        """Register a call site. qualname "<module>" records who imported the module."""
        assert qualname == "<module>" or qualname in self.sources[path].funcs, (path, qualname)
        self.calls[(path, qualname)].append((weight, caller))

    def scope_of(self, key: Key) -> Scope:
        return self.sources[key[0]].scope[key[1]]

    def chains(self, act: Act) -> List[Tuple[float, Tuple[Tuple[str, str, int], ...]]]:
        """All root-first Python chains (filename, qualname, line) for an act, with probabilities."""
        if act._chains is not None:
            return act._chains
        assert act.key is not None
        if act.fixed_chain:
            act._chains = [(1.0, act.fixed_chain)]
            return act._chains

        def expand(key: Key) -> List[Tuple[float, Tuple[Tuple[str, str, int], ...]]]:
            path, line = key
            sc = self.sources[path].scope[line]
            frame = (path, sc.qualname, line)
            if sc.kind == "module" and (path, "<module>") not in self.calls:
                return [(1.0, (frame,))]
            pin = act.pins.get((path, sc.qualname))
            callers = [(1.0, pin)] if pin else self.calls.get((path, sc.qualname), [])
            if not callers:
                return [(1.0, (frame,))]  # thread entry point
            total = sum(w for w, _ in callers)
            out = []
            for w, ck in callers:
                for p, ch in expand(ck):
                    out.append((p * w / total, ch + (frame,)))
            return out

        act._chains = expand(act.key)
        return act._chains

    # -- scheduling -------------------------------------------------------------
    def thread(self, tid: int) -> None:
        if tid not in self.thread_order:
            self.thread_order.append(tid)

    def run(self, tid: int, t: float, dur: float, act: Act) -> float:
        if dur <= 0:
            return t
        self.windows[tid].append((t, t + dur, act))
        self.act_windows[id(act)].append((t, t + dur, tid))
        self.acts[id(act)] = act
        return t + dur

    def seq(self, tid: int, t: float, items: Iterable[Tuple[Act, float]]) -> float:
        for act, dur in items:
            t = self.run(tid, t, dur, act)
        return t

    # -- memory -------------------------------------------------------------------
    def _ep(self) -> int:
        self.mem_episode_seq += 1
        return self.mem_episode_seq

    def _alloc_chunks(self, t0: float, t1: float, mb: float, chunks: int, act: Optional[Act], pyf: float, ep: int) -> None:
        key = act.key if act is not None else None
        chunks = max(1, chunks)
        for i in range(chunks):
            t = t0 + (t1 - t0) * (i + 0.5) / chunks
            self.mem_events.append(MemEvent(t, mb / chunks, key, pyf, ep, act))

    def windows_of(self, act: Act) -> List[Tuple[float, float, int]]:
        return self.act_windows[id(act)]

    def mem_hold(self, act: Act, mb: float, pyf: float, *, chunks: int = 6, window: int = 0,
                 free_at: Optional[float] = None, free_act: Optional[Act] = None) -> None:
        """Allocate `mb` during one window of `act` and keep it (optionally free later)."""
        t0, t1, _ = self.windows_of(act)[window]
        ep = self._ep()
        self._alloc_chunks(t0, t1, mb, chunks, act, pyf, ep)
        if free_at is not None:
            fkey = free_act.key if free_act is not None else act.key
            self.mem_events.append(MemEvent(free_at, -mb, fkey, pyf, None, free_act or act))

    def mem_temp(self, act: Act, mb: float, pyf: float, *, chunks: int = 2, jitter: float = 0.06,
                 life: Optional[float] = None, every: int = 1, free_act: Optional[Act] = None) -> None:
        """Allocate ~`mb` in each window of `act`; free it at the window end (or after `life` s)."""
        for i, (t0, t1, _) in enumerate(self.windows_of(act)):
            if i % every:
                continue
            size = mb * (1.0 + self.rng.uniform(-jitter, jitter))
            ep = self._ep()
            self._alloc_chunks(t0, t0 + (t1 - t0) * 0.8, size, chunks, act, pyf, ep)
            tf = (t0 + life) if life is not None else t1
            fkey = free_act.key if free_act is not None else act.key
            self.mem_events.append(MemEvent(tf, -size, fkey, pyf, None, free_act or act))

    def mem_grow(self, act: Act, total_mb: float, pyf: float, *, leak: Optional[float] = None, jitter: float = 0.04) -> None:
        """Allocate total_mb spread over every window of `act`, never freed (a leak)."""
        wins = self.windows_of(act)
        per = total_mb / max(1, len(wins))
        for (t0, t1, _) in wins:
            ep = self._ep()
            self._alloc_chunks(t0, t1, per * (1.0 + self.rng.uniform(-jitter, jitter)), 1, act, pyf, ep)
        if leak is not None:
            self.leak_acts[id(act)] = leak

    def mem_raw(self, t: float, mb: float, pyf: float, key: Optional[Key] = None, tag: str = "unattributed") -> None:
        """Allocation (or free, if mb < 0) not attributable to a reported line."""
        self.mem_events.append(MemEvent(t, mb, key, pyf, tag if mb > 0 else None, None))

    def gpu_alloc(self, t: float, mb: float) -> None:
        self.gpu_persist.append((t, mb))

    # -- native frames -------------------------------------------------------------
    def module_base(self, module: str) -> int:
        if module not in self.module_bases:
            self.module_bases[module] = 0x7F0000000000 + (h64("base", module) % 0x7FFFF) * 0x100000
        return self.module_bases[module]

    def native_frame(self, sym: str, module: str, salt: Any) -> Dict[str, Any]:
        if not module:  # anonymous / JIT mapping: nothing resolves
            ip = 0x7F7F00000000 + (h64("jit", salt) % 0x3FFFFFF) * 16
            return {"kind": "native", "display_name": "", "filename_or_module": "", "line": None, "ip": ip, "offset": 0}
        base = self.module_base(module)
        if not sym:
            ip = base + (h64("anon", module, salt) % 0xFFFFFF)
            return {"kind": "native", "display_name": "", "filename_or_module": module, "line": None, "ip": ip, "offset": 0}
        start = base + ((h64("sym", module, sym) % 0x3FFFFFF) & ~0xF)
        offset = h64("off", sym, salt) % 0x5C0 + 4
        return {"kind": "native", "display_name": sym, "filename_or_module": module, "line": None, "ip": start + offset, "offset": offset}

    # -- simulation -----------------------------------------------------------------
    def gpu_mem_at(self, t: float) -> float:
        i = bisect.bisect_right(self._gpu_t, t)
        return self._gpu_cum[i - 1] if i else 0.0

    def simulate(self) -> None:
        rng = self.rng
        if not self.elapsed:
            self.elapsed = max(w[-1][1] for w in self.windows.values() if w)
        elapsed = self.elapsed
        for tid in self.windows:
            self.windows[tid].sort(key=lambda w: w[0])
        persist = sorted(self.gpu_persist)
        self._gpu_t = [t for t, _ in persist]
        self._gpu_cum = []
        acc = 0.0
        for _, mb in persist:
            acc += mb
            self._gpu_cum.append(acc)

        n_ticks = int(elapsed / DT)
        ticks = []
        for k in range(n_ticks):
            t = (k + 1) * DT + rng.uniform(-0.0004, 0.0004)
            if 0 < t < elapsed:
                ticks.append(t)
        self.n_ticks = len(ticks)

        # per-line accumulators
        self.raw: Dict[Key, float] = defaultdict(float)
        self.py: Dict[Key, float] = defaultdict(float)
        self.c: Dict[Key, float] = defaultdict(float)
        self.sys: Dict[Key, float] = defaultdict(float)
        self.core_sum: Dict[Key, float] = defaultdict(float)
        self.core_n: Dict[Key, int] = defaultdict(int)
        self.cpu_list: Dict[Key, List[float]] = defaultdict(list)
        self.gpu_load: Dict[Key, float] = defaultdict(float)
        self.gpu_n: Dict[Key, int] = defaultdict(int)
        self.gpu_mem: Dict[Key, List[float]] = defaultdict(list)
        self.await_s: Dict[Key, float] = defaultdict(float)
        self.conc: Dict[Key, List[int]] = defaultdict(list)
        self.task_names: Dict[Key, List[str]] = defaultdict(list)
        self.total_await = 0.0
        stack_index: Dict[tuple, int] = {}
        stacks: List[List[Any]] = []
        timeline: List[Dict[str, Any]] = []
        legacy: Dict[Tuple[str, ...], List[float]] = {}
        t_first: Optional[float] = None

        def emit(frames_key: tuple, frames_factory, tid: int, t: float) -> None:
            nonlocal t_first
            idx = stack_index.get(frames_key)
            if idx is None:
                idx = len(stacks)
                stack_index[frames_key] = idx
                stacks.append([frames_factory(), 0])
            stacks[idx][1] += 1
            if t_first is None:
                t_first = t
            if timeline and timeline[-1]["stack_index"] == idx and timeline[-1]["thread_id"] == tid:
                timeline[-1]["count"] += 1
            else:
                timeline.append({"t_sec": round(t - t_first, 6), "stack_index": idx, "count": 1, "thread_id": tid})

        # suspension sweep structures
        susp = sorted(self.suspensions, key=lambda s: s.t0)
        s_ptr = 0
        live_susp: List[Tuple[float, int, Suspension]] = []  # heap by t1
        live_set: Dict[int, Suspension] = {}

        ptr = {tid: 0 for tid in self.windows}
        order = [tid for tid in self.thread_order if tid in self.windows]

        for t in ticks:
            active: List[Tuple[int, Act]] = []
            for tid in order:
                wins = self.windows[tid]
                i = ptr[tid]
                while i < len(wins) and wins[i][1] <= t:
                    i += 1
                ptr[tid] = i
                if i < len(wins) and wins[i][0] <= t and not wins[i][2].sleeping:
                    active.append((tid, wins[i][2]))
            # asyncio suspensions live at t
            while s_ptr < len(susp) and susp[s_ptr].t0 <= t:
                s = susp[s_ptr]
                heapq.heappush(live_susp, (s.t1, id(s), s))
                live_set[id(s)] = s
                s_ptr += 1
            while live_susp and live_susp[0][0] <= t:
                _, sid, _s = heapq.heappop(live_susp)
                live_set.pop(sid, None)
            suspended = sorted(live_set.values(), key=lambda s: (s.order, s.t0)) if live_set else []
            if suspended:
                k = len(suspended)
                per = 1.0 / k
                self.total_await += 1.0
                for s in suspended:
                    self.await_s[s.root] += per
                    self.conc[s.root].append(k)
                    names = self.task_names[s.root]
                    if len(names) < TASK_NAME_CAP and s.task not in names:
                        names.append(s.task)

            n = max(1, len(active))
            w = 1.0 / n
            for tid, act in active:
                key = act.key
                u = clamp(act.util + rng.gauss(0.0, 0.02), 0.01, 1.0)
                if key is not None:
                    self.raw[key] += w
                    self.py[key] += w * act.pyf * u
                    self.c[key] += w * (1.0 - act.pyf) * u
                    self.sys[key] += w * (1.0 - u)
                    core = act.core if act.core is not None else u * n / self.n_cpus
                    self.core_sum[key] += clamp(core * (1.0 + rng.gauss(0.0, 0.05)))
                    self.core_n[key] += 1
                    if tid == self.main_tid:
                        self.cpu_list[key].append(self.start_perf + t)
                        if self.gpu:
                            gmem = self.gpu_mem_at(t)
                            on = gmem > 0
                            self.gpu_load[key] += clamp(act.gpu + rng.gauss(0.0, 0.04)) if on else 0.0
                            self.gpu_n[key] += 1
                            if on:
                                gmem = gmem * (1.0 + rng.gauss(0.0, 0.0035)) + act.gpu_mb * (1.0 + rng.gauss(0.0, 0.05))
                            self.gpu_mem[key].append(max(0.0, gmem))
                else:
                    continue  # untraced thread: counted in the total, invisible elsewhere
                if not self.stacks_enabled:
                    continue
                # legacy python-only stacks + stitched stacks
                chains = self.chains(act)
                if len(chains) == 1:
                    chain = chains[0][1]
                else:
                    cum = list(itertools_accumulate(p for p, _ in chains))
                    chain = weighted_choice(rng, cum, [c for _, c in chains])
                lk = tuple(f"{f} {q}:{ln};" for f, q, ln in chain)
                ent = legacy.get(lk)
                if ent is None:
                    legacy[lk] = ent = [0, 0.0, 0.0, 0.0]
                ent[0] += 1
                ent[1] += w * act.pyf
                ent[2] += w * (1.0 - act.pyf)
                ent[3] += w
                if tid == self.main_tid and act.idle_loop and suspended:
                    for s in suspended:
                        frames = s.chain
                        key_frames = tuple(
                            ("py", (f"[await] {fn} ({s.task})" if j == len(frames) - 1 else fn), f, ln)
                            for j, (f, ln, fn) in enumerate(frames)
                        )
                        emit(key_frames, lambda kf=key_frames: [
                            {"kind": "py", "display_name": d, "filename_or_module": f, "line": ln, "ip": None, "offset": None}
                            for _, d, f, ln in kf
                        ], tid, t)
                    continue
                if act._native_cum is None:
                    act._native_cum = list(itertools_accumulate(wt for wt, _ in act.native))
                tail = weighted_choice(rng, act._native_cum, [nt for _, nt in act.native])
                key_frames = tuple(("py", q, f, ln) for f, q, ln in chain) + tuple(
                    ("native", sym, mod, None) for sym, mod in tail
                )

                def factory(chain=chain, tail=tail) -> List[Dict[str, Any]]:
                    out = [
                        {"kind": "py", "display_name": q, "filename_or_module": f, "line": ln, "ip": None, "offset": None}
                        for f, q, ln in chain
                    ]
                    leaf = chain[-1]
                    prev = f"{leaf[0]}:{leaf[2]}"
                    for j, (sym, mod) in enumerate(tail):
                        out.append(self.native_frame(sym, mod, (prev, j)))
                        prev = sym or prev
                    return out

                emit(key_frames, factory, tid, t)

        self.combined_stacks = stacks
        self.timeline = timeline
        total = float(max(1, self.n_ticks))
        self.legacy_stacks = [
            [list(k), {"count": v[0], "python_time": v[1] / total, "c_time": v[2] / total, "cpu_samples": v[3] / total}]
            for k, v in legacy.items()
        ]

    # -- memory processing ------------------------------------------------------------
    def process_memory(self) -> None:
        rng = self.rng
        self.mem = {}
        # Scalene stops sampling at exit: anything scheduled later never happens.
        events = sorted((e for e in self.mem_events if 0.0 <= e.t <= self.elapsed), key=lambda e: (e.t, -e.delta))
        footprint = 0.0
        live: Dict[Key, float] = defaultdict(float)
        peak: Dict[Key, float] = defaultdict(float)
        hwm: Dict[Tuple[Key, int], float] = {}
        alloc: Dict[Key, float] = defaultdict(float)
        pyalloc: Dict[Key, float] = defaultdict(float)
        samples: Dict[Key, List[Tuple[int, float]]] = defaultdict(list)
        global_samples: List[Tuple[int, float]] = []
        total_alloc = 0.0
        native_mb = 0.0
        max_fp = 0.0
        max_ev: Optional[MemEvent] = None
        max_pt: Optional[Tuple[int, float]] = None
        stacks: "OrderedDict[tuple, List[Any]]" = OrderedDict()
        for ev in events:
            footprint = max(0.0, footprint + ev.delta)
            t_ns = int(round(ev.t * 1e9))
            pt = (t_ns, footprint)
            global_samples.append(pt)
            if ev.delta > 0:
                total_alloc += ev.delta
                if ev.ep == "<native>":
                    native_mb += ev.delta
            if footprint > max_fp:
                max_fp, max_ev, max_pt = footprint, ev, pt
            if ev.key is None or ev.key[0] not in self.sources:
                continue
            k = ev.key
            live[k] = max(0.0, live[k] + ev.delta)
            peak[k] = max(peak[k], live[k])
            samples[k].append(pt)
            if ev.delta > 0:
                alloc[k] += ev.delta
                pyalloc[k] += ev.delta * ev.pyf
                hk = (k, ev.ep)
                hwm[hk] = max(hwm.get(hk, 0.0), live[k])
                if self.stacks_enabled and ev.act is not None and ev.act.key is not None:
                    chains = self.chains(ev.act)
                    chain = chains[0][1] if len(chains) == 1 else weighted_choice(
                        rng, list(itertools_accumulate(p for p, _ in chains)), [c for _, c in chains])
                    sk = tuple((f, self.sources[f].bare_name(ln) if f in self.sources else q, ln) for f, q, ln in chain)
                    ent = stacks.get(sk)
                    if ent is None:
                        stacks[sk] = ent = [0.0]
                    ent[0] += ev.delta * 0.97  # "smear" allocations are excluded upstream
        episodes: Dict[Key, List[float]] = defaultdict(list)
        for (k, _ep), v in hwm.items():
            episodes[k].append(v)
        self.max_footprint = max_fp
        self.total_alloc = total_alloc
        self.native_alloc = native_mb
        self.final_footprint = footprint
        self.growth_rate = 100.0 * footprint / total_alloc if total_alloc else 0.0
        self.alloc_samples = len(events)
        if max_ev is not None and max_ev.key is not None and max_ev.key[0] in self.sources:
            self.max_fp_loc = max_ev.key
            self.max_fp_pyf = max_ev.pyf
        else:
            self.max_fp_loc = None
            self.max_fp_pyf = max_ev.pyf if max_ev else 0.0
        keep = [p for p in (global_samples[0] if global_samples else None, max_pt,
                            global_samples[-1] if global_samples else None) if p is not None]
        self.global_samples = [[t, v] for t, v in reservoir(rng, global_samples, SPARKLINE_RESERVOIR, keep)]
        for k in sorted(alloc.keys() | peak.keys()):
            eps = episodes.get(k, [])
            n_mallocs = len(eps)
            avg = sum(eps) / n_mallocs if n_mallocs else 0.0
            pk = min(peak[k], max_fp)
            self.mem[k] = {
                "n_malloc_mb": alloc[k],
                "n_mallocs": n_mallocs,
                "n_peak_mb": pk,
                "n_avg_mb": min(avg, pk),
                "n_python_fraction": (pyalloc[k] / alloc[k]) if alloc[k] else 0,
                "n_usage_fraction": alloc[k] / total_alloc if total_alloc else 0.0,
                "memory_samples": [[t, v] for t, v in reservoir(rng, samples[k], SPARKLINE_RESERVOIR)],
            }
        self.memory_stacks = [
            [[{"kind": "py", "display_name": name, "filename_or_module": f, "line": ln, "ip": None, "offset": None}
              for f, name, ln in sk], round(v[0], 6)]
            for sk, v in stacks.items() if round(v[0], 6) > 0
        ]
        # leaks (only reported when the leak detector would fire)
        self.leaks: Dict[str, Dict[str, Dict[str, float]]] = defaultdict(dict)
        if self.growth_rate >= 1.0 and self.max_footprint > 100.0:
            for aid, likelihood in self.leak_acts.items():
                act = self.acts[aid]
                m = self.mem.get(act.key)
                if m:
                    self.leaks[act.key[0]][str(act.key[1])] = {
                        "likelihood": likelihood,
                        "velocity_mb_s": m["n_avg_mb"] / self.elapsed,
                    }
        else:
            assert not self.leak_acts, f"{self.name}: leaks requested but detector would not fire"
        # copy volume
        self.copy: Dict[Key, float] = defaultdict(float)
        for aid, act in self.acts.items():
            if act.copy_mb and act.key is not None:
                self.copy[act.key] += act.copy_mb * len(self.act_windows[aid])

    # -- output -----------------------------------------------------------------------------
    def line_metrics(self, key: Key) -> Dict[str, Any]:
        rng = self.rng
        N = float(max(1, self.n_ticks))
        raw = self.raw.get(key, 0.0)
        out: Dict[str, Any] = {}
        out["n_cpu_percent_python"] = 100.0 * self.py.get(key, 0.0) / N
        out["n_cpu_percent_c"] = 100.0 * self.c.get(key, 0.0) / N
        out["n_sys_percent"] = 100.0 * self.sys.get(key, 0.0) / N
        out["n_core_utilization"] = self.core_sum[key] / self.core_n[key] if self.core_n.get(key) else 0.0
        cl = self.cpu_list.get(key, [])
        out["cpu_samples_list"] = reservoir(rng, cl, CPU_SAMPLES_RESERVOIR) if cl else []
        gn = self.gpu_n.get(key, 0)
        out["n_gpu_percent"] = 100.0 * self.gpu_load[key] / gn if gn else 0
        gm = self.gpu_mem.get(key, [])
        out["n_gpu_avg_memory_mb"] = sum(gm) / len(gm) if gm else 0.0
        out["n_gpu_peak_memory_mb"] = max(gm) if gm else 0.0
        m = self.mem.get(key) if self.memory else None
        if m:
            out["n_malloc_mb"] = m["n_malloc_mb"]
            out["n_mallocs"] = m["n_mallocs"]
            out["n_peak_mb"] = m["n_peak_mb"]
            out["n_growth_mb"] = m["n_peak_mb"]
            out["n_avg_mb"] = m["n_avg_mb"]
            out["n_python_fraction"] = m["n_python_fraction"]
            out["n_usage_fraction"] = m["n_usage_fraction"]
            out["memory_samples"] = m["memory_samples"]
        else:
            out.update(n_malloc_mb=0.0, n_mallocs=0, n_peak_mb=0.0, n_growth_mb=0.0, n_avg_mb=0.0,
                       n_python_fraction=0, n_usage_fraction=0.0, memory_samples=[])
        out["n_copy_mb_s"] = self.copy.get(key, 0.0) / self.elapsed if self.memory else 0.0
        if self.async_profile and self.total_await:
            out["n_async_await_percent"] = 100.0 * self.await_s.get(key, 0.0) / self.total_await
            cc = self.conc.get(key)
            out["n_async_concurrency_mean"] = sum(cc) / len(cc) if cc else 0.0
            out["n_async_concurrency_peak"] = float(max(cc)) if cc else 0.0
            out["async_task_names"] = sorted(self.task_names.get(key, []))
        else:
            out.update(n_async_await_percent=0.0, n_async_concurrency_mean=0.0, n_async_concurrency_peak=0.0,
                       async_task_names=[])
        sc = self.scope_of(key)
        active = raw > 0 or key in self.await_s
        out["is_coroutine"] = bool(self.async_profile and sc.is_async and active)
        out["_raw"] = raw
        return out

    def build(self) -> Dict[str, Any]:
        self.simulate()
        self.process_memory()
        files: Dict[str, Any] = {}
        for path in self.reported:
            src = self.sources[path]
            lines = []
            per_scope: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
            for ln in range(1, src.n + 1):
                key = (path, ln)
                m = self.line_metrics(key)
                raw = m.pop("_raw")
                rec = {"line": src.escaped(ln), "lineno": ln}
                rec.update(m)
                r0, r1 = src.regions[ln]
                o0, o1 = src.outer[ln]
                f0, f1 = src.fbounds[ln]
                rec.update(start_region_line=r0, end_region_line=r1, start_outermost_loop=o0,
                           end_outermost_loop=o1, start_function_line=f0, end_function_line=f1)
                lines.append(rec)
                sc = src.scope[ln]
                has = raw > 0 or rec["n_malloc_mb"] > 0 or rec["n_async_await_percent"] > 0
                if sc.kind != "module" and has:
                    per_scope[sc.qualname].append(rec)
            percent = sum(r["n_cpu_percent_python"] + r["n_cpu_percent_c"] + r["n_sys_percent"] for r in lines)
            functions = [self.function_summary(src.funcs[q], recs) for q, recs in per_scope.items()]
            functions.sort(key=lambda f: (f["lineno"], f["line"]))
            files[path] = {
                "functions": functions,
                "imports": src.imports,
                "leaks": dict(self.leaks.get(path, {})) if self.memory else {},
                "lines": lines,
                "percent_cpu_time": percent,
            }
        mem = self.memory
        out: Dict[str, Any] = {
            "alloc_samples": self.alloc_samples if mem else 0,
            "args": self.args,
            "async_profile": self.async_profile,
            "combined_stacks": self.combined_stacks,
            "combined_stacks_timeline": self.timeline,
            "elapsed_time_sec": self.elapsed,
            "entrypoint_dir": self.entrypoint_dir,
            "filename": self.program_path,
            "files": files,
            "gpu": self.gpu,
            "gpu_device": self.gpu_device,
            "growth_rate": self.growth_rate if mem else 0.0,
            "main_thread_id": self.main_tid,
            "max_footprint_fname": self.max_fp_loc[0] if (mem and self.max_fp_loc) else None,
            "max_footprint_lineno": self.max_fp_loc[1] if (mem and self.max_fp_loc) else None,
            "max_footprint_mb": self.max_footprint if mem else 0.0,
            "max_footprint_python_fraction": self.max_fp_pyf if mem else 0,
            "memory": mem,
            "memory_stacks": self.memory_stacks if mem else [],
            "native_allocations_mb": self.native_alloc if mem else 0.0,
            "program": self.program,
            "samples": self.global_samples if mem else [],
            "stacks": self.legacy_stacks,
            "start_time_absolute": self.start_abs,
            "start_time_perf": self.start_perf,
        }
        out.update(self.extra_top)
        return out

    def function_summary(self, sc: Scope, recs: List[Dict[str, Any]]) -> Dict[str, Any]:
        rng = self.rng
        tot = lambda k: sum(r[k] for r in recs)  # noqa: E731
        cpu_w = [r["n_cpu_percent_python"] + r["n_cpu_percent_c"] + r["n_sys_percent"] for r in recs]
        wsum = sum(cpu_w)
        core = sum(r["n_core_utilization"] * w for r, w in zip(recs, cpu_w)) / wsum if wsum else 0.0
        gw = [len(r["cpu_samples_list"]) for r in recs]
        gsum = sum(gw)
        gpu_pct = sum(r["n_gpu_percent"] * w for r, w in zip(recs, gw)) / gsum if gsum else 0
        gpu_avg = sum(r["n_gpu_avg_memory_mb"] * w for r, w in zip(recs, gw)) / gsum if gsum else 0.0
        malloc = tot("n_malloc_mb")
        mallocs = tot("n_mallocs")
        peak = max((r["n_peak_mb"] for r in recs), default=0.0)
        avg = sum(r["n_avg_mb"] * r["n_mallocs"] for r in recs) / mallocs if mallocs else 0.0
        msamples = [tuple(s) for r in recs for s in r["memory_samples"]]
        aw = [r["n_async_await_percent"] for r in recs]
        awsum = sum(aw)
        names: List[str] = []
        for r in recs:
            for n in r["async_task_names"]:
                if n not in names and len(names) < TASK_NAME_CAP:
                    names.append(n)
        return {
            "line": sc.qualname,
            "lineno": sc.firstline,
            "memory_samples": [list(s) for s in reservoir(rng, sorted(set(msamples)), SPARKLINE_RESERVOIR)],
            "cpu_samples_list": [],
            "n_avg_mb": min(avg, peak),
            "n_copy_mb_s": tot("n_copy_mb_s"),
            "n_core_utilization": core,
            "n_cpu_percent_c": tot("n_cpu_percent_c"),
            "n_cpu_percent_python": tot("n_cpu_percent_python"),
            "n_gpu_avg_memory_mb": min(gpu_avg, max((r["n_gpu_peak_memory_mb"] for r in recs), default=0.0)),
            "n_gpu_peak_memory_mb": max((r["n_gpu_peak_memory_mb"] for r in recs), default=0.0),
            "n_gpu_percent": gpu_pct,
            "n_growth_mb": peak,
            "n_peak_mb": peak,
            "n_malloc_mb": malloc,
            "n_mallocs": mallocs,
            "n_python_fraction": sum(r["n_python_fraction"] * r["n_malloc_mb"] for r in recs) / malloc if malloc else 0,
            "n_sys_percent": tot("n_sys_percent"),
            "n_usage_fraction": tot("n_usage_fraction"),
            "n_async_await_percent": awsum,
            "n_async_concurrency_mean": (sum(r["n_async_concurrency_mean"] * a for r, a in zip(recs, aw)) / awsum) if awsum else 0.0,
            "n_async_concurrency_peak": max((r["n_async_concurrency_peak"] for r in recs), default=0.0),
            "async_task_names": sorted(names),
            "is_coroutine": bool(self.async_profile and sc.is_async),
        }


def itertools_accumulate(xs: Iterable[float]) -> Iterable[float]:
    total = 0.0
    for x in xs:
        total += x
        yield total


def nat(*frames: Tuple[str, str]) -> NativeTail:
    return tuple(frames)


def prefixes(tail: NativeTail, cuts: Sequence[Tuple[int, float]]) -> List[Tuple[float, NativeTail]]:
    """Sample leaves at different depths of one native call path: [(weight, tail[:n])]."""
    return [(w, tail[:n] if n > 0 else tail[: len(tail) + n]) for n, w in cuts]


def dump(obj: Any, path: Path, *, indent: Optional[int] = 4, sort_keys: bool = True) -> None:
    if indent is None:
        text = json.dumps(obj, sort_keys=sort_keys, separators=(",", ":"), allow_nan=False)
    else:
        text = json.dumps(obj, sort_keys=sort_keys, indent=indent, allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8")


def read_src(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


