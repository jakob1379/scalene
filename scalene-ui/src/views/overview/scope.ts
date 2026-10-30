/**
 * Instrument scope — the hero motion graphic (DESIGN.md §4.4, §5.2 M4, §5.3.1).
 *
 * The whole run on one time axis [0, tMax] as stacked channels: PHASE,
 * MEMORY (+ RUG), THREADS, TASKS and TOP LINES. Two canvases: the base holds
 * chrome (grid, axes, labels) and data (traces, areas, strips, phase cells);
 * the overlay holds the beam, crosshair, brush, linked overlays and the peak
 * pulse. Chrome and data are cached in offscreen canvases so the intro sweep
 * only composites (data clipped to x ≤ beam) and its last frame is the static
 * render, pixel for pixel.
 */

import { drawTimeLabels, drawHGridlines, drawVGridlines, memoryScale, timeTicks, type TickSet } from "../../charts/axis";
import { drawCallout, drawFootprint, drawPeakMarker, footprintScales, footprintTrace, measureCallout, type CalloutText } from "../../charts/footprint";
import { contains, dotRect, intersects, placeYTicks, type PeakPlan, type Rect } from "../../charts/placement";
import { binCount, binTimes, drawRug, drawSampleTicks } from "../../charts/raster";
import { alpha, clearCanvas, createCanvasPair, crisp, fitText, hatch, monoFont, observeSize, roundRect, setFont, uiFont, type CanvasPair } from "../../core/canvas";
import type { Source } from "../../core/bus";
import { createDisposer, h, listen } from "../../core/dom";
import { idle } from "../../core/schedule";
import { fmtCount, fmtLoc, fmtMem, fmtRange, fmtTime } from "../../core/format";
import { icon } from "../../core/icons";
import { EASE, DUR } from "../../core/motion";
import { createIntroStage, type IntroStage } from "./scope-intro";
import type { Metric, Target } from "../../core/store";
import { sameTarget } from "../../core/store";
import { shortCode } from "../../model/headline";
import { spokenTime, unionTimes } from "../../model/hotspots";
import { CLS_GIL, CLS_IO } from "../../model/classify";
import { footprintAt, peakInfo, sampleTimes, type PeakInfo } from "../../model/memory";
import { functionAt, lineAt, type HotspotItem } from "../../model/model";
import type { Phase, ThreadBuckets, TimelineM } from "../../model/timeline";
import type { ViewContext } from "../app";
import {
  anyChannel,
  bucketCount,
  canvasHeight,
  channelRect,
  countTicks,
  effectivePresence,
  layoutChannels,
  layoutPhaseCells,
  maxConcurrent,
  phaseCellAt,
  planPeakClear,
  requiredHeight,
  scopeMetrics,
  threadBucketCount,
  topBarHeight,
  TOP_ROWS_ALONE,
  type CalloutSpot,
  type ChannelId,
  type ChannelPresence,
  type PhaseCell,
  type ScopeGeometry,
  type ScopeMetrics,
  type TraceBand,
} from "./scope-layout";

// ── Public surface ──────────────────────────────────────────────────────────

/** Samples of the linked line (§4.4.6). */
export interface LinkedLine {
  kind: "line" | "function" | "file";
  target: Target;
  label: string;
  cpu: Float64Array;
  mem: Float64Array;
  leak: boolean;
}

export interface Annotation {
  kind: "ytick" | "xtick" | "callout" | "chip" | "phase-label" | "channel-label" | "rank";
  rect: Rect;
  /** The rect the annotation must stay inside (its channel, row or header). */
  bounds: Rect;
  text?: string;
}

export interface ScopeDebug {
  width: number;
  height: number;
  plot: Rect;
  channels: { id: ChannelId; rect: Rect }[];
  ticks: Annotation[];
  callout: (Annotation & { plan: PeakPlan["kind"]; spot: CalloutSpot | null }) | null;
  /**
   * The footprint trace per 1 px column (CSS px): `[x, top, bottom]` triples, sampled from the
   * drawn polyline, so tests can prove that the callout never covers the data (review round 1).
   */
  trace: number[];
  /** THREADS: the width-independent y-scale top and the instantaneous concurrency maximum. */
  threads: { top: number; concurrent: number | null; buckets: number } | null;
  /** The figcaption text (accessible description of the signal). */
  description: string;
  chip: Annotation | null;
  phaseCells: { kind: string; rect: Rect; label: string | null; labelRect: Rect | null }[];
  /** Every annotation rect, for the pairwise-disjoint geometry test. */
  annotations: Annotation[];
  /** Last overlay draw time (ms), measured with performance.now(). */
  overlayMs: number;
  sweep: number;
  /** Intro diagnostics: stage builds and their shared origin (document timeline ms). */
  intro: { builds: { at: number; startTime: number | null; reason: string }[]; origin: number | null };
}

export interface ScopeHandle {
  /** The scope pane (header + figure), or an empty element when no channel exists. */
  el: HTMLElement;
  present: boolean;
  /**
   * False when the current layout mode leaves no drawable channel (e.g. a short host that
   * drops PHASE): the pane hides and the hotspots take the full width (§4.4.2).
   */
  drawable(): boolean;
  /** Called when `drawable()` changes. */
  onDrawable(cb: (on: boolean) => void): void;
  setTopLines(items: readonly HotspotItem[], metric: Metric): void;
  /** Linked overlay from a hotspot row (exact item) or a target from another view. */
  link(source: { item?: HotspotItem; target: Target | null }, from: Source): void;
  /**
   * Start the M4 sweep. `clock` resolves with the overview's intro origin (the first painted
   * frame); every stage animation is pinned to it, also after a mid-intro rebuild.
   */
  intro(instant: boolean, clock?: Promise<number>): void;
  /** Called when the instrument layout mode changes (side by side vs stacked). */
  setMode(mode: "side" | "stack"): void;
  /** Hover on a TOP LINES row (rank 1-based, or null). */
  onRowHover(cb: (rank: number | null) => void): void;
  debugLayout(): ScopeDebug;
  destroy(): void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type Tokens = Readonly<Record<string, string>>;

const MICRO_LS = "0.66px"; // 0.06em at 11 px
/** Scalene keeps up to 500 main-thread CPU sample times and 100 allocation events per line. */
const CPU_SAMPLES_KEPT = 500;
const MEM_EVENTS_KEPT = 100;


interface Readout {
  t: number;
  footprint: { mb: number; interpolated: boolean } | null;
  threads: { busy: number; wait: number; gil: number } | null;
  tasks: number | null;
  phase: Phase | null;
  leaf: { name: string; file: string; line: number; text: string | null } | null;
}

function letterSpacing(ctx: CanvasRenderingContext2D, v: string): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = v;
}

function makeCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

function sizeCanvas(c: HTMLCanvasElement, pair: CanvasPair): CanvasRenderingContext2D {
  const w = pair.base.width;
  const hh = pair.base.height;
  if (c.width !== w) c.width = w;
  if (c.height !== hh) c.height = hh;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  ctx.setTransform(pair.dpr, 0, 0, pair.dpr, 0, 0);
  return ctx;
}

/** Step-area path between two series (bucket k spans [x0 + k·bw, x0 + (k+1)·bw)). */
function stepBand(ctx: CanvasRenderingContext2D, lower: ArrayLike<number>, upper: ArrayLike<number>, x0: number, bw: number, y: (v: number) => number): void {
  const n = upper.length;
  ctx.beginPath();
  ctx.moveTo(x0, y(lower[0]));
  for (let k = 0; k < n; k++) {
    ctx.lineTo(x0 + k * bw, y(upper[k]));
    ctx.lineTo(x0 + (k + 1) * bw, y(upper[k]));
  }
  for (let k = n - 1; k >= 0; k--) {
    ctx.lineTo(x0 + (k + 1) * bw, y(lower[k]));
    ctx.lineTo(x0 + k * bw, y(lower[k]));
  }
  ctx.closePath();
}

function stepLine(ctx: CanvasRenderingContext2D, upper: ArrayLike<number>, x0: number, bw: number, y: (v: number) => number): void {
  ctx.beginPath();
  for (let k = 0; k < upper.length; k++) {
    const yy = y(upper[k]);
    if (k === 0) ctx.moveTo(x0, yy);
    else ctx.lineTo(x0 + k * bw, yy);
    ctx.lineTo(x0 + (k + 1) * bw, yy);
  }
}

/** Shorten code text to a pixel width, token-safe (shortCode first, then whole tokens). */
function fitCode(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  const text = s.trim();
  if (ctx.measureText(text).width <= maxW) return text;
  const charW = Math.max(4, ctx.measureText("0").width);
  for (let max = Math.floor(maxW / charW); max >= 6; max--) {
    const c = shortCode(text, max);
    if (c && ctx.measureText(c).width <= maxW) return c;
  }
  return fitText(ctx, text, maxW, "code");
}

/** A group named by its dominant phase: "handle_request(…) ×69" (token-safe), else the count. */
function dominantLabel(ctx: CanvasRenderingContext2D, dom: { label: string; count: number }, maxW: number, n: number): string {
  const suffix = ` ×${dom.count}`;
  const sw = ctx.measureText(suffix).width;
  const code = maxW - sw >= 24 ? fitCode(ctx, dom.label, maxW - sw) : "";
  if (code && ctx.measureText(code + suffix).width <= maxW) return code + suffix;
  return groupLabel(ctx, n, maxW);
}

/** "38 short phases" → "38 short" → "38" (whole words only). */
function groupLabel(ctx: CanvasRenderingContext2D, n: number, maxW: number): string {
  for (const s of [`${n} short phases`, `${n} short`, `${n}`]) if (ctx.measureText(s).width <= maxW) return s;
  return "";
}

function wrapWords(ctx: CanvasRenderingContext2D, s: string, maxW: number, maxLines: number): string[] {
  const words = s.split(" ");
  // Two lines: the most balanced break that fits, so a caption never ends in an orphan word
  // ("when they" / "ran" → "when" / "they ran").
  if (maxLines >= 2 && words.length >= 2 && ctx.measureText(s).width > maxW) {
    let best: string[] | null = null;
    let bestW = Infinity;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(" ");
      const b = words.slice(k).join(" ");
      const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
      if (w <= maxW && w < bestW) {
        best = [a, b];
        bestW = w;
      }
    }
    if (best) return best;
  }
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines);
    head[maxLines - 1] = fitText(ctx, lines.slice(maxLines - 1).join(" "), maxW, "end");
    return head;
  }
  return lines;
}

// ── Mount ───────────────────────────────────────────────────────────────────

