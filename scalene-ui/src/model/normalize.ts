/**
 * Profile input → normalized, validated data + capability flags
 * (DESIGN.md §4.0.1). The raw profile is never mutated: every value read
 * here is copied into new objects with defaults filled, so `globalThis.profile`
 * stays exactly what the host passed in.
 *
 * Absent data is recorded as absent (`null` / caps flag false), never as a
 * measured 0, so views can say "not recorded".
 */

import type {
  CombinedFrame,
  CombinedStackEntry,
  CombinedStackTimelineEvent,
  MemoryStackEntry,
  PyFrame,
} from "../types";

/** Capability flags: which data the profile actually carries (§4.0.1 table). */
export interface Caps {
  memory: boolean;
  gpu: boolean;
  neuron: boolean;
  async: boolean;
  coreUtil: boolean;
  gpuMemory: boolean;
  regions: boolean;
  functionBounds: boolean;
  cpuSamples: boolean;
  startTime: boolean;
  stacks: boolean;
  timeline: boolean;
  threadIds: boolean;
  memStacks: boolean;
  peakLocation: boolean;
  peakPyFraction: boolean;
  leaks: boolean;
  /**
   * A run length is known: `elapsed_time_sec` is a finite number > 0, or one is derived from
   * the sample times (`Model.elapsedSource`). False → seconds are not shown (§1.3.3).
   */
  elapsed: boolean;
}

/** One source line or one function summary with every default filled. */
export interface NormRow {
  lineno: number;
  /** Lines: unescaped source without the trailing newline. Functions: the qualname. */
  text: string;
  py: number;
  c: number;
  sys: number;
  coreUtil: number | null;
  /** Main-thread CPU sample times in seconds since profile start, sorted. */
  cpuTimes: Float64Array;
  malloc: number;
  mallocs: number;
  peak: number;
  avg: number;
  pyFrac: number;
  usage: number;
  copy: number;
  /** `[t0, mb0, t1, mb1, …]`, t in seconds, sorted by time; values raw (may be < 0). */
  memSamples: Float64Array;
  gpu: number;
  gpuAvg: number | null;
  gpuPeak: number | null;
  await: number;
  concMean: number;
  concPeak: number;
  tasks: readonly string[];
  coro: boolean;
  region: [number, number];
  outer: [number, number] | null;
  fnRange: [number, number] | null;
  hasRegion: boolean;
  hasFnBounds: boolean;
  neuron: NormNeuron | null;
}

export interface NormNeuron {
  nrtMs: number;
  nrtPct: number;
  nrtCount: number;
  ncMs: number;
  ncPct: number;
  ncCount: number;
  ncNrtRatio: number | null;
  /** `cpu_samples_nc_overlap_percent`; null when the field is absent. */
  overlapPct: number | null;
  kernel: string | null;
}

export interface NormLeak {
  likelihood: number;
  velocity: number;
}

export interface NormFile {
  name: string;
  pct: number;
  rows: NormRow[];
  functions: NormRow[];
  imports: string[];
  /** Keyed by line number; null when the file has no `leaks` key (very old profiles). */
  leaks: Map<number, NormLeak> | null;
  /** `rows[i].lineno === i + 1` for every row (current emitters). */
  dense: boolean;
}

/**
 * Validated timeline events as parallel arrays (41k events on huge.json, so
 * no per-event objects). `thread[i]` is NaN for an unknown (null) thread.
 */
export interface NormTimeline {
  n: number;
  t: Float64Array;
  stack: Int32Array;
  count: Int32Array;
  thread: Float64Array;
}

/** Thread id of event `i`, null when unknown. */
export function eventThread(tl: NormTimeline, i: number): number | null {
  const v = tl.thread[i];
  return v === v ? v : null;
}

