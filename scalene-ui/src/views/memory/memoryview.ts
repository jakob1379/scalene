/**
 * Memory section (DESIGN.md §4.13): stats row, the program footprint over
 * time with the peak callout (scope placement rules, §4.4.7) and a RUG row
 * for the selected allocation site, and the largest-allocation-sites listbox
 * (Peak | Allocated) with possible leaks pinned. Present only when
 * `caps.memory` and `max_footprint_mb > 0` (the shell decides).
 */

import { alpha, createCanvasPair, crisp, nearViewport, observeSize, setFont, uiFont, type CanvasPair } from "../../core/canvas";
import { badge, sectionHeader, segmented, type Choice } from "../../core/controls";
import { createDisposer, h, replaceChildren as setChildren, uid, VISUALLY_HIDDEN } from "../../core/dom";
import { fmtCount, fmtLoc, fmtMem, fmtPct, fmtRate, fmtTime } from "../../core/format";
import { rovingFocus, type Roving } from "../../core/a11y";
import { bindTooltip } from "../../core/tooltip";
import { EASE } from "../../core/motion";
import { drawHGridlines, drawTimeLabels, drawVGridlines, memoryScale, timeTicks } from "../../charts/axis";
import { drawCallout, drawFootprint, drawPeakMarker, footprintScales, footprintTrace, measureCallout } from "../../charts/footprint";
import { meter } from "../../charts/meter";
import { dotRect, planPeakClear, type Rect } from "../../charts/placement";
import { drawRug } from "../../charts/raster";
import { footprintAt, sampleTimes } from "../../model/memory";
import type { LineM } from "../../model/model";
import { lineTarget } from "../../model/model";
import { allocationSites, type SiteOrder } from "../../model/sites";
import { allocShare, allocated as allocatedPhrase, copied, leak as leakPhrase, linePeak } from "../../model/phrases";
import { icon } from "../../core/icons";
import type { ViewContext, ViewHandle } from "../app";
import { clamp } from "../stacks/shared";

const REVEAL_MS = 520;
const AXIS_H = 20;
const RUG_H = 10;
const Y_GUTTER = 52;
const NEAR_PX = 6;

export interface ChartGeometry {
  width: number;
  height: number;
  plot: Rect;
  rug: Rect;
}

/** Chart height per breakpoint (§4.13.2): 240 lg/md, 200 sm, 180 xs, 160 short. */
export function chartHeight(bp: string, short: boolean): number {
  if (short) return 160;
  if (bp === "xs") return 180;
  if (bp === "sm") return 200;
  return 240;
}

export function chartGeometry(width: number, height: number): ChartGeometry {
  const plot = { x: 0, y: 10, w: Math.max(40, width - Y_GUTTER), h: Math.max(40, height - 10 - 4 - RUG_H - 2 - AXIS_H) };
  const rug = { x: 0, y: plot.y + plot.h + 4, w: plot.w, h: RUG_H };
  return { width, height, plot, rug };
}

/**
 * "100 allocation events shown as ticks under the chart · 200 episodes" (counts pluralised;
 * the episode count only when recorded). Round 1: no plot jargon ("rug"), no "1 … episodes".
 */
export function momentsText(events: number, episodes: number): string {
  const ev = `${fmtCount(events)} allocation event${events === 1 ? "" : "s"} shown as ticks under the chart`;
  return episodes > 0 ? `${ev} · ${fmtCount(episodes)} episode${episodes === 1 ? "" : "s"}` : ev;
}

