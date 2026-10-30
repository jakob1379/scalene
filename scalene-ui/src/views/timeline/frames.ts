/**
 * Timeline frame drawing (DESIGN.md §4.12.2): merged segments per (thread,
 * depth) in the Kind palette, sub-pixel runs accumulated into `--frame-lod`
 * columns, Interleaved thread borders, plus hit testing and tooltip text.
 * `renderTimelineFrames(…, sourceLookup)` is the function the upstream facade
 * hands to `mountTimeline` (§7.5): it draws one panel and returns the panel's
 * hit tester, whose descriptions read source lines through `sourceLookup`.
 */

import { fmtCount, fmtTime, basename } from "../../core/format";
import { monoFont, setFont } from "../../core/canvas";
import type { ThemeApi } from "../../core/theme";
import type { TooltipContent } from "../../core/tooltip";
import type { SourceLookup } from "../../model/source";
import type { TimelineM, ThreadInfo } from "../../model/timeline";
import type { CombinedFrame } from "../../types";
import type { FlameNodeKind } from "../../model/stacks";
import {
  KIND_CHIP,
  KIND_WORD,
  fitChars,
  fitModeFor,
  frameKindOf,
  frameLabelText,
  frameNameOf,
  framePalette,
  lodPick,
  lowerBound,
  monoCharWidth,
  threadSlot,
  fmtSecPrecise,
} from "../stacks/shared";

export interface FramePanelSpec {
  ctx2d: CanvasRenderingContext2D;
  tl: TimelineM;
  /** Lanes drawn into this panel (Interleaved: all lanes, drawn workers first so main is on top). */
  lanes: readonly number[];
  interleaved: boolean;
  x: number;
  y: number;
  w: number;
  rowH: number;
  /** Depth rows drawn. */
  depth: number;
  domain: readonly [number, number];
  theme: ThemeApi;
  dpr: number;
}

export interface SegmentRef {
  lane: number;
  depth: number;
  idx: number;
  t0: number;
  t1: number;
  stack: number;
  samples: number;
  frame: CombinedFrame;
  kind: FlameNodeKind;
}

export interface FramePanel {
  /** Segment under (x, y), topmost first; null in gaps. */
  hit(x: number, y: number): SegmentRef | null;
  /** Tooltip content (source line through the panel's `sourceLookup`). */
  describe(ref: SegmentRef): TooltipContent;
  /** Segments drawn (wide + LOD runs), for perf notes. */
  drawn: number;
  /** Device-pixel LOD columns resolved, and how many fell back to `--frame-lod` (mixed kinds). */
  lodColumns?: number;
  lodMixed?: number;
}

const LABEL_MIN_PX = 40;
const KINDS: readonly FlameNodeKind[] = ["py", "native", "await", "unresolved"];
const NO_FRAME = 255;
/** Per segment row: frame kind codes (index into KINDS), computed once per row. */
const kindCache = new WeakMap<object, Uint8Array>();

function rowKinds(tl: TimelineM, row: { n: number; stack: Int32Array }, depth: number): Uint8Array {
  let k = kindCache.get(row);
  if (!k) {
    k = new Uint8Array(row.n);
    for (let i = 0; i < row.n; i++) {
      const f = tl.frameAt(row.stack[i], depth);
      k[i] = f ? KINDS.indexOf(frameKindOf(f)) : NO_FRAME;
    }
    kindCache.set(row, k);
  }
  return k;
}

/** Build a lane's segments and their kind codes ahead of the first draw (idle work). */
export function prewarmLane(tl: TimelineM, lane: number): void {
  const segs = tl.segments(lane);
  segs.rows.forEach((row, d) => rowKinds(tl, row, d));
}

/** Segment `idx` of a lane/depth as a reference (frame resolved). */
export function segmentRef(tl: TimelineM, lane: number, depth: number, idx: number): SegmentRef | null {
  const row = tl.segments(lane).rows[depth];
  if (!row || idx < 0 || idx >= row.n) return null;
  const frame = tl.frameAt(row.stack[idx], depth);
  if (!frame) return null;
  return { lane, depth, idx, t0: row.t0[idx], t1: row.t1[idx], stack: row.stack[idx], samples: row.samples[idx], frame, kind: frameKindOf(frame) };
}

/** Segment of a lane/depth row covering time `t` (index or −1). */
export function segmentAt(tl: TimelineM, lane: number, depth: number, t: number, slack = 0): number {
  const row = tl.segments(lane).rows[depth];
  if (!row || row.n === 0) return -1;
  const i = lowerBound(row.t1, t - slack, 0, row.n);
  return i < row.n && row.t0[i] <= t + slack ? i : -1;
}

