/**
 * Rect math and annotation placement (DESIGN.md §4.4.7, must-fix 5).
 *
 * Order of placement: peak callout → (range chip lives in the header) →
 * y ticks. Every placed rect is returned so `scope.debugLayout()` can prove
 * that annotations never intersect and stay inside their channel.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** Positive-area overlap (touching edges do not intersect). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** `inner` lies within `outer` shrunk by `inset` on every side. */
export function contains(outer: Rect, inner: Rect, inset = 0): boolean {
  return (
    inner.x >= outer.x + inset &&
    inner.y >= outer.y + inset &&
    inner.x + inner.w <= outer.x + outer.w - inset &&
    inner.y + inner.h <= outer.y + outer.h - inset
  );
}

export function insetRect(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) };
}

/** True when no two rects of the list intersect. */
export function disjoint(rects: readonly Rect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (intersects(rects[i], rects[j])) return false;
  }
  return true;
}

// ── Peak callout (§4.4.7) ───────────────────────────────────────────────────

export type CalloutSide = "left" | "right" | "below-left" | "below-right";

/** Horizontal distance between the dot and the box. */
export const CALLOUT_GAP_X = 10;
/** Box top relative to the dot (side placements). */
export const CALLOUT_RISE = 8;
/** Channel inset a placed annotation must respect. */
export const CHANNEL_INSET = 2;

/** Candidate boxes around the dot, in preference order. */
export function calloutCandidates(dot: Point, size: Size): { side: CalloutSide; rect: Rect }[] {
  const leftX = dot.x - CALLOUT_GAP_X - size.w;
  const rightX = dot.x + CALLOUT_GAP_X;
  const sideY = dot.y - CALLOUT_RISE;
  const belowY = dot.y + CALLOUT_RISE;
  return [
    { side: "left", rect: rect(leftX, sideY, size.w, size.h) },
    { side: "right", rect: rect(rightX, sideY, size.w, size.h) },
    { side: "below-left", rect: rect(leftX, belowY, size.w, size.h) },
    { side: "below-right", rect: rect(rightX, belowY, size.w, size.h) },
  ];
}

export interface PlaceOptions {
  dot: Point;
  size: Size;
  /** The channel the annotation must stay in. */
  bounds: Rect;
  /** Rects already taken (other annotations, the dot itself). */
  reserved?: readonly Rect[];
  inset?: number;
}

/** First candidate inside `bounds` (inset) that hits no reserved rect, else null. */
export function placeCallout(o: PlaceOptions): { side: CalloutSide; rect: Rect } | null {
  const inset = o.inset ?? CHANNEL_INSET;
  for (const c of calloutCandidates(o.dot, o.size)) {
    if (!contains(o.bounds, c.rect, inset)) continue;
    if ((o.reserved ?? []).some((r) => intersects(r, c.rect))) continue;
    return c;
  }
  return null;
}

export type PeakPlan =
  | { kind: "callout"; side: CalloutSide; rect: Rect }
  /** Fallback 1: one-line value label beside the dot. */
  | { kind: "label"; side: CalloutSide; rect: Rect }
  /** Fallback 2: no label in the plot; the channel gutter caption says "peak …". */
  | { kind: "gutter"; rect: null };

/**
 * Plan the peak annotation: the two-line callout, else a one-line label,
 * else nothing in the plot (gutter caption).
 */
export function planPeakLabel(o: { dot: Point; callout: Size; label: Size; bounds: Rect; reserved?: readonly Rect[] }): PeakPlan {
  const full = placeCallout({ dot: o.dot, size: o.callout, bounds: o.bounds, reserved: o.reserved });
  if (full) return { kind: "callout", side: full.side, rect: full.rect };
  const short = placeCallout({ dot: o.dot, size: o.label, bounds: o.bounds, reserved: o.reserved });
  if (short) return { kind: "label", side: short.side, rect: short.rect };
  return { kind: "gutter", rect: null };
}

/** A small square around the peak dot (reserved so labels never cover it). */
export function dotRect(dot: Point, radius = 4): Rect {
  return rect(dot.x - radius, dot.y - radius, 2 * radius, 2 * radius);
}

// ── Y ticks (§4.4.7) ────────────────────────────────────────────────────────

