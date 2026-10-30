// Source text helpers for the code view (DESIGN.md §3.5, §4.0.5, §4.8.10): highlighted
// spans as DOM (text nodes for plain runs, one element per classified token, never
// innerHTML), tab expansion for deterministic wrapping, and wrapped-row math.
import type { Span } from "../../model/syntax";

/** Plain runs become text nodes; classified tokens become `<span class="t-…">`. */
export function renderSpans(spans: readonly Span[]): Node[] {
  const out: Node[] = [];
  for (const s of spans) {
    if (!s.cls) out.push(document.createTextNode(s.text));
    else {
      const el = document.createElement("span");
      el.className = s.cls;
      el.textContent = s.text;
      out.push(el);
    }
  }
  return out;
}

/** Expand tabs to spaces at 4-column stops (identical rendering, deterministic widths). */
export function expandTabs(s: string, tab = 4): string {
  if (s.indexOf("\t") < 0) return s;
  let out = "";
  let col = 0;
  for (const ch of s) {
    if (ch === "\t") {
      const n = tab - (col % tab);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/** Display columns of a line (after tab expansion; astral characters count once). */
export function textColumns(s: string): number {
  return Array.from(expandTabs(s)).length;
}

/** Columns of leading whitespace (after tab expansion). */
export function leadingColumns(s: string): number {
  const e = expandTabs(s);
  let n = 0;
  while (n < e.length && e[n] === " ") n++;
  return n;
}

/**
 * Hanging indent for wrapped continuation lines: the line's indent + 2, capped at half the
 * line width so deep indents still leave room for text.
 */
export function hangFor(indent: number, colsPerLine: number): number {
  return Math.max(0, Math.min(indent + 2, Math.floor(colsPerLine / 2)));
}

/** Display columns of one code point: East Asian wide / fullwidth and emoji take 2. */
export function charCols(cp: number): number {
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Break after these characters (besides spaces): argument lists and brackets. */
const BREAK_AFTER = new Set([",", ";", "(", "[", "{"]);

/**
 * Word-aware wrap points for one code line (§4.8.10, deterministic): the code-point
 * indices where a new visual line starts. The first visual line holds `colsPerLine`
 * columns, continuation lines `colsPerLine − hang` (they hang under the indent). A line
 * breaks at the last opportunity that fits: after a run of spaces or after `, ; ( [ {`
 * (preferred while the line is at least half full), else before a `.` that follows a name
 * (so `cfg.warmup_steps` stays whole when it can); never inside the leading indent, never a
 * line less than a third full (then it breaks inside the token, like `overflow-wrap:
 * anywhere`). The view inserts the breaks itself and renders with `white-space: pre`, so
 * the row height is exactly `rowH × (breaks + 1)` whatever the browser's line breaker does.
 */
export function wrapBreaks(text: string, colsPerLine: number, hang: number): number[] {
  const cps = Array.from(text);
  const n = cps.length;
  const out: number[] = [];
  if (!(colsPerLine > 0) || n === 0) return out;
  const wid = (i: number) => charCols(cps[i].codePointAt(0) ?? 32);
  let end = n;
  while (end > 0 && cps[end - 1] === " ") end--;
  const contCap = Math.max(1, colsPerLine - hang);
  /** The rest of the line from `k` fits on one continuation line. */
  const restFits = (k: number): boolean => {
    let w = 0;
    for (let j = k; j < end; j++) {
      w += wid(j);
      if (w > contCap) return false;
    }
    return true;
  };
  let start = 0;
  let first = true;
  // Guard against pathological inputs: at most one break per code point.
  for (let guard = 0; guard <= n; guard++) {
    const cap = first ? colsPerLine : Math.max(1, colsPerLine - hang);
    let w = 0;
    let i = start;
    let lastSoft = -1; // after spaces, commas, brackets
    let lastDot = -1; // before ".attr"
    let seenText = false;
    while (i < n && w + wid(i) <= cap) {
      w += wid(i);
      if (cps[i] !== " ") seenText = true;
      i++;
      if (i < n && seenText && i > start) {
        const prev = cps[i - 1];
        const cur = cps[i];
        if ((prev === " " && cur !== " ") || (BREAK_AFTER.has(prev) && cur !== " ")) lastSoft = i;
        else if (cur === "." && /[\w)\]]/.test(prev)) lastDot = i;
      }
    }
    // Prefer the break that finishes the line in one more row; otherwise keep dotted names
    // whole (a soft break that fills half the line wins over a dot break).
    const softOk = lastSoft - start >= Math.ceil(cap / 2);
    let lastOpp: number;
    if (softOk && restFits(lastSoft)) lastOpp = lastSoft;
    else if (lastDot > start && restFits(lastDot)) lastOpp = lastDot;
    else if (lastSoft > start && (restFits(lastSoft) || lastSoft - start >= Math.ceil(cap / 3))) lastOpp = lastSoft;
    else lastOpp = Math.max(lastSoft, lastDot);
    if (i >= n) break;
    let brk: number;
    if (cps[i] === " ") {
      // Spaces at the edge hang into the margin: break after the whole run.
      let j = i;
      while (j < n && cps[j] === " ") j++;
      if (j >= n) break;
      brk = j;
    } else if (lastOpp > start && (lastOpp - start >= Math.ceil(cap / 3) || restFits(lastOpp))) brk = lastOpp;
    else brk = i > start ? i : start + 1;
    out.push(brk);
    start = brk;
    first = false;
  }
  return out;
}

/** Visual lines of a word-wrapped code line (see `wrapBreaks`). */
export function wrappedRows(text: string, colsPerLine: number, hang: number): number {
  return wrapBreaks(text, colsPerLine, hang).length + 1;
}

/**
 * Insert the wrap points into highlighted spans (code-point indices into the joined text):
 * each break becomes a `"\n"` in its own `.cv-wbr` span (not selectable, so copying a
 * wrapped line yields the original text). Returns DOM nodes like `renderSpans`.
 */
export function renderWrappedSpans(spans: readonly Span[], breaks: readonly number[]): Node[] {
  if (!breaks.length) return renderSpans(spans);
  const out: Node[] = [];
  let bi = 0;
  let pos = 0;
  const push = (cls: string | null | undefined, text: string) => {
    if (!text) return;
    if (!cls) out.push(document.createTextNode(text));
    else {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = text;
      out.push(el);
    }
  };
  const brk = () => {
    const el = document.createElement("span");
    el.className = "cv-wbr";
    el.setAttribute("aria-hidden", "true");
    el.textContent = "\n";
    out.push(el);
  };
  for (const s of spans) {
    const cps = Array.from(s.text);
    let from = 0;
    while (bi < breaks.length && breaks[bi] < pos + cps.length) {
      const at = breaks[bi] - pos;
      if (at > from) push(s.cls, cps.slice(from, at).join(""));
      brk();
      from = Math.max(from, at);
      bi++;
    }
    push(s.cls, cps.slice(from).join(""));
    pos += cps.length;
  }
  return out;
}

/** Expand tabs inside highlighted spans, keeping the running column across spans. */
export function expandSpans(spans: readonly Span[], tab = 4): Span[] {
  let any = false;
  for (const s of spans) if (s.text.indexOf("\t") >= 0) any = true;
  if (!any) return spans as Span[];
  let col = 0;
  return spans.map((s) => {
    let out = "";
    for (const ch of s.text) {
      if (ch === "\t") {
        const n = tab - (col % tab);
        out += " ".repeat(n);
        col += n;
      } else {
        out += ch;
        col += 1;
      }
    }
    return { cls: s.cls, text: out };
  });
}
