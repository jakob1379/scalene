/**
 * Timeline derivations (DESIGN.md §4.0.7, §4.4.3–4.4.4, §4.12).
 *
 * `summarizeTimeline` is eager and cheap (one pass): threads, sampling
 * interval, run end of the whole timeline and the GC / I/O & waits / GIL lane
 * totals, which the headline, findings and every view share.
 * `buildTimeline` is the lazy part: typed run arrays with per-thread run
 * ends (fixing upstream's cross-thread truncation), phases, buckets for the
 * scope, suspended-task counts and merged frame segments per lane.
 */

import { CLS_GC, CLS_GIL, CLS_IO, isAwaitFrame } from "./classify";
import { runNow, runSliced } from "./lazy";
import type { LaneTotals, LineM, Model } from "./model";
import { eventThread, type NormProfile, type NormTimeline } from "./normalize";
import type { CombinedFrame, CombinedStackEntry, PyFrame } from "../types";

export const DEFAULT_DT = 0.01;
const DT_MIN = 0.0005;
const DT_MAX = 0.2;
const DT_GAPS = 4000;
/** Phases closer than this share of the time domain merge (§4.4.3). */
const PHASE_MERGE_GAP = 0.004;
/** Segment merge tolerance in sampling intervals (see `buildSegments`). */
const SEGMENT_TOUCH = 0.5;

export interface ThreadInfo {
  /** Lane index (lane order: main, unknown, then first appearance). */
  idx: number;
  id: number | null;
  /** "main", "unknown" or "thread N". */
  label: string;
  main: boolean;
  /** Σ count of this thread's events. */
  samples: number;
  /** % of all timeline samples. */
  share: number;
  events: number;
  /** GIL-classified samples (for "the busiest waiting thread"). */
  gilSamples: number;
}

export interface TimelineSummary {
  threads: ThreadInfo[];
  /** Sampling interval in seconds (median same-thread gap per sample, clamped). */
  dt: number;
  /** End of the last run of any thread. */
  tEnd: number;
  runs: number;
  laneTotals: LaneTotals | null;
}

/** Median of `(t_next − t) / count` over consecutive same-thread events (first 4,000 gaps). */
export function samplingInterval(ev: NormTimeline): number {
  const last = new Map<number | null, number>(); // thread → previous event index
  const gaps: number[] = [];
  for (let i = 0; i < ev.n; i++) {
    const k = eventThread(ev, i);
    const prev = last.get(k);
    if (prev !== undefined) {
      const g = (ev.t[i] - ev.t[prev]) / ev.count[prev];
      if (g > 0) gaps.push(g);
      if (gaps.length >= DT_GAPS) break;
    }
    last.set(k, i);
  }
  if (gaps.length === 0) return DEFAULT_DT;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.min(DT_MAX, Math.max(DT_MIN, median));
}

export function summarizeTimeline(np: NormProfile, stackBits: Uint8Array): TimelineSummary {
  const ev = np.timeline;
  if (np.stacks.length === 0 || ev.n === 0) {
    return { threads: [], dt: DEFAULT_DT, tEnd: 0, runs: 0, laneTotals: null };
  }
  const dt = samplingInterval(ev);
  const main = np.mainThreadId;
  const byId = new Map<number | null, ThreadInfo & { order: number; lastEnd: number }>();
  let gc = 0;
  let io = 0;
  let gil = 0;
  let all = 0;
  for (let i = 0; i < ev.n; i++) {
    const id = eventThread(ev, i);
    const c = ev.count[i];
    let t = byId.get(id);
    if (!t) {
      const isMain = id !== null && id === main;
      t = { idx: 0, id, label: "", main: isMain, samples: 0, share: 0, events: 0, gilSamples: 0, order: byId.size, lastEnd: 0 };
      byId.set(id, t);
    }
    t.samples += c;
    t.events++;
    t.lastEnd = ev.t[i] + c * dt;
    const bits = stackBits[ev.stack[i]];
    all += c;
    if (bits & CLS_GC) gc += c;
    if (bits & CLS_IO) io += c;
    if (bits & CLS_GIL) {
      gil += c;
      t.gilSamples += c;
    }
  }
  const rank = (t: { main: boolean; id: number | null }): number => (t.main ? 0 : t.id === null ? 1 : 2);
  const ordered = Array.from(byId.values()).sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  let worker = 0;
  let tEnd = 0;
  const threads: ThreadInfo[] = ordered.map((t, idx) => {
    tEnd = Math.max(tEnd, t.lastEnd);
    const label = t.main ? "main" : t.id === null ? "unknown" : `thread ${++worker}`;
    return {
      idx,
      id: t.id,
      label,
      main: t.main,
      samples: t.samples,
      share: all > 0 ? (100 * t.samples) / all : 0,
      events: t.events,
      gilSamples: t.gilSamples,
    };
  });
  const pct = (n: number): number => (all > 0 ? (100 * n) / all : 0);
  return {
    threads,
    dt,
    tEnd,
    runs: ev.n,
    laneTotals: { gc: pct(gc), io: pct(io), gil: pct(gil), samples: all },
  };
}

