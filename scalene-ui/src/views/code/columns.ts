// Code-view columns (DESIGN.md §4.8.3–4.8.4, §4.8.11): which columns a profile has, which
// fit the width (priority budget), the two-line headers, the exact cell contents with their
// thresholds, cell tooltips, and the row aria-label. Cells are updated in place so the
// virtual list's node pools stay stable (no per-scroll allocations beyond text).
import type { Breakpoint, ColumnKey } from "../../core/store";
import { fmtCount, fmtMem, fmtPct, fmtRate, fmtTime, fmtUtil } from "../../core/format";
import { bindTooltip, type Tooltip, type TooltipContent } from "../../core/tooltip";
import { segmentFractions, type MeterSegment } from "../../charts/meter";
import { sparklineGeometry } from "../../charts/sparkline";
import type { ThemeApi } from "../../core/theme";
import { h } from "../../core/dom";
import { icon } from "../../core/icons";
import type { FunctionM, LineM, Model } from "../../model/model";
import { cellHasValue, idleBand } from "../../model/thresholds";
import * as P from "../../model/phrases";

// ── Specs ───────────────────────────────────────────────────────────────────

export interface ColumnSpec {
  key: ColumnKey;
  /** Header name line (rendered uppercase by CSS). */
  name: string;
  /** Header unit line. */
  unit: string;
  /** Track width in CSS px (0 = flex). */
  width: number;
  /** Meter width inside the cell (0 = no meter). */
  meter: number;
  /** Lower = kept longer when the width shrinks. */
  priority: number;
  sortable: boolean;
  align: "start" | "end";
  /** Full explanation for the header tooltip (§4.0.3 phrases). */
  help: string;
}

/** Display order = the §4.8.3 table order. */
export const COLUMN_ORDER: readonly ColumnKey[] = [
  "line",
  "time",
  "mem",
  "gpu",
  "await",
  "idle",
  "nrt",
  "nc",
  "trend",
  "copy",
  "gpumem",
  "alloc",
  "avg",
  "source",
];

export const COLUMN_SPECS: Readonly<Record<ColumnKey, ColumnSpec>> = {
  line: { key: "line", name: "#", unit: "", width: 52, meter: 0, priority: 0, sortable: true, align: "end", help: "Line number. Click to return to source order; click a number to open that line in the editor." },
  time: { key: "time", name: "Time", unit: "% of run", width: 124, meter: 64, priority: 1, sortable: true, align: "start", help: "Python + native + system time of the line as a share of the run (e.g. 21.4% of run · 11.6 s). Bars are scaled to the hottest line in the profile; system time is hatched." },
  mem: { key: "mem", name: "Memory", unit: "peak", width: 132, meter: 56, priority: 2, sortable: true, align: "start", help: "Peak memory attributed to the line. Bar length = share of the program's peak footprint, split Python / native; the tick marks the average per episode." },
  gpu: { key: "gpu", name: "GPU", unit: "% busy", width: 104, meter: 40, priority: 3, sortable: true, align: "start", help: "GPU utilization while the line ran (time-weighted), on an absolute 0–100% scale." },
  await: { key: "await", name: "Await", unit: "% of await", width: 112, meter: 48, priority: 3, sortable: true, align: "start", help: "Share of all await time spent suspended at the line; bars are scaled to the line with the most await time." },
  idle: { key: "idle", name: "Idle", unit: "device", width: 84, meter: 0, priority: 3, sortable: true, align: "end", help: "Share of the line's CPU samples during which the Neuron device was idle: ● below 30%, ◆ 30–60%, ▲ 60% and above." },
  nrt: { key: "nrt", name: "NRT", unit: "% of run", width: 112, meter: 48, priority: 4, sortable: true, align: "start", help: "Time in the Neuron Runtime attributed to the line, as a share of the run." },
  nc: { key: "nc", name: "NC", unit: "% of run", width: 112, meter: 48, priority: 5, sortable: true, align: "start", help: "NeuronCore busy time attributed to the line, as a share of the run." },
  trend: { key: "trend", name: "Footprint", unit: "when alloc.", width: 76, meter: 0, priority: 6, sortable: false, align: "start", help: "Program footprint at each of the line's allocation / free events, on the run's time axis and the program's peak scale. Red = possible leak." },
  copy: { key: "copy", name: "Copy", unit: "MiB/s", width: 84, meter: 0, priority: 7, sortable: true, align: "end", help: "Copy volume between Python and native memory, averaged over the run." },
  gpumem: { key: "gpumem", name: "GPU mem", unit: "peak", width: 84, meter: 0, priority: 8, sortable: true, align: "end", help: "Peak device memory of the process while the line ran." },
  alloc: { key: "alloc", name: "Alloc", unit: "% of all", width: 80, meter: 0, priority: 9, sortable: true, align: "end", help: "Share of all allocation in the program attributed to the line." },
  avg: { key: "avg", name: "Avg", unit: "per episode", width: 80, meter: 0, priority: 10, sortable: true, align: "end", help: "Average per-episode high-water mark of memory attributed to the line." },
  source: { key: "source", name: "Source", unit: "", width: 0, meter: 0, priority: 99, sortable: false, align: "start", help: "Source code of the file. Hot lines carry a wash in the colour of the heat metric." },
};

