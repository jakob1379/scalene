// Motion primitives (DESIGN.md §5.5). Every animation is cancellable, time-based and
// skipped entirely under reduced motion (`motion-reduce`) or `?still` (final frames).
import { STORAGE_KEYS, storageGet, storageRemove, storageSet } from "./storage";

export type Ease = (t: number) => number;

export interface MotionApi {
  readonly reduced: boolean;
  tween(key: string, ms: number, ease: Ease, step: (t: number) => void, done?: () => void): { cancel(): void };
  flip(nodes: HTMLElement[], mutate: () => void, ms?: number): void;
  countUp(el: HTMLElement, finalText: string, opts?: { ms?: number; delay?: number }): void;
  revealOnce(el: Element, cb: () => void): () => void;
}

export interface IntroStep {
  /** Start offset in ms from the beginning of the intro. */
  at: number;
  /** `immediate` is true on the reduced/still path: render the final state now. */
  run(immediate: boolean): void;
}

export interface MotionController extends MotionApi {
  /** `?still`: every final frame immediately (screenshots, tests). */
  readonly still: boolean;
  /** Reduced or still: animations must render their final state. */
  readonly instant: boolean;
  /** The in-app override: true forces reduce, null follows the OS. */
  preference(): boolean | null;
  setPreference(reduce: boolean | null): void;
  onMotionChange(cb: (reduced: boolean) => void): () => void;
  intro(steps: IntroStep[]): { cancel(): void };
  destroy(): void;
}

/** Cubic-bezier evaluator (same curve as the CSS function). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (hi - lo > 1e-6) {
      if (sx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)));
}

/** Easing functions matching the `--ease-*` tokens, plus the scope sweep curve. */
export const EASE = {
  linear: ((t: number) => t) as Ease,
  out: cubicBezier(0.22, 1, 0.36, 1),
  standard: cubicBezier(0.2, 0, 0, 1),
  productive: cubicBezier(0.2, 0, 0.38, 0.9),
  in: cubicBezier(0.4, 0, 1, 1),
  sweep: ((t: number) => 1 - Math.pow(1 - t, 2.2)) as Ease,
};

