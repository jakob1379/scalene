# Scalene UI — QA record (cumulative)

Last updated: review round 1 verification (2026-10-29). Owner of this file: the verifier of each
review round; each round appends a results block and updates the status columns in place.
Round details: `design/review/round-1/VERIFY.md`. Spec: `DESIGN.md` (§1.4, §6, §7, §8.8, Appendix A).

## 1. How to reproduce every number here

| Command | What it proves |
|---|---|
| `node build.mjs` | strict type-check; §7.5 literals; forbidden strings; TS-entry shape; template contract (escaped, guarded `profile`, inlined once); CSS class-ownership lint; §6.1 size budget |
| `node tools/unit.mjs` | 33 unit files (model, formatters, goldens, layout planners, contract with real jinja2, css lint, …) |
| `node tools/check-tokens.mjs` | §3.2 tokens byte-identical to DESIGN, ligature-free mono stack, 125 contrast pairs (§3.7), radii on scale |
| `node tools/render-fixture.mjs` | 8 fixtures + 3 synthetic inputs (`blank`, `ws`, `scriptbreak`) × standalone + linked → `out/` |
| `node tools/check.mjs` | Chromium matrix: 11 inputs × 2 template modes × 2 themes × 8 viewports (320 … 2560, phones isMobile DPR 3, 1000×400): console/page errors, overflow, `visualViewport.scale`, layout classes, title, section skeleton, empty states, script breakout; lens + drawer overflow; theme toggle |
| `node tools/e2e.mjs` | acceptance suites: overview, code, canvas, shell-ai, linking, **verify** (new in round 1: hand-off fixes, round-1 re-checks, must-fix spot checks, §6.1 perf table, resize storm, intro fps; numbers in `out/e2e/perf.json`) |
| `node tools/shots-final.mjs` | screenshot set → `design/screens/final/` (6 fixtures × 5 sizes × 2 themes, + 4 sections at 1440) |

## 2. Latest results

After the bundle-indentation change (same checks, same machine): build 939.7 KiB raw / 249.8 KiB gz;
unit 390 passed / 1 gated skip; check.mjs 352 page loads pass; e2e **509/509** (ml-training file
switch 56.2 / 52.2 ms this run).

### Round 1 verification, final run

Same tree, sequential, headless Chromium (software raster), node 22:

| Step | Result |
|---|---|
| build | pass — 987.5 KiB raw / 259.93 KiB gz (budget 1,000 / 260; headroom 0.07 KiB gz) |
| unit | 390 passed, 0 failed, 1 gated skip (upstream `generate_html` parity needs `SCALENE_SRC`) |
| check-tokens | pass |
| check.mjs | 352 page loads pass, 0 console errors, 0 overflow |
| e2e | overview 67/67 · code 60/60 · canvas 61/61 · shell-ai 187/187 · linking 70/70 · verify 63/64 → **508/509** (failure: ml-training first file switch 63.4 ms vs 60 ms) |
| screenshots | 94 in `design/screens/final/` (ml-training, async-server, cpu-only, neuron, huge, empty × 2560×1440, 1440×900, 1024×768, 390×844, 1000×400 × light/dark; + Code, Stacks, Timeline, Memory at 1440) |
| review findings | round 1: 3 blocker + 35 major → **0 open**; 53 minor → 52 fixed, 1 partly (file switch budget) |

## 3. Must-fix register (DESIGN §1.4)

Status: **pass** = verified by the named evidence in the latest run; **pass (visual)** = verified by
looking at the named screenshots; **partial** = see the note.

