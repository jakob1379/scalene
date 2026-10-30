/**
 * The immutable report model (DESIGN.md §4.0, §8.4). Built once per
 * `load()`; every view reads from it and nothing reads the raw profile
 * (except `globalThis.profile` compatibility). Heavy derivations (timeline
 * arrays, flame trees, call-context index, search index) are lazy and
 * time-sliced; everything the first screen needs is eager.
 */

import { basename, dirname } from "../core/format";
import type { Metric, Target } from "../core/store";
import { classifyStacks } from "./classify";
import { buildFindings, type Finding } from "./findings";
import { buildHeadline, type HeadlineModel } from "./headline";
import { Lazy } from "./lazy";
import { peakInfo } from "./memory";
import { parseProfile, type Caps, type NormFile, type NormProfile, type NormRow } from "./normalize";
import { buildReadouts, type ReadoutSpec } from "./readouts";
import { buildSearchIndex, type SearchIndex } from "./search";
import { buildCallContextIndex, buildFlameTree, callContextFor, type CallContext, type FlameTree } from "./stacks";
import { stringLines } from "./syntax";
import { buildTimeline, summarizeTimeline, type TimelineM, type TimelineSummary } from "./timeline";
import { classifyRows } from "./visibility";

export type { Caps } from "./normalize";

// ── Interfaces (§8.4) ───────────────────────────────────────────────────────

export interface NeuronLineM {
  nrtMs: number;
  nrtPct: number;
  ncMs: number;
  /** Device idle share of this line's CPU samples: `100 − overlap`; null when not recorded. */
  idlePct: number | null;
  nrtCount: number;
  ncCount: number;
  kernel: string | null;
}

export interface LineM {
  file: FileM;
  no: number;
  /** Unescaped source text (no trailing newline). */
  text: string;
  /** Inside a triple-quoted string (upstream `stringLines`). */
  doc: boolean;
  py: number;
  nat: number;
  sys: number;
  /** `py + nat + sys`, % of run. */
  total: number;
  /** `total / 100 × elapsed`; NaN when the run length is absent (`caps.elapsed` false). */
  sec: number;
  coreUtil: number | null;
  peak: number;
  avg: number;
  malloc: number;
  mallocs: number;
  pyFrac: number;
  usage: number;
  copy: number;
  /** `[t0, mb0, t1, mb1, …]`, t in seconds since start, sorted. */
  memSamples: Float64Array;
  gpu: number;
  gpuPeak: number | null;
  gpuAvg: number | null;
  await: number;
  concMean: number;
  concPeak: number;
  tasks: readonly string[];
  coro: boolean;
  /** Main-thread CPU sample times, seconds since start, sorted. */
  cpuTimes: Float64Array;
  region: [number, number];
  outer: [number, number] | null;
  fnRange: [number, number] | null;
  fn: FunctionM | null;
  leak: { likelihood: number; velocity: number } | null;
  neuron: NeuronLineM | null;
  hasMem: boolean;
  cls: "data" | "context" | "empty";
  /** Σ total over lines start+1 … end (inclusive) of a multi-line region; `total` otherwise. */
  regionTotal: number;
  /** First line of its multi-line region (the AI "region" anchor). */
  regionHead: boolean;
  /** 1-based rank among lines by time (null when `total = 0`). */
  timeRank: number | null;
}

export interface FunctionM {
  file: FileM;
  /** Qualified name (`co_qualname`). */
  name: string;
  /** First line (`co_firstlineno`: the def line or its first decorator). */
  no: number;
  range: [number, number] | null;
  py: number;
  nat: number;
  sys: number;
  total: number;
  sec: number;
  peak: number;
  avg: number;
  malloc: number;
  usage: number;
  copy: number;
  gpu: number;
  gpuPeak: number | null;
  await: number;
  coro: boolean;
  memSamples: Float64Array;
  /** Extension: the source lines attributed to this function (membership rule §4.0.7). */
  members: LineM[];
}

