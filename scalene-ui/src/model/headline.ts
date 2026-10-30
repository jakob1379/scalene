/**
 * The answer-first headline (DESIGN.md §4.2): one generated sentence with at
 * most two code chips, plus the meta line. Output is a segment list so the
 * view can render numbers, chips and refs without parsing strings.
 */

import { fmtDate, fmtLoc, fmtMem, fmtPct, fmtTime, NBSP } from "../core/format";
import type { Target } from "../core/store";
import type { FileM, FunctionM, LineM, Model } from "./model";

export type HeadSeg =
  | { t: "text"; s: string }
  | { t: "num"; s: string }
  /** `full` = the untruncated source (tooltip and aria-label). */
  | { t: "code"; s: string; target: Target; full: string }
  | { t: "ref"; s: string; target: Target };

export interface HeadlineModel {
  segments: HeadSeg[];
  plain: string;
}

// ── shortCode (§4.2.3) ──────────────────────────────────────────────────────

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

/** Brackets balance outside string literals (continuation lines do not). */
export function bracketsBalanced(s: string): boolean {
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const close = s.indexOf(ch, i + 1);
      if (close < 0) return false;
      i = close;
    } else if (ch === "#") break;
    else if (PAIRS[ch]) stack.push(PAIRS[ch]);
    else if (CLOSERS.has(ch) && stack.pop() !== ch) return false;
  }
  return stack.length === 0;
}

