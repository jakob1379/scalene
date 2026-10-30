# Review round 1 — verification

Verifier: round-1 verifier, 2026-10-29. Inputs: fix reports `fix-{canvas,code,overview,shell-ai-core}.md`,
their hand-offs, and the four finding files (91 findings: 3 blocker, 35 major, 53 minor).
Cumulative QA record: `design/QA.md`.

**Result: 0 blocker and 0 major findings open.** One minor stays partly open (ml-training first
file switch 63 ms vs the 60 ms budget, §5). Every suite is green except that one perf check.

## 1. Hand-offs resolved

| From → to | Item | Resolution |
|---|---|---|
| code → shell | gzip headroom 0.05 KiB | `build.mjs` drops per-module `"use strict"` (the IIFE has it) and the space after `:`/`,` in CSS outside strings; dead exports removed (`textInput`, `frameStyle`, unused `FLAME_*`, `memoryTickLabel`): −0.69 KiB gz. After all verifier fixes: 987.5 KiB / **259.93 KiB gz** (headroom 0.07 KiB — see §6) |
| code → shell | virtual list drops focus when the focused row scrolls away | `core/virtual.ts`: the row holding focus stays mounted and is never moved in the DOM (a first version re-inserted it, which itself drops focus; caught by the new check). verify "focuskeep" 2/2 |
| code → shell | palette "Hot lines only" | "Show hot lines only (Hot only)" (+ keywords "hot only"); DESIGN §4.20 |
| code / overview → code | `showHiddenFiles` API | `CodeApi.showHiddenFiles()` + `Nav.showHiddenFiles()` (scroll, settle, open the list with the hidden group); the overview uses the Nav, the `__code` hook is no longer needed by it. e2e overview "hidden-files meta button…" |
| overview / canvas → canvas | Memory section peak callout trace-blind | planner moved to `charts/placement.ts` (`traceBand`, `hitsTrace`, `calloutSpots`, `planPeakClear`; re-exported by `scope-layout.ts`), `footprintTrace()` in `charts/footprint.ts`; scope and Memory chart both use it; `__memory.peak()` debug hook. verify "memcallout" 16/16 |
| overview → code | lens "500 main-thread samples" | "≥ 500 main-thread samples (Scalene keeps up to 500 per line)"; below the cap just the count |
| overview → shell | app bar AI affordance | "AI fixes" label + neutral "Set up" badge while no provider is ready; aria-label "AI fixes — set up a provider" / "AI fixes — <provider>, ready"; DESIGN §4.1 |
| overview → shell | readout wording / compact headline in the model | not moved (optional, no visible change; the view-level rewrite is idempotent and unit-tested) |
| overview → tools | linking NBSP regex; check-tokens `30-code.css:506` | already fixed by the shell and code fixers (linking 70/70, check-tokens green) |
| shell → overview | `.sw-phase` invisible in dark | outline `--control` (was `--line-strong`) |
| shell → overview | `drawSampleTicks` holes for the callout | not needed: the band is ≤ 0.5 alpha and the callout stays legible (shots `e2e/verify/recheck-linked-overlay-*.png`) |
| shell → stacks | flame memory caption "MiB of attributed allocation" | unit-free: "attributed allocation" / "in `save_checkpoint() :120` (36.8% of attributed allocation)" / compact "of alloc." |
| shell → overview | `scope.ts` `/ s$/` regex vs NBSP | uses the shared `spokenTime()` (exported from `model/hotspots.ts`) in the cursor announcement and the "No Python line at …" message |
| shell → memory | `growth 0%` for absent growth | Memory stats "Growth: not recorded" when `growthRecorded` is false |
| shell → code | "All files" Tab escapes to the document start | popover: Tab closes and moves past the trigger (`focusPastTrigger`), Shift+Tab returns to it; xs sheet: modal trap that also works from a roving option. verify "allfiles" 4/4 |
| shell → views | coarse targets `.fd-ref`, `.hs-more`, `.cv-h-btn` | invisible 32 px hit areas on `.fd-ref` / `.hs-more` (text does not move), `.cv-h-btn` 32 px under `pointer: coarse`. verify "coarse" |
| shell → views | perf: code column rebuild per width; file switch; theme | code view skips its row rebuild when only the height changed; hidden function view no longer re-renders on file switch; file-bar path measured once per frame (rAF); flame / timeline / memory repaint on `theme:changed` only within one viewport of the screen (`core/canvas.ts#nearViewport`), the rest when scrolled into range |
| canvas → overview | scope legend / readout "waiting" | "I/O & waits" ("suspended · I/O & waits" with TASKS; card "1.0 busy · 0.0 in I/O & waits · 0.1 GIL") |
| canvas → overview | Hotspots › Functions "ƒ train" | `train()` via `pyFnName` (same form as headline, lens, code, canvases) |
| canvas → overview / model | leak rates without a verb | readout rows "grows 5.71 MiB/s", short "grows 5.71 MiB/s", compact phrase "leak · grows 5.71 MiB/s" |
| canvas → model | "Top 1 files" | "Top file = 99.9% of run time" (unit) |
| canvas → shell | shortcuts heading "SIGNAL (SCOPE)" | "Signal" |
| canvas → model | `linePeak` value-only variant | not done (optional; the local strip is correct) |
| canvas / overview → spec | DESIGN amendments | applied: §3.4 LOD, §4.4.1–4.4.7, §4.5.2–4.5.3, §4.11.3–4.11.7, §4.12.1–4.12.3, §4.13.1–4.13.3, §5.2 M2/M6/M8, §2.3 xxl, §4.1, §4.20, §6.1 (marks, round-1 techniques) |

