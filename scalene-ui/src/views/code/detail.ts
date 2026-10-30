// Detail panel (DESIGN.md §4.9): one component, two layouts. The dock (xl+) is a sticky
// aside next to the table; the lens (below xl) is an inline item after the selected row
// with a 3 / 2 / 1 column grid. Content: head (location, context, badges, actions, the
// source line), then blocks (Time, When it ran, Memory, GPU, Async, Neuron, Call context)
// and the AI footer. A block whose fields are absent says "not recorded".
import { button, badge } from "../../core/controls";
import { h, replaceChildren, type Child } from "../../core/dom";
import { fmtCount, fmtMem, fmtPct, fmtRate, fmtTime, fmtUtil } from "../../core/format";
import { icon } from "../../core/icons";
import { bindTooltip } from "../../core/tooltip";
import { meter } from "../../charts/meter";
import { binCount, binTimes, drawRaster } from "../../charts/raster";
import { drawFootprint, footprintScales } from "../../charts/footprint";
import { alpha as withAlpha, crisp, observeSize, setFont, uiFont } from "../../core/canvas";
import type { ThemeApi } from "../../core/theme";
import type { FunctionM, LineM, Model } from "../../model/model";
import { functionTarget, lineTarget } from "../../model/model";
import type { CallContext, CallEdge } from "../../model/stacks";
import { highlight } from "../../model/syntax";
import { idleBand } from "../../model/thresholds";
import * as P from "../../model/phrases";
import type { ViewContext } from "../app";
import { functionPyFrac, memSegments, ncShare, nrtShare, timeSegments } from "./columns";
import { renderSpans } from "./source";

export type DetailSubject = { kind: "line"; line: LineM } | { kind: "fn"; fn: FunctionM };
export type DetailLayout = "dock" | "lens";

export interface DetailActions {
  close(): void;
  optimize(line: LineM, mode: "line" | "region"): void;
  goToFunction(fn: FunctionM): void;
}

export interface DetailHandle {
  el: HTMLElement;
  /** Render (or re-render) for a subject; null shows the dock's empty state. */
  update(subject: DetailSubject | null, layout: DetailLayout, columns: number): void;
  /** Redraw canvases (theme change) without rebuilding. */
  redraw(): void;
  /** Re-render the AI footer (settings changed). */
  refreshAi(): void;
  subject(): DetailSubject | null;
  destroy(): void;
}

interface Block {
  id: string;
  weight: number;
  el: HTMLElement;
}

const TASK_CHIPS = 12;

// ── Small builders ───────────────────────────────────────────────────────────

function blockHead(label: string, token: string | null, extra?: Child): HTMLElement {
  return h(
    "div",
    { class: "cd-block-head" },
    token ? h("span", { class: "cd-led", style: { "--led": `var(--${token})` }, "aria-hidden": "true" }) : null,
    h("h4", { class: "cd-block-title micro" }, label),
    extra ?? null,
  );
}

function kv(rows: readonly [Child, Child][]): HTMLElement {
  return h(
    "dl",
    { class: "cd-kv" },
    rows.map(([k, v]) => h("div", { class: "cd-kv-row" }, h("dt", null, k), h("dd", null, v))),
  );
}

function big(value: string, rest: string): HTMLElement {
  return h("p", { class: "cd-big" }, h("strong", { class: "cd-big-num" }, value), rest ? h("span", { class: "cd-big-rest" }, ` ${rest}`) : null);
}

function swatch(token: string, hatch = false): HTMLElement {
  return h("span", { class: ["cd-sw", hatch ? "is-hatch" : ""], style: { "--sw": `var(--${token})` }, "aria-hidden": "true" });
}

function note(text: Child, cls = ""): HTMLElement {
  return h("p", { class: ["cd-note", cls] }, text);
}

function code(text: string): HTMLElement {
  return h("code", { class: "cd-inline-code" }, text);
}

/** "abcdef…uvwxyz": keep the head and the (more telling) tail of a long path. */
export function middleEllipsis(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.4);
  const tail = max - 1 - head;
  return `${cps.slice(0, head).join("")}…${cps.slice(cps.length - tail).join("")}`;
}