// ── Lazy timeline ───────────────────────────────────────────────────────────

export interface Phase {
  /** `file:line` of the loop header or frame line. */
  key: string;
  label: string;
  file: string;
  line: number;
  /** The loop header line when the phase is a loop. */
  loop: boolean;
  t0: number;
  t1: number;
  samples: number;
  /** % of main-thread samples. */
  share: number;
}

export interface ThreadBuckets {
  nb: number;
  ta: number;
  tb: number;
  /** Mean number of threads sampled busy (GC counts as busy). */
  busy: Float32Array;
  gil: Float32Array;
  /** I/O & waits (includes `[await]`). */
  wait: Float32Array;
  /** Busy split by leaf frame kind (Python / native). */
  py: Float32Array;
  native: Float32Array;
}

export interface SegmentRow {
  n: number;
  t0: Float64Array;
  t1: Float64Array;
  /** Stack index of the first merged run (its frame at this depth is the segment's frame). */
  stack: Int32Array;
  samples: Float64Array;
}

export interface LaneSegments {
  thread: number;
  /** `rows[d]` = segments at depth d (0 = root frame), sorted by t0. */
  rows: SegmentRow[];
}

export interface TimelineM {
  n: number;
  /** Run start/end (s), stack index, lane index and sample count per run, in event order. */
  t0: Float64Array;
  t1: Float64Array;
  stack: Int32Array;
  thread: Int16Array;
  count: Int32Array;
  dt: number;
  tEnd: number;
  threads: ThreadInfo[];
  /** Lane index of the main thread (−1 when unknown). */
  mainIdx: number;
  laneTotals: LaneTotals;
  /** Per stack: `CLS_GC | CLS_IO | CLS_GIL`. */
  stackBits: Uint8Array;
  /** Per stack: 1 when the leaf is a synthetic `[await]` frame. */
  awaitLeaf: Uint8Array;
  /** Per stack: 1 when the leaf is native. */
  nativeLeaf: Uint8Array;
  /** Per lane: run indices sorted by t0. */
  byThread: Int32Array[];
  /** Per lane: deepest stack. */
  maxDepth: Int32Array;
  phases: Phase[];
  /** Σ count of the runs phases are built from. */
  phaseSamples: number;
  bucketize(nb: number, ta: number, tb: number, thread?: number): ThreadBuckets;
  /** Mean suspended tasks per bucket (async scope TASKS channel). */
  tasks(nb: number, ta: number, tb: number): Float32Array;
  /** Peak of `tasks` instants (max `[await]` leaves at one sample instant). */
  maxTasks: number;
  /** Run index of lane `thread` covering time `t` (within one interval), else −1. */
  runAt(thread: number, t: number): number;
  /** Deepest Python frame of the run covering `t` in a lane (scope click, readout card), or null. */
  pyLeafAt(thread: number, t: number): { run: number; frame: PyFrame; depth: number } | null;
  /** Merged frame segments for one lane (cached; built synchronously on first access). */
  segments(thread: number): LaneSegments;
  /** The same segments built in ≤ 8 ms slices (§6.1.2); shares the cache with `segments`. */
  segmentsSliced(thread: number): Promise<LaneSegments>;
  /** Frame of `stack` at `depth`, or null. */
  frameAt(stack: number, depth: number): CombinedFrame | null;
}

