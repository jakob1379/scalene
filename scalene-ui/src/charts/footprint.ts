/**
 * Footprint area + line, peak marker and peak callout on canvas
 * (DESIGN.md §3.3, §4.4.7, §4.13.2). Used by the scope MEMORY channel, the
 * timeline memory row, the Memory section chart and the lens chart. Colours
 * come from `theme.tokens()`; dark theme adds a glow scaled by `--glow`.
 */

import type { ThemeApi } from "../core/theme";
import { m4 } from "../model/memory";
import { withAlpha } from "./color";
import { traceBand, type PeakPlan, type Point, type Rect, type Size, type TraceBand } from "./placement";

export interface FootprintOptions {
  rect: Rect;
  /** Visible time domain (s). */
  domain: readonly [number, number];
  /** Top of the y domain (MiB); 0 sits at the bottom of `rect`. */
  yMax: number;
  theme: ThemeApi;
  /** Line colour token (default "mem-py"; the lens uses "line-strong"). */
  token?: string;
  /** Area only (no line), e.g. the lens's grey program footprint. */
  areaOnly?: boolean;
  /** Clip drawing to x ≤ clipX (intro sweep). */
  clipX?: number;
}

export interface Scales {
  x(t: number): number;
  y(mb: number): number;
  t(x: number): number;
}

export function footprintScales(rect: Rect, domain: readonly [number, number], yMax: number): Scales {
  const [t0, t1] = domain;
  const span = t1 - t0 || 1;
  const top = yMax > 0 ? yMax : 1;
  return {
    x: (t) => rect.x + ((t - t0) / span) * rect.w,
    y: (mb) => rect.y + rect.h - (Math.max(0, mb) / top) * rect.h,
    t: (x) => t0 + ((x - rect.x) / rect.w) * span,
  };
}

/** At or above one turn-around of the trace per this many CSS px, a series draws as an envelope. */
export const ENVELOPE_PX_PER_TURN = 6;
/** Envelope bin width in CSS px. */
export const ENVELOPE_BIN_PX = 12;

export interface EnvelopeBins {
  n: number;
  min: Float64Array;
  max: Float64Array;
  mean: Float64Array;
  /** Local extrema (direction changes) of the raw series inside each bin. */
  extrema: Uint16Array;
  /** Samples per bin (0 = empty bin). */
  count: Uint32Array;
}

/** The footprint polyline as drawFootprint draws it (same M4 points and scales), per 1 px column. */
export function footprintTrace(samples: Float64Array, rect: Rect, domain: readonly [number, number], yMax: number): TraceBand {
  const s = footprintScales(rect, domain, yMax);
  const pts = m4(samples, domain[0], domain[1], rect.w);
  const xy = new Float64Array(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    xy[i] = s.x(pts[i]);
    xy[i + 1] = s.y(pts[i + 1]);
  }
  return traceBand(xy, rect.x, rect.w);
}

/** Local extrema (direction changes) of a `[t, mb, …]` series inside `[t0, t1]`. */
export function turnArounds(samples: Float64Array, t0: number, t1: number): number {
  let turns = 0;
  let prevV = NaN;
  let prevDir = 0;
  for (let k = 0; k < samples.length / 2; k++) {
    const t = samples[2 * k];
    if (t < t0 || t > t1) continue;
    const v = samples[2 * k + 1];
    if (prevV === prevV) {
      const dir = v > prevV ? 1 : v < prevV ? -1 : 0;
      if (dir !== 0) {
        if (prevDir !== 0 && dir !== prevDir) turns++;
        prevDir = dir;
      }
    }
    prevV = v;
  }
  return turns;
}

/**
 * Envelope bin count for a series drawn `widthPx` wide, or 0 when it should stay a polyline:
 * a series that turns around at least once per 6 px (round 1: example.json's allocation
 * sawtooth drew ~70 full-height spikes) gets 12 px bins.
 */
export function envelopeBinCount(samples: Float64Array, t0: number, t1: number, widthPx: number): number {
  if (!(widthPx > 0) || samples.length / 2 <= widthPx / 4) return 0;
  const turns = turnArounds(samples, t0, t1);
  if (turns < widthPx / ENVELOPE_PX_PER_TURN) return 0;
  // Bins wide enough to hold whole oscillations, so the mean line is calm (≥ 8 bins).
  return Math.max(8, Math.floor(widthPx / ENVELOPE_BIN_PX));
}

