/**
 * Deterministic findings (DESIGN.md §4.6.2). At most one card per rule
 * (leaks: up to three), shown in table order: high → medium → low. Within a
 * rule the instance with the largest `total` wins (leaks by likelihood).
 */

import { fmtLoc, fmtMem, fmtPct, fmtRate, fmtTime } from "../core/format";
import type { IconName } from "../core/icons";
import type { Target } from "../core/store";
import { lineSubject, Segs, type HeadSeg } from "./headline";
import type { LineM, Model } from "./model";

export type FindingId = "gpu-sync" | "loop-blocked" | "leak" | "peak" | "neuron-idle" | "gil" | "copy" | "native" | "python";
export type Severity = "high" | "medium" | "low";

export interface Finding {
  id: FindingId;
  severity: Severity;
  /** Resource token for the icon tile (no `--`). */
  token: string;
  icon: IconName;
  title: string;
  sentence: HeadSeg[];
  /** Evidence location ("train.py:173"), or null for program-wide findings. */
  ref: { label: string; target: Target } | null;
  line: LineM | null;
}

/** Rule thresholds (unit-tested on the fixtures, Appendix A). */
export const THRESHOLDS = {
  gpuSync: { minTotal: 5, minSysShare: 0.5, minGpu: 50 },
  loopBlocked: { minTotal: 5, maxSysShare: 0.5 },
  maxLeaks: 3,
  neuronIdle: { minTotal: 5, minIdle: 60, minSamples: 20, minSpread: 0.25 },
  gilLane: 2,
  copy: 10,
  native: 60,
  python: { minShare: 60, minTotal: 50 },
  /** Chips in finding sentences are shorter than headline chips (they share a 13 px line with numbers). */
  chipMax: 22,
} as const;

const lineTarget = (l: LineM): Target => ({ file: l.file.name, line: l.no });
const refOf = (l: LineM): Finding["ref"] => ({ label: fmtLoc(l.file.name, l.no), target: lineTarget(l) });
const sysShare = (l: LineM): number => (l.total > 0 ? l.sys / l.total : 0);

function largestTotal(lines: readonly LineM[], keep: (l: LineM) => boolean): LineM | null {
  let best: LineM | null = null;
  for (const l of lines) if (keep(l) && (!best || l.total > best.total)) best = l;
  return best;
}

/** p-quantile of sorted values (linear interpolation). */
function quantile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const x = (sorted.length - 1) * p;
  const lo = Math.floor(x);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

/** Recurring work: ≥ 20 CPU samples whose p10–p90 spread covers ≥ 25 % of the run. */
export function isRecurring(l: LineM, elapsed: number): boolean {
  const t = THRESHOLDS.neuronIdle;
  if (l.cpuTimes.length < t.minSamples || !(elapsed > 0)) return false;
  return quantile(l.cpuTimes, 0.9) - quantile(l.cpuTimes, 0.1) >= t.minSpread * elapsed;
}

type Rule = (m: Model, lines: readonly LineM[]) => Finding[];

const gpuSync: Rule = (m, lines) => {
  const t = THRESHOLDS.gpuSync;
  if (!m.caps.gpu) return [];
  const l = largestTotal(lines, (x) => x.total >= t.minTotal && sysShare(x) >= t.minSysShare && x.gpu >= t.minGpu);
  if (!l) return [];
  const b = new Segs();
  lineSubject(b, l, true, THRESHOLDS.chipMax);
  const secs = Number.isFinite(l.sec) ? ` (${fmtTime(l.sec)})` : "";
  b.text(" takes ").num(fmtPct(l.total)).text(` of run time${secs}, ${Math.round(100 * sysShare(l))}% of it system time, while the GPU is `);
  b.num(fmtPct(l.gpu)).text(" busy — likely a host-device synchronization.");
  return [{ id: "gpu-sync", severity: "high", token: "gpu", icon: "sync", title: "The host waits on the GPU", sentence: b.list, ref: refOf(l), line: l }];
};

const loopBlocked: Rule = (m, lines) => {
  const t = THRESHOLDS.loopBlocked;
  if (!m.caps.async) return [];
  const l = largestTotal(lines, (x) => x.coro && x.total >= t.minTotal && sysShare(x) < t.maxSysShare);
  if (!l) return [];
  const b = new Segs();
  lineSubject(b, l, true, THRESHOLDS.chipMax);
  b.text(" takes ").num(fmtPct(l.total)).text(" of run time inside a coroutine; the event loop cannot run other tasks meanwhile.");
  return [{ id: "loop-blocked", severity: "high", token: "async", icon: "wait", title: "CPU work blocks the event loop", sentence: b.list, ref: refOf(l), line: l }];
};

