// Command palette (DESIGN.md §4.20): ⌘/Ctrl+K, `/` or the app-bar Search button. A modal
// dialog (inert background) with a combobox and a grouped listbox: Lines, Functions, Files,
// Sections, Actions; the top 5 hotspots on an empty query. Opens and closes instantly (M24).
// The search index is built lazily (sliced) on first open.
import type { ModalHandle } from "../../core/a11y";
import { modKeyLabel } from "../../core/controls";
import { h, uid, VISUALLY_HIDDEN, type Child } from "../../core/dom";
import { fmtMem, fmtPct } from "../../core/format";
import { icon, type IconName } from "../../core/icons";
import type { SectionId } from "../../core/store";
import { hotspotList } from "../../model/hotspots";
import type { FileM, FunctionM, LineM, Model } from "../../model/model";
import { fuzzyMatch, type SearchIndex } from "../../model/search";
import { highlight } from "../../model/syntax";
import type { OverlayApi, ShellContext } from "../app";

export type GroupKey = "hotspots" | "lines" | "functions" | "files" | "sections" | "actions";

export const GROUP_LABEL: Record<GroupKey, string> = {
  hotspots: "Top hotspots",
  lines: "Lines",
  functions: "Functions",
  files: "Files",
  sections: "Sections",
  actions: "Actions",
};

/** Rows shown per group before "Show all" (§4.20: max 8 visible rows per group). */
export const GROUP_ROWS = 8;
export const MAX_LINES = 50;

export const SECTION_LABELS: Record<SectionId, string> = {
  overview: "Overview",
  code: "Code",
  stacks: "Stacks",
  timeline: "Timeline",
  memory: "Memory",
};