interface FrameLookup {
  line(file: string, no: number): LineM | null;
}

export function* buildTimeline(
  np: NormProfile,
  stackBits: Uint8Array,
  summary: TimelineSummary,
  model: Pick<Model, "fileByName" | "tMax">,
): Generator<unknown, TimelineM | null, void> {
  const ev = np.timeline;
  const laneTotals = summary.laneTotals;
  if (np.stacks.length === 0 || ev.n === 0 || !laneTotals) return null;
  const n = ev.n;
  const dt = summary.dt;
  const laneOf = new Map<number | null, number>(summary.threads.map((t) => [t.id, t.idx]));
  const t0 = ev.t;
  const t1 = new Float64Array(n);
  const stack = ev.stack;
  const thread = new Int16Array(n);
  const count = ev.count;
  // Walk backwards keeping, per lane, the start of the current timestamp
  // group and of the next later one (events of one lane may share a t).
  const cur = new Float64Array(summary.threads.length).fill(Infinity);
  const after = new Float64Array(summary.threads.length).fill(Infinity);
  for (let i = n - 1; i >= 0; i--) {
    const lane = laneOf.get(eventThread(ev, i)) ?? 0;
    const t = t0[i];
    thread[i] = lane;
    if (t < cur[lane]) {
      after[lane] = cur[lane];
      cur[lane] = t;
    }
    const nominal = t + count[i] * dt;
    const next = after[lane];
    t1[i] = next > t && next < nominal ? next : nominal;
    if ((i & 4095) === 0) yield;
  }
  const lanes = summary.threads.length;
  const byThread = splitByThread(thread, lanes, t0);
  yield;
  const stacks = np.stacks;
  const awaitLeaf = new Uint8Array(stacks.length);
  const nativeLeaf = new Uint8Array(stacks.length);
  stacks.forEach(([frames], s) => {
    const leaf = frames[frames.length - 1];
    if (leaf && isAwaitFrame(leaf)) awaitLeaf[s] = 1;
    if (leaf && leaf.kind === "native") nativeLeaf[s] = 1;
  });
  const maxDepth = new Int32Array(lanes);
  for (let i = 0; i < n; i++) {
    const d = stacks[stack[i]][0].length;
    if (d > maxDepth[thread[i]]) maxDepth[thread[i]] = d;
  }
  yield;
  const mainIdx = summary.threads.findIndex((t) => t.main);
  const lookup: FrameLookup = { line: (file, no) => model.fileByName.get(file)?.byNo.get(no) ?? null };
  // Main-thread runs; legacy timelines without thread ids use every run.
  const phaseRuns = summary.threads.every((t) => t.id === null) ? null : byThread[Math.max(0, mainIdx)];
  const { phases, samples: phaseSamples } = yield* buildPhases(
    { t0, t1, stack, count, awaitLeaf },
    stacks,
    phaseRuns,
    lookup,
    Math.max(model.tMax, summary.tEnd),
  );
  yield;
  const instants = yield* buildInstants(t0, awaitLeaf, stack, n);
  const segCache = new Map<number, LaneSegments>();
  const segPending = new Map<number, Promise<LaneSegments>>();
  const frameIds = new FrameIds(stacks);

  const tl: TimelineM = {
    n,
    t0,
    t1,
    stack,
    thread,
    count,
    dt,
    tEnd: summary.tEnd,
    threads: summary.threads,
    mainIdx,
    laneTotals,
    stackBits,
    awaitLeaf,
    nativeLeaf,
    byThread,
    maxDepth,
    phases,
    phaseSamples,
    maxTasks: instants.max,
    bucketize: (nb, ta, tb, lane) => bucketizeRuns(tl, nb, ta, tb, lane),
    tasks: (nb, ta, tb) => bucketInstants(instants, nb, ta, tb),
    runAt: (lane, t) => runAt(tl, lane, t),
    pyLeafAt: (lane, t) => {
      const run = runAt(tl, lane, t);
      if (run < 0) return null;
      const frames = stacks[tl.stack[run]][0];
      for (let d = frames.length - 1; d >= 0; d--) {
        const f = frames[d];
        if (f.kind === "py" && !isAwaitFrame(f)) return { run, frame: f, depth: d };
      }
      return null;
    },
    segments: (lane) => {
      let s = segCache.get(lane);
      if (!s) {
        s = runNow(buildSegments(tl, lane, frameIds, stacks));
        segCache.set(lane, s);
      }
      return s;
    },
    segmentsSliced: (lane) => {
      const done = segCache.get(lane);
      if (done) return Promise.resolve(done);
      let p = segPending.get(lane);
      if (!p) {
        p = runSliced(buildSegments(tl, lane, frameIds, stacks)).then((s) => {
          segPending.delete(lane);
          // A synchronous `segments()` call may have won the race: keep one object per lane.
          const won = segCache.get(lane);
          if (won) return won;
          segCache.set(lane, s);
          return s;
        });
        segPending.set(lane, p);
      }
      return p;
    },
    frameAt: (s, d) => stacks[s]?.[0][d] ?? null,
  };
  return tl;
}

