// One global tooltip (DESIGN.md §4.19). Charts call show/move/hide with pointer
// coordinates (instant); DOM controls use bind() (300 ms hover intent, instant on
// keyboard focus). Tooltips are never the only path to their information.
import { append, clear, h, uid } from "./dom";

export interface TooltipContent {
  title?: string;
  kind?: string;
  rows?: [string, string][];
  code?: string;
  hint?: string;
  /** The title is code (a frame or function name): mono, ligatures off, wraps (§3.5, §4.11.6). */
  mono?: boolean;
}

export interface Tooltip {
  show(at: { x: number; y: number } | Element, c: TooltipContent, opts?: { delay?: number; describe?: Element }): void;
  move(x: number, y: number): void;
  hide(): void;
}

export interface TooltipController extends Tooltip {
  /** Same as `bindTooltip(this, el, content)`. */
  bind(el: HTMLElement, content: TooltipBinding): () => void;
  destroy(): void;
}

/** Static content, or a function computing it on demand (null = nothing to show). */
export type TooltipBinding = TooltipContent | (() => TooltipContent | null);

const OFFSET = 12;
const MARGIN = 8;
const HOVER_INTENT_MS = 300;
const OUT_MS = 90;

type Anchor = { x: number; y: number } | Element;

function render(el: HTMLElement, c: TooltipContent): void {
  clear(el);
  if (c.kind) append(el, h("span", { class: "tt-kind" }, c.kind));
  if (c.title) append(el, h("div", { class: c.mono ? "tt-title code" : "tt-title" }, c.title));
  if (c.rows?.length) {
    append(
      el,
      h(
        "div",
        { class: "tt-rows" },
        c.rows.map(([label, value]) => [h("span", { class: "tt-label" }, label), h("span", { class: "tt-value" }, value)]),
      ),
    );
  }
  if (c.code) append(el, h("pre", { class: "tt-code code" }, c.code));
  if (c.hint) append(el, h("div", { class: "tt-hint" }, c.hint));
}

/** Position `box` next to the anchor, flipping on all four sides to stay in the viewport. */
function place(box: HTMLElement, at: Anchor): void {
  const w = box.offsetWidth;
  const ht = box.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let x: number;
  let y: number;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.left + r.width / 2 - w / 2;
    y = r.bottom + OFFSET;
    if (y + ht > vh - MARGIN) y = r.top - OFFSET - ht;
    if (y < MARGIN) {
      // Neither below nor above fits: go beside the target.
      y = Math.max(MARGIN, Math.min(vh - ht - MARGIN, r.top + r.height / 2 - ht / 2));
      x = r.right + OFFSET;
      if (x + w > vw - MARGIN) x = r.left - OFFSET - w;
    }
  } else {
    x = at.x + OFFSET;
    y = at.y + OFFSET;
    if (x + w > vw - MARGIN) x = at.x - OFFSET - w;
    if (y + ht > vh - MARGIN) y = at.y - OFFSET - ht;
  }
  x = Math.max(MARGIN, Math.min(vw - w - MARGIN, x));
  y = Math.max(MARGIN, Math.min(vh - ht - MARGIN, y));
  box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function createTooltip(root: HTMLElement): TooltipController {
  const box = h("div", { class: "tooltip", role: "tooltip", id: uid("tooltip"), hidden: true });
  root.appendChild(box);
  let showTimer = 0;
  let hideTimer = 0;
  let described: Element | null = null;
  let anchor: Anchor | null = null;

  const undescribe = () => {
    if (!described) return;
    const ids = (described.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== box.id);
    if (ids.length) described.setAttribute("aria-describedby", ids.join(" "));
    else described.removeAttribute("aria-describedby");
    described = null;
  };

  const reveal = (at: Anchor, c: TooltipContent, describe?: Element) => {
    window.clearTimeout(hideTimer);
    render(box, c);
    box.hidden = false;
    anchor = at;
    place(box, at);
    box.classList.add("is-visible");
    undescribe();
    if (describe) {
      const ids = (describe.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      if (!ids.includes(box.id)) describe.setAttribute("aria-describedby", [...ids, box.id].join(" "));
      described = describe;
    }
  };

  const api: TooltipController = {
    show(at, c, opts = {}) {
      window.clearTimeout(showTimer);
      const delay = opts.delay ?? 0;
      if (delay > 0 && !box.classList.contains("is-visible")) {
        showTimer = window.setTimeout(() => reveal(at, c, opts.describe), delay);
      } else {
        reveal(at, c, opts.describe);
      }
    },
    move(x, y) {
      if (box.hidden) return;
      anchor = { x, y };
      place(box, anchor);
    },
    hide() {
      window.clearTimeout(showTimer);
      if (box.hidden) return;
      box.classList.remove("is-visible");
      undescribe();
      anchor = null;
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (!box.classList.contains("is-visible")) box.hidden = true;
      }, OUT_MS);
    },
    bind: (el, content) => bindTooltip(api, el, content),
    destroy() {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      undescribe();
      box.remove();
    },
  };
  return api;
}

/**
 * Attach a DOM-control tooltip to `el` through the public `Tooltip` API (§4.19): it opens
 * after a 300 ms hover intent, immediately on keyboard focus, and closes on leave, blur,
 * press or Esc. Returns a disposer. Views use this with `ctx.tooltip`.
 */
export function bindTooltip(t: Tooltip, el: HTMLElement, content: TooltipBinding): () => void {
  let active = false;
  const open = (delay: number) => {
    const c = typeof content === "function" ? content() : content;
    if (!c) return;
    active = true;
    t.show(el, c, { delay, describe: el });
  };
  const close = () => {
    if (!active) return;
    active = false;
    t.hide();
  };
  const onEnter = () => open(HOVER_INTENT_MS);
  const onFocus = () => {
    if (el.matches(":focus-visible")) open(0);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") close();
  };
  const events: [string, EventListener][] = [
    ["pointerenter", onEnter],
    ["pointerleave", close],
    ["focus", onFocus],
    ["blur", close],
    ["keydown", onKey as EventListener],
    ["pointerdown", close],
  ];
  for (const [type, fn] of events) el.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of events) el.removeEventListener(type, fn);
    close();
  };
}
