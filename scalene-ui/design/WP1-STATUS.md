# WP1 Foundation — status

> **WP6:** every stub of §4 below is replaced by its package (no `// STUB` path is left), the `.stub-card` rules are gone, D1 is decided (§6.1 budget ≤ 1,000 KiB raw / ≤ 260 KiB gzip), and `tools/check.mjs` is now the full matrix (both themes, lens/drawer overflow, `--e2e`). See `design/WP6-INTEGRATION.md`.

**State: integrated and accepted** (all four §8.6 WP1 acceptance items pass, see §2). WP1a (core, shell,
template, tools) and WP1b (model, charts, tests) are merged into one tree. The §8.3/§8.4 interfaces are
frozen as implemented below. WP2–WP5 replace the stubs listed in §4.

Run everything from `scalene-ui/`:

```sh
node build.mjs                      # types, bundle, §7.5 literals, forbidden strings, template, ≤ 450 KiB
node tools/unit.mjs                 # 226 tests (TZ=UTC); SCALENE_SRC=<scalene checkout> runs the upstream parity test
node tools/check-tokens.mjs         # §3.2 byte-identity, ligature-free mono stack, §3.7 contrast (125 pairs)
node tools/render-fixture.mjs       # out/<fixture>.html (standalone) + out/<fixture>.linked.html
node tools/check.mjs                # Chromium matrix: 9 fixtures × 2 modes × 8 viewports + theme toggle
```

## 1. What exists

| Area | Files | Notes |
|---|---|---|
| Build | `build.mjs`, `tsconfig.json` | tsc → CommonJS → one IIFE with a tiny `require()` registry. CSS from `src/styles/*.css` (name order, comments/whitespace stripped) → `src/generated/styles.ts`. Emitted JS is re-indented with tabs (see §5 D1). Post-build checks: §7.5 bundle literals, forbidden strings (`</script`, `<!--`, `experimental`, `bg-warning text-dark`, fixture markers), TS-entry text shape (the upstream slicing test), template contract, size budget. |
| Template | `template/index.html.template` | Exactly §7.1. Verified byte-identical against upstream's own `scalene_utility.generate_html` (standalone and not) and `launchbrowser.generate_html` (see §2 below). |
| Entry / facade | `src/main.ts`, `src/scalene-gui.ts` | `main.ts`: inject CSS, host/theme/motion/layout before first paint, store, app, globals, heartbeat, `?perf` observers. Never calls `load()`. `scalene-gui.ts`: §7.5 excerpt shape + every §7.3 global. |
| Core | `src/core/{dom,store,bus,format,layout,theme,motion,schedule,storage,canvas,a11y,tooltip,toast,icons,controls,virtual,host}.ts` | All §8.2 modules. |
| Model | `src/model/{normalize,classify,syntax,memory,lazy,model,timeline,stacks,visibility,headline,readouts,findings,hotspots,search,source,phrases,thresholds,sites}.ts` | §4.0 data layer; Appendix A goldens unit-tested. Lazy parts (timeline, flame, call context, search) are sliced (≤ 8 ms steps). |
| Charts | `src/charts/{axis,placement,meter,sparkline,raster,footprint,color}.ts` | DOM meters/axes/sparklines, canvas raster/rug/footprint, callout placement. Tested in Node with a fake DOM and a recording canvas. |
| Shell | `src/views/app.ts`, `src/views/appbar.ts` | §2.1 anatomy, lazy sections (reserved-height placeholders, IntersectionObserver `rootMargin 100%` or idle), empty-state switch, layer root, Nav, global keys, idempotent `load()`, hash jump after first paint, perf marks. App bar per §4.1/§2.4.1 at every breakpoint. |
| Styles | `src/styles/00-tokens.css` (byte-identical to §3.2), `01-base`, `02-layout`, `03-controls`, `04-layers`, `10-appbar`, `90-motion` | |
| Tools | `tools/render-fixture.mjs`, `tools/unit.mjs`, `tools/check-tokens.mjs`, `tools/check.mjs` | |
| Tests | `tests/unit/*.test.mjs` (20 files) + `_harness.mjs`, `_dom.mjs` | |
| Screens | `design/screens/wp1/` | Shell at 390×844, 1000×400, 1440×900, 2560×1440 (light, all fixtures) and 390×844 / 1000×400 / 1440×900 dark. |

## 2. Acceptance (§8.6 WP1)

Verified on 2026-10-29 in this tree (node 22, tsc 6.0.2, Chromium via Playwright, python3 + jinja2 3.1.6).

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `node build.mjs` passes: types, literals, forbidden strings, size budget | **pass** | 66 modules, `dist/scalene-gui-bundle.js` **348.5 KiB** (gzip 94.4 KiB) of 450; all post-build checks green |
| 1 | `node tools/unit.mjs` passes | **pass** | 20 files, 226 tests: 225 pass, 1 gated skip (upstream parity, runs with `SCALENE_SRC`; passes, 15/15 in `contract`). Covers §4.0.2 formatter rows + edge cases, Appendix A goldens (split/outside, top-8 + Pareto 58.4%, GPU 66.9%/22.8%, peak 3.11 GiB at 52.9 s, leak order, lane totals 0.6/2.8/0.9, 2.1/4.0/1.6, async I/O 95.7%), headline strings for all 7 fixtures, readout slots, finding ids, classify totals, `pickNiceTickInterval`, `niceMemStep`, `shortCode`, visibility predicates (literal upstream port), placement, §2.1 section presence, shell helpers |
| 2 | `render-fixture.mjs` renders all 8 fixtures in both modes | **pass** | 9 inputs (8 fixtures + synthetic `blank` = `""`) × standalone/linked → `out/` |
| 2 | Template renders exactly like upstream `generate_html()` | **pass** | Node renderer == real jinja2 byte-for-byte on all 18 pages; upstream's own `scalene_utility.generate_html` (standalone and `standalone=False`) and `launchbrowser.generate_html` (no `standalone` variable) run on our template + bundle produce byte-identical pages (`contract.test.mjs`, `SCALENE_SRC=…`) |
| 2 | Chromium: zero console errors, app bar + section skeleton, `document.title`, empty state | **pass** | `tools/check.mjs`: 144 page loads (9 inputs × 2 modes × 7 widths + 1000×400, plus theme toggle), 0 console/page errors; the section list equals the §2.1 rules per fixture; `empty`/`blank` show the empty state with only logo, Load, Theme and title "Scalene" |
| 3 | `tools/check-tokens.mjs` | **pass** | `00-tokens.css` byte-identical to §3.2; mono stack ligature-free; 125 contrast pairs meet §3.7 in both themes |
| 3 | Theme toggle works and persists | **pass** | click flips `data-theme`, keeps `scrollY`, updates the button label; reload keeps the choice |
| 3 | Layout classes at the 7 reference widths; no overflow at 320 | **pass** | `bp-xs/sm/md/lg/xl/xxl` + `short` asserted at 320, 360, 390, 600, 1024, 1440, 2560 and 1000×400; `scrollWidth === clientWidth` and `visualViewport.scale === 1` everywhere (phones with `isMobile`, DPR 3) |
| 4 | `src/scalene-gui.ts` satisfies §7.5 | **pass** | `build.mjs` and `contract.test.mjs` re-implement every check of upstream `tests/test_combined_stacks_gui.py` (bundle literals, TS-source helpers, the `renderCombinedStacksTimeline` / `renderTimelineContent` slicing, template CSS, marker text, data path, "experimental", minimal profile, both modes) |

Extra shell smoke (Chromium, ml-training): all 22 §7.3 globals installed; `globalThis.profile` is the raw
object; `load(sameObject)` within 1 s is skipped; `toggleCombinedStacks()` / `toggleCombinedStacksTimeline()`
scroll, focus `#stacks-h` / `#timeline-h` and set the hash; `load("{ nope")` shows a persistent error toast
and keeps the report; `load("")` shows the empty state and resets the title; `vsNavigate` of a file outside
the profile goes to `vscode://file/…:3:1`; first Tab shows "Skip to main content" at (8, 8); no network
request on `file://`.

Screenshots (looked at): `design/screens/wp1/<fixture>-{390x844,1000x400,1440x900,2560x1440}-light.png` and
`<fixture>-{390x844,1000x400,1440x900}-dark.png` for all 9 inputs. They show the app bar at each
breakpoint (inline nav + search field at 1440, icons + ⋯ at 390 and in the 40 px `short` bar), the
interim headline card from the WP2 stub, and the reserved-height section placeholders.

## 3. Interfaces as implemented

The §8.3 and §8.4 contracts are implemented **exactly** (same names, members and signatures). Where a
module offers more, it is an additive extension; code written against the spec compiles unchanged.