export interface YTickCandidate {
  /** Pixel y of the tick (gridline) position. */
  y: number;
  label: string;
  /** Measured label size. */
  size: Size;
}

export interface PlacedYTick extends YTickCandidate {
  rect: Rect;
}

export interface YTickOptions {
  channel: Rect;
  /** Left edge of the label column (right gutter or inside the plot on `xs`). */
  x: number;
  /** Labels are right-aligned to `x` instead of left-aligned. */
  alignRight?: boolean;
  reserved?: readonly Rect[];
  /** Labels may not enter the channel's top band of this height. */
  topGuard?: number;
  /** At most this many ticks survive. */
  max?: number;
}

/**
 * Y-tick labels, vertically centred on the tick and clamped inside the
 * channel. A tick is dropped when its label would hit the callout (or any
 * reserved rect), another tick, or the channel's top 4 px.
 */
export function placeYTicks(cands: readonly YTickCandidate[], o: YTickOptions): PlacedYTick[] {
  const guard = o.topGuard ?? 4;
  const max = o.max ?? 3;
  const out: PlacedYTick[] = [];
  const top = o.channel.y;
  const bottom = o.channel.y + o.channel.h;
  for (const c of cands) {
    if (out.length >= max) break;
    const h = c.size.h;
    const y = Math.min(bottom - h, Math.max(top, c.y - h / 2));
    const x = o.alignRight ? o.x - c.size.w : o.x;
    const r = rect(x, y, c.size.w, h);
    if (r.y < top + guard) continue;
    if ((o.reserved ?? []).some((q) => intersects(q, r))) continue;
    if (out.some((p) => intersects(p.rect, r))) continue;
    out.push({ ...c, rect: r });
  }
  return out;
}

// ── Peak callout vs. the footprint trace (§4.4.7 + review round 1) ─────────

/** Vertical extent of a polyline per 1 px column: `top[c]`/`bottom[c]` (NaN = no trace). */
export interface TraceBand {
  x0: number;
  top: Float32Array;
  bottom: Float32Array;
}

/** Per-column extent of the polyline `xy` (x0, y0, x1, y1, … in CSS px) over [x0, x0 + w). */
export function traceBand(xy: ArrayLike<number>, x0: number, w: number): TraceBand {
  const n = Math.max(1, Math.ceil(w));
  const top = new Float32Array(n).fill(NaN);
  const bottom = new Float32Array(n).fill(NaN);
  const put = (c: number, y: number) => {
    if (c < 0 || c >= n || !Number.isFinite(y)) return;
    if (!(top[c] <= y)) top[c] = y;
    if (!(bottom[c] >= y)) bottom[c] = y;
  };
  const m = Math.floor(xy.length / 2);
  for (let i = 0; i < m; i++) {
    const xa = xy[2 * i] - x0;
    const ya = xy[2 * i + 1];
    put(Math.floor(xa), ya);
    if (i + 1 >= m) break;
    const xb = xy[2 * i + 2] - x0;
    const yb = xy[2 * i + 3];
    const lo = Math.min(xa, xb);
    const hi = Math.max(xa, xb);
    const span = xb - xa;
    for (let c = Math.max(0, Math.floor(lo)); c <= Math.min(n - 1, Math.floor(hi)); c++) {
      if (span === 0) {
        put(c, ya);
        put(c, yb);
        continue;
      }
      const ca = Math.max(lo, c);
      const cb = Math.min(hi, c + 1);
      put(c, ya + ((ca - xa) / span) * (yb - ya));
      put(c, ya + ((cb - xa) / span) * (yb - ya));
    }
  }
  return { x0, top, bottom };
}

/** Highest (min y) and lowest (max y) trace point over the columns [x, x + w], or null. */
export function bandExtent(b: TraceBand, x: number, w: number): { top: number; bottom: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  const c0 = Math.max(0, Math.floor(x - b.x0));
  const c1 = Math.min(b.top.length - 1, Math.ceil(x + w - b.x0));
  for (let c = c0; c <= c1; c++) {
    if (Number.isNaN(b.top[c])) continue;
    if (b.top[c] < top) top = b.top[c];
    if (b.bottom[c] > bottom) bottom = b.bottom[c];
  }
  return top <= bottom ? { top, bottom } : null;
}

