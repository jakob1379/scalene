// App bar (DESIGN.md §4.1, §2.4.1): logo · program · section nav · search · AI · load ·
// theme, with a ⋯ menu on xs/short. Which parts show at which breakpoint is pure CSS
// (styles/10-appbar.css) keyed on the <html> bp-* / short classes.
import { focusPastTrigger } from "../core/a11y";
import { menu, modKeyLabel, type MenuItem } from "../core/controls";
import { h, uid } from "../core/dom";
import { basename, fmtDate } from "../core/format";
import { icon, logoMark } from "../core/icons";
import { throttleRaf } from "../core/schedule";
import type { SectionId } from "../core/store";
import type { Model } from "../model/model";
import type { SectionInfo, ShellContext } from "./app";

export interface AppBarHandle {
  setModel(model: Model | null, sections: SectionInfo[]): void;
  destroy(): void;
}

const REPO = "https://github.com/plasma-umass/scalene";
const SPY_OFFSET = 40;

/** Program arguments (`args[1:]`) joined; arguments with whitespace are quoted. */
export function displayArgs(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
}

/** Middle-truncate `s` to at most `max` characters ("--config c…200"). */
export function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return max === 1 ? "…" : "";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

const charWidths = new Map<string, number>();
/** Advance width of one character in a monospace font. */
function monoCharWidth(font: string): number {
  let w = charWidths.get(font);
  if (w === undefined) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return 7.5;
    ctx.font = font;
    w = ctx.measureText("0000000000").width / 10 || 7.5;
    charWidths.set(font, w);
  }
  return w;
}

