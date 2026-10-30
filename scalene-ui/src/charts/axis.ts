/**
 * Axes and gridlines (DESIGN.md §4.4.1, §4.11.4, §4.12.2, §7.5).
 *
 * Tick math is pure (unit-tested); renderers come in two flavours: DOM
 * strips with the upstream test-contract class names (`timeline-axis`,
 * `timeline-gridlines`, `memory-axis`, `memory-gridlines`) and canvas
 * drawers for charts that paint their own axis. Colours are tokens only.
 */

import {
  formatMemoryTickLabel,
  formatTimelineTickLabel,
  niceMemStep,
  pickNiceTickInterval,
  TICK_SPACING_PX,
} from "../core/format";
import { crisp } from "../core/canvas";
import type { Rect } from "./placement";

export { formatMemoryTickLabel, formatTimelineTickLabel, niceMemStep, pickNiceTickInterval } from "../core/format";
/** Snap a coordinate to the device-pixel grid for crisp 1 px lines (one implementation, in core/canvas). */
export { crisp };

export interface Tick {
  value: number;
  /** Position in the domain, 0 … 1. */
  frac: number;
  label: string;
  /** Label anchoring so the first/last labels stay inside the plot. */
  edge: "start" | "middle" | "end";
}

export interface TickSet {
  step: number;
  ticks: Tick[];
}

const EMPTY_TICKS: TickSet = { step: 0, ticks: [] };

/** Multiples of `step` inside `[d0, d1]` (multiplication, not accumulation, keeps them exact). */
function multiples(d0: number, d1: number, step: number): number[] {
  const out: number[] = [];
  const eps = step * 1e-7;
  const k0 = Math.ceil(d0 / step - 1e-7);
  for (let k = k0; ; k++) {
    const v = k * step;
    if (v > d1 + eps) break;
    out.push(Math.abs(v) < eps ? 0 : v);
    if (out.length > 1000) break;
  }
  return out;
}

function edgeOf(frac: number, stepFrac: number): Tick["edge"] {
  if (frac <= Math.min(0.02, stepFrac * 0.25)) return "start";
  if (frac >= 1 - Math.min(0.02, stepFrac * 0.25)) return "end";
  return "middle";
}

function toTicks(values: number[], d0: number, d1: number, step: number, label: (v: number) => string): TickSet {
  const span = d1 - d0;
  const stepFrac = step / span;
  return {
    step,
    ticks: values.map((v) => {
      const frac = (v - d0) / span;
      return { value: v, frac, label: label(v), edge: edgeOf(frac, stepFrac) };
    }),
  };
}

/** Time ticks for a visible domain `[d0, d1]` (s) over `widthPx`. */
export function timeTicks(d0: number, d1: number, widthPx: number): TickSet {
  const span = d1 - d0;
  const step = pickNiceTickInterval(span, widthPx);
  if (!(step > 0)) return EMPTY_TICKS;
  return toTicks(multiples(d0, d1, step), d0, d1, step, (v) => formatTimelineTickLabel(v, step));
}

/** Memory ticks over `[0, maxMiB]` with steps in the display unit. */
export function memoryTicks(maxMiB: number, widthPx: number): TickSet {
  return memoryTicksN(maxMiB, Math.max(2, Math.floor(widthPx / TICK_SPACING_PX)));
}

/** Memory ticks over `[0, maxMiB]` with at most `maxTicks` steps. */
export function memoryTicksN(maxMiB: number, maxTicks: number): TickSet {
  const step = niceMemStep(maxMiB, maxTicks);
  if (!(step > 0)) return EMPTY_TICKS;
  return toTicks(multiples(0, maxMiB, step), 0, maxMiB, step, (v) => formatMemoryTickLabel(v, step, maxMiB));
}

export interface MemoryScale {
  /** Top of the y domain (a step multiple ≥ the data max). */
  top: number;
  step: number;
  ticks: TickSet;
}

/**
 * Y scale for footprint charts: binary nice steps (≤ `maxTicks`), domain
 * from 0 to the first step multiple at or above the data max, so the peak
 * never touches the channel top.
 */
export function memoryScale(maxMiB: number, maxTicks = 3): MemoryScale {
  if (!(maxMiB > 0)) return { top: 1, step: 0, ticks: EMPTY_TICKS };
  const step = niceMemStep(maxMiB, maxTicks);
  const top = Math.max(step, Math.ceil((maxMiB * 1.0001) / step) * step);
  // Labels use the unit niceMemStep chose from the data max (one unit per axis).
  return { top, step, ticks: toTicks(multiples(0, top, step), 0, top, step, (v) => formatMemoryTickLabel(v, step, maxMiB)) };
}

// ── DOM renderers (upstream names, §7.5) ────────────────────────────────────

function ownChild(host: HTMLElement, cls: string): HTMLElement {
  for (const c of Array.from(host.children)) {
    if (c instanceof HTMLElement && c.classList.contains(cls)) return c;
  }
  const el = host.ownerDocument.createElement("div");
  el.className = cls;
  el.setAttribute("aria-hidden", "true");
  host.appendChild(el);
  return el;
}

