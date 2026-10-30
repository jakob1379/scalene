/**
 * Readout tiles (DESIGN.md §4.3): up to four KPI tiles from `model.readouts`.
 * Each tile: LED + micro label, value (+ unit), one 8 px micro-visual and a
 * caption that always states its denominator. Count-up (M2) only for single
 * numbers; the time split renders final and its bar grows as one unit (M3).
 */

import { bindTooltip } from "../../core/tooltip";
import { h, type Child } from "../../core/dom";
import { fmtCount, fmtTime } from "../../core/format";
import { DUR, EASE } from "../../core/motion";
import { icon } from "../../core/icons";
import { fmtSampling, type HeadSeg } from "../../model/headline";
import type { ReadoutSpec, ReadoutVisual, SplitPart } from "../../model/readouts";
import type { ViewContext } from "../app";
import { buildCaption, type FitCaption } from "./caption";
import { renderSegments, wireTarget } from "./headline";

export interface ReadoutsHandle {
  /** One element per tile, in slot order (tile 0 = "Where the time went"). */
  tiles: HTMLElement[];
  /** `xs` only: an Elapsed tile that completes the 2 × 2 grid after the hotspots (null if not needed). */
  extra: HTMLElement | null;
  /** Start M2/M3/M6 (or render final values when `instant`). */
  intro(instant: boolean): void;
  /** Drive the M2 count-ups from the intro clock (ms since the first frame); true while running. */
  tick(elapsed: number): boolean;
  /** Re-fit the captions now (after the tiles move, e.g. into the phone order). */
  fit(): void;
  destroy(): void;
}

/** M1 reveal stagger between tiles (§5.2: 30 ms in reading order). */
export const TILE_STAGGER = 30;

/**
 * One clock per tile (review round 1, §5.3.1 "every frame is a truthful partial view"): the
 * tile's label, value, caption and micro-visual reveal together at `reveal`; the count-up (M2)
 * and its meter (M6) start at that same instant and share one duration and easing, so the
 * meter never disagrees with its number and no value shows before its label.
 */
export function tileClock(index: number, revealStart: number): { reveal: number; count: number; meter: number; duration: number } {
  const reveal = revealStart + TILE_STAGGER * index;
  return { reveal, count: reveal, meter: reveal, duration: DUR.count };
}

/** Short tile labels for narrow tiles (200 % zoom, short hosts): never an ellipsis. */
const SHORT_LABEL: Record<string, string> = {
  time: "Time",
  peak: "Peak",
  neuron: "Neuron",
  leaks: "Leaks",
  busiest: "Busiest fn",
  elapsed: "Elapsed",
  await: "Await",
};

/** Compact keys of the time split in short hosts ("Py 11.6%  native 61.9%  sys 26.1%"). */
const SPLIT_KEY: Record<string, string> = { py: "Py", native: "native", system: "sys" };

/**
 * Caption wording (review round 1): the long method phrase is split into short phrases so it can
 * drop from the end instead of being swapped for the iframe phrase, and the Peak tile's second
 * line says what the numbers are ("52.2% stayed live", "212 MiB from native threads").
 */
export function rewriteCaption(s: string): string {
  return s
    .replace(/\bmean while the main thread ran \(time-weighted\)/g, "mean · main thread · time-weighted")
    .replace(/\bmean while profiled lines ran \(time-weighted\)/g, "mean · profiled lines · time-weighted")
    .replace(/\bgrowth (\d[\d.,]*%)/g, "$1 stayed live")
    .replace(/\+(\d[\d.,]*[\s\u00a0][KMGT]?i?B) native threads/g, "$1 from native threads");
}

/**
 * The count-up text at progress `k` (0..1) of `final` ("3.11", "66.9", "14,656"): the same
 * decimals and grouping as the final string from the first frame (§5.1), monotonic.
 */
export function countText(final: string, k: number): string {
  const m = /^(\d[\d,]*)(?:\.(\d+))?$/.exec(final);
  if (!m) return final;
  if (k >= 1) return final;
  const decimals = m[2] ? m[2].length : 0;
  const grouped = m[1].includes(",");
  const value = parseFloat(final.replace(/,/g, ""));
  const scale = Math.pow(10, decimals);
  const v = Math.floor(value * Math.max(0, k) * scale + 1e-9) / scale;
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped });
}

