/**
 * Icicle flame graph on a canvas pair (DESIGN.md §4.11): base = frames,
 * overlay = hover / search / linked outlines. Click zooms (M11), lateral
 * jumps are staged (M12), the DOM axis re-bases to the focused frame, the
 * keyboard walk moves a DOM focus box (`.flame-segment.flame-focus`) and
 * announces every frame. One instance serves both tabs (CPU / Memory).
 */

import { createCanvasPair, monoFont, nearViewport, observeSize, setFont, uiFont, type CanvasPair } from "../../core/canvas";
import { createDisposer, h } from "../../core/dom";
import { EASE } from "../../core/motion";
import type { Target } from "../../core/store";
import { fileColorIndex, isDescendant, selfRampStep, type FlameNode, type FlameNodeKind, type FlameSearch, type FlameTree } from "../../model/stacks";
import { hasSource, type SourceLookup } from "../../model/source";
import type { ViewContext } from "../app";
import {
  announceText,
  axisCaption,
  axisValues,
  axisWeight,
  domainOf,
  frameTooltip,
  lerpDomain,
  rootLabel,
  walk,
  zoomAnnouncement,
  zoomPlan,
  type TreeKind,
} from "./flamemodel";
import { createTapCard, isTouchPointer } from "./details";
import {
  fitChars,
  fitModeFor,
  framePalette,
  frameLabelText,
  isClick,
  monoCharWidth,
  renderAxisLabels,
  renderGridLines,
  strokeHighlight,
  type ColorMode,
  type FramePalette,
} from "./shared";

const ZOOM_MS = 280;
const DIM_MS = 90;
const REVEAL_ROW_MS = 220;
const REVEAL_STAGGER = 14;
const REVEAL_CAP = 600;
const LABEL_MIN_PX = 40;
const MAX_ROWS_UNSCROLLED = 60;

export interface FlameChartOptions {
  ctx: ViewContext;
  sourceLookup: SourceLookup;
  /** Visually hidden help text id for `aria-describedby`. */
  helpId: string;
  /** The zoom target changed (crumbs, reset button, store). */
  onZoom(kind: TreeKind, node: FlameNode): void;
}

export interface FlameChart {
  el: HTMLElement;
  show(kind: TreeKind, tree: FlameTree, opts: { zoom: FlameNode | null; color: ColorMode }): void;
  /** `announce` (default true): say the new zoom root politely once the tween settles. */
  zoomTo(node: FlameNode, animate?: boolean, announce?: boolean): void;
  zoomOut(): boolean;
  setFocus(node: FlameNode, opts?: { announce?: boolean; tooltip?: boolean; visible?: boolean }): void;
  focusCanvas(): void;
  setSearch(result: FlameSearch | null): void;
  setColor(mode: ColorMode): void;
  setKindOutline(kind: FlameNodeKind | null): void;
  setLinked(target: Target | null): void;
  reveal(): void;
  relayout(): void;
  redraw(): void;
  zoomNode(): FlameNode | null;
  focusNode(): FlameNode | null;
  tree(): FlameTree | null;
  destroy(): void;
}

function rowHeightFor(ctx: ViewContext): number {
  const l = ctx.store.get().layout;
  if (l.short) return 18;
  if (l.bp === "xs" || l.coarse) return 22;
  return 20;
}

