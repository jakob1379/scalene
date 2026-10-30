// Code section (DESIGN.md §4.7–4.10, §2.4.3): header, toolbar (view, display mode, wrap,
// ranked chip), file navigator (tabs / rail / switcher), the file bar, the virtualized code
// table with its ribbon minimap, the function view, and the detail panel (dock at xl+,
// inline lens below). Registers `CodeApi` (reveal = §4.8.12 steps 1–8).
import { button, sectionHeader, segmented, switchControl, type Choice } from "../../core/controls";
import { createDisposer, h, type Child } from "../../core/dom";
import { fmtMem, fmtPct } from "../../core/format";
import { icon } from "../../core/icons";
import { observeSize } from "../../core/canvas";
import { STORAGE_KEYS, storageSet } from "../../core/storage";
import { bindTooltip } from "../../core/tooltip";
import type { AppState, Breakpoint, DisplayMode, SortState, Target } from "../../core/store";
import type { HotspotItem } from "../../model/model";
import type { FileM, FunctionM, LineM } from "../../model/model";
import { functionAt, lineAt } from "../../model/model";
import { hotspotList } from "../../model/hotspots";
import * as P from "../../model/phrases";
import { meter } from "../../charts/meter";
import type { CodeApi, ViewContext, ViewHandle } from "../app";
import { COLUMN_SPECS, timeSegments } from "./columns";
import { createCodeTable, DEFAULT_PER_FILE, type CodeTable } from "./codeview";
import { createDetail, detailLabel, type DetailSubject } from "./detail";
import { createFileNav, fileTooltip, hiddenCaption, type FileNavMode } from "./filenav";
import { createFunctionView } from "./functions";
import type { MinimapPin } from "./minimap";

/**
 * Display modes (§4.8.5). Round 1 renamed "Profiled functions | Hot lines" to "Hot + context |
 * Hot only": next to the Lines | Functions view switch, "functions" read as a functions list.
 */
const MODE_OPTIONS: readonly { value: DisplayMode; label: string }[] = [
  { value: "profiled-functions", label: "Hot + context" },
  { value: "profiled-lines", label: "Hot only" },
  { value: "all", label: "All lines" },
];

/** Mode tooltip, naming the activities this profile records (the §4.0.4 data-row rule). */
export function modeDescription(mode: DisplayMode, caps: { memory: boolean; gpu: boolean; neuron: boolean; async: boolean }): string {
  if (mode === "all") return "Every line of the file.";
  const acts = [caps.memory && "memory", caps.gpu && "GPU", caps.neuron && "Neuron", caps.async && "await"].filter(Boolean).join(", ").replace(/, (?=[^,]*$)/, " or ");
  const hot = `lines with more than 1% of run time${acts ? `, or any ${acts} activity` : ""}`;
  return mode === "profiled-lines" ? `Only hot ${hot}. The rest is folded.` : `Hot ${hot}, plus every other line of the functions that contain them. The rest is folded.`;
}

interface Layout {
  bp: Breakpoint;
  short: boolean;
  nav: FileNavMode;
  sheet: "bottom" | "popover";
  dock: boolean;
  lensCols: number;
}

export function codeLayout(l: AppState["layout"]): Layout {
  const { bp, short } = l;
  const nav: FileNavMode = short || bp === "xs" || bp === "sm" ? "switcher" : bp === "xxl" ? "rail" : "tabs";
  return {
    bp,
    short,
    nav,
    sheet: bp === "xs" ? "bottom" : "popover",
    dock: !short && (bp === "xl" || bp === "xxl"),
    lensCols: bp === "xs" ? 1 : bp === "sm" || short ? 2 : 3,
  };
}

/** File share of run split Python / native / system (Σ = `percent_cpu_time`). */
function fileShareSegments(f: FileM) {
  const k = f.total > 0 ? f.pct / f.total : 0;
  return timeSegments(f.py * k, f.nat * k, f.sys * k);
}

function sortLabel(s: SortState, gpu: string): string {
  const name = s.key === "gpu" ? gpu : s.key === "gpumem" ? `${gpu} mem` : COLUMN_SPECS[s.key].name;
  return `Ranked by ${name}`;
}