export interface FileM {
  /** The `files` key, verbatim. */
  name: string;
  base: string;
  dir: string;
  /** Upstream `fileIteration`: 1-based over all files sorted by share (hidden included). */
  no: number;
  hidden: boolean;
  dense: boolean;
  /** `percent_cpu_time`. */
  pct: number;
  py: number;
  nat: number;
  sys: number;
  total: number;
  peak: number;
  peakLine: LineM | null;
  gpuPeak: number;
  nrtMs: number;
  ncMs: number;
  lines: LineM[];
  byNo: Map<number, LineM>;
  functions: FunctionM[];
  imports: string[];
  /** Leak lines, by likelihood desc then velocity desc. */
  leaks: LineM[];
}

export type BadgeKind = "leak" | "loop" | "gpu" | "await" | "copy";
export interface Badge {
  kind: BadgeKind;
  text: string;
}

export interface MeterPart {
  value: number;
  token: string;
  hatch?: "system" | "waiting";
}

export interface HotspotItem {
  rank: number;
  kind: "line" | "function" | "file";
  target: Target;
  value: number;
  secondary: string;
  code: string;
  location: string;
  badge: Badge | null;
  /** TOP LINES samples (seconds): CPU sample times, or allocation times for Memory. */
  times: Float64Array;
  // Extensions used by the views:
  valueText: string;
  /** Meter segments and the value that fills the whole track. */
  meter: { parts: MeterPart[]; max: number };
  ariaLabel: string;
  line: LineM | null;
  fn: FunctionM | null;
  file: FileM;
}

export interface LaneTotals {
  /** Shares in % of timeline samples. */
  gc: number;
  io: number;
  gil: number;
  /** Σ count of all timeline events. */
  samples: number;
}

export interface Model {
  raw: unknown;
  caps: Caps;
  program: string;
  base: string;
  /** Program arguments after the program path (`args[1:]`). */
  args: string[];
  /** Extension: `entrypoint_dir` ("" when absent), for the program-details popover. */
  entrypointDir: string;
  /** Run length in seconds: recorded, derived from the last sample time, or 0 when absent. */
  elapsed: number;
  /**
   * Where `elapsed` comes from: `elapsed_time_sec` ("recorded"); the latest memory, CPU or
   * timeline sample when that field is missing, non-finite or ≤ 0 ("derived", a lower bound);
   * or nothing ("absent": `caps.elapsed` is false and every `sec` is NaN, so formatters print
   * "—" instead of a measured "0 s").
   */
  elapsedSource: "recorded" | "derived" | "absent";
  tMax: number;
  startEpoch: number | null;
  version: string;
  date: string;
  files: FileM[];
  hiddenFiles: FileM[];
  fileByName: Map<string, FileM>;
  split: { py: number; nat: number; sys: number; total: number; outside: number };
  maxLineTotal: number;
  maxLinePeak: number;
  maxLineAwait: number;
  rank: {
    lines: Record<Metric, LineM[]>;
    functions: Record<Metric, FunctionM[]>;
    files: Record<"time" | "memory", FileM[]>;
  };
  memory: {
    samples: Float64Array;
    peak: number;
    peakT: number | null;
    peakLine: LineM | null;
    pyFrac: number | null;
    /** Clamped 0–100; 0 when not recorded (check `growthRecorded`). */
    growth: number;
    growthRecorded: boolean;
    native: number;
    allocated: number;
  } | null;
  gpu: {
    name: string;
    mean: number;
    method: "main-thread" | "all-lines";
    devicePeak: number | null;
    busiest: LineM | null;
  } | null;
  neuron: { nrtMs: number; ncMs: number; idleOverall: number | null } | null;
  async: { topAwait: LineM | null; loopLine: LineM | null } | null;
  leaks: LineM[];
  headline: HeadlineModel;
  readouts: ReadoutSpec[];
  findings: Finding[];
  /** Extension: eager timeline facts (thread count, sampling interval, lane totals). */
  sampling: TimelineSummary;
  /** Extension: Σ hits of `combined_stacks` (0 without stacks). */
  stackSamples: number;
  /** Extension: deepest stack in frames, CPU and memory (reserved heights before mounting). */
  stackDepth: { cpu: number; memory: number };
  // lazy (built on first access, sliced):
  timeline(): Promise<TimelineM | null>;
  flame(kind: "cpu" | "memory"): Promise<FlameTree | null>;
  callContext(file: string, line: number): Promise<CallContext | null>;
  search(): Promise<SearchIndex>;
}

