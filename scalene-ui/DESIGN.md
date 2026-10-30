# Scalene UI — DESIGN.md

**Status:** final design, ready to build. This file is the single source of truth for the new Scalene
report UI. Engineers implement it in parallel from this document alone. If code and this document
disagree, the document wins until it is amended in a reviewed change.

**Codename:** *Instrument* (concept A), with grafts from *Atlas* (B) and *Lens* (C).

**Reference material** (read-only, for context, never required to build):

| What | Where |
|---|---|
| Chosen prototype + screenshots | `scalene-ui/design/reference/` (concept A) |
| Alternatives (screenshots, prototypes) | `scalene-ui/design/alternatives/concept-B/`, `…/concept-C/` |
| Profile schema semantics | `src/types.ts` (doc comments) and §4.0 of this file |
| AI port API | `src/ai/index.ts` (§4.14 and §8 describe how the UI uses it) |
| Fixtures | `scalene-ui/fixtures/*.json` (golden numbers in Appendix A) |

**Conventions in this document**

- "MUST" / "MUST NOT" are acceptance criteria. "Should" is a strong default that can change only
  with a written reason in the PR.
- Profile fields are written `like_this` (exact JSON keys). Model fields are written `Line.total`.
- Every number on screen has a unit and a denominator ("% of what"). The vocabulary is fixed in
  §4.0.3. Do not invent new denominators.
- Pixel sizes are CSS px. Durations are ms. Colours come only from tokens (§3). A hex value in a
  component file is a bug, with one exception: canvas code reads tokens through `theme.tokens()`.
- Breakpoint names (`xs` … `xxl`, `short`) are defined in §2.2 and used everywhere.

---

## 1. Vision and principles

### 1.1 Vision

> **The run is a signal. Read it like an instrument, answer first, and land on the exact line.**

Scalene measures a program over time: when each line ran (`cpu_samples_list`), what every thread was
doing (`combined_stacks_timeline`), how the footprint moved (`samples`, `memory_samples`), and how it
all adds up per line. Every other profiler opens on a table. This report opens on **the answer**,
written as one sentence, with up to four readouts. Next to them is **the run drawn as a luminous
multi-channel signal**: phases, footprint, thread activity, and when each of the top lines ran. The
ranked **hotspots** sit beside that signal. Each hotspot has a rank number, and the same number labels
its strip on the signal. Hover a hotspot and the signal lights up the moments that line ran and
allocated. Click it and the report flies to the line. There the line opens into a lens that has every
metric Scalene recorded, the call context, and the AI action.

The screen should feel calm and precise, like a well-designed oscilloscope. Chrome is neutral, and
data is the only colour. Typography uses tabular figures. Motion happens only when it says something
about the data: the sweep shows that time runs left to right, the bars grow in rank order, the zoom
keeps object constancy, and the jump shows where you landed.

### 1.2 The decision (base concept and grafts)

| Judge | A Instrument | B Atlas | C Lens | Winner |
|---|---|---|---|---|
| Aesthetics | **8.3** | 7.2 | 7.0 | A |
| Clarity | 7.0 | 6.6 | **7.6** | C |
| Engineering | **7.4** | 7.0 | 5.6 | A |
| Mean | **7.57** | 6.93 | 6.73 | **A** |

**Base: A "Instrument".** It has the most share-worthy first screen and the most coherent design
system. Its motion carries meaning, its number layer is the most truthful, its architecture is bounded
(one file at a time, canvas pairs), and it has the best 400 px iframe. Its clarity weaknesses are
layout problems, and the layout below fixes them.

**Structural change from A, driven by the clarity judge.** At ≥ 1280 px the scope and the hotspot
list sit **side by side in one "Instrument" card**, so that all 8 hotspots are on the first screen at
1440×900. This also makes linked hovering obvious, because the signal is right next to the list. The
scope gets shorter (≈ 300 px at 1440). The THREADS logic-analyzer lanes are replaced by a calm
step-area channel, and the hotspots' "when it ran" strips become a channel of the scope.

**Grafts.**

| From | Idea | Where in this spec |
|---|---|---|
| B | "When the top lines ran" small multiples on the shared time axis (scope channel *TOP LINES*, rank-numbered like the hotspot list) | §4.4.5 |
| B | Flame % axis with hairline gridlines and "share of sampled stacks, not of run time" note; axis re-bases to the focused frame | §4.11 |
| B | Semantic-zoom motion grammar for flame zoom (focus fills, siblings fly out, staged lateral jumps) | §4.11, §5 M11–M12 |
| B | Headline generator rules: spread-out branch, event-loop branch, ≤ 2 code chips | §4.2 |
| B | Denominator phrasing everywhere; "Possible leaks" readout; ranked file rail with hidden-file count | §4.0.3, §4.3, §4.7 |
| B | Valid table semantics with sortable `columnheader`s; polite live announcer for canvases; contrast discipline (never dim with opacity); visible skip link | §4.8, §6.2 |
| C | Flame/timeline frame palette with ≥ 3:1 Python/native separation; shared category chips; crosshair time chip + footprint dot | §3.4, §4.11, §4.12 |
| C | Inline **lens** as the detail form below 1600 px (and on touch); A's docked inspector at ≥ 1600 px | §4.9 |
| C | Single-file heat **ribbon minimap** with rank pins, inside the code view only (role=slider) | §4.8.9 |
| C | Intro pacing ≤ 1.0 s; zero-motion reduced-motion path; zero horizontal overflow from 320 to 2560; headline + readouts in one row at 2560 | §5, §2 |
| C | Lens memory chart: program footprint (grey) with this line's allocation moments (dots) on a shared scale; caption conventions ("mean while running · time-weighted, main thread") | §4.9, §4.3 |

**Rejected on purpose.** B's treemap hero (not area-true, flat at scale, labels become stubs). C's
always-on global ribbon (noise on multi-file profiles) and its all-files-in-one-scroll code view
(47 k DOM nodes on huge.json). The THREADS logic-analyzer lanes in A's hero (read as dotted noise).
B's "GB/MB" labels (the values are binary units).

### 1.3 Principles (each one is testable)

1. **Answer first.** One sentence, up to 4 readouts, then the ranked list and the signal. The first
   screen at 1440×900 MUST show the headline, the readouts, the signal and all 8 hotspots. At 390×844
   the first screen MUST show the headline, the time split and the top 3 hotspots.
2. **Colour is data.** Chrome is neutral, and the interactive accent is ink (`--fg`). One hue per
   resource, with lightness by origin (Python strong, native soft, system grey + hatch). Every colour
   has a non-colour twin: position, label, hatch, glyph or icon.
3. **Every number is honest.** It has a unit and a "% of what" (§4.0.3), one formatter per quantity
   (§4.0.2), and binary memory units (KiB/MiB/GiB). An absent field is never shown as a measured 0;
   it shows "not recorded" or the element is hidden. Area encodings are area-true. Bars start at 0.
4. **One encoding per quantity.** The same quantity uses the same mark and colour in every view. No
   two quantities share a mark/colour pair. ("System time" hatch ≠ "waiting" hatch, §3.4.)
5. **Code renders verbatim.** Ligatures are off on every code surface. Source text is never dimmed
   with opacity. Code chips are never truncated mid-token.
6. **Motion carries meaning.** Each animation in §5 names what it communicates. Hover, crosshair,
   keyboard movement and palette open/close are instant. The intro settles in ≤ 1.0 s. Reduced
   motion renders final states on the first frame.
7. **Nothing hides silently.** Folded code says what it hides and what it costs. Filtered files are
   counted, and truncated lists say "N more". Clipped labels have the full text in a tooltip and in
   the detail panel.
8. **Hover is never the only path.** Everything in a tooltip is also reachable by focus, tap, the
   detail panel or the live region.
9. **Bounded work.** The DOM stays under 8 k nodes on huge.json. Canvas is used for dense charts.
   Code rows are virtualized. Heavy derivations are lazy and sliced. No long task over 200 ms after
   first paint.
10. **Host-agnostic.** It works from `file://`, in a 400 px-tall Jupyter iframe, in a VS Code webview,
    and on phones and 2560 px monitors. It is offline, uses system fonts, and loads no network assets.

### 1.4 Must-fix register (every judge item, where it is fixed)

Acceptance for WP6 (§8.6): every row is verified, with the evidence named in the right column.

| # | Must-fix (source judge) | Fixed in | Verified by |
|---|---|---|---|
| 1 | Ligatures off on every code surface (all) | §3.5: ligature-free mono stack + `.code` rule; canvas text rule | CSS test: computed `font-variant-ligatures: none` on every `.code` element; `--font-mono` contains no ligature face (no "Cascadia Code", "JetBrains Mono", "Fira Code"); screenshot shows `>=`, `->`, `==` verbatim in code, chips, flame and tooltips |
| 2 | Phase ribbon: no empty, unlabeled boxes (aes) | §4.4.3 | Visual + unit test on phase layout |
| 3 | Python/native frames ≥ 3:1 apart, both themes; new light tints (aes, eng) | §3.4 | Token contrast table (§3.7) |
| 4 | CPU channel: calm step-area with labelled y axis, capped height; no solid wall on CPU-only (aes, clarity) | §4.4.4 (THREADS channel only for > 1 thread; TOP LINES carries single-thread runs) | cpu-only screenshot |
| 5 | Chart annotation collision avoidance at 390, 1000×400, 1440 (aes) | §4.4.7 | `scope.debugLayout()` geometry test |
| 6 | Intro ≤ 1.0 s; composite numbers never inconsistent mid-animation; reduced motion = final frame (aes, eng) | §5.2, §5.4 | Filmstrip test at 0/300/600/1000 ms |
| 7 | No horizontal overflow at 320/360/390 (all) | §2.2, §6.2.9 | `scrollWidth == clientWidth` with `isMobile` emulation |
| 8 | Headline ≤ 2 code chips, no mid-token truncation, spread-out + event-loop branches (aes, clarity, eng) | §4.2 | Golden headline strings, Appendix A |
| 9 | Allocation overlay = rug/ticks, never 100 rings, never over the peak callout (aes) | §4.4.6, §4.13 | Visual |
| 10 | Theme toggle keeps scroll and selection, redraws canvases in place (aes) | §4.1.6 | Test: `scrollY` and selection unchanged |
| 11 | One GC / I/O / GIL classification and one set of lane totals (aes, clarity, eng) | §4.0.6 (`classify.ts`) | ml-training: GC 0.6 %, I/O & waits 2.8 %, GIL 0.9 % in every view |
| 12 | No treemap (aes) | §1.2 rejected | — |
| 13 | Ribbon hidden in short hosts and empty state; pins de-overlapped; viewport window = visible lines (clarity) | §4.8.9 | Visual at 1000×400 |
| 14 | One definition per number: GPU mean method + one decimal; adaptive rate units; "of run" on region time; "none sampled" not "0 MiB" (clarity) | §4.0.2–4.0.4 | Unit tests on formatters + model |
| 15 | Phone: top 3 hotspots before secondary readouts (clarity) | §2.4.5 | 390×844 screenshot |
| 16 | Every jump moves focus to the target row and opens its detail (clarity) | §4.8.8 `jumpTo` | Keyboard test |
| 17 | Remove "No notable signals" card and unlabelled histograms (clarity) | §4.6 (card hidden when empty) | cpu-only screenshot |
| 18 | Virtualize code rows (clarity, eng) | §4.8.10, §6.1 | DOM count < 8 k on huge |
| 19 | Flame % axis + denominator note; dark native contrast (clarity) | §4.11.4, §3.4 | Visual |
| 20 | Binary units; % sign on every percentage cell (clarity, eng) | §4.0.2 | Formatter tests |
| 21 | `% of all allocations` = `n_usage_fraction` (eng) | §4.0.3, §4.8.4 | ml-training train.py:120 = 33.0 % |
| 22 | Skip link visible on focus (eng) | §6.2.2 | Keyboard test |
| 23 | AI drawer is a real modal (role=dialog, aria-modal, `inert` background, Esc, focus return) (eng) | §4.14.4 | Tab-cycle test (40 Tabs stay inside) |
| 24 | Valid table semantics, `aria-sort`, row `aria-label` (eng) | §4.8.11 | axe + manual |
| 25 | Every keyboard-navigable canvas announces the focused item (eng) | §6.2.5 | Screen-reader text in live region |
| 26 | One encoding per quantity: hatch for system ≠ waiting; flame frames ≥ 3:1 at every width (eng) | §3.4 | Visual + tokens |
| 27 | Absent field never shown as a measured 0 (eng) | §4.0.1 `caps` | example.json: no "Core utilization 0 %" |
| 28 | Event-loop line never presented as the hotspot without saying it is waiting (eng) | §4.2.3, §4.5.4 | async-server headline + hotspot badge |
| 29 | Reduced motion: no transform/position animation; ≤ 150 ms opacity; final values immediately (eng) | §5.4 | Reduced-motion test at 40 ms |
| 30 | DOM bounded (< 8 k nodes), hover/theme < 100 ms, no long task > 200 ms after load (eng) | §6.1 | Perf test on huge.json |
| 31 | Compact/iframe readouts keep a short denominator (eng) | §4.3.5 | 1000×400 screenshot |
| 32 | Hotspot list = one Tab stop with arrow roving; targets ≥ 24 px (eng) | §4.5.6, §6.2 | Keyboard test |

---

## 2. Information architecture and page layout

### 2.1 Page anatomy (DOM order = reading order = focus order)

```
<html lang="en" data-theme?="light|dark" class="motion-ok|motion-reduce bp-<name> [short]">
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <a class="skip-link" href="#code">Skip to code</a>
  <header class="appbar" role="banner">           §4.1  sticky
  <main id="main" tabindex="-1">
    <section id="overview"  aria-labelledby="overview-h">   §4.2–4.6
        h2.visually-hidden "Overview"
        .hero        (headline + meta | readouts)
        .instrument  (scope | hotspots)
        .findings
    <section id="code"      aria-labelledby="code-h">       §4.7–4.10
    <section id="stacks" class="combined-stacks-section" aria-labelledby="stacks-h">  §4.11 (CPU | Memory tabs)
    <section id="timeline"  aria-labelledby="timeline-h">   §4.12
    <section id="memory"    aria-labelledby="memory-h">     §4.13
  </main>
  <footer class="site-footer" role="contentinfo">           §4.17
  <div id="layer-root">  tooltip, toasts, drawer, palette, file sheet, drop overlay, sr-announcer
```

Section presence (a section that is absent also drops out of the nav, the palette and the
shortcuts):

| Section | Present when |
|---|---|
| Overview | profile has `files` with ≥ 1 entry |
| Code | always with Overview |
| Stacks | `combined_stacks.length > 0` **or** (`memory_stacks.length > 0` and Σ mb > 0) |
| Timeline | `combined_stacks_timeline.length > 0` **and** `combined_stacks.length > 0` |
| Memory | `memory === true` and `max_footprint_mb > 0` |
| Empty state (§4.16) | profile is `""`, `{}`, not an object, or has no `files` entries |

The order (overview → code → stacks → timeline → memory) follows the questions in sequence: the
answer, then which lines, then why (callers), then when (ordering, threads), then memory narrative.

### 2.2 Breakpoints, grid, spacing

| Name | Viewport width | Page gutter | Grid | Column gap | Card padding |
|---|---|---|---|---|---|
| `xs` | < 600 (ref. 390; min 320) | 16 | 4 cols | 12 | 12 / 16 (inner tiles) |
| `sm` | 600 – 1023 | 20 | 8 cols | 16 | 16 |
| `md` | 1024 – 1279 | 24 | 12 cols | 16 | 16 / 20 |
| `lg` | 1280 – 1599 (ref. 1440) | 32 | 12 cols | 16 | 20 / 24 |
| `xl` | 1600 – 2199 (ref. 1920) | 32 | 12 cols | 20 | 20 / 24 |
| `xxl` | ≥ 2200 (ref. 2560) | 40 | 12 cols | 24 | 24 |
| `short` | height ≤ 520 (any width; ref. Jupyter 1000×400) | as width | as width | 12 | 12 / 16 |

- Content max width: **2360 px** at `xxl` (centered), otherwise `100vw − 2 × gutter`.
- Spacing scale (4 px grid): `4 8 12 16 20 24 32 40 48 64`. Tokens `--sp-1 … --sp-10` (§3).
- Section rhythm: 48 px between sections (`lg+`), 32 (`md`, `sm`), 24 (`xs`, `short`). Section
  header = `h2` 18/24 600 + one-line description 13/18 `--fg-2`, 40 px tall, 12 px below it.
- Cards: radius 12, 1 px `--line` border, `--surface` fill, `--shadow-card`.
- `bp-*` and `short` classes are set on `<html>` by `core/layout.ts` from `matchMedia` (one source
  of truth for JS and CSS; CSS also uses the same media queries).
- **No horizontal page scroll at any width ≥ 320.** `html, body { overflow-x: clip }` is a safety net
  only. Components MUST fit: wide content (code lines, tab strips, flame) scrolls or clips **inside its
  own container** (`overflow-x: auto` on that container, never on the page). CI checks
  `document.documentElement.scrollWidth === clientWidth` at 320, 360, 390, 600, 1024, 1440, 2560 with
  `isMobile` emulation at the phone sizes (§6.2.9).
- Sticky chrome stack (top offsets): app bar `--appbar-h` (52 `md+`, 48 `xs/sm`, 40 `short`) →
  section-local sticky bars (code file bar 40, code column header 32; `short`: file bar not sticky).
  `html { scroll-padding-top: calc(var(--appbar-h) + 12px) }`.

### 2.3 Overview wireframes (first screen)

All heights are targets at the reference viewport, in px. `▓` = data marks, `·` = hairline.

**`lg` 1440 × 900** (content width 1376; first screen shows headline, readouts, signal and all 8
hotspots; findings start at y ≈ 722)

```
y=0   ┌ APP BAR 52 ───────────────────────────────────────────────────────────────────────────────┐
      │ ▲ Scalene │ train.py --config configs/gpt-small.json …  Overview Code Stacks Timeline Memory │
      │                                                   [⌕ Search  ⌘K] [✦ AI •] [⤒] [☾]        │
y=68  ┌ HERO CARD ─────────────────────────────────────────────────────────────────────────────────┐
      │ train.py ran for 54.1 s. Two lines in [train()] account for 37.6% of the time;              │ 22/30
      │ memory peaked at 3.11 GiB.                                                                  │
      │ Profiled Oct 27, 2026, 14:22 · 6 files · 5 threads · GPU · 10 ms sampling · Scalene 2.4.0   │ 12.5/18
      ├·····························┬························┬··················┬···················┤ y≈158
      │ • WHERE THE TIME WENT       │ • PEAK MEMORY          │ • GPU            │ • POSSIBLE LEAKS  │
      │ 11.6%   61.9%   26.1%       │ 3.11 GiB               │ 66.9%            │ 2                 │ 30/36
      │ ■Python ■native ▨system     │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │ ▓▓▓▓▓▓▓▓▓▓░░░░░  │ ↗ metrics.py:42   │
      │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▨▨▨▨▨▨  │ at 52.9 s · train.py:120│ mean while main  │   5.71 MiB/s      │
      │ share of run · 0.4% outside │ growth 52.2% · +212 MiB│ thread ran ·     │ ↗ loader.py:33    │
      │ profiled files              │ native threads         │ peak 8.62 GiB    │   288 KiB/s       │
y=298 └─────────────────────────────┴────────────────────────┴──────────────────┴───────────────────┘
      readout grid: 1.6fr 1fr 1fr 1fr
y=314 ┌ INSTRUMENT CARD ───────────────────────────────────────────┬────────────────────────────────┐
      │ SIGNAL  the run over time            ■mem ■busy ▨waiting   │ HOTSPOTS  [Lines|Functions|Files]│
      │ PHASE   │▨│  model = GPT(…)  │      for step in range(cfg…│ [Time|Memory|GPU]   by % of run │
      │ MEMORY  │            ╭─peak 3.11 GiB · 52.9 s ─╮      3 GiB│ 1 ▓▓▓▓▓▓▓▨▨▨▨ 21.4% loss_value… │
      │ footprnt│ ________/‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾\   1 GiB│ 2 ▓▓▓▓▓▓▓▓    16.2% scaler.sca… │
      │ rug     │ ' ''  '   '  '   '  '                       │ 3 ▓▓▨          4.9% torch.save… │
      │ THREADS │ ▁▃▅▅▅▅▆▅▅▅▅▆▅▅▅▅▅▅▅▆▅▅▅▅▅▅▅▅▅▅▅▅▅▅▅▅▅▅▅▅  4   │ 4 ▓▓           4.5% import tor… │
      │ busy    │                                             0   │ 5 ▓▓           3.6% model = mo… │
      │ WHEN #1 │        ▂▃▃▂▃▃▂▃▂▃▃▂▃▂▃▂▃▃▂▃▂▃▃▂▃▂▃▂▃▂          │ 6 ▓            2.9% chunk = se… │
      │ TOP  #2 │        ▂▂▃▂▂▃▂▂▃▂▂▂▃▂▂▃▂▂▃▂▂▂▃▂▂▃▂▂▂▃          │ 7 ▓            2.6% grad_norm … │
      │ LINES#3 │   ▁                    ▁                  ▃▅   │ 8 ▓            2.4% accuracy =… │
      │ RAN  #4 │ ▅▃                                             │ Top 8 lines = 58.4% of run time │
      │      #5 │     ▂▅▃                                        │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░ · 100 more ›  │
      │         0      10 s     20 s     30 s     40 s     50 s    │                                │
y=706 └────────────────────────────────────────────────────────────┴────────────────────────────────┘
      columns: scope span 7 (≈ 795) | hotspots span 5 (≈ 565)
y=722 ┌ FINDING ───────────────┐ ┌ FINDING ───────────────┐ ┌ FINDING ───────────────┐  3 × span 4
      │ ⟳ The host waits on…   │ │ ↗ Possible leak at…    │ │ ▲ Memory peaks at…     │
```

**`xxl` 2560 × 1440** (content 2360; headline and readouts share one card row; findings are a third
column next to the hotspots; the code section starts on the first screen at y ≈ 720; round 1: the
instrument is split 3fr / 2fr and the hotspot rows flex from 36 to 44 px to take the spare height)

```
┌ APP BAR 52 ──────────────────────────────────────────────────────────────────────────────────────┐
┌ HERO (one row, 160) ─────────────────────────────┬──────────────────────────────────────────────┐
│ headline 26/34, max 3 lines (span 5)             │ readouts: 4 tiles (span 7), values 34/40      │
│ meta line                                        │                                               │
└──────────────────────────────────────────────────┴──────────────────────────────────────────────┘
┌ INSTRUMENT (440) ───────────────────────────────────────────┬──────────────────┬───────────────┐
│ scope span 7 (≈1360): MEMORY 132, THREADS 52, TOP 5×14      │ hotspots span 3  │ findings span 2│
│                                                             │ (≈570), 8 rows   │ 3 stacked cards│
└─────────────────────────────────────────────────────────────┴──────────────────┴───────────────┘
┌ CODE SECTION ────────────────────────────────────────────────────────────────────────────────────┐
│ rail 280 │ file bar / column header / rows (≈1530)                       │ribbon│ dock 420        │
```

**`md` 1024 × 768** (stacked instrument; 5 hotspot rows visible)

```
APP BAR 52  (nav collapses into a "Sections ▾" menu button; search shows icon + ⌘K chip)
HERO: headline 20/28 (≤ 2 lines) + meta (1 line, overflow → wraps)         ≈ 120
READOUTS: 4 tiles in one row, value 24/30, caption 1 line                   ≈ 104
INSTRUMENT card: scope full width 220 (PHASE, MEMORY 80, THREADS 32, TOP 5×10)
                 hotspots below: header 44 + rows of 36                     rows start ≈ 590
FINDINGS: 2 columns, then 1
```

**`sm` 600 – 1023**: like `md`, readouts 2 × 2 (time split spans 2 columns on the first row),
hotspot rows two-line (56 px: bar + value on line 1, code + location on line 2).

**`xs` 390 × 844** (DOM order is changed for this layout, §2.4.5; first screen: headline, time split,
top 3 hotspots)

```
y=0    APP BAR 48: ▲ train.py ……………… [⌕] [✦] [⋯]   (⋯ = Load, Theme, Sections, Reduce motion)
y=60   HERO: headline 18/26 (≤ 4 lines), meta 12/16 (≤ 2 lines)              ≈ 170
y=230  READOUT 1 full width: WHERE THE TIME WENT (values 24/30 + bar + caption) ≈ 112
y=354  HOTSPOTS card: header (tabs collapse to a select) + 3 two-line rows (56) + "Show all 8"  ≈ 260
y=626  READOUTS 2–4: 2-column grid (Peak memory | GPU), (Possible leaks | Elapsed)  ≈ 200
y=838  SCOPE card 236 (labels inline above each channel; ticks inside, collision-checked)
       FINDINGS (1 column)
```

**`short` 1000 × 400** (Jupyter iframe; the whole answer fits in 400 px)

```
y=0    APP BAR 40 (sticky): ▲ train.py … [⌕][✦][⤒][☾]   (no nav)
y=48   HEADLINE 16/22, 1 line if it fits, else 2; meta hidden (available in program tooltip)  ≈ 40
y=96   READOUTS one row, 4 tiles × 64: label + value 20/24 + short denominator (11/14)
y=168  INSTRUMENT side by side if width ≥ 900: scope 55 % (MEMORY + THREADS, 200 tall, gutter 72)
       | hotspots 45 % (5 rows × 32, compact columns)                         → ends y ≈ 380
       stacked if width < 900: scope 150, then hotspots
```

**Code section, `lg` 1440** (sticky chrome = app bar 52 + file bar 40 + column header 32; lens inline)

```
CODE  6 files · bars scaled to the hottest line (21.4% of run)
[Lines|Functions]  [Profiled functions|Hot lines|All lines]  [↵ Wrap]                 (toolbar, 32)
[train.py 58.8% ▬]  [transformer.py 18.8%]  [adamw.py 7.7%]  [loader.py 6.3%] … [All files ▾] (tabs, 40)
┌ FILE BAR (sticky) /home/dev/llm-train/ train.py · ▓▓▓▨ 58.8% of run · 31.8 s of 54.1 s · peak 1.20 GiB · 2 leaks ┐
│ #   TIME        MEMORY       GPU        FOOTPRINT   COPY    SOURCE · train.py                         │ ribbon │
│     % of run    peak         % busy     when alloc. MiB/s                                             │  56    │
│ ƒ train()  ▓▓▓▓▓▓▓▓  47.1% of run · 25.5 s · peak 2.01 MiB · GPU 81.8%                 (fnHeader 32)  │ ▁▁▃    │
│ 165 ▓▓▓▓▓▓▓ 16.2%               ▓▓▓▓ 95.5%                      scaler.scale(loss).backward()        │ ▂▅█ ②  │
│ 173 ▓▓▨▨▨▨▨ 21.4%               ▓▓▓▓ 96.4%                      loss_value = loss.item()   [✦ Optimize][⋯] ① │
│ ┌ LENS train.py:173 in train() · region 152–184     [Open in editor][Show in stacks][Show in timeline][×] ┐ │
│ │ TIME 21.4% of run · 11.6 s     │ MEMORY                         │ CALL CONTEXT                      │ │
│ │ ▓▓▨▨▨▨▨▨ Python 0.1% …         │ No allocations sampled         │ In 1,157 of 5,901 stack samples   │ │
│ │ WHEN IT RAN ▁▂▃▃▂▃▂▃▃▂▃▂ 0–54.1 s│ GPU 96.4% busy while it ran    │ calls into … / called from …      │ │
│ │ [✦ Optimize line] [✦ Optimize region 152–184]        Anthropic · claude-sonnet-4-5 · [AI settings] │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ⋯ 2 lines without samples · 122–123                                                       (fold 24)  │
```
Rows are 24 px. At `xl` the lens is replaced by the docked inspector (380 px column on the right).

**Timeline, `lg`** (gutter 168)

```
TIMELINE 4,933 sample runs over 54.1 s · 5 threads        [Lanes|Interleaved] [All threads ▾] [−][+][Reset] 0 s – 54.1 s
           │0        10 s       20 s       30 s       40 s       50 s        (timeline-axis, 24)
Memory     │_____/‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾/\     (56)
GC  0.6%   │ ||| |||                                                    |    (12)
I/O 2.8%   │    ▨  ▨▨                                              ▨▨▨▨▨▨    (12)
GIL 0.9%   │      |     | | |   |  ||    |  | | |  |    |   |  |  |           (12)
▾ main 91.3%│<module>████████████████████████████████████████████████████    (header 20 + 12/depth)
           │  train ███████████████████████████████████████████████████
           │    GPT.__init__ ██  …
▸ thread 1 1.1% │   ▂     ▂▂        ▂▂        ▂▂                              (collapsed 16)
```

### 2.4 Layout rules per component and breakpoint

#### 2.4.1 App bar (§4.1)
| | `xs` | `sm` | `md` | `lg` | `xl`/`xxl` | `short` |
|---|---|---|---|---|---|---|
| Height | 48 | 48 | 52 | 52 | 52 | 40 |
| Logo | mark only | mark + "Scalene" | mark + "Scalene" | same | same | mark |
| Program + args | basename, ellipsis | basename + args (mono, middle-ellipsis) | same | same | same | basename |
| Section nav | in ⋯ menu | "Sections ▾" | "Sections ▾" | inline tabs + scroll-spy | inline | in ⋯ |
| Search | icon | icon + ⌘K chip | field 200 | field 220 | field 260 | icon |
| AI / Load / Theme | AI icon; Load + Theme in ⋯ | icons | icons | AI with label, icons | AI, "Load" label, icon | icons |

#### 2.4.2 Overview
| | `xs` | `sm` | `md` | `lg` | `xl` | `xxl` | `short` |
|---|---|---|---|---|---|---|---|
| Headline font | 18/26 | 20/28 | 20/28 | 22/30 | 24/32 | 26/34 | 16/22 |
| Hero layout | stacked | stacked | stacked | stacked | stacked | headline ‖ readouts | stacked, meta hidden |
| Readouts | 1 + (2×2) after hotspots | 2 × 2 | 1 × 4 | 1 × 4 | 1 × 4 | 1 × 4 (in hero) | 1 × 4 compact |
| Readout value | 24/30 | 26/32 | 24/30 | 30/36 | 32/38 | 34/40 | 20/24 |
| Instrument | stacked, hotspots first | stacked | stacked | side by side 7 / 5 | side by side 7 / 5 | 7 / 3 + findings 2 | side by side ≥ 900 |
| Scope height | 236 | 220 | 220 | stretch to hotspots (≈ 330) | ≈ 360 | ≈ 400 | 200 (150 stacked) |
| Hotspot rows | 3 + "Show all" | 8 | 8 | 8 | 8 | 8 | 5 |
| Hotspot row | 2-line 56 | 2-line 56 | 1-line 36 | 1-line 36 | 1-line 36 | 1-line 36 | 1-line 32 |
| Findings | 1 col | 2 cols | 2 cols | 3 cols row | 3 cols row | stacked column | 1 row, max 2 |