| Spec contract | Implemented in | Conformance |
|---|---|---|
| `Breakpoint`, `DisplayMode`, `Metric`, `ColumnKey`, `SortState`, `Target`, `SectionId`, `FlameColorMode`, `AppState`, `Store<S>`, `createStore` | `core/store.ts` | exact; plus `initialAppState()`, `profileStateReset()`, `sameTarget()` |
| `Source`, `JumpOptions`, `Events`, `Bus<E>` | `core/bus.ts` | exact; `createBus<E>()` |
| `Nav`, `CodeApi`, `StacksApi`, `TimelineApi`, `ViewContext`, `ViewHandle`, `MountFn` | `views/app.ts` | exact (`ViewContext.tooltip` is `Tooltip`, `motion` is `MotionApi`, `host` is `HostApi`, `ai` is `AiController`) |
| `ThemeApi` | `core/theme.ts` | exact; the shell holds `ThemeController` (+ `source()`, `toggle()`, `invalidate()`, `destroy()`) |
| `CanvasPair`, `createCanvasPair`, `hatch`, `fitText` | `core/canvas.ts` | exact; plus `roundRect`, colour maths (`parseColor`, `alpha`, `mixOklab`), `setFont/monoFont/uiFont`, `observeSize` |
| `VItem`, `VirtualList<T>`, `createVirtualList` | `core/virtual.ts` | exact; options add optional `topInset()` and `maxRendered` |
| `TooltipContent`, `Tooltip` | `core/tooltip.ts` | exact; plus `bindTooltip(t, el, content)` for DOM controls (300 ms intent, instant on keyboard focus) |
| `Toast` | `core/toast.ts` | exact (`ToastSpec` names the argument type) |
| `Announcer` | `core/a11y.ts` | exact; plus modal manager (inert + focus trap + Esc), `rovingFocus`, `ensureVisibleThenFocus`, `stickyTopInset` |
| `MotionApi` | `core/motion.ts` | exact; plus `runIntro(steps, instant)`, `EASE`, `EASE_CSS`, `DUR`, `cubicBezier`; the shell holds `MotionController` (+ `still`, `instant`, `intro`, `onMotionChange`, `setPreference`) |
| `HostApi` | `core/host.ts` | exact; plus `decodeFilename()`; the shell holds `HostController` (+ `post`, `startHeartbeat`) |
| `Caps`, `LineM`, `FunctionM`, `FileM`, `Model`, `HotspotItem` | `model/model.ts` (+ `Caps` from `normalize.ts`) | exact; extensions in §5 D4 |
| `AiCardState`, `AiController`, `renderAiCard` (§8.5) | `views/ai/controller.ts`, `views/ai/card.ts` | exact (WP5 stubs) |
| `SourceLookup`, `makeFileSourceLookup` | `model/source.ts` | exact |

Shell-only contracts defined by WP1 for the WP5 stubs (`views/app.ts`): `ShellContext`, `ShellActions`,
`ShellViewHandle`, `OverlayApi`, `LoaderApi`, `App`, `AppDeps`; and `AiControllerHandle` (`load(model)`,
`destroy()`) in `views/ai/controller.ts`. The full generated signature list is in the appendix.

How views use the pieces that §8.3 deliberately keeps out of `ViewContext`:
- DOM-control tooltips: `bindTooltip(ctx.tooltip, el, () => content)`.
- Intro (§5.2 M1–M6): `runIntro(steps, ctx.motion.reduced || ctx.host.flags.still)`.
- Lane totals before the lazy timeline resolves: `ctx.model.sampling.laneTotals` (the same numbers as
  `(await ctx.model.timeline()).laneTotals`).
- Readouts, headline, findings: precomputed on the model (`model.readouts`, `model.headline`,
  `model.findings`); hotspot lists: `hotspotList(model, kind, metric, n)` in `model/hotspots.ts`.

## 4. Stubs awaiting WP2–WP5

Every stub is marked `// STUB - owned by WPn`, is imported by `views/app.ts` already, and compiles against
the frozen interfaces. Replacing a stub's body needs no change in WP1 files.

| WP | File | Export the shell calls | Stub behaviour |
|---|---|---|---|
| WP2 | `views/overview/overview.ts` | `mountOverview(host, ctx): ViewHandle` | headline text in a card (`.stub-card`) |
| WP3 | `views/code/codesection.ts` | `mountCodeSection(host, ctx): ViewHandle`; registers `CodeApi` | `reveal()` switches `store.code.file` and scrolls the section |
| WP4 | `views/stacks/stackssection.ts` | `mountStacksSection(host, ctx)`; registers `StacksApi` | placeholder, no-op API |
| WP4 | `views/timeline/timeline.ts` | `mountTimeline(host, ctx, {sourceLookup, drawFrames})`, `renderTimelineFrames(…)`, `TimelineMount`; registers `TimelineApi` | placeholder, no-op API; `renderTimelineFrames` signature is a placeholder WP4 defines (it must keep taking the `SourceLookup`) |
| WP4 | `views/memory/memoryview.ts` | `mountMemory(host, ctx)` | placeholder |
| WP5 | `views/ai/controller.ts` | `createAiController(shell): AiControllerHandle` | always the "setup" card state; no network |
| WP5 | `views/ai/card.ts` | `renderAiCard(el, anchor, ctx)` | setup card |
| WP5 | `views/shell/loader.ts` | `mountLoader(shell): LoaderApi` | file input + JSON parse → `shell.actions.load` |
| WP5 | `views/shell/empty.ts` | `mountEmpty(host, shell): ViewHandle` | title, sentence, "Choose a profile…" |
| WP5 | `views/shell/footer.ts` | `mountFooter(el, shell): ShellViewHandle` | version/date line |
| WP5 | `views/shell/palette.ts`, `shortcuts.ts` | `createPalette(shell)`, `createShortcuts(shell)`: `OverlayApi` | toast only |
| WP5 | `scalene-gui.ts` hook | `registerLegacyAiHandlers({toggleServiceFields, togglePassword, toggleAdvanced, refreshOpenAIModels, refreshGeminiModels, checkApiKey})` | globals installed, no-ops until registered |

Section placeholders (reserved height + "Preparing …" text, `aria-busy`) are rendered by the shell; a view
replaces the placeholder's content when mounted. A throwing `mount` renders "This section could not be
displayed" in that section only and rethrows asynchronously (visible in the console).

## 5. Deviations from DESIGN.md and open decisions

**D1 — Bundle budget (decision needed).** §6.1 caps the unminified bundle at 450 KiB. To keep headroom
without minifying, `build.mjs` drops the leading indentation of tsc's output (since WP6; names, lines and
structure unchanged; lines inside multi-line string/template literals are protected via the TypeScript
parser). That took the bundle from 393.8 to 348.5 KiB. With every view still a stub, the remaining
headroom is ~100 KiB, while WP2–WP5 will add roughly 200–300 KiB (the prototype's view code alone is
~136 KiB of dense JS, plus ~30–40 KiB of view CSS). **Expect the build to fail the budget once two or
three packages land.** The check is kept at 450 KiB as specified. The spec owner should amend §6.1,
e.g. "≤ 750 KiB unminified" or "≤ 160 KiB gzip" (today 94.4 KiB), or allow a minify step.

**D2 — Contrast tool name.** §3.7 asks for `tools/check-contrast.mjs`; §8.2/§8.6 name
`tools/check-tokens.mjs`. One tool exists, `check-tokens.mjs`, which also checks §3.2 byte-identity and the
ligature-free mono stack.

**D3 — §8.2 responsibility names vs implemented names** (8.3/8.4 interfaces are exact; these are the
module-tree descriptions):

| §8.2 says | Implemented |
|---|---|
| `readouts.selectReadouts(model)` | `buildReadouts(model)`; views read `model.readouts` |
| `visibility.rowClasses(file)` | `classifyRows(file, caps)` (run by `buildModel`, result in `LineM.cls`); `buildCodeItems(file, mode, sort, unfolded, extras)` as specified |
| `search.buildIndex(model)`, `query(q)` | `buildSearchIndex(model)` → `SearchIndex.query(q, limits?)`; views use `model.search()` |
| `stacks.callContext(file, line)` | `model.callContext(file, line)` (backed by `buildCallContextIndex` / `callContextFor`) |
| `timeline … phases(), tasksAt()` | `TimelineM.phases` (array) and `TimelineM.tasks(nb, ta, tb)`, `maxTasks` |
| `memory.m4(samples, px)`, `footprintAt(t)` | `m4(samples, t0, t1, px)`, `footprintAt(samples, t)` |
| `controls … switch` | `switchControl` (`switch` is reserved) |
| `bus on/off/emit` | `on()` returns the disposer (as in §8.3; no `off`) |
| `motion.flip(nodes, mutate, {ms, ease})` (§5.5) | `flip(nodes, mutate, ms?)` (as in §8.3) |
| `model.timeline.laneTotals` (§4.0.6 prose) | `model.sampling.laneTotals` (eager) = `(await model.timeline()).laneTotals` |

**D4 — Additive model extensions** (fields only; nothing in §8.4 changed): `Model.sampling` (threads, dt,
tEnd, runs, lane totals), `Model.stackSamples`, `Model.stackDepth {cpu, memory}`, `Model.entrypointDir`,
`FunctionM.members`, `HotspotItem.{valueText, meter, ariaLabel, line, fn, file}`, `HeadSeg` code chips
carry `full` (untruncated text for tooltip/aria-label). The shell no longer reads
`model.raw` (§4.0: only `globalThis.profile` stays raw).

**D5 — Behaviour choices inside the spec's latitude.**
- Timeline segments merge runs whose gap is ≤ 0.5 × the sampling interval (strict "touching" split one
  frame into 2,122 pieces because of timer jitter).
- Finding sentences shorten code chips to ≤ 22 characters (headline chips keep 32), which yields the
  Appendix A strings `hashlib.pbkdf2_hmac(…)` and `torch.save(…)`.
- Formatter rules beat Appendix A shorthand where they disagree: basic.json's peak time reads "1.62 s"
  and example.json's "377 ms" (Appendix A writes "1.6 s" / "0.4 s").
