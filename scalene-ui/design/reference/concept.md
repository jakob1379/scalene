# Concept A — "Instrument"

A Scalene report that reads like a precision instrument: one live **signal** of the whole run,
a ranked **hotspot strip**, and a code view in which **every line is a channel strip with
meters**. Dark-first (deep ink, luminous data marks, hairline grids), with a light theme
tuned separately.

Prototype: `index.html` (ml-training.json), `index-async.html`, `index-cpu.html`, plus
`index-neuron.html`, `index-example.html` (very old format), `index-huge.html` (stress) and
`index-empty.html`. Source: `src/*.js`, `src/style.css`, `src/shell.html`; `node build.mjs` makes
the pages, and `node shoot.js` takes the screenshots. Everything is vanilla JS, inline SVG and
Canvas 2D. There are no external resources, and the pages work from `file://`.

---

## 1. The big idea, and why it answers the brief

**The run is a signal; you read it like a scope.** Profilers usually open on a table. Scalene's
data has a time axis, though: `samples` (footprint), `combined_stacks_timeline` (what every
thread was doing), `cpu_samples_list` (when each line ran) and per-line `memory_samples`. A run
is a waveform. "Instrument" puts that waveform first, as a multi-channel scope:

| Channel | Data | Encoding |
|---|---|---|
| **PHASE** | main-thread timeline mapped to the outermost loop or top-level statement (`start/end_outermost_loop`) | partitioned ruler: `for step in range(cfg.max_steps)` |
| **MEMORY** | `samples` (global footprint, MiB) | luminous line + 12–30 % area, peak dot with direct label |
| **CPU** | timeline bucketed per 4 px: sampled threads by leaf frame (Python / native / I/O·GIL wait) | spectrum bars, y = sampled threads |
| **TASKS** (async) | synthetic `[await]` stacks per bucket | teal step area, y = suspended tasks |
| **THREADS** | per-thread sample density | logic-analyzer lanes, one per thread |

Then the instrument is *linked*. Hover or focus any hotspot, finding or code line and the scope
lights up **when that line ran** (ticks from `cpu_samples_list`) and **when it allocated** (dots
from its `memory_samples`, on the footprint trace). Dragging on the scope selects a range and
zooms the thread timeline to it. The answer to "where did the time and memory go?" is stated in
words, numbers, a ranking and a picture, all on the first screen.

How each part of the brief is met:
- *Revolutionary / captivating*: no profiler shows the run as a linked multi-channel scope with
  per-line "ran here / allocated here" overlays. The first frame is a sweep: a phosphor beam
  draws the run left to right while the readouts count up (see `shot-anim.png`).
- *No cognitive overload*: the order is answer-first: a single headline sentence, four readouts
  at most, one picture, then a top-8 list. Colour encodes data only and the chrome is neutral.
  Columns appear only when the profile has that data. Cold code folds away, and long
  explanations live in tooltips and the inspector.
- *Motion that carries meaning*: the sweep shows the time axis, count-ups land on the true
  values, bars grow from the baseline in rank order, FLIP re-ranks keep object constancy, and the
  flame zoom interpolates the x-domain. Nothing frequent animates for more than 200 ms (§9).
- *Precise plots*: every number is labelled with a unit and "% of what". Axes start at 0. Bars
  use one stated scale per column. Memory uses binary units (MiB/GiB), because that is what
  Scalene's `*_mb` fields contain.

---

## 2. Information architecture (answer-first)

| Order | What | Why here |
|---|---|---|
| 0 | **Top bar** (sticky, 52 px): logo mark, program + args, section nav with scroll-spy, Search ⌘K, AI, Load, Theme | identity and the global actions, always one click away; replaces the 100 px logo and inline AI form |
| 1 | **Headline sentence** generated from the data: *"train.py ran for 54.1 s. Two lines in `train()` account for 37.6 % of the time; memory peaked at 3.11 GiB."* + meta line (date, files, +N below threshold, threads, accelerator, version) | the answer in one breath (fixes A1/A3/A4) |
| 2 | **Readouts** (≤ 4): Elapsed · Where the time went (Python/native/system + stacked bar + "0.4 % outside profiled files") · Peak memory (+ when, where, Python share, growth, native-thread MiB) · contextual 4th: GPU memory / Await / Neuron runtime / Hottest line | Cowan's ~4 chunks; each tile = big tabular number + one micro-visual + a caption that says "% of what" |
| 3 | **Signal** scope (above) | shows *when* things happened; a summary table can't |
| 4 | **Hotspots** (Lines / Functions / Files × Time / Memory) + **Findings** (≤ 3 rule-based cards, "Show N more") | "where is it" ranked across files; findings say "why it matters" and link to evidence |
| 5 | **Code**: file tabs with share bars → file stats → line channel strips, function header rows, folds, inspector | drill-down to the exact line, with every per-line metric |
| 6 | **Call stacks** (CPU / Memory icicle) | "why is this line hot": its callers and callees |
| 7 | **Timeline** (GC/I-O/GIL annotation lanes + thread swimlanes) | ordering, concurrency and contention |
| 8 | **Memory** (footprint chart with allocation-site overlay + largest sites + leaks) | memory narrative, with leak evidence |
| 9 | Footer: version/date, report issue, success stories, load another profile | parity links at a quiet weight, not fixed to the viewport |

