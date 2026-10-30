// WP4 timeline logic (DESIGN.md §4.12, §4.0.6–4.0.7): row layout per breakpoint, domain math,
// classified GC / I/O & waits / GIL intervals vs the model's lane totals (Appendix A), run ends,
// thread filter values (incl. "unknown"), collapsed-lane activity, segment hit/describe/announce,
// and renderTimelineFrames (LOD columns, labels, Interleaved borders) on a recording canvas.
import assert from "node:assert/strict";
import { mod, test, withModel, fixture } from "./_harness.mjs";
import { recordingContext } from "./_dom.mjs";

const lay = mod("views/timeline/layout");
const fr = mod("views/timeline/frames");
const { CLS_GC, CLS_IO, CLS_GIL } = mod("model/classify");

const lanesOf = (tl) => tl.threads.map((t) => ({ idx: t.idx, key: t.label, maxDepth: tl.maxDepth[t.idx] }));

function anyTheme(mode = "light") {
  const tokens = new Proxy({}, { get: (_t, k) => (k === "font-mono" ? "monospace" : k === "frame-dim" ? "0.78" : "#7d8ba3") });
  return { current: () => mode, set() {}, tokens: () => tokens, num: (n) => (n === "frame-dim" ? 0.78 : n.endsWith("ink-split") ? 4 : 0) };
}

test("gutter and depth cap per breakpoint (§2.4.4)", () => {
  assert.equal(lay.gutterFor("lg", false), 168);
  assert.equal(lay.gutterFor("md", false), 168);
  assert.equal(lay.gutterFor("sm", false), 120);
  assert.equal(lay.gutterFor("lg", true), 120);
  assert.equal(lay.gutterFor("xs", false), 0);
  assert.equal(lay.depthCap("lg", false), 16);
  assert.equal(lay.depthCap("xs", false), 8);
  assert.equal(lay.depthCap("md", true), 6);
});

test("domain math: clamp, zoom around a time, pan", () => {
  assert.deepEqual(lay.clampDomain(-5, 5, 100, 1), [0, 10]);
  assert.deepEqual(lay.clampDomain(95, 105, 100, 1), [90, 100]);
  assert.deepEqual(lay.clampDomain(10, 10.1, 100, 1), [10, 11], "minimum span");
  assert.deepEqual(lay.clampDomain(0, 500, 100, 1), [0, 100]);
  const z = lay.zoomAround([0, 100], 25, 0.5, 100, 1);
  assert.deepEqual(z, [12.5, 62.5], "the time under the pointer stays put");
  assert.deepEqual(lay.panBy([10, 20], 0.1, 100, 1), [11, 21]);
  assert.deepEqual(lay.panBy([0, 20], -0.5, 100, 1), [0, 20]);
  assert.equal(lay.minSpan(0.01, 54), 0.04);
});

withModel("ml-training", "layout (lg): axis → memory → GC/I/O/GIL → lanes; main expanded with 16 of 19 levels", async (m) => {
  const tl = await m.timeline();
  const L = lay.computeLayout({ width: 1300, bp: "lg", short: false, view: "lanes", filter: null, lanes: lanesOf(tl), expanded: new Set(["main"]), full: new Set(), memory: true });
  assert.deepEqual(L.items.map((i) => i.kind), ["axis", "memory", "class", "class", "class", "lane", "lane", "lane", "lane", "lane"]);
  assert.equal(L.gutter, 168);
  assert.equal(L.plotX, 168);
  const main = L.items.find((i) => i.kind === "lane" && i.laneKey === "main");
  assert.equal(main.expanded, true);
  assert.equal(main.depthShown, 16);
  assert.equal(main.depthTotal, 19);
  assert.equal(L.rows.length, 16, "keyboard rows = visible depth rows");
  const worker = L.items.find((i) => i.kind === "lane" && i.laneKey === "thread 1");
  assert.equal(worker.expanded, false);
  assert.equal(worker.h, lay.HEAD_H);
  for (let i = 1; i < L.items.length; i++) assert.ok(L.items[i].y >= L.items[i - 1].y + L.items[i - 1].h, "rows never overlap");
  const all = lay.computeLayout({ width: 1300, bp: "lg", short: false, view: "lanes", filter: null, lanes: lanesOf(tl), expanded: new Set(["main"]), full: new Set(["main"]), memory: true });
  assert.equal(all.items.find((i) => i.laneKey === "main").depthShown, 19, "+ show all 19 levels");
});