- The visibility port fixes upstream's `lineno` index bugs (§4.0.4), so it is not byte-for-byte
  upstream; the unit test compares against a literal upstream port with only those fixes applied.
- `Nav.jumpTo` to a file that is not in the profile shows the §4.0.8 toast "This file is not in the
  profile" for every entry point (instead of each view handling it).
- `changeTimelineViewMode` stores `main` or a thread id in `store.timeline.thread` ("all" otherwise);
  WP4 interprets it.
- The `short` app bar shows ⌕, ✦, Load, Theme and a ⋯ menu (Sections, Reduce motion, Shortcuts): §2.4.1
  lists Load/Theme as icons in `short` while §4.1 item 9 moves them into ⋯; the bar fits both at 1000 px.
- Section placeholders get a 1 px `--line` border: dark `--sunken` is nearly the page colour, so the
  reserved block would otherwise be invisible.
- The empty-state frame centres with `min-height: calc(100vh − …)` except in `short` (Jupyter), where it
  is top-aligned with no viewport height (§2.5 forbids `100vh` layouts in iframes).

**D6 — Known gaps (owned elsewhere or later).**
- Charts are unit-tested in Node only (fake DOM, recording canvas); first real browser use is WP2/WP4.
  Meters, axes and sparklines set geometry and token colours inline; WP2/WP4 may add `.meter`,
  `.axis-label`, `.sparkline` rules in their own stylesheets.
- The 250 ms `model.build()` budget is measured in Node (huge.json ≈ 50–100 ms), not yet in Chromium
  (WP6 `tools/perf.mjs`).
- `.stub-card` rules in `02-layout.css` serve the WP2 stub only; WP1 removes them when WP2 lands.
- The accessibility walk, screenshot matrix and perf scripts are WP6 (`tools/check.mjs` is the WP1
  skeleton).

## Appendix: API index (generated from `tsc --declaration`, one line per declaration)

Regenerate with `tsc -p . --declaration --emitDeclarationOnly --outDir <tmp>`. Non-exported
names appear only where an exported signature refers to them.

#### `core/store.ts`

```ts
export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
export type DisplayMode = "profiled-functions" | "profiled-lines" | "all";
export type Metric = "time" | "memory" | "gpu" | "await";
export type ColumnKey = "line" | "time" | "mem" | "gpu" | "await" | "idle" | "nrt" | "nc" | "trend" | "copy" | "gpumem" | "alloc" | "avg" | "source";
export interface SortState { key: ColumnKey; dir: "desc" | "asc"; }
export type Target = { file: string; line: number; } | { file: string; fn: string; };
export type SectionId = "overview" | "code" | "stacks" | "timeline" | "memory";
export type FlameColorMode = "kind" | "file" | "self";
export interface AppState { theme: "light" | "dark"; themeSource: "user" | "system" | "vscode"; reducedMotion: boolean; layout: { bp: Breakpoint; short: boolean; coarse: boolean; }; selection: Target | null; hover: Target | null; hotspots: { kind: "lines" | "functions" | "files"; metric: Metric; showAll: boolean; }; code: { file: string | null; view: "lines" | "functions"; wrap: boolean; perFile: Record<string, { mode: DisplayMode; sort: SortState | null; unfolded: number[]; }>; }; flame: { tab: "cpu" | "memory"; zoom: { cpu: string | null; memory: string | null; }; search: string; color: { cpu: FlameColorMode; memory: FlameColorMode; }; }; timeline: { view: "lanes" | "interleaved"; thread: string; domain: [number, number] | null; expanded: string[]; }; memory: { siteOrder: "peak" | "allocated"; site: { file: string; line: number; } | null; }; range: [number, number] | null; layers: { drawer: boolean; palette: boolean; shortcuts: boolean; fileSheet: boolean; }; }
export interface Store<S> { get(): S; set(patch: Partial<S>): void; update(fn: (s: S) => Partial<S>): void; subscribe<T>(select: (s: S) => T, cb: (v: T, prev: T) => void): () => void; }
export function createStore<S>(initial: S): Store<S>;
export function initialAppState(layout: AppState["layout"], theme: AppState["theme"], reduced: boolean): AppState;
export function profileStateReset(s: AppState): Partial<AppState>;
export function sameTarget(a: Target | null, b: Target | null): boolean;
```

#### `core/bus.ts`

```ts
export type Source = "headline" | "readout" | "hotspot" | "scope" | "finding" | "code" | "minimap" | "flame" | "timeline" | "memory" | "palette" | "global" | "detail";
export interface JumpOptions { focus?: boolean; open?: boolean; flash?: boolean; source?: Source; }
export interface Events { "profile:loaded": { model: Model; }; "hover:line": { target: Target | null; source: Source; }; "hover:peak": { on: boolean; }; "range:set": { range: [number, number] | null; source: Source; reveal?: boolean; }; "stacks:show": { target: Target; }; "timeline:show": { target: Target; }; "theme:changed": { theme: "light" | "dark"; }; "motion:changed": { reduced: boolean; }; "layout:changed": AppState["layout"]; "hotspots:changed": { items: HotspotItem[]; }; "ai:open-settings": { focusField?: string; }; }
export interface Bus<E> { on<K extends keyof E>(k: K, cb: (p: E[K]) => void): () => void; emit<K extends keyof E>(k: K, p: E[K]): void; }
export function createBus<E>(): Bus<E>;
```

#### `views/app.ts`

```ts
export interface Nav { jumpTo(target: Target, opts?: JumpOptions): Promise<void>; showSection(id: SectionId, opts?: { focus?: boolean; tab?: "cpu" | "memory"; }): Promise<void>; showInStacks(target: Target): Promise<void>; showInTimeline(target: Target): Promise<void>; openInEditor(file: string, line: number): void; }
export interface CodeApi { reveal(target: Target, opts: JumpOptions): Promise<void>; currentFile(): string | null; }
export interface StacksApi { focusLine(target: Target): void; selectTab(tab: "cpu" | "memory"): void; }
export interface TimelineApi { focusLine(target: Target): void; setDomain(r: [number, number] | null, animate: boolean): void; }
export interface ViewContext { model: Model; store: Store<AppState>; bus: Bus<Events>; nav: Nav; tooltip: Tooltip; toast: Toast; announce: Announcer; theme: ThemeApi; motion: MotionApi; host: HostApi; ai: AiController; registerApi(name: "code" | "stacks" | "timeline", api: CodeApi | StacksApi | TimelineApi): void; }
export interface ViewHandle { destroy(): void; }
export type MountFn = (host: HTMLElement, ctx: ViewContext) => ViewHandle;
export interface ShellActions { load(raw: unknown, meta?: { name?: string; }): void; openFilePicker(): void; openPalette(): void; openShortcuts(): void; openAiSettings(focusField?: string): void; toggleTheme(): void; useSystemTheme(): void; setReducedMotion(on: boolean): void; }
export interface ShellContext { store: Store<AppState>; bus: Bus<Events>; tooltip: TooltipController; toast: Toast; announce: Announcer; theme: ThemeController; motion: MotionController; host: HostController; modals: ModalManager; layerRoot: HTMLElement; fileInput: HTMLInputElement; meta: { version: string; date: string; }; model(): Model | null; nav(): Nav | null; ai(): AiController; actions: ShellActions; }
export interface ShellViewHandle extends ViewHandle { update(): void; }
export interface OverlayApi { open(): void; close(): void; isOpen(): boolean; destroy(): void; }
export interface LoaderApi { loadFile(): void; loadDemo(): void; loadFetch(): void; destroy(): void; }
export interface SectionInfo { id: SectionId; label: string; }
export interface App { load(raw: unknown, meta?: { name?: string; }): void; readonly shell: ShellContext; readonly loader: LoaderApi; model(): Model | null; nav(): Nav | null; codeApi(): CodeApi | null; stacksApi(): StacksApi | null; timelineApi(): TimelineApi | null; ensureSection(id: SectionId): boolean; }
export interface AppDeps { host: HostController; bus: Bus<Events>; store: Store<AppState>; theme: ThemeController; motion: MotionController; layout: LayoutController; }
export function presentSections(model: Model): SectionId[];
export function isEmptyProfile(p: unknown): boolean;
export function createApp(deps: AppDeps): App;
```

#### `core/theme.ts`

```ts
export type ThemeName = "light" | "dark";
export type ThemeSource = "user" | "system" | "vscode";
export interface ThemeApi { current(): ThemeName; set(choice: ThemeName | "system"): void; tokens(): Readonly<Record<string, string>>; num(name: string): number; }
export interface ThemeController extends ThemeApi { source(): ThemeSource; toggle(): void; invalidate(): void; destroy(): void; }
interface Resolved { theme: ThemeName; source: ThemeSource; highContrast: boolean; }
export function resolveTheme(): Resolved;
export function createTheme(onChange: (theme: ThemeName, source: ThemeSource) => void): ThemeController;
```

#### `core/canvas.ts`