| # | Must-fix | Status | Evidence (latest run) |
|---|---|---|---|
| 1 | Ligatures off on every code surface | **pass** (fixed in round-1 verification) | `verify` "mustfix 1": 121 code surfaces (`code, kbd, .code, .mono, .chip-code, .cv-src`) compute `font-variant-ligatures: none`; `--font-mono` has no ligature face; check-tokens "mono stack is ligature-free"; linking "flame tooltip title is code (mono, ligatures off)". Round 1 found key chips, `.cd-loc` and function-view `.cv-src` with ligatures on (a later `font:` shorthand reset them) → `01-base.css` now forces them off |
| 2 | Phase ribbon: no empty, unlabeled boxes | **pass** | unit `wp2-scope-layout` / `overview-round1` (phase layout, dominant-member labels, PHASE hidden when < 50 % named); `phase-short-cells-invisible` fixed (≥ 3:1 hatch); shots `final/*-1440x900-*.png` |
| 3 | Python/native frames ≥ 3:1, both themes | **pass** | check-tokens §3.7 pairs (frame py vs native 3.53 light / 3.22 dark) |
| 4 | Calm CPU channel, labelled axis; no wall on CPU-only | **pass** | overview "cpu-only channels", "cpu-only TOP LINES: one row per visible hotspot, rows ≤ 32 px", "THREADS scale … width-independent"; shots `final/cpu-only-*` |
| 5 | Annotation collision avoidance at 390, 1000×400, 1440 | **pass** | overview "geometry {ml-training, huge, async-server} × {390×844, 1000×400, 1024×768, 1440×900} ± range" (callout ∩ trace = ∅, ticks in the gutter); `verify` "memcallout" 16/16 (Memory section chart: 4 fixtures × 4 sizes) |
| 6 | Intro ≤ 1.0 s; composites consistent mid-animation; reduced motion = final frame | **pass** | overview "intro settles by 900 ms (light/dark)", "readout intro: no value or caption before its label", "Pareto bar grows with the row meters", "reduced motion = final frame at 40 ms"; `verify` intro: sweep 60 fps at 2560×1440 dark |
| 7 | No horizontal overflow at 320/360/390 | **pass** | `check.mjs` every input × mode × theme at 320, 360, 390 (isMobile, DPR 3) + lens and drawer open; code "overflow matrix 320–2560 with the detail open" |
| 8 | Headline ≤ 2 chips, no mid-token truncation, both branches | **pass** | overview "golden headline" × 5 fixtures (Appendix A); unit `headline.test.mjs`; async compact headline (round 1) unit test |
| 9 | Allocation overlay = rug/ticks, never rings, never over the callout | **pass** | canvas "memory rug for the selected site", "rug ticks are drawn"; charts unit "dense ticks never compound past 0.5", "holes are clipped"; shots `e2e/verify/recheck-linked-overlay-{light,dark}.png` |
| 10 | Theme toggle keeps scroll and selection, redraws in place | **pass** | `check.mjs` theme toggle (flips, keeps scroll, persists); overview "theme toggle redraws the scope in place" |
| 11 | One GC / I/O / GIL classification and lane totals | **pass** | canvas "timeline lane totals equal the model's (0.6 / 2.8 / 0.9 on ml)"; unit `classify.test.mjs` |
| 12 | No treemap | **pass** | not built (§1.2) |
| 13 | Ribbon hidden in short hosts / empty state; pins de-overlapped | **pass (visual)** | `final/*-1000x400-*.png`; code suite minimap checks |
| 14 | One definition per number (GPU method, rate units, "of run", "none sampled") | **pass** | unit `format`, `model`, `readouts`, `derived`; copy badge = fmtRate (round 1); recheck "readout-captions 1440" |
| 15 | Phone: top 3 hotspots before secondary readouts | **pass (visual)** | overview "first screen 390x844"; `final/*-390x844-*.png` |
| 16 | Every jump focuses the target row and opens its detail | **pass** | linking audit (every source → `role=row` focused, lens/dock open); code "jumpTo @1440/1599/1600/390", "hotspot #1 click @…" |
| 17 | No "No notable signals" card, no unlabelled histograms | **pass** | overview "cpu-only findings", "one finding: the card spans two thirds and a note fills the row" |
| 18 | Virtualized code rows | **pass** | code "huge sparse.py All lines: code view < 2,500 DOM nodes" (1440 and 2560); `verify` DOM after load 1,829 (huge) / 1,509 (ml) |
| 19 | Flame % axis + denominator; dark native contrast | **pass** | canvas "flame axis caption at root", "ticks 0–100 %", "re-bases on zoom", "labels thin by a fixed stride"; check-tokens |
| 20 | Binary units; % on every percentage | **pass** | unit `format.test.mjs`, `axis.test.mjs` (one unit per memory axis, round 1); `verify` "memory flame axis labels share one unit" |
| 21 | `% of all allocations` = `n_usage_fraction` | **pass** | overview "hotspots Memory: '% of alloc.' secondary is never clipped" (33.0 % on train.py:120); unit `model.test.mjs` |
| 22 | Skip link visible on focus | **pass** | `verify` "mustfix 22" (first Tab → "Skip to main content" at (8, 8)); shell-ai "Skip to code" moves focus to `#code-h` |
| 23 | AI drawer is a real modal | **pass** | shell-ai "drawer" (role=dialog, aria-modal, inert background, 40 Tabs stay inside, Esc, focus return) |
| 24 | Valid table semantics, aria-sort, row aria-label | **pass** | code "role=table with aria-rowcount", "rowgroup > row > columnheader", "row aria-label summarises columns"; `verify` "mustfix 24" (aria-sort on the sorted column) |
| 25 | Keyboard canvases announce the focused item | **pass** | canvas "keyboard walk announces frames/segments", "timeline zoom is announced", "flame zoom out is announced"; overview "scope: Enter where no line ran says so" |
| 26 | One encoding per quantity (system ≠ waiting hatch) | **pass** | check-tokens; legend chips (`verify` copy: scope legend "I/O & waits", same term as the timeline) |
| 27 | Absent field never shown as a measured 0 | **pass** | `verify` "mustfix 27" (example.json); unit `edgecases.test.mjs` (elapsed 0/missing/NaN/−3/∞/"54", NaN/Infinity tokens, growth not recorded); Memory section "Growth: not recorded" (round 1) |
| 28 | Event-loop line never presented as the hotspot without "waiting" | **pass** | overview "golden headline async-server"; unit `hotspots.test.mjs` badge "event loop · waiting"; `verify` "short-hotspot-rows (async 1000×400) … 'loop · waiting'" |
| 29 | Reduced motion: no transform, ≤ 150 ms opacity, final values | **pass** | overview "reduced motion = final frame at 40 ms"; code "reduced motion: instant jump, no moving animations"; shell-ai "motion" |
| 30 | DOM bounded, hover/theme < 100 ms, no long task > 200 ms after load | **pass** | `verify` perf (huge): DOM 1,829; theme 48 / 40 / 34 ms; hover event median 16 ms (max 40); long tasks after overview ≤ 60 ms (see §5) |
| 31 | Compact/iframe readouts keep a short denominator | **pass** | overview "short time split keeps its labels"; `verify` "busiest-function … 1000×400 compact: keeps 'of run'"; shots `final/*-1000x400-*.png` |
| 32 | Hotspot list = one Tab stop, arrow roving, targets ≥ 24 px | **pass** | overview "hotspots keyboard: one Tab stop, ↑/↓ j/k Home/End", "selection follows focus"; coarse targets (`verify` "coarse") |

