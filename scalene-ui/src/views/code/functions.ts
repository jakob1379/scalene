// Function view (DESIGN.md §4.10): the current file's `functions[]` in a table with the same
// column system as the line view. `line` shows the first line; `source` shows "ƒ qualname"
// and the def line's code in `--fg-2`. Default sort Time ↓; header clicks cycle desc → asc →
// first line. Click or Enter switches to Lines and jumps to the function header row.
import { button } from "../../core/controls";
import { h } from "../../core/dom";
import { fmtMem, fmtPct, fmtTime, fmtUtil } from "../../core/format";
import { icon } from "../../core/icons";
import type { Breakpoint, ColumnKey, SortState } from "../../core/store";
import type { FileM, FunctionM, LineM, Model } from "../../model/model";
import { profileColumns } from "../../model/thresholds";
import { highlightCached } from "../../model/syntax";
import type { ViewContext } from "../app";
import { COLUMN_SPECS, cellEnv, fitColumns, gridTemplate, headerCell, headerTooltip, refocusHeader, renderFunctionCell, type CellEnv } from "./columns";
import { expandSpans, renderSpans } from "./source";

export interface FunctionView {
  el: HTMLElement;
  setFile(file: FileM): void;
  relayout(): void;
  focusFirst(): void;
  destroy(): void;
}

export interface FunctionViewOptions {
  ctx: ViewContext;
  bp(): Breakpoint;
  onOpen(fn: FunctionM): void;
  onLines(): void;
}

const LINE_ONLY = new Set<ColumnKey>(["idle", "nrt", "nc"]);

/** Columns a function table can show (no Neuron columns; trend only with samples). */
export function functionColumns(m: Model, file: FileM | null): ColumnKey[] {
  const fns = file?.functions ?? [];
  return profileColumns(m).filter((k) => {
    if (LINE_ONLY.has(k)) return false;
    if (k === "trend") return fns.some((f) => f.memSamples.length > 0);
    return true;
  });
}

export function functionSortValue(f: FunctionM, key: ColumnKey): number | null {
  switch (key) {
    case "time":
      return f.total;
    case "mem":
      return f.peak;
    case "gpu":
      return f.gpu;
    case "await":
      return f.await;
    case "copy":
      return f.copy;
    case "gpumem":
      return f.gpuPeak;
    case "alloc":
      return f.usage;
    case "avg":
      return f.avg;
    default:
      return null;
  }
}

/** Ranked functions; keyless / zero last in both directions; ties and "line" by first line. */
export function rankFunctions(fns: readonly FunctionM[], sort: SortState | null): FunctionM[] {
  const list = fns.slice();
  if (!sort || sort.key === "line") return list.sort((a, b) => a.no - b.no);
  const dir = sort.dir === "desc" ? -1 : 1;
  return list
    .map((f) => ({ f, v: functionSortValue(f, sort.key) }))
    .sort((a, b) => {
      const ka = a.v !== null && a.v !== 0;
      const kb = b.v !== null && b.v !== 0;
      if (ka !== kb) return ka ? -1 : 1;
      if (ka && kb && a.v !== b.v) return dir * ((a.v as number) - (b.v as number));
      return a.f.no - b.f.no;
    })
    .map((x) => x.f);
}

/** The `def` / `class` line of a function (its first line may be a decorator). */
export function defLine(fn: FunctionM): LineM | null {
  const first = fn.file.byNo.get(fn.no) ?? null;
  for (let n = fn.no; n <= fn.no + 8; n++) {
    const l = fn.file.byNo.get(n);
    if (l && /^\s*(async\s+def|def|class)\s/.test(l.text)) return l;
  }
  return first;
}

