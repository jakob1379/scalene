// A minimal DOM + canvas stand-in for chart unit tests in Node: just enough
// of Element/Document for the DOM renderers (meters, axes, sparklines) and a
// recording 2D context for the canvas drawers.

export class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this.attributes = new Map();
    this.style = {};
    this.textContent = "";
    this._children = [];
    this.parent = null;
  }
  get children() {
    return this._children;
  }
  get lastElementChild() {
    return this._children[this._children.length - 1] ?? null;
  }
  get classList() {
    return { contains: (c) => this.className.split(/\s+/).includes(c) };
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  appendChild(c) {
    c.remove();
    c.parent = this;
    this._children.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c);
  }
  replaceChildren(...cs) {
    for (const c of this._children) c.parent = null;
    this._children = [];
    this.append(...cs);
  }
  remove() {
    if (!this.parent) return;
    const sib = this.parent._children;
    sib.splice(sib.indexOf(this), 1);
    this.parent = null;
  }
}

export class FakeDocument {
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  createElementNS(_ns, tag) {
    return new FakeElement(this, tag);
  }
}

/** Install `HTMLElement` for `instanceof` checks; returns a document. */
export function installDom() {
  globalThis.HTMLElement = FakeElement;
  return new FakeDocument();
}

/** A 2D context that records calls and property writes. */
export function recordingContext() {
  const calls = [];
  const state = { font: "10px sans-serif" };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === "calls") return calls;
      if (prop === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (prop in target) return target[prop];
      return (...args) => {
        calls.push([prop, ...args]);
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      calls.push([`=${String(prop)}`, value]);
      return true;
    },
  });
  return ctx;
}

/** Fake ThemeApi with the light tokens the drawers read. */
export function fakeTheme(mode = "light") {
  const tokens = {
    "mem-py": "#007137",
    "line-strong": "#CDD2DA",
    surface: "#FFFFFF",
    glass: "rgb(255 255 255 / 0.88)",
    "glass-line": "rgb(14 17 22 / 0.08)",
    fg: "#0E1116",
    "fg-2": "#454D5C",
    "font-ui": "system-ui",
  };
  return {
    current: () => mode,
    set: () => {},
    tokens: () => tokens,
    num: (n) => (n === "glow" ? (mode === "dark" ? 1 : 0) : 0),
  };
}
