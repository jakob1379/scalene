/**
 * DOM meters (DESIGN.md §3.3): a `--sunken` track with fill segments in
 * order Python → native → system (hatched), no gaps, ≥ 2 px per non-zero
 * segment. At most four nodes per meter (track + three segments); the
 * 25/50/75 % graduations are a background on the track, and the optional
 * average tick (memory column) reuses a segment slot only when needed.
 * Colours are tokens; geometry is inline so the meter renders without
 * component CSS (styles may refine `.meter` / `.meter__seg`).
 */

export interface MeterSegment {
  value: number;
  /** Colour token without `--`, e.g. "cpu-py". */
  token: string;
  hatch?: "system" | "waiting";
}

export interface MeterOptions {
  segments: readonly MeterSegment[];
  /** Value that fills the whole track (e.g. row #1, or 100 for absolute meters). */
  max: number;
  /** Track height in px (6 default, 8 readouts, 10 hotspots). */
  height?: number;
  /** CSS width of the track (default 100 %). */
  width?: string;
  graduations?: boolean;
  /** Position (same unit as values) of a 1 px `--fg-2` tick, e.g. `n_avg_mb`. */
  tick?: number | null;
  className?: string;
}

/** Fractions of the track per segment, clamped so their sum is ≤ 1. */
export function segmentFractions(segments: readonly Pick<MeterSegment, "value">[], max: number): number[] {
  if (!(max > 0)) return segments.map(() => 0);
  let left = 1;
  return segments.map((s) => {
    const f = Math.min(left, Math.max(0, s.value / max));
    left -= f;
    return f;
  });
}

const HATCH: Record<NonNullable<MeterSegment["hatch"]>, string> = {
  // System time: --cpu-sys fill with --surface 45° lines at 55 % (4 px period).
  system:
    "repeating-linear-gradient(45deg, transparent 0 2.2px, color-mix(in srgb, var(--surface) 55%, transparent) 2.2px 2.83px)",
  // Waiting: --async at 35 % with --async 135° lines (5 px period).
  waiting: "repeating-linear-gradient(135deg, var(--async) 0 1px, transparent 1px 3.54px)",
};

const GRADUATIONS =
  "linear-gradient(90deg, transparent calc(25% - 0.5px), var(--grid-strong) calc(25% - 0.5px) calc(25% + 0.5px), transparent calc(25% + 0.5px) calc(50% - 0.5px), var(--grid-strong) calc(50% - 0.5px) calc(50% + 0.5px), transparent calc(50% + 0.5px) calc(75% - 0.5px), var(--grid-strong) calc(75% - 0.5px) calc(75% + 0.5px), transparent calc(75% + 0.5px))";

function styleSegment(el: HTMLElement, seg: MeterSegment, frac: number): void {
  const s = el.style;
  s.display = "block";
  s.flex = "none";
  s.height = "100%";
  s.width = `${(frac * 100).toFixed(3)}%`;
  s.minWidth = seg.value > 0 && frac > 0 ? "2px" : "0";
  if (seg.hatch === "waiting") {
    s.backgroundColor = "color-mix(in srgb, var(--async) 35%, transparent)";
    s.backgroundImage = HATCH.waiting;
  } else {
    s.backgroundColor = `var(--${seg.token})`;
    s.backgroundImage = seg.hatch ? HATCH[seg.hatch] : "none";
  }
}

/** Create a meter. */
export function meter(doc: Document, o: MeterOptions): HTMLElement {
  const track = doc.createElement("span");
  track.setAttribute("aria-hidden", "true");
  updateMeter(track, o);
  return track;
}

/** Update a meter in place (reuses segment nodes; node pools stay stable). */
export function updateMeter(track: HTMLElement, o: MeterOptions): void {
  const doc = track.ownerDocument;
  track.className = `meter${o.className ? ` ${o.className}` : ""}`;
  const ts = track.style;
  ts.position = "relative";
  ts.display = "flex";
  ts.overflow = "hidden";
  ts.height = `${o.height ?? 6}px`;
  ts.width = o.width ?? "100%";
  ts.borderRadius = "var(--r-xs)";
  ts.background = o.graduations ? `${GRADUATIONS}, var(--sunken)` : "var(--sunken)";
  const fracs = segmentFractions(o.segments, o.max);
  const wantTick = o.tick != null && o.max > 0 && o.tick > 0;
  const needed = o.segments.length + (wantTick ? 1 : 0);
  while (track.children.length > needed) track.lastElementChild?.remove();
  while (track.children.length < needed) {
    const seg = doc.createElement("span");
    seg.className = "meter__seg";
    track.appendChild(seg);
  }
  o.segments.forEach((seg, i) => styleSegment(track.children[i] as HTMLElement, seg, fracs[i]));
  if (wantTick) {
    const tick = track.children[o.segments.length] as HTMLElement;
    tick.className = "meter__tick";
    const pos = Math.min(1, (o.tick as number) / o.max);
    tick.style.cssText = `position:absolute;top:0;bottom:0;width:1px;left:calc(${(pos * 100).toFixed(3)}% - 0.5px);background:var(--fg-2)`;
  }
}
