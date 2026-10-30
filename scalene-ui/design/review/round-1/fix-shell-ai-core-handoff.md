# Round 1 — handoff from the shell-ai-core fixer to other areas

Changes these findings need outside `src/core`, `src/model`, `src/charts`, shell/AI views,
template, tools, tests and styles 00-04/10/70/80/90. Each item names the file and the smallest change.

## overview (src/views/overview/*, 20-overview.css)

1. **scope-card-sc-row-collision — `.sw-phase` swatch invisible in dark.** The `.sc-row` layout is
   fixed on my side (the shortcuts dialog now uses `.kbd-row`; build.mjs fails on any future bare
   class defined in two package stylesheets). Remaining: `20-overview.css:202`
   `.sw-phase { background: var(--sunken); box-shadow: inset 0 0 0 1px var(--line-strong); }` reads as
   a near-black square on `--raised` in dark. Suggested: `background: var(--sunken); box-shadow: inset 0 0 0 1px var(--control);`
   (matching the legend chip), or use the hatch of `.sw-phase-short`.

2. **linked-overlay-opaque-band (optional polish).** The band no longer compounds (max 0.5, usually
   0.3/0.45), so the footprint and peak stay visible. To keep the peak callout fully clear, pass its
   rect as the new last argument in `scope.ts:826`:
   `drawSampleTicks(o, link.cpu, [0, tMax], r, t["cpu-py"], tickAlpha, calloutRect ? [calloutRect] : [])`.

## stacks (src/views/stacks/*)

3. **memory-axis-mixed-units — flame caption.** Ticks now use one unit per axis (GiB on ml-training).
   The memory flame's axis caption still says "MiB of attributed allocation"; make it unit-free:
   "attributed allocation" (the ticks carry the unit).

## overview, again (number-unit-line-break)

4. Formatters now join number and unit with U+00A0 (`NBSP` from core/format). Code that pattern-matches
   formatter output with a literal space no longer matches: `scope.ts:1132`
   `fmtTime(tv).replace(/ s$/, " seconds").replace(/ ms$/, " milliseconds")` → use `/\ss$/` and `/\sms$/`
   (as `model/hotspots.ts` spokenTime now does). Hand-built strings like `` `${n} short phases` `` are fine;
   for new number+unit strings use `` `${n}${NBSP}s` ``.

## code (src/views/code/*) and memory (src/views/memory/*)

5. **elapsed-absent-shown-as-zero.** When `model.caps.elapsed` is false, `LineM.sec`/`FunctionM.sec`
   are NaN, so `fmtTime(sec)` prints "—" and `P.ofRun`/`P.fileShare` drop the seconds automatically.
   Optional: hide second-valued cells/chips instead of "—" (`detail.ts` timeBlock, `columns.ts` time
   tooltip) when `!model.caps.elapsed`.
6. **nan-json (memory view).** `model.memory.growthRecorded` is new; `memoryview.ts:119-122` shows
   `growth 0%` for an absent/Infinity `growth_rate`. Show "growth not recorded" when it is false.
7. **hardcoded-radii.** `node tools/check-tokens.mjs` now fails on off-scale radius literals. The only
   remaining one is `30-code.css:506` `border-radius: 3px 0 0 3px` → `var(--r-xs) 0 0 var(--r-xs)`.
8. **popup-tab-escapes-to-document-start — "All files" listbox** (`views/code/filenav.ts:285`). Its
   popover lives in `#layer-root`. For the non-modal popover (not the xs sheet), on Tab:
   `ev.preventDefault(); close(); focusPastTrigger(allFilesBtn, ev.shiftKey)` with
   `import { focusPastTrigger } from "../../core/a11y"` (same helper menus and the program popover use).

## coarse pointers (overview, code, timeline)

9. **coarse-pointer-targets-24px.** Shared controls are done (seg 32/40, switch 32, icon-btn-sm 32 px hit area,
   chips' hit area, app bar 40, footer 32). View-owned buttons still measure 20–28 px on a coarse
   phone: `.fd-ref` (findings, 24), `.hs-more` (hotspots, 24), `.cv-h-btn` (code sort, 28),
   `.tl-lane-head` / `.tl-more` (timeline, 20). Add `@media (pointer: coarse) { … { min-height: 32px; } }`
   in the owning stylesheet.

## performance (code, all canvas views)

10. **resize / file switch / theme.** `observeSize` now gates off-screen and storm resizes for every
    caller. Remaining view work: (a) `codesection.ts:417` rebuild the column set only when the
    breakpoint/visible-column list changes, not on every width; (b) file switch: build the visible
    window of the new file first and finish in an idle slice (§6.1 < 60 ms on ml-training);
    (c) on `theme:changed`, redraw only canvases near the viewport and mark the rest dirty (repaint
    on intersection) — the first toggle on ml-training is still ~60 ms.