## 2. Found and fixed by the verifier

1. **Ligatures on in three code surfaces** (must-fix 1): key chips, the lens location `.cd-loc` and
   function-view source `.cv-src` computed `font-variant-ligatures: normal` because a later `font:`
   shorthand reset it. `01-base.css` now forces `none` (and `liga/calt/dlig 0`) with `!important` on
   every code surface including `.cv-src`. verify "mustfix 1": 121 surfaces, 0 bad.
2. **Theme toggle over budget** on ml-training (85–93 ms for the first toggles in a full run): off-screen
   canvases no longer repaint synchronously → 57.5 / 42.6 / 36.3 ms (budget 60).
3. **File switch over budget** (89 / 66 ms): hidden function view and per-write path measurement removed
   → 63.4 / 44.4 ms (first switch still 3 ms over; §5).
4. **Virtual list focus fix regression** (see §1): moving the kept node dropped focus.
5. `performance.mark("scalene:load")` at `load()` entry so `model.build()` is measured from the call,
   not from DOMContentLoaded.

## 3. Blocker and major findings of round 1 — re-checked

38 entries (3 blocker, 35 major; `memory-axis-mixed-units` was filed by two reviewers). Status
after verification: **all 38 confirmed fixed**. "e2e x" = a named check in `tools/e2e/x.mjs`,
"verify" = `tools/e2e/verify.mjs` (new this round), "unit" = `tests/unit/*`.