/** Text that looks like code (an expression, a call, a dotted name) searches Lines first. */
export function isCodeLike(q: string): boolean {
  return /[.()[\]{}=:,'"+\-*/<>%@!]|\s/.test(q.trim()) || /_/.test(q);
}

/**
 * Group order for a query: an exact-prefix match of a section or action label comes first
 * ("Timeline"); then Lines, Functions and Files ordered by the quality of their best hit
 * (`best`, match strength 3 = word-start/prefix, 2 = substring, 1 = scattered subsequence),
 * so an exact substring in code beats a subsequence strewn through a path ("loss" → the
 * `loss.item()` line, not adamw.py). Ties keep the default: Lines first for code-like text
 * ("loss.item"), else Functions and Files ("train"). Empty query: hotspots, sections, actions.
 */
export function groupOrder(
  q: string,
  prefixHit: { sections: boolean; actions: boolean },
  best: Partial<Record<"lines" | "functions" | "files", number>> = {},
): GroupKey[] {
  if (!q.trim()) return ["hotspots", "sections", "actions"];
  const head: GroupKey[] = [];
  if (prefixHit.sections) head.push("sections");
  if (prefixHit.actions) head.push("actions");
  const base: ("lines" | "functions" | "files")[] = isCodeLike(q) ? ["lines", "functions", "files"] : ["functions", "files", "lines"];
  const code = base
    .map((g, i) => ({ g, i, s: best[g] ?? 0 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.g as GroupKey);
  const rest: GroupKey[] = (["sections", "actions"] as GroupKey[]).filter((g) => !head.includes(g));
  return [...head, ...code, ...rest];
}

/** Best match strength per group of a search result (0 when the group is empty). */
export function bestStrengths(res: { lines: readonly { strength: number }[]; functions: readonly { strength: number }[]; files: readonly { strength: number }[] }): Record<"lines" | "functions" | "files", number> {
  const top = (xs: readonly { strength: number }[]) => xs.reduce((m, x) => Math.max(m, x.strength), 0);
  return { lines: top(res.lines), functions: top(res.functions), files: top(res.files) };
}

export interface ActionSpec {
  id: string;
  label: string;
  keywords: string;
  icon: IconName;
  hint?: string;
}

export const ACTIONS: readonly ActionSpec[] = [
  { id: "theme", label: "Toggle theme", keywords: "dark light mode appearance", icon: "moon" },
  { id: "system-theme", label: "Use system theme", keywords: "auto os appearance", icon: "monitor" },
  { id: "ai", label: "Open AI settings", keywords: "provider api key openai anthropic gemini ollama bedrock azure", icon: "spark" },
  { id: "load", label: "Load profile…", keywords: "open file json import", icon: "upload" },
  { id: "expand", label: "Expand all lines", keywords: "show all unfold code", icon: "unfold" },
  { id: "collapse", label: "Show hot lines only (Hot only)", keywords: "collapse fold profiled hot only", icon: "fold" },
  { id: "motion", label: "Reduce motion", keywords: "animation accessibility", icon: "eye" },
  { id: "shortcuts", label: "Keyboard shortcuts", keywords: "keys help", icon: "info", hint: "?" },
  { id: "optimize-line", label: "Optimize selected line", keywords: "ai proposal", icon: "spark", hint: "O" },
  { id: "optimize-region", label: "Optimize selected region", keywords: "ai proposal loop function", icon: "spark", hint: "Shift O" },
];

/** Fuzzy filter over labels (+ keywords at a lower weight); prefix matches first. */
export function filterLabels<T extends { label: string; keywords?: string }>(items: readonly T[], q: string): { item: T; prefix: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items.map((item) => ({ item, prefix: false }));
  const out: { item: T; score: number; prefix: boolean }[] = [];
  for (const item of items) {
    const lower = item.label.toLowerCase();
    const prefix = lower.startsWith(needle);
    const m = fuzzyMatch(needle, item.label);
    const k = !m && item.keywords ? (item.keywords.toLowerCase().includes(needle) ? { score: 1 } : null) : null;
    if (m || k) out.push({ item, prefix, score: (prefix ? 100 : 0) + (m ? m.score : 0) + (k ? k.score : 0) });
  }
  return out.sort((a, b) => b.score - a.score).map(({ item, prefix }) => ({ item, prefix }));
}

interface Row {
  id: string;
  group: GroupKey;
  icon: Child;
  main: Child;
  sub?: Child;
  meta?: Child;
  label: string;
  run(): void;
  expand?: boolean;
}

/** Drop weak fuzzy hits (subsequences scattered over a long name) when a strong one exists. */
export function strongHits<T extends { score: number }>(hits: readonly T[], ratio = 0.66): T[] {
  if (!hits.length) return [];
  const best = Math.max(...hits.map((x) => x.score));
  return best > 0 ? hits.filter((x) => x.score >= best * ratio) : hits.slice();
}

/**
 * Files: when some base names match ("train" → train.py), path-only matches (a directory
 * named llm-train) are noise; keep them only for queries that look like paths.
 */
export function preferBaseNames<T extends { item: { base: string } }>(hits: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (needle.includes("/") || needle.includes("\\")) return hits.slice();
  const base = hits.filter((x) => fuzzyMatch(needle, x.item.base) !== null);
  return base.length ? base : hits.slice();
}

/** Highlighted code with the match range [start, end) underlined; leading indentation trimmed. */
function codeWithMatch(text: string, start: number, end: number): Child[] {
  const lead = text.length - text.trimStart().length;
  let shown = text.slice(lead);
  let a = Math.max(0, start - lead);
  let b = Math.max(a, end - lead);
  let prefix = "";
  if (a > 48) {
    const cut = a - 24;
    shown = shown.slice(cut);
    a -= cut;
    b -= cut;
    prefix = "…";
  }
  const out: Child[] = prefix ? [h("span", { class: "pal-ell" }, prefix)] : [];
  let pos = 0;
  for (const s of highlight(shown)) {
    const s0 = pos;
    const s1 = pos + s.text.length;
    pos = s1;
    const parts: [string, boolean][] = [];
    if (b <= s0 || a >= s1 || a === b) parts.push([s.text, false]);
    else {
      if (a > s0) parts.push([s.text.slice(0, a - s0), false]);
      parts.push([s.text.slice(Math.max(0, a - s0), Math.min(s.text.length, b - s0)), true]);
      if (b < s1) parts.push([s.text.slice(b - s0), false]);
    }
    for (const [t, hit] of parts) {
      if (!t) continue;
      const node = s.cls ? h("span", { class: s.cls }, t) : t;
      out.push(hit ? h("span", { class: "pal-hit" }, node) : node);
    }
  }
  return out;
}

/** Name with fuzzy positions emphasised. */
function nameWithHits(name: string, positions: readonly number[]): Child[] {
  if (!positions.length) return [name];
  const set = new Set(positions);
  const out: Child[] = [];
  let run = "";
  let runHit = false;
  for (let i = 0; i < name.length; i++) {
    const hit = set.has(i);
    if (hit !== runHit && run) {
      out.push(runHit ? h("span", { class: "pal-hit" }, run) : run);
      run = "";
    }
    runHit = hit;
    run += name[i];
  }
  if (run) out.push(runHit ? h("span", { class: "pal-hit" }, run) : run);
  return out;
}

const ofRun = (pct: number) => (pct > 0 ? `${fmtPct(pct)} of run` : "");

export function createPalette(shell: ShellContext): OverlayApi {
  const listId = uid("pal-list");
  const inputId = uid("pal-input");
  let built = false;
  let layer: HTMLElement;
  let input: HTMLInputElement;
  let list: HTMLElement;
  let status: HTMLElement;
  let modal: ModalHandle | null = null;
  let open = false;
  let rows: Row[] = [];
  let active = 0;
  let index: SearchIndex | null = null;
  let indexFor: Model | null = null;
  let indexing: Promise<SearchIndex> | null = null;
  let showAllLines = false;
  let announceTimer = 0;

  const model = () => shell.model();

  const sections = (): SectionId[] =>
    (Object.keys(SECTION_LABELS) as SectionId[]).filter((id) => document.getElementById(id)?.classList.contains("report-section"));

  const runAction = (id: string) => {
    const a = shell.actions;
    const sel = shell.store.get().selection;
    switch (id) {
      case "theme":
        return a.toggleTheme();
      case "system-theme":
        return a.useSystemTheme();
      case "ai":
        return a.openAiSettings();
      case "load":
        return a.openFilePicker();
      case "expand":
        return (window as unknown as { expandAll?: () => void }).expandAll?.();
      case "collapse":
        return (window as unknown as { collapseAll?: () => void }).collapseAll?.();
      case "motion":
        return a.setReducedMotion(!shell.motion.reduced);
      case "shortcuts":
        return a.openShortcuts();
      case "optimize-line":
      case "optimize-region":
        if (sel && "line" in sel) shell.ai().request(sel.file, sel.line, id === "optimize-line" ? "line" : "region");
        else shell.toast.show({ kind: "info", text: "Select a line in the code view first" });
        return;
    }
  };

  const go = (fn: () => void | Promise<void>) => () => {
    close();
    void Promise.resolve().then(fn);
  };

  const lineRow = (l: LineM, start: number, end: number, group: GroupKey = "lines"): Row => ({
    id: uid("pal-opt"),
    group,
    icon: icon("code"),
    main: h("span", { class: "pal-code code" }, codeWithMatch(l.text, start, end)),
    sub: `${l.file.base}:${l.no}`,
    meta: ofRun(l.total),
    label: `${l.text.trim()} — ${l.file.base} line ${l.no}${l.total > 0 ? `, ${fmtPct(l.total)} of run` : ""}`,
    run: go(() => shell.nav()?.jumpTo({ file: l.file.name, line: l.no }, { source: "palette" })),
  });

  const fnRow = (f: FunctionM, positions: number[]): Row => ({
    id: uid("pal-opt"),
    group: "functions",
    icon: icon("fn"),
    main: h("span", { class: "pal-name code" }, nameWithHits(f.name, positions)),
    sub: `${f.file.base}${f.no ? `:${f.no}` : ""}`,
    meta: ofRun(f.total),
    label: `Function ${f.name} in ${f.file.base}${f.total > 0 ? `, ${fmtPct(f.total)} of run` : ""}`,
    run: go(() => shell.nav()?.jumpTo({ file: f.file.name, fn: f.name }, { source: "palette" })),
  });

  const fileRow = (f: FileM, basePositions: number[]): Row => {
    const m = model();
    const peak = m?.caps.memory && f.peak > 0 ? `peak ${fmtMem(f.peak)}` : "";
    const share = f.pct > 0 ? `${fmtPct(f.pct)} of run` : "";
    return {
      id: uid("pal-opt"),
      group: "files",
      icon: icon("file"),
      main: h("span", { class: "pal-name code" }, nameWithHits(f.base, basePositions)),
      sub: f.dir || undefined,
      meta: [share, peak ? h("span", { class: "pal-meta-extra" }, `${share ? " · " : ""}${peak}`) : null],
      label: `File ${f.name}${share ? `, ${share}` : ""}${peak ? `, ${peak}` : ""}`,
      run: go(() => {
        shell.store.update((s) => ({ code: { ...s.code, file: f.name } }));
        return shell.nav()?.showSection("code", { focus: true });
      }),
    };
  };

  const sectionRow = (id: SectionId): Row => ({
    id: uid("pal-opt"),
    group: "sections",
    icon: icon("sections"),
    main: SECTION_LABELS[id],
    meta: "Go to section",
    label: `Go to ${SECTION_LABELS[id]}`,
    run: go(() => shell.nav()?.showSection(id, { focus: true, toSelection: true })),
  });

  const actionRow = (a: ActionSpec): Row => {
    let label = a.label;
    let meta: Child = a.hint ? h("kbd", { class: "key-chip" }, a.hint) : undefined;
    if (a.id === "theme") meta = shell.theme.current() === "dark" ? "Dark → Light" : "Light → Dark";
    if (a.id === "motion") meta = shell.motion.reduced ? "On" : "Off";
    if (a.id === "optimize-line" || a.id === "optimize-region") {
      const sel = shell.store.get().selection;
      if (sel && "line" in sel) label = `${a.label} (${sel.file.split(/[\\/]/).pop()}:${sel.line})`;
    }
    return {
      id: uid("pal-opt"),
      group: "actions",
      icon: icon(a.icon === "moon" && shell.theme.current() === "dark" ? "sun" : a.icon),
      main: label,
      meta,
      label,
      run: go(() => runAction(a.id)),
    };
  };

  // ── Query → rows ──────────────────────────────────────────────────────────
  function compute(q: string): Row[] {
    const m = model();
    if (!m) return [];
    const secs = filterLabels(
      sections().map((id) => ({ id, label: SECTION_LABELS[id] })),
      q,
    );
    const acts = filterLabels(ACTIONS, q);
    const res = q.trim() && index ? index.query(q, { lines: MAX_LINES, functions: GROUP_ROWS, files: GROUP_ROWS }) : null;
    const order = groupOrder(q, { sections: secs.some((s) => s.prefix), actions: acts.some((a) => a.prefix) }, res ? bestStrengths(res) : {});
    const out: Row[] = [];
    for (const g of order) {
      if (g === "hotspots") {
        for (const it of hotspotList(m, "lines", "time", 5).items) {
          if (!it.line) continue;
          const r = lineRow(it.line, 0, 0, "hotspots");
          r.meta = it.valueText ? `${it.valueText} of run` : r.meta;
          r.icon = h("span", { class: "pal-rank num" }, String(it.rank));
          out.push(r);
        }
      } else if (g === "sections") {
        out.push(...secs.map((s) => sectionRow(s.item.id)));
      } else if (g === "actions") {
        out.push(...acts.map((a) => actionRow(a.item)));
      } else if (res && g === "lines") {
        const hits = showAllLines ? res.lines : res.lines.slice(0, GROUP_ROWS);
        out.push(...hits.map((x) => lineRow(x.line, x.start, x.end)));
        if (!showAllLines && res.lines.length > GROUP_ROWS) {
          out.push({
            id: uid("pal-opt"),
            group: "lines",
            icon: icon("chevron-down"),
            main: `Show all ${res.lines.length}${res.lines.length >= MAX_LINES ? "+" : ""} matching lines`,
            label: `Show all ${res.lines.length} matching lines`,
            expand: true,
            run: () => {
              showAllLines = true;
              render(GROUP_ROWS);
            },
          });
        }
      } else if (res && g === "functions") {
        out.push(...strongHits(res.functions).map((x) => fnRow(x.item, x.positions)));
      } else if (res && g === "files") {
        out.push(...strongHits(preferBaseNames(res.files, q)).map((x) => fileRow(x.item, x.positions)));
      }
    }
    return out;
  }

  function render(keepActive?: number): void {
    const q = input.value;
    rows = compute(q);
    active = Math.max(0, Math.min(rows.length - 1, keepActive ?? 0));
    const groups = new Map<GroupKey, Row[]>();
    for (const r of rows) {
      const list = groups.get(r.group) ?? [];
      list.push(r);
      groups.set(r.group, list);
    }
    const children: HTMLElement[] = [];
    for (const [g, items] of groups) {
      const labelId = uid("pal-g");
      const count = g === "lines" ? items.filter((r) => !r.expand).length : items.length;
      children.push(
        h(
          "div",
          { class: "pal-group", role: "group", "aria-labelledby": labelId },
          h("div", { class: "pal-group-label micro", id: labelId, role: "presentation" }, GROUP_LABEL[g], h("span", { class: "pal-count num" }, String(count))),
          items.map((r) =>
            h(
              "div",
              {
                id: r.id,
                class: ["pal-opt", r.expand ? "pal-opt-expand" : ""],
                role: "option",
                "aria-selected": "false",
                "aria-label": r.label,
                dataset: { index: rows.indexOf(r) },
              },
              h("span", { class: "pal-ico", "aria-hidden": "true" }, r.icon),
              h("span", { class: "pal-text" }, h("span", { class: "pal-main" }, r.main), r.sub ? h("span", { class: "pal-sub" }, r.sub) : null),
              r.meta ? h("span", { class: "pal-meta num" }, r.meta) : null,
            ),
          ),
        ),
      );
    }
    if (!rows.length) {
      children.push(
        h(
          "p",
          { class: "pal-empty" },
          q.trim() && !index ? "Indexing the profile…" : `No lines, functions, files or commands match “${q.trim()}”.`,
        ),
      );
    }
    list.replaceChildren(...children);
    input.setAttribute("aria-expanded", String(rows.length > 0));
    setActive(active, false);
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      if (open && q.trim()) shell.announce.polite(rows.length ? `${rows.length} result${rows.length === 1 ? "" : "s"}` : "No results");
    }, 400);
  }

  function setActive(i: number, scroll = true): void {
    const opts = Array.from(list.querySelectorAll<HTMLElement>(".pal-opt"));
    if (!opts.length) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    active = (i + opts.length) % opts.length;
    opts.forEach((el, k) => {
      const on = k === active;
      el.setAttribute("aria-selected", String(on));
      el.classList.toggle("is-active", on);
    });
    const el = opts[active];
    input.setAttribute("aria-activedescendant", el.id);
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  function ensureIndex(): void {
    const m = model();
    if (!m) return;
    if (indexFor !== m) {
      index = null;
      indexFor = m;
      indexing = null;
    }
    if (index || indexing) return;
    status.textContent = "Indexing the profile…";
    const p = m.search();
    indexing = p;
    void p.then((ix) => {
      if (indexing !== p) return;
      index = ix;
      indexing = null;
      status.textContent = `${ix.size.toLocaleString("en-US")} lines indexed`;
      if (open) render(active);
    });
  }

  function build(): void {
    built = true;
    input = h("input", {
      id: inputId,
      class: "pal-input",
      type: "text",
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": listId,
      "aria-autocomplete": "list",
      "aria-label": "Search lines, functions, files, sections and commands",
      placeholder: "Search code, functions, files, sections, commands…",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
    });
    list = h("div", { id: listId, class: "pal-list", role: "listbox", "aria-label": "Results" });
    status = h("span", { class: "pal-status" });
    const dialog = h(
      "div",
      { class: "pal", role: "dialog", "aria-modal": "true", "aria-label": "Search" },
      h(
        "div",
        { class: "pal-field" },
        h("span", { class: "pal-field-icon", "aria-hidden": "true" }, icon("search")),
        input,
        h(
          "button",
          { type: "button", class: "pal-esc", "aria-label": "Close search", onClick: () => close() },
          h("kbd", { class: "key-chip" }, "Esc"),
        ),
      ),
      list,
      h(
        "div",
        { class: "pal-foot", "aria-hidden": "true" },
        h("span", null, h("kbd", { class: "key-chip" }, "↑"), h("kbd", { class: "key-chip" }, "↓"), " move"),
        h("span", null, h("kbd", { class: "key-chip" }, "↵"), " open"),
        h("span", null, h("kbd", { class: "key-chip" }, "Esc"), " close"),
        h("span", { class: "pal-foot-gap" }),
        status,
      ),
      h("p", { class: VISUALLY_HIDDEN }, `Type to search. Use the up and down arrows to move and Enter to open. ${modKeyLabel("K")} opens search from anywhere.`),
    );
    layer = h("div", { class: "pal-layer", hidden: true }, h("div", { class: "pal-scrim", "aria-hidden": "true", onClick: () => close() }), dialog);
    shell.layerRoot.appendChild(layer);

    input.addEventListener("input", () => {
      showAllLines = false;
      render(0);
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.isComposing) return;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        setActive(active + (ev.key === "ArrowDown" ? 1 : -1));
      } else if (ev.key === "PageDown" || ev.key === "PageUp") {
        ev.preventDefault();
        const n = list.querySelectorAll(".pal-opt").length;
        setActive(Math.max(0, Math.min(n - 1, active + (ev.key === "PageDown" ? GROUP_ROWS : -GROUP_ROWS))));
      } else if ((ev.key === "Home" || ev.key === "End") && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        setActive(ev.key === "Home" ? 0 : list.querySelectorAll(".pal-opt").length - 1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        rows[active]?.run();
      }
    });
    list.addEventListener("pointermove", (ev) => {
      const opt = (ev.target as Element).closest<HTMLElement>(".pal-opt");
      if (!opt) return;
      const i = Number(opt.dataset.index);
      if (i !== active) setActive(i, false);
    });
    list.addEventListener("click", (ev) => {
      const opt = (ev.target as Element).closest<HTMLElement>(".pal-opt");
      if (!opt) return;
      rows[Number(opt.dataset.index)]?.run();
    });
    // Keep focus in the input when the list is clicked (options are not focusable).
    list.addEventListener("mousedown", (ev) => ev.preventDefault());
  }

  function show(): void {
    if (!model()) return;
    if (!built) build();
    if (open) {
      input.focus();
      input.select();
      return;
    }
    open = true;
    layer.hidden = false;
    shell.tooltip.hide();
    shell.store.update((s) => ({ layers: { ...s.layers, palette: true } }));
    input.value = "";
    showAllLines = false;
    ensureIndex();
    render(0);
    modal = shell.modals.open(layer.querySelector(".pal") as HTMLElement, { onEscape: () => close(), initialFocus: input });
  }

  function close(): void {
    if (!open) return;
    open = false;
    window.clearTimeout(announceTimer);
    layer.hidden = true;
    modal?.close();
    modal = null;
    shell.store.update((s) => ({ layers: { ...s.layers, palette: false } }));
  }

  return {
    open: show,
    close,
    isOpen: () => open,
    destroy() {
      close();
      if (built) layer.remove();
    },
  };
}