export interface BuildOptions {
  /** Scalene version from the template footer (`data-version`). */
  version?: string;
  /** Scalene build date from the template footer (`data-date`). */
  date?: string;
}

/** `load()` received text that is not JSON. */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/** The event-loop entry points of the async headline branch (§4.2.2). */
export const EVENT_LOOP_RE = /\b(asyncio\.run|run_until_complete|run_forever|uvloop\.run|anyio\.run|trio\.run)\s*\(/;

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the model. Returns null for the empty state (`""`, `{}`, no files);
 * throws `ProfileError` for JSON text that does not parse.
 */
export function buildModel(raw: unknown, opts: BuildOptions = {}): Model | null {
  const parsed = parseProfile(raw);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "error") throw new ProfileError(parsed.message);
  return assemble(parsed.raw, parsed.profile, parsed.caps, opts);
}

/** Latest sample time of any kind (memory footprint, CPU samples, timeline events). */
function lastSampleTime(np: NormProfile): number {
  let t = np.samples.length ? np.samples[np.samples.length - 2] : 0;
  for (const f of np.files) {
    for (const r of f.rows) {
      const c = r.cpuTimes;
      if (c.length && c[c.length - 1] > t) t = c[c.length - 1];
    }
  }
  const tl = np.timeline;
  for (let i = 0; i < tl.n; i++) if (tl.t[i] > t) t = tl.t[i];
  return Number.isFinite(t) ? t : 0;
}