/** "main (id 139872518063936)" / "thread 2 (id …)" / "unknown thread". */
export function threadText(t: ThreadInfo | undefined): string {
  if (!t) return "unknown thread";
  if (t.id === null) return "unknown thread";
  return `${t.label} (id ${t.id})`;
}

/** Location text of a raw frame. */
export function frameLocation(f: CombinedFrame): string {
  if (f.kind === "py") return `${basename(f.filename_or_module)}:${f.line}`;
  return f.filename_or_module || "unknown module";
}

/** Tooltip for a timeline segment (§4.12.3). */
export function describeSegment(tl: TimelineM, ref: SegmentRef, sourceLookup: SourceLookup): TooltipContent {
  const f = ref.frame;
  const rows: [string, string][] = [
    ["Location", frameLocation(f)],
    ["Thread", threadText(tl.threads[ref.lane])],
    ["Time", `${fmtSecPrecise(ref.t0)} – ${fmtSecPrecise(ref.t1)} · ${fmtTime(ref.t1 - ref.t0)}`],
    ["Samples", fmtCount(ref.samples)],
  ];
  let code: string | undefined;
  let hint = "Drag to zoom · Ctrl/⌘ + wheel zooms";
  if (f.kind === "py") {
    const text = sourceLookup(f.filename_or_module, f.line).trim();
    if (text) {
      code = text;
      hint = "Click to open the line · drag to zoom";
    } else hint = "Source not in this profile · drag to zoom";
  }
  return { kind: KIND_CHIP[ref.kind], title: frameNameOf(f), mono: true, rows, code, hint };
}

/** "train, train.py line 124, main thread, 2.87 s to 53.9 s, 5,103 samples". */
export function announceSegment(tl: TimelineM, ref: SegmentRef): string {
  const f = ref.frame;
  const where = f.kind === "py" ? `${basename(f.filename_or_module)} line ${f.line}` : f.filename_or_module ? basename(f.filename_or_module) : "unknown module";
  const t = tl.threads[ref.lane];
  const thread = t ? (t.main ? "main thread" : t.id === null ? "unknown thread" : t.label) : "unknown thread";
  const name = ref.kind === "native" ? frameLabelText("native", frameNameOf(f), null) : frameNameOf(f);
  return `${name}, ${where}, ${thread}, ${KIND_WORD[ref.kind]}, ${fmtTime(ref.t0)} to ${fmtTime(ref.t1)}, ${fmtCount(ref.samples)} sample${ref.samples === 1 ? "" : "s"}`;
}

/**
 * Draw one frame panel (a lane body, or the Interleaved panel) and return
 * its hit tester. Rows are culled to the visible domain with `lowerBound`.
 */