withModel("ml-training", "layout: Interleaved = one panel; thread filter = one expanded lane; xs puts labels above", async (m) => {
  const tl = await m.timeline();
  const base = { width: 1300, bp: "lg", short: false, lanes: lanesOf(tl), expanded: new Set(["main"]), full: new Set(), memory: true };
  const inter = lay.computeLayout({ ...base, view: "interleaved", filter: null });
  const panel = inter.items.find((i) => i.kind === "inter");
  assert.ok(panel && !inter.items.some((i) => i.kind === "lane"));
  assert.deepEqual(panel.lanes, [0, 1, 2, 3, 4]);
  assert.equal(panel.depthShown, 16);
  const filt = lay.computeLayout({ ...base, view: "interleaved", filter: 3 });
  const lanes = filt.items.filter((i) => i.kind === "lane");
  assert.equal(lanes.length, 1, "a thread filter overrides Interleaved");
  assert.equal(lanes[0].lane, 3);
  assert.equal(lanes[0].expanded, true);
  const xs = lay.computeLayout({ ...base, width: 358, bp: "xs", view: "lanes", filter: null });
  assert.equal(xs.gutter, 0);
  assert.equal(xs.above, true);
  assert.equal(xs.plotW, 358);
  assert.ok(xs.items.find((i) => i.kind === "memory").labelY !== null);
  assert.equal(xs.items.find((i) => i.laneKey === "main").depthShown, 8);
  const short = lay.computeLayout({ ...base, width: 1000, bp: "md", short: true, view: "lanes", filter: null });
  assert.equal(short.gutter, 120);
  assert.equal(short.items.find((i) => i.laneKey === "main").depthShown, 6);
});

withModel("ml-training", "GC / I/O & waits / GIL intervals add up to the model's lane totals (0.6 / 2.8 / 0.9)", async (m) => {
  const tl = await m.timeline();
  const lt = m.sampling.laneTotals;
  for (const [bit, key, golden] of [
    [CLS_GC, "gc", "0.6%"],
    [CLS_IO, "io", "2.8%"],
    [CLS_GIL, "gil", "0.9%"],
  ]) {
    const iv = lay.classIntervals(tl, bit, null);
    let samples = 0;
    for (let i = 0; i < iv.n; i++) {
      samples += iv.samples[i];
      assert.ok(iv.b[i] >= iv.a[i]);
      if (i > 0) assert.ok(iv.a[i] > iv.b[i - 1], "merged intervals are disjoint and sorted");
    }
    const pct = (100 * samples) / lt.samples;
    assert.ok(Math.abs(pct - lt[key]) < 1e-9, `${key}: ${pct} vs ${lt[key]}`);
    assert.equal(mod("core/format").fmtPct(lt[key]), golden);
  }
  // Per-thread shares (thread filter) are relative to that thread's samples.
  const t2 = lay.laneClassShares(tl, 2);
  assert.ok(t2.gil >= 0 && t2.gil <= 100);
  assert.equal(lay.intervalAt(lay.classIntervals(tl, CLS_GC, null), -10), -1);
});

withModel("huge", "huge lane totals (2.1 / 4.0 / 1.6) from the same intervals", async (m) => {
  const tl = await m.timeline();
  const lt = m.sampling.laneTotals;
  const fmt = mod("core/format").fmtPct;
  for (const [bit, key, golden] of [
    [CLS_GC, "gc", "2.1%"],
    [CLS_IO, "io", "4.0%"],
    [CLS_GIL, "gil", "1.6%"],
  ]) {
    const iv = lay.classIntervals(tl, bit, null);
    let s = 0;
    for (let i = 0; i < iv.n; i++) s += iv.samples[i];
    assert.equal(fmt((100 * s) / lt.samples), golden);
  }
});

