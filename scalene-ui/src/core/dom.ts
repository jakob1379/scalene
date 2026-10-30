// Tiny DOM toolkit: element builders, listeners with disposers, ids.
// Data text always goes through text nodes (never innerHTML).

export type Child = Node | string | number | null | undefined | false | readonly Child[];

type Handler = (ev: never) => void;
export type Attrs = Record<string, unknown>;

/** Properties that must be assigned rather than set as attributes. */
const PROPS = new Set(["value", "checked", "selected", "indeterminate", "textContent"]);

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (v === undefined || v === null || v === false) continue;
    if (key === "class" || key === "className") {
      el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v));
    } else if (key === "style") {
      applyStyle(el as HTMLElement, v);
    } else if (key === "dataset") {
      const ds = (el as HTMLElement).dataset;
      for (const [k, dv] of Object.entries(v as Record<string, unknown>)) {
        if (dv !== undefined && dv !== null) ds[k] = String(dv);
      }
    } else if (key.length > 2 && key.startsWith("on") && key.charCodeAt(2) < 97) {
      el.addEventListener(key.slice(2).toLowerCase(), v as EventListener);
    } else if (PROPS.has(key)) {
      (el as unknown as Record<string, unknown>)[key] = v;
    } else {
      el.setAttribute(key, v === true ? "" : String(v));
    }
  }
}

function applyStyle(el: HTMLElement, v: unknown): void {
  if (typeof v === "string") {
    el.style.cssText = v;
    return;
  }
  for (const [k, sv] of Object.entries(v as Record<string, unknown>)) {
    if (sv === undefined || sv === null) continue;
    if (k.startsWith("--")) el.style.setProperty(k, String(sv));
    else (el.style as unknown as Record<string, string>)[k] = String(sv);
  }
}

/** Append children (strings become text nodes; arrays are flattened; falsy values skipped). */
export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, ...(c as Child[]));
    else if (typeof c === "string" || typeof c === "number") parent.appendChild(document.createTextNode(String(c)));
    else parent.appendChild(c as Node);
  }
}

/**
 * Create an HTML element. Attribute conventions: `class` (string or array),
 * `style` (string or object, `--custom` props allowed), `dataset`, `onClick`-style
 * listeners, booleans as presence attributes, `value`/`checked` as properties.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, ...children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an SVG element (attributes are set verbatim). */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, ...children);
  return el;
}

/** Remove every child node. */
export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace all children of `el`. */
export function replaceChildren(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, ...children);
}

/** addEventListener that returns its own disposer. */
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (ev: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  handler: (ev: DocumentEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  handler: (ev: Event) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  handler: Handler | ((ev: Event) => void),
  opts?: AddEventListenerOptions | boolean,
): () => void {
  const fn = handler as EventListener;
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Collects disposers so a view can release everything in one call. */
export interface Disposer {
  add(fn: (() => void) | { destroy(): void } | null | undefined): void;
  dispose(): void;
}

export function createDisposer(): Disposer {
  let fns: (() => void)[] = [];
  return {
    add(fn) {
      if (!fn) return;
      fns.push(typeof fn === "function" ? fn : () => fn.destroy());
    },
    dispose() {
      const list = fns;
      fns = [];
      for (let i = list.length - 1; i >= 0; i--) {
        try {
          list[i]();
        } catch (e) {
          setTimeout(() => {
            throw e;
          });
        }
      }
    },
  };
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for the rare place that needs an HTML string. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

let uidCounter = 0;
/** Document-unique id with a readable prefix. */
export function uid(prefix = "s"): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter.toString(36)}`;
}

/** Find an element by id, or create it with `make` (used for singletons like #layer-root). */
export function ensureById<T extends HTMLElement>(id: string, make: () => T): T {
  const found = document.getElementById(id);
  if (found) return found as T;
  const el = make();
  el.id = id;
  return el;
}

/** True when the event target is a text-entry control (shortcut keys must not fire there). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (t as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(type);
}

/** Visually hidden but available to assistive technology. */
export const VISUALLY_HIDDEN = "visually-hidden";