export function renderTimelineFrames(spec: FramePanelSpec, sourceLookup: SourceLookup): FramePanel {
  const { ctx2d: c, tl, x, y, w, rowH, domain, theme, dpr } = spec;
  const p = framePalette(theme);
  const [d0, d1] = domain;
  const k = w / (d1 - d0);
  const font = monoFont(theme, 11);
  const cw = monoCharWidth(c, font);
  const px = 1 / dpr;
  const order = spec.interleaved ? spec.lanes.slice().reverse() : spec.lanes.slice();
  let drawn = 0;
  let lodColumns = 0;
  let lodMixed = 0;
  const acc = new Float64Array(KINDS.length);
  c.save();
  c.beginPath();
  c.rect(x, y, w, spec.depth * rowH);
  c.clip();
  setFont(c, font);
  c.textBaseline = "middle";
  c.textAlign = "left";
  for (const lane of order) {
    const segs = tl.segments(lane);
    const slot = threadSlot(lane);
    const depth = Math.min(spec.depth, segs.rows.length);
    for (let d = 0; d < depth; d++) {
      const row = segs.rows[d];
      if (row.n === 0) continue;
      const kinds = rowKinds(tl, row, d);
      const ry = y + d * rowH;
      const rh = rowH - 1;
      // LOD (§3.4, round 1): sub-pixel runs accumulate per device-pixel column the time each
      // frame kind covers; a column takes the fill of the kind covering ≥ 60 % of it (a 50/50
      // mix of the two largest when they cover ≥ 80 %, else `--frame-lod`), and touching
      // columns of the same colour are painted as one rect.
      let col = -1;
      let runA = -1;
      let runB = -1;
      let runPick = "";
      let runFill = "";
      let runPat: CanvasPattern | null = null;
      const paintRun = () => {
        if (runB > runA) {
          c.fillStyle = runFill;
          c.fillRect(runA, ry, runB - runA, rh);
          if (runPat) {
            c.fillStyle = runPat;
            c.fillRect(runA, ry, runB - runA, rh);
          }
          drawn++;
        }
        runA = runB = -1;
        runPick = "";
      };
      const endColumn = () => {
        if (col < 0) return;
        const [ka, kb] = lodPick(acc);
        lodColumns++;
        if (ka < 0) lodMixed++;
        const pick = `${ka},${kb}`;
        const a = col / dpr;
        if (runB >= 0 && pick === runPick && Math.abs(a - runB) < px * 0.25) runB = a + px;
        else {
          paintRun();
          runA = a;
          runB = a + px;
          runPick = pick;
          if (ka < 0) {
            runFill = p.lod;
            runPat = null;
          } else if (kb >= 0) {
            runFill = p.mix(p.fill[KINDS[ka]], p.fill[KINDS[kb]]);
            runPat = null;
          } else {
            const kk = KINDS[ka];
            runFill = p.fill[kk];
            runPat = kk === "await" ? p.awaitLines : kk === "unresolved" ? p.unresolvedLines : null;
          }
        }
        acc.fill(0);
        col = -1;
      };
      const flush = () => {
        endColumn();
        paintRun();
      };
      for (let i = lowerBound(row.t1, d0, 0, row.n); i < row.n; i++) {
        const t0 = row.t0[i];
        if (t0 > d1) break;
        const x0 = x + (t0 - d0) * k;
        const x1 = x + (row.t1[i] - d0) * k;
        const sw = x1 - x0;
        if (sw < px) {
          // Sub-pixel: add this run's time to the device-pixel column(s) it touches.
          const code = kinds[i];
          if (code === NO_FRAME) continue;
          const dur = row.t1[i] - t0;
          const c0 = Math.floor(x0 * dpr);
          const c1 = Math.max(c0, Math.ceil(x1 * dpr) - 1);
          for (let cc = c0; cc <= c1; cc++) {
            if (cc !== col) {
              if (cc < col) {
                // Out of order (cannot happen for sorted rows): fold into the open column.
                acc[code] += dur;
                break;
              }
              endColumn();
              col = cc;
            }
            const share = c1 === c0 || !(sw > 0) ? 1 : (Math.min(x1, (cc + 1) / dpr) - Math.max(x0, cc / dpr)) / sw;
            acc[code] += dur * (share > 0 ? share : 0);
          }
          continue;
        }
        flush();
        const code = kinds[i];
        if (code === NO_FRAME) continue;
        const kind = KINDS[code];
        const xl = Math.max(x0, x - 1);
        const xr = Math.min(x1, x + w + 1);
        const ww = xr - xl - (sw >= 3 ? 1 : 0);
        c.fillStyle = p.fill[kind];
        c.fillRect(xl, ry, ww, rh);
        const pat = kind === "await" ? p.awaitLines : kind === "unresolved" ? p.unresolvedLines : null;
        if (pat) {
          c.fillStyle = pat;
          c.fillRect(xl, ry, ww, rh);
        }
        let inset = 0;
        if (spec.interleaved && sw >= 2) {
          c.fillStyle = p.threads[slot];
          c.fillRect(x0, ry, Math.min(3, sw - 1), rh);
          inset = 3;
        }
        drawn++;
        if (sw >= LABEL_MIN_PX) {
          const left = Math.max(xl, x) + 4 + inset;
          const avail = Math.min(xr, x + w) - left - 4;
          const f = avail >= cw * 2 ? tl.frameAt(row.stack[i], d) : null;
          if (f) {
            const label = fitChars(frameLabelText(kind, frameNameOf(f), f.kind === "py" ? f.line : null), avail / cw, fitModeFor(kind));
            if (label) {
              c.fillStyle = p.ink[kind];
              c.fillText(label, left, ry + rh / 2 + 0.5);
            }
          }
        }
      }
      flush();
    }
  }
  c.restore();

  const hitOrder = spec.interleaved ? spec.lanes.slice() : spec.lanes.slice();
  return {
    drawn,
    lodColumns,
    lodMixed,
    hit(hx, hy) {
      if (hx < x || hx > x + w || hy < y || hy >= y + spec.depth * rowH) return null;
      const d = Math.floor((hy - y) / rowH);
      const t = d0 + (hx - x) / k;
      const slack = 1.5 / k; // 1.5 px tolerance for sub-pixel runs
      for (const lane of hitOrder) {
        const idx = segmentAt(tl, lane, d, t, slack);
        if (idx >= 0) return segmentRef(tl, lane, d, idx);
      }
      return null;
    },
    describe: (ref) => describeSegment(tl, ref, sourceLookup),
  };
}
