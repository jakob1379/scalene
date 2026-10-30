/**
 * Instrument scope geometry (DESIGN.md §4.4.1–4.4.3, §4.4.7): which channels
 * exist, their heights per breakpoint, their rects, and the PHASE cell
 * partition. Pure functions (no DOM), unit-tested in tests/unit/wp2-*.test.mjs.
 */

import type { Breakpoint } from "../../core/store";
import type { Rect } from "../../charts/placement";

export type ChannelId = "phase" | "memory" | "rug" | "threads" | "tasks" | "top";

/** Which channels the profile has (§4.4.2). `topRows` = 0 when TOP LINES is absent. */
export interface ChannelPresence {
  phase: boolean;
  memory: boolean;
  threads: boolean;
  tasks: boolean;
  topRows: number;
}

export interface ScopeMetrics {
  /** Left gutter (channel labels); 0 on `xs` (labels sit on a row above each channel). */
  gutterL: number;
  /** Right gutter (y-tick labels); 0 on `xs` (ticks drawn inside the plot). */
  gutterR: number;
  /** Label row above each channel (`xs` only). */
  labelRow: number;
  gap: number;
  /** Gap between MEMORY and its RUG row. */
  rugGap: number;
  rugH: number;
  axisH: number;
  phaseH: number;
  threadsH: number;
  topRowH: number;
  memoryMin: number;
  /** Target canvas height for stacked layouts (side-by-side layouts stretch). */
  target: number;
  /** Top padding inside the canvas (room for the first label / callout halo). */
  padTop: number;
  short: boolean;
  xs: boolean;
}

export interface ChannelRect {
  id: ChannelId;
  rect: Rect;
  /** `xs`: the 14 px label row above the channel. */
  labelRow: Rect | null;
}

export interface ScopeGeometry {
  width: number;
  height: number;
  plot: Rect;
  channels: ChannelRect[];
  /** Time-axis label row under the plot. */
  axis: Rect;
  m: ScopeMetrics;
}

const CHANNEL_GAP = 8;
/**
 * TOP LINES row pitch when the strips take the free height (no MEMORY / THREADS / TASKS):
 * rows spread out up to this pitch, but each strip stays at most `TOP_BAR_MAX` px tall, so
 * the channel never turns into a wall of tall barcodes (review round 1).
 */
export const TOP_ROW_MAX = 32;
/** Tallest TOP LINES strip (CSS px). */
export const TOP_BAR_MAX = 20;
/** TOP LINES rows: 5 next to another channel, up to 8 (= the hotspot list) when they are the signal. */
export const TOP_ROWS = 5;
export const TOP_ROWS_ALONE = 8;

/** Per-breakpoint metrics (§4.4.1 gutters, §4.4.2 heights, §2.4.2 scope heights). */
export function scopeMetrics(bp: Breakpoint, short: boolean, stacked: boolean): ScopeMetrics {
  const xs = bp === "xs" && !short;
  const base = { gap: CHANNEL_GAP, rugGap: 2, rugH: 6, axisH: 20, memoryMin: 72, padTop: 4, short, xs };
  if (short) {
    // §4.4.1 says 72; 84 keeps "THREADS" / "MEMORY" micro labels whole with their LED.
    const gutterL = bp === "xs" ? 0 : 84;
    return { ...base, gutterL, gutterR: bp === "xs" ? 0 : 44, labelRow: 0, phaseH: 0, threadsH: 48, topRowH: 0, target: stacked ? 150 : 200, memoryMin: 48 };
  }
  switch (bp) {
    case "xs":
      return { ...base, gutterL: 0, gutterR: 0, labelRow: 14, phaseH: 18, threadsH: 36, topRowH: 10, target: 236 };
    case "sm":
      return { ...base, gutterL: 88, gutterR: 52, labelRow: 0, phaseH: 18, threadsH: 32, topRowH: 10, target: 220 };
    case "md":
      return { ...base, gutterL: 96, gutterR: 52, labelRow: 0, phaseH: 18, threadsH: 32, topRowH: 10, target: 220 };
    case "lg":
      return { ...base, gutterL: 104, gutterR: 52, labelRow: 0, phaseH: 18, threadsH: 40, topRowH: 12, target: 330 };
    case "xl":
      return { ...base, gutterL: 112, gutterR: 52, labelRow: 0, phaseH: 20, threadsH: 44, topRowH: 12, target: 360 };
    default:
      return { ...base, gutterL: 120, gutterR: 56, labelRow: 0, phaseH: 20, threadsH: 52, topRowH: 14, target: 400 };
  }
}

