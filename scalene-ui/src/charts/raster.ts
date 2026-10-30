/**
 * "When it ran" strips on canvas (DESIGN.md §3.3, §4.4.5–4.4.6, §4.9):
 * histogram strips (2 CSS px bins, each row scaled to its own peak), sample
 * ticks / density bands for the linked "ran here" overlay, and the 1 × 6 px
 * allocation rug. Binning is pure and unit-tested; drawing takes resolved
 * colours (callers read tokens through `theme.tokens()`).
 */

import type { Rect } from "./placement";

/** CSS px per histogram bin. */
export const BIN_PX = 2;
/** Above this many samples, "ran here" ticks become a density band. */
export const TICK_DENSITY_LIMIT = 300;

/** Number of 2 px bins for a plot width. */
export function binCount(widthPx: number, binPx = BIN_PX): number {
  return Math.max(1, Math.floor(widthPx / binPx));
}

/**
 * Histogram of times over `[t0, t1)` into `n` bins. Times outside the
 * domain are ignored; `t1` itself lands in the last bin.
 */
export function binTimes(times: ArrayLike<number>, t0: number, t1: number, n: number, out?: Float32Array): Float32Array {
  const bins = out && out.length === n ? (out.fill(0), out) : new Float32Array(n);
  const span = t1 - t0;
  if (!(span > 0) || n <= 0) return bins;
  const scale = n / span;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t < t0 || t > t1) continue;
    bins[Math.min(n - 1, Math.floor((t - t0) * scale))]++;
  }
  return bins;
}

export function binMax(bins: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i] > m) m = bins[i];
  return m;
}

export interface RasterStyle {
  fill: string;
  baseline: string;
  /** Row opacity (linked highlighting dims other rows to 0.4). */
  alpha?: number;
}

/** Histogram strip: bar height ∝ count / row max, 1 px baseline. */
export function drawRaster(ctx: CanvasRenderingContext2D, bins: ArrayLike<number>, r: Rect, style: RasterStyle): void {
  ctx.save();
  ctx.globalAlpha = style.alpha ?? 1;
  ctx.fillStyle = style.baseline;
  ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
  const max = binMax(bins);
  if (max > 0) {
    const bw = r.w / bins.length;
    const usable = r.h - 1;
    ctx.fillStyle = style.fill;
    for (let i = 0; i < bins.length; i++) {
      const v = bins[i];
      if (v <= 0) continue;
      const h = Math.max(1, (v / max) * usable);
      ctx.fillRect(r.x + i * bw, r.y + usable - h, Math.max(1, bw - 0.25), h);
    }
  }
  ctx.restore();
}

/** Most opaque a "ran here" column may get (§4.4.6: density band max 0.5). */
export const TICK_ALPHA_CAP = 0.5;
/** A column with one sample keeps this share of the tick alpha, so isolated samples stay visible. */
const TICK_ALPHA_FLOOR = 0.35;

/**
 * Per-column opacity of the "ran here" overlay. Samples are binned per `binPx` column first,
 * so overlapping ticks never compound (round 1: ~9 samples per pixel at 0.3 alpha painted a
 * ~96 % opaque slab over the footprint and its peak). The densest column gets `alpha`
 * (capped at 0.5); a column with one sample gets 35 % of it; alpha ∝ count in between.
 */
export function tickColumnAlphas(
  times: ArrayLike<number>,
  domain: readonly [number, number],
  widthPx: number,
  alpha: number,
  binPx = 1,
): { bins: Float32Array; alphas: Float64Array } {
  const n = binCount(widthPx, binPx);
  const bins = binTimes(times, domain[0], domain[1], n);
  const alphas = new Float64Array(n);
  const max = binMax(bins);
  const top = Math.min(TICK_ALPHA_CAP, alpha);
  if (max <= 0) return { bins, alphas };
  for (let i = 0; i < n; i++) {
    const c = bins[i];
    if (c > 0) alphas[i] = top * (TICK_ALPHA_FLOOR + (1 - TICK_ALPHA_FLOOR) * (c / max));
  }
  return { bins, alphas };
}

/**
 * "Ran here" overlay through `r`: one column per CSS px (2 px bins above 300 samples), each at
 * the opacity of `tickColumnAlphas` (never above 0.5, never compounding). `holes` are rects the
 * overlay must leave clear (e.g. the peak callout), so data annotations stay readable.
 */
export function drawSampleTicks(
  ctx: CanvasRenderingContext2D,
  times: ArrayLike<number>,
  domain: readonly [number, number],
  r: Rect,
  color: string,
  alpha: number,
  holes: readonly Rect[] = [],
): void {
  const [t0, t1] = domain;
  if (!(t1 - t0 > 0) || times.length === 0 || r.w <= 0) return;
  const binPx = times.length > TICK_DENSITY_LIMIT ? BIN_PX : 1;
  const { alphas } = tickColumnAlphas(times, domain, r.w, alpha, binPx);
  const bw = r.w / alphas.length;
  ctx.save();
  if (holes.length) {
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    for (const hole of holes) ctx.rect(hole.x + hole.w, hole.y, -hole.w, hole.h);
    ctx.clip("evenodd");
  }
  ctx.fillStyle = color;
  for (let i = 0; i < alphas.length; i++) {
    if (alphas[i] <= 0) continue;
    ctx.globalAlpha = alphas[i];
    ctx.fillRect(r.x + i * bw, r.y, bw, r.h);
  }
  ctx.restore();
}

/** Allocation rug: 1 × `r.h` (6 px) ticks at 85 % alpha. */
export function drawRug(ctx: CanvasRenderingContext2D, times: ArrayLike<number>, domain: readonly [number, number], r: Rect, color: string): void {
  const [t0, t1] = domain;
  const span = t1 - t0;
  if (!(span > 0)) return;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = color;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t < t0 || t > t1) continue;
    ctx.fillRect(Math.round(r.x + ((t - t0) / span) * r.w), r.y, 1, r.h);
  }
  ctx.restore();
}
