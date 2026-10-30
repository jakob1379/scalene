/**
 * Call stacks section (DESIGN.md §4.11): header with the CPU | Memory tabs,
 * the toolbar (search with matched share, colour mode, legend, reset), the
 * zoom breadcrumb and the flame chart. Registers `StacksApi` so "Show in
 * stacks" (code view, hotspots, detail panel) can focus a line.
 */

import { icon } from "../../core/icons";
import { bindTooltip } from "../../core/tooltip";
import { createDisposer, h, isTypingTarget, uid, VISUALLY_HIDDEN } from "../../core/dom";
import { menu, sectionHeader, select, tabs, type Choice, type SelectControl } from "../../core/controls";
import { basename } from "../../core/format";
import { DUR, EASE_CSS } from "../../core/motion";
import type { Target } from "../../core/store";
import { functionAt } from "../../model/model";
import { makeFileSourceLookup } from "../../model/source";
import { fileColorIndex, searchFlame, type FlameNode, type FlameNodeKind, type FlameSearch, type FlameTree } from "../../model/stacks";
import type { StacksApi, ViewContext, ViewHandle } from "../app";
import { createFlameChart } from "./flame";
import { flameDescription, matchSummary, nodeForLine, nodeForRange, shortRef, showInStacksZoom, type TreeKind } from "./flamemodel";
import { createShowInCaption } from "./details";
import type { ColorMode } from "./shared";

const MODE_LABEL: Record<ColorMode, string> = { kind: "Kind", file: "File", self: "Self" };
const KIND_LEGEND: { kind: FlameNodeKind; label: string; cls: string }[] = [
  { kind: "py", label: "Python", cls: "sw-py" },
  { kind: "native", label: "native", cls: "sw-native" },
  { kind: "await", label: "await", cls: "sw-await" },
  { kind: "unresolved", label: "unresolved", cls: "sw-unresolved" },
];