/** True when a channel can carry the free height (MEMORY, THREADS or TASKS). */
export function hasFlexChannel(p: ChannelPresence): boolean {
  return p.memory || p.threads || p.tasks;
}

/**
 * The channels drawn in a layout mode. `p.topRows` is the number of ranked items available
 * (up to 8). Short hosts drop PHASE and TOP LINES (§4.4.2 table: "–"), except that TOP LINES
 * stays (5 rows) when it is the only channel left, so a CPU-only profile never gets an empty
 * signal card in a 400 px iframe. When TOP LINES is the signal (no MEMORY / THREADS / TASKS)
 * in a side-by-side layout it shows up to 8 rows, one per visible hotspot.
 */
export function effectivePresence(p: ChannelPresence, m: ScopeMetrics, side = false): ChannelPresence {
  const flex = hasFlexChannel(p);
  if (m.short) return { ...p, phase: false, topRows: flex ? 0 : Math.min(TOP_ROWS, p.topRows) };
  const max = side && !flex && !m.xs ? TOP_ROWS_ALONE : TOP_ROWS;
  return { ...p, topRows: Math.min(max, p.topRows) };
}

export function anyChannel(p: ChannelPresence): boolean {
  return p.phase || p.memory || p.threads || p.tasks || p.topRows > 0;
}

interface Slot {
  id: ChannelId;
  h: number | "flex";
  gapBefore: number;
  label: boolean;
}

function slots(p: ChannelPresence, m: ScopeMetrics): Slot[] {
  const out: Slot[] = [];
  const push = (id: ChannelId, h: number | "flex", label = true, gap = m.gap) => out.push({ id, h, gapBefore: out.length ? gap : 0, label });
  if (p.phase) push("phase", m.phaseH);
  if (p.memory) {
    push("memory", "flex");
    push("rug", m.rugH, false, m.rugGap);
  }
  if (p.threads) push("threads", m.threadsH);
  if (p.tasks) push("tasks", m.threadsH);
  if (p.topRows > 0) push("top", p.topRows * m.topRowH);
  // Without MEMORY the flex space goes to the busiest numeric channel so the plot fills the card.
  if (!p.memory) {
    const grow = out.find((s) => s.id === "threads") ?? out.find((s) => s.id === "tasks");
    if (grow) grow.h = "flex";
  }
  return out;
}

/** Fixed height (everything except the flexible channel at its minimum). */
export function requiredHeight(p: ChannelPresence, m: ScopeMetrics): number {
  const list = slots(p, m);
  if (!list.length) return 0;
  let h = m.padTop + m.axisH + 4;
  for (const s of list) {
    h += s.gapBefore + (s.label && m.labelRow ? m.labelRow : 0);
    h += s.h === "flex" ? (s.id === "memory" ? m.memoryMin : m.threadsH) : s.h;
  }
  return Math.ceil(h);
}

/** Canvas height for a layout: stacked layouts use the target, side by side the available height. */
export function canvasHeight(p: ChannelPresence, m: ScopeMetrics, available: number | null): number {
  const req = requiredHeight(p, m);
  const want = available !== null && available > 0 ? available : m.target;
  return Math.max(req, Math.round(want));
}