export interface NormProfile {
  program: string;
  args: string[];
  entrypointDir: string;
  /** `elapsed_time_sec`, 0 when missing, non-finite or ≤ 0 (then `elapsedRecorded` is false). */
  elapsed: number;
  elapsedRecorded: boolean;
  startEpoch: number | null;
  startPerf: number | null;
  memory: boolean;
  gpu: boolean;
  gpuDevice: string;
  asyncProfile: boolean;
  maxFootprint: number;
  maxFootprintPyFrac: number | null;
  maxFootprintFile: string | null;
  maxFootprintLine: number | null;
  nativeAllocations: number;
  /** Raw `growth_rate` (may be < 0 or > 100; display clamps); 0 when absent. */
  growthRate: number;
  /** `growth_rate` is a finite number (NaN/±Infinity/missing → not recorded, §1.3.3). */
  growthRecorded: boolean;
  allocSamples: number | null;
  /** Program footprint `[t0, mb0, …]`, t in seconds, sorted by time; values raw. */
  samples: Float64Array;
  files: NormFile[];
  stacks: CombinedStackEntry[];
  timeline: NormTimeline;
  memoryStacks: MemoryStackEntry[];
  mainThreadId: number | null;
  neuronTotalMs: number | null;
  neuronNcTotalMs: number | null;
  /** `cpu_samples_nc_overlap_percent_overall`. */
  overlapOverall: number | null;
}

export type ParseResult =
  | { kind: "ok"; profile: NormProfile; caps: Caps; raw: Record<string, unknown> }
  | { kind: "empty" }
  | { kind: "error"; message: string };

// ── Scalar coercion (NaN / ±Infinity count as absent) ───────────────────────

type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Finite number, else `fallback`. */
export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Finite number, else null (absent). */
export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const ESCAPED = /\\u(003[cCeE]|0026)/g;

/**
 * Scalene escapes `<`, `>`, `&` in source text as the six-character
 * sequences `<`, `>`, `&` (any hex case). Restore only those,
 * and strip one trailing line break.
 */
