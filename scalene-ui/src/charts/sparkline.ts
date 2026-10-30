/**
 * Footprint sparkline for the code `trend` column (DESIGN.md §3.3): a
 * 64 × 16 SVG polyline (1.25 px `--mem-py`, `--danger` for a leak line), no
 * area, a dot at the max point, shared scales x `[0, tMax]` and
 * y `[0, max_footprint_mb]`. Negative legacy values clamp to 0 for drawing.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SparklineOptions {
  tMax: number;
  yMax: number;
  width?: number;
  height?: number;
  leak?: boolean;
}

export interface SparklineGeometry {
  /** SVG `points` attribute. */
  points: string;
  /** The max point (null when empty). */
  max: { x: number; y: number } | null;
}

const PAD = 1.5; // keeps the stroke and dot inside the box

/** Pure geometry (unit-tested). Samples are `[t0, mb0, t1, mb1, …]`. */
export function sparklineGeometry(samples: Float64Array, o: SparklineOptions): SparklineGeometry {
  const w = o.width ?? 64;
  const h = o.height ?? 16;
  const m = samples.length / 2;
  if (m === 0 || !(o.tMax > 0) || !(o.yMax > 0)) return { points: "", max: null };
  const sx = (w - 2 * PAD) / o.tMax;
  const sy = (h - 2 * PAD) / o.yMax;
  const pts: string[] = [];
  let best = -1;
  for (let i = 0; i < m; i++) {
    const t = Math.min(o.tMax, Math.max(0, samples[2 * i]));
    const v = Math.min(o.yMax, Math.max(0, samples[2 * i + 1]));
    pts.push(`${(PAD + t * sx).toFixed(2)},${(h - PAD - v * sy).toFixed(2)}`);
    if (best < 0 || samples[2 * i + 1] > samples[2 * best + 1]) best = i;
  }
  if (m === 1) pts.push(pts[0]); // a single point still draws (as the dot)
  const [mx, my] = pts[best].split(",").map(Number);
  return { points: pts.join(" "), max: { x: mx, y: my } };
}

/** Build (or update `reuse`) the sparkline SVG: svg > polyline + circle. */
export function sparkline(doc: Document, samples: Float64Array, o: SparklineOptions, reuse?: SVGSVGElement | null): SVGSVGElement {
  const w = o.width ?? 64;
  const h = o.height ?? 16;
  const svg = reuse ?? (doc.createElementNS(SVG_NS, "svg") as SVGSVGElement);
  if (!reuse) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.append(doc.createElementNS(SVG_NS, "polyline"), doc.createElementNS(SVG_NS, "circle"));
  }
  svg.setAttribute("class", `sparkline${o.leak ? " is-leak" : ""}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const color = o.leak ? "var(--danger)" : "var(--mem-py)";
  const g = sparklineGeometry(samples, o);
  const line = svg.children[0] as SVGPolylineElement;
  line.setAttribute("points", g.points);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke-width", "1.25");
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("stroke-linecap", "round");
  line.style.stroke = color;
  const dot = svg.children[1] as SVGCircleElement;
  if (g.max) {
    dot.setAttribute("cx", String(g.max.x));
    dot.setAttribute("cy", String(g.max.y));
    dot.setAttribute("r", "1.25");
    dot.style.fill = color;
    dot.style.display = "";
  } else dot.style.display = "none";
  return svg;
}
