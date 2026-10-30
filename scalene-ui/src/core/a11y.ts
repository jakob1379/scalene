// Accessibility plumbing: live-region announcer, modal stack (inert + focus trap + Esc),
// roving tabindex, and "scroll into view, then focus". DESIGN.md §6.2.
import { h, isTypingTarget, VISUALLY_HIDDEN } from "./dom";

export interface Announcer {
  polite(text: string): void;
  assertive(text: string): void;
}

export interface AnnouncerController extends Announcer {
  destroy(): void;
}

const POLITE_DEBOUNCE_MS = 150;

/** Creates `#sr-polite` / `#sr-assertive` inside `root` (the layer root). */
export function createAnnouncer(root: HTMLElement): AnnouncerController {
  const region = (id: string, live: "polite" | "assertive") =>
    document.getElementById(id) ??
    root.appendChild(h("div", { id, class: VISUALLY_HIDDEN, "aria-live": live, "aria-atomic": "true" }));
  const polite = region("sr-polite", "polite");
  const assertive = region("sr-assertive", "assertive");
  let timer = 0;

  // Clearing first makes screen readers re-announce identical consecutive messages.
  const say = (el: HTMLElement, text: string) => {
    el.textContent = "";
    requestAnimationFrame(() => {
      el.textContent = text;
    });
  };

  return {
    polite(text) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => say(polite, text), POLITE_DEBOUNCE_MS);
    },
    assertive(text) {
      say(assertive, text);
    },
    destroy() {
      window.clearTimeout(timer);
    },
  };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Keyboard-focusable descendants in DOM order (visible ones only). */
export function focusables(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0,
  );
}

/**
 * Tab / Shift+Tab out of a popup that lives in `#layer-root` (menus, popovers, listboxes):
 * the popup is DOM-detached from its trigger, so default sequential navigation would fall
 * through to the end of the document. Call it after closing the popup: Shift+Tab returns to
 * the trigger; Tab moves to the first focusable after the trigger in document order (outside
 * any layer), as the APG menu-button pattern prescribes. Returns the element focused.
 */