export function mountAppBar(el: HTMLElement, shell: ShellContext): AppBarHandle {
  const { theme, motion, tooltip, layerRoot } = shell;
  let model: Model | null = null;
  let sections: SectionInfo[] = [];
  let active: SectionId | null = null;
  let argsText = "";

  el.classList.add("appbar");
  el.setAttribute("role", "banner");

  // 1–2. Logo + divider
  const logo = h(
    "a",
    { class: "appbar-logo", href: REPO, target: "_blank", rel: "noopener", "aria-label": "Scalene on GitHub" },
    logoMark(22),
    h("span", { class: "appbar-logo-text", "aria-hidden": "true" }, "Scalene"),
  );
  const divider = h("span", { class: "appbar-divider", "aria-hidden": "true" });

  // 3. Program (button → details popover)
  const progName = h("span", { class: "appbar-prog-name mono" });
  const progArgs = h("span", { class: "appbar-prog-args mono" });
  const popId = uid("program");
  const progBtn = h(
    "button",
    // aria-controls is added while the popover exists (a dangling IDREF is invalid).
    { type: "button", class: "appbar-program", "aria-expanded": "false" },
    progName,
    progArgs,
  );
  const progWrap = h("div", { class: "appbar-program-wrap" }, progBtn);
  let popover: HTMLElement | null = null;

  // 4. Section nav (lg+) and the "Sections ▾" menu button (sm, md)
  const navEl = h("nav", { class: "appbar-nav", "aria-label": "Sections" });
  const sectionsBtn = h(
    "button",
    { type: "button", class: "btn btn-ghost btn-compact appbar-sections" },
    h("span", { class: "btn-label" }, "Sections"),
    icon("chevron-down"),
  );

  // 6–9. Search, AI, Load, Theme, and the ⋯ menu (xs, short)
  const searchBtn = h(
    "button",
    {
      type: "button",
      class: "appbar-search",
      "aria-label": "Search lines, functions and files",
      "aria-keyshortcuts": "Control+K Meta+K /",
      onClick: () => shell.actions.openPalette(),
    },
    icon("search"),
    h("span", { class: "appbar-search-label", "aria-hidden": "true" }, "Search"),
    h("kbd", { class: "key-chip appbar-search-key", "aria-hidden": "true" }, modKeyLabel("K")),
  );
  const aiDot = h("span", { class: "appbar-ai-dot", "aria-hidden": "true" });
  // "AI fixes" + a visible "Set up" badge until a provider is ready (review round 1: a bare
  // "AI" with a hollow ring did not say what it offers or that it needs setting up).
  const aiSetup = h("span", { class: "badge badge-neutral appbar-ai-setup" }, "Set up");
  const aiBtn = h(
    "button",
    { type: "button", class: "icon-btn icon-btn-text appbar-ai", onClick: () => shell.actions.openAiSettings() },
    icon("spark"),
    h("span", { class: "icon-btn-label appbar-ai-label", "aria-hidden": "true" }, "AI fixes", aiSetup),
    aiDot,
  );
  const loadBtn = h(
    "button",
    { type: "button", class: "icon-btn icon-btn-text appbar-load", "aria-label": "Load a profile (.json)", onClick: () => shell.actions.openFilePicker() },
    icon("upload"),
    h("span", { class: "icon-btn-label appbar-load-label", "aria-hidden": "true" }, "Load"),
  );
  const themeBtn = h("button", { type: "button", class: "icon-btn appbar-theme", onClick: () => shell.actions.toggleTheme() });
  const moreBtn = h(
    "button",
    { type: "button", class: "icon-btn appbar-more", "aria-label": "More actions" },
    icon("menu"),
  );

  el.replaceChildren(
    h(
      "div",
      { class: "appbar-inner" },
      logo,
      divider,
      progWrap,
      navEl,
      sectionsBtn,
      h("span", { class: "appbar-spacer" }),
      searchBtn,
      aiBtn,
      loadBtn,
      themeBtn,
      moreBtn,
    ),
  );

  const disposers: (() => void)[] = [];
  disposers.push(
    tooltip.bind(loadBtn, { title: "Load a profile (.json)" }),
    tooltip.bind(themeBtn, () => ({ title: themeBtn.getAttribute("aria-label") ?? "" })),
    tooltip.bind(aiBtn, () => ({ title: aiBtn.getAttribute("aria-label") ?? "" })),
    tooltip.bind(moreBtn, { title: "More actions" }),
  );

  // ── State renderers ─────────────────────────────────────────────────────────

  const renderTheme = () => {
    const dark = theme.current() === "dark";
    themeBtn.replaceChildren(icon(dark ? "sun" : "moon"));
    themeBtn.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
  };

  const renderAi = () => {
    const ai = shell.ai();
    const ready = ai.ready().ready;
    const summary = ai.providerSummary();
    const provider = summary.split(" · ")[0];
    aiBtn.setAttribute("aria-label", ready ? `AI fixes — ${provider}, ready` : "AI fixes — set up a provider");
    aiDot.classList.toggle("is-ready", ready);
    aiSetup.hidden = ready;
  };

  const fitArgs = () => {
    if (!argsText) {
      progArgs.textContent = "";
      return;
    }
    // The wrapper takes the free space; the button shrinks to its content.
    const avail = progWrap.clientWidth - progName.offsetWidth - 8 - 16;
    const cs = getComputedStyle(progArgs);
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const chars = Math.floor(Math.max(0, avail) / monoCharWidth(font));
    progArgs.textContent = middleEllipsis(argsText, chars);
  };

  const renderProgram = () => {
    if (!model) {
      progName.textContent = "";
      argsText = "";
      fitArgs();
      return;
    }
    progName.textContent = model.program ? basename(model.program) : "Scalene report";
    argsText = model.program ? displayArgs(model.args) : "";
    progBtn.setAttribute("aria-label", `Program ${model.program || "unknown"}${argsText ? ` ${argsText}` : ""}. Show details`);
    fitArgs();
  };

  const renderNav = () => {
    navEl.replaceChildren(
      ...sections.map((s) =>
        h(
          "a",
          {
            href: `#${s.id}`,
            class: "appbar-nav-link",
            dataset: { section: s.id },
            "aria-current": s.id === active ? "true" : undefined,
            onClick: (ev: MouseEvent) => {
              ev.preventDefault();
              void shell.nav()?.showSection(s.id, { focus: true, toSelection: true });
            },
          },
          s.label,
        ),
      ),
    );
  };

  const setActive = (id: SectionId | null) => {
    if (id === active) return;
    active = id;
    for (const a of Array.from(navEl.querySelectorAll<HTMLElement>("[data-section]"))) {
      if (a.dataset.section === id) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  };

  // Scroll-spy: active = last section whose top ≤ app bar height + 40 (bottom → last).
  const spy = throttleRaf(() => {
    if (!sections.length) return;
    const line = el.getBoundingClientRect().height + SPY_OFFSET;
    let current: SectionId | null = sections[0].id;
    for (const s of sections) {
      const sec = document.getElementById(s.id);
      if (sec && sec.getBoundingClientRect().top <= line) current = s.id;
    }
    const doc = document.documentElement;
    if (window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
      current = sections[sections.length - 1].id;
    }
    setActive(current);
  });
  window.addEventListener("scroll", spy, { passive: true });
  window.addEventListener("resize", spy, { passive: true });
  disposers.push(() => {
    window.removeEventListener("scroll", spy);
    window.removeEventListener("resize", spy);
    spy.cancel();
  });

  // ── Program popover ─────────────────────────────────────────────────────────

  const closePopover = (restoreFocus = false) => {
    if (!popover) return;
    popover.remove();
    popover = null;
    progBtn.setAttribute("aria-expanded", "false");
    progBtn.removeAttribute("aria-controls");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onPopoverKey, true);
    if (restoreFocus) progBtn.focus({ preventScroll: true });
  };
  const onOutside = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (popover && !popover.contains(t) && !progBtn.contains(t)) closePopover();
  };
  const onPopoverKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && popover) {
      ev.preventDefault();
      ev.stopPropagation();
      closePopover(true);
    } else if (ev.key === "Tab" && popover && popover.contains(document.activeElement)) {
      // The popover lives in #layer-root, after the page: leave it relative to its trigger.
      ev.preventDefault();
      closePopover();
      focusPastTrigger(progBtn, ev.shiftKey);
    }
  };
  const openPopover = () => {
    if (!model || popover) return;
    const rows: [string, string][] = [
      ["Program", model.program || "not recorded"],
      ["Arguments", argsText || "none"],
      ["Directory", model.entrypointDir || "not recorded"],
      ["Profiled", model.startEpoch !== null ? fmtDate(model.startEpoch) : "not recorded"],
      ["Scalene", shell.meta.version || model.version || "not recorded"],
    ];
    popover = h(
      "div",
      { id: popId, class: "popover appbar-program-popover", role: "dialog", "aria-label": "Program details" },
      h(
        "dl",
        { class: "popover-rows" },
        rows.map(([k, v]) => [h("dt", null, k), h("dd", { class: k === "Profiled" || k === "Scalene" ? "" : "mono" }, v)]),
      ),
    );
    layerRoot.appendChild(popover);
    const r = progBtn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const x = Math.max(8, Math.min(vw - popover.offsetWidth - 8, r.left));
    popover.style.transform = `translate(${Math.round(x)}px, ${Math.round(r.bottom + 6)}px)`;
    progBtn.setAttribute("aria-expanded", "true");
    progBtn.setAttribute("aria-controls", popId);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onPopoverKey, true);
    // A non-modal dialog: focus moves into it; leaving it (Tab, click elsewhere) closes it.
    popover.setAttribute("tabindex", "-1");
    popover.addEventListener("focusout", (ev) => {
      const next = ev.relatedTarget as Node | null;
      if (popover && next && !popover.contains(next) && next !== progBtn) closePopover();
    });
    popover.focus({ preventScroll: true });
  };
  progBtn.addEventListener("click", () => (popover ? closePopover() : openPopover()));
  disposers.push(() => closePopover());

  // ── Menus ───────────────────────────────────────────────────────────────────

  const sectionItems = (): MenuItem[] =>
    sections.map((s) => ({
      label: s.label,
      current: s.id === active,
      run: () => void shell.nav()?.showSection(s.id, { focus: true, toSelection: true }),
    }));

  const sectionsMenu = menu({ trigger: sectionsBtn, label: "Sections", root: layerRoot, align: "start", items: sectionItems });
  const moreMenu = menu({
    trigger: moreBtn,
    label: "More actions",
    root: layerRoot,
    items: () => {
      const dark = theme.current() === "dark";
      const items: MenuItem[] = [];
      if (model && sections.length) items.push(...sectionItems(), { kind: "separator" });
      items.push(
        { label: "Load profile…", icon: "upload", run: () => shell.actions.openFilePicker() },
        { label: dark ? "Light theme" : "Dark theme", icon: dark ? "sun" : "moon", run: () => shell.actions.toggleTheme() },
        { label: "Reduce motion", checked: motion.reduced, run: () => shell.actions.setReducedMotion(!motion.reduced) },
      );
      if (model) items.push({ label: "Keyboard shortcuts", hint: "?", run: () => shell.actions.openShortcuts() });
      return items;
    },
  });
  disposers.push(() => sectionsMenu.destroy(), () => moreMenu.destroy());

  // ── Subscriptions ───────────────────────────────────────────────────────────

  disposers.push(
    shell.bus.on("theme:changed", renderTheme),
    shell.ai().onChange((anchor) => {
      if (anchor === null) renderAi();
    }),
  );
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => fitArgs());
    ro.observe(progWrap);
    disposers.push(() => ro.disconnect());
  }

  renderTheme();
  renderAi();
  el.classList.add("is-empty");

  return {
    setModel(m, list) {
      model = m;
      sections = list;
      active = null;
      el.classList.toggle("is-empty", m === null);
      closePopover();
      renderProgram();
      renderNav();
      renderAi();
      setActive(list[0]?.id ?? null);
      spy();
    },
    destroy() {
      for (const d of disposers.splice(0)) d();
      el.replaceChildren();
    },
  };
}
