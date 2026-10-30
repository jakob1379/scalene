# Round 1 — overview fixer: hand-offs to other owners

The overview fixes live in `src/views/overview/*` and `src/styles/20-overview.css` only. The items
below need a change outside that area. Where a local workaround exists, it is described so the
owner can replace it without a visible change.

## canvas (charts/*, views/memory/*, views/timeline/*)

1. **Memory section chart: the peak callout still covers the trace** (finding
   `peak-callout-occludes-trace`, evidence `visual-motion/shots/async-server/1440x900-light-timeline-v1.png`).
   `charts/placement.ts#planPeakLabel` does not know about the data. The scope now uses a
   trace-aware planner. It is pure and exported from `views/overview/scope-layout.ts`:
   `traceBand(xy, x0, w)` (per-column extent of the drawn polyline), `hitsTrace(rect, band, 4)`,
   `calloutSpots(dot, size, band)` (beside, then above/below the trace, sliding 0–96 px) and
   `planPeakClear({dot, callout, label, bounds, reserved, trace})` → callout | label | gutter.
   Suggested: move these four into `charts/placement.ts` and call them from the Memory chart, the
   timeline memory row and the lens. The scope's `memTrace()` shows how to build the band from the
   same `m4()` points `drawFootprint` draws. Unit tests: `tests/unit/overview-round1.test.mjs`.
2. `charts/footprint.ts` changed during this round (another fixer). The scope still calls
   `drawFootprint` / `drawCallout` / `measureCallout` with the same signatures.

## code (views/code/*)

3. **Hidden files**: the overview's "(+16 below 1%)" meta button now scrolls to Code and opens the
   file list with the hidden group expanded. It does so through the section's debug hook
   (`document.getElementById("code").__code.showHidden()`, defined in `codesection.ts`) once the
   scroll settles. Please expose it on `CodeApi` (e.g. `showHiddenFiles(): void`) so
   `Nav`/the overview can call a real API. The overview code is in `headline.ts#showHiddenFiles`.
4. **Lens wording**: the scope link caption now says "ran in ≥ 500 main-thread samples" when a
   line hits Scalene's 500-per-line cap (and "≥ 100 allocation events"). The lens says "500
   main-thread samples (Scalene keeps up to 500 per line)". Consider the same "≥" phrasing there.
5. The hotspot footer no longer opens the code view ranked by one file. It expands the ranking in
   place (8 → 25 → 50 → all, across files), so the ranked chip and `SORT_COLUMN` route are no longer
   used by the overview.

## shell-ai-core (model/*, core/*, views/appbar.ts, tools)

6. **Readout wording lives in the view for now** (`views/overview/readouts.ts#rewriteCaption`,
   `captionLines`, `shortCaption`). The regexes are idempotent, so moving the text into
   `model/readouts.ts` needs no change in the view:
   - Peak line 2: "growth 52.2%" → "52.2% stayed live" (the Memory section's own wording);
     "+212 MiB native threads" → "212 MiB from native threads". ("growth not recorded" is kept.)
   - GPU method: "mean while the main thread ran (time-weighted)" → "mean · main thread ·
     time-weighted" (three phrases, so the caption drops "time-weighted" instead of switching to the
     iframe phrase).
   - Busiest function: caption starts with "of run · …"; short caption "of run · accelerations()"
     (must-fix 31).
   `tests/unit/readouts.test.mjs` still asserts the model strings (unchanged).
7. **Compact event-loop headline** for phones and short hosts is built in the view from the model
   segments (`views/overview/headline.ts#compactSegments`): "bench_server.py ran for 15.7 s. 59.6%
   is the event loop, mostly waiting; `hashlib.pbkdf2_hmac(…)` (21.6%) blocks it." It could become
   `HeadlineModel.compact` in `model/headline.ts`.
8. **App bar AI affordance** (finding `ai-discoverability-overview`, second half): label the app-bar
   button "AI fixes" with a visible "Set up" badge when `ai.ready()` is false (`views/appbar.ts`).
   The overview part is done: "✦ Propose a fix" on finding cards and on hotspot rows (hover/focus,
   key A). Both call `ai.request(file, line, "line")` and jump to the line.
9. **tools/e2e/linking.mjs:414**: the regex `/([\d.]+) s\s*[–-]\s*([\d.]+) s/` no longer matches
   since `fmtTime` joins number and unit with U+00A0. The timeline domain itself is right
   (16.23–29.76 s for "16.2 s – 29.8 s"). Use `\s` (which includes U+00A0) instead of the literal
   space. This is the only failing check in the linking suite (69/70).
10. `node tools/check-tokens.mjs` fails on `30-code.css:506` (`border-radius 3px 0 0 3px`). That
    file is outside this area. `20-overview.css` passes.

## DESIGN.md (spec owner): deviations made on purpose in round 1

- §5.2 M2/M6: count-ups and their meters run on the tile's reveal clock (60 ms + 30 ms × tile,
  600 ms, `--ease-out`). They no longer use 80 + 40 × i, and the meter no longer uses 120 ms / 420 ms.
  A value never shows before its label, and a meter never disagrees with its number.
- §4.4.1 / §4.4.7: y-tick labels sit in a right gutter at every width. On `xs` the gutter is just
  as wide as the widest label; labels are never drawn inside the plot.
- §4.4.4: the THREADS scale comes from fixed time windows (max(10·dt, tMax/600)), so the axis is
  the same at every width. The caption sentence uses the instantaneous maximum ("Up to 5 threads
  busy at the same moment"). The 0 label is dropped; the baseline is the 0.
- §4.4.5: TOP LINES draws smoothed density areas with adaptive bins (≥ ~8 samples per bin), not
  2 px bars. Strips are at most 20 px tall, with a row pitch of at most 32 px. When TOP LINES is
  the only numeric channel in a side-by-side layout it shows 8 rows (one per visible hotspot).
  Short hosts keep it (5 rows) when nothing else is drawable. Rank numerals sit in the right
  gutter (on phones, in the 16 px left gutter).
- §4.4.3: short-phase cells use a 1 px `--control` hatch on the card surface with a `--line-strong`
  outline. A group whose dominant member covers ≥ 50 % of its time is labelled "label ×N". PHASE
  is hidden when named cells cover less than half of the main-thread time.
- §4.5.3: "N more lines" expands the ranking in place. Side by side, the list keeps the card height
  and scrolls.
- §2.3 xxl: the instrument is split 3fr / 2fr (it was 7 / 3), and the hotspot rows flex from 36 to
  44 px.