export function createFlameChart(o: FlameChartOptions): FlameChart {
  const { ctx } = o;
  const theme = ctx.theme;
  const perf = ctx.host.flags.perf;
  const dispose = createDisposer();

  // ── DOM ──
  const caption = h("span", { class: "flame-axis-caption" });
  const axis = h("div", { class: "flame-axis", "aria-hidden": "true" }, caption);
  const grid = h("div", { class: "flame-gridlines", "aria-hidden": "true" });
  const focusBox = h("div", { class: "flame-segment flame-focus", "aria-hidden": "true", hidden: true });
  const body = h("div", { class: "flame-body" }, grid);
  const pair: CanvasPair = createCanvasPair(body, { interactive: true });
  body.append(focusBox);
  const scroller = h("div", { class: "flame-scroll" }, body);
  const el = h("div", { class: "flame-plot" }, axis, scroller);
  // Touch: the first tap selects a frame and pins its details here (round 1, principle 8).
  let tapSel: FlameNode | null = null;
  const tap = createTapCard(() => {
    tapSel = null;
    forcedFocus = false;
    placeFocusBox();
  });
  el.append(tap.el);
  const cv = pair.overlay;
  cv.tabIndex = 0;
  cv.setAttribute("role", "application");
  cv.setAttribute("aria-roledescription", "flame graph");
  cv.setAttribute("aria-describedby", o.helpId);
  cv.classList.add("flame-canvas");

  // ── State ──
  let kind: TreeKind = "cpu";
  let tree: FlameTree | null = null;
  let zoom: FlameNode | null = null; // target of the current zoom
  let axisFocus: FlameNode | null = null; // frame the axis is re-based to (the current stage)
  let domain: [number, number] = [0, 1];
  let focus: FlameNode | null = null;
  let hover: FlameNode | null = null;
  let color: ColorMode = "kind";
  let search: FlameSearch | null = null;
  let matchMask: Uint8Array | null = null;
  let dimT = 0; // search dimming progress (0 → 1 in 90 ms)
  let kindOutline: FlameNodeKind | null = null;
  let linked: FlameNode[] = [];
  let linkedTarget: Target | null = null;
  let fileIdx: Int8Array | null = null;
  let rowH = rowHeightFor(ctx);
  let width = 0;
  let height = 0;
  let revealStart: number | null = null; // null = not revealed yet; -1 = done
  let revealFrame = 0;
  let canvasFocused = false;
  let forcedFocus = false; // match cycling shows the focus box without moving DOM focus
  let keyboard = false; // focus came from the keyboard (focus-visible): show the focus box
  let emittedHover = false;
  const measureCache = new Map<string, number>();

  const instant = () => ctx.motion.reduced || ctx.host.flags.still;
  if (instant()) revealStart = -1;

  const labelFor = (n: FlameNode) => (n.kind === "root" ? rootLabel(kind, tree as FlameTree) : frameLabelText(n.kind, n.name, n.line));

  // ── Geometry ──
  const xOf = (w: number) => ((w - domain[0]) / (domain[1] - domain[0])) * width;
  const rowsShown = () => (tree ? tree.maxDepth + 1 : 0);

  const relayout = () => {
    rowH = rowHeightFor(ctx);
    width = Math.max(1, Math.floor(scroller.clientWidth));
    height = rowsShown() * rowH + 4;
    body.style.height = `${height}px`;
    const rows = rowsShown();
    scroller.classList.toggle("is-scrolling", rows > MAX_ROWS_UNSCROLLED);
    scroller.style.maxHeight = rows > MAX_ROWS_UNSCROLLED ? `${MAX_ROWS_UNSCROLLED * rowH}px` : "";
    pair.resize(width, height);
    measureCache.clear();
    drawBase();
    drawOverlay();
  };

  // ── Axis (DOM, re-based to the focused frame) ──
  const measureCaption = (s: string): number => {
    let w = measureCache.get(s);
    if (w === undefined) {
      const c = pair.o;
      c.save();
      setFont(c, uiFont(theme, 12, 400));
      w = c.measureText(s).width;
      c.restore();
      measureCache.set(s, w);
    }
    return w;
  };

  const drawAxis = () => {
    if (!tree || !axisFocus) return;
    const f = axisFocus;
    const vals = axisValues(kind, f, width);
    const ticks = vals.map((v) => ({ x: xOf(axisWeight(f, v.frac)), label: v.label }));
    const cap = axisCaption(kind, zoom ?? f, tree, width < 560);
    if (caption.textContent !== cap) caption.textContent = cap;
    const capW = Math.ceil(measureCaption(cap)) + 16;
    // Fixed nested strides anchored at 0 % + a 90 ms fade: the zoom tween never shows
    // irregular label sets (round 1, flame-axis-thinning-flicker).
    renderAxisLabels(axis, ticks, width, measureCaption, capW, { stride: true, fade: !instant() });
    renderGridLines(
      grid,
      ticks.map((t) => t.x),
      width,
    );
  };

  // ── Base draw ──
  function revealProgress(depth: number, now: number): number {
    if (revealStart === -1) return 1;
    if (revealStart === null) return 0;
    const rows = rowsShown();
    const stagger = Math.min(REVEAL_STAGGER, (REVEAL_CAP - REVEAL_ROW_MS) / Math.max(1, rows - 1));
    const p = (now - revealStart - stagger * depth) / REVEAL_ROW_MS;
    return p <= 0 ? 0 : p >= 1 ? 1 : EASE.out(p);
  }

  function fillOf(p: FramePalette, n: FlameNode): { fill: string; ink: string; pattern: CanvasPattern | null } {
    if (n.kind === "root") return { fill: p.fill.root, ink: p.ink.root, pattern: null };
    if (color === "file") {
      const fi = fileIdx as Int8Array;
      let idx = fi[n.id];
      if (idx < 0) idx = fi[n.id] = fileColorIndex(n.file);
      return { fill: p.file[idx], ink: p.fileInk, pattern: null };
    }
    if (color === "self") {
      const s = selfRampStep(n.self, (tree as FlameTree).maxSelf);
      return { fill: p.ramp[kind][s], ink: p.rampInk[kind][s], pattern: null };
    }
    return {
      fill: p.fill[n.kind],
      ink: p.ink[n.kind],
      pattern: n.kind === "await" ? p.awaitLines : n.kind === "unresolved" ? p.unresolvedLines : null,
    };
  }

  function drawBase(): void {
    const t0 = performance.now();
    const b = pair.b;
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, pair.base.width, pair.base.height);
    b.restore();
    if (!tree || width <= 1) return;
    drawAxis();
    const p = framePalette(theme);
    const now = performance.now();
    const [d0, d1] = domain;
    const k = width / (d1 - d0);
    const zoomDepth = zoom ? zoom.depth : 0;
    const mono = monoFont(theme, rowH >= 20 ? 12 : 11);
    const rootFont = uiFont(theme, 12, 500);
    setFont(b, mono);
    const cw = monoCharWidth(b, mono);
    b.textBaseline = "middle";
    b.textAlign = "left";
    const searching = matchMask !== null && dimT > 0;
    let pending = false;
    for (let d = 0; d < tree.byDepth.length; d++) {
      const rp = revealProgress(d, now);
      if (rp < 1) pending = true;
      if (rp <= 0) continue;
      const row = tree.byDepth[d];
      const y = d * rowH;
      const hh = (rowH - 1) * rp;
      b.globalAlpha = rp;
      // First node with x1 > d0 (rows are sorted and disjoint).
      let lo = 0;
      let hi = row.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (row[mid].x1 <= d0) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < row.length; i++) {
        const n = row[i];
        if (n.x0 >= d1) break;
        const x = (n.x0 - d0) * k;
        const x2 = (n.x1 - d0) * k;
        const w = x2 - x;
        if (w < 0.5) continue;
        const xl = x < -1 ? -1 : x;
        const xr = x2 > width + 1 ? width + 1 : x2;
        const ww = xr - xl - (w >= 2 ? 1 : 0);
        if (ww <= 0) continue;
        const st = fillOf(p, n);
        const ancestor = d < zoomDepth;
        const nonMatch = searching && (matchMask as Uint8Array)[n.id] === 0;
        let ink = st.ink;
        if (ancestor) {
          b.fillStyle = p.dim(st.fill);
          b.fillRect(xl, y, ww, hh);
          ink = p.dimInk;
        } else {
          b.fillStyle = st.fill;
          b.fillRect(xl, y, ww, hh);
          if (st.pattern) {
            b.fillStyle = st.pattern;
            b.fillRect(xl, y, ww, hh);
          }
          if (nonMatch) {
            const a = b.globalAlpha;
            b.globalAlpha = a * dimT;
            b.fillStyle = p.dim(st.fill);
            b.fillRect(xl, y, ww, hh);
            b.globalAlpha = a;
            if (dimT > 0.5) ink = p.dimInk;
          }
        }
        if (w >= LABEL_MIN_PX && rp > 0.6) {
          const left = Math.max(xl, 0) + 5;
          const avail = Math.min(xr, width) - left - 5;
          if (avail >= cw * 2) {
            if (n.kind === "root") {
              setFont(b, rootFont);
              b.fillStyle = ink;
              b.fillText(labelFor(n), left, y + hh / 2 + 0.5, avail);
              setFont(b, mono);
            } else {
              const text = fitChars(labelFor(n), avail / cw, fitModeFor(n.kind));
              if (text) {
                b.fillStyle = ink;
                b.fillText(text, left, y + hh / 2 + 0.5);
              }
            }
          }
        }
      }
    }
    b.globalAlpha = 1;
    if (pending && revealStart !== null && revealStart !== -1) {
      if (!revealFrame) revealFrame = requestAnimationFrame(() => {
        revealFrame = 0;
        drawBase();
      });
    } else if (revealStart !== null && revealStart !== -1 && !pending) {
      revealStart = -1;
    }
    const ms = performance.now() - t0;
    if (perf) mark("scalene:flame-base", t0, ms);
    el.dataset.baseMs = ms.toFixed(2);
  }

  function mark(name: string, start: number, ms: number): void {
    try {
      performance.measure(name, { start, end: start + ms });
    } catch {
      // measure() with options is unavailable in very old engines.
    }
  }

  // ── Overlay ──
  function rectOf(n: FlameNode): { x: number; y: number; w: number; h: number } | null {
    if (!tree) return null;
    const x = xOf(n.x0);
    const x2 = xOf(n.x1);
    if (x2 < 0 || x > width) return null;
    const xl = Math.max(x, 0);
    const xr = Math.min(x2, width);
    return { x: xl, y: n.depth * rowH, w: Math.max(2, xr - xl - (x2 - x >= 2 ? 1 : 0)), h: rowH - 1 };
  }

  function drawOverlay(): void {
    const t0 = performance.now();
    pair.clearOverlay();
    if (!tree) return;
    const c = pair.o;
    const p = framePalette(theme);
    c.save();
    // Search matches, a legend kind, and linked lines: the §3.4 highlight.
    const outline = (n: FlameNode, min: number) => {
      const r = rectOf(n);
      if (!r || xOf(n.x1) - xOf(n.x0) < min) return;
      strokeHighlight(c, p, r.x, r.y, r.w, r.h);
    };
    if (search && search.matches.length > 0) {
      let drawn = 0;
      for (const n of search.matches) {
        if (drawn > 2000) break;
        if (n.x1 <= domain[0] || n.x0 >= domain[1]) continue;
        outline(n, 3);
        drawn++;
      }
    }
    if (kindOutline) {
      for (const row of tree.byDepth) {
        for (const n of row) if (n.kind === kindOutline && n.x1 > domain[0] && n.x0 < domain[1]) outline(n, 3);
      }
    }
    for (const n of linked) outline(n, 0);
    if (hover) {
      const r = rectOf(hover);
      if (r) {
        c.lineWidth = 1.5;
        c.strokeStyle = p.fg;
        c.strokeRect(r.x + 0.75, r.y + 0.75, Math.max(0.5, r.w - 1.5), Math.max(0.5, r.h - 1.5));
      }
    }
    c.restore();
    const ms = performance.now() - t0;
    if (perf) mark("scalene:flame-overlay", t0, ms);
    el.dataset.overlayMs = ms.toFixed(2);
  }

  // ── Focus box (DOM, §4.11.7) ──
  function placeFocusBox(): void {
    const n = focus;
    const r = n ? rectOf(n) : null;
    if (!n || !r || !((canvasFocused && keyboard) || forcedFocus)) {
      focusBox.hidden = true;
      return;
    }
    focusBox.hidden = false;
    focusBox.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`;
    focusBox.style.width = `${Math.max(4, Math.round(r.w))}px`;
    focusBox.style.height = `${r.h}px`;
  }

  // ── Zoom ──
  function applyDomain(d: [number, number]): void {
    domain = d;
    el.dataset.domain = `${d[0]},${d[1]}`;
    drawBase();
    drawOverlay();
    placeFocusBox();
  }

  function zoomTo(node: FlameNode, animate = true, announce = true): void {
    if (!tree) return;
    const from = zoom ?? tree.root;
    const plan = zoomPlan(from, node);
    const out = node !== from && isDescendant(from, node);
    zoom = node;
    el.dataset.zoom = node.path || "root";
    el.dataset.stages = String(plan.length);
    o.onZoom(kind, node);
    tap.hide();
    const run = (i: number) => {
      if (i >= plan.length) {
        // Once the zoom settles, say where it landed (debounced by the polite announcer).
        if (announce && tree && zoom === node) ctx.announce.polite(zoomAnnouncement(kind, node, tree, out));
        return;
      }
      const stage = plan[i];
      axisFocus = stage;
      const a = domain;
      const b = domainOf(stage);
      if (!animate || instant()) {
        applyDomain(b);
        run(i + 1);
        return;
      }
      ctx.motion.tween(
        "flame-zoom",
        ZOOM_MS,
        EASE.standard,
        (t) => applyDomain(lerpDomain(a, b, t)),
        () => run(i + 1),
      );
    };
    run(0);
  }

  function zoomOut(): boolean {
    if (!zoom || !zoom.parent) return false;
    zoomTo(zoom.parent);
    return true;
  }

  // ── Focus and announcements ──
  function setFocus(node: FlameNode, opts: { announce?: boolean; tooltip?: boolean; visible?: boolean } = {}): void {
    focus = node;
    forcedFocus = opts.visible ?? (canvasFocused ? forcedFocus : false);
    placeFocusBox();
    if (!tree) return;
    if (opts.announce) ctx.announce.polite(announceText(kind, node, tree));
    if (opts.tooltip && canvasFocused && keyboard && !focusBox.hidden) {
      showTip(focusBox, node);
    }
  }

  // ── Tooltip ──
  function showTip(at: { x: number; y: number } | Element, n: FlameNode): void {
    if (!tree) return;
    const content = frameTooltip(kind, n, tree, o.sourceLookup, (f) => hasSource(ctx.model, f));
    ctx.tooltip.show(at, content);
  }
  function hideTip(): void {
    ctx.tooltip.hide();
  }

  // ── Hit testing ──
  function hit(ev: PointerEvent | MouseEvent): FlameNode | null {
    if (!tree) return null;
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    // The 1 px row gap counts as the row above, so the hover never flickers.
    const depth = Math.floor(y / rowH);
    const row = tree.byDepth[depth];
    if (!row || x < 0 || x > width) return null;
    const w = domain[0] + (x / width) * (domain[1] - domain[0]);
    let lo = 0;
    let hi = row.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = row[mid];
      if (w < n.x0) hi = mid - 1;
      else if (w >= n.x1) lo = mid + 1;
      else return xOf(n.x1) - xOf(n.x0) >= 0.5 ? n : null;
    }
    return null;
  }

  const targetOf = (n: FlameNode | null): Target | null =>
    n && (n.kind === "py" || n.kind === "await") && n.line !== null && hasSource(ctx.model, n.file) ? { file: n.file, line: n.line } : null;

  function setHover(n: FlameNode | null): void {
    if (n === hover) return;
    hover = n;
    drawOverlay();
    const t = targetOf(n);
    if (t || emittedHover) {
      ctx.bus.emit("hover:line", { target: t, source: "flame" });
      emittedHover = t !== null;
    }
  }

  let down: { x: number; y: number; node: FlameNode | null; type: string } | null = null;
  let lastClickNode: FlameNode | null = null;
  let lastPointer = "mouse";

  /** Touch: select a frame and pin its details with real buttons (round 1, principle 8). */
  function selectTap(n: FlameNode): void {
    if (!tree) return;
    tapSel = n;
    setHover(null);
    hideTip();
    setFocus(n, { visible: true });
    const r = rectOf(n);
    const content = frameTooltip(kind, n, tree, o.sourceLookup, (f) => hasSource(ctx.model, f));
    const actions = [];
    if (n.children.length > 0 || n === zoom) {
      actions.push(
        n === zoom && n.parent
          ? { label: "Zoom out", icon: "minus" as const, run: () => zoomTo(n.parent as FlameNode) }
          : { label: "Zoom in", icon: "plus" as const, run: () => zoomTo(n) },
      );
    }
    if ((n.kind === "py" || n.kind === "await") && n.line !== null && hasSource(ctx.model, n.file)) {
      actions.push({ label: "Open line", icon: "code" as const, run: () => goToSource(n) });
    }
    if (r) {
      const top = scroller.offsetTop - scroller.scrollTop;
      tap.show(content, actions, { x: r.x, y: top + r.y, w: r.w, h: r.h }, { w: el.clientWidth, h: el.clientHeight });
    }
    ctx.announce.polite(announceText(kind, n, tree));
  }

  dispose.add(listen(cv, "pointermove", (ev) => {
    if (isTouchPointer(ev.pointerType)) return; // no hover on touch: a tap selects instead
    const n = hit(ev);
    setHover(n);
    if (n) showTip({ x: ev.clientX, y: ev.clientY }, n);
    else hideTip();
    cv.style.cursor = n ? "pointer" : "default";
  }));
  dispose.add(listen(cv, "pointerleave", () => {
    setHover(null);
    hideTip();
  }));
  dispose.add(listen(cv, "pointerdown", (ev) => {
    lastPointer = ev.pointerType || "mouse";
    if (!isTouchPointer(lastPointer)) forcedFocus = false;
    keyboard = false;
    down = { x: ev.clientX, y: ev.clientY, node: hit(ev), type: lastPointer };
  }));
  dispose.add(listen(cv, "click", (ev) => {
    if (down && isTouchPointer(down.type)) {
      // Touch: first tap selects (details pinned), a second tap on the same frame zooms.
      if (!isClick(down.x, down.y, ev.clientX, ev.clientY)) return;
      const n = down.node;
      if (!n || !tree) {
        tap.hide();
        return;
      }
      if (n !== tapSel) {
        selectTap(n);
        return;
      }
      if (n === zoom && n.parent) zoomTo(n.parent);
      else zoomTo(n);
      setFocus(n, { visible: true });
      return;
    }
    // The frame under the FIRST click of a double-click: the zoom it starts moves the frames,
    // so the second press may sit on another frame. (pointerdown.detail is always 0 in
    // Chromium; click.detail counts.)
    if (ev.detail === 1) lastClickNode = down && isClick(down.x, down.y, ev.clientX, ev.clientY) ? down.node : null;
    if (!down || !isClick(down.x, down.y, ev.clientX, ev.clientY) || ev.detail > 1) return;
    const n = down.node;
    if (!n || !tree) return;
    hideTip();
    if (n === zoom && n.parent) zoomTo(n.parent);
    else zoomTo(n);
    setFocus(n);
  }));
  dispose.add(listen(cv, "dblclick", (ev) => {
    if (isTouchPointer(lastPointer)) return; // a double tap is two taps (select, then zoom)
    const n = lastClickNode ?? hit(ev);
    if (!n) return;
    goToSource(n);
  }));

  function goToSource(n: FlameNode): void {
    if ((n.kind === "py" || n.kind === "await") && n.line !== null) {
      void ctx.nav.jumpTo({ file: n.file, line: n.line }, { source: "flame" });
    }
  }

  dispose.add(listen(cv, "focus", () => {
    canvasFocused = true;
    keyboard = cv.matches(":focus-visible");
    if (!tree || !keyboard) return;
    if (!focus) focus = zoom ?? tree.root;
    setFocus(focus, { announce: true });
  }));
  dispose.add(listen(cv, "blur", () => {
    canvasFocused = false;
    placeFocusBox();
    hideTip();
  }));
  dispose.add(listen(cv, "keydown", (ev) => {
    if (!tree || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (!keyboard) {
      keyboard = true;
      placeFocusBox();
    }
    const cur = focus ?? zoom ?? tree.root;
    const key = ev.key;
    if (key === "Enter" || key === " ") {
      ev.preventDefault();
      // The zoom announces the new root once it settles ("Zoomed into …").
      zoomTo(cur);
      setFocus(cur, { tooltip: true });
      return;
    }
    if (key === "Escape" || key === "Backspace") {
      if (tap.isOpen()) {
        ev.preventDefault();
        tap.hide();
        return;
      }
      if (zoomOut()) {
        ev.preventDefault();
        if (zoom) setFocus(zoom, { tooltip: true });
      }
      return;
    }
    if (key === "g" || key === "G") {
      ev.preventDefault();
      if ((cur.kind === "py" || cur.kind === "await") && cur.line !== null) goToSource(cur);
      else ctx.announce.polite("Native frames have no source line");
      return;
    }
    const next = walk(tree, cur, key, zoom ?? tree.root);
    if (!next) return;
    ev.preventDefault();
    // A walk into frames the zoom hides (e.g. ↓ from an ancestor row) stays visible.
    setFocus(next, { announce: true, tooltip: true });
    setHover(null);
  }));

  // Size and theme.
  dispose.add(observeSize(scroller, () => relayout()));
  // Theme: repaint now when near the viewport, else when it scrolls into range (§6.1).
  const near = nearViewport(scroller);
  dispose.add(near.dispose);
  dispose.add(ctx.bus.on("theme:changed", () => near.run(() => {
    drawBase();
    drawOverlay();
  })));

  function show(k: TreeKind, t: FlameTree, opts: { zoom: FlameNode | null; color: ColorMode }): void {
    ctx.motion.tween("flame-zoom", 0, EASE.linear, () => undefined);
    kind = k;
    tree = t;
    color = opts.color;
    fileIdx = new Int8Array(t.nodes.length).fill(-1);
    zoom = opts.zoom ?? t.root;
    axisFocus = zoom;
    focus = null;
    hover = null;
    search = null;
    matchMask = null;
    dimT = 0;
    linked = [];
    axis.className = k === "cpu" ? "flame-axis" : "memory-axis";
    grid.className = k === "cpu" ? "flame-gridlines" : "memory-gridlines";
    cv.setAttribute("aria-label", k === "cpu" ? "Call stacks flame graph" : "Memory stacks flame graph");
    domain = domainOf(zoom);
    el.dataset.zoom = zoom.path || "root";
    el.dataset.kind = k;
    if (linkedTarget) setLinked(linkedTarget);
    relayout();
  }

  function setSearch(result: FlameSearch | null): void {
    if (!tree) return;
    const had = matchMask !== null;
    search = result && result.query ? result : null;
    if (search) {
      const mask = new Uint8Array(tree.nodes.length);
      for (const n of search.matches) mask[n.id] = 1;
      matchMask = mask;
      if (!had) {
        dimT = 0;
        ctx.motion.tween("flame-dim", DIM_MS, EASE.linear, (t) => {
          dimT = t;
          drawBase();
        });
      } else {
        dimT = 1;
        drawBase();
      }
    } else if (had) {
      ctx.motion.tween(
        "flame-dim",
        DIM_MS,
        EASE.linear,
        (t) => {
          dimT = 1 - t;
          drawBase();
        },
        () => {
          matchMask = null;
          dimT = 0;
          drawBase();
        },
      );
    }
    drawOverlay();
  }

  function setLinked(target: Target | null): void {
    linkedTarget = target;
    linked = [];
    if (tree && target && "line" in target) {
      linked = (tree.byLine.get(`${target.file}\u0000${target.line}`) ?? []).slice(0, 400);
    }
    drawOverlay();
  }

  // Test hook (read-only geometry + zoom driver for the browser checks; no data leaves the page).
  Object.defineProperty(el, "__flame", {
    configurable: true,
    value: {
      domain: () => domain.slice(),
      zoom: () => zoom?.path ?? null,
      focus: () => focus?.path ?? null,
      rowH: () => rowH,
      nodeRect: (path: string) => {
        const n = tree?.byPath.get(path);
        return n ? rectOf(n) : null;
      },
      heaviest: (file: string, line: number) => {
        const list = tree?.byLine.get(`${file}\u0000${line}`) ?? [];
        return list.reduce<FlameNode | null>((a, b) => (!a || b.total > a.total ? b : a), null)?.path ?? null;
      },
      zoomTo: (path: string) => {
        const n = tree?.byPath.get(path);
        if (n) zoomTo(n);
      },
    },
  });

  return {
    el,
    show,
    zoomTo,
    zoomOut,
    setFocus,
    focusCanvas() {
      cv.focus({ preventScroll: true });
      // A deliberate landing ("Show in stacks") shows the focus box like keyboard focus.
      keyboard = true;
      placeFocusBox();
    },
    setSearch,
    setColor(mode) {
      color = mode;
      drawBase();
    },
    setKindOutline(k) {
      kindOutline = k;
      drawOverlay();
    },
    setLinked,
    reveal() {
      if (revealStart !== null) return;
      revealStart = instant() ? -1 : performance.now();
      drawBase();
    },
    relayout,
    redraw() {
      drawBase();
      drawOverlay();
    },
    zoomNode: () => zoom,
    focusNode: () => focus,
    tree: () => tree,
    destroy() {
      if (revealFrame) cancelAnimationFrame(revealFrame);
      dispose.dispose();
      hideTip();
      pair.destroy();
      el.remove();
    },
  };
}

/** addEventListener returning a disposer (typed for the canvas). */
function listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (ev: HTMLElementEventMap[K]) => void): () => void {
  target.addEventListener(type, fn as EventListener);
  return () => target.removeEventListener(type, fn as EventListener);
}