#### 2.4.3 Code section (§4.7–4.10)
| | `xs` | `sm` | `md` | `lg` | `xl` | `xxl` | `short` |
|---|---|---|---|---|---|---|---|
| File navigation | switcher button → sheet | switcher | tabs | tabs | tabs | rail 280 | switcher |
| Minimap ribbon | – | – | 48 | 56 | 56 | 56 | – |
| Detail panel | lens, 1 col | lens, 2 cols | lens, 3 cols | lens, 3 cols | dock 380 | dock 420 | lens, 2 cols |
| Row height | 28 (coarse) | 28 (coarse) / 24 | 24 | 24 | 24 | 24 | 24 |
| Code font | 12/28 | 12.5 | 13 | 13 | 13 | 13.5 | 12.5 |
| Metric columns | Time (value + 24 px bar) | by width (§4.8.3) | by width | by width | by width | all | by width |

#### 2.4.4 Stacks, Timeline, Memory
| | `xs` | `sm` | `md`+ | `short` |
|---|---|---|---|---|
| Flame row height | 22 (touch) | 20 | 20 | 18 |
| Flame toolbar | search full width; mode in ⋯ | inline | inline | inline, compact |
| Timeline gutter | labels above lanes (no gutter) | 120 | 168 | 120 |
| Timeline default lanes | main expanded (8 rows), workers collapsed | same | main 16 rows | main 6 rows |
| Memory section | stats 2-col, chart 180, sites list below | chart 200 | chart 240 + sites side by side (`lg+`: 8 / 4 cols) | chart 160 |

#### 2.4.5 Phone order (xs only)
`core/layout.ts` emits `layout:changed` when crossing the `xs` boundary. The Overview view then
**moves** (does not re-create) its nodes into this order: headline → readout "Where the time went" →
hotspots → readouts 2–4 → scope → findings. Focus and state are kept. Above `xs` the order is
headline → readouts → instrument (scope, hotspots) → findings. DOM order always equals visual order.

### 2.5 Hosts

| Host | Specifics |
|---|---|
| Browser via `scalene view` (`http://localhost:11235+`) | Heartbeat every 10 s; `/env-api-keys.json` fetched once (§7). |
| `file://` (`--html`, `--standalone`) | No network calls at all on load. Everything inline. |
| Jupyter (`IFrame(height=400)`) | `short` layout. The app bar stays sticky (40). Sections are normal flow; no `100vh` heights anywhere (iframes make `vh` = 400). |
| VS Code webview | `acquireVsCodeApi()` called **once**, cached. Theme: if no stored choice, follow `body.vscode-dark` / `body.vscode-light` / `body.vscode-high-contrast` (high contrast → dark tokens + `--line` = `--fg-3`). Line navigation posts `jumpToLine` (§7.4). In-app "Reduce motion" toggle, because webviews may not pass the OS setting. |
| Phone browsers | `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`; `env(safe-area-inset-*)` padding on the app bar and footer. |

---

## 3. Design tokens

### 3.1 Rules

- **Light is the `:root` default; dark is `:root[data-theme="dark"]`.** The resolved theme (stored
  choice → VS Code body class → `prefers-color-scheme`) is written to `<html data-theme>` before first
  paint, so there is exactly one dark block. The aesthetic is tuned dark-first (glow, phosphor sweep);
  light is tuned separately, not inverted.
- Chrome uses only neutrals. Data uses only data tokens. Interactive state uses ink (`--fg`) for focus
  and selection bars, never a data hue.
- **Canvas reads tokens** through `theme.tokens()` (§8.2), which caches `getComputedStyle` values per
  theme and invalidates them on `theme:changed`. Canvas code never hard-codes colours.
- Text in a data colour is allowed only where §3.7 shows ≥ 4.5:1 (dark theme mostly). In light theme,
  put a swatch chip next to `--fg` text instead.
- Hatch patterns: **system time** = `--cpu-sys` fill with `--surface` 45° lines (55 % alpha, 4 px
  period). **Waiting** (I/O & waits, `[await]`) = `--async` at 35 % with `--async` 135° lines (5 px
  period). These are two different encodings for two different quantities. Canvas uses cached 8×8
  `CanvasPattern`s per theme (`canvas.ts: hatch(kind)`).

### 3.2 Token block (paste as `src/styles/00-tokens.css`)

```css
/* 00-tokens.css — Scalene UI design tokens (DESIGN.md §3). Do not use raw colours elsewhere. */
:root {
  color-scheme: light;

  /* ── Surfaces & ink ─────────────────────────────────────────────── */
  --page: #F4F5F7;
  --surface: #FFFFFF;
  --raised: #FFFFFF;            /* popovers, drawer, lens (with shadow) */
  --raised-2: #F6F7F9;          /* zebra / inner wells on raised */
  --sunken: #F0F2F5;            /* tracks, empty meters, chart wells, code chips */
  --line: #E4E7EC;              /* decorative hairline (no contrast requirement) */
  --line-strong: #CDD2DA;
  --control: #878E9B;           /* boundaries that identify a control: 3.30:1 on surface */
  --grid: rgb(14 17 22 / 0.06);
  --grid-strong: rgb(14 17 22 / 0.12);
  --fg: #0E1116;                /* 18.9:1 on surface */
  --fg-2: #454D5C;              /* 8.5:1 */
  --fg-3: #5E6676;              /* 5.8:1 surface, 5.1:1 sunken: captions, units, line numbers */
  --on-strong: #FFFFFF;         /* text on strong data fills */
  --hover: rgb(14 17 22 / 0.035);
  --select: #EDF3FC;            /* selected row background */
  --select-bar: #0E1116;        /* 2 px inset bar on selected row */
  --focus: #0E1116;             /* focus ring, 2 px + 2 px offset */
  --flash: #FFF1B8;             /* jump-to-line highlighter (transient, not data) */
  --glass: rgb(255 255 255 / 0.88);
  --glass-line: rgb(14 17 22 / 0.08);
  --scrim: rgb(14 17 22 / 0.32);
  --glow: 0;                    /* 1 in dark: canvas shadowBlur multiplier */

  /* ── Data: one hue per resource, lightness = origin ─────────────── */
  --cpu-py: #044CB6;            /* Python time            7.74:1 */
  --cpu-native: #1385BD;        /* native time            4.10:1 */
  --cpu-sys: #8C8F94;           /* system time + 45° hatch 3.24:1 */
  --mem-py: #007137;            /* Python memory          6.15:1 */
  --mem-native: #579C50;        /* native memory          3.35:1 */
  --copy: #C67600;              /* copy volume            3.50:1 */
  --gpu: #8031C0;               /* GPU util / Neuron NC   6.73:1 */
  --gpu-mem: #A777CA;           /* GPU memory / Neuron NRT 3.42:1 */
  --async: #007E84;             /* await, I/O & waits (+135° hatch) 4.86:1 */
  --gil: #C64080;               /* GIL contention         4.72:1 */
  --gc: #4F5766;                /* garbage collection lane 7.27:1 (neutral: GC is housekeeping) */
  --danger: #C92324;            /* leaks, errors          5.60:1 (also as text) */
  --danger-wash: #FDECEC;       /* leak badge background; danger text on it 4.90:1 */

  /* ── Row heat washes (max strength; JS sets --heat 0..1 on the row) */
  --wash-cpu: #E0ECFF;
  --wash-mem: #DCF2DF;
  --wash-gpu: #F0E6FB;
  --wash-await: #DDF2F2;

  /* ── Stack frames (flame + timeline), "Kind" colour mode ─────────── */
  --frame-py: #2F5FB3;          --frame-py-ink: #FFFFFF;        /* label 6.16:1 */
  --frame-native: #93CDE0;      --frame-native-ink: #0E1116;    /* label 10.85:1; py:native 3.53:1 */
  --frame-await: #CDECEC;       --frame-await-ink: #0E1116;     /* + hatch in --async */
  --frame-unresolved: #E3E5E9;  --frame-unresolved-ink: #454D5C;
  --frame-root: #DADDE3;        --frame-root-ink: #0E1116;
  --frame-lod: #7D8BA3;         /* "busy" band for sub-pixel runs 3.45:1 */
  --frame-dim: 0.78;            /* search non-match: mix 78 % toward --surface (oklab) */

  /* ── Sequential ramps ("Self" colour mode, minimap heat) ─────────── */
  --cpu-ramp-0: #EDF4FE; --cpu-ramp-1: #BFD3F2; --cpu-ramp-2: #91B3E4;
  --cpu-ramp-3: #6492D6; --cpu-ramp-4: #3671C7; --cpu-ramp-5: #0050AF;
  --cpu-ramp-ink-split: 4;      /* steps < 4 use --fg, steps ≥ 4 use #FFFFFF */
  --mem-ramp-0: #EBF8EC; --mem-ramp-1: #C1DCC5; --mem-ramp-2: #98C19F;
  --mem-ramp-3: #6FA67A; --mem-ramp-4: #458B56; --mem-ramp-5: #067132;
  --mem-ramp-ink-split: 5;

  /* ── "File" colour mode: 8 low-chroma tints, label --fg ──────────── */
  --file-0: #C8D6E4; --file-1: #C8E4E0; --file-2: #C8E4CD; --file-3: #D6E4C8;
  --file-4: #E4DBC8; --file-5: #E4CDC8; --file-6: #E4C8D6; --file-7: #D6C8E4;

  /* ── Threads (Interleaved timeline only; lanes use position) ─────── */
  --thread-0: #0072B2; --thread-1: #C35400; --thread-2: #00866A;
  --thread-3: #A86F00; --thread-4: #B5568F; --thread-other: #8C8F94;

  /* ── Neuron "device idle" bands: shape + colour (never colour alone) */
  --band-low: var(--fg-3);      /* ● < 30 % idle */
  --band-mid: var(--fg-2);      /* ◆ 30–60 % */
  --band-high: var(--danger);   /* ▲ ≥ 60 % */

  /* ── Syntax (calm, low chroma, away from data hues) ──────────────── */
  --syn-text: #1F2430;          /* 15.5 surface / 12.9 max wash */
  --syn-kw: #0E1116;            /* weight 600 */
  --syn-str: #75523A;           /* 6.9 / 5.8 */
  --syn-num: #7A4848;           /* 7.4 / 6.1 */
  --syn-com: #5E6676;           /* italic; comments + docstrings 5.8 / 4.8 */
  --syn-builtin: #454D5C;       /* builtins, decorators 8.5 / 7.1 */

  /* ── Type ────────────────────────────────────────────────────────── */
  --font-ui: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto,
    "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif;
  /* Ligature-free faces only: never add "Cascadia Code", "JetBrains Mono", "Fira Code". */
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", Menlo, Consolas,
    "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", monospace;
  --type-micro: 600 11px/14px var(--font-ui);     --ls-micro: 0.06em;  /* uppercase */
  --type-caption: 400 12px/16px var(--font-ui);
  --type-caption-mono: 400 12px/16px var(--font-mono);
  --type-body: 400 14px/20px var(--font-ui);
  --type-body-strong: 600 14px/20px var(--font-ui);
  --type-code: 400 13px/24px var(--font-mono);
  --type-title: 600 15px/22px var(--font-ui);     /* card titles */
  --type-section: 600 18px/24px var(--font-ui);   /* h2 */
  --type-headline: 500 22px/30px var(--font-ui);  /* key numbers inside: 600 */
  --type-readout: 600 30px/36px var(--font-ui);   --ls-readout: -0.02em;
  --type-readout-unit: 500 15px/20px var(--font-ui);

  /* ── Spacing (4 px grid) ─────────────────────────────────────────── */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px;
  --sp-6: 24px; --sp-7: 32px; --sp-8: 40px; --sp-9: 48px; --sp-10: 64px;

  /* ── Radii ───────────────────────────────────────────────────────── */
  --r-xs: 3px;   /* meters, bar ends */
  --r-sm: 6px;   /* buttons, inputs, chips, segmented thumbs */
  --r-md: 8px;   /* tooltips, menus */
  --r-lg: 12px;  /* cards, lens */
  --r-xl: 16px;  /* drawer edge, sheets, palette */
  --r-pill: 999px;

  /* ── Elevation (one shadow per layer kind) ───────────────────────── */
  --shadow-card: 0 1px 2px rgb(15 18 25 / 0.04);
  --shadow-float: 0 12px 40px rgb(15 18 25 / 0.14), 0 1px 2px rgb(15 18 25 / 0.08),
    0 0 0 1px rgb(14 17 22 / 0.06);
  --shadow-drawer: -24px 0 64px rgb(15 18 25 / 0.18), 0 0 0 1px rgb(14 17 22 / 0.06);

  /* ── Z-index scale ───────────────────────────────────────────────── */
  --z-sticky: 10; --z-code-head: 20; --z-appbar: 30; --z-menu: 50; --z-tooltip: 60;
  --z-scrim: 70; --z-drawer: 71; --z-palette: 80; --z-toast: 90; --z-drop: 95; --z-skip: 100;

  /* ── Motion ──────────────────────────────────────────────────────── */
  --dur-0: 0ms;      /* hover, crosshair, linked highlight, keyboard moves, palette */
  --dur-1: 90ms;     /* press feedback, tooltip out, chip select */
  --dur-2: 140ms;    /* tooltip in, small fades */
  --dur-3: 200ms;    /* disclosure, segmented thumb, lens open, tab cross-fade */
  --dur-4: 280ms;    /* FLIP re-rank, flame/timeline zoom, drawer */
  --dur-5: 420ms;    /* first-load bar growth */
  --dur-count: 600ms;  /* first-load count-up (hero totals only) */
  --dur-sweep: 640ms;  /* first-load scope sweep */
  --dur-flash: 1200ms; /* jump highlighter fade */
  --stagger: 30ms;     /* rank stagger, cap 8 items */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-productive: cubic-bezier(0.2, 0, 0.38, 0.9);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);          /* exits only */

  /* ── Layout ──────────────────────────────────────────────────────── */
  --gutter: 32px;
  --maxw: 2360px;
  --appbar-h: 52px;
  --row-h: 24px;
  --file-bar-h: 40px;
  --col-head-h: 32px;
}

/* Dark ("Instrument"). The resolved theme is ALWAYS written to <html data-theme> before first
   paint (template head script, §7.1; core/theme.ts re-asserts it at boot for foreign hosts), so one
   attribute selector is the single source of dark tokens. */
:root[data-theme="dark"] {
    color-scheme: dark;
    --page: #07090D; --surface: #0C0F14; --raised: #12161D; --raised-2: #181D26; --sunken: #06080B;
    --line: #1A1F28; --line-strong: #2A313D; --control: #6B7384;
    --grid: rgb(255 255 255 / 0.055); --grid-strong: rgb(255 255 255 / 0.10);
    --fg: #E8ECF2; --fg-2: #A3ADBC; --fg-3: #7F8999; --on-strong: #07090D;
    --hover: rgb(255 255 255 / 0.035); --select: #162131; --select-bar: #E8ECF2; --focus: #E8ECF2;
    --flash: #2B2616; --glass: rgb(18 22 29 / 0.82); --glass-line: rgb(255 255 255 / 0.08);
    --scrim: rgb(0 0 0 / 0.55); --glow: 1;
    --cpu-py: #79B4FF; --cpu-native: #378EC8; --cpu-sys: #6B7079;
    --mem-py: #62D286; --mem-native: #549957; --copy: #F6B84D;
    --gpu: #C190F6; --gpu-mem: #8E62BC; --async: #56D3D7; --gil: #F075AA; --gc: #B4BDCB;
    --danger: #FA6863; --danger-wash: #3A1615;
    --wash-cpu: #1B293F; --wash-mem: #172F1D; --wash-gpu: #2A2140; --wash-await: #13302F;
    --frame-py: #9BC1F3; --frame-py-ink: #07090D;
    --frame-native: #286A8A; --frame-native-ink: #E8ECF2;
    --frame-await: #173B3D; --frame-await-ink: #E8ECF2;
    --frame-unresolved: #262B33; --frame-unresolved-ink: #A3ADBC;
    --frame-root: #1C222C; --frame-root-ink: #E8ECF2;
    --frame-lod: #52627F; --frame-dim: 0.80;
    --cpu-ramp-0: #15202D; --cpu-ramp-1: #2A3C54; --cpu-ramp-2: #3F5B7E;
    --cpu-ramp-3: #577BAA; --cpu-ramp-4: #6F9DD9; --cpu-ramp-5: #91C1FF; --cpu-ramp-ink-split: 3;
    --mem-ramp-0: #142318; --mem-ramp-1: #25442E; --mem-ramp-2: #376845;
    --mem-ramp-3: #498E5E; --mem-ramp-4: #5CB678; --mem-ramp-5: #70E093; --mem-ramp-ink-split: 3;
    --file-0: #2E4256; --file-1: #2E5650; --file-2: #2E5635; --file-3: #42562E;
    --file-4: #56492E; --file-5: #56352E; --file-6: #562E42; --file-7: #422E56;
    --thread-0: #3D8FD1; --thread-1: #E0702B; --thread-2: #1FA383;
    --thread-3: #B8842A; --thread-4: #C06EA0; --thread-other: #696C71;
    --syn-text: #D5D9E2; --syn-kw: #F2F4F8; --syn-str: #DBB597; --syn-num: #E8ACAB;
    --syn-com: #8C94A4; --syn-builtin: #AAB1BF;
    --shadow-card: inset 0 1px 0 rgb(255 255 255 / 0.025);
    --shadow-float: 0 16px 48px rgb(0 0 0 / 0.55), 0 0 0 1px rgb(255 255 255 / 0.06);
    --shadow-drawer: -24px 0 64px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(255 255 255 / 0.06);
}

/* Ramps: label colour per step = ramp index < --*-ramp-ink-split ? --fg : --on-strong-ramp,
   where the light theme uses #FFFFFF and the dark theme uses #07090D for steps at/after the split
   (light ramps get darker → white labels; dark ramps get lighter → ink labels). */

/* ── Responsive token overrides ─────────────────────────────────────── */
@media (max-width: 599.98px) {
  :root { --gutter: 16px; --appbar-h: 48px;
    --type-headline: 500 18px/26px var(--font-ui); --type-readout: 600 24px/30px var(--font-ui); }
}
@media (min-width: 600px) and (max-width: 1023.98px) {
  :root { --gutter: 20px; --appbar-h: 48px;
    --type-headline: 500 20px/28px var(--font-ui); --type-readout: 600 26px/32px var(--font-ui); }
}
@media (min-width: 1024px) and (max-width: 1279.98px) {
  :root { --gutter: 24px; --type-headline: 500 20px/28px var(--font-ui);
    --type-readout: 600 24px/30px var(--font-ui); }
}
@media (min-width: 1600px) { :root { --type-headline: 500 24px/32px var(--font-ui);
    --type-readout: 600 32px/38px var(--font-ui); } }
@media (min-width: 2200px) { :root { --gutter: 40px; --type-headline: 500 26px/34px var(--font-ui);
    --type-readout: 600 34px/40px var(--font-ui); --type-code: 400 13.5px/24px var(--font-mono); } }
@media (max-height: 520px) {
  :root { --appbar-h: 40px; --type-headline: 500 16px/22px var(--font-ui);
    --type-readout: 600 20px/24px var(--font-ui); --type-readout-unit: 500 12px/16px var(--font-ui); }
}
@media (pointer: coarse) { :root { --row-h: 28px; } }

/* ── Reduced motion: class set by core/motion.ts from matchMedia OR the in-app toggle ── */
:root.motion-reduce {
  --dur-1: 0ms; --dur-2: 120ms; --dur-3: 0ms; --dur-4: 0ms; --dur-5: 0ms;
  --dur-count: 0ms; --dur-sweep: 0ms; --stagger: 0ms;
  /* --dur-2 stays 120 ms for OPACITY-ONLY fades (tooltips, toasts, scrim). Nothing moves. */
}
```

Theme resolution (`core/theme.ts`, mirrored by the template head script): stored choice
(`localStorage["scalene-theme"]` = `"light"` | `"dark"`) → else VS Code body class
(`vscode-dark`/`vscode-high-contrast` → dark, `vscode-light` → light) → else
`matchMedia("(prefers-color-scheme: dark)")`. The result is written to `<html data-theme>`. When no
choice is stored, the app follows live changes of the media query and of the VS Code body class
(MutationObserver).

### 3.3 Data mark specifications (shared by DOM and canvas)

| Mark | Spec |
|---|---|
| **Meter** (DOM, inline) | Track: `--sunken`, height 6 (8 in readouts, 10 in hotspots), radius `--r-xs`. Fill segments in order Python → native → system (hatch), no gaps, `min-width: 2px` when value > 0. Optional graduations at 25/50/75 % of track: 1 px `--grid-strong`. |
| **Stacked split bar** (readout) | Height 8, full width, 3 segments + 1 px `--surface` separators between segments. Labels above with swatches. |
| **Sparkline** (code `Trend`, 64×16) | 1.25 px line `--mem-py` (`--danger` when the line has a leak), no area, max point dot (2.5 px), shared x `[0, tMax]` and y `[0, max_footprint_mb]` scales. |
| **Footprint area** (scope, timeline, memory) | Line 1.5 px `--mem-py` (dark: + `shadowBlur 8 × --glow`, `shadowColor` = token at 60 %); area = token at 14 % (light) / 18 % (dark), from y = 0. |
| **Threads-busy step-area** | Step (not smoothed) area of busy threads: `--cpu-native` at 45 % + 1.25 px top line `--cpu-py`; GIL band `--gil` 70 %; waiting band = waiting hatch. |
| **Raster / histogram strip** ("when it ran") | Bins of 2 CSS px; bar height ∝ count / row max; fill `--cpu-py` (time) or `--mem-py` (allocations); baseline 1 px `--grid-strong`. |
| **Rug** (allocation moments) | 1 px × 6 px ticks, `--mem-py` (`--danger` for a leak line), 85 % alpha. |
| **Peak marker** | 4 px radius ring, 1.5 px stroke `--mem-py`, `--surface` fill, plus callout (§4.4.7). |
| **Crosshair** | 1 px `--fg` at 45 %; time chip on the axis: `--fg` fill, `--surface` text 11 px, radius `--r-xs`. |
| **Selection brush** | Fill `--fg` 8 %, edges 1 px `--fg` 50 %. |
| **Leak badge** | `--danger-wash` pill, `--danger` icon (trend-up) + text "possible leak · 5.71 MiB/s". |

### 3.4 Stack-frame palette (flame and timeline)

| Mode | Fill | Label | Notes |
|---|---|---|---|
| **Kind** (default CPU) | Python `--frame-py`; native `--frame-native`; `[await]` `--frame-await` + waiting hatch; unresolved native `--frame-unresolved` + system-style hatch at 30 %; root `--frame-root` | `--frame-*-ink` | Python vs native ≥ 3:1 in both themes (light 3.53, dark 3.22); dark native vs surface 3.22. Narrow frames (< 6 px) keep the fill and drop the label; separation is the 1 px `--surface` gap. |
| **File** | `--file-(hash(filename_or_module) mod 8)`; native frames use the file tint of their module (`.so` path) | `--fg` | Legend lists the top 8 files by weight; others share the hash tint with a tooltip. |
| **Self** (default Memory) | ramp step = `min(5, floor(6 × self / maxSelf))` over `--cpu-ramp-*` (CPU) or `--mem-ramp-*` (Memory) | per ramp split | "darker = more self" in light; "brighter = more self" in dark. |

- Dim (search non-match / not on focused path) = fill mixed toward `--surface` by `--frame-dim`, label
  `--fg-3`.
- Highlight (search match, linked line) = 2 px `--focus` outline drawn on the overlay canvas, with a
  1 px `--surface` inner offset so it reads on every fill.
- LOD (timeline): sub-pixel runs accumulate, per device-pixel column and depth, the time each frame kind covers; the
  column takes the fill (and hatch) of the kind covering ≥ 60 % of it, a 50/50 OKLab mix of the two
  largest kinds when they cover ≥ 80 % together, else `--frame-lod` ("mixed short frames"). Touching
  columns of one colour are painted as one rect; the 1 px `--surface` gap rule for frames ≥ 3 px is
  unchanged (round 1: the old "one `--frame-lod` column per pixel" rule painted ~74 % of the
  ml-training main lane grey). Flame: frames < 0.5 px are skipped.

### 3.5 Code surfaces

```css
.code, code, kbd, .mono, .chip-code {
  font-family: var(--font-mono);
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "calt" 0, "dlig" 0;
  font-variant-numeric: tabular-nums;
  tab-size: 4;
}
```

- Canvas text: `ctx.font = "12px " + tokens.fontMono`, `ctx.fontKerning = "none"`, and
  `ctx.textRendering = "optimizeSpeed"` where the property exists. Together with the ligature-free
  stack, this renders `>=`, `->`, `==`, `!=` verbatim.
- Source text is **never** dimmed with `opacity`. Cold lines keep full syntax colours; hot lines
  get a wash behind them (§4.8.6). Docstrings and comments use `--syn-com` italic (≥ 4.8:1 even on a
  max wash).
- Keywords: weight 600 in `--syn-kw`. `def`/`class` names: weight 600 `--syn-text`. Decorators:
  `--syn-builtin`.

### 3.6 Iconography

