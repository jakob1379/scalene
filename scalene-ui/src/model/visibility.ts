/**
 * Row visibility and code-view items (DESIGN.md §4.0.4, §4.8.2, §4.8.5,
 * §4.8.8). Predicates follow upstream `makeProfileLine` / display modes,
 * with the documented fixes: regions are summed by lineno (lines
 * start+1 … end, inclusive), region heads are per file, sparse files get
 * `gap` items, and ranked lists put keyless rows last in both directions.
 */

import type { ColumnKey, DisplayMode, SortState } from "../core/store";
import type { Caps } from "./normalize";
import type { FileM, FunctionM, LineM } from "./model";

/** Upstream `maxLinesPerRegion`: a region head forces visibility only up to this size. */
export const MAX_LINES_PER_REGION = 50;

// ── Per-line predicates ─────────────────────────────────────────────────────

/** `n_avg_mb + n_peak_mb + memory_samples.length + (usage ≥ 0.01 ? 1 : 0) > 0`. */
export function lineHasMem(l: Pick<LineM, "avg" | "peak" | "memSamples" | "usage">): boolean {
  return l.avg + l.peak + l.memSamples.length / 2 + (l.usage >= 0.01 ? 1 : 0) > 0;
}

function hasNeuronTime(l: LineM): boolean {
  return l.neuron !== null && (l.neuron.nrtMs > 0 || l.neuron.ncMs > 0);
}

/** Upstream first-pass predicate for "profiled function" keys (no async, no region clause). */
function profilesFunction(l: LineM, caps: Caps): boolean {
  return l.total > 1.0 || l.hasMem || (caps.gpu && l.gpu >= 1.0) || hasNeuronTime(l);
}

/** Data row without the region-head clause (§4.0.4). */
function isDataLine(l: LineM, caps: Caps): boolean {
  return profilesFunction(l, caps) || (caps.async && l.await >= 1.0);
}

/**
 * Sorted-lineno prefix sums of a per-line quantity, for O(1) region sums
 * over lines `(a, b]` of sparse files.
 */