function splitByThread(thread: Int16Array, lanes: number, t0: Float64Array): Int32Array[] {
  const counts = new Int32Array(lanes);
  for (let i = 0; i < thread.length; i++) counts[thread[i]]++;
  const out = Array.from(counts, (c) => new Int32Array(c));
  const fill = new Int32Array(lanes);
  for (let i = 0; i < thread.length; i++) out[thread[i]][fill[thread[i]]++] = i;
  // Events are chronological, but guard against merged multi-process input.
  for (const idx of out) {
    let sorted = true;
    for (let k = 1; k < idx.length; k++) if (t0[idx[k]] < t0[idx[k - 1]]) sorted = false;
    if (!sorted) idx.sort((a, b) => t0[a] - t0[b] || a - b);
  }
  return out;
}

// ── Phases (§4.4.3) ─────────────────────────────────────────────────────────

interface RunArrays {
  t0: Float64Array;
  t1: Float64Array;
  stack: Int32Array;
  count: Int32Array;
  awaitLeaf: Uint8Array;
}

const LOOP_HEADER_RE = /^(?:for|while|async\s+for)\b/;

interface PhaseKey {
  key: string;
  label: string;
  file: string;
  line: number;
  loop: boolean;
}

function phaseKeyOf(frames: readonly CombinedFrame[], lookup: FrameLookup): PhaseKey | null {
  const py = frames.filter((f) => f.kind === "py");
  if (py.length === 0) return null;
  for (let d = 0; d < Math.min(2, py.length); d++) {
    const f = py[d];
    const line = f.line === null ? null : lookup.line(f.filename_or_module, f.line);
    const outer = line?.outer;
    if (!line || !outer || !(outer[0] < outer[1])) continue;
    const header = line.file.byNo.get(outer[0]);
    const text = header ? header.text.trim() : "";
    if (LOOP_HEADER_RE.test(text)) {
      return { key: `${line.file.name}:${outer[0]}`, label: text.replace(/\s*:\s*$/, ""), file: line.file.name, line: outer[0], loop: true };
    }
  }
  const f = py[Math.min(1, py.length - 1)];
  const no = f.line ?? 0;
  const line = lookup.line(f.filename_or_module, no);
  const label = line && line.text.trim() ? line.text.trim() : `${f.display_name}()`;
  return { key: `${f.filename_or_module}:${no}`, label, file: f.filename_or_module, line: no, loop: false };
}