```ts
export interface CanvasPair { base: HTMLCanvasElement; overlay: HTMLCanvasElement; b: CanvasRenderingContext2D; o: CanvasRenderingContext2D; width: number; height: number; dpr: number; resize(w: number, h: number): void; clearOverlay(): void; destroy(): void; }
export const DPR_CAP = 2;
export function currentDpr(): number;
export function createCanvasPair(host: HTMLElement, opts?: { interactive?: boolean; }): CanvasPair;
export function clearCanvas(ctx: CanvasRenderingContext2D): void;
export function crisp(x: number, dpr?: number): number;
export type RGBA = [number, number, number, number];
export function parseColor(c: string): RGBA | null;
export function rgbaString([r, g, b, a]: RGBA): string;
export function alpha(color: string, a: number): string;
export function mixOklab(a: string, b: string, t: number): string;
export type HatchKind = "system" | "waiting" | "short-phase";
export function hatch(ctx: CanvasRenderingContext2D, kind: HatchKind, t: ThemeApi): CanvasPattern;
export function setFont(ctx: CanvasRenderingContext2D, font: string): void;
export function monoFont(t: ThemeApi, px?: number, weight?: number): string;
export function uiFont(t: ThemeApi, px?: number, weight?: number): string;
export function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number, mode: "end" | "middle" | "code"): string;
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void;
export function observeSize(el: Element, cb: (w: number, h: number) => void): () => void;
```

#### `core/virtual.ts`

```ts
export interface VItem { key: string; kind: string; height: number | "measure"; estimate?: number; }
export interface VirtualList<T extends VItem> { setItems(items: readonly T[], keepAnchorKey?: string): void; scrollToKey(key: string, align: "center" | "start", behavior: ScrollBehavior): Promise<void>; elementFor(key: string): HTMLElement | null; visibleKeys(): string[]; refresh(keys?: string[]): void; destroy(): void; }
export interface VirtualListOptions<T extends VItem> { container: HTMLElement; render(item: T, reuse: HTMLElement | null): HTMLElement; overscanPx?: number; onRange?(first: number, last: number): void; topInset?(): number; maxRendered?: number; }
export function indexAtOffset(offsets: Float64Array, n: number, y: number): number;
export function prefixOffsets(heights: Float64Array, out?: Float64Array): Float64Array;
export function createVirtualList<T extends VItem>(opts: VirtualListOptions<T>): VirtualList<T>;
```

#### `core/tooltip.ts`

```ts
export interface TooltipContent { title?: string; kind?: string; rows?: [string, string][]; code?: string; hint?: string; }
export interface Tooltip { show(at: { x: number; y: number; } | Element, c: TooltipContent, opts?: { delay?: number; describe?: Element; }): void; move(x: number, y: number): void; hide(): void; }
export interface TooltipController extends Tooltip { bind(el: HTMLElement, content: TooltipBinding): () => void; destroy(): void; }
export type TooltipBinding = TooltipContent | (() => TooltipContent | null);
export function createTooltip(root: HTMLElement): TooltipController;
export function bindTooltip(t: Tooltip, el: HTMLElement, content: TooltipBinding): () => void;
```

#### `core/toast.ts`

```ts
export interface ToastSpec { kind: "info" | "success" | "error"; text: string; action?: { label: string; run(): void; }; sticky?: boolean; }
export interface Toast { show(t: ToastSpec): () => void; }
export interface ToastController extends Toast { destroy(): void; }
export function createToasts(root: HTMLElement): ToastController;
```

#### `core/a11y.ts`

```ts
export interface Announcer { polite(text: string): void; assertive(text: string): void; }
export interface AnnouncerController extends Announcer { destroy(): void; }
export function createAnnouncer(root: HTMLElement): AnnouncerController;
export function focusables(container: Element): HTMLElement[];
export interface ModalOptions { onEscape(): void; returnFocus?: HTMLElement | null; initialFocus?: HTMLElement | null; }
export interface ModalHandle { close(opts?: { restoreFocus?: boolean; }): void; }
export interface ModalManager { open(el: HTMLElement, opts: ModalOptions): ModalHandle; topmost(): HTMLElement | null; escape(): boolean; destroy(): void; }
export function createModalManager(background: () => Element[]): ModalManager;
export interface RovingOptions { container: HTMLElement; items(): HTMLElement[]; orientation?: "vertical" | "horizontal" | "both"; vimKeys?: boolean; loop?: boolean; onMove?(el: HTMLElement, index: number): void; onActivate?(el: HTMLElement, index: number, ev: KeyboardEvent): void; spaceActivates?: boolean; }
export interface Roving { setActive(index: number, focus?: boolean): void; active(): number; sync(): void; destroy(): void; }
export function rovingFocus(opts: RovingOptions): Roving;
export function stickyTopInset(extra?: number): number;
export function ensureVisibleThenFocus(el: HTMLElement, opts?: { block?: ScrollLogicalPosition; topInset?: number; }): void;
```

#### `core/motion.ts`

```ts
export type Ease = (t: number) => number;
export interface MotionApi { readonly reduced: boolean; tween(key: string, ms: number, ease: Ease, step: (t: number) => void, done?: () => void): { cancel(): void; }; flip(nodes: HTMLElement[], mutate: () => void, ms?: number): void; countUp(el: HTMLElement, finalText: string, opts?: { ms?: number; delay?: number; }): void; revealOnce(el: Element, cb: () => void): () => void; }
export interface IntroStep { at: number; run(immediate: boolean): void; }
export interface MotionController extends MotionApi { readonly still: boolean; readonly instant: boolean; preference(): boolean | null; setPreference(reduce: boolean | null): void; onMotionChange(cb: (reduced: boolean) => void): () => void; intro(steps: IntroStep[]): { cancel(): void; }; destroy(): void; }
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease;
export const EASE: { linear: Ease; out: Ease; standard: Ease; productive: Ease; in: Ease; sweep: Ease; };
export const EASE_CSS: { readonly out: "cubic-bezier(0.22, 1, 0.36, 1)"; readonly standard: "cubic-bezier(0.2, 0, 0, 1)"; readonly productive: "cubic-bezier(0.2, 0, 0.38, 0.9)"; readonly in: "cubic-bezier(0.4, 0, 1, 1)"; };
export const DUR: { readonly d1: 90; readonly d2: 140; readonly d3: 200; readonly d4: 280; readonly d5: 420; readonly count: 600; readonly sweep: 640; readonly flash: 1200; readonly stagger: 30; };
export function runIntro(steps: IntroStep[], instant: boolean): { cancel(): void; };
export function createMotion(flags: { still: boolean; motion: "reduce" | null; }): MotionController;
```

#### `core/host.ts`

```ts
export interface HostApi { readonly isVsCode: boolean; readonly isHttp: boolean; openInEditor(rawFile: string, line: number): void; flags: { still: boolean; motion: "reduce" | null; perf: boolean; }; }
export interface HostController extends HostApi { post(message: unknown): void; startHeartbeat(): void; destroy(): void; }
export function readFlags(search: string): HostApi["flags"];
export function createHost(): HostController;
export function decodeFilename(encoded: string): string;
```

#### `core/layout.ts`

```ts
export type Layout = AppState["layout"];
export const BREAKPOINTS: readonly Breakpoint[];
export function bpAtLeast(bp: Breakpoint, min: Breakpoint): boolean;
export function bpForWidth(width: number): Breakpoint;
export function readLayout(): Layout;
export function applyLayoutClasses(layout: Layout, root?: HTMLElement): void;
export interface LayoutController { current(): Layout; destroy(): void; }
export function createLayout(onChange: (layout: Layout, prev: Layout) => void): LayoutController;
```

#### `core/schedule.ts`

```ts
export function yieldToMain(): Promise<void>;
export function slice<T>(work: Iterator<unknown, T>, budgetMs?: number): Promise<T>;
export function idle(fn: () => void, timeout?: number): () => void;
export function nextFrame(): Promise<number>;
export interface Throttled<A extends unknown[]> { (...args: A): void; cancel(): void; flush(): void; }
export function throttleRaf<A extends unknown[]>(fn: (...args: A) => void): Throttled<A>;
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A>;
```

#### `core/storage.ts`

```ts
export const STORAGE_KEYS: { readonly theme: "scalene-theme"; readonly reducedMotion: "scalene-reduced-motion"; readonly codeWrap: "scalene-code-wrap"; };
export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
export function storageGet(key: string): string | null;
export function storageSet(key: string, value: string): boolean;
export function storageRemove(key: string): void;
export function onStorageFailure(cb: () => void): void;
```

#### `core/dom.ts`

```ts
export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type Attrs = Record<string, unknown>;
export function append(parent: Node, ...children: Child[]): void;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K];
export function clear(el: Node): void;
export function replaceChildren(el: Element, ...children: Child[]): void;
export function listen<K extends keyof WindowEventMap>(target: Window, type: K, handler: (ev: WindowEventMap[K]) => void, opts?: AddEventListenerOptions | boolean): () => void;
export function listen<K extends keyof DocumentEventMap>(target: Document, type: K, handler: (ev: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions | boolean): () => void;
export function listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (ev: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions | boolean): () => void;
export function listen(target: EventTarget, type: string, handler: (ev: Event) => void, opts?: AddEventListenerOptions | boolean): () => void;
export interface Disposer { add(fn: (() => void) | { destroy(): void; } | null | undefined): void; dispose(): void; }
export function createDisposer(): Disposer;
export function escapeHtml(s: string): string;
export function uid(prefix?: string): string;
export function ensureById<T extends HTMLElement>(id: string, make: () => T): T;
export function isTypingTarget(t: EventTarget | null): boolean;
export const VISUALLY_HIDDEN = "visually-hidden";
```

