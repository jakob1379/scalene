/**
 * Call-stack derivations (DESIGN.md §4.0.7, §4.9, §4.11): the flame tree for
 * CPU (`combined_stacks`, weight = hits) and memory (`memory_stacks`,
 * weight = MiB), and the call context of a source line. Both are built
 * lazily from generators so they can run in time slices.
 */

import { basename, fmtCount, fmtPct } from "../core/format";
import { isAwaitFrame } from "./classify";
import type { CombinedFrame, CombinedStackEntry, MemoryStackEntry } from "../types";

export type FlameNodeKind = "root" | "py" | "native" | "await" | "unresolved";

export interface FlameNode {
  id: number;
  /** Upstream merge key `kind|file|(line or "x")|display_name`, unique among siblings. */
  key: string;
  /** Path of keys from the root, unique in the tree (used for zoom state). */
  path: string;
  parent: FlameNode | null;
  depth: number;
  kind: FlameNodeKind;
  /** Display name; `0x…` for unresolved native frames, "All stacks" for the root. */
  name: string;
  file: string;
  line: number | null;
  ip: number | null;
  /** Weight through this node (hits or MiB). */
  total: number;
  /** Weight of stacks ending here. */
  self: number;
  /** Horizontal extent in weight units: `[x0, x1)`, root = `[0, total)`. */
  x0: number;
  x1: number;
  /** Heaviest first. */
  children: FlameNode[];
}

export interface FlameTree {
  kind: "cpu" | "memory";
  root: FlameNode;
  total: number;
  /** Number of input stacks with weight > 0. */
  stacks: number;
  /** Deepest frame count (root excluded). */
  maxDepth: number;
  /** Nodes per depth sorted by x0 (binary-search hit testing). */
  byDepth: FlameNode[][];
  /** Every node in depth-first order (root first). */
  nodes: FlameNode[];
  byPath: Map<string, FlameNode>;
  /** Python nodes per `file:line`. */
  byLine: Map<string, FlameNode[]>;
  /** Largest `self` of any node (for the "Self" colour ramp). */
  maxSelf: number;
}

export const lineKey = (file: string, line: number): string => `${file}\u0000${line}`;

export function frameMergeKey(f: CombinedFrame): string {
  return `${f.kind}|${f.filename_or_module ?? ""}|${f.kind === "py" ? f.line : "x"}|${f.display_name ?? ""}`;
}

function frameKind(f: CombinedFrame): FlameNodeKind {
  if (f.kind === "py") return isAwaitFrame(f) ? "await" : "py";
  return f.display_name ? "native" : "unresolved";
}

function frameName(f: CombinedFrame): string {
  if (f.display_name) return f.display_name;
  return f.kind === "native" && typeof f.ip === "number" ? `0x${f.ip.toString(16)}` : "??";
}

function newNode(id: number, key: string, parent: FlameNode | null, f: CombinedFrame | null): FlameNode {
  return {
    id,
    key,
    path: parent ? (parent.parent ? `${parent.path}\u0001${key}` : key) : "",
    parent,
    depth: parent ? parent.depth + 1 : 0,
    kind: f ? frameKind(f) : "root",
    name: f ? frameName(f) : "All stacks",
    file: f?.filename_or_module ?? "",
    line: f && f.kind === "py" ? f.line : null,
    ip: f && f.kind === "native" ? f.ip : null,
    total: 0,
    self: 0,
    x0: 0,
    x1: 0,
    children: [],
  };
}

const SLICE_ROWS = 128;

/** Build the icicle tree: merge by key root-first, heaviest children first. */
export function* buildFlameTree(
  entries: readonly (CombinedStackEntry | MemoryStackEntry)[],
  kind: "cpu" | "memory",
): Generator<unknown, FlameTree | null, void> {
  const root = newNode(0, "root", null, null);
  const childIndex = new Map<FlameNode, Map<string, FlameNode>>();
  let nextId = 1;
  let stacks = 0;
  let maxDepth = 0;
  for (let e = 0; e < entries.length; e++) {
    const frames = entries[e][0] as readonly CombinedFrame[];
    const w = entries[e][1];
    if (!(w > 0)) continue;
    stacks++;
    root.total += w;
    let node = root;
    for (const f of frames) {
      let kids = childIndex.get(node);
      if (!kids) childIndex.set(node, (kids = new Map()));
      const key = frameMergeKey(f);
      let child = kids.get(key);
      if (!child) {
        child = newNode(nextId++, key, node, f);
        kids.set(key, child);
        node.children.push(child);
      }
      child.total += w;
      node = child;
    }
    node.self += w;
    if (frames.length > maxDepth) maxDepth = frames.length;
    if (e % SLICE_ROWS === SLICE_ROWS - 1) yield;
  }
  if (stacks === 0) return null;
  yield;
  const nodes: FlameNode[] = [];
  const byDepth: FlameNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const byPath = new Map<string, FlameNode>();
  const byLine = new Map<string, FlameNode[]>();
  // Iterative pre-order layout keeps deep recursion chains off the call stack.
  root.x0 = 0;
  root.x1 = root.total;
  const todo: FlameNode[] = [root];
  let visited = 0;
  while (todo.length > 0) {
    const n = todo.pop() as FlameNode;
    nodes.push(n);
    byDepth[n.depth].push(n);
    byPath.set(n.path, n);
    if (n.kind === "py" || n.kind === "await") {
      if (n.line !== null) {
        const k = lineKey(n.file, n.line);
        const list = byLine.get(k);
        if (list) list.push(n);
        else byLine.set(k, [n]);
      }
    }
    n.children.sort((a, b) => b.total - a.total);
    let x = n.x0;
    for (const c of n.children) {
      c.x0 = x;
      x += c.total;
      c.x1 = x;
    }
    for (let i = n.children.length - 1; i >= 0; i--) todo.push(n.children[i]);
    if (++visited % 1024 === 0) yield;
  }
  yield;
  for (const row of byDepth) row.sort((a, b) => a.x0 - b.x0);
  let maxSelf = 0;
  for (const n of nodes) if (n !== root && n.self > maxSelf) maxSelf = n.self;
  return { kind, root, total: root.total, stacks, maxDepth, byDepth, nodes, byPath, byLine, maxSelf };
}

