// Variable-height virtual list (DESIGN.md §4.8.10). The window is the scroller; the
// container is an in-flow element whose height is the sum of item heights. Items in
// [viewportTop − overscan, viewportBottom + overscan] are rendered from per-kind node
// pools and positioned with translateY. DOM order always equals item order.

export interface VItem {
  key: string;
  kind: string;
  height: number | "measure";
  estimate?: number;
}

export interface VirtualList<T extends VItem> {
  setItems(items: readonly T[], keepAnchorKey?: string): void; // keeps the anchor row in place
  scrollToKey(key: string, align: "center" | "start", behavior: ScrollBehavior): Promise<void>;
  elementFor(key: string): HTMLElement | null; // null when not rendered
  visibleKeys(): string[];
  refresh(keys?: string[]): void;
  destroy(): void;
}

export interface VirtualListOptions<T extends VItem> {
  container: HTMLElement; // in-flow element; window is the scroller; holds only item nodes
  render(item: T, reuse: HTMLElement | null): HTMLElement;
  overscanPx?: number; // default 600
  onRange?(first: number, last: number): void;
  /** Height of sticky chrome above the viewport (for centring and visibility). */
  topInset?(): number;
  /** Hard cap on rendered items (default 160). */
  maxRendered?: number;
}

const DEFAULT_ESTIMATE = 120;