#### `core/controls.ts`

```ts
export interface ButtonOptions { label?: Child; icon?: IconName; trailingIcon?: IconName; variant?: "primary" | "secondary" | "ghost"; compact?: boolean; ariaLabel?: string; class?: string; disabled?: boolean; onClick?(ev: MouseEvent): void; }
export function button(o: ButtonOptions): HTMLButtonElement;
export interface IconButtonOptions { icon: IconName; label: string; onClick?(ev: MouseEvent): void; pressed?: boolean; class?: string; text?: string; }
export function iconButton(o: IconButtonOptions): HTMLButtonElement;
export interface Option<V extends string> { value: V; label: Child; description?: string; controls?: string; }
export interface Choice<V extends string> { el: HTMLElement; value(): V; set(v: V, opts?: { emit?: boolean; }): void; buttons(): HTMLButtonElement[]; destroy(): void; }
export function segmented<V extends string>(o: { label: string; options: readonly Option<V>[]; value: V; onChange(v: V): void; id?: string; }): Choice<V>;
export function tabs<V extends string>(o: { label: string; options: readonly Option<V>[]; value: V; onChange(v: V): void; id?: string; }): Choice<V>;
export interface SelectControl<V extends string> { el: HTMLElement; select: HTMLSelectElement; value(): V; set(v: V): void; setOptions(options: readonly { value: V; label: string; }[], value?: V): void; }
export function select<V extends string>(o: { label: string; options: readonly { value: V; label: string; }[]; value: V; onChange(v: V): void; id?: string; showLabel?: boolean; }): SelectControl<V>;
export function textInput(o: { label: string; value?: string; placeholder?: string; type?: "text" | "search" | "password" | "url" | "number"; id?: string; onInput?(v: string): void; }): HTMLInputElement;
export interface SwitchControl { el: HTMLButtonElement; checked(): boolean; set(on: boolean): void; }
export function switchControl(o: { label: string; checked: boolean; onChange(on: boolean): void; id?: string; }): SwitchControl;
export type MenuItem = { kind?: "item"; label: string; icon?: IconName; run(): void; checked?: boolean; current?: boolean; disabled?: boolean; hint?: string; } | { kind: "separator"; };
export interface MenuControl { open(focus?: "first" | "last"): void; close(restoreFocus?: boolean): void; isOpen(): boolean; destroy(): void; }
export function menu(o: { trigger: HTMLElement; label: string; items(): MenuItem[]; root: HTMLElement; align?: "start" | "end"; }): MenuControl;
export interface Disclosure { el: HTMLElement; button: HTMLButtonElement; panel: HTMLElement; isOpen(): boolean; set(open: boolean): void; }
export function disclosure(o: { label: Child; content: Child; open?: boolean; onToggle?(open: boolean): void; class?: string; }): Disclosure;
export function chip(text: string, o?: { onClick?(ev: MouseEvent): void; ariaLabel?: string; class?: string; }): HTMLElement;
export function badge(text: Child, o?: { variant?: "neutral" | "danger" | "resource"; icon?: IconName; swatch?: string; }): HTMLElement;
export function keyChip(text: string): HTMLElement;
export function modKeyLabel(key: string): string;
export function sectionHeader(o: { section: string; title: Child; description?: Child; actions?: Child; }): HTMLElement;
```

#### `core/icons.ts`

```ts
declare const PATHS: { /* SVG path data, 16 px grid */ }; // keys: search, spark, sun, moon, monitor, upload, chevron-right, chevron-down, x, external, flame, lanes, chip, code, trend-up, gpu, sync, peak, cpu, copy, check, wait, minus, plus, reset, file, fn, eye, info, alert, menu, sort-asc, sort-desc, fold, unfold, play, sections
export type IconName = keyof typeof PATHS;
export function icon(name: IconName, size?: number): SVGSVGElement;
export function logoMark(size?: number): SVGSVGElement;
```

#### `core/format.ts`

```ts
export function fmtPct(v: number | null | undefined): string;
export function fmtUtil(v: number | null | undefined): string;
export function fmtTime(s: number | null | undefined): string;
export function fmtRange(a: number, b: number): string;
export function fmtMem(mib: number | null | undefined): string;
export function fmtRate(mibPerS: number | null | undefined): string;
export function fmtCount(n: number | null | undefined): string;
export function fmtDate(epochSec: number | null | undefined): string;
export function basename(path: string): string;
export function dirname(path: string): string;
export function fmtLoc(file: string, line: number): string;
export function splitUnit(s: string): [string, string];
export const TICK_SPACING_PX = 80;
export function niceCeil(raw: number): number;
export function pickNiceTickInterval(total: number, pixelWidth: number): number;
export function formatTimelineTickLabel(sec: number, stepSec: number): string;
export function formatMemoryTickLabel(mib: number, stepMiB: number): string;
export function niceMemStep(maxMiB: number, maxTicks: number): number;
```

#### `model/model.ts`

```ts
export type { Caps } from "./normalize";
export interface NeuronLineM { nrtMs: number; nrtPct: number; ncMs: number; idlePct: number | null; nrtCount: number; ncCount: number; kernel: string | null; }
export interface LineM { file: FileM; no: number; text: string; doc: boolean; py: number; nat: number; sys: number; total: number; sec: number; coreUtil: number | null; peak: number; avg: number; malloc: number; mallocs: number; pyFrac: number; usage: number; copy: number; memSamples: Float64Array; gpu: number; gpuPeak: number | null; gpuAvg: number | null; await: number; concMean: number; concPeak: number; tasks: readonly string[]; coro: boolean; cpuTimes: Float64Array; region: [number, number]; outer: [number, number] | null; fnRange: [number, number] | null; fn: FunctionM | null; leak: { likelihood: number; velocity: number; } | null; neuron: NeuronLineM | null; hasMem: boolean; cls: "data" | "context" | "empty"; regionTotal: number; regionHead: boolean; timeRank: number | null; }
export interface FunctionM { file: FileM; name: string; no: number; range: [number, number] | null; py: number; nat: number; sys: number; total: number; sec: number; peak: number; avg: number; malloc: number; usage: number; copy: number; gpu: number; gpuPeak: number | null; await: number; coro: boolean; memSamples: Float64Array; members: LineM[]; }
export interface FileM { name: string; base: string; dir: string; no: number; hidden: boolean; dense: boolean; pct: number; py: number; nat: number; sys: number; total: number; peak: number; peakLine: LineM | null; gpuPeak: number; nrtMs: number; ncMs: number; lines: LineM[]; byNo: Map<number, LineM>; functions: FunctionM[]; imports: string[]; leaks: LineM[]; }
export type BadgeKind = "leak" | "loop" | "gpu" | "await" | "copy";
export interface Badge { kind: BadgeKind; text: string; }
export interface MeterPart { value: number; token: string; hatch?: "system" | "waiting"; }
export interface HotspotItem { rank: number; kind: "line" | "function" | "file"; target: Target; value: number; secondary: string; code: string; location: string; badge: Badge | null; times: Float64Array; valueText: string; meter: { parts: MeterPart[]; max: number; }; ariaLabel: string; line: LineM | null; fn: FunctionM | null; file: FileM; }
export interface LaneTotals { gc: number; io: number; gil: number; samples: number; }
export interface Model { raw: unknown; caps: Caps; program: string; base: string; args: string[]; entrypointDir: string; elapsed: number; tMax: number; startEpoch: number | null; version: string; date: string; files: FileM[]; hiddenFiles: FileM[]; fileByName: Map<string, FileM>; split: { py: number; nat: number; sys: number; total: number; outside: number; }; maxLineTotal: number; maxLinePeak: number; maxLineAwait: number; rank: { lines: Record<Metric, LineM[]>; functions: Record<Metric, FunctionM[]>; files: Record<"time" | "memory", FileM[]>; }; memory: { samples: Float64Array; peak: number; peakT: number | null; peakLine: LineM | null; pyFrac: number | null; growth: number; native: number; allocated: number; } | null; gpu: { name: string; mean: number; method: "main-thread" | "all-lines"; devicePeak: number | null; busiest: LineM | null; } | null; neuron: { nrtMs: number; ncMs: number; idleOverall: number | null; } | null; async: { topAwait: LineM | null; loopLine: LineM | null; } | null; leaks: LineM[]; headline: HeadlineModel; readouts: ReadoutSpec[]; findings: Finding[]; sampling: TimelineSummary; stackSamples: number; stackDepth: { cpu: number; memory: number; }; timeline(): Promise<TimelineM | null>; flame(kind: "cpu" | "memory"): Promise<FlameTree | null>; callContext(file: string, line: number): Promise<CallContext | null>; search(): Promise<SearchIndex>; }
export interface BuildOptions { version?: string; date?: string; }
export class ProfileError extends Error { constructor(message: string); }
export const EVENT_LOOP_RE: RegExp;
export function buildModel(raw: unknown, opts?: BuildOptions): Model | null;
export function lineAt(model: Model, file: string, line: number): LineM | null;
export function functionAt(model: Model, file: string, qualname: string): FunctionM | null;
export function lineTarget(l: LineM): Target;
export function functionTarget(f: FunctionM): Target;
```

#### `model/normalize.ts`