/** Index of the site's event nearest to time `t` within `maxDt` seconds, or −1. */
export function nearestEvent(times: Float64Array, t: number, maxDt: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestD = maxDt;
  for (const j of [lo - 1, lo]) {
    if (j < 0 || j >= times.length) continue;
    const d = Math.abs(times[j] - t);
    if (d <= bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

export function mountMemory(host: HTMLElement, ctx: ViewContext): ViewHandle {
  const { model, store, theme } = ctx;
  const dispose = createDisposer();
  const mem = model.memory;
  const tMax = model.tMax > 0 ? model.tMax : 1;
  const samples = mem && mem.samples.length >= 4 ? mem.samples : null;

  const header = sectionHeader({
    section: "memory",
    title: "Memory",
    description: "program footprint over time · select an allocation site to see when it allocated",
  });

  // ── Stats (§4.13.1) ──
  const stat = (label: string, value: Parameters<typeof h>[2], caption?: string, opts: { danger?: boolean; tip?: string } = {}) => {
    const dd = h("dd", { class: ["mem-stat-value", opts.danger ? "is-danger" : ""] }, value);
    const el = h("div", { class: "mem-stat" }, h("dt", { class: "mem-stat-label" }, label), dd, caption ? h("dd", { class: "mem-stat-cap" }, caption) : null);
    // The caption is hidden in short hosts; the tooltip keeps the denominator reachable.
    const hint = [caption, opts.tip].filter(Boolean).join(" · ");
    if (hint) {
      const tip = { title: label, hint };
      dispose.add(bindTooltip(ctx.tooltip, dd, tip));
      // Not hover-only (round 1, principle 8): the exact value is in the text for screen
      // readers, and the value is a focus stop (tooltip on focus) that a tap also opens.
      if (opts.tip) dd.append(h("span", { class: VISUALLY_HIDDEN }, ` (${opts.tip})`));
      if (dd.querySelector("button") === null) dd.tabIndex = 0;
      dd.addEventListener("click", (ev) => {
        if ((ev.target as Element).closest("button")) return;
        if ((ev as PointerEvent).pointerType === "touch" || (ev as PointerEvent).pointerType === "pen") ctx.tooltip.show(dd, tip, { describe: dd });
      });
    }
    return el;
  };
  const stats = h("dl", { class: "mem-stats" });
  if (mem) {
    stats.append(stat("Peak", fmtMem(mem.peak), "max footprint", { tip: `${mem.peak.toFixed(2)} MiB = ${fmtMem(mem.peak)}` }));
    const atValue: HTMLElement[] = [h("span", null, mem.peakT !== null ? fmtTime(mem.peakT) : "not sampled")];
    if (mem.peakLine) {
      const l = mem.peakLine;
      const b = h(
        "button",
        { type: "button", class: "chip-code mem-at-loc", "aria-label": `Go to ${l.file.base} line ${l.no}` },
        fmtLoc(l.file.name, l.no),
      );
      b.addEventListener("click", () => void ctx.nav.jumpTo(lineTarget(l), { source: "memory" }));
      b.addEventListener("pointerenter", () => ctx.bus.emit("hover:line", { target: lineTarget(l), source: "memory" }));
      b.addEventListener("pointerleave", () => ctx.bus.emit("hover:line", { target: null, source: "memory" }));
      atValue.push(b);
    }
    stats.append(stat("At", atValue, mem.peakLine ? "time and line of the peak" : model.caps.peakLocation ? "time of the peak" : "location not recorded"));
    const g = clamp(mem.growth, 0, 100);
    stats.append(
      // An absent / non-finite growth_rate is "not recorded", never a measured 0% (round 1).
      mem.growthRecorded
        ? stat("Growth", fmtPct(g), "of allocated memory stayed live", {
            tip: g !== mem.growth ? `Recorded growth rate ${mem.growth.toFixed(2)}% (shown clamped to 0–100%)` : "growth_rate: share of allocated memory still live at the end",
          })
        : stat("Growth", "not recorded", "this profile has no growth rate"),
    );
    stats.append(stat("Native threads", mem.native > 0 ? fmtMem(mem.native) : "none sampled", "allocated outside Python frames"));
    stats.append(stat("Allocated", fmtMem(mem.allocated), "sampled volume over the run"));
    const leakVal = model.caps.leaks ? (model.leaks.length > 0 ? String(model.leaks.length) : "none detected") : "not recorded";
    stats.append(stat("Possible leaks", leakVal, model.leaks.length > 0 ? "lines whose memory keeps growing" : undefined, { danger: model.leaks.length > 0 }));
  }

  // ── Chart (§4.13.2) ──
  const caption = h("p", { class: "mem-caption" });
  const chartHost = h("div", { class: "mem-chart" });
  const figcaption = h("figcaption", { class: VISUALLY_HIDDEN });
  const figure = h("figure", { class: "mem-figure" }, chartHost, figcaption);
  const pair: CanvasPair = createCanvasPair(chartHost);
  const detail = h("div", { class: "mem-detail", "aria-live": "off" });
  const chartCol = h(
    "div",
    { class: "mem-chart-col" },
    caption,
    samples ? figure : h("p", { class: "mem-empty" }, "The footprint over time was not sampled in this profile."),
    detail,
  );

  // ── Sites (§4.13.3) ──
  const listId = uid("mem-sites");
  let order: SiteOrder = store.get().memory.siteOrder;
  let showMore = false;
  const orderCtl: Choice<SiteOrder> = segmented<SiteOrder>({
    label: "Rank allocation sites by",
    options: [
      { value: "peak", label: "Peak" },
      { value: "allocated", label: "Allocated" },
    ],
    value: order,
    onChange: (v) => {
      order = v;
      store.update((s) => ({ memory: { ...s.memory, siteOrder: v } }));
      renderSites();
    },
  });
  const list = h("div", { class: "mem-sites", role: "listbox", id: listId, "aria-label": "Largest allocation sites" });
  const moreBtn = h("button", { type: "button", class: "btn btn-ghost btn-compact mem-more" });
  moreBtn.addEventListener("click", () => {
    showMore = !showMore;
    renderSites();
  });
  const sitesCol = h(
    "div",
    { class: "mem-sites-col" },
    h("div", { class: "mem-sites-head" }, h("h3", { class: "mem-sites-title" }, "Largest allocation sites"), orderCtl.el),
    list,
    moreBtn,
  );
  const grid = h("div", { class: "mem-grid" }, chartCol, sitesCol);
  const card = h("div", { class: "card memory-card" }, stats, grid);
  host.append(header, card);

  // ── Selection ──
  const siteKey = (l: LineM) => `${l.file.name}\u0000${l.no}`;
  const lineOf = (s: { file: string; line: number } | null): LineM | null => (s ? model.fileByName.get(s.file)?.byNo.get(s.line) ?? null : null);
  let selected: LineM | null = lineOf(store.get().memory.site) ?? allocationSites(model, order).defaultSite;
  let hoverLinked: LineM | null = null;
  let roving: Roving | null = null;
  let rowsDispose = createDisposer();
  dispose.add(() => rowsDispose.dispose());
  let rows: { el: HTMLElement; line: LineM }[] = [];

  function select(l: LineM | null, opts: { announce?: boolean } = {}): void {
    selected = l;
    store.update((s) => ({ memory: { ...s.memory, site: l ? { file: l.file.name, line: l.no } : null } }));
    for (const r of rows) r.el.setAttribute("aria-selected", String(r.line === l));
    renderCaption();
    drawBase();
    if (opts.announce && l) ctx.announce.polite(siteAnnouncement(l));
  }

  function siteAnnouncement(l: LineM): string {
    const n = l.memSamples.length / 2;
    return `${l.file.base} line ${l.no} selected: peak ${fmtMem(l.peak)}, ${fmtCount(n)} allocation event${n === 1 ? "" : "s"} shown as ticks under the chart${l.leak ? `, possible leak growing ${fmtRate(l.leak.velocity)}` : ""}`;
  }

  function renderDetail(): void {
    const l = selected;
    if (!l) {
      detail.replaceChildren();
      return;
    }
    const open = h("button", { type: "button", class: "btn btn-ghost btn-compact mem-detail-open" }, icon("code"), h("span", { class: "btn-label" }, "Open line"));
    open.addEventListener("click", () => void ctx.nav.jumpTo(lineTarget(l), { source: "memory" }));
    const n = l.memSamples.length / 2;
    const rowsDl: [string, string][] = [
      // The row label already says "Peak": the value does not repeat it (round 1).
      ["Peak", `${linePeak(l.peak).replace(/^peak /, "")} (Python ${fmtPct(100 * clamp(l.pyFrac, 0, 1))})`],
      ["Allocated", allocatedPhrase(l.malloc)],
      ["Share", allocShare(l.usage)],
      ["Moments", momentsText(n, l.mallocs)],
    ];
    if (l.avg > 0) rowsDl.push(["Average", `${fmtMem(l.avg)} per allocation episode`]);
    if (l.copy >= 1) rowsDl.push(["Copy", copied(l.copy)]);
    setChildren(
      detail,
      h(
        "div",
        { class: "mem-detail-head" },
        h("span", { class: "mem-detail-label" }, "Selected site"),
        h("span", { class: "mono mem-detail-loc" }, fmtLoc(l.file.name, l.no)),
        h("span", { class: "flame-spacer" }),
        open,
      ),
      h("pre", { class: "code mem-detail-code" }, l.text.trim() || "(no source)"),
      h(
        "dl",
        { class: "mem-detail-rows" },
        rowsDl.map(([k, v]) => h("div", { class: "mem-detail-row" }, h("dt", null, k), h("dd", null, v))),
      ),
      l.leak ? h("p", { class: "mem-detail-leak" }, icon("trend-up"), leakPhrase(l.leak)) : null,
    );
  }

  function renderCaption(): void {
    renderDetail();
    const l = selected;
    if (!l) {
      caption.replaceChildren("Select an allocation site to see when it allocated.");
      return;
    }
    const n = l.memSamples.length / 2;
    const parts: (Node | string)[] = [
      h("i", { class: ["mem-rug-sw", l.leak ? "is-leak" : ""], "aria-hidden": "true" }),
      h("span", { class: "mono mem-cap-loc" }, fmtLoc(l.file.name, l.no)),
      n > 0 ? ` allocated or freed at ${fmtCount(n)} sampled moment${n === 1 ? "" : "s"} (ticks under the chart)` : " has no sampled allocation moments",
    ];
    caption.replaceChildren(...parts);
    figcaption.textContent = chartSummary();
  }

  function chartSummary(): string {
    if (!mem) return "";
    const peak = mem.peakT !== null ? ` at ${fmtTime(mem.peakT)}` : "";
    const sn = selected ? selected.memSamples.length / 2 : 0;
    const site = selected ? ` Ticks under the chart mark the ${fmtCount(sn)} allocation event${sn === 1 ? "" : "s"} of ${selected.file.base} line ${selected.no}.` : "";
    return `Program footprint over ${fmtTime(tMax)}, peaking at ${fmtMem(mem.peak)}${peak}.${site}`;
  }

  function siteRow(l: LineM, rank: number | null, scale: number): HTMLElement {
    const value = order === "peak" ? fmtMem(l.peak) : fmtMem(l.malloc);
    const segs =
      order === "peak"
        ? [
            { value: l.peak * clamp(l.pyFrac, 0, 1), token: "mem-py" },
            { value: l.peak * (1 - clamp(l.pyFrac, 0, 1)), token: "mem-native" },
          ]
        : [{ value: l.usage, token: "mem-py" }];
    const m = meter(document, { segments: segs, max: scale > 0 ? scale : 1, height: 6, className: "mem-site-meter" });
    const code = l.text.trim() || "(no source)";
    const share = order === "peak" ? `peak ${fmtMem(l.peak)} attributed to this line` : `${fmtMem(l.malloc)} allocated over the run (sampled) · ${fmtPct(100 * l.usage)} of all allocation`;
    const el = h(
      "div",
      {
        role: "option",
        class: ["mem-site", l.leak ? "is-leak" : ""],
        id: uid("site"),
        tabindex: "-1",
        "aria-selected": String(l === selected),
        "aria-label": `${rank !== null ? `${rank}. ` : ""}${l.file.base} line ${l.no}, ${code}, ${share}${l.leak ? `, possible leak growing ${fmtRate(l.leak.velocity)}` : ""}`,
        dataset: { key: siteKey(l) },
      },
      h("span", { class: "mem-site-rank", "aria-hidden": "true" }, rank !== null ? String(rank) : ""),
      h(
        "span",
        { class: "mem-site-main" },
        h("span", { class: "mem-site-line1" }, h("span", { class: "mem-site-loc mono" }, fmtLoc(l.file.name, l.no)), h("span", { class: "mem-site-code code" }, code)),
        h(
          "span",
          { class: "mem-site-line2" },
          m,
          l.leak ? badge(`possible leak · grows ${fmtRate(l.leak.velocity)}`, { variant: "danger", icon: "trend-up" }) : null,
        ),
      ),
      h("span", { class: "mem-site-val" }, value),
    );
    el.addEventListener("click", () => {
      roving?.setActive(rows.findIndex((r) => r.el === el), true);
      select(l);
    });
    el.addEventListener("dblclick", () => void ctx.nav.jumpTo(lineTarget(l), { source: "memory" }));
    el.addEventListener("pointerenter", () => ctx.bus.emit("hover:line", { target: lineTarget(l), source: "memory" }));
    el.addEventListener("pointerleave", () => ctx.bus.emit("hover:line", { target: null, source: "memory" }));
    rowsDispose.add(
      bindTooltip(ctx.tooltip, el, () => ({
        title: fmtLoc(l.file.name, l.no),
        rows: [
          ["Peak", `${fmtMem(l.peak)} (Python ${fmtPct(100 * clamp(l.pyFrac, 0, 1))})`],
          ["Allocated", `${fmtMem(l.malloc)} · ${fmtPct(100 * l.usage)} of all`],
          ["Moments", momentsText(l.memSamples.length / 2, l.mallocs)],
        ] as [string, string][],
        code,
        hint: "Click to show its allocation events under the chart · double-click or Enter opens the line",
      })),
    );
    return el;
  }

  function renderSites(): void {
    rowsDispose.dispose();
    rowsDispose = createDisposer();
    const sites = allocationSites(model, order, showMore ? 25 : 8);
    const nodes: HTMLElement[] = [];
    rows = [];
    sites.rows.forEach((l, i) => {
      const el = siteRow(l, i + 1, sites.scale);
      rows.push({ el, line: l });
      nodes.push(el);
    });
    if (sites.pinnedLeaks.length > 0) {
      const groupLabel = uid("leaks");
      const group = h(
        "div",
        { role: "group", class: "mem-site-group", "aria-labelledby": groupLabel },
        h("div", { class: "mem-site-group-label", id: groupLabel }, "Possible leaks"),
      );
      for (const l of sites.pinnedLeaks) {
        const el = siteRow(l, null, sites.scale);
        rows.push({ el, line: l });
        group.append(el);
      }
      nodes.push(group);
    }
    if (rows.length === 0) nodes.push(h("p", { class: "mem-empty" }, "No allocation sites were sampled."));
    list.replaceChildren(...nodes);
    const total = sites.rows.length + sites.more;
    moreBtn.hidden = total <= 8;
    moreBtn.textContent = showMore ? "Show top 8 sites" : `Show ${Math.min(25, total)} sites`;
    if (selected && !rows.some((r) => r.line === selected)) {
      // Keep the selection when it is still listed; otherwise fall back to the default.
      selected = sites.defaultSite;
    }
    if (!selected && rows.length) selected = rows[0].line;
    for (const r of rows) r.el.setAttribute("aria-selected", String(r.line === selected));
    roving?.destroy();
    roving = rovingFocus({
      container: list,
      items: () => rows.map((r) => r.el),
      orientation: "vertical",
      vimKeys: true,
      onMove: (_el, i) => select(rows[i]?.line ?? null, { announce: true }),
      onActivate: (_el, i, ev) => {
        const l = rows[i]?.line;
        if (!l) return;
        if (ev.key === " ") select(l, { announce: true });
        else void ctx.nav.jumpTo(lineTarget(l), { source: "memory" });
      },
    });
    const idx = rows.findIndex((r) => r.line === selected);
    roving.setActive(Math.max(0, idx), false);
    renderCaption();
    drawBase();
  }

  // ── Drawing ──
  let geo: ChartGeometry | null = null;
  /** Last peak annotation and the trace it avoids (debug hook, review round 1). */
  let peakPlan: { kind: string; rect: Rect | null; trace: unknown } | null = null;
  let hoverX: number | null = null;
  let revealStart: number | null = ctx.motion.reduced || ctx.host.flags.still ? -1 : null;
  let revealFrame = 0;
  let range: [number, number] | null = store.get().range;
  const top = mem ? memoryScale(mem.peak, 3) : null;

  function relayout(): void {
    if (!samples) return;
    const l = store.get().layout;
    const w = Math.max(120, Math.floor(chartHost.clientWidth));
    const hgt = chartHeight(l.bp, l.short);
    chartHost.style.height = `${hgt}px`;
    pair.resize(w, hgt);
    geo = chartGeometry(w, hgt);
    drawBase();
    drawOverlay();
  }

  function clipX(): number {
    if (!geo) return 0;
    if (revealStart === -1) return geo.width;
    if (revealStart === null) return 0;
    const p = clamp((performance.now() - revealStart) / REVEAL_MS, 0, 1);
    if (p >= 1) {
      revealStart = -1;
      return geo.width;
    }
    if (!revealFrame) revealFrame = requestAnimationFrame(() => {
      revealFrame = 0;
      drawBase();
    });
    return geo.plot.x + geo.plot.w * EASE.out(p);
  }

  function drawBase(): void {
    if (!samples || !geo || !mem || !top) return;
    const b = pair.b;
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, pair.base.width, pair.base.height);
    b.restore();
    const t = theme.tokens();
    const { plot, rug } = geo;
    const domain: [number, number] = [0, tMax];
    const xt = timeTicks(0, tMax, plot.w);
    drawVGridlines(b, xt, plot, t["grid"], pair.dpr);
    drawHGridlines(b, top.ticks, plot, t["grid"], pair.dpr);
    // Baseline at 0.
    b.fillStyle = t["line-strong"];
    b.fillRect(plot.x, Math.round(plot.y + plot.h) - 0.5, plot.w, 1);
    // Y labels in the right gutter (max 3, clamped inside the plot's vertical bounds).
    setFont(b, uiFont(theme, 11, 400));
    b.fillStyle = t["fg-3"];
    b.textBaseline = "middle";
    b.textAlign = "left";
    let lastY = Infinity;
    for (const tk of top.ticks.ticks) {
      if (tk.value === 0) continue;
      const y = plot.y + plot.h - tk.frac * plot.h;
      if (y < plot.y - 2 || lastY - y < 14) continue;
      b.fillText(tk.label, plot.x + plot.w + 8, clamp(y, plot.y + 6, plot.y + plot.h - 6));
      lastY = y;
    }
    drawTimeLabels(b, xt, plot, geo.height - 5, { font: uiFont(theme, 11, 400), color: t["fg-3"] });
    if (range) {
      const s = footprintScales(plot, domain, top.top);
      const a = s.x(Math.max(0, range[0]));
      const c = s.x(Math.min(tMax, range[1]));
      b.fillStyle = alpha(t["fg"], 0.06);
      b.fillRect(a, plot.y, Math.max(1, c - a), plot.h);
    }
    const cx = clipX();
    drawFootprint(b, samples, { rect: plot, domain, yMax: top.top, theme, clipX: cx });
    // Rug: the selected site's allocation moments (never rings on the line, must-fix 9).
    b.fillStyle = t["sunken"];
    b.fillRect(rug.x, rug.y, rug.w, rug.h);
    if (selected && selected.memSamples.length) {
      b.save();
      b.beginPath();
      b.rect(0, 0, cx, geo.height);
      b.clip();
      drawRug(b, sampleTimes(selected.memSamples), domain, { x: rug.x, y: rug.y + 2, w: rug.w, h: rug.h - 4 }, selected.leak ? t["danger"] : t["mem-py"]);
      b.restore();
    }
    if (hoverLinked && hoverLinked !== selected && hoverLinked.memSamples.length) {
      b.save();
      b.globalAlpha = 0.6;
      drawRug(b, sampleTimes(hoverLinked.memSamples), domain, { x: rug.x, y: rug.y + 2, w: rug.w, h: rug.h - 4 }, t["fg-2"]);
      b.restore();
    }
    // Peak marker + callout once the sweep has crossed the peak (the peak is an event in time).
    if (mem.peakT !== null) {
      const s = footprintScales(plot, domain, top.top);
      const dot = { x: s.x(mem.peakT), y: s.y(mem.peak) };
      if (dot.x <= cx) {
        const text = { title: `peak ${fmtMem(mem.peak)}`, detail: `${fmtTime(mem.peakT)}${mem.peakLine ? ` · ${fmtLoc(mem.peakLine.file.name, mem.peakLine.no)}` : ""}` };
        const sizes = measureCallout(b, text, theme);
        // Trace-aware (review round 1): the box never covers the footprint it annotates.
        const trace = footprintTrace(samples, plot, domain, top.top);
        const p = planPeakClear({ dot, callout: sizes.callout, label: sizes.label, bounds: plot, reserved: [dotRect(dot, 6)], trace });
        peakPlan = { kind: p.kind, rect: p.rect, trace };
        drawPeakMarker(b, dot, theme);
        drawCallout(b, p.kind === "gutter" ? { kind: "gutter", rect: null } : { kind: p.kind, side: p.spot.endsWith("right") ? "right" : "left", rect: p.rect }, text, theme);
      }
    }
  }

  function drawOverlay(): void {
    pair.clearOverlay();
    if (!samples || !geo || !top || hoverX === null) return;
    const o = pair.o;
    const t = theme.tokens();
    const { plot, rug } = geo;
    const x = clamp(hoverX, plot.x, plot.x + plot.w);
    const s = footprintScales(plot, [0, tMax], top.top);
    o.save();
    o.strokeStyle = alpha(t["fg"], 0.45);
    o.lineWidth = 1;
    o.beginPath();
    o.moveTo(crisp(x, pair.dpr), plot.y);
    o.lineTo(crisp(x, pair.dpr), rug.y + rug.h);
    o.stroke();
    const tv = s.t(x);
    const fp = footprintAt(samples, tv);
    if (fp) {
      o.beginPath();
      o.arc(x, s.y(fp.mb), 3.5, 0, Math.PI * 2);
      o.fillStyle = t["mem-py"];
      o.fill();
      o.lineWidth = 1.5;
      o.strokeStyle = t["surface"];
      o.stroke();
    }
    o.restore();
  }

  // ── Hover ──
  const rel = (ev: MouseEvent) => {
    const r = pair.overlay.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  // The canvas pair is not interactive (aria-hidden); hover lives on the host.
  chartHost.addEventListener("pointermove", (ev) => {
    if (!geo || !samples || !top) return;
    const { x } = rel(ev);
    if (x < geo.plot.x || x > geo.plot.x + geo.plot.w) {
      hoverX = null;
      drawOverlay();
      ctx.tooltip.hide();
      return;
    }
    hoverX = x;
    drawOverlay();
    const s = footprintScales(geo.plot, [0, tMax], top.top);
    const tv = s.t(x);
    const fp = footprintAt(samples, tv);
    const rows: [string, string][] = [["Footprint", fp ? `${fmtMem(fp.mb)}${fp.interpolated ? " (interpolated)" : ""}` : "not sampled"]];
    let hint: string | undefined;
    if (selected && selected.memSamples.length) {
      const times = sampleTimes(selected.memSamples);
      const j = nearestEvent(times, tv, (NEAR_PX / geo.plot.w) * tMax);
      if (j >= 0) {
        const mb = selected.memSamples[2 * j + 1];
        hint = `${fmtLoc(selected.file.name, selected.no)} allocated or freed at ${times[j].toFixed(2)} s (footprint ${fmtMem(mb)})`;
      }
    }
    ctx.tooltip.show({ x: ev.clientX, y: ev.clientY }, { title: fmtTime(tv), rows, hint });
  });
  chartHost.addEventListener("pointerleave", () => {
    hoverX = null;
    drawOverlay();
    ctx.tooltip.hide();
  });

  // ── Wiring ──
  // Theme: repaint now when near the viewport, else when it scrolls into range (§6.1).
  const near = nearViewport(card);
  dispose.add(near.dispose);
  dispose.add(ctx.bus.on("theme:changed", () => near.run(() => {
    drawBase();
    drawOverlay();
  })));
  dispose.add(ctx.bus.on("layout:changed", () => relayout()));
  dispose.add(
    ctx.bus.on("range:set", ({ range: r }) => {
      range = r;
      drawBase();
    }),
  );
  dispose.add(store.subscribe((s) => s.range, (r) => {
    range = r;
    drawBase();
  }));
  dispose.add(
    ctx.bus.on("hover:line", ({ target, source }) => {
      if (source === "memory") return;
      const l = target && "line" in target ? lineOf({ file: target.file, line: target.line }) : null;
      for (const r of rows) r.el.classList.toggle("is-linked", r.line === l);
      const next = l && l.memSamples.length ? l : null;
      if (next !== hoverLinked) {
        hoverLinked = next;
        drawBase();
      }
    }),
  );
  let lastW = -1;
  dispose.add(
    observeSize(chartHost, (w) => {
      if (w === lastW) return;
      lastW = w;
      relayout();
    }),
  );
  dispose.add(
    ctx.motion.revealOnce(card, () => {
      if (revealStart !== null) return;
      revealStart = ctx.motion.reduced || ctx.host.flags.still ? -1 : performance.now();
      drawBase();
    }),
  );

  renderSites();
  relayout();
  Object.defineProperty(card, "__memory", {
    configurable: true,
    value: { selected: () => (selected ? `${selected.file.base}:${selected.no}` : null), geo: () => geo, peak: () => peakPlan, rugCount: () => (selected ? selected.memSamples.length / 2 : 0) },
  });

  return {
    destroy() {
      if (revealFrame) cancelAnimationFrame(revealFrame);
      dispose.dispose();
      roving?.destroy();
      orderCtl.destroy();
      pair.destroy();
      host.replaceChildren();
    },
  };
}