class LinePrefix {
  private readonly nos: Float64Array;
  private readonly sums: Float64Array;
  constructor(lines: readonly LineM[], value: (l: LineM) => number) {
    this.nos = Float64Array.from(lines, (l) => l.no);
    this.sums = new Float64Array(lines.length + 1);
    lines.forEach((l, i) => (this.sums[i + 1] = this.sums[i] + value(l)));
  }
  /** Number of lines with lineno ≤ x. */
  private upto(x: number): number {
    let lo = 0;
    let hi = this.nos.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.nos[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Σ over lines with a < lineno ≤ b. */
  between(a: number, b: number): number {
    return b <= a ? 0 : this.sums[this.upto(b)] - this.sums[this.upto(a)];
  }
}

/**
 * Set `hasMem`, `regionTotal`, `regionHead` and `cls` on every line of a
 * file. `cls`: "data" rows are always shown; "context" rows (other lines of a
 * profiled function) show in "Profiled functions"; "empty" only in "All".
 */
export function classifyRows(file: FileM, caps: Caps): void {
  const lines = file.lines;
  for (const l of lines) l.hasMem = lineHasMem(l);
  const time = new LinePrefix(lines, (l) => l.total);
  const mem = new LinePrefix(lines, (l) => (l.hasMem ? 1 : 0));
  const seenRegions = new Set<string>();
  const profiledFns = new Set<string>();
  for (const l of lines) {
    if (l.fnRange && profilesFunction(l, caps)) profiledFns.add(`${l.fnRange[0]},${l.fnRange[1]}`);
  }
  for (const l of lines) {
    const [s, e] = l.region;
    const multi = s !== e;
    l.regionTotal = multi ? time.between(s, e) : l.total;
    l.regionHead = false;
    if (multi) {
      const key = `${s},${e}`;
      if (!seenRegions.has(key)) {
        seenRegions.add(key);
        l.regionHead = true;
      }
    }
    const hotHead =
      l.regionHead && s > 0 && e > 0 && e - s <= MAX_LINES_PER_REGION && (l.regionTotal >= 1.0 || mem.between(s, e) > 0);
    if (isDataLine(l, caps) || hotHead) l.cls = "data";
    else if (l.fnRange && profiledFns.has(`${l.fnRange[0]},${l.fnRange[1]}`)) l.cls = "context";
    else l.cls = "empty";
  }
}

/** Whether the display mode shows a line (before folds are revealed). */
export function shownInMode(l: LineM, mode: DisplayMode): boolean {
  if (mode === "all") return true;
  if (mode === "profiled-lines") return l.cls === "data";
  return l.cls !== "empty";
}

// ── Sorting ─────────────────────────────────────────────────────────────────

/** Sort key of a line for a column, or null when the column has no key. */
export function sortValue(l: LineM, key: ColumnKey): number | null {
  switch (key) {
    case "time":
      return l.total;
    case "mem":
      return l.peak;
    case "gpu":
      return l.gpu;
    case "await":
      return l.await;
    case "idle":
      return l.neuron?.idlePct ?? null;
    case "nrt":
      return l.neuron ? l.neuron.nrtMs || l.neuron.nrtPct : null;
    case "nc":
      return l.neuron ? l.neuron.ncMs : null;
    case "copy":
      return l.copy;
    case "gpumem":
      return l.gpuPeak;
    case "alloc":
      return l.usage;
    case "avg":
      return l.avg;
    default:
      return null;
  }
}

export function isSortable(key: ColumnKey): boolean {
  return key !== "trend" && key !== "source";
}

/** Rank rows by a column: keyless / zero rows last in both directions, ties by lineno. */
export function rankLines(lines: readonly LineM[], sort: SortState): LineM[] {
  const dir = sort.dir === "desc" ? -1 : 1;
  return lines
    .map((l) => ({ l, v: sortValue(l, sort.key) }))
    .sort((a, b) => {
      const ka = a.v !== null && a.v !== 0;
      const kb = b.v !== null && b.v !== 0;
      if (ka !== kb) return ka ? -1 : 1;
      if (ka && kb && a.v !== b.v) return dir * ((a.v as number) - (b.v as number));
      return a.l.no - b.l.no;
    })
    .map((x) => x.l);
}

// ── Code items ──────────────────────────────────────────────────────────────

export type CodeItem =
  | { kind: "line"; key: string; line: LineM }
  | { kind: "fold"; key: string; start: number; end: number; count: number; total: number }
  | { kind: "gap"; key: string; start: number; end: number; count: number }
  | { kind: "fnHeader"; key: string; fn: FunctionM }
  | { kind: "lens"; key: string; anchor: string }
  | { kind: "aiCard"; key: string; line: number };

export interface CodeExtras {
  /** Item key the lens follows (a line or function header), if open. */
  lensAfter?: string | null;
  /** Lines that carry an AI proposal card (anchor start lines). */
  aiAnchors?: readonly number[];
}

export const lineItemKey = (no: number): string => `L:${no}`;
export const foldItemKey = (start: number): string => `F:${start}`;
export const fnItemKey = (fn: FunctionM): string => `H:${fn.no}`;
export const aiItemKey = (no: number): string => `ai:${no}`;
export const LENS_KEY = "lens";

/** A run of hidden lines (pass 1); `start`/`end` may span lines missing from a sparse file. */
interface HiddenRun {
  start: number;
  end: number;
  lines: LineM[];
  total: number;
}

type Piece =
  | { kind: "line"; line: LineM }
  | { kind: "run"; run: HiddenRun }
  | { kind: "gap"; start: number; end: number }
  | { kind: "fn"; fn: FunctionM };

/** Accumulates pieces; hidden lines collect into the open run until something shown flushes it. */
class StructureBuilder {
  readonly out: Piece[] = [];
  private run: HiddenRun | null = null;

  get inRun(): boolean {
    return this.run !== null;
  }
  /** Close the open run (if any), then append a shown piece. */
  push(p: Piece): void {
    this.flush();
    this.out.push(p);
  }
  hide(l: LineM): void {
    if (this.run) {
      this.run.end = l.no;
      this.run.lines.push(l);
      this.run.total += l.total;
    } else this.run = { start: l.no, end: l.no, lines: [l], total: l.total };
  }
  /** Missing lines `a … b` (sparse files) join the open run, or open one. */
  absorb(a: number, b: number): void {
    if (this.run) this.run.end = b;
    else this.run = { start: a, end: b, lines: [], total: 0 };
  }
  flush(): void {
    if (this.run) this.out.push({ kind: "run", run: this.run });
    this.run = null;
  }
}

/**
 * Pass 1: the file's structure under a display mode. Hidden runs are split
 * at function starts (so headers stay in place) and absorb missing lines
 * next to them (missing lines have no samples either); missing lines between
 * two shown lines become `gap`s.
 */
function structure(file: FileM, mode: DisplayMode): Piece[] {
  const b = new StructureBuilder();
  const fns = file.functions;
  let fi = 0;
  let prev = 0;
  for (const l of file.lines) {
    const shown = shownInMode(l, mode);
    if (l.no > prev + 1) {
      if (mode !== "all" && (b.inRun || !shown)) b.absorb(prev + 1, l.no - 1);
      else b.push({ kind: "gap", start: prev + 1, end: l.no - 1 });
    }
    while (fi < fns.length && fns[fi].no <= l.no) b.push({ kind: "fn", fn: fns[fi++] });
    if (shown) b.push({ kind: "line", line: l });
    else b.hide(l);
    prev = l.no;
  }
  b.flush();
  return b.out;
}

/** Start of the fold that hides `lineno` under `mode`, or null when it is shown. */
export function foldStartFor(file: FileM, mode: DisplayMode, lineno: number): number | null {
  for (const p of structure(file, mode)) {
    if (p.kind === "run" && lineno >= p.run.start && lineno <= p.run.end) return p.run.start;
  }
  return null;
}

/** Lines shown under `mode` with the given folds revealed, in source order. */
export function visibleLines(file: FileM, mode: DisplayMode, unfolded: readonly number[] = []): LineM[] {
  const open = new Set(unfolded);
  const out: LineM[] = [];
  for (const p of structure(file, mode)) {
    if (p.kind === "line") out.push(p.line);
    else if (p.kind === "run" && open.has(p.run.start)) out.push(...p.run.lines);
  }
  return out;
}

function pushRevealed(items: CodeItem[], run: HiddenRun): void {
  let prev = run.start - 1;
  for (const l of run.lines) {
    if (l.no > prev + 1) items.push(gapItem(prev + 1, l.no - 1));
    items.push({ kind: "line", key: lineItemKey(l.no), line: l });
    prev = l.no;
  }
  if (run.end > prev) items.push(gapItem(prev + 1, run.end));
}

function gapItem(start: number, end: number): CodeItem {
  return { kind: "gap", key: `G:${start}`, start, end, count: end - start + 1 };
}

/**
 * The code view's item list for one file. Source order (sort null or "#")
 * has function headers, folds and gaps; ranked order lists the visible rows
 * only. The lens and AI cards follow their anchor rows in both.
 */
export function buildCodeItems(
  file: FileM,
  mode: DisplayMode,
  sort: SortState | null,
  unfolded: readonly number[],
  extras: CodeExtras = {},
): CodeItem[] {
  const items: CodeItem[] = [];
  if (sort && sort.key !== "line" && isSortable(sort.key)) {
    for (const l of rankLines(visibleLines(file, mode, unfolded), sort)) {
      items.push({ kind: "line", key: lineItemKey(l.no), line: l });
    }
  } else {
    const open = new Set(unfolded);
    for (const p of structure(file, mode)) {
      if (p.kind === "line") items.push({ kind: "line", key: lineItemKey(p.line.no), line: p.line });
      else if (p.kind === "gap") items.push(gapItem(p.start, p.end));
      else if (p.kind === "fn") items.push({ kind: "fnHeader", key: fnItemKey(p.fn), fn: p.fn });
      else if (open.has(p.run.start)) pushRevealed(items, p.run);
      else {
        const { start, end, total } = p.run;
        items.push({ kind: "fold", key: foldItemKey(start), start, end, count: end - start + 1, total });
      }
    }
  }
  return insertExtras(items, extras);
}

function insertExtras(items: CodeItem[], extras: CodeExtras): CodeItem[] {
  const ai = new Set(extras.aiAnchors ?? []);
  const lensAfter = extras.lensAfter ?? null;
  if (ai.size === 0 && lensAfter === null) return items;
  const out: CodeItem[] = [];
  for (const it of items) {
    out.push(it);
    if (it.key === lensAfter) out.push({ kind: "lens", key: LENS_KEY, anchor: it.key });
    if (it.kind === "line" && ai.has(it.line.no)) out.push({ kind: "aiCard", key: aiItemKey(it.line.no), line: it.line.no });
  }
  return out;
}

/** "193 lines, 41 shown" for the file bar. */
export function shownCount(file: FileM, mode: DisplayMode, unfolded: readonly number[] = []): number {
  return visibleLines(file, mode, unfolded).length;
}
