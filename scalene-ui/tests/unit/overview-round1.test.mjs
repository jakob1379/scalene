// Overview review round 1 (design/review/round-1/fix-overview.md): pure-logic guards for the
// fixes — callout vs. trace, width-independent THREADS scale, short-host presence, PHASE group
// naming, caption wording and denominators, in-place hotspot expansion, compact headline.
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const L = mod("views/overview/scope-layout");
const ro = mod("views/overview/readouts");
const hs = mod("views/overview/hotspots");
const hl = mod("views/overview/headline");

// ── Peak callout never covers the trace it annotates ───────────────────────

/** A rising footprint that peaks near the right edge (ml-training's shape). */
function rising(x0, w, yTop, yBottom) {
  const xy = [];
  for (let i = 0; i <= w; i += 2) {
    const f = i / w;
    const y = f < 0.95 ? yBottom - (yBottom - yTop) * (0.55 + 0.35 * f) : yBottom - (yBottom - yTop) * (f < 0.975 ? 1 : 0.7);
    xy.push(x0 + i, y);
  }
  return xy;
}

function clear(rect, band, margin = 4) {
  for (let c = 0; c < band.top.length; c++) {
    const x = band.x0 + c;
    if (Number.isNaN(band.top[c]) || x < rect.x - margin || x > rect.x + rect.w + margin) continue;
    if (band.top[c] <= rect.y + rect.h + margin && band.bottom[c] >= rect.y - margin) return false;
  }
  return true;
}

test("traceBand: per-column extent of a polyline, interpolated between points", () => {
  const b = L.traceBand([0, 10, 10, 20], 0, 11);
  assert.equal(b.top[0], 10);
  assert.ok(Math.abs(b.top[5] - 15) < 1e-6 && Math.abs(b.bottom[5] - 16) < 1e-6);
  assert.equal(b.bottom[10], 20);
  assert.deepEqual(L.bandExtent(b, 0, 10), { top: 10, bottom: 20 });
  assert.equal(L.hitsTrace({ x: 2, y: 30, w: 4, h: 4 }, b, 4), false);
  assert.equal(L.hitsTrace({ x: 2, y: 14, w: 4, h: 4 }, b, 4), true);
});

test("peak callout: placed clear of the trace, else the one-line label, else the gutter", () => {
  for (const [w, h] of [[786, 72], [596, 177], [265, 72], [402, 76], [1300, 132]]) {
    const mem = { x: 100, y: 30, w, h };
    const xy = rising(mem.x, w, mem.y + 0.22 * h, mem.y + h - 1);
    const band = L.traceBand(xy, mem.x, w);
    // the dot sits on the trace's highest point
    let best = 0;
    for (let c = 1; c < band.top.length; c++) if (band.top[c] < band.top[best]) best = c;
    const dot = { x: mem.x + best, y: band.top[best] };
    const plan = L.planPeakClear({ dot, callout: { w: 118, h: 37 }, label: { w: 96, h: 23 }, bounds: mem, reserved: [{ x: dot.x - 5, y: dot.y - 5, w: 10, h: 10 }], trace: band });
    if (plan.kind === "gutter") continue;
    assert.ok(clear(plan.rect, band), `${w}×${h}: ${plan.kind} at ${plan.spot} covers the trace`);
    assert.ok(plan.rect.x >= mem.x + 2 && plan.rect.x + plan.rect.w <= mem.x + w - 2, `${w}×${h} inside x`);
    assert.ok(plan.rect.y >= mem.y + 2 && plan.rect.y + plan.rect.h <= mem.y + h - 2, `${w}×${h} inside y`);
  }
});

test("peak callout: a tall channel keeps the two-line callout (beside, above or below the trace)", () => {
  const mem = { x: 0, y: 0, w: 600, h: 180 };
  const xy = [];
  for (let x = 0; x <= 600; x += 3) xy.push(x, 90 + 40 * Math.sin(x / 40) - (x > 290 && x < 310 ? 60 : 0));
  const band = L.traceBand(xy, 0, 600);
  const plan = L.planPeakClear({ dot: { x: 300, y: band.top[300] }, callout: { w: 120, h: 37 }, label: { w: 90, h: 23 }, bounds: mem, reserved: [], trace: band });
  assert.equal(plan.kind, "callout");
  assert.ok(clear(plan.rect, band));
});

// ── THREADS: one scale at every width ──────────────────────────────────────

test("THREADS windows are fixed in time: the same bucket count at every plot width", () => {
  assert.equal(L.threadBucketCount(54.1, 0.01), 541); // windows of max(10·dt, tMax/600) = 0.1 s
  assert.equal(L.threadBucketCount(227, 0.01), 600);
  assert.equal(L.threadBucketCount(1.68, 0.01), 17);
  assert.equal(L.threadBucketCount(0, 0.01), 16);
});

test("maxConcurrent: instantaneous maximum of half-open intervals", () => {
  assert.equal(L.maxConcurrent([0, 1, 2], [2, 3, 4]), 2);
  assert.equal(L.maxConcurrent([0, 1], [1, 2]), 1, "an interval ending at t does not overlap one starting at t");
  assert.equal(L.maxConcurrent([0, 0, 0], [1, 1, 1], (i) => i !== 1), 2);
  assert.equal(L.maxConcurrent([], []), 0);
});

