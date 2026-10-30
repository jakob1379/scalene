# WP6 Integration — report

**State: integrated, everything green** (2026-10-29). Build, 346 unit tests, token check, the 288-load
Chromium matrix and 364 browser acceptance checks in 5 suites pass on the integrated tree.

WP2–WP5 were built in parallel against WP1's frozen interfaces. WP6 owns every file after hand-over
(DESIGN.md §8.6). This pass: (1) the cross-package change requests, (2) stub removal, (3) a green
build/unit/render/browser matrix, (4) the cross-view linking audit, (5) every package's acceptance
script folded into the repo.

## 1. Change requests

| Request | Change | Files |
|---|---|---|
| WP2 R1 — code tabs scroll the page on load | Already fixed by WP3 (`revealIn` scrolls only the strip/rail/panel). Now guarded: `tools/e2e/overview.mjs` fails if `scrollY ≠ 0` 1.5 s after load at 1440×900, 390×844 and 1000×400; the old `scrollTo(0, 0)` workaround is gone. | `tools/e2e/overview.mjs` |
| WP2 R2 — lazy sections mount during the intro | With motion on, lazy mounts (IntersectionObserver + idle) start 1,050 ms after the overview mounts (intro settles at origin + 900 ms) or on the first scroll, whichever comes first. `jumpTo`, nav, palette, hash and the globals still force-mount synchronously. Reduced motion / `?still`: unchanged (immediate). | `src/views/app.ts` |
| WP2 R3, WP3 §2, WP4 R3, WP5 #1 — bundle budget | Decided in DESIGN.md §6.1: ≤ 1,000 KiB raw and ≤ 260 KiB gzip (`build.mjs` checks both). Current: see §3. | `build.mjs` (already amended) |
| WP3 §1 — app-bar blur costs scroll frames at 2560 | At `xxl` (≥ 2200 px) the app bar is opaque `--page` without `backdrop-filter`; below `xxl` it keeps the §4.1 glass. | `src/styles/10-appbar.css` |
| WP3 §3 — unhandled `AbortError` on load | Not reproducible in the integrated tree: the controller catches every rejection (`aborted` → silent). Every suite and the matrix fail on any page error; none is raised. | — |
| WP4 R1 — mono frame-tooltip titles | `TooltipContent.mono?: boolean` renders `.tt-title.code` (mono, ligatures off via the global `.code` rule); `.tt-rows` is `auto minmax(0, 1fr)` and `.tt-value` wraps anywhere globally. Flame and timeline set `mono: true` on frame tooltips; the `tt-flame` class toggles and their CSS are gone. | `src/core/tooltip.ts`, `src/styles/04-layers.css`, `40-stacks.css`, `views/stacks/flame.ts`, `flamemodel.ts`, `views/timeline/timeline.ts`, `frames.ts` |
| WP4 R2 — "Open in timeline" loses the zoom | `nav.showSection("timeline")` (mounts synchronously) now runs before `bus.emit("range:set", {reveal: true})`. | `src/views/overview/scope.ts` |
| WP4 R4 — adopt `wp4-check.mjs` | Folded into `tools/e2e/canvas.mjs` (see §5). | `tools/e2e/canvas.mjs` |
| WP4 R5 — build lane segments in slices | `TimelineM.segmentsSliced(lane)` runs the (now generator) segment builder through `runSliced` (≤ 8 ms slices) and shares the cache with `segments(lane)` (one object per lane, also when a sync call wins the race). The timeline view awaits the first-draw lanes sliced before its first layout and pre-builds the rest one lane per idle period. | `src/model/timeline.ts`, `src/views/timeline/timeline.ts` |
| WP5 #2 — keep the report when `buildModel` throws | `load()` builds the model before tearing down; on failure it shows the error toast, logs the error and keeps the current report (a first load falls back to the empty state). | `src/views/app.ts` |
| WP5 #3 — redundant layout rules | `.empty-state` layout and the footer flex rules removed from `02-layout.css` (`80-shell.css` owns them; the footer keeps its max width). | `src/styles/02-layout.css` |
| WP5 #4 — `openAiSettings(field)` | No change needed (WP5's drawer already accepts ids and field names). | — |

## 2. Stubs and integration fixes found by the audit