export function mountStacksSection(host: HTMLElement, ctx: ViewContext): ViewHandle {
  const { model, store } = ctx;
  const dispose = createDisposer();
  const sourceLookup = makeFileSourceLookup(model);
  const tabsAvail: TreeKind[] = [];
  if (model.caps.stacks) tabsAvail.push("cpu");
  if (model.caps.memStacks) tabsAvail.push("memory");
  const initialTab: TreeKind = tabsAvail.includes(store.get().flame.tab) ? store.get().flame.tab : tabsAvail[0] ?? "cpu";
  let tab: TreeKind = initialTab;
  const trees: Partial<Record<TreeKind, FlameTree | null>> = {};
  const pending: (() => void)[] = [];
  let destroyed = false;

  // ── Header ──
  const panelId = uid("flame-panel");
  const helpId = uid("flame-help");
  const desc = h("span", { class: "flame-desc" }, "Preparing call stacks…");
  let tabCtl: Choice<TreeKind> | null = null;
  if (tabsAvail.length > 1) {
    tabCtl = tabs<TreeKind>({
      label: "Stack type",
      options: tabsAvail.map((k) => ({ value: k, label: k === "cpu" ? "CPU" : "Memory", controls: panelId })),
      value: tab,
      onChange: (v) => switchTab(v, true),
    });
  }
  const title = tabsAvail.includes("cpu") ? "Call stacks" : "Memory stacks";
  const header = sectionHeader({ section: "stacks", title, description: desc, actions: tabCtl ? tabCtl.el : undefined });

  // ── Toolbar ──
  const searchInput = h("input", {
    type: "search",
    class: "flame-search-input",
    placeholder: "Find function or file",
    "aria-label": "Find function or file in the stacks",
    autocomplete: "off",
    spellcheck: "false",
    value: store.get().flame.search,
  });
  const searchBox = h("label", { class: "flame-search" }, icon("search"), searchInput, h("kbd", { class: "key-chip flame-search-key", "aria-hidden": "true" }, "/"));
  const matchText = h("span", { class: "flame-match-text" });
  const prevBtn = h("button", { type: "button", class: "icon-btn icon-btn-sm flame-prev", "aria-label": "Previous match" }, icon("chevron-right"));
  const nextBtn = h("button", { type: "button", class: "icon-btn icon-btn-sm", "aria-label": "Next match" }, icon("chevron-right"));
  const matchChip = h("span", { class: "flame-match", role: "status", hidden: true }, matchText, prevBtn, nextBtn);
  const legend = h("div", { class: "flame-legend", "aria-label": "Legend" });
  let modeSel: SelectControl<ColorMode> | null = null;
  const modeHost = h("span", { class: "flame-mode" });
  const resetBtn = h("button", { type: "button", class: "btn btn-ghost btn-compact flame-reset", hidden: true }, icon("reset"), h("span", { class: "btn-label" }, "Reset zoom"));
  // xs: the colour mode moves into a ⋯ menu (§2.4.4); the select serves every other width.
  const moreBtn = h("button", { type: "button", class: "icon-btn flame-more", "aria-label": "Color mode" }, icon("menu"));
  const toolbar = h("div", { class: "flame-toolbar" }, searchBox, matchChip, h("span", { class: "flame-spacer" }), legend, modeHost, moreBtn, resetBtn);
  const crumbs = h("nav", { class: "flame-crumbs", "aria-label": "Zoom path", hidden: true });
  // "Show in stacks" landing caption (round 1): what is shown, with Clear and Back to code.
  const showInHost = h("div", { class: "showin-host", hidden: true });
  const help = h(
    "p",
    { id: helpId, class: VISUALLY_HIDDEN },
    "Flame graph. Arrow Up moves to the caller, Arrow Down to the heaviest callee, Arrow Left and Right to neighboring frames. Enter zooms, Escape zooms out, G opens the source line, Home returns to all stacks, slash searches.",
  );
  const placeholder = h("div", { class: "flame-loading", "aria-hidden": "true" }, "Preparing call stacks…");
  const empty = h("p", { class: "flame-empty", hidden: true });

  const chart = createFlameChart({
    ctx,
    sourceLookup,
    helpId,
    onZoom: (k, node) => {
      renderCrumbs(node, true);
      resetBtn.hidden = node.parent === null;
      store.update((s) => ({ flame: { ...s.flame, zoom: { ...s.flame.zoom, [k]: node.parent ? node.path : null } } }));
    },
  });
  chart.el.hidden = true;

  const card = h(
    "div",
    { class: "card stacks-card", id: panelId, role: tabCtl ? "tabpanel" : undefined, "aria-labelledby": tabCtl ? undefined : "stacks-h" },
    toolbar,
    showInHost,
    crumbs,
    placeholder,
    chart.el,
    empty,
    help,
  );
  if (tabCtl) {
    const active = tabCtl.buttons().find((b) => b.getAttribute("aria-selected") === "true");
    if (active) card.setAttribute("aria-labelledby", active.id);
  }
  host.append(header, card);

  // Reserve the final height while the tree builds (no layout shift, §6.1.1).
  const reserve = (k: TreeKind) => {
    const depth = k === "cpu" ? model.stackDepth.cpu : model.stackDepth.memory;
    const rowH = store.get().layout.short ? 18 : store.get().layout.bp === "xs" ? 22 : 20;
    placeholder.style.height = `${24 + Math.min(61, depth + 1) * rowH + 4}px`;
  };
  reserve(tab);

  // ── Breadcrumb (§4.11.3) ──
  let crumbPath: FlameNode[] = [];
  function renderCrumbs(node: FlameNode, animate: boolean): void {
    const path: FlameNode[] = [];
    for (let n: FlameNode | null = node; n; n = n.parent) path.unshift(n);
    const prevLen = crumbPath.length;
    crumbPath = path;
    crumbs.hidden = path.length <= 1;
    const items: HTMLElement[] = [];
    path.forEach((n, i) => {
      if (i > 0) items.push(h("span", { class: "crumb-sep", "aria-hidden": "true" }, "›"));
      const last = i === path.length - 1;
      const label = n.parent ? shortRef(n) : "All stacks";
      const b = h(
        "button",
        { type: "button", class: ["crumb", n.kind === "root" ? "" : "mono"], "aria-current": last ? "true" : undefined, dataset: { i } },
        label,
      );
      items.push(b);
      if (animate && i >= prevLen && i > 0 && !ctx.motion.reduced && !ctx.host.flags.still) {
        b.animate([{ opacity: 0, transform: "translateX(8px)" }, { opacity: 1, transform: "none" }], { duration: DUR.d2, easing: EASE_CSS.out });
      }
    });
    crumbs.replaceChildren(...items);
  }
  crumbs.addEventListener("click", (ev) => {
    const b = (ev.target as Element).closest<HTMLButtonElement>("button.crumb");
    if (!b) return;
    const n = crumbPath[Number(b.dataset.i)];
    if (n) {
      chart.zoomTo(n);
      chart.setFocus(n);
    }
  });
  const showIn = createShowInCaption({
    host: showInHost,
    model,
    jump: (t) => void ctx.nav.jumpTo(t, { source: "flame" }),
    onClear: () => {
      chart.setLinked(null);
      chart.focusCanvas();
    },
  });

  // ── Colour mode + legend ──
  const modesFor = (k: TreeKind): ColorMode[] => (k === "cpu" ? ["kind", "file", "self"] : ["file", "self"]);
  function colorFor(k: TreeKind): ColorMode {
    const c = store.get().flame.color[k];
    return modesFor(k).includes(c) ? c : k === "cpu" ? "kind" : "self";
  }
  const moreMenu = menu({
    trigger: moreBtn,
    label: "Color mode",
    align: "end",
    root: document.getElementById("layer-root") ?? document.body,
    items: () =>
      modesFor(tab).map((m) => ({
        label: `Color by ${MODE_LABEL[m].toLowerCase()}`,
        checked: colorFor(tab) === m,
        run: () => applyMode(m),
      })),
  });
  dispose.add(() => moreMenu.destroy());

  function applyMode(v: ColorMode): void {
    store.update((s) => ({ flame: { ...s.flame, color: { ...s.flame.color, [tab]: v } } }));
    modeSel?.set(v);
    chart.setColor(v);
    renderLegend(tab, chart.tree());
  }

  function renderModeSelect(k: TreeKind): void {
    modeSel = select<ColorMode>({
      label: "Color",
      showLabel: true,
      options: modesFor(k).map((m) => ({ value: m, label: MODE_LABEL[m] })),
      value: colorFor(k),
      onChange: (v) => applyMode(v),
    });
    modeHost.replaceChildren(modeSel.el);
  }

  let legendDispose = createDisposer();
  dispose.add(() => legendDispose.dispose());

  function renderLegend(k: TreeKind, tree: FlameTree | null): void {
    legendDispose.dispose();
    legendDispose = createDisposer();
    const mode = colorFor(k);
    const items: HTMLElement[] = [];
    if (!tree) {
      legend.replaceChildren();
      return;
    }
    if (mode === "kind") {
      const present = new Set<FlameNodeKind>();
      for (const n of tree.nodes) present.add(n.kind);
      for (const it of KIND_LEGEND) {
        if (!present.has(it.kind)) continue;
        const chip = h("span", { class: "legend-chip", dataset: { kind: it.kind } }, h("i", { class: ["legend-sw", it.cls], "aria-hidden": "true" }), it.label);
        chip.addEventListener("pointerenter", () => chart.setKindOutline(it.kind));
        chip.addEventListener("pointerleave", () => chart.setKindOutline(null));
        items.push(chip);
      }
    } else if (mode === "file") {
      const weight = new Map<string, number>();
      for (const n of tree.nodes) if (n.kind !== "root" && n.file) weight.set(n.file, (weight.get(n.file) ?? 0) + n.self);
      const top = Array.from(weight.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      for (const [file] of top) {
        const chip = h(
          "span",
          { class: "legend-chip mono" },
          h("i", { class: "legend-sw", style: { background: `var(--file-${fileColorIndex(file)})` }, "aria-hidden": "true" }),
          basename(file) || file,
        );
        legendDispose.add(bindTooltip(ctx.tooltip, chip, { title: file, hint: "Files beyond the top 8 share these tints by hash" }));
        items.push(chip);
      }
    } else {
      items.push(
        h(
          "span",
          { class: "legend-chip legend-ramp" },
          h("span", { class: "legend-ramp-word" }, "self:"),
          h("span", { class: "legend-ramp-word" }, "less"),
          h(
            "span",
            { class: "legend-ramp-steps", "aria-hidden": "true" },
            Array.from({ length: 6 }, (_, i) => h("i", { class: "legend-sw", style: { background: `var(--${k === "cpu" ? "cpu" : "mem"}-ramp-${i})` } })),
          ),
          h("span", { class: "legend-ramp-word" }, "more"),
        ),
      );
    }
    legend.replaceChildren(...items);
  }

  // ── Search (§4.11.2) ──
  let search: FlameSearch | null = null;
  let matchIdx = -1;
  function runSearch(): void {
    const tree = chart.tree();
    const q = searchInput.value;
    if (!tree || !q.trim()) {
      search = null;
      matchIdx = -1;
      chart.setSearch(null);
      matchChip.hidden = true;
      return;
    }
    search = searchFlame(tree, q);
    matchIdx = -1;
    chart.setSearch(search);
    matchChip.hidden = false;
    const sum = matchSummary(tab, search.share, search.matches.length);
    if (sum) {
      matchText.replaceChildren(sum.lead, h("strong", null, sum.value), sum.tail);
      prevBtn.hidden = nextBtn.hidden = false;
    } else {
      matchText.replaceChildren("No frames match");
      prevBtn.hidden = nextBtn.hidden = true;
    }
  }
  let searchTimer = 0;
  searchInput.addEventListener("input", () => {
    store.update((s) => ({ flame: { ...s.flame, search: searchInput.value } }));
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 60);
  });
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      cycle(ev.shiftKey ? -1 : 1);
    } else if (ev.key === "Escape" && searchInput.value) {
      ev.preventDefault();
      searchInput.value = "";
      store.update((s) => ({ flame: { ...s.flame, search: "" } }));
      runSearch();
    }
  });
  function cycle(dir: number): void {
    const tree = chart.tree();
    if (!tree || !search || search.matches.length === 0) return;
    const n = search.matches.length;
    matchIdx = matchIdx < 0 ? (dir > 0 ? 0 : n - 1) : (matchIdx + dir + n) % n;
    const node = search.matches[matchIdx];
    const zoom = chart.zoomNode() ?? tree.root;
    let inside = false;
    for (let p: FlameNode | null = node; p; p = p.parent) if (p === zoom) inside = true;
    if (!inside) chart.zoomTo(node.parent ?? tree.root, true, false);
    chart.setFocus(node, { announce: false, visible: true });
    ctx.announce.polite(`Match ${matchIdx + 1} of ${n}: ${shortRef(node)}`);
  }
  prevBtn.addEventListener("click", () => cycle(-1));
  nextBtn.addEventListener("click", () => cycle(1));

  // "/" inside the section focuses the search (elsewhere it opens the palette).
  host.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !isTypingTarget(ev.target)) {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // ── Tabs and lazy trees ──
  function showTree(k: TreeKind, tree: FlameTree | null): void {
    if (destroyed || k !== tab) return;
    placeholder.hidden = true;
    renderModeSelect(k);
    if (!tree) {
      chart.el.hidden = true;
      empty.hidden = false;
      empty.textContent = k === "cpu" ? "No call stacks were sampled." : "No allocation stacks were sampled.";
      desc.textContent = "";
      legend.replaceChildren();
      return;
    }
    empty.hidden = true;
    chart.el.hidden = false;
    desc.textContent = flameDescription(k, tree);
    const path = store.get().flame.zoom[k];
    const zoom = (path && tree.byPath.get(path)) || tree.root;
    chart.show(k, tree, { zoom, color: colorFor(k) });
    renderCrumbs(zoom, false);
    resetBtn.hidden = zoom.parent === null;
    renderLegend(k, tree);
    runSearch();
    chart.setLinked(store.get().hover ?? store.get().selection ?? null);
    while (pending.length) (pending.shift() as () => void)();
  }

  function load(k: TreeKind): void {
    if (k in trees) {
      showTree(k, trees[k] ?? null);
      return;
    }
    reserve(k);
    placeholder.hidden = false;
    chart.el.hidden = true;
    void model.flame(k).then((t) => {
      trees[k] = t;
      if (!destroyed) showTree(k, t);
    });
  }

  function switchTab(k: TreeKind, fromUser: boolean): void {
    if (!tabsAvail.includes(k)) return;
    if (k === tab && (k in trees)) return;
    tab = k;
    tabCtl?.set(k);
    if (tabCtl) {
      const active = tabCtl.buttons().find((b) => b.getAttribute("aria-selected") === "true");
      if (active) card.setAttribute("aria-labelledby", active.id);
    }
    store.update((s) => ({ flame: { ...s.flame, tab: k } }));
    load(k);
    if (fromUser && !ctx.motion.reduced && !ctx.host.flags.still) {
      card.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 120, easing: "linear" });
    }
  }

  // First reveal (M17) when the chart first enters the viewport.
  dispose.add(ctx.motion.revealOnce(card, () => chart.reveal()));

  // ── Linking (§4.4.6, §4.11.6) ──
  dispose.add(
    ctx.bus.on("hover:line", ({ target, source }) => {
      if (source === "flame") return;
      chart.setLinked(target ?? (showIn.suppressed() ? null : store.get().selection));
    }),
  );
  dispose.add(
    store.subscribe((s) => s.selection, (sel) => {
      showIn.selectionChanged(sel);
      chart.setLinked(store.get().hover ?? sel);
    }),
  );
  dispose.add(
    ctx.bus.on("layout:changed", () => {
      if (chart.tree()) chart.relayout();
    }),
  );

  // ── API ──
  function whenReady(fn: () => void): void {
    if (tab in trees) fn();
    else pending.push(fn);
  }

  function focusTarget(target: Target): void {
    const tree = chart.tree();
    if (!tree) return;
    let node: FlameNode | null = null;
    if ("line" in target) node = nodeForLine(tree, target.file, target.line);
    else {
      const fn = functionAt(model, target.file, target.fn);
      if (fn?.range) node = nodeForRange(tree, target.file, fn.range);
      else if (fn) node = nodeForLine(tree, target.file, fn.no);
    }
    if (!node) {
      ctx.toast.show({ kind: "info", text: "This line does not appear in any sampled stack" });
      return;
    }
    if (searchInput.value) {
      searchInput.value = "";
      store.update((s) => ({ flame: { ...s.flame, search: "" } }));
      runSearch();
    }
    chart.zoomTo(showInStacksZoom(node), true, false);
    chart.focusCanvas();
    chart.setFocus(node, { announce: true });
    showIn.show(target);
  }

  const api: StacksApi = {
    selectTab(k) {
      switchTab(k, false);
    },
    focusLine(target) {
      if (tabsAvail.includes("cpu")) switchTab("cpu", false);
      whenReady(() => focusTarget(target));
    },
  };
  ctx.registerApi("stacks", api);
  Object.defineProperty(host, "__stacksApi", { configurable: true, value: api });
  load(tab);

  return {
    destroy() {
      destroyed = true;
      window.clearTimeout(searchTimer);
      dispose.dispose();
      chart.destroy();
      tabCtl?.destroy();
      host.replaceChildren();
    },
  };
}