---

## 3. Layout grid and responsive behaviour

4 px spacing grid (4/8/12/16/20/24/32/40). Cards: 12 px radius, 1 px hairline, 20 px section gap.
Page gutter: 32 px (40 px from 1800 px up, 12 px on phones). Content max-width 2200 px (2360 px
from 2400 px up).

| Viewport | Behaviour |
|---|---|
| **2560×1440** | The hero gets a 34 px KPI scale and a 340–380 px scope. Hotspots (fluid) sit beside Findings (420 px+). The code area becomes 3 columns: **files rail 260 px** · channel strips · **docked inspector 400 px**. Extra columns appear: Avg, Alloc share, Copy, GPU mem. See `shot-wide.png`. |
| **1440×900** | The first screen shows the headline, readouts, signal and top hotspots. The code area has horizontal file tabs and a docked 340 px inspector. Columns: Line · Time · Memory · Trend · GPU util (Copy appears when the code area is ≥ 1180 px). |
| **1024** | The nav collapses (sections stay reachable with Search). KPIs go 2×2. Hotspots and Findings stack. The inspector becomes a **bottom sheet**. |
| **390 phone** | Viewport meta is set. "Where the time went" spans the full width; Elapsed / Peak / GPU form a compact row of 3. The signal is 230 px with inline axis labels. Hotspot rows go to 2 lines (bar + value / code + `file:line`). Code: Line · Time (mini-meter + value) · Source, with every other metric in the bottom-sheet inspector on tap. Touch targets ≥ 36–44 px. See `shot-mobile*.png`. |
| **1000×400 iframe** (Jupyter) | `@media (max-height: 520px)` gives a compact mode: 44 px top bar, one-line headline, all 4 readouts in one row without captions, and a 170 px scope without phase/threads. The **whole answer fits in 400 px** (`shot-iframe.png`). |
| VS Code webview | The same layout, following `prefers-color-scheme`. `acquireVsCodeApi()` is cached once, and `jumpToLine` keeps the upstream message shape. |

No horizontal page scroll at any width (checked: `scrollWidth == clientWidth` for every capture).

---

## 4. Colour tokens

Colour = data; chrome is neutral. Hue = resource. Lightness = origin (Python strong, native soft,
system grey + 45° hatch). Every hue has a non-colour twin (position, label, hatch, `[await]`,
icon).

### Neutrals
| Token | Dark ("Instrument") | Light ("Daylight") | Text contrast dark / light |
|---|---|---|---|
| `--page` | `#07090D` | `#F4F5F7` | |
| `--surface` (cards) | `#0C0F14` | `#FFFFFF` | |
| `--raised` (drawer, popover) | `#12161D` | `#FFFFFF` + shadow | |
| `--sunken` (tracks, code chips, charts) | `#06080B` | `#F0F2F5` | |
| `--line` / `--line-strong` (decorative hairlines) | `#1A1F28` / `#2A313D` | `#E4E7EC` / `#CDD2DA` | — |
| `--fg` | `#E8ECF2` | `#0E1116` | 16.2 / 18.9 on surface |
| `--fg-2` | `#A3ADBC` | `#454D5C` | 8.5 / 8.5 |
| `--fg-3` (labels, line numbers) | `#7F8999` | `#5E6676` | 5.4 / 5.8 on surface; ≥ 5.1 on raised and sunken |