function assemble(raw: unknown, np: NormProfile, caps: Caps, opts: BuildOptions): Model {
  const derived = np.elapsedRecorded ? 0 : lastSampleTime(np);
  const elapsedSource: Model["elapsedSource"] = np.elapsedRecorded ? "recorded" : derived > 0 ? "derived" : "absent";
  const elapsed = np.elapsedRecorded ? np.elapsed : derived > 0 ? derived : 0;
  caps = { ...caps, elapsed: elapsedSource !== "absent" };
  const totalMalloc = np.files.reduce((a, f) => a + f.rows.reduce((b, r) => b + r.malloc, 0), 0);

  const allFiles = np.files.map((nf) => buildFile(nf, elapsed, caps));
  allFiles.sort((a, b) => b.pct - a.pct || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  allFiles.forEach((f, i) => {
    f.no = i + 1;
    f.hidden = f.pct < 1.0 && f.peak < 0.01 * totalMalloc;
  });
  const files = allFiles.filter((f) => !f.hidden);
  const hiddenFiles = allFiles.filter((f) => f.hidden);
  const fileByName = new Map(allFiles.map((f) => [f.name, f] as const));

  const allLines: LineM[] = [];
  const allFunctions: FunctionM[] = [];
  for (const f of allFiles) {
    for (const l of f.lines) allLines.push(l);
    for (const fn of f.functions) allFunctions.push(fn);
  }

  const split = programSplit(allFiles);
  const rank = buildRankings(allLines, allFunctions, allFiles);
  rank.lines.time.forEach((l, i) => (l.timeRank = i + 1));

  const stackBits = classifyStacks(np.stacks);
  const sampling = summarizeTimeline(np, stackBits);
  const lastSample = np.samples.length ? np.samples[np.samples.length - 2] : 0;
  const tMax = Math.max(elapsed, lastSample, sampling.tEnd);

  const leaks = allFiles.flatMap((f) => f.leaks).sort(byLeak);
  const lookup = (file: string | null, line: number | null): LineM | null =>
    file === null || line === null ? null : fileByName.get(file)?.byNo.get(line) ?? null;

  const model: Model = {
    raw,
    caps,
    program: np.program,
    base: np.program ? basename(np.program) : "",
    args: np.args,
    entrypointDir: np.entrypointDir,
    elapsed,
    elapsedSource,
    tMax,
    startEpoch: np.startEpoch,
    version: opts.version ?? "",
    date: opts.date ?? "",
    files,
    hiddenFiles,
    fileByName,
    split,
    maxLineTotal: rank.lines.time[0]?.total ?? 0,
    maxLinePeak: rank.lines.memory[0]?.peak ?? 0,
    maxLineAwait: rank.lines.await[0]?.await ?? 0,
    rank,
    memory: caps.memory ? memorySummary(np, totalMalloc, lookup(np.maxFootprintFile, np.maxFootprintLine)) : null,
    gpu: caps.gpu ? gpuSummary(np, caps, allLines, rank.lines.gpu) : null,
    neuron: caps.neuron ? neuronSummary(np, allLines) : null,
    async: caps.async ? asyncSummary(rank.lines) : null,
    leaks,
    headline: { segments: [], plain: "" },
    readouts: [],
    findings: [],
    sampling,
    stackSamples: np.stacks.reduce((a, s) => a + s[1], 0),
    stackDepth: {
      cpu: np.stacks.reduce((a, s) => Math.max(a, s[0].length), 0),
      memory: np.memoryStacks.reduce((a, s) => Math.max(a, s[0].length), 0),
    },
    timeline: () => timeline.get(),
    flame: (kind) => (kind === "cpu" ? cpuFlame.get() : memFlame.get()),
    callContext: async (file, line) => {
      const index = await ccIndex.get();
      return index ? callContextFor(index, np.stacks, file, line) : null;
    },
    search: () => search.get(),
  };

  // Lazy derivations (§6.1.2), declared after `model` because the search index
  // reads it; the accessors above only run once `assemble` has returned.
  const timeline = new Lazy(() => buildTimeline(np, stackBits, sampling, { fileByName, tMax }));
  const cpuFlame = new Lazy(() => buildFlameTree(caps.stacks ? np.stacks : [], "cpu"));
  const memFlame = new Lazy(() => buildFlameTree(caps.memStacks ? np.memoryStacks : [], "memory"));
  const ccIndex = new Lazy(() => buildCallContextIndex(caps.stacks ? np.stacks : []));
  const search = new Lazy(() => buildSearchIndex(model));

  model.headline = buildHeadline(model);
  model.readouts = buildReadouts(model);
  model.findings = buildFindings(model);
  return model;
}

// ── Files, lines, functions ─────────────────────────────────────────────────

function buildFile(nf: NormFile, elapsed: number, caps: Caps): FileM {
  const file: FileM = {
    name: nf.name,
    base: basename(nf.name),
    dir: dirname(nf.name),
    no: 0,
    hidden: false,
    dense: nf.dense,
    pct: nf.pct,
    py: 0,
    nat: 0,
    sys: 0,
    total: 0,
    peak: 0,
    peakLine: null,
    gpuPeak: 0,
    nrtMs: 0,
    ncMs: 0,
    lines: [],
    byNo: new Map(),
    functions: [],
    imports: nf.imports,
    leaks: [],
  };
  const docs = stringLines(nf.rows.map((r) => r.text));
  nf.rows.forEach((r, i) => {
    const line = buildLine(file, r, docs[i], elapsed, nf);
    file.lines.push(line);
    file.byNo.set(line.no, line);
    file.py += line.py;
    file.nat += line.nat;
    file.sys += line.sys;
    if (line.peak > file.peak) {
      file.peak = line.peak;
      file.peakLine = line;
    }
    if (line.gpuPeak !== null && line.gpuPeak > file.gpuPeak) file.gpuPeak = line.gpuPeak;
    if (line.neuron) {
      file.nrtMs += line.neuron.nrtMs;
      file.ncMs += line.neuron.ncMs;
    }
    if (line.leak) file.leaks.push(line);
  });
  file.total = file.py + file.nat + file.sys;
  file.leaks.sort(byLeak);
  file.functions = nf.functions.map((r) => buildFunction(file, r, elapsed));
  assignMembership(file, caps);
  classifyRows(file, caps);
  return file;
}

function buildLine(file: FileM, r: NormRow, doc: boolean, elapsed: number, nf: NormFile): LineM {
  const total = r.py + r.c + r.sys;
  const leak = nf.leaks?.get(r.lineno) ?? null;
  const n = r.neuron;
  return {
    file,
    no: r.lineno,
    text: r.text,
    doc,
    py: r.py,
    nat: r.c,
    sys: r.sys,
    total,
    sec: elapsed > 0 ? (total / 100) * elapsed : NaN,
    coreUtil: r.coreUtil,
    peak: r.peak,
    avg: r.avg,
    malloc: r.malloc,
    mallocs: r.mallocs,
    pyFrac: r.pyFrac,
    usage: r.usage,
    copy: r.copy,
    memSamples: r.memSamples,
    gpu: r.gpu,
    gpuPeak: r.gpuPeak,
    gpuAvg: r.gpuAvg,
    await: r.await,
    concMean: r.concMean,
    concPeak: r.concPeak,
    tasks: r.tasks,
    coro: r.coro,
    cpuTimes: r.cpuTimes,
    region: r.region,
    outer: r.outer,
    fnRange: r.fnRange,
    fn: null,
    leak: leak ? { likelihood: leak.likelihood, velocity: leak.velocity } : null,
    neuron: n
      ? {
          nrtMs: n.nrtMs,
          nrtPct: n.nrtPct,
          ncMs: n.ncMs,
          idlePct: n.overlapPct === null ? null : 100 - n.overlapPct,
          nrtCount: n.nrtCount,
          ncCount: n.ncCount,
          kernel: n.kernel,
        }
      : null,
    hasMem: false,
    cls: "empty",
    regionTotal: total,
    regionHead: false,
    timeRank: null,
  };
}

function buildFunction(file: FileM, r: NormRow, elapsed: number): FunctionM {
  const total = r.py + r.c + r.sys;
  return {
    file,
    name: r.text,
    no: r.lineno,
    range: null,
    py: r.py,
    nat: r.c,
    sys: r.sys,
    total,
    sec: elapsed > 0 ? (total / 100) * elapsed : NaN,
    peak: r.peak,
    avg: r.avg,
    malloc: r.malloc,
    usage: r.usage,
    copy: r.copy,
    gpu: r.gpu,
    gpuPeak: r.gpuPeak,
    await: r.await,
    coro: r.coro,
    memSamples: r.memSamples,
    members: [],
  };
}

const DEF_RE = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;

function qualnameMatches(qualname: string, name: string): boolean {
  return qualname === name || qualname.endsWith("." + name);
}

/**
 * The `functions[]` entry for a def/class at `defLine` named `name`: the one
 * with `lineno ∈ [defLine − 20, defLine]` whose qualname ends with the name
 * (closest first), else the nearest entry with `lineno ≤ defLine`.
 */
function functionForDef(fns: FunctionM[], defLine: number, name: string | null, nearestFallback: boolean): FunctionM | null {
  let byName: FunctionM | null = null;
  let nearest: FunctionM | null = null;
  for (const fn of fns) {
    if (fn.no > defLine) break;
    nearest = fn;
    if (name !== null && fn.no >= defLine - 20 && qualnameMatches(fn.name, name)) byName = fn;
  }
  return byName ?? (nearestFallback ? nearest : null);
}

/** Function membership (§4.0.7): bounds when recorded, indentation for dense old files, else none. */
function assignMembership(file: FileM, caps: Caps): void {
  const fns = file.functions;
  if (fns.length === 0) return;
  const byDef = new Map<number, FunctionM | null>();
  const resolve = (defLine: number, nearestFallback: boolean): FunctionM | null => {
    let fn = byDef.get(defLine);
    if (fn === undefined) {
      const m = DEF_RE.exec(file.byNo.get(defLine)?.text ?? "");
      fn = functionForDef(fns, defLine, m ? m[1] : null, nearestFallback);
      byDef.set(defLine, fn);
    }
    return fn;
  };
  if (caps.functionBounds) {
    for (const line of file.lines) {
      if (!line.fnRange) continue;
      line.fn = resolve(line.fnRange[0], true);
      if (line.fn && !line.fn.range) line.fn.range = [line.fnRange[0], line.fnRange[1]];
    }
  } else if (file.dense) {
    assignByIndentation(file, (defLine) => resolve(defLine, false));
  }
  for (const line of file.lines) if (line.fn) line.fn.members.push(line);
  for (const fn of fns) {
    if (!fn.range && fn.members.length > 0) {
      fn.range = [Math.min(fn.no, fn.members[0].no), fn.members[fn.members.length - 1].no];
    }
  }
}

/** Without bounds: the innermost enclosing def/class by indentation (a def line belongs to itself). */
function assignByIndentation(file: FileM, resolve: (defLine: number) => FunctionM | null): void {
  const open: { indent: number; line: number }[] = [];
  for (const line of file.lines) {
    const text = line.text;
    const trimmed = text.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) {
      const top = open[open.length - 1];
      if (top) line.fn = resolve(top.line);
      continue;
    }
    const indent = text.length - trimmed.length;
    while (open.length > 0 && open[open.length - 1].indent >= indent) open.pop();
    if (DEF_RE.test(text)) {
      open.push({ indent, line: line.no });
      line.fn = resolve(line.no);
      continue;
    }
    const top = open[open.length - 1];
    if (top) line.fn = resolve(top.line);
  }
}

