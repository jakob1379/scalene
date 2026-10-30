/**
 * Palette search index (DESIGN.md §4.20): substring search over every
 * source line (hot lines first), subsequence ("fuzzy") search over function
 * qualnames and file paths. Built lazily in slices on first open.
 */

import type { FileM, FunctionM, LineM, Model } from "./model";

export const MAX_LINE_RESULTS = 50;
export const MAX_GROUP_RESULTS = 8;

export interface LineHit {
  line: LineM;
  /** Match range in `line.text` (characters). */
  start: number;
  end: number;
  /** Match quality (see `Strength`): a substring is ≥ 2, 3 at a word start. */
  strength: Strength;
}

/**
 * Match quality, comparable across groups (§4.20 group order): 3 = prefix or a contiguous
 * match at a word start, 2 = contiguous substring, 1 = scattered subsequence.
 */
export type Strength = 1 | 2 | 3;

export interface FuzzyHit<T> {
  item: T;
  score: number;
  /** Matched character positions in the searched string. */
  positions: number[];
  strength: Strength;
}

export interface SearchResults {
  lines: LineHit[];
  functions: FuzzyHit<FunctionM>[];
  files: FuzzyHit<FileM>[];
}

export interface SearchIndex {
  /** Number of indexed lines. */
  size: number;
  query(q: string, limits?: { lines?: number; functions?: number; files?: number }): SearchResults;
}

/**
 * Subsequence match of `q` (lower case) in `s`. Score rewards contiguous
 * runs, word starts and early matches; null when `q` is not a subsequence.
 */
export function fuzzyMatch(q: string, s: string): { score: number; positions: number[] } | null {
  if (!q) return { score: 0, positions: [] };
  const lower = s.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = lower.indexOf(ch, from);
    if (i < 0) return null;
    const boundary = i === 0 || /[^A-Za-z0-9]/.test(s[i - 1]) || (s[i] >= "A" && s[i] <= "Z" && s[i - 1] >= "a" && s[i - 1] <= "z");
    score += 1 + (i === prev + 1 ? 3 : 0) + (boundary ? 2 : 0);
    positions.push(i);
    prev = i;
    from = i + 1;
  }
  score -= positions[0] * 0.05 + (s.length - q.length) * 0.01;
  return { score, positions };
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

/** Strength of a fuzzy match given its positions in `s`. */
export function strengthOf(s: string, positions: readonly number[]): Strength {
  if (!positions.length) return 1;
  for (let i = 1; i < positions.length; i++) if (positions[i] !== positions[i - 1] + 1) return 1;
  const at = positions[0];
  return at === 0 || !isWordChar(s[at - 1]) || (s[at] >= "A" && s[at] <= "Z" && s[at - 1] >= "a" && s[at - 1] <= "z") ? 3 : 2;
}

/**
 * Best match of `q` in `s`: a contiguous occurrence (preferring a word start) when there is
 * one — `fuzzyMatch` is greedy and may pick a scattered path through an exact substring —
 * else the subsequence. Null when `q` is not a subsequence of `s`.
 */
export function bestMatch(q: string, s: string): { score: number; positions: number[]; strength: Strength } | null {
  const lower = s.toLowerCase();
  let at = -1;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + 1)) {
    if (at < 0) at = i;
    if (i === 0 || !isWordChar(s[i - 1])) {
      at = i;
      break;
    }
  }
  if (at >= 0) {
    const positions = Array.from(q, (_, k) => at + k);
    const strength = strengthOf(s, positions);
    // Same scale as fuzzyMatch: 1 + 3 (contiguous) per char, +2 at the start boundary.
    const score = q.length * 4 - 3 + (strength === 3 ? 2 : 0) - at * 0.05 - (s.length - q.length) * 0.01;
    return { score, positions, strength };
  }
  const f = fuzzyMatch(q, s);
  return f ? { ...f, strength: strengthOf(s, f.positions) } : null;
}

/**
 * Minimum score of a scattered (strength 1) match: about 1.5 per query character, so a
 * subsequence strewn over a long name ("loss" through ".venv/lib/…/adamw.py") is dropped.
 */
