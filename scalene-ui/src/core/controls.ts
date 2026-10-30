// Shared controls (DESIGN.md §4.21): buttons, segmented radiogroups, tabs, select,
// switch, menu, disclosure, chips, badges, key chips. Styles: styles/03-controls.css.
import { focusPastTrigger } from "./a11y";
import { h, uid, type Child } from "./dom";
import { icon, type IconName } from "./icons";
import { EASE_CSS, DUR } from "./motion";

/** Motion is allowed unless <html> carries motion-reduce / motion-still. */
function motionAllowed(): boolean {
  const c = document.documentElement.classList;
  return !c.contains("motion-reduce") && !c.contains("motion-still");
}

// ── Buttons ─────────────────────────────────────────────────────────────────────

export interface ButtonOptions {
  label?: Child;
  icon?: IconName;
  /** Icon after the label (e.g. a chevron). */
  trailingIcon?: IconName;
  variant?: "primary" | "secondary" | "ghost";
  compact?: boolean;
  ariaLabel?: string;
  class?: string;
  disabled?: boolean;
  onClick?(ev: MouseEvent): void;
}

export function button(o: ButtonOptions): HTMLButtonElement {
  const b = h(
    "button",
    {
      type: "button",
      class: ["btn", `btn-${o.variant ?? "secondary"}`, o.compact ? "btn-compact" : "", o.class ?? ""],
      "aria-label": o.ariaLabel,
      "aria-disabled": o.disabled ? "true" : undefined,
    },
    o.icon ? icon(o.icon) : null,
    o.label !== undefined ? h("span", { class: "btn-label" }, o.label) : null,
    o.trailingIcon ? icon(o.trailingIcon) : null,
  );
  if (o.onClick) {
    const run = o.onClick;
    b.addEventListener("click", (ev) => {
      if (b.getAttribute("aria-disabled") === "true") return;
      run(ev);
    });
  }
  return b;
}

export interface IconButtonOptions {
  icon: IconName;
  /** Accessible name (required); also the tooltip text. */
  label: string;
  onClick?(ev: MouseEvent): void;
  pressed?: boolean;
  class?: string;
  /** Visible text after the icon (e.g. "AI" at lg+); hidden per breakpoint via CSS. */
  text?: string;
}

export function iconButton(o: IconButtonOptions): HTMLButtonElement {
  const b = h(
    "button",
    {
      type: "button",
      class: ["icon-btn", o.text ? "icon-btn-text" : "", o.class ?? ""],
      "aria-label": o.label,
      "aria-pressed": o.pressed === undefined ? undefined : String(o.pressed),
      onClick: o.onClick,
    },
    icon(o.icon),
    o.text ? h("span", { class: "icon-btn-label", "aria-hidden": "true" }, o.text) : null,
  );
  return b;
}

// ── Segmented control (radiogroup) and tabs ──────────────────────────────────────

export interface Option<V extends string> {
  value: V;
  label: Child;
  /** Tooltip / description text (shown via the shared tooltip by the caller). */
  description?: string;
  /** Tabs only: id of the controlled panel. */
  controls?: string;
}

export interface Choice<V extends string> {
  el: HTMLElement;
  value(): V;
  set(v: V, opts?: { emit?: boolean }): void;
  buttons(): HTMLButtonElement[];
  destroy(): void;
}

interface ChoiceConfig<V extends string> {
  role: "radiogroup" | "tablist";
  itemRole: "radio" | "tab";
  stateAttr: "aria-checked" | "aria-selected";
  className: string;
  label: string;
  options: readonly Option<V>[];
  value: V;
  onChange(v: V): void;
  id?: string;
}

