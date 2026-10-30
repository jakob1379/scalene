// File navigator (DESIGN.md §4.7): visible files by share (hidden ones counted in their own
// group), shown as tabs (md–xl, with "All files ▾"), a rail (xxl) or a switcher button that
// opens a file sheet (xs bottom sheet, sm / short popover). Every entry carries the same
// per-file summary: basename, mini split bar, share, peak, leak icon, NRT/NC share.
import { focusPastTrigger, focusables } from "../../core/a11y";
import { h, uid, type Child } from "../../core/dom";
import { fmtMem, fmtPct } from "../../core/format";
import { icon } from "../../core/icons";
import { bindTooltip } from "../../core/tooltip";
import type { TooltipContent } from "../../core/tooltip";
import type { FileM, Model } from "../../model/model";
import * as P from "../../model/phrases";
import type { ViewContext } from "../app";

export type FileNavMode = "tabs" | "rail" | "switcher";

export interface FileNav {
  /** Tabs strip or switcher button (above the file bar). */
  bar: HTMLElement;
  /** Rail column (xxl). */
  rail: HTMLElement;
  setMode(mode: FileNavMode, sheet: "bottom" | "popover"): void;
  setCurrent(file: FileM): void;
  /** Open the file list with the hidden group expanded (headline "+16 below 1%"). */
  showHidden(): void;
  destroy(): void;
}

export interface FileNavOptions {
  ctx: ViewContext;
  onSelect(file: FileM): void;
}

/** Hidden-group caption (§4.7). */
export function hiddenCaption(n: number, long = false): string {
  return long
    ? `${n} file${n === 1 ? "" : "s"} below 1% of time with little memory`
    : `${n} file${n === 1 ? "" : "s"} below 1% of time · little memory`;
}

/** Mini split bar: Python / native / system of the file, length = share / max share. */
function splitBar(f: FileM, maxShare: number, w = 32): HTMLElement {
  const bar = h("span", { class: "fn-bar", style: { width: `${w}px` }, "aria-hidden": "true" });
  const len = maxShare > 0 ? Math.min(1, f.pct / maxShare) : 0;
  const tot = f.total > 0 ? f.total : 1;
  const parts: [number, string, boolean][] = [
    [f.py, "cpu-py", false],
    [f.nat, "cpu-native", false],
    [f.sys, "cpu-sys", true],
  ];
  for (const [v, token, hatch] of parts) {
    if (v <= 0) continue;
    bar.append(h("span", { class: ["fn-bar-seg", hatch ? "is-hatch" : ""], style: { width: `${((v / tot) * len * 100).toFixed(2)}%`, "--seg": `var(--${token})` } }));
  }
  return bar;
}

function neuronShare(f: FileM, m: Model): string | null {
  if (!m.caps.neuron || !(m.elapsed > 0) || (f.nrtMs <= 0 && f.ncMs <= 0)) return null;
  const nrt = f.nrtMs / 10 / m.elapsed;
  const nc = f.ncMs / 10 / m.elapsed;
  return `NRT ${fmtPct(nrt)} · NC ${fmtPct(nc)}`;
}

export function fileTooltip(f: FileM, m: Model): TooltipContent {
  const rows: [string, string][] = [["time", P.fileShare(f.pct, m.elapsed)]];
  if (m.caps.memory && f.peak > 0) rows.push(["peak", fmtMem(f.peak)]);
  if (f.leaks.length) rows.push(["possible leaks", String(f.leaks.length)]);
  const ns = neuronShare(f, m);
  if (ns) rows.push(["Neuron", `${ns} of run`]);
  return { title: f.name, rows, hint: f.hidden ? hiddenCaption(1).replace(/^1 file /, "Hidden: ") : undefined };
}