export function unescapeSource(s: string): string {
  const text = s.replace(/\r?\n$/, "");
  return text.indexOf("\\u") < 0 ? text : text.replace(ESCAPED, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ── Typed sample arrays ─────────────────────────────────────────────────────

/** `[[t_ns, mb], …]` → sorted `[t_s, mb, …]`; invalid pairs are dropped. */
export function toMemSamples(v: unknown): Float64Array {
  const src = arr(v);
  if (src.length === 0) return EMPTY;
  const out = new Float64Array(src.length * 2);
  let n = 0;
  let sorted = true;
  let last = -Infinity;
  for (const s of src) {
    if (!Array.isArray(s) || s.length < 2) continue;
    const t = s[0];
    const mb = s[1];
    if (typeof t !== "number" || typeof mb !== "number" || !Number.isFinite(t) || !Number.isFinite(mb)) continue;
    const ts = t / 1e9;
    if (ts < last) sorted = false;
    last = ts;
    out[n++] = ts;
    out[n++] = mb;
  }
  const res = n === out.length ? out : out.slice(0, n);
  return sorted ? res : sortPairs(res);
}

function sortPairs(a: Float64Array): Float64Array {
  const m = a.length / 2;
  const idx = new Uint32Array(m);
  for (let i = 0; i < m; i++) idx[i] = i;
  idx.sort((x, y) => a[2 * x] - a[2 * y] || x - y);
  const out = new Float64Array(a.length);
  for (let i = 0; i < m; i++) {
    out[2 * i] = a[2 * idx[i]];
    out[2 * i + 1] = a[2 * idx[i] + 1];
  }
  return out;
}

/** Absolute `perf_counter` seconds → seconds since start, sorted. */
function toCpuTimes(v: unknown, startPerf: number | null): Float64Array {
  if (startPerf === null) return EMPTY;
  const src = arr(v);
  if (src.length === 0) return EMPTY;
  const out = new Float64Array(src.length);
  let n = 0;
  let sorted = true;
  for (const x of src) {
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    const t = x - startPerf;
    if (n > 0 && t < out[n - 1]) sorted = false;
    out[n++] = t;
  }
  const res = n === out.length ? out : out.slice(0, n);
  return sorted ? res : res.sort();
}

export const EMPTY = new Float64Array(0);

// ── Rows ────────────────────────────────────────────────────────────────────

function range(o: Obj, startKey: string, endKey: string): [number, number] | null {
  const s = numOrNull(o[startKey]);
  if (s === null) return null;
  const e = numOrNull(o[endKey]);
  return [s, e === null ? s : e];
}

function neuronOf(o: Obj): NormNeuron | null {
  const has =
    "nrt_time_ms" in o || "nc_time_ms" in o || "nrt_percent" in o || "cpu_samples_nc_overlap_percent" in o;
  if (!has) return null;
  return {
    nrtMs: num(o.nrt_time_ms, num(o.neuron_time_ms)),
    nrtPct: num(o.nrt_percent),
    nrtCount: num(o.nrt_execute_count),
    ncMs: num(o.nc_time_ms),
    ncPct: num(o.nc_percent),
    ncCount: num(o.nc_execute_count),
    ncNrtRatio: numOrNull(o.nc_nrt_ratio),
    overlapPct: numOrNull(o.cpu_samples_nc_overlap_percent),
    kernel: strOrNull(o.nrt_source_code),
  };
}

function taskNames(v: unknown): readonly string[] {
  const src = arr(v);
  return src.length === 0 ? NO_TASKS : src.filter((x): x is string => typeof x === "string");
}
const NO_TASKS: readonly string[] = Object.freeze([]);

function normRow(o: Obj, isFunction: boolean, startPerf: number | null): NormRow | null {
  const lineno = num(o.lineno, NaN);
  if (!(lineno >= 0)) return null;
  const rawText = str(o.line);
  const region = range(o, "start_region_line", "end_region_line");
  const fs = numOrNull(o.start_function_line);
  const fe = numOrNull(o.end_function_line);
  const peak = "n_peak_mb" in o ? num(o.n_peak_mb) : num(o.n_growth_mb);
  return {
    lineno,
    text: isFunction ? rawText.trim() : unescapeSource(rawText),
    py: num(o.n_cpu_percent_python),
    c: num(o.n_cpu_percent_c),
    sys: num(o.n_sys_percent),
    coreUtil: numOrNull(o.n_core_utilization),
    cpuTimes: isFunction ? EMPTY : toCpuTimes(o.cpu_samples_list, startPerf),
    malloc: num(o.n_malloc_mb),
    mallocs: num(o.n_mallocs),
    peak,
    avg: num(o.n_avg_mb),
    pyFrac: num(o.n_python_fraction),
    usage: num(o.n_usage_fraction),
    copy: num(o.n_copy_mb_s),
    memSamples: toMemSamples(o.memory_samples),
    gpu: num(o.n_gpu_percent),
    gpuAvg: numOrNull(o.n_gpu_avg_memory_mb),
    gpuPeak: numOrNull(o.n_gpu_peak_memory_mb),
    await: num(o.n_async_await_percent),
    concMean: num(o.n_async_concurrency_mean),
    concPeak: num(o.n_async_concurrency_peak),
    tasks: taskNames(o.async_task_names),
    coro: o.is_coroutine === true,
    region: region ?? [lineno, lineno],
    outer: range(o, "start_outermost_loop", "end_outermost_loop"),
    fnRange: fs !== null && fs > 0 ? [fs, fe === null ? fs : fe] : null,
    hasRegion: region !== null,
    hasFnBounds: fs !== null,
    neuron: isFunction ? null : neuronOf(o),
  };
}

function normRows(v: unknown, isFunction: boolean, startPerf: number | null): NormRow[] {
  const out: NormRow[] = [];
  let sorted = true;
  for (const o of arr(v)) {
    if (!isObject(o)) continue;
    const r = normRow(o, isFunction, startPerf);
    if (!r) continue;
    if (out.length > 0 && r.lineno < out[out.length - 1].lineno) sorted = false;
    out.push(r);
  }
  if (!sorted) out.sort((a, b) => a.lineno - b.lineno);
  if (isFunction) return out;
  // Lines are keyed by lineno: keep the first of duplicates.
  return out.filter((r, i) => i === 0 || r.lineno !== out[i - 1].lineno);
}

function normLeaks(v: unknown): Map<number, NormLeak> | null {
  if (!isObject(v)) return null;
  const m = new Map<number, NormLeak>();
  for (const [k, info] of Object.entries(v)) {
    const lineno = Number(k);
    if (!Number.isInteger(lineno) || !isObject(info)) continue;
    m.set(lineno, { likelihood: num(info.likelihood), velocity: num(info.velocity_mb_s) });
  }
  return m;
}

function normFile(name: string, o: Obj, startPerf: number | null): NormFile {
  const rows = normRows(o.lines, false, startPerf);
  let dense = true;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].lineno !== i + 1) {
      dense = false;
      break;
    }
  }
  return {
    name,
    pct: num(o.percent_cpu_time),
    rows,
    functions: normRows(o.functions, true, null),
    imports: arr(o.imports).filter((x): x is string => typeof x === "string"),
    leaks: normLeaks(o.leaks),
    dense,
  };
}