/** Per-bin min / max / mean of a `[t, mb, …]` series over `[t0, t1]` and its turn-arounds. */
export function envelopeBins(samples: Float64Array, t0: number, t1: number, nBins: number): EnvelopeBins {
  const n = Math.max(1, Math.floor(nBins));
  const min = new Float64Array(n).fill(Infinity);
  const max = new Float64Array(n).fill(-Infinity);
  const mean = new Float64Array(n);
  const extrema = new Uint16Array(n);
  const count = new Uint32Array(n);
  const m = samples.length / 2;
  const span = t1 - t0;
  if (!(span > 0)) return { n, min, max, mean, extrema, count };
  let prevV = NaN;
  let prevDir = 0;
  for (let k = 0; k < m; k++) {
    const t = samples[2 * k];
    if (t < t0 || t > t1) continue;
    const v = Math.max(0, samples[2 * k + 1]);
    const b = Math.min(n - 1, Math.floor(((t - t0) / span) * n));
    if (v < min[b]) min[b] = v;
    if (v > max[b]) max[b] = v;
    mean[b] += v;
    count[b]++;
    if (prevV === prevV) {
      const dir = v > prevV ? 1 : v < prevV ? -1 : 0;
      if (dir !== 0) {
        if (prevDir !== 0 && dir !== prevDir && extrema[b] < 65535) extrema[b]++;
        prevDir = dir;
      }
    }
    prevV = v;
  }
  for (let b = 0; b < n; b++) if (count[b] > 0) mean[b] /= count[b];
  return { n, min, max, mean, extrema, count };
}

/**
 * Draw the series as an area from y = 0 plus a 1.5 px line. A dense, oscillating series
 * (`envelopeBinCount` > 0; round 1: example.json, 2,846 samples → a glowing comb of
 * full-height spikes) draws as a min–max envelope band (the token at 35 %) with the per-bin
 * mean as its line and no glow; the area then sits under the mean. Other series keep the
 * exact polyline (M4 above 2 × width). The peak marker still marks the true maximum.
 */