export function minFuzzyScore(q: string): number {
  return q.length <= 2 ? 0 : q.length * 1.5;
}

function* indexLines(m: Model): Generator<unknown, { order: LineM[]; lower: string[] }, void> {
  const all = m.files.concat(m.hiddenFiles);
  const hot = m.rank.lines.time;
  const seen = new Set<LineM>(hot);
  const order: LineM[] = hot.slice();
  for (const f of all) {
    for (const l of f.lines) if (!seen.has(l) && l.text.trim()) order.push(l);
    yield;
  }
  const lower = new Array<string>(order.length);
  for (let i = 0; i < order.length; i++) {
    lower[i] = order[i].text.toLowerCase();
    if ((i & 2047) === 2047) yield;
  }
  return { order, lower };
}

function topFuzzy<T>(items: readonly T[], key: (x: T) => string, q: string, n: number, weight: (x: T) => number): FuzzyHit<T>[] {
  const hits: FuzzyHit<T>[] = [];
  const min = minFuzzyScore(q);
  for (const item of items) {
    const r = bestMatch(q, key(item));
    if (r && (r.strength > 1 || r.score >= min)) hits.push({ item, score: r.score + weight(item), positions: r.positions, strength: r.strength });
  }
  return hits.sort((a, b) => b.strength - a.strength || b.score - a.score).slice(0, n);
}

/**
 * Files match on the base name (fuzzy) or on a whole directory segment (contiguous only,
 * ranked below base-name hits): "train" → train.py, "optim" → torch/optim/adamw.py, but
 * never a subsequence scattered across the full path.
 */
function topFiles(files: readonly FileM[], q: string, n: number): FuzzyHit<FileM>[] {
  const hits: FuzzyHit<FileM>[] = [];
  const min = minFuzzyScore(q);
  for (const f of files) {
    const weight = f.pct / 50;
    const r = bestMatch(q, f.base);
    if (r && (r.strength > 1 || r.score >= min)) {
      hits.push({ item: f, score: r.score + weight, positions: r.positions, strength: r.strength });
      continue;
    }
    const dir = f.name.slice(0, f.name.length - f.base.length);
    let seg: FuzzyHit<FileM> | null = null;
    for (const part of dir.split(/[\\/]+/)) {
      const at = part.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const strength: Strength = at === 0 ? 3 : 2;
      const score = q.length * 4 - 5 - (part.length - q.length) * 0.05 + weight;
      if (!seg || score > seg.score) seg = { item: f, score, positions: [], strength: Math.min(strength, 2) as Strength };
    }
    if (seg) hits.push(seg);
  }
  return hits.sort((a, b) => b.strength - a.strength || b.score - a.score).slice(0, n);
}

export function* buildSearchIndex(m: Model): Generator<unknown, SearchIndex, void> {
  const { order, lower } = yield* indexLines(m);
  const functions = m.files.concat(m.hiddenFiles).flatMap((f) => f.functions);
  const files = m.files.concat(m.hiddenFiles);
  return {
    size: order.length,
    query(q, limits = {}) {
      const needle = q.trim().toLowerCase();
      if (!needle) return { lines: [], functions: [], files: [] };
      const maxLines = limits.lines ?? MAX_LINE_RESULTS;
      const lines: LineHit[] = [];
      for (let i = 0; i < order.length && lines.length < maxLines; i++) {
        const at = lower[i].indexOf(needle);
        if (at >= 0) {
          const text = order[i].text;
          lines.push({ line: order[i], start: at, end: at + needle.length, strength: at === 0 || !isWordChar(text[at - 1]) ? 3 : 2 });
        }
      }
      // Small boost for heavier items so ties resolve toward what matters.
      return {
        lines,
        functions: topFuzzy(functions, (f) => f.name, needle, limits.functions ?? MAX_GROUP_RESULTS, (f) => f.total / 50),
        files: topFiles(files, needle, limits.files ?? MAX_GROUP_RESULTS),
      };
    },
  };
}