/** Channel rects for a canvas of `width × height` CSS px. */
export function layoutChannels(width: number, height: number, p: ChannelPresence, m: ScopeMetrics): ScopeGeometry {
  const list = slots(p, m);
  const plotX = m.gutterL;
  const plotW = Math.max(40, width - m.gutterL - m.gutterR);
  const fixed = requiredHeight(p, m);
  const flexSlot = list.find((s) => s.h === "flex");
  const flexBase = flexSlot ? (flexSlot.id === "memory" ? m.memoryMin : m.threadsH) : 0;
  const flexH = flexBase + Math.max(0, height - fixed);
  // No flexible channel (e.g. CPU-only: PHASE + TOP LINES): the rows spread out (pitch ≤ 32 px);
  // the strips themselves stay ≤ 20 px tall (topBarHeight), so the free height becomes air.
  const topSlot = list.find((s) => s.id === "top");
  let topH = topSlot ? (topSlot.h as number) : 0;
  if (!flexSlot && topSlot && height > fixed) topH = Math.min(p.topRows * TOP_ROW_MAX, topH + (height - fixed));
  const channels: ChannelRect[] = [];
  let y = m.padTop;
  for (const s of list) {
    y += s.gapBefore;
    let labelRow: Rect | null = null;
    if (s.label && m.labelRow) {
      labelRow = { x: 0, y, w: width, h: m.labelRow };
      y += m.labelRow;
    }
    const h = s.h === "flex" ? flexH : s.id === "top" ? topH : s.h;
    channels.push({ id: s.id, rect: { x: plotX, y, w: plotW, h }, labelRow });
    y += h;
  }
  const plotTop = channels.length ? channels[0].labelRow?.y ?? channels[0].rect.y : m.padTop;
  const plot: Rect = { x: plotX, y: plotTop, w: plotW, h: Math.max(0, y - plotTop) };
  const axis: Rect = { x: plotX, y: y + 4, w: plotW, h: m.axisH };
  return { width, height, plot, channels, axis, m };
}

/** TOP LINES strip height for a row pitch: the row minus a 2 px gap, at most 20 px. */
export function topBarHeight(pitch: number): number {
  return Math.max(1, Math.min(TOP_BAR_MAX, pitch - 2));
}

export function channelRect(g: ScopeGeometry, id: ChannelId): Rect | null {
  return g.channels.find((c) => c.id === id)?.rect ?? null;
}

// ── PHASE cells (§4.4.3, must-fix 2) ────────────────────────────────────────

export interface PhaseLike {
  key: string;
  label: string;
  t0: number;
  t1: number;
}

export type PhaseCellKind = "label" | "short" | "group";

export interface PhaseCell<P extends PhaseLike = PhaseLike> {
  kind: PhaseCellKind;
  /** Pixel extent of the time span (before the 2 px gaps). */
  x0: number;
  x1: number;
  /** Drawn rect x/w (2 px gaps between neighbouring cells). */
  x: number;
  w: number;
  t0: number;
  t1: number;
  members: P[];
  /** Text to draw ("N short phases" for labelled groups); null for hatched cells. */
  label: string | null;
  /**
   * Group cells: the member phase that covers at least half of the group's time, with its
   * repeat count, so a group reads "handle_request(…) ×69" instead of "69 short phases".
   */
  dominant: { label: string; count: number; share: number } | null;
}

/** The phase (by key) that covers ≥ 50 % of the members' time, or null. */
export function dominantMember(members: readonly PhaseLike[]): { label: string; count: number; share: number } | null {
  if (members.length < 2) return null;
  const by = new Map<string, { label: string; count: number; time: number }>();
  let total = 0;
  for (const m of members) {
    const d = Math.max(0, m.t1 - m.t0);
    total += d;
    const e = by.get(m.key);
    if (e) {
      e.count++;
      e.time += d;
    } else by.set(m.key, { label: m.label, count: 1, time: d });
  }
  let best: { label: string; count: number; time: number } | null = null;
  for (const e of by.values()) if (!best || e.time > best.time) best = e;
  if (!best || !(total > 0) || best.time / total < 0.5 || best.count < 2) return null;
  return { label: best.label, count: best.count, share: best.time / total };
}

export const PHASE_LABEL_MIN = 64;
export const PHASE_CELL_MIN = 12;
const PHASE_GAP = 2;

/**
 * Partition phases into cells by pixel width: ≥ 64 px labelled, 12–63 px
 * hatched "short phase", < 12 px merged with adjacent tiny cells into one
 * hatched group (labelled "N short phases" when the group is ≥ 64 px).
 * Tiny cells merge only across gaps < 12 px, so time without main-thread
 * samples stays empty.
 */
