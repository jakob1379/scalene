// Canvas helpers shared by every chart: base + overlay pairs (DPR capped at 2), cached
// hatch patterns per theme, token colour maths and token-safe text fitting (§3.1, §3.5).
import type { ThemeApi } from "./theme";

export interface CanvasPair {
  base: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  b: CanvasRenderingContext2D;
  o: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number; // CSS px; dpr capped at 2
  resize(w: number, h: number): void;
  clearOverlay(): void;
  destroy(): void;
}

export const DPR_CAP = 2;

export function currentDpr(): number {
  return Math.max(1, Math.min(DPR_CAP, window.devicePixelRatio || 1));
}

function context2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("scalene-ui: 2D canvas is not available");
  return ctx;
}

/**
 * Two stacked canvases inside `host`: `base` for static geometry and `overlay` for
 * hover/crosshair/brush. The base is aria-hidden; the overlay is too unless the chart is
 * interactive (the view then gives it role, label and tabindex).
 */
export function createCanvasPair(host: HTMLElement, opts: { interactive?: boolean } = {}): CanvasPair {
  host.classList.add("canvas-pair");
  const base = document.createElement("canvas");
  const overlay = document.createElement("canvas");
  base.className = "cv-base";
  overlay.className = "cv-overlay";
  base.setAttribute("aria-hidden", "true");
  if (!opts.interactive) overlay.setAttribute("aria-hidden", "true");
  host.append(base, overlay);
  const pair: CanvasPair = {
    base,
    overlay,
    b: context2d(base),
    o: context2d(overlay),
    width: 0,
    height: 0,
    dpr: currentDpr(),
    resize(w, h) {
      const dpr = currentDpr();
      const cw = Math.max(1, Math.round(w * dpr));
      const ch = Math.max(1, Math.round(h * dpr));
      pair.width = w;
      pair.height = h;
      pair.dpr = dpr;
      for (const c of [base, overlay]) {
        if (c.width !== cw) c.width = cw;
        if (c.height !== ch) c.height = ch;
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      pair.b.setTransform(dpr, 0, 0, dpr, 0, 0);
      pair.o.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    clearOverlay() {
      pair.o.save();
      pair.o.setTransform(1, 0, 0, 1, 0, 0);
      pair.o.clearRect(0, 0, overlay.width, overlay.height);
      pair.o.restore();
    },
    destroy() {
      base.remove();
      overlay.remove();
      host.classList.remove("canvas-pair");
    },
  };
  return pair;
}

/** Clear a whole canvas regardless of its current transform. */
export function clearCanvas(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** Snap a coordinate to the device pixel grid (centre of a pixel, for 1 px lines). */
export function crisp(x: number, dpr = currentDpr()): number {
  return (Math.round(x * dpr) + 0.5) / dpr;
}

// ── Colour maths (tokens are #RRGGBB or rgb(r g b / a)) ─────────────────────────

export type RGBA = [number, number, number, number];

export function parseColor(c: string): RGBA | null {
  const s = c.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch);
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4]?.endsWith("%")) a /= 100;
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  }
  return null;
}