```ts
export interface Caps { memory: boolean; gpu: boolean; neuron: boolean; async: boolean; coreUtil: boolean; gpuMemory: boolean; regions: boolean; functionBounds: boolean; cpuSamples: boolean; startTime: boolean; stacks: boolean; timeline: boolean; threadIds: boolean; memStacks: boolean; peakLocation: boolean; peakPyFraction: boolean; leaks: boolean; }
export interface NormRow { lineno: number; text: string; py: number; c: number; sys: number; coreUtil: number | null; cpuTimes: Float64Array; malloc: number; mallocs: number; peak: number; avg: number; pyFrac: number; usage: number; copy: number; memSamples: Float64Array; gpu: number; gpuAvg: number | null; gpuPeak: number | null; await: number; concMean: number; concPeak: number; tasks: readonly string[]; coro: boolean; region: [number, number]; outer: [number, number] | null; fnRange: [number, number] | null; hasRegion: boolean; hasFnBounds: boolean; neuron: NormNeuron | null; }
export interface NormNeuron { nrtMs: number; nrtPct: number; nrtCount: number; ncMs: number; ncPct: number; ncCount: number; ncNrtRatio: number | null; overlapPct: number | null; kernel: string | null; }
export interface NormLeak { likelihood: number; velocity: number; }
export interface NormFile { name: string; pct: number; rows: NormRow[]; functions: NormRow[]; imports: string[]; leaks: Map<number, NormLeak> | null; dense: boolean; }
export interface NormTimeline { n: number; t: Float64Array; stack: Int32Array; count: Int32Array; thread: Float64Array; }
export function eventThread(tl: NormTimeline, i: number): number | null;
export interface NormProfile { program: string; args: string[]; entrypointDir: string; elapsed: number; startEpoch: number | null; startPerf: number | null; memory: boolean; gpu: boolean; gpuDevice: string; asyncProfile: boolean; maxFootprint: number; maxFootprintPyFrac: number | null; maxFootprintFile: string | null; maxFootprintLine: number | null; nativeAllocations: number; growthRate: number; allocSamples: number | null; samples: Float64Array; files: NormFile[]; stacks: CombinedStackEntry[]; timeline: NormTimeline; memoryStacks: MemoryStackEntry[]; mainThreadId: number | null; neuronTotalMs: number | null; neuronNcTotalMs: number | null; overlapOverall: number | null; }
export type ParseResult = { kind: "ok"; profile: NormProfile; caps: Caps; raw: Record<string, unknown>; } | { kind: "empty"; } | { kind: "error"; message: string; };
type Obj = Record<string, unknown>;
export function isObject(v: unknown): v is Obj;
export function num(v: unknown, fallback?: number): number;
export function numOrNull(v: unknown): number | null;
export function unescapeSource(s: string): string;
export function toMemSamples(v: unknown): Float64Array;
export const EMPTY: Float64Array<ArrayBuffer>;
export function parseProfile(input: unknown): ParseResult;
export function normalize(p: Obj): NormProfile;
export function computeCaps(np: NormProfile, raw: Obj): Caps;
```

#### `model/source.ts`

```ts
export type SourceLookup = (filename: string, line: number) => string;
export function makeFileSourceLookup(model: Pick<Model, "fileByName">): SourceLookup;
export function hasSource(model: Pick<Model, "fileByName">, filename: string): boolean;
```

#### `model/headline.ts`

```ts
export type HeadSeg = { t: "text"; s: string; } | { t: "num"; s: string; }
| { t: "code"; s: string; target: Target; full: string; } | { t: "ref"; s: string; target: Target; };
export interface HeadlineModel { segments: HeadSeg[]; plain: string; }
export function bracketsBalanced(s: string): boolean;
export function shortCode(text: string, max?: number): string | null;
export class Segs { readonly list: HeadSeg[]; text(s: string): this; num(s: string): this; code(s: string, target: Target, full: string): this; ref(s: string, target: Target): this; model(): HeadlineModel; }
export function functionChip(name: string, max?: number): string;
export function lineSubject(b: Segs, l: LineM, capital: boolean, max?: number): boolean;
export function buildHeadline(m: Model): HeadlineModel;
export type MetaKind = "date" | "files" | "threads" | "async" | "accelerator" | "cpu-only" | "sampling" | "version";
export interface MetaItem { kind: MetaKind; text: string; extra?: string; }
export function fmtSampling(dt: number): string;
export function buildMeta(m: Model): MetaItem[];
```

#### `model/readouts.ts`

```ts
export type ReadoutKind = "time" | "peak" | "gpu" | "neuron" | "await" | "leaks" | "elapsed" | "busiest";
export interface SplitPart { key: "py" | "native" | "system"; label: string; value: number; text: string; token: string; hatch?: "system"; }
export type ReadoutVisual = { kind: "split"; parts: SplitPart[]; max: number; }
| { kind: "meter"; value: number; max: number; token: string; }
| { kind: "meters"; rows: { label: string; value: number; max: number; token: string; }[]; }
| { kind: "neutral"; note: string; };
export interface LeakRef { line: LineM; target: Target; label: string; rate: string; likelihood: string; }
export interface ReadoutSpec { kind: ReadoutKind; label: string; token: string; value: string; number: string; unit: string; countUp: boolean; parts?: SplitPart[]; visual: ReadoutVisual | null; caption: HeadSeg[][]; short: string; tooltip: string; leaks?: { items: LeakRef[]; more: number; }; danger?: boolean; }
export function buildReadouts(m: Model): ReadoutSpec[];
```

#### `model/findings.ts`

```ts
export type FindingId = "gpu-sync" | "loop-blocked" | "leak" | "peak" | "neuron-idle" | "gil" | "copy" | "native" | "python";
export type Severity = "high" | "medium" | "low";
export interface Finding { id: FindingId; severity: Severity; token: string; icon: IconName; title: string; sentence: HeadSeg[]; ref: { label: string; target: Target; } | null; line: LineM | null; }
export const THRESHOLDS: { readonly gpuSync: { readonly minTotal: 5; readonly minSysShare: 0.5; readonly minGpu: 50; }; readonly loopBlocked: { readonly minTotal: 5; readonly maxSysShare: 0.5; }; readonly maxLeaks: 3; readonly neuronIdle: { readonly minTotal: 5; readonly minIdle: 60; readonly minSamples: 20; readonly minSpread: 0.25; }; readonly gilLane: 2; readonly copy: 10; readonly native: 60; readonly python: { readonly minShare: 60; readonly minTotal: 50; }; readonly chipMax: 22; };
export function isRecurring(l: LineM, elapsed: number): boolean;
export function buildFindings(m: Model): Finding[];
export const FINDINGS_VISIBLE = 3;
```

#### `model/hotspots.ts`

```ts
export type HotspotKind = "lines" | "functions" | "files";
export interface HotspotList { kind: HotspotKind; metric: Metric; items: HotspotItem[]; total: number; more: number; pareto: number | null; subtitle: string; emptyText: string; }
export const HOTSPOTS_DEFAULT = 8;
export function availableMetrics(m: Model): Metric[];
export function unionTimes(arrays: readonly Float64Array[]): Float64Array;
export function hotspotList(m: Model, kind: HotspotKind, metric: Metric, n?: number): HotspotList;
export function paretoText(list: HotspotList): string | null;
```

#### `model/timeline.ts`

```ts
export const DEFAULT_DT = 0.01;
export interface ThreadInfo { idx: number; id: number | null; label: string; main: boolean; samples: number; share: number; events: number; gilSamples: number; }
export interface TimelineSummary { threads: ThreadInfo[]; dt: number; tEnd: number; runs: number; laneTotals: LaneTotals | null; }
export function samplingInterval(ev: NormTimeline): number;
export function summarizeTimeline(np: NormProfile, stackBits: Uint8Array): TimelineSummary;
export interface Phase { key: string; label: string; file: string; line: number; loop: boolean; t0: number; t1: number; samples: number; share: number; }
export interface ThreadBuckets { nb: number; ta: number; tb: number; busy: Float32Array; gil: Float32Array; wait: Float32Array; py: Float32Array; native: Float32Array; }
export interface SegmentRow { n: number; t0: Float64Array; t1: Float64Array; stack: Int32Array; samples: Float64Array; }
export interface LaneSegments { thread: number; rows: SegmentRow[]; }
export interface TimelineM { n: number; t0: Float64Array; t1: Float64Array; stack: Int32Array; thread: Int16Array; count: Int32Array; dt: number; tEnd: number; threads: ThreadInfo[]; mainIdx: number; laneTotals: LaneTotals; stackBits: Uint8Array; awaitLeaf: Uint8Array; nativeLeaf: Uint8Array; byThread: Int32Array[]; maxDepth: Int32Array; phases: Phase[]; phaseSamples: number; bucketize(nb: number, ta: number, tb: number, thread?: number): ThreadBuckets; tasks(nb: number, ta: number, tb: number): Float32Array; maxTasks: number; runAt(thread: number, t: number): number; pyLeafAt(thread: number, t: number): { run: number; frame: PyFrame; depth: number; } | null; segments(thread: number): LaneSegments; frameAt(stack: number, depth: number): CombinedFrame | null; }
export function buildTimeline(np: NormProfile, stackBits: Uint8Array, summary: TimelineSummary, model: Pick<Model, "fileByName" | "tMax">): Generator<unknown, TimelineM | null, void>;
```

#### `model/stacks.ts`