/** Contiguous partition of blocks into `n` columns minimising the tallest column. */
export function partitionBlocks(weights: readonly number[], n: number): number[][] {
  const k = Math.max(1, Math.min(n, weights.length));
  if (weights.length === 0) return [];
  const pre = [0];
  for (const w of weights) pre.push(pre[pre.length - 1] + w);
  const sum = (a: number, b: number) => pre[b] - pre[a];
  const m = weights.length;
  // best[j][i]: minimal max-sum for the first i blocks in j columns.
  const best: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(m + 1).fill(0));
  best[0][0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = 1; i <= m; i++) {
      for (let p = j - 1; p < i; p++) {
        const v = Math.max(best[j - 1][p], sum(p, i));
        if (v < best[j][i]) {
          best[j][i] = v;
          cut[j][i] = p;
        }
      }
    }
  }
  const groups: number[][] = [];
  let i = m;
  for (let j = k; j >= 1; j--) {
    const p = cut[j][i];
    const g: number[] = [];
    for (let x = p; x < i; x++) g.push(x);
    groups.unshift(g);
    i = p;
  }
  return groups.filter((g) => g.length > 0);
}

// ── Canvas charts ────────────────────────────────────────────────────────────

interface ChartSpec {
  canvas: HTMLCanvasElement;
  height: number;
  draw(ctx: CanvasRenderingContext2D, w: number, hgt: number): void;
}

function sizeCanvas(c: HTMLCanvasElement, w: number, hgt: number): CanvasRenderingContext2D | null {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const cw = Math.max(1, Math.round(w * dpr));
  const ch = Math.max(1, Math.round(hgt * dpr));
  if (c.width !== cw) c.width = cw;
  if (c.height !== ch) c.height = ch;
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  return ctx;
}

/** "When it ran": histogram strip of the line's main-thread sample times on [0, tMax]. */
function drawWhen(theme: ThemeApi, times: Float64Array, tMax: number) {
  return (ctx: CanvasRenderingContext2D, w: number, hgt: number) => {
    const t = theme.tokens();
    const stripH = hgt - 14;
    ctx.fillStyle = t["sunken"];
    ctx.fillRect(0, 0, w, stripH);
    const n = binCount(w);
    const bins = binTimes(times, 0, tMax || 1, n);
    drawRaster(ctx, bins, { x: 0, y: 2, w, h: stripH - 2 }, { fill: t["cpu-py"], baseline: t["grid-strong"] });
    setFont(ctx, uiFont(theme, 11));
    ctx.fillStyle = t["fg-3"];
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText("0", 0, hgt);
    ctx.textAlign = "right";
    ctx.fillText(fmtTime(tMax), w, hgt);
  };
}