### Data marks (validated in research §3.3; re-checked against these surfaces)
| Token | Dark | vs surface | Light | vs surface |
|---|---|---|---|---|
| `--cpu-py` | `#79B4FF` | 8.9 | `#044CB6` | 7.7 |
| `--cpu-native` | `#378EC8` | 5.4 | `#1385BD` | 4.1 |
| `--cpu-sys` (+hatch) | `#6B7079` | 3.9 | `#8C8F94` | 3.2 |
| `--mem-py` | `#62D286` | 10.1 | `#007137` | 6.2 |
| `--mem-native` | `#549957` | 5.6 | `#579C50` | 3.4 |
| `--copy` | `#F6B84D` | 10.9 | `#C67600` | 3.5 |
| `--gpu` | `#C190F6` | 7.9 | `#8031C0` | 6.7 |
| `--gpu-mem` (Neuron NRT) | `#8E62BC` | 4.2 | `#A777CA` | 3.4 |
| `--async` | `#56D3D7` | 10.7 | `#007E84` | 4.9 |
| `--gil` | `#F075AA` | 7.2 | `#C64080` | 4.7 |
| `--danger` (leaks, errors) | `#FA6863` | 6.6 | `#C92324` | 5.6 |

All marks are ≥ 3:1 on the surface they are drawn on (WCAG 1.4.11). The light-mode soft tokens
are only used as fills next to `--fg` labels, never as text colour.

**Stack frames** (flame graph and timeline) use tints so that labels stay legible. Python frame
= `cpu-py` mixed 46 % / 34 % into sunken, **plus a 1.25 px top edge in full `cpu-py`** (the
"luminous edge" marks your code). Native frame = a desaturated "steel" (`cpu-native` ⊕ `fg-3`)
mixed 32 % / 22 %, with no edge. `[await]` = async hatch. Labels in `--fg`: dark 6.3 (py) / 11.1
(native); light 9.5 / 12.8. Python vs native fill contrast is only 1.78 (dark) / 1.35 (light).
Hue, the edge, the legend chip and the tooltip's "Python frame" kind label carry the distinction
(see weaknesses). Memory flame frames use the same recipe with `mem-py` (fg on fill 5.8 / 10.1).

**Row heat wash** (code view): `--wash-cpu` (`#1B293F` / `#E0ECFF`) fades left → right, with
opacity 0.3 → 1 ∝ line share. Code on max wash: 12.3 / 15.9; comments on max wash: 4.8 / 4.6.

**Glow** (`--glow: 1` in dark, `0` in light): canvas `shadowBlur` 10 on the footprint trace
and peak dot, LED dots on readout labels, and a faint radial phosphor wash on the hero. These
are used sparingly and never on text.

**States**: hover = `--hover` (3–3.5 % ink); selected row = `--select` + 2 px `--fg` inset bar;
focus ring = 2 px `--fg`, offset 2 px (≥ 15:1); search non-match = frame tinted to 12 % grey at
0.9 alpha; flash after a jump = `--copy` at 28 % fading over 1.2 s (upstream parity).

---

## 5. Type scale (system fonts only)

`--font-ui: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, …`
`--font-mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, …`
(nothing is downloaded). Ligatures are **off** for code (`==` must stay `==`).
`font-variant-numeric: tabular-nums` applies everywhere numbers align or count.

| Role | Size / line | Weight |
|---|---|---|
| micro labels (KPI, channels, column groups) | 11 / 14, +0.06 em, uppercase | 600 |
| captions, axis ticks, chips | 12–12.5 / 16–18 | 400–500 |
| code | 13 / 22 (12 on phone) | 400; keywords 600 |
| body | 14 / 20 | 400/500 |
| card titles | 15 / 22 | 600 |
| headline sentence | 22 / 30 (24 wide, 17 phone, 16 iframe) | 500, key numbers 600 |
| readout numbers | 30 / 36 (34 wide, 24 phone, 20 iframe) | 600, −0.02 em |

---

## 6. Units and formatting (one formatter per quantity)

| Quantity | Format | Examples |
|---|---|---|
| share | ≥ 0.05 → one decimal; < 0.05 → `<0.1%`; 0 → `0%` | `21.4%`, `0.4%`, `<0.1%` |
| time | µs / ms / s (2 decimals < 10 s, 1 decimal < 60 s) / `m ss s` / `h mm m` | `368 ms`, `2.64 s`, `54.1 s`, `3 m 47 s` |
| memory (MiB input) | B / KiB / MiB / GiB / TiB, 3 significant digits | `22 KiB`, `98.3 MiB`, `3.11 GiB` |
| rate | memory + `/s` | `5.71 MiB/s`, `288 KiB/s` |
| counts | grouped | `5,901 samples` |

Every number says **what it is a share of**: "of run" (share of sampled time; `% × elapsed` gives
time), "of sampled stacks" (flame), "of attributed allocation" (memory flame), "of all
allocation" (`n_usage_fraction`, program-wide, which fixes upstream's "in file" wording), "busy
while this line ran" (GPU util), "of await time", "of elapsed" (NRT/NC), "of samples"
(GC/I-O/GIL lanes).

---

## 7. Iconography