```ts
export type FlameNodeKind = "root" | "py" | "native" | "await" | "unresolved";
export interface FlameNode { id: number; key: string; path: string; parent: FlameNode | null; depth: number; kind: FlameNodeKind; name: string; file: string; line: number | null; ip: number | null; total: number; self: number; x0: number; x1: number; children: FlameNode[]; }
export interface FlameTree { kind: "cpu" | "memory"; root: FlameNode; total: number; stacks: number; maxDepth: number; byDepth: FlameNode[][]; nodes: FlameNode[]; byPath: Map<string, FlameNode>; byLine: Map<string, FlameNode[]>; maxSelf: number; }
export const lineKey: (file: string, line: number) => string;
export function frameMergeKey(f: CombinedFrame): string;
export function buildFlameTree(entries: readonly (CombinedStackEntry | MemoryStackEntry)[], kind: "cpu" | "memory"): Generator<unknown, FlameTree | null, void>;
export function heaviestNode(tree: FlameTree, file: string, line: number): FlameNode | null;
export function nodeAt(tree: FlameTree, depth: number, x: number): FlameNode | null;
export function ancestry(node: FlameNode): FlameNode[];
export function isDescendant(node: FlameNode, ancestor: FlameNode): boolean;
export interface FlameSearch { query: string; matches: FlameNode[]; outermost: FlameNode[]; share: number; }
export function searchFlame(tree: FlameTree, query: string): FlameSearch;
export function simplifyNativeName(name: string): string;
export function fileColorIndex(fileOrModule: string): number;
export function selfRampStep(self: number, maxSelf: number): number;
export interface CallEdge { name: string; kind: FlameNodeKind; file: string; line: number | null; hits: number; share: number; }
export interface CallContext { file: string; line: number; hits: number; total: number; share: number; summary: string; callsInto: CallEdge[]; calledFrom: CallEdge[]; }
export interface CallContextIndex { total: number; stacksByLine: Map<string, number[]>; }
export function buildCallContextIndex(stacks: readonly CombinedStackEntry[]): Generator<unknown, CallContextIndex | null, void>;
export function callContextFor(index: CallContextIndex, stacks: readonly CombinedStackEntry[], file: string, line: number): CallContext;
```

#### `model/classify.ts`

```ts
export type FrameClass = "gc" | "io" | "gil" | "other";
export const IO_CATEGORIES: readonly ["awaiting coroutines ([await])", "file and socket I/O (read, write, recv, send, open, close, fsync …)", "polling (select, poll, epoll_wait, kevent)", "blocking waits (pthread_cond_wait, pthread_cond_timedwait)", "Python I/O modules (_io, socket, selectors, asyncio, subprocess)"];
export function classifyFrame(f: CombinedFrame): FrameClass;
export interface StackClass { gc: boolean; io: boolean; gil: boolean; }
export function classifyStack(stack: readonly CombinedFrame[]): StackClass;
export const CLS_GC = 1;
export const CLS_IO = 2;
export const CLS_GIL = 4;
export function classifyStacks(stacks: readonly (readonly [readonly CombinedFrame[], number])[]): Uint8Array;
export function isAwaitFrame(f: CombinedFrame): boolean;
```

#### `model/memory.ts`

```ts
export interface PeakInfo { t: number; mb: number; index: number; }
export function peakInfo(samples: Float64Array): PeakInfo | null;
export function pairAtOrBefore(samples: Float64Array, t: number): number;
export interface FootprintAt { mb: number; interpolated: boolean; }
export function footprintAt(samples: Float64Array, t: number): FootprintAt | null;
export function m4(samples: Float64Array, t0: number, t1: number, px: number): Float64Array;
export function sampleTimes(samples: Float64Array): Float64Array;
export function seriesMax(samples: Float64Array): number;
```

#### `model/syntax.ts`

```ts
export type SynClass = "t-kw" | "t-def" | "t-bi" | "t-dec" | "t-str" | "t-num" | "t-com";
export interface Span { cls: SynClass | ""; text: string; }
export function stringLines(lines: readonly string[]): boolean[];
export function highlight(line: string, inString?: boolean): Span[];
export function highlightCached(key: string, line: string, inString: boolean): Span[];
export function clearHighlightCache(): void;
```

#### `model/visibility.ts`

```ts
export const MAX_LINES_PER_REGION = 50;
export function lineHasMem(l: Pick<LineM, "avg" | "peak" | "memSamples" | "usage">): boolean;
export function classifyRows(file: FileM, caps: Caps): void;
export function shownInMode(l: LineM, mode: DisplayMode): boolean;
export function sortValue(l: LineM, key: ColumnKey): number | null;
export function isSortable(key: ColumnKey): boolean;
export function rankLines(lines: readonly LineM[], sort: SortState): LineM[];
export type CodeItem = { kind: "line"; key: string; line: LineM; } | { kind: "fold"; key: string; start: number; end: number; count: number; total: number; } | { kind: "gap"; key: string; start: number; end: number; count: number; } | { kind: "fnHeader"; key: string; fn: FunctionM; } | { kind: "lens"; key: string; anchor: string; } | { kind: "aiCard"; key: string; line: number; };
export interface CodeExtras { lensAfter?: string | null; aiAnchors?: readonly number[]; }
export const lineItemKey: (no: number) => string;
export const foldItemKey: (start: number) => string;
export const fnItemKey: (fn: FunctionM) => string;
export const aiItemKey: (no: number) => string;
export const LENS_KEY = "lens";
export function foldStartFor(file: FileM, mode: DisplayMode, lineno: number): number | null;
export function visibleLines(file: FileM, mode: DisplayMode, unfolded?: readonly number[]): LineM[];
export function buildCodeItems(file: FileM, mode: DisplayMode, sort: SortState | null, unfolded: readonly number[], extras?: CodeExtras): CodeItem[];
export function shownCount(file: FileM, mode: DisplayMode, unfolded?: readonly number[]): number;
```

#### `model/search.ts`

```ts
export const MAX_LINE_RESULTS = 50;
export const MAX_GROUP_RESULTS = 8;
export interface LineHit { line: LineM; start: number; end: number; }
export interface FuzzyHit<T> { item: T; score: number; positions: number[]; }
export interface SearchResults { lines: LineHit[]; functions: FuzzyHit<FunctionM>[]; files: FuzzyHit<FileM>[]; }
export interface SearchIndex { size: number; query(q: string, limits?: { lines?: number; functions?: number; files?: number; }): SearchResults; }
export function fuzzyMatch(q: string, s: string): { score: number; positions: number[]; } | null;
export function buildSearchIndex(m: Model): Generator<unknown, SearchIndex, void>;
```

#### `model/lazy.ts`

```ts
export const SLICE_BUDGET_MS = 8;
export function runSliced<T>(gen: Generator<unknown, T, void>, budgetMs?: number): Promise<T>;
export function runNow<T>(gen: Generator<unknown, T, void>): T;
export class Lazy<T> { private readonly make; private promise; private value; private ready; constructor(make: () => Generator<unknown, T, void>); get(): Promise<T>; peek(): T | undefined; force(): T; }
```

#### `model/phrases.ts`

```ts
export function ofRun(total: number, sec: number, compact?: boolean): string;
export function splitParts(py: number, nat: number, sys: number): string;
export function fileShare(pct: number, elapsed: number): string;
export function outside(pct: number): string | null;
export function cores(fraction: number, compact?: boolean): string;
export function linePeak(mib: number, compact?: boolean): string;
export function allocShare(fraction: number, compact?: boolean): string;
export function allocated(mib: number): string;
export function copied(mibPerS: number, compact?: boolean): string;
export function gpuBusy(pct: number, compact?: boolean): string;
export function gpuMethod(method: "main-thread" | "all-lines", compact?: boolean): string;
export function gpuMemory(compact?: boolean): string;
export function awaitShare(pct: number, compact?: boolean): string;
export function concurrency(mean: number, peak: number, compact?: boolean): string;
export function deviceTime(ms: number, elapsed: number, compact?: boolean): string;
export function deviceIdle(idlePct: number, compact?: boolean): string;
export const FLAME_CPU_DENOMINATOR = "% of sampled stacks \u2014 not of run time";
export const FLAME_CPU_DENOMINATOR_SHORT = "of stacks";
export const FLAME_MEMORY_DENOMINATOR = "% of attributed allocation (cumulative volume, not live size)";
export const FLAME_MEMORY_DENOMINATOR_SHORT = "of alloc.";
export function ofSamples(pct: number): string;
export function threadsSampled(n: number): string;
export function growth(pct: number, compact?: boolean): string;
export function leak(l: { velocity: number; likelihood: number; }, compact?: boolean): string;
export function region(start: number, end: number, total: number): string;
export function stackPresence(hits: number, total: number): string;
export const NOT_RECORDED = "not recorded";
export const NONE_SAMPLED = "none sampled";
export const MISSING_COMPACT = "\u2014";
export function missing(present: boolean, compact?: boolean): string;
```

#### `model/thresholds.ts`

```ts
export const ALLOC_MIN = 0.01;
export const CELL_MIN = 1;
export const HEAT_FLOOR = 0.25;
export function cellHasValue(l: LineM, key: ColumnKey, caps: Caps): boolean;
export function profileColumns(m: Pick<Model, "caps" | "files" | "hiddenFiles">): ColumnKey[];
export type HeatMetric = "time" | "mem" | "gpu" | "await";
export function heatMetric(sortKey: ColumnKey | null | undefined): HeatMetric;
export const HEAT_WASH: Record<HeatMetric, string>;
export function heatOf(m: Pick<Model, "maxLineTotal" | "maxLinePeak" | "maxLineAwait">, l: LineM, metric: HeatMetric): number;
export function heatForMetric(metric: Metric): HeatMetric;
export type IdleBand = "low" | "medium" | "high";
export function idleBand(idlePct: number): { band: IdleBand; glyph: string; token: string; };
```

