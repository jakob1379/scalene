/**
 * Hotspot lists (DESIGN.md §4.5): ranked lines, functions or files by
 * metric, with meters, secondary values, badges and the TOP LINES sample
 * times for the scope. The list and the scope always come from the same
 * call, so ranks agree.
 */

import { fmtLoc, fmtMem, fmtPct, fmtRate, fmtTime, fmtUtil } from "../core/format";
import type { Metric, Target } from "../core/store";
import { EMPTY } from "./normalize";
import { sampleTimes } from "./memory";
import type { Badge, FileM, FunctionM, HotspotItem, LineM, MeterPart, Model } from "./model";

export type HotspotKind = "lines" | "functions" | "files";

export interface HotspotList {
  kind: HotspotKind;
  metric: Metric;
  items: HotspotItem[];
  /** Number of ranked candidates (for "100 more ›"). */
  total: number;
  more: number;
  /** Σ value of the shown items (Time and Await only, else null). */
  pareto: number | null;
  /** "by share of run time · bars scaled to #1" etc. */
  subtitle: string;
  /** Shown when the list is empty. */
  emptyText: string;
}

export const HOTSPOTS_DEFAULT = 8;

const SUBTITLES: Record<Metric, string> = {
  time: "by share of run time · bars scaled to #1",
  memory: "by peak attributed · peaks overlap, so they do not add",
  gpu: "mean util. while running · lines ≥ 1% of run",
  await: "by share of await time",
};

const KIND_WORD: Record<HotspotKind, string> = { lines: "lines", functions: "functions", files: "files" };

/** Metrics a profile can rank by (§4.5.1). */
export function availableMetrics(m: Model): Metric[] {
  const out: Metric[] = ["time"];
  if (m.caps.memory) out.push("memory");
  if (m.caps.gpu) out.push("gpu");
  if (m.caps.async) out.push("await");
  return out;
}

// ── Shared pieces ───────────────────────────────────────────────────────────

function timeParts(x: { py: number; nat: number; sys: number }): MeterPart[] {
  return [
    { value: x.py, token: "cpu-py" },
    { value: x.nat, token: "cpu-native" },
    { value: x.sys, token: "cpu-sys", hatch: "system" },
  ];
}

function memParts(peak: number, pyFrac: number): MeterPart[] {
  const f = Math.min(1, Math.max(0, pyFrac));
  return [
    { value: peak * f, token: "mem-py" },
    { value: peak * (1 - f), token: "mem-native" },
  ];
}

function metricValue(x: { total: number; peak: number; gpu: number; await: number }, metric: Metric): number {
  return metric === "time" ? x.total : metric === "memory" ? x.peak : metric === "gpu" ? x.gpu : x.await;
}

function valueText(v: number, metric: Metric): string {
  return metric === "memory" ? fmtMem(v) : metric === "gpu" ? fmtUtil(v) : fmtPct(v);
}

function meterFor(x: { py: number; nat: number; sys: number; peak: number; gpu: number; await: number }, metric: Metric, top: number, pyFrac: number): HotspotItem["meter"] {
  switch (metric) {
    case "time":
      return { parts: timeParts(x), max: top };
    case "memory":
      return { parts: memParts(x.peak, pyFrac), max: top };
    case "gpu":
      return { parts: [{ value: x.gpu, token: "gpu" }], max: 100 };
    default:
      return { parts: [{ value: x.await, token: "async" }], max: top };
  }
}

/** One badge at most: leak > event loop > GPU (metric ≠ GPU) > await > copy. */
function badgeFor(m: Model, l: LineM | null, x: { gpu: number; await: number; copy: number }, metric: Metric): Badge | null {
  if (l?.leak) return { kind: "leak", text: "↗ leak" };
  if (l && m.async?.loopLine === l) return { kind: "loop", text: "event loop · waiting" };
  if (metric !== "gpu" && m.caps.gpu && x.gpu >= 1) return { kind: "gpu", text: `GPU ${Math.round(x.gpu)}%` };
  if (metric !== "await" && m.caps.async && x.await >= 1) return { kind: "await", text: `await ${fmtPct(x.await)}` };
  // One formatter per quantity: the same "13.5 MiB/s" as the finding, code cell and detail.
  if (x.copy >= 1) return { kind: "copy", text: `copy ${fmtRate(x.copy)}` };
  return null;
}

