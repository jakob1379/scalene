// The code table (DESIGN.md §4.8): a virtualized `role=table` over one file's items
// (line rows, folds, gaps, function headers, the inline lens and AI cards), with every
// metric column that fits, two-line sortable headers, the heat wash, row actions, roving
// keyboard focus, FLIP re-ranking (M9), the lens motion (M16), the jump flash (M14) and
// the ribbon minimap beside it. One instance lives for the section; it switches files.
import { EASE_CSS, DUR } from "../../core/motion";
import { h } from "../../core/dom";
import { icon } from "../../core/icons";
import { fmtCount, fmtMem, fmtPct, fmtTime, fmtUtil } from "../../core/format";
import { meter } from "../../charts/meter";
import type { Breakpoint, ColumnKey, DisplayMode, SortState, Target } from "../../core/store";
import { createVirtualList, type VirtualList } from "../../core/virtual";
import type { FileM, FunctionM, LineM, Model } from "../../model/model";
import { functionAt } from "../../model/model";
import { highlightCached } from "../../model/syntax";
import { heatMetric, heatOf, HEAT_WASH, profileColumns, type HeatMetric } from "../../model/thresholds";
import {
  buildCodeItems,
  fnItemKey,
  foldStartFor,
  isSortable,
  lineItemKey,
  LENS_KEY,
  type CodeItem,
} from "../../model/visibility";
import type { ViewContext } from "../app";
import { renderAiCard } from "../ai/card";
import {
  COLUMN_SPECS,
  cellEnv,
  cellTooltip,
  fitColumns,
  fixedWidth,
  gridTemplate,
  headerCell,
  headerTooltip,
  refocusHeader,
  renderLineCell,
  rowAriaLabel,
  timeSegments,
  type CellEnv,
} from "./columns";
import type { DetailHandle, DetailSubject } from "./detail";
import { detailLabel } from "./detail";
import { createMinimap, type Minimap, type MinimapPin } from "./minimap";
import { expandSpans, expandTabs, hangFor, leadingColumns, renderSpans, renderWrappedSpans, wrapBreaks } from "./source";

export interface PerFile {
  mode: DisplayMode;
  sort: SortState | null;
  unfolded: number[];
}

export const DEFAULT_PER_FILE: PerFile = { mode: "profiled-functions", sort: null, unfolded: [] };

export type VRow = { key: string; kind: CodeItem["kind"]; height: number | "measure"; estimate?: number; item: CodeItem };

export interface CodeTableOptions {
  ctx: ViewContext;
  detail: DetailHandle;
  /** Breakpoint now. */
  bp(): Breakpoint;
  /** Sticky chrome above the body (app bar + file bar + column header), CSS px. */
  inset(): number;
  /** Lens below xl (true) or dock (false). */
  useLens(): boolean;
  lensColumns(): number;
  /** Shown/total line counts changed (file bar). */
  onCounts?(shown: number, total: number): void;
  /** The ranked state changed (toolbar chip). */
  onSortChange?(sort: SortState | null): void;
}

export interface CodeTable {
  /** The frame element (table + ribbon column). */
  el: HTMLElement;
  table: HTMLElement;
  setFile(file: FileM, opts?: { crossfade?: boolean }): void;
  file(): FileM | null;
  /** Re-read the per-file state and selection from the store and rebuild. */
  sync(): void;
  /** Breakpoint, width or wrap changed. */
  relayout(): void;
  /** Theme changed: redraw canvases, re-measure the code font. */
  redraw(): void;
  /** §4.8.12 steps 2–8 for the current file. */
  reveal(target: Target, opts: { focus?: boolean; open?: boolean; flash?: boolean }): Promise<void>;
  setPins(pins: MinimapPin[]): void;
  isLensOpen(): boolean;
  closeLens(): void;
  /** Rows that are data rows but not present in the items (should be none). */
  debug(): { items: readonly CodeItem[]; columns: ColumnKey[]; rendered: number };
  destroy(): void;
}

const FN_ROW_H = 32;
const LENS_ESTIMATE = 300;
const AI_ESTIMATE = 150;
/** First-open lens height estimate by grid columns (measured afterwards). */
const lensEstimateFor = (cols: number): number => (cols >= 3 ? 400 : cols === 2 ? 560 : 900);
const FLIP_MAX = 60;
const RIBBON_W: Partial<Record<Breakpoint, number>> = { md: 48, lg: 56, xl: 56, xxl: 56 };

interface RowEl extends HTMLElement {
  _sig?: string;
  _key?: string;
}

function lineOf(item: CodeItem): LineM | null {
  return item.kind === "line" ? item.line : null;
}

function isFocusable(item: CodeItem): boolean {
  return item.kind === "line" || item.kind === "fold" || item.kind === "fnHeader";
}

function stillMotion(): boolean {
  const c = document.documentElement.classList;
  return c.contains("motion-reduce") || c.contains("motion-still");
}

export function ribbonWidth(bp: Breakpoint, short: boolean): number {
  return short ? 0 : RIBBON_W[bp] ?? 0;
}

/**
 * Fold row copy (§4.8.2, round 1), worded by what the folded lines hold:
 *   nothing at all       → "15 lines without samples · 1–15"
 *   some time (≤ 1 % each) → "32 lines below 1% each · 19–50 · together 0.2% of run"
 * Folded lines are never data rows (§4.0.4), so each one is at most 1 % of the run.
 */
export function foldText(file: FileM, start: number, end: number, total: number): string {
  let any = total > 0;
  let max = 0;
  for (let n = start; n <= end; n++) {
    const l = file.byNo.get(n);
    if (!l) continue;
    if (l.total > max) max = l.total;
    if (!any && (l.total > 0 || l.cpuTimes.length > 0 || l.peak > 0 || l.memSamples.length > 0 || l.gpu > 0 || l.await > 0)) any = true;
  }
  const count = end - start + 1;
  const range = start === end ? String(start) : `${start}–${end}`;
  const lines = `${fmtCount(count)} line${count === 1 ? "" : "s"}`;
  if (!any) return `${lines} without samples · ${range}`;
  const bound = max >= 1 ? "at most 1%" : "below 1%";
  const cost = total > 0 ? (count === 1 ? ` · ${fmtPct(total)} of run` : ` · together ${fmtPct(total)} of run`) : "";
  return `${lines} ${bound}${count === 1 ? "" : " each"} · ${range}${cost}`;
}

