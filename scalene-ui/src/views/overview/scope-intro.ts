/**
 * The scope's first-load sweep as compositor animations (DESIGN.md §4.4.9, §5.2 M4, §5.3.1).
 *
 * Every moving part is a transform or opacity Web Animation, so the sweep stays fluid while the
 * main thread is busy (other sections mount during the first second):
 *
 *   stage (clips to the plot) ─┬─ window ⟶ slides in from the left (translateX −W → 0)
 *                              │    └─ data layer ⟵ counter-slides (W → 0): it stays in place
 *                              │       while the window's right edge (the beam) uncovers it
 *                              ├─ afterglow window: AFTERGLOW px wide, rides the beam, masked by
 *                              │    a 0 → 1 ramp; holds a bloomed copy of the data (in dark the
 *                              │    bloom is pre-composited into the canvas with shadowBlur and
 *                              │    'lighter', and shown with normal blending: a blended layer
 *                              │    cost 10–20 fps at 2560 px; in light a deeper ink pass) that
 *                              │    counter-slides too
 *                              ├─ beam: 1 px line + 48 px phosphor trail
 *                              └─ write head: a dot riding the footprint (keyframes sampled from
 *                                   the real trace, x linear in sweep progress)
 *   time chip on the axis (position composited, text from the main thread), peak callout layer
 *   (fades in when the beam crosses the peak's x), peak ping ring.
 *
 * All animations share one effect timing (delay 120 ms, 640 ms, `1 − (1 − t)^2.2` as a CSS
 * `linear()` easing) and are created in one task, so they start on the same frame. When they
 * finish the stage is removed and the static base render (identical pixels) remains.
 */

import { h } from "../../core/dom";
import { DUR, EASE, EASE_CSS } from "../../core/motion";
import type { Rect } from "../../charts/placement";

export const SWEEP_START = 120;
/** Phosphor afterglow band behind the beam (CSS px). */
export const AFTERGLOW_PX = 112;
export const TRAIL_PX = 48;
/** The intro must be settled by this time after its first frame (§5.3.1). */
export const SETTLE_MS = 900;

/** `1 − (1 − t)^2.2` as a CSS `linear()` easing (n segments; max error < 0.2 % of the width). */
export function sweepLinearEasing(n = 48): string {
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) pts.push(EASE.sweep(i / n).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
  return `linear(${pts.join(", ")})`;
}

/** Sweep progress (0..1) at `e` ms after the intro origin. */
export function sweepAt(e: number): number {
  const u = (e - SWEEP_START) / DUR.sweep;
  return u <= 0 ? 0 : u >= 1 ? 1 : EASE.sweep(u);
}

/** Time (ms after the origin) at which the beam reaches fraction `frac` of the plot width. */
export function crossingTime(frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  const u = 1 - Math.pow(1 - f, 1 / 2.2);
  return SWEEP_START + u * DUR.sweep;
}

export interface IntroSpec {
  host: HTMLElement;
  /** Inserted before this node (the overlay canvas), so interaction stays on top. */
  before: Node;
  width: number;
  height: number;
  plot: Rect;
  /** Full data layer (device px, already drawn). It is shown in the stage, then handed back. */
  data: HTMLCanvasElement;
  dpr: number;
  dark: boolean;
  glow: number;
  tokens: Readonly<Record<string, string>>;
  /** Footprint samples along the plot: points at x = plot.x + (i/n)·plot.w, y or null (not sampled). */
  head: (number | null)[] | null;
  /** Peak dot (CSS px) and its callout drawn on its own canvas (device px), if any. */
  peak: { x: number; y: number; callout: HTMLCanvasElement | null } | null;
  /** Axis chip row (CSS px). */
  axisY: number;
  /** Main-thread label of the chip at sweep progress p (e.g. "26.9 s"). */
  chipText(p: number): string;
  /**
   * Continue an intro that already started (document timeline ms): used when the stage is
   * rebuilt mid-sweep for a new geometry. Omitted: start on the next frame (pending).
   */
  startTime?: number | null;
}

export interface IntroStage {
  /** Resolves with the shared start time (document timeline ms) once the first frame commits. */
  origin: Promise<number>;
  /** Resolves when every animation has finished (or the stage was destroyed). */
  finished: Promise<void>;
  /** The data layer changed in place (e.g. the lazy timeline arrived): refresh the glow copy. */
  refresh(): void;
  /** Pin every animation to a shared start time (the overview's intro origin). */
  sync(startTime: number): void;
  /** Sweep progress now (0..1), from the shared clock. */
  progress(): number;
  destroy(): void;
}

