/**
 * Timeline row layout and domain math (DESIGN.md §4.12.1–4.12.3), pure so it
 * is unit-tested in Node. The chart is one coordinate system: the gutter
 * (labels, DOM) on the left and the plot to its right; rows stack top-down:
 * axis → memory → GC / I/O & waits / GIL → thread lanes (or one interleaved panel).
 */

import type { Breakpoint } from "../../core/store";
import { CLS_GC, CLS_GIL, CLS_IO } from "../../model/classify";
import type { TimelineM } from "../../model/timeline";
import { fmtTime } from "../../core/format";
import { lowerBound } from "../stacks/shared";

export const AXIS_H = 24;
export const MEMORY_H = 56;
export const CLASS_H = 12;
export const CLASS_GAP = 2;
/** Lane header / "show all" button height: ≥ 24 px targets (WCAG 2.5.8), 32 px on coarse pointers (§6.2.7). */
export const HEAD_H = 24;
export const HEAD_H_COARSE = 32;
export const headHeight = (coarse?: boolean): number => (coarse ? HEAD_H_COARSE : HEAD_H);
export const STRIP_H = 16;
export const ROW_H = 12;
export const LABEL_ROW_H = 16;

export type ClassKey = "gc" | "io" | "gil";
export const CLASS_KEYS: readonly ClassKey[] = ["gc", "io", "gil"];
export const CLASS_BIT: Record<ClassKey, number> = { gc: CLS_GC, io: CLS_IO, gil: CLS_GIL };
export const CLASS_LABEL: Record<ClassKey, string> = { gc: "GC", io: "I/O & waits", gil: "GIL" };

export interface LaneSpec {
  /** Lane index in `TimelineM.threads`. */
  idx: number;
  /** Stable key ("main", "thread 3", "unknown"). */
  key: string;
  maxDepth: number;
}

export interface LayoutInput {
  width: number;
  bp: Breakpoint;
  short: boolean;
  view: "lanes" | "interleaved";
  /** Lane index the thread filter keeps, or null for all threads. */
  filter: number | null;
  lanes: readonly LaneSpec[];
  expanded: ReadonlySet<string>;
  /** Lanes showing every depth level (past the default cap). */
  full: ReadonlySet<string>;
  memory: boolean;
  /** Coarse pointer (touch): 32 px lane headers and buttons. */
  coarse?: boolean;
}

export type ItemKind = "axis" | "memory" | "class" | "lane" | "inter";

export interface LayoutItem {
  kind: ItemKind;
  /** Top of the item's plot rows (CSS px). */
  y: number;
  h: number;
  /** Label row above the item (xs only), else null. */
  labelY: number | null;
  cls?: ClassKey;
  lane?: number;
  laneKey?: string;
  expanded?: boolean;
  /** Depth rows drawn (expanded lanes / interleaved). */
  depthShown?: number;
  depthTotal?: number;
  /** Lane indices drawn in this item (one lane, or all for interleaved). */
  lanes?: number[];
  /** Top of the depth rows (expanded) or of the 16 px strip (collapsed). */
  bodyY?: number;
}

/** One keyboard row (↑/↓ walk through lanes and depths, §4.12.3). */
export interface KeyRow {
  item: number;
  depth: number;
  lanes: number[];
  y: number;
}

export interface TimelineLayout {
  width: number;
  height: number;
  gutter: number;
  /** Labels sit above rows (xs). */
  above: boolean;
  plotX: number;
  plotW: number;
  items: LayoutItem[];
  rows: KeyRow[];
  /**
   * Gutter column header above several lanes ("Threads · % of samples", round 1): every lane
   * header then shows its share as a bare number in that column. null when absent.
   */
  laneHeaderY: number | null;
}

/** Gutter width per breakpoint (§2.4.4): xs none (labels above), sm/short 120, md+ 168. */
export function gutterFor(bp: Breakpoint, short: boolean): number {
  if (bp === "xs") return 0;
  if (short || bp === "sm") return 120;
  return 168;
}

/** Depth rows shown before "+ show all N levels" (§2.4.4): md+ 16, xs 8, short 6. */
export function depthCap(bp: Breakpoint, short: boolean): number {
  if (short) return 6;
  if (bp === "xs") return 8;
  return 16;
}