/** The heaviest node of `file:line` (for "Show in stacks"), or null. */
export function heaviestNode(tree: FlameTree, file: string, line: number): FlameNode | null {
  const list = tree.byLine.get(lineKey(file, line));
  if (!list || list.length === 0) return null;
  return list.reduce((a, b) => (b.total > a.total ? b : a));
}

/** Node at depth `depth` covering weight offset `x`, or null (binary search). */
export function nodeAt(tree: FlameTree, depth: number, x: number): FlameNode | null {
  const row = tree.byDepth[depth];
  if (!row) return null;
  let lo = 0;
  let hi = row.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const n = row[mid];
    if (x < n.x0) hi = mid - 1;
    else if (x >= n.x1) lo = mid + 1;
    else return n;
  }
  return null;
}

/** "Root › a › b" ancestry, root first. */
export function ancestry(node: FlameNode): FlameNode[] {
  const out: FlameNode[] = [];
  for (let n: FlameNode | null = node; n; n = n.parent) out.push(n);
  return out.reverse();
}

/** True when `node` is `ancestor` or below it. */
export function isDescendant(node: FlameNode, ancestor: FlameNode): boolean {
  for (let n: FlameNode | null = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

// ── Search, labels, colour helpers (§3.4, §4.11) ────────────────────────────

export interface FlameSearch {
  query: string;
  /** Matching nodes in depth-first order. */
  matches: FlameNode[];
  /** Matches without a matching ancestor (their weights do not overlap). */
  outermost: FlameNode[];
  /** % of the tree's weight in stacks with ≥ 1 matching frame. */
  share: number;
}

/**
 * Case-insensitive substring search over frame names and the basename of
 * their file/module. The share counts each stack once: the weight of the
 * shallowest match on every path.
 */
export function searchFlame(tree: FlameTree, query: string): FlameSearch {
  const q = query.trim().toLowerCase();
  if (!q) return { query: q, matches: [], outermost: [], share: 0 };
  const hit = (n: FlameNode): boolean => n.name.toLowerCase().includes(q) || (n.file !== "" && basename(n.file).toLowerCase().includes(q));
  const matches: FlameNode[] = [];
  const outermost: FlameNode[] = [];
  // Pre-order visits parents first; `covered[id]` = the node or an ancestor matched.
  const covered = new Uint8Array(tree.nodes.length);
  let weight = 0;
  for (const n of tree.nodes) {
    if (n === tree.root) continue;
    const parentCovered = n.parent !== null && covered[n.parent.id] === 1;
    if (hit(n)) {
      matches.push(n);
      if (!parentCovered) {
        outermost.push(n);
        weight += n.total;
      }
      covered[n.id] = 1;
    } else if (parentCovered) covered[n.id] = 1;
  }
  return { query: q, matches, outermost, share: tree.total > 0 ? (100 * weight) / tree.total : 0 };
}

/**
 * Simplified C++ label: template arguments and parameter lists collapse to
 * `<…>` and `(…)` (`operator<<`, `operator()` and `(anonymous namespace)`
 * stay intact). The full name belongs in the tooltip.
 */
export function simplifyNativeName(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch !== "<" && ch !== "(") {
      out += ch;
      continue;
    }
    if (out.endsWith("operator") || out.endsWith("operator<") || out.endsWith("operator(")) {
      out += ch;
      continue;
    }
    if (name.startsWith("(anonymous namespace)", i)) {
      out += "(anonymous namespace)";
      i += "(anonymous namespace)".length - 1;
      continue;
    }
    const close = ch === "<" ? ">" : ")";
    let depth = 0;
    let j = i;
    for (; j < name.length; j++) {
      const c = name[j];
      if (c === "<" || c === "(") depth++;
      else if (c === ">" || c === ")") depth--;
      if (depth === 0) break;
    }
    if (j >= name.length) {
      out += name.slice(i); // unbalanced: keep verbatim
      break;
    }
    out += name[i + 1] === close ? `${ch}${close}` : `${ch}…${close}`;
    i = j;
  }
  return out;
}

