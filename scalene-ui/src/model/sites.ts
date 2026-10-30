/**
 * Largest allocation sites for the Memory section (DESIGN.md §4.13.3):
 * lines ranked by peak (`n_peak_mb`) or by allocated volume (`n_malloc_mb`),
 * with leaks outside the top rows pinned at the end, and the default
 * selection (the most likely leak, else #1).
 */

import type { LineM, Model } from "./model";

export type SiteOrder = "peak" | "allocated";

export interface SiteList {
  order: SiteOrder;
  /** Top rows by the order. */
  rows: LineM[];
  /** Leaks not among `rows` ("Possible leaks" group). */
  pinnedLeaks: LineM[];
  /** Candidates beyond `rows` ("Show 25"). */
  more: number;
  /** Default selection: the most likely leak, else rows[0]. */
  defaultSite: LineM | null;
  /** Meter scale: `max_footprint_mb` for peak, row #1 usage for allocated. */
  scale: number;
}

const allocatedCache = new WeakMap<Model, LineM[]>();

function byAllocated(m: Model): LineM[] {
  let list = allocatedCache.get(m);
  if (!list) {
    list = m.files
      .concat(m.hiddenFiles)
      .flatMap((f) => f.lines)
      .filter((l) => l.malloc > 0)
      .sort((a, b) => b.malloc - a.malloc || b.peak - a.peak || a.file.no - b.file.no || a.no - b.no);
    allocatedCache.set(m, list);
  }
  return list;
}

export function allocationSites(m: Model, order: SiteOrder, n = 8): SiteList {
  const ranked = order === "peak" ? m.rank.lines.memory : byAllocated(m);
  const rows = ranked.slice(0, n);
  const shown = new Set(rows);
  const pinnedLeaks = m.leaks.filter((l) => !shown.has(l));
  const scale = order === "peak" ? m.memory?.peak ?? rows[0]?.peak ?? 0 : rows[0]?.usage ?? 0;
  return {
    order,
    rows,
    pinnedLeaks,
    more: Math.max(0, ranked.length - rows.length),
    defaultSite: m.leaks[0] ?? rows[0] ?? null,
    scale,
  };
}