// ── Stacks ──────────────────────────────────────────────────────────────────

function isFrame(f: unknown): f is CombinedFrame {
  if (!isObject(f)) return false;
  return f.kind === "py" || f.kind === "native";
}

function normStacks(v: unknown): CombinedStackEntry[] {
  const out: CombinedStackEntry[] = [];
  for (const e of arr(v)) {
    if (!Array.isArray(e) || !Array.isArray(e[0])) {
      out.push([[], 0]); // keep indices aligned with timeline stack_index
      continue;
    }
    const frames = (e[0] as unknown[]).filter(isFrame);
    out.push([frames, Math.max(0, num(e[1]))]);
  }
  return out;
}

function normMemoryStacks(v: unknown): MemoryStackEntry[] {
  const out: MemoryStackEntry[] = [];
  for (const e of arr(v)) {
    if (!Array.isArray(e) || !Array.isArray(e[0])) continue;
    const mb = num(e[1]);
    if (!(mb > 0)) continue;
    const frames = (e[0] as unknown[]).filter((f): f is PyFrame => isFrame(f) && f.kind === "py");
    if (frames.length > 0) out.push([frames, mb]);
  }
  return out;
}

function normTimeline(v: unknown, nStacks: number): NormTimeline {
  const src = arr(v);
  const t = new Float64Array(src.length);
  const stack = new Int32Array(src.length);
  const count = new Int32Array(src.length);
  const thread = new Float64Array(src.length);
  let n = 0;
  for (const e of src) {
    if (!isObject(e)) continue;
    const ev = e as Partial<CombinedStackTimelineEvent>;
    const ts = ev.t_sec;
    const si = ev.stack_index;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (typeof si !== "number" || !Number.isInteger(si) || si < 0 || si >= nStacks) continue;
    const c = ev.count;
    t[n] = ts;
    stack[n] = si;
    count[n] = typeof c === "number" && Number.isFinite(c) ? Math.max(1, Math.round(c)) : 1;
    thread[n] = typeof ev.thread_id === "number" && Number.isFinite(ev.thread_id) ? ev.thread_id : NaN;
    n++;
  }
  return n === src.length
    ? { n, t, stack, count, thread }
    : { n, t: t.slice(0, n), stack: stack.slice(0, n), count: count.slice(0, n), thread: thread.slice(0, n) };
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Python's `json.dumps` (Scalene's writer, `allow_nan=True`) may emit the bare tokens `NaN`,
 * `Infinity` and `-Infinity`, which `JSON.parse` rejects. Replace them — outside strings
 * only — with `null`, which normalization already treats as absent (§4.0.1).
 */
export function replaceNonFiniteTokens(text: string): string {
  const out: string[] = [];
  let last = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \\ */) i++;
      else if (c === 34 /* " */) inString = false;
      continue;
    }
    if (c === 34) {
      inString = true;
      continue;
    }
    let len = 0;
    if (c === 78 /* N */ && text.startsWith("NaN", i)) len = 3;
    else if (c === 73 /* I */ && text.startsWith("Infinity", i)) len = 8;
    else if (c === 45 /* - */ && text.startsWith("-Infinity", i)) len = 9;
    if (!len) continue;
    out.push(text.slice(last, i), "null");
    i += len - 1;
    last = i + 1;
  }
  if (!out.length) return text;
  out.push(text.slice(last));
  return out.join("");
}

/**
 * `JSON.parse` for profile text, tolerant of Python's NaN/±Infinity tokens (retried once
 * with them replaced by null). The error message is the original parser's.
 */
export function parseProfileText(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const fixed = replaceNonFiniteTokens(text);
    if (fixed !== text) {
      try {
        return { ok: true, value: JSON.parse(fixed) as unknown };
      } catch {
        // fall through: report the first error
      }
    }
    return { ok: false, message };
  }
}

/**
 * Accept what `load()` may receive: an object, JSON text, `""`, `null`, …
 * `""`, `null`, a non-object, `{}` or a profile without `files` entries are
 * the empty state; unparsable text is an error (load-error toast).
 */