function choiceGroup<V extends string>(cfg: ChoiceConfig<V>): Choice<V> {
  let current = cfg.value;
  const thumb = cfg.role === "radiogroup" ? h("span", { class: "seg-thumb", "aria-hidden": "true" }) : null;
  const btns = cfg.options.map((opt) =>
    h(
      "button",
      {
        type: "button",
        role: cfg.itemRole,
        class: `${cfg.className}-item`,
        id: cfg.role === "tablist" ? uid("tab") : undefined,
        "aria-controls": opt.controls,
        dataset: { value: opt.value },
      },
      opt.label,
    ),
  );
  const el = h("div", { role: cfg.role, class: cfg.className, "aria-label": cfg.label, id: cfg.id }, thumb, btns);
  // Compatibility: upstream code reads `.value` from these groups (e.g. #display-mode-file-N).
  Object.defineProperty(el, "value", { get: () => current, configurable: true });

  let lastThumb: { x: number; w: number } | null = null;
  const placeThumb = (animate: boolean) => {
    if (!thumb) return;
    const i = cfg.options.findIndex((o) => o.value === current);
    const target = btns[i];
    if (!target || !target.offsetWidth) return;
    const next = { x: target.offsetLeft, w: target.offsetWidth };
    thumb.style.width = `${next.w}px`;
    thumb.style.transform = `translateX(${next.x}px)`;
    if (animate && lastThumb && motionAllowed() && (lastThumb.x !== next.x || lastThumb.w !== next.w)) {
      thumb.animate(
        [{ transform: `translateX(${lastThumb.x}px) scaleX(${lastThumb.w / next.w})` }, { transform: `translateX(${next.x}px)` }],
        { duration: DUR.d3, easing: EASE_CSS.standard },
      );
    }
    lastThumb = next;
  };

  const sync = () => {
    btns.forEach((b, i) => {
      const on = cfg.options[i].value === current;
      b.setAttribute(cfg.stateAttr, String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };

  const set = (v: V, opts: { emit?: boolean } = {}) => {
    if (!cfg.options.some((o) => o.value === v)) return;
    const changed = v !== current;
    current = v;
    sync();
    placeThumb(true);
    if (changed && opts.emit) cfg.onChange(v);
  };

  el.addEventListener("click", (ev) => {
    const b = (ev.target as Element).closest<HTMLButtonElement>(`.${cfg.className}-item`);
    if (b && el.contains(b)) set(b.dataset.value as V, { emit: true });
  });
  el.addEventListener("keydown", (ev) => {
    const i = btns.indexOf(ev.target as HTMLButtonElement);
    if (i < 0) return;
    let next = -1;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (i + 1) % btns.length;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (i - 1 + btns.length) % btns.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = btns.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    btns[next].focus();
    set(cfg.options[next].value, { emit: true });
  });

  let ro: ResizeObserver | null = null;
  if (thumb && typeof ResizeObserver === "function") {
    ro = new ResizeObserver(() => placeThumb(false));
    ro.observe(el);
  }
  sync();

  return {
    el,
    value: () => current,
    set,
    buttons: () => btns,
    destroy: () => ro?.disconnect(),
  };
}

/** Segmented control: `role=radiogroup`, sliding thumb (M7), ←/→ moves and selects. */
export function segmented<V extends string>(o: {
  label: string;
  options: readonly Option<V>[];
  value: V;
  onChange(v: V): void;
  id?: string;
}): Choice<V> {
  return choiceGroup({ ...o, role: "radiogroup", itemRole: "radio", stateAttr: "aria-checked", className: "seg" });
}

/** Tabs: `role=tablist`, automatic activation on arrow keys, 2 px ink underline. */
export function tabs<V extends string>(o: {
  label: string;
  options: readonly Option<V>[];
  value: V;
  onChange(v: V): void;
  id?: string;
}): Choice<V> {
  return choiceGroup({ ...o, role: "tablist", itemRole: "tab", stateAttr: "aria-selected", className: "tabs" });
}

// ── Select, text input, switch ─────────────────────────────────────────────────

export interface SelectControl<V extends string> {
  el: HTMLElement;
  select: HTMLSelectElement;
  value(): V;
  set(v: V): void;
  setOptions(options: readonly { value: V; label: string }[], value?: V): void;
}

export function select<V extends string>(o: {
  label: string;
  options: readonly { value: V; label: string }[];
  value: V;
  onChange(v: V): void;
  id?: string;
  /** Render a visible label before the control. */
  showLabel?: boolean;
}): SelectControl<V> {
  const id = o.id ?? uid("select");
  const sel = h("select", { id, class: "select-input", "aria-label": o.showLabel ? undefined : o.label });
  const setOptions = (opts: readonly { value: V; label: string }[], value?: V) => {
    sel.replaceChildren(...opts.map((x) => h("option", { value: x.value }, x.label)));
    if (value !== undefined) sel.value = value;
  };
  setOptions(o.options, o.value);
  sel.addEventListener("change", () => o.onChange(sel.value as V));
  const el = h(
    "span",
    { class: "select" },
    o.showLabel ? h("label", { class: "select-label", for: id }, o.label) : null,
    h("span", { class: "select-box" }, sel, icon("chevron-down")),
  );
  return {
    el,
    select: sel,
    value: () => sel.value as V,
    set: (v) => {
      sel.value = v;
    },
    setOptions,
  };
}

export interface SwitchControl {
  el: HTMLButtonElement;
  checked(): boolean;
  set(on: boolean): void;
}

/** `role=switch` button: 32 × 18 track, on = ink track. */
export function switchControl(o: { label: string; checked: boolean; onChange(on: boolean): void; id?: string }): SwitchControl {
  let on = o.checked;
  const el = h(
    "button",
    { type: "button", role: "switch", class: "switch", id: o.id },
    h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-thumb" })),
    h("span", { class: "switch-label" }, o.label),
  );
  const sync = () => el.setAttribute("aria-checked", String(on));
  el.addEventListener("click", () => {
    on = !on;
    sync();
    o.onChange(on);
  });
  sync();
  return {
    el,
    checked: () => on,
    set(v) {
      on = v;
      sync();
    },
  };
}

// ── Menu ────────────────────────────────────────────────────────────────────────

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: IconName;
      run(): void;
      /** Renders a menuitemcheckbox. */
      checked?: boolean;
      /** Marks the current location (e.g. the active section) with a check and aria-current. */
      current?: boolean;
      disabled?: boolean;
      hint?: string;
    }
  | { kind: "separator" };

export interface MenuControl {
  open(focus?: "first" | "last"): void;
  close(restoreFocus?: boolean): void;
  isOpen(): boolean;
  destroy(): void;
}

/**
 * Popup menu (`role=menu`) anchored to `trigger`, rendered in the layer root: arrow keys,
 * Home/End, typeahead, Esc / Tab / outside click close it.
 */
export function menu(o: { trigger: HTMLElement; label: string; items(): MenuItem[]; root: HTMLElement; align?: "start" | "end" }): MenuControl {
  const id = uid("menu");
  let panel: HTMLElement | null = null;
  let typed = "";
  let typedTimer = 0;
  o.trigger.setAttribute("aria-haspopup", "menu");
  o.trigger.setAttribute("aria-expanded", "false");
  // aria-controls is set only while the menu exists (an IDREF to a missing id is invalid).
  o.trigger.removeAttribute("aria-controls");

  const items = () => (panel ? Array.from(panel.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')) : []);

  const close = (restoreFocus = true) => {
    if (!panel) return;
    panel.remove();
    panel = null;
    o.trigger.setAttribute("aria-expanded", "false");
    o.trigger.removeAttribute("aria-controls");
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", onViewportChange);
    if (restoreFocus) o.trigger.focus({ preventScroll: true });
  };

  const onOutside = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (panel && !panel.contains(t) && !o.trigger.contains(t)) close(false);
  };
  const onViewportChange = () => close(false);

  const position = () => {
    if (!panel) return;
    const r = o.trigger.getBoundingClientRect();
    const w = panel.offsetWidth;
    const vw = document.documentElement.clientWidth;
    let x = o.align === "start" ? r.left : r.right - w;
    x = Math.max(8, Math.min(vw - w - 8, x));
    let y = r.bottom + 4;
    if (y + panel.offsetHeight > window.innerHeight - 8) y = Math.max(8, r.top - 4 - panel.offsetHeight);
    panel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const onKey = (ev: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (n: number) => list[(n + list.length) % list.length]?.focus();
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        focusAt(i + 1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        focusAt(i - 1);
        break;
      case "Home":
        ev.preventDefault();
        focusAt(0);
        break;
      case "End":
        ev.preventDefault();
        focusAt(list.length - 1);
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        close(true);
        break;
      case "Tab":
        // The panel lives in #layer-root: leave it relative to the trigger, never through
        // the end of the document (WCAG 2.4.3, APG menu button).
        ev.preventDefault();
        close(false);
        focusPastTrigger(o.trigger, ev.shiftKey);
        break;
      default:
        if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          typed += ev.key.toLowerCase();
          window.clearTimeout(typedTimer);
          typedTimer = window.setTimeout(() => (typed = ""), 600);
          const start = Math.max(0, i);
          const order = [...list.slice(start + 1), ...list.slice(0, start + 1)];
          order.find((el) => (el.textContent ?? "").trim().toLowerCase().startsWith(typed))?.focus();
        }
    }
  };

  const open = (focus: "first" | "last" = "first") => {
    if (panel) return;
    const built = o.items().map((it) => {
      if (it.kind === "separator") return h("div", { role: "separator", class: "menu-sep" });
      const checkable = it.checked !== undefined;
      return h(
        "button",
        {
          type: "button",
          role: checkable ? "menuitemcheckbox" : "menuitem",
          class: "menu-item",
          tabindex: "-1",
          "aria-checked": checkable ? String(it.checked) : undefined,
          "aria-current": it.current ? "true" : undefined,
          "aria-disabled": it.disabled ? "true" : undefined,
          onClick: () => {
            if (it.disabled) return;
            close(false);
            it.run();
          },
        },
        h("span", { class: "menu-icon" }, it.icon ? icon(it.icon) : it.checked || it.current ? icon("check") : null),
        h("span", { class: "menu-label" }, it.label),
        it.hint ? h("kbd", { class: "key-chip" }, it.hint) : null,
      );
    });
    panel = h("div", { id, role: "menu", class: "menu", "aria-label": o.label, onKeydown: onKey }, built);
    o.root.appendChild(panel);
    o.trigger.setAttribute("aria-expanded", "true");
    o.trigger.setAttribute("aria-controls", id);
    position();
    const list = items();
    (focus === "last" ? list[list.length - 1] : list[0])?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onViewportChange);
  };

  const onTriggerClick = () => (panel ? close(false) : open());
  const onTriggerKey = (ev: KeyboardEvent) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      open(ev.key === "ArrowUp" ? "last" : "first");
    }
  };
  o.trigger.addEventListener("click", onTriggerClick);
  o.trigger.addEventListener("keydown", onTriggerKey);

  return {
    open,
    close,
    isOpen: () => panel !== null,
    destroy() {
      close(false);
      o.trigger.removeEventListener("click", onTriggerClick);
      o.trigger.removeEventListener("keydown", onTriggerKey);
    },
  };
}