withModel("ml-training", "THREADS: the concurrency sentence and axis are width-independent (5 threads at once)", async (m) => {
  const tl = await m.timeline();
  if (!tl) return;
  const CLS = mod("model/classify");
  const busy = (i) => !(tl.stackBits[tl.stack[i]] & (CLS.CLS_GIL | CLS.CLS_IO));
  assert.equal(L.maxConcurrent(tl.t0, tl.t1, busy), 5);
  const nb = L.threadBucketCount(m.tMax, m.sampling.dt);
  const b = tl.bucketize(nb, 0, m.tMax);
  let max = 0;
  for (let k = 0; k < nb; k++) max = Math.max(max, b.busy[k] + b.gil[k] + b.wait[k]);
  assert.ok(Math.ceil(max - 1e-6) <= 5);
});

// ── Short hosts and TOP LINES presence ─────────────────────────────────────

test("short hosts keep TOP LINES (5 rows) when it is the only channel; side layouts show 8", () => {
  const short = L.scopeMetrics("sm", true, false);
  const cpu = { phase: true, memory: false, threads: false, tasks: false, topRows: 8 };
  assert.deepEqual(L.effectivePresence(cpu, short), { ...cpu, phase: false, topRows: 5 });
  assert.equal(L.anyChannel(L.effectivePresence(cpu, short)), true, "never an empty signal card in a 400 px host");
  const lg = L.scopeMetrics("lg", false, false);
  assert.equal(L.effectivePresence(cpu, lg, true).topRows, 8, "TOP 8 = the visible hotspots when the strips are the signal");
  assert.equal(L.effectivePresence(cpu, lg, false).topRows, 5);
  const ml = { phase: true, memory: true, threads: true, tasks: false, topRows: 8 };
  assert.equal(L.effectivePresence(ml, lg, true).topRows, 5);
  assert.equal(L.effectivePresence(ml, short).topRows, 0);
  const none = { phase: true, memory: false, threads: false, tasks: false, topRows: 0 };
  assert.equal(L.anyChannel(L.effectivePresence(none, short)), false, "→ the scope hides, hotspots take the width");
});

// ── PHASE groups named by their dominant member ────────────────────────────

test("phase groups: a member covering ≥ 50 % of the group's time names it (×count)", () => {
  const loop = (i) => ({ key: "s.py:10", label: "while time.monotonic() < deadline", t0: i * 8, t1: i * 8 + 6 });
  const other = (i) => ({ key: `o${i}`, label: `other ${i}`, t0: i * 8, t1: i * 8 + 2 });
  const cells = L.layoutPhaseCells([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (i % 3 === 2 ? other(i) : loop(i))), (t) => t);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].kind, "group");
  assert.deepEqual({ label: cells[0].dominant.label, count: cells[0].dominant.count }, { label: "while time.monotonic() < deadline", count: 7 });
  const mixed = L.layoutPhaseCells([0, 1, 2, 3].map((i) => ({ key: `k${i}`, label: `p${i}`, t0: i * 8, t1: i * 8 + 6 })), (t) => t);
  assert.equal(mixed[0].dominant, null);
});

// ── Readout wording and denominators ───────────────────────────────────────

test("readout captions: method phrase split into short phrases, Peak line 2 says what it is", () => {
  assert.equal(ro.rewriteCaption("mean while the main thread ran (time-weighted)"), "mean · main thread · time-weighted");
  assert.equal(ro.rewriteCaption("growth 52.2% · +212 MiB native threads"), "52.2% stayed live · 212 MiB from native threads");
  assert.equal(ro.rewriteCaption("growth 15.9%"), "15.9% stayed live");
  assert.equal(ro.rewriteCaption("at 52.9 s"), "at 52.9 s");
});

withModel("cpu-only", "Busiest function: 'of run' first, also in the compact caption (must-fix 31)", (m) => {
  const b = m.readouts.find((r) => r.kind === "busiest");
  const lines = ro.captionLines(b, m.elapsed).map((l) => l.map((s) => s.s).join(""));
  assert.match(lines[0], /^of run · accelerations\(\) · nbody\.py:32 · 19\.3\s?s$/);
  assert.equal(ro.shortCaption(b), "of run · accelerations()");
  const zero = ro.captionLines(b, 0).map((l) => l.map((s) => s.s).join(""));
  assert.equal(zero[0], "of run · accelerations() · nbody.py:32", "elapsed 0: no seconds (§4.0.8)");
});

// ── Hotspots: expansion in place ───────────────────────────────────────────

test("hotspot list expands in place 8 → 25 → 50 → all", () => {
  assert.equal(hs.nextExpansion(8, 108), 25);
  assert.equal(hs.nextExpansion(25, 108), 50);
  assert.equal(hs.nextExpansion(50, 108), 108);
  assert.equal(hs.nextExpansion(108, 108), null);
  assert.equal(hs.nextExpansion(8, 29), 25);
  assert.equal(hs.nextExpansion(8, 10), 10);
  assert.equal(hs.nextExpansion(8, 8), null);
  assert.ok(hs.M8.leave <= hs.M8.moveDelay + 30, "leaving rows are (almost) gone before rows move");
});

// ── Compact event-loop headline (≤ 4 lines on phones) ──────────────────────

withModel("async-server", "compact headline keeps the numbers and chips of the full sentence", (m) => {
  const c = hl.compactSegments(m.headline.segments);
  assert.ok(c, "event-loop branch has a compact form");
  const text = c.map((s) => s.s).join("");
  assert.match(text, /^bench_server\.py ran for 15\.7\s?s\. 59\.6% is the event loop, mostly waiting; hashlib\.pbkdf2_hmac\(…\) \(21\.6%\) blocks it\.$/);
  assert.ok(text.length < m.headline.plain.length * 0.6);
  assert.equal(c.filter((s) => s.t === "code").length, 1);
});

withModel("ml-training", "no compact form outside the event-loop branch", (m) => {
  assert.equal(hl.compactSegments(m.headline.segments), null);
});