/** `order` = run indices to use in time order (null: every run). */
function* buildPhases(
  runs: RunArrays,
  stacks: readonly CombinedStackEntry[],
  order: Int32Array | null,
  lookup: FrameLookup,
  tMax: number,
): Generator<unknown, { phases: Phase[]; samples: number }, void> {
  const total = order ? order.length : runs.t0.length;
  const keyCache = new Map<number, PhaseKey | null>();
  const maxGap = tMax * PHASE_MERGE_GAP;
  const out: Phase[] = [];
  let samples = 0;
  for (let k = 0; k < total; k++) {
    if ((k & 4095) === 4095) yield;
    const i = order ? order[k] : k;
    const s = runs.stack[i];
    if (runs.awaitLeaf[s]) continue; // suspended tasks are not what the program is doing
    let pk = keyCache.get(s);
    if (pk === undefined) {
      pk = phaseKeyOf(stacks[s][0], lookup);
      keyCache.set(s, pk);
    }
    samples += runs.count[i];
    if (!pk) continue;
    const last = out[out.length - 1];
    if (last && last.key === pk.key && runs.t0[i] - last.t1 < maxGap) {
      last.t1 = Math.max(last.t1, runs.t1[i]);
      last.samples += runs.count[i];
    } else {
      out.push({ ...pk, t0: runs.t0[i], t1: runs.t1[i], samples: runs.count[i], share: 0 });
    }
  }
  for (const p of out) p.share = samples > 0 ? (100 * p.samples) / samples : 0;
  return { phases: out, samples };
}

// ── Buckets (§4.4.4) ────────────────────────────────────────────────────────

function bucketizeRuns(tl: TimelineM, nb: number, ta: number, tb: number, lane?: number): ThreadBuckets {
  const out: ThreadBuckets = {
    nb,
    ta,
    tb,
    busy: new Float32Array(nb),
    gil: new Float32Array(nb),
    wait: new Float32Array(nb),
    py: new Float32Array(nb),
    native: new Float32Array(nb),
  };
  const span = tb - ta;
  if (!(nb > 0) || !(span > 0)) return out;
  const bw = span / nb;
  const visit = (i: number): void => {
    const a = Math.max(tl.t0[i], ta);
    const b = Math.min(tl.t1[i], tb);
    if (!(b > a)) return;
    const s = tl.stack[i];
    const bits = tl.stackBits[s];
    const target = bits & CLS_GIL ? out.gil : bits & CLS_IO ? out.wait : out.busy;
    const leaf = bits & (CLS_GIL | CLS_IO) ? null : tl.nativeLeaf[s] ? out.native : out.py;
    const k0 = Math.max(0, Math.floor((a - ta) / bw));
    const k1 = Math.min(nb - 1, Math.floor((b - ta) / bw));
    for (let k = k0; k <= k1; k++) {
      const lo = ta + k * bw;
      const ov = Math.min(b, lo + bw) - Math.max(a, lo);
      if (ov <= 0) continue;
      const v = ov / bw;
      target[k] += v;
      if (leaf) leaf[k] += v;
    }
  };
  if (lane === undefined) for (let i = 0; i < tl.n; i++) visit(i);
  else for (const i of tl.byThread[lane] ?? []) visit(i);
  return out;
}

interface Instants {
  t: Float64Array;
  awaits: Float32Array;
  max: number;
}

/** Distinct sample instants with the number of `[await]`-leaf events at each. */
function* buildInstants(t0: Float64Array, awaitLeaf: Uint8Array, stack: Int32Array, n: number): Generator<unknown, Instants, void> {
  const ts: number[] = [];
  const aw: number[] = [];
  let max = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 8191) === 8191) yield;
    const last = ts.length - 1;
    const a = awaitLeaf[stack[i]];
    if (last >= 0 && ts[last] === t0[i]) aw[last] += a;
    else {
      ts.push(t0[i]);
      aw.push(a);
    }
  }
  for (const a of aw) if (a > max) max = a;
  return { t: Float64Array.from(ts), awaits: Float32Array.from(aw), max };
}