export function mountCodeSection(host: HTMLElement, ctx: ViewContext): ViewHandle {
  const m = ctx.model;
  const store = ctx.store;
  const disposer = createDisposer();
  let layout = codeLayout(store.get().layout);
  let file: FileM | null = null;
  let revealing = false;
  let appbarH = 52;

  // ── Header & toolbar ──────────────────────────────────────────────────────
  const hiddenN = m.hiddenFiles.length;
  const desc = `${m.files.length} file${m.files.length === 1 ? "" : "s"}${hiddenN ? ` (+${hiddenN} below 1%)` : ""} · bars scaled to the hottest line (${fmtPct(m.maxLineTotal)} of run)`;
  const header = sectionHeader({ section: "code", title: "Code", description: desc });

  const viewSeg: Choice<"lines" | "functions"> = segmented({
    label: "View",
    options: [
      { value: "lines", label: "Lines" },
      { value: "functions", label: "Functions" },
    ],
    value: store.get().code.view,
    onChange: (v) => store.update((s) => ({ code: { ...s.code, view: v } })),
  });
  const modeSeg: Choice<DisplayMode> = segmented({
    label: "Which lines",
    options: MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: modeDescription(o.value, m.caps) })),
    value: DEFAULT_PER_FILE.mode,
    onChange: (v) => writeMode(v),
  });
  modeSeg.buttons().forEach((b, i) => disposer.add(bindTooltip(ctx.tooltip, b, { title: MODE_OPTIONS[i].label, hint: modeDescription(MODE_OPTIONS[i].value, m.caps) })));
  // Compatibility (§4.8.5, upstream `<select>`): hosts may set `#display-mode-file-N.value`
  // and then call `onFileDisplayModeChange("file-N")`, which reads it back.
  {
    const read = Object.getOwnPropertyDescriptor(modeSeg.el, "value")?.get;
    Object.defineProperty(modeSeg.el, "value", {
      configurable: true,
      get: () => (read ? read.call(modeSeg.el) : modeSeg.value()),
      set: (v: unknown) => {
        if (MODE_OPTIONS.some((o) => o.value === v)) modeSeg.set(v as DisplayMode);
      },
    });
  }
  const wrapSw = switchControl({
    label: "Wrap long lines",
    checked: store.get().code.wrap,
    onChange: (on) => {
      storageSet(STORAGE_KEYS.codeWrap, on ? "1" : "0");
      store.update((s) => ({ code: { ...s.code, wrap: on } }));
    },
  });
  wrapSw.el.classList.add("code-wrap");
  const rankChip = h("span", { class: "code-rank" });
  const toolbar = h(
    "div",
    { class: "code-toolbar", role: "toolbar", "aria-label": "Code view options" },
    viewSeg.el,
    modeSeg.el,
    wrapSw.el,
    rankChip,
  );
  disposer.add(viewSeg);
  disposer.add(modeSeg);

  function writeMode(mode: DisplayMode): void {
    if (!file) return;
    const name = file.name;
    store.update((s) => {
      const cur = s.code.perFile[name] ?? DEFAULT_PER_FILE;
      return { code: { ...s.code, perFile: { ...s.code.perFile, [name]: { ...cur, mode, unfolded: [] } } } };
    });
    ctx.announce.polite(`${MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode}`);
  }

  function renderRank(sort: SortState | null): void {
    if (!sort || sort.key === "line" || store.get().code.view !== "lines") {
      rankChip.replaceChildren();
      rankChip.hidden = true;
      return;
    }
    rankChip.hidden = false;
    rankChip.replaceChildren(
      h(
        "span",
        { class: "code-rank-chip" },
        `${sortLabel(sort, m.gpu?.name || "GPU")} ${sort.dir === "desc" ? "↓" : "↑"}`,
      ),
      button({
        label: "Source order",
        icon: "reset",
        variant: "ghost",
        compact: true,
        onClick: () => {
          if (!file) return;
          const name = file.name;
          store.update((s) => {
            const cur = s.code.perFile[name] ?? DEFAULT_PER_FILE;
            return { code: { ...s.code, perFile: { ...s.code.perFile, [name]: { ...cur, sort: null } } } };
          });
          ctx.announce.polite("Source order");
        },
      }),
    );
  }

  // ── Detail (shared by dock and lens) ──────────────────────────────────────
  const dock = h("aside", { class: "code-dock", "aria-label": "Line details" });
  const detail = createDetail(ctx, {
    close: () => {
      if (layout.dock) store.set({ selection: null });
      else table.closeLens();
    },
    optimize: (l, mode) => ctx.ai.request(l.file.name, l.no, mode),
    goToFunction: (fn) => void ctx.nav.jumpTo({ file: fn.file.name, line: fn.no }, { source: "detail" }),
  });

  const subjectOf = (t: Target | null): DetailSubject | null => {
    if (!t) return null;
    if ("line" in t) {
      const l = lineAt(m, t.file, t.line);
      return l ? { kind: "line", line: l } : null;
    }
    const fn = functionAt(m, t.file, t.fn);
    return fn ? { kind: "fn", fn } : null;
  };

  function syncDock(): void {
    if (!layout.dock) return;
    const subject = subjectOf(store.get().selection);
    if (detail.el.parentElement !== dock) dock.replaceChildren(detail.el);
    dock.setAttribute("aria-label", subject ? detailLabel(subject) : "Line details");
    const cur = detail.subject();
    const same =
      cur && subject && ((cur.kind === "line" && subject.kind === "line" && cur.line === subject.line) || (cur.kind === "fn" && subject.kind === "fn" && cur.fn === subject.fn));
    if (!same || !detail.el.classList.contains("cd-dock") || (!subject && cur)) detail.update(subject, "dock", 1);
  }

  // ── File bar ──────────────────────────────────────────────────────────────
  const filebar = h("div", { class: "code-filebar", id: "code-filebar" });
  let counts: [number, number] = [0, 0];
  let filebarTip: (() => void) | null = null;

  function renderFilebar(): void {
    if (!file) return;
    const f = file;
    const items: Child[] = [];
    // Not a Tab stop unless the directory is cut off (syncPathFocus): the summary is visible
    // text, and the table points at this bar with aria-describedby.
    const path = h(
      "span",
      { class: "code-path" },
      f.dir ? h("span", { class: "code-dir" }, h("span", { class: "fn-dir-inner" }, `‎${f.dir}‎`)) : null,
      h("span", { class: "code-base mono" }, f.base),
    );
    items.push(path);
    items.push(
      h(
        "span",
        { class: "code-fb-item code-fb-share" },
        h("span", { class: "code-fb-meter" }, meter(document, { segments: fileShareSegments(f), max: 100, height: 6, graduations: true })),
        h("span", null, h("b", null, fmtPct(f.pct)), ` of run · ${P.fileShare(f.pct, m.elapsed).split(" · ")[1] ?? ""}`),
      ),
    );
    if (m.caps.memory && f.peak > 0) items.push(h("span", { class: "code-fb-item" }, "peak ", h("b", null, fmtMem(f.peak))));
    if (m.caps.gpu && m.caps.gpuMemory && f.gpuPeak > 0) items.push(h("span", { class: "code-fb-item" }, `${m.gpu?.name || "GPU"} mem `, h("b", null, fmtMem(f.gpuPeak))));
    if (m.caps.neuron && m.elapsed > 0 && (f.nrtMs > 0 || f.ncMs > 0)) {
      items.push(h("span", { class: "code-fb-item" }, "NRT ", h("b", null, fmtPct(f.nrtMs / 10 / m.elapsed)), " · NC ", h("b", null, fmtPct(f.ncMs / 10 / m.elapsed)), " of run"));
    }
    if (f.leaks.length) {
      items.push(h("span", { class: "code-fb-item code-fb-leak" }, icon("trend-up", 12), `${f.leaks.length} possible leak${f.leaks.length === 1 ? "" : "s"}`));
    }
    const [shown, total] = counts;
    items.push(h("span", { class: "code-fb-item code-fb-count" }, store.get().code.view === "functions" ? `${f.functions.length} function${f.functions.length === 1 ? "" : "s"}` : `${total} lines, ${shown} shown`));
    if (f.hidden) items.push(h("span", { class: "code-fb-item code-fb-hidden" }, hiddenCaption(1).replace(/^1 file /, "")));
    filebar.replaceChildren(...(items as Node[]));
    // Measured once per frame, not after every DOM write of a file switch (§6.1 file switch).
    if (!pathFrame) pathFrame = requestAnimationFrame(() => {
      pathFrame = 0;
      syncPathFocus();
    });
    filebarTip?.();
    filebarTip = bindTooltip(ctx.tooltip, path, () => {
      const t = fileTooltip(f, m);
      return { ...t, rows: [...(t.rows ?? []), ["lines", `${total} lines, ${shown} shown`]] };
    });
  }

  /**
   * The path is focusable only while the directory is ellipsized: then it is a named group
   * whose tooltip (on focus) gives the full path. Otherwise it would be an empty Tab stop.
   */
  let pathFrame = 0;
  function syncPathFocus(): void {
    const path = filebar.querySelector<HTMLElement>(".code-path");
    if (!path || !file || document.activeElement === path) return;
    const dir = path.querySelector<HTMLElement>(".code-dir");
    const cut = !!dir && dir.scrollWidth > dir.clientWidth + 1;
    for (const [k, v] of [["tabindex", "0"], ["role", "group"], ["aria-label", file.name]]) cut ? path.setAttribute(k, v) : path.removeAttribute(k);
  }


  // ── Table, function view, file nav ────────────────────────────────────────
  const inset = () => appbarH + (layout.short ? 0 : 40) + 32;
  const table: CodeTable = createCodeTable({
    ctx,
    detail,
    bp: () => layout.bp,
    inset,
    useLens: () => !layout.dock,
    lensColumns: () => layout.lensCols,
    onCounts: (shown, total) => {
      counts = [shown, total];
      renderFilebar();
    },
    onSortChange: (s) => renderRank(s),
  });
  table.table.id = "code-table";
  table.table.setAttribute("aria-describedby", "code-filebar");

  const fnView = createFunctionView({
    ctx,
    bp: () => layout.bp,
    onOpen: (fn: FunctionM) => {
      store.update((s) => ({ code: { ...s.code, view: "lines" } }));
      void ctx.nav.jumpTo({ file: fn.file.name, fn: fn.name }, { source: "code" });
    },
    onLines: () => store.update((s) => ({ code: { ...s.code, view: "lines" } })),
  });

  const nav = createFileNav({
    ctx,
    onSelect: (f) => store.update((s) => ({ code: { ...s.code, file: f.name } })),
  });

  const card = h("div", { class: "code-card card" }, nav.bar, filebar, table.el, fnView.el);
  const main = h("div", { class: "code-main" }, card);
  const grid = h("div", { class: "code-layout" }, nav.rail, main, dock);
  host.append(header, toolbar, grid);

  // ── File switching ────────────────────────────────────────────────────────
  function switchFile(f: FileM, opts: { keepSelection: boolean; crossfade: boolean }): void {
    if (f === file) return;
    file = f;
    modeSeg.el.id = `display-mode-file-${f.no}`;
    const per = store.get().code.perFile[f.name] ?? DEFAULT_PER_FILE;
    modeSeg.set(per.mode);
    nav.setCurrent(f);
    // Switch the table first so clearing the selection cannot animate the old file's lens.
    table.setFile(f, { crossfade: opts.crossfade });
    if (!opts.keepSelection && store.get().selection) store.set({ selection: null });
    fnView.setFile(f);
    setPins(currentPins);
    renderFilebar();
  }

  // ── Pins (hotspot ranks for this file) ────────────────────────────────────
  let currentPins: HotspotItem[] = (() => {
    const hs = store.get().hotspots;
    try {
      return hotspotList(m, hs.kind, hs.metric, 8).items;
    } catch {
      return [];
    }
  })();
  function setPins(items: HotspotItem[]): void {
    currentPins = items;
    if (!file) return;
    const pins: MinimapPin[] = [];
    for (const it of items) {
      if (it.target.file !== file.name) continue;
      if ("line" in it.target) pins.push({ rank: it.rank, line: it.target.line });
      else {
        const fn = functionAt(m, it.target.file, it.target.fn);
        if (fn) pins.push({ rank: it.rank, line: fn.no });
      }
    }
    table.setPins(pins);
  }

  // ── View & layout ─────────────────────────────────────────────────────────
  function applyView(): void {
    const v = store.get().code.view;
    viewSeg.set(v);
    const fns = v === "functions";
    table.el.hidden = fns;
    fnView.el.hidden = !fns;
    modeSeg.el.hidden = fns;
    wrapSw.el.hidden = fns;
    card.classList.toggle("is-functions", fns);
    renderRank(fns ? null : file ? (store.get().code.perFile[file.name]?.sort ?? null) : null);
    renderFilebar();
    if (fns) fnView.relayout();
    else table.relayout();
  }

  function readAppbar(): void {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--appbar-h"));
    appbarH = Number.isFinite(v) && v > 0 ? v : 52;
    host.style.setProperty("--code-inset", `${inset()}px`);
  }

  function applyLayout(): void {
    layout = codeLayout(store.get().layout);
    readAppbar();
    host.classList.toggle("code-short", layout.short);
    grid.classList.toggle("has-rail", layout.nav === "rail");
    grid.classList.toggle("has-dock", layout.dock);
    dock.hidden = !layout.dock;
    nav.setMode(layout.nav, layout.sheet);
    if (file) nav.setCurrent(file);
    if (layout.dock) {
      syncDock();
    } else if (detail.el.parentElement === dock) {
      dock.replaceChildren();
    }
    if (store.get().code.view === "functions") fnView.relayout();
    else table.relayout();
  }

  // ── CodeApi ───────────────────────────────────────────────────────────────
  const api: CodeApi = {
    async reveal(target, opts) {
      const f = m.fileByName.get(target.file);
      if (!f) return;
      revealing = true;
      try {
        // 1. Switch file (reveals the hidden group if needed); Functions view → Lines.
        if (store.get().code.view !== "lines") store.update((s) => ({ code: { ...s.code, view: "lines" } }));
        if (store.get().code.file !== f.name) store.update((s) => ({ code: { ...s.code, file: f.name } }));
        if (file !== f) switchFile(f, { keepSelection: true, crossfade: false });
      } finally {
        revealing = false;
      }
      await table.reveal(target, opts);
      if (layout.dock) syncDock();
    },
    currentFile: () => file?.name ?? null,
    showHiddenFiles: () => nav.showHidden(),
  };
  ctx.registerApi("code", api);

  // ── Subscriptions ─────────────────────────────────────────────────────────
  disposer.add(
    store.subscribe(
      (s) => s.code.file,
      (name) => {
        const f = name ? m.fileByName.get(name) : undefined;
        if (f) switchFile(f, { keepSelection: revealing, crossfade: !revealing });
      },
    ),
  );
  disposer.add(store.subscribe((s) => s.code.view, () => applyView()));
  disposer.add(
    store.subscribe(
      (s) => s.code.wrap,
      (on) => {
        wrapSw.set(on);
        table.relayout();
      },
    ),
  );
  disposer.add(
    store.subscribe(
      (s) => (file ? s.code.perFile[file.name] : undefined),
      (per) => {
        modeSeg.set((per ?? DEFAULT_PER_FILE).mode);
        renderRank(per?.sort ?? null);
      },
    ),
  );
  disposer.add(store.subscribe((s) => s.selection, () => syncDock()));
  disposer.add(store.subscribe((s) => s.layout, () => applyLayout()));
  disposer.add(ctx.bus.on("theme:changed", () => table.redraw()));
  disposer.add(ctx.bus.on("hotspots:changed", ({ items }) => setPins(items)));
  disposer.add(
    observeSize(main, () => {
      if (store.get().code.view === "functions") fnView.relayout();
      else table.relayout();
      syncPathFocus();
    }),
  );

  // ── First render ──────────────────────────────────────────────────────────
  applyLayout();
  const initialName = store.get().code.file;
  const initial = (initialName ? m.fileByName.get(initialName) : undefined) ?? m.files[0] ?? m.hiddenFiles[0];
  if (initial) {
    if (store.get().code.file !== initial.name) {
      revealing = true;
      store.update((s) => ({ code: { ...s.code, file: initial.name } }));
      revealing = false;
    }
    if (file !== initial) switchFile(initial, { keepSelection: true, crossfade: false });
  }
  applyView();
  syncDock();

  // Test/debug hook (non-enumerable; used by tools/wp3 checks).
  Object.defineProperty(host, "__code", {
    configurable: true,
    value: {
      table: () => table.debug(),
      file: () => file?.name ?? null,
      layout: () => layout,
      showHidden: () => nav.showHidden(),
    },
  });

  return {
    destroy() {
      cancelAnimationFrame(pathFrame);
      disposer.dispose();
      filebarTip?.();
      table.destroy();
      fnView.destroy();
      nav.destroy();
      detail.destroy();
      host.replaceChildren();
    },
  };
}

export type { LineM };
