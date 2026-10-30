// Breakpoints (DESIGN.md §2.2). One source of truth for JS and CSS: the same media
// queries drive the `bp-*` / `short` classes on <html> and the token overrides in CSS.
import type { AppState, Breakpoint } from "./store";

export type Layout = AppState["layout"];

export const BREAKPOINTS: readonly Breakpoint[] = ["xs", "sm", "md", "lg", "xl", "xxl"];

const BP_QUERIES: Record<Breakpoint, string> = {
  xs: "(max-width: 599.98px)",
  sm: "(min-width: 600px) and (max-width: 1023.98px)",
  md: "(min-width: 1024px) and (max-width: 1279.98px)",
  lg: "(min-width: 1280px) and (max-width: 1599.98px)",
  xl: "(min-width: 1600px) and (max-width: 2199.98px)",
  xxl: "(min-width: 2200px)",
};
const SHORT_QUERY = "(max-height: 520px)";
const COARSE_QUERY = "(pointer: coarse)";

const MIN_WIDTH: Record<Breakpoint, number> = { xs: 0, sm: 600, md: 1024, lg: 1280, xl: 1600, xxl: 2200 };

/** True when `bp` is at least `min` (e.g. `bpAtLeast(bp, "lg")`). */
export function bpAtLeast(bp: Breakpoint, min: Breakpoint): boolean {
  return BREAKPOINTS.indexOf(bp) >= BREAKPOINTS.indexOf(min);
}

function matches(q: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(q).matches;
}

/** Breakpoint for a CSS width (used when matchMedia is unavailable, and by tests). */
export function bpForWidth(width: number): Breakpoint {
  let bp: Breakpoint = "xs";
  for (const b of BREAKPOINTS) if (width >= MIN_WIDTH[b]) bp = b;
  return bp;
}

export function readLayout(): Layout {
  const bp = BREAKPOINTS.find((b) => matches(BP_QUERIES[b])) ?? bpForWidth(window.innerWidth);
  return { bp, short: matches(SHORT_QUERY), coarse: matches(COARSE_QUERY) };
}

/** Write `bp-<name>` and `short` on <html> (other classes are left alone). */
export function applyLayoutClasses(layout: Layout, root: HTMLElement = document.documentElement): void {
  for (const b of BREAKPOINTS) root.classList.toggle(`bp-${b}`, b === layout.bp);
  root.classList.toggle("short", layout.short);
}

export interface LayoutController {
  current(): Layout;
  destroy(): void;
}

/** Track breakpoint/short/coarse changes; `onChange` fires only when something changed. */
export function createLayout(onChange: (layout: Layout, prev: Layout) => void): LayoutController {
  let layout = readLayout();
  applyLayoutClasses(layout);

  const update = () => {
    const next = readLayout();
    if (next.bp === layout.bp && next.short === layout.short && next.coarse === layout.coarse) return;
    const prev = layout;
    layout = next;
    applyLayoutClasses(layout);
    onChange(layout, prev);
  };

  const lists: MediaQueryList[] =
    typeof window.matchMedia === "function"
      ? [...Object.values(BP_QUERIES), SHORT_QUERY, COARSE_QUERY].map((q) => window.matchMedia(q))
      : [];
  for (const mql of lists) mql.addEventListener("change", update);
  if (!lists.length) window.addEventListener("resize", update);

  return {
    current: () => layout,
    destroy() {
      for (const mql of lists) mql.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    },
  };
}
