/**
 * Pure flame-graph logic (DESIGN.md §4.11): zoom plans (staged lateral zoom,
 * M12), re-based axis ticks, captions, keyboard walk, announcements and
 * tooltip content. No DOM access, so every rule is unit-tested in Node.
 */

import { basename, fmtCount, fmtMem, fmtPct, pickNiceTickInterval } from "../../core/format";
import { memoryTicks } from "../../charts/axis";
import type { TooltipContent } from "../../core/tooltip";
import type { FlameNode, FlameTree } from "../../model/stacks";
import { heaviestNode, isDescendant, lineKey } from "../../model/stacks";
import { KIND_CHIP, KIND_WORD, frameLabelText } from "./shared";

export type TreeKind = "cpu" | "memory";

// ── Domain and zoom ─────────────────────────────────────────────────────────

/** The weight domain that makes `node` span the full width. */
export function domainOf(node: FlameNode): [number, number] {
  return [node.x0, node.x1 > node.x0 ? node.x1 : node.x0 + 1e-9];
}

/** Deepest node that is an ancestor of (or equal to) both nodes. */
export function commonAncestor(a: FlameNode, b: FlameNode): FlameNode {
  const seen = new Set<FlameNode>();
  for (let n: FlameNode | null = a; n; n = n.parent) seen.add(n);
  for (let n: FlameNode | null = b; n; n = n.parent) if (seen.has(n)) return n;
  let root = a;
  while (root.parent) root = root.parent;
  return root;
}

/**
 * Zoom stages from the current focus `from` to `to` (§4.11.6, M11/M12):
 * one stage when `to` is inside `from`'s subtree or on its ancestor path,
 * otherwise (a lateral jump) first out to the common ancestor, then in.
 */
export function zoomPlan(from: FlameNode, to: FlameNode): FlameNode[] {
  if (from === to) return [to];
  if (isDescendant(to, from) || isDescendant(from, to)) return [to];
  const common = commonAncestor(from, to);
  return common === to ? [to] : [common, to];
}