export function layoutPhaseCells<P extends PhaseLike>(phases: readonly P[], x: (t: number) => number): PhaseCell<P>[] {
  type Raw = { x0: number; x1: number; members: P[] };
  const raw: Raw[] = [];
  let prevEnd = -Infinity;
  for (const p of phases) {
    let x0 = x(p.t0);
    const x1 = Math.max(x0, x(p.t1));
    if (x0 < prevEnd) x0 = Math.min(prevEnd, x1);
    raw.push({ x0, x1, members: [p] });
    prevEnd = x1;
  }
  const tiny = (r: Raw) => r.x1 - r.x0 < PHASE_CELL_MIN;
  const merged: (Raw & { group: boolean })[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && last.group && tiny(r) && r.x0 - last.x1 < PHASE_CELL_MIN) {
      last.x1 = r.x1;
      last.members.push(...r.members);
    } else merged.push({ ...r, members: [...r.members], group: tiny(r) });
  }
  const cells: PhaseCell<P>[] = merged.map((r) => {
    const w = r.x1 - r.x0;
    let kind: PhaseCellKind;
    let label: string | null = null;
    if (r.group && r.members.length > 1) {
      kind = "group";
      if (w >= PHASE_LABEL_MIN) label = `${r.members.length} short phases`;
    } else if (w >= PHASE_LABEL_MIN) {
      kind = "label";
      label = r.members[0].label;
    } else kind = "short";
    const dominant = kind === "group" ? dominantMember(r.members) : null;
    return { kind, x0: r.x0, x1: r.x1, x: r.x0, w, t0: r.members[0].t0, t1: r.members[r.members.length - 1].t1, members: r.members, label, dominant };
  });
  // 2 px gaps where cells touch; a cell never shrinks below 1 px.
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const left = i > 0 && c.x0 - cells[i - 1].x1 < PHASE_GAP ? PHASE_GAP / 2 : 0;
    const right = i < cells.length - 1 && cells[i + 1].x0 - c.x1 < PHASE_GAP ? PHASE_GAP / 2 : 0;
    const w = c.x1 - c.x0 - left - right;
    if (w >= 1) {
      c.x = c.x0 + left;
      c.w = w;
    } else {
      c.x = c.x0;
      c.w = Math.max(1, c.x1 - c.x0);
    }
  }
  return cells;
}

/** The cell (index) covering pixel `px`, or −1. */
export function phaseCellAt(cells: readonly PhaseCell[], px: number): number {
  let lo = 0;
  let hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cells[mid];
    if (px < c.x0) hi = mid - 1;
    else if (px > Math.max(c.x1, c.x0 + 1)) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// ── Small numeric helpers ───────────────────────────────────────────────────

/** Integer y ticks for a count channel: 0 and ceil(max), plus a middle tick when max ≥ 4. */
export function countTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max - 1e-6));
  const out = [0, top];
  if (top >= 4) out.splice(1, 0, Math.round(top / 2));
  return out;
}

/** Bucket count for a plot width (≈ 2 CSS px per bucket, §4.4.4). */
export function bucketCount(plotW: number): number {
  return Math.max(8, Math.floor(plotW / 2));
}

// ── THREADS scale (width-independent) ──────────────────────────────────────

/**
 * THREADS buckets in time, not pixels: windows of max(10·dt, tMax/600) (review round 1), so the
 * y scale, the "busy · 0–N" caption and the readout values are the same at every window width.
 */
export function threadBucketCount(tMax: number, dt: number): number {
  if (!(tMax > 0)) return 16;
  const w = Math.max(10 * (dt > 0 ? dt : 0.01), tMax / 600);
  return Math.max(16, Math.min(600, Math.round(tMax / w)));
}

/**
 * The largest number of intervals `[t0[i], t1[i])` open at one instant (a sweep over the
 * endpoints; an interval ending at t does not overlap one starting at t). `keep(i)` filters.
 */
export function maxConcurrent(t0: ArrayLike<number>, t1: ArrayLike<number>, keep: (i: number) => boolean = () => true): number {
  const ev: number[] = [];
  for (let i = 0; i < t0.length; i++) {
    if (!(t1[i] > t0[i]) || !keep(i)) continue;
    ev.push(t0[i], 1, t1[i], -1);
  }
  const n = ev.length / 2;
  const order = new Int32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  // By time; at equal times the ends (−1) come first (half-open intervals).
  order.sort((a, b) => ev[2 * a] - ev[2 * b] || ev[2 * a + 1] - ev[2 * b + 1]);
  let cur = 0;
  let max = 0;
  for (let k = 0; k < n; k++) {
    cur += ev[2 * order[k] + 1];
    if (cur > max) max = cur;
  }
  return max;
}

// ── Peak callout vs. the footprint trace (§4.4.7 + review round 1) ─────────
// The trace-aware planner lives in charts/placement (shared with the Memory chart).
export { bandExtent, CALLOUT_SHIFTS, calloutSpots, hitsTrace, planPeakClear, traceBand, type CalloutSpot, type TraceBand } from "../../charts/placement";