/** CSS easing strings for the Web Animations API. */
export const EASE_CSS = {
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  productive: "cubic-bezier(0.2, 0, 0.38, 0.9)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/** Durations in ms, matching the `--dur-*` tokens (motion allowed). */
export const DUR = { d1: 90, d2: 140, d3: 200, d4: 280, d5: 420, count: 600, sweep: 640, flash: 1200, stagger: 30 } as const;

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Run an intro plan (§5.2 M1–M6) from one timeline so the stagger is deterministic.
 * `instant` (reduced motion or `?still`) runs every step's final state now. Views get
 * `MotionApi` (no `intro`), so they call this with `motion.reduced || host.flags.still`.
 */
export function runIntro(steps: IntroStep[], instant: boolean): { cancel(): void } {
  const ordered = steps.slice().sort((a, b) => a.at - b.at);
  if (instant) {
    for (const s of ordered) s.run(true);
    return { cancel() {} };
  }
  let next = 0;
  let frame = 0;
  const t0 = performance.now();
  const tick = (now: number) => {
    const elapsed = now - t0;
    while (next < ordered.length && ordered[next].at <= elapsed) ordered[next++].run(false);
    if (next < ordered.length) frame = requestAnimationFrame(tick);
  };
  tick(t0);
  return {
    cancel() {
      if (frame) cancelAnimationFrame(frame);
      while (next < ordered.length) ordered[next++].run(true);
    },
  };
}

function parseNumber(text: string): { prefix: string; value: number; decimals: number; grouped: boolean; suffix: string } | null {
  const m = /^([^\d<>]*)(\d[\d,]*(?:\.\d+)?)(.*)$/s.exec(text);
  if (!m) return null;
  const digits = m[2];
  const value = parseFloat(digits.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return {
    prefix: m[1],
    value,
    decimals: (digits.split(".")[1] ?? "").length,
    grouped: digits.includes(","),
    suffix: m[3],
  };
}

function formatLike(v: number, decimals: number, grouped: boolean): string {
  return grouped
    ? v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : v.toFixed(decimals);
}

export function createMotion(flags: { still: boolean; motion: "reduce" | null }): MotionController {
  const root = document.documentElement;
  const mql = typeof window.matchMedia === "function" ? window.matchMedia(REDUCE_QUERY) : null;
  const listeners = new Set<(reduced: boolean) => void>();
  const running = new Map<string, { cancel(): void }>();
  const flips = new WeakMap<HTMLElement, Animation>();
  const counts = new WeakMap<HTMLElement, { cancel(): void }>();

  // In-memory copy of the in-app override, so the toggle works even when storage is blocked.
  let pref: boolean | null = storageGet(STORAGE_KEYS.reducedMotion) === "1" ? true : null;
  let counter = 0;
  const computeReduced = () => flags.motion === "reduce" || pref === true || Boolean(mql?.matches);
  let reduced = computeReduced();

  const applyClasses = () => {
    root.classList.toggle("motion-reduce", reduced);
    root.classList.toggle("motion-ok", !reduced);
    root.classList.toggle("motion-still", flags.still);
  };
  applyClasses();

  const refresh = () => {
    const next = computeReduced();
    if (next === reduced) return;
    reduced = next;
    applyClasses();
    for (const cb of Array.from(listeners)) cb(reduced);
  };
  mql?.addEventListener("change", refresh);

  const instant = () => reduced || flags.still;

  const tween: MotionApi["tween"] = (key, ms, ease, step, done) => {
    running.get(key)?.cancel();
    if (instant() || ms <= 0) {
      step(1);
      done?.();
      return { cancel() {} };
    }
    let frame = 0;
    let cancelled = false;
    const t0 = performance.now();
    const handle = {
      cancel() {
        cancelled = true;
        if (frame) cancelAnimationFrame(frame);
        if (running.get(key) === handle) running.delete(key);
      },
    };
    const tick = (now: number) => {
      if (cancelled) return;
      const t = Math.min(1, Math.max(0, (now - t0) / ms));
      step(ease(t));
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        running.delete(key);
        done?.();
      }
    };
    running.set(key, handle);
    frame = requestAnimationFrame(tick);
    return handle;
  };

  const flip: MotionApi["flip"] = (nodes, mutate, ms = DUR.d4) => {
    if (instant() || nodes.length === 0 || nodes.length > 300) {
      mutate();
      return;
    }
    for (const n of nodes) flips.get(n)?.cancel();
    const first = nodes.map((n) => n.getBoundingClientRect());
    mutate();
    nodes.forEach((n, i) => {
      if (!n.isConnected) return;
      const last = n.getBoundingClientRect();
      const dx = first[i].left - last.left;
      const dy = first[i].top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      const anim = n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: ms,
        easing: EASE_CSS.standard,
      });
      flips.set(n, anim);
    });
  };

  const countUp: MotionApi["countUp"] = (el, finalText, opts = {}) => {
    counts.get(el)?.cancel();
    const parsed = parseNumber(finalText);
    if (instant() || !parsed || parsed.value === 0) {
      el.textContent = finalText;
      return;
    }
    const { prefix, value, decimals, grouped, suffix } = parsed;
    const ms = opts.ms ?? DUR.count;
    el.textContent = prefix + formatLike(0, decimals, grouped) + suffix;
    let handle: { cancel(): void } = { cancel() {} };
    const timer = window.setTimeout(() => {
      handle = tween(`count:${counter++}`, ms, EASE.out, (t) => {
        el.textContent = t >= 1 ? finalText : prefix + formatLike(value * t, decimals, grouped) + suffix;
      });
    }, Math.max(0, opts.delay ?? 0));
    counts.set(el, {
      cancel() {
        window.clearTimeout(timer);
        handle.cancel();
        el.textContent = finalText;
      },
    });
  };

  const revealOnce: MotionApi["revealOnce"] = (el, cb) => {
    if (typeof IntersectionObserver !== "function") {
      cb();
      return () => undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          cb();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  };

  const intro = (steps: IntroStep[]) => runIntro(steps, instant());

  return {
    get reduced() {
      return reduced;
    },
    still: flags.still,
    get instant() {
      return instant();
    },
    tween,
    flip,
    countUp,
    revealOnce,
    intro,
    preference: () => pref,
    setPreference(reduce) {
      pref = reduce ? true : null;
      if (reduce) storageSet(STORAGE_KEYS.reducedMotion, "1");
      else storageRemove(STORAGE_KEYS.reducedMotion);
      refresh();
    },
    onMotionChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    destroy() {
      mql?.removeEventListener("change", refresh);
      for (const h of Array.from(running.values())) h.cancel();
      listeners.clear();
    },
  };
}