| Sev | Finding | Status | Evidence |
|---|---|---|---|
| blocker | profile-script-breakout | fixed | build template check (escaped `<`, inlined once); unit `contract.test.mjs` (real jinja2, both modes, hostile sources evaluated in `vm`); `check.mjs` loads `scriptbreak` × 2 modes × 2 themes × 8 viewports: no `window.__pwned`, `profile` defined |
| blocker | short-empty-signal-card | fixed | e2e overview "cpu-only 1000x400 light/dark: scope has a channel or is absent"; shot `final/cpu-only-1000x400-{light,dark}.png` (TOP 5 strips, no empty box) |
| blocker | scope-card-sc-row-collision | fixed | verify "scopecard (light/dark): .sc-row computed flex, one line" (3 rows); build lint `css-ownership` rejects bare classes defined in two packages; `.sw-phase` outline now `--control` (visible in dark); shots `e2e/verify/scopecard-{light,dark}.png` |
| major | code-sort-fold-focus-lost | fixed | e2e code round1 "Enter on every code header button keeps focus", "Enter / Space on a fold moves focus to the first revealed line", "sorting the function view keeps focus" |
| major | timeline-showall-focus-lost | fixed | e2e canvas "'+ show all N levels' keeps focus (both directions)" |
| major | popup-tab-escapes-to-document-start | fixed (last part by the verifier) | e2e shell-ai "popups" (program popover, Sections, ⋯ More); the code "All files" popover was still open → `filenav.ts` now closes and calls `focusPastTrigger`; the xs sheet keeps a modal trap that also works from a roving option; verify "allfiles" 4/4 |
| major | forced-colors-state-and-data-loss | fixed | e2e shell-ai "forced colors (light/dark)": selected ≠ unselected, meters visible, nav underline |
| major | touch-scope-tap-jumps | fixed | e2e overview "touch: first tap shows the readout card (no jump)", "a second tap … opens the line" |
| major | touch-flame-timeline-no-details | fixed | e2e canvas "touch: first tap on a frame pins its details, no zoom", "a second tap on the same frame zooms" |
| major | resize-relayouts-every-section | fixed | verify "resize ml-training / huge: 1440→1280 drag in 8 px steps": 0 long tasks, frame p95 16.8 ms (33 ms in an earlier run), no overflow (reviewer: 4 long tasks of 50–57 ms, p95 50 ms); code view now also skips its row rebuild on height-only resizes |
| major | timeline-lane-heads-touch-target | fixed | e2e canvas "lane headers and 'show all' are ≥ 24 px tall" (32 px coarse) |
| major | short-time-split-unlabeled | fixed | e2e overview "short time split keeps its labels (light/dark)" |
| major | busiest-function-no-denominator | fixed | e2e overview golden readouts cpu-only; verify "busiest-function … 1440" and "1000×400 compact: keeps 'of run'" |
| major | short-hotspot-rows-lose-file-and-waiting | fixed | verify "short-hotspot-rows (async 1000×400): file:line never truncated; 'loop · waiting'"; shot `e2e/verify/recheck-async-1000x400.png` |
| major | hotspot-memory-secondary-clipped | fixed | e2e overview "hotspots Memory: '% of alloc.' secondary is never clipped" |
| major | readout-captions-drop-context-at-1440 | fixed | verify "readout-captions 1440 (ml): no clipped caption text; 'stayed live'; 'mean · main thread'" |
| major | hundred-more-opens-one-file | fixed | verify "'N more lines' expands the ranking in place" (8 → 25 rows, no scroll, "Top 25 lines = 79.7%"); unit `nextExpansion` |
| major | fold-copy-says-without-samples | fixed | e2e code round1 "folds with sampled lines say 'below 1% each'"; unit every fold of train.py |
| major | source-column-starved | fixed | e2e code round1 "1440×900 source ≥ 640 px … 640×400 source ≥ 380 px; actions never cover the code" |
| major | timeline-lod-grey-not-in-legend | fixed | e2e canvas "timeline legend decodes the neutral LOD colour"; shot `final/ml-training-1440x900-dark-timeline.png` |
| major | timeline-show-in-no-caption | fixed | e2e canvas "'Show in timeline' says what it shows", "Clear removes the caption" |
| major | memory-axis-mixed-units (×2) | fixed | unit `axis.test.mjs` (one unit per axis); verify "memory flame axis labels share one unit" (0, 0.2 GiB … 2.8 GiB); caption now unit-free |
| major | palette-file-fuzzy-beats-code | fixed | unit "ml-training: palette: 'loss' opens the loss.item() line, never adamw.py"; e2e code "palette 'loss.item' → Enter" |
| major | empty-state-wrong-for-empty-profile | fixed | e2e shell-ai empty titles; shot `final/empty-*-{light,dark}.png` ("Scalene collected no samples"; CTA above the fold at 1000×400) |
| major | ai-setup-card-assumes-aws | fixed | e2e shell-ai first-time card ("Choose an AI provider …", focus on a provider radio), stored-Bedrock card keeps the AWS copy; unit `wp5-ai` |
| major | no-way-back-after-show-in | fixed | e2e shell-ai "wayback" 5/5 |
| major | threads-busy-depends-on-viewport | fixed | e2e overview "THREADS scale and concurrency sentence are width-independent"; unit `maxConcurrent` = 5 on ml |
| major | linked-overlay-opaque-band | fixed | unit charts "dense ticks never compound past 0.5", "holes are clipped"; shots `e2e/verify/recheck-linked-overlay-{light,dark}.png` (footprint, peak ring and callout readable through the band) |
| major | peak-callout-occludes-trace | fixed (Memory chart by the verifier) | e2e overview geometry 24 checks (scope); the Memory section chart now uses the same planner (moved to `charts/placement.ts`, `footprintTrace` in `charts/footprint.ts`): verify "memcallout" 16/16 (ml, async, huge, neuron × 390/1024/1440/2560: never within 4 px of the trace, inside the plot) |
| major | xs-yticks-collide-with-data | fixed | e2e overview geometry (every y-tick x ≥ plot right edge at every size) |
| major | intro-readouts-zero-values | fixed | e2e overview "readout intro: no value or caption before its label" |
| major | glow-plus-lighter-drops-frames | fixed | verify "intro: ml-training 2560×1440 dark sweep (120–760 ms) ≥ 55 fps, no frame > 50 ms": 60 / 60 / 60 fps, max frame 16.8 ms (reviewer: 40–49 fps) |
| major | hotspot-metric-flip-overlap | fixed | e2e overview "M8: leaving rows fade before rows move; moving rows hide what they pass" (44-frame filmstrip) |
| major | cpu-only-short-empty-scope | fixed | duplicate of short-empty-signal-card (same evidence) |
| major | cpu-only-top-lines-barcode | fixed | e2e overview "cpu-only TOP LINES: one row per visible hotspot, rows ≤ 32 px" |
| major | timeline-lod-grey-slab | fixed | unit `canvas-round1.test.mjs` (grey ≤ 20 % of the painted main lane at dpr 1 and 2; measured 0.0 % on ml/async/huge); shot `final/ml-training-1440x900-dark-timeline.png` |
| major | phase-short-cells-invisible | fixed | check-tokens pair `--control on --surface` ≥ 3:1 (3.30 / 4.03); shots `final/*-1440x900-*.png` |