// ── Program-wide summaries ──────────────────────────────────────────────────

function programSplit(files: FileM[]): Model["split"] {
  let py = 0;
  let nat = 0;
  let sys = 0;
  for (const f of files) {
    py += f.py;
    nat += f.nat;
    sys += f.sys;
  }
  const total = py + nat + sys;
  return { py, nat, sys, total, outside: Math.max(0, 100 - total) };
}

type Ranked = { file: FileM; no: number };
function tieBreak(a: Ranked, b: Ranked): number {
  return a.file.no - b.file.no || a.no - b.no;
}

function ranked<T extends Ranked>(items: T[], keep: (x: T) => boolean, key: (x: T) => number, key2?: (x: T) => number): T[] {
  return items
    .filter(keep)
    .sort((a, b) => key(b) - key(a) || (key2 ? key2(b) - key2(a) : 0) || tieBreak(a, b));
}

function buildRankings(lines: LineM[], fns: FunctionM[], files: FileM[]): Model["rank"] {
  return {
    lines: {
      time: ranked(lines, (l) => l.total > 0, (l) => l.total),
      memory: ranked(lines, (l) => l.peak > 0, (l) => l.peak, (l) => l.malloc),
      gpu: ranked(lines, (l) => l.total >= 1 && l.gpu > 0, (l) => l.gpu),
      await: ranked(lines, (l) => l.await > 0, (l) => l.await),
    },
    functions: {
      time: ranked(fns, (f) => f.total > 0, (f) => f.total),
      memory: ranked(fns, (f) => f.peak > 0, (f) => f.peak, (f) => f.malloc),
      gpu: ranked(fns, (f) => f.total >= 1 && f.gpu > 0, (f) => f.gpu),
      await: ranked(fns, (f) => f.await > 0, (f) => f.await),
    },
    files: {
      time: files.filter((f) => f.pct > 0 || f.total > 0).sort((a, b) => b.pct - a.pct || a.no - b.no),
      memory: files.filter((f) => f.peak > 0).sort((a, b) => b.peak - a.peak || a.no - b.no),
    },
  };
}