#### `model/sites.ts`

```ts
export type SiteOrder = "peak" | "allocated";
export interface SiteList { order: SiteOrder; rows: LineM[]; pinnedLeaks: LineM[]; more: number; defaultSite: LineM | null; scale: number; }
export function allocationSites(m: Model, order: SiteOrder, n?: number): SiteList;
```

#### `charts/axis.ts`

```ts
export { formatMemoryTickLabel, formatTimelineTickLabel, niceMemStep, pickNiceTickInterval } from "../core/format";
export { crisp };
export interface Tick { value: number; frac: number; label: string; edge: "start" | "middle" | "end"; }
export interface TickSet { step: number; ticks: Tick[]; }
export function timeTicks(d0: number, d1: number, widthPx: number): TickSet;
export function memoryTicks(maxMiB: number, widthPx: number): TickSet;
export function memoryTicksN(maxMiB: number, maxTicks: number): TickSet;
export interface MemoryScale { top: number; step: number; ticks: TickSet; }
export function memoryScale(maxMiB: number, maxTicks?: number): MemoryScale;
export function renderTimelineAxis(host: HTMLElement, domain: readonly [number, number], widthPx: number): { el: HTMLElement; ticks: TickSet; };
export function renderTimelineGridlines(host: HTMLElement, ticks: TickSet): HTMLElement;
export function renderMemoryAxis(host: HTMLElement, maxMiB: number, widthPx: number): { el: HTMLElement; ticks: TickSet; };
export function renderMemoryGridlines(host: HTMLElement, ticks: TickSet): HTMLElement;
export function drawVGridlines(ctx: CanvasRenderingContext2D, set: TickSet, rect: Rect, color: string, dpr?: number): void;
export function drawHGridlines(ctx: CanvasRenderingContext2D, set: TickSet, rect: Rect, color: string, dpr?: number): void;
export interface AxisLabelStyle { font: string; color: string; }
export function drawTimeLabels(ctx: CanvasRenderingContext2D, set: TickSet, rect: Rect, y: number, style: AxisLabelStyle): Rect[];
```

#### `charts/placement.ts`

```ts
export interface Rect { x: number; y: number; w: number; h: number; }
export interface Point { x: number; y: number; }
export interface Size { w: number; h: number; }
export function rect(x: number, y: number, w: number, h: number): Rect;
export function intersects(a: Rect, b: Rect): boolean;
export function contains(outer: Rect, inner: Rect, inset?: number): boolean;
export function insetRect(r: Rect, d: number): Rect;
export function disjoint(rects: readonly Rect[]): boolean;
export type CalloutSide = "left" | "right" | "below-left" | "below-right";
export const CALLOUT_GAP_X = 10;
export const CALLOUT_RISE = 8;
export const CHANNEL_INSET = 2;
export function calloutCandidates(dot: Point, size: Size): { side: CalloutSide; rect: Rect; }[];
export interface PlaceOptions { dot: Point; size: Size; bounds: Rect; reserved?: readonly Rect[]; inset?: number; }
export function placeCallout(o: PlaceOptions): { side: CalloutSide; rect: Rect; } | null;
export type PeakPlan = { kind: "callout"; side: CalloutSide; rect: Rect; }
| { kind: "label"; side: CalloutSide; rect: Rect; }
| { kind: "gutter"; rect: null; };
export function planPeakLabel(o: { dot: Point; callout: Size; label: Size; bounds: Rect; reserved?: readonly Rect[]; }): PeakPlan;
export function dotRect(dot: Point, radius?: number): Rect;
export interface YTickCandidate { y: number; label: string; size: Size; }
export interface PlacedYTick extends YTickCandidate { rect: Rect; }
export interface YTickOptions { channel: Rect; x: number; alignRight?: boolean; reserved?: readonly Rect[]; topGuard?: number; max?: number; }
export function placeYTicks(cands: readonly YTickCandidate[], o: YTickOptions): PlacedYTick[];
```

#### `charts/meter.ts`

```ts
export interface MeterSegment { value: number; token: string; hatch?: "system" | "waiting"; }
export interface MeterOptions { segments: readonly MeterSegment[]; max: number; height?: number; width?: string; graduations?: boolean; tick?: number | null; className?: string; }
export function segmentFractions(segments: readonly Pick<MeterSegment, "value">[], max: number): number[];
export function meter(doc: Document, o: MeterOptions): HTMLElement;
export function updateMeter(track: HTMLElement, o: MeterOptions): void;
```

#### `charts/sparkline.ts`

```ts
export interface SparklineOptions { tMax: number; yMax: number; width?: number; height?: number; leak?: boolean; }
export interface SparklineGeometry { points: string; max: { x: number; y: number; } | null; }
export function sparklineGeometry(samples: Float64Array, o: SparklineOptions): SparklineGeometry;
export function sparkline(doc: Document, samples: Float64Array, o: SparklineOptions, reuse?: SVGSVGElement | null): SVGSVGElement;
```

#### `charts/raster.ts`

```ts
export const BIN_PX = 2;
export const TICK_DENSITY_LIMIT = 300;
export function binCount(widthPx: number, binPx?: number): number;
export function binTimes(times: ArrayLike<number>, t0: number, t1: number, n: number, out?: Float32Array): Float32Array;
export function binMax(bins: ArrayLike<number>): number;
export interface RasterStyle { fill: string; baseline: string; alpha?: number; }
export function drawRaster(ctx: CanvasRenderingContext2D, bins: ArrayLike<number>, r: Rect, style: RasterStyle): void;
export function drawSampleTicks(ctx: CanvasRenderingContext2D, times: ArrayLike<number>, domain: readonly [number, number], r: Rect, color: string, alpha: number): void;
export function drawRug(ctx: CanvasRenderingContext2D, times: ArrayLike<number>, domain: readonly [number, number], r: Rect, color: string): void;
```

#### `charts/footprint.ts`

```ts
export interface FootprintOptions { rect: Rect; domain: readonly [number, number]; yMax: number; theme: ThemeApi; token?: string; areaOnly?: boolean; clipX?: number; }
export interface Scales { x(t: number): number; y(mb: number): number; t(x: number): number; }
export function footprintScales(rect: Rect, domain: readonly [number, number], yMax: number): Scales;
export function drawFootprint(ctx: CanvasRenderingContext2D, samples: Float64Array, o: FootprintOptions): void;
export function drawPeakMarker(ctx: CanvasRenderingContext2D, at: Point, theme: ThemeApi, scale?: number, alpha?: number): void;
export interface CalloutText { title: string; detail?: string; }
export function measureCallout(ctx: CanvasRenderingContext2D, text: CalloutText, theme: ThemeApi): { callout: Size; label: Size; };
export function drawCallout(ctx: CanvasRenderingContext2D, plan: PeakPlan, text: CalloutText, theme: ThemeApi, alpha?: number): void;
```

#### `charts/color.ts`

```ts
export function withAlpha(color: string, a: number): string;
```

#### `views/appbar.ts`

```ts
export interface AppBarHandle { setModel(model: Model | null, sections: SectionInfo[]): void; destroy(): void; }
export function displayArgs(args: readonly string[]): string;
export function middleEllipsis(s: string, max: number): string;
export function mountAppBar(el: HTMLElement, shell: ShellContext): AppBarHandle;
```

#### `views/ai/controller.ts`

```ts
export type AiCardState = { status: "setup"; message: string; missing: string[]; } | { status: "working"; startedAt: number; provider: string; model: string; mode: "line" | "region"; start: number; end: number; } | { status: "result"; result: OptimizationResult; view: "proposal" | "diff"; showPrompt: boolean; } | { status: "error"; error: AiError; mode: "line" | "region"; };
export interface AiController { settings(): AiSettings; ready(): Readiness; providerSummary(): string; availability(file: string): Map<number, ProposalAvailability>; request(file: string, line: number, mode: "line" | "region"): void; cancel(anchor: string): void; dismiss(anchor: string): void; card(anchor: string): AiCardState | null; anchors(file: string): string[]; openSettings(focusField?: string): void; onChange(cb: (anchor: string | null) => void): () => void; }
export interface AiControllerHandle extends AiController { load(model: Model | null): void; destroy(): void; }
export function createAiController(shell: ShellContext): AiControllerHandle;
```

#### `scalene-gui.ts`

```ts
export function renderCombinedStacksTimeline(host: HTMLElement, ctx: ViewContext): TimelineMount;
export { pickNiceTickInterval, formatTimelineTickLabel, formatMemoryTickLabel, renderTimelineAxis, renderTimelineGridlines, renderMemoryAxis, renderMemoryGridlines };
export interface LegacyAiHandlers { toggleServiceFields(): void; togglePassword(btn: HTMLElement): void; toggleAdvanced(el: HTMLElement): void; refreshOpenAIModels(): void; refreshGeminiModels(): void; checkApiKey(value: string): void; }
export function registerLegacyAiHandlers(handlers: Partial<LegacyAiHandlers>): void;
export function installGlobals(app: App): void;
```