/** Footprint chart (graft from C): program footprint (grey area) + this line's allocation moments (dots). */
function drawFootprintChart(theme: ThemeApi, m: Model, samples: Float64Array, leak: boolean) {
  return (ctx: CanvasRenderingContext2D, w: number, hgt: number) => {
    const t = theme.tokens();
    const yMax = Math.max(m.memory?.peak ?? 0, m.maxLinePeak, 1e-9);
    const gutterR = 52;
    const plot = { x: 0, y: 6, w: Math.max(10, w - gutterR), h: hgt - 6 - 18 };
    const domain: [number, number] = [0, m.tMax || 1];
    // Gridlines at 0 and the peak.
    ctx.fillStyle = t["grid-strong"];
    ctx.fillRect(plot.x, crisp(plot.y + plot.h) - 0.5, plot.w, 1);
    ctx.fillStyle = t["grid"];
    ctx.fillRect(plot.x, crisp(plot.y) - 0.5, plot.w, 1);
    if (m.memory && m.memory.samples.length >= 4) {
      drawFootprint(ctx, m.memory.samples, { rect: plot, domain, yMax, theme, token: "line-strong", areaOnly: true });
    }
    const s = footprintScales(plot, domain, yMax);
    const color = leak ? t["danger"] : t["mem-py"];
    ctx.fillStyle = color;
    const glow = theme.num("glow");
    if (glow > 0) {
      ctx.shadowBlur = 6 * glow;
      ctx.shadowColor = withAlpha(color, 0.6);
    }
    for (let i = 0; i + 1 < samples.length; i += 2) {
      ctx.beginPath();
      ctx.arc(s.x(samples[i]), s.y(samples[i + 1]), 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    setFont(ctx, uiFont(theme, 11));
    ctx.fillStyle = t["fg-3"];
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(fmtMem(yMax), plot.x + plot.w + 6, plot.y + 1);
    ctx.fillText("0", plot.x + plot.w + 6, plot.y + plot.h);
    ctx.textBaseline = "bottom";
    ctx.fillText("0", 0, hgt);
    ctx.textAlign = "right";
    ctx.fillText(fmtTime(m.tMax), plot.x + plot.w, hgt);
  };
}

// ── The component ───────────────────────────────────────────────────────────

export function createDetail(ctx: ViewContext, actions: DetailActions): DetailHandle {
  const m = ctx.model;
  const el = h("div", { class: "cd" });
  let current: DetailSubject | null = null;
  let layout: DetailLayout = "lens";
  let cols = 3;
  let charts: ChartSpec[] = [];
  let sizeStops: (() => void)[] = [];
  let ctxToken = 0;
  let aiFooter: HTMLElement | null = null;

  const stopCharts = () => {
    for (const s of sizeStops) s();
    sizeStops = [];
    charts = [];
  };

  const addChart = (height: number, draw: ChartSpec["draw"], label: string): HTMLElement => {
    const canvas = h("canvas", { class: "cd-canvas", "aria-hidden": "true" });
    const wrap = h("div", { class: "cd-chart", style: { height: `${height}px` }, role: "img", "aria-label": label }, canvas);
    const spec: ChartSpec = { canvas, height, draw };
    charts.push(spec);
    sizeStops.push(
      observeSize(wrap, (w) => {
        const c2 = sizeCanvas(canvas, Math.floor(w), height);
        if (c2) spec.draw(c2, Math.floor(w), height);
      }),
    );
    return wrap;
  };

  const redraw = () => {
    for (const c of charts) {
      const w = Math.floor(c.canvas.parentElement?.clientWidth ?? 0);
      if (!w) continue;
      const c2 = sizeCanvas(c.canvas, w, c.height);
      if (c2) c.draw(c2, w, c.height);
    }
  };

  // ── Head ──────────────────────────────────────────────────────────────────

  const headActions = (subject: DetailSubject): HTMLElement => {
    const target = subject.kind === "line" ? lineTarget(subject.line) : functionTarget(subject.fn);
    const file = subject.kind === "line" ? subject.line.file : subject.fn.file;
    const lineNo = subject.kind === "line" ? subject.line.no : subject.fn.no;
    const btns: HTMLElement[] = [];
    btns.push(button({ label: "Open in editor", icon: "external", variant: "ghost", compact: true, onClick: () => ctx.nav.openInEditor(file.name, lineNo) }));
    if (subject.kind === "fn") {
      btns.push(button({ label: "Go to source", icon: "code", variant: "ghost", compact: true, onClick: () => actions.goToFunction(subject.fn) }));
    }
    if (m.caps.stacks) btns.push(button({ label: "Show in stacks", icon: "flame", variant: "ghost", compact: true, onClick: () => void ctx.nav.showInStacks(target) }));
    if (subject.kind === "line" && m.caps.timeline && (subject.line.cpuTimes.length > 0 || subject.line.total > 0)) {
      btns.push(button({ label: "Show in timeline", icon: "lanes", variant: "ghost", compact: true, onClick: () => void ctx.nav.showInTimeline(target) }));
    }
    const close = h(
      "button",
      { type: "button", class: "icon-btn icon-btn-sm cd-close", "aria-label": layout === "dock" ? "Clear selection" : "Close details", onClick: () => actions.close() },
      icon("x"),
    );
    return h("div", { class: "cd-actions" }, btns, close);
  };

  const head = (subject: DetailSubject): HTMLElement => {
    const parts: Child[] = [];
    if (subject.kind === "line") {
      const l = subject.line;
      parts.push(h("h3", { class: "cd-loc mono" }, `${l.file.base}:${l.no}`));
      const ctxBits: Child[] = [];
      if (l.fn) ctxBits.push(h("span", null, "in ", code(`${l.fn.name}()`)));
      else ctxBits.push(h("span", null, "module level"));
      if (l.region[0] !== l.region[1]) ctxBits.push(h("span", null, `region ${l.region[0]}–${l.region[1]}`));
      const badges: Child[] = [];
      if (l.leak) badges.push(badge("possible leak", { variant: "danger", icon: "trend-up" }));
      if (m.async?.loopLine === l) badges.push(badge("event loop · waiting", { variant: "neutral", icon: "wait" }));
      if (l.coro) badges.push(badge("coroutine", { variant: "neutral" }));
      parts.push(h("p", { class: "cd-context" }, ctxBits.map((c, i) => [i ? h("span", { class: "cd-dot", "aria-hidden": "true" }, "·") : null, c]), badges.length ? h("span", { class: "cd-badges" }, badges) : null));
    } else {
      const f = subject.fn;
      const range = f.range ? `${f.range[0]}–${f.range[1]}` : String(f.no);
      parts.push(h("h3", { class: "cd-loc mono" }, h("span", { class: "cd-fn-icon", "aria-hidden": "true" }, icon("fn", 14)), `${f.name}()`));
      const badges: Child[] = [];
      if (f.coro) badges.push(badge("coroutine", { variant: "neutral" }));
      parts.push(h("p", { class: "cd-context" }, h("span", { class: "mono" }, `${f.file.base}:${range}`), badges.length ? h("span", { class: "cd-badges" }, badges) : null));
    }
    const src = subject.kind === "line" ? subject.line : subject.fn.file.byNo.get(subject.fn.no) ?? null;
    const pre = src && src.text.trim() ? h("pre", { class: "cd-source code" }, renderSpans(highlight(src.text.replace(/^\s+/, ""), src.doc))) : null;
    return h("header", { class: "cd-head" }, h("div", { class: "cd-head-row" }, h("div", { class: "cd-head-text" }, parts), headActions(subject)), pre);
  };

  // ── Blocks ────────────────────────────────────────────────────────────────

  const timeBlock = (py: number, nat: number, sys: number, total: number, sec: number, extra: [Child, Child][], regionText: [string, string] | null): Block => {
    const els: Child[] = [blockHead("Time", "cpu-py")];
    if (total > 0) {
      els.push(big(fmtPct(total), `of run · ${fmtTime(sec)}`));
      els.push(h("div", { class: "cd-split" }, meter(document, { segments: timeSegments(py, nat, sys), max: total, height: 8 })));
      els.push(
        h(
          "p",
          { class: "cd-legend" },
          h("span", null, swatch("cpu-py"), "Python ", h("b", null, fmtPct(py))),
          h("span", null, swatch("cpu-native"), "native ", h("b", null, fmtPct(nat))),
          h("span", null, swatch("cpu-sys", true), "system ", h("b", null, fmtPct(sys))),
        ),
      );
    } else {
      els.push(note("No CPU time was sampled on this line."));
    }
    if (extra.length) els.push(kv(extra));
    if (regionText) els.push(h("p", { class: "cd-region" }, regionText[0], h("b", null, regionText[1]), " of run"));
    return { id: "time", weight: total > 0 ? 150 + 26 * extra.length : 70, el: h("section", { class: "cd-block" }, els) };
  };

  const whenBlock = (l: LineM): Block | null => {
    if (!m.caps.cpuSamples) return null;
    const n = l.cpuTimes.length;
    // No CPU time at all: the Time block already says so; a "worker thread or native only"
    // note would invent time that was never sampled (round 1).
    if (n === 0 && !(l.total > 0)) return null;
    const els: Child[] = [blockHead("When it ran", null)];
    if (n > 0) {
      els.push(addChart(34, drawWhen(ctx.theme, l.cpuTimes, m.tMax), `Main-thread samples of line ${l.no} over the run, from 0 to ${fmtTime(m.tMax)}`));
      // At Scalene's per-line cap the count is a floor: "≥ 500" (same phrasing as the scope link).
      els.push(note(n >= 500 ? `≥ ${fmtCount(n)} main-thread samples (Scalene keeps up to 500 per line)` : `${fmtCount(n)} main-thread sample${n === 1 ? "" : "s"}`, "cd-caption"));
    } else {
      els.push(note("No main-thread samples (worker thread or native only)."));
    }
    return { id: "when", weight: 86, el: h("section", { class: "cd-block" }, els) };
  };

  const memoryBlock = (o: {
    peak: number;
    pyFrac: number | null;
    avg: number;
    malloc: number;
    usage: number;
    mallocs: number | null;
    copy: number;
    samples: Float64Array;
    leak: LineM["leak"];
    what: string;
  }): Block | null => {
    if (!m.caps.memory) return null;
    const els: Child[] = [blockHead("Memory", "mem-py")];
    const any = o.peak > 0 || o.malloc > 0 || o.samples.length > 0 || o.avg > 0;
    if (!any) {
      els.push(note(`No allocations sampled on this ${o.what}.`));
      return { id: "mem", weight: 60, el: h("section", { class: "cd-block" }, els) };
    }
    els.push(big(fmtMem(o.peak), `peak${o.pyFrac !== null && o.peak > 0 ? ` · Python ${fmtPct(100 * o.pyFrac)}` : ""}`));
    if (o.peak > 0 && o.pyFrac !== null) {
      els.push(h("div", { class: "cd-split" }, meter(document, { segments: memSegments(o.peak, o.pyFrac), max: Math.max(m.memory?.peak ?? 0, o.peak), height: 8, tick: o.avg > 0 ? o.avg : null })));
    }
    const rows: [Child, Child][] = [
      ["average per episode", o.avg > 0 ? fmtMem(o.avg) : P.NONE_SAMPLED],
      ["allocated over the run", o.malloc > 0 ? h("span", null, fmtMem(o.malloc), h("span", { class: "cd-unit" }, " sampled")) : P.NONE_SAMPLED],
      ["share of all allocation", fmtPct(100 * o.usage)],
    ];
    if (o.mallocs !== null) rows.push(["allocation episodes", fmtCount(o.mallocs)]);
    rows.push(["copy rate", o.copy > 0 ? fmtRate(o.copy) : P.NONE_SAMPLED]);
    els.push(kv(rows));
    if (o.leak) {
      els.push(h("p", { class: "cd-leak", role: "note" }, icon("trend-up", 14), h("span", null, h("b", null, "Possible leak"), ` · grows ~${fmtRate(o.leak.velocity)} · likelihood ${fmtPct(100 * o.leak.likelihood)}`)));
    }
    if (o.samples.length > 0) {
      const n = o.samples.length / 2;
      els.push(addChart(96, drawFootprintChart(ctx.theme, m, o.samples, o.leak !== null), `Program footprint over the run with ${n} allocation moments of this ${o.what}`));
      els.push(note(`Program footprint (grey) and the moments this ${o.what} allocated or freed (dots)`, "cd-caption"));
    }
    return { id: "mem", weight: 120 + 26 * rows.length + (o.samples.length ? 130 : 0) + (o.leak ? 40 : 0), el: h("section", { class: "cd-block" }, els) };
  };

  const gpuBlock = (gpu: number, gpuPeak: number | null, gpuAvg: number | null, what: "line" | "function"): Block | null => {
    if (!m.caps.gpu) return null;
    const name = m.gpu?.name || "GPU";
    const els: Child[] = [blockHead(name, "gpu")];
    if (gpu <= 0 && !(gpuPeak && gpuPeak > 0)) {
      els.push(note(`No ${name} activity sampled while this ${what} ran.`));
      return { id: "gpu", weight: 60, el: h("section", { class: "cd-block" }, els) };
    }
    els.push(big(fmtUtil(gpu), `busy while this ${what} ran (time-weighted)`));
    els.push(h("div", { class: "cd-split" }, meter(document, { segments: [{ value: gpu, token: "gpu" }], max: 100, height: 8, graduations: true })));
    const rows: [Child, Child][] = [];
    if (m.caps.gpuMemory) {
      rows.push(["device memory peak (process)", gpuPeak !== null ? fmtMem(gpuPeak) : P.NOT_RECORDED]);
      if (gpuAvg !== null || gpuPeak !== null) rows.push(["device memory avg", gpuAvg !== null ? fmtMem(gpuAvg) : P.NOT_RECORDED]);
    }
    if (rows.length) els.push(kv(rows));
    return { id: "gpu", weight: 110 + 26 * rows.length, el: h("section", { class: "cd-block" }, els) };
  };

  const asyncBlock = (aw: number, concMean: number, concPeak: number, coro: boolean, tasks: readonly string[], what: "line" | "function"): Block | null => {
    if (!m.caps.async) return null;
    const els: Child[] = [blockHead("Async", "async")];
    if (aw > 0) els.push(big(fmtPct(aw), "of await time"));
    else els.push(note(`No await time sampled on this ${what}.`));
    const rows: [Child, Child][] = [];
    if (aw > 0 || concPeak > 0) rows.push(["tasks suspended here", concPeak > 0 ? P.concurrency(concMean, concPeak) : P.NONE_SAMPLED]);
    rows.push(["coroutine", coro ? "yes" : "no"]);
    els.push(kv(rows));
    if (tasks.length) {
      const list = h("div", { class: "cd-chips" });
      const fill = (all: boolean) => {
        replaceChildren(
          list,
          (all ? tasks : tasks.slice(0, TASK_CHIPS)).map((t) => h("code", { class: "chip-code" }, t)),
          !all && tasks.length > TASK_CHIPS
            ? h("button", { type: "button", class: "cd-more", onClick: () => fill(true) }, `+${tasks.length - TASK_CHIPS} more`)
            : null,
        );
      };
      fill(false);
      els.push(list, note(`Task names${tasks.length >= 100 ? " (Scalene keeps up to 100 names)" : ""}`, "cd-caption"));
    }
    return { id: "async", weight: 120 + Math.min(tasks.length, TASK_CHIPS) * 6, el: h("section", { class: "cd-block" }, els) };
  };

  const neuronBlock = (l: LineM): Block | null => {
    if (!m.caps.neuron) return null;
    const n = l.neuron;
    const els: Child[] = [blockHead("Neuron", "gpu")];
    if (!n || (n.nrtMs <= 0 && n.nrtPct <= 0 && n.ncMs <= 0 && n.idlePct === null)) {
      els.push(note("No Neuron activity recorded on this line."));
      return { id: "neuron", weight: 60, el: h("section", { class: "cd-block" }, els) };
    }
    const rows: [Child, Child][] = [];
    const nrtPct = nrtShare(l, m.elapsed);
    rows.push(["NRT", n.nrtMs > 0 ? `${fmtTime(n.nrtMs / 1000)} · ${fmtPct(nrtPct)} of run` : n.nrtPct > 0 ? `${fmtPct(n.nrtPct)} of run` : P.NONE_SAMPLED]);
    if (m.neuron && m.neuron.nrtMs > 0 && n.nrtMs > 0) rows.push(["share of all NRT time", fmtPct((100 * n.nrtMs) / m.neuron.nrtMs)]);
    if (n.nrtCount > 0) rows.push(["NRT executions", fmtCount(n.nrtCount)]);
    rows.push(["NC", n.ncMs > 0 ? `${fmtTime(n.ncMs / 1000)} · ${fmtPct(ncShare(l, m.elapsed))} of run` : P.NONE_SAMPLED]);
    if (n.ncMs > 0 && n.nrtMs > 0) rows.push(["NC / NRT ratio", (n.ncMs / n.nrtMs).toFixed(2)]);
    if (n.idlePct !== null) {
      const b = idleBand(n.idlePct);
      rows.push([
        "device idle",
        h("span", null, h("span", { class: "cv-band", style: { color: `var(--${b.token})` }, "aria-hidden": "true" }, b.glyph), ` ${fmtPct(n.idlePct)} · ${b.band}`),
      ]);
    }
    if (n.kernel) {
      const k = h("code", { class: "cd-kernel", tabindex: "0", "aria-label": `kernel ${n.kernel}` }, middleEllipsis(n.kernel, 34));
      if (k.textContent !== n.kernel) bindTooltip(ctx.tooltip, k, { title: "Kernel (nrt_source_code)", code: n.kernel });
      rows.push(["kernel", k]);
    }
    els.push(kv(rows));
    return { id: "neuron", weight: 40 + 26 * rows.length, el: h("section", { class: "cd-block" }, els) };
  };

  const callBlock = (l: LineM): Block | null => {
    if (!m.caps.stacks) return null;
    const body = h("div", { class: "cd-call" }, note("Reading the call stacks…", "cd-caption"));
    const el = h("section", { class: "cd-block" }, blockHead("Call context", null), body);
    const token = ++ctxToken;
    void m.callContext(l.file.name, l.no).then((cc) => {
      if (token !== ctxToken) return;
      replaceChildren(body, callContent(l, cc));
    });
    return { id: "call", weight: 220, el };
  };

  const edgeButton = (e: CallEdge, l: LineM, kind: "into" | "from"): HTMLElement => {
    const inProfile = e.file && m.fileByName.has(e.file) && e.line !== null;
    const target = inProfile ? { file: e.file, line: e.line as number } : lineTarget(l);
    const where = e.line !== null && e.file ? `${e.file.split("/").pop()}:${e.line}` : e.kind === "native" ? "native" : "";
    return h(
      "button",
      {
        type: "button",
        class: "cd-edge",
        "aria-label": `${kind === "into" ? "Calls into" : "Called from"} ${e.name}${where ? `, ${where}` : ""}, ${fmtPct(e.share)} — show in stacks`,
        onClick: () => void ctx.nav.showInStacks(target),
      },
      h("span", { class: "cd-edge-name mono" }, e.name),
      where ? h("span", { class: "cd-edge-where" }, where) : null,
      h("span", { class: "cd-edge-val" }, fmtPct(e.share)),
      kind === "into" ? h("span", { class: "cd-edge-bar", "aria-hidden": "true" }, h("span", { style: { width: `${Math.min(100, Math.max(2, e.share)).toFixed(1)}%` } })) : null,
    );
  };

  const callContent = (l: LineM, cc: CallContext | null): Child[] => {
    if (!cc || cc.hits <= 0) return [note("This line does not appear in the sampled call stacks.")];
    const out: Child[] = [
      h("p", { class: "cd-call-sum" }, "In ", h("b", null, fmtCount(cc.hits)), ` of ${fmtCount(cc.total)} stack samples `, h("span", { class: "cd-unit" }, `(${fmtPct(cc.share)})`)),
    ];
    if (cc.callsInto.length) {
      out.push(h("p", { class: "cd-sub micro" }, "Calls into"), h("div", { class: "cd-edges" }, cc.callsInto.slice(0, 4).map((e) => edgeButton(e, l, "into"))));
    }
    if (cc.calledFrom.length) {
      out.push(h("p", { class: "cd-sub micro" }, "Called from"), h("div", { class: "cd-edges" }, cc.calledFrom.slice(0, 2).map((e) => edgeButton(e, l, "from"))));
    }
    return out;
  };

  // ── AI footer ─────────────────────────────────────────────────────────────

  const renderAi = (l: LineM): HTMLElement => {
    const avail = ctx.ai.availability(l.file.name).get(l.no);
    const ready = ctx.ai.ready().ready;
    const btns: HTMLElement[] = [];
    if (avail?.line) btns.push(button({ label: "Optimize line", icon: "spark", variant: "secondary", compact: true, onClick: () => actions.optimize(l, "line") }));
    if (avail?.region) {
      const r = avail.region;
      btns.push(button({ label: `Optimize region ${r.start}–${r.end}`, icon: "spark", variant: "secondary", compact: true, onClick: () => actions.optimize(l, "region") }));
    }
    const status = h(
      "span",
      { class: "cd-ai-status" },
      h("span", { class: ["cd-ai-dot", ready ? "is-ready" : ""], "aria-hidden": "true" }),
      ctx.ai.providerSummary(),
    );
    const settings = button({ label: "AI settings", variant: "ghost", compact: true, onClick: () => ctx.ai.openSettings() });
    return h(
      "footer",
      { class: "cd-ai" },
      btns.length ? h("div", { class: "cd-ai-btns" }, btns) : h("span", { class: "cd-ai-none" }, "No AI proposal for this line (below 1% of run)"),
      h("div", { class: "cd-ai-meta" }, status, settings),
    );
  };

  // ── Assemble ──────────────────────────────────────────────────────────────

  const blocksFor = (subject: DetailSubject): Block[] => {
    const out: (Block | null)[] = [];
    if (subject.kind === "line") {
      const l = subject.line;
      const extra: [Child, Child][] = [];
      // Core use is a property of the samples: without CPU time there is nothing to report.
      if (l.total > 0) extra.push(["cores busy while it ran", m.caps.coreUtil ? (l.coreUtil !== null ? `${fmtPct(100 * l.coreUtil)} of all cores` : P.NONE_SAMPLED) : P.NOT_RECORDED]);
      const regionText: [string, string] | null = l.region[0] !== l.region[1] ? [`Region ${l.region[0]}–${l.region[1]}: `, fmtPct(l.regionTotal)] : null;
      out.push(timeBlock(l.py, l.nat, l.sys, l.total, l.sec, extra, regionText));
      out.push(whenBlock(l));
      out.push(memoryBlock({ peak: l.peak, pyFrac: l.pyFrac, avg: l.avg, malloc: l.malloc, usage: l.usage, mallocs: l.mallocs, copy: l.copy, samples: l.memSamples, leak: l.leak, what: "line" }));
      out.push(gpuBlock(l.gpu, l.gpuPeak, l.gpuAvg, "line"));
      out.push(asyncBlock(l.await, l.concMean, l.concPeak, l.coro, l.tasks, "line"));
      out.push(neuronBlock(l));
      out.push(callBlock(l));
    } else {
      const f = subject.fn;
      out.push(timeBlock(f.py, f.nat, f.sys, f.total, f.sec, [], null));
      out.push(memoryBlock({ peak: f.peak, pyFrac: f.peak > 0 ? functionPyFrac(f) : null, avg: f.avg, malloc: f.malloc, usage: f.usage, mallocs: null, copy: f.copy, samples: f.memSamples, leak: null, what: "function" }));
      out.push(gpuBlock(f.gpu, f.gpuPeak, null, "function"));
      out.push(asyncBlock(f.await, 0, 0, f.coro, [], "function"));
    }
    return out.filter((b): b is Block => b !== null);
  };

  const emptyState = (): HTMLElement =>
    h(
      "div",
      { class: "cd-empty" },
      h("span", { class: "cd-empty-icon", "aria-hidden": "true" }, icon("eye", 16)),
      h("p", { class: "cd-empty-title" }, "Select a line to see every metric, its call context and AI options"),
      h(
        "ul",
        { class: "cd-keys" },
        h("li", null, h("kbd", { class: "key-chip" }, "↑"), h("kbd", { class: "key-chip" }, "↓"), " move"),
        h("li", null, h("kbd", { class: "key-chip" }, "Enter"), " details"),
        h("li", null, h("kbd", { class: "key-chip" }, "o"), " optimize"),
        h("li", null, h("kbd", { class: "key-chip" }, "e"), " open in editor"),
        h("li", null, h("kbd", { class: "key-chip" }, "s"), " stacks"),
      ),
    );

  const render = () => {
    stopCharts();
    ctxToken++;
    aiFooter = null;
    el.classList.toggle("cd-dock", layout === "dock");
    el.classList.toggle("cd-lens", layout === "lens");
    if (!current) {
      el.removeAttribute("aria-label");
      el.replaceChildren(emptyState());
      return;
    }
    const subject = current;
    const blocks = blocksFor(subject);
    const n = layout === "dock" ? 1 : cols;
    const groups = partitionBlocks(
      blocks.map((b) => b.weight),
      n,
    );
    const grid = h(
      "div",
      { class: "cd-grid", style: { "--cd-cols": String(Math.max(1, groups.length)) } },
      groups.map((g) => h("div", { class: "cd-col" }, g.map((i) => blocks[i].el))),
    );
    const children: Child[] = [head(subject), grid];
    if (subject.kind === "line") {
      aiFooter = renderAi(subject.line);
      children.push(aiFooter);
    }
    el.replaceChildren(...(children as Node[]));
  };

  return {
    el,
    update(subject, lay, columns) {
      current = subject;
      layout = lay;
      cols = columns;
      render();
    },
    redraw,
    refreshAi() {
      if (current?.kind === "line" && aiFooter) {
        const next = renderAi(current.line);
        aiFooter.replaceWith(next);
        aiFooter = next;
      }
    },
    subject: () => current,
    destroy() {
      stopCharts();
      el.remove();
    },
  };
}

/** Accessible label for the detail region. */
export function detailLabel(subject: DetailSubject): string {
  return subject.kind === "line"
    ? `Details for ${subject.line.file.base} line ${subject.line.no}`
    : `Details for function ${subject.fn.name} in ${subject.fn.file.base}`;
}