withModel("ml-training", "run ends (§4.0.7): min(next same-thread t, t + count × dt), per thread", async (m) => {
  const tl = await m.timeline();
  for (let lane = 0; lane < tl.threads.length; lane++) {
    const idx = tl.byThread[lane];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const nominal = tl.t0[i] + tl.count[i] * tl.dt;
      // Next *later* timestamp of the same thread.
      let next = Infinity;
      for (let j = k + 1; j < idx.length; j++) if (tl.t0[idx[j]] > tl.t0[i]) { next = tl.t0[idx[j]]; break; }
      const expect = next < nominal ? next : nominal;
      assert.ok(Math.abs(tl.t1[i] - expect) < 1e-9, `lane ${lane} run ${k}: ${tl.t1[i]} vs ${expect}`);
    }
  }
});

withModel("ml-training", "thread filter values round-trip (main, thread id, all)", async (m) => {
  const tl = await m.timeline();
  assert.equal(lay.laneForFilter(tl, "all"), null);
  assert.equal(lay.laneForFilter(tl, "main"), 0);
  assert.equal(lay.laneForFilter(tl, "interleaved"), null);
  const t3 = tl.threads[3];
  assert.equal(lay.laneForFilter(tl, String(t3.id)), 3);
  assert.equal(lay.laneForFilter(tl, "thread 3"), 3);
  assert.equal(lay.laneForFilter(tl, "nope"), null);
  for (let i = 0; i < tl.threads.length; i++) assert.equal(lay.laneForFilter(tl, lay.filterValueFor(tl, i)), i);
  assert.equal(lay.filterValueFor(tl, null), "all");
});

test("thread filter 'unknown' on a synthetic profile (a worker without thread_id)", async () => {
  const raw = structuredClone(fixture("ml-training"));
  if (!raw) return;
  const main = raw.main_thread_id;
  const worker = raw.combined_stacks_timeline.find((e) => e.thread_id !== main).thread_id;
  for (const e of raw.combined_stacks_timeline) if (e.thread_id === worker) delete e.thread_id;
  const m = mod("model/model").buildModel(raw, { version: "test" });
  const tl = await m.timeline();
  const unknown = lay.laneForFilter(tl, "unknown");
  assert.notEqual(unknown, null);
  assert.equal(tl.threads[unknown].id, null);
  assert.equal(tl.threads[unknown].label, "unknown");
  assert.equal(unknown, 1, "lane order: main, unknown, then first appearance");
  assert.equal(lay.filterValueFor(tl, unknown), "unknown");
  const L = lay.computeLayout({ width: 1300, bp: "lg", short: false, view: "lanes", filter: unknown, lanes: lanesOf(tl), expanded: new Set(), full: new Set(), memory: true });
  assert.deepEqual(L.items.filter((i) => i.kind === "lane").map((i) => i.laneKey), ["unknown"]);
  assert.ok(lay.classIntervals(tl, CLS_GC, unknown).n >= 0);
});

withModel("ml-training", "collapsed-lane activity: coverage per column, majority leaf kind", async (m) => {
  const tl = await m.timeline();
  const lane = 1;
  const mr = lay.maxRunLength(tl, lane);
  assert.ok(mr > 0 && mr < m.tMax);
  const a = lay.laneActivity(tl, lane, 0, m.tMax, 500, mr);
  let covered = 0;
  for (let c = 0; c < 500; c++) {
    assert.ok(a.cov[c] >= 0 && a.cov[c] <= 1 + 1e-6, "one thread covers at most the whole column");
    assert.ok(a.kind[c] <= 2);
    covered += a.cov[c];
  }
  let busy = 0;
  for (const i of tl.byThread[lane]) busy += tl.t1[i] - tl.t0[i];
  assert.ok(Math.abs((covered * m.tMax) / 500 - busy) < 1e-6 * Math.max(1, busy), "Σ coverage × column = Σ run lengths");
  const again = lay.laneActivity(tl, lane, 10, 20, 500, mr, a.scratch);
  assert.equal(again.scratch, a.scratch, "scratch buffers are reused");
});

