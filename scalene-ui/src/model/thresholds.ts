/**
 * Display thresholds (DESIGN.md §4.0.4, upstream parity unless noted):
 * when a cell has a value, which columns a profile has, the row heat wash
 * and Neuron device-idle bands. Views decide layout; these decide data.
 */

import type { ColumnKey, Metric } from "../core/store";
import type { Caps } from "./normalize";
import type { LineM, Model } from "./model";

/** Alloc share cell: `n_usage_fraction ≥ 0.01`. */
export const ALLOC_MIN = 0.01;
/** Copy, GPU, GPU memory and await cells: ≥ 1. */
export const CELL_MIN = 1;
/** A row's heat wash, when present, is at least this strong. */
export const HEAT_FLOOR = 0.25;

/**
 * Whether a metric cell shows a value for this line (§4.8.4 "Empty when").
 * `line`, `source` and `trend` follow their own rules (trend: any samples).
 */
export function cellHasValue(l: LineM, key: ColumnKey, caps: Caps): boolean {
  switch (key) {
    case "line":
    case "source":
      return true;
    case "time":
      return l.total > 0;
    case "mem":
      return l.peak > 0;
    case "trend":
      return l.memSamples.length > 0;
    case "avg":
      return l.avg > 0;
    case "alloc":
      return l.usage >= ALLOC_MIN;
    case "copy":
      return l.copy >= CELL_MIN;
    case "gpu":
      return caps.gpu && l.gpu >= CELL_MIN;
    case "gpumem":
      return caps.gpu && (l.gpuPeak ?? 0) >= CELL_MIN && l.gpu >= CELL_MIN;
    case "await":
      return l.await >= CELL_MIN;
    case "idle":
      return l.neuron?.idlePct != null && (l.total >= 1 || l.neuron.nrtMs > 0 || l.neuron.nrtPct > 0);
    case "nrt":
      return l.neuron !== null && (l.neuron.nrtMs > 0 || l.neuron.nrtPct > 0);
    case "nc":
      return l.neuron !== null && l.neuron.ncMs > 0;
    default:
      return false;
  }
}

/** Columns the profile has data for (§4.8.3 "Present when"), in priority order. */
export function profileColumns(m: Pick<Model, "caps" | "files" | "hiddenFiles">): ColumnKey[] {
  const c = m.caps;
  const anyCopy = m.files.concat(m.hiddenFiles).some((f) => f.lines.some((l) => l.copy >= CELL_MIN));
  const cols: [ColumnKey, boolean][] = [
    ["line", true],
    ["time", true],
    ["mem", c.memory],
    ["gpu", c.gpu],
    ["await", c.async],
    ["idle", c.neuron],
    ["nrt", c.neuron],
    ["nc", c.neuron],
    ["trend", c.memory],
    ["copy", anyCopy],
    ["gpumem", c.gpu && c.gpuMemory],
    ["alloc", c.memory],
    ["avg", c.memory],
    ["source", true],
  ];
  return cols.filter(([, present]) => present).map(([k]) => k);
}

export type HeatMetric = "time" | "mem" | "gpu" | "await";

/** The heat metric: the active sort column when it is time/mem/gpu/await, else time. */
export function heatMetric(sortKey: ColumnKey | null | undefined): HeatMetric {
  return sortKey === "mem" || sortKey === "gpu" || sortKey === "await" ? sortKey : "time";
}

/** The wash token for a heat metric (`--wash-…`). */
export const HEAT_WASH: Record<HeatMetric, string> = { time: "wash-cpu", mem: "wash-mem", gpu: "wash-gpu", await: "wash-await" };

function heatValue(l: LineM, metric: HeatMetric): number {
  return metric === "time" ? l.total : metric === "mem" ? l.peak : metric === "gpu" ? l.gpu : l.await;
}

function heatMax(m: Pick<Model, "maxLineTotal" | "maxLinePeak" | "maxLineAwait">, metric: HeatMetric): number {
  return metric === "time" ? m.maxLineTotal : metric === "mem" ? m.maxLinePeak : metric === "gpu" ? 100 : m.maxLineAwait;
}

/**
 * Row heat (§4.8.6): value / profile max, floored at 0.25 when the row passes
 * the threshold (≥ 1 % for time / GPU / await, > 0 for memory peak), else 0.
 */
export function heatOf(m: Pick<Model, "maxLineTotal" | "maxLinePeak" | "maxLineAwait">, l: LineM, metric: HeatMetric): number {
  const v = heatValue(l, metric);
  const passes = metric === "mem" ? v > 0 : v >= 1;
  const max = heatMax(m, metric);
  if (!passes || !(max > 0)) return 0;
  return Math.min(1, Math.max(HEAT_FLOOR, v / max));
}

/** Metric of the hotspots list → its heat metric in the code view. */
export function heatForMetric(metric: Metric): HeatMetric {
  return metric === "memory" ? "mem" : metric;
}

export type IdleBand = "low" | "medium" | "high";

/** Device-idle band (§4.0.4): < 30 ● low, 30–<60 ◆ medium, ≥ 60 ▲ high; shape + colour, never colour alone. */
export function idleBand(idlePct: number): { band: IdleBand; glyph: string; token: string } {
  if (idlePct >= 60) return { band: "high", glyph: "▲", token: "band-high" };
  if (idlePct >= 30) return { band: "medium", glyph: "◆", token: "band-mid" };
  return { band: "low", glyph: "●", token: "band-low" };
}