// ── Disclosure ─────────────────────────────────────────────────────────────────

export interface Disclosure {
  el: HTMLElement;
  button: HTMLButtonElement;
  panel: HTMLElement;
  isOpen(): boolean;
  set(open: boolean): void;
}

/** Chevron button + panel revealed via grid-template-rows 0fr → 1fr (200 ms). */
export function disclosure(o: { label: Child; content: Child; open?: boolean; onToggle?(open: boolean): void; class?: string }): Disclosure {
  let isOpen = o.open ?? false;
  const panelId = uid("disc");
  const btn = h(
    "button",
    { type: "button", class: "disclosure-btn", "aria-controls": panelId },
    h("span", { class: "disclosure-chevron" }, icon("chevron-right")),
    h("span", null, o.label),
  );
  const panel = h("div", { id: panelId, class: "disclosure-panel" }, h("div", { class: "disclosure-inner" }, o.content));
  const el = h("div", { class: ["disclosure", o.class ?? ""] }, btn, panel);
  const sync = () => {
    btn.setAttribute("aria-expanded", String(isOpen));
    el.toggleAttribute("data-open", isOpen);
  };
  btn.addEventListener("click", () => {
    isOpen = !isOpen;
    sync();
    o.onToggle?.(isOpen);
  });
  sync();
  return {
    el,
    button: btn,
    panel,
    isOpen: () => isOpen,
    set(v) {
      isOpen = v;
      sync();
    },
  };
}