export function rgbaString([r, g, b, a]: RGBA): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(4)})`;
}

/** The colour with its alpha multiplied by `a`. */
export function alpha(color: string, a: number): string {
  const c = parseColor(color);
  return c ? rgbaString([c[0], c[1], c[2], c[3] * a]) : color;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
};

function toOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(L: number, A: number, B: number): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Mix `a` toward `b` by `t` (0 = a, 1 = b) in OKLab; used for frame dimming (§3.4). */
export function mixOklab(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  const la = toOklab(ca[0], ca[1], ca[2]);
  const lb = toOklab(cb[0], cb[1], cb[2]);
  const [r, g, bl] = fromOklab(la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t);
  return rgbaString([r, g, bl, ca[3] + (cb[3] - ca[3]) * t]);
}

// ── Hatch patterns (§3.1): two encodings for two quantities ─────────────────────

export type HatchKind = "system" | "waiting" | "short-phase";

interface HatchSpec {
  period: number;
  angle: 45 | 135;
  width: number;
  fill(t: ThemeApi): string | null;
  stroke(t: ThemeApi): string;
}

const HATCH: Record<HatchKind, HatchSpec> = {
  // System time: --cpu-sys fill with --surface 45° lines (55 % alpha, 4 px period).
  system: {
    period: 4,
    angle: 45,
    width: 1.25,
    fill: (t) => t.tokens()["cpu-sys"],
    stroke: (t) => alpha(t.tokens()["surface"], 0.55),
  },
  // Waiting (I/O & waits, [await]): --async at 35 % with --async 135° lines (5 px period).
  waiting: {
    period: 5,
    angle: 135,
    width: 1,
    fill: (t) => alpha(t.tokens()["async"], 0.35),
    stroke: (t) => t.tokens()["async"],
  },
  // Short phase cells: the system-style hatch at 35 % on --sunken.
  "short-phase": {
    period: 4,
    angle: 45,
    width: 1.25,
    fill: (t) => t.tokens()["sunken"],
    stroke: (t) => alpha(t.tokens()["cpu-sys"], 0.35),
  },
};

const hatchCache = new Map<string, CanvasPattern>();

function drawHatchTile(spec: HatchSpec, t: ThemeApi, dpr: number): HTMLCanvasElement {
  const size = spec.period * 2;
  const tile = document.createElement("canvas");
  tile.width = tile.height = Math.round(size * dpr);
  const x = context2d(tile);
  x.scale(dpr, dpr);
  const fill = spec.fill(t);
  if (fill) {
    x.fillStyle = fill;
    x.fillRect(0, 0, size, size);
  }
  x.strokeStyle = spec.stroke(t);
  x.lineWidth = spec.width;
  x.lineCap = "square";
  x.beginPath();
  // Lines x ± y = c spaced one period apart; extending past the tile keeps it seamless.
  for (let c = -size; c <= 2 * size; c += spec.period) {
    if (spec.angle === 45) {
      x.moveTo(c, 0);
      x.lineTo(c - size, size);
    } else {
      x.moveTo(c, 0);
      x.lineTo(c + size, size);
    }
  }
  x.stroke();
  return tile;
}

/** Cached hatch pattern for the current theme and DPR. */
export function hatch(ctx: CanvasRenderingContext2D, kind: HatchKind, t: ThemeApi): CanvasPattern {
  const spec = HATCH[kind];
  const dpr = currentDpr();
  const key = `${kind}|${t.current()}|${dpr}|${spec.fill(t)}|${spec.stroke(t)}`;
  let p = hatchCache.get(key);
  if (!p) {
    const made = ctx.createPattern(drawHatchTile(spec, t, dpr), "repeat");
    if (!made) throw new Error("scalene-ui: createPattern failed");
    if (typeof DOMMatrix === "function") made.setTransform(new DOMMatrix().scale(1 / dpr));
    p = made;
    if (hatchCache.size > 64) hatchCache.clear();
    hatchCache.set(key, p);
  }
  return p;
}

// ── Text ────────────────────────────────────────────────────────────────────────

/** Configure canvas text so code renders verbatim (§3.5): mono stack, no kerning. */
export function setFont(ctx: CanvasRenderingContext2D, font: string): void {
  ctx.font = font;
  const c = ctx as CanvasRenderingContext2D & { fontKerning?: string; textRendering?: string };
  if ("fontKerning" in c) c.fontKerning = "none";
  if ("textRendering" in c) c.textRendering = "optimizeSpeed";
}

/** Font shorthand for monospace canvas text at `px` (reads `--font-mono`). */
export function monoFont(t: ThemeApi, px = 12, weight = 400): string {
  return `${weight} ${px}px ${t.tokens()["font-mono"] || "monospace"}`;
}

/** Font shorthand for UI canvas text at `px` (reads `--font-ui`). */
export function uiFont(t: ThemeApi, px = 11, weight = 400): string {
  return `${weight} ${px}px ${t.tokens()["font-ui"] || "sans-serif"}`;
}

const ELLIPSIS = "…";
const TOKEN_RE = /\s+|[A-Za-z_\d]+|[^\sA-Za-z_\d]/g;

/**
 * Fit `s` into `maxW` px with the context's current font.
 * - `end`: "loss_value = lo…"
 * - `middle`: "torch::autograd::…::backward"
 * - `code`: whole tokens only, then " …" (never truncates mid-token; may return "").
 */
export function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number, mode: "end" | "middle" | "code"): string {
  const width = (x: string) => ctx.measureText(x).width;
  if (width(s) <= maxW) return s;
  if (maxW <= width(ELLIPSIS)) return "";
  if (mode === "code") {
    const tokens = s.match(TOKEN_RE) ?? [];
    const budget = maxW - width(` ${ELLIPSIS}`);
    let out = "";
    for (const tok of tokens) {
      if (width(out + tok) > budget) break;
      out += tok;
    }
    out = out.trimEnd();
    return out ? `${out} ${ELLIPSIS}` : "";
  }
  if (mode === "end") {
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (width(s.slice(0, mid) + ELLIPSIS) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? s.slice(0, lo) + ELLIPSIS : "";
  }
  // middle: keep balanced head and tail.
  let lo = 0;
  let hi = Math.floor(s.length / 2);
  const build = (k: number) => s.slice(0, Math.ceil(k)) + ELLIPSIS + s.slice(s.length - Math.floor(k));
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(build(mid)) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? build(lo) : "";
}

/** Rounded rectangle path (falls back when ctx.roundRect is unavailable). */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Resize events closer together than this are a "storm" (window or panel drag). */
export const RESIZE_STORM_MS = 150;
/** Trailing delay before a storm's final relayout. */
export const RESIZE_SETTLE_MS = 120;

/**
 * Observe an element's content-box size (DESIGN.md §6.1.5, round 1 review). Callbacks are
 * coalesced to one per frame, and:
 *  - the first size is always delivered (initial layout);
 *  - while sizes keep arriving less than 150 ms apart, only the first one relayouts at once;
 *    the rest wait for a 120 ms pause (one reallocation and redraw at the end of a drag);
 *  - an element that is off-screen (more than one viewport away) does not relayout at all:
 *    it is marked dirty and relayouts when it comes back into range.
 * A window drag therefore stops relayouting every canvas section on every pixel.
 */
export function observeSize(el: Element, cb: (w: number, h: number) => void): () => void {
  let frame = 0;
  let settle = 0;
  let last: [number, number] = [-1, -1];
  let delivered: [number, number] = [-1, -1];
  let lastEventAt = -Infinity;
  let first = true;
  let visible = true;
  let dirty = false;
  const deliver = () => {
    frame = 0;
    if (!visible) {
      dirty = true;
      return;
    }
    dirty = false;
    if (last[0] === delivered[0] && last[1] === delivered[1]) return;
    delivered = [last[0], last[1]];
    cb(last[0], last[1]);
  };
  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(deliver);
  };
  const ro = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    const box = e.contentBoxSize?.[0];
    const w = box ? box.inlineSize : e.contentRect.width;
    const h = box ? box.blockSize : e.contentRect.height;
    if (w === last[0] && h === last[1]) return;
    last = [w, h];
    const now = performance.now();
    const storm = !first && now - lastEventAt < RESIZE_STORM_MS;
    lastEventAt = now;
    if (first) {
      first = false;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        dirty = false;
        delivered = [last[0], last[1]];
        cb(last[0], last[1]);
      });
      return;
    }
    window.clearTimeout(settle);
    if (storm) settle = window.setTimeout(schedule, RESIZE_SETTLE_MS);
    else schedule();
  });
  ro.observe(el);
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === "function") {
    io = new IntersectionObserver(
      (entries) => {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible && dirty) schedule();
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
  }
  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.clearTimeout(settle);
    ro.disconnect();
    io?.disconnect();
  };
}

/**
 * Deferred repaint for canvases far from the viewport (§6.1 theme toggle budget; review round 1):
 * `run(draw)` draws now when `el` is within one viewport of the screen, else keeps only the
 * latest `draw` and runs it when the element comes into that range. Returns a disposer.
 */
export function nearViewport(el: Element): { run(draw: () => void): void; dispose(): void } {
  let near = true;
  let pending: (() => void) | null = null;
  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            near = entries[entries.length - 1].isIntersecting;
            if (near && pending) {
              const d = pending;
              pending = null;
              d();
            }
          },
          { rootMargin: "100% 0px" },
        )
      : null;
  io?.observe(el);
  return {
    run(draw) {
      if (near) {
        pending = null;
        draw();
      } else pending = draw;
    },
    dispose: () => io?.disconnect(),
  };
}