/** Linear interpolation of two domains (the tween state). */
export function lerpDomain(a: readonly [number, number], b: readonly [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// ── Axis (§4.11.4) ──────────────────────────────────────────────────────────

export interface AxisValue {
  /** Position inside the focused frame, 0 … 1. */
  frac: number;
  label: string;
}

function pctLabel(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${v.toFixed(decimals)}%`;
}

/** Ticks re-based to the focused frame: 0–100 % (CPU) or 0–focused MiB (memory). */
export function axisValues(kind: TreeKind, focus: FlameNode, widthPx: number): AxisValue[] {
  if (kind === "memory") {
    const max = focus.total;
    if (!(max > 0)) return [];
    const set = memoryTicks(max, widthPx);
    return set.ticks.map((t) => ({ frac: t.value / max, label: t.label }));
  }
  const step = pickNiceTickInterval(100, widthPx);
  if (!(step > 0)) return [];
  const out: AxisValue[] = [];
  for (let k = 0; k * step <= 100 + 1e-9 && out.length < 200; k++) {
    const v = k * step;
    out.push({ frac: v / 100, label: v === 0 ? "0%" : pctLabel(v, step) });
  }
  return out;
}

/** Weight-unit position of an axis value inside the focus (for drawing under a tweening domain). */
export function axisWeight(focus: FlameNode, frac: number): number {
  return focus.x0 + frac * (focus.x1 - focus.x0);
}

/**
 * Short frame reference for captions, crumbs and announcements: the canvas label
 * ("train() :173" = function train, line 173; never "train:173", which reads like a
 * file), "cudaMalloc" for native frames.
 */
export function shortRef(node: FlameNode): string {
  if (node.kind === "root") return "All stacks";
  if (node.kind === "native" || node.kind === "unresolved") return frameLabelText(node.kind, node.name, null);
  return frameLabelText(node.kind, node.name, node.line);
}

/** Share of the whole tree, in % (0 for an empty tree). */
export function shareOf(node: FlameNode, tree: FlameTree): number {
  return tree.total > 0 ? (100 * node.total) / tree.total : 0;
}

/** The denominator statement at the right end of the axis (`compact` on narrow plots, §4.0.3). */
export function axisCaption(kind: TreeKind, focus: FlameNode, tree: FlameTree, compact = false): string {
  if (compact) {
    // The ticks carry the unit (one per axis, MiB or GiB), so the caption names none (round 1).
    if (kind === "memory") return focus.kind === "root" ? "of alloc." : `in ${shortRef(focus)}`;
    return focus.kind === "root" ? "% of stacks" : `% of ${shortRef(focus)}`;
  }
  if (kind === "memory") {
    if (focus.kind === "root") return "attributed allocation";
    return `in ${shortRef(focus)} (${fmtPct(shareOf(focus, tree))} of attributed allocation)`;
  }
  if (focus.kind === "root") return "% of all sampled stacks";
  return `% of ${shortRef(focus)} (${fmtPct(shareOf(focus, tree))} of all stacks)`;
}

/** Root row label: "All stacks · 5,901 samples" / "All stacks · 3.17 GiB". */
export function rootLabel(kind: TreeKind, tree: FlameTree): string {
  return kind === "cpu" ? `All stacks · ${fmtCount(tree.total)} samples` : `All stacks · ${fmtMem(tree.total)}`;
}

/** Section description per tab (§4.11.1). */
export function flameDescription(kind: TreeKind, tree: FlameTree): string {
  if (kind === "cpu") {
    return `${fmtCount(tree.stacks)} stitched Python + native stacks · ${fmtCount(tree.total)} samples · width = share of sampled stacks, not of run time`;
  }
  return `${fmtCount(tree.stacks)} allocation stacks · ${fmtMem(tree.total)} attributed · width = share of attributed allocation (cumulative volume, not live size)`;
}

/** Match chip text: "Matched 23.4% of samples · 12 frames" (parts for bolding). */
export function matchSummary(kind: TreeKind, share: number, frames: number): { lead: string; value: string; tail: string } | null {
  if (frames === 0) return null;
  return {
    lead: "Matched ",
    value: fmtPct(share),
    tail: ` of ${kind === "cpu" ? "samples" : "allocation"} · ${fmtCount(frames)} frame${frames === 1 ? "" : "s"}`,
  };
}

// ── Values and words ────────────────────────────────────────────────────────

/** "878 samples" / "1.17 GiB". */
export function weightText(kind: TreeKind, w: number): string {
  return kind === "cpu" ? `${fmtCount(Math.round(w))} sample${Math.round(w) === 1 ? "" : "s"}` : fmtMem(w);
}

/** Where the frame lives: "train.py:173", the module path, or "unresolved module". */
export function locationText(node: FlameNode): string {
  if (node.kind === "root") return "";
  if (node.kind === "py" || node.kind === "await") return node.line !== null ? `${basename(node.file)}:${node.line}` : basename(node.file);
  return node.file || "unknown module";
}

/**
 * Polite announcement for the keyboard walk (§4.11.7):
 * "train, train.py line 173, Python frame, 14.9% of sampled stacks, 878 samples, depth 2 of 19".
 */
export function announceText(kind: TreeKind, node: FlameNode, tree: FlameTree): string {
  const depth = `depth ${node.depth} of ${tree.maxDepth}`;
  if (node.kind === "root") {
    return kind === "cpu"
      ? `All stacks, ${fmtCount(tree.total)} samples, ${depth}`
      : `All stacks, ${fmtMem(tree.total)} attributed, ${depth}`;
  }
  const where =
    node.kind === "py" || node.kind === "await"
      ? `${basename(node.file)} line ${node.line ?? "?"}`
      : node.file
        ? basename(node.file)
        : "unknown module";
  const name = node.kind === "native" ? frameLabelText("native", node.name, null) : node.name;
  const share = fmtPct(shareOf(node, tree));
  const value =
    kind === "cpu"
      ? `${share} of sampled stacks, ${weightText(kind, node.total)}`
      : `${fmtMem(node.total)}, ${share} of attributed allocation`;
  return `${name}, ${where}, ${KIND_WORD[node.kind]}, ${value}, ${depth}`;
}

/** Spoken frame reference: "train, train.py line 165" / "cudaMalloc, libcudart.so". */
function spokenRef(node: FlameNode): string {
  if (node.kind === "root") return "All stacks";
  if (node.kind === "py" || node.kind === "await") return `${node.name}, ${basename(node.file)} line ${node.line ?? "?"}`;
  const name = node.kind === "native" ? frameLabelText("native", node.name, null) : node.name;
  return node.file ? `${name}, ${basename(node.file)}` : name;
}

/**
 * Polite announcement once a zoom settles (round 1): "Zoomed into train, train.py line 165,
 * 14.9% of samples" / "Zoomed out to All stacks". `out` = the new focus is an ancestor of the old.
 */
export function zoomAnnouncement(kind: TreeKind, node: FlameNode, tree: FlameTree, out: boolean): string {
  if (node.kind === "root") return "Zoomed out to All stacks";
  const share = fmtPct(shareOf(node, tree));
  const what = kind === "cpu" ? `${share} of samples` : `${fmtMem(node.total)}, ${share} of attributed allocation`;
  return `${out ? "Zoomed out to" : "Zoomed into"} ${spokenRef(node)}, ${what}`;
}

/** Tooltip content for a frame (§4.11.6). `source` returns "" when unknown; `known` tells if the file is in the profile. */
export function frameTooltip(
  kind: TreeKind,
  node: FlameNode,
  tree: FlameTree,
  source: (file: string, line: number) => string,
  known: (file: string) => boolean,
): TooltipContent {
  if (node.kind === "root") {
    return {
      kind: KIND_CHIP.root,
      title: rootLabel(kind, tree),
      rows: [
        ["Stacks", fmtCount(tree.stacks)],
        ["Depth", `${tree.maxDepth} frames`],
      ],
      hint: kind === "cpu" ? "Width = share of sampled stacks, not of run time" : "Width = share of attributed allocation",
    };
  }
  const share = fmtPct(shareOf(node, tree));
  const parentTotal = node.parent ? node.parent.total : 0;
  const ofCaller = parentTotal > 0 ? fmtPct((100 * node.total) / parentTotal) : "—";
  const rows: [string, string][] = [];
  rows.push(["Location", locationText(node)]);
  if (kind === "cpu") {
    rows.push(["Sampled stacks", `${share} · ${weightText(kind, node.total)}`]);
    rows.push(["Self", fmtPct(tree.total > 0 ? (100 * node.self) / tree.total : 0)]);
  } else {
    rows.push(["Attributed", `${fmtMem(node.total)} · ${share}`]);
    rows.push(["Self", fmtMem(node.self)]);
  }
  rows.push(["Of caller", ofCaller]);
  const py = node.kind === "py" || node.kind === "await";
  let code: string | undefined;
  let hint = "Click to zoom";
  if (py && node.line !== null) {
    if (known(node.file)) {
      const text = source(node.file, node.line).trim();
      if (text) code = text;
      hint = "Click to zoom · double-click to open the line";
    } else {
      hint = "Click to zoom · source not in this profile";
    }
  }
  return { kind: KIND_CHIP[node.kind], title: node.name, mono: true, rows, code, hint };
}

// ── Keyboard walk (§4.11.7) ─────────────────────────────────────────────────

/** True when `n` is drawn under the zoom focus (inside its subtree or on its ancestor path). */
export function inZoom(n: FlameNode, zoom: FlameNode): boolean {
  return isDescendant(n, zoom) || isDescendant(zoom, n);
}

function rowIndex(row: readonly FlameNode[], n: FlameNode): number {
  let lo = 0;
  let hi = row.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (row[mid].x0 < n.x0) lo = mid + 1;
    else if (row[mid].x0 > n.x0) hi = mid - 1;
    else {
      // Zero-width neighbours may share x0: scan locally.
      for (let i = mid; i >= 0 && row[i].x0 === n.x0; i--) if (row[i] === n) return i;
      for (let i = mid + 1; i < row.length && row[i].x0 === n.x0; i++) if (row[i] === n) return i;
      return mid;
    }
  }
  return row.indexOf(n);
}

/**
 * Next focused frame for a key: ↑ parent, ↓ heaviest child, ←/→ the nearest
 * frame at the same depth (siblings first, they are adjacent), Home → root.
 * Movement stays inside what the zoom shows; null when the key is not a walk key.
 */
export function walk(tree: FlameTree, from: FlameNode, key: string, zoom: FlameNode): FlameNode | null {
  switch (key) {
    case "ArrowUp":
      return from.parent ?? from;
    case "ArrowDown":
      return from.children[0] ?? from;
    case "Home":
      return tree.root;
    case "ArrowLeft":
    case "ArrowRight": {
      const row = tree.byDepth[from.depth];
      if (!row) return from;
      const i = rowIndex(row, from);
      const dir = key === "ArrowRight" ? 1 : -1;
      for (let j = i + dir; j >= 0 && j < row.length; j += dir) {
        const n = row[j];
        if (n.x1 <= n.x0) continue;
        return inZoom(n, zoom) ? n : from;
      }
      return from;
    }
    default:
      return null;
  }
}

// ── Targets ─────────────────────────────────────────────────────────────────

/**
 * The node "Show in stacks" focuses (§4.11.6): the heaviest node of the line,
 * or for a function range the heaviest node of any line inside it.
 */
export function nodeForLine(tree: FlameTree, file: string, line: number): FlameNode | null {
  return heaviestNode(tree, file, line);
}

export function nodeForRange(tree: FlameTree, file: string, range: readonly [number, number]): FlameNode | null {
  let best: FlameNode | null = null;
  for (let no = range[0]; no <= range[1]; no++) {
    const list = tree.byLine.get(lineKey(file, no));
    if (!list) continue;
    for (const n of list) if (!best || n.total > best.total) best = n;
  }
  return best;
}

/** Zoom target for "Show in stacks": the parent of the heaviest node, so its callees stay visible. */
export function showInStacksZoom(node: FlameNode): FlameNode {
  return node.parent ?? node;
}

