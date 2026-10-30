/**
 * Thread timeline (DESIGN.md §4.12): a DOM gutter (labels, lane toggles)
 * beside one canvas pair; rows = axis, memory footprint, GC / I/O & waits /
 * GIL annotation lanes with the model's totals, then one lane per thread
 * (Lanes) or one panel (Interleaved). Brush, Ctrl/⌘+wheel, keys and
 * `range:set` drive the time domain (M13); `TimelineApi` serves
 * "Show in timeline". Frames are drawn by `renderTimelineFrames(…, sourceLookup)`.
 */

import { alpha, createCanvasPair, crisp, hatch, nearViewport, observeSize, setFont, uiFont, type CanvasPair } from "../../core/canvas";
import { sectionHeader, segmented, select, type Choice, type SelectControl } from "../../core/controls";
import { createDisposer, h, uid, VISUALLY_HIDDEN } from "../../core/dom";
import { idle } from "../../core/schedule";
import { fmtCount, fmtMem, fmtPct, fmtRange, fmtTime } from "../../core/format";
import { icon } from "../../core/icons";
import { EASE } from "../../core/motion";
import type { Target } from "../../core/store";
import { bindTooltip } from "../../core/tooltip";
import type { TooltipContent } from "../../core/tooltip";
import { drawFootprint, drawPeakMarker, footprintScales } from "../../charts/footprint";
import { memoryScale, timeTicks } from "../../charts/axis";
import { IO_CATEGORIES } from "../../model/classify";
import { fmtSampling } from "../../model/headline";
import { footprintAt } from "../../model/memory";
import type { SourceLookup } from "../../model/source";
import { lineKey } from "../../model/stacks";
import type { TimelineM } from "../../model/timeline";
import type { TimelineApi, ViewContext, ViewHandle } from "../app";
import {
  clamp,
  drawTimeChip,
  fmtSecPrecise,
  framePalette,
  frameKindOf,
  frameNameOf,
  isClick,
  renderAxisLabels,
  renderGridLines,
  strokeHighlight,
  threadSlot,
  wheelPixels,
} from "../stacks/shared";
import { createShowInCaption, createTapCard, isTouchPointer, type TapAction } from "../stacks/details";
import {
  AXIS_H,
  CLASS_BIT,
  CLASS_KEYS,
  CLASS_LABEL,
  ROW_H,
  STRIP_H,
  classIntervals,
  clampDomain,
  computeLayout,
  domainAnnouncement,
  filterValueFor,
  fmtDomain,
  intervalAt,
  laneActivity,
  laneClassShares,
  laneForFilter,
  maxRunLength,
  minSpan,
  panBy,
  zoomAround,
  type ActivityScratch,
  type ClassKey,
  type Intervals,
  type LaneSpec,
  type LayoutItem,
  type TimelineLayout,
} from "./layout";
import {
  announceSegment,
  frameLocation,
  prewarmLane,
  renderTimelineFrames,
  segmentAt,
  segmentRef,
  threadText,
  type FramePanel,
  type SegmentRef,
} from "./frames";

export { renderTimelineFrames } from "./frames";

export interface TimelineMount extends ViewHandle {
  api: TimelineApi;
}

export interface TimelineMountOptions {
  sourceLookup: SourceLookup;
  drawFrames: typeof renderTimelineFrames;
}

const ZOOM_MS = 280;
const KEY_ZOOM_MS = 140;
const REVEAL_MS = 520;
const KEY_ZOOM = 1.5;
const WHEEL_NOTCH = 1.25;

interface Hover {
  x: number;
  y: number;
  t: number;
  seg: SegmentRef | null;
  item: LayoutItem | null;
}

interface FocusState {
  row: number;
  ref: SegmentRef;
}