## 4. Parity checklist (DESIGN §8.8)

| # | Parity item | Status | Evidence |
|---|---|---|---|
| 1 | Template vars, both modes, `scalene-gui-bundle.js`, offline, 400 px iframe, guarded empty `profile` | **pass** | build template contract (escaped `<`, guarded `trim`, inlined once); unit `contract.test.mjs` (real jinja2 both modes, hostile sources, byte parity with render-fixture); `check.mjs` standalone + linked, 1000×400, `blank` / `ws` / `scriptbreak` (no `window.__pwned`) |
| 2 | Upstream test literals | **pass** | build "literals, TS entry shape" |
| 3 | Window globals incl. `load` re-render, `loadFile`, `loadDemo`, `loadFetch`, `toggleReduced` | **pass** | linking "globals: all 22 §7.3 functions installed", "load(asyncObject) re-renders", "load(sameObject) within 1 s is skipped", `loadFetch()` over http |
| 4 | VS Code `jumpToLine`, in-page reveal, `vscode://` fallback | **pass** (fallback by WP1 smoke test only) | linking "vsNavigate …", code "vsNavigate loader.py:33 @…"; Chromium cannot intercept `location.href = vscode://…` |
| 5 | Heartbeat every 10 s; `/env-api-keys.json` over http(s) only | **pass** | shell-ai "network" (scalene-view-like server: env keys + heartbeat; Jupyter-like: one heartbeat, no env-keys request, ≤ 1 console error) |
| 6 | `document.title = "Scalene - <program>"` | **pass** | `check.mjs` title per input |
| 7 | Summary: CPU split, peak + split, memory timeline, max footprint, growth, native threads | **pass** | overview "golden readouts" × 5; canvas memory checks; `final/*-memory.png` |
| 8 | Files sorted, exclusion rule + hidden count, first expanded, show/hide all, per-file summary, Neuron totals | **pass** | code "globals: toggleDisplay(file-N), expandAll, collapseAll, onFileDisplayModeChange", "display modes", "file switch"; overview "hidden-files meta button opens the hidden list" (now `Nav.showHiddenFiles` → `CodeApi.showHiddenFiles`) |
| 9 | Line and function tables, every column, conditional columns, thresholds | **pass** | code "columns ml-training / neuron / cpu-only @2560", "function view …" |
| 10 | Display modes, docstrings, `\uXXXX`, highlighting | **pass** | code "display modes: hot < pf < all lines"; unit `syntax.test.mjs`, `normalize` |
| 11 | Sort by every column, reset to line order | **pass** | code "sort cycle desc → asc → source", "ranked order …", round1 header focus |
| 12 | Leak indication with velocity | **pass** | canvas "memory: default selection is the most likely leak"; `verify` copy "grows 5.71 MiB/s"; `final/ml-training-1440x900-*-memory.png` |
| 13 | AI: per-line / per-region triggers, prompt, six providers, validation, results, persistence, env prefill | **pass** | shell-ai "ai", "drawer", "network" groups (187 checks); unit `wp5-ai.test.mjs` |
| 14 | Call-stacks flame | **pass** | canvas flame checks (axis, crumbs, search, staged zoom, keyboard, touch) |
| 15 | Timeline (runs, GC/IO/GIL, tracks, lanes/interleaved/filter, axis, tooltips, navigation) | **pass** | canvas timeline checks (24) |
| 16 | Memory-stacks flame with MB axis, gridlines | **pass** | canvas "memory flame uses .memory-axis and .memory-gridlines"; `verify` one unit per axis |
| 17 | Resizable chart areas | **deviation (documented)** | content-sized charts + zoom (§4.11.5, §4.12.2) |
| 18 | Empty state, "load another profile", footer, version/date | **pass** | shell-ai "loader", "footer", empty-state titles ("No profile loaded" / "Scalene collected no samples" / "Couldn't read this profile"); `final/empty-*.png` |