/** True when the rect comes within `margin` px of the trace in its x-span. */
export function hitsTrace(r: Rect, b: TraceBand, margin = 4): boolean {
  return bandOverlaps(b, r.x - margin, r.w + 2 * margin, r.y - margin, r.y + r.h + margin);
}

/** True when the trace passes through the box [x, x + w] × [ya, yb]. */
function bandOverlaps(b: TraceBand, x: number, w: number, ya: number, yb: number): boolean {
  const c0 = Math.max(0, Math.floor(x - b.x0));
  const c1 = Math.min(b.top.length - 1, Math.ceil(x + w - b.x0));
  for (let c = c0; c <= c1; c++) {
    const t = b.top[c];
    if (Number.isNaN(t)) continue;
    if (t <= yb && b.bottom[c] >= ya) return true;
  }
  return false;
}

export type CalloutSpot = "left" | "right" | "above-left" | "above-right" | "below-left" | "below-right";
/** Horizontal offsets (px) tried for the above / below spots. */
export const CALLOUT_SHIFTS = [0, 24, 48, 72, 96];

/** Candidate rects around the peak dot: beside it, then above or below the trace on either side. */
export function calloutSpots(dot: { x: number; y: number }, size: { w: number; h: number }, band: TraceBand | null): { spot: CalloutSpot; rect: Rect }[] {
  const leftX = dot.x - 10 - size.w;
  const rightX = dot.x + 10;
  const out: { spot: CalloutSpot; rect: Rect }[] = [
    { spot: "left", rect: { x: leftX, y: dot.y - 8, w: size.w, h: size.h } },
    { spot: "right", rect: { x: rightX, y: dot.y - 8, w: size.w, h: size.h } },
  ];
  // Above / below the trace, sliding away from the dot in 24 px steps: next to a steep rise
  // the box finds room a little further along, still beside the peak it names.
  for (const vertical of ["above", "below"] as const) {
    for (const side of ["left", "right"] as const) {
      for (const shift of CALLOUT_SHIFTS) {
        const x = side === "left" ? leftX - shift : rightX + shift;
        const e = band ? bandExtent(band, x - 4, size.w + 8) : null;
        const spot = `${vertical}-${side}` as CalloutSpot;
        // The dot itself is a reserved rect, so only the trace under the box decides its y.
        if (vertical === "above") {
          const bottom = (e ? e.top : dot.y - 4) - 6;
          out.push({ spot, rect: { x, y: bottom - size.h, w: size.w, h: size.h } });
        } else {
          const top = (e ? e.bottom : dot.y + 4) + 6;
          out.push({ spot, rect: { x, y: top, w: size.w, h: size.h } });
        }
      }
    }
  }
  return out;
}

/**
 * Place the peak annotation clear of the footprint trace: the two-line callout at the first
 * free spot, else the one-line label, else nothing in the plot (the gutter caption says it).
 * A spot is rejected if it leaves `bounds` (inset 2), hits a reserved rect, or comes within
 * 4 px of the trace.
 */
export function planPeakClear(o: {
  dot: { x: number; y: number };
  callout: { w: number; h: number };
  label: { w: number; h: number };
  bounds: Rect;
  reserved: readonly Rect[];
  trace: TraceBand | null;
}): { kind: "callout" | "label"; spot: CalloutSpot; rect: Rect } | { kind: "gutter"; spot: null; rect: null } {
  const inside = (r: Rect) => r.x >= o.bounds.x + 2 && r.y >= o.bounds.y + 2 && r.x + r.w <= o.bounds.x + o.bounds.w - 2 && r.y + r.h <= o.bounds.y + o.bounds.h - 2;
  const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const kind of ["callout", "label"] as const) {
    const size = kind === "callout" ? o.callout : o.label;
    for (const c of calloutSpots(o.dot, size, o.trace)) {
      if (!inside(c.rect)) continue;
      if (o.reserved.some((r) => hit(r, c.rect))) continue;
      if (o.trace && hitsTrace(c.rect, o.trace, 4)) continue;
      return { kind, spot: c.spot, rect: c.rect };
    }
  }
  return { kind: "gutter", spot: null, rect: null };
}