/** True when the value is one plain number (count-up safe: "3.11", "66.9", "2"). */
export function countable(spec: Pick<ReadoutSpec, "countUp" | "number" | "unit">): boolean {
  return spec.countUp && /^[\d.,]+$/.test(spec.number) && !/\d/.test(spec.unit);
}

/** Readout grid columns (§4.3.1): the time split gets 1.6 fr, the others 1 fr each. */
export function gridColumns(n: number): string {
  return n <= 1 ? "minmax(0, 1fr)" : `minmax(0, 1.6fr) repeat(${n - 1}, minmax(0, 1fr))`;
}

function hatchClass(p: { hatch?: string }): string {
  return p.hatch === "system" ? " is-hatch-sys" : "";
}

/** One stacked bar: segments laid out in a fill that grows from the left as one unit. */
function splitBar(parts: readonly SplitPart[], max: number, height: number, label: string): HTMLElement {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0);
  const fill = h("span", { class: "ro-fill", style: { width: `${Math.min(100, (100 * total) / (max || 1)).toFixed(3)}%` } });
  for (const p of parts) {
    if (!(p.value > 0)) continue;
    fill.append(h("i", { class: `ro-seg${hatchClass(p)}`, style: { flexGrow: String(p.value), background: p.hatch ? undefined : `var(--${p.token})` } }));
  }
  return h("span", { class: "ro-bar", role: "img", "aria-label": label, style: { height: `${height}px` } }, fill);
}

function meterBar(value: number, max: number, token: string, height: number, label: string): HTMLElement {
  const frac = Math.max(0, Math.min(1, value / (max || 1)));
  const fill = h("span", { class: "ro-fill", style: { width: `${(frac * 100).toFixed(3)}%`, minWidth: value > 0 ? "2px" : "0", background: `var(--${token})` } });
  return h("span", { class: "ro-bar ro-bar-grad", role: "img", "aria-label": label, style: { height: `${height}px` } }, fill);
}

function visualFor(spec: ReadoutSpec, v: ReadoutVisual | null): HTMLElement | null {
  if (!v) return null;
  switch (v.kind) {
    case "split": {
      const label = v.parts.map((p) => `${p.label} ${p.text}`).join(", ") + (spec.kind === "time" ? " of run time" : " of the peak allocation");
      return splitBar(v.parts, v.max, 8, label);
    }
    case "meter":
      return meterBar(v.value, v.max, v.token, 8, `${spec.value} of 100%`);
    case "meters":
      return h(
        "span",
        { class: "ro-meters" },
        v.rows.map((r) => meterBar(r.value, r.max, r.token, 3, `${r.label} ${r.value.toFixed(1)}% of run`)),
      );
    case "neutral":
      return h("span", { class: "ro-bar is-neutral", role: "img", "aria-label": v.note, style: { height: "8px" } });
    default:
      return null;
  }
}

/** Caption lines as shown: rewritten phrases, "of run" on Busiest function, no seconds at elapsed 0. */
export function captionLines(spec: ReadoutSpec, elapsed: number): HeadSeg[][] {
  const lines: HeadSeg[][] = spec.caption.map((c) => c.map((seg): HeadSeg => (seg.t === "text" ? { t: "text", s: rewriteCaption(seg.s) } : seg)));
  if (spec.kind === "busiest" && lines[0]) {
    // §4.0.3 "X% of run": the value's denominator comes first (must-fix 31 in compact too).
    const first = lines[0][0];
    if (!(first && first.t === "text" && /^of run\b/.test(first.s))) lines[0].unshift({ t: "text", s: "of run · " });
    if (!(elapsed > 0)) {
      // elapsed_time_sec = 0 (§4.0.8): seconds are not shown.
      const last = lines[0][lines[0].length - 1];
      if (last && last.t === "text") last.s = last.s.replace(/\s·\s[\d.,]+[\s\u00a0](?:ms|s)$/, "");
    }
  }
  return lines;
}