export function computeLayout(inp: LayoutInput): TimelineLayout {
  const gutter = gutterFor(inp.bp, inp.short);
  const above = gutter === 0;
  const plotX = gutter;
  const plotW = Math.max(40, inp.width - gutter - (above ? 0 : 6));
  const cap = depthCap(inp.bp, inp.short);
  const headH = headHeight(inp.coarse);
  const items: LayoutItem[] = [];
  const rows: KeyRow[] = [];
  let laneHeaderY: number | null = null;
  let y = 0;
  items.push({ kind: "axis", y: 0, h: AXIS_H, labelY: null });
  y = AXIS_H + 6;
  if (inp.memory) {
    const labelY = above ? y : null;
    if (above) y += LABEL_ROW_H;
    items.push({ kind: "memory", y, h: MEMORY_H, labelY });
    y += MEMORY_H + 8;
  }
  {
    const labelY = above ? y : null;
    if (above) y += LABEL_ROW_H;
    CLASS_KEYS.forEach((cls, i) => {
      items.push({ kind: "class", cls, y, h: CLASS_H, labelY: i === 0 ? labelY : null });
      y += CLASS_H + (i < 2 ? CLASS_GAP : 0);
    });
    y += 10;
  }
  const shown = inp.filter === null ? inp.lanes : inp.lanes.filter((l) => l.idx === inp.filter);
  if (inp.view === "interleaved" && inp.filter === null && inp.lanes.length > 1) {
    const total = Math.max(0, ...inp.lanes.map((l) => l.maxDepth));
    const fullAll = inp.full.has("*");
    const depthShown = fullAll ? total : Math.min(total, cap);
    const labelY = y;
    const bodyY = y + headH;
    const it: LayoutItem = {
      kind: "inter",
      y,
      h: headH + depthShown * ROW_H,
      labelY: above ? labelY : null,
      depthShown,
      depthTotal: total,
      lanes: inp.lanes.map((l) => l.idx),
      bodyY,
      expanded: true,
      laneKey: "*",
    };
    items.push(it);
    for (let d = 0; d < depthShown; d++) rows.push({ item: items.length - 1, depth: d, lanes: it.lanes as number[], y: bodyY + d * ROW_H });
    y += it.h + 8;
  } else {
    // Several lanes beside a gutter: one column header names the denominator for all of them.
    if (!above && shown.length > 1) {
      laneHeaderY = y;
      y += LABEL_ROW_H;
    }
    for (const lane of shown) {
      const expanded = inp.expanded.has(lane.key) || inp.filter === lane.idx || shown.length === 1;
      const depthShown = expanded ? (inp.full.has(lane.key) ? lane.maxDepth : Math.min(lane.maxDepth, cap)) : 0;
      let h: number;
      let bodyY: number;
      if (above) {
        // The label row (header + "show all") is reserved above the rows: no target touches the canvas.
        bodyY = y + headH;
        h = headH + (expanded ? depthShown * ROW_H : STRIP_H + 4);
      } else if (expanded) {
        bodyY = y + 4;
        // The gutter holds the header, the share line (16, unless the column header carries it)
        // and the "show all" / "show N" button.
        const toggle = depthShown < lane.maxDepth || (depthShown > cap && inp.full.has(lane.key));
        const gutterNeed = headH + (laneHeaderY === null ? 16 : 0) + (toggle ? headH + 4 : 0);
        h = Math.max(gutterNeed, 4 + depthShown * ROW_H + 2);
      } else {
        bodyY = y + Math.round((headH - STRIP_H) / 2);
        h = headH;
      }
      const it: LayoutItem = {
        kind: "lane",
        y,
        h,
        labelY: above ? y : null,
        lane: lane.idx,
        laneKey: lane.key,
        expanded,
        depthShown,
        depthTotal: lane.maxDepth,
        lanes: [lane.idx],
        bodyY,
      };
      items.push(it);
      if (expanded) for (let d = 0; d < depthShown; d++) rows.push({ item: items.length - 1, depth: d, lanes: [lane.idx], y: bodyY + d * ROW_H });
      y += h + 6;
    }
  }
  return { width: inp.width, height: y + 2, gutter, above, plotX, plotW, items, rows, laneHeaderY };
}

// ── Domain ──────────────────────────────────────────────────────────────────

/** Smallest visible span: four sampling intervals, never below 1 ms. */
export function minSpan(dt: number, tMax: number): number {
  return Math.min(tMax, Math.max(0.001, 4 * dt));
}

/** Clamp a domain into `[0, tMax]` keeping its span within `[minSpan, tMax]`. */
export function clampDomain(a: number, b: number, tMax: number, min: number): [number, number] {
  let span = Math.max(min, Math.min(tMax, b - a));
  if (!(span > 0)) span = tMax;
  let lo = a;
  if (lo < 0) lo = 0;
  if (lo + span > tMax) lo = tMax - span;
  return [lo, lo + span];
}

/** Zoom by `factor` (< 1 zooms in) around time `at`, keeping `at` under the same x. */
export function zoomAround(d: readonly [number, number], at: number, factor: number, tMax: number, min: number): [number, number] {
  const span = d[1] - d[0];
  const next = Math.max(min, Math.min(tMax, span * factor));
  const f = span > 0 ? (at - d[0]) / span : 0.5;
  return clampDomain(at - f * next, at - f * next + next, tMax, min);
}