/** Index of the top-level assignment `=` (not `==`, `<=`, `>=`, `!=`), or −1. */
function assignmentIndex(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const close = s.indexOf(ch, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (ch === "#") return -1;
    else if (PAIRS[ch]) depth++;
    else if (CLOSERS.has(ch)) depth--;
    else if (ch === "=" && depth === 0) {
      const prev = s[i - 1] ?? "";
      if (s[i + 1] === "=" || prev === "=" || prev === "<" || prev === ">" || prev === "!") {
        if (s[i + 1] === "=") i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

const COMPOUND_RE = /^(?:async\s+)?(?:for|while|if|elif|else|with|def|class|try|except|finally|match|case)\b/;
const CALL_RE = /^((?:await|return|yield)\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/;
const AUG_OPS = ["//", "**", ">>", "<<", "+", "-", "*", "/", "%", "&", "|", "^", "@"];

/** Index just past the bracket group opening at `i` (strings skipped), or −1. */
function groupEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'") {
      const close = s.indexOf(ch, j + 1);
      if (close < 0) return -1;
      j = close;
    } else if (PAIRS[ch]) depth++;
    else if (CLOSERS.has(ch) && --depth === 0) return j + 1;
  }
  return -1;
}

const ATTR_RE = /^\.\s*([A-Za-z_]\w*)/;

/**
 * Chip for an expression that is a pure call: `a.b.c(args)` → `a.b.c(…)`
 * (subscripts after it are dropped), a method chain → `a.f(…).g(…)`, else the
 * last call `….g(…)`. Keeps `await`/`return`/`yield`; empty args stay `()`.
 * Null when the expression is not a call (e.g. `f(x) * 2`) or nothing fits.
 * An unbalanced continuation (`tokenizer(`) counts as a call.
 */
function callForm(expr: string, max: number): string | null {
  const m = CALL_RE.exec(expr);
  if (!m) return null;
  const prefix = m[1] ? `${m[1].trim()} ` : "";
  const argsOf = (open: number, close: number): string => (expr.slice(open + 1, close - 1).trim() ? "(…)" : "()");
  const open = m[0].length - 1;
  const close = groupEnd(expr, open);
  const parts = [`${m[2]}${close < 0 ? "(…)" : argsOf(open, close)}`];
  let i = close;
  while (i >= 0 && i < expr.length) {
    const rest = expr.slice(i);
    const ws = rest.length - rest.trimStart().length;
    if (ws === rest.length) break;
    const j = i + ws;
    const ch = expr[j];
    if (ch === "[") {
      i = groupEnd(expr, j);
      continue;
    }
    const attr = ATTR_RE.exec(expr.slice(j));
    if (!attr) return null; // an operator follows: not a pure call
    let k = j + attr[0].length;
    const k2 = k + (expr.slice(k).length - expr.slice(k).trimStart().length);
    let piece = `.${attr[1]}`;
    if (expr[k2] === "(") {
      const e = groupEnd(expr, k2);
      piece += e < 0 ? "(…)" : argsOf(k2, e);
      k = e;
    }
    parts.push(piece);
    i = k;
  }
  const whole = prefix + parts.join("");
  if (whole.length <= max) return whole;
  const last = parts[parts.length - 1];
  const dot = parts.length > 1 ? last.lastIndexOf(".") : m[2].lastIndexOf(".");
  if (dot < 0) return null;
  const tail = parts.length > 1 ? `${prefix}…${last}` : `${prefix}….${last.slice(dot + 1)}`;
  return tail.length <= max ? tail : null;
}

/** Keep whole whitespace tokens while they fit in `max − 2`, then " …". */
function headerForm(s: string, max: number): string | null {
  const tokens = s.split(/\s+/);
  let out = "";
  for (const tok of tokens) {
    const next = out ? `${out} ${tok}` : tok;
    if (next.length > max - 2) break;
    out = next;
  }
  if (!out) return null;
  return out.length === s.length ? out : `${out} …`;
}

/**
 * Token-safe chip text (§4.2.3), or null when no chip fits (use a ref).
 * An ellipsis is only ever placed between tokens. Lines with unbalanced
 * brackets (continuations such as `enc = tokenizer(`) are always shortened.
 */
export function shortCode(text: string, max = 32): string | null {
  const s = text.trim();
  if (!s) return null;
  if (s.length <= max && bracketsBalanced(s)) return s;
  if (COMPOUND_RE.test(s)) return headerForm(s, max);
  const eq = assignmentIndex(s);
  if (eq > 0) {
    let target = s.slice(0, eq).trimEnd();
    let op = "=";
    for (const a of AUG_OPS) {
      if (target.endsWith(a)) {
        op = `${a}=`;
        target = target.slice(0, -a.length).trimEnd();
        break;
      }
    }
    const colon = target.indexOf(":"); // annotated assignment `x: int = …`
    if (colon > 0 && op === "=") target = target.slice(0, colon).trimEnd();
    const call = callForm(s.slice(eq + 1).trim(), max);
    if (call) return call;
    const short = `${target} ${op} …`;
    return short.length <= max ? short : null;
  }
  return callForm(s, max);
}

// ── Headline generator (§4.2.2) ─────────────────────────────────────────────

const NUMBER_WORDS = ["", "One", "Two", "Three"];

/** Segment list builder (merges adjacent text). */
export class Segs {
  readonly list: HeadSeg[] = [];
  text(s: string): this {
    const last = this.list[this.list.length - 1];
    if (last && last.t === "text") last.s += s;
    else this.list.push({ t: "text", s });
    return this;
  }
  num(s: string): this {
    this.list.push({ t: "num", s });
    return this;
  }
  code(s: string, target: Target, full: string): this {
    this.list.push({ t: "code", s, target, full });
    return this;
  }
  ref(s: string, target: Target): this {
    this.list.push({ t: "ref", s, target });
    return this;
  }
  model(): HeadlineModel {
    return { segments: this.list, plain: this.list.map((x) => x.s).join("") };
  }
}

const lineTarget = (l: LineM): Target => ({ file: l.file.name, line: l.no });
const fnTarget = (f: FunctionM): Target => ({ file: f.file.name, fn: f.name });

/** Chip text for a function: `qualname()`, else `name()` of the last component. */
export function functionChip(name: string, max = 32): string {
  const full = `${name}()`;
  if (full.length <= max) return full;
  return `${name.slice(name.lastIndexOf(".") + 1)}()`;
}

/** Append a line's chip, or "line file:line" when no chip fits (`capital` at sentence start). */
export function lineSubject(b: Segs, l: LineM, capital: boolean, max = 32): boolean {
  const chip = shortCode(l.text, max);
  if (chip) {
    b.code(chip, lineTarget(l), l.text.trim());
    return true;
  }
  b.text(capital ? "Line " : "line ").ref(fmtLoc(l.file.name, l.no), lineTarget(l));
  return false;
}

function memoryClause(b: Segs, m: Model): void {
  if (m.caps.memory && m.memory && m.memory.peak > 0) b.text("; memory peaked at ").num(fmtMem(m.memory.peak)).text(".");
  else b.text(".");
}

function eventLoopBranch(b: Segs, loop: LineM, next: LineM | undefined): void {
  const mostlyWaiting = loop.total > 0 && loop.sys / loop.total >= 0.5;
  b.text(" ").num(fmtPct(loop.total)).text(" of it is the event loop (");
  lineSubject(b, loop, false);
  b.text(`), ${mostlyWaiting ? "mostly waiting" : "running callbacks"}.`);
  if (!next) return;
  const loc = (): void => {
    b.text(`(${fmtPct(next.total)}, `).ref(fmtLoc(next.file.name, next.no), lineTarget(next)).text(")");
  };
  if (next.coro) {
    b.text(" The busiest code, ");
    lineSubject(b, next, false);
    b.text(" ");
    loc();
    b.text(", runs inside a coroutine, so the loop stalls while it runs.");
  } else {
    b.text(" The busiest code is ");
    lineSubject(b, next, false);
    b.text(" ");
    loc();
    b.text(".");
  }
}

function sameFunction(lines: readonly LineM[]): FunctionM | null {
  const fn = lines[0]?.fn ?? null;
  return fn && lines.every((l) => l.fn === fn) ? fn : null;
}

function concentratedBranch(b: Segs, top: readonly LineM[], sum: number): void {
  const k = top.length;
  const fn = k >= 2 ? sameFunction(top) : null;
  if (fn) {
    b.text(` ${NUMBER_WORDS[k]} lines in `).code(functionChip(fn.name), fnTarget(fn), fn.name);
    b.text(" account for ").num(fmtPct(sum)).text(" of the time");
    return;
  }
  if (k === 1) {
    const l = top[0];
    b.text(" ");
    if (lineSubject(b, l, true)) b.text(" (").ref(fmtLoc(l.file.name, l.no), lineTarget(l)).text(")");
    b.text(" takes ").num(fmtPct(sum)).text(" of the time");
    return;
  }
  if (k === 2) {
    const [a, c] = top;
    b.text(" ");
    if (lineSubject(b, a, true)) b.text(" (").ref(fmtLoc(a.file.name, a.no), lineTarget(a)).text(")");
    b.text(" and ");
    const sameFile = a.file === c.file;
    const cRef = sameFile ? `:${c.no}` : fmtLoc(c.file.name, c.no);
    const chip = shortCode(c.text);
    if (chip) b.code(chip, lineTarget(c), c.text.trim()).text(" (").ref(cRef, lineTarget(c)).text(")");
    else b.text("line ").ref(cRef, lineTarget(c));
    b.text(" account for ").num(fmtPct(sum)).text(" of the time");
    return;
  }
  const busiest = top[0];
  b.text(" Three lines account for ").num(fmtPct(sum)).text(" of the time; the busiest is ");
  const chip = shortCode(busiest.text);
  if (chip) {
    b.code(chip, lineTarget(busiest), busiest.text.trim());
    b.text(` (${fmtPct(busiest.total)}, `).ref(fmtLoc(busiest.file.name, busiest.no), lineTarget(busiest)).text(")");
  } else {
    b.text("line ").ref(fmtLoc(busiest.file.name, busiest.no), lineTarget(busiest)).text(` (${fmtPct(busiest.total)})`);
  }
}

function spreadBranch(b: Segs, m: Model): void {
  const fn = m.rank.functions.time[0];
  if (fn) {
    b.text(" Time is spread out: the busiest function, ").code(functionChip(fn.name), fnTarget(fn), fn.name);
    b.text(", takes ").num(fmtPct(fn.total));
    return;
  }
  const file: FileM | undefined = m.rank.files.time[0];
  if (!file) return;
  const hot = file.lines.reduce<LineM | null>((a, l) => (!a || l.total > a.total ? l : a), null);
  const target: Target = { file: file.name, line: hot ? hot.no : 1 };
  b.text(" Time is spread out: the busiest file, ").code(file.base, target, file.name);
  b.text(", takes ").num(fmtPct(file.pct));
}

/** Generate the headline (rules 1–6 of §4.2.2). */
export function buildHeadline(m: Model): HeadlineModel {
  const b = new Segs();
  // §1.3.3: a missing run length is never "0 s"; a derived one is a lower bound.
  if (m.elapsedSource === "absent") b.num(m.base || "This program").text(" ran for an unrecorded time");
  else b.num(m.base || "This program").text(m.elapsedSource === "derived" ? " ran for at least " : " ran for ").num(fmtTime(m.elapsed));
  const R = m.rank.lines.time;
  if (R.length === 0) {
    b.text("; no CPU samples were attributed to profiled files");
    memoryClause(b, m);
    return b.model();
  }
  b.text(".");
  const loop = m.async?.loopLine ?? null;
  if (m.caps.async && loop && loop === R[0]) {
    eventLoopBranch(b, loop, R[1]);
    return b.model();
  }
  let k = 1;
  let sum = R[0].total;
  while (k < 3 && k < R.length && sum < 30) sum += R[k++].total;
  if (sum >= 25) concentratedBranch(b, R.slice(0, k), sum);
  else spreadBranch(b, m);
  memoryClause(b, m);
  return b.model();
}

// ── Meta line (§4.2) ────────────────────────────────────────────────────────

export type MetaKind = "date" | "files" | "threads" | "async" | "accelerator" | "cpu-only" | "sampling" | "version";

export interface MetaItem {
  kind: MetaKind;
  text: string;
  /** "files" only: the hidden-files suffix "(+16 below 1%)" (a button in the view). */
  extra?: string;
}

/** Sampling interval as shown in the meta line: "10 ms sampling". */
export function fmtSampling(dt: number): string {
  const ms = dt * 1000;
  return `${ms >= 2 ? Math.round(ms) : ms.toFixed(1)}${NBSP}ms sampling`;
}

export function buildMeta(m: Model): MetaItem[] {
  const out: MetaItem[] = [];
  if (m.caps.startTime && m.startEpoch !== null) out.push({ kind: "date", text: `Profiled ${fmtDate(m.startEpoch)}` });
  const n = m.files.length;
  out.push({
    kind: "files",
    text: `${n} file${n === 1 ? "" : "s"}`,
    extra: m.hiddenFiles.length > 0 ? `(+${m.hiddenFiles.length} below 1%)` : undefined,
  });
  const threads = m.sampling.threads.length;
  if (threads > 1) out.push({ kind: "threads", text: `${threads} threads` });
  if (m.caps.async) out.push({ kind: "async", text: "async" });
  const raw = m.raw as { gpu?: unknown; gpu_device?: unknown };
  if (raw.gpu === true || m.caps.neuron) {
    const device = typeof raw.gpu_device === "string" ? raw.gpu_device : "";
    out.push({ kind: "accelerator", text: m.caps.neuron || device === "Neuron" ? "AWS Neuron" : device || "GPU" });
  }
  if (!m.caps.memory) out.push({ kind: "cpu-only", text: "CPU only" });
  if (m.caps.timeline) out.push({ kind: "sampling", text: fmtSampling(m.sampling.dt) });
  if (m.version) out.push({ kind: "version", text: `Scalene ${m.version}` });
  return out;
}