export function parseProfile(input: unknown): ParseResult {
  let value: unknown = input;
  if (typeof input === "string") {
    if (input.trim() === "") return { kind: "empty" };
    const r = parseProfileText(input);
    if (!r.ok) return { kind: "error", message: r.message };
    value = r.value;
  }
  if (!isObject(value)) return { kind: "empty" };
  const files = value.files;
  if (!isObject(files) || Object.keys(files).length === 0) return { kind: "empty" };
  const profile = normalize(value);
  return { kind: "ok", profile, caps: computeCaps(profile, value), raw: value };
}

/** Normalize a raw profile object (assumed to have a `files` object). */
export function normalize(p: Obj): NormProfile {
  const startPerf = numOrNull(p.start_time_perf);
  const files: NormFile[] = [];
  const rawFiles = isObject(p.files) ? p.files : {};
  for (const [name, fd] of Object.entries(rawFiles)) {
    if (isObject(fd)) files.push(normFile(name, fd, startPerf));
  }
  const stacks = normStacks(p.combined_stacks);
  const args = arr(p.args).filter((x): x is string => typeof x === "string");
  return {
    program: str(p.program),
    args: args.slice(1),
    entrypointDir: str(p.entrypoint_dir),
    elapsed: Math.max(0, num(p.elapsed_time_sec)),
    elapsedRecorded: num(p.elapsed_time_sec) > 0,
    startEpoch: numOrNull(p.start_time_absolute),
    startPerf,
    memory: p.memory === true,
    gpu: p.gpu === true,
    gpuDevice: str(p.gpu_device),
    asyncProfile: p.async_profile === true,
    maxFootprint: Math.max(0, num(p.max_footprint_mb)),
    maxFootprintPyFrac: numOrNull(p.max_footprint_python_fraction),
    maxFootprintFile: strOrNull(p.max_footprint_fname),
    maxFootprintLine: numOrNull(p.max_footprint_lineno),
    nativeAllocations: num(p.native_allocations_mb),
    growthRate: num(p.growth_rate),
    growthRecorded: numOrNull(p.growth_rate) !== null,
    allocSamples: numOrNull(p.alloc_samples),
    samples: toMemSamples(p.samples),
    files,
    stacks,
    timeline: normTimeline(p.combined_stacks_timeline, stacks.length),
    memoryStacks: normMemoryStacks(p.memory_stacks),
    mainThreadId: numOrNull(p.main_thread_id),
    neuronTotalMs: numOrNull(p.neuron_total_time_ms),
    neuronNcTotalMs: numOrNull(p.neuron_total_nc_time_ms),
    overlapOverall: numOrNull(p.cpu_samples_nc_overlap_percent_overall),
  };
}

/** Capability flags (§4.0.1). `raw` is read only for key presence. */
export function computeCaps(np: NormProfile, raw: Obj): Caps {
  let neuron = false;
  let coreUtil = false;
  let gpuMemory = false;
  let regions = false;
  let functionBounds = false;
  let anyCpuSamples = false;
  let leaks = false;
  for (const f of np.files) {
    if (f.leaks !== null) leaks = true;
    for (const r of f.rows) {
      const n = r.neuron;
      if (n && (n.ncMs > 0 || n.nrtMs > 0 || n.nrtPct > 0)) neuron = true;
      if (r.coreUtil !== null) coreUtil = true;
      if (r.gpuPeak !== null) gpuMemory = true;
      if (r.hasRegion) regions = true;
      if (r.hasFnBounds) functionBounds = true;
      if (r.cpuTimes.length > 0) anyCpuSamples = true;
    }
  }
  const memStackMb = np.memoryStacks.reduce((a, e) => a + e[1], 0);
  const stacks = np.stacks.length > 0;
  return {
    memory: np.memory,
    gpu: np.gpu && !neuron,
    neuron,
    async: np.asyncProfile,
    coreUtil,
    gpuMemory,
    regions,
    functionBounds,
    cpuSamples: np.startPerf !== null && anyCpuSamples,
    startTime: np.startEpoch !== null,
    stacks,
    timeline: stacks && np.timeline.n > 0,
    threadIds: np.timeline.thread.some((x) => x === x),
    memStacks: np.memoryStacks.length > 0 && memStackMb > 0,
    peakLocation: np.maxFootprintFile !== null && np.maxFootprintLine !== null,
    peakPyFraction: "max_footprint_python_fraction" in raw && np.maxFootprintPyFrac !== null,
    leaks,
    // Refined by the model when the run length can be derived from sample times.
    elapsed: np.elapsedRecorded,
  };
}