export function createFunctionView(o: FunctionViewOptions): FunctionView {
  const { ctx } = o;
  const m = ctx.model;
  const el = h("div", { class: "cfv" });
  const table = h("div", { class: "cv-table cfv-table", role: "table" });
  let file: FileM | null = null;
  let sort: SortState | null = { key: "time", dir: "desc" };
  const sorts = new Map<string, SortState | null>();
  let columns: ColumnKey[] = [];
  let env: CellEnv = cellEnv(m, o.bp(), ctx.theme);
  let stops: (() => void)[] = [];
  let focusIdx = 0;

  const ariaSort = (key: ColumnKey): "ascending" | "descending" | "none" => {
    if (key === "line") return !sort || sort.key === "line" ? "ascending" : "none";
    if (!sort || sort.key !== key) return "none";
    return sort.dir === "desc" ? "descending" : "ascending";
  };

  const cycle = (key: ColumnKey) => {
    if (key === "line" || !COLUMN_SPECS[key].sortable) sort = null;
    else if (!sort || sort.key !== key) sort = { key, dir: "desc" };
    else if (sort.dir === "desc") sort = { key, dir: "asc" };
    else sort = null;
    if (file) sorts.set(file.name, sort);
    render();
    ctx.announce.polite(sort ? `Functions ranked by ${COLUMN_SPECS[sort.key].name}, ${sort.dir === "desc" ? "descending" : "ascending"}` : "Functions in source order");
  };

  function header(): HTMLElement {
    const fileName = file?.base ?? "";
    return h(
      "div",
      { class: "cv-head", role: "rowgroup" },
      h(
        "div",
        { class: "cv-head-row", role: "row", "aria-rowindex": "1" },
        columns.map((key) => {
          const name = key === "gpu" ? env.gpuLabel : key === "gpumem" ? `${env.gpuLabel} mem` : key === "source" ? "Function" : COLUMN_SPECS[key].name;
          const unit = key === "source" ? fileName : key === "time" ? "% of run" : COLUMN_SPECS[key].unit;
          const tip = key === "source" ? () => ({ title: `Function · ${fileName}`, hint: "Each function's name and its def line. Enter or a click on a row shows it in the code." }) : () => headerTooltip(key, env.gpuLabel, fileName);
          return headerCell(key, name, unit, ariaSort(key), key === "line" ? "First line: source order" : `${name}: rank functions`, () => cycle(key), ctx.tooltip, tip, stops);
        }),
      ),
    );
  }

  function row(fn: FunctionM, i: number, maxFn: number): HTMLElement {
    const def = defLine(fn);
    const label = [`Function ${fn.name}, line ${fn.no}`, fn.total > 0 ? `${fmtPct(fn.total)} of run time, ${fmtTime(fn.sec)}` : "no CPU time sampled"];
    if (m.caps.memory && fn.peak > 0) label.push(`peak ${fmtMem(fn.peak)}`);
    if (m.caps.gpu && fn.gpu >= 1) label.push(`GPU ${fmtUtil(fn.gpu)} busy`);
    if (m.caps.async && fn.await >= 1) label.push(`${fmtPct(fn.await)} of await time`);
    const r = h("div", {
      class: ["cv-row", "cv-line", "cfv-row", fn.total > 0 || fn.peak > 0 ? "is-data" : ""],
      role: "row",
      "aria-rowindex": String(i + 2),
      tabindex: i === focusIdx ? "0" : "-1",
      "aria-label": `${label.join(", ")}. Press Enter to show it in the code`,
      dataset: { fn: fn.name },
    });
    for (const key of columns) {
      const cell = h("div", { class: ["cv-c", `cv-c-${key}`], role: "cell", dataset: { col: key } });
      if (key === "line") cell.textContent = String(fn.no);
      else if (key === "source") {
        const code = def ? h("span", { class: "cfv-def" }, renderSpans(expandSpans(highlightCached(`${fn.file.name}:def:${def.no}`, def.text.trim(), def.doc)))) : null;
        cell.append(
          h(
            "span",
            { class: "cv-src cfv-src" },
            h("span", { class: "cfv-fn" }, icon("fn", 13), h("span", { class: "cfv-name" }, `${fn.name}()`)),
            fn.coro ? h("span", { class: "badge badge-neutral" }, "coroutine") : null,
            code,
          ),
        );
      } else renderFunctionCell(cell, key, fn, env, maxFn);
      r.append(cell);
    }
    return r;
  }

  function render(): void {
    for (const s of stops) s();
    stops = [];
    if (!file) return;
    const fns = file.functions;
    if (!fns.length) {
      el.replaceChildren(
        h(
          "div",
          { class: "cfv-empty" },
          h("p", null, "No function summaries in this profile. Module-level code only, or an old Scalene version."),
          button({ label: "Show lines", icon: "code", variant: "secondary", compact: true, onClick: () => o.onLines() }),
        ),
      );
      return;
    }
    const bp = o.bp();
    env = cellEnv(m, bp, ctx.theme);
    const width = el.getBoundingClientRect().width || 800;
    columns = fitColumns(functionColumns(m, file), width, bp, ctx.store.get().layout.short);
    table.style.setProperty("--cv-cols", gridTemplate(columns, bp));
    table.setAttribute("aria-label", `Functions in ${file.base}`);
    table.setAttribute("aria-rowcount", String(fns.length + 1));
    // Re-rendering (sort, resize) must not drop keyboard focus (WCAG 2.4.3): remember the
    // focused header column or function row and focus its replacement.
    const ae = document.activeElement;
    const was = ae && table.contains(ae) ? ae.closest<HTMLElement>(".cv-h, .cfv-row") : null;
    const ranked = rankFunctions(fns, sort);
    const maxFn = Math.max(...fns.map((f) => f.total), 0);
    const keep = was?.dataset.fn ? ranked.findIndex((f) => f.name === was.dataset.fn) : -1;
    focusIdx = keep >= 0 ? keep : Math.min(focusIdx, ranked.length - 1);
    table.replaceChildren(header(), h("div", { class: "cfv-body", role: "rowgroup" }, ranked.map((fn, i) => row(fn, i, maxFn))));
    el.replaceChildren(table);
    refocusHeader(table, was?.dataset.col);
    if (keep >= 0) rowsEls()[keep].focus({ preventScroll: true });
  }

  const rowsEls = () => Array.from(table.querySelectorAll<HTMLElement>(".cfv-row"));
  const fnOf = (r: HTMLElement) => (file ? file.functions.find((f) => f.name === r.dataset.fn) ?? null : null);

  table.addEventListener("click", (ev) => {
    const r = (ev.target as Element).closest<HTMLElement>(".cfv-row");
    const fn = r ? fnOf(r) : null;
    if (fn) o.onOpen(fn);
  });
  table.addEventListener("keydown", (ev) => {
    const r = (ev.target as Element).closest<HTMLElement>(".cfv-row");
    if (!r || ev.target !== r) return;
    const list = rowsEls();
    const i = list.indexOf(r);
    let j = -1;
    if (ev.key === "ArrowDown" || ev.key === "j") j = Math.min(list.length - 1, i + 1);
    else if (ev.key === "ArrowUp" || ev.key === "k") j = Math.max(0, i - 1);
    else if (ev.key === "Home") j = 0;
    else if (ev.key === "End") j = list.length - 1;
    else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      const fn = fnOf(r);
      if (fn) o.onOpen(fn);
      return;
    }
    if (j < 0) return;
    ev.preventDefault();
    focusIdx = j;
    list.forEach((x, k) => (x.tabIndex = k === j ? 0 : -1));
    list[j].focus({ preventScroll: true });
    list[j].scrollIntoView({ block: "nearest" });
  });
  table.addEventListener("pointerover", (ev) => {
    const r = (ev.target as Element).closest<HTMLElement>(".cfv-row");
    const fn = r ? fnOf(r) : null;
    ctx.bus.emit("hover:line", { target: fn ? { file: fn.file.name, fn: fn.name } : null, source: "code" });
  });
  table.addEventListener("pointerleave", () => ctx.bus.emit("hover:line", { target: null, source: "code" }));

  return {
    el,
    setFile(f) {
      if (file) sorts.set(file.name, sort);
      file = f;
      sort = sorts.has(f.name) ? (sorts.get(f.name) ?? null) : { key: "time", dir: "desc" };
      focusIdx = 0;
      // Hidden (Lines view): render when shown (relayout), not on every file switch (§6.1).
      if (!el.hidden) render();
    },
    relayout: render,
    focusFirst() {
      rowsEls()[focusIdx]?.focus({ preventScroll: true });
    },
    destroy() {
      for (const s of stops) s();
      el.remove();
    },
  };
}