- **Stubs:** no `// STUB` code path is left in `src/`; `.stub-card` (02-layout.css) removed.
- **Sections landed 128 px below the app bar** (every `showSection` / toggle global / hash jump):
  `html { scroll-padding-top }` and `.report-section { scroll-margin-top }` both added the app-bar
  offset. Sections now carry no scroll margin (`main#main > .report-section`, which also outranks the
  template's `.combined-stacks-section` margin, §7.1); the heading lands 12 px under the bar.
- **Flame double-click did not navigate:** `pointerdown.detail` is always 0 in Chromium, so the
  "first click" frame was overwritten by the second press — which, after the zoom the first click
  starts, sits on another frame. The frame is now taken from `click` with `detail === 1`.
- **Stale load-error toasts:** persistent error toasts from failed loads (bad JSON, failed build,
  loader errors) stayed on screen after a later successful load; they are dismissed when the next
  profile loads (`views/app.ts`, `views/shell/loader.ts`).

## 3. Results (integrated tree, 2026-10-29, headless Chromium, node 22)

| Run | Result |
|---|---|
| `node build.mjs` | pass — strict type-check, §7.5 literals, forbidden strings, TS-entry shape, template; bundle **927.0 KiB raw / 239.0 KiB gzip** (budget 1,000 / 260) |
| `node tools/unit.mjs` | **346 passed**, 0 failed, 1 gated skip (upstream parity, needs `SCALENE_SRC`); new `wp6-integration.test.mjs` (6): sliced = sync segments on ml, async, huge (every lane, identical arrays), shared promise / one object per lane, mono frame-tooltip titles, section presence rules |
| `node tools/check-tokens.mjs` | pass — §3.2 byte-identity, ligature-free mono stack, 125 contrast pairs |
| `node tools/render-fixture.mjs` | 9 inputs × standalone + linked → `out/` |
| `node tools/check.mjs` | **288 page loads pass** (9 inputs × 2 modes × 2 themes × 8 viewports): zero console/page errors, no horizontal overflow from 320 to 2560 px (phones with `isMobile`, DPR 3) and at 1000×400, `visualViewport.scale = 1`, layout classes, titles, section skeletons, empty states; in standalone also no overflow with the lens open and with the AI drawer open; theme toggle keeps scroll and persists. 4 m 19 s. |
| `node tools/e2e.mjs` | **364/364**: overview 38/38, code 48/48, canvas 45/45, shell-ai 163/163, linking 70/70 (≈ 6 min) |

**Cross-view linking audit** (`tools/e2e/linking.mjs`, ml-training unless noted, motion on). Each jump
must land with focus on the `role=row` in `#code`, the row selected, flashed (M14), announced
("train.py line N selected…"), on screen, with the lens (or the dock at ≥ 1600) open, and no overflow:

| Source (§4.8.12 / §4.4.6) | Landing |
|---|---|
| Hotspot click (code section not yet mounted), Enter (code suite), tap at 390×844, reduced motion | L:173 / L:165 ✓ |
| Headline chip `train()` (1440 lens, 1920 dock); async-server chips `asyncio.run(…)`, `hashlib.pbkdf2_hmac(…)` and ref `handlers.py:51` | H:124 (function header) / L:99 / L:51 ✓ |
| Readout reference (`train.py:120`), finding evidence button, finding card | ✓ |
| Scope: TOP LINES row 1 click, labelled PHASE cell click, keyboard Enter at the cursor | L:173 / phase line / cursor line ✓ |
| Minimap slider Enter | the slider's hot line ✓ |
| Flame double-click (`train:165`; was broken, §2), `g` (code suite) | L:165 ✓ |
| Timeline segment click and Enter (after `focusLine(train.py:120)`) | L:120 ✓ |
| Memory: peak location chip, site double-click, site Enter | L:120 ✓ |
| Palette: Lines result "loss.item", Functions result "train" | L:173 / H:124 ✓ |
| `vsNavigate(escape(loader.py), 33)`; after `load(async)`, `vsNavigate(handlers.py, 51)` | L:33 / L:51 ✓ |
| Show in stacks: hotspot `f`, code row `s` | flame canvas focused on the line's frame, announced ✓ |
| Show in timeline: code row `t`; scope range → "Open in timeline" | timeline focused segment / domain = brushed range (16.2–29.8 s) ✓ |
| Linked overlay caption (§4.4.6) from hotspot row, headline chip, finding card, readout ref, code row, memory site, flame frame, timeline segment | `.scope-desc .link-loc` names the line and clears on leave ✓; a selection stays in the caption until Esc ✓; flame tooltip title is `.code` with ligatures off ✓ |

**Window globals (§7.3)**: all 22 functions installed; `globalThis.profile` raw; `toggleCombinedStacks` /
`toggleMemoryStacks` / `toggleCombinedStacksTimeline` focus `#stacks-h` / `#timeline-h`, set the hash and
tab, and land the section under the bar; `expandAll` / `collapseAll`; `toggleDisplay("file-2")`;
`onFileDisplayModeChange("file-1")` with a written `.value`; `changeTimelineViewMode` for
`interleaved` / `swimlanes` / `main`; `proposeOptimizationLine` / `Region` → AI cards (setup state);
`toggleServiceFields` builds the drawer; `toggleReduced` no-op; `load(object)` re-renders another
fixture, `load(sameObject)` within 1 s is skipped, `load(jsonText)`, `load("{ nope")` and a profile that
fails to build keep the report with an error toast, `load("")` → empty state, a later load dismisses the
error toasts; `clickToLoadFile()` → picker → file loads; `loadFile()` reads `#fileinput`; `loadDemo()`
loads `example_profile`; `loadFetch()` over http loads `profile.json`. (The other AI globals are
exercised by `tools/e2e/shell-ai.mjs`.)

**Intro long tasks (WP2 R2)**, `?perf`, 1440×900, 3 runs each, long tasks overlapping intro origin…+900 ms:

| | HEAD (before) | WP6 |
|---|---|---|
| ml-training | 58 ms, 0, 0 | 0, 0, 0 (section mounts after the intro: 52–56 ms tasks, ≤ 100 ms budget) |
| huge | 63, 170 (sum), 55 ms | 0, 0, 0 (after: ≤ 55 ms, ≤ 200 ms budget) |

## 4. Notes and open items

- `vsNavigate` outside the profile sets `location.href = "vscode://file/…"`; Chromium does not let
  the test intercept `location.href`, so that branch is covered by WP1's smoke test only.
- The suites measure frame and draw times (code scroll p95, flame/timeline base draws on huge);
  run them on an otherwise idle machine (`tools/e2e.mjs` runs them sequentially).
- Not in this pass (left for the WP6 review rounds): the §6.2.11 accessibility-tree script, the perf
  table on huge/ml as one tool (`tools/perf.mjs`), filmstrip/shots tools and the committed screenshot
  set, and the §1.4 / §8.8 sign-off document.

## 5. Acceptance suite in the repo

| Command | What |
|---|---|
| `node tools/check.mjs` | Matrix: 9 inputs × 2 template modes × 2 themes × 8 viewports (320, 360, 390, 600, 1024, 1440, 2560 + 1000×400). Console/page errors, overflow, `visualViewport.scale`, layout classes, title, section skeleton, empty state; in standalone mode also overflow with the lens open and with the AI drawer open (§6.2.9); theme toggle. `--e2e` then runs the suites. |
| `node tools/e2e.mjs` | Runs every suite below in sequence; tally in `out/e2e/summary.json`. |
| `node tools/e2e/overview.mjs` | WP2 acceptance (from `design/screens/wp2/tools/check.mjs`) + no load-time scroll. |
| `node tools/e2e/code.mjs` | WP3 acceptance (from `design/screens/wp3/wp3-check.cjs`). |
| `node tools/e2e/canvas.mjs` | WP4 acceptance (from `design/requests/wp4-check.mjs`). |
| `node tools/e2e/shell-ai.mjs` | WP5 acceptance (from `tools/wp5-check.mjs`). |
| `node tools/e2e/linking.mjs` | WP6 cross-view linking audit + §7.3 globals (new). |

Shared setup: `tools/e2e/_env.mjs` (paths, Playwright, page opener, report → `out/e2e/<suite>.json`).
`SCALENE_ROOT=<tree>` points a suite at another tree's `out/`; `SHOTS=<dir>` moves its screenshots
(default `design/screens/e2e/<suite>/`, gitignored).