/** Pan by a fraction of the span (positive = later). */
export function panBy(d: readonly [number, number], frac: number, tMax: number, min: number): [number, number] {
  const span = d[1] - d[0];
  return clampDomain(d[0] + frac * span, d[1] + frac * span, tMax, min);
}

// ── Classified intervals (GC / I/O & waits / GIL rows) ──────────────────────

export interface Intervals {
  n: number;
  a: Float64Array;
  b: Float64Array;
  /** Σ count of the merged runs (samples). */
  samples: Float64Array;
}

/**
 * Runs whose stack has the class bit, merged when they touch (gap ≤ half a
 * sampling interval). `lane` restricts to one thread. Sorted and disjoint.
 */
export function classIntervals(tl: TimelineM, bit: number, lane: number | null): Intervals {
  const order = lane === null ? null : tl.byThread[lane] ?? new Int32Array(0);
  const n = order ? order.length : tl.n;
  const touch = 0.5 * tl.dt;
  const a: number[] = [];
  const b: number[] = [];
  const s: number[] = [];
  // Event order is chronological; one pass merges across threads as well.
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k;
    if ((tl.stackBits[tl.stack[i]] & bit) === 0) continue;
    const t0 = tl.t0[i];
    const t1 = tl.t1[i];
    const last = a.length - 1;
    if (last >= 0 && t0 <= b[last] + touch) {
      if (t1 > b[last]) b[last] = t1;
      s[last] += tl.count[i];
    } else if (last >= 0 && t0 < a[last]) {
      // Out-of-order input (merged profiles): fall back to a sorted rebuild.
      return sortedIntervals(tl, bit, order, n);
    } else {
      a.push(t0);
      b.push(t1);
      s.push(tl.count[i]);
    }
  }
  return { n: a.length, a: Float64Array.from(a), b: Float64Array.from(b), samples: Float64Array.from(s) };
}

function sortedIntervals(tl: TimelineM, bit: number, order: Int32Array | null, n: number): Intervals {
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k;
    if (tl.stackBits[tl.stack[i]] & bit) idx.push(i);
  }
  idx.sort((x, y) => tl.t0[x] - tl.t0[y]);
  const touch = 0.5 * tl.dt;
  const a: number[] = [];
  const b: number[] = [];
  const s: number[] = [];
  for (const i of idx) {
    const last = a.length - 1;
    if (last >= 0 && tl.t0[i] <= b[last] + touch) {
      if (tl.t1[i] > b[last]) b[last] = tl.t1[i];
      s[last] += tl.count[i];
    } else {
      a.push(tl.t0[i]);
      b.push(tl.t1[i]);
      s.push(tl.count[i]);
    }
  }
  return { n: a.length, a: Float64Array.from(a), b: Float64Array.from(b), samples: Float64Array.from(s) };
}

/** Index of the interval containing `t` (or −1). */
export function intervalAt(iv: Intervals, t: number, slack = 0): number {
  const i = lowerBound(iv.b, t - slack);
  return i < iv.n && iv.a[i] <= t + slack ? i : -1;
}

/** Lane totals for one thread: % of that thread's samples in each class (thread filter). */
export function laneClassShares(tl: TimelineM, lane: number): Record<ClassKey, number> {
  let all = 0;
  const acc = { gc: 0, io: 0, gil: 0 };
  for (const i of tl.byThread[lane] ?? []) {
    const c = tl.count[i];
    const bits = tl.stackBits[tl.stack[i]];
    all += c;
    if (bits & CLS_GC) acc.gc += c;
    if (bits & CLS_IO) acc.io += c;
    if (bits & CLS_GIL) acc.gil += c;
  }
  const pct = (v: number) => (all > 0 ? (100 * v) / all : 0);
  return { gc: pct(acc.gc), io: pct(acc.io), gil: pct(acc.gil) };
}

/** Parse the store's thread filter ("all", "main", "unknown", "thread 3", a raw id) to a lane index. */
export function laneForFilter(tl: Pick<TimelineM, "threads">, v: string): number | null {
  if (!v || v === "all" || v === "interleaved" || v === "swimlanes") return null;
  const threads = tl.threads;
  if (v === "main") {
    const m = threads.find((t) => t.main);
    return m ? m.idx : null;
  }
  if (v === "unknown") {
    const u = threads.find((t) => t.id === null);
    return u ? u.idx : null;
  }
  const byLabel = threads.find((t) => t.label === v);
  if (byLabel) return byLabel.idx;
  const byId = threads.find((t) => t.id !== null && String(t.id) === v);
  return byId ? byId.idx : null;
}