/** One-line entry content (tabs, sheet, menu). */
function entryContent(f: FileM, m: Model, maxShare: number, active: boolean): Child[] {
  const out: Child[] = [
    h("span", { class: ["fn-name", "mono", active ? "is-active" : ""] }, f.base),
    splitBar(f, maxShare),
    h("span", { class: "fn-pct" }, fmtPct(f.pct)),
  ];
  // Labelled (round 1): a bare "1.20 GiB" next to "58.8%" does not say what it measures.
  if (m.caps.memory && f.peak > 0) out.push(h("span", { class: "fn-peak" }, `peak ${fmtMem(f.peak)}`));
  if (f.leaks.length) {
    const li = icon("trend-up", 12);
    li.classList.add("fn-leak");
    out.push(h("span", { class: "fn-leak-wrap", "aria-label": `${f.leaks.length} possible leak${f.leaks.length === 1 ? "" : "s"}` }, li));
  }
  const ns = neuronShare(f, m);
  if (ns) out.push(h("span", { class: "fn-peak" }, ns));
  return out;
}

function entryLabel(f: FileM, m: Model): string {
  const bits = [f.base, `${fmtPct(f.pct)} of run`];
  if (m.caps.memory && f.peak > 0) bits.push(`peak ${fmtMem(f.peak)}`);
  if (f.leaks.length) bits.push(`${f.leaks.length} possible leak${f.leaks.length === 1 ? "" : "s"}`);
  if (f.hidden) bits.push("below 1% of time");
  return bits.join(", ");
}

/**
 * Scroll `box` (and only `box`) so `el` is inside it with `pad` px to spare. Unlike
 * `scrollIntoView`, this never scrolls the window: the tab strip and the rail must not
 * pull the page away from a row that `jumpTo` just centred.
 */
export function revealIn(box: HTMLElement, el: HTMLElement, axis: "x" | "y", pad = 0): void {
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (axis === "x") {
    if (r.left < b.left + pad) box.scrollLeft -= b.left + pad - r.left;
    else if (r.right > b.right - pad) box.scrollLeft += Math.min(r.right - (b.right - pad), r.left - (b.left + pad));
  } else if (r.top < b.top + pad) box.scrollTop -= b.top + pad - r.top;
  else if (r.bottom > b.bottom - pad) box.scrollTop += Math.min(r.bottom - (b.bottom - pad), r.top - (b.top + pad));
}

