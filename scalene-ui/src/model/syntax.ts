/**
 * Python highlighting for code surfaces (DESIGN.md §4.0.5).
 *
 * `stringLines` is upstream's triple-quote scanner (gui:272): opening, inner
 * and closing lines of a triple-quoted string are marked; a one-line
 * `"""doc"""` is not. `highlight` is a single-pass tokenizer for one line
 * that returns `{cls, text}` spans; views build DOM with `textContent`.
 */

export type SynClass = "t-kw" | "t-def" | "t-bi" | "t-dec" | "t-str" | "t-num" | "t-com" | `t-ctl u${string}`;

export interface Span {
  /** "" for plain text. */
  cls: SynClass | "";
  text: string;
}

/** Upstream `stringLines`: `true` for lines inside (or opening/closing) a triple-quoted string. */
export function stringLines(lines: readonly string[]): boolean[] {
  const marked = new Array<boolean>(lines.length).fill(false);
  let delimiter: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInside = delimiter !== null;
    let from = 0;
    for (;;) {
      const s = line.indexOf("'''", from);
      const d = line.indexOf('"""', from);
      if (s < 0 && d < 0) break;
      const useSingle = s >= 0 && (d < 0 || s < d);
      const at = useSingle ? s : d;
      const found = useSingle ? "'''" : '"""';
      from = at + 3;
      if (delimiter === null) delimiter = found;
      else if (delimiter === found) delimiter = null;
    }
    marked[i] = wasInside || delimiter !== null;
  }
  return marked;
}

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);
const SOFT_KEYWORDS = new Set(["match", "case"]);
const BUILTINS = new Set(
  "print len range enumerate zip map filter sum min max abs any all isinstance hasattr getattr setattr super open iter next sorted reversed int float str bytes list dict set tuple object type self cls".split(
    " ",
  ),
);

const IDENT = /[A-Za-z_À-￿][\wÀ-￿]*/y;
const NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/y;
const DECORATOR = /@[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/y;
const STRING_PREFIX = /[rRbBuUfF]{1,2}(?=["'])/y;

function matchAt(re: RegExp, s: string, i: number): string | null {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0] : null;
}

/** End index (exclusive) of a string literal starting with a quote at `i`. */
function stringEnd(s: string, i: number): number {
  const q = s[i];
  if (s.startsWith(q + q + q, i)) {
    const close = s.indexOf(q + q + q, i + 3);
    return close < 0 ? s.length : close + 3;
  }
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === q) return j + 1;
  }
  return s.length;
}

class SpanBuilder {
  readonly spans: Span[] = [];
  push(cls: Span["cls"], text: string): void {
    if (!text) return;
    const last = this.spans[this.spans.length - 1];
    if (last && last.cls === cls) last.text += text;
    else this.spans.push({ cls, text });
  }
}

const CONTROL_CHARS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const CONTROL_SPLIT = /([\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff])/;

/**
 * Invisible bidi / zero-width controls become their own spans, class `t-ctl u202e`: the code
 * surfaces isolate them (`unicode-bidi: isolate`, so an override cannot reorder the rest of
 * the line — "Trojan Source") and show a visible "U+202E" badge. The span text stays the
 * original character, so copy, wrapping and column math are unchanged.
 */
export function splitControls(spans: Span[]): Span[] {
  if (!spans.some((s) => CONTROL_CHARS.test(s.text))) return spans;
  const out: Span[] = [];
  for (const s of spans) {
    if (!CONTROL_CHARS.test(s.text)) {
      out.push(s);
      continue;
    }
    for (const part of s.text.split(CONTROL_SPLIT)) {
      if (!part) continue;
      if (part.length === 1 && CONTROL_CHARS.test(part)) {
        out.push({ cls: `t-ctl u${(part.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`, text: part });
      } else out.push({ cls: s.cls, text: part });
    }
  }
  return out;
}

/**
 * Tokenize one source line. `inString` is the line's `stringLines` flag:
 * such lines render entirely as `t-com` (docstring style).
 */
export function highlight(line: string, inString = false): Span[] {
  if (inString) return line ? splitControls([{ cls: "t-com", text: line }]) : [];
  const out = new SpanBuilder();
  const n = line.length;
  let i = 0;
  let atLineStart = true; // only whitespace seen so far
  let expectName = false; // previous token was `def` / `class`
  while (i < n) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      let j = i + 1;
      while (j < n && (line[j] === " " || line[j] === "\t")) j++;
      out.push("", line.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "#") {
      out.push("t-com", line.slice(i));
      break;
    }
    const prefix = matchAt(STRING_PREFIX, line, i);
    if (ch === '"' || ch === "'" || prefix) {
      const q = prefix ? i + prefix.length : i;
      const end = stringEnd(line, q);
      out.push("t-str", line.slice(i, end));
      i = end;
      atLineStart = expectName = false;
      continue;
    }
    if (ch === "@" && atLineStart) {
      const dec = matchAt(DECORATOR, line, i);
      if (dec) {
        out.push("t-dec", dec);
        i += dec.length;
        atLineStart = false;
        continue;
      }
    }
    const ident = matchAt(IDENT, line, i);
    if (ident) {
      out.push(identClass(ident, atLineStart, expectName, line, i + ident.length), ident);
      expectName = ident === "def" || ident === "class";
      i += ident.length;
      atLineStart = false;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || (ch === "." && i + 1 < n && line[i + 1] >= "0" && line[i + 1] <= "9")) {
      const numText = matchAt(NUMBER, line, i);
      if (numText) {
        out.push("t-num", numText);
        i += numText.length;
        atLineStart = expectName = false;
        continue;
      }
    }
    out.push("", ch);
    i++;
    atLineStart = expectName = false;
  }
  return splitControls(out.spans);
}

function identClass(id: string, atLineStart: boolean, expectName: boolean, line: string, end: number): Span["cls"] {
  if (expectName) return "t-def";
  if (KEYWORDS.has(id)) return "t-kw";
  // Soft keywords only when they start a statement (`match x:` / `case 1:`).
  if (SOFT_KEYWORDS.has(id) && atLineStart && /^\s+\S/.test(line.slice(end)) && !/^\s*[=.(\[,]/.test(line.slice(end))) {
    return "t-kw";
  }
  if (BUILTINS.has(id)) return "t-bi";
  return "";
}

const memo = new Map<string, Span[]>();
const MEMO_CAP = 6000;

/** Memoised `highlight`, keyed by `file:line` (views render rows lazily). */
export function highlightCached(key: string, line: string, inString: boolean): Span[] {
  const hit = memo.get(key);
  if (hit) return hit;
  if (memo.size >= MEMO_CAP) memo.clear();
  const spans = highlight(line, inString);
  memo.set(key, spans);
  return spans;
}

/** Drop the memo (profile reload). */
export function clearHighlightCache(): void {
  memo.clear();
}
