// Inline SVG icon set (DESIGN.md §3.6): 16 px grid, 1.5 px stroke, round caps/joins,
// currentColor, aria-hidden. The accessible name always lives on the control.
import { svg } from "./dom";

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
  search: [circle(7, 7, 4.5), "M10.5 10.5 14 14"],
  spark: ["M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6Z", "M13 1.8v2.4M11.8 3h2.4"],
  sun: [circle(8, 8, 3), "M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"],
  moon: ["M13.5 9.6A5.5 5.5 0 0 1 6.4 2.5a5.5 5.5 0 1 0 7.1 7.1Z"],
  monitor: [
    "M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z",
    "M5.5 14h5M8 11.5V14",
  ],
  upload: ["M8 10.5V2.5M5 5.5l3-3 3 3", "M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"],
  "chevron-right": ["M6 4l4 4-4 4"],
  "arrow-left": ["M13 8H3.5M7 4.5 3.5 8 7 11.5"],
  "chevron-down": ["M4 6l4 4 4-4"],
  x: ["M4 4l8 8M12 4l-8 8"],
  external: ["M6 3.5H3.5v9h9V10", "M9 2.5h4.5V7M13.5 2.5 7.5 8.5"],
  flame: [
    "M8 14.5c-2.8 0-4.5-1.9-4.5-4.3 0-2.6 2.1-3.7 2.6-6.7 1.4.9 2 2.2 2.1 3.4.6-.5.9-1.3.9-2.1 1.6 1.2 3.4 3.1 3.4 5.4 0 2.4-1.7 4.3-4.5 4.3Z",
  ],
  lanes: ["M2 3.5h7M2 8h12M2 12.5h9"],
  chip: [
    "M5 3.5h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5Z",
    "M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2",
  ],
  code: ["M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"],
  "trend-up": ["M2 12.5 6 8.5l2.5 2.5L14 5.5", "M10.5 5.5H14V9"],
  gpu: [
    "M3 4h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 12H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 4Z",
    circle(10.5, 8, 2),
    "M4 7h2.5M4 9h2.5",
  ],
  sync: ["M13 5.5A5 5 0 0 0 3.6 4.4M3 10.5a5 5 0 0 0 9.4 1.1", "M13.5 2.5v3h-3M2.5 13.5v-3h3"],
  peak: ["M1.5 13.5h13", "M2.5 11 6 7l2.5 2L13 3", circle(13, 3, 1)],
  cpu: [
    "M5.2 4h5.6A1.2 1.2 0 0 1 12 5.2v5.6a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 10.8V5.2A1.2 1.2 0 0 1 5.2 4Z",
    "M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5",
  ],
  copy: [
    "M7 5.5h5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5Z",
    "M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2",
  ],
  check: ["M3 8.5l3 3 7-7"],
  wait: [
    "M4 1.5h8M4 14.5h8",
    "M5 1.5v2.2c0 1.4 3 2.8 3 4.3s-3 2.9-3 4.3v2.2M11 1.5v2.2c0 1.4-3 2.8-3 4.3s3 2.9 3 4.3v2.2",
  ],
  minus: ["M3.5 8h9"],
  plus: ["M8 3.5v9M3.5 8h9"],
  reset: ["M2.5 8a5.5 5.5 0 1 0 1.6-3.9", "M2.5 2.5v3h3"],
  file: [
    "M4 1.5h5.5L12.5 4.5v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z",
    "M9.5 1.5v3h3",
  ],
  fn: ["M10.5 2.5c-1.8 0-2.5.9-2.8 2.7L6.3 12c-.3 1.6-1 2-2.3 2", "M4.5 6.5h6"],
  eye: ["M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z", circle(8, 8, 2)],
  info: [circle(8, 8, 6.2), "M8 7.2v4M8 4.8v.1"],
  alert: ["M8 2 14.5 13.5h-13Z", "M8 6.5v3.2M8 11.6v.1"],
  menu: [circle(3.2, 8, 0.6), circle(8, 8, 0.6), circle(12.8, 8, 0.6)],
  "sort-asc": ["M8 13V3M4.5 6.5 8 3l3.5 3.5"],
  "sort-desc": ["M8 3v10M4.5 9.5 8 13l3.5-3.5"],
  fold: ["M5 2.5l3 3 3-3M5 13.5l3-3 3 3", "M2.5 8h11"],
  unfold: ["M5 5.5l3-3 3 3M5 10.5l3 3 3-3"],
  play: ["M5 3.5v9l7.5-4.5Z"],
  sections: ["M2.5 3.5h11M2.5 8h11M2.5 12.5h7"],
} as const;

export type IconName = keyof typeof PATHS;

/** An icon as an inline SVG element (`aria-hidden`, not focusable). */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const el = svg("svg", {
    class: `icon icon-${name}`,
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  });
  for (const d of PATHS[name]) el.appendChild(svg("path", { d }));
  return el;
}

/**
 * The Scalene logo mark: a triangle whose edges use the three resource hues. It is the
 * only decorative use of data hues in the UI (§3.6).
 */
export function logoMark(size = 22): SVGSVGElement {
  const el = svg("svg", {
    class: "logo-mark",
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  });
  const edge = (d: string, color: string) =>
    svg("path", { d, fill: "none", "stroke-width": "2.4", "stroke-linecap": "round", style: `stroke: var(${color})` });
  el.append(edge("M4 19.2 12 5", "--cpu-py"), edge("M12 5l8 14.2", "--mem-py"), edge("M20 19.2H4", "--gpu"));
  return el;
}
