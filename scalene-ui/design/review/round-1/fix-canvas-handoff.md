# Round 1 — canvas fixer: hand-offs to other owners

The canvas fixes live in `src/views/stacks/*` (new: `details.ts`), `src/views/timeline/*`,
`src/views/memory/*` and `src/styles/40-stacks.css`, `50-timeline.css`, `60-memory.css`, plus
tests (`tests/unit/canvas-round1.test.mjs`, updated `tests/unit/wp4-flame.test.mjs`,
`tools/e2e/canvas.mjs`). Items below need a change outside that area.

## DESIGN.md (spec owner): amendments made on purpose in round 1

- **§3.4 LOD** (findings `timeline-lod-grey-slab`, `timeline-lod-grey-not-in-legend`): replace
  "runs narrower than 1 device pixel are merged into one `--frame-lod` column per pixel and depth"
  with: "sub-pixel runs accumulate, per device-pixel column and depth, the time each frame kind
  covers; the column takes the fill (and hatch) of the kind covering ≥ 60 % of it, a 50/50 OKLab
  mix of the two largest kinds when they cover ≥ 80 % together, else `--frame-lod` ('mixed short
  frames'). Touching columns of one colour are painted as one rect; the 1 px `--surface` gap rule
  for frames ≥ 3 px is unchanged." Same sentence in §4.12.2 ("LOD: …"). Census of the ml-training
  main lane at full range (1147 px): grey 73.6 % → 0.0 % of painted area (async-server 80.9 → 0.0,
  huge 79.0 → 0.0); pinned by `tests/unit/canvas-round1.test.mjs` (≤ 20 %).
- **§4.12.1 legend**: add the chip "mixed short frames" (`--frame-lod` swatch, tooltip) whenever the
  profile has more than one frame kind; the footnote gains "Frames narrower than a pixel take the
  color of the kind that fills most of that pixel; grey marks mixed kinds (zoom in to separate them)."
- **§4.12.2 rows**: lane header 24 px (32 px under `pointer: coarse`), "+ show all N levels" the
  same; a collapsed lane is one header tall. With several lanes beside a gutter, a 16 px column
  header "Threads · % of samples" sits above the lanes and every lane header shows its bare share
  ("2.5%"); full-width (xs) label rows say "2.5% of samples". GC / I/O & waits / GIL gutter labels
  are one focusable group (`.tl-class-group`) whose tooltip lists the three shares and definitions.
  Gutter sub-labels are 12/16 (class-row shares 11/14), never 10.5 px.
- **§4.12.1 range label**: below 1 s of span both ends get enough decimals to differ
  ("28.400 s – 28.440 s").
- **§4.11.4 axis**: labels thin by nested strides of nice ticks anchored at 0 (×1, 2, 10, 20, 100 …,
  chosen from the current tick spacing) and fade 90 ms (`--dur-1`) when the set changes.
- **§4.11.5 labels / §4.11.3 crumbs / axis caption**: py frames read `train() :173` (function, then
  line; `<module> :193` for non-identifiers), never `train:173`. Fitting: drop ` :line`, then `()`,
  then truncate; native names drop collapsed `(…)`/`<…>` groups before one middle cut; a truncated
  label keeping fewer than 6 real characters is dropped (hex ips too).
- **§4.11.6 / §4.12.3 touch**: on touch/pen a tap selects (focus outline + pinned details card with
  "Zoom in / Zoom out", "Open line", "Zoom to segment" and ×); a second tap on the same item zooms
  (flame) or opens the line (timeline, py) / zooms to it (native). No hover tooltips on touch;
  double tap never resets or jumps.
- **§4.11.7 / §4.12.3 announcements**: once a zoom settles (debounced ≥ 150 ms): flame "Zoomed into
  train, train.py line 165, 14.9% of samples" / "Zoomed out to All stacks"; timeline "Showing
  9.46 s to 45.5 s of 54.1 s" / "Showing the whole run, 54.1 s". A newer segment announcement
  cancels a pending range announcement.
- **§4.11.6 / §4.12.3 Show in**: after "Show in stacks / timeline" a caption row under the toolbar:
  "Showing train.py:173 · loss_value = loss.item() · in 19.6% of stack samples [× Clear]
  [← Back to code]". Clear removes the caption and the selected line's outline (until the selection
  changes); selecting another line ends the caption.
- **§4.13.3**: "Show 25 sites" / "Show top 8 sites"; leak badge "possible leak · grows 5.71 MiB/s";
  selected row bar is a straight 2 px `::before` (6 px insets), not an inset shadow; the site detail
  reads "Peak | 614 MiB attributed to this line (Python 0%)" and "Moments | 100 allocation events
  shown as ticks under the chart · 200 episodes" (counts pluralised). §4.13.2 caption says "(ticks
  under the chart)". §4.13.1 stat values with a tooltip are focus stops (tooltip on focus, tap opens
  it) and carry the exact value as visually hidden text.

## overview (views/overview/*)

1. `cross-view-terms-inconsistent` (1): the scope legend / readout card call the wait hatch
   "waiting"; the timeline legend and lanes use "I/O & waits" (the §4.12 term). Please use
   "I/O & waits" in the scope legend and its readout card.
2. `cross-view-terms-inconsistent` (3): Hotspots › Functions shows "ƒ train"; headline, lens and
   code use "train()". `pyFnName(name)` in `views/stacks/shared.ts` produces the canvas form
   (`train()`, `<module>`), if useful.
3. `memory-section-copy`: leak rates in the overview tiles/readouts read "5.71 MiB/s" with no verb;
   the Memory section now says "grows 5.71 MiB/s".
4. Not in my findings but in the overview hand-off: the Memory chart's peak callout still uses
   `charts/placement.ts#planPeakLabel` (trace-blind). `charts/*` is outside this area; once the
   trace-aware planner moves into `charts/placement.ts`, `memoryview.ts#drawBase` can call it (one
   line: pass the `m4()` trace band of `samples`).

## shell-ai-core (model/*, core/*, views/shell/*)

5. `pluralization-counts`, second half: `model/hotspots.ts#paretoText` prints "Top 1 files = 99.9%
   of run time" (example, basic). Use the singular for one item ("Top file = …") or hide the footer
   when only one item exists.
6. `cross-view-terms-inconsistent` (5): the shortcuts dialog heading "SIGNAL (SCOPE)" exposes the
   internal name; use "Signal".
7. `model/phrases.ts#linePeak` starts with "peak …"; the memory detail row strips it locally
   (`replace(/^peak /, "")`). A value-only variant (e.g. `linePeak(mib, "value")`) would remove that.
8. `model/phrases.ts#leak(…, compact)` prints "leak 5.71 MiB/s"; consider "leak · grows 5.71 MiB/s".
