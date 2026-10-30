/**
 * The fixed "% of what" vocabulary (DESIGN.md §4.0.3). Every view builds
 * denominators from these functions, so one number has one phrase
 * everywhere. `compact` variants are for short hosts and chips.
 */

import { fmtCount, fmtMem, fmtPct, fmtRate, fmtTime } from "../core/format";

/** "21.4% of run · 11.6 s" / compact "21.4% of run". */
export function ofRun(total: number, sec: number, compact = false): string {
  // NaN seconds = no run length recorded: the share stands alone (never "0 s").
  return compact || !Number.isFinite(sec) ? `${fmtPct(total)} of run` : `${fmtPct(total)} of run · ${fmtTime(sec)}`;
}

/** "Python 0.1% · native 7.2% · system 14.1% (of run)". */
export function splitParts(py: number, nat: number, sys: number): string {
  return `Python ${fmtPct(py)} · native ${fmtPct(nat)} · system ${fmtPct(sys)} (of run)`;
}

/** File share: "58.8% of run · 31.8 s of 54.1 s". */
export function fileShare(pct: number, elapsed: number): string {
  if (!(elapsed > 0)) return `${fmtPct(pct)} of run`;
  return `${fmtPct(pct)} of run · ${fmtTime((pct / 100) * elapsed)} of ${fmtTime(elapsed)}`;
}

/** "0.4% outside profiled files", or null below 0.05 % (hidden, never negative). */
export function outside(pct: number): string | null {
  return pct >= 0.05 ? `${fmtPct(pct)} outside profiled files` : null;
}

/** Core use (`n_core_utilization` is a 0–1 fraction): "1.2% of all cores while it ran" / "cores 1.2%". */
export function cores(fraction: number, compact = false): string {
  const p = fmtPct(100 * fraction);
  return compact ? `cores ${p}` : `${p} of all cores while it ran`;
}

/** "peak 1.20 GiB attributed to this line" / "peak 1.20 GiB". */
export function linePeak(mib: number, compact = false): string {
  return compact ? `peak ${fmtMem(mib)}` : `peak ${fmtMem(mib)} attributed to this line`;
}

/** Allocation share (`n_usage_fraction`, 0–1): "33.0% of all allocation" / "33.0% of alloc.". */
export function allocShare(fraction: number, compact = false): string {
  const p = fmtPct(100 * fraction);
  return compact ? `${p} of alloc.` : `${p} of all allocation`;
}

/** "1.20 GiB allocated over the run (sampled)". */
export function allocated(mib: number): string {
  return `${fmtMem(mib)} allocated over the run (sampled)`;
}

/** "22.0 MiB/s copied (average over run)" / "22.0 MiB/s". */
export function copied(mibPerS: number, compact = false): string {
  return compact ? fmtRate(mibPerS) : `${fmtRate(mibPerS)} copied (average over run)`;
}

/** Line GPU util: "96.4% busy while this line ran" / "96.4% busy". */
export function gpuBusy(pct: number, compact = false): string {
  return compact ? `${fmtPct(pct)} busy` : `${fmtPct(pct)} busy while this line ran`;
}

/** GPU readout method caption (§4.0.3). */
export function gpuMethod(method: "main-thread" | "all-lines", compact = false): string {
  if (compact) return "mean while running";
  return method === "main-thread"
    ? "mean while the main thread ran profiled lines (time-weighted)"
    : "mean while profiled lines ran (time-weighted)";
}

/** "peak device memory (process) while this line ran" / "device peak". */
export function gpuMemory(compact = false): string {
  return compact ? "device peak" : "peak device memory (process) while this line ran";
}

/** "35.8% of await time" / compact "of await". */
export function awaitShare(pct: number, compact = false): string {
  return compact ? "of await" : `${fmtPct(pct)} of await time`;
}

/** "15.5 tasks suspended on average, 22 at most" / "15.5 / 22 tasks". */
export function concurrency(mean: number, peak: number, compact = false): string {
  return compact ? `${mean.toFixed(1)} / ${fmtCount(peak)} tasks` : `${mean.toFixed(1)} tasks suspended on average, ${fmtCount(peak)} at most`;
}

/** NRT / NC time: "9.69 s · 37.0% of run" / "37.0% of run". */
export function deviceTime(ms: number, elapsed: number, compact = false): string {
  const pct = elapsed > 0 ? ms / 10 / elapsed : 0;
  return compact ? `${fmtPct(pct)} of run` : `${fmtTime(ms / 1000)} · ${fmtPct(pct)} of run`;
}

/** "12.4% of this line's CPU samples had the device idle" / "idle 12.4%". */
export function deviceIdle(idlePct: number, compact = false): string {
  return compact ? `idle ${fmtPct(idlePct)}` : `${fmtPct(idlePct)} of this line's CPU samples had the device idle`;
}

export const FLAME_CPU_DENOMINATOR = "% of sampled stacks — not of run time";

/** GC / I/O & waits / GIL lanes: "0.6% of samples". */
export function ofSamples(pct: number): string {
  return `${fmtPct(pct)} of samples`;
}

/** Threads busy: "4.2 threads sampled". */
export function threadsSampled(n: number): string {
  return `${n.toFixed(1)} threads sampled`;
}

/** Growth (`growth_rate`, clamped for display): "52.2% of allocated memory stayed live" / "growth 52.2%". */
export function growth(pct: number, compact = false): string {
  const p = fmtPct(Math.min(100, Math.max(0, pct)));
  return compact ? `growth ${p}` : `${p} of allocated memory stayed live`;
}

/** "possible leak · grows ~5.71 MiB/s · likelihood 99.7%" / "leak 5.71 MiB/s". */
export function leak(l: { velocity: number; likelihood: number }, compact = false): string {
  return compact
    ? `leak · grows ${fmtRate(l.velocity)}`
    : `possible leak · grows ~${fmtRate(l.velocity)} · likelihood ${fmtPct(100 * l.likelihood)}`;
}

/** "Region 152–184: 43.4% of run". */
export function region(start: number, end: number, total: number): string {
  return `Region ${start}–${end}: ${fmtPct(total)} of run`;
}

/** "in 1,157 of 5,901 stack samples (19.6%)". */
export function stackPresence(hits: number, total: number): string {
  return `in ${fmtCount(hits)} of ${fmtCount(total)} stack samples (${fmtPct(total > 0 ? (100 * hits) / total : 0)})`;
}

export const NOT_RECORDED = "not recorded";
export const NONE_SAMPLED = "none sampled";
export const MISSING_COMPACT = "—";

/**
 * Missing values: "not recorded" when the field is absent from the profile,
 * "none sampled" when it is present but 0 ("—" in compact cells).
 */
export function missing(present: boolean, compact = false): string {
  return compact ? MISSING_COMPACT : present ? NONE_SAMPLED : NOT_RECORDED;
}
