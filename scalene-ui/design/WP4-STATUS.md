# WP4 Canvas views (Stacks, Timeline, Memory) — status

> **WP6:** this package's browser acceptance script now lives in the repo as `tools/e2e/canvas.mjs` (run all suites with `node tools/e2e.mjs`); see `design/WP6-INTEGRATION.md`.

**State: done; acceptance met** (DESIGN.md §8.6 WP4). All eight acceptance items pass in Chromium
(45/45 browser checks) and 29 new unit tests pass (full suite 340 pass, 0 fail, 1 gated skip).
Open items for other owners are in `design/requests/wp4.md` (R1–R5); none blocks WP4.

## 1. Files (WP4-owned)

| File | What |
|---|---|
| `src/views/stacks/stackssection.ts` | §4.11.1–4.11.3: header + CPU \| Memory tabs (tablist only with both), toolbar (search with matched share and ‹ › match cycling, colour mode select — `⋯` menu on `xs`, legend chips with kind outlines, Reset zoom), breadcrumb (`nav aria-label="Zoom path"`, last crumb `aria-current`), lazy trees with reserved height, `/` focuses search inside the section, registers **`StacksApi`** (`selectTab`, `focusLine` → zoom to the parent of the heaviest node, focus it, announce) |
| `src/views/stacks/flame.ts` | the icicle on a canvas pair: base = frames, overlay = hover / search / linked outlines; DOM axis `.flame-axis` / `.memory-axis` + gridlines `.flame-gridlines` / `.memory-gridlines` re-based to the focused frame (ticks follow the frame during the tween); click zoom (M11, 280 ms, cancellable), staged lateral zoom (M12, out to the common ancestor then in); ancestors dimmed; search dimming (90 ms); colour modes Kind / File / Self (§3.4) incl. await + unresolved hatches; labels ≥ 40 px (py `name:line`, simplified middle-truncated C++, hex for unresolved) fitted in O(1) with monospace cells; tooltips (kind chip, name, location, share · samples, self, of caller, source line via `makeFileSourceLookup`, "source not in this profile"); double-click / `g` → `nav.jumpTo`; keyboard walk (↑ ↓ ← → Enter Esc/Backspace g Home) with the DOM focus box `<div class="flame-segment flame-focus">` and polite announcements; M17 first reveal (depth by depth, ≤ 600 ms); `?perf` measures |
| `src/views/stacks/flamemodel.ts` | pure rules: `zoomPlan`, `commonAncestor`, `axisValues`/`axisCaption` (full and compact phrases, §4.0.3), `announceText`, `frameTooltip`, `walk`, `matchSummary`, `flameDescription`, Show-in-stacks targets |
| `src/views/stacks/shared.ts` | shared by all three views: §3.4 frame palette from tokens (OKLab dimming cache, lines-only hatch patterns), `fitChars`, frame kind/name/label helpers, DOM axis label/gridline renderers (pooled spans, collision-dropped labels), crosshair time chip, §3.4 highlight stroke |
| `src/views/timeline/timeline.ts` | §4.12: `mountTimeline` (exported names unchanged for the facade), DOM gutter (labels, lane toggles with `aria-expanded`, "+ show all N levels", Interleaved thread chips) beside one canvas pair; rows axis (`.timeline-axis`, `.timeline-gridlines`) → memory footprint + peak dot → GC / I/O & waits / GIL with the model's lane totals → lanes or the Interleaved panel; Lanes \| Interleaved radiogroup and thread filter `<select id="timeline-view-mode">` (All / main / thread N / **unknown**), both driven through the store (so `changeTimelineViewMode` works); crosshair + time chip + footprint dot + tooltips; click → `jumpTo`; brush → M13 zoom; Ctrl/⌘ + wheel zoom ×1.25 per notch at the pointer, Shift/horizontal wheel pans, plain wheel scrolls the page; keys W/S/+/−, A/D/Alt+←/→, ↑/↓ rows, ←/→/Home/End segments, Enter / Shift+Enter, `0`/Esc reset, announcements; `range:set {reveal}` zooms; `hover:line` / selection outline matching segments; registers **`TimelineApi`** (`setDomain`, `focusLine`); M18 sweep; `?perf` measures |
| `src/views/timeline/frames.ts` | **`renderTimelineFrames(spec, sourceLookup)`**: draws one panel (merged segments per thread × depth, Kind palette, sub-pixel runs merged into `--frame-lod` columns, 3 px `--thread-k` borders in Interleaved, labels ≥ 40 px) and returns the panel's hit tester whose `describe()` reads source lines through `sourceLookup`; segment helpers, tooltip and announcement text |
| `src/views/timeline/layout.ts` | pure row layout per breakpoint (gutter 168 / 120 / labels above on `xs`; depth cap 16 / 8 / 6), domain math (clamp / zoom-around / pan), merged class intervals, per-thread class shares, thread-filter values, collapsed-lane activity |
| `src/views/memory/memoryview.ts` | §4.13: stats `<dl>` (6 items; captions also in tooltips, hidden in `short`), footprint chart (area + line, binary y ticks in a 52 px gutter, nice time ticks, peak marker + callout through `planPeakLabel`), 10 px RUG row for the selected site (`--danger` for leaks), crosshair + footprint readout + nearest allocation moment within 6 px, `range:set` band (`--fg` 6 %), selected-site detail (every number with its denominator), sites listbox (Peak \| Allocated, 8 rows + "Show 25", leaks pinned under "Possible leaks", roving focus, Enter / double-click → `jumpTo`, default = most likely leak), M18 sweep |
| `src/styles/40-stacks.css`, `50-timeline.css`, `60-memory.css` | tokens only, no hex; responsive rules for `xs`, `short` |
| `tests/unit/wp4-flame.test.mjs`, `wp4-timeline.test.mjs`, `wp4-memory.test.mjs` | 29 tests (below) |