## 5. Performance vs budgets (DESIGN §6.1)

Measured by `node tools/e2e/verify.mjs --only perf,resize,intro` (3 page loads per fixture at
1440×900, medians; interactions on the last load) and `tools/e2e/canvas.mjs` / `code.mjs` (draw and
scroll). Final verification run:

| Metric | huge.json budget | huge.json | ml-training budget | ml-training | Status |
|---|---|---|---|---|---|
| `model.build()` (`scalene:load` → `scalene:model`) | ≤ 250 ms | 102 ms (84–113) | ≤ 40 ms | 37 ms (25–41) | pass (ml near the limit; Node 15 ms) |
| DOMContentLoaded → `scalene:overview` | ≤ 1.0 s | 263 ms | ≤ 300 ms | 204 ms | pass |
| Long tasks after `scalene:overview` | none > 200 ms | max 60 ms | none > 100 ms | max 60 ms | pass |
| DOM nodes after load | < 8,000 | 1,829 | < 5,000 | 1,509 | pass |
| Event timing, hover hotspot (median; max) | < 50 ms | 16 ms (40) | < 30 ms | 16 ms (32) | pass on the median; one 32 ms event on ml (8 ms granularity, presentation-bound; handlers ≤ 6 ms) |
| Hover overlay draw | ≤ 2 ms | 0.1–0.4 ms | ≤ 2 ms | 0.1–0.5 ms | pass |
| Theme toggle → next paint | < 100 ms | 48.4 / 39.7 / 33.9 ms | < 60 ms | 57.5 / 42.6 / 36.3 ms | pass (round 1: was 85–93 ms on ml) |
| File switch → next paint | < 100 ms | 70.1 / 35.1 ms | < 60 ms | **63.4** / 44.4 ms | ml first switch over by 3 ms (was 89 ms) |
| Column sort → next paint | < 100 ms | 2.6 / 3.3 ms | < 60 ms | 4.6 / 4.5 ms | pass |
| Flame zoom frame (base draw) | ≤ 16 ms | median 0.8, p90 11.4 ms | ≤ 10 ms | — | pass |
| Timeline zoom frame (base draw) | ≤ 16 ms (≤ 8 ms median) | median 6.9, p90 12.7, max 15.7 ms | ≤ 10 ms | — | pass |
| Code scroll (sparse.py, All lines) | p95 ≤ 20 ms | 16.8 ms at 1440 and 2560 | | | pass |
| JS heap after load (CDP, after GC) | < 300 MB | 26.4 MB | < 80 MB | 7.1 MB | pass |
| Resize storm 1440 → 1280 in 8 px / 16 ms | no long task | 0 long tasks, p95 16.7 ms | | 0 long tasks, p95 16.8 ms | pass (was 3–4 long tasks, p95 50 ms) |
| Signature intro sweep, 2560×1440 dark | 60 fps | | | 60 / 60 / 60 fps, max frame 16.8 ms | pass (was 40–49 fps) |
| Bundle | ≤ 1,000 KiB raw, ≤ 260 KiB gz | 987.5 KiB / 259.93 KiB gz | | | pass, 0.07 KiB gz headroom |

