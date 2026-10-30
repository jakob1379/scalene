#!/usr/bin/env python3
"""Generate Scalene JSON profile fixtures for the scalene-ui test suite.

    python3 tools/gen_fixtures.py [--only NAME[,NAME...]] [--upstream DIR]

Writes into ``fixtures/`` (next to this ``tools/`` directory):

    example.json      upstream scalene-gui/example-profile.js (very old format)
    basic.json        upstream scalene-gui/profile.json (mid-age format), verbatim
    ml-training.json  PyTorch-style GPT training run: GPU, threads, leaks, rich stacks
    async-server.json asyncio web service with --async (await %, task names)
    neuron.json       AWS Inferentia2 inference, merged with merge_scalene_neuron_profiles.py fields
    cpu-only.json     --cpu only (memory false, no GPU): the minimal column set
    huge.json         stress test: 40 files, ~12k lines, ~3k stacks, ~40k timeline events
    empty.json        {} (no samples / demo state)

Stdlib only and fully deterministic (every random draw comes from a
``random.Random`` seeded with a fixed string), so re-running produces
byte-identical files.

How the synthetic profiles are built
------------------------------------
Each fixture is a small *simulation* of what Scalene observes, not a set of
hand-typed numbers. A scenario lays out a schedule of "activities" (one
source line executing on one thread, with a Python/native split, CPU
utilization, accelerator load and a list of native call tails) over wall
time. The simulator then fires a CPU sample every 10 ms, exactly like
Scalene's signal-driven sampler:

* each sample's time is split evenly among the non-sleeping threads
  (``normalized_time``), which yields the per-line python/native/system
  percentages, so lines sum to ``percent_cpu_time`` and files sum to <= 100;
* main-thread samples feed ``cpu_samples_list`` (absolute ``perf_counter``
  seconds), GPU utilization/memory and core utilization;
* every sample also yields one stitched Python+native stack per thread
  (``combined_stacks``) and an RLE timeline entry with the global
  trailing-run merge rule of ``scalene_utility.add_combined_stack``; with
  ``--async`` an idle event-loop sample yields one synthetic ``[await]``
  stack per suspended task instead, and the await time is credited to each
  task's outermost coroutine line (as ``Scalene._sample_async`` does);
* memory "components" (hold / temp / grow) emit malloc and free events whose
  running sum is the global footprint, from which per-line peak, average,
  allocation volume, sparkline samples, leaks and ``memory_stacks`` follow.

Region fields (``start/end_region_line`` ...) come from a verbatim port of
``scalene_analysis.ScaleneAnalysis``; native-import detection mimics
``ScaleneAnalysis.is_native`` for the modules used here.

Layout: ``fixturelib.py`` is the simulation engine, ``fixture_scenarios.py``
holds one ``build_*`` per fixture, and ``fixture_src/`` holds the Python
sources the profiled programs are made of (huge.json's 40 modules are
generated procedurally instead). Design notes and the feature/fixture matrix:
notes/fixtures.md.

example.json conversion: example-profile.js is a JS object literal (unquoted
keys, trailing commas), not JSON. ``tools/convert_example.mjs`` evaluates it
in an empty ``node:vm`` context and writes JSON; this script runs it when
``node`` is on PATH and otherwise falls back to a small tokenizer
(``js_literal_to_json``) that handles exactly that subset. Both produce the
same document (checked by ``tools/validate_fixtures.py --check-convert``).
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, List

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURES = ROOT / "fixtures"
DEFAULT_UPSTREAM = Path(os.environ.get("SCALENE_SRC", ROOT.parent))  # scalene-ui/ sits in a Scalene checkout

sys.dont_write_bytecode = True  # keep tools/ free of __pycache__
sys.path.insert(0, str(HERE))
from fixturelib import dump  # noqa: E402
from fixture_scenarios import build_async, build_cpu_only, build_huge, build_ml, build_neuron  # noqa: E402


# ---------------------------------------------------------------------------
# Upstream sample conversion
# ---------------------------------------------------------------------------

_JS_TOKEN = re.compile(
    r"""\s+|//[^\n]*|/\*.*?\*/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z_$][A-Za-z0-9_$]*|[{}\[\]:,;=]""",
    re.S,
)


