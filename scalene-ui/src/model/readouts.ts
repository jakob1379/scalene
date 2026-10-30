/**
 * Readout tiles (DESIGN.md §4.3): slot selection and the content of each
 * tile, as data. Every caption states its denominator (§4.0.3); the compact
 * `short` caption keeps a short denominator for the Jupyter iframe.
 */

import { fmtCount, fmtLoc, fmtMem, fmtPct, fmtRate, fmtTime, fmtUtil, NBSP, splitUnit } from "../core/format";
import type { Target } from "../core/store";
import { functionChip, fmtSampling, Segs, shortCode, type HeadSeg } from "./headline";
import type { LineM, Model } from "./model";

export type ReadoutKind = "time" | "peak" | "gpu" | "neuron" | "await" | "leaks" | "elapsed" | "busiest";

export interface SplitPart {
  key: "py" | "native" | "system";
  label: string;
  value: number;
  text: string;
  token: string;
  hatch?: "system";
}

export type ReadoutVisual =
  /** One stacked split bar (time split, peak Python/native split); `max` fills the track. */
  | { kind: "split"; parts: SplitPart[]; max: number }
  /** A single absolute meter. */
  | { kind: "meter"; value: number; max: number; token: string }
  /** Two thin meters (Neuron NRT / NC, % of run). */
  | { kind: "meters"; rows: { label: string; value: number; max: number; token: string }[] }
  /** Neutral track with a note ("split not recorded"). */
  | { kind: "neutral"; note: string };

export interface LeakRef {
  line: LineM;
  target: Target;
  label: string;
  rate: string;
  likelihood: string;
}

export interface ReadoutSpec {
  kind: ReadoutKind;
  label: string;
  /** LED colour token (no `--`). */
  token: string;
  /** Final formatted value ("3.11 GiB"); "" for the time split (see `parts`). */
  value: string;
  /** `value` split into number and unit for the two type sizes. */
  number: string;
  unit: string;
  /** Count-up applies to single-number values only (never the time split). */
  countUp: boolean;
  /** Time split: three values side by side. */
  parts?: SplitPart[];
  visual: ReadoutVisual | null;
  /** Caption lines (≤ 2), each a segment list. */
  caption: HeadSeg[][];
  /** Compact caption for `short` hosts. */
  short: string;
  /** Precise value for the hover tooltip. */
  tooltip: string;
  /** Leaks tile: up to two leak buttons + the overflow count. */
  leaks?: { items: LeakRef[]; more: number };
  /** Value styled as danger (leak count). */
  danger?: boolean;
}

const lineTarget = (l: LineM): Target => ({ file: l.file.name, line: l.no });
const text = (s: string): HeadSeg[] => [{ t: "text", s }];

function spec(base: Omit<ReadoutSpec, "number" | "unit">): ReadoutSpec {
  const [number, unit] = base.value ? splitUnit(base.value) : ["", ""];
  return { ...base, number, unit };
}

function timeSplitParts(py: number, nat: number, sys: number): SplitPart[] {
  return [
    { key: "py", label: "Python", value: py, text: fmtPct(py), token: "cpu-py" },
    { key: "native", label: "native", value: nat, text: fmtPct(nat), token: "cpu-native" },
    { key: "system", label: "system", value: sys, text: fmtPct(sys), token: "cpu-sys", hatch: "system" },
  ];
}

function timeTile(m: Model): ReadoutSpec {
  const { py, nat, sys, total, outside } = m.split;
  const parts = timeSplitParts(py, nat, sys);
  const showOutside = outside >= 0.05;
  const caption =
    total > 0
      ? `share of run time${showOutside ? ` · ${fmtPct(outside)} outside profiled files` : ""}`
      : "no CPU samples";
  return spec({
    kind: "time",
    label: "Where the time went",
    token: "cpu-py",
    value: "",
    countUp: false,
    parts,
    visual: { kind: "split", parts, max: 100 },
    caption: [text(caption)],
    short: total > 0 ? `of run${showOutside ? ` · ${fmtPct(outside)} outside` : ""}` : "no CPU samples",
    tooltip: `Python ${py.toFixed(2)}% · native ${nat.toFixed(2)}% · system ${sys.toFixed(2)}% of run time`,
  });
}