/** Store value for a lane index (inverse of `laneForFilter`). */
export function filterValueFor(tl: Pick<TimelineM, "threads">, lane: number | null): string {
  if (lane === null) return "all";
  const t = tl.threads[lane];
  if (!t) return "all";
  if (t.main) return "main";
  if (t.id === null) return "unknown";
  return String(t.id);
}

/** Collapsed-lane activity: per pixel column, covered fraction and majority leaf kind (0 py, 1 native, 2 await). */
export interface Activity {
  cov: Float32Array;
  kind: Uint8Array;
}

export interface ActivityScratch {
  cov: Float32Array;
  py: Float32Array;
  nat: Float32Array;
  aw: Float32Array;
  kind: Uint8Array;
}

function scratchFor(cols: number, s?: ActivityScratch): ActivityScratch {
  if (s && s.cov.length === cols) {
    s.cov.fill(0);
    s.py.fill(0);
    s.nat.fill(0);
    s.aw.fill(0);
    return s;
  }
  return { cov: new Float32Array(cols), py: new Float32Array(cols), nat: new Float32Array(cols), aw: new Float32Array(cols), kind: new Uint8Array(cols) };
}

/** `scratch` buffers are reused between calls (one draw paints many lanes). */
export function laneActivity(tl: TimelineM, lane: number, d0: number, d1: number, cols: number, maxRun: number, scratch?: ActivityScratch): Activity & { scratch: ActivityScratch } {
  const sc = scratchFor(cols, scratch);
  const { cov, py, nat, aw } = sc;
  const idx = tl.byThread[lane];
  const span = d1 - d0;
  if (!idx || !(span > 0) || cols <= 0) return { cov, kind: sc.kind.fill(0), scratch: sc };
  const colDur = span / cols;
  // Runs sorted by t0: start one maximal run length before the domain.
  let lo = 0;
  let hi = idx.length;
  const start = d0 - maxRun;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tl.t0[idx[mid]] < start) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < idx.length; k++) {
    const i = idx[k];
    const a0 = tl.t0[i];
    if (a0 > d1) break;
    const a = a0 > d0 ? a0 : d0;
    const b = tl.t1[i] < d1 ? tl.t1[i] : d1;
    if (!(b > a)) continue;
    const s = tl.stack[i];
    const acc = tl.awaitLeaf[s] ? aw : tl.nativeLeaf[s] ? nat : py;
    const c0 = Math.max(0, Math.floor((a - d0) / colDur));
    const c1 = Math.min(cols - 1, Math.floor((b - d0) / colDur));
    if (c0 === c1) {
      const f = (b - a) / colDur;
      cov[c0] += f;
      acc[c0] += f;
      continue;
    }
    for (let c = c0; c <= c1; c++) {
      const cs = d0 + c * colDur;
      const ov = Math.min(b, cs + colDur) - Math.max(a, cs);
      if (ov <= 0) continue;
      const f = ov / colDur;
      cov[c] += f;
      acc[c] += f;
    }
  }
  const kind = sc.kind;
  for (let c = 0; c < cols; c++) kind[c] = aw[c] > py[c] && aw[c] > nat[c] ? 2 : nat[c] > py[c] ? 1 : 0;
  return { cov, kind, scratch: sc };
}

/** Longest run of a lane (activity culling window). */
export function maxRunLength(tl: TimelineM, lane: number): number {
  let m = 0;
  for (const i of tl.byThread[lane] ?? []) {
    const d = tl.t1[i] - tl.t0[i];
    if (d > m) m = d;
  }
  return m;
}

// ── Range text (header label and announcements) ─────────────────────────────

/**
 * "10.9 s – 52.4 s"; below 1 s of span the ends get enough decimals to differ
 * ("28.400 s – 28.440 s", never "28.4 s – 28.4 s").
 */
export function fmtDomain(a: number, b: number, sep = " – "): string {
  const span = b - a;
  if (!(span > 0) || span >= 1) return `${fmtTime(a)}${sep}${fmtTime(b)}`;
  const dec = Math.min(6, Math.max(2, Math.ceil(-Math.log10(span)) + 1));
  return `${a.toFixed(dec)}\u00a0s${sep}${b.toFixed(dec)}\u00a0s`;
}

/** Polite announcement once a zoom/pan settles: "Showing 28.400 s to 28.440 s of 54.1 s". */
export function domainAnnouncement(d: readonly [number, number], tMax: number): string {
  if (d[0] <= 1e-9 && d[1] >= tMax - 1e-9) return `Showing the whole run, ${fmtTime(tMax)}`;
  return `Showing ${fmtDomain(d[0], d[1], " to ")} of ${fmtTime(tMax)}`;
}