/** Narrow time column on phones: 24 px meter + value (§4.8.3). */
export const XS_TIME_WIDTH = 72;
export const XS_TIME_METER = 24;

export function columnWidth(key: ColumnKey, bp: Breakpoint): number {
  return key === "time" && bp === "xs" ? XS_TIME_WIDTH : COLUMN_SPECS[key].width;
}

export function meterWidth(key: ColumnKey, bp: Breakpoint): number {
  return key === "time" && bp === "xs" ? XS_TIME_METER : COLUMN_SPECS[key].meter;
}

/**
 * Minimum source width per breakpoint (§4.8.3, round 1): the code is what people read, so it
 * keeps ~80 columns at `lg+` (640) and ~50 at `sm`/`md` (420; 400 in short hosts). The
 * metric columns that no longer fit are always in the detail panel.
 */
export function sourceMin(bp: Breakpoint, short = false): number {
  if (bp === "xs") return 160;
  if (bp === "sm" || bp === "md") return short ? 400 : 420;
  return 640;
}

/**
 * Width budget (§4.8.3): `line`, `time` and `source` always; then the profile's other
 * columns in priority order (ties: table order) while Σ widths + next ≤ available −
 * sourceMin. Phones keep only Time. Returns keys in display order.
 */
export function fitColumns(present: readonly ColumnKey[], available: number, bp: Breakpoint, short = false): ColumnKey[] {
  const chosen = new Set<ColumnKey>(["line", "time", "source"]);
  let used = columnWidth("line", bp) + columnWidth("time", bp);
  if (bp !== "xs") {
    const budget = available - sourceMin(bp, short);
    const candidates = present
      .filter((k) => !chosen.has(k))
      .sort((a, b) => COLUMN_SPECS[a].priority - COLUMN_SPECS[b].priority || COLUMN_ORDER.indexOf(a) - COLUMN_ORDER.indexOf(b));
    for (const k of candidates) {
      const w = columnWidth(k, bp);
      if (used + w > budget) break;
      chosen.add(k);
      used += w;
    }
  }
  return COLUMN_ORDER.filter((k) => chosen.has(k));
}

/** CSS grid template for the chosen columns (source takes the rest). */
export function gridTemplate(cols: readonly ColumnKey[], bp: Breakpoint): string {
  return cols.map((k) => (k === "source" ? "minmax(0, 1fr)" : `${columnWidth(k, bp)}px`)).join(" ");
}

/** Σ fixed widths (everything but source). */
export function fixedWidth(cols: readonly ColumnKey[], bp: Breakpoint): number {
  return cols.reduce((a, k) => a + (k === "source" ? 0 : columnWidth(k, bp)), 0);
}

// ── Cell environment ─────────────────────────────────────────────────────────

export interface CellEnv {
  model: Model;
  bp: Breakpoint;
  /** Memory meter scale: `max_footprint_mb` (falls back to the largest line peak). */
  memMax: number;
  /** Sparkline y scale. */
  trendMax: number;
  gpuLabel: string;
  /** Resolved colours for data-URI sparklines (CSS variables do not reach inside them). */
  colors: { theme: string; memPy: string; danger: string; grid: string };
}

export function cellEnv(model: Model, bp: Breakpoint, theme?: ThemeApi): CellEnv {
  const peak = model.memory?.peak ?? 0;
  const memMax = Math.max(peak, model.maxLinePeak, 0);
  const t = theme?.tokens() ?? {};
  return {
    model,
    bp,
    memMax,
    trendMax: memMax,
    gpuLabel: model.gpu?.name || "GPU",
    colors: {
      theme: theme?.current() ?? "light",
      memPy: t["mem-py"] || "currentColor",
      danger: t["danger"] || "currentColor",
      grid: t["line-strong"] || "currentColor",
    },
  };
}