export function mountTimeline(host: HTMLElement, ctx: ViewContext, opts: TimelineMountOptions): TimelineMount {
  const { model, store, theme } = ctx;
  const dispose = createDisposer();
  const perf = ctx.host.flags.perf;
  const drawFrames = opts.drawFrames;
  const tMax = model.tMax > 0 ? model.tMax : 1;
  const summary = model.sampling;
  const threadsN = summary.threads.length;
  const multi = threadsN > 1;
  const hasIds = summary.threads.some((t) => t.id !== null);
  let tl: TimelineM | null = null;
  let destroyed = false;
  const pending: (() => void)[] = [];

  // ── Header ──
  const desc = `${fmtCount(summary.runs)} sample runs over ${fmtTime(tMax)} · ${threadsN} thread${threadsN === 1 ? "" : "s"} · x = time, rows = stack depth`;
  let viewCtl: Choice<"lanes" | "interleaved"> | null = null;
  let threadCtl: SelectControl<string> | null = null;
  const actions: HTMLElement[] = [];
  if (multi) {
    viewCtl = segmented<"lanes" | "interleaved">({
      label: "Timeline layout",
      options: [
        { value: "lanes", label: "Lanes" },
        { value: "interleaved", label: "Interleaved" },
      ],
      value: store.get().timeline.view,
      onChange: (v) => {
        store.update((s) => ({ timeline: { ...s.timeline, view: v, thread: v === "interleaved" ? "all" : s.timeline.thread } }));
      },
    });
    actions.push(viewCtl.el);
    if (hasIds) {
      const options = [{ value: "all", label: "All threads" }].concat(
        summary.threads.map((t) => ({ value: t.main ? "main" : t.id === null ? "unknown" : String(t.id), label: t.id === null ? "unknown" : t.label })),
      );
      threadCtl = select<string>({
        label: "Thread",
        id: "timeline-view-mode",
        options,
        value: store.get().timeline.thread || "all",
        onChange: (v) => store.update((s) => ({ timeline: { ...s.timeline, thread: v, view: v === "all" ? s.timeline.view : "lanes" } })),
      });
      actions.push(threadCtl.el);
    }
  }
  const header = sectionHeader({ section: "timeline", title: "Timeline", description: desc, actions: actions.length ? actions : undefined });

  // ── Toolbar ──
  const legend = h("div", { class: "flame-legend tl-legend", "aria-label": "Legend" });
  const rangeLabel = h("span", { class: "tl-range", "aria-live": "off" });
  const zoomOutBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Zoom out" }, icon("minus"));
  const zoomInBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Zoom in" }, icon("plus"));
  const resetBtn = h("button", { type: "button", class: "btn btn-ghost btn-compact" }, icon("reset"), h("span", { class: "btn-label" }, "Reset"));
  dispose.add(bindTooltip(ctx.tooltip, zoomOutBtn, { title: "Zoom out", hint: "S or −" }));
  dispose.add(bindTooltip(ctx.tooltip, zoomInBtn, { title: "Zoom in", hint: "W or +" }));
  const toolbar = h("div", { class: "tl-toolbar" }, legend, h("span", { class: "flame-spacer" }), rangeLabel, zoomOutBtn, zoomInBtn, resetBtn);
  // "Show in timeline" landing caption (round 1): which line the outlines are, Clear, Back to code.
  const showInHost = h("div", { class: "showin-host", hidden: true });

  // ── Chart ──
  const helpId = uid("tl-help");
  const chart = h("div", { class: "tl-chart" });
  const pair: CanvasPair = createCanvasPair(chart, { interactive: true });
  const axis = h("div", { class: "timeline-axis", "aria-hidden": "true" });
  const grid = h("div", { class: "timeline-gridlines", "aria-hidden": "true" });
  const gutter = h("div", { class: "tl-gutter" });
  chart.insertBefore(grid, pair.overlay);
  chart.insertBefore(axis, pair.overlay);
  chart.append(gutter);
  const cv = pair.overlay;
  cv.tabIndex = 0;
  cv.classList.add("tl-canvas");
  cv.setAttribute("role", "application");
  cv.setAttribute("aria-roledescription", "timeline");
  cv.setAttribute("aria-label", "Thread timeline");
  cv.setAttribute("aria-describedby", helpId);
  const foot = h(
    "p",
    { class: "tl-foot" },
    `Runs end at the thread's next sample or after count × ${fmtSampling(summary.dt).replace(" sampling", "")}.` +
      (model.caps.memory && model.memory && model.memory.samples.length >= 4 ? " Thread activity may be offset from the memory axis by up to one sampling interval." : "") +
      " Frames narrower than a pixel take the color of the kind that fills most of that pixel; grey marks mixed kinds (zoom in to separate them).",
  );
  const help = h(
    "p",
    { id: helpId, class: VISUALLY_HIDDEN },
    "Thread timeline. W and S or plus and minus zoom, A and D or Alt with arrow keys pan, Arrow Up and Down move between rows, Arrow Left and Right between segments, Enter opens the source line, Shift Enter zooms to the segment, 0 resets the zoom.",
  );
  const placeholder = h("div", { class: "flame-loading tl-loading", "aria-hidden": "true", style: { height: "420px" } }, "Preparing the timeline…");
  chart.hidden = true;
  // Touch: a tap pins the segment's details with real buttons (round 1, principle 8).
  let tapRef: SegmentRef | null = null;
  const tap = createTapCard(() => {
    tapRef = null;
    drawOverlay();
  });
  chart.append(tap.el);
  const card = h("div", { class: "card timeline-card" }, toolbar, showInHost, placeholder, chart, foot, help);
  host.append(header, card);

  // ── State ──
  const st = store.get().timeline;
  let view: "lanes" | "interleaved" = multi ? st.view : "lanes";
  let filter: number | null = null;
  const expanded = new Set<string>();
  const full = new Set<string>();
  let domain: [number, number] = st.domain ? clampDomain(st.domain[0], st.domain[1], tMax, 0.001) : [0, tMax];
  let layout: TimelineLayout | null = null;
  let panels: { item: LayoutItem; panel: FramePanel }[] = [];
  let width = 0;
  let hover: Hover | null = null;
  let brush: [number, number] | null = null;
  let focus: FocusState | null = null;
  let canvasFocused = false;
  let keyboard = false; // focus-visible: draw the focused segment and announce
  let linkedTarget: Target | null = null;
  let linkedRefs: { lane: number; depth: number; idx: number }[] = [];
  let lineIndex: Map<string, { lane: number; depth: number; idx: number }[]> | null = null;
  const intervalCache = new Map<string, Intervals>();
  let activityScratch: ActivityScratch | undefined;
  const labelWidths = new Map<string, number>();
  const maxRun = new Map<number, number>();
  let revealStart: number | null = ctx.motion.reduced || ctx.host.flags.still ? -1 : null;
  let revealFrame = 0;
  let emittedHover = false;
  const memSamples = model.caps.memory && model.memory && model.memory.samples.length >= 4 ? model.memory.samples : null;
  const memTop = model.memory ? memoryScale(model.memory.peak, 2).top : 1;

  const instant = () => ctx.motion.reduced || ctx.host.flags.still;
  const span = () => domain[1] - domain[0];
  const minS = () => minSpan(tl ? tl.dt : summary.dt, tMax);
  const xOf = (t: number) => (layout ? layout.plotX + ((t - domain[0]) / span()) * layout.plotW : 0);
  const tOf = (x: number) => (layout ? domain[0] + ((x - layout.plotX) / layout.plotW) * span() : 0);

  function lanes(): LaneSpec[] {
    if (!tl) return [];
    const t = tl;
    return t.threads.map((th) => ({ idx: th.idx, key: th.label, maxDepth: t.maxDepth[th.idx] ?? 0 }));
  }

  function intervals(cls: ClassKey): Intervals {
    const key = `${cls}|${filter ?? "all"}`;
    let iv = intervalCache.get(key);
    if (!iv && tl) {
      iv = classIntervals(tl, CLASS_BIT[cls], filter);
      intervalCache.set(key, iv);
    }
    return iv as Intervals;
  }

  // ── Layout + gutter ──
  function relayout(): void {
    if (!tl) return;
    const l = store.get().layout;
    width = Math.max(200, Math.floor(chart.clientWidth || card.clientWidth));
    layout = computeLayout({
      width,
      bp: l.bp,
      short: l.short,
      view,
      filter,
      lanes: lanes(),
      expanded,
      full,
      memory: memSamples !== null,
      coarse: l.coarse,
    });
    tap.hide();
    chart.style.height = `${layout.height}px`;
    pair.resize(width, layout.height);
    axis.style.left = `${layout.plotX}px`;
    axis.style.width = `${layout.plotW}px`;
    grid.style.left = `${layout.plotX}px`;
    grid.style.width = `${layout.plotW}px`;
    grid.style.top = `${AXIS_H}px`;
    renderGutter();
    if (focus && !layout.rows[focus.row]) focus = null;
    drawBase();
    drawOverlay();
  }

  function laneShareText(lane: number): string {
    const t = tl?.threads[lane];
    return t ? `${fmtPct(t.share)} of samples` : "";
  }

  function classShare(cls: ClassKey): { text: string; tip: string } {
    if (!tl) return { text: "", tip: "" };
    if (filter === null) {
      const v = tl.laneTotals[cls];
      return { text: `${fmtPct(v)} of samples`, tip: "Share of all timeline samples whose stack is in this class" };
    }
    const v = laneClassShares(tl, filter)[cls];
    const who = tl.threads[filter]?.label ?? "this thread";
    return { text: `${fmtPct(v)} of ${who}`, tip: `Share of ${who}'s samples whose stack is in this class` };
  }

  let gutterDispose = createDisposer();
  dispose.add(() => gutterDispose.dispose());

  function renderGutter(): void {
    if (!tl || !layout) return;
    gutterDispose.dispose();
    gutterDispose = createDisposer();
    const L = layout;
    const nodes: HTMLElement[] = [];
    const pos = (el: HTMLElement, y: number, hgt?: number) => {
      el.style.top = `${y}px`;
      if (hgt !== undefined) el.style.height = `${hgt}px`;
      el.style.width = L.above ? "100%" : `${L.gutter - 4}px`;
      return el;
    };
    for (const it of L.items) {
      if (it.kind === "memory" && model.memory) {
        const el = h(
          "div",
          { class: "tl-label tl-label-memory" },
          h("span", { class: "tl-name" }, h("i", { class: "legend-sw sw-mem", "aria-hidden": "true" }), "Memory"),
          h("span", { class: "tl-sub" }, `peak ${fmtMem(model.memory.peak)}`),
        );
        nodes.push(pos(el, it.labelY ?? it.y));
      } else if (it.kind === "class" && it.cls) {
        if (L.above) {
          if (it.labelY !== null) {
            const el = h(
              "div",
              { class: "tl-label tl-label-inline tl-class-group", tabindex: "0", role: "group", "aria-label": classGroupLabel() },
              CLASS_KEYS.map((k) =>
                h("span", { class: "tl-class-chip" }, h("i", { class: ["legend-sw", `sw-${k}`], "aria-hidden": "true" }), `${CLASS_LABEL[k]} ${classShare(k).text.replace(/ of .*$/, "")}`),
              ),
              h("span", { class: VISUALLY_HIDDEN }, classDefinition()),
            );
            bindClassTip(el);
            nodes.push(pos(el, it.labelY));
          }
        } else if (it.cls === CLASS_KEYS[0]) {
          // GC · I/O & waits · GIL: one focusable, tappable group (≥ 24 px target) whose
          // tooltip carries every definition — no hover-only information (round 1).
          const rows = L.items.filter((x) => x.kind === "class");
          const top = rows[0].y - 1;
          const bottom = rows[rows.length - 1].y + rows[rows.length - 1].h + 1;
          // Narrow gutters keep the number; the denominator moves to the tooltip.
          const compact = L.gutter < 168;
          const group = h(
            "div",
            { class: "tl-label tl-class-group", tabindex: "0", role: "group", "aria-label": classGroupLabel() },
            rows.map((r) => {
              const cls = r.cls as ClassKey;
              const share = classShare(cls);
              const row = h(
                "div",
                { class: "tl-label-class" },
                h("span", { class: "tl-name" }, h("i", { class: ["legend-sw", `sw-${cls}`], "aria-hidden": "true" }), CLASS_LABEL[cls]),
                h("span", { class: "tl-sub" }, compact ? share.text.replace(/ of .*$/, "") : share.text),
              );
              row.style.top = `${r.y - 1 - top}px`;
              return row;
            }),
            h("span", { class: VISUALLY_HIDDEN }, classDefinition()),
          );
          bindClassTip(group);
          nodes.push(pos(group, top, bottom - top));
        }
      } else if (it.kind === "lane" && it.lane !== undefined) {
        const lane = it.lane;
        const t = tl.threads[lane];
        const canToggle = L.items.filter((x) => x.kind === "lane").length > 1 && filter === null;
        const btn = h(
          "button",
          {
            type: "button",
            class: ["tl-lane-head", it.expanded ? "is-open" : ""],
            "aria-expanded": canToggle ? String(!!it.expanded) : undefined,
            "aria-disabled": canToggle ? undefined : "true",
            dataset: { lane },
          },
          canToggle ? h("span", { class: "tl-chev", "aria-hidden": "true" }, icon("chevron-right")) : h("span", { class: "tl-chev tl-chev-none", "aria-hidden": "true" }),
          h("span", { class: "tl-lane-name" }, t?.id === null ? "unknown" : t?.label ?? `lane ${lane}`),
          // Every lane says what its share is of (round 1): "2.5% of samples" in a full-width label
          // row, else the number under the gutter's "% of samples" column header.
          L.above
            ? h("span", { class: "tl-lane-share" }, laneShareText(lane))
            : L.laneHeaderY !== null
              ? h("span", { class: "tl-lane-share" }, fmtPct(t?.share ?? 0))
              : null,
        );
        btn.addEventListener("click", () => {
          if (!canToggle) return;
          if (expanded.has(it.laneKey as string)) expanded.delete(it.laneKey as string);
          else expanded.add(it.laneKey as string);
          persistExpanded();
          relayout();
          const again = gutter.querySelector<HTMLButtonElement>(`.tl-lane-head[data-lane="${lane}"]`);
          again?.focus({ preventScroll: true });
        });
        if (t) gutterDispose.add(bindTooltip(ctx.tooltip, btn, { title: t.label, rows: [["Thread", threadText(t)], ["Samples", `${fmtCount(t.samples)} · ${fmtPct(t.share)} of samples`]] }));
        const wrap = h("div", { class: "tl-label tl-label-lane", dataset: { laneKey: it.laneKey as string } }, btn);
        if (it.expanded && !L.above && L.laneHeaderY === null) wrap.append(h("span", { class: "tl-sub tl-lane-sub" }, L.gutter < 168 ? fmtPct(t?.share ?? 0) : laneShareText(lane)));
        if (it.expanded && (it.depthShown ?? 0) < (it.depthTotal ?? 0)) wrap.append(moreButton(it));
        else if (it.expanded && full.has(it.laneKey as string) && (it.depthTotal ?? 0) > (it.depthShown ?? 0) - 1 && (it.depthTotal ?? 0) > capFor()) wrap.append(lessButton(it));
        nodes.push(pos(wrap, it.labelY ?? it.y));
      } else if (it.kind === "inter") {
        const chips = tl.threads.map((t) =>
          h(
            "span",
            { class: "tl-thread-chip" },
            h("i", { class: "tl-thread-sw", style: { background: `var(--thread-${threadSlot(t.idx) < 5 ? threadSlot(t.idx) : "other"})` }, "aria-hidden": "true" }),
            h("span", { class: "tl-thread-name" }, t.id === null ? "unknown" : t.label),
            h("span", { class: "tl-sub" }, fmtPct(t.share)),
          ),
        );
        const wrap = h(
          "div",
          { class: "tl-label tl-label-inter", dataset: { laneKey: "*" } },
          h("span", { class: "tl-name" }, "All threads"),
          h("span", { class: "tl-sub" }, "interleaved by depth"),
          L.above ? null : h("div", { class: "tl-thread-list" }, chips),
        );
        if ((it.depthShown ?? 0) < (it.depthTotal ?? 0)) wrap.append(moreButton(it));
        nodes.push(pos(wrap, it.labelY ?? it.y));
      }
    }
    if (L.laneHeaderY !== null) {
      const head = h("div", { class: "tl-label tl-lanes-head", "aria-hidden": "true" }, L.gutter >= 168 ? h("span", null, "Threads") : null, h("span", { class: "tl-lanes-unit" }, "% of samples"));
      nodes.push(pos(head, L.laneHeaderY));
    }
    gutter.replaceChildren(...nodes);
    gutter.classList.toggle("is-above", L.above);
    gutter.style.width = L.above ? "100%" : `${L.gutter}px`;
  }

  function classGroupLabel(): string {
    return `Sample classes: ${CLASS_KEYS.map((k) => `${CLASS_LABEL[k]} ${classShare(k).text}`).join(", ")}`;
  }
  function classDefinition(): string {
    const who = filter === null ? "all timeline samples" : `${tl?.threads[filter]?.label ?? "this thread"}'s samples`;
    return `Share of ${who} whose stack is in each class. I/O & waits includes ${IO_CATEGORIES.join("; ")}.`;
  }
  function bindClassTip(el: HTMLElement): void {
    const content = (): TooltipContent => ({
      title: "Sample classes",
      rows: CLASS_KEYS.map((k) => [CLASS_LABEL[k], classShare(k).text] as [string, string]),
      hint: classDefinition(),
    });
    gutterDispose.add(bindTooltip(ctx.tooltip, el, content));
    // Tap (touch) opens it at once; hover and keyboard focus use the binding above.
    const onClick = (ev: MouseEvent) => {
      if (isTouchPointer((ev as PointerEvent).pointerType)) ctx.tooltip.show(el, content(), { describe: el });
    };
    el.addEventListener("click", onClick);
    gutterDispose.add(() => el.removeEventListener("click", onClick));
    el.style.pointerEvents = "auto";
  }

  /** Re-focus the "show all" / "show N" toggle of a lane after the gutter is rebuilt (round 1). */
  function refocusToggle(laneKey: string): void {
    const sel = `.tl-label[data-lane-key="${CSS.escape(laneKey)}"] .tl-more`;
    gutter.querySelector<HTMLButtonElement>(sel)?.focus({ preventScroll: true });
  }

  const capFor = () => {
    const l = store.get().layout;
    return l.short ? 6 : l.bp === "xs" ? 8 : 16;
  };

  function moreButton(it: LayoutItem): HTMLElement {
    const narrow = (layout?.gutter ?? 168) < 168 && !layout?.above;
    const b = h(
      "button",
      { type: "button", class: "tl-more", "aria-expanded": "false", "aria-label": `Show all ${it.depthTotal} levels` },
      narrow ? `+ all ${it.depthTotal} levels` : `+ show all ${it.depthTotal} levels`,
    );
    b.addEventListener("click", () => {
      const key = it.laneKey as string;
      const hadFocus = document.activeElement === b;
      full.add(key);
      persistExpanded();
      relayout();
      // The gutter is rebuilt: keep focus on this lane's toggle (now "− show N levels").
      if (hadFocus) refocusToggle(key);
    });
    return b;
  }
  function lessButton(it: LayoutItem): HTMLElement {
    const b = h("button", { type: "button", class: "tl-more", "aria-expanded": "true", "aria-label": `Show ${capFor()} of ${it.depthTotal} levels` }, `− show ${capFor()} levels`);
    b.addEventListener("click", () => {
      const key = it.laneKey as string;
      const hadFocus = document.activeElement === b;
      full.delete(key);
      persistExpanded();
      relayout();
      if (hadFocus) refocusToggle(key);
    });
    return b;
  }

  function persistExpanded(): void {
    const list = Array.from(expanded).concat(Array.from(full).map((k) => `${k}#all`));
    store.update((s) => ({ timeline: { ...s.timeline, expanded: list } }));
  }

  // ── Base draw ──
  function revealClip(now: number): number {
    if (!layout) return 0;
    if (revealStart === -1) return layout.plotX + layout.plotW + 2;
    if (revealStart === null) return layout.plotX;
    const p = clamp((now - revealStart) / REVEAL_MS, 0, 1);
    if (p >= 1) {
      revealStart = -1;
      return layout.plotX + layout.plotW + 2;
    }
    if (!revealFrame) revealFrame = requestAnimationFrame(() => {
      revealFrame = 0;
      drawBase();
    });
    return layout.plotX + layout.plotW * EASE.out(p);
  }

  function drawAxis(): void {
    if (!layout) return;
    const L = layout;
    const ticks = timeTicks(domain[0], domain[1], L.plotW);
    const list = ticks.ticks.map((t) => ({ x: t.frac * L.plotW, label: t.label }));
    const c = pair.o;
    renderAxisLabels(
      axis,
      list,
      L.plotW,
      (s) => {
        let w = labelWidths.get(s);
        if (w === undefined) {
          c.save();
          setFont(c, uiFont(theme, 12, 400));
          w = c.measureText(s).width;
          c.restore();
          if (labelWidths.size > 2000) labelWidths.clear();
          labelWidths.set(s, w);
        }
        return w;
      },
      0,
    );
    renderGridLines(
      grid,
      list.map((t) => t.x),
      L.plotW,
    );
  }

  function drawBase(): void {
    const t0 = performance.now();
    const b = pair.b;
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, pair.base.width, pair.base.height);
    b.restore();
    panels = [];
    if (!tl || !layout) return;
    const L = layout;
    const p = framePalette(theme);
    const tk = theme.tokens();
    const tA = performance.now();
    drawAxis();
    const axisMs = performance.now() - tA;
    let stripMs = 0;
    let frameMs = 0;
    rangeLabel.textContent = fmtDomain(domain[0], domain[1]);
    const clipX = revealClip(performance.now());
    b.save();
    b.beginPath();
    b.rect(0, AXIS_H, clipX, L.height);
    b.clip();
    // Axis baseline.
    b.fillStyle = tk["line"];
    b.fillRect(L.plotX, AXIS_H - 1, L.plotW, 1);
    for (const it of L.items) {
      if (it.kind === "memory" && memSamples && model.memory) {
        const rect = { x: L.plotX, y: it.y + 3, w: L.plotW, h: it.h - 6 };
        b.fillStyle = tk["sunken"];
        b.globalAlpha = 0.5;
        b.fillRect(L.plotX, it.y, L.plotW, it.h);
        b.globalAlpha = 1;
        drawFootprint(b, memSamples, { rect, domain, yMax: memTop, theme });
        const pt = model.memory.peakT;
        if (pt !== null && pt >= domain[0] && pt <= domain[1]) {
          const s = footprintScales(rect, domain, memTop);
          drawPeakMarker(b, { x: s.x(pt), y: s.y(model.memory.peak) }, theme);
        }
      } else if (it.kind === "class" && it.cls) {
        b.fillStyle = tk["sunken"];
        b.fillRect(L.plotX, it.y, L.plotW, it.h);
        const iv = intervals(it.cls);
        b.fillStyle = it.cls === "gc" ? tk["gc"] : it.cls === "gil" ? tk["gil"] : hatch(b, "waiting", theme);
        const k = L.plotW / span();
        let lastX = -Infinity;
        for (let i = lowerB(iv.b, domain[0], iv.n); i < iv.n; i++) {
          const a = iv.a[i];
          if (a > domain[1]) break;
          let x0 = L.plotX + (a - domain[0]) * k;
          const x1 = L.plotX + (iv.b[i] - domain[0]) * k;
          if (x1 - x0 < 1) {
            if (x0 < lastX + 1) continue; // one bar per pixel
            x0 = Math.floor(x0);
            b.fillRect(x0, it.y + 1, 1, it.h - 2);
            lastX = x0;
            continue;
          }
          b.fillRect(x0, it.y + 1, x1 - x0, it.h - 2);
          lastX = x1;
        }
      } else if (it.kind === "lane" && it.lane !== undefined) {
        // Hairline separator between lanes.
        b.fillStyle = tk["line"];
        b.fillRect(0, Math.round(it.y - 3), L.width, 1);
        const tP = performance.now();
        if (it.expanded) {
          const panel = drawFrames(
            { ctx2d: b, tl, lanes: [it.lane], interleaved: false, x: L.plotX, y: it.bodyY as number, w: L.plotW, rowH: ROW_H, depth: it.depthShown ?? 0, domain, theme, dpr: pair.dpr },
            opts.sourceLookup,
          );
          panels.push({ item: it, panel });
          frameMs += performance.now() - tP;
        } else {
          drawStrip(b, it.lane, it.bodyY as number, p);
          stripMs += performance.now() - tP;
        }
      } else if (it.kind === "inter" && it.lanes) {
        b.fillStyle = tk["line"];
        b.fillRect(0, Math.round(it.y - 3), L.width, 1);
        const panel = drawFrames(
          { ctx2d: b, tl, lanes: it.lanes, interleaved: true, x: L.plotX, y: it.bodyY as number, w: L.plotW, rowH: ROW_H, depth: it.depthShown ?? 0, domain, theme, dpr: pair.dpr },
          opts.sourceLookup,
        );
        panels.push({ item: it, panel });
      }
    }
    b.restore();
    const ms = performance.now() - t0;
    if (perf) measure("scalene:timeline-base", t0, ms);
    chart.dataset.baseMs = ms.toFixed(2);
    if (perf) chart.dataset.breakdown = `axis ${axisMs.toFixed(1)} · frames ${frameMs.toFixed(1)} · strips ${stripMs.toFixed(1)}`;
  }

  function drawStrip(b: CanvasRenderingContext2D, lane: number, y: number, p: ReturnType<typeof framePalette>): void {
    if (!tl || !layout) return;
    const L = layout;
    let mr = maxRun.get(lane);
    if (mr === undefined) {
      mr = maxRunLength(tl, lane);
      maxRun.set(lane, mr);
    }
    const cols = Math.max(1, Math.floor(L.plotW));
    const act = laneActivity(tl, lane, domain[0], domain[1], cols, mr, activityScratch);
    activityScratch = act.scratch;
    const tk = theme.tokens();
    b.fillStyle = tk["sunken"];
    b.globalAlpha = 0.6;
    b.fillRect(L.plotX, y, L.plotW, STRIP_H);
    b.globalAlpha = 1;
    const colors = [p.fill.py, p.fill.native, alpha(tk["async"], 0.75)];
    const cw = L.plotW / cols;
    for (let c = 0; c < cols; c++) {
      const v = act.cov[c];
      if (v <= 0.02) continue;
      const hh = Math.max(1, Math.min(1, v) * STRIP_H);
      b.fillStyle = colors[act.kind[c]];
      b.fillRect(L.plotX + c * cw, y + STRIP_H - hh, Math.max(1, cw), hh);
    }
  }

  function measure(name: string, start: number, ms: number): void {
    try {
      performance.measure(name, { start, end: start + ms });
    } catch {
      // Older engines lack measure() options.
    }
  }

  // ── Overlay ──
  function segRect(ref: { lane: number; depth: number; idx: number }): { x: number; y: number; w: number; h: number } | null {
    if (!tl || !layout) return null;
    const L = layout;
    const item = L.items.find((it) => (it.kind === "inter" || (it.kind === "lane" && it.expanded)) && it.lanes?.includes(ref.lane));
    if (!item || ref.depth >= (item.depthShown ?? 0)) return null;
    const row = tl.segments(ref.lane).rows[ref.depth];
    if (!row) return null;
    const x0 = xOf(row.t0[ref.idx]);
    const x1 = xOf(row.t1[ref.idx]);
    if (x1 < L.plotX || x0 > L.plotX + L.plotW) return null;
    const xl = Math.max(L.plotX, x0);
    const xr = Math.min(L.plotX + L.plotW, x1);
    return { x: xl, y: (item.bodyY as number) + ref.depth * ROW_H, w: Math.max(2, xr - xl), h: ROW_H - 1 };
  }

  function drawOverlay(): void {
    const t0 = performance.now();
    pair.clearOverlay();
    if (!tl || !layout) return;
    const L = layout;
    const o = pair.o;
    const p = framePalette(theme);
    const tk = theme.tokens();
    o.save();
    for (const r of linkedRefs) {
      const rc = segRect(r);
      if (rc) strokeHighlight(o, p, rc.x, rc.y, rc.w, rc.h);
    }
    if (hover?.seg) {
      const rc = segRect(hover.seg);
      if (rc) {
        o.lineWidth = 1.5;
        o.strokeStyle = p.fg;
        o.strokeRect(rc.x + 0.75, rc.y + 0.75, Math.max(0.5, rc.w - 1.5), Math.max(0.5, rc.h - 1.5));
      }
    }
    if (focus && canvasFocused && keyboard) {
      const rc = segRect(focus.ref);
      if (rc) strokeHighlight(o, p, rc.x, rc.y, rc.w, rc.h);
    }
    if (tapRef) {
      const rc = segRect(tapRef);
      if (rc) strokeHighlight(o, p, rc.x, rc.y, rc.w, rc.h);
    }
    if (brush) {
      const a = xOf(Math.min(brush[0], brush[1]));
      const bb = xOf(Math.max(brush[0], brush[1]));
      o.fillStyle = alpha(tk["fg"], 0.08);
      o.fillRect(a, AXIS_H, bb - a, L.height - AXIS_H);
      o.fillStyle = alpha(tk["fg"], 0.5);
      o.fillRect(Math.round(a), AXIS_H, 1, L.height - AXIS_H);
      o.fillRect(Math.round(bb), AXIS_H, 1, L.height - AXIS_H);
    }
    if (hover && hover.x >= L.plotX && hover.x <= L.plotX + L.plotW) {
      const x = crisp(hover.x, pair.dpr);
      o.strokeStyle = alpha(tk["fg"], 0.45);
      o.lineWidth = 1;
      o.beginPath();
      o.moveTo(x, AXIS_H);
      o.lineTo(x, L.height);
      o.stroke();
      const mem = L.items.find((it) => it.kind === "memory");
      if (mem && memSamples) {
        const fp = footprintAt(memSamples, hover.t);
        if (fp) {
          const s = footprintScales({ x: L.plotX, y: mem.y + 3, w: L.plotW, h: mem.h - 6 }, domain, memTop);
          o.beginPath();
          o.arc(hover.x, s.y(fp.mb), 3.5, 0, Math.PI * 2);
          o.fillStyle = tk["mem-py"];
          o.fill();
          o.lineWidth = 1.5;
          o.strokeStyle = tk["surface"];
          o.stroke();
        }
      }
      const chipText = brush ? `${fmtRange(Math.min(brush[0], brush[1]), Math.max(brush[0], brush[1]))} · ${fmtTime(Math.abs(brush[1] - brush[0]))}` : fmtTime(hover.t);
      drawTimeChip(o, theme, hover.x, 4, chipText, L.plotX, L.plotX + L.plotW);
    }
    o.restore();
    const ms = performance.now() - t0;
    if (perf) measure("scalene:timeline-overlay", t0, ms);
    chart.dataset.overlayMs = ms.toFixed(2);
  }

  // ── Domain ──
  function applyDomain(d: [number, number]): void {
    domain = d;
    chart.dataset.domain = `${d[0]},${d[1]}`;
    drawBase();
    if (hover && layout) hover.t = tOf(hover.x);
    drawOverlay();
  }

  let persistTimer = 0;
  function persistDomain(): void {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      const full = domain[0] <= 1e-9 && domain[1] >= tMax - 1e-9;
      store.update((s) => ({ timeline: { ...s.timeline, domain: full ? null : [domain[0], domain[1]] } }));
    }, 120);
  }

  let announceTimer = 0;
  dispose.add(() => window.clearTimeout(announceTimer));
  /**
   * `announce` (default true): once the zoom/pan settles, say the new range politely, debounced
   * 150 ms ("Showing 28.400 s to 28.440 s of 54.1 s"; round 1). Callers that announce their own
   * result (keyboard segment walk, Show in timeline) pass false.
   */
  function setDomain(r: readonly [number, number] | null, animate: boolean, ms = ZOOM_MS, announce = true): void {
    const target = r ? clampDomain(r[0], r[1], tMax, minS()) : ([0, tMax] as [number, number]);
    const from: [number, number] = [domain[0], domain[1]];
    const animated = animate && !instant() && !!tl;
    tap.hide();
    if (!animated) {
      ctx.motion.tween("tl-zoom", 0, EASE.linear, () => undefined);
      applyDomain(target);
    } else {
      ctx.motion.tween("tl-zoom", ms, EASE.standard, (t) => applyDomain([from[0] + (target[0] - from[0]) * t, from[1] + (target[1] - from[1]) * t]));
    }
    persistDomain();
    window.clearTimeout(announceTimer);
    if (announce) announceTimer = window.setTimeout(() => ctx.announce.polite(domainAnnouncement(domain, tMax)), (animated ? ms : 0) + 150);
  }

  // ── Hover and hit testing ──
  function itemAt(y: number): LayoutItem | null {
    if (!layout) return null;
    for (const it of layout.items) {
      if (it.kind === "axis") continue;
      const top = it.kind === "lane" || it.kind === "inter" ? (it.bodyY as number) : it.y;
      const bottom = it.kind === "lane" && !it.expanded ? top + STRIP_H : it.kind === "lane" || it.kind === "inter" ? top + (it.depthShown ?? 0) * ROW_H : it.y + it.h;
      if (y >= top - 1 && y < bottom + 1) return it;
    }
    return null;
  }

  function hitSeg(x: number, y: number): SegmentRef | null {
    for (const { panel } of panels) {
      const r = panel.hit(x, y);
      if (r) return r;
    }
    return null;
  }

  const targetOf = (ref: SegmentRef | null): Target | null =>
    ref && ref.frame.kind === "py" && model.fileByName.has(ref.frame.filename_or_module) ? { file: ref.frame.filename_or_module, line: ref.frame.line } : null;

  function tooltipFor(hv: Hover): TooltipContent | null {
    if (!tl || !layout) return null;
    if (hv.seg) {
      for (const { panel } of panels) {
        if (panel.hit(hv.x, hv.y)) return panel.describe(hv.seg);
      }
      return null;
    }
    const it = hv.item;
    if (!it) return null;
    if (it.kind === "memory" && memSamples) {
      const fp = footprintAt(memSamples, hv.t);
      return {
        title: fmtTime(hv.t),
        rows: [["Footprint", fp ? `${fmtMem(fp.mb)}${fp.interpolated ? " (interpolated)" : ""}` : "not sampled"]],
      };
    }
    if (it.kind === "class" && it.cls) {
      const iv = intervals(it.cls);
      const slack = (1.5 / layout.plotW) * span();
      const i = intervalAt(iv, hv.t, slack);
      if (i < 0) return null;
      return {
        title: CLASS_LABEL[it.cls],
        rows: [
          ["Time", `${fmtSecPrecise(iv.a[i])} – ${fmtSecPrecise(iv.b[i])} · ${fmtTime(iv.b[i] - iv.a[i])}`],
          ["Samples", fmtCount(iv.samples[i])],
          ["Lane total", classShare(it.cls).text],
        ],
        hint: it.cls === "io" ? `Includes ${IO_CATEGORIES.join("; ")}` : undefined,
      };
    }
    if (it.kind === "lane" && !it.expanded && it.lane !== undefined) {
      const run = tl.runAt(it.lane, hv.t);
      if (run < 0) return { title: tl.threads[it.lane]?.label ?? "thread", rows: [["At", fmtTime(hv.t)]], hint: "Not sampled here · click the lane name to expand it" };
      const leafDepth = (() => {
        let d = 0;
        while (tl.frameAt(tl.stack[run], d + 1)) d++;
        return d;
      })();
      const leaf = tl.frameAt(tl.stack[run], leafDepth);
      if (!leaf) return null;
      return {
        kind: "LEAF FRAME",
        title: frameNameOf(leaf),
        rows: [
          ["Location", frameLocation(leaf)],
          ["Thread", threadText(tl.threads[it.lane])],
          ["Run", `${fmtSecPrecise(tl.t0[run])} – ${fmtSecPrecise(tl.t1[run])}`],
          ["Samples", fmtCount(tl.count[run])],
        ],
        hint: "Click the lane name to expand it",
      };
    }
    return null;
  }

  function updateHover(x: number, y: number, clientX: number, clientY: number): void {
    if (!layout) return;
    const inPlot = x >= layout.plotX && x <= layout.plotX + layout.plotW && y >= AXIS_H;
    if (!inPlot) {
      clearHover();
      return;
    }
    const seg = hitSeg(x, y);
    const prevSeg = hover?.seg ?? null;
    hover = { x, y, t: tOf(x), seg, item: itemAt(y) };
    drawOverlay();
    const content = tooltipFor(hover);
    if (content) {
      ctx.tooltip.show({ x: clientX, y: clientY }, content);
    } else hideTip();
    const sameSeg = prevSeg && seg && prevSeg.lane === seg.lane && prevSeg.depth === seg.depth && prevSeg.idx === seg.idx;
    if (!sameSeg) {
      const t = targetOf(seg);
      if (t || emittedHover) {
        ctx.bus.emit("hover:line", { target: t, source: "timeline" });
        emittedHover = t !== null;
      }
    }
    cv.style.cursor = seg && seg.frame.kind === "py" ? "pointer" : "crosshair";
  }

  function clearHover(): void {
    if (!hover) return;
    hover = null;
    drawOverlay();
    hideTip();
    if (emittedHover) {
      ctx.bus.emit("hover:line", { target: null, source: "timeline" });
      emittedHover = false;
    }
  }

  function hideTip(): void {
    ctx.tooltip.hide();
  }

  // ── Pointer ──
  let drag: { x: number; y: number; t: number; moved: boolean; id: number; type: string } | null = null;
  let lastPointer = "mouse";
  const rel = (ev: MouseEvent) => {
    const r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  dispose.add(on(cv, "pointerdown", (ev) => {
    if (!layout || ev.button !== 0) return;
    keyboard = false;
    const { x, y } = rel(ev);
    if (x < layout.plotX || y < AXIS_H) return;
    lastPointer = ev.pointerType || "mouse";
    drag = { x, y, t: tOf(x), moved: false, id: ev.pointerId, type: lastPointer };
    try {
      cv.setPointerCapture(ev.pointerId);
    } catch {
      // Synthetic events may not have an active pointer.
    }
  }));
  dispose.add(on(cv, "pointermove", (ev) => {
    const { x, y } = rel(ev);
    if (drag && layout) {
      if (!drag.moved && !isClick(drag.x, drag.y, x, y)) drag.moved = true;
      if (drag.moved) {
        const xc = clamp(x, layout.plotX, layout.plotX + layout.plotW);
        brush = [drag.t, tOf(xc)];
        hover = { x: xc, y, t: tOf(xc), seg: null, item: null };
        hideTip();
        drawOverlay();
        return;
      }
    }
    if (isTouchPointer(ev.pointerType)) return; // no hover on touch: a tap selects instead
    updateHover(x, y, ev.clientX, ev.clientY);
  }));
  dispose.add(on(cv, "pointerup", (ev) => {
    if (!drag || !layout) return;
    const d = drag;
    drag = null;
    const { x, y } = rel(ev);
    if (d.moved && brush) {
      const a = Math.min(brush[0], brush[1]);
      const b = Math.max(brush[0], brush[1]);
      brush = null;
      if (Math.abs(xOf(b) - xOf(a)) >= 4) setDomain([a, b], true);
      else drawOverlay();
      return;
    }
    brush = null;
    if (isClick(d.x, d.y, x, y) && isTouchPointer(d.type)) {
      handleTap(x, y);
      return;
    }
    if (isClick(d.x, d.y, x, y)) {
      const seg = hitSeg(x, y);
      if (seg && seg.frame.kind === "py") {
        hideTip();
        void ctx.nav.jumpTo({ file: seg.frame.filename_or_module, line: seg.frame.line }, { source: "timeline" });
      }
    }
  }));
  dispose.add(on(cv, "pointercancel", () => {
    drag = null;
    brush = null;
    drawOverlay();
  }));
  dispose.add(on(cv, "pointerleave", () => {
    if (!drag) clearHover();
  }));
  dispose.add(on(cv, "dblclick", () => {
    if (isTouchPointer(lastPointer)) return; // a double tap is two taps (select, then act); it never resets
    setDomain(null, true);
  }));

  const sameSeg = (a: SegmentRef | null, b: SegmentRef | null) => !!a && !!b && a.lane === b.lane && a.depth === b.depth && a.idx === b.idx;

  /** Touch (round 1, principle 8): first tap pins details + actions, a second tap on the same segment acts. */
  function handleTap(x: number, y: number): void {
    if (!tl || !layout) return;
    const seg = hitSeg(x, y);
    const L = layout;
    const bounds = { w: L.width, h: L.height };
    if (seg) {
      const target = targetOf(seg);
      const zoomSeg = () => {
        const len = seg.t1 - seg.t0;
        setDomain([seg.t0 - len * 0.05, seg.t1 + len * 0.05], true);
      };
      const open = () => {
        if (target) void ctx.nav.jumpTo(target, { source: "timeline" });
      };
      if (sameSeg(seg, tapRef)) {
        tap.hide();
        if (target) open();
        else zoomSeg();
        return;
      }
      tapRef = seg;
      hover = null;
      hideTip();
      drawOverlay();
      const actions: TapAction[] = [];
      if (target) actions.push({ label: "Open line", icon: "code", run: open });
      actions.push({ label: "Zoom to segment", icon: "plus", run: zoomSeg });
      const panel = panels.find((pp) => pp.item.lanes?.includes(seg.lane));
      const rc = segRect(seg) ?? { x, y, w: 1, h: 1 };
      if (panel) tap.show(panel.panel.describe(seg), actions, rc, bounds);
      ctx.announce.polite(announceSegment(tl, seg));
      return;
    }
    tapRef = null;
    drawOverlay();
    const content = tooltipFor({ x, y, t: tOf(x), seg: null, item: itemAt(y) });
    if (content) tap.show(content, [], { x, y: y - 6, w: 1, h: 12 }, bounds);
    else tap.hide();
  }
  const onWheel = (ev: WheelEvent) => {
    if (!layout) return;
    const { x } = rel(ev);
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const notches = wheelPixels(ev, "y") / 100;
      const at = x >= layout.plotX ? tOf(x) : (domain[0] + domain[1]) / 2;
      setDomain(zoomAround(domain, at, Math.pow(WHEEL_NOTCH, notches), tMax, minS()), false);
      return;
    }
    const dx = wheelPixels(ev, "x");
    const dy = wheelPixels(ev, "y");
    if (ev.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      ev.preventDefault();
      const px = ev.shiftKey && Math.abs(dy) > Math.abs(dx) ? dy : dx;
      setDomain(panBy(domain, px / layout.plotW, tMax, minS()), false);
    }
    // A plain vertical wheel scrolls the page (never hijacked).
  };
  cv.addEventListener("wheel", onWheel, { passive: false });
  dispose.add(() => cv.removeEventListener("wheel", onWheel));

  zoomInBtn.addEventListener("click", () => setDomain(zoomAround(domain, (domain[0] + domain[1]) / 2, 1 / KEY_ZOOM, tMax, minS()), true));
  zoomOutBtn.addEventListener("click", () => setDomain(zoomAround(domain, (domain[0] + domain[1]) / 2, KEY_ZOOM, tMax, minS()), true));
  resetBtn.addEventListener("click", () => setDomain(null, true));

  // ── Keyboard (§4.12.3) ──
  function rowHasSegments(r: number): boolean {
    if (!tl || !layout) return false;
    const row = layout.rows[r];
    return row.lanes.some((lane) => (tl as TimelineM).segments(lane).rows[row.depth]?.n > 0);
  }

  /** Segment in keyboard row `r` nearest to time `t` (covering first). */
  function nearestIn(r: number, t: number): SegmentRef | null {
    if (!tl || !layout) return null;
    const row = layout.rows[r];
    let best: SegmentRef | null = null;
    let bestDist = Infinity;
    for (const lane of row.lanes) {
      const segs = tl.segments(lane).rows[row.depth];
      if (!segs || segs.n === 0) continue;
      const i = lowerB(segs.t1, t, segs.n);
      for (const j of [i - 1, i]) {
        if (j < 0 || j >= segs.n) continue;
        const dist = t < segs.t0[j] ? segs.t0[j] - t : t > segs.t1[j] ? t - segs.t1[j] : 0;
        if (dist < bestDist) {
          bestDist = dist;
          best = segmentRef(tl, lane, row.depth, j);
        }
      }
    }
    return best;
  }

  /** Next/previous segment in row `r` after/before `ref` (across lanes for Interleaved). */
  function stepIn(r: number, ref: SegmentRef, dir: 1 | -1): SegmentRef | null {
    if (!tl || !layout) return null;
    const row = layout.rows[r];
    let best: SegmentRef | null = null;
    for (const lane of row.lanes) {
      const segs = tl.segments(lane).rows[row.depth];
      if (!segs || segs.n === 0) continue;
      let j: number;
      if (dir > 0) {
        j = lowerB(segs.t0, ref.t0 + 1e-9, segs.n);
        while (j < segs.n && lane === ref.lane && j <= ref.idx) j++;
        if (j >= segs.n) continue;
        if (!best || segs.t0[j] < best.t0) best = segmentRef(tl, lane, row.depth, j);
      } else {
        j = lowerB(segs.t0, ref.t0 - 1e-9, segs.n) - 1;
        while (j >= 0 && lane === ref.lane && j >= ref.idx) j--;
        if (j < 0) continue;
        if (!best || segs.t0[j] > best.t0) best = segmentRef(tl, lane, row.depth, j);
      }
    }
    return best;
  }

  function setFocus(row: number, ref: SegmentRef, announce = true): void {
    focus = { row, ref };
    // Keep the focused segment visible: pan (same span) when it is outside the domain.
    if (ref.t1 < domain[0] || ref.t0 > domain[1]) {
      const s = span();
      const mid = (ref.t0 + ref.t1) / 2;
      setDomain([mid - s / 2, mid + s / 2], true, KEY_ZOOM_MS, false);
    } else drawOverlay();
    if (announce && tl) {
      window.clearTimeout(announceTimer); // the newest action speaks: the segment, not an older range
      ctx.announce.polite(announceSegment(tl, ref));
    }
    if (canvasFocused && keyboard && tl) {
      const rc = segRect(ref);
      if (rc) {
        const r = cv.getBoundingClientRect();
        const panel = panels.find((pp) => pp.item.lanes?.includes(ref.lane));
        if (panel) ctx.tooltip.show({ x: r.left + rc.x + Math.min(rc.w, 24), y: r.top + rc.y + rc.h }, panel.panel.describe(ref));
      }
    }
  }

  function initialFocus(): void {
    if (!tl || !layout || focus) return;
    const mid = (domain[0] + domain[1]) / 2;
    for (let r = 0; r < layout.rows.length; r++) {
      if (!rowHasSegments(r)) continue;
      const ref = nearestIn(r, mid);
      if (ref) {
        setFocus(r, ref);
        return;
      }
    }
    ctx.announce.polite("No frames in the visible range. Expand a thread lane to walk its frames.");
  }

  dispose.add(on(cv, "focus", () => {
    canvasFocused = true;
    keyboard = cv.matches(":focus-visible");
    if (!keyboard) return;
    if (focus) setFocus(focus.row, focus.ref);
    else initialFocus();
  }));
  dispose.add(on(cv, "blur", () => {
    canvasFocused = false;
    hideTip();
    drawOverlay();
  }));
  dispose.add(on(cv, "keydown", (ev) => {
    if (!tl || !layout || ev.ctrlKey || ev.metaKey) return;
    keyboard = true;
    const key = ev.key;
    const at = hover && hover.x >= layout.plotX ? hover.t : focus ? (focus.ref.t0 + focus.ref.t1) / 2 : (domain[0] + domain[1]) / 2;
    const center = (domain[0] + domain[1]) / 2;
    const zoomAt = hover ? at : focus && focus.ref.t0 <= domain[1] && focus.ref.t1 >= domain[0] ? clamp(at, domain[0], domain[1]) : center;
    let handled = true;
    if (!ev.altKey && (key === "w" || key === "W" || key === "+" || key === "=")) setDomain(zoomAround(domain, zoomAt, 1 / KEY_ZOOM, tMax, minS()), true, KEY_ZOOM_MS);
    else if (!ev.altKey && (key === "s" || key === "S" || key === "-" || key === "_")) setDomain(zoomAround(domain, zoomAt, KEY_ZOOM, tMax, minS()), true, KEY_ZOOM_MS);
    else if ((!ev.altKey && (key === "a" || key === "A")) || (ev.altKey && key === "ArrowLeft")) setDomain(panBy(domain, -0.1, tMax, minS()), true, KEY_ZOOM_MS);
    else if ((!ev.altKey && (key === "d" || key === "D")) || (ev.altKey && key === "ArrowRight")) setDomain(panBy(domain, 0.1, tMax, minS()), true, KEY_ZOOM_MS);
    else if (key === "0") setDomain(null, true);
    else if (key === "Escape") {
      if (span() < tMax - 1e-9) setDomain(null, true);
      else handled = false;
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      if (!focus) initialFocus();
      else {
        const dir = key === "ArrowDown" ? 1 : -1;
        const t = (focus.ref.t0 + focus.ref.t1) / 2;
        for (let r = focus.row + dir; r >= 0 && r < layout.rows.length; r += dir) {
          if (!rowHasSegments(r)) continue;
          const ref = nearestIn(r, t);
          if (ref) {
            setFocus(r, ref);
            break;
          }
        }
      }
    } else if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
      if (!focus) initialFocus();
      else if (key === "Home" || key === "End") {
        const ref = nearestIn(focus.row, key === "Home" ? -Infinity : Infinity);
        if (ref) setFocus(focus.row, ref);
      } else {
        const ref = stepIn(focus.row, focus.ref, key === "ArrowRight" ? 1 : -1);
        if (ref) setFocus(focus.row, ref);
      }
    } else if (key === "Enter") {
      if (!focus) initialFocus();
      else if (ev.shiftKey) {
        const len = focus.ref.t1 - focus.ref.t0;
        setDomain([focus.ref.t0 - len * 0.05, focus.ref.t1 + len * 0.05], true);
      } else if (focus.ref.frame.kind === "py") {
        void ctx.nav.jumpTo({ file: focus.ref.frame.filename_or_module, line: focus.ref.frame.line }, { source: "timeline" });
      } else ctx.announce.polite("Native frames have no source line");
    } else handled = false;
    if (handled) ev.preventDefault();
  }));

  // ── Linking ──
  function buildLineIndex(): Map<string, { lane: number; depth: number; idx: number }[]> {
    const map = new Map<string, { lane: number; depth: number; idx: number }[]>();
    if (!tl) return map;
    for (let lane = 0; lane < tl.threads.length; lane++) {
      const segs = tl.segments(lane);
      segs.rows.forEach((row, depth) => {
        for (let i = 0; i < row.n; i++) {
          const f = tl?.frameAt(row.stack[i], depth);
          if (!f || f.kind !== "py") continue;
          const k = lineKey(f.filename_or_module, f.line);
          const list = map.get(k);
          if (list) list.push({ lane, depth, idx: i });
          else map.set(k, [{ lane, depth, idx: i }]);
        }
      });
    }
    return map;
  }

  function setLinked(target: Target | null): void {
    linkedTarget = target;
    linkedRefs = [];
    if (tl && target && "line" in target) {
      lineIndex ??= buildLineIndex();
      linkedRefs = (lineIndex.get(lineKey(target.file, target.line)) ?? []).slice(0, 4000);
    }
    drawOverlay();
  }

  function focusLine(target: Target): void {
    if (!tl || !layout) return;
    lineIndex ??= buildLineIndex();
    let refs: { lane: number; depth: number; idx: number }[] = [];
    if ("line" in target) refs = lineIndex.get(lineKey(target.file, target.line)) ?? [];
    else {
      const fn = model.fileByName.get(target.file)?.functions.find((f) => f.name === target.fn);
      if (fn) for (const l of fn.members) refs = refs.concat(lineIndex.get(lineKey(target.file, l.no)) ?? []);
    }
    if (refs.length === 0) {
      ctx.toast.show({ kind: "info", text: "This line does not appear in the sampled timeline" });
      return;
    }
    let best = refs[0];
    let bestSamples = -1;
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of refs) {
      const row = tl.segments(r.lane).rows[r.depth];
      const s = row.samples[r.idx];
      if (s > bestSamples) {
        bestSamples = s;
        best = r;
      }
      lo = Math.min(lo, row.t0[r.idx]);
      hi = Math.max(hi, row.t1[r.idx]);
    }
    const th = tl.threads[best.lane];
    if (filter !== null && filter !== best.lane) {
      filter = null;
      store.update((s) => ({ timeline: { ...s.timeline, thread: "all" } }));
    }
    if (view === "lanes" && th) {
      expanded.add(th.label);
      if (best.depth >= capFor()) full.add(th.label);
      persistExpanded();
    } else if (view === "interleaved" && best.depth >= capFor()) full.add("*");
    relayout();
    const pad = (hi - lo) * 0.04;
    if (hi - lo >= 0.9 * tMax) setDomain(null, true, ZOOM_MS, false);
    else setDomain([lo - pad, hi + pad], true, ZOOM_MS, false);
    if ("line" in target) setLinked(target);
    showIn.show(target);
    const rowIdx = layout.rows.findIndex((r) => r.depth === best.depth && r.lanes.includes(best.lane));
    const ref = segmentRef(tl, best.lane, best.depth, best.idx);
    cv.focus({ preventScroll: true });
    keyboard = true;
    if (ref && rowIdx >= 0) setFocus(rowIdx, ref);
  }

  // ── "Show in timeline" caption (round 1): which line the outlines are, Clear, Back to code ──
  const showIn = createShowInCaption({
    host: showInHost,
    model,
    jump: (t) => void ctx.nav.jumpTo(t, { source: "timeline" }),
    onClear: () => {
      setLinked(null);
      cv.focus({ preventScroll: true });
    },
  });

  // ── Store / bus ──
  function applyStore(): void {
    if (!tl) return;
    const s = store.get().timeline;
    const nextView = multi ? s.view : "lanes";
    const nextFilter = laneForFilter(tl, s.thread);
    if (nextView === view && nextFilter === filter) return;
    view = nextView;
    filter = nextFilter;
    viewCtl?.set(view);
    if (threadCtl) threadCtl.set(filterValueFor(tl, filter));
    focus = null;
    relayout();
  }
  dispose.add(store.subscribe((s) => s.timeline.view, () => applyStore()));
  dispose.add(store.subscribe((s) => s.timeline.thread, () => applyStore()));
  dispose.add(
    ctx.bus.on("range:set", ({ range, source, reveal }) => {
      if (source === "timeline" || !range || !reveal) return;
      whenReady(() => setDomain(range, true));
    }),
  );
  dispose.add(
    ctx.bus.on("hover:line", ({ target, source }) => {
      if (source === "timeline") return;
      whenReady(() => setLinked(target ?? (showIn.suppressed() ? null : store.get().selection)));
    }),
  );
  dispose.add(
    store.subscribe((s) => s.selection, (sel) =>
      whenReady(() => {
        showIn.selectionChanged(sel);
        setLinked(store.get().hover ?? sel);
      }),
    ),
  );
  // Theme: repaint now when near the viewport, else when it scrolls into range (§6.1).
  const near = nearViewport(card);
  dispose.add(near.dispose);
  dispose.add(ctx.bus.on("theme:changed", () => near.run(() => {
    drawBase();
    drawOverlay();
  })));
  dispose.add(ctx.bus.on("layout:changed", () => relayout()));
  let observedW = -1;
  dispose.add(
    observeSize(card, (w) => {
      if (w === observedW) return;
      observedW = w;
      relayout();
    }),
  );

  const legendDispose = createDisposer();
  dispose.add(() => legendDispose.dispose());
  function renderLegend(): void {
    if (!tl) return;
    const anyAwait = tl.awaitLeaf.some((v) => v === 1);
    const kinds = new Set<string>();
    for (let s = 0; s < Math.min(tl.awaitLeaf.length, 4000); s++) {
      for (let d = 0; ; d++) {
        const f = tl.frameAt(s, d);
        if (!f) break;
        kinds.add(frameKindOf(f));
      }
    }
    const chip = (cls: string, label: string) => h("span", { class: "legend-chip" }, h("i", { class: ["legend-sw", cls], "aria-hidden": "true" }), label);
    const items = [chip("sw-py", "Python frame")];
    if (kinds.has("native")) items.push(chip("sw-native", "native frame"));
    if (anyAwait || kinds.has("await")) items.push(chip("sw-await", "await"));
    if (kinds.has("unresolved")) items.push(chip("sw-unresolved", "unresolved"));
    if (kinds.size > 1) {
      // The neutral LOD fallback is decoded here (round 1): a pixel whose sub-pixel frames are of mixed kinds.
      const lod = chip("sw-lod", "mixed short frames");
      legendDispose.add(
        bindTooltip(ctx.tooltip, lod, {
          title: "Mixed short frames",
          hint: "Frames narrower than a pixel take the color of the kind that fills most of that pixel (a blend when two kinds share it); grey marks a pixel of mixed kinds. Zoom in to separate them.",
        }),
      );
      items.push(lod);
    }
    items.push(chip("sw-gc", "GC"), chip("sw-io", "I/O & waits"), chip("sw-gil", "GIL"));
    legend.replaceChildren(...items);
  }

  /**
   * Build every other lane's merged segments ahead of use, one lane per idle period, each in
   * ≤ 8 ms slices (§6.1.2), so no later draw pays for them and no single task gets long.
   */
  function prebuildSegments(t: TimelineM): void {
    let lane = 0;
    const step = () => {
      if (destroyed || lane >= t.threads.length) return;
      const l = lane++;
      void t.segmentsSliced(l).then(() => {
        if (destroyed) return;
        prewarmLane(t, l);
        cancelIdle = idle(step);
      });
    };
    let cancelIdle = idle(step);
    dispose.add(() => cancelIdle());
  }

  function whenReady(fn: () => void): void {
    if (tl && layout) fn();
    else pending.push(fn);
  }

  const api: TimelineApi = {
    focusLine: (target) => whenReady(() => focusLine(target)),
    setDomain: (r, animate) => whenReady(() => setDomain(r, animate)),
  };
  ctx.registerApi("timeline", api);
  // Test hook for the browser checks (geometry and the registered API).
  Object.defineProperty(chart, "__timeline", {
    configurable: true,
    value: {
      api,
      domain: () => domain.slice(),
      layout: () => layout,
      filter: () => filter,
      view: () => view,
      focus: () => (focus ? { row: focus.row, lane: focus.ref.lane, depth: focus.ref.depth, idx: focus.ref.idx, t0: focus.ref.t0, t1: focus.ref.t1 } : null),
      segRect: (lane: number, depth: number, idx: number) => segRect({ lane, depth, idx }),
      segments: (lane: number, depth: number) => {
        const r = tl?.segments(lane).rows[depth];
        return r ? { n: r.n, t0: Array.from(r.t0.slice(0, 50)), t1: Array.from(r.t1.slice(0, 50)) } : null;
      },
      runs: (lane: number, k: number) => {
        if (!tl) return null;
        const idx = tl.byThread[lane];
        return Array.from(idx.slice(0, k)).map((i) => ({ t0: tl?.t0[i], t1: tl?.t1[i], count: tl?.count[i] }));
      },
    },
  });

  // Reveal (M18) when the chart first enters the viewport.
  dispose.add(
    ctx.motion.revealOnce(card, () => {
      if (revealStart !== null) return;
      revealStart = instant() ? -1 : performance.now();
      drawBase();
    }),
  );

  void model.timeline().then(async (t) => {
    if (destroyed) return;
    if (!t) {
      tl = t;
      placeholder.remove();
      card.append(h("p", { class: "flame-empty" }, "No timeline samples in this profile."));
      return;
    }
    // The lanes of the first draw need their merged segments: build them in slices (a lazy
    // derivation, outside the measured base draw; the main lane of huge.json is ~40 ms of work).
    const savedThread = laneForFilter(t, store.get().timeline.thread);
    const savedExpanded = store.get().timeline.expanded;
    const defaultLane = t.threads.find((x) => x.main) ?? t.threads[0];
    const firstLanes = t.threads
      .filter((x) => t.threads.length === 1 || savedThread === x.idx || (savedExpanded.length === 0 ? x === defaultLane : savedExpanded.includes(x.label)))
      .map((x) => x.idx);
    await Promise.all(firstLanes.map((lane) => t.segmentsSliced(lane)));
    if (destroyed) return;
    tl = t;
    placeholder.remove();
    chart.hidden = false;
    filter = laneForFilter(t, store.get().timeline.thread);
    if (threadCtl) threadCtl.set(filterValueFor(t, filter));
    const saved = store.get().timeline.expanded;
    if (saved.length === 0) {
      const main = t.threads.find((x) => x.main) ?? t.threads[0];
      if (main) expanded.add(main.label);
    } else {
      for (const k of saved) {
        if (k.endsWith("#all")) full.add(k.slice(0, -4));
        else expanded.add(k);
      }
    }
    renderLegend();
    // Segments of the expanded lanes are built (above); add their kind codes. Every other lane
    // is built in idle slices.
    for (const x of t.threads) if (expanded.has(x.label) || filter === x.idx || t.threads.length === 1) prewarmLane(t, x.idx);
    relayout();
    while (pending.length) (pending.shift() as () => void)();
    prebuildSegments(t);
    if (linkedTarget === null) setLinked(store.get().hover ?? store.get().selection);
  });

  return {
    api,
    destroy() {
      destroyed = true;
      window.clearTimeout(persistTimer);
      if (revealFrame) cancelAnimationFrame(revealFrame);
      dispose.dispose();
      hideTip();
      viewCtl?.destroy();
      pair.destroy();
      host.replaceChildren();
    },
  };
}

function lowerB(a: Float64Array, v: number, n: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (ev: HTMLElementEventMap[K]) => void): () => void {
  target.addEventListener(type, fn as EventListener);
  return () => target.removeEventListener(type, fn as EventListener);
}

// Exposed for unit tests (pure helpers re-exported from the layout module).
export { computeLayout, classIntervals, laneForFilter, segmentAt };
