# WP4 Canvas views — requests to other owners / the integrator

> **Resolved by WP6** (`design/WP6-INTEGRATION.md` §1): R1 `TooltipContent.mono`; R2 `showSection` before `range:set`; R3 budget amended; R4 folded into `tools/e2e/canvas.mjs`; R5 `TimelineM.segmentsSliced(lane)` (≤ 8 ms slices).

## R1 (WP1, `src/core/tooltip.ts` / `04-layers.css`) — a mono title for frame tooltips

§4.11.6 asks for the frame name in the tooltip to be "mono, wraps" (it is code: `torch::autograd::…`,
`x >= 0`). `TooltipContent` has no way to say so. WP4 works around it locally: after
`ctx.tooltip.show(…)` the flame and timeline add the class `tt-flame` to the global `.tooltip` element and
remove it on hide; `40-stacks.css` styles `.tooltip.tt-flame .tt-title` (mono, ligatures off) and lets
long module paths wrap (`.tt-value { overflow-wrap: anywhere }`).

Suggested change: add `mono?: boolean` (or `titleClass?: string`) to `TooltipContent`, render
`.tt-title.code` when set, and give `.tt-value` `overflow-wrap: anywhere` globally. WP4 then drops the
class toggle (two call sites: `views/stacks/flame.ts showTip/hideTip`, `views/timeline/timeline.ts`).

## R2 (WP2, `src/views/overview/scope.ts:1073`) — emit `range:set` after mounting the timeline

"Open in timeline" emits `range:set {reveal: true}` *before* `nav.showSection("timeline")`. If the
timeline section has not been mounted yet (it mounts lazily: IntersectionObserver or idle), its
`range:set` listener does not exist when the event fires and the zoom is lost. In practice the idle mount
has usually run by then, but on slow machines / huge profiles it may not.

Fix: swap the two lines (`showSection` mounts synchronously before its first `await`):
`void ctx.nav.showSection("timeline"); bus.emit("range:set", { range, source: "scope", reveal: true });`
WP4's listener already queues the zoom until the lazy timeline data is ready.

## R3 (WP1 / spec owner, `build.mjs` size budget) — gzip budget exceeded with all packages in

With WP2–WP5 code in the tree the bundle is ~926 KiB raw / ~239 KiB gzip (2026-10-29, live tree);
`build.mjs` fails both budgets (900 KiB raw, 200 KiB gzip). WP4's share is ≈ 140 KiB raw (167 KB as
4-space tsc output) / ≈ 44 KiB gzip (`views/stacks`, `views/timeline`, `views/memory`, styles 40/50/60). The bundle is still written, so all
checks can run; the budget decision belongs to the spec owner (see WP1-STATUS D1).

## R4 (WP6) — WP4 browser acceptance script

`design/requests/wp4-check.mjs` (now `tools/e2e/canvas.mjs`) is the Playwright script WP4 used for its acceptance evidence (flame
axis re-base, search share, staged zoom, keyboard walk announcements, lane totals, run ends,
brush/zoom/keys/wheel, Interleaved, thread filter incl. a synthetic "unknown" thread, memory rug and
pinned leaks, `?perf` budgets on huge). WP6 may fold it into `tools/check.mjs` / `tools/perf.mjs`.
It reads rendered pages from an `out/` directory given as the first argument.

## R5 (WP1, `src/model/timeline.ts` `segments(lane)`) — build lane segments in slices

§6.1 lists "timeline typed arrays and segments" among the lazy derivations that run in ≤ 8 ms slices.
`TimelineM.segments(lane)` builds a lane synchronously on first access: the main lane of huge.json
takes ≈ 30–45 ms (23,396 segments). WP4 keeps that out of the measured base draw (it pre-builds the
expanded lanes right after `model.timeline()` resolves and the other lanes in idle callbacks), but the
first build is still one task of that size. Suggested: a generator variant (`segmentsSliced(lane)` run
through `runSliced`) or building the segments inside `buildTimeline`'s existing slices.