/** NRT share of the run (meter value), from the time when recorded, else the percent field. */
export function nrtShare(l: LineM, elapsed: number): number {
  const n = l.neuron;
  if (!n) return 0;
  if (n.nrtMs > 0 && elapsed > 0) return n.nrtMs / 10 / elapsed;
  return n.nrtPct;
}

export function ncShare(l: LineM, elapsed: number): number {
  const n = l.neuron;
  if (!n || !(elapsed > 0)) return 0;
  return n.ncMs / 10 / elapsed;
}

/** Time split segments (Python → native → system hatch). Zero segments are dropped. */
export function timeSegments(py: number, nat: number, sys: number): MeterSegment[] {
  const s: MeterSegment[] = [];
  if (py > 0) s.push({ value: py, token: "cpu-py" });
  if (nat > 0) s.push({ value: nat, token: "cpu-native" });
  if (sys > 0) s.push({ value: sys, token: "cpu-sys", hatch: "system" });
  return s;
}

export function memSegments(peak: number, pyFrac: number): MeterSegment[] {
  const f = Math.min(1, Math.max(0, pyFrac));
  const s: MeterSegment[] = [];
  if (peak * f > 0) s.push({ value: peak * f, token: "mem-py" });
  if (peak * (1 - f) > 0) s.push({ value: peak * (1 - f), token: "mem-native" });
  return s;
}

// ── Cell DOM (in place, one element per cell) ───────────────────────────────
//
// The DOM budget (§4.8.10: ≤ 2,500 nodes in the code view) rules out a span per meter
// segment on 100+ rendered rows. A metric cell is therefore ONE element: the meter is its
// `::before`, painted from a background list (`--mbar`) that reproduces `charts/meter.ts`
// exactly (Python → native → system hatch, no gaps, ≥ 2 px per non-zero segment, avg tick),
// and the value is the cell's text. The sparkline is an SVG data-URI background.

/**
 * CSS background list for a meter of `widthPx` (§3.3): segments as hard gradient stops,
 * the system (45°) / waiting (135°) hatch as tiles over their segment, the 1 px `--fg-2`
 * average tick on top, and the `--sunken` track underneath.
 */
export function meterBackground(segments: readonly MeterSegment[], max: number, widthPx: number, tick?: number | null): string {
  const fr = segmentFractions(segments, max);
  const stops: string[] = [];
  const layers: string[] = [];
  let x = 0;
  const px = (v: number) => `${+v.toFixed(2)}px`;
  segments.forEach((sg, i) => {
    if (!(fr[i] > 0) || !(sg.value > 0)) return;
    const w = Math.min(Math.max(2, fr[i] * widthPx), widthPx - x);
    if (w <= 0) return;
    const color = sg.hatch === "waiting" ? "color-mix(in srgb, var(--async) 35%, transparent)" : `var(--${sg.token})`;
    stops.push(`${color} ${px(x)} ${px(x + w)}`);
    if (sg.hatch === "system") {
      layers.push(`repeating-linear-gradient(45deg, transparent 0 2.2px, color-mix(in srgb, var(--surface) 55%, transparent) 2.2px 2.83px) ${px(x)} 0 / ${px(w)} 100% no-repeat`);
    } else if (sg.hatch === "waiting") {
      layers.push(`repeating-linear-gradient(135deg, var(--async) 0 1px, transparent 1px 3.54px) ${px(x)} 0 / ${px(w)} 100% no-repeat`);
    }
    x += w;
  });
  if (tick != null && max > 0 && tick > 0) {
    const tx = Math.min(1, tick / max) * widthPx;
    layers.unshift(`linear-gradient(var(--fg-2), var(--fg-2)) ${px(Math.max(0, Math.min(widthPx - 1, tx - 0.5)))} 0 / 1px 100% no-repeat`);
  }
  if (stops.length) layers.push(`linear-gradient(90deg, ${stops.join(", ")}, transparent ${px(x)}) 0 0 / 100% 100% no-repeat`);
  layers.push("var(--sunken)");
  return layers.join(", ");
}

