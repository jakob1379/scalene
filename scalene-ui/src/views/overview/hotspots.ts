/**
 * Hotspot ranking (DESIGN.md §4.5): the ranked list beside the scope. One Tab
 * stop (roving focus, ↑/↓, j/k, Home/End), Enter jumps to the code row, `f`
 * shows the line in the call stacks. Kind × metric changes re-rank with FLIP
 * (M8); the first load grows the meters in rank order (M5).
 */

import { rovingFocus, type Roving } from "../../core/a11y";
import { segmented, select, type Choice, type SelectControl } from "../../core/controls";
import { createDisposer, h } from "../../core/dom";
import { dirname, fmtLoc, fmtPct } from "../../core/format";
import { icon } from "../../core/icons";
import { DUR, EASE_CSS } from "../../core/motion";
import type { Metric, Target } from "../../core/store";
import { sameTarget } from "../../core/store";
import { bindTooltip } from "../../core/tooltip";
import { availableMetrics, hotspotList, paretoText, HOTSPOTS_DEFAULT, type HotspotKind, type HotspotList } from "../../model/hotspots";
import type { HotspotItem, MeterPart } from "../../model/model";
import { highlight } from "../../model/syntax";
import type { ViewContext } from "../app";
import { spokenTarget } from "./headline";
import { pyFnName } from "../stacks/shared";

export interface HotspotsHandle {
  el: HTMLElement;
  list(): HotspotList;
  /** Linked highlight driven by another view (null clears). */
  highlight(target: Target | null): void;
  /** Rows shown: 8 (default), 5 (`short`), 3 (`xs`, unless "Show all"). */
  setVisible(n: number, showAllButton: boolean): void;
  onItems(cb: (list: HotspotList) => void): void;
  onHover(cb: (item: HotspotItem | null) => void): void;
  intro(instant: boolean): void;
  destroy(): void;
}

const KIND_LABEL: Record<HotspotKind, string> = { lines: "Lines", functions: "Functions", files: "Files" };
const METRIC_LABEL: Record<Metric, string> = { time: "Time", memory: "Memory", gpu: "GPU", await: "Await" };
const METRIC_PHRASE: Record<Metric, string> = {
  time: "share of run time",
  memory: "peak memory attributed",
  gpu: "GPU utilization while running",
  await: "share of await time",
};
/** The denominator next to the title in short hosts, where the subtitle is hidden. */
const METRIC_UNIT: Record<Metric, string> = { time: "% of run", memory: "peak", gpu: "mean utilization", await: "% of await" };
const KIND_NOUN: Record<HotspotKind, [string, string]> = { lines: ["line", "lines"], functions: ["function", "functions"], files: ["file", "files"] };
/** In-place expansion of the ranked list (review round 1): 8 → 25 → 50 → all, across files. */
export const EXPAND_STEPS = [HOTSPOTS_DEFAULT, 25, 50];

/** The next list size after `n` rows of `total`, or null when everything is shown. */
export function nextExpansion(n: number, total: number): number | null {
  if (n >= total) return null;
  for (const s of EXPAND_STEPS) if (s > n) return Math.min(s, total);
  return total;
}

const AI_HINT = ". Press A to propose a fix with AI";

/** M8 timings (ms): leaving rows fade first, then rows move, then numbers and new rows land. */
export const M8 = { leave: 90, moveDelay: 60, move: 280, land: 140, enterStagger: 20 } as const;

export function itemKey(it: Pick<HotspotItem, "kind" | "target">): string {
  const t = it.target;
  return `${it.kind}|${t.file}|${"line" in t ? t.line : `fn:${t.fn}`}`;
}

interface Row {
  key: string;
  el: HTMLElement;
  fill: HTMLElement;
  item: HotspotItem;
  frac: number;
}

function meterNodes(parts: readonly MeterPart[], max: number): { track: HTMLElement; fill: HTMLElement; frac: number } {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0);
  const frac = max > 0 ? Math.max(0, Math.min(1, total / max)) : 0;
  const fill = h("span", { class: "hs-fill" });
  fillSegments(fill, parts, frac, total);
  const track = h("span", { class: "hs-meter", "aria-hidden": "true" }, fill);
  return { track, fill, frac };
}