function peakTile(m: Model): ReadoutSpec {
  const mem = m.memory as NonNullable<Model["memory"]>;
  const line1 = new Segs();
  line1.text(mem.peakT !== null ? `at ${fmtTime(mem.peakT)}` : "time not sampled");
  if (mem.peakLine) line1.text(" · ").ref(fmtLoc(mem.peakLine.file.name, mem.peakLine.no), lineTarget(mem.peakLine));
  else if (!m.caps.peakLocation) line1.text(" · location not recorded");
  if (mem.pyFrac !== null) line1.text(` · Python ${fmtPct(100 * mem.pyFrac)}`);
  // An absent (or non-finite) growth_rate is never shown as a measured "growth 0%".
  const line2: string[] = [mem.growthRecorded ? `growth ${fmtPct(mem.growth)}` : "growth not recorded"];
  if (mem.native > 0) line2.push(`+${fmtMem(mem.native)} native threads`);
  const visual: ReadoutVisual =
    mem.pyFrac !== null
      ? {
          kind: "split",
          max: 1,
          parts: [
            { key: "py", label: "Python", value: mem.pyFrac, text: fmtPct(100 * mem.pyFrac), token: "mem-py" },
            { key: "native", label: "native", value: 1 - mem.pyFrac, text: fmtPct(100 * (1 - mem.pyFrac)), token: "mem-native" },
          ],
        }
      : { kind: "neutral", note: "split not recorded" };
  const precise = `${mem.peak.toFixed(2)}${NBSP}MiB = ${fmtMem(mem.peak)}`;
  return spec({
    kind: "peak",
    label: "Peak memory",
    token: "mem-py",
    value: fmtMem(mem.peak),
    countUp: true,
    visual,
    caption: [line1.list, text(line2.join(" · "))],
    short: mem.peakT !== null ? `at ${fmtTime(mem.peakT)}` : "time not sampled",
    tooltip: mem.peakT !== null ? `${precise}, at ${mem.peakT.toFixed(2)}${NBSP}s` : precise,
  });
}

function gpuTile(m: Model): ReadoutSpec {
  const g = m.gpu as NonNullable<Model["gpu"]>;
  const none = !(g.mean > 0) && !m.rank.lines.gpu.length;
  const line2 = new Segs();
  if (g.devicePeak !== null && g.devicePeak > 0) line2.text(`peak device memory ${fmtMem(g.devicePeak)}`);
  if (g.busiest) {
    if (line2.list.length) line2.text(" · ");
    line2.text("busiest ").ref(fmtLoc(g.busiest.file.name, g.busiest.no), lineTarget(g.busiest)).text(` ${fmtUtil(g.busiest.gpu)}`);
  }
  const how = g.method === "main-thread" ? "mean while the main thread ran (time-weighted)" : "mean while profiled lines ran (time-weighted)";
  return spec({
    kind: "gpu",
    label: g.name,
    token: "gpu",
    value: none ? "0.0%" : fmtUtil(g.mean),
    countUp: true,
    visual: { kind: "meter", value: g.mean, max: 100, token: "gpu" },
    caption: none ? [text("no GPU activity sampled")] : [text(how), line2.list].filter((c) => c.length > 0),
    short: "mean while running",
    tooltip: `${g.mean.toFixed(2)}% ${how}`,
  });
}

function neuronTile(m: Model): ReadoutSpec {
  const n = m.neuron as NonNullable<Model["neuron"]>;
  const elapsedMs = m.elapsed * 1000;
  const nrtPct = elapsedMs > 0 ? (100 * n.nrtMs) / elapsedMs : 0;
  const ncPct = elapsedMs > 0 ? (100 * n.ncMs) / elapsedMs : 0;
  const caption: HeadSeg[][] = [text(`${fmtPct(nrtPct)} of run in NRT · NC ${fmtTime(n.ncMs / 1000)} (${fmtPct(ncPct)})`)];
  if (n.idleOverall !== null) caption.push(text(`device idle in ${fmtPct(n.idleOverall)} of CPU samples`));
  return spec({
    kind: "neuron",
    label: "Neuron runtime",
    token: "gpu",
    value: fmtTime(n.nrtMs / 1000),
    countUp: true,
    visual: {
      kind: "meters",
      rows: [
        { label: "NRT", value: nrtPct, max: 100, token: "gpu-mem" },
        { label: "NC", value: ncPct, max: 100, token: "gpu" },
      ],
    },
    caption,
    short: `${fmtPct(nrtPct)} of run in NRT`,
    tooltip: `${(n.nrtMs / 1000).toFixed(3)}${NBSP}s in Neuron Runtime · ${(n.ncMs / 1000).toFixed(3)}${NBSP}s NeuronCore busy`,
  });
}