/** The compact caption (short hosts) with its denominator (must-fix 31). */
export function shortCaption(spec: ReadoutSpec): string {
  if (spec.kind === "busiest" && !/\bof run\b/.test(spec.short)) return `of run · ${spec.short}`;
  return spec.short;
}

function captionFor(ctx: ViewContext, spec: ReadoutSpec): FitCaption {
  const lines: HeadSeg[][] = captionLines(spec, ctx.model.elapsed);
  if (spec.visual?.kind === "neutral") {
    const note: HeadSeg = { t: "text", s: `${spec.visual.note} · ` };
    if (lines.length) lines[0].unshift(note);
    else lines.push([{ t: "text", s: spec.visual.note }]);
  }
  const cap = buildCaption(lines, shortCaption(spec) || null, (segs) => renderSegments(ctx, segs, "readout", { refClass: "ro-ref" }));
  bindTooltip(ctx.tooltip, cap.el, () => {
    const full = cap.hiddenText();
    return full ? { title: spec.label, hint: full } : null;
  });
  return cap;
}

interface TileParts {
  el: HTMLElement;
  caption: FitCaption | null;
  counters: { el: HTMLElement; text: string; start: number; duration: number }[];
  grows: HTMLElement[];
  splitGrow: HTMLElement | null;
  clock: ReturnType<typeof tileClock>;
}

function valueBlock(spec: ReadoutSpec, clock: ReturnType<typeof tileClock>, counters: TileParts["counters"]): HTMLElement {
  const num = h("span", { class: "ro-num", "aria-hidden": "true" }, spec.number || spec.value);
  const children: Child[] = [num];
  if (spec.unit) children.push(h("span", { class: "ro-unit", "aria-hidden": "true" }, spec.unit));
  children.push(h("span", { class: "visually-hidden" }, spec.value));
  if (countable(spec)) counters.push({ el: num, text: spec.number, start: clock.count, duration: clock.duration });
  return h("div", { class: ["ro-value", spec.danger ? "is-danger" : ""] }, children);
}