function clearCell(cell: HTMLElement): void {
  if (cell.firstChild) cell.textContent = "";
  if (cell.classList.contains("has-meter")) {
    cell.classList.remove("has-meter", "is-hot");
    cell.style.removeProperty("--mbar");
  }
  if (cell.style.backgroundImage) cell.style.backgroundImage = "";
}

/** Meter (as `::before`) + right-aligned value text (+ optional trailing icon). */
function meterCell(cell: HTMLElement, key: ColumnKey, env: CellEnv, segments: MeterSegment[], max: number, text: string, opts: { tick?: number | null; hot?: boolean; leak?: boolean } = {}): void {
  cell.classList.add("has-meter");
  cell.classList.toggle("is-hot", Boolean(opts.hot));
  cell.style.setProperty("--mbar", meterBackground(segments, max, meterWidth(key, env.bp), opts.tick));
  const first = cell.firstChild;
  const wantNodes = opts.leak ? 2 : 1;
  if (first && first.nodeType === 3 && cell.childNodes.length === wantNodes) {
    if ((first as Text).data !== text) (first as Text).data = text;
    return;
  }
  cell.textContent = text;
  if (opts.leak) {
    const li = icon("trend-up", 12);
    li.classList.add("cv-leak-icon");
    cell.appendChild(li);
  }
}

function textCell(cell: HTMLElement, text: string): void {
  if (cell.childElementCount) cell.textContent = "";
  if (cell.textContent !== text) cell.textContent = text;
}

const sparkCache = new Map<string, string>();

/** Sparkline (§3.3) as an SVG data URI: baseline, 1.25 px line, max dot; shared scales. */
export function sparkUri(samples: Float64Array, tMax: number, yMax: number, color: string, baseline: string): string {
  const g = sparklineGeometry(samples, { tMax: tMax || 1, yMax: yMax || 1 });
  const dot = g.max ? `<circle cx='${g.max.x}' cy='${g.max.y}' r='1.25' fill='${color}'/>` : "";
  const svgText =
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='16' viewBox='0 0 64 16'>` +
    `<path d='M0 15.5H64' stroke='${baseline}' stroke-width='1'/>` +
    (g.points ? `<polyline points='${g.points}' fill='none' stroke='${color}' stroke-width='1.25' stroke-linejoin='round' stroke-linecap='round'/>` : "") +
    dot +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svgText)}")`;
}

function trendCell(cell: HTMLElement, cacheKey: string, samples: Float64Array, leak: boolean, env: CellEnv): void {
  if (cell.firstChild) cell.textContent = "";
  const key = `${cacheKey}|${env.colors.theme}|${leak ? 1 : 0}`;
  let uri = sparkCache.get(key);
  if (!uri) {
    uri = sparkUri(samples, env.model.tMax, env.trendMax, leak ? env.colors.danger : env.colors.memPy, env.colors.grid);
    if (sparkCache.size > 4000) sparkCache.clear();
    sparkCache.set(key, uri);
  }
  if (cell.style.backgroundImage !== uri) cell.style.backgroundImage = uri;
}

const HOT_TIME = 5;

