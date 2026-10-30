// Cooperative scheduling: time-sliced work, idle callbacks, frame helpers.

interface PostTaskScheduler {
  postTask(cb: () => void, opts?: { priority?: "user-blocking" | "user-visible" | "background" }): Promise<void>;
}

/** Yield to the event loop (scheduler.postTask when available, else a macrotask). */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: PostTaskScheduler }).scheduler;
  if (sched && typeof sched.postTask === "function") {
    return sched.postTask(() => undefined, { priority: "user-visible" });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Run a generator in slices of at most `budgetMs`. Each `yield` is a checkpoint
 * where the work may pause; the generator's return value resolves the promise.
 */
export async function slice<T>(work: Iterator<unknown, T>, budgetMs = 8): Promise<T> {
  let start = performance.now();
  for (;;) {
    const r = work.next();
    if (r.done) return r.value;
    if (performance.now() - start >= budgetMs) {
      await yieldToMain();
      start = performance.now();
    }
  }
}

/** Run `fn` when the browser is idle (or after `timeout` ms at the latest). */
export function idle(fn: () => void, timeout = 1500): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
}

/** Resolves on the next animation frame. */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
}

/** Coalesce calls into at most one per animation frame (last arguments win). */
export function throttleRaf<A extends unknown[]>(fn: (...args: A) => void): Throttled<A> {
  let frame = 0;
  let pending: A | null = null;
  const run = () => {
    frame = 0;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const t = ((...args: A) => {
    pending = args;
    if (!frame) frame = requestAnimationFrame(run);
  }) as Throttled<A>;
  t.cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
  };
  t.flush = () => {
    if (frame) cancelAnimationFrame(frame);
    run();
  };
  return t;
}

/** Trailing debounce. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let timer = 0;
  let pending: A | null = null;
  const run = () => {
    timer = 0;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const d = ((...args: A) => {
    pending = args;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(run, ms);
  }) as Throttled<A>;
  d.cancel = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    pending = null;
  };
  d.flush = () => {
    if (timer) window.clearTimeout(timer);
    run();
  };
  return d;
}