// ── Chips, badges, key chips ─────────────────────────────────────────────────────

/** Code chip: mono, never wraps; a button when it navigates. */
export function chip(text: string, o: { onClick?(ev: MouseEvent): void; ariaLabel?: string; class?: string } = {}): HTMLElement {
  if (o.onClick) {
    return h("button", { type: "button", class: ["chip-code", o.class ?? ""], "aria-label": o.ariaLabel, onClick: o.onClick }, text);
  }
  return h("code", { class: ["chip-code", o.class ?? ""] }, text);
}

/** Badge: neutral, danger, or resource (swatch dot in a token colour + `--fg-2` text). */
export function badge(text: Child, o: { variant?: "neutral" | "danger" | "resource"; icon?: IconName; swatch?: string } = {}): HTMLElement {
  const variant = o.variant ?? "neutral";
  return h(
    "span",
    { class: ["badge", `badge-${variant}`] },
    o.icon ? icon(o.icon, 12) : null,
    o.swatch ? h("span", { class: "badge-swatch", style: { background: `var(--${o.swatch})` }, "aria-hidden": "true" }) : null,
    text,
  );
}

/** Keyboard key chip. */
export function keyChip(text: string): HTMLElement {
  return h("kbd", { class: "key-chip" }, text);
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function modKeyLabel(key: string): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform) ? `⌘${key}` : `Ctrl ${key}`;
}

// ── Section header ─────────────────────────────────────────────────────────────

/**
 * Section header (§2.2): `h2` 18/24 600 + one-line description 13/18 `--fg-2`. The heading
 * gets `id="<section>-h"` (the section's aria-labelledby target) and tabindex -1 so
 * navigation can move focus to it.
 */
export function sectionHeader(o: { section: string; title: Child; description?: Child; actions?: Child }): HTMLElement {
  return h(
    "header",
    { class: "section-head" },
    h(
      "div",
      { class: "section-head-text" },
      h("h2", { id: `${o.section}-h`, class: "section-title", tabindex: "-1" }, o.title),
      o.description !== undefined ? h("p", { class: "section-desc" }, o.description) : null,
    ),
    o.actions !== undefined ? h("div", { class: "section-head-actions" }, o.actions) : null,
  );
}