function buildTile(ctx: ViewContext, spec: ReadoutSpec, index: number, revealStart: number): TileParts {
  const clock = tileClock(index, revealStart);
  const revealDelay = clock.reveal;
  const counters: TileParts["counters"] = [];
  const grows: HTMLElement[] = [];
  let splitGrow: HTMLElement | null = null;
  let caption: FitCaption | null = null;
  const short = SHORT_LABEL[spec.kind];
  const labelText = h("span", { class: "ro-label-text" }, h("span", { class: "ro-label-full" }, spec.label), short && short !== spec.label ? h("span", { class: "ro-label-short", "aria-hidden": "true" }, short) : null);
  const label = h(
    "div",
    { class: "ro-label micro m-reveal", style: { "--d": `${revealDelay}ms` } },
    h("span", { class: "led", style: { "--c": `var(--${spec.token})` }, "aria-hidden": "true" }),
    labelText,
  );
  bindTooltip(ctx.tooltip, labelText, () => (labelText.scrollWidth > labelText.clientWidth + 1 || labelText.classList.contains("use-short") ? { title: spec.label } : null));
  const el = h("div", { class: "ro-tile", dataset: { kind: spec.kind } }, label);

  if (spec.kind === "time" && spec.parts) {
    el.append(
      h(
        "div",
        { class: "ro-split" },
        spec.parts.map((p) => {
          const [n, u] = [p.text.replace(/%$/, ""), p.text.endsWith("%") ? "%" : ""];
          // Short hosts keep a one-word key before each number (never colour alone, §1.3.2).
          return h(
            "div",
            { class: "ro-sv" },
            h("span", { class: "ro-sk", "aria-hidden": "true" }, h("i", { class: `sw${p.hatch ? " sw-sys" : ""}`, style: p.hatch ? undefined : { background: `var(--${p.token})` } }), SPLIT_KEY[p.key] ?? p.label),
            h("span", { class: "ro-value" }, h("span", { class: "ro-num" }, n), u ? h("span", { class: "ro-unit" }, u) : null),
            h("span", { class: "ro-sl" }, h("i", { class: `sw${p.hatch ? " sw-sys" : ""}`, style: p.hatch ? undefined : { background: `var(--${p.token})` }, "aria-hidden": "true" }), p.label),
          );
        }),
      ),
    );
  } else {
    el.append(valueBlock(spec, clock, counters));
  }

  const visual = visualFor(spec, spec.visual);
  const vis = h("div", { class: "ro-visual" }, visual);
  el.append(vis);
  if (visual) {
    const fills = Array.from(visual.querySelectorAll<HTMLElement>(".ro-fill"));
    if (spec.kind === "time") splitGrow = fills[0] ?? null;
    else grows.push(...fills);
  } else el.classList.add("no-visual");

  if (spec.leaks) {
    const list = h(
      "div",
      { class: "ro-leaks" },
      spec.leaks.items.map((l) => {
        const b = h(
          "button",
          { type: "button", class: "ro-leak", "aria-label": `Possible leak at ${l.label}, grows about ${l.rate}, likelihood ${l.likelihood} — go to the line` },
          icon("trend-up", 14),
          h("span", { class: "ro-leak-loc mono" }, l.label),
          h("span", { class: "ro-leak-rate" }, `grows ${l.rate}`),
        );
        wireTarget(ctx, b, l.target, "readout");
        bindTooltip(ctx.tooltip, b, { title: `Possible leak · ${l.label}`, rows: [["grows about", l.rate], ["likelihood", l.likelihood]], code: l.line.text.trim() });
        return b;
      }),
      spec.leaks.more > 0
        ? h("button", { type: "button", class: "ro-ref ro-more", onClick: () => void ctx.nav.showSection("memory") }, `+${spec.leaks.more} more in Memory`)
        : null,
    );
    el.append(list);
  } else {
    caption = captionFor(ctx, spec);
    el.append(caption.el);
  }
  const shortEl = h("p", { class: "ro-short" }, shortCaption(spec));
  el.append(shortEl);
  bindTooltip(ctx.tooltip, shortEl, () => (shortEl.scrollHeight > shortEl.clientHeight + 1 || shortEl.scrollWidth > shortEl.clientWidth + 1 ? { title: spec.label, hint: captionLines(spec, ctx.model.elapsed).map((l) => l.map((x) => x.s).join("")).join(" · ") } : null));
  // M1 (one clock per tile): everything below the label reveals with it, so a value or a leak
  // button is never visible before the label that says what it is.
  for (const child of Array.from(el.children)) {
    if (child === label || !(child instanceof HTMLElement)) continue;
    child.classList.add("m-reveal");
    child.style.setProperty("--d", `${revealDelay}ms`);
  }

  // Precise value on hover (§4.3.3).
  const valueEl = el.querySelector<HTMLElement>(".ro-value, .ro-split");
  if (valueEl && spec.tooltip) bindTooltip(ctx.tooltip, valueEl, { title: spec.tooltip });

  if (spec.kind === "peak") {
    const on = () => ctx.bus.emit("hover:peak", { on: true });
    const off = () => ctx.bus.emit("hover:peak", { on: false });
    el.addEventListener("mouseenter", on);
    el.addEventListener("mouseleave", off);
    el.addEventListener("focusin", on);
    el.addEventListener("focusout", off);
  }
  return { el, caption, counters, grows, splitGrow, clock };
}

/** The Elapsed tile, built locally for the `xs` 2 × 2 grid (§2.3 xs wireframe). */
function elapsedSpec(ctx: ViewContext): ReadoutSpec {
  const m = ctx.model;
  const parts = ["wall clock"];
  const n = m.sampling.threads.length;
  if (n > 0) parts.push(`${n} thread${n === 1 ? "" : "s"}`);
  if (m.stackSamples > 0) parts.push(`${fmtCount(m.stackSamples)} samples`);
  const caption: HeadSeg[][] = [[{ t: "text", s: parts.join(" · ") }]];
  if (m.caps.timeline) caption.push([{ t: "text", s: fmtSampling(m.sampling.dt) }]);
  const value = fmtTime(m.elapsed);
  const match = /^([\d.,]+)\s*(\D*)$/.exec(value);
  return {
    kind: "elapsed",
    label: "Elapsed",
    token: "fg-2",
    value,
    number: match ? match[1] : value,
    unit: match ? match[2] : "",
    countUp: true,
    visual: null,
    caption,
    short: "wall clock",
    tooltip: `${m.elapsed.toFixed(3)} s wall clock`,
  };
}