Inline SVG only: 16 px grid, 1.5 px stroke, round caps and joins, `currentColor`, `aria-hidden="true"`
(the button carries the label). There are **no emoji anywhere** (upstream ⚡/💥 become text buttons
with the spark icon). The set lives in `core/icons.ts`:
`search, spark (AI), sun, moon, monitor (system theme), upload, chevron-right, chevron-down, x,
external (open in editor), flame, lanes, chip (memory), code, trend-up (leak), gpu, sync, peak, cpu,
copy, check, wait (hourglass), minus, plus, reset, file, fn (ƒ), eye, info, alert, menu (⋯), sort-asc,
sort-desc, fold, unfold, play (load demo), sections`.
The logo mark is a 22 px triangle whose three edges are drawn in `--cpu-py`, `--mem-py` and `--gpu`
(an echo of Scalene's logo). It is the only decorative use of data hues, and it is not data.

### 3.7 Contrast verification (computed, WCAG 2.x)

Computed with `scratchpad/final/contrast.py` (relative luminance, sRGB). WP1 MUST add
`tools/check-contrast.mjs`, which recomputes this table from `00-tokens.css` and fails CI below
the targets: text ≥ 4.5, graphics and control boundaries ≥ 3.0.

| Pair | Light | Dark | Target |
|---|---|---|---|
| `--fg` / `--fg-2` / `--fg-3` on `--surface` | 18.91 / 8.51 / 5.77 | 16.19 / 8.46 / 5.43 | 4.5 |
| `--fg-3` on `--sunken` / `--raised` | 5.15 / 5.77 | 5.67 / 5.13 | 4.5 |
| `--control` on `--surface` / `--page` | 3.30 / 3.02 | 4.03 / 4.18 | 3.0 |
| `--cpu-py` / `--cpu-native` / `--cpu-sys` | 7.74 / 4.10 / 3.24 | 8.94 / 5.36 / 3.86 | 3.0 |
| `--mem-py` / `--mem-native` | 6.15 / 3.35 | 10.13 / 5.55 | 3.0 |
| `--copy` / `--gpu` / `--gpu-mem` | 3.50 / 6.73 / 3.42 | 10.86 / 7.85 / 4.23 | 3.0 |
| `--async` / `--gil` / `--gc` / `--danger` | 4.86 / 4.72 / 7.27 / 5.60 | 10.69 / 7.16 / 10.13 / 6.60 | 3.0 (danger as text 4.5) |
| `--danger` on `--danger-wash` | 4.90 | 5.53 | 4.5 |
| Frame Python : native | 3.53 | 3.22 | 3.0 |
| Frame labels (py / native / await / unresolved) | 6.16 / 10.85 / 15.13 / ≥ 7 | 10.74 / 5.03 / 10.24 / ≥ 6 | 4.5 |
| Dark native frame vs surface | – | 3.22 | 3.0 |
| `--frame-lod` vs surface | 3.45 | 3.12 | 3.0 |
| Syntax text / kw / str / num / com / builtin on surface | 15.52 / 18.91 / 6.94 / 7.37 / 5.77 / 8.51 | 13.58 / 17.43 / 10.12 / 9.98 / 6.29 / 8.91 | 4.5 |
| `--syn-com` on max wash (cpu / mem / gpu / await) | 4.84 / 4.90 / 4.79 / 4.96 | 4.80 / 4.71 / 4.95 / 4.62 | 4.5 |
| `--syn-com` on `--select` / `--flash` | 5.17 / 5.09 | 5.31 / 4.95 | 4.5 |
| Thread colours (5 + other) vs surface | 4.25–5.19 / 3.24 | 5.47–6.06 / 3.64 | 3.0 |
| Ramp labels (worst step) cpu / mem | 4.83 / 4.58 | 4.57 / 5.04 | 4.5 |
| Focus ring (`--fg`) vs every surface | ≥ 16.9 | ≥ 15.3 | 3.0 |

Light `--cpu-sys` is 2.97 on `--page` and `--mem-native`/`--copy`/`--gpu-mem` are 3.0–3.2 on
`--page`, so **data marks are always drawn on `--surface`** (cards), never on the page background.

---

## 4. Component specifications

### 4.0 Shared data layer (model, formatting, vocabulary, thresholds)

Every view reads from **one immutable `Model`** built once per `load()` (§8.3 `model/`). No view
reads the raw profile, except that `globalThis.profile` stays the raw object for compatibility (§7.3).

#### 4.0.1 Normalization and capability flags (`model/normalize.ts`)

- `load(p)` accepts an object or a JSON string (`JSON.parse` in try/catch → load-error toast, §4.15).
  `""`, `null`, a non-object, `{}`, or `files` missing or empty → **empty state** (§4.16).
- Defaults (schema §8): numbers → 0, arrays → `[]`, booleans → false, `gpu_device` → `""` (label
  "GPU"), `main_thread_id` → null, region bounds → `(lineno, lineno)`, function bounds → `(0, 0)`,
  `n_peak_mb` ← `n_growth_mb` when missing. `NaN`/`±Infinity` → 0, and the field counts as absent.
- **Never mutate the raw profile** (upstream mutated `line.line`).
- Source text: strip one trailing `\r?\n`; replace only the literal six-character sequences `<`,
  `>`, `&` (case-insensitive hex) with `<`, `>`, `&`. Everything that reaches the DOM goes
  through `textContent` or `escapeHtml`.
- Sort `samples` and every `memory_samples` by time (old profiles are unsorted). Clamp footprint
  values to ≥ 0 for drawing (old profiles have −0.06 MiB). Times may exceed `elapsed_time_sec`.
- Lines are looked up by `lineno` (fast path `lines[lineno-1]` when `lineno` matches, else a `Map`).
  Never assume dense arrays.
- `elapsed_time_sec` missing, non-finite or ≤ 0: the run length is **derived** from the latest
  memory/CPU/timeline sample time when there is one (`Model.elapsedSource = "derived"`, headline
  "ran for at least 54.1 s", no Elapsed tile), else **absent** (`caps.elapsed = false`, every `sec` is
  NaN so formatters print "—", phrases drop the seconds, headline "ran for an unrecorded time").
- `growth_rate` missing or non-finite → "growth not recorded" (never "growth 0%").
- JSON text (load(text), picker, drag and drop) is parsed with `parseProfileText`: on failure it
  retries once with Python's bare `NaN` / `Infinity` / `-Infinity` tokens (outside strings) as `null`.
- `caps` (capability flags) records **presence**, so absent data is never shown as a measured 0:

| Flag | True when |
|---|---|
| `memory` | `memory === true` |
| `gpu` | `gpu === true` and not `neuron` (upstream hides GPU columns when Neuron data exists) |
| `neuron` | any line has `nc_time_ms > 0 \|\| nrt_time_ms > 0 \|\| nrt_percent > 0` |
| `async` | `async_profile === true` |
| `coreUtil` | any line has the key `n_core_utilization` |
| `gpuMemory` | any line has the key `n_gpu_peak_memory_mb` |
| `regions` | any line has `start_region_line` |
| `functionBounds` | any line has `start_function_line` |
| `cpuSamples` | `start_time_perf` present and any line has a non-empty `cpu_samples_list` |
| `startTime` | `start_time_absolute` present |
| `stacks` | `combined_stacks.length > 0` |
| `timeline` | `stacks` and `combined_stacks_timeline.length > 0` |
| `threadIds` | timeline events carry `thread_id` |
| `memStacks` | `memory_stacks.length > 0` and Σ mb > 0 |
| `peakLocation` | `max_footprint_fname` and `max_footprint_lineno` non-null |
| `peakPyFraction` | `max_footprint_python_fraction` present |
| `leaks` | any file has a `leaks` key (else "leak detection: not recorded") |

#### 4.0.2 Formatters (`core/format.ts`) — one per quantity, used everywhere

All outputs join number and unit with a no-break space (U+00A0, exported as `NBSP`), so prose
never wraps between "128" and "MiB"; `%` attaches directly. Compound times keep every space
unbreakable ("3 m 47 s"); ranges break only around the en dash. Axis tick labels (never wrapped)
keep a plain space. Locale is fixed to `en-US` for determinism.

| Function | Input | Rules | Examples |
|---|---|---|---|
| `fmtPct(v)` | 0–100 | `null`/non-finite → "—"; `v ≤ 0` → "0%"; `v < 0.05` → "<0.1%"; `99.95 ≤ v < 100.05` → "100%"; else `v.toFixed(1)+"%"` | `21.4%`, `0.4%`, `<0.1%` |
| `fmtTime(s)` | seconds | ≤ 0 → "0 s"; < 1 ms → "N µs"; < 10 ms → 1 decimal ms; < 1 s → integer ms; < 10 s → 2 decimals; < 60 s → 1 decimal; < 1 h → "M m SS s"; else "H h MM m" | `368 ms`, `2.64 s`, `54.1 s`, `3 m 47 s` |
| `fmtMem(mib)` | MiB | ≤ 0 → "0 B"; ≥ 1 TiB → 2 decimals TiB; ≥ 1024 → GiB with 2/1/0 decimals for < 10 / < 100 / ≥ 100; ≥ 100 → integer MiB; ≥ 10 → 1 decimal MiB; ≥ 1 → 2 decimals MiB; ≥ 1/1024 → integer KiB; else integer B | `3.11 GiB`, `98.3 MiB`, `742 MiB`, `22 KiB` |
| `fmtRate(mibPerS)` | MiB/s | `fmtMem(v) + "/s"` (adaptive, so small rates read in KiB/s) | `5.71 MiB/s`, `288 KiB/s`, `11 KiB/s` |
| `fmtCount(n)` | integer | grouped | `5,901` |
| `fmtUtil(v)` | 0–100 | like `fmtPct` (one decimal) | `66.9%` |
| `fmtDate(epochSec)` | s | `Oct 27, 2026, 14:22` (24 h) | |
| `fmtRange(a, b)` | s | `fmtTime(a) + " – " + fmtTime(b)` | `12.0 s – 18.5 s` |
| `fmtLoc(file, line)` | | `basename:line`; full path in tooltip | `train.py:173` |
| `pickNiceTickInterval(total, px)` | | upstream algorithm (1/2/5 × 10^k); max ticks = `max(2, floor(px / 80))` | |
| `formatTimelineTickLabel(sec, step)` | | "0"; ≥ 1 s → decimals by step (0/1/2/3) + " s"; < 1 s → ms (0 or 2 decimals) + " ms" | `0`, `10 s`, `250 ms` |
| `formatMemoryTickLabel(mib, step, max?)` | | "0"; unit = GiB if `max ≥ 1024`, MiB if ≥ 1, else KiB — **one unit per axis** (`max` = the axis data max; every axis helper passes it); decimals by step in that unit | `1 GiB`, `1.5 GiB`, `0.2 GiB`, `512 MiB` |
| `niceMemStep(maxMiB, maxTicks)` | | 1/2/5 steps **in the display unit** (KiB/MiB/GiB), so ticks land on 1, 2, 4 GiB… | |

Percentages always carry `%`. Memory always carries a binary unit. Bare numbers are allowed only for
counts that are labelled ("5,901 samples"). Unit tests in WP1 cover every row with the examples above
plus the edge cases (0, negative, NaN, 99.96, 1023.99 MiB, 0.0009 MiB).

#### 4.0.3 "% of what" vocabulary (fixed phrases)

| Quantity (field) | Full phrase | Compact phrase (short host, chips) |
|---|---|---|
| Line/function/file time `py + c + sys` | "21.4% of run · 11.6 s" | "21.4% of run" |
| Split parts | "Python 0.1% · native 7.2% · system 14.1% (of run)" | |
| File share `percent_cpu_time` | "58.8% of run · 31.8 s of 54.1 s" | |
| Unattributed `100 − Σ files` | "0.4% outside profiled files" | |
| Core use `n_core_utilization` | "1.2% of all cores while it ran" | "cores 1.2%" |
| Line peak `n_peak_mb` | "peak 1.20 GiB attributed to this line" | "peak 1.20 GiB" |
| Allocation share `n_usage_fraction` | "33.0% of all allocation" (program-wide) | "33.0% of alloc." |
| Allocated volume `n_malloc_mb` | "1.20 GiB allocated over the run (sampled)" | |
| Copy `n_copy_mb_s` | "22.0 MiB/s copied (average over run)" | "22.0 MiB/s" |
| GPU util `n_gpu_percent` | "96.4% busy while this line ran" | "96.4% busy" |
| GPU readout | "mean while the main thread ran profiled lines (time-weighted)" | "mean while running" |
| GPU memory `n_gpu_peak_memory_mb` | "peak device memory (process) while this line ran" | "device peak" |
| Await `n_async_await_percent` | "35.8% of await time" | "of await" |
| Concurrency | "15.5 tasks suspended on average, 22 at most" | "15.5 / 22 tasks" |
| NRT / NC | "9.69 s · 37.0% of run" | "37.0% of run" |
| Device idle (Neuron) | "12.4% of this line's CPU samples had the device idle" | "idle 12.4%" |
| CPU flame width | "% of sampled stacks — not of run time" | "of stacks" |
| Memory flame width | "% of attributed allocation (cumulative volume, not live size)" | "of alloc." |
| GC / I/O & waits / GIL lanes | "0.6% of samples" | |
| Threads busy | "4.2 threads sampled" | |
| Growth `growth_rate` | "52.2% of allocated memory stayed live" | "growth 52.2%" |
| Leak | "possible leak · grows ~5.71 MiB/s · likelihood 99.7%" | "leak 5.71 MiB/s" |
| Region | "Region 152–184: 43.4% of run" | |
| Stack presence of a line | "in 1,157 of 5,901 stack samples (19.6%)" | |
| Missing value | "not recorded" (field absent) / "none sampled" (field present, 0) | "—" |

#### 4.0.4 Thresholds (upstream parity unless marked NEW)

| Rule | Value |
|---|---|
| Time value printed | `total > 0`; `< 0.05` prints "<0.1%" |
| Data row (visible in "Hot lines") | `total > 1.0 \|\| hasMem \|\| (caps.gpu && gpu ≥ 1) \|\| nrt > 0 \|\| nc > 0 \|\| (caps.async && await ≥ 1) \|\| hotRegionHead` |
| `hasMem` | `n_avg_mb + n_peak_mb + memory_samples.length + (n_usage_fraction ≥ 0.01 ? 1 : 0) > 0` |
| Hot region head | first line of a region (`start ≠ end`) whose region (lines start+1 … end, **inclusive**, by lineno — fixes upstream's index bug) has Σ total ≥ 1.0 or any `hasMem` |
| Function context row | line within `[start_function_line, end_function_line]` of a function containing a line with `total > 1.0 \|\| hasMem \|\| gpu ≥ 1 \|\| nrt/nc > 0` |
| AI line / region eligibility | exactly `computeProposalAvailability(lines, 50)` from `src/ai` |
| Alloc column cell | `n_usage_fraction ≥ 0.01` |
| Copy cell | `n_copy_mb_s ≥ 1` |
| GPU util cell | `n_gpu_percent ≥ 1` (and `caps.gpu`) |
| GPU memory cell | `n_gpu_peak_memory_mb ≥ 1` and `n_gpu_percent ≥ 1` |
| Await cell | `n_async_await_percent ≥ 1` |
| Device idle bands | `< 30` ● low, `30–<60` ◆ medium, `≥ 60` ▲ high (`100 − cpu_samples_nc_overlap_percent`) |
| File hidden | `percent_cpu_time < 1.0 && max(n_peak_mb of file) < 0.01 × Σ n_malloc_mb (all lines, all files)` — counted and revealable (NEW) |
| Row heat wash | heat metric value ≥ 1 % (time) / > 0 (memory peak), strength ∝ value / max line value in profile |
| Hotspots GPU metric population | lines with `total ≥ 1` (NEW, stated in the list header) |
| Finding thresholds | §4.6.2 |

#### 4.0.5 Python highlighter (`model/syntax.ts`)

A single-pass tokenizer per line, given the line's "inside triple-quoted string" state from the
`stringLines` port (upstream `stringLines` semantics, gui:272: opening, inner and closing lines are
marked; a one-line `"""doc"""` is not). Token classes and CSS:

| Class | Matches | Style |
|---|---|---|
| `t-kw` | `False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case` (soft keywords `match`/`case` only at line start) | `--syn-kw` 600 |
| `t-def` | identifier after `def`/`class` | `--syn-text` 600 |
| `t-bi` | `print len range enumerate zip map filter sum min max abs any all isinstance hasattr getattr setattr super open iter next sorted reversed int float str bytes list dict set tuple object type self cls` | `--syn-builtin` |
| `t-dec` | `@name(.name)*` at line start | `--syn-builtin` |
| `t-str` | string literals with optional prefixes `rRbBuUfF{1,2}`; single-line `'…'`, `"…"`; triple quotes on the same line | `--syn-str` |
| `t-num` | ints, floats, hex/oct/bin, `_` separators, `j` suffix | `--syn-num` |
| `t-com` | `#…` to end of line (outside strings); whole line when inside a triple-quoted string | `--syn-com` italic |

Output is an array of `{cls, text}` spans; the view builds DOM with `textContent` (no `innerHTML`).
Highlighting is lazy per rendered row and memoised per `file:line`.

#### 4.0.6 Stack classification (`model/classify.ts`) — one rule for every view

Port upstream `classifyFrame` **verbatim** (feature inventory §4.7): GC name regex → GIL exact names
(`take_gil`, `_PyEval_LockGIL`, `PyGILState_Ensure`) → I/O exact names and patterns (including
`^\[await\]`, `pthread_cond_wait`, `pthread_cond_timedwait`, `__psynch_cvwait`, …; **no stripping of
`@@GLIBC` version suffixes**) → for py frames, I/O file patterns. A stack is GC / I/O / GIL if any
frame is; **GIL overrides I/O**. The I/O lane is labelled **"I/O & waits"** because the upstream list
contains blocking waits (`select`, `poll`, `epoll_wait`, `pthread_cond_wait`) and `[await]`. Its
tooltip lists the categories.

Lane totals = Σ `count` of timeline events whose stack has the class ÷ Σ `count` of all events,
shown as "% of samples". **Golden values:** ml-training GC 0.6 %, I/O & waits 2.8 %, GIL 0.9 %;
huge GC 2.1 %, I/O & waits 4.0 %, GIL 1.6 %; async-server I/O & waits 95.7 % (mostly `[await]`). The
scope, timeline, findings and tooltips all read `model.timeline.laneTotals`. No view recomputes them.

#### 4.0.7 Derived quantities (`model/model.ts`, `model/timeline.ts`, `model/stacks.ts`)

| Quantity | Formula |
|---|---|
| `Line.total` | `py + c + sys` (% of run); `Line.sec = total / 100 × elapsed_time_sec` |
| Program split | Σ over **all** files' lines of py, c, sys; `outside = max(0, 100 − Σ)` (ml-training 11.6 / 61.9 / 26.1, outside 0.4) |
| File totals | Σ of its lines (bar); text uses `percent_cpu_time` |
| Rankings | lines with `total > 0` over all files, sorted desc (ties: file rank, then lineno); same for memory (`n_peak_mb` desc, ties `n_malloc_mb`), GPU (`n_gpu_percent` desc among `total ≥ 1`), await (`n_async_await_percent` desc); functions from `functions[]`; files by `percent_cpu_time` (time) or max line peak (memory) |
| Function membership | if `caps.functionBounds`: innermost range `[start_function_line, end_function_line]`; the `functions[]` entry is the one with `lineno ∈ [start − 20, start]` whose qualname ends with the `def`/`class` name parsed from line `start` (else nearest `lineno ≤ start`). Without bounds (old profiles, dense lines): scan upward for the nearest `def`/`class` line with smaller indentation. Sparse lines without bounds: none |
| Region total | Σ `total` over lines `start+1 … end` (inclusive) by lineno |
| GPU readout | `Σ(gpu × total) / Σ total` over lines with `total > 0` **and** non-empty `cpu_samples_list` (main-thread lines; GPU is sampled on the main thread). Fallback without `caps.cpuSamples`: all lines with `total > 0`. One decimal. ml-training **66.9 %**, huge 22.8 % |
| GPU device peak | max `n_gpu_peak_memory_mb` over lines (ml-training 8.62 GiB) |
| Peak time | time of the max-footprint point in `samples` (ns → s). ml-training 52.9 s |
| Footprint at t | linear interpolation between neighbouring `samples` (label it "interpolated"); outside the sampled range → "not sampled" |
| `samples` downsampling | M4 per pixel column (first, min, max, last) when points > 2 × plot width |
| Leaks | per file `leaks[lineno]` → list sorted by likelihood desc, then velocity desc |
| `tMax` (time domain) | `max(elapsed_time_sec, last samples t / 1e9, last timeline run end)` |
| Sampling interval `dt` | median of `(t_next − t) / count` over consecutive events of the same thread (first 4,000 gaps), clamped to [0.5 ms, 200 ms], default 10 ms. Shown in meta ("10 ms sampling") |
| Run end (timeline) | `min(nextSameThread.t_sec (if later), t_sec + count × dt)`; last run of a thread: `t_sec + count × dt`. Fixes upstream's cross-thread truncation |
| Time alignment | `samples`/`memory_samples`: ns since start → s. `cpu_samples_list`: `v − start_time_perf`. Timeline `t_sec`: as is (origin = first sampled run; offset ≤ dt, stated in the scope's info tooltip) |
| Threads busy (scope) | bucket `[a, b)` of width ≈ 2 CSS px: Σ over runs of overlap(run, bucket) / (b − a), split by stack class into busy / GIL / I/O & waits; GC counts as busy |
| Suspended tasks (async scope) | per bucket: mean over sample instants of the number of `[await]`-leaf events at that instant |
| Thread labels | `main` (id == `main_thread_id`), `unknown` (null), else `thread N` numbered by first appearance after main (raw id in tooltips) |
| Call context of a line | stacks containing a py frame with `filename_or_module == file && line == lineno`; "in N of M stack samples" = Σ hits of those stacks / Σ all hits; *calls into* = next frame below the deepest match, aggregated by display name, top 4 with share of N; *called from* = frame above the first match, top 2 |
| Flame tree | merge key `kind \| filename_or_module \| (line for py, "x" for native) \| display_name`, root-first; node `total` = Σ hits through it, `self` = hits ending at it; children sorted by `total` desc (heaviest left) |

#### 4.0.8 Edge cases (every view MUST handle these; fixtures in brackets)

| Case | Required behaviour |
|---|---|
| `elapsed_time_sec = 0` | Times show "0 s"; seconds columns hidden; the scope is not rendered; percentages still render |
| No CPU samples in any file | Headline rule 6; hotspots "No CPU samples were attributed to profiled files"; Time readout shows 0% with "no CPU samples" |
| `memory: true` but `samples` empty | MEMORY channel absent; Peak readout still shows `max_footprint_mb` (time "not sampled") |
| `gpu: true` but every `n_gpu_percent = 0` | GPU readout "0.0%" with caption "no GPU activity sampled"; GPU column hidden (no cell ≥ 1) |
| `async_profile: true` without `[await]` stacks | Await readout and column still from line fields; TASKS channel absent |
| Files sum > 100 (one ulp) [async] | Clamp "outside profiled files" to ≥ 0 and hide it below 0.05 |
| `growth_rate` < 0 or > 100 | Display clamped to [0, 100]; the raw value goes in the tooltip |
| `leaks` keys sorted as strings [all] | Sort by likelihood, never by key order |
| Legacy timeline without `thread_id` | One lane "unknown"; no thread filter; phases use all runs |
| Frames whose file is not in `files` [ml] | Tooltip "source not in this profile"; jump disabled (`g`/double-click show a toast "This file is not in the profile") |
| Unresolved native frames [ml: 183] | Label `0x…` (hex ip), kind "UNRESOLVED", module path in the tooltip |
| Very long native names (411 chars) [ml] | Simplified + middle-truncated label; full name wraps in the tooltip (max-width 360) |
| Jupyter cell files `[12]`, `<exec_3>` | Shown verbatim in mono; base = the full key; no "dir" part |
| File paths with spaces / non-ASCII | `vsNavigate` decoding per §7.3; `escape()` for the VS Code message; labels shown decoded |
| Sparse `lines` [example] | Look up by lineno; `gap` items; no function membership without bounds |
| Unsorted / negative `memory_samples` [example] | Sorted at normalize; negatives clamped to 0 for drawing, raw in tooltips |
| > 10 threads [huge: 12] | Lanes need no palette; Interleaved uses 5 colours + "other" |
| `profile` given as JSON text, `""`, `null` | Parsed / empty state / empty state |
| `NaN` / `Infinity` in numbers | Treated as absent (§4.0.1) |
| Storage blocked (private mode, sandboxed iframe) | Everything works; preferences reset per load; one info toast when a save fails |
| Clipboard API denied | Copy falls back to a hidden textarea + `execCommand("copy")`; on failure an error toast |

### 4.1 App bar (`views/appbar.ts`)

**Anatomy** (left → right), height `--appbar-h`, sticky top 0, `z: --z-appbar`, background `--page`
at 85 % with `backdrop-filter: blur(12px) saturate(140%)`, 1 px `--line` bottom border,
`padding-inline: max(var(--gutter), env(safe-area-inset-left))`:

1. **Logo** (22 px mark + "Scalene" 15/20 600), a link to `https://github.com/plasma-umass/scalene`
   (`target=_blank rel=noopener`). Not the page `h1`.
2. 1 px × 20 px divider `--line-strong`.
3. **Program**: basename of `program` (mono 13 600 `--fg`) + `args[1:]` joined (mono 12.5 `--fg-3`,
   middle ellipsis). A button: click/focus opens a popover with the full program path,
   `entrypoint_dir`, full args, start date, Scalene version. Missing `program` → "Scalene report".
4. **Section nav** (`lg+`): links Overview · Code · Stacks · Timeline · Memory (only present sections,
   §2.1), 14/20 500 `--fg-2`; active = `--fg` + 2 px `--fg` underline (scroll-spy via
   IntersectionObserver: active = last section whose top ≤ `--appbar-h + 40`). Below `lg`: a
   "Sections ▾" menu button (`md`, `sm`) or the ⋯ menu (`xs`, `short`).
5. Spacer.
6. **Search**: a button styled as a field ("⌕ Search" + key chip "⌘K" on macOS, "Ctrl K" elsewhere;
   width per §2.4.1) that opens the palette (§4.20).
7. **AI**: spark icon + "AI fixes" label (`lg+`; round 1) + a neutral "Set up" badge while no
   provider is ready + status dot: filled `--fg` = `checkReady(settings).ready`, 1.5 px ring = not
   set up. `aria-label="AI fixes — Anthropic, ready"` / `"AI fixes — set up a provider"`. Opens the
   drawer (§4.14.4).
8. **Load** (upload icon; label "Load" at `xl+`): clicks the single `<input type=file id="fileinput"
   accept=".json,application/json" hidden>`.
9. **Theme**: sun/moon icon button, `aria-label="Switch to dark theme"` (or light). On `xs` and in
   `short`, Load, Theme, Sections, "Reduce motion" and "Keyboard shortcuts" move into a ⋯ menu
   (`role=menu`, arrow keys, Esc).

**Buttons**: 32 × 32 (36 on coarse pointers), radius `--r-sm`, icon 16, hover `--hover`, pressed
`--grid-strong`, focus ring. No data hues anywhere in the app bar except the logo.

**Navigation click**: scroll the section to the top under the app bar (smooth; reduced motion:
instant), then `heading.focus({preventScroll: true})`, then `history.replaceState(null, "", "#id")`.
On load with a hash (`#code` etc.), jump there after first paint.

#### 4.1.6 Theme toggle (must-fix 10)

1. Compute next theme, store it in `localStorage["scalene-theme"]` (try/catch; works without storage),
   set `<html data-theme>`.
2. In the same task: `theme.invalidate()`, then emit `theme:changed`. Every canvas view redraws
   synchronously from cached geometry (no re-layout, no DOM rebuild, no re-measure).
3. No transition on colours (frequent action). `scrollY`, selection, focus, open lens, flame zoom and
   timeline domain are unchanged. Test: toggle twice on ml-training at a scrolled position with an
   open lens, then assert that `scrollY`, `document.activeElement` and the selection are equal and
   that the event-timing duration is < 100 ms.
4. Palette action "Use system theme" removes the stored value and follows the system again.

### 4.2 Headline (`views/overview/headline.ts`, generator `model/headline.ts`)

**Anatomy**: `<h1 class="headline">` (`--type-headline`, `--fg-2` for connective words, `--fg` 600 for
numbers and the program name) + `<p class="meta">` (12.5/18 `--fg-2`, items separated by 3 px dots).
The headline is at most 3 lines at `lg` (`xs`: 4). It never contains more than **2 code chips**.

**Meta items** (in order, only if applicable): "Profiled Oct 27, 2026, 14:22" (`caps.startTime`) ·
"6 files" + " (+16 below 1%)" as a button that opens the hidden-files list in the code navigator ·
"5 threads" · "async" · "GPU" / "AWS Neuron" (`gpu_device`) · "CPU only" (`!memory`) · "10 ms sampling"
(`caps.timeline`) · "Scalene 2.4.0" (from the template footer's `data-version`).

#### 4.2.1 Segments model
`HeadlineModel = { segments: HeadSeg[]; plain: string }` where `HeadSeg` is
`{t:"text", s}` | `{t:"num", s}` | `{t:"code", s, target}` | `{t:"ref", s, target}`, and `target` is
`{file, line}` or `{file, fn}`. The view renders `num` as `<strong>`, `code` as
`<button class="chip-code">` (mono 0.9 em, `--sunken` fill, 1 px `--line`, radius `--r-sm`,
padding 1 px 6 px), and `ref` as a quiet `--fg-3` button ("train.py:173").

#### 4.2.2 Generator rules (in order)
Let `P` = basename of `program` (else "This program"), `E` = `fmtTime(elapsed)`, `R` = lines ranked by
time (all files).

1. Always start with: "**P** ran for **E**."
2. **Event-loop branch** (`caps.async` and `R[0]` text matches
   `/\b(asyncio\.run|run_until_complete|run_forever|uvloop\.run|anyio\.run|trio\.run)\s*\(/`):
   "**59.6%** of it is the event loop (`asyncio.run(…)`), mostly waiting." ("mostly waiting" when
   `sys / total ≥ 0.5`, else "running callbacks"). Then with `c` = `R[1]`: "The busiest code,
   `hashlib.pbkdf2_hmac(…)` (21.6%, handlers.py:51), runs inside a coroutine, so the loop stalls while
   it runs." when `c.coro`; else "The busiest code is `chip` (21.6%, file:line)." Stop (no memory
   clause; 2 chips used).
3. **Concentrated branch**: take the smallest `k ∈ {1,2,3}` such that Σ `R[0..k)` ≥ 30 % (else
   `k = 3`). If that sum ≥ 25 %:
   - all `k` lines in the same named function `F` (k ≥ 2): "Two lines in `F()` account for **37.6%** of
     the time" (1 chip: the function).
   - `k = 1`: "`chip` (infer_bert.py:66) takes **37.7%** of the time" (1 chip).
   - `k = 2`, different functions: "`chipA` (train.py:173) and `chipB` (:165) account for **37.6%** of
     the time" (2 chips; the second ref drops the file name when it is the same file).
   - `k = 3`, different functions: "Three lines account for **X%** of the time; the busiest is `chip`
     (y%, file:line)" (1 chip).
4. **Spread-out branch** (sum < 25 %): "Time is spread out: the busiest function, `F()`, takes
   **5.8%**" (function = max `functions[]` total; if there are no functions, the busiest file:
   "…the busiest file, `name.py`, takes x%").
5. **Memory clause** (`caps.memory`, `max_footprint_mb > 0`, branch 2 not taken): "; memory peaked at
   **3.11 GiB**." Otherwise end with ".". No chip is added here.
6. No CPU time at all: "**P** ran for **E**; no CPU samples were attributed to profiled files." (+
   memory clause).

#### 4.2.3 Code chip text (token-safe shortening, `shortCode(text, max = 32)`)
1. `s = text.trim()`; if `s.length ≤ max` → `s`.
2. Assignment `target (op)= rhs` (not `==`): if `rhs` is a call `a.b.c(args)` → `a.b.c(…)` if it fits,
   else `….c(…)`. Otherwise `target = …` if it fits.
3. Call statement → `a.b.c(…)` → `….c(…)`.
4. Compound header (`for`, `while`, `if`, `with`, `def`, `class`, `async …`): keep whole tokens from
   the start until the next token would exceed `max − 2`, then append " …".
5. Otherwise no chip: use the `ref` ("train.py:173") as the subject ("Line train.py:173 takes …").
An ellipsis is only ever placed **between** tokens. The full text is the chip's tooltip and
`aria-label` ("loss_value = loss.item() — go to train.py line 173").

**Interactions**: a chip or ref click calls `nav.jumpTo(target, {focus: true, open: true})`.
Hover or focus emits `hover:line` (the scope overlay and the hotspot row highlight, §4.4.6). Golden
outputs per fixture are in Appendix A and are unit-tested.

### 4.3 Readouts (KPI tiles) (`views/overview/readouts.ts`)

#### 4.3.1 Slot selection (max 4, in this order)
```
tiles = [TimeSplit]
if (caps.memory && max_footprint_mb > 0) tiles.push(PeakMemory)
if (caps.neuron) tiles.push(Neuron) else if (caps.gpu) tiles.push(Gpu) else if (caps.async) tiles.push(Await)
if (model.leaks.length > 0) tiles.push(Leaks)
for (const t of [Elapsed, BusiestFunction]) if (tiles.length < 4 && t.applicable) tiles.push(t)
```
Grid: `grid-template-columns: 1.6fr repeat(n − 1, 1fr)`, 1 px `--line` dividers, no gaps. Resulting
sets: ml-training and huge = Time · Peak · GPU · Leaks; async-server = Time · Peak · Await · Elapsed;
neuron = Time · Peak · Neuron · Elapsed; cpu-only = Time · Elapsed · Busiest function; basic =
Time · Peak · Elapsed · Busiest function.

#### 4.3.2 Tile anatomy
Padding 16/20 (`lg`). Label row: 6 px LED dot in the resource colour (dark: `box-shadow 0 0 6px` at
`--glow`) + micro label (`--type-micro`, uppercase, `--ls-micro`, `--fg-2`). Value row:
`--type-readout` + unit (`--type-readout-unit`, `--fg-2`), `tabular-nums`. Micro-visual (one per tile,
8 px tall). Caption: 12/16 `--fg-2`, max 2 lines, always states the denominator.

| Tile | Value | Micro-visual | Caption |
|---|---|---|---|
| **Where the time went** | three values side by side: Python / native / system (each `fmtPct`), with swatch + label under each | one stacked split bar (system hatched), full width | "share of run time · 0.4% outside profiled files" (outside part only if ≥ 0.05) |
| **Peak memory** | `fmtMem(max_footprint_mb)` | Python/native split bar of the peak allocation (`max_footprint_python_fraction`); if absent: neutral `--sunken` bar + "split not recorded" | "at 52.9 s · `train.py:120` · Python 1.0%" / "growth 52.2% · +212 MiB native threads" (each part only if present) |
| **GPU** | `fmtUtil(gpuMean)` | absolute 0–100 meter `--gpu` | "mean while the main thread ran (time-weighted)" / "peak device memory 8.62 GiB · busiest `train.py:173` 96.4%" |
| **Neuron runtime** | NRT total `fmtTime(Σ nrt_time_ms / 1000)` | two thin meters: NRT `--gpu-mem`, NC `--gpu` (% of run) | "37.8% of run in NRT · NC 8.69 s (33.2%)" / "device idle in 78.5% of CPU samples" (from `cpu_samples_nc_overlap_percent_overall`, if present) |
| **Await** | top await site share `fmtPct` | meter `--async`, scaled to 100 % | "of await time at `await asyncio.sleep(…)` · bench_server.py:59" / "15.5 tasks suspended on average, 22 at most" |
| **Possible leaks** | count, `--danger` | none | up to 2 buttons: "↗ metrics.py:42 · 5.71 MiB/s", "↗ loader.py:33 · 288 KiB/s"; "+N more in Memory" link |
| **Elapsed** | `fmtTime(elapsed)` | none | "wall clock · 5 threads · 5,901 samples" / "10 ms sampling" |
| **Busiest function** | its total `fmtPct` (cpu-only: 86.8%) | meter `--cpu-py` scaled to 100 % | "`accelerations()` · nbody.py:32 · 19.3 s" |

#### 4.3.3 Interactions
Tiles are not buttons. Inner refs (peak location, busiest line, leak items, functions) are buttons
that call `nav.jumpTo`. Hovering or focusing the Peak tile emits `hover:peak` (the scope's peak marker
pulses once, 420 ms ring scale 1 → 1.6 opacity 1 → 0; reduced motion: a static 2 px ring for 1.2 s).
Hovering a value shows a precise tooltip (e.g., "3,184.65 MiB = 3.11 GiB, at 52.93 s").

#### 4.3.4 Motion
Count-up (M3) only for the single-number values (Peak, GPU, NRT, Await, Elapsed, Busiest
function). The **time split never counts**: its three numbers render final and its bar grows as one
unit (`scaleX` 0 → 1 from the left, M4). The animated text node is `aria-hidden`, and a visually
hidden sibling holds the final value from the start.

#### 4.3.5 Compact (`short`)
Tile = label + value + one short caption line (11/14), no micro-visual except the time split bar
(4 px). Short captions: "of run · 0.4% outside", "at 52.9 s", "mean while running", "of await time",
"top 5.71 MiB/s", "wall clock". (Must-fix 31: the denominator never disappears.)

### 4.4 Instrument scope — the hero motion graphic (`views/overview/scope.ts`)

The scope draws the whole run on one time axis `[0, tMax]` as stacked **channels**. It is the
signature visual and the linking hub of the overview.

#### 4.4.1 Card anatomy
- The **Instrument card** holds the scope (left, span 7 at `lg+`) and the hotspots (right), separated
  by a 1 px `--line` vertical divider. Below `lg` the scope is on top and the hotspots are below
  (`xs`: hotspots first, §2.4.5).
- Scope header row (28 px): micro label "SIGNAL" + description "the run over time" (`--fg-2`, 12.5) +
  legend chips on the right (only for channels shown: "■ footprint", "■ threads busy",
  "▨ I/O & waits" (the §4.12 term; with TASKS "suspended · I/O & waits"), "■ GIL", "▨ short phases"
  (only when a short cell is drawn)). While a range is brushed, the description is replaced by
  the **range chip** (§4.4.8). While a line is hovered or selected, it is replaced by the **link
  caption** (§4.4.6).
- Left gutter (channel labels: micro label + one caption line): `lg` 104, `xl` 112, `xxl` 120, `md` 96,
  `sm` 88, `short` 72; `xs`: no gutter, labels sit on a 14 px row above each channel.
- Right gutter (y-tick labels): 52 at every width (round 1; `xs`: exactly as wide as the widest
  label). Labels are never drawn inside the plot and never switch sides.
- Bottom: time axis 20 px (nice ticks via `pickNiceTickInterval`, labels via
  `formatTimelineTickLabel`, 1 px `--grid` vertical gridlines through all channels).
- Two stacked canvases: **base** (channels, axes, phase cells) and **overlay** (beam, crosshair,
  brush, linked overlays, peak pulse). DPR-aware; `ResizeObserver` → relayout + base redraw (≤ 1 per
  frame).

#### 4.4.2 Channels (top → bottom; gaps 8 px; only present channels are drawn)

| Channel | Present when | Height (`lg` / `xxl` / `md` / `xs` / `short`) | Encoding |
|---|---|---|---|
| **PHASE** | `caps.timeline` and main-thread runs exist | 18 / 20 / 18 / 18 / – | partition cells (§4.4.3) |
| **MEMORY** "footprint" | `caps.memory` and `samples.length ≥ 2` | flex: fills the remaining height (min 72; ≈ 100 / 132 / 80 / 96 / 110) | footprint area (§3.3), y from 0, binary nice ticks (max 3), peak marker + callout |
| **RUG** | with MEMORY | 6 | allocation moments of the linked line (§4.4.6); empty otherwise (space reserved, nothing drawn) |
| **THREADS** "busy" | `caps.timeline` and > 1 thread | 40 / 52 / 32 / 36 / 48 | step-area (§4.4.4) |
| **TASKS** "suspended" | `caps.async` and any `[await]` leaf in the timeline | 40 / 52 / 32 / 36 / 48 | step-area `--async` + waiting hatch, y = suspended tasks |
| **TOP LINES** "when top 5 ran" | `caps.cpuSamples` (Time/GPU/Await metric) or `caps.memory` (Memory metric) | 5 × 12 / 5 × 14 / 5 × 10 / 5 × 10 / – | histogram strips (§4.4.5) |

If no channel is present (no memory, no timeline, no `cpu_samples_list`), the scope is not
rendered, and the hotspots take the full width of the Instrument card.

#### 4.4.3 PHASE channel (must-fix 2: never an empty, unlabeled box)
- **Data**: main-thread runs (thread id = `main_thread_id`; without thread ids, all runs). For each
  run's stack, take its py frames root-first. For depth d ∈ {0, 1}: if the frame's line has an
  enclosing loop (`start_outermost_loop < end_outermost_loop`) whose header line starts with
  `for`/`while`/`async for`, then phase = that loop (key `file:start`, label = header text without
  the trailing `:`). Otherwise phase = the frame at depth `min(1, n−1)` (label = its source line,
  trimmed, or `display_name()`).
- Merge consecutive runs with the same key when the gap is < 0.4 % of `tMax`.
- **Cells by pixel width**:
  - ≥ 64 px: labelled cell. Fill `--sunken`, radius 3, label mono 11/18 `--fg-2`, shortened with
    `shortCode` to the width (token-safe, measured with `measureText`).
  - 12–63 px: unlabelled cell with a 1 px `--control` hatch on a 4 px period drawn directly on the
    card surface (≥ 3:1: 3.30 light / 4.03 dark; round 1) and a 1 px `--line-strong` outline (all
    cells get the outline). The legend chip uses the same pattern. It has a tooltip and is
    reachable by keyboard.
  - < 12 px: merged with adjacent < 12 px cells into one **group cell** (hatched). If the group is
    ≥ 64 px it is labelled "N short phases", or "label ×N" when its dominant member covers ≥ 50 % of
    the group's time ("while time.monotonic() < deadline ×31").
  - PHASE is hidden when named cells cover less than half of the main-thread time (round 1).
  - 2 px gaps between cells. Time without main-thread samples stays empty (no cell, no border).
- Hover or focus → tooltip: label, `file:line`, time range, "% of main-thread samples". Group cells
  list up to 6 members. Click → `nav.jumpTo(line)`.

#### 4.4.4 THREADS channel (must-fix 4)
- Buckets are fixed time windows of max(10·dt, tMax/600) (round 1), so the axis is the same at every
  width; drawing is never finer than those windows. Per bucket: `busy`, `gil` and `wait` = mean
  number of threads sampled in that state (§4.0.7; GC counts as busy).
- Stacked step-area, bottom → top: busy (`--cpu-native` 45 % + 1.25 px `--cpu-py` top line), GIL
  (`--gil` 70 %), waiting (waiting hatch). These are **thread counts**, not the line-level
  Python/native split, so the legend says "threads busy", never "Python/native".
- Y axis: `ceil(max)` (plus a middle tick if `max ≥ 4`), integer labels; the 0 label is dropped (the
  1 px `--grid-strong` baseline is the 0, as on MEMORY). The caption sentence uses the instantaneous
  maximum from a sweep over the busy runs' [t0, t1) intervals ("Up to 5 threads busy at the same
  moment"; GIL and I/O waits excluded), independent of pixels.
- Height is capped by the table above. Single-thread profiles never get this channel (cpu-only shows
  PHASE + TOP LINES), so a solid 1-thread wall cannot happen.

#### 4.4.5 TOP LINES channel (graft from B)
- Rows 1–5 follow the **current hotspot list** (tab × metric, §4.5): the same rank numerals (mono 11
  `--fg-2`) sit in the gutter, and the first row carries the label "WHEN TOP 5 RAN" (Memory metric:
  "…ALLOCATED").
- Round 1: strips are smoothed density areas (adaptive bins with ≥ ~8 samples each, a [1 2 1]
  kernel, alpha fill and a crisp top edge only where the line ran), at most 20 px tall with a row
  pitch of at most 32 px. When TOP LINES is the only numeric channel side by side it shows 8 rows (one
  per visible hotspot); short hosts keep it (5 rows) when nothing else is drawable. Rank numerals sit
  in the right gutter (phones: the 16 px left gutter); two-line captions use the most balanced break.
- Each row is a density of `cpu_samples_list − start_time_perf` (Memory metric: `memory_samples`
  times), height ∝ count / **row max** (each row is scaled to its own peak;
  the label tooltip says so: "main-thread CPU samples, up to 500 kept per line; each strip is scaled to
  its own peak"). Fill `--cpu-py` (Memory: `--mem-py`). Baseline 1 px `--grid-strong`.
- Functions tab: union of the member lines' samples. Files tab: union over the file's lines.
- A row without samples shows "no main-thread samples (worker thread or native only)" in 11 px
  `--fg-3`. That is information, not an empty strip.
- Hover a row ↔ hover the hotspot item with the same rank (bidirectional).

#### 4.4.6 Linked overlays ("ran here / allocated here")
Triggered by `hover:line` (transient) or `select:line` (sticky until Esc or a new selection), from:
hotspot rows, findings, headline chips, code rows, flame/timeline frames, memory sites.
- **Ran here**: for each `cpu_samples_list` time of the line, a 1 px vertical tick through MEMORY,
  THREADS and TASKS at 30 % (`--cpu-py`; dark 45 %). With > 300 samples, the ticks become a density band
  per 2 px bin (alpha ∝ count, max 0.5).
- **Allocated here**: `memory_samples` times as RUG ticks (`--mem-py`, `--danger` if the line has a
  leak). Never rings on the footprint line (must-fix 9).
- The TOP LINES row of the line (if it is one of the 5) gets full opacity; the other rows dim to 40 %.
- **Link caption** in the header: "`train.py:173` · ran in ≥ 500 main-thread samples · 0 allocation
  events" ("≥" at Scalene's per-line caps of 500 CPU samples / 100 allocation events). It restores the description on leave.
- Overlays draw on the overlay canvas only (≤ 2 ms per draw on huge.json).

#### 4.4.7 Annotations and collision avoidance (must-fix 5)
`scope.debugLayout(): { plot, channels[], ticks[], callout, chip, phaseCells[] }` returns every
annotation rect in CSS px. A geometry test asserts that they do not intersect pairwise and stay
inside their channel and plot rects at 390×844, 1000×400 and 1440×900 on ml-training and huge.
- **Placement order**: peak callout → range chip (header row, never in the plot) → y ticks.
- **Peak callout** ("peak 3.11 GiB" 12 px 600 / "52.9 s · train.py:120" 11 px `--fg-2`; glass
  background, radius `--r-sm`, padding 4 × 6). Candidate positions around the peak dot, in order:
  left (box right edge = dot − 10, top = dot − 8), right, then above / below the **trace** on either
  side, sliding 0–96 px away in 24 px steps. A candidate is rejected if it leaves the MEMORY channel
  rect (inset 2 px), intersects a reserved rect, or comes within 4 px of the drawn footprint
  polyline (round 1: `charts/placement.ts#planPeakClear` with `footprintTrace`, shared with the
  Memory section chart). Fallback 1:
  a one-line "3.11 GiB" label beside the dot. Fallback 2: no label; the channel gutter caption reads
  "peak 3.11 GiB".
- **Y ticks**: nice steps, max 3 per channel, labels clamped inside the channel's vertical bounds.
  A tick whose label rect would intersect the callout, another tick or the channel top 4 px is
  dropped. On `xs` too, labels sit in the right gutter (round 1).
- **Phase strip** is its own row, so ticks never reach it. **Rug** is its own row, so it never
  touches the callout.

#### 4.4.8 Interaction
- **Hover**: crosshair (1 px `--fg` 45 %) through all channels + time chip on the axis + footprint dot
  (3.5 px `--mem-py`) + **readout card** (glass, `--r-md`, max-width 320, flips to stay inside the
  card). Readout rows: time (`fmtTime`, 13 600); "Footprint 1.63 GiB (interpolated)"; "Threads 4.2
  busy · 0.4 waiting · 0.1 GIL"; "Tasks 17 suspended"; "Phase `for step in range(…)`"; "Main thread
  `train()` · train.py:173" + its source line (mono block); hint "Click to open the line · drag to
  select a range" (`--fg-3`). Rows appear only if their channel exists. 0 ms in, 90 ms out.
- **Click** (pointer moved < 4 px): `nav.jumpTo` the main thread's leaf py frame at that time (if any).
- **Drag** (≥ 4 px): brush `[t0, t1]` (fill `--fg` 8 %, edges 50 %), following the pointer with no
  easing. On release, the header shows the **range chip**: "12.0 s – 18.5 s · 6.5 s" + **Open in
  timeline** (emits `range:set` and scrolls to the Timeline, which zooms with M13) + × (clear).
- **Keyboard** (canvas `tabindex=0`): ←/→ move the cursor by 1 % of the domain (Shift: 10 %); Home/End;
  Shift+←/→ extend a range; Enter opens the line under the cursor; Esc clears the range, then the
  selection. Each cursor move updates the readout card (anchored at the cursor) and announces a
  short text through the polite live region: "31.2 seconds: footprint 1.63 GiB, 4.2 threads busy,
  main thread in train, train.py line 173".

#### 4.4.9 Motion (signature moment, M5 in §5)
On first load, a **phosphor beam** sweeps from left to right. The base layer is clipped to `x ≤ beam`.
The beam is a 1 px `--fg` line at 70 % with a 48 px trailing gradient in `--cpu-py` (alpha 0.18 → 0;
dark: `shadowBlur 10 × --glow`). The footprint trace, busy area, phase cells and TOP LINES bars appear
as the beam passes them. The **peak callout** fades in (140 ms) at the moment the beam crosses the
peak's x, because the peak is an event in time. Start at 120 ms, duration `--dur-sweep` (640 ms), easing
`1 − (1 − t)^2.2`, so the sweep ends by 760 ms. The final frame is identical to the static render.
Reduced motion: the static render on the first frame.

#### 4.4.10 Accessibility
`<figure>` with a visually hidden `<figcaption>` generated from the model: "Signal of the run over
54.1 s. Memory footprint rises to a peak of 3.11 GiB at 52.9 s. Up to 5 threads busy. The top line,
train.py:173, ran from 5.2 s to 54.0 s." The base canvas is `aria-hidden`. The interactive overlay
canvas has `role="application"`, `aria-roledescription="signal chart"`, `aria-label="Run signal"` and
`aria-describedby` pointing to the keyboard help text.

### 4.5 Hotspot ranking (`views/overview/hotspots.ts`)

#### 4.5.1 Header
Title "Hotspots" (`--type-title`) + two segmented controls (radiogroups): **kind** Lines | Functions |
Files; **metric** Time | Memory (if `caps.memory`) | GPU (if `caps.gpu`) | Await (if `caps.async`). On
`xs` both collapse into one `<select>` pair. A subtitle states the denominator and scale:
"by share of run time · bars scaled to #1"; Memory: "by peak attributed · peaks overlap, so they do
not add"; GPU: "mean util. while running · lines ≥ 1% of run"; Await: "by share of await time".

#### 4.5.2 Row anatomy (one line, 36 px; two-line 56 px on `xs`/`sm`)

| Part | Width (`lg`) | Content |
|---|---|---|
| Rank | 20 | numeral, mono 12 `--fg-3` (matches the TOP LINES gutter) |
| Meter | 72 (`xl` 96, `xxl` 120) | Time: Python/native/system segments; Memory: Python/native by `n_python_fraction`; GPU: absolute 0–100; Await: `--async`. Length **scaled to row #1** (GPU: to 100). 25/50/75 % graduations |
| Value | 56 | `fmtPct` / `fmtMem` (13 600 tabular, right-aligned) |
| Secondary | 52 | Time: seconds; Memory: "33.0% of alloc."; GPU: seconds; Await: "15.5 tasks" (`--fg-3`) |
| Code | flex (min 140) | Lines: highlighted source (mono 13, single line, fade-out at the right). Functions: "`train()`" (the canvas/headline form, round 1). Files: basename (mono) + dir (`--fg-3`, left ellipsis) |
| Badge | 0 or 72 (`xl+`) | one at most, priority: leak "↗ leak" > event loop "waiting" > GPU "GPU 96%" (when the metric is not GPU) > await > copy "copy 22.0 MiB/s" (`fmtRate`, the same text as the copy finding and code cell) |
| Location | 150 | Lines: "`train()` · train.py:173"; Functions: "train.py:124"; Files: peak memory. Left ellipsis on the path |

#### 4.5.3 List behaviour
- 8 rows (`short`: 5; `xs`: 3 + "Show top 8"). A footer row gives the **Pareto** total (Time and Await
  only): "Top 8 lines = **58.4%** of run time" ("Top file = …" for one item) + a cumulative bar (8 px,
  `--cpu-py` on `--sunken`, grows with M5 starting with the last row) + "17 more lines" (round 1:
  expands the same ranking in place, across files: 8 → 25 → 50 → "Show all N", plus "Show top 8";
  side by side the list keeps the card height and scrolls). Memory footer: "Sorted by peak.
  Peaks overlap in time, so they do not add."
- Changing tab or metric re-ranks with FLIP (M8): rows that persist slide to their new rank, meters
  morph, new rows fade in. The scope's TOP LINES channel updates at the same time.
- A row whose line is the event loop (async branch, §4.2.2) gets the badge "event loop · waiting"
  (must-fix 28).

#### 4.5.4 Interactions
- Hover or focus a row → `hover:line` (scope overlay §4.4.6, code row highlight if visible).
- Click / Enter → `nav.jumpTo({file, line}, {focus: true, open: true})` (Functions: the function header
  row; Files: the file's first hot line). `f` → "Show in stacks" (§4.11.6).
- `xs`: tap = jump.

#### 4.5.5 Motion
First load: meters grow from the baseline (`scaleX`, M6) with a 30 ms rank stagger (cap 8), so the
biggest lands first. Values do not count.

#### 4.5.6 Accessibility (must-fix 32)
`role="listbox"` with `aria-label="Hotspots: lines ranked by share of run time"`. Rows are
`role="option"` with `aria-label="1. loss_value = loss.item(), train.py line 173 in train, 21.4% of run,
11.6 seconds"`. There is one Tab stop: roving focus with ↑/↓, j/k, Home/End; Enter activates. Row
height ≥ 32 px (targets ≥ 24 px).

### 4.6 Findings (`views/overview/findings.ts`, rules in `model/findings.ts`)

#### 4.6.1 Card anatomy
Each finding is a card: 28 px icon tile (tinted with the finding's resource token at 14 %, icon in
that token) + title (14/20 600) + one factual sentence with numbers and at most one code chip
(13/20 `--fg-2`) + evidence ref ("train.py:173 ›"). At most **3** are shown, then "Show N more". **If
there are no findings, the Findings block is not rendered at all** (must-fix 17).

#### 4.6.2 Rules (deterministic; at most ONE card per rule except `leak` (≤ 3); shown in the table order)

| Id | Condition | Title | Sentence (template) | Severity |
|---|---|---|---|---|
| `gpu-sync` | line with `total ≥ 5`, `sys / total ≥ 0.5`, `gpu ≥ 50` | The host waits on the GPU | "`chip` takes **21.4%** of run time (11.6 s), 66% of it system time, while the GPU is **96.4%** busy — likely a host-device synchronization." | high |
| `loop-blocked` | `caps.async`; line with `coro` and `total ≥ 5` and `sys / total < 0.5` | CPU work blocks the event loop | "`hashlib.pbkdf2_hmac(…)` takes **21.6%** of run time inside a coroutine; the event loop cannot run other tasks meanwhile." | high |
| `leak` | each leak, by likelihood | Possible leak at metrics.py:42 | "`chip` grows about **5.71 MiB/s** (likelihood 99.7%); peak 614 MiB." | high |
| `peak` | `caps.memory`, `caps.peakLocation` | Memory peaks at 3.11 GiB | "at 52.9 s in `torch.save(…)` (train.py:120); this line's own peak is 1.20 GiB." | medium |
| `neuron-idle` | `caps.neuron`; line with `total ≥ 5`, device idle ≥ 60 %, and **recurring** work: ≥ 20 `cpu_samples_list` entries whose p90 − p10 spread is ≥ 25 % of elapsed (excludes one-time setup such as imports and model loading) | The accelerator idles during recurring work | "`tokenizer(…)` takes **11.4%** of run time with the device idle in **100%** of its samples, throughout the run." | medium |
| `gil` | GIL lane ≥ 2 % of samples | Threads wait for the GIL | "**x%** of samples are waiting to take the GIL; the busiest waiting thread is thread 2." | medium |
| `copy` | line with `n_copy_mb_s ≥ 10` | Heavy copying | "`chip` copies **22.0 MiB/s** on average — check Python↔native conversions." | medium |
| `native` | native share of program ≥ 60 % | Most time is in native code | "**61.9%** of run time is native. Python-level edits help less; see which native calls in Call stacks." | low |
| `python` | Python share ≥ 60 % and program total ≥ 50 % | Python interpreter time dominates | "**94.3%** of run time runs in the interpreter; vectorizing the hot loop would help most." | low |

Within a rule, the instance with the largest `total` wins (leaks: highest likelihood first). The
display order is the table order (high → medium → low), and the first 3 are shown. Thresholds are
constants in `model/findings.ts` and are unit-tested on the fixtures (Appendix A lists the expected
finding ids per fixture).

#### 4.6.3 Interactions
Hover or focus → `hover:line` (scope overlay + hotspot highlight). Click the card or its ref →
`nav.jumpTo`. Findings are a `role="list"` of `article`s. The card is not a button; the ref and the chip
are buttons.

### 4.7 File navigator (`views/code/filenav.ts`)

- **Data**: visible files sorted by `percent_cpu_time` desc (ties: name). Hidden files (rule §4.0.4)
  form a separate group, also sorted. `File.no` = upstream `fileIteration` (1-based index over **all**
  files in that order, hidden ones included), used for `file-N` ids and `proposeOptimization*` globals.
- **Entry content**: basename (mono 13, `--fg`; 600 when active) · mini split bar 32 × 4 (Python /
  native / system of the file, length = file share / max file share) · "58.8%" (12.5 tabular) ·
  "peak 1.20 GiB" (`fmtMem` with its label, `--fg-3`, only if `caps.memory` and > 0; round 1: a bare
  size did not say what it measures) · leak icon (`--danger`) if the file has leaks ·
  NRT/NC share (Neuron). Full path and the "% of run · s of s" sentence are in the tooltip.
- **Tabs** (`md`–`xl`): `role=tablist`, one row, horizontal scroll **inside** the strip
  (`overflow-x: auto`, thin scrollbar, 24 px fade masks at the edges, ‹ › buttons when overflowing). The
  active tab has a 2 px `--fg` underline. The last item is "All files ▾": a menu with a filter field
  listing every file, plus the hidden group "16 files below 1% of time · little memory".
  Automatic activation on arrow keys (switching is cheap).
- **Rail** (`xxl`): 280 px column, `role=listbox`, two-line entries (basename + share / dir + peak),
  sticky (`top: var(--appbar-h) + 8`, own scroll, max-height `100vh − appbar − 16`). The hidden group is
  collapsed at the bottom: "16 files below 1% of time with little memory · Show".
- **Switcher** (`xs`, `sm`, `short`): a button "train.py · 58.8% ▾" that opens a file sheet (`xs`:
  bottom sheet; `sm`: popover; `role=dialog`, focus-trapped, Esc) listing all files with the same
  entry content.
- **Switching file**: the code body cross-fades in 120 ms (M10, opacity only). The selection is
  cleared unless the switch is part of a `jumpTo`. The per-file display mode, sort and unfolded folds
  are kept in the store (per file).
- Upstream "first file expanded" maps to: the highest-share visible file is the current file on load.

### 4.8 Code view (`views/code/codeview.ts`, `columns.ts`, `minimap.ts`)

#### 4.8.1 Anatomy (top → bottom)
1. **Section header**: `h2#code-h` "Code" + description "6 files · bars scaled to the hottest line
   (21.4% of run)".
2. **Toolbar** (wraps on narrow widths, never overflows): view **Lines | Functions** (radiogroup);
   display mode **Hot + context | Hot only | All lines** (radiogroup; round 1 renamed "Profiled
   functions | Hot lines", which read as a functions list next to Lines | Functions). Each has a
   tooltip that states the §4.0.4 predicate with the profile's own activities: "Hot lines with more
   than 1% of run time, or any memory or GPU activity, plus every other line of the functions that
   contain them. The rest is folded." / "Only hot lines with … The rest is folded." / "Every line of
   the file."; **Wrap long lines** toggle (default on for `xs`, off elsewhere; per viewer in
   localStorage `scalene-code-wrap`); when ranked: chip "Ranked by Time ↓" + "Source order ↺" button.
3. **File navigator** (§4.7).
4. **File bar** (sticky under the app bar, 40 px, `--surface` at 92 % + blur, bottom hairline): dir
   (`--fg-3`, left ellipsis) + **basename** (mono 600) · split meter 80 × 6 + "**58.8%** of run · 31.8 s of
   54.1 s" · "peak 1.20 GiB" · "GPU mem 8.62 GiB" · "NRT 37.8% · NC 33.2% of run" (Neuron, file totals) · "2 leaks" ·
   "193 lines, 41 shown" (`--fg-3`). Items drop from the right as width shrinks; the tooltip on the
   path always has all of them. The bar is the table's `aria-describedby`; the path is a Tab stop
   (`role="group"`, named by the full path) only while its directory is ellipsized (round 1).
5. **Column header** (sticky below the file bar, 32 px): two-line headers (§4.8.3).
6. **Body** (virtualized, §4.8.10) + **ribbon** at the right (§4.8.9) + **dock** at `xl+` (§4.9).

#### 4.8.2 Item kinds

| Kind | Height | Content |
|---|---|---|
| `line` | `--row-h` (× wrapped lines when wrapping) | metric cells + source |
| `fold` | `--row-h` | worded by content (round 1): nothing sampled → "⋯ 15 lines without samples · 1–15"; otherwise "⋯ 32 lines below 1% each · 19–50 · together 0.2% of run" (one line: "1 line below 1% · 95 · <0.1% of run"; "at most 1%" when a line is exactly 1.0%). `--fg-3`, full-width button, `aria-expanded="false"` |
| `gap` (sparse profiles only) | `--row-h` | "⋯ 7 lines not in this profile · 5–11", not interactive |
| `fnHeader` | 32 | ƒ icon + qualname (mono 600) + meter (function total / max function total) + "47.1% of run · 25.5 s" + "peak 2.01 MiB" + "GPU 81.8%" + "await 4.0%" + "coroutine" badge; selectable (detail shows the function aggregate) |
| `lens` | measured | detail panel in lens form (§4.9), directly after the selected item |
| `aiCard` | measured | AI proposal card (§4.14.3), directly after its anchor line (after the lens if both) |

Function headers appear only in source order, before the row at `functions[].lineno` (the decorator
line for decorated functions).

#### 4.8.3 Columns (shown only when the profile has the data AND the width allows)

| Key | Header (name / unit line) | Width | Present when (profile) | Priority (lower = kept longer) | Sortable key |
|---|---|---|---|---|---|
| `line` | # | 52 | always | 0 | lineno (= source order) |
| `time` | TIME / % of run | 124 (meter 64 + value 52) | always | 1 | `total` |
| `mem` | MEMORY / peak | 132 (meter 56 + value 68) | `caps.memory` | 2 | `n_peak_mb` |
| `gpu` | GPU / % busy | 104 (meter 40 + value 56) | `caps.gpu` | 3 | `n_gpu_percent` |
| `await` | AWAIT / % of await | 112 | `caps.async` | 3 | `n_async_await_percent` |
| `idle` | IDLE / device | 84 | `caps.neuron` | 3 | `100 − overlap` |
| `nrt` | NRT / % of run | 112 | `caps.neuron` | 4 | `nrt_time_ms \|\| nrt_percent` |
| `nc` | NC / % of run | 112 | `caps.neuron` | 5 | `nc_time_ms` |
| `trend` | FOOTPRINT / when it allocated | 76 | `caps.memory` | 6 | not sortable |
| `copy` | COPY / MiB/s | 84 | any line `n_copy_mb_s ≥ 1` | 7 | `n_copy_mb_s` |
| `gpumem` | GPU MEM / peak | 84 | `caps.gpu && caps.gpuMemory` | 8 | `n_gpu_peak_memory_mb` |
| `alloc` | ALLOC / % of all | 80 | `caps.memory` | 9 | `n_usage_fraction` |
| `avg` | AVG / per episode | 80 | `caps.memory` | 10 | `n_avg_mb` |
| `source` | SOURCE / train.py | flex, min 640 (`lg+`), 420 (`md`, `sm`; 400 in `short`), 160 (`xs`) (round 1: the code is what people read) | always | – | not sortable |

**Width budget**: `available = bodyWidth − ribbon`. Add columns in priority order while
`Σ widths + next ≤ available − sourceMin`. Recompute on resize (`ResizeObserver` on the body, not
the window). On `xs`, `time` shrinks to 72 (24 px meter + value). Dropped columns are always in the
detail panel. The header tooltip carries the full explanation from §4.0.3. Every header is a Tab
stop: sortable ones are buttons; FOOTPRINT and SOURCE are focusable info headers whose definition
shows on focus, hover and tap and is their `aria-description` (round 1). Re-rendering the header
(sort, resize) keeps focus on the same column's control. ml-training: 1440 → line … gpumem (source
662 px), 1024 → line … trend (438 px), 1000×400 → line … trend (470 px), 2560 → all.

#### 4.8.4 Cells (exact)

| Column | Content | Empty when | Tooltip |
|---|---|---|---|
| `line` | right-aligned mono 12; `--fg` on data rows, `--fg-3` otherwise. A button: `vsNavigate(file, line)` | never | "Open train.py:173 in the editor" |
| `time` | segmented meter (Python / native / system hatch) scaled to `model.maxLineTotal` (profile-wide) + `fmtPct(total)` | `total = 0` | "21.4% of run · 11.6 s — Python 0.1% · native 7.2% · system 14.1%" |
| `mem` | meter: Python/native by `n_python_fraction`, length `n_peak_mb / max_footprint_mb`, with a 1 px `--fg-2` tick at `n_avg_mb` + `fmtMem(n_peak_mb)` + leak icon | `n_peak_mb = 0` | "peak 1.20 GiB attributed to this line · avg 1.20 GiB · Python 1.0%" |
| `trend` | 64 × 16 sparkline (§3.3), shared scales; `--danger` + leak icon if leak | no `memory_samples` | "program footprint at each of this line's 100 allocation/free events" |
| `avg` | `fmtMem(n_avg_mb)` | 0 | "average per-episode high-water mark" |
| `alloc` | `fmtPct(100 × n_usage_fraction)` | `< 0.01` | "33.0% of all allocation in the program (1.20 GiB allocated here)" |
| `copy` | `fmtRate(n_copy_mb_s)` | `< 1` | "22.0 MiB/s copied, averaged over the run" |
| `gpu` | absolute 0–100 meter `--gpu` + `fmtUtil` | `< 1` | "GPU 96.4% busy while this line ran (time-weighted)" |
| `gpumem` | `fmtMem(n_gpu_peak_memory_mb)` | `< 1` or util `< 1` | "peak device memory of the process while this line ran; avg 5.88 GiB" |
| `await` | meter `--async` scaled to max line await + `fmtPct` | `< 1` | "35.8% of await time · 15.5 / 22 tasks suspended" |
| `idle` | band glyph (● ◆ ▲, colour per §3.2) + `fmtPct(100 − overlap)` | overlap undefined, or (`total < 1` and no NRT) | "12.4% of this line's CPU samples had the device idle (medium)" |
| `nrt` | meter `--gpu-mem` (`nrt_time_ms / (elapsed × 1000) × 100`) + `fmtPct` | `nrt_time_ms = 0 && nrt_percent = 0` | "9.69 s in Neuron Runtime · 98.0% of all NRT time · 1,200 executions" |
| `nc` | meter `--gpu` + `fmtPct` | `nc_time_ms = 0` | "8.50 s NeuronCore busy · ratio NC/NRT 0.88" |
| `source` | highlighted code (§4.0.5), docstrings italic; wash (§4.8.6); right-aligned actions on hover/focus/selection (§4.8.7); unwrapped lines wider than the box (`is-clipped`, from the column count) fade out over the last 28 px, never a hard cut | – | clipped lines: full text |

#### 4.8.5 Display modes and folds (upstream predicates, §4.0.4)

| Mode | Data rows | Function-context rows | Other rows |
|---|---|---|---|
| Hot + context (default, `profiled-functions`) | shown | shown | folded |
| Hot only (`profiled-lines`) | shown | folded | folded |
| All lines (`all`) | shown | shown | shown |

- Every run of consecutive hidden lines becomes one `fold` item (even a single line). Clicking or
  pressing Enter on it reveals **only that fold** (stored per file until the mode changes) and moves
  focus to its first line. Nothing is ever hidden silently.
- `expandAll()` sets every file to All lines. `collapseAll()` sets every file to Hot only.
- `onFileDisplayModeChange("file-N")` reads `#display-mode-file-N` (the current file's mode
  radiogroup carries that id and a `value` property) and applies it.

#### 4.8.6 Heat wash
- The **heat metric** is the active sort column if it is `time`, `mem`, `gpu` or `await`; otherwise
  `time`.
- `--heat` on the row = `value / maxValueInProfile`, floored at 0.25 when the row passes the
  threshold (§4.0.4), else 0. The source cell's `::before` paints `var(--wash-<metric>)` with
  `opacity: var(--heat)` (opacity on a background pseudo-element, **never on text**). A metric change
  cross-fades `--heat` over 200 ms (M15).

#### 4.8.7 Row actions and AI affordance
On hover, focus or selection (never on every row at once), the right end of the source cell shows a
compact action group on a `--surface` → transparent 24 px gradient: **✦ Optimize** (only when
`availability.line`), **✦ Region 152–184** (only on the region's first line when
`availability.region`), and **⋯** (open details). Buttons are 22 px tall (24 on coarse pointers), 12 px
text. There are no emoji and no invisible placeholders, so the source alignment never shifts.
Keyboard: `o` = Optimize line, `Shift+O` = Optimize region, Enter = details.
The group never hides code (round 1): when its buttons would overlap the line's text, the row shows
a compact icon-only group (✦ ⋯, tooltips name them) instead, and none while that row's detail panel
(lens or dock) is open, since the panel carries the same actions.

#### 4.8.8 Sorting (ranking)
- Click a sortable header: 1st click **descending**, 2nd ascending, 3rd → source order. Clicking `#`
  → source order. `aria-sort` on the `columnheader`; ↓/↑ icon in the header.
- Ranked mode lists the **visible rows of the current display mode** sorted by key (ties: lineno).
  Rows whose key is 0 or absent go last in both directions (upstream reversed them). Folds and
  function headers are removed, and line numbers stay visible, so context is never lost. Lens and AI
  cards follow their row.
- Rows in or near the viewport (≤ 60) animate with FLIP (M9). Others jump. Reduced motion: instant,
  plus a 1.5 s `--select` highlight on the row that had focus.

#### 4.8.9 Ribbon minimap (graft from C; current file only)
- 56 px wide (`md` 48) at the right edge of the body, sticky (`top` = sticky chrome, height = visible
  code viewport). Hidden on `xs`, `sm`, `short`, and in the empty state.
- Drawn on canvas: one row per source line of the file (`row = H / nLines`, clamped 0.25–4 px; several
  lines per device pixel aggregate by max). Left 10 px: memory peak marks (`--mem-py`, length ∝ peak /
  file max). Middle 8 px: a neutral code silhouette (indent + length, `--line-strong`). Right 34 px:
  heat bars of the heat metric (Python/native/system for time), length ∝ value / file max.
- **Rank pins**: global hotspot ranks (current hotspot list) for lines in this file. 14 px circles
  (`--fg` fill, `--surface` numeral), de-overlapped by moving down in steps of 15 px with a 1 px leader
  line. Pins never cover the file label or another pin.
- **Viewport window**: a rounded rect (`--fg` 10 % fill, 1 px `--fg` 40 %) spanning exactly the first
  to last **line** item visible in the body (lens and AI cards are excluded). Hidden in ranked mode.
- Interaction: click or drag to scrub (scrolls the page so that line is centered, instant). Hover
  shows a tooltip: line, code, value.
- ARIA: `role="slider"`, `aria-label="Hot lines in train.py"`, `aria-valuemin=1`,
  `aria-valuemax=nLines`, `aria-valuenow` = the line at the window center (same scale),
  `aria-valuetext="train.py line 173, 21.4% of run"`. ←/→/↑/↓ step through **hot lines** (data rows,
  in line order), PageUp/PageDown move 10 % of the file, Home/End go to the first/last line, Enter
  calls `jumpTo` for that line.

#### 4.8.10 Virtualization (must-fix 18)
- The window scrolls (no nested vertical scroll). `body.style.height` = Σ item heights.
- Heights are deterministic: `line` = `rowH × max(1, ceil(textCols / colsPerLine))` when wrapping
  (`colsPerLine` = `floor(sourceWidth / charWidth)`, with `charWidth` measured once per theme/font),
  else `rowH`; `fold`/`gap` = `rowH`; `fnHeader` = 32; `lens`/`aiCard` = measured with
  `ResizeObserver` (estimates 280 / 140 until measured). Offsets are kept in a `Float64Array` prefix
  sum and recomputed in O(n) on change.
- Render the items intersecting `[viewportTop − 600 px, viewportBottom + 600 px]` (binary search on
  offsets), positioned with `transform: translateY()`, from a **node pool** keyed by item kind (no
  per-scroll allocations). Scroll and resize handlers are rAF-throttled.
- Budget: ≤ 160 rendered items; ≤ 2,500 DOM nodes in the code view; scroll at 60 fps on the 1,455-line
  `sparse.py` in huge.json.

#### 4.8.11 Accessibility (must-fix 24)
- `role="table"` on the code view root with `aria-label="Line profile of train.py"` and
  `aria-rowcount` (all row items, counted as if rendered). Header row: `role="rowgroup"` > `role="row"`
  > `role="columnheader"` (with a `<button>` inside for sortable ones; `aria-sort` on the columnheader).
  Body: `role="rowgroup"`; each rendered row is `role="row"` with `aria-rowindex`, and its cells are
  `role="cell"`.
- Each line row has an `aria-label` summarising its present columns:
  "Line 173, 21.4% of run time, GPU 96.4% busy, peak memory none sampled: loss_value = loss.item()".
- One Tab stop for the body: roving `tabindex` on rows. ↑/↓ and j/k move; PageUp/PageDown move by a
  page; Home/End go to the first/last row; Enter or Space toggles the detail; `e` open in editor; `o` /
  `Shift+O` optimize line/region; `s` show in stacks; `t` show in timeline; Esc closes the lens, then
  clears the selection. Fold rows: Enter reveals. Focus never lands on an off-screen row: moving
  focus scrolls it into view first.

#### 4.8.12 `jumpTo(target, opts)` — the one navigation function (must-fix 16)
`target = {file, line} | {file, fn: qualname}`; `opts = {focus = true, open = true, flash = true,
source}`.
1. If the file is not current, switch to it (reveal the hidden group if needed).
2. If ranked and the target row is not in the ranked list, return to source order.
3. If the row is folded, reveal its fold (the mode does not change; upstream switched to "all").
4. Scroll so the row is centered in the code viewport (smooth; reduced motion: instant).
5. Flash the row (`--flash` → transparent, 1.2 s, M14).
6. Select it in the store; open the detail if `open` (lens or dock).
7. Focus the row (`preventScroll`) if `focus`.
8. Announce: "train.py line 173 selected: 21.4% of run time" (polite).
Every entry point uses it: hotspots, findings, headline chips, palette, scope click, phase cells, flame
double-click / Enter, timeline click, memory sites, minimap, `vsNavigate` (outside VS Code).

- **Way back** (round 1): `showInStacks` / `showInTimeline` record where they started (the selected
  code row when focus or the viewport is in Code, else the scroll position and focused control),
  push a same-document history entry (`replaceState` for repeated jumps) and show a pill
  "← Back to train.py:173" at the bottom centre (`views/shell/returnchip.ts`). The pill and
  browser Back return there; it hides on use, ×, Esc, any `jumpTo`/`showSection` and on load.
  App-bar nav, the Sections menu and the palette's "Code" call `showSection("code", { toSelection })`,
  which returns to the selected row instead of the section top.

### 4.9 Detail panel: dock (`xl+`) and lens (below) (`views/code/detail.ts`)

One component with two layouts. Content is built from a `line`, a `fnHeader` (function aggregate) or
a function-view row.

| Layout | Where | Size | Behaviour |
|---|---|---|---|
| **Dock** | right column of the code section (`xl`: 380, `xxl`: 420) | sticky under the chrome; max-height `100vh − chrome − 16`; own scroll | empty state: "Select a line to see every metric, its call context and AI options" + key hints |
| **Lens** | inline item after the selected row | full table width; grid of 3 columns (`md`, `lg`), 2 (`sm`, `short`), 1 (`xs`) | opens with M16 (rows below slide down 200 ms; content fades in 140 ms); closing reverses; Esc or × closes |

**Head**: `file:line` (mono 600) · "in `train()`" · "region 152–184" · badges (possible leak,
coroutine, event loop) · actions: **Open in editor** (`host.openInEditor`), **Show in stacks**,
**Show in timeline** (if the line has timeline frames), × close. Below: the source line, highlighted,
wrapped.

**Blocks** (each only if it has data; a block whose fields are absent says "not recorded"):

| Block | Content |
|---|---|
| **Time** | "**21.4%** of run · 11.6 s" (20/26 600); split bar (8 px) + legend with values "Python 0.1% · native 7.2% · system 14.1%"; "cores busy while it ran 1.2% of all cores" (`caps.coreUtil`); "Region 152–184: **43.4%** of run" (multi-line regions) |
| **When it ran** | raster of `cpu_samples_list` (relative s) on `[0, tMax]`, 32 px tall, with 0 and `tMax` labels; caption "500 main-thread samples (Scalene keeps up to 500 per line)". Without samples but with CPU time (`total > 0`): "no main-thread samples (worker thread or native only)"; with no CPU time at all the block is omitted (the Time block already says so; round 1). Not shown for functions (always empty upstream) |
| **Memory** | rows: peak (with Python share), average per episode, allocated over the run (`n_malloc_mb`), share of all allocation, allocation episodes (`n_mallocs`), copy rate. **Footprint chart** (graft from C): program footprint (`samples`) as a `--line-strong` area, this line's `memory_samples` as 3 px `--mem-py` dots on the same `[0, tMax] × [0, max_footprint_mb]` scale, with axes (2 ticks each) and the caption "Program footprint (grey) and the moments this line allocated or freed (dots)". Leak: danger callout "Possible leak · grows ~5.71 MiB/s · likelihood 99.7%". No allocations: "No allocations sampled on this line." |
| **GPU** | "**96.4%** busy while this line ran (time-weighted)"; device memory peak / avg (process) |
| **Async** | "**35.8%** of await time"; "15.5 tasks suspended on average, 22 at most"; "coroutine" flag; task-name chips (first 12, then "+N more" expands; note "Scalene keeps up to 100 names") |
| **Neuron** | NRT time + % of run + share of NRT + executions; NC time + % of run + NC/NRT ratio; device idle with band glyph and word (low/medium/high); kernel (`nrt_source_code`, mono, middle ellipsis) |
| **Call context** (`caps.stacks`) | "In **1,157** of 5,901 stack samples (19.6%)"; **Calls into** (top 4: name + share bar of those samples); **Called from** (top 2: caller frame + file:line). Each entry is a button that opens Stacks focused on it |
| **AI** (footer) | **Optimize line** / **Optimize region a–b** (when eligible) + provider status ("Anthropic · claude-sonnet-4-5" or "No AI provider set up") + **AI settings**. The result card appears below the panel content (lens) or at the bottom of the dock |

For a function: head "ƒ `train()` · train.py:124–189"; Time (no region), Memory (footprint chart from
the function's merged `memory_samples`), GPU, Async; no "When it ran" and no AI (upstream offers AI
on lines only); a **Go to source** button.

ARIA: the lens is `role="region"` with `aria-label="Details for train.py line 173"`. The dock is an
`aside` with the same label. Opening never steals focus from the row; Tab from the row enters the
panel.

### 4.10 Function view (`views/code/functions.ts`)

- The **Functions** view of the code section lists `files[current].functions` (qualnames) in a table
  with the same column system (`line` column shows the first line; `source` shows "ƒ qualname" and the
  def line's code, dimmed by colour token `--fg-2`, not opacity). There is no `trend` column unless
  functions have `memory_samples`.
- Default sort: Time descending. Header sorting as §4.8.8 (3rd click → by first line).
- Click or Enter on a row → switch to Lines and `jumpTo({file, fn})` (selects the function header row
  and opens its aggregate detail).
- Empty (`functions` is `[]`): "No function summaries in this profile. Module-level code only, or an old
  Scalene version." plus a button to the Lines view.

### 4.11 Flame graph: call stacks and memory stacks (`views/stacks/flame.ts`)

#### 4.11.1 Section anatomy
`<section id="stacks" class="combined-stacks-section">`. Header: `h2` "Call stacks" + tabs
**CPU | Memory** (`role=tablist`; a tab exists only if its data exists; with one tab there is no
tablist and the title is "Call stacks" or "Memory stacks").
- CPU description: "336 stitched Python + native stacks · 5,901 samples · width = share of sampled
  stacks, not of run time".
- Memory description: "30 allocation stacks · 3.17 GiB attributed · width = share of attributed
  allocation (cumulative volume, not live size)".

#### 4.11.2 Toolbar (one row, wraps on narrow widths)
- Search field ("Find function or file", 280 px; `xs` full width). With focus inside the section, `/`
  focuses it (elsewhere `/` opens the palette). Case-insensitive substring over `display_name` and the
  basename of `filename_or_module`.
- Match summary chip: "Matched **23.4%** of samples · 12 frames" (share = Σ hits of stacks with ≥ 1
  matching frame ÷ Σ hits) + ‹ › buttons that cycle the focused match. No match: "No frames match".
- Colour mode `<select>`: Kind / File / Self (Memory: File / Self; default Self). See §3.4.
- Legend chips for the active mode (Kind: Python · native · await · unresolved). Hovering a chip
  outlines the frames of that kind.
- **Reset zoom** button (only when zoomed).

#### 4.11.3 Breadcrumb (28 px, only when zoomed)
"All stacks › `<module> :193` › `train() :173`": each crumb is a button that zooms to that node. It is
`nav aria-label="Zoom path"`, and the last crumb has `aria-current="true"`.

#### 4.11.4 Axis and grid (graft from B; must-fix 19)
- Top axis (24 px, `--type-caption`, tabular) with nice ticks across the **current domain re-based to
  0–100 %** of the focused frame. At the right end: "% of `train:173` (14.9% of all stacks)" when
  zoomed, "% of all sampled stacks" at the root.
- Memory tab: a **MiB axis** over `[0, focused MiB]` with `formatMemoryTickLabel` and binary nice
  steps. Its wrapper element has the class `memory-axis`, and the gridline layer has the class
  `memory-gridlines` (upstream test literals). The CPU axis wrapper is `flame-axis`.
- Hairline gridlines (`--grid`) at each tick through the whole chart.
- Label thinning (round 1): labels thin by nested strides of nice ticks anchored at 0 (×1, 2, 10, 20,
  100 …, each dividing the next, chosen from the current tick spacing), so a zoom only adds or removes
  whole subsets; a change of the shown set fades over `--dur-1` (90 ms; instant under reduced motion).
- The axis caption names no unit on the Memory tab ("attributed allocation", "in `save_checkpoint()
  :120` (36.8% of attributed allocation)"): the ticks carry one unit per axis (§4.0.2).

#### 4.11.5 Frames
- Icicle (root at top), children heaviest-left (§4.0.7 tree). Row height 20 (19 + 1 px `--surface`
  gap; `xs` 22, `short` 18). Root row "All stacks · 5,901 samples" (`--frame-root`).
- `x = (node.x0 − d0) / (d1 − d0) × W`. Skip frames < 0.5 px. Frames < 2 px have no gap.
- **Label** when width ≥ 40 px: py → `train() :173` (function, then line; `<module> :193` for
  non-identifiers), never `train:173`. Fitting: drop ` :line`, then `()`, then truncate; native names
  drop collapsed `(…)`/`<…>` groups before one middle cut; a truncated label keeping fewer than 6 real
  characters is dropped (hex ips too). Native → the simplified C++ name (template
  arguments `<…>` and parameter lists `(…)` collapsed to `<…>`/`(…)`), middle-truncated with
  `measureText`; unresolved → `0x7f3e4bf52287` (hex `ip`). Font: mono 12 (§3.5 canvas rules), colour =
  the mode's label ink.
- Height = all depths (ml-training 19 rows ≈ 404 px; huge 38 rows ≈ 784 px). Above 60 rows the chart
  gets an internal vertical scroll with a 24 px fade at the bottom (documented deviation from upstream's
  resizable container; parity row "Resizable charts").

#### 4.11.6 Interactions
- **Hover** → tooltip: kind chip ("PYTHON FRAME" / "NATIVE FRAME" / "AWAIT" / "UNRESOLVED"), full
  name (mono, wraps), `file:line` or module path (`--fg-3`), "**14.9%** of sampled stacks · 878
  samples" (Memory, frame `save_checkpoint:120`: "**1.17 GiB** · 36.8% of attributed allocation"), "self 0.5% · 100% of caller",
  then the source line (py frames, from `makeFileSourceLookup`; a file not in `files` → "source not in
  this profile"), and the hint "Click to zoom · double-click to open the line". Instant in, 90 ms out.
- **Click** → zoom (M11): the domain tweens to `[node.x0, node.x1]` over 280 ms. Ancestors stay as
  full-width rows above, dimmed. Siblings slide off the edges (a consequence of the linear domain).
  The axis re-bases and the breadcrumb updates.
- **Lateral zoom** (target not a descendant of the current focus): staged (M12), first zoom out to
  the common ancestor (280 ms), then in (280 ms).
- **Double-click** a py frame with a line → `nav.jumpTo`. Native frames do nothing (tooltip only).
- Esc / Backspace → zoom out one level; Reset → root.
- **Linked**: `hover:line` from any view outlines (overlay canvas) every frame whose py frame is that
  `file:line`. **Show in stacks** (code view, hotspot `f`, detail panel) → CPU tab, zoom to the
  **parent** of the heaviest node of that line (so the line and its callees are visible), focus that
  node, scroll the section into view, and show the Show-in caption (§4.12.3).
- **Touch / pen** (round 1): a tap selects a frame (focus outline + pinned details card: kind, name,
  location, shares, source, "Zoom in / Zoom out", "Open line", ×) and announces it; a second tap on
  the same frame zooms. No hover tooltips on touch; double tap never resets or jumps.

#### 4.11.7 Keyboard and announcements
The canvas has `tabindex=0`, `role="application"`, `aria-roledescription="flame graph"` and
`aria-describedby` pointing to the help text. Focus starts at the root. ↑ parent; ↓ heaviest child;
←/→ previous/next sibling (if none, the nearest frame at the same depth); Enter zoom; Esc zoom out;
`g` go to source (py); Home → root. The focused frame gets a DOM overlay
`<div class="flame-segment flame-focus">` (2 px `--focus` outline) positioned over it. Each move
announces (polite): "train, train.py line 173, Python frame, 14.9% of sampled stacks, 878 samples,
depth 2 of 19". Once a zoom settles (debounced ≥ 150 ms; round 1): "Zoomed into train, train.py line
165, 14.9% of samples" / "Zoomed out to All stacks".

#### 4.11.8 Motion
First reveal (when the section first enters the viewport): rows appear depth by depth from the root
(clip + opacity, 220 ms + 14 ms × depth, total cap 600 ms, M17). Zoom 280 ms `--ease-standard`, and
cancellable (a new zoom starts from the current interpolated domain). Search dimming 90 ms. Reduced
motion: all instant.

#### 4.11.9 Performance
The tree is built lazily (first intersection or `requestIdleCallback`), in slices of ≤ 8 ms. Nodes
are stored per depth in arrays sorted by `x0` (binary-search hit testing). A draw touches only visible
rows and frames ≥ 0.5 px. The overlay canvas is used for hover, focus and search outlines. Budget:
≤ 6 ms per base draw on huge.json (3,183 stacks, depth 38).

### 4.12 Timeline (`views/timeline/timeline.ts`)

#### 4.12.1 Header and controls
`h2` "Timeline" + description "4,933 sample runs over 54.1 s · 5 threads · x = time, rows = stack
depth". Controls (wrap on narrow widths): view **Lanes | Interleaved** (radiogroup, only with > 1
thread); thread filter `<select id="timeline-view-mode">` (All threads / main / thread 1 … /
unknown; only with > 1 thread; "unknown" works, which fixes upstream); zoom − / + / **Reset**; range
label "0 s – 54.1 s" (tabular; below 1 s of span both ends get enough decimals to differ:
"28.400 s – 28.440 s"); legend chips (Python frame, native frame, await, GC, I/O & waits, GIL, and
"mixed short frames" with the `--frame-lod` swatch and a tooltip whenever the profile has more than
one frame kind). A footnote under the chart: "Runs end at the thread's next sample or after count ×
10 ms. Thread activity may be offset from the memory axis by up to one sampling interval. Frames
narrower than a pixel take the color of the kind that fills most of that pixel; grey marks mixed
kinds (zoom in to separate them)."

#### 4.12.2 Rows (gutter `lg` 168, `sm` 120, `xs` labels above rows)

| Row | Height | Content |
|---|---|---|
| Axis | 24 | wrapper class `timeline-axis`; ticks via `pickNiceTickInterval` on the visible domain, labels via `formatTimelineTickLabel`; gridline layer class `timeline-gridlines` (1 px `--grid` through all rows) |
| Memory (`caps.memory`) | 56 | footprint area on the same time domain + peak dot; gutter "Memory · peak 3.11 GiB" |
| GC · I/O & waits · GIL | 12 each (+ 2 gaps) | bars over classified runs: GC `--gc`, I/O & waits = waiting hatch, GIL `--gil`; gutter "GC 0.6% of samples" etc. (from `laneTotals`). The three gutter labels are one focusable group (`.tl-class-group`, ≥ 40 px) whose tooltip (focus, hover or tap) lists the three shares and definitions |
| Threads column header (round 1) | 16 | with several lanes beside a gutter: "Threads · % of samples" above the lanes; every lane header then shows its bare share ("2.5%"); full-width (`xs`) label rows say "2.5% of samples" |
| Thread lane header | 24 (32 under `pointer: coarse`) | chevron + name ("main", "thread 1"…) + share (+ thread colour chip in Interleaved); a collapsed lane is one header tall; "+ show all N levels" has the same height and keeps focus on the rebuilt toggle |
| Thread lane body, expanded | 12 per depth | frames by depth (Kind palette, §3.4), label ≥ 40 px (mono 11). Main is expanded by default up to 16 rows (`xs` 8, `short` 6), then a "+ show all 19 levels" gutter button |
| Thread lane body, collapsed | 16 | activity strip: per pixel column, a bar of height ∝ covered fraction, coloured by the majority leaf kind |

- Gutter sub-labels are `--type-caption` (12/16; class-row shares 11/14), never 10.5 px (round 1).
- **Lanes** (default with > 1 thread): one lane per thread in the order main, unknown, then by first
  appearance. Workers start collapsed; clicking a header (or Enter on it) toggles it.
- **Interleaved** (upstream parity): one panel; frames of all threads are drawn by depth, with a 3 px
  left border in `--thread-k` (5 slots, then `--thread-other`; colours never cycle back onto main).
- **Thread filter**: lanes and GC/I/O/GIL bars are restricted to that thread. An empty result shows
  "No samples for this thread".
- Frames per (thread, depth) merge when consecutive runs have the same frame key (`py:file:line` /
  `native:module:name`) and touch (upstream rule, with our run ends). LOD: sub-pixel runs accumulate, per device-pixel column and depth, the time each frame kind covers; the
  column takes the fill (and hatch) of the kind covering ≥ 60 % of it, a 50/50 OKLab mix of the two
  largest kinds when they cover ≥ 80 % together, else `--frame-lod` ("mixed short frames"). Touching
  columns of one colour are painted as one rect; the 1 px `--surface` gap rule for frames ≥ 3 px is
  unchanged (round 1: the old "one `--frame-lod` column per pixel" rule painted ~74 % of the
  ml-training main lane grey).

#### 4.12.3 Interactions
- **Hover**: crosshair through all rows + time chip on the axis + footprint dot on the memory row +
  tooltip: kind chip, name, `file:line` / module, "main (id 139872518063936)", "2.870 s – 53.900 s ·
  51.0 s", "5,103 samples", source line (py, via `sourceLookup`).
- **Click** (moved < 4 px) on a py segment → `nav.jumpTo`. **Drag** → brush; on release the domain
  tweens to the range (M13). Double-click, Esc or `0` → reset.
- Ctrl/⌘ + wheel zooms at the pointer (×1.25 per notch). Shift + wheel or horizontal wheel pans. A
  plain vertical wheel scrolls the page (never hijacked).
- Keys when the canvas has focus: W/S or +/− zoom at the crosshair (or center); A/D or ←/→ with Alt
  pan 10 %; ↑/↓ move the focused row (through lanes and depths, skipping empty ones); ←/→ previous/next
  segment in the row; Enter → go to source (py); Shift+Enter → zoom to the segment. Each move
  announces: "train, train.py line 124, main thread, 2.87 s to 53.9 s, 5,103 samples".
- **Zoom announcements** (round 1): every zoom or pan (keys, buttons, wheel, brush, reset,
  `range:set`) announces once it settles (debounced ≥ 150 ms): "Showing 9.46 s to 45.5 s of 54.1 s"
  / "Showing the whole run, 54.1 s". A newer segment announcement cancels a pending range one.
- **Touch / pen** (round 1): a tap selects a segment (focus outline + pinned details card with "Open
  line", "Zoom to segment" and ×); a second tap on it opens the line (py) or zooms to it (native).
  Taps on GC / I/O / GIL / memory / collapsed rows show their readout. No hover tooltips on touch;
  double tap never resets or jumps.
- **Show in timeline caption** (round 1, shared with the flame): a caption row under the toolbar,
  "Showing train.py:173 · loss_value = loss.item() · in 19.6% of stack samples [× Clear]
  [← Back to code]". Clear removes the caption and the selected line's outline (until the selection
  changes); selecting another line ends the caption.
- `range:set` (from the scope's "Open in timeline") → zoom to that range and scroll the section into
  view. `hover:line` → outline matching segments.

#### 4.12.4 Motion and performance
First reveal: a left-to-right clip sweep of 520 ms (M18, the same time metaphor as the hero). Zoom
tween 280 ms (keyboard 140 ms), cancellable. Reduced motion: instant. Data: typed arrays (`Float64Array`
t0/t1, `Int32Array` stack index, `Int16Array` thread), segments per (thread, depth) sorted by t0,
`lowerBound` culling to the visible domain. One base draw per rAF at most. Budget: ≤ 8 ms per base
draw for 41,604 runs and 12 threads; hover ≤ 2 ms (overlay only).

### 4.13 Memory section (`views/memory/memoryview.ts`)

Present only when `caps.memory` and `max_footprint_mb > 0`.

#### 4.13.1 Stats row (`<dl>`, 6 items, wrap)
Peak **3.11 GiB** · At **52.9 s** `train.py:120` (button) · Growth **52.2%** "of allocated memory
stayed live" (absent / non-finite `growth_rate`: "not recorded") · Native threads **212 MiB** "allocated outside Python frames" · Allocated **3.27 GiB**
"sampled volume over the run" (Σ `n_malloc_mb`) · Possible leaks **2** (or "none detected"; without
`caps.leaks`: "not recorded"). Stat values with a tooltip are focus stops (tooltip on focus, tap
opens it) and carry the exact value ("3184.65 MiB = 3.11 GiB") as visually hidden text (round 1).

#### 4.13.2 Footprint chart (240 px `lg+`, 200 `sm`, 180 `xs`, 160 `short`)
- Area + line (§3.3), y from 0 with binary nice ticks in a right gutter (52), x = time `[0, tMax]`
  with nice ticks. Peak marker and callout use the scope's trace-aware placement
  (`charts/placement.ts#planPeakClear` with `footprintTrace`, §4.4.7): the callout never covers the
  footprint it annotates.
- **RUG row** (10 px) directly under the plot: the selected site's `memory_samples` times (§3.3 rug;
  `--danger` for a leak site). Never rings or dots on the line (must-fix 9).
- Hover: crosshair + readout "31.2 s · footprint 1.63 GiB (interpolated)" + the nearest event of the
  selected site within 6 px: "metrics.py:42 allocated or freed at 31.20 s (footprint 1.63 GiB)".
- An active `range:set` is shown as a `--fg` 6 % band (the chart does not zoom).

#### 4.13.3 Largest allocation sites (side by side with the chart at `lg+`: 8 / 4 columns)
- Toggle **Peak | Allocated** (radiogroup): rank lines by `n_peak_mb` or by `n_malloc_mb`.
- Rows (40 px): rank · meter (Peak: `n_peak_mb / max_footprint_mb`, split Python/native;
  Allocated: `n_usage_fraction`, scaled to #1) · value · code (mono, fade) · location · leak badge
  "↗ possible leak · grows 5.71 MiB/s". The selected row's bar is a straight 2 px `::before`
  (6 px insets), not an inset shadow (round 1).
- `role=listbox`. Arrow keys / click **select** a site (drives the rug and the chart caption).
  Enter / double-click → `nav.jumpTo`. Default selection: the most likely leak, else #1. 8 rows +
  "Show 25 sites" (then "Show top 8 sites"). The site detail reads "Peak | 614 MiB attributed to
  this line (Python 0%)" and "Moments | 100 allocation events shown as ticks under the chart · 200
  episodes" (counts pluralised).
- Leaks that are not in the top 8 are pinned as extra rows at the end under "Possible leaks".

### 4.14 AI optimization proposals (`views/ai/controller.ts`, `card.ts`, `drawer.ts`)

The network, prompt and settings layers already exist in `src/ai` (see `src/ai/index.ts`). The UI
MUST use only its public API: `fetchEnvApiKeys`, `loadSettings`, `saveSettings`,
`updateProviderField`, `syncSettingsWithProfile`, `acceleratorName`, `envFilledFields`,
`computeProposalAvailability`, `requestFromProfile`, `checkReady`, `preparePrompt`,
`proposeOptimization`, `listModels`, `modelOptions`, `validateApiKey`, `providerLabel`,
`providerInfo`, `PROVIDERS`, `isAiError`/`AiError`.

#### 4.14.1 Lifecycle
1. Page boot: `env = await fetchEnvApiKeys()` (it never throws and skips non-http pages). Then
   `settings = loadSettings({env})`.
2. Each `load(profile)`: `settings = syncSettingsWithProfile(settings, profile)` (the GPU toggle
   follows `profile.gpu`). Recompute availability per file with `computeProposalAvailability(lines,
   50)` (lazy per file, cached).
3. **No network request happens on page load.** Ollama is probed only when the user picks Local or
   presses Check. The OpenAI key is validated only after typing stops (600 ms debounce) or at request
   time.

#### 4.14.2 Triggers and flow
Triggers: row actions (§4.8.7), detail panel buttons (§4.9), keys `o` / `Shift+O`, palette actions
"Optimize selected line / region", and the globals `proposeOptimizationLine(fname, fileNo,
encodedLineJSON)` / `proposeOptimizationRegion(...)` (decode `fname` with `unescape`, look up the file by
name or by `fileNo`, parse the line JSON for `lineno`).

```
request = requestFromProfile(rawProfile, file, lineno, mode)
ready = checkReady(settings)
if (!ready.ready) → card "setup" state (no network)
else → card "working" (AbortController) → proposeOptimization(request, settings, signal)
     → "result" | "error" (AiError) | removed on abort
```
There is one card per anchor (`file:startLine`). A new request for the same anchor replaces it. Cards
persist per file while the report is open and move with their row in ranked mode.

#### 4.14.3 Proposal card (item after the anchor row; full table width; `--raised`, radius `--r-lg`, 1 px `--line`, `--shadow-card`)

| State | Content | Actions |
|---|---|---|
| **setup** | spark icon + "No AI provider is set up" (or `ready.message`, e.g. "To activate proposed optimizations, enter an Anthropic API key…"). Privacy line: "Proposals go from your browser straight to the provider you choose. Scalene sends this code, up to 9 lines of context and its profile numbers." | **Set up AI provider** (opens the drawer and focuses the first field in `ready.missing`), Dismiss |
| **working** | header "Optimizing line 173" / "Optimizing lines 152–184" · provider · model · live elapsed time (tabular, 1 s ticks); 3 static skeleton bars (`--sunken`, no shimmer) | **Cancel** (`AbortController.abort()` → the card is removed and a toast says "Request cancelled") |
| **result** | header "Proposal for line 173" · "Anthropic · claude-sonnet-4-5 · 6.2 s"; view toggle **Proposal \| Diff**. Proposal = `result.code` highlighted (§4.0.5) in a code block that keeps `result.leadingSpaces` indentation. Diff = line diff (LCS) of the original lines `startLine..endLine` (unescaped) vs the proposal, with − rows (`--danger-wash` gutter) and + rows (`--wash-mem` gutter), both highlighted. Footer note: "AI-generated suggestions may not always be correct." | **Copy** (copies `result.code`; the icon turns into ✓ "Copied" for 1.2 s; a toast on clipboard failure), **Regenerate**, **Show prompt** (disclosure with `result.prompt` in mono, scrollable max 320 px), **Dismiss** |
| **error** | `--danger` alert icon + `AiError.message`; "Details" disclosure with `error.detail` (status, body excerpt) | **Retry**; for `missing-credentials` / `invalid-key`: **Open AI settings** (focus that field); for `model-not-found`: **Choose another model** (opens the drawer at the model field) |

`role="region"` with `aria-label="AI proposal for train.py line 173"`. State changes are announced
(polite: "Proposal ready for line 173"; assertive for errors). There is never an `alert()` and never
text injected into the source rows (upstream `# Query failed…`).

#### 4.14.4 Settings drawer (must-fix 23)
- Right drawer, 440 px wide (`xs`: full-screen sheet). `role="dialog"`, `aria-modal="true"`,
  `aria-labelledby` its title "AI optimization". While open, `#main`, the app bar and the footer get the
  `inert` attribute, so Tab cannot leave the drawer (40 Tabs stay inside). Esc, the × button, **Done**
  or a scrim click close it, and focus returns to the opener. The drawer slides in (M20).
- **Provider**: radio tiles in a 2 × 3 grid, in upstream order: Amazon Bedrock · Anthropic · Azure
  OpenAI · Google Gemini · OpenAI · Local (Ollama). The radiogroup has `id="service-select"` and a
  `value` property (compatibility). A change saves through `saveSettings` and shows that provider's
  fields.
- **Fields** come from `providerInfo(id).fields` in catalog order. Advanced fields (`advanced: true`)
  sit behind an "Advanced options" disclosure (`toggleAdvanced`). Inputs keep the **upstream element
  ids**: `api-key`, `language-model-openai`, `openai-custom-model`, `openai-custom-url`,
  `anthropic-api-key`, `language-model-anthropic`, `anthropic-custom-model`, `anthropic-custom-url`,
  `gemini-api-key`, `language-model-gemini`, `gemini-custom-model`, `gemini-custom-url`,
  `azure-api-key`, `azure-api-url`, `language-model-azure`, `azure-custom-model`, `azure-api-version`,
  `aws-access-key`, `aws-secret-key`, `aws-session-token`, `aws-region`, `language-model-amazon`,
  `local-ip`, `local-port`, `language-model-local`. Persistence is **only** through
  `saveSettings(next, prev, {env})` (storage keys per `src/ai/settings.ts`; environment values are never
  written to storage).
  - `secret`: password input + **Show/Hide** button (`togglePassword`), `autocomplete="off"`,
    `spellcheck=false`.
  - `model`: `<select>` from `modelOptions(provider, settings, models)` (keeps a saved model that is not
    listed). With `canListModels`: a **Refresh** button → `listModels` (button shows a spinner; on
    error, keep the static list and show `result.error.message` inline).
  - OpenAI key: a status line under the field from `validateApiKey`: "✓ Key accepted" / "✕ Key
    rejected" (icon + text, `id="valid-api-key"`), "Not checked (custom URL)".
  - Fields filled from the environment (`envFilledFields`) show a badge "from environment"
    (`--fg-3`, monospace env var name in the tooltip).
  - `helpUrl`: the label gets a "Get a key ↗" link.
  - Local (Ollama): note "Run AI locally with Ollama ↗"; Server `local-ip` : Port `local-port`; a
    **Check** button → `listModels("local")` → status line "3 models found" or, in `--danger`,
    "Server not found. Run: `ollama pull codellama`" (`id="install-models-message"`); the model select is
    `id="language-model-local"` inside `id="local-models-list"`.
- **Optimize for**: segmented **Runtime performance | Memory efficiency** (ids `optimize-performance`
  / `optimize-memory`, saved as the complementary pair).
- **Include ⟨acceleratorName(profile)⟩ optimizations**: a switch (`id="use-gpu-checkbox"`, label span
  `id="accelerator-name"`), synced to `profile.gpu` on each load.
- Advanced (global): **Prompt** select — Auto (recommended) / Scalene insights (classic) / Targeted
  (`promptStyle`), with a one-line explanation.
- Footer text: "Proposals are sent from your browser directly to the provider. Keys are stored in this
  browser's localStorage. AI-generated suggestions may not always be correct." + **Done**.
- Every edit saves immediately (debounced 300 ms for text). The app-bar status dot updates live.

#### 4.14.5 Error copy (from `AiError.kind`)
`missing-credentials` / `invalid-key` → the message + Open AI settings. `quota` → "The provider
reports that the quota is exhausted." `rate-limit` → "Rate limited, try again in a moment." + Retry
(enabled after 5 s). `model-not-found` → "Model not found: ⟨model⟩." `network` → "Couldn't reach
⟨provider⟩ (network or CORS)." + for Local: "Is `ollama serve` running? Origins other than
localhost and file:// need `OLLAMA_ORIGINS`." `empty-response` → "The provider returned no code."
`aborted` → the card is removed silently. Other kinds → `AiError.message`.

### 4.15 Load profile: picker, drag and drop, errors (`views/shell/loader.ts`)
- **Entry points**: app-bar Load, footer "Load another profile", empty-state button, palette "Load
  profile…", template `clickToLoadFile()`, global `loadFile()` (reads `#fileinput.files[0]`).
- **Drag and drop anywhere**: on `dragenter` with Files, show a full-viewport overlay (`z: --z-drop`;
  `--scrim` + centered dashed 2 px `--fg` 50 % rounded panel, upload icon, "Drop a Scalene profile
  (.json)"). It hides on `dragleave` out of the window or on drop. Drop → read the first file.
- **Read and parse**: `FileReader.readAsText` → `JSON.parse` (in try/catch) → validate: it must be an
  object; `{}` → empty state; otherwise it must have a `files` object, else the error "This JSON is not
  a Scalene profile (no "files" section)". Above 2 MB, show a progress toast "Reading
  profile.json · 16.1 MB…" until render.
- **Success**: `load(parsed)`, then the toast "Loaded profile.json · 6 files", then
  `document.title = "Scalene - " + program` and a scroll to the top.
- **Errors**: an error toast (`role=alert`, persists until dismissed): "Couldn't load profile.json:
  Unexpected token } in JSON at position 1234". The current report stays.
- `loadDemo()`: loads the global `example_profile` binding if it exists (hosted demo; it is a top-level
  `const` in `example-profile.js`, so test with `typeof example_profile !== "undefined"`, not
  `window.example_profile`), else no-op. `loadFetch()`:
  `fetch("profile.json")` relative → same pipeline; errors → toast.

### 4.16 Empty / demo state (`views/shell/empty.ts`)
- Shown for `""`, `{}`, a non-object, or no `files` entries. The copy names the case: `""` / a
  non-object → "No profile loaded" (below); `{}` or an object without files → title **"Scalene
  collected no samples"** + "Your program may have finished before Scalene took a sample, or spent
  its time outside the profiled files. Try a longer run, or `--profile-all`."; a first load that
  cannot be parsed → "Couldn't read this profile" + the parser message (button "Choose another
  profile…"). `aria-busy` is always cleared.
- `short` hosts: a 24 px mark inline with the title; **Choose a profile…** and the drop hint on one
  row *before* the steps (DOM order too); steps are one row each (command scrolls inside its chip);
  the button's bottom stays ≤ 380 px at 1000×400.
- The chrome is stripped: the app bar shows only the logo, Load and Theme (no nav, no search, no AI). No
  footer links except version. The ribbon and every section are absent.
- A centered card (max-width 560; `xs` full width), vertically centered in the viewport (in `short`:
  top-aligned):
  - logo mark 40 px; title "No profile loaded" (`--type-section`); a sentence: "Open a Scalene JSON
    profile to see where your program spends time and memory. Scalene writes `{}` when it collected no
    samples.";
  - numbered steps (mono chips with Copy buttons): **1** `scalene --json --outfile profile.json
    your_program.py` · **2** `scalene view profile.json`;
  - primary button **Choose a profile…** (opens `#fileinput`) + a dashed drop zone "or drop a .json
    file anywhere" (a 2 px dashed `--control` border);
  - when the global `example_profile` exists: a secondary button **Load the demo profile** (`loadDemo`).

### 4.17 Footer and meta (`views/shell/footer.ts`)
- Static (not fixed; it never covers content), 1 px `--line` top, 12.5/18 `--fg-2`, padding 24 /
  gutter, `env(safe-area-inset-bottom)`.
- Content: "**Scalene** {{scalene_version}}, {{scalene_date}}" (read from the template's
  `#scalene-footer` `data-version` / `data-date`) · "Report an issue or request a feature" (`/issues/new/choose`)
  · "Share your success story" (`/issues/58`) · "Load another profile" · a units note "Times are shares
  of sampled time × wall clock. Memory uses binary units (1 MiB = 2²⁰ bytes)." · "Reduce motion"
  toggle (switch) · "Keyboard shortcuts (?)".
- `document.title` = `"Scalene - " + program` (or "Scalene") after every load.

### 4.18 Toasts (`core/toast.ts`)
- Stack in `#layer-root` (`z: --z-toast`), bottom-right (`xs`: bottom-center, full width − 32), max 3
  visible (older ones collapse). Toast: `--raised`, `--shadow-float`, radius `--r-md`, 12/16 text,
  icon (info / check / alert in `--danger`), optional action button, × close.
- Info/success: `role="status"` (polite), auto-dismiss after 4 s (paused on hover or focus). Errors:
  `role="alert"`, stay until closed.
- Motion: opacity + 8 px rise, 140 ms in / 90 ms out (reduced motion: opacity only).
- Uses: copied, profile loaded, load errors, request cancelled, clipboard denied, storage
  unavailable ("Settings can't be saved in this browser (storage blocked)", shown once).

### 4.19 Tooltips (`core/tooltip.ts`)
- One global tooltip element (`role="tooltip"`, `z: --z-tooltip`), `--glass` background + blur(12px),
  1 px `--glass-line`, radius `--r-md`, `--shadow-float`, padding 8 × 10, max-width 360
  (`xs`: `100vw − 32`).
- Content model: `{title?, kind?, rows?: [label, value][], code?: string, hint?}`. Title 12/16 600;
  rows 12/16 with tabular values right-aligned; code block mono 12 on `--sunken`; hint `--fg-3`.
- Placement: 12 px offset from the pointer (charts) or the target (DOM), flipping on all four sides to
  stay inside the viewport; never covering the hovered mark.
- Timing: charts and canvases appear at 0 ms and follow the pointer; DOM controls (icon buttons,
  headers) appear after a 300 ms hover intent, and immediately on keyboard focus. In 140 ms, out
  90 ms (opacity only, plus a 2 px rise when motion is allowed).
- Controls with a tooltip reference it through `aria-describedby` while it shows. Data tooltips are
  never the only path (§1.3.8). There are no native `title` attributes on data.

### 4.20 Command palette (`views/shell/palette.ts`)
- Opened by ⌘/Ctrl+K, `/` (outside inputs) or the app-bar Search button. A modal dialog
  (`role=dialog`, `aria-modal`, `inert` background), top 18vh, width 640 (`xs`: full width, top 0).
  It opens and closes instantly (frequent action).
- An input (combobox, `aria-controls` the listbox, `aria-activedescendant`) + a grouped listbox, max
  8 visible rows per group:
  - **Lines** (default when typing code-like text): substring match over all source lines, hot lines
    first (sorted by time, then by file rank), at most 50. A row shows highlighted code, `file:line`
    and "21.4% of run".
  - **Functions**: fuzzy (subsequence) match over qualnames, showing "% of run".
  - **Files**: fuzzy over base names, plus contiguous matches of whole directory segments (never a
    subsequence scattered across the full path); scattered matches need ≥ 1.5 score per character.
    Showing share and peak.
  - Group order: Lines, Functions and Files are ordered by the strength of their best hit (word-start
    or prefix > substring > scattered subsequence); ties keep the default order above.
  - **Sections**: Overview, Code, Stacks, Timeline, Memory.
  - **Actions**: Toggle theme, Use system theme, Open AI settings, Load profile…, Expand all lines,
    Show hot lines only (Hot only), Reduce motion, Keyboard shortcuts, Optimize selected line.
- Empty query: Sections + Actions + the top 5 hotspots. ↑/↓ move, Enter runs, Esc closes. The search
  index is built lazily on first open (in slices, ≤ 30 ms on huge.json).

### 4.21 Shared controls (`core/controls.ts`, `styles/03-controls.css`)

| Control | Spec |
|---|---|
| Button | 32 px tall (28 compact, 36 coarse), radius `--r-sm`, 13/16 500. Variants: **primary** (`--fg` fill, `--surface` text), **secondary** (transparent, 1 px `--control` border), **ghost** (text only, hover `--hover`). Disabled = `--fg-3` text, no fill change, `aria-disabled` |
| Icon button | 32 × 32, icon 16, `aria-label` required, tooltip from the label |
| Segmented control | `role=radiogroup`; `--sunken` track, radius `--r-sm`, padding 2; selected thumb `--surface` + `--shadow-card`, sliding (M7); ←/→ moves and selects; 28 px tall |
| Tabs | `role=tablist`; 2 px `--fg` underline on the selected tab |
| Select | native `<select>` styled: 32 px, 1 px `--control` border, chevron icon |
| Text input | 32 px, 1 px `--control` border, radius `--r-sm`, focus = focus ring (no colour change) |
| Switch | 32 × 18 track, `role=switch`, `aria-checked`; on = `--fg` track |
| Chip (code) | mono 0.9 em, `--sunken`, 1 px `--line`, radius `--r-sm`, padding 1 × 6, never wraps; a button when it navigates |
| Badge | 11/14 600, radius `--r-pill`, padding 1 × 6: neutral (`--sunken` / `--fg-2`), danger (`--danger-wash` / `--danger`), resource (swatch dot + `--fg-2` text) |
| Key chip | mono 11, 1 px `--line-strong`, radius `--r-xs`, padding 0 × 4 |
| Disclosure | button with a chevron rotating 90° (M7 timing), `aria-expanded`, content revealed with height via `grid-template-rows 0fr → 1fr` (200 ms) |
| Menu | `role=menu`, `--raised`, `--shadow-float`, radius `--r-md`, items 32 px, arrow keys, typeahead, Esc |
| Focus ring | `outline: 2px solid var(--focus); outline-offset: 2px` on `:focus-visible`, everywhere; inset (−2 px) inside dense rows and canvases |

---

## 5. Motion specification

### 5.1 Rules
- Only `transform` and `opacity` animate in the DOM (FLIP for layout changes). Canvas charts tween
  their own geometry in `requestAnimationFrame` with time-based easing and skip frames rather than
  slowing down.
- Every animation is **cancellable**. A new interaction starts from the current interpolated state.
  Input is never blocked.
- **No overshoot or bounce on data marks.** Count-ups are monotonic, use tabular figures, and
  start in the final unit and decimal count.
- Frequent interactions do not animate: hover, linked highlight, crosshair, keyboard focus moves,
  palette open/close, theme toggle.
- Degrade to a cross-fade if a transition would touch more than 300 DOM nodes or 5,000 canvas rects.
- Test switches: `?motion=reduce` forces the reduced path; `?still` renders every final frame
  immediately (screenshots, tests).

### 5.2 Motion table

| # | Trigger | Target | Properties | Duration / easing / stagger | Communicates | Reduced motion |
|---|---|---|---|---|---|---|
| M1 | first load | headline, meta, readout labels, card titles | opacity 0 → 1, y 6 → 0 | opacity 200 ms, transform 320 ms `--ease-out`; 30 ms stagger in reading order from 0 ms | reading order = importance | final on first frame |
| M2 | first load | readout values (single numbers only) | text count-up to the exact final string | `--dur-count` 600 ms `--ease-out`; on the tile's reveal clock: start 60 ms + 30 ms × tile index, together with its label (round 1: a value never shows before its label) | magnitude | final values |
| M3 | first load | time-split bar (as **one** unit) | `scaleX` 0 → 1, origin left | 420 ms `--ease-out`, start 80 ms | composition; the three numbers render final, so they never disagree mid-flight | full bar |
| M4 | first load | scope base layer | clip to a beam sweeping 0 → 100 % of x; trailing phosphor gradient; peak callout fades in (140 ms) when the beam crosses the peak | `--dur-sweep` 640 ms, `1 − (1 − t)^2.2`, start 120 ms (ends 760 ms) | time runs left → right; the peak is an event in time | static render |
| M5 | first load | hotspot meters | `scaleX` 0 → 1 from the baseline | 420 ms `--ease-out`, start 200 ms + 30 ms × rank (cap 8) → ends ≤ 830 ms | rank order, biggest first | full meters |
| M6 | first load | readout meters (GPU, Await, Busiest fn), peak minibar | `scaleX` 0 → 1 | same clock as the tile's count-up (600 ms `--ease-out`, start 60 ms + 30 ms × tile), so a meter never disagrees with its number (round 1) | magnitude | full |
| M7 | segmented control / disclosure | thumb; chevron | `translateX` + `scaleX` (thumb); `rotate(90deg)` (chevron) | 200 ms `--ease-standard` | which option is active / open | instant |
| M8 | hotspot kind or metric change | rows, meters, TOP LINES strips | in sequence (round 1): leaving rows are inert clones at z 0 that fade out in 90 ms `--ease-in`; persisting rows hold 60 ms, then slide on an opaque `--surface` at z 2, their rank/value fading in as they land; entering rows fade in after the move (stagger 20 ms); strips cross-fade 140 ms | 280 ms `--ease-standard` | object constancy across re-ranking | instant + 1.5 s `--select` highlight on the previously focused item |
| M9 | code sort / source order / display-mode change | visible rows (≤ 60) | FLIP `translateY` | 280 ms `--ease-standard`, no stagger (common fate) | where each line went | instant + highlight on the focused row |
| M10 | file switch | code body | opacity 0.4 → 1 | 120 ms | content replaced, not moved | instant |
| M11 | flame click / crumb / Esc | x-domain; breadcrumb | domain tween; crumb `translateX` 8 → 0 + fade | 280 ms `--ease-standard`; crumb 140 ms | this frame now spans the width; siblings fly out | instant |
| M12 | flame lateral jump | x-domain | staged: out to the common ancestor, then in | 2 × 280 ms | where the new frame sits relative to the old one | instant |
| M13 | timeline brush release / ± / keys / `range:set` | time domain | domain tween | 280 ms (keys 140 ms) `--ease-standard` | zoom into exactly this range | instant |
| M14 | `jumpTo` | page scroll; target row background | smooth scroll; `--flash` held 300 ms, then fading to transparent over 900 ms | browser smooth scroll; 1.2 s total | where you landed | instant scroll; flash kept (colour, no motion) |
| M15 | heat metric change | row washes | `--heat` opacity cross-fade | 200 ms | heat now means another resource | instant |
| M16 | lens open / close | rows below; lens content | FLIP `translateY` of the following rows; content opacity 0 → 1 (delay 60 ms) | 200 ms `--ease-standard`; content 140 ms | the detail belongs to this line | instant |
| M17 | flame section first enters the viewport | rows by depth | clip from the top + opacity per depth | 220 ms + 14 ms × depth, cap 600 ms | the hierarchy grows from the root | static |
| M18 | timeline / memory chart first enters the viewport | chart | left → right clip sweep | 520 ms `--ease-out` | the same time metaphor as the hero | static |
| M19 | tooltip | tooltip | opacity + 2 px rise | in 140 ms / out 90 ms | detail on demand | opacity only (120 ms) |
| M20 | AI drawer / file sheet / ⋯ menu | panel; scrim | `translateX(100%) → 0` (sheet: `translateY`); scrim opacity | 280 ms `--ease-standard` in, 200 ms `--ease-in` out; scrim 200 ms | the panel comes from the edge it lives on | opacity 120 ms |
| M21 | toast | toast | opacity + 8 px rise | 140 ms in / 90 ms out | transient feedback | opacity only |
| M22 | AI card appears / changes state | card | height via `grid-template-rows` 0fr → 1fr + content opacity; copy icon ✓ swap for 1.2 s | 200 ms `--ease-out` | work in progress → result, attached to the line | instant |
| M23 | hover / focus the Peak readout | scope peak marker | ring `scale` 1 → 1.6 + opacity 1 → 0, once | 420 ms `--ease-out` | where and when the peak is | static 2 px ring for 1.2 s |
| M24 | hover, linked highlight, crosshair, keyboard moves, palette, theme | — | — | **0 ms** | — | — |
| M25 | file dragged over the window | drop overlay | opacity | 140 ms | drop target | same |

### 5.3 Signature moments (the "awe", each tied to real data)
1. **The run draws itself** (M1–M6, ≤ 900 ms). A beam sweeps the run's real time axis. The footprint
   rises exactly as it did, and the peak callout appears when the beam reaches the real peak time.
   The readouts land on their exact values, and the hotspot bars grow in rank order. Every frame of
   the animation is a truthful partial view, not a decoration.
   - Filmstrip expectations on ml-training (1440×900): at 120 ms the headline is visible (opacity ≥
     0.5) and the beam starts. At 300 ms the beam is at ≈ 45 % of the x range; the split numbers are
     final while the split bar is partially grown. At ≈ 650 ms the peak callout appears (52.9 s of
     54.1 s). At 760 ms the sweep is done. At 900 ms everything is settled and pixel-identical to
     `?still` (diff < 0.5 %).
2. **Light up when it ran** (M24 + §4.4.6). Hovering hotspot #1 instantly projects its 500 sample
   times across the signal, and the matching TOP LINES strip lights up while the others dim. The
   correspondence between rank, code and time is shown in one glance, with no animation delay.
3. **Fly to the line** (M14 + M16). A click on a hotspot glides the page to the exact row, flashes
   it, and unfolds the lens beneath it with every metric and the call context. Focus lands on the row.
4. **Zoom into the call** (M11/M12). A flame frame expands to fill the width while its siblings fly
   out, the axis re-bases to "% of this frame", and the breadcrumb records the path.
5. **Brush to timeline** (M13). Drag a range on the signal and choose "Open in timeline". The
   timeline animates its domain to exactly that range, and the same seconds are now readable as
   threads and frames.

### 5.4 Reduced motion (must-fix 6, 29)
- Source: `matchMedia("(prefers-reduced-motion: reduce)")` (live), overridden by the in-app toggle
  (`localStorage["scalene-reduced-motion"] = "1"` forces reduce; removing it follows the OS). The class
  `motion-reduce` on `<html>` drives the CSS token overrides (§3.2); JS reads `motion.reduced`.
- Under reduce: no intro (final state on the first frame), no count-ups, no sweeps or reveals, no FLIP
  (instant + 1.5 s highlight on the acted item), no zoom tweens, no smooth scrolling, no `translate` or
  `scale` anywhere. Only **opacity** fades of ≤ 120 ms remain (tooltip, toast, scrim, drawer). The jump
  flash stays (a colour change, not motion).
- Test: with `reducedMotion: "reduce"` emulated, the Overview screenshot at 40 ms equals the final
  screenshot (diff < 0.5 %), and `document.getAnimations()` contains only opacity animations ≤ 120 ms.

### 5.5 Implementation primitives (`core/motion.ts`)
`motion.reduced: boolean`; `onMotionChange(cb)`; `tween(key, ms, ease, step, done?)` (one running tween
per key, cancellable, returns a handle); `flip(nodes, mutate, {ms, ease})`; `countUp(el, finalText,
{ms, delay})` (parses the number and keeps the unit and decimals); `revealOnce(el, cb)`
(IntersectionObserver, threshold 0.15); `intro(plan)` (runs M1–M6 from one timeline so the stagger is
deterministic); `EASE` (cubic-bezier evaluators that match the CSS tokens).

---

## 6. Performance and accessibility strategy

### 6.1 Performance (must-fix 18, 30)

**Budgets** (headless Chromium on the CI machine; huge.json = 16 MB inline, 40 files, 11,739 lines,
3,183 stacks, 41,604 runs, 12 threads):

| Metric | huge.json | ml-training.json |
|---|---|---|
| `model.build()` (normalize, model, rankings, headline, findings, readouts) | ≤ 250 ms | ≤ 40 ms |
| `DOMContentLoaded` → `performance.mark("scalene:overview")` (overview painted) | ≤ 1.0 s | ≤ 300 ms |
| Long tasks after `scalene:overview` | none > 200 ms | none > 100 ms |
| DOM nodes after load (`document.querySelectorAll("*").length`) | < 8,000 | < 5,000 |
| Event timing: hover hotspot / flame / timeline | < 50 ms | < 30 ms |
| Theme toggle, file switch, column sort | < 100 ms | < 60 ms |
| Flame zoom / timeline zoom frame | ≤ 16 ms per frame | ≤ 10 ms |
| JS heap after load | < 300 MB | < 80 MB |
| Bundle (unminified JS + CSS, AI port included) | ≤ 1,000 KiB raw and ≤ 260 KiB gzipped (upstream page assets: 1,426 KiB raw, 445 KiB gzipped) | |

**Techniques**
1. **Lazy sections**: Code, Stacks, Timeline and Memory render a placeholder with the **reserved
   height** computed from the model (e.g. flame height from depth), so nothing shifts. The placeholder
   is the real section header plus a static `--sunken` block with "Preparing call stacks…" in `--fg-3`
   (no shimmer, `aria-busy="true"`). They mount on
   IntersectionObserver (`rootMargin: "100% 0px"`) or on idle, whichever comes first. `jumpTo`, nav
   and palette force-mount synchronously.
2. **Lazy derivations**, each run in ≤ 8 ms slices (`scheduler.postTask` when available, else
   `setTimeout(0)` chunks): flame tree, timeline typed arrays and segments, phases, call-context
   index, memory-stack tree, search index, per-file availability and visibility.
3. **Canvas** for the scope, flame, timeline, memory chart and minimap, as base + overlay pairs. The
   device-pixel ratio is capped at 2. Hit-testing uses binary search on sorted arrays. LOD and culling
   rules are in §4.11–4.12.
4. **Virtualized code view** with node pools (§4.8.10). Sparklines are tiny inline SVG `polyline`s
   (2 nodes); meters are spans (≤ 4 nodes).
5. `ResizeObserver` callbacks are batched into one rAF; reads happen before writes (no layout
   thrash). Scroll handlers are passive and rAF-throttled.
6. `samples` are downsampled with M4 when there are more than 2 × the plot width (old profiles have
   2,846 points).
7. `load()` is idempotent: the same object passed twice within 1 s is skipped (the upstream
   template and hosts may both call it).
8. Measurement: `performance.mark` at `scalene:load` (entry of `load()`), `scalene:model`,
   `scalene:overview`, `scalene:idle-done`. A `PerformanceObserver` for `longtask` and `event` is
   installed only with `?perf`. `node tools/e2e/verify.mjs --only perf,resize,intro` measures this
   table (results in `out/e2e/perf.json`).
9. Round 1: `observeSize` delivers the first size at once, batches resize storms (< 150 ms apart)
   into one relayout after a 120 ms pause and only marks off-screen elements dirty; a theme change
   repaints the flame, timeline and memory canvases only within one viewport of the screen
   (`nearViewport`), the rest when they come into range; a hidden function view is not re-rendered
   on file switches; the code view skips its row rebuild on height-only resizes.

### 6.2 Accessibility (WCAG 2.2 AA)

1. **Structure**: `banner`, `main` (with `nav` inside the app bar), `contentinfo`. One `h1` (the
   headline), one `h2` per section, `h3` per card. DOM order = visual order (§2.4.5).
2. **Skip links** (must-fix 22): "Skip to main content" and "Skip to code" are the first focusable
   elements. They are off-screen until focused, then appear at (8, 8) with `--fg` background,
   `--surface` text, 8 × 12 padding, `z: --z-skip`.
3. **Keyboard map** (also in the `?` dialog):

| Scope | Keys |
|---|---|
| Global | `/` or ⌘/Ctrl+K palette · `?` shortcuts · Esc closes the topmost layer, then clears the selection |
| Hotspots (listbox) | ↑/↓ or j/k move · Home/End · Enter open the line · `f` show in stacks |
| Scope | ←/→ (Shift ×10) move the cursor · Home/End · Shift+←/→ select a range · Enter open the line · Esc clear |
| Code table | ↑/↓, j/k, PageUp/PageDown, Home/End · Enter/Space toggle details · `e` open in editor · `o` optimize line · Shift+O optimize region · `s` show in stacks · `t` show in timeline · Esc |
| Minimap (slider) | arrows step through hot lines · PageUp/PageDown · Home/End · Enter open |
| Flame | ↑ parent · ↓ heaviest child · ←/→ siblings · Enter zoom · Esc zoom out · `g` go to source · Home root · `/` search (inside the section) |
| Timeline | ↑/↓ rows · ←/→ segments · W/S or +/− zoom · A/D or Alt+←/→ pan · `0` reset · Enter go to source · Shift+Enter zoom to segment · Esc |
| Dialogs (drawer, palette, sheets, shortcuts) | Tab cycles inside · Esc closes and returns focus |

4. **Names, roles, values**: every interactive element has an accessible name. Composite widgets
   use the roles in §4 (listbox, tablist, radiogroup, table, slider, dialog, menu, switch). Sort state
   is `aria-sort`, disclosures use `aria-expanded`, and toggles use `aria-pressed` or `aria-checked`.
   Duplicate ids are forbidden (one `#fileinput`).
5. **Canvases** (must-fix 25): a non-interactive canvas is `aria-hidden`, and its figure has a text
   summary. An interactive canvas (scope, flame, timeline) has `role="application"`,
   `aria-roledescription`, a label, `aria-describedby` help, and announces the focused item through
   `#sr-polite` (an `aria-live="polite"` visually hidden region, debounced 150 ms). Errors use
   `#sr-assertive`. The minimap is a `slider`.
6. **Colour and contrast**: §3.7. Every colour has a twin (table below). Text is never dimmed with
   opacity.

| Colour-coded thing | Non-colour twin |
|---|---|
| Python / native / system time | segment order (Python first) + legend labels + hatch on system |
| Waiting (I/O & waits, `[await]`) | 135° hatch + `[await]` prefix + lane label |
| Leak | trend-up icon + "possible leak" text |
| Device idle bands | shape glyph ● ◆ ▲ + word in the tooltip |
| Threads (interleaved) | lane/label text in tooltips; Lanes mode by default |
| Flame kind | label text + tooltip kind chip |
| Heat wash | the meter length and the number |

7. **Targets**: ≥ 24 × 24 px everywhere (WCAG 2.5.8); 32 px rows and buttons on coarse pointers;
   36–44 px primary touch targets on `xs`.
8. **Motion**: §5.4. **Reflow**: no horizontal page scroll at 320 px (WCAG 1.4.10), and none at
   1280 px with 200 % browser zoom.
9. **Overflow test** (must-fix 7): for widths 320, 360, 390 (Playwright `isMobile: true`,
   `deviceScaleFactor: 3`), 600, 1024, 1440, 2560, every fixture: `scrollWidth === clientWidth` and
   `visualViewport.scale === 1` after load, after opening the lens, and with the drawer open.
10. **Forms** (drawer): visible labels; errors connected with `aria-describedby`; Show/Hide buttons
    have `aria-pressed` and `aria-controls`; the env badge text is part of the accessible description.
11. **Automated checks** (no npm installs; WP6): a Playwright script that walks
    `page.accessibility.snapshot()` and fails on unnamed interactive nodes, duplicate ids, `title`-only
    data, missing `aria-sort` on sorted headers, focusable elements hidden by `inert`, and a skip link
    that is not visible on focus. It also checks the computed contrast of rendered text nodes against
    their effective background (failures > 0 → fail).

---

## 7. Integration contract (must not break)

### 7.1 Jinja template (`scalene-ui/template/index.html.template`, replaces upstream `index.html.template`)

Variables used: `profile`, `scalene_version`, `scalene_date`, `standalone`, `gui_js`,
`favicon_base64`. Others (`logo_base64`, `jquery_js`, `bootstrap_css`, `bootstrap_js`, `prism_css`) are
ignored (Jinja ignores unused variables). The template MUST be exactly this structure (WP1 creates it;
comments may be shortened, but the word "experimental" must not appear anywhere):

```html
{# index.html.template — Scalene report UI (scalene-ui). Rendered by scalene_utility.generate_html
   and launchbrowser.generate_html. #}
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline' data: blob:; img-src * data: blob:; connect-src * data: blob:; font-src * data: blob:; frame-src * data: blob:;">
  <title>Scalene</title>
  {% if standalone %}
  <link rel="icon" href="data:image/x-icon;base64,{{ favicon_base64 }}" type="image/x-icon">
  {% else %}
  <link rel="icon" href="favicon.ico" type="image/x-icon">
  {% endif %}
  <script>
    (function () {
      var t = null;
      try { t = window.localStorage.getItem("scalene-theme"); } catch (e) {}
      if (t !== "light" && t !== "dark") {
        t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      document.documentElement.setAttribute("data-theme", t);
    })();
  </script>
  <style>
    html { background: #F4F5F7; color: #0E1116; }
    html[data-theme="dark"] { background: #07090D; color: #E8ECF2; }
    body { margin: 0; }
    /* Upstream test contract: these selectors must live in the template (both modes). */
    .combined-stacks-section { scroll-margin-top: 64px; }
    .flame-segment { position: absolute; box-sizing: border-box; pointer-events: none; }
    /* First paint before the bundle runs (a 16 MB profile takes ~0.7 s to parse): a calm
       placeholder, and the template footer stays hidden until the app adopts it. */
    #scalene-footer:not(.site-footer) { visibility: hidden; }
    .boot-note { margin: 0; padding: 38vh 16px 0; text-align: center; font: 14px/20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #5E6676; }
    html[data-theme="dark"] .boot-note { color: #7F8999; }
  </style>
  {% if not standalone %}
  <!-- upstream Google Analytics block, copied verbatim (navigator.onLine guard, G-4JXPHEBMTY) -->
  {% endif %}
</head>
<body>
  <div id="scalene-app" aria-busy="true"><p class="boot-note">Loading profile&hellip;</p></div>
  <noscript>Scalene needs JavaScript to display this profile.</noscript>
  <footer id="scalene-footer" data-version="{{ scalene_version }}" data-date="{{ scalene_date }}">
    <a href="https://github.com/plasma-umass/scalene">Scalene</a> version {{ scalene_version }}, {{ scalene_date }}
  </footer>
  <script>
    const profile = {{ ((profile or '') | trim or '""') | replace('<', '\\u003c') }};
    function clickToLoadFile() { var i = document.getElementById("fileinput"); if (i) { i.click(); } }
  </script>
  {% if standalone %}
  <script>{{ gui_js }}</script>
  {% else %}
  <script src="scalene-gui-bundle.js"></script>
  {% endif %}
  <script>
    (function () {
      function go() { load(profile); }
      if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", go); } else { go(); }
    })();
  </script>
</body>
</html>
```

Notes:
- `((profile or '') | trim or '""')` guards the empty and whitespace-only cases (upstream produced
  `const profile = ` → a syntax error). The fallback is `""`, not `{}`, so the empty state can tell
  "no profile loaded" (missing/blank file) from "Scalene collected no samples" (`{}`, §4.16). `| replace('<', '\\u003c')` stops profile text from ending
  the inline `<script>`: Scalene profiles carry the full source of each file, and a line holding
  `</script>` or `<!--<script` would otherwise end the element (blank report, injected markup runs
  as script). In JSON `<` occurs only inside strings, so `\u003c` parses to the same data (round 1
  review, `profile-script-breakout`; `build.mjs` checks the exact expression, `contract.test.mjs`
  and the `scriptbreak`/`ws` fixtures of `tools/check.mjs` guard it).
- The template calls `load(profile)` **once**. The bundle **never** auto-calls `load` (fixes the
  double render). Hosts that embed the bundle themselves (VS Code extension, hosted demo) call
  `load(...)` as before.
- The app mounts into `#scalene-app` (creating it if a foreign host lacks it) and **adopts**
  `#scalene-footer` (reads its `data-*` attributes and re-renders its content as §4.17).
- The bundle MUST NOT contain `</script` or `<!--` (it is inlined into a `<script>` element). The
  build check enforces it.

### 7.2 Server endpoints
| Endpoint | Rule |
|---|---|
| `GET /heartbeat` | `core/host.ts`: only when `location.protocol` is `http:` or `https:`; every **10,000 ms** via `fetch("/heartbeat", {cache: "no-store"})` with errors swallowed (upstream used XHR and also fired on `file://`, which only produced console errors). `launchbrowser.monitor_heartbeat` kills the server after 60 s without one. |
| `GET /env-api-keys.json` | only through `fetchEnvApiKeys()` in `src/ai` (http(s) only, `cache: "no-store"`, never throws). |
| Ollama `GET http://host:port/api/tags` | only on user action (§4.14.1); **not** at module load (upstream probed on every load). |
| OpenAI key check | debounced on input, cached per key, skipped with a custom URL (§4.14.4). |

### 7.3 Window globals (same names and signatures; installed by `src/scalene-gui.ts`)

| Global | New behaviour |
|---|---|
| `load(profile)` | Render (or re-render) the whole report. Accepts an object or JSON text. Idempotent for the same object within 1 s. Sets `globalThis.profile = profile` (raw) and `document.title`. |
| `vsNavigate(filename, lineno)` | `filename` is the **escaped** form (as upstream). In VS Code: post `jumpToLine` (§7.4). Otherwise decode (`decodeURIComponent`, falling back to `unescape` for `%uXXXX`; fixes non-ASCII) and `jumpTo` if the file is in the profile, else `location.href = "vscode://file/<decoded>:<lineno>:1"`. |
| `proposeOptimizationLine(fname, fileNo, encodedLineJSON)` / `proposeOptimizationRegion(...)` | §4.14.2 |
| `expandAll()` / `collapseAll()` | All files → "All lines" / "Hot lines" (§4.8.5) |
| `toggleDisplay(id)` | `id = "file-N"`: make file N current and scroll to the code section |
| `onFileDisplayModeChange(id)` | §4.8.5 |
| `toggleCombinedStacks()` / `toggleMemoryStacks()` | Scroll to `#stacks`, select the CPU / Memory tab, focus the heading |
| `toggleCombinedStacksTimeline()` | Scroll to `#timeline`, focus the heading |
| `changeTimelineViewMode(selectEl)` | `selectEl.value` ∈ `interleaved` / `swimlanes` (= Lanes) / `main` / a thread id → apply (§4.12.2) |
| `loadFile()`, `loadDemo()`, `loadFetch()` | §4.15 |
| `toggleServiceFields()` | Re-read the drawer provider (`#service-select`.value) and show its fields |
| `togglePassword(btn)` | Toggle the secret input controlled by `btn` (`aria-controls`) |
| `toggleAdvanced(el)` | Toggle the drawer's "Advanced options" disclosure that contains `el` |
| `refreshOpenAIModels()`, `refreshGeminiModels()` | `listModels("openai" / "gemini")` and refresh the select |
| `checkApiKey(value)` | Set the OpenAI key to `value` and run `validateApiKey` (status line) |
| `toggleReduced()` | Legacy no-op, kept for back-compat |
| `globalThis.profile` | The raw profile object of the last `load` |

### 7.4 VS Code webview
- `acquireVsCodeApi()` is called **once**, lazily, and cached in `core/host.ts` (upstream called it on
  every click and threw on the second call).
- Message shape is unchanged: `postMessage({ command: "jumpToLine", filePath: <escape()-encoded
  filename>, lineNumber: <int> })`. Internal callers pass the raw filename; `host.openInEditor(raw,
  line)` applies `escape(raw)`, so the extension receives exactly what upstream sent.
- Theme: follow `body.vscode-dark` / `vscode-light` / `vscode-high-contrast` unless the user chose a
  theme (§3.2 resolution).

### 7.5 Upstream test contract (`tests/test_combined_stacks_gui.py`)
- **Bundle** (`scalene-gui-bundle.js`) contains the literals `toggleCombinedStacks`,
  `toggleCombinedStacksTimeline`, `toggleMemoryStacks` (global names) and `timeline-axis`,
  `timeline-gridlines`, `memory-axis`, `memory-gridlines` (real class names, §4.11.4, §4.12.2).
- **TS entry `scalene-gui.ts`** (in our tree: `src/scalene-gui.ts`) contains `pickNiceTickInterval`,
  `formatTimelineTickLabel`, `renderTimelineAxis`, `renderTimelineGridlines`,
  `formatMemoryTickLabel`, `renderMemoryAxis`, `renderMemoryGridlines`, `makeFileSourceLookup`,
  `renderTimelineFrames` and `renderTimelineContent`. It MUST have this exact shape (the test slices the
  text between definitions):

```ts
// src/scalene-gui.ts (excerpt; the order matters for the test's text slicing)
import { pickNiceTickInterval, formatTimelineTickLabel, formatMemoryTickLabel,
  renderTimelineAxis, renderTimelineGridlines, renderMemoryAxis, renderMemoryGridlines } from "./charts/axis";
import { makeFileSourceLookup, type SourceLookup } from "./model/source";
import { mountTimeline, renderTimelineFrames, type TimelineMount } from "./views/timeline/timeline";

export function renderCombinedStacksTimeline(host: HTMLElement, ctx: ViewContext): TimelineMount {
  const sourceLookup = makeFileSourceLookup(ctx.model);
  return renderTimelineContent(host, ctx, sourceLookup);
}

function renderTimelineContent(host: HTMLElement, ctx: ViewContext, sourceLookup: SourceLookup): TimelineMount {
  // dispatches Lanes / Interleaved / single-thread; frames are drawn by renderTimelineFrames(…, sourceLookup)
  return mountTimeline(host, ctx, { sourceLookup, drawFrames: renderTimelineFrames });
}
```
- **Rendered HTML** (both modes) contains `.combined-stacks-section` and `.flame-segment` (template
  `<style>`, §7.1). The standalone HTML contains `Scalene` and `toggleCombinedStacks`, and does **not**
  contain `experimental` (any case) or `bg-warning text-dark`.
- The bundle does **not** contain `marker_native_symbol` or `user_inner_function`.
- WP1's `build.mjs` post-build check fails the build if any of these rules is violated (plus
  `</script` / `<!--`).

### 7.6 Files and hosts
- Bundle filename stays **`scalene-gui-bundle.js`** (`launchbrowser.GUI_ASSETS` copies only known
  names). No other new asset is needed: no fonts, images, CSS files or chunks. `favicon.ico` stays.
- Upstream layout after integration: our `src/` becomes `scalene/scalene-gui/src/` (or is copied
  flat), `src/scalene-gui.ts` is the TS entry the test reads, the template replaces
  `scalene/scalene-gui/index.html.template`, and `node build.mjs` writes the bundle next to it. The
  jQuery/Bootstrap/Prism assets become unused (they can stay in `GUI_ASSETS` until upstream removes
  them).
- `profile` inputs: object literal from the template; JSON text (from `loadFile`/`loadFetch`); `{}`;
  `""` (guarded); the merged Neuron profile (indent 2, unsorted keys).

---

## 8. Implementation plan (TypeScript, `scalene-ui/src`)

### 8.1 Ground rules
- TypeScript strict (existing `tsconfig.json`), ES2020 target, **no npm dependencies**, relative
  imports **without extensions** (`import { fmtPct } from "../core/format"`). `node build.mjs`
  compiles `src/` with `tsc` and bundles it into `dist/scalene-gui-bundle.js`. CSS in
  `src/styles/*.css` is concatenated in file-name order into `src/generated/styles.ts`, and `main.ts`
  injects it as one `<style id="scalene-ui-css">`.
- **Rendering**: plain DOM through a tiny `h()` helper (no framework, no `innerHTML` with data), inline
  SVG for icons and sparklines, Canvas 2D for dense charts (base + overlay pairs). Views own their
  subtree and update it imperatively on store/bus events.
- **State**: one store (`core/store.ts`) for durable UI state; one typed bus (`core/bus.ts`) for
  transient events (hover, jumps). The model is immutable and shared.
- Each view module exports `mount(host, ctx): ViewHandle`. A view never touches another view's DOM.
  It talks through `ctx.nav`, the store and the bus.
- Tests: `tests/unit/*.test.mjs` (plain `node:assert`) require the compiled CommonJS output in
  `build/` (`node build.mjs && node tools/unit.mjs`). Browser checks: `tools/*.mjs` use
  `require("playwright")` and `chromium.launch()` with no options.

### 8.2 Module tree and responsibilities

```
scalene-ui/
  build.mjs                 + post-build checks (§7.5 literals, forbidden strings, size budget)   [WP1]
  template/index.html.template                                                                   [WP1]
  tools/render-fixture.mjs  template + fixture → out/<name>.html (standalone and non-standalone;
                            tiny Jinja subset: {{ x }}, {{ profile or '{}' }}, {% if %}/{% else %}, {# #}) [WP1]
  tools/unit.mjs            runs tests/unit/*.test.mjs                                            [WP1]
  tools/check-tokens.mjs    parses 00-tokens.css; recomputes §3.7 contrast; fails below target     [WP1]
  tools/check.mjs           Playwright: console errors, overflow matrix, a11y walk, geometry      [WP1 skeleton → WP6]
  tools/perf.mjs, tools/shots.mjs, tools/filmstrip.mjs                                            [WP6]
  tests/unit/               format, model goldens, headline, findings, readouts, classify, axis,
                            visibility, syntax, virtual list math, placement                      [WP1; others add theirs]
  src/
    main.ts                 inject CSS; host.init(); theme/motion/layout init; install globals      [WP1]
    scalene-gui.ts          upstream-compatible facade: window globals + test-contract functions  [WP1]
    types.ts                (exists) profile JSON types
    ai/                     (exists) provider/prompt/settings port — bug fixes only, by WP5
    core/
      dom.ts                h(), svg(), clear(), listen() with disposer, escapeHtml, uid()
      store.ts              createStore<AppState>(); get/set/update/subscribe(selector, cb)
      bus.ts                createBus<Events>(); on/off/emit
      format.ts             §4.0.2 formatters (incl. upstream-named tick formatters)
      layout.ts             breakpoints, short, coarse pointer; sets <html> classes; layout:changed
      theme.ts              resolve/apply/persist theme; tokens() cache for canvas; theme:changed
      motion.ts             §5.5
      schedule.ts           slice(fn, budgetMs), idle(fn), nextFrame(), throttleRaf(fn)
      storage.ts            safe localStorage get/set/remove (try/catch); key registry
      canvas.ts             createCanvasPair(), dpr cap 2, hatch(kind), fitText(), roundRect()
      a11y.ts               announcer (#sr-polite/#sr-assertive), inert manager + focus trap,
                            roving tabindex helper, ensureVisibleThenFocus()
      tooltip.ts            §4.19
      toast.ts              §4.18
      icons.ts              §3.6 (SVG path data + icon(name, size?))
      controls.ts           §4.21 builders: button, iconButton, segmented, tabs, select, switch,
                            menu, disclosure, chip, badge, keyChip
      virtual.ts            variable-height virtual list engine (§4.8.10)
      host.ts               VS Code bridge, openInEditor, heartbeat, query flags (?motion, ?still, ?perf)
    model/
      normalize.ts          ProfileInput → NormProfile + Caps (§4.0.1)
      source.ts             makeFileSourceLookup(model) → SourceLookup
      model.ts              buildModel(raw) → Model (§4.0.7, rankings, totals, membership, leaks)
      syntax.ts             stringLines(), highlight(line, inString) (§4.0.5)
      classify.ts           classifyFrame(), classifyStack() (§4.0.6, verbatim upstream regexes)
      stacks.ts             buildFlameTree(cpu|memory), callContext(file, line)
      timeline.ts           buildTimeline(): runs, dt, threads, laneTotals, segments, bucketize(),
                            phases(), tasksAt()
      memory.ts             m4(samples, px), footprintAt(t), peakInfo()
      headline.ts           buildHeadline(model) → HeadlineModel; shortCode()
      readouts.ts           selectReadouts(model) → ReadoutSpec[] (§4.3.1)
      findings.ts           buildFindings(model) → Finding[] (§4.6.2)
      visibility.ts         rowClasses(file), buildCodeItems(file, mode, sort, unfolded, extras)
      search.ts             buildIndex(model) (lazy), query(q) → grouped results
    charts/
      axis.ts               pickNiceTickInterval, niceMemStep, formatTimelineTickLabel,
                            formatMemoryTickLabel, renderTimelineAxis, renderTimelineGridlines,
                            renderMemoryAxis, renderMemoryGridlines
      placement.ts          rect math + callout placement (§4.4.7)
      meter.ts              DOM meters (segmented/single, graduations, avg tick)
      sparkline.ts          SVG polyline sparkline (§3.3)
      raster.ts             histogram strip on canvas (TOP LINES, "When it ran")
      footprint.ts          footprint area/line drawer + peak marker + callout via placement.ts
    views/
      app.ts                shell: #scalene-app layout, sections, lazy mount, empty-state switch,
                            layer root, Nav implementation (jumpTo dispatcher), global keys     [WP1]
      appbar.ts             §4.1                                                                [WP1]
      overview/             overview.ts headline.ts readouts.ts scope.ts hotspots.ts findings.ts  [WP2]
      code/                 codesection.ts filenav.ts codeview.ts columns.ts minimap.ts detail.ts
                            functions.ts                                                        [WP3]
      stacks/               stackssection.ts flame.ts                                          [WP4]
      timeline/             timeline.ts                                                         [WP4]
      memory/               memoryview.ts                                                       [WP4]
      ai/                   controller.ts card.ts drawer.ts                                     [WP5]
      shell/                loader.ts empty.ts footer.ts palette.ts shortcuts.ts                [WP5]
    styles/
      00-tokens.css 01-base.css 02-layout.css 03-controls.css 04-layers.css 10-appbar.css      [WP1]
      20-overview.css                                                                          [WP2]
      30-code.css                                                                              [WP3]
      40-stacks.css 50-timeline.css 60-memory.css                                              [WP4]
      70-ai.css 80-shell.css                                                                   [WP5]
      90-motion.css (shared keyframes: reveal, fade, flash, pulse)                             [WP1]
```

### 8.3 Core interfaces (exact TypeScript; WP1 implements, everyone codes against them)

```ts
// ── core/store.ts ───────────────────────────────────────────────────────
export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
export type DisplayMode = "profiled-functions" | "profiled-lines" | "all";
export type Metric = "time" | "memory" | "gpu" | "await";
export type ColumnKey = "line" | "time" | "mem" | "gpu" | "await" | "idle" | "nrt" | "nc" | "trend"
  | "copy" | "gpumem" | "alloc" | "avg" | "source";
export interface SortState { key: ColumnKey; dir: "desc" | "asc" }
export type Target = { file: string; line: number } | { file: string; fn: string };
export type SectionId = "overview" | "code" | "stacks" | "timeline" | "memory";
export type FlameColorMode = "kind" | "file" | "self";

export interface AppState {
  theme: "light" | "dark";
  themeSource: "user" | "system" | "vscode";
  reducedMotion: boolean;
  layout: { bp: Breakpoint; short: boolean; coarse: boolean };
  selection: Target | null;                 // sticky; drives lens/dock, scope overlay, outlines
  hover: Target | null;                     // transient linked highlight
  hotspots: { kind: "lines" | "functions" | "files"; metric: Metric; showAll: boolean };
  code: {
    file: string | null;
    view: "lines" | "functions";
    wrap: boolean;
    perFile: Record<string, { mode: DisplayMode; sort: SortState | null; unfolded: number[] }>;
  };
  flame: { tab: "cpu" | "memory"; zoom: { cpu: string | null; memory: string | null };
           search: string; color: { cpu: FlameColorMode; memory: FlameColorMode } };
  timeline: { view: "lanes" | "interleaved"; thread: string; domain: [number, number] | null;
              expanded: string[] };
  memory: { siteOrder: "peak" | "allocated"; site: { file: string; line: number } | null };
  range: [number, number] | null;            // scope brush (seconds)
  layers: { drawer: boolean; palette: boolean; shortcuts: boolean; fileSheet: boolean };
}
export interface Store<S> {
  get(): S;
  set(patch: Partial<S>): void;                         // shallow merge + notify
  update(fn: (s: S) => Partial<S>): void;
  subscribe<T>(select: (s: S) => T, cb: (v: T, prev: T) => void): () => void;  // fires on !Object.is
}
export function createStore<S>(initial: S): Store<S>;

// ── core/bus.ts ─────────────────────────────────────────────────────────
export type Source = "headline" | "readout" | "hotspot" | "scope" | "finding" | "code" | "minimap"
  | "flame" | "timeline" | "memory" | "palette" | "global" | "detail";
export interface JumpOptions { focus?: boolean; open?: boolean; flash?: boolean; source?: Source }
export interface Events {
  "profile:loaded": { model: Model };
  "hover:line": { target: Target | null; source: Source };
  "hover:peak": { on: boolean };
  "range:set": { range: [number, number] | null; source: Source; reveal?: boolean };
  "stacks:show": { target: Target };
  "timeline:show": { target: Target };
  "theme:changed": { theme: "light" | "dark" };
  "motion:changed": { reduced: boolean };
  "layout:changed": AppState["layout"];
  "hotspots:changed": { items: HotspotItem[] };          // drives scope TOP LINES + minimap pins
  "ai:open-settings": { focusField?: string };
}
export interface Bus<E> {
  on<K extends keyof E>(k: K, cb: (p: E[K]) => void): () => void;
  emit<K extends keyof E>(k: K, p: E[K]): void;
}

// ── views/app.ts (Nav) ──────────────────────────────────────────────────
export interface Nav {
  jumpTo(target: Target, opts?: JumpOptions): Promise<void>;   // §4.8.12; mounts Code if needed
  showSection(id: SectionId, opts?: { focus?: boolean; tab?: "cpu" | "memory" }): Promise<void>;
  showInStacks(target: Target): Promise<void>;                  // §4.11.6
  showInTimeline(target: Target): Promise<void>;
  openInEditor(file: string, line: number): void;               // host bridge (§7.4)
}
// Views register handlers the Nav calls (only the owning view implements them):
export interface CodeApi { reveal(target: Target, opts: JumpOptions): Promise<void>; currentFile(): string | null }
export interface StacksApi { focusLine(target: Target): void; selectTab(tab: "cpu" | "memory"): void }
export interface TimelineApi { focusLine(target: Target): void; setDomain(r: [number, number] | null, animate: boolean): void }

// ── shared view contract ────────────────────────────────────────────────
export interface ViewContext {
  model: Model; store: Store<AppState>; bus: Bus<Events>; nav: Nav;
  tooltip: Tooltip; toast: Toast; announce: Announcer; theme: ThemeApi; motion: MotionApi;
  host: HostApi; ai: AiController;
  registerApi(name: "code" | "stacks" | "timeline", api: CodeApi | StacksApi | TimelineApi): void;
}
export interface ViewHandle { destroy(): void }
export type MountFn = (host: HTMLElement, ctx: ViewContext) => ViewHandle;

// ── core/theme.ts ───────────────────────────────────────────────────────
export interface ThemeApi {
  current(): "light" | "dark";
  set(choice: "light" | "dark" | "system"): void;
  tokens(): Readonly<Record<string, string>>;   // e.g. tokens()["cpu-py"], ["font-mono"]; cached per theme
  num(name: string): number;                    // numeric tokens, e.g. "glow", "frame-dim"
}

// ── core/canvas.ts ──────────────────────────────────────────────────────
export interface CanvasPair {
  base: HTMLCanvasElement; overlay: HTMLCanvasElement;
  b: CanvasRenderingContext2D; o: CanvasRenderingContext2D;
  width: number; height: number; dpr: number;      // CSS px; dpr capped at 2
  resize(w: number, h: number): void; clearOverlay(): void; destroy(): void;
}
export function createCanvasPair(host: HTMLElement, opts?: { interactive?: boolean }): CanvasPair;
export function hatch(ctx: CanvasRenderingContext2D, kind: "system" | "waiting" | "short-phase", t: ThemeApi): CanvasPattern;
export function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number, mode: "end" | "middle" | "code"): string;

// ── core/virtual.ts ─────────────────────────────────────────────────────
export interface VItem { key: string; kind: string; height: number | "measure"; estimate?: number }
export interface VirtualList<T extends VItem> {
  setItems(items: readonly T[], keepAnchorKey?: string): void;   // keeps the anchor row in place
  scrollToKey(key: string, align: "center" | "start", behavior: ScrollBehavior): Promise<void>;
  elementFor(key: string): HTMLElement | null;                   // null when not rendered
  visibleKeys(): string[];
  refresh(keys?: string[]): void;
  destroy(): void;
}
export function createVirtualList<T extends VItem>(opts: {
  container: HTMLElement;                         // in-flow element; window is the scroller
  render(item: T, reuse: HTMLElement | null): HTMLElement;
  overscanPx?: number;                            // default 600
  onRange?(first: number, last: number): void;
}): VirtualList<T>;

// ── core/tooltip.ts, toast.ts, a11y.ts, motion.ts, host.ts ─────────────
export interface TooltipContent { title?: string; kind?: string; rows?: [string, string][]; code?: string; hint?: string }
export interface Tooltip { show(at: { x: number; y: number } | Element, c: TooltipContent, opts?: { delay?: number; describe?: Element }): void; move(x: number, y: number): void; hide(): void }
export interface Toast { show(t: { kind: "info" | "success" | "error"; text: string; action?: { label: string; run(): void }; sticky?: boolean }): () => void }
export interface Announcer { polite(text: string): void; assertive(text: string): void }
export interface MotionApi { readonly reduced: boolean; tween(key: string, ms: number, ease: (t: number) => number, step: (t: number) => void, done?: () => void): { cancel(): void }; flip(nodes: HTMLElement[], mutate: () => void, ms?: number): void; countUp(el: HTMLElement, finalText: string, opts?: { ms?: number; delay?: number }): void; revealOnce(el: Element, cb: () => void): () => void }
export interface HostApi { readonly isVsCode: boolean; readonly isHttp: boolean; openInEditor(rawFile: string, line: number): void; flags: { still: boolean; motion: "reduce" | null; perf: boolean } }
```

### 8.4 Model interfaces (`model/model.ts`; WP1)

```ts
export interface Caps { memory: boolean; gpu: boolean; neuron: boolean; async: boolean; coreUtil: boolean;
  gpuMemory: boolean; regions: boolean; functionBounds: boolean; cpuSamples: boolean; startTime: boolean;
  stacks: boolean; timeline: boolean; threadIds: boolean; memStacks: boolean; peakLocation: boolean;
  peakPyFraction: boolean; leaks: boolean }

export interface LineM {
  file: FileM; no: number; text: string; doc: boolean;          // unescaped text; docstring flag
  py: number; nat: number; sys: number; total: number; sec: number;
  coreUtil: number | null;
  peak: number; avg: number; malloc: number; mallocs: number; pyFrac: number; usage: number; copy: number;
  memSamples: Float64Array;                                     // [t0, mb0, t1, mb1, …], t in seconds
  gpu: number; gpuPeak: number | null; gpuAvg: number | null;
  await: number; concMean: number; concPeak: number; tasks: readonly string[]; coro: boolean;
  cpuTimes: Float64Array;                                       // seconds since start, sorted
  region: [number, number]; outer: [number, number] | null; fnRange: [number, number] | null;
  fn: FunctionM | null;
  leak: { likelihood: number; velocity: number } | null;
  neuron: { nrtMs: number; nrtPct: number; ncMs: number; idlePct: number | null; nrtCount: number; ncCount: number; kernel: string | null } | null;
  hasMem: boolean; cls: "data" | "context" | "empty"; regionTotal: number; regionHead: boolean;
  timeRank: number | null;                                      // 1-based rank among lines by time
}
export interface FunctionM { file: FileM; name: string; no: number; range: [number, number] | null;
  py: number; nat: number; sys: number; total: number; sec: number; peak: number; avg: number; malloc: number;
  usage: number; copy: number; gpu: number; gpuPeak: number | null; await: number; coro: boolean; memSamples: Float64Array }
export interface FileM { name: string; base: string; dir: string; no: number; hidden: boolean; dense: boolean;
  pct: number; py: number; nat: number; sys: number; total: number; peak: number; peakLine: LineM | null;
  gpuPeak: number; nrtMs: number; ncMs: number; lines: LineM[]; byNo: Map<number, LineM>;
  functions: FunctionM[]; imports: string[]; leaks: LineM[] }

export interface Model {
  raw: unknown; caps: Caps; program: string; base: string; args: string[];
  elapsed: number; tMax: number; startEpoch: number | null; version: string; date: string;
  files: FileM[]; hiddenFiles: FileM[]; fileByName: Map<string, FileM>;
  split: { py: number; nat: number; sys: number; total: number; outside: number };
  maxLineTotal: number; maxLinePeak: number; maxLineAwait: number;
  rank: { lines: Record<Metric, LineM[]>; functions: Record<Metric, FunctionM[]>; files: Record<"time" | "memory", FileM[]> };
  memory: { samples: Float64Array; peak: number; peakT: number | null; peakLine: LineM | null;
            pyFrac: number | null; growth: number; native: number; allocated: number } | null;
  gpu: { name: string; mean: number; method: "main-thread" | "all-lines"; devicePeak: number | null; busiest: LineM | null } | null;
  neuron: { nrtMs: number; ncMs: number; idleOverall: number | null } | null;
  async: { topAwait: LineM | null; loopLine: LineM | null } | null;
  leaks: LineM[];
  headline: HeadlineModel; readouts: ReadoutSpec[]; findings: Finding[];
  // lazy (built on first access, sliced):
  timeline(): Promise<TimelineM | null>;        // runs, dt, threads, laneTotals, segments, phases
  flame(kind: "cpu" | "memory"): Promise<FlameTree | null>;
  callContext(file: string, line: number): Promise<CallContext | null>;
  search(): Promise<SearchIndex>;
}
```

`HotspotItem = { rank: number; kind: "line" | "function" | "file"; target: Target; value: number;
secondary: string; code: string; location: string; badge: Badge | null; times: Float64Array }` (times =
the TOP LINES samples). `ReadoutSpec`, `Finding`, `HeadlineModel`, `TimelineM`, `FlameTree` and
`CallContext` are defined in their modules with the fields named in §4.

### 8.5 AI controller and card interfaces (`views/ai/*`; WP5 implements, WP3 consumes)

```ts
export type AiCardState =
  | { status: "setup"; message: string; missing: string[] }
  | { status: "working"; startedAt: number; provider: string; model: string; mode: "line" | "region"; start: number; end: number }
  | { status: "result"; result: OptimizationResult; view: "proposal" | "diff"; showPrompt: boolean }
  | { status: "error"; error: AiError; mode: "line" | "region" };
export interface AiController {
  settings(): AiSettings;
  ready(): Readiness;
  providerSummary(): string;                                     // "Anthropic · claude-sonnet-4-5" | "No AI provider set up"
  availability(file: string): Map<number, ProposalAvailability>; // cached per file
  request(file: string, line: number, mode: "line" | "region"): void;
  cancel(anchor: string): void; dismiss(anchor: string): void;
  card(anchor: string): AiCardState | null;                      // anchor = `${file}:${startLine}`
  anchors(file: string): string[];                               // for building code items
  openSettings(focusField?: string): void;
  onChange(cb: (anchor: string | null) => void): () => void;     // null = settings changed
}
export function renderAiCard(el: HTMLElement | null, anchor: string, ctx: ViewContext): HTMLElement;  // card.ts
```

### 8.6 Work packages (strict file ownership; nobody edits another package's files — request a change from its owner)

**WP1 Foundation** (first; blocks all others; target 1 engineer-week)
- Owns: `build.mjs`, `tsconfig.json`, `template/`, `tools/{render-fixture,unit,check-tokens,check}.mjs`
  (check = skeleton), `tests/unit/` (initial), `src/main.ts`, `src/scalene-gui.ts`, `src/core/*`,
  `src/model/*`, `src/charts/*`, `src/views/app.ts`, `src/views/appbar.ts`, styles `00–04, 10, 90`.
- Delivers: tokens CSS exactly as §3.2; every core/model/charts module in §8.2–8.4; the app shell
  with the sections in §2.1 as placeholders (`mount` stubs that later packages replace by importing
  their modules in `views/app.ts`; the import lines are added by WP1 up front); the app bar; Nav;
  globals (§7.3, delegating to registered APIs); template; build checks; fixture renderer.
- Acceptance:
  1. `node build.mjs` passes (types, literals, forbidden strings, size budget). `node tools/unit.mjs`
     passes: formatters (§4.0.2 rows), model goldens (Appendix A: split, outside, top-8 lines and
     totals, GPU mean 66.9, peak 3.11 GiB at 52.9 s, leaks order, lane totals), headline strings for
     all 7 fixtures, readout slots, finding ids, classify totals, `pickNiceTickInterval`,
     `niceMemStep`, shortCode cases, visibility predicates (upstream examples), placement.
  2. `tools/render-fixture.mjs` renders all 8 fixtures in both modes. In Chromium each page loads with
     **zero console errors**, shows the app bar and the section skeleton, sets `document.title`, and
     `empty.json` shows the empty-state placeholder.
  3. `tools/check-tokens.mjs` passes (§3.7). The theme toggle works and persists. `layout` classes are
     correct at the 7 reference widths. No horizontal overflow from the shell at 320 px.
  4. `src/scalene-gui.ts` satisfies the §7.5 text rules (a unit test re-implements the upstream
     slicing checks).

**WP2 Overview** (after WP1; parallel with WP3–WP5)
- Owns: `src/views/overview/*`, `src/styles/20-overview.css`.
- Delivers: §4.2–4.6 and the overview parts of §2.3/2.4 (all breakpoints, `xs` reordering), intro
  M1–M6, linked overlays, `scope.debugLayout()`.
- Acceptance: the first-screen rules of §1.3.1 at 1440×900, 390×844 and 1000×400 (screenshots in
  `design/screens/`); golden headline and readouts visible for ml, async, cpu, neuron, huge; scope
  geometry test passes at 390/1000×400/1440 on ml and huge; cpu-only shows no THREADS channel and no
  empty findings card; the intro filmstrip settles by 900 ms and matches `?still`; reduced motion =
  final frame at 40 ms; hotspots keyboard (one Tab stop, arrows, Enter jumps, focus lands on the code
  row); hover on hotspot #1 draws its sample overlay in ≤ 2 ms (overlay draw time measured with `?perf`).

**WP3 Code** (after WP1)
- Owns: `src/views/code/*`, `src/styles/30-code.css`.
- Delivers: §4.7–4.10, `CodeApi.reveal` (= §4.8.12 steps 1–8), the ribbon minimap, rendering of AI
  cards through `renderAiCard` (from WP5; stub until it lands).
- Acceptance: column sets per fixture (ml: line, time, mem, gpu, trend, copy, gpumem, alloc, avg at
  2560; neuron: idle/nrt/nc and no GPU columns; cpu-only: line, time, source); display modes and folds
  match the upstream predicates (unit test on `visibility.ts` plus a DOM test: ml `train.py` in
  "Profiled functions" mode shows no hidden data row); sorting cycles desc → asc → source; `jumpTo`
  from hotspots, palette and flame lands focused on the row with the lens open; DOM < 2,500 nodes in
  the code view on huge `sparse.py` in All lines; 60 fps scroll; `role=table` semantics with
  `aria-rowcount`/`aria-rowindex`/`aria-sort`; minimap slider keyboard; dock at ≥ 1600, lens below;
  wrap mode on `xs` without overflow.

**WP4 Canvas views: Stacks, Timeline, Memory** (after WP1)
- Owns: `src/views/stacks/*`, `src/views/timeline/*`, `src/views/memory/*`, styles `40/50/60`.
- Delivers: §4.11–4.13, `StacksApi`, `TimelineApi`, the class names `flame-axis`, `memory-axis`,
  `memory-gridlines`, `timeline-axis`, `timeline-gridlines`, `flame-segment` used for real, and
  `renderTimelineFrames(…, sourceLookup)` exported for the facade.
- Acceptance: the flame axis re-bases on zoom; search share on ml ("train" → matches report the share
  of samples); lateral zoom is staged; the keyboard walk announces frames; timeline lane totals equal
  the model's (0.6 / 2.8 / 0.9 on ml); run ends follow §4.0.7; brush/zoom/keys; Interleaved and
  thread filter (including "unknown" on a synthetic profile); memory rug for the selected site; leak
  sites pinned; perf budgets of §6.1 on huge (base draw ≤ 8 ms timeline, ≤ 6 ms flame; hover ≤ 2 ms).

**WP5 AI + Shell** (after WP1)
- Owns: `src/views/ai/*`, `src/views/shell/*`, styles `70/80`; bug fixes in `src/ai/*` (with tests).
- Delivers: §4.14–4.20 except the app bar; the AI controller; the drawer; cards; loader + drop overlay;
  empty state; footer; palette; shortcuts dialog; the AI globals of §7.3.
- Acceptance: with a mocked `fetch`, every provider's happy path renders a result card (proposal and
  diff), every `AiError` kind renders its copy and actions, Cancel aborts, and Regenerate replaces the
  card; the drawer is a real modal (40 Tabs stay inside, Esc returns focus) and saves to the upstream
  storage keys (a test reads localStorage); no network request on page load in a `file://` page and
  on `http://` (only `/env-api-keys.json` and `/heartbeat`); invalid JSON drop → error toast and
  the report stays; `{}` → empty state; palette results for "loss.item", "train", "Timeline".

**WP6 Integration and QA** (after WP2–WP5 land; owns all files after each package's acceptance)
- Owns: `tools/{check,perf,shots,filmstrip}.mjs`, `design/screens/`, the must-fix register
  sign-off; after hand-over, any file for cross-cutting fixes.
- Delivers: the cross-view linking audit (every source in §4.8.12 and §4.4.6 works); motion
  choreography tuning (§5); the perf pass (§6.1 table on huge and ml); the accessibility pass
  (§6.2.11 script + keyboard walk); the overflow matrix (§6.2.9); the screenshot set (2560, 1440,
  1024, 390, 1000×400 × light/dark × ml/async/cpu/neuron/huge/empty) committed to
  `design/screens/`; parity checklist sign-off (§8.8).
- Acceptance: every row of §1.4 and §8.8 is checked with evidence; `tools/check.mjs` passes on all
  fixtures in both themes; no console errors anywhere.

### 8.7 Delivery order and integration points
1. WP1 lands (interfaces frozen; changes need a DESIGN.md amendment).
2. WP2, WP3, WP4 and WP5 work in parallel against the frozen interfaces. Day-1 stubs: WP5 ships a
   `renderAiCard` stub and an `AiController` returning "setup"; WP3 ships `CodeApi.reveal` that at least
   switches file and scrolls; WP4 ships `StacksApi`/`TimelineApi` no-ops. This lets cross-links work
   early.
3. WP6 integrates, then runs the full check matrix and the polish loop.

### 8.8 Parity checklist (feature inventory §10 → where it lives)

| # | Parity item (feature-inventory §10) | Component / section | WP |
|---|---|---|---|
| 1 | Template vars, standalone / non-standalone, `scalene-gui-bundle.js`, offline, 400 px iframe, guard empty `profile` | §7.1, §7.6, §2.3 `short`, §4.16 | WP1 |
| 2 | Upstream test literals in bundle, TS source and template | §7.5, build checks | WP1 (+WP4 class names) |
| 3 | All window globals (names, signatures) incl. `load` re-render, `loadFile`, `loadDemo`, `loadFetch`, `toggleReduced` no-op | §7.3 | WP1 (+WP5 AI/loader globals) |
| 4 | VS Code `jumpToLine` (same shape, cached API); in-page navigation (reveal, smooth scroll, 1.2 s highlight); `vscode://file/…:line:1` fallback | §7.4, §4.8.12, M14 | WP1, WP3 |
| 5 | Heartbeat every 10 s; `/env-api-keys.json` over http(s) only | §7.2 | WP1, WP5 |
| 6 | `document.title = "Scalene - <program>"` | §4.17 | WP1 |
| 7 | Summary: CPU split, peak + Python/native split, memory timeline, max footprint, growth, native-thread allocations | §4.3 readouts, §4.4 MEMORY channel, §4.13 | WP2, WP4 |
| 8 | Files sorted by `percent_cpu_time`, exclusion rule (+ visible hidden count), first file expanded, show all / hide all, per-file CPU + memory summary, "% of time (t / total)", Neuron NRT/NC totals | §4.7, §4.8.1 file bar, §4.8.5 `expandAll`/`collapseAll` | WP3 |
| 9 | Line and function tables, every column, conditional on memory/gpu/async/neuron, same thresholds | §4.8.3–4.8.4, §4.0.4, §4.10 | WP3 |
| 10 | Display modes, docstring styling, `\uXXXX` unescaping, Python highlighting | §4.8.5, §4.0.5, §4.0.1 | WP1, WP3 |
| 11 | Sort by every column (direction fixed), reset to line order | §4.8.8 | WP3 |
| 12 | Leak indication on memory timelines with velocity | §4.8.4 trend/mem cells, §4.9 memory block, §4.3 leaks tile, §4.13 | WP2, WP3, WP4 |
| 13 | AI: ⚡ per eligible line, 💥 per region head (≤ 50 lines, region ≥ 1 %), same prompt, six providers with all fields, model refresh, custom model/URL, Azure API version, Ollama discovery, per-provider validation, working state, inline highlighted result, copy, regenerate, persistence keys, env prefill, default provider | §4.8.7, §4.9 AI footer, §4.14 | WP3, WP5 |
| 14 | Call stacks flame (icicle, merge key, sort by weight, py/native colouring, tooltip with source line, click to navigate) | §4.11 (click = zoom; double-click / `g` = navigate; documented change) | WP4 |
| 15 | Timeline: runs, GC/IO/GIL patterns, tracks, thread track/colours/labels/legend, interleaved / swimlanes / single thread, merged segments, axis with nice ticks and gridlines, tooltips, click to navigate | §4.12, §4.0.6, §4.0.7 | WP4 |
| 16 | Memory stacks flame with MB axis, gridlines, formatted tooltips | §4.11.4 (MiB axis, `memory-axis`, `memory-gridlines`), §4.11.6 | WP4 |
| 17 | Resizable chart areas | replaced by content-sized charts + zoom (§4.11.5, §4.12.2); documented deviation | WP4 |
| 18 | Empty state with file picker; "load another profile"; footer links and version/date | §4.16, §4.15, §4.17 | WP5 |

Documented, intentional deviations (each fixes an upstream bug or usability problem): sort direction
(desc first), keyless columns sort last, `jumpTo` unfolds one fold instead of switching to "all",
run ends per thread, the `[await]`-as-I/O lane label "I/O & waits", region totals inclusive of the end
line, no Ollama/OpenAI network on load, no `alert()`, the GPU readout method, binary unit labels, no
GA in standalone (unchanged), and click-to-zoom in the flame (navigation moved to double-click / `g`).

---

## Appendix A. Golden values per fixture (verified from the fixtures; unit and E2E tests assert them)

Dates are formatted in **UTC** in tests (`TZ=UTC`); the product uses local time.

### A.1 `ml-training.json`
- Headline: "train.py ran for **54.1 s**. Two lines in `train()` account for **37.6%** of the time;
  memory peaked at **3.11 GiB**."
- Meta: "Profiled Oct 27, 2026, 14:22 · 6 files · 5 threads · GPU · 10 ms sampling · Scalene ⟨version⟩".
- Readouts: **Time** Python 11.6% · native 61.9% · system 26.1%, "0.4% outside profiled files" ·
  **Peak** 3.11 GiB, at 52.9 s · train.py:120 · Python 1.0%, growth 52.2% · +212 MiB native threads ·
  **GPU** 66.9% (main-thread method), peak device memory 8.62 GiB, busiest train.py:173 96.4% ·
  **Leaks** 2: metrics.py:42 5.71 MiB/s (99.7%), loader.py:33 288 KiB/s (96.2%).
- Hotspots (time): 1 train.py:173 21.4% 11.6 s · 2 train.py:165 16.2% 8.78 s · 3 train.py:120 4.9%
  2.64 s · 4 train.py:17 4.5% 2.41 s · 5 train.py:145 3.6% 1.94 s · 6 loader.py:33 2.9% 1.57 s · 7
  train.py:167 2.6% 1.39 s · 8 metrics.py:39 2.4% 1.30 s. Pareto "Top 8 lines = 58.4% of run time".
- Functions: `train` 47.1% (25.5 s, peak 2.01 MiB, GPU 81.8%), `save_checkpoint` 4.9% (peak 1.20 GiB).
  Region 152–184 = 43.4% of run.
- Memory: Σ allocated 3.27 GiB; train.py:120 peak 1.20 GiB, alloc 33.0%, copy 22.0 MiB/s; loader.py:18
  800 MiB; metrics.py:42 614 MiB (leak).
- Stacks: 336 stacks, 5,901 samples, depth 19; train.py:173 appears in 1,157 of 5,901 (19.6%).
  Memory stacks: 30, 3.17 GiB; `save_checkpoint:120` = 1.17 GiB (36.8%).
- Timeline: 4,933 runs, 5 threads, dt 10 ms; lanes GC 0.6%, I/O & waits 2.8%, GIL 0.9%.
- Findings (order): gpu-sync (train.py:173) · leak (metrics.py:42) · leak (loader.py:33) · peak ·
  copy (train.py:120, 22.0 MiB/s) · native (61.9%). Shown: the first 3 + "Show 3 more".
- Code columns at 2560: line, time, mem, gpu, trend, copy, gpumem, alloc, avg, source.

### A.2 `async-server.json`
- Headline: "bench_server.py ran for **15.7 s**. **59.6%** of it is the event loop
  (`asyncio.run(…)`), mostly waiting. The busiest code, `hashlib.pbkdf2_hmac(…)` (21.6%,
  handlers.py:51), runs inside a coroutine, so the loop stalls while it runs."
- Readouts: Time 12.3% · 32.4% · 55.3% (no "outside" part; the files sum to 100.00000000000001 →
  clamp to 0) · Peak 50.1 MiB at 15.2 s · cache.py:24 · Python 90.0%, growth 15.9% · **Await** 35.8% at
  `await asyncio.sleep(…)` bench_server.py:59, 15.5 tasks suspended on average, 22 at most ·
  **Elapsed** 15.7 s, 1 thread, 14,656 samples.
- Hotspot #1 (bench_server.py:99) carries the badge "event loop · waiting".
- Lanes: I/O & waits 95.7%, GC 0.1%, GIL 0.0%. Scope channels: PHASE, MEMORY, TASKS, TOP LINES
  (no THREADS).
- Findings: loop-blocked (handlers.py:51) · peak. No leaks ("growth without leak": growth shown, no
  badges).

### A.3 `cpu-only.json`
- Headline: "nbody.py ran for **22.2 s**. Three lines in `accelerations()` account for **32.0%** of
  the time." (no memory clause)
- Readouts: Time 94.3% · 4.6% · 1.1% · Elapsed 22.2 s, 1 thread, 2,222 samples · Busiest function
  `accelerations()` 86.8%, 19.3 s.
- Scope: PHASE + TOP LINES only. No Memory section, no memory columns, no Findings card except
  python (94.3%).
- Code columns: line, time, source.

### A.4 `neuron.json`
- Headline: "infer_bert.py ran for **26.2 s**. `neuron_model(…)` (infer_bert.py:66) takes **37.7%**
  of the time; memory peaked at **742 MiB**."
- Readouts: Time 17.1% · 34.2% · 48.7% · Peak 742 MiB at 10.7 s · infer_bert.py:23 · **Neuron
  runtime** 9.89 s, "37.8% of run in NRT · NC 8.69 s (33.2%)", "device idle in 78.5% of CPU samples" ·
  Elapsed 26.2 s.
- No Stacks or Timeline sections (`--no-stacks`). The scope shows MEMORY + TOP LINES.
- Code columns include idle, nrt, nc; no GPU columns. Line 66: NRT 37.0% of run (9.69 s, 98.0% of
  NRT), NC 32.5%, device idle 12.4% (● low).
- Findings: peak · neuron-idle (preprocess.py:45, 11.4%, idle 100%).

### A.5 `basic.json` (mid-age format)
- Headline: "testme.py ran for **1.68 s**. Two lines in `doit2()` account for **41.6%** of the time;
  memory peaked at **10.2 MiB**." (membership through the indentation fallback)
- Readouts: Time 79.2% · 17.6% · 3.2% · Peak 10.2 MiB at 1.6 s · testme.py:13 · Python 100% ·
  Elapsed 1.68 s · Busiest function `doit2()` 67.9%.
- Findings: peak · copy (testme.py:23, 13.5 MiB/s) · python (79.2%). No stacks, no timeline; core
  utilisation is recorded; `cpu_samples_list` is absent → no TOP LINES, no "When it ran".

### A.6 `example.json` (very old format)
- Headline: "This program ran for **12.7 s**. `z1 = …` (testme.py:14) takes **34.6%** of the time;
  memory peaked at **46.2 MiB**." (no `program`; sparse lines → no function membership)
- Readouts: Time 72.6% · 25.1% · 2.2%, "0.1% outside profiled files" · Peak 46.2 MiB at 0.4 s, split
  and location "not recorded" · Elapsed 12.7 s · Busiest function `doit1()` 76.6%.
- **No "Core utilization 0%" anywhere** (`caps.coreUtil` false → "not recorded"). Sparse lines →
  `gap` items in All lines mode. 2,846 `samples` downsampled with M4.
- Findings: python (72.6%).

### A.7 `huge.json` (stress)
- Headline: "run_sim.py ran for **3 m 47 s**. Time is spread out: the busiest function,
  `update_basis()`, takes **5.8%**; memory peaked at **2.38 GiB**."
- Meta: "Profiled Oct 21, 2026, 02:17 · 24 files (+16 below 1%) · 12 threads · GPU · 10 ms sampling".
- Readouts: Time 75.2% · 17.2% · 7.2%, 0.5% outside · Peak 2.38 GiB at 49.5 s · thermal.py:169 ·
  GPU 22.8%, device peak 6.75 GiB · Leaks 2: registry.py:90 11 KiB/s (99.1%), statistics.py:66
  4 KiB/s (95.0%).
- Hotspot #1: fluids.py:495 `assert dist >= 0, "negative density"` 4.2% (the `>=` renders verbatim).
- Stacks 3,183, 51,784 samples, depth 38. Timeline 41,604 runs, 12 threads; GC 2.1%, I/O & waits
  4.0%, GIL 1.6% (no gil finding, < 2%).
- Findings: leak (registry.py:90) · leak (statistics.py:66) · peak · python (75.2%).
- Budgets (§6.1) are measured on this file.

### A.8 `empty.json`
`{}` → the empty state (§4.16). The app bar shows only the logo, Load and Theme. There is no console
error, and `document.title` is "Scalene".

---

## Appendix B. Decision log (closed questions)

| Question | Decision | Why |
|---|---|---|
| Default AI provider when nothing is stored | Keep upstream `defaultProvider(env)` (Amazon Bedrock last resort) | Behaviour parity; the card's setup state explains what to do |
| GPU readout method | Time-weighted over main-thread lines (66.9% on ml) | GPU is sampled on the main thread; worker lines record 0, which would bias the mean |
| I/O classification | Upstream names verbatim, no `@@GLIBC` stripping; lane named "I/O & waits" | One rule everywhere (2.8% on ml); the name matches what the list contains |
| Flame click | Click = zoom, double-click / `g` = open line | Zoom is the frequent action; the tooltip says so |
| Line jump into folded code | Reveal that fold only | Keeps the user's display mode |
| Treemap | Not used | Not area-true at scale; labels become stubs (judges) |
| Timeline memory row and Memory section both show the footprint | Keep both | Different jobs: alignment with threads vs. allocation-site narrative |
| Theme default | Follow system (VS Code body class in webviews) | Hosts differ; dark-first tuning stays in the tokens |
| Wrap long code lines | Off by default, on for `xs`; persisted per viewer | Fixed 24 px rows scan best on desktop; phones need wrapping |
| Deep links (`#file:line`) | Not in scope; section hashes only | Avoid history spam in iframes and webviews |

## Appendix C. Reference index
- Chosen prototype (concept A) source and pages: `design/reference/` (`index.html` = ml-training,
  `index-async.html`, `index-cpu.html`, `index-empty.html`, `index-neuron.html`, `index-example.html`;
  `src/` with the original JS/CSS; `concept.md`). Screenshots `design/reference/shot-*.png`.
- Alternatives: `design/alternatives/concept-B/` and `design/alternatives/concept-C/` (screenshots;
  prototype pages under 5 MB). Graft references from the judges: `concept-B/judge-B-light-map.png`
  (small multiples "when the top lines ran"), `judge-B-zoom-mid.png` / `judge-B-zoom-after.png`
  (semantic-zoom motion grammar), `concept-C/judge-C-light-timeline.png` (frame palette, crosshair
  chip, labelled lanes), `judge-C-fly-after.png` (inline lens). `reference/judge-filmstrip-A.png` shows
  A's original 1.8 s intro (to be shortened to ≤ 1.0 s), and `reference/judge-A-light-stacks.png` the
  weak light-theme frame tints that §3.4 replaces.
- The prototype is a **reference for look and motion only**. Where it differs from this document
  (e.g., the THREADS lanes, the separate scope/hotspot cards, the 1.8 s intro, opacity-dimmed cold code,
  the I/O hatch), this document wins.