function fillSegments(fill: HTMLElement, parts: readonly MeterPart[], frac: number, total: number): void {
  fill.replaceChildren(
    ...parts
      .filter((p) => p.value > 0)
      .map((p) =>
        h("i", {
          class: ["hs-seg", p.hatch === "system" ? "is-hatch-sys" : "", p.hatch === "waiting" ? "is-hatch-wait" : ""],
          style: { flexGrow: String(p.value / (total || 1)), background: p.hatch ? undefined : `var(--${p.token})` },
        }),
      ),
  );
  fill.style.width = `${(frac * 100).toFixed(3)}%`;
  fill.style.minWidth = total > 0 ? "2px" : "0";
}

function codeCell(it: HotspotItem): HTMLElement {
  if (it.kind === "line" && it.line) {
    const spans = highlight(it.code, it.line.doc);
    return h(
      "span",
      { class: "hs-code code" },
      spans.map((s) => (s.cls ? h("span", { class: s.cls }, s.text) : s.text)),
    );
  }
  if (it.kind === "function") {
    // Same form as the headline, lens, code and canvases: "train()" (review round 1).
    return h("span", { class: "hs-code code" }, h("span", { class: "t-def" }, pyFnName(it.code)));
  }
  const dir = dirname(it.file.name);
  return h("span", { class: "hs-code hs-file" }, h("span", { class: "code hs-base" }, it.code), dir ? h("span", { class: "hs-dir" }, h("bdi", null, dir)) : null);
}

function badgeEl(it: HotspotItem): HTMLElement | null {
  const b = it.badge;
  if (!b) return null;
  switch (b.kind) {
    case "leak":
      return h("span", { class: "hs-badge badge badge-danger", dataset: { kind: b.kind } }, icon("trend-up", 12), h("span", { class: "hs-badge-text" }, "leak"));
    case "loop":
      // "event loop · waiting" where the badge column exists, "waiting" in narrower panes, the
      // hourglass alone in 400 px hosts; the row's name and tooltip always say it (must-fix 28).
      return h(
        "span",
        { class: "hs-badge badge badge-neutral", dataset: { kind: b.kind } },
        icon("wait", 12),
        h("span", { class: "hs-badge-text" }, h("span", { class: "hs-badge-long" }, h("span", { class: "hs-badge-ev" }, "event "), "loop · "), "waiting"),
      );
    case "gpu":
      return h("span", { class: "hs-badge badge badge-resource", dataset: { kind: b.kind } }, h("span", { class: "badge-swatch", style: { background: "var(--gpu)" } }), b.text);
    case "await":
      return h("span", { class: "hs-badge badge badge-resource", dataset: { kind: b.kind } }, h("span", { class: "badge-swatch", style: { background: "var(--async)" } }), b.text);
    default:
      return h("span", { class: "hs-badge badge badge-resource", dataset: { kind: b.kind } }, h("span", { class: "badge-swatch", style: { background: "var(--copy)" } }), b.text);
  }
}

function locationCell(it: HotspotItem): HTMLElement {
  // The function comes first and yields first; the file name and line never truncate.
  if (it.kind === "line" && it.line) {
    const fn = it.line.fn;
    return h(
      "span",
      { class: "hs-loc" },
      fn ? h("span", { class: "hs-loc-fn" }, `${fn.name}()`) : null,
      fn ? h("span", { class: "hs-loc-sep", "aria-hidden": "true" }, "·") : null,
      h("span", { class: "hs-loc-file" }, h("bdi", null, fmtLoc(it.file.name, it.line.no))),
    );
  }
  return h("span", { class: "hs-loc" }, h("span", { class: "hs-loc-file" }, h("bdi", null, it.location)));
}

function rowAria(it: HotspotItem): string {
  let s = it.ariaLabel;
  if (it.badge?.kind === "loop") s += ", event loop, mostly waiting";
  if (it.badge?.kind === "leak") s += ", possible leak";
  return s;
}