/** Sorted union of several sample-time arrays. */
export function unionTimes(arrays: readonly Float64Array[]): Float64Array {
  const nonEmpty = arrays.filter((a) => a.length > 0);
  if (nonEmpty.length === 0) return EMPTY;
  if (nonEmpty.length === 1) return nonEmpty[0];
  const out = new Float64Array(nonEmpty.reduce((a, x) => a + x.length, 0));
  let n = 0;
  for (const a of nonEmpty) {
    out.set(a, n);
    n += a.length;
  }
  return out.sort();
}

function lineTimes(l: LineM, metric: Metric): Float64Array {
  return metric === "memory" ? sampleTimes(l.memSamples) : l.cpuTimes;
}

function secondaryFor(x: { sec: number; usage: number; concMean: number }, metric: Metric): string {
  if (metric === "memory") return x.usage >= 0.0005 ? `${fmtPct(100 * x.usage)} of alloc.` : "";
  if (metric === "await") return `${x.concMean.toFixed(1)} tasks`;
  // No run length (caps.elapsed false): seconds are absent, not "0 s".
  return Number.isFinite(x.sec) ? fmtTime(x.sec) : "";
}

function aria(rank: number, what: string, where: string, value: string, metric: Metric, extra: string): string {
  const of = metric === "time" ? " of run" : metric === "await" ? " of await time" : metric === "gpu" ? " GPU busy" : " peak";
  return `${rank}. ${what}, ${where}, ${value}${of}${extra ? `, ${extra}` : ""}`;
}

// ── Builders per kind ───────────────────────────────────────────────────────

function lineItems(m: Model, metric: Metric, n: number): { items: HotspotItem[]; total: number } {
  const ranked = m.rank.lines[metric];
  const top = ranked[0] ? metricValue(ranked[0], metric) : 0;
  const items = ranked.slice(0, n).map((l, i): HotspotItem => {
    const value = metricValue(l, metric);
    const where = `${l.file.base} line ${l.no}${l.fn ? ` in ${l.fn.name}` : ""}`;
    const secondary = secondaryFor({ sec: l.sec, usage: l.usage, concMean: l.concMean }, metric);
    const text = valueText(value, metric);
    return {
      rank: i + 1,
      kind: "line",
      target: { file: l.file.name, line: l.no },
      value,
      valueText: text,
      secondary,
      code: l.text.trim(),
      location: `${l.fn ? `${l.fn.name}() · ` : ""}${fmtLoc(l.file.name, l.no)}`,
      badge: badgeFor(m, l, l, metric),
      times: lineTimes(l, metric),
      meter: meterFor(l, metric, top, l.pyFrac),
      ariaLabel: aria(i + 1, l.text.trim(), where, text, metric, metric === "time" ? spokenTime(l.sec) : secondary),
      line: l,
      fn: l.fn,
      file: l.file,
    };
  });
  return { items, total: ranked.length };
}

/** "54.1 seconds" / "350 milliseconds" for screen readers ("" when not recorded). */
export function spokenTime(sec: number): string {
  if (!Number.isFinite(sec)) return "";
  // fmtTime joins number and unit with a no-break space.
  return fmtTime(sec).replace(/\ss$/, " seconds").replace(/\sms$/, " milliseconds");
}

function functionItems(m: Model, metric: Metric, n: number): { items: HotspotItem[]; total: number } {
  const ranked = m.rank.functions[metric];
  const top = ranked[0] ? metricValue(ranked[0], metric) : 0;
  const items = ranked.slice(0, n).map((f: FunctionM, i): HotspotItem => {
    const value = metricValue(f, metric);
    const text = valueText(value, metric);
    const conc = f.members.reduce((a, l) => Math.max(a, l.concMean), 0);
    const secondary = secondaryFor({ sec: f.sec, usage: f.usage, concMean: conc }, metric);
    const target: Target = { file: f.file.name, fn: f.name };
    return {
      rank: i + 1,
      kind: "function",
      target,
      value,
      valueText: text,
      secondary,
      code: f.name,
      location: fmtLoc(f.file.name, f.no),
      badge: badgeFor(m, null, f, metric),
      times: unionTimes(f.members.map((l) => lineTimes(l, metric))),
      meter: meterFor(f, metric, top, f.malloc > 0 ? pyFracOf(f) : 0),
      ariaLabel: aria(i + 1, `function ${f.name}`, `${f.file.base} line ${f.no}`, text, metric, secondary),
      line: null,
      fn: f,
      file: f.file,
    };
  });
  return { items, total: ranked.length };
}

/** Python share of a function's peak, from its hungriest member line. */
function pyFracOf(f: FunctionM): number {
  let best: LineM | null = null;
  for (const l of f.members) if (!best || l.peak > best.peak) best = l;
  return best ? best.pyFrac : 0;
}