/** First index i with offsets[i + 1] > y (offsets has n + 1 entries). */
export function indexAtOffset(offsets: Float64Array, n: number, y: number): number {
  let lo = 0;
  let hi = n - 1;
  if (n <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Prefix sums of heights: offsets[i] = top of item i, offsets[n] = total. */
export function prefixOffsets(heights: Float64Array, out?: Float64Array): Float64Array {
  const n = heights.length;
  const offsets = out && out.length === n + 1 ? out : new Float64Array(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + heights[i];
  return offsets;
}

function waitForScrollEnd(timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let last = window.scrollY;
    let stable = 0;
    const t0 = performance.now();
    const tick = () => {
      const y = window.scrollY;
      stable = y === last ? stable + 1 : 0;
      last = y;
      if (stable >= 3 || performance.now() - t0 > timeoutMs) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function createVirtualList<T extends VItem>(opts: VirtualListOptions<T>): VirtualList<T> {
  const { container } = opts;
  const overscan = opts.overscanPx ?? 600;
  const maxRendered = opts.maxRendered ?? 160;
  const inset = () => opts.topInset?.() ?? 0;

  let items: readonly T[] = [];
  let index = new Map<string, number>();
  let heights: Float64Array = new Float64Array(0);
  let offsets: Float64Array = new Float64Array(1);
  const measured = new Map<string, number>();
  const rendered = new Map<string, HTMLElement>();
  const keyOf = new WeakMap<HTMLElement, string>();
  const kindOf = new WeakMap<HTMLElement, string>();
  const pool = new Map<string, HTMLElement[]>();
  let frame = 0;
  let destroyed = false;

  container.style.position = "relative";
  container.style.setProperty("overflow-anchor", "none");

  const heightOf = (it: T) =>
    typeof it.height === "number" ? it.height : (measured.get(it.key) ?? it.estimate ?? DEFAULT_ESTIMATE);

  const recompute = () => {
    for (let i = 0; i < items.length; i++) heights[i] = heightOf(items[i]);
    offsets = prefixOffsets(heights, offsets);
    container.style.height = `${offsets[items.length]}px`;
  };

  const ro =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          let changedAbove = 0;
          let changed = false;
          const viewTop = -container.getBoundingClientRect().top + inset();
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const key = keyOf.get(el);
            if (key === undefined || rendered.get(key) !== el) continue;
            const hgt = e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
            if (!hgt || measured.get(key) === hgt) continue;
            const i = index.get(key);
            if (i === undefined) continue;
            const prev = heights[i];
            measured.set(key, hgt);
            changed = true;
            if (offsets[i] + prev <= viewTop) changedAbove += hgt - prev;
          }
          if (!changed) return;
          recompute();
          if (changedAbove) window.scrollBy(0, changedAbove);
          update();
        })
      : null;

  const recycle = (key: string, el: HTMLElement) => {
    rendered.delete(key);
    ro?.unobserve(el);
    el.remove();
    const kind = kindOf.get(el) ?? "";
    let list = pool.get(kind);
    if (!list) pool.set(kind, (list = []));
    if (list.length < 64) list.push(el);
  };

  const place = (el: HTMLElement, i: number) => {
    const y = `translateY(${offsets[i]}px)`;
    if (el.style.transform !== y) el.style.transform = y;
  };

  const mount = (it: T, i: number, existing: HTMLElement | null): HTMLElement => {
    const reuse = existing ?? pool.get(it.kind)?.pop() ?? null;
    const el = opts.render(it, reuse);
    if (existing && el !== existing) recycle(it.key, existing);
    if (!el.dataset.vItem) {
      el.dataset.vItem = "";
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.right = "0";
      el.style.top = "0";
    }
    keyOf.set(el, it.key);
    kindOf.set(el, it.kind);
    rendered.set(it.key, el);
    place(el, i);
    if (it.height === "measure") ro?.observe(el);
    else ro?.unobserve(el);
    return el;
  };

  /** Visible index range (no overscan) and the overscanned range, capped. */
  const computeRange = (): [number, number] => {
    const n = items.length;
    if (!n) return [0, -1];
    const top = -container.getBoundingClientRect().top;
    const bottom = top + window.innerHeight;
    if (bottom + overscan < 0 || top - overscan > offsets[n]) return [0, -1];
    let first = indexAtOffset(offsets, n, Math.max(0, top - overscan));
    let last = indexAtOffset(offsets, n, Math.max(0, bottom + overscan));
    if (offsets[last] >= bottom + overscan && last > first) last--;
    if (last - first + 1 > maxRendered) {
      const vFirst = indexAtOffset(offsets, n, Math.max(0, top));
      first = Math.max(0, vFirst - Math.floor((maxRendered - 1) / 4));
      last = Math.min(n - 1, first + maxRendered - 1);
    }
    return [first, last];
  };

  function update(): void {
    if (destroyed) return;
    const [first, last] = computeRange();
    // The row holding keyboard focus stays mounted when scrolled out of range, so focus never
    // falls to <body> and the next Tab continues from it (review round 1).
    const act = document.activeElement;
    let keep: HTMLElement | null = null;
    let keepAt = -1;
    for (const [key, el] of Array.from(rendered)) {
      const i = index.get(key);
      if (i === undefined || items[i].kind !== kindOf.get(el)) recycle(key, el);
      else if (i < first || i > last) {
        if (!keep && act && el.contains(act)) {
          keep = el;
          keepAt = i;
          place(el, i);
        } else recycle(key, el);
      }
    }
    // Walk in item order and keep DOM order equal to visual order.
    // The kept row is never moved (moving a node drops its focus): rows in range are placed
    // around it, after it when it precedes them, before it when it follows them.
    let cursor: Element | null = keep && keepAt < first ? keep.nextElementSibling : container.firstElementChild;
    for (let i = first; i <= last; i++) {
      const it = items[i];
      let el = rendered.get(it.key);
      if (el) place(el, i);
      else el = mount(it, i, null);
      if (cursor === el) {
        cursor = el.nextElementSibling;
      } else {
        container.insertBefore(el, cursor);
      }
    }
    opts.onRange?.(first, last);
  }

  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    }
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });

  const api: VirtualList<T> = {
    setItems(next, keepAnchorKey) {
      // Anchor: the requested key if rendered, else the first visible item.
      let anchorKey: string | null = null;
      let anchorTop = 0;
      const rect = container.getBoundingClientRect();
      const anchorEl = keepAnchorKey ? rendered.get(keepAnchorKey) : undefined;
      if (keepAnchorKey && anchorEl) {
        anchorKey = keepAnchorKey;
        anchorTop = anchorEl.getBoundingClientRect().top;
      } else if (items.length && rect.top < inset()) {
        const i = indexAtOffset(offsets, items.length, inset() - rect.top);
        anchorKey = items[i].key;
        anchorTop = rect.top + offsets[i];
      }

      items = next;
      index = new Map(next.map((it, i) => [it.key, i]));
      heights = new Float64Array(next.length);
      recompute();
      for (const key of Array.from(measured.keys())) if (!index.has(key)) measured.delete(key);

      if (anchorKey !== null) {
        const i = index.get(anchorKey);
        if (i !== undefined) {
          const newTop = container.getBoundingClientRect().top + offsets[i];
          if (Math.abs(newTop - anchorTop) >= 1) window.scrollBy(0, newTop - anchorTop);
        }
      }
      // Re-render items that stay mounted (their data may have changed).
      for (const [key, el] of Array.from(rendered)) {
        const i = index.get(key);
        if (i !== undefined && items[i].kind === kindOf.get(el)) mount(items[i], i, el);
      }
      update();
    },

    async scrollToKey(key, align, behavior) {
      const i = index.get(key);
      if (i === undefined) return;
      const docTop = container.getBoundingClientRect().top + window.scrollY + offsets[i];
      const top = inset();
      const avail = window.innerHeight - top;
      const y = align === "center" ? docTop - top - Math.max(0, (avail - heights[i]) / 2) : docTop - top;
      const target = Math.max(0, Math.round(y));
      if (Math.abs(window.scrollY - target) < 1) {
        update();
        return;
      }
      window.scrollTo({ top: target, behavior });
      if (behavior === "smooth") await waitForScrollEnd();
      update();
    },

    elementFor: (key) => rendered.get(key) ?? null,

    visibleKeys() {
      const n = items.length;
      if (!n) return [];
      const top = -container.getBoundingClientRect().top + inset();
      const bottom = top + window.innerHeight - inset();
      const out: string[] = [];
      for (let i = indexAtOffset(offsets, n, Math.max(0, top)); i < n && offsets[i] < bottom; i++) {
        out.push(items[i].key);
      }
      return out;
    },

    refresh(keys) {
      const list = keys ?? Array.from(rendered.keys());
      for (const key of list) {
        const el = rendered.get(key);
        const i = index.get(key);
        if (el && i !== undefined) mount(items[i], i, el);
      }
      recompute();
      update();
    },

    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      for (const [key, el] of Array.from(rendered)) recycle(key, el);
      pool.clear();
      container.style.height = "";
    },
  };
  return api;
}