**Open blocker + major after verification: 0.**


### Minor findings (53)

All fixed (by the fixers, or by the verifier through the hand-offs above), except
**budget-ml-theme-file-switch: partly** (theme toggle now within budget; ml-training's first file
switch 63–70 ms vs 60 ms, repeat switches 35–44 ms). The four minors that were only partly fixed in
the fix reports are now complete: cross-view-terms-inconsistent (scope "I/O & waits", Hotspots
`train()`, shortcuts "Signal"), memory-section-copy (overview leak rates "grows"),
pluralization-counts ("Top file"), ai-discoverability-overview (app bar "AI fixes · Set up"),
hidden-files-meta-button-noop (real API), coarse-pointer-targets-24px (view-owned targets).

## 4. Test matrix (final run, same tree)

| Step | Result |
|---|---|
| `node build.mjs` | pass — 987.5 KiB raw, 259.93 KiB gz (budget 1,000 / 260) |
| `node tools/unit.mjs` | 390 passed, 0 failed, 1 skipped (upstream parity, needs `SCALENE_SRC`) |
| `node tools/check-tokens.mjs` | pass (tokens, ligature-free mono, 125 contrast pairs, radii) |
| `node tools/render-fixture.mjs` | 11 inputs × 2 modes |
| `node tools/check.mjs` | **352 page loads pass** (11 inputs × standalone/linked × light/dark × 320/360/390/600/1024/1440/2560 + 1000×400): no console errors, no overflow (also with lens and drawer open), titles, skeletons, empty states, no script breakout, theme toggle |
| `node tools/e2e.mjs` | overview 67/67, code 60/60, canvas 61/61, shell-ai 187/187, linking 70/70, **verify 63/64** (the one failure: ml first file switch 63.4 ms vs 60) — 508/509 |
| `node tools/shots-final.mjs` | 94 screenshots in `design/screens/final/`, no console errors, no overflow |

## 5. Performance (final run, `out/e2e/perf.json`)

See `design/QA.md` §5 for the table against the §6.1 budgets. Headlines: model 37 / 102 ms (ml /
huge, budgets 40 / 250), overview painted 204 / 263 ms (300 / 1,000), long tasks after overview
≤ 60 ms, DOM 1,509 / 1,829, heap 7.1 / 26.4 MB, theme 57.5 / 48.4 ms first toggle, file switch
63.4 / 70.1 ms first switch, sort ≤ 5 ms, resize storm 0 long tasks (p95 16.8 ms), intro sweep
60 fps at 2560×1440 dark.

## 6. Notes for round 2

- **Bundle gzip headroom is 0.07 KiB.** Any growth fails the build. Options for the spec owner:
  drop leading indentation from the shipped bundle (measured −8.7 KiB gz; `build/` keeps the
  readable modules, names and line breaks stay), or re-baseline the 260 KiB budget (upstream ships
  445 KiB gz).