/** Fill one metric cell of a line row (not `line` / `source`, which the view renders). */
export function renderLineCell(cell: HTMLElement, key: ColumnKey, l: LineM, env: CellEnv): void {
  const m = env.model;
  const caps = m.caps;
  if (!cellHasValue(l, key, caps)) {
    clearCell(cell);
    return;
  }
  switch (key) {
    case "time":
      meterCell(cell, key, env, timeSegments(l.py, l.nat, l.sys), m.maxLineTotal || l.total, fmtPct(l.total), { hot: l.total >= HOT_TIME });
      return;
    case "mem":
      meterCell(cell, key, env, memSegments(l.peak, l.pyFrac), env.memMax || l.peak, fmtMem(l.peak), {
        tick: l.avg > 0 ? l.avg : null,
        hot: env.memMax > 0 && l.peak / env.memMax >= 0.1,
        leak: l.leak !== null,
      });
      return;
    case "gpu":
      meterCell(cell, key, env, [{ value: l.gpu, token: "gpu" }], 100, fmtUtil(l.gpu), { hot: l.gpu >= 50 });
      return;
    case "await":
      meterCell(cell, key, env, [{ value: l.await, token: "async" }], m.maxLineAwait || l.await, fmtPct(l.await), { hot: l.await >= 10 });
      return;
    case "nrt": {
      const v = nrtShare(l, m.elapsed);
      meterCell(cell, key, env, [{ value: v, token: "gpu-mem" }], 100, fmtPct(v), { hot: v >= HOT_TIME });
      return;
    }
    case "nc": {
      const v = ncShare(l, m.elapsed);
      meterCell(cell, key, env, [{ value: v, token: "gpu" }], 100, fmtPct(v), { hot: v >= HOT_TIME });
      return;
    }
    case "idle": {
      const idle = l.neuron?.idlePct ?? 0;
      const band = idleBand(idle);
      let glyph = cell.firstElementChild as HTMLElement | null;
      if (!glyph || !glyph.classList.contains("cv-band")) {
        cell.textContent = "";
        glyph = document.createElement("span");
        glyph.className = "cv-band";
        glyph.setAttribute("aria-hidden", "true");
        cell.append(glyph, document.createTextNode(""));
      }
      glyph.textContent = band.glyph;
      glyph.style.color = `var(--${band.token})`;
      (glyph.nextSibling as Text).data = fmtPct(idle);
      return;
    }
    case "trend":
      trendCell(cell, `${l.file.name}:${l.no}`, l.memSamples, l.leak !== null, env);
      return;
    case "avg":
      textCell(cell, fmtMem(l.avg));
      return;
    case "alloc":
      textCell(cell, fmtPct(100 * l.usage));
      return;
    case "copy":
      textCell(cell, fmtRate(l.copy));
      return;
    case "gpumem":
      textCell(cell, fmtMem(l.gpuPeak ?? 0));
      return;
    default:
      clearCell(cell);
  }
}

/** Function-table cells (§4.10): the same column system over `FunctionM`. */
export function functionHasValue(f: FunctionM, key: ColumnKey, m: Model): boolean {
  switch (key) {
    case "time":
      return f.total > 0;
    case "mem":
      return f.peak > 0;
    case "gpu":
      return m.caps.gpu && f.gpu >= 1;
    case "await":
      return f.await >= 1;
    case "trend":
      return f.memSamples.length > 0;
    case "copy":
      return f.copy >= 1;
    case "gpumem":
      return m.caps.gpu && (f.gpuPeak ?? 0) >= 1 && f.gpu >= 1;
    case "alloc":
      return f.usage >= 0.01;
    case "avg":
      return f.avg > 0;
    default:
      return false;
  }
}

/** Python share of a function's peak, weighted over its member lines (functions[] has no split). */
export function functionPyFrac(f: FunctionM): number {
  let num = 0;
  let den = 0;
  for (const l of f.members) {
    num += l.peak * l.pyFrac;
    den += l.peak;
  }
  return den > 0 ? num / den : 1;
}

export function renderFunctionCell(cell: HTMLElement, key: ColumnKey, f: FunctionM, env: CellEnv, maxFnTotal: number): void {
  const m = env.model;
  if (!functionHasValue(f, key, m)) {
    clearCell(cell);
    return;
  }
  switch (key) {
    case "time":
      meterCell(cell, key, env, timeSegments(f.py, f.nat, f.sys), maxFnTotal || f.total, fmtPct(f.total), { hot: f.total >= HOT_TIME });
      return;
    case "mem":
      meterCell(cell, key, env, memSegments(f.peak, functionPyFrac(f)), env.memMax || f.peak, fmtMem(f.peak), { tick: f.avg > 0 ? f.avg : null });
      return;
    case "gpu":
      meterCell(cell, key, env, [{ value: f.gpu, token: "gpu" }], 100, fmtUtil(f.gpu), { hot: f.gpu >= 50 });
      return;
    case "await":
      meterCell(cell, key, env, [{ value: f.await, token: "async" }], m.maxLineAwait || f.await, fmtPct(f.await));
      return;
    case "trend":
      trendCell(cell, `${f.file.name}:fn:${f.name}`, f.memSamples, false, env);
      return;
    case "avg":
      textCell(cell, fmtMem(f.avg));
      return;
    case "alloc":
      textCell(cell, fmtPct(100 * f.usage));
      return;
    case "copy":
      textCell(cell, fmtRate(f.copy));
      return;
    case "gpumem":
      textCell(cell, fmtMem(f.gpuPeak ?? 0));
      return;
    default:
      clearCell(cell);
  }
}

// ── Tooltips ─────────────────────────────────────────────────────────────────