withModel("ml-training", "segments: hit, describe (source via sourceLookup), announce", async (m) => {
  const tl = await m.timeline();
  const row = tl.segments(0).rows[1];
  let best = 0;
  for (let i = 1; i < row.n; i++) if (row.samples[i] > row.samples[best]) best = i;
  const mid = (row.t0[best] + row.t1[best]) / 2;
  assert.equal(fr.segmentAt(tl, 0, 1, mid), best);
  assert.equal(fr.segmentAt(tl, 0, 1, -1), -1);
  const ref = fr.segmentRef(tl, 0, 1, best);
  assert.equal(ref.frame.kind, "py");
  const lookups = [];
  const tip = fr.describeSegment(tl, ref, (f, l) => (lookups.push([f, l]), "for step in range(cfg.max_steps):"));
  assert.deepEqual(lookups, [[ref.frame.filename_or_module, ref.frame.line]], "the source line comes from sourceLookup");
  assert.equal(tip.kind, "PYTHON FRAME");
  const rows = Object.fromEntries(tip.rows);
  assert.match(rows.Thread, /^main \(id \d+\)$/);
  assert.match(rows.Time, /^\d+\.\d{3} s – \d+\.\d{3} s · /);
  assert.equal(tip.code, "for step in range(cfg.max_steps):");
  assert.match(fr.announceSegment(tl, ref), /^train, train\.py line \d+, main thread, Python frame, .+ to .+, [\d,]+ samples?$/);
  assert.equal(fr.threadText(tl.threads[1]), `thread 1 (id ${tl.threads[1].id})`);
});

withModel("ml-training", "renderTimelineFrames: LOD columns at full range, labels when ≥ 40 px, hit tester", async (m) => {
  const tl = await m.timeline();
  const ctx = recordingContext();
  const panel = fr.renderTimelineFrames(
    { ctx2d: ctx, tl, lanes: [0], interleaved: false, x: 168, y: 100, w: 1100, rowH: 12, depth: 16, domain: [0, m.tMax], theme: anyTheme(), dpr: 1 },
    () => "",
  );
  const fills = ctx.calls.filter((c) => c[0] === "fillRect");
  const lod = ctx.calls.filter((c, i) => c[0] === "=fillStyle" && c[1] === "#7d8ba3").length;
  assert.ok(fills.length > 50, `${fills.length} rects`);
  assert.ok(fills.length < 20000, "sub-pixel runs are merged into LOD columns");
  assert.ok(lod > 0);
  assert.ok(ctx.calls.some((c) => c[0] === "fillText" && /^<module>/.test(c[1])), "the root frame is labelled");
  for (const [, x, , w] of fills) assert.ok(x >= 168 - 1 && x + w <= 168 + 1100 + 1.01, "clipped to the plot");
  const hit = panel.hit(168 + 550, 100 + 6);
  assert.ok(hit && hit.depth === 0 && hit.lane === 0);
  assert.equal(panel.hit(10, 106), null, "the gutter is not the plot");
  // Interleaved: thread borders.
  const ctx2 = recordingContext();
  fr.renderTimelineFrames(
    { ctx2d: ctx2, tl, lanes: [0, 1, 2, 3, 4], interleaved: true, x: 168, y: 0, w: 1100, rowH: 12, depth: 9, domain: [20, 21], theme: anyTheme(), dpr: 2 },
    () => "",
  );
  assert.ok(ctx2.calls.filter((c) => c[0] === "fillRect" && c[3] === 3).length > 0, "3 px thread borders in Interleaved");
});