/** File-level value per metric: share, max line peak, time-weighted GPU mean, Σ await share. */
function fileValue(m: Model, f: FileM, metric: Metric): number {
  if (metric === "time") return f.pct;
  if (metric === "memory") return f.peak;
  if (metric === "await") return f.lines.reduce((a, l) => a + l.await, 0);
  let weighted = 0;
  let weight = 0;
  for (const l of f.lines) {
    if (!(l.total > 0) || (m.caps.cpuSamples && l.cpuTimes.length === 0)) continue;
    weighted += l.gpu * l.total;
    weight += l.total;
  }
  return weight > 0 ? weighted / weight : 0;
}

function rankedFiles(m: Model, metric: Metric): FileM[] {
  if (metric === "time" || metric === "memory") return m.rank.files[metric];
  const all = m.files.concat(m.hiddenFiles).filter((f) => (metric !== "gpu" || f.total >= 1) && fileValue(m, f, metric) > 0);
  return all.sort((a, b) => fileValue(m, b, metric) - fileValue(m, a, metric) || a.no - b.no);
}

function fileItems(m: Model, metric: Metric, n: number): { items: HotspotItem[]; total: number } {
  const ranked = rankedFiles(m, metric);
  const top = ranked[0] ? fileValue(m, ranked[0], metric) : 0;
  const timesMetric: Metric = metric === "memory" ? "memory" : "time";
  const items = ranked.slice(0, n).map((f, i): HotspotItem => {
    const value = fileValue(m, f, metric);
    const text = valueText(value, metric);
    const hot = hottestLine(f);
    const parts: MeterPart[] =
      metric === "memory"
        ? memParts(f.peak, f.peakLine?.pyFrac ?? 0)
        : metric === "time"
          ? timeParts(f)
          : [{ value, token: metric === "gpu" ? "gpu" : "async" }];
    return {
      rank: i + 1,
      kind: "file",
      target: { file: f.name, line: hot ? hot.no : 1 },
      value,
      valueText: text,
      secondary: metric === "memory" || metric === "await" || !(m.elapsed > 0) ? "" : fmtTime((f.pct / 100) * m.elapsed),
      code: f.base,
      location: m.caps.memory && f.peak > 0 ? `peak ${fmtMem(f.peak)}` : "",
      badge: f.leaks.length > 0 ? { kind: "leak", text: "↗ leak" } : null,
      times: unionTimes(f.lines.map((l) => lineTimes(l, timesMetric))),
      meter: { parts, max: metric === "gpu" ? 100 : top },
      ariaLabel: aria(i + 1, `file ${f.base}`, f.dir || f.name, text, metric, ""),
      line: null,
      fn: null,
      file: f,
    };
  });
  return { items, total: ranked.length };
}

function hottestLine(f: FileM): LineM | null {
  let best: LineM | null = null;
  for (const l of f.lines) if (l.total > 0 && (!best || l.total > best.total)) best = l;
  return best;
}

/** The hotspot list for a tab × metric (§4.5); `n` = rows shown (8, `short` 5). */
export function hotspotList(m: Model, kind: HotspotKind, metric: Metric, n = HOTSPOTS_DEFAULT): HotspotList {
  const build = kind === "lines" ? lineItems : kind === "functions" ? functionItems : fileItems;
  const { items, total } = build(m, metric, n);
  const pareto = metric === "time" || metric === "await" ? items.reduce((a, x) => a + x.value, 0) : null;
  const what = KIND_WORD[kind];
  return {
    kind,
    metric,
    items,
    total,
    more: Math.max(0, total - items.length),
    pareto,
    subtitle: SUBTITLES[metric],
    emptyText:
      metric === "time" ? "No CPU samples were attributed to profiled files" : `No ${what} with ${metric === "memory" ? "memory" : metric === "gpu" ? "GPU" : "await"} samples`,
  };
}

/** "Top 8 lines = 58.4% of run time" (null when the metric does not add up). */
export function paretoText(list: HotspotList): string | null {
  if (list.pareto === null || list.items.length === 0) return null;
  const denom = list.metric === "await" ? "of await time" : "of run time";
  const n = list.items.length;
  // One item: "Top file = 99.9% of run time", never "Top 1 files" (review round 1).
  return `${n === 1 ? `Top ${KIND_WORD[list.kind].slice(0, -1)}` : `Top ${n} ${KIND_WORD[list.kind]}`} = ${fmtPct(list.pareto)} ${denom}`;
}