const EDGE_TRANSFORM: Record<Tick["edge"], string> = {
  start: "translateX(0)",
  middle: "translateX(-50%)",
  end: "translateX(-100%)",
};

/** Fill an axis strip with tick marks and labels (reuses the element). */
function renderAxisStrip(host: HTMLElement, cls: string, set: TickSet): HTMLElement {
  const el = ownChild(host, cls);
  el.style.position = "relative";
  el.replaceChildren();
  for (const t of set.ticks) {
    const pos = `${(t.frac * 100).toFixed(4)}%`;
    const mark = host.ownerDocument.createElement("span");
    mark.className = "axis-tick";
    mark.style.cssText = `position:absolute;left:${pos};bottom:0;width:1px;height:4px;background:var(--grid-strong)`;
    const label = host.ownerDocument.createElement("span");
    label.className = "axis-label";
    label.textContent = t.label;
    label.style.cssText =
      `position:absolute;left:${pos};top:0;transform:${EDGE_TRANSFORM[t.edge]};white-space:nowrap;` +
      "font:var(--type-caption);font-variant-numeric:tabular-nums;color:var(--fg-3);padding:0 2px";
    el.append(mark, label);
  }
  return el;
}

/** Fill a gridline layer: 1 px `--grid` verticals at each tick, through the whole chart. */
function renderGridLayer(host: HTMLElement, cls: string, set: TickSet): HTMLElement {
  const el = ownChild(host, cls);
  el.style.cssText = "position:absolute;inset:0;pointer-events:none";
  el.replaceChildren();
  for (const t of set.ticks) {
    const line = host.ownerDocument.createElement("span");
    line.style.cssText = `position:absolute;left:${(t.frac * 100).toFixed(4)}%;top:0;bottom:0;width:1px;background:var(--grid)`;
    el.appendChild(line);
  }
  return el;
}

/** `.timeline-axis` strip for the time domain `[d0, d1]` drawn over `widthPx`. */
export function renderTimelineAxis(host: HTMLElement, domain: readonly [number, number], widthPx: number): { el: HTMLElement; ticks: TickSet } {
  const ticks = timeTicks(domain[0], domain[1], widthPx);
  return { el: renderAxisStrip(host, "timeline-axis", ticks), ticks };
}

/** `.timeline-gridlines` layer (absolute, fills `host`) for the given ticks. */
export function renderTimelineGridlines(host: HTMLElement, ticks: TickSet): HTMLElement {
  return renderGridLayer(host, "timeline-gridlines", ticks);
}

/** `.memory-axis` strip over `[0, maxMiB]` (memory flame graph, §4.11.4). */
export function renderMemoryAxis(host: HTMLElement, maxMiB: number, widthPx: number): { el: HTMLElement; ticks: TickSet } {
  const ticks = memoryTicks(maxMiB, widthPx);
  return { el: renderAxisStrip(host, "memory-axis", ticks), ticks };
}

/** `.memory-gridlines` layer for the given ticks. */
export function renderMemoryGridlines(host: HTMLElement, ticks: TickSet): HTMLElement {
  return renderGridLayer(host, "memory-gridlines", ticks);
}

// ── Canvas drawers ──────────────────────────────────────────────────────────


/** 1 px vertical gridlines at each tick across `rect`. */
export function drawVGridlines(ctx: CanvasRenderingContext2D, set: TickSet, rect: Rect, color: string, dpr = 1): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1 / dpr;
  ctx.beginPath();
  for (const t of set.ticks) {
    const x = crisp(rect.x + t.frac * rect.w, dpr);
    ctx.moveTo(x, rect.y);
    ctx.lineTo(x, rect.y + rect.h);
  }
  ctx.stroke();
  ctx.restore();
}

/** 1 px horizontal gridlines for y ticks (`frac` 0 = bottom of `rect`). */
export function drawHGridlines(ctx: CanvasRenderingContext2D, set: TickSet, rect: Rect, color: string, dpr = 1): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1 / dpr;
  ctx.beginPath();
  for (const t of set.ticks) {
    const y = crisp(rect.y + rect.h - t.frac * rect.h, dpr);
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.w, y);
  }
  ctx.stroke();
  ctx.restore();
}

export interface AxisLabelStyle {
  font: string;
  color: string;
}

/**
 * Time-axis labels below `rect` (baseline at `y`); first/last labels are
 * anchored inward. Returns the label rects for collision tests.
 */
export function drawTimeLabels(ctx: CanvasRenderingContext2D, set: TickSet, rect: Rect, y: number, style: AxisLabelStyle): Rect[] {
  ctx.save();
  ctx.font = style.font;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  const out: Rect[] = [];
  let right = -Infinity;
  for (const t of set.ticks) {
    const w = ctx.measureText(t.label).width;
    const x = rect.x + t.frac * rect.w;
    const left = t.edge === "start" ? x : t.edge === "end" ? x - w : x - w / 2;
    if (left < right + 6) continue; // never let labels touch
    ctx.textAlign = "left";
    ctx.fillText(t.label, left, y);
    out.push({ x: left, y: y - 11, w, h: 14 });
    right = left + w;
  }
  ctx.restore();
  return out;
}