const leak: Rule = (m) =>
  m.leaks.slice(0, THRESHOLDS.maxLeaks).map((l) => {
    const info = l.leak as NonNullable<LineM["leak"]>;
    const b = new Segs();
    lineSubject(b, l, true, THRESHOLDS.chipMax);
    b.text(" grows about ").num(fmtRate(info.velocity)).text(` (likelihood ${fmtPct(100 * info.likelihood)}); peak ${fmtMem(l.peak)}.`);
    return {
      id: "leak" as const,
      severity: "high" as const,
      token: "danger",
      icon: "trend-up",
      title: `Possible leak at ${fmtLoc(l.file.name, l.no)}`,
      sentence: b.list,
      ref: refOf(l),
      line: l,
    };
  });

const peak: Rule = (m) => {
  const mem = m.memory;
  if (!m.caps.memory || !m.caps.peakLocation || !mem || !(mem.peak > 0)) return [];
  const l = mem.peakLine;
  const b = new Segs();
  b.text(mem.peakT !== null ? `at ${fmtTime(mem.peakT)}` : "time not sampled");
  if (l) {
    b.text(" in ");
    if (lineSubject(b, l, false, THRESHOLDS.chipMax)) b.text(" (").ref(fmtLoc(l.file.name, l.no), lineTarget(l)).text(")");
    b.text("; this line's own peak is ").num(fmtMem(l.peak)).text(".");
  } else b.text(".");
  return [{ id: "peak", severity: "medium", token: "mem-py", icon: "peak", title: `Memory peaks at ${fmtMem(mem.peak)}`, sentence: b.list, ref: l ? refOf(l) : null, line: l }];
};

const neuronIdle: Rule = (m, lines) => {
  const t = THRESHOLDS.neuronIdle;
  if (!m.caps.neuron) return [];
  const l = largestTotal(
    lines,
    (x) => x.total >= t.minTotal && (x.neuron?.idlePct ?? -1) >= t.minIdle && isRecurring(x, m.elapsed),
  );
  if (!l) return [];
  const idle = l.neuron?.idlePct ?? 0;
  const b = new Segs();
  lineSubject(b, l, true, THRESHOLDS.chipMax);
  b.text(" takes ").num(fmtPct(l.total)).text(" of run time with the device idle in ").num(fmtPct(idle)).text(" of its samples, throughout the run.");
  return [{ id: "neuron-idle", severity: "medium", token: "gpu", icon: "gpu", title: "The accelerator idles during recurring work", sentence: b.list, ref: refOf(l), line: l }];
};

const gil: Rule = (m) => {
  const lanes = m.sampling.laneTotals;
  if (!lanes || lanes.gil < THRESHOLDS.gilLane) return [];
  const waiting = m.sampling.threads.reduce<(typeof m.sampling.threads)[number] | null>(
    (a, t) => (t.gilSamples > 0 && (!a || t.gilSamples > a.gilSamples) ? t : a),
    null,
  );
  const b = new Segs().num(fmtPct(lanes.gil)).text(" of samples are waiting to take the GIL");
  b.text(waiting ? `; the busiest waiting thread is ${waiting.label}.` : ".");
  return [{ id: "gil", severity: "medium", token: "gil", icon: "lanes", title: "Threads wait for the GIL", sentence: b.list, ref: null, line: null }];
};

const copy: Rule = (_m, lines) => {
  const l = largestTotal(lines, (x) => x.copy >= THRESHOLDS.copy);
  if (!l) return [];
  const b = new Segs();
  lineSubject(b, l, true, THRESHOLDS.chipMax);
  b.text(" copies ").num(fmtRate(l.copy)).text(" on average — check Python↔native conversions.");
  return [{ id: "copy", severity: "medium", token: "copy", icon: "copy", title: "Heavy copying", sentence: b.list, ref: refOf(l), line: l }];
};

const native: Rule = (m) => {
  if (m.split.nat < THRESHOLDS.native) return [];
  const b = new Segs().num(fmtPct(m.split.nat)).text(" of run time is native. Python-level edits help less; see which native calls in Call stacks.");
  return [{ id: "native", severity: "low", token: "cpu-native", icon: "cpu", title: "Most time is in native code", sentence: b.list, ref: null, line: null }];
};

const python: Rule = (m) => {
  const t = THRESHOLDS.python;
  if (m.split.py < t.minShare || m.split.total < t.minTotal) return [];
  const b = new Segs().num(fmtPct(m.split.py)).text(" of run time runs in the interpreter; vectorizing the hot loop would help most.");
  return [{ id: "python", severity: "low", token: "cpu-py", icon: "code", title: "Python interpreter time dominates", sentence: b.list, ref: null, line: null }];
};

const RULES: readonly Rule[] = [gpuSync, loopBlocked, leak, peak, neuronIdle, gil, copy, native, python];

export function buildFindings(m: Model): Finding[] {
  const lines = m.files.concat(m.hiddenFiles).flatMap((f) => f.lines);
  return RULES.flatMap((rule) => rule(m, lines));
}

/** Findings shown before "Show N more". */
export const FINDINGS_VISIBLE = 3;