function supportsLinearEasing(): boolean {
  try {
    return typeof CSS !== "undefined" && CSS.supports("animation-timing-function", "linear(0, 1)");
  } catch {
    return false;
  }
}

export function createIntroStage(s: IntroSpec): IntroStage {
  const W = s.plot.w;
  const H = s.height;
  const easing = supportsLinearEasing() ? sweepLinearEasing() : EASE_CSS.out;
  const timing: KeyframeAnimationOptions = { duration: DUR.sweep, delay: SWEEP_START, easing, fill: "both" };
  const anims: Animation[] = [];
  const px = (v: number) => `${v}px`;

  // ── Stage + data window ──
  const stage = h("div", { class: "scope-stage", "aria-hidden": "true", style: { left: px(s.plot.x), top: "0px", width: px(W), height: px(H) } });
  const win = h("div", { class: "ss-win", style: { width: px(W), height: px(H) } });
  const data = s.data;
  data.classList.add("ss-data");
  data.style.cssText = `position:absolute;left:${-s.plot.x}px;top:0;width:${s.width}px;height:${H}px`;
  win.append(data);
  stage.append(win);
  anims.push(win.animate([{ transform: `translateX(${-W}px)` }, { transform: "translateX(0px)" }], timing));
  anims.push(data.animate([{ transform: `translateX(${W}px)` }, { transform: "translateX(0px)" }], timing));

  // ── Afterglow ──
  const AG = Math.min(AFTERGLOW_PX, W);
  const glowWin = h("div", { class: ["ss-glow", s.dark && s.glow > 0 ? "is-bloom" : ""], style: { left: px(-AG), width: px(AG), height: px(H) } });
  const glowCv = document.createElement("canvas");
  glowCv.style.cssText = `position:absolute;left:${AG - s.plot.x}px;top:0;width:${s.width}px;height:${H}px`;
  glowWin.append(glowCv);
  stage.append(glowWin);
  const paintGlow = () => {
    if (glowCv.width !== data.width) glowCv.width = data.width;
    if (glowCv.height !== data.height) glowCv.height = data.height;
    const g = glowCv.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, glowCv.width, glowCv.height);
    if (s.dark && s.glow > 0) {
      // Bloom, pre-composited (no mix-blend-mode on the layer, review round 1): the halo alone
      // (the data is drawn off-canvas and only its shadow lands here), then the trace added
      // onto it with 'lighter', so the copy reads as light without a blended compositor layer.
      const off = glowCv.width + 64;
      g.shadowBlur = 9 * s.glow * s.dpr;
      g.shadowColor = alphaToRgba(s.tokens["fg"], 0.45);
      g.shadowOffsetX = off;
      g.drawImage(data, -off, 0);
      g.shadowBlur = 0;
      g.shadowOffsetX = 0;
      g.globalCompositeOperation = "lighter";
      g.drawImage(data, 0, 0);
      g.globalCompositeOperation = "source-over";
    } else g.drawImage(data, 0, 0);
  };
  paintGlow();
  anims.push(glowWin.animate([{ transform: "translateX(0px)" }, { transform: `translateX(${W}px)` }], timing));
  // The glow decays as the beam settles, so the last frame is the static render (no band left).
  const glowA = s.dark && s.glow > 0 ? 0.9 : 0.6;
  anims.push(glowWin.animate([{ opacity: glowA }, { opacity: glowA, offset: 0.7 }, { opacity: 0 }], { duration: DUR.sweep, delay: SWEEP_START, easing: "linear", fill: "both" }));
  anims.push(glowCv.animate([{ transform: "translateX(0px)" }, { transform: `translateX(${-W}px)` }], timing));

  // ── Beam ──
  const beam = h(
    "div",
    { class: "ss-beam", style: { left: px(-TRAIL_PX), top: px(s.plot.y), height: px(s.plot.h), width: px(TRAIL_PX + 1) } },
    h("i", { class: "ss-trail" }),
    h("i", { class: "ss-line" }),
  );
  stage.append(beam);
  anims.push(beam.animate([{ transform: "translateX(0px)" }, { transform: `translateX(${W}px)` }], timing));
  anims.push(beam.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: DUR.sweep, delay: SWEEP_START, easing: "linear", fill: "both" }));

  // ── Write head on the footprint ──
  if (s.head && s.head.length > 1) {
    const n = s.head.length - 1;
    const dot = h("i", { class: "ss-head" });
    stage.append(dot);
    let lastY = s.head.find((v) => v !== null) ?? 0;
    const frames: Keyframe[] = s.head.map((y, i) => {
      if (y !== null) lastY = y;
      return { offset: i / n, transform: `translate(${((i / n) * W - 3).toFixed(2)}px, ${((y ?? lastY) - 3).toFixed(2)}px)`, opacity: y === null ? 0 : 1 };
    });
    // fill "none" + base opacity 0: no head before the sweep starts or after it ends (the
    // static render has none), and only composited properties animate.
    dot.style.opacity = "0";
    anims.push(dot.animate(frames, { ...timing, fill: "none" }));
  }

  // ── Time chip on the axis (position composited, text from the main thread) ──
  const CHIP_W = 56;
  const chip = h("span", { class: "ss-chip", "aria-hidden": "true", style: { left: px(s.plot.x - CHIP_W / 2), top: px(s.axisY + 1), width: px(CHIP_W) } }, s.chipText(0));
  anims.push(chip.animate([{ transform: "translateX(0px)" }, { transform: `translateX(${W}px)` }], timing));
  anims.push(chip.animate([{ opacity: 1 }, { opacity: 1 }], { duration: DUR.sweep, delay: SWEEP_START, fill: "none" }));
  chip.style.opacity = "0";

  // ── Peak: callout fades in and a ring pings when the beam crosses it ──
  let callout: HTMLCanvasElement | null = null;
  if (s.peak) {
    const at = crossingTime((s.peak.x - s.plot.x) / W);
    if (s.peak.callout) {
      callout = s.peak.callout;
      callout.classList.add("ss-callout");
      callout.style.cssText = `position:absolute;left:0;top:0;width:${s.width}px;height:${H}px;pointer-events:none`;
      anims.push(callout.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.d2, delay: at, easing: "linear", fill: "both" }));
    }
    const pingMs = Math.min(240, SETTLE_MS - 20 - at);
    if (pingMs >= 80) {
      const ring = h("i", { class: "ss-ping", "aria-hidden": "true", style: { left: px(s.peak.x - 4), top: px(s.peak.y - 4) } });
      ring.style.opacity = "0";
      anims.push(ring.animate([{ transform: "scale(1)", opacity: 0.9 }, { transform: "scale(3)", opacity: 0 }], { duration: pingMs, delay: at, easing: EASE_CSS.out, fill: "none" }));
      s.host.insertBefore(ring, s.before);
    }
  }

  s.host.insertBefore(stage, s.before);
  if (callout) s.host.insertBefore(callout, s.before);
  s.host.insertBefore(chip, s.before);

  // ── Shared clock ──
  let originT: number | null = null;
  if (typeof s.startTime === "number") {
    for (const a of anims) a.startTime = s.startTime;
    originT = s.startTime;
  }
  const origin = anims[0].ready.then(
    (a) => {
      originT = typeof a.startTime === "number" ? a.startTime : performance.now();
      return originT;
    },
    () => originT ?? performance.now(),
  );
  const now = () => {
    const ct = document.timeline?.currentTime;
    return typeof ct === "number" ? ct : performance.now();
  };
  let chipFrame = 0;
  const chipTick = () => {
    if (originT !== null) chip.textContent = s.chipText(sweepAt(now() - originT));
    chipFrame = requestAnimationFrame(chipTick);
  };
  chipFrame = requestAnimationFrame(chipTick);

  let alive = true;
  const finished = Promise.all(anims.map((a) => a.finished.catch(() => undefined))).then(() => undefined);

  return {
    origin,
    finished,
    refresh() {
      if (alive) paintGlow();
    },
    sync(startTime) {
      if (!alive) return;
      originT = startTime;
      for (const a of anims) {
        try {
          a.startTime = startTime;
        } catch {
          // A cancelled animation has no timeline to pin to.
        }
      }
    },
    progress() {
      return originT === null ? 0 : sweepAt(now() - originT);
    },
    destroy() {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(chipFrame);
      for (const a of anims) a.cancel();
      data.classList.remove("ss-data");
      data.removeAttribute("style");
      data.remove();
      callout?.remove();
      stage.remove();
      chip.remove();
      s.host.querySelectorAll(".ss-ping").forEach((r) => r.remove());
    },
  };
}

/** "rgb(r g b)" / "#rrggbb" + alpha → rgba() for canvas shadows (tokens are hex in practice). */
function alphaToRgba(color: string, a: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return c;
}