function awaitTile(m: Model): ReadoutSpec {
  const top = m.async?.topAwait ?? null;
  const line1 = new Segs().text("of await time");
  const caption: HeadSeg[][] = [line1.list];
  if (top) {
    line1.text(" at ");
    const chip = shortCode(top.text);
    if (chip) line1.code(chip, lineTarget(top), top.text.trim()).text(" · ");
    line1.ref(fmtLoc(top.file.name, top.no), lineTarget(top));
    if (top.concPeak > 0 || top.concMean > 0) {
      caption.push(text(`${top.concMean.toFixed(1)} tasks suspended on average, ${fmtCount(top.concPeak)} at most`));
    }
  }
  const v = top ? top.await : 0;
  return spec({
    kind: "await",
    label: "Await",
    token: "async",
    value: fmtPct(v),
    countUp: true,
    visual: { kind: "meter", value: v, max: 100, token: "async" },
    caption,
    short: "of await time",
    tooltip: top ? `${v.toFixed(2)}% of await time at ${fmtLoc(top.file.name, top.no)}` : "no await time recorded",
  });
}

function leaksTile(m: Model): ReadoutSpec {
  const items: LeakRef[] = m.leaks.slice(0, 2).map((l) => ({
    line: l,
    target: lineTarget(l),
    label: fmtLoc(l.file.name, l.no),
    rate: fmtRate(l.leak?.velocity ?? 0),
    likelihood: fmtPct(100 * (l.leak?.likelihood ?? 0)),
  }));
  const more = Math.max(0, m.leaks.length - items.length);
  const n = m.leaks.length;
  return spec({
    kind: "leaks",
    label: "Possible leaks",
    token: "danger",
    value: String(n),
    countUp: false,
    visual: null,
    caption: [],
    leaks: { items, more },
    danger: true,
    short: items[0] ? `grows ${items[0].rate}` : "",
    tooltip: `${n} possible leak${n === 1 ? "" : "s"} (likelihood ≥ 95%)`,
  });
}

function elapsedTile(m: Model): ReadoutSpec {
  const parts = ["wall clock"];
  const threads = m.sampling.threads.length;
  if (threads > 0) parts.push(`${threads} thread${threads === 1 ? "" : "s"}`);
  if (m.stackSamples > 0) parts.push(`${fmtCount(m.stackSamples)} samples`);
  const caption: HeadSeg[][] = [text(parts.join(" · "))];
  if (m.caps.timeline) caption.push(text(fmtSampling(m.sampling.dt)));
  return spec({
    kind: "elapsed",
    label: "Elapsed",
    token: "fg-2",
    value: fmtTime(m.elapsed),
    countUp: true,
    visual: null,
    caption,
    short: "wall clock",
    tooltip: `${m.elapsed.toFixed(3)}${NBSP}s wall clock`,
  });
}

function busiestTile(m: Model): ReadoutSpec {
  const fn = m.rank.functions.time[0];
  const line = new Segs();
  line.code(functionChip(fn.name), { file: fn.file.name, fn: fn.name }, fn.name).text(" · ");
  line.ref(fmtLoc(fn.file.name, fn.no), { file: fn.file.name, line: fn.no });
  if (Number.isFinite(fn.sec)) line.text(` · ${fmtTime(fn.sec)}`);
  return spec({
    kind: "busiest",
    label: "Busiest function",
    token: "cpu-py",
    value: fmtPct(fn.total),
    countUp: true,
    visual: { kind: "meter", value: fn.total, max: 100, token: "cpu-py" },
    caption: [line.list],
    short: functionChip(fn.name),
    tooltip: Number.isFinite(fn.sec) ? `${fn.total.toFixed(2)}% of run · ${fmtTime(fn.sec)}` : `${fn.total.toFixed(2)}% of run`,
  });
}

/** Slot selection (§4.3.1): at most four tiles, in this order. */
export function buildReadouts(m: Model): ReadoutSpec[] {
  const tiles: ReadoutSpec[] = [timeTile(m)];
  if (m.caps.memory && m.memory && m.memory.peak > 0) tiles.push(peakTile(m));
  if (m.caps.neuron && m.neuron) tiles.push(neuronTile(m));
  else if (m.caps.gpu && m.gpu) tiles.push(gpuTile(m));
  else if (m.caps.async) tiles.push(awaitTile(m));
  if (m.leaks.length > 0) tiles.push(leaksTile(m));
  const optional: [boolean, () => ReadoutSpec][] = [
    // Only a recorded run length gets a tile (a derived one is a lower bound, said in the headline).
    [m.elapsedSource === "recorded", () => elapsedTile(m)],
    [m.rank.functions.time.length > 0, () => busiestTile(m)],
  ];
  for (const [applicable, make] of optional) if (tiles.length < 4 && applicable) tiles.push(make());
  return tiles;
}