export function mountScope(ctx: ViewContext): ScopeHandle {
  const { model, theme, store, bus } = ctx;
  const disposer = createDisposer();
  const tMax = model.tMax > 0 ? model.tMax : model.elapsed;
  const memSamples = model.memory && model.memory.samples.length >= 4 ? model.memory.samples : null;
  const peak: PeakInfo | null = memSamples ? peakInfo(memSamples) : null;
  const memMax = memSamples ? Math.max(model.memory?.peak ?? 0, peak?.mb ?? 0) : 0;
  const memScale = memoryScale(memMax, 3);
  const threads = model.sampling.threads;
  const mainInfo = threads.find((t) => t.main);
  const legacyThreads = threads.length > 0 && threads.every((t) => t.id === null);

  let topItems: HotspotItem[] = [];
  let topMetric: Metric = "time";
  let tl: TimelineM | null = null;
  let tasksPresent = model.caps.async && model.caps.timeline;

  const basePresence = (): ChannelPresence => ({
    phase: model.caps.timeline && (Boolean(mainInfo && mainInfo.samples > 0) || legacyThreads),
    memory: Boolean(memSamples),
    threads: model.caps.timeline && threads.length > 1,
    tasks: tasksPresent,
    topRows: topRowsFor(topItems, topMetric),
  });
  /** Ranked items available to TOP LINES (the layout mode then shows 5, or up to 8, §4.4.5). */
  function topRowsFor(items: readonly HotspotItem[], metric: Metric): number {
    const ok = metric === "memory" ? model.caps.memory : model.caps.cpuSamples;
    return ok ? Math.min(TOP_ROWS_ALONE, items.length) : 0;
  }

  // elapsed_time_sec = 0 → no scope (§4.0.8); the hotspots take the full card width.
  const potential = model.elapsed > 0 && tMax > 0 && anyChannel({ ...basePresence(), topRows: model.caps.cpuSamples || model.caps.memory ? 5 : 0 });
  const el = h("div", { class: "ov-scope" });
  if (!potential) {
    return {
      el,
      present: false,
      drawable: () => false,
      onDrawable() {},
      setTopLines() {},
      link() {},
      intro() {},
      setMode() {},
      onRowHover() {},
      debugLayout: () => ({ width: 0, height: 0, plot: { x: 0, y: 0, w: 0, h: 0 }, channels: [], ticks: [], callout: null, chip: null, phaseCells: [], annotations: [], overlayMs: 0, sweep: 1, intro: { builds: [], origin: null }, trace: [], threads: null, description: "" }),
      destroy() {},
    };
  }

  // ── DOM ──
  const descText = "the run over time";
  const desc = h("span", { class: "scope-desc" }, descText);
  const legend = h("div", { class: "scope-legend", "aria-hidden": "true" });
  const info = h("button", { type: "button", class: "icon-btn icon-btn-sm scope-info", "aria-label": "About this chart" }, icon("info"));
  const head = h("div", { class: "scope-head" }, h("span", { class: "micro scope-title m-reveal", style: { "--d": "90ms" } }, "Signal"), info, desc, legend);
  const helpId = "scope-help";
  const help = h(
    "p",
    { id: helpId, class: "visually-hidden" },
    "Left and right arrows move the time cursor by 1% of the run, Page Up and Page Down by 10%, Home and End jump to the start or end. Shift with an arrow extends a time range. Enter opens the line the main thread was running. Escape clears the range, then the selection.",
  );
  const caption = h("figcaption", { class: "visually-hidden" }, "");
  const host = h("div", { class: "scope-canvas" });
  const card = h("div", { class: "scope-card", "aria-hidden": "true" });
  const fig = h("figure", { class: "scope-fig" }, caption, host, help);
  el.append(head, fig);
  const pair = createCanvasPair(host, { interactive: true });
  host.append(card);
  const ov = pair.overlay;
  ov.setAttribute("role", "application");
  ov.setAttribute("aria-roledescription", "signal chart");
  ov.setAttribute("aria-label", "Run signal");
  ov.setAttribute("aria-describedby", helpId);
  ov.tabIndex = 0;

  const chromeCv = makeCanvas();
  const dataCv = makeCanvas();

  // ── State ──
  let mode: "side" | "stack" = "stack";
  let g: ScopeGeometry | null = null;
  let presence = basePresence();
  let metrics: ScopeMetrics = scopeMetrics(store.get().layout.bp, store.get().layout.short, true);
  let ticks: TickSet = { step: 0, ticks: [] };
  let buckets: ThreadBuckets | null = null;
  let tasksArr: Float32Array | null = null;
  let tasksMax = 0;
  let tasksScaleFor: TimelineM | null = null;
  /** THREADS y-scale top: ceil of the fixed-window maximum (width-independent, review round 1). */
  let busyTop = 1;
  /** Largest number of threads busy at one instant (sweep over the runs), once the timeline is in. */
  let concurrent: number | null = null;
  let busyScaleFor: TimelineM | null = null;
  /** The footprint polyline per column (callout obstacle, debugLayout). */
  let band: TraceBand | null = null;
  let calloutSpot: CalloutSpot | null = null;
  let drawableNow = true;
  /** Touch: the tapped point while its readout card is pinned (a second tap there opens). */
  let touchPin: { px: number; py: number } | null = null;
  let drawableCb: (on: boolean) => void = () => {};
  let cells: PhaseCell<Phase>[] = [];
  let topBins: Float32Array[] = [];
  let annotations: Annotation[] = [];
  let tickAnn: Annotation[] = [];
  let phaseAnn: ScopeDebug["phaseCells"] = [];
  let calloutPlan: PeakPlan | null = null;
  let calloutText: CalloutText | null = null;
  /** Data revealed (0..1); < 1 only while the intro stage runs. */
  let sweep = 1;
  let stage: IntroStage | null = null;
  let pendingIntro = false;
  /** Start time of the running intro (document timeline ms), once its first frame committed. */
  let introOrigin: number | null = null;
  let introClock: Promise<number> | null = null;
  /** Off-screen at load (phones, stacked layouts): the sweep waits until the scope is seen. */
  let introDeferred = false;
  let introIo: IntersectionObserver | null = null;
  const introBuilds: { at: number; startTime: number | null; reason: string }[] = [];
  let linked: LinkedLine | null = null;
  let linkedRank: number | null = null;
  let selectionLink: LinkedLine | null = null;
  let hoverX: number | null = null;
  let cursorT: number | null = null; // keyboard cursor
  let range: [number, number] | null = store.get().range;
  let drag: { x0: number; t0: number; t1: number; moved: boolean; id: number } | null = null;
  let anchorT: number | null = null; // shift-extend anchor
  let pulse: { start: number; reduced: boolean } | null = null;
  let pulseFrame = 0;
  let overlayMs = 0;
  let rowHoverCb: (rank: number | null) => void = () => {};
  let hoveredRow: number | null = null;
  const linkCache = new Map<string, LinkedLine>();

  // ── Scales ──
  const x = (t: number): number => (g ? g.plot.x + (t / tMax) * g.plot.w : 0);
  const tAt = (px: number): number => (g ? Math.max(0, Math.min(tMax, ((px - g.plot.x) / g.plot.w) * tMax)) : 0);

  // ── Layout ──
  const layoutState = () => store.get().layout;

  function relayout(width: number, available: number | null): void {
    // A geometry change mid-intro rebuilds the stage on the same clock (below).
    const resume = stage ? introOrigin ?? -1 : null;
    if (stage) {
      const st = stage;
      stage = null;
      st.destroy();
    }
    const L = layoutState();
    metrics = scopeMetrics(L.bp, L.short, mode === "stack");
    presence = effectivePresence(basePresence(), metrics, mode === "side");
    // y-tick labels live in a right gutter at every width; on phones it is just as wide as the
    // widest label, so a label never sits on the data (review round 1).
    if (metrics.xs) metrics = { ...metrics, gutterR: presence.memory || presence.threads || presence.tasks ? tickGutter() - 6 : 0 };
    else if (metrics.gutterR > 0) metrics = { ...metrics, gutterR: Math.max(metrics.gutterR, tickGutter()) };
    // xs: a 16 px rank gutter keeps the TOP LINES numerals off the strips (labels sit above channels).
    if (metrics.xs && presence.topRows > 0) metrics = { ...metrics, gutterL: 16 };
    if (presence.phase && !phaseUseful(Math.max(40, Math.floor(width) - metrics.gutterL - metrics.gutterR))) presence = { ...presence, phase: false };
    setDrawable(anyChannel(presence));
    const hh = canvasHeight(presence, metrics, mode === "side" ? available : null);
    if (mode === "stack") host.style.height = `${hh}px`;
    else {
      host.style.height = "";
      host.style.minHeight = `${requiredHeight(presence, metrics)}px`;
    }
    const w = Math.max(120, Math.floor(width));
    pair.resize(w, hh);
    g = layoutChannels(w, hh, presence, metrics);
    ticks = timeTicks(0, tMax, g.plot.w);
    computeData();
    buildCaches();
    composite();
    drawOverlay();
    renderLegend();
    // The pane was detached when the intro was requested: start it on the first layout (the
    // ResizeObserver delivers that before the first paint, so it still shares the first frame).
    if (pendingIntro) {
      pendingIntro = false;
      beginIntro();
    } else if (resume !== null) startIntro(resume >= 0 ? resume : null, `relayout ${Math.round(width)}×${Math.round(available ?? -1)}`);
  }

  /**
   * PHASE earns its row only when named cells (a phase label, or a group named by its dominant
   * member) cover at least half of the main-thread time; a row of anonymous hatching is noise
   * (review round 1). Unknown until the timeline arrives (the row stays reserved until then).
   */
  function phaseUseful(plotW: number): boolean {
    if (!tl) return true;
    const cs = layoutPhaseCells(tl.phases, (t) => (t / tMax) * plotW);
    let named = 0;
    let total = 0;
    for (const c of cs) {
      const d = Math.max(0, c.t1 - c.t0);
      total += d;
      if (c.kind === "label" || c.dominant) named += d;
    }
    return total > 0 && named / total >= 0.5;
  }

  /** Right gutter wide enough for the widest y-tick label (+ 8 px offset, 4 px margin). */
  function tickGutter(): number {
    const c = pair.b;
    c.save();
    setFont(c, uiFont(theme, 11, 400));
    let w = 0;
    for (const k of memSamples ? memScale.ticks.ticks : []) w = Math.max(w, c.measureText(k.label).width);
    if (threads.length > 1 || tasksPresent) w = Math.max(w, c.measureText("88").width);
    // TOP LINES rank numerals sit in the right gutter, beside the hotspot list (§4.4.5).
    w = Math.max(w, 8);
    c.restore();
    return Math.ceil(w + 12);
  }

  function setDrawable(on: boolean): void {
    if (on === drawableNow) return;
    drawableNow = on;
    el.hidden = !on;
    drawableCb(on);
  }

  /** THREADS windows: fixed in time (width-independent), never finer than ≈ 2 px when drawn. */
  function threadScale(timeline: TimelineM): void {
    if (busyScaleFor === timeline) return;
    busyScaleFor = timeline;
    const nb = threadBucketCount(tMax, model.sampling.dt || timeline.dt);
    const b = timeline.bucketize(nb, 0, tMax);
    let max = 0;
    for (let k = 0; k < nb; k++) max = Math.max(max, b.busy[k] + b.gil[k] + b.wait[k]);
    busyTop = countTicks(max)[1] ?? 1;
    // "Up to N threads busy at the same moment": GIL waits and I/O are not busy (§4.0.6).
    concurrent = maxConcurrent(timeline.t0, timeline.t1, (i) => !(timeline.stackBits[timeline.stack[i]] & (CLS_GIL | CLS_IO)));
  }

  function computeData(): void {
    if (!g) return;
    const nb = bucketCount(g.plot.w);
    buckets = null;
    tasksArr = null;
    if (tl && presence.threads) {
      threadScale(tl);
      buckets = tl.bucketize(Math.min(nb, threadBucketCount(tMax, model.sampling.dt || tl.dt)), 0, tMax);
    }
    if (tl && presence.tasks) {
      // ≈ 4 px columns (suspended counts jitter per instant), never finer than the fixed windows
      // the y scale comes from, so "suspended · 0–N" is the same at every width.
      const nbFix = Math.max(8, Math.floor(threadBucketCount(tMax, model.sampling.dt || tl.dt) / 2));
      if (tasksScaleFor !== tl) {
        tasksScaleFor = tl;
        const fixed = tl.tasks(nbFix, 0, tMax);
        tasksMax = 0;
        for (let k = 0; k < fixed.length; k++) tasksMax = Math.max(tasksMax, fixed[k]);
      }
      tasksArr = tl.tasks(Math.max(4, Math.min(nbFix, Math.floor(nb / 2))), 0, tMax);
    }
    cells = tl && presence.phase ? layoutPhaseCells(tl.phases, x) : [];
    const nbin = binCount(g.plot.w);
    topBins = topItems.slice(0, presence.topRows).map((it) => densityBins(it.times, nbin));
  }

  /**
   * TOP LINES density (review round 1): adaptive bins with ≥ ~8 expected samples each (never
   * finer than 2 px), smoothed with a [1 2 1] kernel, so sparse rows read as a calm activity
   * profile instead of quantised spikes. Each row is still scaled to its own peak (§4.4.5).
   */
  function densityBins(times: ArrayLike<number>, maxBins: number): Float32Array {
    const n = Math.max(6, Math.min(maxBins, Math.floor(times.length / 8)));
    const raw = binTimes(times, 0, tMax, n);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = raw[Math.max(0, k - 1)];
      const c = raw[Math.min(n - 1, k + 1)];
      out[k] = (a + 2 * raw[k] + c) / 4;
    }
    return out;
  }

  // ── Base drawing ──
  function buildCaches(): void {
    if (!g) return;
    const t = theme.tokens();
    const c = sizeCanvas(chromeCv, pair);
    const d = sizeCanvas(dataCv, pair);
    annotations = [];
    tickAnn = [];
    phaseAnn = [];
    planCallout(c, t);
    drawChrome(c, t);
    drawData(d, t);
    for (const a of tickAnn) annotations.push(a);
    if (calloutPlan && calloutPlan.kind !== "gutter") {
      const mem = channelRect(g, "memory") as Rect;
      annotations.push({ kind: "callout", rect: calloutPlan.rect, bounds: mem, text: calloutText?.title });
    }
  }

  /** The footprint as drawn (same M4 points and scales as drawFootprint), per 1 px column. */
  function memTrace(mem: Rect): TraceBand | null {
    return memSamples ? footprintTrace(memSamples, { x: mem.x, y: mem.y, w: mem.w, h: mem.h - 1 }, [0, tMax], memScale.top) : null;
  }

  function planCallout(c: CanvasRenderingContext2D, t: Tokens): void {
    calloutPlan = null;
    calloutText = null;
    calloutSpot = null;
    band = null;
    const mem = g ? channelRect(g, "memory") : null;
    if (!g || !mem || !peak || !model.memory) return;
    // The dot is drawn on the footprint's own scale (rect height − 1, see drawData).
    const s = footprintScales({ x: mem.x, y: mem.y, w: mem.w, h: mem.h - 1 }, [0, tMax], memScale.top);
    const dot = { x: s.x(peak.t), y: s.y(peak.mb) };
    const loc = model.memory.peakLine ? ` · ${fmtLoc(model.memory.peakLine.file.name, model.memory.peakLine.no)}` : "";
    calloutText = { title: `peak ${fmtMem(model.memory.peak)}`, detail: `${fmtTime(peak.t)}${loc}` };
    const sizes = measureCallout(c, calloutText, theme);
    band = memTrace(mem);
    // The box never covers the trace it annotates: candidates beside the dot, then above or
    // below the trace on either side; then the one-line label; then the gutter caption.
    const plan = planPeakClear({ dot, callout: sizes.callout, label: sizes.label, bounds: mem, reserved: [dotRect(dot, 5)], trace: band });
    calloutSpot = plan.spot;
    calloutPlan = plan.kind === "gutter" ? { kind: "gutter", rect: null } : { kind: plan.kind, side: plan.spot.endsWith("right") ? "right" : "left", rect: plan.rect };
    void t;
  }

  function channelLabel(c: CanvasRenderingContext2D, t: Tokens, id: ChannelId, micro: string, cap: string | null, led: string, reserveRight = 0): void {
    if (!g) return;
    const ch = g.channels.find((q) => q.id === id);
    if (!ch) return;
    const r = ch.rect;
    c.save();
    c.textBaseline = "top";
    c.textAlign = "left";
    if (ch.labelRow) {
      // xs: one inline row above the channel: ● MICRO caption
      const y = ch.labelRow.y + 1;
      const lx = ch.labelRow.x;
      c.fillStyle = led;
      c.beginPath();
      c.arc(lx + 3, y + 6, 2.5, 0, Math.PI * 2);
      c.fill();
      setFont(c, uiFont(theme, 11, 600));
      letterSpacing(c, MICRO_LS);
      c.fillStyle = t["fg-2"];
      const label = micro.toUpperCase();
      c.fillText(label, lx + 10, y);
      const mw = c.measureText(label).width;
      letterSpacing(c, "0px");
      annotations.push({ kind: "channel-label", rect: { x: lx, y, w: 10 + mw, h: 13 }, bounds: ch.labelRow, text: label });
      if (cap) {
        setFont(c, uiFont(theme, 11, 400));
        c.fillStyle = t["fg-3"];
        const cx = lx + 10 + mw + 6;
        const fitted = fitText(c, cap, Math.max(0, r.x + r.w - cx - 60), "end");
        if (fitted) {
          c.fillText(fitted, cx, y);
          annotations.push({ kind: "channel-label", rect: { x: cx, y, w: c.measureText(fitted).width, h: 13 }, bounds: ch.labelRow, text: fitted });
        }
      }
      c.restore();
      return;
    }
    const gw = g.m.gutterL - 8 - reserveRight;
    const bounds = { x: 0, y: r.y, w: g.m.gutterL - 4 - reserveRight, h: Math.max(r.h, 14) };
    const oneLine = r.h < 26 || !cap;
    const y0 = oneLine ? r.y + Math.max(0, (r.h - 14) / 2) : r.y;
    c.fillStyle = led;
    c.beginPath();
    c.arc(3, y0 + 6.5, 2.5, 0, Math.PI * 2);
    c.fill();
    setFont(c, uiFont(theme, 11, 600));
    letterSpacing(c, MICRO_LS);
    c.fillStyle = t["fg-2"];
    const label = fitText(c, micro.toUpperCase(), gw - 10, "end");
    c.fillText(label, 10, y0 + 1);
    annotations.push({ kind: "channel-label", rect: { x: 0, y: y0, w: 10 + c.measureText(label).width, h: 14 }, bounds, text: label });
    letterSpacing(c, "0px");
    if (cap && !oneLine) {
      setFont(c, uiFont(theme, 11, 400));
      c.fillStyle = t["fg-3"];
      const maxLines = Math.max(1, Math.floor((r.h - 14) / 14));
      // "busy · 0–5" → "busy" when one line is all there is (the y ticks carry the range).
      const fits = c.measureText(cap).width <= gw - 10;
      const text = maxLines === 1 && !fits ? cap.split(" · ")[0] : cap;
      // Two lines: break at the " · " separator ("suspended" / "0–14"), never leave a dangling dot.
      const parts = text.split(" · ");
      const lines = !fits && maxLines >= parts.length && parts.length > 1 && parts.every((q) => c.measureText(q).width <= gw - 10) ? parts : wrapWords(c, text, gw - 10, maxLines);
      lines.forEach((ln, i) => {
        const yy = y0 + 15 + i * 14;
        c.fillText(ln, 10, yy);
        annotations.push({ kind: "channel-label", rect: { x: 10, y: yy, w: c.measureText(ln).width, h: 14 }, bounds, text: ln });
      });
    }
    c.restore();
  }

  function yTicksFor(c: CanvasRenderingContext2D, t: Tokens, r: Rect, values: number[], toY: (v: number) => number, label: (v: number) => string, reserved: Rect[]): void {
    if (!g) return;
    setFont(c, uiFont(theme, 11, 400));
    const cands = values.map((v) => ({ y: toY(v), label: label(v), size: { w: Math.ceil(c.measureText(label(v)).width), h: 13 } }));
    // Labels sit in the right gutter, left-aligned, always on the same side (phones get a gutter
    // just as wide as the widest label: they never sit on the data or flip sides).
    const inside = g.m.gutterR === 0;
    const placed = placeYTicks(cands, {
      channel: r,
      x: inside ? r.x + r.w - 3 : r.x + r.w + (g.m.xs ? 4 : 8),
      alignRight: inside,
      reserved,
      topGuard: 0,
      max: 3,
    });
    c.save();
    c.textBaseline = "top";
    c.textAlign = "left";
    for (const p of placed) {
      if (inside) {
        c.lineWidth = 3;
        c.strokeStyle = t["surface"];
        c.lineJoin = "round";
        c.strokeText(p.label, p.rect.x, p.rect.y);
      }
      c.fillStyle = t["fg-3"];
      c.fillText(p.label, p.rect.x, p.rect.y);
      const bounds = inside ? r : { x: r.x, y: r.y, w: g.width - r.x, h: r.h };
      tickAnn.push({ kind: "ytick", rect: p.rect, bounds, text: p.label });
    }
    c.restore();
  }

  function drawChrome(c: CanvasRenderingContext2D, t: Tokens): void {
    if (!g) return;
    const dpr = pair.dpr;
    // Vertical gridlines through every channel (§4.4.1).
    drawVGridlines(c, ticks, { x: g.plot.x, y: g.plot.y, w: g.plot.w, h: g.plot.h }, t["grid"], dpr);
    // Time axis labels.
    const axisRects = drawTimeLabels(c, ticks, g.plot, g.axis.y + 12, { font: uiFont(theme, 11, 400), color: t["fg-3"] });
    const axisBounds = { x: 0, y: g.axis.y - 2, w: g.width, h: g.axis.h + 2 };
    for (const r of axisRects) tickAnn.push({ kind: "xtick", rect: { x: r.x, y: r.y, w: r.w, h: r.h }, bounds: axisBounds });

    const reserved: Rect[] = calloutPlan && calloutPlan.kind !== "gutter" ? [calloutPlan.rect] : [];
    for (const ch of g.channels) {
      const r = ch.rect;
      if (ch.id === "phase") channelLabel(c, t, "phase", "Phase", null, t["fg-3"]);
      if (ch.id === "memory") {
        const s = footprintScales(r, [0, tMax], memScale.top);
        drawHGridlines(c, { step: memScale.step, ticks: memScale.ticks.ticks.filter((k) => k.value > 0) }, r, t["grid"], dpr);
        baseline(c, r, t);
        const capText = calloutPlan && calloutPlan.kind === "gutter" ? `peak ${fmtMem(model.memory?.peak ?? 0)}` : "footprint";
        channelLabel(c, t, "memory", "Memory", capText, t["mem-py"]);
        const vals = memScale.ticks.ticks.filter((k) => k.value > 0).reverse();
        const labelOf = new Map(memScale.ticks.ticks.map((k) => [k.value, k.label] as const));
        yTicksFor(c, t, r, vals.map((k) => k.value), (v) => s.y(v), (v) => labelOf.get(v) ?? "", reserved);
      }
      if (ch.id === "threads") {
        baseline(c, r, t);
        const tk = countTicks(busyTop);
        const top = tk[tk.length - 1];
        const y = (v: number) => r.y + r.h - (v / top) * r.h;
        if (buckets) {
          c.save();
          c.strokeStyle = t["grid"];
          c.lineWidth = 1 / dpr;
          c.beginPath();
          for (const v of tk) if (v > 0) {
            const yy = crisp(y(v), dpr);
            c.moveTo(r.x, yy);
            c.lineTo(r.x + r.w, yy);
          }
          c.stroke();
          c.restore();
          // The baseline is the 0 (as on MEMORY): only the top (and middle) values are labelled.
          yTicksFor(c, t, r, tk.filter((v) => v > 0).reverse(), y, (v) => String(v), reserved);
        }
        channelLabel(c, t, "threads", "Threads", buckets ? `busy · 0–${top}` : "busy", t["cpu-native"]);
      }
      if (ch.id === "tasks") {
        baseline(c, r, t);
        const tk = countTicks(tasksMax);
        const top = tk[tk.length - 1];
        const y = (v: number) => r.y + r.h - (v / top) * r.h;
        if (tasksArr) yTicksFor(c, t, r, tk.filter((v) => v > 0).reverse(), y, (v) => String(v), reserved);
        channelLabel(c, t, "tasks", "Tasks", tasksArr ? `suspended · 0–${top}` : "suspended", t["async"]);
      }
      if (ch.id === "top") drawTopChrome(c, t, r);
    }
  }

  function baseline(c: CanvasRenderingContext2D, r: Rect, t: Tokens): void {
    c.save();
    c.fillStyle = t["grid-strong"];
    c.fillRect(r.x, r.y + r.h - 1, r.w, 1);
    c.restore();
  }

  /** Where rank numerals sit: the left 16 px gutter on phones, else the right gutter (§4.4.5). */
  function rankColumn(): { x: number; align: CanvasTextAlign; w: number; inside: boolean } {
    const gg = g as ScopeGeometry;
    if (gg.m.gutterL === 0) return { x: gg.plot.x + 1, align: "left", w: 12, inside: true };
    if (gg.m.xs) return { x: gg.m.gutterL - 3, align: "right", w: gg.m.gutterL, inside: false };
    return { x: gg.plot.x + gg.plot.w + 6, align: "left", w: gg.width - gg.plot.x - gg.plot.w, inside: false };
  }

  /** Strip rect of TOP LINES row i (bottom-aligned on the row's baseline, ≤ 20 px tall). */
  function topStrip(r: Rect, i: number): { y: number; h: number; pitch: number } {
    const pitch = r.h / Math.max(1, presence.topRows);
    const h = topBarHeight(pitch);
    return { y: r.y + (i + 1) * pitch - 1 - h, h, pitch };
  }

  function drawTopChrome(c: CanvasRenderingContext2D, t: Tokens, r: Rect): void {
    if (!g) return;
    const n = presence.topRows;
    // "TOP 5" + "when they ran" with the whole gutter (the rank numerals moved to the right).
    channelLabel(c, t, "top", `Top ${n}`, topMetric === "memory" ? "when allocated" : "when they ran", topMetric === "memory" ? t["mem-py"] : t["cpu-py"]);
    const col = rankColumn();
    for (let i = 0; i < n; i++) {
      const strip = topStrip(r, i);
      const ry = r.y + i * strip.pitch;
      const cy = strip.y + strip.h / 2;
      c.save();
      c.fillStyle = t["grid-strong"];
      c.fillRect(r.x, Math.round(strip.y + strip.h), r.w, 1);
      // Numerals never touch at a 10 px pitch: 11 px text, smaller on tight rows.
      const fs = Math.max(8, Math.min(11, Math.floor(strip.pitch) - 1));
      setFont(c, monoFont(theme, fs, 400));
      c.textBaseline = "middle";
      c.textAlign = col.align;
      const num = String(i + 1);
      const nw = c.measureText(num).width;
      if (col.inside) {
        c.lineWidth = 3;
        c.strokeStyle = t["surface"];
        c.strokeText(num, col.x, cy);
      }
      c.fillStyle = t["fg-2"];
      c.fillText(num, col.x, cy);
      const rx = col.align === "right" ? col.x - nw : col.x;
      const rowBounds = col.inside ? { x: r.x, y: ry, w: r.w, h: strip.pitch } : col.align === "right" ? { x: 0, y: ry, w: g.m.gutterL, h: strip.pitch } : { x: r.x + r.w, y: ry, w: col.w, h: strip.pitch };
      annotations.push({ kind: "rank", rect: { x: rx, y: Math.max(ry, cy - fs / 2), w: nw, h: Math.min(fs, strip.pitch) }, bounds: rowBounds, text: num });
      const it = topItems[i];
      if (it && it.times.length === 0) {
        setFont(c, uiFont(theme, strip.h < 12 ? 10 : 11, 400));
        c.textAlign = "left";
        c.fillStyle = t["fg-3"];
        const msg = topMetric === "memory" ? "no allocation samples on this line" : "no main-thread samples (worker thread or native only)";
        c.fillText(fitText(c, msg, r.w - 20, "end"), r.x + (col.inside ? 14 : 6), cy);
      }
      c.restore();
    }
  }

  function drawData(d: CanvasRenderingContext2D, t: Tokens): void {
    if (!g) return;
    const nb = buckets?.nb ?? 0;
    for (const ch of g.channels) {
      const r = ch.rect;
      if (ch.id === "phase") drawPhases(d, t, r);
      if (ch.id === "memory" && memSamples) {
        drawFootprint(d, memSamples, { rect: { x: r.x, y: r.y, w: r.w, h: r.h - 1 }, domain: [0, tMax], yMax: memScale.top, theme });
        if (peak) {
          const s = footprintScales({ x: r.x, y: r.y, w: r.w, h: r.h - 1 }, [0, tMax], memScale.top);
          drawPeakMarker(d, { x: s.x(peak.t), y: s.y(peak.mb) }, theme);
        }
      }
      if (ch.id === "threads" && buckets && nb > 0) {
        const tk = countTicks(busyTop);
        const top = tk[tk.length - 1];
        const y = (v: number) => r.y + r.h - 1 - (Math.min(v, top) / top) * (r.h - 1);
        const bw = r.w / nb;
        const zero = new Float32Array(nb);
        const c1 = buckets.busy;
        const c2 = new Float32Array(nb);
        const c3 = new Float32Array(nb);
        for (let k = 0; k < nb; k++) {
          c2[k] = c1[k] + buckets.gil[k];
          c3[k] = c2[k] + buckets.wait[k];
        }
        d.save();
        stepBand(d, c2, c3, r.x, bw, y);
        d.fillStyle = hatch(d, "waiting", theme);
        d.fill();
        stepBand(d, c1, c2, r.x, bw, y);
        d.fillStyle = alpha(t["gil"], 0.7);
        d.fill();
        stepBand(d, zero, c1, r.x, bw, y);
        d.fillStyle = alpha(t["cpu-native"], 0.45);
        d.fill();
        stepLine(d, c1, r.x, bw, y);
        d.strokeStyle = t["cpu-py"];
        d.lineWidth = 1.25;
        d.lineJoin = "round";
        d.stroke();
        d.restore();
      }
      if (ch.id === "tasks" && tasksArr && tasksArr.length) {
        const tk = countTicks(tasksMax);
        const top = tk[tk.length - 1];
        const n = tasksArr.length;
        const y = (v: number) => r.y + r.h - 1 - (Math.min(v, top) / top) * (r.h - 1);
        const bw = r.w / n;
        d.save();
        stepBand(d, new Float32Array(n), tasksArr, r.x, bw, y);
        d.fillStyle = hatch(d, "waiting", theme);
        d.fill();
        stepLine(d, tasksArr, r.x, bw, y);
        d.strokeStyle = t["async"];
        d.lineWidth = 1.25;
        d.stroke();
        d.restore();
      }
      if (ch.id === "top") {
        const n = presence.topRows;
        const fill = topMetric === "memory" ? t["mem-py"] : t["cpu-py"];
        for (let i = 0; i < n; i++) {
          const bins = topBins[i];
          if (bins) drawDensity(d, bins, r, topStrip(r, i), fill);
        }
      }
    }
  }

  /** One TOP LINES row: a smoothed density area (alpha fill + crisp top edge where > 0). */
  function drawDensity(d: CanvasRenderingContext2D, bins: Float32Array, r: Rect, strip: { y: number; h: number }, color: string): void {
    let max = 0;
    for (let k = 0; k < bins.length; k++) if (bins[k] > max) max = bins[k];
    if (!(max > 0)) return;
    const n = bins.length;
    const bw = r.w / n;
    const base = strip.y + strip.h;
    const px = (k: number) => r.x + (k + 0.5) * bw;
    const py = (k: number) => base - (bins[k] / max) * (strip.h - 1);
    const curve = (move: boolean) => {
      if (move) d.moveTo(r.x, py(0));
      else d.lineTo(r.x, py(0));
      d.lineTo(px(0), py(0));
      for (let k = 1; k < n; k++) {
        const mx = (px(k - 1) + px(k)) / 2;
        const my = (py(k - 1) + py(k)) / 2;
        d.quadraticCurveTo(px(k - 1), py(k - 1), mx, my);
      }
      d.lineTo(px(n - 1), py(n - 1));
      d.lineTo(r.x + r.w, py(n - 1));
    };
    d.save();
    d.beginPath();
    d.moveTo(r.x, base);
    curve(false);
    d.lineTo(r.x + r.w, base);
    d.closePath();
    d.globalAlpha = 0.3;
    d.fillStyle = color;
    d.fill();
    d.globalAlpha = 1;
    // The top edge, clipped to where the line ran (no ink along the empty baseline).
    d.beginPath();
    for (let k = 0; k < n; k++) {
      if (bins[k] <= 0 && bins[Math.max(0, k - 1)] <= 0 && bins[Math.min(n - 1, k + 1)] <= 0) continue;
      d.rect(r.x + (k - 0.5) * bw, strip.y - 2, bw * 2, strip.h + 1.5);
    }
    d.clip();
    d.beginPath();
    curve(true);
    d.strokeStyle = color;
    d.lineWidth = 1.25;
    d.lineJoin = "round";
    d.stroke();
    d.restore();
  }

  /** Short-phase hatch: 1 px `--control` lines on a 4 px period, ≥ 3:1 on the card (§3.7). */
  let phaseHatch: { key: string; pattern: CanvasPattern } | null = null;
  function shortPhaseHatch(d: CanvasRenderingContext2D, t: Tokens): CanvasPattern | string {
    const dpr = pair.dpr;
    const key = `${t["control"]}|${t["surface"]}|${dpr}`;
    if (phaseHatch && phaseHatch.key === key) return phaseHatch.pattern;
    const size = 8;
    const tile = document.createElement("canvas");
    tile.width = tile.height = Math.round(size * dpr);
    const x = tile.getContext("2d");
    if (!x) return t["control"];
    x.scale(dpr, dpr);
    x.strokeStyle = t["control"];
    x.lineWidth = 1;
    x.lineCap = "square";
    x.beginPath();
    for (let c = -size; c <= 2 * size; c += 4) {
      x.moveTo(c, 0);
      x.lineTo(c - size, size);
    }
    x.stroke();
    const p = d.createPattern(tile, "repeat");
    if (!p) return t["control"];
    if (typeof DOMMatrix === "function") p.setTransform(new DOMMatrix().scale(1 / dpr));
    phaseHatch = { key, pattern: p };
    return p;
  }

  function drawPhases(d: CanvasRenderingContext2D, t: Tokens, r: Rect): void {
    d.save();
    setFont(d, monoFont(theme, 11, 400));
    d.textBaseline = "middle";
    for (const cell of cells) {
      const rect = { x: cell.x, y: r.y, w: cell.w, h: r.h };
      roundRect(d, rect.x, rect.y, rect.w, rect.h, Math.min(3, rect.w / 2));
      // Labelled cells sit on --sunken; short phases are interactive marks: a --control hatch
      // straight on the card surface (3.30:1 light, 4.03:1 dark, §3.7), not a 35 % tint.
      d.fillStyle = cell.kind === "label" ? t["sunken"] : shortPhaseHatch(d, t);
      d.fill();
      if (cell.w >= 3) {
        d.strokeStyle = t["line-strong"];
        d.lineWidth = 1;
        roundRect(d, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, Math.min(2.5, rect.w / 2));
        d.stroke();
      }
      let labelRect: Rect | null = null;
      if (cell.label) {
        const avail = cell.w - 14;
        const text = cell.kind === "label" ? fitCode(d, cell.label, avail) : cell.dominant ? dominantLabel(d, cell.dominant, avail, cell.members.length) : groupLabel(d, cell.members.length, avail);
        if (text) {
          const tw = d.measureText(text).width;
          if (cell.kind === "group") {
            const pad = 4;
            d.fillStyle = t["sunken"];
            d.fillRect(rect.x + 7 - pad, r.y + 3, tw + 2 * pad, r.h - 6);
          }
          d.fillStyle = t["fg-2"];
          d.fillText(text, rect.x + 7, r.y + r.h / 2 + 0.5);
          labelRect = { x: rect.x + 7, y: r.y + 2, w: tw, h: r.h - 4 };
          annotations.push({ kind: "phase-label", rect: labelRect, bounds: rect, text });
        }
      }
      phaseAnn.push({ kind: cell.kind, rect, label: cell.label, labelRect });
    }
    d.restore();
  }

  /**
   * Compose chrome + data + callout into the base canvas. During the intro the data and the
   * callout live in the compositor stage (scope-intro.ts) and the base holds the chrome only.
   */
  function composite(): void {
    if (!g) return;
    const b = pair.b;
    clearCanvas(b);
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.drawImage(chromeCv, 0, 0);
    const revealed = !stage && !introDeferred;
    if (revealed) b.drawImage(dataCv, 0, 0);
    b.restore();
    if (revealed && calloutPlan && calloutText) drawCallout(b, calloutPlan, calloutText, theme, 1);
  }

  // ── Overlay ──
  function currentLink(): LinkedLine | null {
    return linked ?? selectionLink;
  }

  function drawOverlay(now = performance.now()): void {
    if (!g) return;
    const t0 = performance.now();
    pair.clearOverlay();
    const o = pair.o;
    const t = theme.tokens();
    const dark = theme.current() === "dark";
    const top = g.plot.y;
    const bottom = g.plot.y + g.plot.h;

    // Brush / range
    const rg = drag && drag.moved ? ([Math.min(drag.t0, drag.t1), Math.max(drag.t0, drag.t1)] as [number, number]) : range;
    if (rg) {
      const a = x(rg[0]);
      const bb = x(rg[1]);
      o.save();
      o.fillStyle = alpha(t["fg"], 0.08);
      o.fillRect(a, top, Math.max(1, bb - a), bottom - top);
      o.fillStyle = alpha(t["fg"], 0.5);
      o.fillRect(Math.round(a), top, 1, bottom - top);
      o.fillRect(Math.round(bb), top, 1, bottom - top);
      o.restore();
    }

    // Linked overlays (§4.4.6)
    const link = currentLink();
    if (link) {
      const tickAlpha = dark ? 0.45 : 0.3;
      for (const id of ["memory", "threads", "tasks"] as const) {
        const r = channelRect(g, id);
        if (r && link.cpu.length) drawSampleTicks(o, link.cpu, [0, tMax], r, t["cpu-py"], tickAlpha);
      }
      const rug = channelRect(g, "rug");
      if (rug && link.mem.length) drawRug(o, link.mem, [0, tMax], rug, link.leak ? t["danger"] : t["mem-py"]);
      const topR = channelRect(g, "top");
      if (topR && presence.topRows > 0) {
        const rank = linkedRank ?? topItems.findIndex((it) => sameTarget(it.target, link.target)) + 1;
        const rowH = topR.h / presence.topRows;
        o.save();
        o.fillStyle = alpha(t["surface"], 0.6);
        for (let i = 0; i < presence.topRows; i++) {
          if (i + 1 === rank) continue;
          o.fillRect(topR.x - 1, topR.y + i * rowH, topR.w + 2, rowH);
        }
        if (rank > 0) {
          // A hairline marker beside the rank numeral ties the strip to its rank.
          o.fillStyle = t["fg"];
          const mx = g.m.xs || g.m.gutterL === 0 ? 0 : topR.x + topR.w + 2;
          o.fillRect(mx, topR.y + (rank - 1) * rowH + 1, 2, rowH - 2);
        }
        o.restore();
      }
    }

    // Crosshair (pointer or keyboard cursor)
    const cx = hoverX !== null && !drag?.moved ? Math.max(g.plot.x, Math.min(g.plot.x + g.plot.w, hoverX)) : cursorT !== null ? x(cursorT) : null;
    if (cx !== null && sweep >= 1) {
      o.save();
      o.fillStyle = alpha(t["fg"], 0.45);
      o.fillRect(Math.round(cx * pair.dpr) / pair.dpr, top, 1, bottom - top);
      o.restore();
      const tc = tAt(cx);
      const mem = channelRect(g, "memory");
      if (mem && memSamples) {
        const fp = footprintAt(memSamples, tc);
        if (fp) {
          const s = footprintScales({ x: mem.x, y: mem.y, w: mem.w, h: mem.h - 1 }, [0, tMax], memScale.top);
          o.save();
          o.beginPath();
          o.arc(cx, s.y(fp.mb), 3.5, 0, Math.PI * 2);
          o.fillStyle = t["mem-py"];
          o.fill();
          o.lineWidth = 1.5;
          o.strokeStyle = t["surface"];
          o.stroke();
          o.restore();
        }
      }
      axisChip(o, t, cx, fmtTime(tc));
    }

    // Peak pulse (M23)
    if (pulse && peak) {
      const mem = channelRect(g, "memory");
      if (mem) {
        const s = footprintScales({ x: mem.x, y: mem.y, w: mem.w, h: mem.h - 1 }, [0, tMax], memScale.top);
        const at = { x: s.x(peak.t), y: s.y(peak.mb) };
        const e = now - pulse.start;
        if (pulse.reduced) {
          o.save();
          o.beginPath();
          o.arc(at.x, at.y, 7, 0, Math.PI * 2);
          o.lineWidth = 2;
          o.strokeStyle = t["mem-py"];
          o.stroke();
          o.restore();
        } else {
          const p = Math.min(1, e / DUR.d5);
          const k = EASE.out(p);
          o.save();
          o.globalAlpha = 1 - k;
          o.beginPath();
          o.arc(at.x, at.y, 4 * (1 + 0.6 * k) + 2, 0, Math.PI * 2);
          o.lineWidth = 1.5;
          o.strokeStyle = t["mem-py"];
          o.stroke();
          o.restore();
        }
      }
    }
    overlayMs = performance.now() - t0;
    if (ctx.host.flags.perf) {
      try {
        performance.measure("scalene:scope-overlay", { start: t0, end: t0 + overlayMs });
      } catch {
        // Older engines: the debugLayout().overlayMs value still reports it.
      }
    }
  }

  function axisChip(o: CanvasRenderingContext2D, t: Tokens, cx: number, label: string): void {
    if (!g) return;
    o.save();
    setFont(o, uiFont(theme, 11, 500));
    const tw = Math.ceil(o.measureText(label).width);
    const w = tw + 10;
    const hh = 16;
    const xx = Math.max(0, Math.min(g.width - w, cx - w / 2));
    const yy = g.axis.y + 1;
    roundRect(o, xx, yy, w, hh, 3);
    o.fillStyle = t["fg"];
    o.fill();
    o.fillStyle = t["surface"];
    o.textBaseline = "middle";
    o.textAlign = "left";
    o.fillText(label, xx + 5, yy + hh / 2 + 0.5);
    o.restore();
  }

  // ── Readout card (§4.4.8) ──
  function readoutAt(tv: number): Readout {
    const out: Readout = { t: tv, footprint: null, threads: null, tasks: null, phase: null, leaf: null };
    if (memSamples && presence.memory) out.footprint = footprintAt(memSamples, tv);
    if (g && buckets && presence.threads) {
      const k = Math.max(0, Math.min(buckets.nb - 1, Math.floor((tv / tMax) * buckets.nb)));
      out.threads = { busy: buckets.busy[k], wait: buckets.wait[k], gil: buckets.gil[k] };
    }
    if (tasksArr && presence.tasks) {
      const k = Math.max(0, Math.min(tasksArr.length - 1, Math.floor((tv / tMax) * tasksArr.length)));
      out.tasks = tasksArr[k];
    }
    if (tl) {
      out.phase = tl.phases.find((p) => tv >= p.t0 && tv <= p.t1) ?? null;
      const lane = tl.mainIdx >= 0 ? tl.mainIdx : 0;
      const leaf = tl.pyLeafAt(lane, tv);
      if (leaf) {
        const f = leaf.frame;
        const line = f.line !== null ? lineAt(model, f.filename_or_module, f.line) : null;
        out.leaf = { name: f.display_name, file: f.filename_or_module, line: f.line ?? 0, text: line ? line.text.trim() : null };
      }
    }
    return out;
  }

  function renderCard(px: number | null, touch = false): void {
    if (px === null || !g || sweep < 1) {
      card.classList.remove("is-on", "is-touch");
      card.setAttribute("aria-hidden", "true");
      return;
    }
    const r = readoutAt(tAt(px));
    const rows: HTMLElement[] = [];
    rows.push(h("div", { class: "sc-time" }, h("span", null, fmtTime(r.t)), h("span", { class: "sc-of" }, `of ${fmtTime(tMax)}`)));
    if (presence.memory) {
      rows.push(
        h(
          "div",
          { class: "sc-row" },
          h("i", { class: "sw", style: { background: "var(--mem-py)" } }),
          h("span", null, "Footprint"),
          h("b", null, r.footprint ? `${fmtMem(r.footprint.mb)}${r.footprint.interpolated ? " (interpolated)" : ""}` : "not sampled"),
        ),
      );
    }
    if (presence.threads && r.threads) {
      rows.push(
        h(
          "div",
          { class: "sc-row" },
          h("i", { class: "sw", style: { background: "var(--cpu-native)" } }),
          h("span", null, "Threads"),
          h("b", null, `${r.threads.busy.toFixed(1)} busy · ${r.threads.wait.toFixed(1)} in I/O & waits · ${r.threads.gil.toFixed(1)} GIL`),
        ),
      );
    }
    if (presence.tasks && r.tasks !== null) {
      rows.push(h("div", { class: "sc-row" }, h("i", { class: "sw sw-wait" }), h("span", null, "Tasks"), h("b", null, `${r.tasks.toFixed(1)} suspended`)));
    }
    if (presence.phase && r.phase) {
      rows.push(h("div", { class: "sc-row" }, h("i", { class: "sw sw-phase" }), h("span", null, "Phase"), h("code", { class: "sc-code" }, shortCode(r.phase.label, 34) ?? r.phase.label)));
    }
    if (r.leaf) {
      rows.push(
        h(
          "div",
          { class: "sc-stack" },
          h("div", null, h("span", { class: "sc-dim" }, "Main thread "), h("code", null, `${r.leaf.name}()`), h("span", { class: "sc-dim" }, ` · ${fmtLoc(r.leaf.file, r.leaf.line)}`)),
          r.leaf.text ? h("code", { class: "sc-src" }, r.leaf.text) : null,
        ),
      );
    }
    if (touch) {
      // Touch (review round 1): the first tap reads; opening the line is an explicit second step.
      const leaf = r.leaf;
      rows.push(
        h(
          "div",
          { class: "sc-actions" },
          leaf
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn-compact sc-open",
                  onClick: (ev: Event) => {
                    ev.stopPropagation();
                    clearTouch();
                    void ctx.nav.jumpTo({ file: leaf.file, line: leaf.line }, { source: "scope" });
                  },
                },
                `Open ${fmtLoc(leaf.file, leaf.line)}`,
                icon("chevron-right", 14),
              )
            : h("span", { class: "sc-hint" }, "No Python line at this time"),
        ),
      );
    } else rows.push(h("div", { class: "sc-hint" }, r.leaf ? "Click to open the line · drag to select a range" : "Drag to select a range"));
    card.replaceChildren(...rows);
    card.classList.add("is-on");
    card.classList.toggle("is-touch", touch);
    if (touch) card.removeAttribute("aria-hidden");
    else card.setAttribute("aria-hidden", "true");
    const cw = card.offsetWidth;
    const hostW = host.clientWidth;
    if (touch && touchPin) {
      // Under a finger: never cover the tapped point (a second tap there opens the line). The
      // card sits above the finger when there is room, else below it.
      const ch = card.offsetHeight;
      const py = touchPin.py;
      const top = py - ch - 14 >= 0 ? py - ch - 14 : py + 18;
      card.style.left = `${Math.max(4, Math.min(hostW - cw - 4, px - cw / 2))}px`;
      card.style.top = `${Math.max(0, top)}px`;
      return;
    }
    let left = px + 14;
    if (left + cw > hostW - 4) left = px - cw - 14;
    card.style.left = `${Math.max(4, left)}px`;
    card.style.top = `${Math.max(4, g.plot.y + 4)}px`;
  }

  function announceAt(tv: number): void {
    const r = readoutAt(tv);
    const parts = [spokenTime(tv)];
    if (r.footprint) parts.push(`footprint ${fmtMem(r.footprint.mb)}`);
    if (r.threads) parts.push(`${r.threads.busy.toFixed(1)} threads busy`);
    if (r.tasks !== null) parts.push(`${r.tasks.toFixed(1)} tasks suspended`);
    if (r.leaf) parts.push(`main thread in ${r.leaf.name}, ${fmtLoc(r.leaf.file, r.leaf.line).replace(":", " line ")}`);
    ctx.announce.polite(parts.join(", "));
  }

  // ── Header: description / range chip / link caption ──
  function renderHeader(): void {
    const link = currentLink();
    head.classList.toggle("is-busy", Boolean(range || link));
    if (range) {
      const chip = h(
        "span",
        { class: "range-chip" },
        h("span", { class: "range-text" }, `${fmtRange(range[0], range[1])} · ${fmtTime(range[1] - range[0])}`),
        model.caps.timeline
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-ghost btn-compact range-open",
                onClick: () => {
                  // showSection mounts the lazy timeline synchronously, so its listener exists (WP4 R2).
                  void ctx.nav.showSection("timeline");
                  bus.emit("range:set", { range, source: "scope", reveal: true });
                },
              },
              "Open in timeline",
            )
          : null,
        h("button", { type: "button", class: "icon-btn icon-btn-sm", "aria-label": "Clear range", onClick: () => setRange(null, true) }, icon("x")),
      );
      desc.replaceChildren(chip);
      desc.classList.add("has-chip");
      return;
    }
    desc.classList.remove("has-chip");
    if (link) {
      desc.replaceChildren(h("code", { class: "link-loc" }, link.label), h("span", null, ` · ${linkCounts(link)}`));
      return;
    }
    desc.replaceChildren(descText);
  }

  /**
   * "ran in 312 main-thread samples · 4 allocation events". Scalene keeps at most 500 CPU sample
   * times (and 100 allocation events) per line, so a count at the cap is a floor, not the total.
   */
  function linkCounts(link: LinkedLine): string {
    const n = link.cpu.length;
    const m = link.mem.length;
    const atCap = link.kind === "line";
    const cpu = atCap && n >= CPU_SAMPLES_KEPT ? `ran in ≥ ${fmtCount(n)} main-thread samples` : `ran in ${fmtCount(n)} main-thread sample${n === 1 ? "" : "s"}`;
    const mem = atCap && m >= MEM_EVENTS_KEPT ? `≥ ${fmtCount(m)} allocation events` : `${fmtCount(m)} allocation event${m === 1 ? "" : "s"}`;
    return `${cpu} · ${mem}`;
  }

  function renderLegend(): void {
    const items: [string, string][] = [];
    if (presence.memory) items.push(["sw", "footprint"]);
    if (presence.threads) items.push(["sw sw-busy", "threads busy"]);
    if (presence.threads && model.sampling.laneTotals && model.sampling.laneTotals.gil > 0) items.push(["sw sw-gil", "GIL"]);
    if (presence.threads || presence.tasks) items.push(["sw sw-wait", presence.tasks ? "suspended · I/O & waits" : "I/O & waits"]);
    if (cells.some((c) => c.kind !== "label")) items.push(["sw sw-phase-short", "short phases"]);
    legend.replaceChildren(...items.map(([cls, label]) => h("span", { class: "lg-item" }, h("i", { class: cls }), label)));
  }

  function updateCaption(): void {
    const parts = [`Signal of the run over ${fmtTime(tMax)}.`];
    if (model.memory && peak) parts.push(`Memory footprint rises to a peak of ${fmtMem(model.memory.peak)} at ${fmtTime(peak.t)}.`);
    // One number at every window width (review round 1): the instantaneous maximum from the runs.
    if (presence.threads) parts.push(concurrent !== null && concurrent > 0 ? `Up to ${concurrent} thread${concurrent === 1 ? "" : "s"} busy at the same moment.` : `${threads.length} threads sampled.`);
    if (presence.tasks && tasksArr) parts.push(`Up to ${Math.ceil(tasksMax - 1e-6)} tasks suspended on average per moment.`);
    const first = topItems[0];
    if (first && first.times.length && presence.topRows) {
      const loc = first.line ? fmtLoc(first.file.name, first.line.no) : first.code;
      parts.push(`The top ${first.kind === "file" ? "file" : first.kind === "function" ? "function" : "line"}, ${loc}, ${topMetric === "memory" ? "allocated" : "ran"} from ${fmtTime(first.times[0])} to ${fmtTime(first.times[first.times.length - 1])}.`);
    }
    caption.textContent = parts.join(" ");
  }

  // ── Range ──
  function setRange(r: [number, number] | null, emit: boolean): void {
    range = r;
    if (emit) {
      store.set({ range: r });
      bus.emit("range:set", { range: r, source: "scope" });
    }
    renderHeader();
    drawOverlay();
  }

  // ── Linked line resolution ──
  function resolveLink(target: Target, item?: HotspotItem): LinkedLine | null {
    const key = item ? `item:${item.kind}:${item.target.file}:${"line" in item.target ? item.target.line : item.target.fn}` : `${target.file}:${"line" in target ? target.line : `fn:${target.fn}`}`;
    const hit = linkCache.get(key);
    if (hit) return hit;
    let out: LinkedLine | null = null;
    if (item && item.kind === "file") {
      const f = item.file;
      out = {
        kind: "file",
        target: item.target,
        label: f.base,
        cpu: unionTimes(f.lines.map((l) => l.cpuTimes)),
        mem: unionTimes(f.lines.map((l) => sampleTimes(l.memSamples))),
        leak: f.leaks.length > 0,
      };
    } else if ("fn" in target) {
      const fn = functionAt(model, target.file, target.fn);
      if (fn) out = { kind: "function", target, label: `${fn.name}()`, cpu: unionTimes(fn.members.map((l) => l.cpuTimes)), mem: sampleTimes(fn.memSamples), leak: fn.members.some((l) => l.leak) };
    } else {
      const l = lineAt(model, target.file, target.line);
      if (l) out = { kind: "line", target, label: fmtLoc(l.file.name, l.no), cpu: l.cpuTimes, mem: sampleTimes(l.memSamples), leak: Boolean(l.leak) };
    }
    if (out) {
      if (linkCache.size > 200) linkCache.clear();
      linkCache.set(key, out);
    }
    return out;
  }

  // ── Interaction ──
  const localX = (ev: PointerEvent | MouseEvent): number => ev.clientX - host.getBoundingClientRect().left;
  const localY = (ev: PointerEvent | MouseEvent): number => ev.clientY - host.getBoundingClientRect().top;

  function topRowAt(px: number, py: number): number | null {
    if (!g) return null;
    const r = channelRect(g, "top");
    if (!r || presence.topRows === 0) return null;
    if (py < r.y || py >= r.y + r.h || px < 0 || px > g.width) return null;
    return Math.min(presence.topRows, Math.floor((py - r.y) / (r.h / presence.topRows)) + 1);
  }

  function phaseAt(px: number, py: number): PhaseCell<Phase> | null {
    if (!g) return null;
    const r = channelRect(g, "phase");
    if (!r || py < r.y || py > r.y + r.h) return null;
    const i = phaseCellAt(cells, px);
    return i >= 0 ? cells[i] : null;
  }

  function gutterHelp(px: number, py: number): { title: string; hint?: string; rows?: [string, string][] } | null {
    if (!g || px >= g.plot.x || g.m.gutterL === 0) return null;
    const ch = g.channels.find((c) => py >= c.rect.y - 2 && py <= c.rect.y + Math.max(c.rect.h, 28));
    if (!ch) return null;
    switch (ch.id) {
      case "phase":
        return { title: "Phase", hint: "What the main thread was doing: its outermost loop, or the frame below the entry point. Hatched cells are short phases." };
      case "memory":
        return { title: "Memory footprint", hint: `Program footprint over the run (sampled), from 0 to ${memScale.ticks.ticks[memScale.ticks.ticks.length - 1]?.label ?? ""}. Ticks under it show when the linked line allocated.` };
      case "threads": {
        const lt = model.sampling.laneTotals;
        return {
          title: "Threads busy",
          hint: `Mean number of threads sampled in each state per ${fmtTime(tMax / threadBucketCount(tMax, model.sampling.dt))} window (the same at every window width); GC counts as busy.${concurrent !== null ? ` At most ${concurrent} were busy at the same moment.` : ""}`,
          rows: lt ? [["GC", `${lt.gc.toFixed(1)}% of samples`], ["I/O & waits", `${lt.io.toFixed(1)}% of samples`], ["GIL", `${lt.gil.toFixed(1)}% of samples`]] : undefined,
        };
      }
      case "tasks":
        return { title: "Suspended tasks", hint: "Mean number of coroutines suspended in await at each sample instant." };
      case "top":
        return {
          title: topMetric === "memory" ? "When the top 5 allocated" : "When the top 5 ran",
          hint:
            topMetric === "memory"
              ? "Allocation and free events of each hotspot (Scalene keeps up to 100 per line); each strip is scaled to its own peak."
              : "Main-thread CPU samples, up to 500 kept per line; each strip is scaled to its own peak.",
        };
      default:
        return null;
    }
  }

  function onMove(ev: PointerEvent): void {
    if (!g) return;
    const px = localX(ev);
    const py = localY(ev);
    if (drag) {
      drag.t1 = tAt(px);
      if (Math.abs(px - drag.x0) >= (ev.pointerType === "touch" ? 10 : 4)) drag.moved = true;
      if (drag.moved) {
        hoverX = null;
        touchPin = null;
        renderCard(null);
        ctx.tooltip.hide();
        drawOverlay();
        return;
      }
    }
    // A finger has no hover: the pinned readout (onTouchTap) stays until the next tap.
    if (ev.pointerType === "touch") return;
    const inPlot = px >= g.plot.x - 2 && px <= g.plot.x + g.plot.w + 2 && py >= g.plot.y - 4 && py <= g.axis.y + g.axis.h;
    hoverX = inPlot ? px : null;
    const row = topRowAt(px, py);
    if (row !== hoveredRow) {
      hoveredRow = row;
      rowHoverCb(row);
      const it = row ? topItems[row - 1] : null;
      if (it) {
        linkedRank = row;
        linked = resolveLink(it.target, it);
        bus.emit("hover:line", { target: it.target, source: "scope" });
      } else if (linkedRank !== null) {
        linkedRank = null;
        linked = null;
        bus.emit("hover:line", { target: null, source: "scope" });
      }
      renderHeader();
    }
    const cell = phaseAt(px, py);
    const help = gutterHelp(px, py);
    if (cell) {
      const p = cell.members[0];
      if (cell.members.length === 1) {
        ctx.tooltip.show(
          { x: ev.clientX, y: ev.clientY },
          {
            kind: p.loop ? "loop" : "phase",
            code: p.label,
            rows: [
              ["Where", fmtLoc(p.file, p.line)],
              ["When", fmtRange(p.t0, p.t1)],
              ["Share", `${p.share < 0.05 ? "<0.1" : p.share.toFixed(1)}% of main-thread samples`],
            ],
            hint: "Click to open the line",
          },
        );
      } else {
        const list = cell.members.slice(0, 6).map((m): [string, string] => [shortCode(m.label, 30) ?? fmtLoc(m.file, m.line), fmtTime(m.t1 - m.t0)]);
        if (cell.members.length > 6) list.push([`+${cell.members.length - 6} more`, ""]);
        ctx.tooltip.show({ x: ev.clientX, y: ev.clientY }, { title: `${cell.members.length} short phases`, rows: list, hint: fmtRange(cell.t0, cell.t1) });
      }
    } else if (help) ctx.tooltip.show({ x: ev.clientX, y: ev.clientY }, help);
    else ctx.tooltip.hide();
    renderCard(cell || help || row ? null : hoverX);
    drawOverlay();
  }

  function onLeave(ev?: PointerEvent): void {
    if (drag) return;
    hoverX = null;
    if (touchPin || ev?.pointerType === "touch") {
      drawOverlay();
      return;
    }
    renderCard(null);
    ctx.tooltip.hide();
    if (hoveredRow !== null) {
      hoveredRow = null;
      rowHoverCb(null);
      if (linkedRank !== null) {
        linkedRank = null;
        linked = null;
        bus.emit("hover:line", { target: null, source: "scope" });
        renderHeader();
      }
    }
    drawOverlay();
  }

  function jumpAtPoint(px: number, py: number): void {
    const row = topRowAt(px, py);
    if (row && topItems[row - 1]) {
      void ctx.nav.jumpTo(topItems[row - 1].target, { source: "scope" });
      return;
    }
    const cell = phaseAt(px, py);
    if (cell && cell.members.length === 1) {
      const p = cell.members[0];
      void ctx.nav.jumpTo({ file: p.file, line: p.line }, { source: "scope" });
      return;
    }
    jumpAtTime(tAt(px));
  }

  function jumpAtTime(tv: number): boolean {
    const r = readoutAt(tv);
    if (r.leaf) void ctx.nav.jumpTo({ file: r.leaf.file, line: r.leaf.line }, { source: "scope" });
    return Boolean(r.leaf);
  }

  // ── Touch (review round 1): tap = read (cursor + readout card), tap again = open ──
  function clearTouch(): void {
    if (!touchPin) return;
    touchPin = null;
    cursorT = null;
    renderCard(null);
    drawOverlay();
  }
  function onTouchTap(px: number, py: number): void {
    if (!g) return;
    if (touchPin && Math.abs(px - touchPin.px) <= 16 && Math.abs(py - touchPin.py) <= 24) {
      clearTouch();
      jumpAtPoint(px, py);
      return;
    }
    const cx = Math.max(g.plot.x, Math.min(g.plot.x + g.plot.w, px));
    touchPin = { px, py };
    cursorT = tAt(cx);
    hoverX = null;
    const row = topRowAt(px, py);
    linkedRank = row;
    linked = row && topItems[row - 1] ? resolveLink(topItems[row - 1].target, topItems[row - 1]) : null;
    renderHeader();
    renderCard(cx, true);
    drawOverlay();
    announceAt(cursorT);
  }
  disposer.add(
    listen(document, "pointerdown", (ev: PointerEvent) => {
      if (touchPin && !host.contains(ev.target as Node)) clearTouch();
    }),
  );
  disposer.add(listen(window, "scroll", () => clearTouch(), { passive: true }));

  disposer.add(listen(ov, "pointermove", onMove));
  disposer.add(listen(ov, "pointerleave", onLeave));
  disposer.add(
    listen(ov, "pointerdown", (ev: PointerEvent) => {
      if (ev.button !== 0 || !g) return;
      const px = localX(ev);
      if (px < g.plot.x - 2 || px > g.plot.x + g.plot.w + 2) return;
      const t0 = tAt(px);
      drag = { x0: px, t0, t1: t0, moved: false, id: ev.pointerId };
    }),
  );
  disposer.add(
    listen(ov, "pointerup", (ev: PointerEvent) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      try {
        if (ov.hasPointerCapture(d.id)) ov.releasePointerCapture(d.id);
      } catch {
        // Capture may already be gone.
      }
      if (d.moved) {
        const a = Math.min(d.t0, d.t1);
        const b = Math.max(d.t0, d.t1);
        setRange(b - a > 0 ? [a, b] : null, true);
      } else if (ev.pointerType === "touch") onTouchTap(localX(ev), localY(ev));
      else jumpAtPoint(localX(ev), localY(ev));
      drawOverlay();
    }),
  );
  // Capture only once a drag really starts, so vertical touch scrolling stays native.
  disposer.add(
    listen(ov, "pointermove", (ev: PointerEvent) => {
      if (drag && drag.moved && !ov.hasPointerCapture(ev.pointerId)) {
        try {
          ov.setPointerCapture(ev.pointerId);
        } catch {
          // Synthetic events cannot be captured.
        }
      }
    }),
  );
  disposer.add(
    listen(ov, "pointercancel", () => {
      drag = null;
      drawOverlay();
    }),
  );

  // Keyboard (§4.4.8)
  disposer.add(
    listen(ov, "keydown", (ev: KeyboardEvent) => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const step1 = tMax / 100;
      const cur = cursorT ?? (range ? range[1] : 0);
      let next: number | null = null;
      let extend = false;
      switch (ev.key) {
        case "ArrowRight":
          next = cur + step1;
          extend = ev.shiftKey;
          break;
        case "ArrowLeft":
          next = cur - step1;
          extend = ev.shiftKey;
          break;
        case "PageUp":
          next = cur - 10 * step1;
          extend = ev.shiftKey;
          break;
        case "PageDown":
          next = cur + 10 * step1;
          extend = ev.shiftKey;
          break;
        case "Home":
          next = 0;
          extend = ev.shiftKey;
          break;
        case "End":
          next = tMax;
          extend = ev.shiftKey;
          break;
        case "Enter":
          ev.preventDefault();
          if (!jumpAtTime(cur)) ctx.announce.polite(`No Python line at ${spokenTime(cur)}: the main thread was not sampled in profiled code then`);
          return;
        case "ArrowUp":
        case "ArrowDown":
          // The chart is a role=application: vertical arrows stay inside (no page scroll).
          ev.preventDefault();
          return;
        case "Escape":
          if (range) {
            ev.preventDefault();
            anchorT = null;
            setRange(null, true);
          } else if (store.get().selection) {
            ev.preventDefault();
            store.set({ selection: null });
          }
          return;
        default:
          return;
      }
      ev.preventDefault();
      const nt = Math.max(0, Math.min(tMax, next));
      if (extend) {
        if (anchorT === null) anchorT = range ? range[0] : cur;
        const a = Math.min(anchorT, nt);
        const b = Math.max(anchorT, nt);
        setRange(b > a ? [a, b] : null, true);
      } else anchorT = null;
      cursorT = nt;
      hoverX = null;
      renderCard(x(nt));
      drawOverlay();
      announceAt(nt);
    }),
  );
  let pointerAt = -1;
  disposer.add(listen(ov, "pointerdown", () => (pointerAt = performance.now())));
  disposer.add(
    listen(ov, "focus", () => {
      if (performance.now() - pointerAt < 500) return; // pointer focus: no keyboard cursor
      if (cursorT === null) cursorT = peak ? peak.t : 0;
      renderCard(x(cursorT));
      drawOverlay();
    }),
  );
  disposer.add(
    listen(ov, "blur", () => {
      cursorT = null;
      anchorT = null;
      renderCard(null);
      drawOverlay();
    }),
  );
  disposer.add(ctx.tooltip ? () => ctx.tooltip.hide() : null);
  ctx.tooltip && disposer.add(listen(info, "click", () => showInfo()));
  function showInfo(): void {
    ctx.tooltip.show(info, {
      title: "Signal: the run over time",
      hint: `Time runs from the start of profiling (0 s) to ${fmtTime(tMax)}. Thread activity starts at the first sampled run (offset ≤ ${fmtTime(model.sampling.dt)}). Hover to read values, drag to select a range, click to open the line the main thread was running.`,
    });
  }
  disposer.add(listen(info, "mouseenter", showInfo));
  disposer.add(listen(info, "focus", showInfo));
  disposer.add(listen(info, "mouseleave", () => ctx.tooltip.hide()));
  disposer.add(listen(info, "blur", () => ctx.tooltip.hide()));

  // ── Bus / store wiring ──
  disposer.add(
    bus.on("theme:changed", () => {
      if (!g) return;
      endIntro();
      buildCaches();
      composite();
      drawOverlay();
    }),
  );
  disposer.add(
    bus.on("hover:peak", ({ on }) => {
      if (!on || !peak || !g) return;
      cancelAnimationFrame(pulseFrame);
      pulse = { start: performance.now(), reduced: ctx.motion.reduced || ctx.host.flags.still };
      const end = pulse.reduced ? DUR.flash : DUR.d5;
      const tick = (now: number) => {
        if (!pulse) return;
        drawOverlay(now);
        if (now - pulse.start < end) pulseFrame = requestAnimationFrame(tick);
        else {
          pulse = null;
          drawOverlay();
        }
      };
      pulseFrame = requestAnimationFrame(tick);
    }),
  );
  disposer.add(() => cancelAnimationFrame(pulseFrame));
  disposer.add(
    bus.on("range:set", ({ range: r, source }) => {
      if (source === "scope") return;
      range = r;
      renderHeader();
      drawOverlay();
    }),
  );
  disposer.add(
    store.subscribe(
      (s) => s.range,
      (r) => {
        if (r === range) return;
        range = r;
        renderHeader();
        drawOverlay();
      },
    ),
  );
  disposer.add(
    store.subscribe(
      (s) => s.selection,
      (sel) => {
        selectionLink = sel ? resolveLink(sel) : null;
        renderHeader();
        drawOverlay();
      },
    ),
  );
  if (store.get().selection) selectionLink = resolveLink(store.get().selection as Target);

  // Timeline (lazy, sliced): phases, buckets and tasks arrive after first paint.
  let alive = true;
  disposer.add(() => (alive = false));
  if (model.caps.timeline) {
    void model.timeline().then((timeline) => {
      if (!alive || !timeline) return;
      tl = timeline;
      tasksPresent = model.caps.async && timeline.maxTasks > 0;
      // Channels may change (TASKS appears, PHASE may prove to be anonymous hatching): relayout.
      if (g) relayout(g.width, mode === "side" ? host.clientHeight : null);
      updateCaption();
    });
  }

  // Size tracking.
  disposer.add(
    observeSize(host, (w, hh) => {
      if (!w) return;
      if (g && Math.abs(w - g.width) < 0.5 && (mode === "stack" || Math.abs(hh - g.height) < 0.5)) return;
      relayout(w, mode === "side" ? hh : null);
    }),
  );
  disposer.add(
    store.subscribe(
      (s) => s.layout,
      () => {
        if (g) relayout(host.clientWidth || g.width, mode === "side" ? host.clientHeight : null);
      },
    ),
  );

  // ── Warm-up: resolve the hotspots' sample sets and run one linked overlay draw while idle, so
  // the first hover on a hotspot pays no allocation or first-run cost (§4.4.6: ≤ 2 ms per draw).
  let warmCancel: (() => void) | null = null;
  let warmed = false;
  function warmNow(): void {
    for (const it of topItems) resolveLink(it.target, it);
    const first = topItems[0];
    if (!g || !first || linked || selectionLink) return;
    linked = resolveLink(first.target, first);
    linkedRank = 1;
    drawOverlay();
    linked = null;
    linkedRank = null;
    drawOverlay();
    warmed = true;
  }
  function scheduleWarm(): void {
    // The first time synchronously (≈ 1 ms at mount, before anyone can hover), later lists idle.
    if (!warmed) return warmNow();
    warmCancel?.();
    warmCancel = idle(() => {
      warmCancel = null;
      warmNow();
    }, 2000);
  }
  disposer.add(() => warmCancel?.());

  // ── Intro (M4): compositor stage (scope-intro.ts) ──
  function endIntro(): void {
    if (introDeferred) {
      stopDeferral();
      sweep = 1;
      composite();
    }
    if (!stage) return;
    const st = stage;
    stage = null;
    st.destroy();
    sweep = 1;
    composite();
    drawOverlay();
  }

  /**
   * Start the sweep now when the scope is on screen; otherwise (phones put it below the hotspots)
   * keep the data hidden and sweep on its own clock when it first scrolls into view (as M18 does
   * for the other time charts), so the moment is seen rather than spent off-screen.
   */
  function beginIntro(): void {
    const r = host.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight);
    if (onScreen || typeof IntersectionObserver !== "function") {
      startIntro(null);
      return;
    }
    introDeferred = true;
    introClock = null;
    composite();
    introIo = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        stopDeferral();
        startIntro(null, "in view");
      },
      { threshold: 0.15 },
    );
    introIo.observe(host);
  }

  function stopDeferral(): void {
    introIo?.disconnect();
    introIo = null;
    introDeferred = false;
  }

  function startIntro(startTime: number | null, reason = "intro"): void {
    if (!g || stage) return;
    introBuilds.push({ at: Math.round(performance.now()), startTime, reason });
    const mem = channelRect(g, "memory");
    let head: (number | null)[] | null = null;
    let peakSpec: { x: number; y: number; callout: HTMLCanvasElement | null } | null = null;
    if (mem && memSamples) {
      const s = footprintScales({ x: mem.x, y: mem.y, w: mem.w, h: mem.h - 1 }, [0, tMax], memScale.top);
      const n = Math.max(24, Math.min(160, Math.round(g.plot.w / 6)));
      head = [];
      for (let i = 0; i <= n; i++) {
        const fp = footprintAt(memSamples, (i / n) * tMax);
        head.push(fp ? s.y(fp.mb) : null);
      }
      if (peak) {
        let cv: HTMLCanvasElement | null = null;
        if (calloutPlan && calloutText && calloutPlan.kind !== "gutter") {
          cv = makeCanvas();
          cv.width = pair.base.width;
          cv.height = pair.base.height;
          const c = cv.getContext("2d") as CanvasRenderingContext2D;
          c.setTransform(pair.dpr, 0, 0, pair.dpr, 0, 0);
          drawCallout(c, calloutPlan, calloutText, theme, 1);
        }
        peakSpec = { x: s.x(peak.t), y: s.y(peak.mb), callout: cv };
      }
    }
    stage = createIntroStage({
      host,
      before: pair.overlay,
      width: g.width,
      height: g.height,
      plot: g.plot,
      data: dataCv,
      dpr: pair.dpr,
      dark: theme.current() === "dark",
      glow: theme.num("glow"),
      tokens: theme.tokens(),
      head,
      peak: peakSpec,
      axisY: g.axis.y,
      chipText: (p) => fmtTime(p * tMax),
      startTime,
    });
    const built = stage;
    if (startTime !== null) introOrigin = startTime;
    else
      void (introClock ?? stage.origin).then((o) => {
        introOrigin = o;
        if (stage === built) built.sync(o);
      });
    sweep = 0;
    composite();
    drawOverlay();
    const mine = stage;
    void mine.finished.then(() => {
      if (stage === mine) endIntro();
    });
  }

  const handle: ScopeHandle = {
    el,
    present: true,
    drawable: () => drawableNow,
    onDrawable(cb) {
      drawableCb = cb;
    },
    setTopLines(items, metric) {
      const prevRows = presence.topRows;
      const prevMetric = topMetric;
      topItems = items.slice();
      topMetric = metric;
      linkCache.clear();
      if (linkedRank !== null) {
        linked = null;
        linkedRank = null;
      }
      const rows = effectivePresence(basePresence(), metrics, mode === "side").topRows;
      if (g && (rows !== prevRows || prevMetric !== metric)) relayout(g.width, mode === "side" ? host.clientHeight : null);
      else if (g) {
        computeData();
        buildCaches();
        stage?.refresh();
        composite();
        drawOverlay();
      }
      updateCaption();
      scheduleWarm();
    },
    link(src, from) {
      if (from === "scope") return;
      const target = src.target;
      linkedRank = null;
      linked = target ? resolveLink(target, src.item) : null;
      if (src.item && target) linkedRank = topItems.indexOf(src.item) + 1 || null;
      renderHeader();
      drawOverlay();
    },
    intro(instant, clock) {
      endIntro();
      pendingIntro = false;
      introClock = clock ?? null;
      if (instant || typeof Element.prototype.animate !== "function") {
        sweep = 1;
        composite();
        drawOverlay();
        return;
      }
      introOrigin = null;
      if (g) beginIntro();
      else pendingIntro = true;
    },
    setMode(m) {
      if (m === mode && g) return;
      mode = m;
      el.dataset.mode = m;
      if (host.isConnected) relayout(host.clientWidth || 600, mode === "side" ? host.clientHeight : null);
    },
    onRowHover(cb) {
      rowHoverCb = cb;
    },
    debugLayout() {
      const hostBox = host.getBoundingClientRect();
      let chip: Annotation | null = null;
      const chipEl = desc.querySelector(".range-chip");
      if (chipEl) {
        const cr = chipEl.getBoundingClientRect();
        const hr = head.getBoundingClientRect();
        chip = {
          kind: "chip",
          rect: { x: cr.left - hostBox.left, y: cr.top - hostBox.top, w: cr.width, h: cr.height },
          bounds: { x: hr.left - hostBox.left, y: hr.top - hostBox.top, w: hr.width, h: hr.height },
        };
      }
      const all = annotations.slice();
      if (chip) all.push(chip);
      const calloutAnn = annotations.find((a) => a.kind === "callout");
      const trace: number[] = [];
      if (band) for (let c = 0; c < band.top.length; c++) if (!Number.isNaN(band.top[c])) trace.push(band.x0 + c, band.top[c], band.bottom[c]);
      return {
        width: g?.width ?? 0,
        height: g?.height ?? 0,
        plot: g ? { ...g.plot } : { x: 0, y: 0, w: 0, h: 0 },
        channels: g ? g.channels.map((c) => ({ id: c.id, rect: { ...c.rect } })) : [],
        ticks: tickAnn.slice(),
        callout: calloutAnn && calloutPlan ? { ...calloutAnn, plan: calloutPlan.kind, spot: calloutSpot } : null,
        trace,
        threads: presence.threads && buckets ? { top: countTicks(busyTop)[1] ?? busyTop, concurrent, buckets: buckets.nb } : null,
        description: caption.textContent ?? "",
        chip,
        phaseCells: phaseAnn.slice(),
        annotations: all,
        overlayMs,
        sweep: stage ? stage.progress() : sweep,
        intro: { builds: introBuilds.slice(), origin: introOrigin },
      };
    },
    destroy() {
      endIntro();
      disposer.dispose();
      pair.destroy();
      el.remove();
    },
  };

  // First layout happens when the orchestrator attaches the pane and sets the mode.
  renderHeader();
  updateCaption();
  return handle;
}

/** Geometry self-check used by tests: annotations disjoint and inside their bounds. */
export function checkAnnotations(list: readonly Annotation[]): string[] {
  const errors: string[] = [];
  const eps = 0.51;
  for (const a of list) {
    const shrunk = { x: a.rect.x + eps, y: a.rect.y + eps, w: Math.max(0, a.rect.w - 2 * eps), h: Math.max(0, a.rect.h - 2 * eps) };
    if (!contains(a.bounds, shrunk)) errors.push(`${a.kind} "${a.text ?? ""}" leaves its bounds`);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const sa = { x: a.rect.x + eps, y: a.rect.y + eps, w: a.rect.w - 2 * eps, h: a.rect.h - 2 * eps };
      const sb = { x: b.rect.x + eps, y: b.rect.y + eps, w: b.rect.w - 2 * eps, h: b.rect.h - 2 * eps };
      if (intersects(sa, sb)) errors.push(`${a.kind} "${a.text ?? ""}" overlaps ${b.kind} "${b.text ?? ""}"`);
    }
  }
  return errors;
}