function bucketInstants(ins: Instants, nb: number, ta: number, tb: number): Float32Array {
  const sum = new Float32Array(nb);
  const cnt = new Float32Array(nb);
  const span = tb - ta;
  if (!(nb > 0) || !(span > 0)) return sum;
  for (let i = 0; i < ins.t.length; i++) {
    const t = ins.t[i];
    if (t < ta || t >= tb) continue;
    const k = Math.min(nb - 1, Math.floor(((t - ta) / span) * nb));
    sum[k] += ins.awaits[i];
    cnt[k]++;
  }
  for (let k = 0; k < nb; k++) sum[k] = cnt[k] > 0 ? sum[k] / cnt[k] : 0;
  return sum;
}

function runAt(tl: TimelineM, lane: number, t: number): number {
  const idx = tl.byThread[lane];
  if (!idx || idx.length === 0) return -1;
  let lo = 0;
  let hi = idx.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl.t0[idx[mid]] <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return -1;
  const i = idx[best];
  return t <= tl.t1[i] + tl.dt ? i : -1;
}

// ── Segments (§4.12.2) ──────────────────────────────────────────────────────

/** Interned upstream `frameKey` per (stack, depth), so merging compares ints. */
class FrameIds {
  private readonly ids = new Map<string, number>();
  private readonly perStack: (Int32Array | undefined)[];
  constructor(private readonly stacks: readonly CombinedStackEntry[]) {
    this.perStack = new Array(stacks.length);
  }
  of(s: number): Int32Array {
    let a = this.perStack[s];
    if (!a) {
      const frames = this.stacks[s][0];
      a = new Int32Array(frames.length);
      frames.forEach((f, d) => {
        const key = f.kind === "py" ? `py:${f.filename_or_module}:${f.line}` : `native:${f.filename_or_module}:${f.display_name}`;
        let id = this.ids.get(key);
        if (id === undefined) {
          id = this.ids.size;
          this.ids.set(key, id);
        }
        (a as Int32Array)[d] = id;
      });
      this.perStack[s] = a;
    }
    return a;
  }
}

/**
 * Merge consecutive runs of one lane with the same frame per depth (upstream
 * rule). Runs "touch" when the gap is at most half a sampling interval:
 * timer jitter leaves gaps < 0.1 × dt between back-to-back runs, while a
 * thread that really stopped being sampled leaves gaps ≥ 1 × dt.
 */
function* buildSegments(
  tl: TimelineM,
  lane: number,
  ids: FrameIds,
  stacks: readonly CombinedStackEntry[],
): Generator<unknown, LaneSegments, void> {
  const depth = tl.maxDepth[lane] ?? 0;
  const touch = SEGMENT_TOUCH * tl.dt;
  const rows = Array.from({ length: depth }, () => ({ t0: [] as number[], t1: [] as number[], stack: [] as number[], samples: [] as number[], id: [] as number[] }));
  const order = tl.byThread[lane] ?? new Int32Array(0);
  for (let k = 0; k < order.length; k++) {
    if ((k & 1023) === 1023) yield;
    const i = order[k];
    const s = tl.stack[i];
    const fid = ids.of(s);
    const a = tl.t0[i];
    const b = tl.t1[i];
    const c = tl.count[i];
    for (let d = 0; d < stacks[s][0].length; d++) {
      const r = rows[d];
      const last = r.t0.length - 1;
      if (last >= 0 && r.id[last] === fid[d] && r.t1[last] >= a - touch) {
        r.t1[last] = Math.max(r.t1[last], b);
        r.samples[last] += c;
      } else {
        r.t0.push(a);
        r.t1.push(b);
        r.stack.push(s);
        r.samples.push(c);
        r.id.push(fid[d]);
      }
    }
  }
  return {
    thread: lane,
    rows: rows.map((r) => ({
      n: r.t0.length,
      t0: Float64Array.from(r.t0),
      t1: Float64Array.from(r.t1),
      stack: Int32Array.from(r.stack),
      samples: Float64Array.from(r.samples),
    })),
  };
}