## 6. Known limitations and open items

1. **Bundle size (resolved after round 1):** `build.mjs` now drops leading indentation outside
   string/template literals (names and line breaks unchanged). Bundle: 939.7 KiB raw, 249.8 KiB
   gzip, against budgets of 1,000 / 260 KiB (upstream page assets: 1,426 / 445 KiB).
2. **ml-training first file switch 63–70 ms** (budget 60; repeat switches 35–44 ms). The cost is the
   synchronous re-render of ~40 rows plus their style/layout in software raster. Ideas: render the
   visible window first and the rest in an idle slice; reuse rows by key across files.
3. `model.build()` on ml-training measures 25–41 ms in Chromium (median 37 ms vs 40 ms); one run in
   three can exceed the budget on this machine.
4. Hover Event Timing on ml shows an occasional 32 ms event (budget 30) — presentation-bound
   (handlers ≤ 6 ms, overlay draw ≤ 0.5 ms); the check uses the median.
5. Intro: the 120 ms before the sweep can show one 33–67 ms frame (lazy work); the sweep is 60 fps.
6. `vscode://file/…` fallback cannot be intercepted in Chromium (WP1 smoke test only).
7. Not automated yet: the §6.2.11 accessibility-tree walker (unnamed nodes, `title`-only data,
   rendered-text contrast); covered piecemeal by the shell-ai / code / overview a11y checks.
8. Optional hand-offs deliberately left: readout wording and the compact async headline still live
   in the overview view (idempotent rewrites, unit-tested); `linePeak` value-only variant;
   `drawSampleTicks` callout holes; hiding second-valued cells when `caps.elapsed` is false
   (they print "—").
9. Screenshots under `design/screens/` are gitignored (regenerate with `node tools/shots-final.mjs`).

## 7. History

| Round | Date | Result |
|---|---|---|
| WP6 integration | 2026-10-29 | build, unit 346, check 288 loads, e2e 364/364 |
| Review round 1 (findings) | 2026-10-29 | 91 findings: 3 blocker, 35 major, 53 minor (4 reviewers) |
| Review round 1 (fixes + verification) | 2026-10-29 | see §2; open blocker/major: see `design/review/round-1/VERIFY.md` |