export function createCodeTable(o: CodeTableOptions): CodeTable {
  const { ctx, detail } = o;
  const m: Model = ctx.model;
  const present = profileColumns(m);

  // ── DOM skeleton ──────────────────────────────────────────────────────────
  const headRow = h("div", { class: "cv-head-row", role: "row", "aria-rowindex": "1" });
  const head = h("div", { class: "cv-head", role: "rowgroup" }, headRow);
  const body = h("div", { class: "cv-body", role: "rowgroup" });
  const table = h("div", { class: "cv-table", role: "table" }, head, body);
  const measureEl = h("span", { class: "cv-measure code", "aria-hidden": "true" }, "0".repeat(100));
  const ribbonSpacer = h("div", { class: "cv-ribbon-head", "aria-hidden": "true" });
  const ribbonCol = h("div", { class: "cv-ribbon-col" }, ribbonSpacer);
  const frame = h("div", { class: "cv-frame" }, table, ribbonCol, measureEl);

  // ── State ─────────────────────────────────────────────────────────────────
  let file: FileM | null = null;
  /** Bumped on every file switch; part of every row signature. */
  let fileGen = 0;
  let per: PerFile = DEFAULT_PER_FILE;
  let items: CodeItem[] = [];
  let index = new Map<string, number>();
  let columns: ColumnKey[] = ["line", "time", "source"];
  let colSig = "";
  let layoutSig = "";
  let env: CellEnv = cellEnv(m, o.bp(), ctx.theme);
  let heat: HeatMetric = "time";
  let rowH = 24;
  let charW = 7.8;
  let colsPerLine = 80;
  let wrap = ctx.store.get().code.wrap;
  /** Visual rows per line in wrap mode (index = position in `file.lines`), for `wrapCpl`. */
  let wrapRows: Int32Array | null = null;
  let wrapCpl = 0;
  let selKey: string | null = null;
  let lensOpen = false;
  let focusKey: string | null = null;
  let hoverKey: string | null = null;
  let linkedKey: string | null = null;
  let tipCell: HTMLElement | null = null;
  let destroyed = false;
  let batching = false;
  let lastCounts = "";

  const lensRow = h("div", { class: "cv-row cv-lens-row", role: "row" });
  const lensCell = h("div", { class: "cv-lens-cell", role: "cell" });
  const lensBox = h("div", { class: "cv-lens", role: "region" });
  lensCell.append(lensBox);
  lensRow.append(lensCell);
  const aiRows = new Map<string, HTMLElement>();

  // ── Minimap ───────────────────────────────────────────────────────────────
  const minimap: Minimap = createMinimap({
    ctx,
    inset: () => o.inset(),
    onScrub: (line) => scrollToLine(line, "auto"),
    onActivate: (line) => {
      if (file) void ctx.nav.jumpTo({ file: file.name, line }, { source: "minimap" });
    },
  });
  ribbonCol.append(minimap.el);

  // ── Measurements ──────────────────────────────────────────────────────────
  const readRowH = () => {
    const v = parseFloat(getComputedStyle(table).getPropertyValue("--row-h"));
    rowH = Number.isFinite(v) && v > 0 ? v : 24;
  };
  const measureChar = () => {
    const w = measureEl.getBoundingClientRect().width;
    if (w > 0) charW = w / 100;
  };
  const ribbonW = () => ribbonWidth(o.bp(), ctx.store.get().layout.short);

  const sourcePad = 24; // 12 px each side of the code text
  /** Width of the code text box (source cell minus its padding), CSS px. */
  let srcTextW = 600;
  /** Visual columns of a line (tabs expanded). */
  const textColsOf = (l: LineM): number => expandTabs(l.text).length;

  const computeColumns = () => {
    const bp = o.bp();
    const width = table.getBoundingClientRect().width || frame.getBoundingClientRect().width - ribbonW();
    columns = fitColumns(present, width, bp, ctx.store.get().layout.short);
    const sig = `${bp}|${columns.join(",")}`;
    const srcW = Math.max(40, width - fixedWidth(columns, bp) - sourcePad);
    srcTextW = srcW;
    colsPerLine = Math.max(8, Math.floor(srcW / charW));
    frame.style.setProperty("--cv-cols", gridTemplate(columns, bp));
    frame.style.setProperty("--cv-cpl", String(colsPerLine));
    frame.style.setProperty("--cv-ribbon-w", `${ribbonW()}px`);
    frame.style.setProperty("--cv-line-w", `${COLUMN_SPECS.line.width}px`);
    frame.classList.toggle("has-ribbon", ribbonW() > 0);
    minimap.el.hidden = ribbonW() === 0;
    if (sig !== colSig) {
      colSig = sig;
      env = cellEnv(m, bp, ctx.theme);
      renderHead();
    }
  };

  /** Word-aware wrap points of a line at the current width (§4.8.10, `source.ts`). */
  const breaksOf = (l: LineM): number[] => {
    const t = expandTabs(l.text);
    return wrapBreaks(t, colsPerLine, hangFor(leadingColumns(t), colsPerLine));
  };
  const ensureWrapRows = () => {
    if (!file) return;
    if (wrapRows && wrapCpl === colsPerLine && wrapRows.length === file.lines.length) return;
    wrapCpl = colsPerLine;
    wrapRows = new Int32Array(file.lines.length);
    file.lines.forEach((l, i) => {
      wrapRows![i] = breaksOf(l).length + 1;
    });
  };

  // Wrapped heights (§4.8.10), deterministic: rowH × visual rows (continuations hang under the indent).
  let lineIdx = new Map<number, number>();
  const lineHeightFast = (l: LineM): number => {
    if (!wrap) return rowH;
    ensureWrapRows();
    const i = lineIdx.get(l.no);
    const rows = i !== undefined && wrapRows ? wrapRows[i] : breaksOf(l).length + 1;
    return rowH * rows;
  };

  // ── Header ────────────────────────────────────────────────────────────────
  let headDisposers: (() => void)[] = [];

  function sortOf(key: ColumnKey): "ascending" | "descending" | "none" {
    const s = per.sort;
    if (key === "line") return !s || s.key === "line" ? "ascending" : "none";
    if (!s || s.key !== key) return "none";
    return s.dir === "desc" ? "descending" : "ascending";
  }

  function renderHead(): void {
    for (const d of headDisposers) d();
    headDisposers = [];
    const fileName = file?.base ?? "";
    // Rebuilding the header must not drop keyboard focus (WCAG 2.4.3): remember which
    // column's control had it and focus the same column's control afterwards.
    const ae = document.activeElement;
    const col = ae && headRow.contains(ae) ? ae.closest<HTMLElement>(".cv-h")?.dataset.col : null;
    headRow.replaceChildren(
      ...columns.map((key) => {
        const name = key === "gpu" ? env.gpuLabel : key === "gpumem" ? `${env.gpuLabel} mem` : COLUMN_SPECS[key].name;
        const unit = key === "source" ? fileName : COLUMN_SPECS[key].unit;
        const label = key === "line" ? "Line number: source order" : `${name} (${unit}): rank lines`;
        return headerCell(key, name, unit, sortOf(key), label, () => cycleSort(key), ctx.tooltip, () => headerTooltip(key, env.gpuLabel, fileName), headDisposers);
      }),
    );
    refocusHeader(headRow, col);
  }

  function cycleSort(key: ColumnKey): void {
    if (!file) return;
    let next: SortState | null;
    const s = per.sort;
    if (key === "line" || !isSortable(key)) next = null;
    else if (!s || s.key !== key) next = { key, dir: "desc" };
    else if (s.dir === "desc") next = { key, dir: "asc" };
    else next = null;
    writePer({ sort: next });
    const label = COLUMN_SPECS[key].name;
    ctx.announce.polite(next ? `Ranked by ${label}, ${next.dir === "desc" ? "descending" : "ascending"}` : "Source order");
  }

  function writePer(patch: Partial<PerFile>): void {
    if (!file) return;
    const name = file.name;
    ctx.store.update((s) => {
      const cur = s.code.perFile[name] ?? DEFAULT_PER_FILE;
      return { code: { ...s.code, perFile: { ...s.code.perFile, [name]: { ...cur, ...patch } } } };
    });
  }

  // ── Items ─────────────────────────────────────────────────────────────────
  const aiAnchorsOf = (f: FileM): number[] =>
    ctx.ai
      .anchors(f.name)
      .map((a) => Number(a.slice(a.lastIndexOf(":") + 1)))
      .filter((n) => Number.isFinite(n));

  const toVRows = (list: CodeItem[]): VRow[] =>
    list.map((it) => {
      switch (it.kind) {
        case "line":
          return { key: it.key, kind: it.kind, height: lineHeightFast(it.line), item: it };
        case "fnHeader":
          return { key: it.key, kind: it.kind, height: FN_ROW_H, item: it };
        case "lens":
          // Keyed per subject so the list never reuses another line's lens height.
          return { key: `${it.key}@${selKey ?? ""}`, kind: it.kind, height: "measure", estimate: measuredH.get(LENS_KEY) ?? lensEstimateFor(o.lensColumns()), item: it };
        case "aiCard":
          return { key: it.key, kind: it.kind, height: "measure", estimate: AI_ESTIMATE, item: it };
        default:
          return { key: it.key, kind: it.kind, height: rowH, item: it };
      }
    });

  const showLens = () => o.useLens() && lensOpen && selKey !== null;

  function buildItems(): void {
    if (!file) {
      items = [];
      index = new Map();
      return;
    }
    const ranked = per.sort !== null && per.sort.key !== "line";
    items = buildCodeItems(file, per.mode, per.sort, per.unfolded, {
      lensAfter: showLens() ? selKey : null,
      aiAnchors: aiAnchorsOf(file),
    });
    // A lens anchored to a row that is not listed (e.g. folded) cannot render.
    if (showLens() && !items.some((it) => it.kind === "lens")) lensOpen = false;
    index = new Map(items.map((it, i) => [it.key, i]));
    table.setAttribute("aria-rowcount", String(items.length + 1));
    table.classList.toggle("is-ranked", ranked);
    const shown = items.reduce((a, it) => a + (it.kind === "line" ? 1 : 0), 0);
    const counts = `${file.name}|${shown}|${file.lines.length}`;
    if (counts !== lastCounts) {
      lastCounts = counts;
      o.onCounts?.(shown, file.lines.length);
    }
  }

  // ── Row rendering ─────────────────────────────────────────────────────────
  const rowIndexAttr = (key: string) => String((index.get(key) ?? 0) + 2);

  function applyRowState(el: RowEl, key: string): void {
    el.setAttribute("aria-rowindex", rowIndexAttr(key));
    const it = items[index.get(key) ?? -1];
    const focusable = it ? isFocusable(it) : false;
    el.tabIndex = focusable ? (key === effectiveFocusKey() ? 0 : -1) : -1;
    el.classList.toggle("is-selected", key === selKey);
    el.classList.toggle("is-linked", key === linkedKey && key !== selKey);
    el.classList.toggle("has-lens", key === selKey && showLens());
  }

  function renderLine(el: RowEl | null, l: LineM, key: string): RowEl {
    const row = (el ?? h("div", { class: "cv-row cv-line", role: "row" })) as RowEl;
    // Keys repeat across files (L:51 in every file): the file generation is part of the signature.
    const sig = `${fileGen}|${key}|${colSig}|${heat}|${wrap ? colsPerLine : 0}|${env.colors.theme}`;
    if (row._sig !== sig) {
      row._sig = sig;
      row._key = key;
      row.dataset.key = key;
      // Cells: rebuild only when the column set changed.
      const cellSig = row.dataset.cols;
      if (cellSig !== colSig) {
        row.replaceChildren(
          ...columns.map((c) => {
            const cell = h("div", { class: ["cv-c", `cv-c-${c}`], role: "cell", dataset: { col: c } });
            if (c === "source") cell.append(h("span", { class: "cv-src code" }));
            return cell;
          }),
        );
        row.dataset.cols = colSig;
      }
      const cells = row.children;
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        const cell = cells[i] as HTMLElement;
        if (c === "line") {
          cell.textContent = String(l.no);
        } else if (c === "source") {
          const src = cell.firstElementChild as HTMLElement;
          const spans = expandSpans(highlightCached(`${l.file.name}:${l.no}`, l.text, l.doc));
          src.replaceChildren(...(wrap ? renderWrappedSpans(spans, breaksOf(l)) : renderSpans(spans)));
          if (wrap) {
            const hang = hangFor(leadingColumns(l.text), colsPerLine);
            src.style.paddingLeft = `${hang}ch`;
            src.style.textIndent = `-${hang}ch`;
          } else if (src.style.paddingLeft) {
            src.style.paddingLeft = "";
            src.style.textIndent = "";
          }
          cell.querySelector(".cv-acts")?.remove();
          delete cell.dataset.acts;
        } else {
          renderLineCell(cell, c, l, env);
        }
      }
      row.classList.toggle("is-data", l.cls === "data");
      row.classList.toggle("is-doc", l.doc);
      row.classList.toggle("is-leak", l.leak !== null);
      const hv = heatOf(m, l, heat);
      row.style.setProperty("--heat", hv > 0 ? hv.toFixed(3) : "0");
      row.setAttribute("aria-label", rowAriaLabel(l, m, present));
    }
    // Unwrapped lines wider than the code box fade out at the right edge (CSS `.is-clipped`),
    // never a hard cut mid-glyph; the tooltip and the detail panel show the whole line.
    row.classList.toggle("is-clipped", !wrap && textColsOf(l) * charW > srcTextW + 0.5);
    applyRowState(row, key);
    syncRowActions(row, l, key);
    return row;
  }

  function renderFn(el: RowEl | null, fn: FunctionM, key: string): RowEl {
    const row = (el ?? h("div", { class: "cv-row cv-fn", role: "row" })) as RowEl;
    const sig = `${fileGen}|${key}|${columns.length}`;
    if (row._sig !== sig) {
      row._sig = sig;
      row._key = key;
      row.dataset.key = key;
      const maxFn = m.rank.functions.time[0]?.total ?? fn.total;
      const stats: (HTMLElement | null)[] = [];
      if (fn.total > 0) stats.push(h("span", { class: "cv-fn-stat" }, h("b", null, fmtPct(fn.total)), ` of run · ${fmtTime(fn.sec)}`));
      if (m.caps.memory && fn.peak > 0) stats.push(h("span", { class: "cv-fn-stat" }, "peak ", h("b", null, fmtMem(fn.peak))));
      if (m.caps.gpu && fn.gpu >= 1) stats.push(h("span", { class: "cv-fn-stat" }, `${env.gpuLabel} `, h("b", null, fmtUtil(fn.gpu))));
      if (m.caps.async && fn.await >= 1) stats.push(h("span", { class: "cv-fn-stat" }, "await ", h("b", null, fmtPct(fn.await))));
      row.replaceChildren(
        h("div", { class: "cv-c cv-fn-icon", role: "cell" }, icon("fn", 14)),
        h(
          "div",
          { class: "cv-c cv-fn-body", role: "cell", "aria-colspan": String(Math.max(1, columns.length - 1)) },
          h("span", { class: "cv-fn-name" }, `${fn.name}()`),
          fn.total > 0
            ? h("span", { class: "cv-fn-meter" }, meter(document, { segments: timeSegments(fn.py, fn.nat, fn.sys), max: maxFn || fn.total, height: 4 }))
            : null,
          stats,
          fn.coro ? h("span", { class: "badge badge-neutral" }, "coroutine") : null,
        ),
      );
      const bits = [`Function ${fn.name}`, fn.total > 0 ? `${fmtPct(fn.total)} of run time, ${fmtTime(fn.sec)}` : "no CPU time sampled"];
      if (m.caps.memory && fn.peak > 0) bits.push(`peak ${fmtMem(fn.peak)}`);
      if (m.caps.gpu && fn.gpu >= 1) bits.push(`GPU ${fmtUtil(fn.gpu)}`);
      row.setAttribute("aria-label", bits.join(", "));
    }
    applyRowState(row, key);
    return row;
  }

  function renderFold(el: RowEl | null, it: Extract<CodeItem, { kind: "fold" }>): RowEl {
    const row = (el ?? h("div", { class: "cv-row cv-fold", role: "row" })) as RowEl;
    const sig = `${fileGen}|${it.key}|${it.count}|${columns.length}`;
    if (row._sig !== sig) {
      row._sig = sig;
      row._key = it.key;
      row.dataset.key = it.key;
      const text = file ? foldText(file, it.start, it.end, it.total) : `${fmtCount(it.count)} lines`;
      row.replaceChildren(
        h(
          "div",
          { class: "cv-c cv-fold-cell", role: "cell", "aria-colspan": String(columns.length) },
          h(
            "button",
            { type: "button", class: "cv-fold-btn", tabindex: "-1", "aria-expanded": "false", "aria-label": `Show ${text}` },
            h("span", { class: "cv-fold-mark", "aria-hidden": "true" }, icon("unfold", 14)),
            h("span", { class: "cv-fold-text" }, text),
          ),
        ),
      );
      row.setAttribute("aria-label", `Folded: ${text}`);
    }
    applyRowState(row, it.key);
    return row;
  }

  function renderGap(el: RowEl | null, it: Extract<CodeItem, { kind: "gap" }>): RowEl {
    const row = (el ?? h("div", { class: "cv-row cv-gap", role: "row" })) as RowEl;
    const sig = `${fileGen}|${it.key}|${it.count}|${columns.length}`;
    if (row._sig !== sig) {
      row._sig = sig;
      row._key = it.key;
      row.dataset.key = it.key;
      const range = it.start === it.end ? String(it.start) : `${it.start}–${it.end}`;
      row.replaceChildren(
        h(
          "div",
          { class: "cv-c cv-gap-cell", role: "cell", "aria-colspan": String(columns.length) },
          h("span", { class: "cv-fold-mark", "aria-hidden": "true" }, "⋯"),
          `${fmtCount(it.count)} line${it.count === 1 ? "" : "s"} not in this profile · ${range}`,
        ),
      );
    }
    applyRowState(row, it.key);
    return row;
  }

  function renderLens(): HTMLElement {
    (lensRow as RowEl)._key = LENS_KEY;
    lensCell.setAttribute("aria-colspan", String(columns.length));
    lensRow.setAttribute("aria-rowindex", rowIndexAttr(LENS_KEY));
    if (detail.el.parentElement !== lensBox) lensBox.append(detail.el);
    return lensRow;
  }

  function renderAi(it: Extract<CodeItem, { kind: "aiCard" }>): HTMLElement {
    if (!file) return h("div");
    const anchor = `${file.name}:${it.line}`;
    let row = aiRows.get(anchor);
    if (!row) {
      row = h("div", { class: "cv-row cv-ai-row", role: "row" }, h("div", { class: "cv-ai-cell", role: "cell" }));
      aiRows.set(anchor, row);
      sizeRo.observe(row);
    }
    (row as RowEl)._key = it.key;
    const cell = row.firstElementChild as HTMLElement;
    cell.setAttribute("aria-colspan", String(columns.length));
    row.setAttribute("aria-rowindex", rowIndexAttr(it.key));
    const prev = cell.firstElementChild as HTMLElement | null;
    const card = renderAiCard(prev, anchor, ctx);
    if (card !== prev) cell.replaceChildren(card);
    return row;
  }

  const render = (v: VRow, reuse: HTMLElement | null): HTMLElement => {
    const it = v.item;
    switch (it.kind) {
      case "line":
        return renderLine(reuse as RowEl | null, it.line, it.key);
      case "fnHeader":
        return renderFn(reuse as RowEl | null, it.fn, it.key);
      case "fold":
        return renderFold(reuse as RowEl | null, it);
      case "gap":
        return renderGap(reuse as RowEl | null, it);
      case "lens":
        return renderLens();
      case "aiCard":
        return renderAi(it);
    }
  };

  // ── Row actions (§4.8.7) ──────────────────────────────────────────────────
  /** Visual columns of a line's first visual row (what the actions could cover). */
  const firstRowCols = (l: LineM): number => {
    const cols = textColsOf(l);
    if (!wrap) return cols;
    const b = breaksOf(l);
    return b.length ? b[0] : cols;
  };

  function buildActs(l: LineM, compact: boolean): HTMLElement {
    const avail = ctx.ai.availability(l.file.name).get(l.no);
    const r = avail?.region;
    const b = (act: string, label: string, text: string | null, ic: "spark" | "menu" = "spark") =>
      h("button", { type: "button", class: ["cv-act", text ? "" : "cv-act-icon"], tabindex: "-1", dataset: { act }, "aria-label": label }, icon(ic, ic === "menu" ? 14 : 12), text);
    return h(
      "span",
      { class: ["cv-acts", compact ? "is-compact" : ""] },
      avail?.line ? b("opt", `Optimize line ${l.no} with AI`, compact ? null : "Optimize") : null,
      r && !compact ? b("optr", `Optimize lines ${r.start}–${r.end} with AI`, `Region ${r.start}–${r.end}`) : null,
      b("details", `Details for line ${l.no}`, null, "menu"),
    );
  }

  /**
   * Hover / focus / selection actions at the right end of the source cell. They must not hide
   * the code (round 1): when the full group would cover the line's text, the row shows a
   * compact ✦ ⋯ group instead, and none at all while the detail panel for that row is open
   * (the lens and the dock carry the same actions). The fade behind them is the cue that
   * the line continues; the tooltip and the detail panel show it whole.
   */
  function syncRowActions(row: HTMLElement, l: LineM, key: string): void {
    const src = row.querySelector<HTMLElement>(".cv-c-source");
    if (!src) return;
    const focused = document.activeElement === row || row.contains(document.activeElement);
    const want = key === hoverKey || key === selKey || focused;
    const existing = src.querySelector<HTMLElement>(".cv-acts");
    if (!want) {
      if (existing && !existing.contains(document.activeElement)) existing.remove();
      if (!src.querySelector(".cv-acts")) delete src.dataset.acts;
      return;
    }
    const detailShown = key === selKey && (o.useLens() ? showLens() : true);
    const avail = ctx.ai.availability(l.file.name).get(l.no);
    const state = `${l.file.name}:${l.no}|${Math.round(srcTextW)}|${wrap ? colsPerLine : 0}|${detailShown ? 1 : 0}|${avail?.line ? 1 : 0}|${avail?.region?.start ?? ""}`;
    // Decided for this state already (full, compact or none), or a button inside has focus.
    if (src.dataset.acts === state || existing?.contains(document.activeElement)) return;
    existing?.remove();
    const acts = buildActs(l, false);
    src.append(acts);
    // Rows are rendered before the virtual list mounts them: measure once connected (the
    // rAF runs before the next paint, so the full group is never shown over the code).
    if (!src.isConnected) {
      if (!actsFrame) actsFrame = requestAnimationFrame(() => ((actsFrame = 0), refreshActions()));
      return;
    }
    src.dataset.acts = state;
    // Does the group (buttons, not the fade) reach the text? One layout read, only on the few
    // rows that show actions.
    const cellW = src.clientWidth;
    const padL = o.bp() === "xs" ? 10 : 12;
    const textEnd = padL + firstRowCols(l) * charW;
    const buttonsLeft = cellW - 8 - (acts.offsetWidth - 24);
    if (textEnd <= buttonsLeft - 6) return;
    acts.remove();
    if (detailShown) return;
    src.append(buildActs(l, true));
  }

  let actsFrame = 0;
  function refreshActions(): void {
    for (const key of [hoverKey, selKey, focusKey, ...Array.from(body.querySelectorAll<RowEl>(".cv-acts")).map((a) => (a.closest(".cv-row") as RowEl | null)?._key ?? null)]) {
      if (!key) continue;
      const el = vlist.elementFor(key);
      const it = items[index.get(key) ?? -1];
      if (el && it?.kind === "line") syncRowActions(el, it.line, key);
    }
  }

  // ── Virtual list ──────────────────────────────────────────────────────────
  const vlist: VirtualList<VRow> = createVirtualList<VRow>({
    container: body,
    render,
    topInset: () => o.inset(),
    onRange: () => scheduleWindow(),
  });

  let winFrame = 0;
  function scheduleWindow(): void {
    if (winFrame) return;
    winFrame = requestAnimationFrame(() => {
      winFrame = 0;
      updateWindow();
      ensureTabStop();
    });
  }

  function updateWindow(): void {
    if (!file || destroyed) return;
    if (per.sort && per.sort.key !== "line") {
      minimap.setWindow(null, null);
      return;
    }
    let first: number | null = null;
    let last: number | null = null;
    for (const key of vlist.visibleKeys()) {
      const it = items[index.get(key) ?? -1];
      const l = it ? lineOf(it) : null;
      if (!l) continue;
      if (first === null) first = l.no;
      last = l.no;
    }
    minimap.setWindow(first, last);
  }

  /** The row that carries tabindex 0: the focus row when rendered, else the first visible focusable row. */
  function effectiveFocusKey(): string | null {
    if (focusKey && index.has(focusKey)) return focusKey;
    return items.find(isFocusable)?.key ?? null;
  }

  /**
   * Keep exactly one tab stop in the body: the focus row when rendered, else the first
   * visible focusable row. Pure arithmetic over the list (no per-row layout reads), so it
   * is cheap enough to run on every scroll frame.
   */
  let tabStopEl: HTMLElement | null = null;
  function ensureTabStop(): void {
    const fk = effectiveFocusKey();
    const fkEl = fk ? vlist.elementFor(fk) : null;
    let want: HTMLElement | null = fkEl;
    if (!want) {
      for (const key of vlist.visibleKeys()) {
        const it = items[index.get(key) ?? -1];
        if (!it || !isFocusable(it)) continue;
        want = vlist.elementFor(key);
        if (want) break;
      }
    }
    if (tabStopEl && tabStopEl !== want && tabStopEl.tabIndex === 0 && document.activeElement !== tabStopEl) tabStopEl.tabIndex = -1;
    if (want && want.tabIndex !== 0) want.tabIndex = 0;
    tabStopEl = want;
  }

  let lastRows: VRow[] = [];
  function setItems(anchor?: string): void {
    const hadFocus = body.contains(document.activeElement);
    lastRows = toVRows(items);
    vlist.setItems(lastRows, anchor);
    scheduleWindow();
    if (hadFocus) keepFocus();
  }

  /**
   * Focus guard (WCAG 2.4.3, §6.2.3): a rebuild that recycled the focused row (a fold that
   * unfolded, a re-rank, a lens that closed) must not drop focus to <body>. Focus the roving
   * focus row when it is rendered, else the first visible focusable row (never scrolls).
   */
  function keepFocus(): void {
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.isConnected) return;
    const keys = focusKey && vlist.elementFor(focusKey) ? [focusKey] : vlist.visibleKeys();
    const key = keys.find((k) => {
      const it = items[index.get(k) ?? -1];
      return !!it && isFocusable(it) && !!vlist.elementFor(k);
    });
    if (!key) return;
    focusKey = key;
    applyAll();
    vlist.elementFor(key)?.focus({ preventScroll: true });
  }

  function applyAll(): void {
    for (const row of Array.from(body.children) as RowEl[]) if (row._key) applyRowState(row, row._key);
  }


  // Measured heights of the lens / AI rows (for scroll placement and better estimates).
  const measuredH = new Map<string, number>();
  const sizeRo = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as RowEl;
      const hgt = e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      if (!el._key || !hgt) continue;
      measuredH.set(el._key, hgt);
    }
  });
  sizeRo.observe(lensRow);
  const heightOfRow = (r: VRow): number =>
    typeof r.height === "number" ? r.height : measuredH.get(r.kind === "lens" ? LENS_KEY : r.key) ?? r.estimate ?? LENS_ESTIMATE;

  /**
   * §4.8.12 step 4: centre the row in the code viewport. With the lens open, centre the row
   * and its lens together when they fit (else keep three rows of context above the row), so
   * the detail is never pushed below the fold.
   */
  async function placeRow(key: string, behavior: ScrollBehavior): Promise<void> {
    const i = lastRows.findIndex((r) => r.key === key);
    if (i < 0) return;
    let off = 0;
    for (let k = 0; k < i; k++) off += heightOfRow(lastRows[k]);
    const rowHgt = heightOfRow(lastRows[i]);
    const next = lastRows[i + 1];
    const lensH = next && next.kind === "lens" ? heightOfRow(next) : 0;
    const inset = o.inset();
    const avail = window.innerHeight - inset;
    const bodyTop = body.getBoundingClientRect().top + window.scrollY;
    let y: number;
    if (!lensH) y = bodyTop + off - inset - Math.max(0, (avail - rowHgt) / 2);
    else {
      const block = rowHgt + lensH;
      y = block <= avail - 2 * rowH ? bodyTop + off - inset - (avail - block) / 2 : bodyTop + off - inset - Math.min(3 * rowH, avail * 0.2);
    }
    const target = Math.max(0, Math.round(y));
    if (Math.abs(window.scrollY - target) < 1) return;
    window.scrollTo({ top: target, behavior });
    if (behavior === "smooth") await scrollSettled();
  }

  function rowOnScreen(key: string): boolean {
    const el = vlist.elementFor(key);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= o.inset() - 1 && r.bottom <= window.innerHeight + 1;
  }

  /** Measure the lens row off-list (hidden) when it is not mounted, to seed its estimate. */
  function premeasureLens(): void {
    if (!showLens() || lensRow.isConnected) return;
    renderLens();
    lensRow.style.cssText += ";position:absolute;left:0;right:0;top:0;visibility:hidden";
    body.append(lensRow);
    const hgt = lensRow.offsetHeight;
    lensRow.remove();
    lensRow.style.visibility = "";
    if (hgt > 0) measuredH.set(LENS_KEY, hgt);
  }

  function scrollSettled(timeoutMs = 1600): Promise<void> {
    return new Promise((resolve) => {
      let last = window.scrollY;
      let stable = 0;
      const t0 = performance.now();
      const tick = () => {
        const y = window.scrollY;
        stable = y === last ? stable + 1 : 0;
        last = y;
        if (stable >= 4 || performance.now() - t0 > timeoutMs) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // ── FLIP (M9, M16) ────────────────────────────────────────────────────────
  /** FLIP the rows near the viewport across `mutate` (M9 re-rank 280 ms; M16 lens 200 ms). */
  function flipRows(mutate: () => void, highlightKey: string | null = null, ms: number = DUR.d4): void {
    if (stillMotion()) {
      mutate();
      if (highlightKey && document.documentElement.classList.contains("motion-reduce")) actedHighlight(highlightKey);
      return;
    }
    const before = new Map<string, number>();
    const top = o.inset() - 200;
    const bottom = window.innerHeight + 200;
    for (const el of Array.from(body.children) as RowEl[]) {
      if (!el._key || before.size >= FLIP_MAX) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < top || r.top > bottom) continue;
      before.set(el._key, r.top);
    }
    mutate();
    if (before.size === 0) return;
    for (const el of Array.from(body.children) as RowEl[]) {
      if (!el._key) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < top || r.top > bottom) continue;
      const was = before.get(el._key);
      if (was === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.d2, easing: "linear" });
        continue;
      }
      const dy = was - r.top;
      if (Math.abs(dy) < 1 || Math.abs(dy) > 2400) continue;
      el.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], { duration: ms, easing: EASE_CSS.standard });
    }
  }

  function actedHighlight(key: string): void {
    const el = vlist.elementFor(key);
    if (!el) return;
    el.classList.add("is-acted");
    window.setTimeout(() => el.classList.remove("is-acted"), 1500);
  }

  // ── Sync with the store ───────────────────────────────────────────────────
  function readPer(): PerFile {
    if (!file) return DEFAULT_PER_FILE;
    return ctx.store.get().code.perFile[file.name] ?? DEFAULT_PER_FILE;
  }

  function readSelection(): string | null {
    const s = ctx.store.get().selection;
    if (!s || !file || s.file !== file.name) return null;
    if ("line" in s) return lineItemKey(s.line);
    const fn = functionAt(m, s.file, s.fn);
    return fn ? fnItemKey(fn) : null;
  }

  function updateHeat(): void {
    const next = heatMetric(per.sort?.key ?? null);
    if (next !== heat) {
      heat = next;
      frame.style.setProperty("--cv-wash", `var(--${HEAT_WASH[heat]})`);
      frame.dataset.heat = heat;
      minimap.setMetric(heat);
    }
  }

  function sync(): void {
    if (batching || !file) return;
    const next = readPer();
    const prev = per;
    const sortChanged = prev.sort?.key !== next.sort?.key || prev.sort?.dir !== next.sort?.dir;
    const modeChanged = prev.mode !== next.mode;
    per = next;
    selKey = readSelection();
    updateHeat();
    if (sortChanged || modeChanged) {
      const ranked = next.sort !== null && next.sort.key !== "line";
      const tableTop = table.getBoundingClientRect().top;
      flipRows(() => {
        buildItems();
        renderHead();
        if (sortChanged && ranked && tableTop < o.inset() - 32) {
          // Ranking from deep in the file: show the top of the ranked list.
          const y = window.scrollY + tableTop - (o.inset() - 32) + 1;
          setItems();
          window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
        } else setItems(focusKey ?? selKey ?? undefined);
      }, focusKey);
      if (sortChanged) o.onSortChange?.(per.sort);
    } else {
      buildItems();
      setItems(focusKey ?? undefined);
    }
    detailSync();
  }

  function updateSelection(): void {
    if (batching || !file) return;
    const next = readSelection();
    if (next === selKey) return;
    const hadLens = showLens();
    selKey = next;
    if (!selKey) lensOpen = false;
    const wantLens = showLens();
    if (hadLens || wantLens) {
      flipRows(
        () => {
          buildItems();
          setItems(selKey ?? undefined);
        },
        null,
        DUR.d3,
      );
    } else {
      applyAll();
    }
    refreshActions();
    detailSync();
  }

  /** Update the shared detail panel for the current selection and layout. */
  function detailSync(): void {
    const subject = subjectFor(selKey);
    if (o.useLens()) {
      if (!showLens()) return;
      if (subject) {
        lensBox.setAttribute("aria-label", detailLabel(subject));
        if (!sameSubject(detail.subject(), subject) || detail.el.parentElement !== lensBox || !detail.el.classList.contains("cd-lens")) {
          detail.update(subject, "lens", o.lensColumns());
        }
        if (detail.el.parentElement !== lensBox) lensBox.append(detail.el);
      }
    }
  }

  function subjectFor(key: string | null): DetailSubject | null {
    if (!key || !file) return null;
    const it = items[index.get(key) ?? -1];
    if (it?.kind === "line") return { kind: "line", line: it.line };
    if (it?.kind === "fnHeader") return { kind: "fn", fn: it.fn };
    if (key.startsWith("L:")) {
      const l = file.byNo.get(Number(key.slice(2)));
      return l ? { kind: "line", line: l } : null;
    }
    if (key.startsWith("H:")) {
      const no = Number(key.slice(2));
      const fn = file.functions.find((f) => f.no === no);
      return fn ? { kind: "fn", fn } : null;
    }
    return null;
  }

  function sameSubject(a: DetailSubject | null, b: DetailSubject | null): boolean {
    if (!a || !b) return a === b;
    if (a.kind === "line" && b.kind === "line") return a.line === b.line;
    if (a.kind === "fn" && b.kind === "fn") return a.fn === b.fn;
    return false;
  }

  // ── Selection & lens actions ──────────────────────────────────────────────
  function targetFor(key: string): Target | null {
    const it = items[index.get(key) ?? -1];
    if (!it || !file) return null;
    if (it.kind === "line") return { file: file.name, line: it.line.no };
    if (it.kind === "fnHeader") return { file: file.name, fn: it.fn.name };
    return null;
  }

  /** Select a row and open (or toggle) its detail. */
  function activate(key: string, toggle: boolean): void {
    const t = targetFor(key);
    if (!t) return;
    const same = key === selKey;
    if (toggle && same && (o.useLens() ? lensOpen : true)) {
      if (o.useLens()) {
        closeLens();
        return;
      }
    }
    lensOpen = true;
    focusKey = key;
    if (same) {
      flipRows(
        () => {
          buildItems();
          setItems(key);
        },
        null,
        DUR.d3,
      );
      detailSync();
    } else {
      ctx.store.set({ selection: t });
    }
    announceSelection(key);
  }

  function closeLens(): void {
    if (!lensOpen) return;
    const keep = selKey;
    flipRows(
      () => {
        lensOpen = false;
        buildItems();
        setItems(keep ?? undefined);
      },
      null,
      DUR.d3,
    );
    if (keep) {
      const el = vlist.elementFor(keep);
      if (el && detail.el.contains(document.activeElement)) el.focus({ preventScroll: true });
    }
  }

  function announceSelection(key: string): void {
    const it = items[index.get(key) ?? -1];
    if (!it || !file) return;
    if (it.kind === "line") {
      const l = it.line;
      ctx.announce.polite(`${file.base} line ${l.no} selected: ${l.total > 0 ? `${fmtPct(l.total)} of run time` : "no CPU time sampled"}`);
    } else if (it.kind === "fnHeader") {
      ctx.announce.polite(`Function ${it.fn.name} selected: ${fmtPct(it.fn.total)} of run time`);
    }
  }

  function unfold(start: number): void {
    if (!file) return;
    const cur = readPer();
    if (cur.unfolded.includes(start)) return;
    focusKey = lineItemKey(start);
    const l = file.byNo.get(start);
    if (!l) {
      const first = file.lines.find((x) => x.no >= start);
      focusKey = first ? lineItemKey(first.no) : null;
    }
    // The fold row goes away with this write; setItems() moves focus to the first revealed
    // line (focusKey) when the fold had it, so the next ArrowDown stays in the table.
    writePer({ unfolded: [...cur.unfolded, start] });
  }

  // ── Focus movement ────────────────────────────────────────────────────────
  const focusables = (): CodeItem[] => items.filter(isFocusable);

  async function focusRow(key: string, opts: { scroll?: boolean } = {}): Promise<void> {
    focusKey = key;
    let el = vlist.elementFor(key);
    const inset = o.inset();
    if (!el || opts.scroll) {
      await vlist.scrollToKey(key, "center", "auto");
      el = vlist.elementFor(key);
    } else {
      const r = el.getBoundingClientRect();
      if (r.top < inset || r.bottom > window.innerHeight) {
        await vlist.scrollToKey(key, r.top < inset ? "start" : "center", "auto");
        el = vlist.elementFor(key);
      }
    }
    applyAll();
    if (el) el.focus({ preventScroll: true });
  }

  function moveFocus(from: string, delta: number | "home" | "end" | "pagedown" | "pageup"): void {
    const list = focusables();
    if (!list.length) return;
    let i = list.findIndex((it) => it.key === from);
    if (i < 0) i = 0;
    const page = Math.max(1, Math.floor((window.innerHeight - o.inset()) / rowH) - 1);
    let j: number;
    if (delta === "home") j = 0;
    else if (delta === "end") j = list.length - 1;
    else if (delta === "pagedown") j = Math.min(list.length - 1, i + page);
    else if (delta === "pageup") j = Math.max(0, i - page);
    else j = Math.max(0, Math.min(list.length - 1, i + delta));
    void focusRow(list[j].key);
  }

  // ── Events ────────────────────────────────────────────────────────────────
  const rowFromEvent = (ev: Event): RowEl | null => {
    const t = ev.target as Element | null;
    const row = t?.closest?.(".cv-row") as RowEl | null;
    return row && body.contains(row) ? row : null;
  };

  function optimize(l: LineM, mode: "line" | "region"): void {
    const avail = ctx.ai.availability(l.file.name).get(l.no);
    if (mode === "line" && !avail?.line) {
      ctx.announce.polite(`Line ${l.no} is not eligible for an AI proposal (below 1% of run time)`);
      return;
    }
    if (mode === "region" && !avail?.region) {
      ctx.announce.polite(`No AI region proposal starts at line ${l.no}`);
      return;
    }
    ctx.ai.request(l.file.name, l.no, mode);
  }

  body.addEventListener("click", (ev) => {
    const row = rowFromEvent(ev);
    if (!row || !row._key || !file) return;
    const it = items[index.get(row._key) ?? -1];
    if (!it) return;
    const t = ev.target as Element;
    if (it.kind === "fold") {
      unfold(it.start);
      return;
    }
    if (it.kind === "line") {
      const act = t.closest<HTMLElement>(".cv-act");
      if (act) {
        const a = act.dataset.act;
        if (a === "opt") optimize(it.line, "line");
        else if (a === "optr") optimize(it.line, "region");
        else activate(row._key, false);
        return;
      }
      if (t.closest(".cv-c-line")) {
        if (ctx.host.isVsCode) ctx.nav.openInEditor(file.name, it.line.no);
        else activate(row._key, false);
        return;
      }
      // Text selection drags are not clicks.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return;
      focusKey = row._key;
      activate(row._key, true);
      return;
    }
    if (it.kind === "fnHeader") {
      focusKey = row._key;
      activate(row._key, true);
    }
  });

  body.addEventListener("keydown", (ev) => {
    const row = rowFromEvent(ev);
    if (!row || !row._key || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const onRow = ev.target === row;
    const key = row._key;
    const it = items[index.get(key) ?? -1];
    if (!it) return;
    const k = ev.key;
    const nav = (d: Parameters<typeof moveFocus>[1]) => {
      ev.preventDefault();
      moveFocus(key, d);
    };
    if (!onRow && (k === "Enter" || k === " ")) return; // buttons inside rows handle their own activation
    switch (k) {
      case "ArrowDown":
      case "j":
        return nav(1);
      case "ArrowUp":
      case "k":
        return nav(-1);
      case "PageDown":
        return nav("pagedown");
      case "PageUp":
        return nav("pageup");
      case "Home":
        return nav("home");
      case "End":
        return nav("end");
      case "Enter":
      case " ":
        ev.preventDefault();
        if (it.kind === "fold") unfold(it.start);
        else activate(key, true);
        return;
      case "Escape":
        if (lensOpen && showLens()) {
          ev.preventDefault();
          closeLens();
        } else if (selKey) {
          ev.preventDefault();
          ctx.store.set({ selection: null });
        }
        return;
    }
    if (!file) return;
    const l = lineOf(it);
    const lineNo = l ? l.no : it.kind === "fnHeader" ? it.fn.no : null;
    const target = targetFor(key);
    if (k === "e" && lineNo !== null) {
      ev.preventDefault();
      ctx.nav.openInEditor(file.name, lineNo);
    } else if (k === "o" && l) {
      ev.preventDefault();
      optimize(l, "line");
    } else if (k === "O" && l) {
      ev.preventDefault();
      optimize(l, "region");
    } else if (k === "s" && target && m.caps.stacks) {
      ev.preventDefault();
      void ctx.nav.showInStacks(target);
    } else if (k === "t" && target && m.caps.timeline) {
      ev.preventDefault();
      void ctx.nav.showInTimeline(target);
    }
  });

  // Hover → linked highlight (§4.4.6) + row actions; cell tooltips after 300 ms intent.
  body.addEventListener("pointerover", (ev) => {
    const row = rowFromEvent(ev);
    const key = row?._key ?? null;
    const it = key ? items[index.get(key) ?? -1] : undefined;
    const hk = it && (it.kind === "line" || it.kind === "fnHeader") ? key : null;
    if (hk !== hoverKey) {
      const prev = hoverKey;
      hoverKey = hk;
      for (const k of [prev, hk]) {
        if (!k) continue;
        const el = vlist.elementFor(k);
        const ii = items[index.get(k) ?? -1];
        if (el && ii?.kind === "line") syncRowActions(el, ii.line, k);
      }
      ctx.bus.emit("hover:line", { target: hk ? targetFor(hk) : null, source: "code" });
    }
    const act = (ev.target as Element).closest?.(".cv-act") as HTMLElement | null;
    const cell = act ?? ((ev.target as Element).closest?.(".cv-c") as HTMLElement | null);
    if (cell !== tipCell) {
      tipCell = cell;
      if (!cell || !it || it.kind !== "line") {
        ctx.tooltip.hide();
        return;
      }
      if (act) {
        // Row action buttons (the compact ones are icon-only): name + shortcut.
        ctx.tooltip.show(act, { title: act.getAttribute("aria-label") ?? "", hint: `Key: ${({ opt: "o", optr: "Shift+O" } as Record<string, string>)[act.dataset.act ?? ""] ?? "Enter"}` }, { delay: 300 });
        return;
      }
      const col = cell.dataset.col as ColumnKey | undefined;
      let content = col && col !== "source" ? cellTooltip(col, it.line, env) : null;
      if (col === "line" && !ctx.host.isVsCode) content = { title: `Line ${it.line.no}`, hint: "Click for details · e opens it in the editor" };
      if (col === "source" && row?.classList.contains("is-clipped")) content = { code: it.line.text, hint: `${it.line.file.base}:${it.line.no}` };
      if (content) ctx.tooltip.show(cell, content, { delay: 300 });
      else ctx.tooltip.hide();
    }
  });
  body.addEventListener("pointerleave", () => {
    tipCell = null;
    ctx.tooltip.hide();
    if (hoverKey) {
      const prev = hoverKey;
      hoverKey = null;
      const el = vlist.elementFor(prev);
      const ii = items[index.get(prev) ?? -1];
      if (el && ii?.kind === "line") syncRowActions(el, ii.line, prev);
      ctx.bus.emit("hover:line", { target: null, source: "code" });
    }
  });
  body.addEventListener("focusin", (ev) => {
    const row = rowFromEvent(ev);
    if (!row?._key) return;
    if (ev.target === row) {
      focusKey = row._key;
      for (const r of Array.from(body.children) as RowEl[]) if (r._key && r.tabIndex === 0 && r !== row) r.tabIndex = -1;
      row.tabIndex = 0;
      const it = items[index.get(row._key) ?? -1];
      if (it?.kind === "line") syncRowActions(row, it.line, row._key);
      const t = targetFor(row._key);
      if (t) ctx.bus.emit("hover:line", { target: t, source: "code" });
    }
  });
  body.addEventListener("focusout", (ev) => {
    const row = rowFromEvent(ev);
    if (!row?._key) return;
    const next = ev.relatedTarget as Node | null;
    if (next && row.contains(next)) return;
    requestAnimationFrame(() => {
      const it = items[index.get(row._key ?? "") ?? -1];
      if (it?.kind === "line" && row._key) syncRowActions(row, it.line, row._key);
    });
    if (!next || !body.contains(next)) ctx.bus.emit("hover:line", { target: null, source: "code" });
  });

  // Esc inside the lens closes it and returns focus to the row.
  lensRow.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    ev.preventDefault();
    const keep = selKey;
    closeLens();
    if (keep) void focusRow(keep);
  });

  // ── Scrolling helpers ─────────────────────────────────────────────────────
  function keyForLine(line: number): string | null {
    const k = lineItemKey(line);
    if (index.has(k)) return k;
    if (!file) return null;
    // Folded: the fold that hides it; sparse gap: nearest listed line.
    const start = foldStartFor(file, per.mode, line);
    if (start !== null && index.has(`F:${start}`)) return `F:${start}`;
    let best: string | null = null;
    let bestD = Infinity;
    for (const it of items) {
      if (it.kind !== "line") continue;
      const d = Math.abs(it.line.no - line);
      if (d < bestD) {
        bestD = d;
        best = it.key;
      }
    }
    return best;
  }

  function scrollToLine(line: number, behavior: ScrollBehavior): void {
    const key = keyForLine(line);
    if (key) void vlist.scrollToKey(key, "center", behavior);
  }

  function flash(key: string): void {
    const el = vlist.elementFor(key);
    if (!el) return;
    el.classList.remove("m-flash");
    void el.offsetWidth;
    el.classList.add("m-flash");
    window.setTimeout(() => el.classList.remove("m-flash"), DUR.flash + 50);
  }

  // ── Linked hover from other views ─────────────────────────────────────────
  const offHover = ctx.bus.on("hover:line", ({ target, source }) => {
    if (source === "code") return;
    let next: string | null = null;
    if (target && file && target.file === file.name) {
      if ("line" in target) next = lineItemKey(target.line);
      else {
        const fn = functionAt(m, target.file, target.fn);
        next = fn ? fnItemKey(fn) : null;
      }
    }
    if (next === linkedKey) return;
    const prev = linkedKey;
    linkedKey = next;
    for (const k of [prev, next]) {
      const el = k ? vlist.elementFor(k) : null;
      if (el && k) applyRowState(el as RowEl, k);
    }
  });

  const offAi = ctx.ai.onChange((anchor) => {
    if (!file) return;
    if (anchor === null) {
      detail.refreshAi();
      refreshActions();
      return;
    }
    const f = anchor.slice(0, anchor.lastIndexOf(":"));
    if (f !== file.name) return;
    const key = `ai:${anchor.slice(anchor.lastIndexOf(":") + 1)}`;
    const had = index.has(key);
    buildItems();
    if (had || index.has(key)) setItems(lineItemKey(Number(key.slice(3))));
    if (index.has(key)) vlist.refresh([key]);
  });

  const unsubs = [
    ctx.store.subscribe(
      (s) => (file ? s.code.perFile[file.name] : undefined),
      () => sync(),
    ),
    ctx.store.subscribe(
      (s) => s.selection,
      () => updateSelection(),
    ),
  ];

  // ── API ───────────────────────────────────────────────────────────────────
  const api: CodeTable = {
    el: frame,
    table,
    setFile(f, opts = {}) {
      if (file === f) return;
      // Rows are pooled: stop any FLIP still running on them before they show another file.
      for (const el of Array.from(body.children) as HTMLElement[]) for (const a of el.getAnimations()) a.cancel();
      file = f;
      fileGen++;
      wrapRows = null;
      lineIdx = new Map(f.lines.map((l, i) => [l.no, i]));
      per = readPer();
      selKey = readSelection();
      if (!selKey) lensOpen = false;
      focusKey = null;
      hoverKey = null;
      table.setAttribute("aria-label", `Line profile of ${f.base}`);
      updateHeat();
      renderHead();
      buildItems();
      minimap.setFile(f, heat);
      if (opts.crossfade && !stillMotion()) body.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      setItems();
      o.onSortChange?.(per.sort);
      detailSync();
    },
    file: () => file,
    sync,
    relayout() {
      readRowH();
      measureChar();
      wrap = ctx.store.get().code.wrap;
      computeColumns();
      table.classList.toggle("is-wrap", wrap);
      if (!file) return;
      // A height-only resize (lens, dock, section growth) changes nothing in the rows: skip the
      // rebuild (§6.1; review round 1, resize-relayouts-every-section).
      const sig = `${file.name}|${colSig}|${ctx.store.get().layout.short}|${wrap}|${colsPerLine}|${rowH}|${charW}|${Math.round(srcTextW)}`;
      if (sig !== layoutSig) {
        layoutSig = sig;
        buildItems();
        setItems(vlist.visibleKeys()[0]);
      }
      minimap.redraw();
      detailSync();
    },
    redraw() {
      measureChar();
      env = cellEnv(m, o.bp(), ctx.theme);
      if (file) {
        const hadFocus = body.contains(document.activeElement);
        vlist.refresh();
        if (hadFocus) keepFocus();
      }
      minimap.redraw();
      detail.redraw();
    },
    async reveal(target, opts) {
      if (!file || target.file !== file.name) return;
      batching = true;
      try {
        let key: string;
        let fn: FunctionM | null = null;
        if ("fn" in target) {
          fn = functionAt(m, target.file, target.fn);
          if (!fn) return;
          key = fnItemKey(fn);
        } else key = lineItemKey(target.line);
        let cur = readPer();
        // 2. Ranked and not listed (function headers never are) → source order.
        if (cur.sort && cur.sort.key !== "line" && (fn || !buildCodeItems(file, cur.mode, cur.sort, cur.unfolded).some((it) => it.key === key))) {
          cur = { ...cur, sort: null };
        }
        // 3. Folded → reveal that fold only (the mode does not change).
        if (!fn) {
          const start = foldStartFor(file, cur.mode, (target as { line: number }).line);
          if (start !== null && !cur.unfolded.includes(start)) cur = { ...cur, unfolded: [...cur.unfolded, start] };
        }
        const stored = readPer();
        if (cur.sort !== stored.sort || cur.unfolded !== stored.unfolded) {
          writePer(cur);
          o.onSortChange?.(cur.sort);
        }
        per = cur;
        updateHeat();
        renderHead();
        // 6. Select (and open the lens).
        if (opts.open !== false) lensOpen = true;
        ctx.store.set({ selection: fn ? { file: file.name, fn: fn.name } : { file: file.name, line: (target as { line: number }).line } });
        selKey = readSelection();
        buildItems();
        if (!index.has(key)) {
          // Sparse files: the line is not listed (gap) → nearest row.
          const near = keyForLine((target as { line?: number }).line ?? 0);
          if (!near) return;
          key = near;
        }
        focusKey = key;
        // Fill and measure the lens before positioning anything, so the scroll target is
        // exact and no late measurement above the viewport interrupts the smooth scroll.
        detailSync();
        premeasureLens();
        setItems(key);
        detailSync();
      } finally {
        batching = false;
      }
      // 4. Centre the row (smooth; reduced motion: instant).
      const behavior: ScrollBehavior = stillMotion() || ctx.motion.reduced ? "auto" : "smooth";
      const key = focusKey as string;
      await placeRow(key, behavior);
      vlist.refresh([]); // render the rows at the new scroll position now (no frame wait)
      // A height change during the smooth scroll (async call context, fonts) can stop it
      // short: correct instantly so the row is always on screen before it takes focus.
      if (!rowOnScreen(key)) {
        await placeRow(key, "auto");
        vlist.refresh([]);
      }
      // 5. Flash. 7. Focus. 8. Announce.
      if (opts.flash !== false) flash(key);
      const el = vlist.elementFor(key);
      applyAll();
      if (opts.focus !== false && el) el.focus({ preventScroll: true });
      refreshActions();
      announceSelection(key);
    },
    setPins(pins) {
      minimap.setPins(pins);
    },
    isLensOpen: () => lensOpen && showLens(),
    closeLens,
    debug: () => ({ items, columns, rendered: body.children.length }),
    destroy() {
      destroyed = true;
      if (winFrame) cancelAnimationFrame(winFrame);
      if (actsFrame) cancelAnimationFrame(actsFrame);
      for (const d of headDisposers) d();
      for (const u of unsubs) u();
      offHover();
      offAi();
      vlist.destroy();
      sizeRo.disconnect();
      minimap.destroy();
      frame.remove();
    },
  };

  // Initial measurements happen once the frame is in the document (relayout()).
  return api;
}