Inline SVG only: a 16 px grid, 1.5 px stroke, round caps, and `currentColor` (`ICONS` in
`01-util.js`). The set: search, spark (AI), sun/moon, upload, chevrons, x, jump-to-editor, flame,
lanes, memory chip, code, leak (trend-up), GPU, sync, peak, CPU, copy, wait, minus/plus, reset,
file, ƒ (function), eye (inspect), info.

There are **no emoji**. Upstream's ⚡ becomes an "Optimize" button and 💥 becomes
"Region a–b" (spark icon + text). The logo mark is a triangle whose three edges are drawn in the
CPU, memory and GPU colours (an echo of Scalene's logo, in 22 px vector).

---

## 8. Components

**Readouts (KPI).** A micro label with an LED dot in the resource colour, a big tabular value
with a small unit, one micro-visual (a stacked bar for the CPU split, a Python/native minibar for
peak memory) and a two-line caption. The fourth tile adapts:
- GPU: peak device memory, plus the busiest line's utilisation.
- Async: peak suspended tasks, plus the top await line.
- Neuron: NRT seconds and % of elapsed, NC busy time, device idle % of CPU samples.
- Otherwise: the hottest line.

`max_footprint_python_fraction` missing (old profiles) → a neutral bar, and no Python % is claimed.

**Signal scope** (`03-hero.js`). Two canvases: a static base and an overlay for the cursor,
brush, sweep and linked marks.
- Gutters: 112 px left for channel labels, 70 px right for y ticks (inline on phones).
- Hover readout (glass card): time; footprint (interpolated); sampled threads with the
  Python/native/wait split; suspended tasks; phase; the main thread's leaf Python frame and its
  source line.
- Drag selects a range: a chip shows "Selected a – b · Open in timeline", and the timeline
  zooms. Click a phase to jump to its line.
- Memory scale: nice binary ticks (1-2-5 in GiB or MiB), starting at 0. The CPU y-axis = integer
  sampled-thread ceiling.

**Hotspot strip** (`04-hotspots.js`). Rows are 40 px with fixed columns: rank · meter (segments
Python/native/system-hatch, **scaled to #1**, with 25/50/75 % graduations) · value · seconds ·
syntax-highlighted code · one badge (leak > GPU > await > copy) · `fn() file:line`.
- Toggles: Lines / Functions / Files × Time / Memory (memory = peak, Python/native split,
  secondary = share of all allocation).
- Footer: Pareto ("Top 8 lines = 58.4 % of run time" + bar), "N more", "Open code view".
- Interaction: click or Enter jumps to the code. ↑/↓ or j/k move. Hover/focus lights the scope.

**Findings.** Deterministic rules, with ≤ 3 shown and the rest behind "Show N more". Each card has
a tinted icon, a one-line title, a factual sentence with the numbers, and a `file:line` link.
The rules:
- GPU sync: system ≥ 50 % of the line and GPU ≥ 50 % busy.
- CPU work inside a coroutine.
- Possible leak (likelihood, velocity).
- Peak location.
- Native vs Python dominance.
- Heavy copy (≥ 10 MiB/s).
- GIL wait ≥ 2 % of samples.
- Neuron device idle during CPU work.

**File navigation.** Tabs show `basename` + share + a mini Python/native/system bar + peak +
"leak". Collapsed files that fall under the exclusion rule are **counted** ("+16 files below
1%"; ml-training has none). From 1800 px the tabs become a vertical rail. Search (⌘K) covers
every file, function and line.

**Code / line view** (`05-code.js`). A row is 22 px; the header is sticky (under the top bar)
and states each column's unit. Columns appear only when the profile has the data:

| Column | Data | Encoding / threshold (upstream parity) |
|---|---|---|
| Line | `lineno` | clickable → `vsNavigate` (VS Code `jumpToLine` / in-page) |
| Time · % of run | `n_cpu_percent_python/_c`, `n_sys_percent` | segmented meter scaled to the hottest line + `21.4%` |
| Memory · peak | `n_peak_mb`, `n_python_fraction` | meter scaled to `max_footprint_mb` (global peak = full) + `1.20 GiB` |
| Trend | `memory_samples` + `leaks` | 56×16 sparkline on the shared [0, tMax] × [0, peak] scale, max marked; red when a leak |
| Avg · Alloc · Copy | `n_avg_mb`, `n_usage_fraction` (≥ 0.01), `n_copy_mb_s` (≥ 1) | right-aligned numbers with units |
| GPU util / GPU mem | `n_gpu_percent` (≥ 1), `n_gpu_peak_memory_mb` (≥ 1 & util ≥ 1) | absolute 0–100 meter / number; hidden when Neuron data exists |
| Await | `n_async_await_percent` (≥ 1) | meter scaled to the max line |
| Unused · NRT · NC | Neuron merge fields | dot (green < 30 ≤ amber < 60 ≤ red) + %, meters as % of elapsed |
| Source | `line` (unescaped `</e/26`) | calm highlighter, docstrings italic/dim, heat wash |

Other parts of the code view:
- **Function header rows** (ƒ `train()` · meter · `47.1% of run · 25.5 s` · `peak 2.01 MiB` ·
  `GPU 81.8%`) replace the separate function table as structure. The table is still available
  under **Lines | Functions**, sorted by time, and clicking a row jumps to the function.
- **Folds**: "⋯ 51 lines without samples (19–69)". Click to reveal. Nothing is hidden silently.
- **Display modes**: Profiled functions (default) / Hot lines / All, using upstream predicates.
- **Ranking**: clicking any column header ranks by it (**descending first**, arrow +
  `aria-sort`). Clicking `#` returns to source order. The re-rank is FLIP-animated.
- **AI affordance**: on hover/focus/selection a row shows **Optimize** (eligible lines, upstream
  rule) and **Region a–b** (first line of a region ≤ 50 lines), plus Inspect.

**Inspector.** Docked from 1280 px; a bottom sheet below that. It shows `file:line`, the
function and region, and the code. Then:
- **Time**: share + seconds, a split bar with values, core utilisation.
- **When it ran**: the run-long strip of `cpu_samples_list` ticks and allocation dots.
- **Memory**: peak, avg, Python share, allocated, share of all allocation, copy rate, leak
  velocity + likelihood, and the footprint-at-allocation chart with axes over the faint global
  trace.
- **GPU**: util, device memory peak/avg.
- **Async**: await share, concurrency mean/peak, coroutine flag, task names (100+ capped).

Actions: Optimize line / region, Open in editor, Show in stacks.

**Flame graph** (`06-flame.js`, canvas). An icicle, left-heavy (children by weight), 22 px rows.
Merge key = upstream (`kind|file|line|name`). Labels: `name` + quiet `:line`, middle-truncated,
hidden below 34 px. Unresolved native frames show `0x…`.
- Tabs: CPU stacks (`combined_stacks`, width = share of sampled stacks) / Memory stacks
  (`memory_stacks`, width = share of attributed MiB).
- Search dims non-matches and reports "matched X % of samples".
- Click zooms (x-domain tween 280 ms) with a breadcrumb; Escape or a crumb zooms out.
- Double-click a Python frame opens its line. Arrow keys walk frames; Enter zooms.
- The tooltip shows kind, name, file:line or module, share, samples/MiB, self, % of caller and
  the source line (via the file lookup, with graceful misses for files not in `files`).

**Thread timeline** (`07-timeline.js`, canvas).
- **Annotation lanes** GC / I/O / GIL with "% of samples" totals; upstream classification
  regexes are ported verbatim.
- **Swimlanes** by default when there is more than one thread. Main is expanded as a
  function-level flame chart; workers are collapsed into activity strips, and clicking a header
  expands one.
- **Interleaved** mode and a **single-thread** select (parity).
- **Durations**: a run ends at the next event *of the same thread*, capped at count × the
  estimated sampling interval. That interval is the median per-sample gap, 10 ms in ml-training.
  This avoids upstream's cross-thread end times.
- **LOD**: segments < 1.5 px collapse into a muted "busy" band per pixel, so zoomed-out views are
  calm and wide segments stay crisp.
- **Navigation**: drag to zoom, ⌘/Ctrl+wheel zooms at the pointer, shift/horizontal wheel pans,
  W/S/A/D keys, double-click resets, ± and Reset buttons. The time axis uses 1-2-5 ticks with
  adaptive units, plus a cursor rule.

**Memory section** (`08-memory.js`).
- Stats: peak, at (time + line), growth, native threads, leak count.
- A 260 px footprint chart with axes and peak annotation. **Allocation-site overlay**: select a
  site (the default is the top leak) to plot the footprint at each of its allocation events,
  dashed and dotted (red for leaks).
- "Largest allocation sites" list with meters scaled to the global peak and leak badges.

**AI optimization** (`09-ai.js`).
- A right **drawer** (dialog, focus-managed, Esc/scrim to close) holds:
  - all six providers as radio tiles in upstream order;
  - per-provider fields with **upstream element ids/storage keys** (`service-select`,
    `scalene-api-key`, `aws-access-key`, `language-model-*`, …);
  - Show/Hide on secrets;
  - an Advanced disclosure (custom model/URL, Azure API version, Bedrock session token);
  - model selects with Refresh;
  - Ollama host/port with an explicit **Check** (no network on load);
  - an Optimize-for segmented control (Runtime / Memory);
  - an "Include GPU optimizations" switch synced to `profile.gpu`;
  - the privacy note.
- Requests are inline: an **AI note** under the row (role=status).
  - Missing credentials → "add your Amazon Bedrock access key ID and secret access key" +
    **Open AI settings**, which focuses the first missing field.
  - The real flow adds working state + Cancel (AbortController) → result card with highlighted
    code, diff toggle, Copy, provider/model/time, Dismiss, and errors as inline notices with
    retry (never `alert()`).

**Load / drop / empty.** Drag a file anywhere: the full-page overlay "Drop a Scalene profile".
Invalid JSON gives a toast with the parser message (upstream failed silently). The empty state
shows a dashed drop zone, Choose a profile…, and the two CLI steps.

---

## 9. Interaction model

- **Keyboard**:
  - ⌘/Ctrl+K or `/` opens the palette (files, functions, code text), with ↑/↓ and Enter.
  - Tab order follows reading order; skip link.
  - Hotspots: ↑/↓ j/k, Enter.
  - Code rows (roving tabindex): ↑/↓ j/k move the selection, Enter opens the inspector, `o`
    optimizes, Esc closes.
  - Flame: arrows walk frames, Enter zooms, Esc zooms out.
  - Timeline: W/S/A/D.
  - Esc closes the drawer and palette.
- **Hover is never the only path**: everything in a tooltip is also in the inspector (focus/tap)
  or in text.
- **Linking**:
  - hotspot / finding / code row → scope overlay (ran here / allocated here);
  - scope brush → timeline domain;
  - phase click → code;
  - flame / timeline / memory site double-click or click → code line;
  - inspector → "Show in stacks" zooms the flame to that line's heaviest frame.
- **Navigation to a line** (one function, `APP.jumpTo`): switch file → reveal a folded line
  (no forced mode change) → smooth scroll to center → 1.2 s flash → select → focus.
- **Theme**: follows `prefers-color-scheme`. The toggle persists `scalene-theme` (try/catch;
  works without storage), with a 220 ms colour cross-fade and a canvas redraw.

---

## 10. Motion spec

Tokens: `--dur-1` 90 ms, `--dur-2` 140, `--dur-3` 200, `--dur-4` 280, `--dur-5` 420; ease-out
`cubic-bezier(.22,1,.36,1)`, standard `cubic-bezier(.2,0,0,1)`. Only transform and opacity
animate in the DOM; canvases interpolate in rAF.

| # | Trigger | Property | Duration / easing / stagger | Communicates | Reduced motion |
|---|---|---|---|---|---|
| 1 | first load | headline, meta, KPI tiles, card headers: opacity 0→1, y 6→0 | 420 ms ease-out; 40 ms stagger in reading order | reveal order = importance | opacity only, 150 ms |
| 2 | first load | KPI numbers count up to their exact final text (same unit and decimals; `aria-label` holds the final value) | 700 ms ease-out, 60 + 40 ms stagger | magnitude | final value immediately |
| 3 | first load | stacked/mini bars `scaleX` 0→1 from the baseline | 420 ms ease-out, segment stagger 40 ms | composition | full bars |
| 4 | first load | **scope sweep**: data clipped to a moving x, with a 1 px beam + 60 px phosphor trail; the peak marker appears when the beam passes it | 900 ms, `1-(1-t)^2.2`, starts at 140 ms | time runs left→right; the peak is an event in time | drawn complete |
| 5 | first load | hotspot bars grow from the baseline | 420 ms ease-out, 30 ms × rank (cap 8) | rank order, biggest first | static |
| 6 | section first enters the viewport | flame rows grow downward per depth | 260 ms/row, 16 ms × depth | hierarchy grows from the root | static |
| 7 | section first enters | timeline and memory chart sweep | 700–800 ms | same time metaphor as the hero | static |
| 8 | Lines/Functions/Files or Time/Memory toggle | FLIP rows (translateY) + bar width morph (scaleX old/new); new rows fade | 280 ms standard; fades 200 ms, 20 ms stagger | object constancy across re-ranking | instant + highlight |
| 9 | column sort / mode change in the code view | FLIP of visible rows | 280 ms standard | where each line went | instant |
| 10 | segmented control | thumb slides (translateX + width) | 200 ms standard | which option is active | instant |
| 11 | flame click / crumb / Esc | x-domain interpolation | 280 ms standard; cancellable | "this frame now fills the view" | instant |
| 12 | timeline brush / buttons / hero brush | domain interpolation | 280 ms (140 ms for keys) | zoom into the range | instant |
| 13 | jump to line | smooth scroll + background flash | browser smooth scroll; 1.2 s fade | where you landed | instant scroll + flash |
| 14 | tooltip / readout | opacity, 2 px rise | 90 / 140 ms | detail on demand | opacity only |
| 15 | drawer / bottom sheet | translateX / translateY | 280 ms standard | panel comes from the edge it lives on | instant |
| 16 | AI note | opacity + y −4→0 | 200 ms ease-out | result attached to the line | none |
| 17 | hover, linked highlight, crosshair, palette open | — | **0 ms** | — | — |

Frequent interactions never animate longer than 200 ms (hover 0, tooltips ≤ 140, thumb 200);
the 280 ms transitions are discrete, user-initiated view changes. `?reduced` forces the reduced
path for testing, and `?still` renders final frames.

---

## 11. Scale (huge.json: 40 files, 11.7 k lines, 3.2 k stacks, 41.6 k runs, 12 threads)

Measured in the prototype: `index-huge.html` (16 MB inline JSON) parses and renders all views in
about 2.1 s total in headless Chromium (upstream: ~55 s). The product plan:
- **Parse once**, then derive into typed arrays (`Float64Array` t0/t1, `Int32Array` stack index,
  `Int16Array` thread). `bucketize` is O(events) per width change.
- **Canvas** for the scope, flame and timeline. The overlay canvas means hover redraws only the
  cursor. The flame index is per depth and sorted by x (binary-search hit-test). Frames < 0.9 px
  are skipped and < 3 px dimmed. The timeline uses per-pixel LOD bands and `lowerBound` to cull
  to the visible domain.
- **Code view**: virtualize rows. A 22 px fixed row height makes this trivial: render the
  viewport ± 40 rows and keep folds as single rows. Today the prototype renders whole files
  (fine up to ~2 k rows). Sparklines → one shared canvas per viewport when virtualized.
- **Hotspots** use a partial sort (top-N heap). Search indexes lowercase text once.
- **Threads**: lanes are positional (no colour palette to overflow); 12+ threads stay readable,
  and the hero caps logic-analyzer lanes at 12 (with "N sampled").
- Downsample `samples` per pixel with min/max (M4) when > 2× pixel width (the old example has
  2,846 points).

---

## 12. Parity mapping (feature-inventory §10)

| Parity item | Where it lives in "Instrument" |
|---|---|
| Template vars, standalone/non-standalone, `scalene-gui-bundle.js`, offline, 400 px iframe, empty `profile` guard | Single bundle + shell; no external assets; compact short-height mode; `load("")`/`{}` → empty state |
| Upstream test literals (`toggleCombinedStacks`, `timeline-axis`, …, `.combined-stacks-section`, `.flame-segment`) | Product: keep these names as the section ids/classes and function names (the stacks section = `.combined-stacks-section`, the canvas host gets `.flame-segment` styling hooks; the axis functions keep upstream names) |
| `window` globals | `load`, `vsNavigate`, `loadFile`, `expandAll`/`collapseAll` (→ All / Hot lines modes), `toggleReduced` no-op are wired in the prototype. `proposeOptimizationLine/Region`, `toggleDisplay`, `onFileDisplayModeChange`, `toggle*Stacks` (scroll/focus the section), `changeTimelineViewMode`, `loadDemo`, `loadFetch`, `toggleServiceFields`, `togglePassword`, `toggleAdvanced`, `refresh*Models`, `checkApiKey` map 1:1 onto the new controls |
| VS Code `jumpToLine` (cached API), in-page jump + 1.2 s highlight, `vscode://file/…:line:1` | `APP.vsNavigate` (cached `acquireVsCodeApi`, escaped `filePath` as upstream); `APP.jumpTo`; "Open in editor" |
| Heartbeat 10 s, env keys over http(s) only | `bindGlobal` heartbeat; drawer prefill from `/env-api-keys.json` with an "from environment" badge (product) |
| `document.title` | `Scalene - <program>` |
| Summary: CPU split, peak + Python/native, memory timeline, max footprint, growth, native-thread MiB | Readouts + Signal memory channel + Memory section |
| File list sorted, exclusion rule + count, first file open, show all/hide all, per-file stats, Neuron totals | File tabs/rail (sorted by `percent_cpu_time`), "+N below 1 %" with reveal, first file selected, file info bar (% + time / total, peak, NRT/NC) |
| Line + function tables with every column and threshold | Channel strips (columns table §8) + inspector + Functions view |
| Display modes, docstrings, unescape, highlighting | Profiled functions / Hot lines / All; `stringLines` port; `</3e/26` unescape; calm highlighter |
| Sort by every column (descending first), reset to line order | Column headers + `#` |
| Leak indication with velocity | Trend sparkline (red), badges in hotspots/allocation list, findings, inspector (velocity + likelihood) |
| AI: ⚡/💥 eligibility, prompts, 6 providers, refresh, custom model/URL, Azure version, Ollama discovery, validation, working state, inline result, copy, regenerate, persistence keys, env prefill, default provider | Optimize / Region buttons (same rules via `computeProposalAvailability`), drawer (same keys/default provider), inline AI note/result card; the `src/ai` port supplies the network layer |
| Call stacks flame (icicle, merge key, sort, py/native colour, tooltip with source, click to navigate) | §8 Flame graph |
| Timeline: runs, GC/IO/GIL patterns, tracks, thread track/legend/labels, interleaved/swimlanes/single, merged segments, nice ticks + gridlines, tooltips, navigation | §8 Timeline (thread identity by lane label; raw ids in tooltips) |
| Memory stacks flame with MB axis, gridlines, formatted tooltips | Stacks → Memory tab (MiB; product adds the sticky MiB axis above the icicle) |
| Resizable charts | Charts size to content (flame grows with depth, max 620 px then scrolls; timeline expands per lane); no WebKit-only resizer |
| Empty state, load another profile, footer links | Empty state, drop overlay, top-bar Load, footer |

Data shown that upstream collected but never displayed: core utilisation, async concurrency/task
names/coroutine flag, leak likelihood, max-footprint location, program args, start time, GPU avg
memory, per-line sample times (`cpu_samples_list`).

---

## 13. Known weaknesses and open questions

1. **Python vs native flame fills are close in lightness** (1.35–1.78:1). They differ by hue,
   the Python top edge, the legend and the tooltip's kind label. A CVD-checked alternative is to
   give native frames a hatch at small widths.
2. **The scope's CPU channel is derived** from stitched stacks (leaf kind, threads sampled). It
   does not show the Python/native/system split that the tables report, and the timeline's
   `t_sec` origin is the first sample, not profile start, which can be off by one sampling
   interval. The readout and legend say what is shown, but users may still compare the channel
   with the "Where the time went" readout.
3. **Phase ribbon labels** need about 7 % of the run to fit, so short phases (e.g. `import torch`,
   4.4 %) show only in the hover readout.
4. **The zoomed-out timeline is dense** for alternating stacks. The LOD band calms it, but
   reading needs zoom; a minimap is not built.
5. The prototype renders whole files (no virtualization yet), uses a light Python highlighter
   (no multi-line string state beyond docstrings), and stubs the network AI call (settings,
   eligibility and the missing-credential path are real).
6. The default AI provider is still upstream's Amazon Bedrock when nothing is stored. Changing
   the default to Local (Ollama) would be friendlier, but it changes behaviour.
7. Glow and the phosphor wash are tuned for dark. Light relies on crisp 1.5 px traces and a soft
   area; on low-gamut displays the light `cpu-sys` hatch is the weakest mark (3.2:1).

---

## 14. Screenshots (all in this folder)

| File | Viewport | Content |
|---|---|---|
| `shot-desktop-dark.png` / `shot-desktop-light.png` | 1440×900 | first screen after the entry motion settles |
| `shot-desktop-full-light.png` (+ `shot-desktop-full-dark.png`) | 1440 × full | the whole report |
| `shot-wide.png` | 2560×1440 | wide layout (files rail, docked inspector, extra columns) |
| `shot-mobile.png` (+ `-2`, `-3`) | 390×844 @2x | phone: hero, hotspots, code |
| `shot-iframe.png` | 1000×400 | Jupyter compact mode |
| `shot-anim.png` | 1440×900 | mid-sweep frame (~520 ms): beam, trail, numbers counting |
| `shot-flame.png` / `shot-flame-zoom.png` | 1440×900 | icicle with tooltip; zoomed into `train:165` with breadcrumb |
| `shot-timeline.png` | 1440×900 | GC/I-O/GIL lanes, main lane expanded, workers collapsed, tooltip |
| `shot-code.png` / `shot-code-ai.png` | 1440×900 | channel strips, function header rows, inspector; Optimize → missing-credentials note |
| `shot-link.png` / `shot-scope-hover.png` | 1440×900 | hotspot hover lights the scope; scope readout |
| `shot-ai.png` | 1440×900 | AI settings drawer (light) |
| `shot-async.png` / `shot-cpu.png` / `shot-empty.png` | 1440×900 | async variant (TASKS channel, await readout), CPU-only variant, empty state |
