# WP2 Overview — status

> **WP6:** this package's browser acceptance script now lives in the repo as `tools/e2e/overview.mjs` (run all suites with `node tools/e2e.mjs`); see `design/WP6-INTEGRATION.md`.

**State: done.** All the §8.6 WP2 acceptance criteria pass in Chromium against the **current live tree** (every
package's latest files, 2026-10-29). `npx tsc --noEmit -p .` is clean, and unit tests pass at 340/340 with 1 gated skip.
Requests for other owners are in `design/requests/wp2.md` (R1 WP3, R2 WP1/integrator, R3 budget).

## 1. Files (WP2 owns exactly these)

| File | Role |
|---|---|
| `src/views/overview/overview.ts` | `mountOverview`. Builds the hero → instrument → findings layout, side by side at `lg+`, stacked below, findings as a third column at `xxl`. On `xs` it **moves** the existing nodes into the §2.4.5 phone order (headline → time split → hotspots → readouts 2–4 → scope → findings) and keeps focus. Also: linking via the bus, one intro clock, and `window.__scaleneOverview` (`scope.debugLayout()`, `mode()`, `t0`, `started`). |
| `src/views/overview/headline.ts` | §4.2 headline (`h1`) and meta line. Segments render as `<strong>` numbers and as code-chip or ref buttons that call `nav.jumpTo` on click and emit `hover:line` on hover/focus. Also holds the shared segment renderer, which keeps glued punctuation on the chip's line. |
| `src/views/overview/readouts.ts` | §4.3 tiles: LED, micro label, value and unit, one micro-visual, and the caption. Count-ups (M2) run on the intro clock; the time split never counts (M3). Hovering the Peak tile emits `hover:peak`. |
| `src/views/overview/caption.ts` | **Caption fitting** (§4.3.2 "max 2 lines", §2.3 md "1 line", §1.3.7). Lines break only between whole phrases (`·`-separated inline-blocks), so a chip or ref is never cut. Each line gets one row, and phrases drop whole from the end. A plain first line that needs two rows gives way to the compact denominator (`ReadoutSpec.short`, §4.0.3). A first line that opens with a code chip is kept whole. Dropped text goes to the tooltip and a visually hidden span. The row budget comes from CSS `--ro-cap-lines`, and it is re-fitted from a ResizeObserver before paint. |
| `src/views/overview/scope.ts` | §4.4 Instrument scope. Channels: PHASE, MEMORY + RUG, THREADS, TASKS, TOP LINES. Also: annotations with collision avoidance, the hover crosshair and readout card, click to jump, the brush and range chip, keyboard cursor and live announcements, linked overlays, the peak pulse, theme redraw in place, the figcaption, and `debugLayout()`. |
| `src/views/overview/scope-layout.ts` | Pure geometry: per-breakpoint gutters and heights, channel rects, PHASE cell partition (labelled / hatched / group), count ticks. |
| `src/views/overview/scope-intro.ts` | **M4 as compositor animations.** A data window slides in from the left while the data layer counter-slides, so the beam uncovers it. A phosphor afterglow band rides the beam: a masked, bloomed copy, `plus-lighter` in dark and a deeper ink pass in light. Also: a 1 px beam with a 48 px trail, a write-head dot riding the real footprint (keyframes sampled from the trace), and an axis time chip. When the beam crosses the peak's x, the peak callout fades in and a ping ring fires. Everything animated is transform or opacity on one effect timing: delay 120 ms, 640 ms, with `1 − (1 − t)^2.2` written as a CSS `linear()` easing. |
| `src/views/overview/hotspots.ts` | §4.5 ranking. Kind and metric are segmented controls (selects on `xs` / `short`). Rows show rank, meter, value, secondary, highlighted code, badge and location. The footer shows the Pareto share and "N more ›". FLIP re-rank (M8), first-load meter growth (M5). The list is one Tab stop: roving ↑/↓, j/k, Home/End; Enter jumps, `f` shows the line in stacks. |
| `src/views/overview/findings.ts` | §4.6 cards. At most 3, then "Show N more"; `short` shows 2. **Not rendered when empty.** |
| `src/styles/20-overview.css` | All overview styles, tokens only. |
| `tests/unit/wp2-overview.test.mjs`, `wp2-scope-layout.test.mjs`, `wp2-intro-caption.test.mjs` | 30 unit tests: layout modes, row counts, readout grid, count-up rules, scope metrics/layout/phase cells/ticks, annotation checker, caption planner, count-up text, sweep easing/crossing maths, ml peak crossing ≈ 650 ms. |
| `design/screens/wp2/` (+ `tools/`) | 61 screenshots and the acceptance/screenshot scripts (`tools/README.md`). |

## 2. Acceptance (§8.6 WP2): `design/screens/wp2/tools/check.mjs`, 35/35 pass

| Criterion | Result | Evidence |
|---|---|---|
| First screen §1.3.1 at 1440×900 | pass | headline, all 4 readouts, the signal and **8/8 hotspots** inside the viewport (top ≥ 0, bottom ≤ 900). `ml-training-1440x900-{light,dark}.png` |
| First screen at 390×844 (isMobile, DPR 3) | pass | headline, time split and **top 3 hotspots** visible; no overflow. `ml-training-390x844-*.png` |
| First screen at 1000×400 | pass | the whole answer in 400 px: headline, 4 compact readouts, signal and 5 hotspots. `*-1000x400-*.png` |
| Golden headline + readouts (ml, async, cpu, neuron, huge) | pass | Appendix A strings exact; every readout value and caption part present and visible |
| Scope geometry at 390 / 1000×400 / 1440 on ml and huge | pass | `debugLayout()` annotations (ticks, callout, channel labels, ranks, phase labels, range chip) are pairwise disjoint and inside their bounds; channels inside the plot; also checked with a brushed range |
| cpu-only: no THREADS, no empty findings card | pass | channels PHASE + TOP LINES; one card (`python`); no "no notable" text |
| Intro settles by 900 ms and matches `?still` | pass | light and dark: sweep 0.05 @120, 0.52 @300, 0.98 @650 ms; at 900 ms no running animations, pixel diff vs `?still` 0.000% (light) / ≤ 0.07% (dark). `intro-ml-1440-*ms-*.png` |
| Reduced motion = final frame at 40 ms | pass | diff 0.000%; no transform animations, no opacity animation > 120 ms |
| Hotspots keyboard | pass | one Tab stop; ↓, j, End, Home move; Enter → `nav.jumpTo` → focus lands on the code `row` ("Line 173, 21.4% of run time, …") |
| Hover on hotspot #1 draws its overlay in ≤ 2 ms (`?perf`) | pass | ml 0.2–0.4 ms, huge 0.1–0.6 ms over 6 hovers (`performance.measure("scalene:scope-overlay")`) |
| Theme toggle redraws the scope in place | pass | diff vs a dark load 0.3%; scrollY kept |

Other checks I ran (scripts in `tools/`, results looked at):
- Every fixture at 1440 light, and ml, async, cpu, neuron, huge at 390 and 1000×400 in both themes. Also 1024 and 2560, an `sm` sample at 800×1100, a mid-sweep phone run, hover/link/range/keyboard states, and the hover/scope/range shots for huge.
- Zero console or page errors on all of them.

## 3. What changed in this pass (on top of the interrupted first attempt, which already passed the checks)

1. **The intro is compositor-driven and starts on the first painted frame.**
   - Before: the sweep was a main-thread canvas loop anchored at mount time. Mount work and other sections' long tasks (100–300 ms) ate the first fifth of the choreography and stalled the beam.
   - Now: every moving part is a pending Web Animation that starts on the first frame that paints the overview. The count-ups and the scope stage share that origin (`anims[0].ready`). If the stage is rebuilt for a new geometry mid-sweep, it is re-pinned to the same clock.
   - A phosphor afterglow and the beam's write head were added.
   - On phones the scope is below the fold, so its sweep now starts when the scope scrolls into view (like M18), instead of playing off-screen.
2. **Readout captions honour "max 2 lines".**
   - Before: up to 5 lines, and the GPU and Await captions broke mid-phrase.
   - Now: phrase fitting (`caption.ts`). md uses 1 row, as in the wireframe, and its leak list is one line per leak. The leak list starts right under the value (subgrid rows 3–4).
   - Result: the 1440 readout row went from 200 to ~168 px, and the 1024×768 first screen now reaches the first hotspot row.
3. **`xxl`.** The instrument is ≥ 440 px (§2.3) and shares its bottom edge with the findings column. The hotspot footer sits on that edge.
4. **Hotspot rows.**
   - The code cell keeps ≥ 140 px (§4.5.2; 120 px in 400 px hosts). The location yields first, ellipsizing from the left so ":173" stays.
   - In 400 px hosts the badges shrink to their glyph (hourglass, trend-up).
   - Leak and event-loop rows name themselves in the tooltip.
5. **Smaller fixes.**
   - Odd counts in the phone readout grid: the last tile takes the full row.
   - Gutter captions break at "·" ("suspended" / "0–14").
   - First linked-overlay draw warmed at mount, so the first hover is ≤ 2 ms.

## 4. Gaps and deviations (with reasons)

- **Load-time page scroll (WP3, R1).** `filenav.ts:379` calls `scrollIntoView` on the active file tab when the code section mounts, which scrolls the window by about 280 px at 1440×900. Overview screenshots and first-screen checks reset `scrollTo(0, 0)` until WP3 fixes it.
- **Lazy sections mount during the intro (R2).** The sweep, reveals and bar growth stay fluid because they run on the compositor. The count-up text and the axis chip's label are main-thread and can stall for 100–300 ms. Fix: start lazy mounts after `scalene:overview-settled`.
- **Bundle budget (R3).** The whole tree is 925 KiB raw against a 900 KiB budget. WP2's share is about 140 KiB of JS plus 29 KiB of CSS. My sandbox raises the limit locally; `build.mjs` is untouched.
- **md/sm wireframe heights.** At md, §2.3 puts hotspot rows at about 590 px, but its own figures for readouts (104), scope (220) and header (44) do not add up to that. The page now follows the component specs: the readout row is about 159 px and the first hotspot row is on screen at 1024×768.
- **A few dropped caption parts.**
  - GPU: "busiest train.py:173 96.4%" is in the tooltip and screen-reader text at `lg`. The hotspots carry the same fact through the GPU metric and badge.
  - Await: the ref after the code chip. The chip itself jumps to the line.
  - example.json peak: "location not recorded".
- **Spec latitude I used.**
  - The 400 px gutter is 84 px instead of 72, so the micro labels stay whole.
  - The `short` hotspot badge is glyph-only.
  - The phone scope sweeps when it comes into view, not on load.

## 5. How to verify

```sh
cd scalene-ui && node build.mjs && node tools/unit.mjs && node tools/render-fixture.mjs
node tools/e2e/overview.mjs                                      # 38 checks (needs a passing build)
node design/screens/wp2/tools/film.cjs ml-training dark 1440x900 120 300 650 900
```