- ml-training first file switch (63–70 ms) is the only §6.1 miss; the remaining cost is the
  synchronous re-render of ~40 rows and its layout (software raster in headless Chromium).
- Model build on ml-training sits near its 40 ms budget in Chromium (25–41 ms per run, median 37 ms;
  Node: 15 ms).
- The intro's first 120 ms (before the sweep) occasionally shows one 33–67 ms frame (lazy work);
  the sweep itself is 60 fps.
- Not covered by automation yet: the §6.2.11 accessibility-tree walker; `vscode://` fallback
  (not interceptable in Chromium).

## 7. Progress log (restart-safe; newest last)

- Baseline: build green (991.8 KiB, 259.95 KiB gz — 0.05 KiB headroom), unit 390/0/1, check-tokens green.
- Build budget: build.mjs now drops per-module "use strict" and the space after ':'/',' in CSS (outside strings); removed dead exports (textInput, frameStyle, FLAME_* unused, memoryTickLabel). 984.3 KiB / 259.31 KiB gz.
- Handoffs resolved in code (step 1): filenav popover Tab → focusPastTrigger (sheet keeps a robust trap); trace-aware planner moved to charts/placement + footprintTrace (scope + Memory chart); .sw-phase outline --control; scope legend/readout "I/O & waits"; Hotspots functions "train()"; leak "grows 5.71 MiB/s" (tiles, short, compact phrase); paretoText "Top file"; shortcuts "Signal"; palette "Show hot lines only (Hot only)"; lens "≥ 500 … (Scalene keeps up to 500 per line)"; flame memory caption unit-free; scope spokenTime (NBSP-safe); memory "Growth not recorded"; coarse hit areas .hs-more/.fd-ref, .cv-h-btn 32 px; CodeApi.showHiddenFiles + Nav.showHiddenFiles; virtual list keeps the focused row mounted; app bar "AI fixes" + "Set up" badge; code relayout skips rebuild on height-only resizes. Unit 390/0/1 after.
- DESIGN.md: canvas + overview round-1 amendments from the hand-offs applied (§3.4 LOD, §4.4.1–4.4.7, §4.5.2–4.5.3, §4.11.3–4.11.7, §4.12.1–4.12.3, §4.13.1–4.13.3, §5.2 M2/M6/M8, §2.3 xxl, §4.1 AI fixes, §4.20 palette).
- e2e run 1 (after hand-off fixes): overview 67/67, code 60/60, canvas 61/61, shell-ai 187/187, linking 70/70 = 445/445.
- New suite tools/e2e/verify.mjs (added to tools/e2e.mjs): allfiles Tab, focus kept on scroll, Memory callout vs trace (4 fixtures × 4 sizes), copy hand-offs, coarse targets, scope card blocker, §6.1 perf table, resize storm, intro fps.
- Found + fixed while verifying: (1) virtual list moved the kept focused row with insertBefore, which drops focus → the kept row is never moved; (2) theme toggle over budget on ml (85–93 ms first toggles) → flame/timeline/memory repaint only near the viewport (nearViewport); (3) file switch over budget (89/66 ms ml) → hidden function view no longer re-renders on file switch, file-bar path measured once per frame; (4) added performance.mark("scalene:load") so model build is measured from load() entry.
- Perf after: ml theme 40.8/30.3/24.7 ms (≤ 60), file switch 70.1/35.1 ms (first switch still > 60, minor), huge theme 39/31/34 (≤ 100), file switch 50.6/36; ml model 29 ms, huge 84 ms; overview 167 / 225 ms; long tasks after overview max 64 / 78 ms; DOM 1509 / 1829; heap 7.1 / 26.5 MB; resize storm 0 long tasks, p95 33 ms; intro sweep 60 fps at 2560 dark.
- check.mjs matrix (before the ligature fix): 352 page loads pass (11 inputs × 2 modes × 2 themes × 8 viewports), no console errors, no overflow.
- Must-fix spot checks (verify --only mustfix) found key chips, the lens location (.cd-loc) and function-view source (.cv-src) with ligatures ON (a later `font:` shorthand resets font-variant-ligatures) → 01-base.css forces ligatures off (!important) on every code surface incl. .cv-src. mustfix 4/4 after.
