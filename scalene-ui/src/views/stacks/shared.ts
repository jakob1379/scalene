/**
 * Shared pieces of the canvas views owned by WP4 (flame graph, timeline,
 * memory chart): the stack-frame palette of DESIGN.md §3.4 resolved from
 * tokens, monospace label fitting (O(1) per label, §4.11.9), DOM axis strips
 * with the upstream class names (§4.11.4, §4.12.2), the crosshair time chip
 * and small search helpers. Pure helpers are exported for unit tests.
 */

import { alpha, currentDpr, mixOklab, roundRect, setFont, uiFont } from "../../core/canvas";
import type { ThemeApi } from "../../core/theme";
import type { FlameNodeKind } from "../../model/stacks";
import { simplifyNativeName } from "../../model/stacks";
import type { CombinedFrame } from "../../types";
import { isAwaitFrame } from "../../model/classify";

// ── Binary search ───────────────────────────────────────────────────────────

/** First index i in [lo, hi) with `a[i] >= v` (a sorted ascending). */
export function lowerBound(a: ArrayLike<number>, v: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i with `a[i] > v`. */
export function upperBound(a: ArrayLike<number>, v: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ── Frame kinds and labels ──────────────────────────────────────────────────

/** Kind of a raw timeline/stack frame in the §3.4 vocabulary. */
export function frameKindOf(f: CombinedFrame): FlameNodeKind {
  if (f.kind === "py") return isAwaitFrame(f) ? "await" : "py";
  return f.display_name ? "native" : "unresolved";
}

/** Display name of a raw frame (`0x…` for unresolved native frames). */
export function frameNameOf(f: CombinedFrame): string {
  if (f.display_name) return f.display_name;
  return f.kind === "native" && typeof f.ip === "number" ? `0x${f.ip.toString(16)}` : "??";
}

/** Upper-case kind chip text used in tooltips (§4.11.6). */
export const KIND_CHIP: Record<FlameNodeKind, string> = {
  root: "ALL STACKS",
  py: "PYTHON FRAME",
  native: "NATIVE FRAME",
  await: "AWAIT",
  unresolved: "UNRESOLVED",
};

/** Words used in announcements ("Python frame"). */
export const KIND_WORD: Record<FlameNodeKind, string> = {
  root: "all stacks",
  py: "Python frame",
  native: "native frame",
  await: "await frame",
  unresolved: "unresolved native frame",
};

/**
 * Python function reference as every view writes it: `train()` for an identifier
 * (`Block.forward()` for a qualified name), names like `<module>` / `[await] sleep` as they are.
 */
export function pyFnName(name: string): string {
  return /^[A-Za-z_][\w.]*$/.test(name) ? `${name}()` : name;
}

/**
 * Label text of a frame before fitting: py/await → `train() :173` (function, then
 * its line; never `train:173`, which reads like a file name), native → the
 * simplified C++ name, unresolved → hex ip (already the name).
 */
export function frameLabelText(kind: FlameNodeKind, name: string, line: number | null): string {
  if (kind === "py" || kind === "await") return line !== null && line > 0 ? `${pyFnName(name)} :${line}` : pyFnName(name);
  if (kind === "native") return simplifyNativeName(name);
  return name;
}

const ELLIPSIS = "…";
/** A truncated label keeps at least this many real characters, else it is dropped (fill + tooltip carry it). */
export const MIN_TRUNCATED_CHARS = 6;

/** "" when a truncated label keeps fewer than `MIN_TRUNCATED_CHARS` non-ellipsis characters. */
function keepTruncated(s: string): string {
  let n = 0;
  for (const ch of s) if (ch !== ELLIPSIS) n++;
  return n < MIN_TRUNCATED_CHARS ? "" : s;
}

function middleCut(s: string, n: number): string {
  const keep = n - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return s.slice(0, head) + ELLIPSIS + (tail > 0 ? s.slice(s.length - tail) : "");
}

/** Trailing collapsed groups of a simplified C++ name: `(…)`, `()`, `<…>`, `<>`, ` const` (not `operator()`). */
const TRAILING_GROUP = /(?:\s*const)?\s*(?:\(…\)|<…>|<>|(?<!operator)\(\))\s*$/;

/**
 * Native names: collapse the templates/parameter lists first (they are already `<…>`/`(…)`),
 * then middle-truncate only the identifier part, so a label never shows two ellipses.
 */
function fitNative(s: string, n: number): string {
  let core = s;
  for (let i = 0; i < 8; i++) {
    const next = core.replace(TRAILING_GROUP, "");
    if (next === core || next.length === 0) break;
    core = next;
  }
  if (core.length <= n) return core;
  // Inner collapsed groups (`std::vector<…>::push_back`) carry nothing once space is short.
  const bare = core.replace(/<…>|\(…\)/g, "").replace(/…/g, "");
  if (bare.length <= n) return bare;
  return keepTruncated(middleCut(bare, n));
}

/**
 * Fit `s` into `maxChars` monospace cells. `end` keeps the head, `middle`
 * (native names) drops collapsed `(…)`/`<…>` groups, then keeps a balanced
 * head and tail of the identifier; py labels (`train() :173`) drop the ` :line`
 * suffix, then the `()`, before truncating the name. A label is never more
 * than one ellipsis, and a truncated label keeping fewer than 6 real
 * characters is dropped (""), the same for hex ips. "" when not even 2 cells fit.
 */
export function fitChars(s: string, maxChars: number, mode: "end" | "middle" | "py"): string {
  const n = Math.floor(maxChars);
  if (s.length <= n) return s;
  if (n < 2) return "";
  if (mode === "py") {
    const m = /^(.*?)(\(\))?\s?:\d+$/.exec(s) ?? /^(.*?)(\(\))$/.exec(s);
    if (m && m[1]) {
      const name = m[1];
      const call = name + (m[2] ?? "");
      if (call.length <= n) return call;
      if (name.length <= n) return name;
      return keepTruncated(name.slice(0, n - 1) + ELLIPSIS);
    }
    return keepTruncated(s.slice(0, n - 1) + ELLIPSIS);
  }
  if (mode === "end") return keepTruncated(s.slice(0, n - 1) + ELLIPSIS);
  return fitNative(s, n);
}

/** Fitting mode per kind. */
export function fitModeFor(kind: FlameNodeKind): "end" | "middle" | "py" {
  return kind === "py" || kind === "await" ? "py" : kind === "native" ? "middle" : "end";
}

// ── Monospace metrics (one measure per font) ────────────────────────────────

const charWidthCache = new Map<string, number>();

/** Advance width of one monospace cell for `font` (cached). */
export function monoCharWidth(ctx: CanvasRenderingContext2D, font: string): number {
  let w = charWidthCache.get(font);
  if (w === undefined) {
    ctx.save();
    setFont(ctx, font);
    w = ctx.measureText("MMMMMMMMMM").width / 10 || 7;
    ctx.restore();
    charWidthCache.set(font, w);
  }
  return w;
}

// ── Palette (§3.4) ──────────────────────────────────────────────────────────

export type ColorMode = "kind" | "file" | "self";

export interface FramePalette {
  key: string;
  fill: Record<FlameNodeKind, string>;
  ink: Record<FlameNodeKind, string>;
  file: string[];
  fileInk: string;
  ramp: { cpu: string[]; memory: string[] };
  rampInk: { cpu: string[]; memory: string[] };
  /** Dimmed label colour (search non-match / ancestors). */
  dimInk: string;
  lod: string;
  surface: string;
  focus: string;
  fg: string;
  fg2: string;
  fg3: string;
  grid: string;
  gridStrong: string;
  sunken: string;
  /** Mix toward `--surface` by `--frame-dim` in OKLab (cached per colour). */
  dim(fill: string): string;
  /** 50/50 OKLab mix of two fills (cached): a LOD column shared by two frame kinds. */
  mix(a: string, b: string): string;
  /** `--async` 135° lines on transparent (await frames). */
  awaitLines: CanvasPattern | null;
  /** `--cpu-sys` 45° lines at 30 % (unresolved native frames). */
  unresolvedLines: CanvasPattern | null;
  threads: string[];
}

const lineCache = new Map<string, CanvasPattern>();

/** Device-pixel ratio (1 outside a browser, e.g. in unit tests). */
const dprNow = (): number => (typeof window === "undefined" ? 1 : currentDpr());

/** Lines-only hatch pattern (transparent background), cached per colour/dpr. */
export function linePattern(color: string, period: number, angle: 45 | 135, width: number): CanvasPattern | null {
  const dpr = dprNow();
  const key = `${color}|${period}|${angle}|${width}|${dpr}`;
  const hit = lineCache.get(key);
  if (hit) return hit;
  if (typeof document === "undefined") return null;
  const size = period * 2;
  const tile = document.createElement("canvas");
  tile.width = tile.height = Math.round(size * dpr);
  const x = tile.getContext("2d");
  if (!x) return null;
  x.scale(dpr, dpr);
  x.strokeStyle = color;
  x.lineWidth = width;
  x.lineCap = "square";
  x.beginPath();
  for (let c = -size; c <= 2 * size; c += period) {
    if (angle === 45) {
      x.moveTo(c, 0);
      x.lineTo(c - size, size);
    } else {
      x.moveTo(c, 0);
      x.lineTo(c + size, size);
    }
  }
  x.stroke();
  const p = x.createPattern(tile, "repeat");
  if (!p) return null;
  if (typeof DOMMatrix === "function") p.setTransform(new DOMMatrix().scale(1 / dpr));
  if (lineCache.size > 48) lineCache.clear();
  lineCache.set(key, p);
  return p;
}

let paletteCache: FramePalette | null = null;

/** The frame palette for the current theme (rebuilt when tokens change). */
export function framePalette(theme: ThemeApi): FramePalette {
  const t = theme.tokens();
  const key = `${theme.current()}|${t["frame-py"]}|${t["surface"]}|${t["frame-dim"]}|${dprNow()}`;
  if (paletteCache && paletteCache.key === key) return paletteCache;
  const surface = t["surface"];
  const dimBy = theme.num("frame-dim") || 0.78;
  const dimCache = new Map<string, string>();
  const mixCache = new Map<string, string>();
  const onStrong = t["on-strong"];
  const rampInk = (kind: "cpu" | "mem"): string[] => {
    const split = theme.num(`${kind}-ramp-ink-split`) || 4;
    return Array.from({ length: 6 }, (_, i) => (i < split ? t["fg"] : onStrong));
  };
  paletteCache = {
    key,
    fill: {
      root: t["frame-root"],
      py: t["frame-py"],
      native: t["frame-native"],
      await: t["frame-await"],
      unresolved: t["frame-unresolved"],
    },
    ink: {
      root: t["frame-root-ink"],
      py: t["frame-py-ink"],
      native: t["frame-native-ink"],
      await: t["frame-await-ink"],
      unresolved: t["frame-unresolved-ink"],
    },
    file: Array.from({ length: 8 }, (_, i) => t[`file-${i}`]),
    fileInk: t["fg"],
    ramp: {
      cpu: Array.from({ length: 6 }, (_, i) => t[`cpu-ramp-${i}`]),
      memory: Array.from({ length: 6 }, (_, i) => t[`mem-ramp-${i}`]),
    },
    rampInk: { cpu: rampInk("cpu"), memory: rampInk("mem") },
    dimInk: t["fg-3"],
    lod: t["frame-lod"],
    surface,
    focus: t["focus"],
    fg: t["fg"],
    fg2: t["fg-2"],
    fg3: t["fg-3"],
    grid: t["grid"],
    gridStrong: t["grid-strong"],
    sunken: t["sunken"],
    dim(fill: string): string {
      let d = dimCache.get(fill);
      if (d === undefined) {
        d = mixOklab(fill, surface, dimBy);
        dimCache.set(fill, d);
      }
      return d;
    },
    mix(a: string, b: string): string {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      let m = mixCache.get(k);
      if (m === undefined) {
        m = mixOklab(a, b, 0.5);
        mixCache.set(k, m);
      }
      return m;
    },
    awaitLines: linePattern(alpha(t["async"], 0.55), 5, 135, 1),
    unresolvedLines: linePattern(alpha(t["cpu-sys"], 0.3), 4, 45, 1.25),
    threads: [t["thread-0"], t["thread-1"], t["thread-2"], t["thread-3"], t["thread-4"], t["thread-other"]],
  };
  return paletteCache;
}

/** `--thread-k` slot of a lane index (5 slots, then "other"; never cycles back). */
export function threadSlot(laneIdx: number): number {
  return laneIdx >= 0 && laneIdx < 5 ? laneIdx : 5;
}

// ── LOD columns (§3.4, amended in round 1) ─────────────────────────────────

/** Share of a pixel's time one kind must cover to paint the column in its own fill. */
export const LOD_DOMINANT = 0.6;
/** Share the two largest kinds must cover together for a 50/50 mix (else `--frame-lod`). */
export const LOD_PAIR = 0.8;

/**
 * Colour rule for a sub-pixel LOD column from the time each frame kind covers in it
 * (`w[k]`, k = index into the kind list): `[k, -1]` when kind k covers ≥ 60 % (its fill),
 * `[k1, k2]` when the two largest cover ≥ 80 % (50/50 OKLab mix), `[-1, -1]` otherwise
 * (`--frame-lod`, the "mixed short frames" fallback the legend explains).
 */
export function lodPick(w: ArrayLike<number>): [number, number] {
  let total = 0;
  let a = -1;
  let b = -1;
  for (let k = 0; k < w.length; k++) {
    const v = w[k];
    if (!(v > 0)) continue;
    total += v;
    if (a < 0 || v > w[a]) {
      b = a;
      a = k;
    } else if (b < 0 || v > w[b]) b = k;
  }
  if (a < 0 || !(total > 0)) return [-1, -1];
  if (w[a] >= LOD_DOMINANT * total) return [a, -1];
  if (b >= 0 && w[a] + w[b] >= LOD_PAIR * total) return [a, b];
  return [-1, -1];
}

// ── DOM axis strips (class names are part of the upstream contract, §7.5) ──

export interface AxisTick {
  /** CSS px from the strip's left edge. */
  x: number;
  label: string;
}

export interface AxisLabelOptions {
  /**
   * Thin labels by a fixed stride of nice ticks anchored at the first tick (every 1st, 2nd,
   * 10th, 20th … — each stride divides the next, so a zoom only ever adds or removes whole
   * subsets), chosen from the current tick spacing. Without it, overlapping labels are
   * hidden greedily left to right.
   */
  stride?: boolean;
  /** Fade labels in/out over 90 ms when the shown set changes (never during reduced motion). */
  fade?: boolean;
}

/** Nested label strides: each divides the next (§4.11.4 zoom tween, round 1). */
export const LABEL_STRIDES: readonly number[] = [1, 2, 10, 20, 100, 200, 1000];

/** Smallest nested stride whose label spacing fits the widest label (+ 6 px air). */
export function labelStride(spacingPx: number, maxLabelPx: number): number {
  if (!(spacingPx > 0)) return 1;
  for (const s of LABEL_STRIDES) if (spacingPx * s >= maxLabelPx + 6) return s;
  return LABEL_STRIDES[LABEL_STRIDES.length - 1];
}

const FADE_MS = 90;
const fadeTimers = new WeakMap<HTMLElement, number>();

function setLabelShown(label: HTMLElement, show: boolean, fade: boolean): void {
  const was = label.dataset.on === "1";
  // Unchanged: shown stays shown; hidden (or still fading out) stays as it is.
  if (show === was && (show || label.hidden || label.classList.contains("is-out"))) return;
  label.dataset.on = show ? "1" : "";
  const timer = fadeTimers.get(label);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    fadeTimers.delete(label);
  }
  if (show) {
    label.hidden = false;
    label.classList.remove("is-out");
    if (fade && !was) {
      label.classList.remove("is-in");
      void label.offsetWidth; // restart the 90 ms fade-in
      label.classList.add("is-in");
    }
    return;
  }
  if (fade && was && !label.hidden) {
    label.classList.remove("is-in");
    label.classList.add("is-out");
    fadeTimers.set(
      label,
      window.setTimeout(() => {
        fadeTimers.delete(label);
        if (label.dataset.on !== "1") {
          label.hidden = true;
          label.classList.remove("is-out");
        }
      }, FADE_MS),
    );
    return;
  }
  label.hidden = true;
  label.classList.remove("is-in", "is-out");
}

/**
 * Render tick labels into an axis strip (reusing spans). Labels that would
 * overlap each other, leave `[0, width]` or collide with `reserveRight` px at
 * the right end are hidden; the tick marks always draw. Returns the number
 * of visible labels.
 */
export function renderAxisLabels(
  strip: HTMLElement,
  ticks: readonly AxisTick[],
  width: number,
  measure: (s: string) => number,
  reserveRight = 0,
  opts: AxisLabelOptions = {},
): number {
  const pool = strip.querySelectorAll<HTMLElement>(":scope > .axis-tick-label");
  const marks = strip.querySelectorAll<HTMLElement>(":scope > .axis-tick-mark");
  let shown = 0;
  let right = -Infinity;
  const limit = width - reserveRight;
  const fade = !!opts.fade;
  let stride = 1;
  if (opts.stride && ticks.length > 1) {
    let maxW = 0;
    for (const t of ticks) maxW = Math.max(maxW, Math.ceil(measure(t.label)) + 4);
    stride = labelStride(Math.abs(ticks[1].x - ticks[0].x), maxW);
  }
  for (let i = 0; i < Math.max(ticks.length, pool.length); i++) {
    let label = pool[i];
    let mark = marks[i];
    const t = ticks[i];
    if (!t) {
      if (label) setLabelShown(label, false, false);
      if (mark) mark.hidden = true;
      continue;
    }
    if (!label) {
      label = document.createElement("span");
      label.className = "axis-tick-label";
      label.hidden = true;
      strip.appendChild(label);
    }
    if (!mark) {
      mark = document.createElement("span");
      mark.className = "axis-tick-mark";
      strip.appendChild(mark);
    }
    const inside = t.x >= -0.5 && t.x <= width + 0.5;
    mark.hidden = !inside;
    if (inside) mark.style.transform = `translateX(${Math.round(t.x * 2) / 2}px)`;
    const w = Math.ceil(measure(t.label)) + 4;
    let left = t.x - w / 2;
    if (left < 0) left = 0;
    if (left + w > width) left = width - w;
    const ok = inside && i % stride === 0 && left >= right + 6 && left + w <= limit + 0.5;
    if (ok) {
      if (label.textContent !== t.label) label.textContent = t.label;
      label.style.transform = `translateX(${Math.round(left)}px)`;
      right = left + w;
      shown++;
    } else if (label.classList.contains("is-out")) {
      // A label fading out keeps moving with its tick.
      label.style.transform = `translateX(${Math.round(left)}px)`;
    }
    setLabelShown(label, ok, fade);
  }
  return shown;
}

/** Position 1 px gridlines (reusing spans) at the tick x positions. */
export function renderGridLines(layer: HTMLElement, xs: readonly number[], width: number): void {
  const pool = layer.children;
  let n = 0;
  for (const x of xs) {
    if (x < -0.5 || x > width + 0.5) continue;
    let el = pool[n] as HTMLElement | undefined;
    if (!el) {
      el = document.createElement("span");
      el.className = "grid-line";
      layer.appendChild(el);
    }
    el.hidden = false;
    el.style.transform = `translateX(${Math.round(Math.min(width - 1, Math.max(0, x)))}px)`;
    n++;
  }
  for (let i = n; i < pool.length; i++) (pool[i] as HTMLElement).hidden = true;
}

// ── Crosshair time chip (§3.3) ──────────────────────────────────────────────

/** `--fg` chip with `--surface` 11 px text centred on `cx`, clamped to `[minX, maxX]`. */
export function drawTimeChip(o: CanvasRenderingContext2D, theme: ThemeApi, cx: number, y: number, label: string, minX: number, maxX: number): void {
  const t = theme.tokens();
  o.save();
  setFont(o, uiFont(theme, 11, 500));
  const w = Math.ceil(o.measureText(label).width) + 10;
  const hh = 16;
  const x = Math.max(minX, Math.min(maxX - w, cx - w / 2));
  roundRect(o, x, y, w, hh, 3);
  o.fillStyle = t["fg"];
  o.fill();
  o.fillStyle = t["surface"];
  o.textBaseline = "middle";
  o.textAlign = "left";
  o.fillText(label, x + 5, y + hh / 2 + 0.5);
  o.restore();
}

/** Two outlines that read on every fill: 2 px `--focus` outside a 1 px `--surface` ring (§3.4). */
export function strokeHighlight(o: CanvasRenderingContext2D, p: FramePalette, x: number, y: number, w: number, h: number): void {
  o.lineWidth = 1;
  o.strokeStyle = p.surface;
  o.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  o.lineWidth = 2;
  o.strokeStyle = p.focus;
  o.strokeRect(x - 1, y - 1, w + 2, h + 2);
}

/** Seconds with three decimals for precise ranges in tooltips ("2.870 s"). */
export function fmtSecPrecise(s: number): string {
  return `${s.toFixed(3)} s`;
}

/** True when the pointer moved less than `px` between two points. */
export function isClick(ax: number, ay: number, bx: number, by: number, px = 4): boolean {
  return Math.abs(ax - bx) < px && Math.abs(ay - by) < px;
}

/** Wheel delta in CSS px (line/page modes normalised). */
export function wheelPixels(ev: WheelEvent, axis: "x" | "y"): number {
  const d = axis === "x" ? ev.deltaX : ev.deltaY;
  return ev.deltaMode === 1 ? d * 16 : ev.deltaMode === 2 ? d * 400 : d;
}