/** Cell tooltip (§4.8.4 "Tooltip" column); null for empty cells. */
export function cellTooltip(key: ColumnKey, l: LineM, env: CellEnv): TooltipContent | null {
  const m = env.model;
  if (key === "line") return { title: `Open ${l.file.base}:${l.no} in the editor` };
  if (!cellHasValue(l, key, m.caps)) return null;
  switch (key) {
    case "time":
      return {
        title: P.ofRun(l.total, l.sec),
        rows: [
          ["Python", fmtPct(l.py)],
          ["native", fmtPct(l.nat)],
          ["system", fmtPct(l.sys)],
        ],
        hint: "Bars are scaled to the hottest line in the profile",
      };
    case "mem": {
      const rows: [string, string][] = [
        ["average per episode", fmtMem(l.avg)],
        ["Python share", fmtPct(100 * l.pyFrac)],
      ];
      if (l.leak) rows.push(["possible leak", `${fmtRate(l.leak.velocity)} · ${fmtPct(100 * l.leak.likelihood)}`]);
      return { title: P.linePeak(l.peak), rows };
    }
    case "trend": {
      const n = l.memSamples.length / 2;
      return {
        title: `Program footprint at each of this line's ${fmtCount(n)} allocation/free event${n === 1 ? "" : "s"}`,
        hint: l.leak ? P.leak(l.leak) : `x: 0 – ${fmtTime(m.tMax)} · y: 0 – ${fmtMem(env.trendMax)}`,
      };
    }
    case "avg":
      return { title: `${fmtMem(l.avg)} average per-episode high-water mark` };
    case "alloc":
      return { title: `${P.allocShare(l.usage)} in the program`, hint: `${fmtMem(l.malloc)} allocated here` };
    case "copy":
      return { title: P.copied(l.copy) };
    case "gpu":
      return { title: `${env.gpuLabel} ${fmtUtil(l.gpu)} busy while this line ran (time-weighted)` };
    case "gpumem":
      return {
        title: `${fmtMem(l.gpuPeak ?? 0)} peak device memory of the process while this line ran`,
        hint: l.gpuAvg !== null ? `avg ${fmtMem(l.gpuAvg)}` : undefined,
      };
    case "await":
      return { title: P.awaitShare(l.await), hint: l.concPeak > 0 ? P.concurrency(l.concMean, l.concPeak, true) + " suspended" : undefined };
    case "idle": {
      const idle = l.neuron?.idlePct ?? 0;
      return { title: P.deviceIdle(idle), hint: `${idleBand(idle).band} (● < 30%, ◆ 30–60%, ▲ ≥ 60%)` };
    }
    case "nrt": {
      const n = l.neuron;
      if (!n) return null;
      const share = m.neuron && m.neuron.nrtMs > 0 ? fmtPct((100 * n.nrtMs) / m.neuron.nrtMs) : null;
      return {
        title: `${fmtTime(n.nrtMs / 1000)} in Neuron Runtime · ${fmtPct(nrtShare(l, m.elapsed))} of run`,
        rows: [
          ...(share ? ([["share of all NRT time", share]] as [string, string][]) : []),
          ["executions", fmtCount(n.nrtCount)],
        ],
      };
    }
    case "nc": {
      const n = l.neuron;
      if (!n) return null;
      return {
        title: `${fmtTime(n.ncMs / 1000)} NeuronCore busy · ${fmtPct(ncShare(l, m.elapsed))} of run`,
        hint: n.nrtMs > 0 ? `ratio NC/NRT ${(n.ncMs / n.nrtMs).toFixed(2)}` : undefined,
      };
    }
    default:
      return null;
  }
}

/** Header tooltip: name + unit + the full explanation. */
export function headerTooltip(key: ColumnKey, gpuLabel: string, file: string): TooltipContent {
  const s = COLUMN_SPECS[key];
  const name = key === "gpu" ? gpuLabel : key === "gpumem" ? `${gpuLabel} mem` : s.name;
  const unit = key === "source" ? file : key === "trend" ? "when it allocated" : s.unit;
  return {
    title: unit ? `${name} · ${unit}` : name,
    hint: s.help + (s.sortable && key !== "line" ? " Click to rank: descending, ascending, then source order." : ""),
  };
}

/**
 * One two-line column header (§4.8.3), shared by the line and function tables: a sort button
 * with `aria-sort` on the columnheader for sortable keys, else a focusable info header.
 * Tooltip disposers go to `stops`.
 */