/** "File" colour mode slot: upstream string hash of the file/module, mod 8 (`--file-N`). */
export function fileColorIndex(fileOrModule: string): number {
  let h = 0;
  for (let i = 0; i < fileOrModule.length; i++) h = ((h << 5) - h + fileOrModule.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}

/** "Self" colour mode ramp step: `min(5, floor(6 × self / maxSelf))`. */
export function selfRampStep(self: number, maxSelf: number): number {
  if (!(maxSelf > 0) || !(self > 0)) return 0;
  return Math.min(5, Math.floor((6 * self) / maxSelf));
}

// ── Call context (§4.0.7, §4.9) ─────────────────────────────────────────────

export interface CallEdge {
  name: string;
  kind: FlameNodeKind;
  file: string;
  line: number | null;
  hits: number;
  /** % of the line's stack samples (N). */
  share: number;
}

export interface CallContext {
  file: string;
  line: number;
  /** N: Σ hits of stacks containing this line as a Python frame. */
  hits: number;
  /** M: Σ hits of all stacks. */
  total: number;
  /** N / M in %. */
  share: number;
  /** "in 1,157 of 5,901 stack samples (19.6%)". */
  summary: string;
  /** Next frame below the deepest match, top 4 by hits. */
  callsInto: CallEdge[];
  /** Frame above the first match, top 2 by hits. */
  calledFrom: CallEdge[];
}

export interface CallContextIndex {
  total: number;
  /** `lineKey(file, line)` → stack indices containing that py frame. */
  stacksByLine: Map<string, number[]>;
}

export function* buildCallContextIndex(stacks: readonly CombinedStackEntry[]): Generator<unknown, CallContextIndex | null, void> {
  if (stacks.length === 0) return null;
  const stacksByLine = new Map<string, number[]>();
  let total = 0;
  for (let s = 0; s < stacks.length; s++) {
    const [frames, hits] = stacks[s];
    total += hits;
    let seen: Set<string> | null = null;
    for (const f of frames) {
      if (f.kind !== "py") continue;
      const k = lineKey(f.filename_or_module, f.line);
      if (seen?.has(k)) continue;
      (seen ??= new Set()).add(k);
      const list = stacksByLine.get(k);
      if (list) list.push(s);
      else stacksByLine.set(k, [s]);
    }
    if (s % SLICE_ROWS === SLICE_ROWS - 1) yield;
  }
  return { total, stacksByLine };
}

function topEdges(acc: Map<string, CallEdge>, n: number, denom: number): CallEdge[] {
  const list = Array.from(acc.values()).sort((a, b) => b.hits - a.hits || (a.name < b.name ? -1 : 1));
  return list.slice(0, n).map((e) => ({ ...e, share: denom > 0 ? (100 * e.hits) / denom : 0 }));
}

function addEdge(acc: Map<string, CallEdge>, key: string, f: CombinedFrame, hits: number): void {
  const e = acc.get(key);
  if (e) e.hits += hits;
  else acc.set(key, { name: frameName(f), kind: frameKind(f), file: f.filename_or_module ?? "", line: f.kind === "py" ? f.line : null, hits, share: 0 });
}

export function callContextFor(
  index: CallContextIndex,
  stacks: readonly CombinedStackEntry[],
  file: string,
  line: number,
): CallContext {
  const list = index.stacksByLine.get(lineKey(file, line)) ?? [];
  const into = new Map<string, CallEdge>();
  const from = new Map<string, CallEdge>();
  let hits = 0;
  for (const s of list) {
    const [frames, h] = stacks[s];
    hits += h;
    let first = -1;
    let last = -1;
    frames.forEach((f, d) => {
      if (f.kind === "py" && f.line === line && f.filename_or_module === file) {
        if (first < 0) first = d;
        last = d;
      }
    });
    const below = frames[last + 1];
    if (below) addEdge(into, `${frameKind(below)}|${frameName(below)}`, below, h);
    const above = first > 0 ? frames[first - 1] : undefined;
    if (above) addEdge(from, frameMergeKey(above), above, h);
  }
  const share = index.total > 0 ? (100 * hits) / index.total : 0;
  return {
    file,
    line,
    hits,
    total: index.total,
    share,
    summary: `in ${fmtCount(hits)} of ${fmtCount(index.total)} stack samples (${fmtPct(share)})`,
    callsInto: topEdges(into, 4, hits),
    calledFrom: topEdges(from, 2, hits),
  };
}
