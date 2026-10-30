// charts/*: meters, sparklines, raster strips, rug, footprint drawer,
// callouts and the DOM axes with the upstream test-contract class names.
import assert from "node:assert/strict";
import { fakeTheme, installDom, recordingContext } from "./_dom.mjs";
import { mod, test } from "./_harness.mjs";

const doc = installDom();
const meter = mod("charts/meter");
const spark = mod("charts/sparkline");
const raster = mod("charts/raster");
const fp = mod("charts/footprint");
const axis = mod("charts/axis");
const R = (x, y, w, h) => ({ x, y, w, h });
const count = (ctx, name) => ctx.calls.filter((c) => c[0] === name).length;

test("segmentFractions: share of the track, clamped to the track", () => {
  assert.deepEqual(meter.segmentFractions([{ value: 10 }, { value: 5 }, { value: 5 }], 40), [0.25, 0.125, 0.125]);
  assert.deepEqual(meter.segmentFractions([{ value: 30 }, { value: 30 }], 40), [0.75, 0.25]);
  assert.deepEqual(meter.segmentFractions([{ value: -1 }, { value: 4 }], 4), [0, 1]);
  assert.deepEqual(meter.segmentFractions([{ value: 1 }], 0), [0]);
});

test("meter: ≤ 4 nodes, token colours, system hatch, min 2 px, avg tick; updates in place", () => {
  const el = meter.meter(doc, {
    segments: [
      { value: 0.1, token: "cpu-py" },
      { value: 7.2, token: "cpu-native" },
      { value: 14.1, token: "cpu-sys", hatch: "system" },
    ],
    max: 21.4,
    height: 10,
    graduations: true,
  });
  assert.equal(el.className, "meter");
  assert.equal(el.getAttribute("aria-hidden"), "true");
  assert.equal(el.children.length, 3);
  assert.equal(el.style.height, "10px");
  assert.match(el.style.background, /var\(--grid-strong\)/);
  const [py, nat, sys] = el.children;
  assert.equal(py.style.backgroundColor, "var(--cpu-py)");
  assert.equal(py.style.minWidth, "2px");
  assert.equal(nat.style.width, `${((7.2 / 21.4) * 100).toFixed(3)}%`);
  assert.match(sys.style.backgroundImage, /repeating-linear-gradient\(45deg/);
  assert.equal(sys.style.backgroundColor, "var(--cpu-sys)");
  meter.updateMeter(el, { segments: [{ value: 50, token: "mem-py" }, { value: 10, token: "mem-native" }], max: 100, tick: 30 });
  assert.equal(el.children.length, 3, "2 segments + avg tick");
  assert.equal(el.children[2].className, "meter__tick");
  assert.match(el.children[2].style.cssText, /left:calc\(30\.000% - 0\.5px\)/);
  meter.updateMeter(el, { segments: [{ value: 0, token: "gpu" }], max: 100 });
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].style.minWidth, "0");
  const waiting = meter.meter(doc, { segments: [{ value: 5, token: "async", hatch: "waiting" }], max: 10 });
  assert.match(waiting.children[0].style.backgroundImage, /135deg/);
  for (const k of ["backgroundColor", "backgroundImage", "background"]) {
    for (const c of [el, ...el.children, waiting.children[0]]) assert.ok(!/#[0-9a-f]{3,6}\b/i.test(c.style[k] ?? ""), "no raw colours");
  }
});

test("sparkline geometry: shared scales, clamped negatives, max dot", () => {
  const s = Float64Array.from([0, 0, 5, 50, 10, -0.06]);
  const g = spark.sparklineGeometry(s, { tMax: 10, yMax: 100, width: 64, height: 16 });
  const pts = g.points.split(" ").map((p) => p.split(",").map(Number));
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0], [1.5, 14.5]);
  assert.deepEqual(pts[1], [32, 8]);
  assert.deepEqual(pts[2], [62.5, 14.5], "negative legacy values clamp to 0");
  assert.deepEqual(g.max, { x: 32, y: 8 });
  assert.deepEqual(spark.sparklineGeometry(new Float64Array(0), { tMax: 10, yMax: 1 }), { points: "", max: null });
  const one = spark.sparklineGeometry(Float64Array.from([2, 1]), { tMax: 4, yMax: 2 });
  assert.equal(one.points.split(" ").length, 2);
});