## 2. Acceptance (§8.6 WP4)

Run: `node build.mjs && node tools/render-fixture.mjs && node tools/e2e/canvas.mjs`
(last run: 45/45; log of the run in the WP4 session), `node tools/unit.mjs wp4`.

| Criterion | Result | Evidence |
|---|---|---|
| Flame axis re-bases on zoom | **pass** | root caption "% of all sampled stacks", ticks 0 %…; after clicking `train:165`: "% of train:165 (14.9% of all stacks)", ticks restart at 0 %; breadcrumb "All stacks › <module>:193 › train:165" (last `aria-current`). Memory tab uses `.memory-axis` / `.memory-gridlines` with MiB ticks over `[0, focused MiB]`. Unit: `axisValues`, `axisCaption`. Screens `flame-zoom-light.png`, `motion-flame-zoom-midflight.png` (ticks travel with the frame mid-tween) |
| Search share on ml ("train") | **pass** | chip "Matched **91.3%** of samples · 42 frames"; "No frames match" otherwise; ‹ › cycle matches (zooming to the match's parent when it is outside the view). `flame-search-dark.png` |
| Staged lateral zoom | **pass** | `train:173` → `train:165`: 2 stages; with motion the domain widens to 5,105 samples (the common ancestor `<module>:193`) mid-flight, then narrows. Unit: `zoomPlan` |
| Keyboard walk announces frames | **pass** | Tab to the canvas (`aria-roledescription="flame graph"`), ↓ ↓ → `#sr-polite`: "train, train.py line 173, Python frame, 21.x% of sampled stacks, … samples, depth 2 of 19"; `.flame-segment.flame-focus` visible; Enter zooms, Esc zooms out |
| Timeline lane totals = model's (0.6 / 2.8 / 0.9 on ml) | **pass** | gutter "0.6% of samples · 2.8% of samples · 0.9% of samples" (from `laneTotals`); unit test sums the merged interval samples and gets the model's totals exactly on ml and huge (2.1 / 4.0 / 1.6) |
| Run ends per §4.0.7 | **pass** | every run of every ml thread: `t1 = min(next later same-thread t, t + count × dt)` (unit); browser check on thread 1; tooltips show those ends ("2.850 s – 53.9…") |
| Brush / zoom / keys | **pass** | brush 20–40 % → domain 10.82–21.64 s, range label "10.8 s – 21.6 s"; W zooms in, A pans exactly 10 %, ↓ announces "…, main thread, Python frame, 2.85 s to 53.9 s, 5,105 samples", `0` resets; Ctrl + wheel = ×1.25; plain wheel scrolls the page. `tl-brush.png`, `tl-zoomed.png` |
| Interleaved and thread filter (incl. "unknown") | **pass** | Interleaved = one panel with thread borders (`tl-interleaved-zoom.png`); "thread 2" → one expanded lane, totals "… of thread 2"; synthetic profile (one worker's events lose `thread_id`) lists and filters **unknown** (browser + unit) |
| Memory rug for the selected site | **pass** | default selection metrics.py:42 (most likely leak, rug in `--danger`); Home → train.py:120, caption "train.py:120 allocated or freed at 13 sampled moments", rug pixels drawn |
| Leak sites pinned | **pass** | loader.py:33 (rank > 8) under "Possible leaks" |
| Perf (§6.1) on huge, `?perf` | **pass** | timeline base draw median **5.5 ms** (p90 8.8, n = 25, Lanes + Interleaved sweeps, 41,604 runs / 12 threads); flame base draw median **1.0 ms** (steady state, n = 24; first cold draw ≈ 13 ms); hover/overlay median 0.1 ms (p90 0.4, max 2.4) |
| Class names used for real (§7.5) | **pass** | `flame-axis`, `memory-axis`, `memory-gridlines`, `timeline-axis`, `timeline-gridlines` are the live axis/gridline containers; `flame-segment` is the keyboard focus box |
| `renderTimelineFrames(…, sourceLookup)` | **pass** | exported from `views/timeline/timeline.ts` (re-export of `frames.ts`), passed by the facade as `drawFrames`, called for every lane / panel; its hit tester's tooltips read source through `sourceLookup` (unit test asserts the lookup call) |

Also verified: no console errors on any page; no horizontal overflow in the three sections at 320 / 360 /
390 (isMobile, DPR 3), 600, 1024, 1000×400, 2560 on ml-training, async-server, huge, example; theme
toggle redraws canvases in place (≈ 30 ms for the whole page); scope "Open in timeline" zooms the
timeline to the brushed range (17.9–31.5 s) and scrolls there; hotspot `f` → flame zoomed to
`<module>:193` with focus on the canvas; `TimelineApi.focusLine(train.py:120)` → domain 50.8–53.6 s,
segment focused and announced (`timeline-show-line-120.png`).

Unit tests (29): label fitting, frame labels, thread slots, binary search; zoom plans; re-based axis +
captions (CPU, memory); Appendix A descriptions; announcement grammar (CPU, native, memory); walk keys;
tooltip rows/code/hints incl. "source not in this profile"; search share 91.3 %; Show-in-stacks targets;
timeline gutters/depth caps; domain math; layouts (lg, Interleaved, filter, xs, short); lane totals ml +
huge; run ends; thread-filter round trip; synthetic "unknown"; lane activity conservation; segment
hit/describe/announce; `renderTimelineFrames` on a recording canvas (LOD, labels, clipping, borders);
memory chart geometry, nearest moment, site ranking / pins / default.

## 3. Screens (`design/screens/wp4/`, all looked at)

1440×900 light/dark: `ml-training-{stacks,timeline,memory}-1440x900-{light,dark}.png`;
390×844 and 1000×400 (both themes, whole sections): `ml-{stacks,timeline,memory}-{390,1000x400}-{light,dark}.png`;
1024 / 2560: `ml-*-1024-light.png`, `ml-*-2560-dark.png`; other fixtures: `async-stacks-1440-light.png`
(await hatch), `async-timeline-1440-{light,dark}.png` (1 thread, I/O & waits 95.7 %),
`cpu-timeline-1440-light.png`, `huge-{stacks,timeline}-1440-*.png`, `mem-example-hover-dark.png`
(old format: location and leaks "not recorded", 2,846 samples); interactions: `flame-zoom-light.png`,
`flame-search-dark.png`, `ml-stacks-390-dark-menu.png`, `tl-hover.png`, `tl-brush.png`, `tl-zoomed.png`,
`tl-interleaved-zoom.png`, `timeline-show-line-120.png`, `mem-hover-light.png`; motion:
`motion-flame-reveal-150ms.png`, `motion-flame-zoom-midflight.png`, `motion-timeline-sweep-200ms.png`,
`motion-flame-settled.png`.

## 4. Decisions inside the spec's latitude

- **Timeline gutter is DOM, plot is canvas.** Lane toggles and "show all levels" are real buttons
  (keyboard, `aria-expanded`); the canvas spans the gutter so separators run full width. The canvas focus
  ring is drawn around the whole chart (`:has`) so it never cuts through gutter labels.
- **Expanded lanes sit beside their gutter label** (header, share and the show-all button stack in the
  gutter) instead of a separate 20 px header row; collapsed lanes are one 20 px row (header + 16 px
  strip). On `xs` labels sit in rows above.
- **Focus outlines appear only for keyboard focus** (`:focus-visible`, a key press, or a deliberate
  landing from Show in stacks / Show in timeline); a mouse click never leaves a focus box.
- **Thread filter shows that thread's class shares** ("0.4% of thread 2"), with the denominator in the
  text; with All threads the gutter shows exactly `model.sampling.laneTotals`.
- **Collapsed-lane strips** colour columns by majority leaf kind (Python `--frame-py`, native
  `--frame-native`, await `--async` 75 %).
- **Memory section adds a selected-site detail** under the chart (peak with Python share, allocated,
  share of all allocation, moments/episodes, average, copy, leak line with likelihood) — the same
  numbers as the code lens, with their §4.0.3 denominators; it also balances the 8 / 4 grid.
- **Compact phrases on narrow plots** (§4.0.3): flame axis caption "% of stacks" / "MiB of alloc." below
  560 px; timeline gutter numbers without "of samples" in 120 px gutters (full phrase in the tooltip).
- Keyboard zoom step ×1.5 (W/S, ±), wheel ×1.25 per notch (spec), pan 10 %.
- Test hooks: read-only `__flame`, `__stacksApi`, `__timeline`, `__memory` properties on WP4's own
  elements (geometry + the registered APIs) for the browser checks; no data leaves the page.

## 5. Gaps / follow-ups

- Requests (`design/requests/wp4.md`): R1 mono tooltip titles (WP4 toggles a `tt-flame` class meanwhile),
  R2 emit `range:set` after mounting the timeline (WP2), R3 bundle budget (all packages), R4 adopt
  `wp4-check.mjs` into WP6 tools, R5 sliced lane-segment building (the main lane of huge is one
  ≈ 30–45 ms task, kept out of the measured draw).
- Timeline segments merge by `py:file:line` (WP1 model, §4.12.2), so a function spans several segments
  per line; the spec's tooltip example ("train … 51.0 s") assumed per-function merging.
- Frame hover in the timeline at full range mostly lands on `--frame-lod` columns of huge profiles (by
  design); zoom in to read frames.
- The full-section flame on huge (39 rows) leaves the sparse deep tail mostly empty; no internal scroll
  until 60 rows (spec).