function byLeak(a: LineM, b: LineM): number {
  const la = a.leak;
  const lb = b.leak;
  if (!la || !lb) return 0;
  return lb.likelihood - la.likelihood || lb.velocity - la.velocity;
}

function memorySummary(np: NormProfile, allocated: number, peakLine: LineM | null): NonNullable<Model["memory"]> {
  const pk = peakInfo(np.samples);
  return {
    samples: np.samples,
    peak: np.maxFootprint,
    peakT: pk ? pk.t : null,
    peakLine,
    pyFrac: np.maxFootprintPyFrac,
    growth: Math.min(100, Math.max(0, np.growthRate)),
    growthRecorded: np.growthRecorded,
    native: np.nativeAllocations,
    allocated,
  };
}

/**
 * GPU readout (§4.0.7): time-weighted mean over main-thread lines (lines
 * with CPU samples), because GPU load is sampled on the main thread and
 * worker lines record 0. Without `cpu_samples_list`: all lines with time.
 */
function gpuSummary(np: NormProfile, caps: Caps, lines: LineM[], byGpu: LineM[]): NonNullable<Model["gpu"]> {
  const method = caps.cpuSamples ? "main-thread" : "all-lines";
  let weighted = 0;
  let weight = 0;
  let devicePeak: number | null = null;
  for (const l of lines) {
    if (l.gpuPeak !== null && (devicePeak === null || l.gpuPeak > devicePeak)) devicePeak = l.gpuPeak;
    if (!(l.total > 0)) continue;
    if (method === "main-thread" && l.cpuTimes.length === 0) continue;
    weighted += l.gpu * l.total;
    weight += l.total;
  }
  return {
    name: np.gpuDevice || "GPU",
    mean: weight > 0 ? weighted / weight : 0,
    method,
    devicePeak: caps.gpuMemory ? devicePeak : null,
    busiest: byGpu[0] ?? null,
  };
}