export function focusPastTrigger(trigger: HTMLElement, backwards: boolean): HTMLElement {
  if (!backwards) {
    const list = focusables(document.body).filter((el) => !el.closest(".layer-root, #layer-root, [aria-hidden='true']") && !el.closest("[inert]"));
    const after = list.find((el) => el !== trigger && !trigger.contains(el) && (trigger.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    if (after) {
      after.focus();
      return after;
    }
  }
  trigger.focus({ preventScroll: true });
  return trigger;
}

export interface ModalOptions {
  /** Called on Esc while this modal is topmost (usually closes it). */
  onEscape(): void;
  /** Element to focus on close (defaults to the element focused at open time). */
  returnFocus?: HTMLElement | null;
  /** Element to focus on open (defaults to the first focusable descendant). */
  initialFocus?: HTMLElement | null;
}

export interface ModalHandle {
  close(opts?: { restoreFocus?: boolean }): void;
}

export interface ModalManager {
  open(el: HTMLElement, opts: ModalOptions): ModalHandle;
  topmost(): HTMLElement | null;
  /** Close the topmost modal (Esc semantics). Returns false when none is open. */
  escape(): boolean;
  destroy(): void;
}

interface ModalEntry {
  el: HTMLElement;
  opts: ModalOptions;
  returnFocus: HTMLElement | null;
}

/**
 * Real modals (§4.14.4, must-fix 23): background regions get `inert`, Tab cycles inside,
 * Esc closes the topmost layer, and focus returns to the opener.
 *
 * @param background the page regions to make inert (main, app bar, footer).
 */
export function createModalManager(background: () => Element[]): ModalManager {
  const stack: ModalEntry[] = [];

  const applyInert = () => {
    const top = stack[stack.length - 1]?.el ?? null;
    const others = [...background(), ...stack.slice(0, -1).map((m) => m.el)];
    for (const el of others) {
      if (top && !el.contains(top)) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      top.opts.onEscape();
    } else if (ev.key === "Tab") {
      const items = focusables(top.el);
      if (!items.length) {
        ev.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (ev.shiftKey && (active === first || !top.el.contains(active))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (active === last || !top.el.contains(active))) {
        ev.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", onKey, true);

  const remove = (entry: ModalEntry, restoreFocus: boolean) => {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    entry.el.removeAttribute("inert");
    applyInert();
    if (!stack.length) for (const el of background()) el.removeAttribute("inert");
    const target = entry.returnFocus;
    if (restoreFocus && target && target.isConnected) target.focus({ preventScroll: true });
  };

  return {
    open(el, opts) {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const entry: ModalEntry = { el, opts, returnFocus: opts.returnFocus ?? active };
      stack.push(entry);
      applyInert();
      const first = opts.initialFocus ?? focusables(el)[0] ?? el;
      if (first === el && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      first.focus({ preventScroll: true });
      return { close: (o) => remove(entry, o?.restoreFocus ?? true) };
    },
    topmost: () => stack[stack.length - 1]?.el ?? null,
    escape() {
      const top = stack[stack.length - 1];
      if (!top) return false;
      top.opts.onEscape();
      return true;
    },
    destroy() {
      document.removeEventListener("keydown", onKey, true);
      while (stack.length) remove(stack[stack.length - 1], false);
    },
  };
}

export interface RovingOptions {
  container: HTMLElement;
  items(): HTMLElement[];
  orientation?: "vertical" | "horizontal" | "both";
  /** Also accept j/k for vertical movement. */
  vimKeys?: boolean;
  loop?: boolean;
  /** Called after the active item changed (and was focused). */
  onMove?(el: HTMLElement, index: number): void;
  /** Called on Enter (and Space unless `spaceActivates` is false). */
  onActivate?(el: HTMLElement, index: number, ev: KeyboardEvent): void;
  spaceActivates?: boolean;
}

export interface Roving {
  setActive(index: number, focus?: boolean): void;
  active(): number;
  /** Re-apply tabindex after the item set changed. */
  sync(): void;
  destroy(): void;
}

/** One Tab stop for a composite widget; arrows/Home/End move a roving tabindex. */
export function rovingFocus(opts: RovingOptions): Roving {
  const orientation = opts.orientation ?? "vertical";
  let index = 0;

  const sync = () => {
    const items = opts.items();
    if (index >= items.length) index = Math.max(0, items.length - 1);
    items.forEach((el, i) => el.setAttribute("tabindex", i === index ? "0" : "-1"));
  };

  const setActive = (i: number, focus = true) => {
    const items = opts.items();
    if (!items.length) return;
    index = Math.max(0, Math.min(items.length - 1, i));
    sync();
    if (focus) {
      ensureVisibleThenFocus(items[index]);
      opts.onMove?.(items[index], index);
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    if (isTypingTarget(ev.target) || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const items = opts.items();
    const from = items.indexOf(ev.target as HTMLElement);
    if (from < 0) return;
    index = from;
    const vertical = orientation !== "horizontal";
    const horizontal = orientation !== "vertical";
    let next: number | null = null;
    const k = ev.key;
    if ((vertical && k === "ArrowDown") || (horizontal && k === "ArrowRight") || (opts.vimKeys && k === "j")) next = from + 1;
    else if ((vertical && k === "ArrowUp") || (horizontal && k === "ArrowLeft") || (opts.vimKeys && k === "k")) next = from - 1;
    else if (k === "Home") next = 0;
    else if (k === "End") next = items.length - 1;
    else if (k === "Enter" || (k === " " && opts.spaceActivates !== false)) {
      if (opts.onActivate) {
        ev.preventDefault();
        opts.onActivate(items[from], from, ev);
      }
      return;
    }
    if (next === null) return;
    ev.preventDefault();
    if (opts.loop) next = (next + items.length) % items.length;
    setActive(next);
  };

  opts.container.addEventListener("keydown", onKey);
  const onFocusIn = (ev: FocusEvent) => {
    const i = opts.items().indexOf(ev.target as HTMLElement);
    if (i >= 0 && i !== index) {
      index = i;
      sync();
    }
  };
  opts.container.addEventListener("focusin", onFocusIn);
  sync();

  return {
    setActive,
    active: () => index,
    sync,
    destroy() {
      opts.container.removeEventListener("keydown", onKey);
      opts.container.removeEventListener("focusin", onFocusIn);
    },
  };
}

/** Sticky chrome height above the content (app bar + any section-local sticky bars). */
export function stickyTopInset(extra = 0): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--appbar-h"));
  return (Number.isFinite(v) ? v : 52) + extra;
}

/**
 * Focus never lands on an off-screen element: scroll it into view first (instant), then
 * focus without a second scroll.
 */
export function ensureVisibleThenFocus(
  el: HTMLElement,
  opts: { block?: ScrollLogicalPosition; topInset?: number } = {},
): void {
  const r = el.getBoundingClientRect();
  const top = opts.topInset ?? stickyTopInset();
  if (r.top < top || r.bottom > window.innerHeight) {
    el.scrollIntoView({ block: opts.block ?? "nearest", inline: "nearest" });
    const after = el.getBoundingClientRect();
    if (after.top < top) window.scrollBy(0, after.top - top - 8);
  }
  el.focus({ preventScroll: true });
}