export function mountReadouts(ctx: ViewContext, revealStart: number): ReadoutsHandle {
  const specs = ctx.model.readouts;
  const built = specs.map((s, i) => buildTile(ctx, s, i, revealStart));
  let extra: TileParts | null = null;
  const secondary = specs.length - 1;
  // Only a recorded run length gets an Elapsed tile (a derived one is a lower bound, §4.0.8).
  if (secondary % 2 === 1 && !specs.some((s) => s.kind === "elapsed") && ctx.model.elapsed > 0 && ctx.model.elapsedSource === "recorded") {
    extra = buildTile(ctx, elapsedSpec(ctx), specs.length, revealStart);
    extra.el.classList.add("ro-extra");
  }
  const all = extra ? built.concat(extra) : built;

  // Caption fitting (§4.3.2 max 2 lines; md 1 line): the row budget comes from CSS
  // (`--ro-cap-lines` on the tile, set per breakpoint) so JS and media queries never disagree.
  const caps = all.filter((t) => t.caption).map((t) => ({ tile: t.el, cap: t.caption as FitCaption, w: -1, budget: -1 }));
  // Labels: the short form only when the full one does not fit (measured, so it never depends
  // on a guessed breakpoint).
  const labels = all.map((t) => t.el.querySelector<HTMLElement>(".ro-label-text")).filter((x): x is HTMLElement => Boolean(x && x.querySelector(".ro-label-short")));
  const fitLabels = () => {
    for (const l of labels) l.classList.remove("use-short");
    const over = labels.filter((l) => l.scrollWidth > l.clientWidth + 1);
    for (const l of over) l.classList.add("use-short");
  };
  const fitAll = () => {
    fitLabels();
    for (const c of caps) {
      const width = c.cap.el.clientWidth;
      const budget = parseInt(getComputedStyle(c.tile).getPropertyValue("--ro-cap-lines"), 10);
      const b = Number.isFinite(budget) ? budget : 2;
      if (width === c.w && b === c.budget) continue;
      c.w = width;
      c.budget = b;
      c.cap.fit(b);
    }
  };
  // ResizeObserver callbacks run after layout and before paint, so the first fit never flashes.
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(() => fitAll());
    for (const t of all) ro.observe(t.el);
  }
  return {
    tiles: built.map((b) => b.el),
    extra: extra ? extra.el : null,
    intro(instant) {
      for (const t of all) {
        if (t.splitGrow) {
          // M3: the time split grows as one unit (its numbers render final).
          t.splitGrow.classList.add("m-grow");
          t.splitGrow.style.setProperty("--d", `${Math.max(80, t.clock.reveal)}ms`);
        }
        for (const g of t.grows) {
          // M6 on the tile's clock: same start, duration and easing as the count-up beside it.
          g.classList.add("m-grow");
          g.style.setProperty("--d", `${t.clock.meter}ms`);
          g.style.setProperty("--dur", `${t.clock.duration}ms`);
        }
        for (const c of t.counters) c.el.textContent = instant ? c.text : countText(c.text, 0);
      }
    },
    tick(elapsed) {
      let running = false;
      for (const t of all) {
        for (const c of t.counters) {
          const u = (elapsed - c.start) / c.duration;
          const p = Math.max(0, Math.min(1, u));
          c.el.textContent = p >= 1 ? c.text : countText(c.text, EASE.out(p));
          if (p < 1) running = true;
        }
      }
      return running;
    },
    fit: fitAll,
    destroy() {
      ro?.disconnect();
    },
  };
}