function neuronSummary(np: NormProfile, lines: LineM[]): NonNullable<Model["neuron"]> {
  let nrt = 0;
  let nc = 0;
  for (const l of lines) {
    if (!l.neuron) continue;
    nrt += l.neuron.nrtMs;
    nc += l.neuron.ncMs;
  }
  return {
    nrtMs: nrt > 0 ? nrt : np.neuronTotalMs ?? 0,
    ncMs: nc > 0 ? nc : np.neuronNcTotalMs ?? 0,
    idleOverall: np.overlapOverall === null ? null : 100 - np.overlapOverall,
  };
}

function asyncSummary(rank: Model["rank"]["lines"]): NonNullable<Model["async"]> {
  const top = rank.time[0] ?? null;
  return {
    topAwait: rank.await[0] ?? null,
    loopLine: top && EVENT_LOOP_RE.test(top.text) ? top : null,
  };
}

// ── Small shared helpers for model consumers ────────────────────────────────

/** The line at `file:line`, or null. */
export function lineAt(model: Model, file: string, line: number): LineM | null {
  return model.fileByName.get(file)?.byNo.get(line) ?? null;
}

/** The function `qualname` in `file`, or null. */
export function functionAt(model: Model, file: string, qualname: string): FunctionM | null {
  return model.fileByName.get(file)?.functions.find((f) => f.name === qualname) ?? null;
}

export function lineTarget(l: LineM): Target {
  return { file: l.file.name, line: l.no };
}

export function functionTarget(f: FunctionM): Target {
  return { file: f.file.name, fn: f.name };
}