export function mountHotspots(ctx: ViewContext, titleDelay: number): HotspotsHandle {
  const { model, store, motion } = ctx;
  const disposer = createDisposer();
  const metrics = availableMetrics(model);
  const st = store.get().hotspots;
  let kind: HotspotKind = st.kind;
  let metric: Metric = metrics.includes(st.metric) ? st.metric : "time";
  /** Rows requested from the model: 8, or more once expanded in place. */
  let limit = HOTSPOTS_DEFAULT;
  let current: HotspotList = hotspotList(model, kind, metric, limit);
  let rows: Row[] = [];
  let visible = HOTSPOTS_DEFAULT;
  let showAllBtnWanted = false;
  let itemsCb: (l: HotspotList) => void = () => {};
  let hoverCb: (it: HotspotItem | null) => void = () => {};
  let hovered: HotspotItem | null = null;
  let linkedTarget: Target | null = null;

  // ── Header ──
  const title = h("h3", { class: "card-title hs-title m-reveal", style: { "--d": `${titleDelay}ms` } }, "Hotspots");
  const kindSeg: Choice<HotspotKind> = segmented<HotspotKind>({
    label: "Rank",
    options: (["lines", "functions", "files"] as HotspotKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] })),
    value: kind,
    onChange: (v) => change(v, metric),
  });
  const metricSeg: Choice<Metric> | null =
    metrics.length > 1
      ? segmented<Metric>({
          label: "Metric",
          options: metrics.map((m) => ({ value: m, label: METRIC_LABEL[m] })),
          value: metric,
          onChange: (v) => change(kind, v),
        })
      : null;
  const kindSel: SelectControl<HotspotKind> = select<HotspotKind>({
    label: "Rank",
    options: (["lines", "functions", "files"] as HotspotKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] })),
    value: kind,
    onChange: (v) => change(v, metric),
  });
  const metricSel: SelectControl<Metric> | null =
    metrics.length > 1
      ? select<Metric>({ label: "Metric", options: metrics.map((m) => ({ value: m, label: METRIC_LABEL[m] })), value: metric, onChange: (v) => change(kind, v) })
      : null;
  const controls = h("div", { class: "hs-controls" }, kindSeg.el, metricSeg?.el ?? null);
  const selects = h("div", { class: "hs-selects" }, kindSel.el, metricSel?.el ?? null);
  const subtitle = h("p", { class: "hs-sub" }, subtitleText(current.subtitle));
  const unit = h("span", { class: "hs-unit" }, METRIC_UNIT[metric]);
  const head = h("div", { class: "hs-head" }, h("div", { class: "hs-head-row" }, title, unit, controls, selects), subtitle);

  // ── List ──
  const listEl = h("div", { class: "hs-list", role: "listbox", dataset: { metric } });
  const empty = h("p", { class: "hs-empty" }, "");
  const showAll = h("button", { type: "button", class: "btn btn-ghost btn-compact hs-showall" }, "");
  const foot = h("div", { class: "hs-foot" });
  const el = h("div", { class: "ov-hot" }, head, listEl, empty, showAll, foot);

  const roving: Roving = rovingFocus({
    container: listEl,
    items: () => rows.filter((r) => !r.el.hidden).map((r) => r.el),
    vimKeys: true,
    onMove: (rowEl) => {
      const r = rows.find((x) => x.el === rowEl);
      syncSelected();
      if (r) setHover(r.item);
    },
    onActivate: (rowEl) => {
      const r = rows.find((x) => x.el === rowEl);
      if (r) jump(r.item);
    },
  });
  disposer.add(roving);

  function jump(it: HotspotItem): void {
    void ctx.nav.jumpTo(it.target, { focus: true, open: true, source: "hotspot" });
  }

  /** AI proposal for a line (the same trigger as the code row's Optimize, §4.8.7). */
  function canPropose(it: HotspotItem): boolean {
    return it.kind === "line" && Boolean(it.line) && Boolean(ctx.ai.availability(it.file.name).get(it.line?.no ?? -1)?.line);
  }
  function propose(it: HotspotItem): void {
    const l = it.line;
    if (!l || !canPropose(it)) {
      ctx.announce.polite("This hotspot is not eligible for an AI proposal (lines only, at least 1% of run time)");
      return;
    }
    ctx.ai.request(l.file.name, l.no, "line");
    void ctx.nav.jumpTo(it.target, { focus: true, open: false, source: "hotspot" });
  }

  /** "mean util." → "mean utilization": the subtitle carries the explanation once. */
  function subtitleText(s: string): string {
    return s.replace(/\butil\./g, "utilization");
  }

  function setHover(it: HotspotItem | null): void {
    if (it === hovered) return;
    hovered = it;
    hoverCb(it);
  }

  function buildRow(it: HotspotItem): Row {
    const { track, fill, frac } = meterNodes(it.meter.parts, it.meter.max);
    const codeWrap = h("span", { class: "hs-codewrap" }, codeCell(it), badgeEl(it));
    // elapsed_time_sec = 0 (§4.0.8): no seconds anywhere; percentages stay.
    const secondary = !(model.elapsed > 0) && /\d[\s\u00a0]?(?:ms|s)$/.test(it.secondary) ? "" : it.secondary;
    // Eligibility comes from the AI controller, which learns the profile after the overview
    // mounts: the button exists for every line and syncAi() shows it where a proposal is possible.
    const ai =
      it.kind === "line" && it.line
        ? h(
            "button",
            { type: "button", class: "hs-ai", tabindex: "-1", hidden: !canPropose(it), "aria-label": `Propose a fix for ${spokenTarget(it.target)} with AI` },
            icon("spark", 14),
            h("span", null, "Propose a fix"),
          )
        : null;
    const rowEl = h(
      "div",
      { class: "hs-row", role: "option", "aria-selected": "false", tabindex: "-1", "aria-label": rowAria(it) + (ai && !ai.hidden ? AI_HINT : "") },
      h("span", { class: "hs-rank num", "aria-hidden": "true" }, String(it.rank)),
      track,
      h("span", { class: "hs-val num", "aria-hidden": "true" }, it.valueText),
      h("span", { class: "hs-sec num", "aria-hidden": "true" }, secondary),
      codeWrap,
      locationCell(it),
      ai,
    );
    for (const c of Array.from(rowEl.children)) c.setAttribute("aria-hidden", "true");
    if (ai) {
      ai.addEventListener("click", (ev) => {
        ev.stopPropagation();
        propose(row.item);
      });
      bindTooltip(ctx.tooltip, ai, { title: "Propose a fix with AI", hint: `${ctx.ai.ready().ready ? ctx.ai.providerSummary() : "Set up an AI provider first"} · shortcut A` });
    }
    const row: Row = { key: itemKey(it), el: rowEl, fill, item: it, frac };
    rowEl.addEventListener("mouseenter", () => setHover(row.item));
    rowEl.addEventListener("mouseleave", () => setHover(null));
    rowEl.addEventListener("focus", () => setHover(row.item));
    rowEl.addEventListener("click", () => jump(row.item));
    rowEl.addEventListener("keydown", (ev) => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key === "f" && model.caps.stacks) {
        ev.preventDefault();
        void ctx.nav.showInStacks(row.item.target);
      } else if ((ev.key === "a" || ev.key === "A") && row.item.kind === "line") {
        ev.preventDefault();
        propose(row.item);
      }
    });
    bindTooltip(ctx.tooltip, codeWrap, () =>
      row.item.kind === "line"
        ? {
            title: row.item.badge?.kind === "loop" ? "Event loop · mostly waiting" : row.item.badge?.kind === "leak" ? "Possible leak" : undefined,
            code: row.item.code,
            hint: `${spokenTarget(row.item.target)} · Enter to open`,
          }
        : { title: row.item.kind === "file" ? row.item.file.name : row.item.code, hint: row.item.location },
    );
    return row;
  }

  function updateRow(row: Row, it: HotspotItem): void {
    const fresh = buildRow(it);
    row.el.replaceChildren(...Array.from(fresh.el.childNodes));
    row.el.setAttribute("aria-label", rowAria(it) + (canPropose(it) ? AI_HINT : ""));
    row.fill = row.el.querySelector(".hs-fill") as HTMLElement;
    row.item = it;
    row.frac = fresh.frac;
  }

  /** Show the AI action where the controller allows a proposal (after it loads the profile). */
  function syncAi(): void {
    for (const r of rows) {
      const b = r.el.querySelector<HTMLElement>(".hs-ai");
      if (!b) continue;
      const ok = canPropose(r.item);
      b.hidden = !ok;
      r.el.setAttribute("aria-label", rowAria(r.item) + (ok ? AI_HINT : ""));
    }
  }
  disposer.add(ctx.ai.onChange((anchor) => anchor === null && syncAi()));
  queueMicrotask(syncAi);

  function syncState(): void {
    const sel = store.get().selection;
    for (const r of rows) {
      const isSel = Boolean(sel && sameTarget(sel, r.item.target));
      r.el.classList.toggle("is-selected", isSel);
      r.el.classList.toggle("is-linked", Boolean(linkedTarget && sameTarget(linkedTarget, r.item.target)));
    }
    syncSelected();
  }

  /** Selection follows focus (single-select listbox): the roving option is the selected one. */
  function syncSelected(): void {
    for (const r of rows) r.el.setAttribute("aria-selected", String(r.el.getAttribute("tabindex") === "0"));
  }

  function applyVisible(): void {
    const n = current.items.length;
    rows.forEach((r, i) => (r.el.hidden = i >= visible));
    const hiddenCount = Math.max(0, Math.min(n, HOTSPOTS_DEFAULT) - visible);
    showAll.hidden = !(showAllBtnWanted && (hiddenCount > 0 || store.get().hotspots.showAll));
    showAll.textContent = store.get().hotspots.showAll ? "Show top 3" : `Show top ${Math.min(n, HOTSPOTS_DEFAULT)}`;
    roving.sync();
    syncSelected();
  }

  function renderHeaderText(): void {
    subtitle.textContent = subtitleText(current.subtitle);
    unit.textContent = METRIC_UNIT[metric];
    listEl.dataset.metric = metric;
    listEl.setAttribute("aria-label", `Hotspots: ${kind} ranked by ${METRIC_PHRASE[metric]}`);
    kindSeg.set(kind);
    kindSel.set(kind);
    metricSeg?.set(metric);
    metricSel?.set(metric);
  }

  /** The cumulative bar (grows with the row meters on first load, M5). */
  let cumFill: HTMLElement | null = null;

  function renderFoot(): void {
    const text = paretoText(current);
    const children: HTMLElement[] = [];
    cumFill = null;
    if (current.items.length === 0) {
      foot.hidden = true;
      return;
    }
    if (text && current.pareto !== null) {
      const v = fmtPct(current.pareto);
      const [pre, post] = text.split(v);
      children.push(h("span", { class: "hs-pareto" }, pre, h("strong", { class: "num" }, v), post));
      cumFill = h("span", { class: "hs-cum-fill", style: { width: `${Math.min(100, current.pareto).toFixed(2)}%`, background: metric === "await" ? "var(--async)" : "var(--cpu-py)" } });
      children.push(h("span", { class: "hs-cum", "aria-hidden": "true" }, cumFill));
    }
    // Memory / GPU: the subtitle already explains the ranking; the footer holds only actions.
    const [one, many] = KIND_NOUN[kind];
    // Phones show 3 rows first: "Show top 8" comes before any "N more lines".
    const phoneCollapsed = showAllBtnWanted && !store.get().hotspots.showAll && limit <= HOTSPOTS_DEFAULT;
    const next = phoneCollapsed ? null : nextExpansion(current.items.length, current.total);
    if (next !== null) {
      const add = next - current.items.length;
      const all = next >= current.total;
      const label = all && current.items.length > HOTSPOTS_DEFAULT ? `Show all ${current.total.toLocaleString("en-US")} ${many}` : `${add.toLocaleString("en-US")} more ${add === 1 ? one : many}`;
      const more = h("button", { type: "button", class: "hs-more", "aria-expanded": "false", onClick: () => expand(next) }, label, icon("chevron-down", 14));
      more.setAttribute("aria-label", `Show ${add} more ${add === 1 ? one : many} in this ranking (${current.total} in all, across files)`);
      children.push(more);
    }
    if (current.items.length > HOTSPOTS_DEFAULT) {
      children.push(h("button", { type: "button", class: "hs-more hs-less", onClick: () => expand(HOTSPOTS_DEFAULT) }, `Show top ${HOTSPOTS_DEFAULT}`));
    }
    foot.hidden = children.length === 0;
    foot.replaceChildren(...children);
  }

  /**
   * "N more lines": the ranking continues in place (same ranking, rank numerals and meters,
   * across files) instead of jumping to one file's code view (review round 1). Side by side,
   * the list keeps the card's height and scrolls, so the signal is not stretched.
   */
  function expand(n: number): void {
    const keep = listEl.getBoundingClientRect().height;
    const wasExpanded = limit > HOTSPOTS_DEFAULT;
    limit = n;
    current = hotspotList(model, kind, metric, limit);
    if (limit > HOTSPOTS_DEFAULT && !wasExpanded) listEl.style.setProperty("--hs-list-max", `${Math.max(160, Math.round(keep))}px`);
    listEl.classList.toggle("is-expanded", limit > HOTSPOTS_DEFAULT);
    const before = rows.length;
    setVisibleCount(false);
    renderList(false);
    renderFoot();
    // New rows fade in (no motion: they extend the list where it ends).
    if (!(motion.reduced || ctx.host.flags.still)) {
      rows.slice(before).forEach((r, k) => {
        if (!r.el.hidden) r.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.d2, delay: Math.min(8, k) * M8.enterStagger, easing: "linear", fill: "backwards" });
      });
    }
    if (n > HOTSPOTS_DEFAULT && rows[before]) {
      roving.setActive(before, false);
      rows[before].el.scrollIntoView({ block: "nearest" });
    } else if (n === HOTSPOTS_DEFAULT) listEl.scrollTop = 0;
    foot.querySelector<HTMLElement>(".hs-more")?.focus({ preventScroll: true });
    itemsCb(current);
  }

  function renderList(animate: boolean): void {
    const items = current.items;
    empty.hidden = items.length > 0;
    listEl.hidden = items.length === 0;
    empty.textContent = items.length === 0 ? current.emptyText : "";
    const old = new Map(rows.map((r) => [r.key, r] as const));
    const focusedKey = rows.find((r) => r.el === document.activeElement)?.key ?? null;
    const reduced = motion.reduced || ctx.host.flags.still;
    const nextRows: Row[] = items.map((it) => {
      const key = itemKey(it);
      const prev = old.get(key);
      if (prev) {
        old.delete(key);
        return prev;
      }
      return buildRow(it);
    });
    const persisting = nextRows.filter((r) => r.el.isConnected);
    const prevFrac = new Map(nextRows.map((r) => [r, r.frac] as const));
    const leaving = Array.from(old.values());
    const mutate = () => {
      nextRows.forEach((r, i) => {
        if (r.el.isConnected) updateRow(r, items[i]);
      });
      for (const r of leaving) r.el.remove();
      listEl.replaceChildren(...nextRows.map((r) => r.el));
    };
    if (animate && !reduced && persisting.length) {
      // M8, sequenced so two rows' text never overlaps (review round 1):
      //  1. leaving rows (inert clones at their old rects, under everything) fade out in 90 ms;
      //  2. persisting rows hold their old slot, then slide 280 ms on an opaque surface above
      //     the others; their numbers (rank, value, secondary) land with them (fade in at the end);
      //  3. entering rows fade in in their slots after the move (20 ms stagger).
      const listBox = listEl.getBoundingClientRect();
      const first = new Map(persisting.map((r) => [r, r.el.getBoundingClientRect()] as const));
      const ghosts = leaving
        .filter((r) => !r.el.hidden && r.el.isConnected)
        .map((r) => {
          const b = r.el.getBoundingClientRect();
          const ghost = r.el.cloneNode(true) as HTMLElement;
          ghost.classList.add("hs-ghost");
          ghost.classList.remove("is-linked", "is-selected");
          ghost.removeAttribute("role");
          ghost.removeAttribute("tabindex");
          ghost.removeAttribute("aria-selected");
          ghost.setAttribute("aria-hidden", "true");
          ghost.style.top = `${b.top - listBox.top}px`;
          return ghost;
        });
      mutate();
      rows = nextRows;
      applyVisible();
      for (const g of ghosts) {
        listEl.appendChild(g);
        const done = () => g.remove();
        g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: M8.leave, easing: EASE_CSS.in, fill: "forwards" }).finished.then(done, done);
      }
      const landAt = M8.moveDelay + M8.move - 60;
      for (const r of persisting) {
        const a = first.get(r);
        if (!a || !r.el.isConnected || r.el.hidden) continue;
        const b = r.el.getBoundingClientRect();
        const dy = a.top - b.top;
        if (Math.abs(dy) >= 0.5) {
          r.el.classList.add("is-moving");
          const anim = r.el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: M8.move, delay: M8.moveDelay, easing: EASE_CSS.standard, fill: "backwards" });
          const done = () => r.el.classList.remove("is-moving");
          anim.finished.then(done, done);
        }
        for (const cell of Array.from(r.el.querySelectorAll<HTMLElement>(".hs-rank, .hs-val, .hs-sec"))) {
          cell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M8.land, delay: landAt, easing: "linear", fill: "backwards" });
        }
        const was = prevFrac.get(r) ?? 0;
        if (r.frac > 0 && Math.abs(was - r.frac) > 0.001) {
          r.fill.animate([{ transform: `scaleX(${Math.max(0, was / r.frac)})` }, { transform: "none" }], { duration: M8.move, delay: M8.moveDelay, easing: EASE_CSS.standard, fill: "backwards" });
        }
      }
      let k = 0;
      for (const r of nextRows) {
        if (persisting.includes(r) || r.el.hidden) continue;
        r.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M8.land, delay: landAt + M8.enterStagger * k++, easing: "linear", fill: "backwards" });
      }
    } else {
      mutate();
    }
    rows = nextRows;
    applyVisible();
    syncState();
    if (focusedKey) {
      const r = rows.find((x) => x.key === focusedKey) ?? rows[0];
      if (r) {
        roving.setActive(rows.indexOf(r), false);
        r.el.focus({ preventScroll: true });
        if (animate && reduced) {
          r.el.classList.add("is-acted");
          window.setTimeout(() => r.el.classList.remove("is-acted"), 1500);
        }
      }
    }
    markClipped();
  }

  /** Code cells that overflow get the right-edge fade (never on short code). */
  function markClipped(): void {
    requestAnimationFrame(() => {
      for (const r of rows) {
        const code = r.el.querySelector<HTMLElement>(".hs-code");
        if (code) code.classList.toggle("is-clipped", code.scrollWidth > code.clientWidth + 1);
      }
    });
  }

  function change(k: HotspotKind, m: Metric): void {
    if (k === kind && m === metric) return;
    kind = k;
    metric = m;
    // A new ranking starts at the top 8 again.
    limit = HOTSPOTS_DEFAULT;
    listEl.classList.remove("is-expanded");
    listEl.scrollTop = 0;
    setVisibleCount(false);
    current = hotspotList(model, kind, metric, limit);
    store.update((s) => ({ hotspots: { ...s.hotspots, kind, metric } }));
    renderHeaderText();
    renderList(true);
    renderFoot();
    itemsCb(current);
  }

  showAll.addEventListener("click", () => {
    store.update((s) => ({ hotspots: { ...s.hotspots, showAll: !s.hotspots.showAll } }));
  });
  disposer.add(store.subscribe((s) => s.selection, () => syncState()));
  disposer.add(
    store.subscribe(
      (s) => s.hotspots.showAll,
      () => {
        setVisibleCount();
        renderFoot();
      },
    ),
  );
  // Pointer focus and roving both end with the focused option as the tab stop.
  listEl.addEventListener("focusin", () => queueMicrotask(syncSelected));
  listEl.addEventListener("focusout", (ev) => {
    if (!listEl.contains(ev.relatedTarget as Node | null)) setHover(null);
  });
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => markClipped());
    ro.observe(listEl);
    disposer.add(() => ro.disconnect());
  }

  let baseVisible = HOTSPOTS_DEFAULT;
  /** Rows shown: phones 3 (+ "Show top 8"), short hosts 5, else the requested ranking (8 or expanded). */
  function setVisibleCount(apply = true): void {
    const expanded = limit > HOTSPOTS_DEFAULT;
    visible = expanded ? limit : showAllBtnWanted && store.get().hotspots.showAll ? HOTSPOTS_DEFAULT : baseVisible;
    if (apply) applyVisible();
  }

  renderHeaderText();
  renderList(false);
  renderFoot();

  return {
    el,
    list: () => current,
    highlight(target) {
      linkedTarget = target;
      syncState();
    },
    setVisible(n, btn) {
      baseVisible = n;
      showAllBtnWanted = btn;
      setVisibleCount();
      renderFoot();
    },
    onItems(cb) {
      itemsCb = cb;
    },
    onHover(cb) {
      hoverCb = cb;
    },
    intro(instant) {
      if (instant) return;
      rows.forEach((r, i) => {
        r.fill.classList.add("m-grow");
        r.fill.style.setProperty("--d", `${200 + 30 * Math.min(i, 7)}ms`);
      });
      // The sum never shows before its parts (review round 1): the Pareto bar grows with the
      // last row's meter (M5 ends ≤ 830 ms).
      if (cumFill) {
        cumFill.classList.add("m-grow");
        cumFill.style.setProperty("--d", `${200 + 30 * Math.min(Math.max(0, rows.length - 1), 7)}ms`);
      }
    },
    destroy() {
      disposer.dispose();
      kindSeg.destroy();
      metricSeg?.destroy();
      el.remove();
    },
  };
}