export function drawFootprint(ctx: CanvasRenderingContext2D, samples: Float64Array, o: FootprintOptions): void {
  const m = samples.length / 2;
  if (m === 0) return;
  const s = footprintScales(o.rect, o.domain, o.yMax);
  const tokens = o.theme.tokens();
  const color = tokens[o.token ?? "mem-py"] ?? tokens["mem-py"];
  const dark = o.theme.current() === "dark";
  const glow = o.theme.num("glow");
  const base = o.rect.y + o.rect.h;
  const nBins = envelopeBinCount(samples, o.domain[0], o.domain[1], o.rect.w);
  const env = nBins > 0 ? envelopeBins(samples, o.domain[0], o.domain[1], nBins) : null;
  const dense = env !== null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(o.rect.x, o.rect.y - 4, (o.clipX ?? o.rect.x + o.rect.w) - o.rect.x, o.rect.h + 8);
  ctx.clip();
  let trace: () => { x0: number; x1: number } | null;
  if (env) {
    const bw = o.rect.w / env.n;
    const xs: number[] = [];
    const lo: number[] = [];
    const hi: number[] = [];
    const mid: number[] = [];
    for (let b = 0; b < env.n; b++) {
      if (env.count[b] === 0) continue;
      xs.push(o.rect.x + (b + 0.5) * bw);
      lo.push(s.y(env.min[b]));
      hi.push(s.y(env.max[b]));
      mid.push(s.y(env.mean[b]));
    }
    trace = () => {
      if (!xs.length) return null;
      ctx.moveTo(xs[0], mid[0]);
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], mid[i]);
      return { x0: xs[0], x1: xs[xs.length - 1] };
    };
    if (!o.areaOnly && xs.length) {
      // Envelope band: the range the trace sweeps within each bin, as one smooth shape.
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(xs[0], hi[0]);
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], hi[i]);
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], lo[i]);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    const pts = m4(samples, o.domain[0], o.domain[1], o.rect.w);
    const n = pts.length / 2;
    trace = () => {
      ctx.moveTo(s.x(pts[0]), s.y(pts[1]));
      for (let i = 1; i < n; i++) ctx.lineTo(s.x(pts[2 * i]), s.y(pts[2 * i + 1]));
      return { x0: s.x(pts[0]), x1: s.x(pts[2 * (n - 1)]) };
    };
  }
  ctx.beginPath();
  const ends = trace();
  if (ends) {
    ctx.lineTo(ends.x1, base);
    ctx.lineTo(ends.x0, base);
    ctx.closePath();
    ctx.globalAlpha = o.areaOnly ? 1 : dark ? 0.18 : 0.14;
    ctx.fillStyle = color;
    ctx.fill();
  }
  if (!o.areaOnly && ends) {
    ctx.globalAlpha = 1;
    ctx.beginPath();
    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    if (dark && glow > 0 && !dense) {
      ctx.shadowBlur = 8 * glow;
      ctx.shadowColor = withAlpha(color, 0.6);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Peak marker: 4 px ring, 1.5 px `--mem-py` stroke, `--surface` fill (`scale`/`alpha` for the M23 pulse). */
export function drawPeakMarker(ctx: CanvasRenderingContext2D, at: Point, theme: ThemeApi, scale = 1, alpha = 1): void {
  const t = theme.tokens();
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 4 * scale, 0, Math.PI * 2);
  ctx.fillStyle = t["surface"];
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = t["mem-py"];
  ctx.stroke();
  ctx.restore();
}

export interface CalloutText {
  /** "peak 3.11 GiB" (12 px 600). */
  title: string;
  /** "52.9 s · train.py:120" (11 px `--fg-2`); omitted for the one-line label. */
  detail?: string;
}

const PAD_X = 6;
const PAD_Y = 4;
const TITLE_H = 15;
const DETAIL_H = 14;

function fonts(theme: ThemeApi): { title: string; detail: string } {
  const ui = theme.tokens()["font-ui"] || "system-ui, sans-serif";
  return { title: `600 12px ${ui}`, detail: `400 11px ${ui}` };
}

/** Box sizes of the two-line callout and the one-line label (for placement). */
export function measureCallout(ctx: CanvasRenderingContext2D, text: CalloutText, theme: ThemeApi): { callout: Size; label: Size } {
  const f = fonts(theme);
  ctx.save();
  ctx.font = f.title;
  const tw = ctx.measureText(text.title).width;
  ctx.font = f.detail;
  const dw = text.detail ? ctx.measureText(text.detail).width : 0;
  ctx.restore();
  return {
    callout: { w: Math.ceil(Math.max(tw, dw) + 2 * PAD_X), h: TITLE_H + (text.detail ? DETAIL_H : 0) + 2 * PAD_Y },
    label: { w: Math.ceil(tw + 2 * PAD_X), h: TITLE_H + 2 * PAD_Y },
  };
}

/** Draw a planned callout (glass box, `--r-sm` radius). The gutter plan draws nothing. */
export function drawCallout(ctx: CanvasRenderingContext2D, plan: PeakPlan, text: CalloutText, theme: ThemeApi, alpha = 1): void {
  if (plan.kind === "gutter") return;
  const t = theme.tokens();
  const f = fonts(theme);
  const r = plan.rect;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  roundedRect(ctx, r, 6);
  ctx.fillStyle = t["glass"] || t["raised"];
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = t["glass-line"] || t["line"];
  ctx.stroke();
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.font = f.title;
  ctx.fillStyle = t["fg"];
  ctx.fillText(text.title, r.x + PAD_X, r.y + PAD_Y + 1);
  if (plan.kind === "callout" && text.detail) {
    ctx.font = f.detail;
    ctx.fillStyle = t["fg-2"];
    ctx.fillText(text.detail, r.x + PAD_X, r.y + PAD_Y + TITLE_H + 1);
  }
  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const k = Math.min(radius, r.w / 2, r.h / 2);
  ctx.moveTo(r.x + k, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, k);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, k);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, k);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, k);
  ctx.closePath();
}