export function createFileNav(o: FileNavOptions): FileNav {
  const { ctx } = o;
  const m = ctx.model;
  const visible = m.files;
  const hidden = m.hiddenFiles;
  const all = [...visible, ...hidden];
  const maxShare = Math.max(1e-9, ...all.map((f) => f.pct));
  let mode: FileNavMode = "tabs";
  let sheetKind: "bottom" | "popover" = "popover";
  let current: FileM | null = visible[0] ?? hidden[0] ?? null;
  let tipStops: (() => void)[] = [];
  let railHiddenOpen = false;

  const bar = h("div", { class: "fn-nav" });
  const rail = h("nav", { class: "fn-rail", "aria-label": "Files" });

  // ── Popover / sheet (All files menu and the switcher) ──────────────────────
  let panel: HTMLElement | null = null;
  let scrim: HTMLElement | null = null;
  let opener: HTMLElement | null = null;

  const layerRoot = () => document.getElementById("layer-root") ?? document.body;

  function closePanel(restore = true): void {
    if (!panel) return;
    panel.remove();
    scrim?.remove();
    panel = null;
    scrim = null;
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", onResize);
    opener?.setAttribute("aria-expanded", "false");
    ctx.store.update((s) => ({ layers: { ...s.layers, fileSheet: false } }));
    if (restore) opener?.focus({ preventScroll: true });
  }

  const onOutside = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (panel && !panel.contains(t) && !opener?.contains(t)) closePanel(false);
  };
  const onResize = () => position();

  function position(): void {
    if (!panel || !opener) return;
    if (panel.classList.contains("is-sheet")) {
      panel.style.transform = "";
      return;
    }
    const r = opener.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const w = panel.offsetWidth;
    const x = Math.max(8, Math.min(vw - w - 8, r.right - w));
    let y = r.bottom + 6;
    const maxH = window.innerHeight - y - 8;
    if (maxH < 200) y = Math.max(8, r.top - 6 - Math.min(panel.offsetHeight, window.innerHeight - 16));
    panel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    panel.style.maxHeight = `${Math.max(200, window.innerHeight - y - 8)}px`;
  }

  function option(f: FileM): HTMLElement {
    const active = f === current;
    const el = h(
      "button",
      {
        type: "button",
        role: "option",
        class: ["fn-option", active ? "is-active" : ""],
        "aria-selected": String(active),
        tabindex: "-1",
        "aria-label": entryLabel(f, m),
        dataset: { file: f.name },
        onClick: () => {
          closePanel(false);
          o.onSelect(f);
        },
      },
      h("span", { class: "fn-option-main" }, entryContent(f, m, maxShare, active)),
      f.dir ? h("span", { class: "fn-option-dir" }, h("span", { class: "fn-dir-inner" }, `‎${f.dir}‎`)) : null,
    );
    return el;
  }

  function openPanel(trigger: HTMLElement, opts: { hiddenOpen?: boolean } = {}): void {
    if (panel) {
      closePanel(false);
      return;
    }
    opener = trigger;
    const sheet = mode === "switcher" && sheetKind === "bottom";
    const titleId = uid("fn-title");
    const list = h("div", { class: "fn-list", role: "listbox", "aria-label": "Files by share of run time" });
    const hiddenList = h("div", { class: "fn-list", role: "listbox", "aria-label": hiddenCaption(hidden.length) });
    let hiddenOpen = opts.hiddenOpen ?? (current?.hidden ?? false);
    const hiddenToggle = hidden.length
      ? h("button", { type: "button", class: "fn-hidden-toggle", "aria-expanded": String(hiddenOpen) })
      : null;
    const filter = all.length > 8
      ? (h("input", {
          type: "search",
          class: "text-input fn-filter",
          placeholder: "Filter files",
          "aria-label": "Filter files",
          spellcheck: "false",
          autocomplete: "off",
        }) as HTMLInputElement)
      : null;
    const fill = () => {
      const q = (filter?.value ?? "").trim().toLowerCase();
      const match = (f: FileM) => !q || f.name.toLowerCase().includes(q);
      list.replaceChildren(...visible.filter(match).map(option));
      const hv = hidden.filter(match);
      const showHidden = hiddenOpen || (q !== "" && hv.length > 0);
      hiddenList.replaceChildren(...(showHidden ? hv.map(option) : []));
      hiddenList.hidden = !showHidden || hv.length === 0;
      if (hiddenToggle) {
        hiddenToggle.setAttribute("aria-expanded", String(showHidden));
        hiddenToggle.replaceChildren(
          h("span", { class: "fn-hidden-chev", "aria-hidden": "true" }, icon(showHidden ? "chevron-down" : "chevron-right", 14)),
          hiddenCaption(hidden.length),
        );
      }
      if (!list.childElementCount && hiddenList.hidden) list.append(h("p", { class: "fn-empty" }, "No file matches"));
    };
    hiddenToggle?.addEventListener("click", () => {
      hiddenOpen = !hiddenOpen;
      fill();
    });
    filter?.addEventListener("input", fill);
    fill();
    panel = h(
      "div",
      {
        class: ["fn-panel", sheet ? "is-sheet" : "is-popover"],
        role: "dialog",
        "aria-modal": sheet ? "true" : undefined,
        "aria-labelledby": titleId,
      },
      h(
        "div",
        { class: "fn-panel-head" },
        h("h3", { id: titleId, class: "fn-panel-title" }, `${all.length} file${all.length === 1 ? "" : "s"}`),
        h("button", { type: "button", class: "icon-btn icon-btn-sm", "aria-label": "Close", onClick: () => closePanel(true) }, icon("x")),
      ),
      filter,
      h("div", { class: "fn-panel-body" }, list, hiddenToggle, hiddenList),
    );
    panel.addEventListener("keydown", (ev) => {
      if (!panel) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closePanel(true);
        return;
      }
      const opts2 = Array.from(panel.querySelectorAll<HTMLElement>('[role="option"]'));
      const i = opts2.indexOf(document.activeElement as HTMLElement);
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const j = ev.key === "ArrowDown" ? (i < 0 ? 0 : Math.min(opts2.length - 1, i + 1)) : i <= 0 ? -1 : i - 1;
        if (j < 0) (filter ?? opts2[0])?.focus();
        else opts2[j]?.focus();
      } else if (ev.key === "Home" && i >= 0) {
        ev.preventDefault();
        opts2[0]?.focus();
      } else if (ev.key === "End" && i >= 0) {
        ev.preventDefault();
        opts2[opts2.length - 1]?.focus();
      } else if (ev.key === "Enter" && document.activeElement === filter) {
        ev.preventDefault();
        opts2[0]?.click();
      } else if (ev.key === "Tab") {
        // The popover lives in #layer-root, far from its trigger: Tab closes it and moves past
        // the trigger (Shift+Tab back to it), never to the document start (APG menu button).
        if (!sheet && opener) {
          ev.preventDefault();
          const t = opener;
          closePanel(false);
          focusPastTrigger(t, ev.shiftKey);
          return;
        }
        // The sheet is modal: Tab cycles inside, also from a roving option (tabindex -1).
        const f = focusables(panel);
        if (!f.length) return;
        const at = f.indexOf(document.activeElement as HTMLElement);
        if (ev.shiftKey ? at <= 0 : at < 0 || at === f.length - 1) {
          ev.preventDefault();
          (ev.shiftKey ? f[f.length - 1] : f[0]).focus();
        }
      }
    });
    if (sheet) {
      scrim = h("div", { class: "scrim fn-scrim", "aria-hidden": "true", onClick: () => closePanel(true) });
      layerRoot().append(scrim);
    }
    layerRoot().append(panel);
    trigger.setAttribute("aria-expanded", "true");
    ctx.store.update((s) => ({ layers: { ...s.layers, fileSheet: true } }));
    position();
    const activeOpt = panel.querySelector<HTMLElement>('[role="option"].is-active');
    (filter ?? activeOpt ?? panel.querySelector<HTMLElement>('[role="option"]'))?.focus({ preventScroll: true });
    const body = panel.querySelector<HTMLElement>(".fn-panel-body");
    if (activeOpt && body) revealIn(body, activeOpt, "y", 8);
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onResize);
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  let tabsEl: HTMLElement | null = null;
  let strip: HTMLElement | null = null;
  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;
  let stripRo: ResizeObserver | null = null;

  const tabFiles = (): FileM[] => (current && current.hidden ? [...visible, current] : visible);

  function syncOverflow(): void {
    if (!strip || !tabsEl) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft < max - 1;
    tabsEl.classList.toggle("fade-left", left);
    tabsEl.classList.toggle("fade-right", right);
    if (prevBtn) prevBtn.hidden = !left;
    if (nextBtn) nextBtn.hidden = !right;
  }

  function buildTabs(): void {
    const files = tabFiles();
    strip = h("div", { class: "fn-tabs", role: "tablist", "aria-label": "Files" });
    for (const f of files) {
      const active = f === current;
      const tab = h(
        "button",
        {
          type: "button",
          role: "tab",
          class: ["fn-tab", active ? "is-active" : ""],
          "aria-selected": String(active),
          "aria-controls": "code-table",
          tabindex: active ? "0" : "-1",
          "aria-label": entryLabel(f, m),
          dataset: { file: f.name },
        },
        entryContent(f, m, maxShare, active),
      );
      tipStops.push(bindTooltip(ctx.tooltip, tab, () => fileTooltip(f, m)));
      strip.append(tab);
    }
    strip.addEventListener("click", (ev) => {
      const t = (ev.target as Element).closest<HTMLElement>(".fn-tab");
      const f = t ? m.fileByName.get(t.dataset.file ?? "") : undefined;
      if (f && f !== current) o.onSelect(f);
    });
    strip.addEventListener("keydown", (ev) => {
      const tabsList = Array.from(strip!.querySelectorAll<HTMLElement>(".fn-tab"));
      const i = tabsList.indexOf(ev.target as HTMLElement);
      if (i < 0) return;
      let j = -1;
      if (ev.key === "ArrowRight") j = (i + 1) % tabsList.length;
      else if (ev.key === "ArrowLeft") j = (i - 1 + tabsList.length) % tabsList.length;
      else if (ev.key === "Home") j = 0;
      else if (ev.key === "End") j = tabsList.length - 1;
      if (j < 0) return;
      ev.preventDefault();
      tabsList[j].focus({ preventScroll: true });
      revealIn(strip!, tabsList[j], "x", 32);
      const f = m.fileByName.get(tabsList[j].dataset.file ?? "");
      if (f) o.onSelect(f); // automatic activation (switching is cheap)
    });
    strip.addEventListener("scroll", syncOverflow, { passive: true });
    prevBtn = h("button", { type: "button", class: "fn-scroll fn-scroll-prev", "aria-label": "Scroll files left", tabindex: "-1", hidden: true, onClick: () => strip?.scrollBy({ left: -strip.clientWidth * 0.7, behavior: "smooth" }) }, icon("chevron-right"));
    nextBtn = h("button", { type: "button", class: "fn-scroll fn-scroll-next", "aria-label": "Scroll files right", tabindex: "-1", hidden: true, onClick: () => strip?.scrollBy({ left: strip.clientWidth * 0.7, behavior: "smooth" }) }, icon("chevron-right"));
    const allBtn = h(
      "button",
      { type: "button", class: "fn-all btn btn-ghost btn-compact", "aria-haspopup": "dialog", "aria-expanded": "false" },
      h("span", { class: "btn-label" }, "All files", hidden.length ? h("span", { class: "fn-all-count" }, ` (+${hidden.length})`) : null),
      icon("chevron-down"),
    );
    allBtn.addEventListener("click", () => openPanel(allBtn));
    tabsEl = h("div", { class: "fn-tabs-wrap" }, h("div", { class: "fn-tabs-scroller" }, prevBtn, strip, nextBtn), allBtn);
    stripRo?.disconnect();
    stripRo = new ResizeObserver(() => syncOverflow());
    stripRo.observe(strip);
    bar.replaceChildren(tabsEl);
    requestAnimationFrame(() => {
      const act = strip?.querySelector<HTMLElement>(".fn-tab.is-active");
      if (strip && act) revealIn(strip, act, "x", 32);
      syncOverflow();
    });
  }

  // ── Switcher ──────────────────────────────────────────────────────────────
  function buildSwitcher(): void {
    if (!current) return;
    const btn = h(
      "button",
      { type: "button", class: "fn-switcher btn btn-secondary", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-label": `File: ${entryLabel(current, m)}. Choose another file` },
      h("span", { class: "fn-name mono is-active" }, current.base),
      h("span", { class: "fn-pct" }, fmtPct(current.pct)),
      all.length > 1 ? h("span", { class: "fn-switcher-count" }, `${all.length} files`) : null,
      icon("chevron-down"),
    );
    btn.addEventListener("click", () => openPanel(btn));
    bar.replaceChildren(btn);
  }

  // ── Rail ──────────────────────────────────────────────────────────────────
  function railOption(f: FileM): HTMLElement {
    const active = f === current;
    const el = h(
      "div",
      {
        role: "option",
        class: ["fn-rail-item", active ? "is-active" : ""],
        "aria-selected": String(active),
        tabindex: active ? "0" : "-1",
        "aria-label": entryLabel(f, m),
        dataset: { file: f.name },
      },
      h(
        "span",
        { class: "fn-rail-l1" },
        h("span", { class: ["fn-name", "mono", active ? "is-active" : ""] }, f.base),
        f.leaks.length ? (() => {
          const li = icon("trend-up", 12);
          li.classList.add("fn-leak");
          return li;
        })() : null,
        h("span", { class: "fn-pct" }, fmtPct(f.pct)),
      ),
      splitBar(f, maxShare, 248),
      h(
        "span",
        { class: "fn-rail-l2" },
        h("span", { class: "fn-option-dir" }, h("span", { class: "fn-dir-inner" }, f.dir ? `‎${f.dir}‎` : "")),
        m.caps.memory && f.peak > 0 ? h("span", { class: "fn-peak" }, `peak ${fmtMem(f.peak)}`) : neuronShare(f, m) ? h("span", { class: "fn-peak" }, neuronShare(f, m)) : null,
      ),
    );
    tipStops.push(bindTooltip(ctx.tooltip, el, () => fileTooltip(f, m)));
    return el;
  }

  function buildRail(): void {
    const list = h("div", { class: "fn-rail-list", role: "listbox", "aria-label": "Files by share of run time" }, visible.map(railOption));
    const children: Child[] = [h("p", { class: "fn-rail-title micro" }, `Files · ${visible.length}`), list];
    if (hidden.length) {
      const showHid = railHiddenOpen || (current?.hidden ?? false);
      children.push(
        h(
          "button",
          {
            type: "button",
            class: "fn-hidden-toggle fn-rail-hidden",
            "aria-expanded": String(showHid),
            onClick: () => {
              railHiddenOpen = !showHid;
              buildRail();
              rail.querySelector<HTMLElement>(".fn-rail-hidden")?.focus();
            },
          },
          h("span", { class: "fn-hidden-chev", "aria-hidden": "true" }, icon(showHid ? "chevron-down" : "chevron-right", 14)),
          h("span", null, hiddenCaption(hidden.length, true), h("span", { class: "fn-hidden-act" }, showHid ? " · Hide" : " · Show")),
        ),
      );
      if (showHid) children.push(h("div", { class: "fn-rail-list", role: "listbox", "aria-label": hiddenCaption(hidden.length) }, hidden.map(railOption)));
    }
    rail.replaceChildren(...(children as Node[]));
  }

  rail.addEventListener("click", (ev) => {
    const t = (ev.target as Element).closest<HTMLElement>(".fn-rail-item");
    const f = t ? m.fileByName.get(t.dataset.file ?? "") : undefined;
    if (f && f !== current) o.onSelect(f);
  });
  rail.addEventListener("keydown", (ev) => {
    const itemsEls = Array.from(rail.querySelectorAll<HTMLElement>(".fn-rail-item"));
    const i = itemsEls.indexOf(ev.target as HTMLElement);
    if (i < 0) return;
    let j = -1;
    if (ev.key === "ArrowDown") j = Math.min(itemsEls.length - 1, i + 1);
    else if (ev.key === "ArrowUp") j = Math.max(0, i - 1);
    else if (ev.key === "Home") j = 0;
    else if (ev.key === "End") j = itemsEls.length - 1;
    else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      const f = m.fileByName.get(itemsEls[i].dataset.file ?? "");
      if (f && f !== current) o.onSelect(f);
      return;
    }
    if (j < 0) return;
    ev.preventDefault();
    itemsEls.forEach((el, k) => (el.tabIndex = k === j ? 0 : -1));
    itemsEls[j].focus();
  });

  // ── Mode switching ────────────────────────────────────────────────────────
  function rebuild(): void {
    for (const s of tipStops) s();
    tipStops = [];
    closePanel(false);
    bar.hidden = mode === "rail";
    rail.hidden = mode !== "rail";
    if (mode === "tabs") buildTabs();
    else if (mode === "switcher") buildSwitcher();
    else {
      bar.replaceChildren();
      buildRail();
    }
    if (mode !== "rail") rail.replaceChildren();
  }

  return {
    bar,
    rail,
    setMode(next, sheet) {
      sheetKind = sheet;
      if (next === mode && (bar.childElementCount || rail.childElementCount)) return;
      mode = next;
      rebuild();
    },
    setCurrent(f) {
      if (f === current && (bar.childElementCount || rail.childElementCount)) return;
      const focusInNav = bar.contains(document.activeElement) || rail.contains(document.activeElement);
      current = f;
      rebuild();
      if (focusInNav) {
        const sel = mode === "rail" ? ".fn-rail-item.is-active" : mode === "tabs" ? ".fn-tab.is-active" : ".fn-switcher";
        (mode === "rail" ? rail : bar).querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
      }
    },
    showHidden() {
      if (mode === "rail") {
        railHiddenOpen = true;
        buildRail();
        const hid = rail.querySelector<HTMLElement>(".fn-rail-hidden");
        if (hid) revealIn(rail, hid, "y", 8);
        return;
      }
      const trigger = bar.querySelector<HTMLElement>(mode === "tabs" ? ".fn-all" : ".fn-switcher");
      if (trigger) openPanel(trigger, { hiddenOpen: true });
    },
    destroy() {
      closePanel(false);
      for (const s of tipStops) s();
      stripRo?.disconnect();
      bar.remove();
      rail.remove();
    },
  };
}
