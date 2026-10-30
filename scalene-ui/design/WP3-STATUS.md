# WP3 Code — status: done (ready for integration)

> **WP6:** this package's browser acceptance script now lives in the repo as `tools/e2e/code.mjs` (run all suites with `node tools/e2e.mjs`); see `design/WP6-INTEGRATION.md`.

Owner files: `src/views/code/{codesection,codeview,columns,detail,filenav,functions,minimap,source}.ts`,
`src/styles/30-code.css`, `tests/unit/wp3-code.test.mjs`. Evidence lives in `design/screens/wp3/`:
`wp3-check.cjs` (Chromium acceptance, 48 checks), `batch.cjs` + `final-jobs.json` (screenshot set),
`perf.cjs` / `perf-layers.cjs` (scroll cost). Requests for the integrator: `design/requests/wp3.md`.

All scripts take `SCALENE_ROOT=<tree>` (default: this repo) so they can run against a copy of the
tree when another package's in-progress file breaks the build; they read `<tree>/out/*.html` after
`node build.mjs && node tools/render-fixture.mjs --mode standalone`.

## What is delivered (DESIGN.md §4.7–4.10, §8.6 WP3)

| Spec | Delivered |
|---|---|
| §4.7 file navigator | Tabs (`md`–`xl`, `role=tablist`, auto-activation, inner scroll with fade masks ending under ‹ › buttons, "All files (+16)" panel with filter and the hidden group), rail (`xxl`, listbox, two-line entries, collapsed hidden group), switcher (`xs` bottom sheet / `sm`,`short` popover, dialog with focus trap + Esc). Entry: basename, split bar, share, peak, leak icon, NRT/NC. Per-file mode / sort / unfolded folds kept in the store; selection cleared on a plain switch; 120 ms cross-fade (M10). |
| §4.8.1 anatomy | Header + description, toolbar (Lines/Functions, display modes with tooltips, Wrap switch persisted in `scalene-code-wrap`, ranked chip + "Source order"), sticky file bar (dir + basename, split meter, "% of run · s of s", peak, GPU mem, NRT/NC, leaks, "N lines, M shown"; opaque, see requests §1), sticky two-line column header. |
| §4.8.2–4.8.4 items, columns, cells | line / fold (+ cost) / gap / fnHeader / lens / aiCard; all 14 columns with the §4.8.3 width budget (ResizeObserver on the body), exact §4.8.4 contents, thresholds and tooltips; meters as one element per cell (`::before` backgrounds) to stay in the DOM budget; sparklines as SVG data URIs on shared scales. |
| §4.8.5 modes and folds | Upstream predicates via `model/visibility.ts`; every hidden run is one fold; Enter/click reveals only that fold; `expandAll` / `collapseAll` / `onFileDisplayModeChange` (the mode radiogroup also accepts a written `.value`). |
| §4.8.6 heat wash | `--heat` per row (floor 0.25), metric follows the sort column, 200 ms cross-fade (M15), never on text. |
| §4.8.7 row actions | Optimize / Region a–b / ⋯ on hover, focus or selection only; `o`, `Shift+O`, Enter; requests go to `ctx.ai.request`. |
| §4.8.8 sorting | desc → asc → source, `#` → source, keyless rows last both ways, folds/headers dropped, lens and AI cards follow their row; FLIP ≤ 60 rows at 280 ms (M9); reduced motion: instant + 1.5 s highlight. |
| §4.8.9 ribbon minimap | Canvas pair: memory marks, code silhouette, heat bars (Python/native/system), de-overlapped rank pins with leaders, viewport window (hidden when ranked); click/drag scrub, hover tooltip; `role=slider` with value text; arrows step hot lines, PgUp/PgDn 10 %, Home/End, Enter = `jumpTo`. Hidden on `xs`, `sm`, `short`. |
| §4.8.10 virtualization | WP1 `core/virtual.ts` + per-kind node pools; deterministic heights. **Wrap mode** inserts word-aware breaks itself (`source.ts wrapBreaks`: after spaces / `, ; ( [ {`, before `.attr`, one-row lookahead, never inside the indent, hanging indent) and renders with `white-space: pre`, so a row is exactly `rowH × visual lines`; break spans are unselectable (copy yields the original line). |
| §4.8.11 a11y | `role=table` + `aria-label`, `aria-rowcount`, `aria-rowindex`, rowgroup/row/columnheader/cell, `aria-sort`, sortable headers are buttons (≥ 24 px), row `aria-label` with units and denominators, one roving tab stop (layout-free upkeep), full key map, Esc closes the lens then clears the selection. |
| §4.8.12 `CodeApi.reveal` | Steps 1–8: switch file (incl. hidden), leave ranking if the row is not listed, reveal its fold only, centre (smooth; reduced motion instant; the lens is pre-measured and a scroll interrupted by a late measurement is corrected), 1.2 s flash, select + open lens/dock, focus (`preventScroll`), polite announcement. |
| §4.9 detail | One component, dock (`xl` 380 / `xxl` 420, sticky, own scroll, empty state with key hints) or inline lens (3/2/1 columns, M16 200 ms, content fade 140 ms). Blocks: Time (split, cores only with CPU time, region), When it ran (raster), Memory (rows + footprint chart with this line's moments + leak callout), GPU, Async, Neuron (bands, middle-ellipsis kernel with tooltip), Call context (async, buttons to Stacks), AI footer (provider status, settings). Function subject: aggregate, Go to source, no AI / When it ran. |
| §4.10 function view | Same column system, Time ↓ default, 3-click cycle back to first line, Enter/click → Lines + `jumpTo({file, fn})` (function header selected, aggregate detail), empty-state message. |
| AI cards | `renderAiCard` from `views/ai/card.ts` (WP5) as measured virtual items after the anchor row (after the lens); re-rendered on `ctx.ai.onChange`. |

## Acceptance evidence (§8.6 WP3)

`wp3-check.cjs` final run: **47/48 PASS** on the sandboxed full tree; the one FAIL was the 2560 scroll
sample taken while another package's Chromium suite was running (load average 3.5 on 4 cores). Re-run
three times right after: **PASS 3/3, 0 slow frames of 240** (code view with the app-bar blur
neutralised; the shipped page with the blur: 20–40 slow frames of 240, see requests §1).

| Criterion | Evidence |
|---|---|
| Column sets per fixture | ml @2560 `line,time,mem,gpu,trend,copy,gpumem,alloc,avg,source`; neuron `…,idle,nrt,nc,…` and no GPU; cpu-only `line,time,source` (unit + Chromium). |
| Display modes / folds match upstream predicates | unit (`visibility` + wp3) and DOM: ml `train.py` Profiled functions lists all 27 data rows, none inside a fold while scrolling the whole file; hot 27 < pf 100 < all 193; a fold click reveals exactly one fold. |
| Sorting cycle | desc → asc → source (aria-sort on the columnheader), hottest first (L:173). |
| `jumpTo` from hotspots / palette / flame lands focused with the lens open | Hotspot click and Enter (code section mounted lazily, motion on) at 1440, 1920 (dock), 1000×400; palette "loss.item" → Enter; flame keyboard `g`; vsNavigate into another file; folded target reveals its fold only. |
| DOM < 2,500 nodes in the code view (huge `sparse.py`, All lines) | max 1,895 @1440 and 2,276 @2560 (≤ 111 rendered items). |
| 60 fps scroll | p95 16.7–16.8 ms @1440 and @2560 (code view), see note above. |
| `role=table` semantics | rowcount = items + header, rowindex on every row, cells inside rows, sortable headers with `aria-sort`, row `aria-label`. |
| Minimap slider keyboard | role/label/min/max/now/valuetext; Home → 1, ↓ steps hot lines, End → last, Enter jumps. |
| Dock ≥ 1600, lens below | 1599 → lens, 1600 → dock. |
| Wrap on `xs` without overflow | ml, huge, async, neuron at 390 (isMobile, DPR 3): wrap on, no overflow, no overlapping rows; overflow matrix 320–2560 on ml/huge/neuron with the detail open: none. |
| Extra | Row content integrity across file switches; table keyboard walk; globals; reduced-motion animation audit (no moving animations, flash kept); motion audit (FLIP 280 ms, lens 200 ms, file cross-fade 120 ms). |

Unit tests: `node tools/unit.mjs` → 340 passed, 0 failed (wp3-code: column budget, meter
backgrounds, sparkline URI, word-aware wrap + span splitting, lens partitioning, middle ellipsis,
`revealIn`, ribbon geometry, pin de-overlap, function ranking, layout per breakpoint, modes/folds,
fold reveal, ranking order, sparse gaps, aria labels, neuron cells).

Screenshots (`design/screens/wp3/`, looked at): 2560 dark rail + dock, 1920 light dock, 1440 light
lens, 1440 dark, function view, AI setup card, 1024 ranked + lens, 1000×400 light lens / dark,
390 wrap + lens, leak lens, neuron lens + 2560, async lens + dark, cpu-only 1440 / 2560, example
All lines with gaps, huge rail / All files panel / jump to `fluids.py:495` (`>=` verbatim) / 390 sheet.

## Fixed in the final pass

- Stale rows after a file switch: pooled rows kept the previous file's text when keys repeated
  (`L:51` in both files). Row signatures now carry a file generation; covered by a DOM check.
- The tab strip's `scrollIntoView` scrolled the window back up after a jump (hit on huge at
  1024/1440). Replaced by `revealIn` (scrolls only the strip / rail / panel).
- A lens measured during a smooth jump scroll could stop it short and leave focus on `body`.
- Clearing the selection on a file switch animated the old file's lens closing over the new rows.
- Lens open/close FLIP now 200 ms (M16); character-level wrapping replaced by word-aware wrapping.

## Gaps and notes

- App-bar backdrop blur dominates scroll frames at 2560 (WP1 file; requests §1).
- Bundle over the size budget team-wide (requests §2); WP3 is ~150 KiB raw / ~44 KiB gzip of JS.
- WP5's in-progress controller can raise an unhandled `AbortError` on load (requests §3); the
  entry-point check ignores that one error kind.
- The ribbon keeps the spec's 56 px layout: rank pins sit at the right edge and can overlap the
  ends of the longest heat bars of their own lines (the pin then reads as the bar's label).
- In the dock layout, Tab from a row reaches the minimap slider before the dock (DOM order =
  visual order: table, ribbon, dock).
- Measured in headless Chromium with software raster on a shared 4-core machine; frame-time
  checks are sensitive to concurrent load (re-run when another suite is running).