def js_literal_to_json(src: str) -> Any:
    """Parse `const name = { ...JS object literal... };` (unquoted keys, trailing commas)."""
    start = src.index("=", src.index("example_profile")) + 1
    body = src[start:]
    out: List[str] = []
    pos = 0
    toks: List[str] = []
    while pos < len(body):
        m = _JS_TOKEN.match(body, pos)
        if not m:
            raise ValueError(f"unexpected character at {pos}: {body[pos:pos + 20]!r}")
        tok = m.group(0)
        pos = m.end()
        if tok.isspace() or tok.startswith("//") or tok.startswith("/*"):
            continue
        toks.append(tok)
    depth = 0
    for i, tok in enumerate(toks):
        if tok == ";" and depth == 0:
            break
        nxt = toks[i + 1] if i + 1 < len(toks) else ""
        if tok in "{[":
            depth += 1
        elif tok in "}]":
            depth -= 1
        if tok == "," and nxt in ("}", "]"):
            continue  # trailing comma
        if re.match(r"[A-Za-z_$]", tok) and tok not in ("true", "false", "null") and nxt == ":":
            out.append(json.dumps(tok))
        elif tok.startswith("'"):
            out.append(json.dumps(ast.literal_eval(tok)))
        elif tok in ("NaN", "Infinity", "undefined"):
            raise ValueError(f"non-JSON literal {tok}")
        else:
            out.append(tok)
    return json.loads("".join(out))


def convert_example(upstream: Path) -> Any:
    js = upstream / "scalene" / "scalene-gui" / "example-profile.js"
    node = shutil.which("node")
    if node:
        res = subprocess.run(
            [node, str(HERE / "convert_example.mjs"), str(js), "-"],
            check=True, capture_output=True, text=True,
        )
        return json.loads(res.stdout)
    print("  (node not found: using the built-in JS literal tokenizer)", file=sys.stderr)
    return js_literal_to_json(js.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="", help="comma-separated fixture names (without .json)")
    ap.add_argument("--upstream", default=os.environ.get("SCALENE_UPSTREAM", str(DEFAULT_UPSTREAM)),
                    help="upstream scalene checkout (for example.json / basic.json)")
    ap.add_argument("--out", default=str(FIXTURES))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    upstream = Path(args.upstream)

    def want(name: str) -> bool:
        return not only or name in only

    if want("example") or want("basic"):
        if (upstream / "scalene" / "scalene-gui").is_dir():
            if want("example"):
                dump(convert_example(upstream), out / "example.json", sort_keys=False)
                print("wrote example.json")
            if want("basic"):
                shutil.copyfile(upstream / "scalene" / "scalene-gui" / "profile.json", out / "basic.json")
                print("wrote basic.json")
        else:
            print(f"warning: {upstream} not found; skipping example.json / basic.json", file=sys.stderr)

    builders = [
        ("ml-training", build_ml, {}),
        ("async-server", build_async, {}),
        ("neuron", build_neuron, {"neuron": True}),
        ("cpu-only", build_cpu_only, {}),
        ("huge", build_huge, {"indent": None}),
    ]
    for name, fn, opts in builders:
        if not want(name):
            continue
        prof = fn()
        if opts.get("neuron"):
            # merge_scalene_neuron_profiles.py re-reads the sorted profile and
            # rewrites it with indent=2 and no sort_keys, appending its keys.
            dump(prof, out / f"{name}.json", indent=2, sort_keys=False)
        else:
            dump(prof, out / f"{name}.json", indent=opts.get("indent", 4))
        size = (out / f"{name}.json").stat().st_size
        print(f"wrote {name}.json ({size / 1e6:.2f} MB)")
    if want("empty"):
        (out / "empty.json").write_text("{}\n", encoding="utf-8")
        print("wrote empty.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