test("sparkline SVG: polyline + dot, leak colour, reuse keeps nodes", () => {
  const s = Float64Array.from([0, 10, 1, 20]);
  const svg = spark.sparkline(doc, s, { tMax: 2, yMax: 40 });
  assert.equal(svg.children.length, 2);
  assert.equal(svg.getAttribute("class"), "sparkline");
  assert.equal(svg.children[0].style.stroke, "var(--mem-py)");
  assert.equal(svg.children[0].getAttribute("stroke-width"), "1.25");
  const again = spark.sparkline(doc, s, { tMax: 2, yMax: 40, leak: true }, svg);
  assert.equal(again, svg);
  assert.equal(svg.children.length, 2);
  assert.equal(svg.getAttribute("class"), "sparkline is-leak");
  assert.equal(svg.children[1].style.fill, "var(--danger)");
  spark.sparkline(doc, new Float64Array(0), { tMax: 2, yMax: 40 }, svg);
  assert.equal(svg.children[1].style.display, "none");
});

test("binTimes: 2 px bins, domain edges, buffer reuse", () => {
  assert.equal(raster.binCount(795), 397);
  const b = raster.binTimes([0, 0.5, 1, 9.99, 10, 11, -1], 0, 10, 10);
  assert.deepEqual(Array.from(b), [2, 1, 0, 0, 0, 0, 0, 0, 0, 2]);
  const again = raster.binTimes([5], 0, 10, 10, b);
  assert.equal(again, b);
  assert.deepEqual(Array.from(b), [0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.equal(raster.binMax(Float32Array.from([1, 4, 2])), 4);
  assert.deepEqual(Array.from(raster.binTimes([1], 5, 5, 3)), [0, 0, 0]);
});

test("drawRaster: baseline + one bar per non-empty bin, heights ∝ count / row max", () => {
  const ctx = recordingContext();
  raster.drawRaster(ctx, Float32Array.from([0, 2, 4, 0]), R(0, 0, 8, 13), { fill: "#00f", baseline: "#ccc", alpha: 0.4 });
  const rects = ctx.calls.filter((c) => c[0] === "fillRect");
  assert.equal(rects.length, 3);
  assert.deepEqual(rects[0].slice(1), [0, 12, 8, 1], "1 px baseline at the bottom");
  assert.equal(rects[1][4], 6, "half the row max → half height");
  assert.equal(rects[2][4], 12);
  assert.ok(ctx.calls.some((c) => c[0] === "=globalAlpha" && c[1] === 0.4));
});

test("drawSampleTicks: ticks up to 300 samples, density band above", () => {
  const few = recordingContext();
  raster.drawSampleTicks(few, [1, 2, 3, 50], [0, 10], R(0, 0, 100, 40), "#00f", 0.3);
  assert.equal(count(few, "fillRect"), 3, "out-of-domain samples skipped");
  const many = recordingContext();
  const times = Array.from({ length: 500 }, (_, i) => i / 50);
  raster.drawSampleTicks(many, times, [0, 10], R(0, 0, 100, 40), "#00f", 0.3);
  assert.ok(count(many, "fillRect") <= raster.binCount(100));
  const alphas = many.calls.filter((c) => c[0] === "=globalAlpha").map((c) => c[1]);
  assert.ok(Math.max(...alphas) <= 0.5);
  const rug = recordingContext();
  raster.drawRug(rug, [1, 2], [0, 10], R(0, 50, 100, 6), "#0a0");
  assert.equal(count(rug, "fillRect"), 2);
  assert.ok(rug.calls.some((c) => c[0] === "=globalAlpha" && c[1] === 0.85));
});

test("drawSampleTicks: dense ticks never compound past 0.5 (round 1: torch.save slab)", () => {
  // ml-training train.py:120: 264 samples in 51–54 s of a 54.1 s run, plot ~600 px wide.
  const times = Array.from({ length: 264 }, (_, i) => 51 + (3 * i) / 264);
  const ctx = recordingContext();
  raster.drawSampleTicks(ctx, times, [0, 54.1], R(0, 0, 600, 120), "#044CB6", 0.3);
  const xs = new Set();
  let painted = 0;
  let alpha = 1;
  for (const c of ctx.calls) {
    if (c[0] === "=globalAlpha") alpha = c[1];
    if (c[0] !== "fillRect") continue;
    painted++;
    const key = Math.round(c[1] * 1000);
    assert.ok(!xs.has(key), "one rect per column: overlapping ticks would compound");
    xs.add(key);
    assert.ok(alpha <= 0.3 + 1e-6, `column alpha ${alpha} above the tick alpha`);
    assert.ok(alpha >= 0.3 * 0.35 - 1e-6, "a single sample stays visible");
  }
  assert.ok(painted > 20 && painted <= 40, `~33 one-px columns (got ${painted})`);
  const { alphas } = raster.tickColumnAlphas(times, [0, 54.1], 600, 0.9);
  assert.ok(Math.max(...alphas) <= raster.TICK_ALPHA_CAP, "cap 0.5 even with a high tick alpha");
});

test("drawSampleTicks: holes (peak callout) are clipped out of the band", () => {
  const ctx = recordingContext();
  raster.drawSampleTicks(ctx, [5, 5.1, 5.2], [0, 10], R(0, 0, 100, 40), "#00f", 0.45, [R(40, 5, 30, 12)]);
  assert.ok(ctx.calls.some((c) => c[0] === "clip"), "clip applied");
  const plain = recordingContext();
  raster.drawSampleTicks(plain, [5], [0, 10], R(0, 0, 100, 40), "#00f", 0.45);
  assert.ok(!plain.calls.some((c) => c[0] === "clip"));
});

test("drawFootprint: area + line, M4 above 2 × width, glow only in dark", () => {
  const pts = [];
  for (let i = 0; i < 2000; i++) pts.push(i / 100, 100 + 50 * Math.sin(i / 150)); // smooth: polyline mode
  const samples = Float64Array.from(pts);
  const light = recordingContext();
  fp.drawFootprint(light, samples, { rect: R(10, 10, 100, 60), domain: [0, 20], yMax: 200, theme: fakeTheme("light") });
  assert.equal(count(light, "fill"), 1);
  assert.equal(count(light, "stroke"), 1);
  assert.ok(count(light, "lineTo") <= 2 * (4 * 100 + 2) + 2, "downsampled");
  assert.ok(light.calls.some((c) => c[0] === "=globalAlpha" && c[1] === 0.14));
  assert.ok(!light.calls.some((c) => c[0] === "=shadowBlur"));
  const dark = recordingContext();
  fp.drawFootprint(dark, samples, { rect: R(10, 10, 100, 60), domain: [0, 20], yMax: 200, theme: fakeTheme("dark") });
  assert.ok(dark.calls.some((c) => c[0] === "=shadowBlur" && c[1] === 8));
  assert.ok(dark.calls.some((c) => c[0] === "=shadowColor" && c[1] === "rgba(0, 113, 55, 0.6)"));
  assert.ok(dark.calls.some((c) => c[0] === "=globalAlpha" && c[1] === 0.18));
  const area = recordingContext();
  fp.drawFootprint(area, samples, { rect: R(0, 0, 100, 60), domain: [0, 20], yMax: 200, theme: fakeTheme(), token: "line-strong", areaOnly: true });
  assert.equal(count(area, "stroke"), 0);
  const s = fp.footprintScales(R(0, 0, 100, 50), [0, 10], 200);
  assert.equal(s.x(5), 50);
  assert.equal(s.y(100), 25);
  assert.equal(s.y(-3), 50, "negative values draw at 0");
  assert.equal(s.t(25), 2.5);
});

test("drawFootprint: a dense oscillating series draws a min–max envelope + mean line, no glow (round 1 comb)", () => {
  // example.json-like: 2,846 samples, an allocation sawtooth that turns around every ~3 samples.
  const pts = [];
  for (let i = 0; i < 2846; i++) pts.push((i / 2846) * 12.7, 20 + (i % 3 === 0 ? 30 : 0) + (i % 7));
  const samples = Float64Array.from(pts);
  const nb = fp.envelopeBinCount(samples, 0, 12.7, 600);
  assert.ok(nb >= 8 && nb <= 300, `bins ${nb}`);
  const env = fp.envelopeBins(samples, 0, 12.7, nb);
  let total = 0;
  for (let b = 0; b < env.n; b++) total += env.count[b];
  assert.equal(total, 2846);
  for (let b = 0; b < env.n; b++) if (env.count[b]) assert.ok(env.min[b] <= env.mean[b] && env.mean[b] <= env.max[b]);
  const dark = recordingContext();
  fp.drawFootprint(dark, samples, { rect: R(0, 0, 600, 120), domain: [0, 12.7], yMax: 64, theme: fakeTheme("dark") });
  assert.ok(!dark.calls.some((c) => c[0] === "=shadowBlur"), "no glow on the envelope");
  assert.ok(dark.calls.some((c) => c[0] === "=globalAlpha" && c[1] === 0.35), "envelope band at 35 %");
  assert.ok(count(dark, "lineTo") <= 4 * nb + 4, "band + mean line: a few vertices per bin, not one per sample");
  // Smooth series and sparse series stay polylines (and keep the dark-theme glow).
  const smooth = [];
  for (let i = 0; i < 2846; i++) smooth.push((i / 2846) * 12.7, 10 + i / 100);
  assert.equal(fp.envelopeBinCount(Float64Array.from(smooth), 0, 12.7, 600), 0);
  assert.equal(fp.envelopeBinCount(Float64Array.from([0, 1, 1, 5, 2, 1, 3, 5]), 0, 3, 600), 0, "few samples");
  assert.equal(fp.turnArounds(Float64Array.from([0, 1, 1, 5, 2, 1, 3, 5, 4, 5]), 0, 4), 2);
});

test("peak marker, callout measurement and drawing", () => {
  const theme = fakeTheme();
  const ctx = recordingContext();
  fp.drawPeakMarker(ctx, { x: 5, y: 5 }, theme);
  assert.ok(ctx.calls.some((c) => c[0] === "arc" && c[3] === 4));
  const sizes = fp.measureCallout(ctx, { title: "peak 3.11 GiB", detail: "52.9 s · train.py:120" }, theme);
  assert.deepEqual(sizes.callout, { w: 21 * 6 + 12, h: 37 });
  assert.deepEqual(sizes.label, { w: 13 * 6 + 12, h: 23 });
  const draw = recordingContext();
  fp.drawCallout(draw, { kind: "callout", side: "left", rect: R(0, 0, 138, 37) }, { title: "peak 3.11 GiB", detail: "52.9 s · train.py:120" }, theme);
  assert.equal(count(draw, "fillText"), 2);
  const label = recordingContext();
  fp.drawCallout(label, { kind: "label", side: "left", rect: R(0, 0, 90, 23) }, { title: "3.11 GiB", detail: "x" }, theme);
  assert.equal(count(label, "fillText"), 1);
  const none = recordingContext();
  fp.drawCallout(none, { kind: "gutter", rect: null }, { title: "x" }, theme);
  assert.equal(none.calls.length, 0);
});

test("DOM axes carry the upstream class names and reuse their elements", () => {
  const host = doc.createElement("div");
  const { el, ticks } = axis.renderTimelineAxis(host, [0, 54.11], 795);
  assert.equal(el.className, "timeline-axis");
  assert.equal(el.getAttribute("aria-hidden"), "true");
  assert.deepEqual(el.children.filter((c) => c.className === "axis-label").map((c) => c.textContent), ["0", "10 s", "20 s", "30 s", "40 s", "50 s"]);
  assert.equal(axis.renderTimelineAxis(host, [0, 10], 795).el, el, "same element on re-render");
  assert.equal(host.children.filter((c) => c.className === "timeline-axis").length, 1);
  const grid = axis.renderTimelineGridlines(host, ticks);
  assert.equal(grid.className, "timeline-gridlines");
  assert.equal(grid.children.length, ticks.ticks.length);
  assert.match(grid.children[1].style.cssText, /background:var\(--grid\)/);
  const mem = axis.renderMemoryAxis(host, 3246.5, 600);
  assert.equal(mem.el.className, "memory-axis");
  assert.equal(mem.el.children.filter((c) => c.className === "axis-label")[1].textContent, "0.5 GiB", "one unit per axis");
  assert.equal(axis.renderMemoryGridlines(host, mem.ticks).className, "memory-gridlines");
});

test("canvas gridlines and time labels never touch", () => {
  const ctx = recordingContext();
  const set = axis.timeTicks(0, 54.11, 795);
  axis.drawVGridlines(ctx, set, R(100, 0, 795, 300), "rgba(0,0,0,0.06)", 2);
  assert.equal(count(ctx, "moveTo"), set.ticks.length);
  const x = ctx.calls.find((c) => c[0] === "moveTo")[1];
  assert.equal(x, axis.crisp(100, 2));
  const labels = recordingContext();
  const rects = axis.drawTimeLabels(labels, axis.timeTicks(0, 54.11, 795), R(0, 0, 60, 20), 15, { font: "12px x", color: "#000" });
  for (let i = 1; i < rects.length; i++) assert.ok(rects[i].x >= rects[i - 1].x + rects[i - 1].w + 6);
  assert.ok(rects.length < set.ticks.length, "crowded labels are dropped");
  const h = recordingContext();
  axis.drawHGridlines(h, axis.memoryScale(3184.65).ticks, R(0, 0, 100, 100), "#eee", 1);
  assert.equal(count(h, "moveTo"), 3);
});
