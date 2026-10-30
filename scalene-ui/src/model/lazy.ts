/**
 * Lazy, time-sliced derivations (DESIGN.md §6.1.2). A derivation is a
 * generator that `yield`s at convenient points; `runSliced` drives it in
 * slices of at most `budgetMs`, yielding to the event loop in between, so no
 * long task blocks input. DOM-free (core/schedule's `slice` needs only
 * `performance` and timers), so the model runs and is unit-tested in Node.
 */

import { slice } from "../core/schedule";

export const SLICE_BUDGET_MS = 8;

/** Run a generator to completion in ≤ `budgetMs` slices; resolves with its return value. */
export function runSliced<T>(gen: Generator<unknown, T, void>, budgetMs = SLICE_BUDGET_MS): Promise<T> {
  return slice(gen, budgetMs);
}

/** Run a generator synchronously (tests, forced mounts). */
export function runNow<T>(gen: Generator<unknown, T, void>): T {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * A memoised lazy value: the first `get()` starts the sliced computation,
 * later calls share the same promise; `peek()` returns the value once ready.
 */
export class Lazy<T> {
  private promise: Promise<T> | null = null;
  private value: T | undefined;
  private ready = false;

  constructor(private readonly make: () => Generator<unknown, T, void>) {}

  get(): Promise<T> {
    if (!this.promise) {
      this.promise = runSliced(this.make()).then((v) => {
        this.value = v;
        this.ready = true;
        return v;
      });
    }
    return this.promise;
  }

  /** The value if it has been computed, else undefined. */
  peek(): T | undefined {
    return this.ready ? this.value : undefined;
  }

  /** Compute synchronously now (or return the finished value). */
  force(): T {
    if (this.ready) return this.value as T;
    const v = runNow(this.make());
    this.value = v;
    this.ready = true;
    this.promise = Promise.resolve(v);
    return v;
  }
}