export function headerCell(
  key: ColumnKey,
  name: string,
  unit: string,
  sort: "ascending" | "descending" | "none",
  label: string,
  onSort: () => void,
  tooltip: Tooltip,
  tip: () => TooltipContent,
  stops: (() => void)[],
): HTMLElement {
  const spec = COLUMN_SPECS[key];
  const cell = h("div", { class: ["cv-h", `cv-h-${key}`, spec.align === "end" ? "is-end" : ""], role: "columnheader", dataset: { col: key } });
  const text = h("span", { class: "cv-h-text" }, h("span", { class: "cv-h-name" }, name), unit ? h("span", { class: "cv-h-unit" }, unit) : null);
  if (spec.sortable) {
    cell.setAttribute("aria-sort", sort);
    const btn = h(
      "button",
      { type: "button", class: "cv-h-btn", "aria-label": label, onClick: onSort },
      text,
      sort !== "none" && key !== "line" ? h("span", { class: "cv-h-sort" }, icon(sort === "descending" ? "sort-desc" : "sort-asc", 12)) : null,
    );
    stops.push(bindTooltip(tooltip, btn, tip));
    cell.append(btn);
  } else {
    // Not sortable (Footprint, Source): still a Tab stop with its definition (round 1).
    cell.append(text);
    stops.push(bindHeaderInfo(tooltip, cell, tip));
  }
  return cell;
}

/** Focus the control of column `col` in a rebuilt header row (sorting must keep focus). */
export function refocusHeader(row: Element, col: string | null | undefined): void {
  if (col) row.querySelector<HTMLElement>(`.cv-h-${col} .cv-h-btn, .cv-h-${col}.cv-h-info`)?.focus({ preventScroll: true });
}

/**
 * A non-sorting column header (Footprint, Source, Function) as a Tab stop that explains the
 * column (round 1, principle 8): the definition shows on hover, on keyboard focus and on a
 * tap (touch closes tooltips on pointerdown, so a tap re-opens it until blur), and it is the
 * header's aria-description for screen readers. Returns the disposer.
 */
export function bindHeaderInfo(tooltip: Tooltip, cell: HTMLElement, content: () => TooltipContent): () => void {
  const c = content();
  cell.classList.add("cv-h-info");
  cell.tabIndex = 0;
  cell.setAttribute("aria-description", `${c.title}. ${c.hint ?? ""}`);
  // The cell is rebuilt with the header, so these listeners need no disposer.
  cell.addEventListener("click", () => tooltip.show(cell, content(), { delay: 0, describe: cell }));
  cell.addEventListener("blur", () => tooltip.hide());
  cell.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && tooltip.hide());
  return bindTooltip(tooltip, cell, content);
}

// ── Accessible row summary (§4.8.11) ─────────────────────────────────────────

/** "Line 173, 21.4% of run time, GPU 96.4% busy, peak memory none sampled: loss_value = loss.item()". */
export function rowAriaLabel(l: LineM, m: Model, present: readonly ColumnKey[]): string {
  const parts: string[] = [`Line ${l.no}`];
  const has = (k: ColumnKey) => present.includes(k);
  parts.push(l.total > 0 ? `${fmtPct(l.total)} of run time` : "no CPU time sampled");
  if (has("mem")) parts.push(l.peak > 0 ? `peak memory ${fmtMem(l.peak)}` : `peak memory ${P.NONE_SAMPLED}`);
  if (l.leak) parts.push(P.leak(l.leak));
  if (has("gpu")) parts.push(l.gpu >= 1 ? `GPU ${fmtUtil(l.gpu)} busy` : `GPU ${P.NONE_SAMPLED}`);
  if (has("await") && l.await >= 1) parts.push(`${fmtPct(l.await)} of await time`);
  if (has("nrt") && l.neuron && (l.neuron.nrtMs > 0 || l.neuron.nrtPct > 0)) parts.push(`NRT ${fmtPct(nrtShare(l, m.elapsed))} of run`);
  if (has("nc") && l.neuron && l.neuron.ncMs > 0) parts.push(`NC ${fmtPct(ncShare(l, m.elapsed))} of run`);
  if (has("idle") && cellHasValue(l, "idle", m.caps)) parts.push(`device idle ${fmtPct(l.neuron?.idlePct ?? 0)}`);
  if (has("copy") && l.copy >= 1) parts.push(`copies ${fmtRate(l.copy)}`);
  const code = l.text.trim();
  return `${parts.join(", ")}${code ? `: ${code}` : ": blank line"}`;
}
