// Shared derivations for views: §4.0.3 phrases, §4.0.4 thresholds and column
// presence, §4.13.3 allocation sites, §4.11 flame search / labels / colour
// helpers, and the main-thread leaf frame at a time (scope, timeline).
import assert from "node:assert/strict";
import { lineOf, loc, mod, test, withModel } from "./_harness.mjs";

const ph = mod("model/phrases");
const th = mod("model/thresholds");
const st = mod("model/stacks");
const { allocationSites } = mod("model/sites");

test("phrases: the fixed vocabulary of §4.0.3", () => {
  assert.equal(ph.ofRun(21.38, 11.57), "21.4% of run · 11.6\u00a0s");
  assert.equal(ph.ofRun(21.38, 11.57, true), "21.4% of run");
  assert.equal(ph.splitParts(0.1, 7.2, 14.1), "Python 0.1% · native 7.2% · system 14.1% (of run)");
  assert.equal(ph.fileShare(58.8, 54.11), "58.8% of run · 31.8\u00a0s of 54.1\u00a0s");
  assert.equal(ph.outside(0.39), "0.4% outside profiled files");
  assert.equal(ph.outside(0.04), null);
  assert.equal(ph.outside(-1e-14), null);
  assert.equal(ph.cores(0.012), "1.2% of all cores while it ran");
  assert.equal(ph.cores(0.012, true), "cores 1.2%");
  assert.equal(ph.linePeak(1229), "peak 1.20\u00a0GiB attributed to this line");
  assert.equal(ph.linePeak(1229, true), "peak 1.20\u00a0GiB");
  assert.equal(ph.allocShare(0.33), "33.0% of all allocation");
  assert.equal(ph.allocShare(0.33, true), "33.0% of alloc.");
  assert.equal(ph.allocated(1229), "1.20\u00a0GiB allocated over the run (sampled)");
  assert.equal(ph.copied(21.955), "22.0\u00a0MiB/s copied (average over run)");
  assert.equal(ph.copied(21.955, true), "22.0\u00a0MiB/s");
  assert.equal(ph.gpuBusy(96.4), "96.4% busy while this line ran");
  assert.equal(ph.gpuBusy(96.4, true), "96.4% busy");
  assert.equal(ph.gpuMethod("main-thread"), "mean while the main thread ran profiled lines (time-weighted)");
  assert.equal(ph.gpuMethod("main-thread", true), "mean while running");
  assert.equal(ph.gpuMemory(), "peak device memory (process) while this line ran");
  assert.equal(ph.awaitShare(35.8), "35.8% of await time");
  assert.equal(ph.awaitShare(35.8, true), "of await");
  assert.equal(ph.concurrency(15.49, 22), "15.5 tasks suspended on average, 22 at most");
  assert.equal(ph.concurrency(15.49, 22, true), "15.5 / 22 tasks");
  assert.equal(ph.deviceTime(9690, 26.16), "9.69\u00a0s · 37.0% of run");
  assert.equal(ph.deviceTime(9690, 26.16, true), "37.0% of run");
  assert.equal(ph.deviceIdle(12.4), "12.4% of this line's CPU samples had the device idle");
  assert.equal(ph.deviceIdle(12.4, true), "idle 12.4%");
  assert.equal(ph.ofSamples(0.56), "0.6% of samples");
  assert.equal(ph.threadsSampled(4.2), "4.2 threads sampled");
  assert.equal(ph.growth(52.2483), "52.2% of allocated memory stayed live");
  assert.equal(ph.growth(140, true), "growth 100%");
  assert.equal(ph.leak({ velocity: 5.712, likelihood: 0.9968 }), "possible leak · grows ~5.71\u00a0MiB/s · likelihood 99.7%");
  assert.equal(ph.leak({ velocity: 5.712, likelihood: 0.9968 }, true), "leak · grows 5.71\u00a0MiB/s");
  assert.equal(ph.region(152, 184, 43.42), "Region 152–184: 43.4% of run");
  assert.equal(ph.stackPresence(1157, 5901), "in 1,157 of 5,901 stack samples (19.6%)");
  assert.equal(ph.missing(false), "not recorded");
  assert.equal(ph.missing(true), "none sampled");
  assert.equal(ph.missing(true, true), "—");
  assert.equal(ph.FLAME_CPU_DENOMINATOR, "% of sampled stacks — not of run time");
});

const COLUMNS = {
  "ml-training": ["line", "time", "mem", "gpu", "trend", "copy", "gpumem", "alloc", "avg", "source"],
  "cpu-only": ["line", "time", "source"],
  neuron: ["line", "time", "mem", "idle", "nrt", "nc", "trend", "alloc", "avg", "source"],
  "async-server": ["line", "time", "mem", "await", "trend", "alloc", "avg", "source"],
};

for (const [name, cols] of Object.entries(COLUMNS)) {
  withModel(name, `profile columns: ${cols.join(", ")}`, (m) => {
    assert.deepEqual(th.profileColumns(m), cols);
  });
}

withModel("ml-training", "cell thresholds (§4.0.4 / §4.8.4)", (m) => {
  const c = m.caps;
  const save = lineOf(m, "train.py:120");
  assert.equal(th.cellHasValue(save, "copy", c), true);
  assert.equal(th.cellHasValue(save, "alloc", c), true);
  const top = lineOf(m, "train.py:173");
  assert.equal(th.cellHasValue(top, "gpu", c), true);
  assert.equal(th.cellHasValue(top, "gpumem", c), true);
  assert.equal(th.cellHasValue(top, "mem", c), false, "peak 0 → empty (row label says 'none sampled')");
  assert.equal(th.cellHasValue(lineOf(m, "train.py:1"), "time", c), false);
  assert.equal(th.cellHasValue(lineOf(m, "metrics.py:42"), "trend", c), true);
  assert.equal(th.cellHasValue(top, "await", c), false);
});

withModel("neuron", "idle cell and bands", (m) => {
  const l = lineOf(m, "infer_bert.py:66");
  assert.equal(th.cellHasValue(l, "idle", m.caps), true);
  assert.equal(th.cellHasValue(l, "nrt", m.caps), true);
  assert.equal(th.cellHasValue(l, "nc", m.caps), true);
  assert.equal(th.cellHasValue(l, "gpu", m.caps), false, "GPU hidden with Neuron data");
  assert.deepEqual(th.idleBand(l.neuron.idlePct), { band: "low", glyph: "●", token: "band-low" });
  assert.deepEqual(th.idleBand(45), { band: "medium", glyph: "◆", token: "band-mid" });
  assert.deepEqual(th.idleBand(60), { band: "high", glyph: "▲", token: "band-high" });
  const tok = lineOf(m, "preprocess.py:45");
  assert.equal(th.idleBand(tok.neuron.idlePct).band, "high");
});

withModel("ml-training", "heat wash: value / profile max, floored at 0.25 when present", (m) => {
  const top = lineOf(m, "train.py:173");
  assert.equal(th.heatOf(m, top, "time"), 1);
  assert.equal(th.heatOf(m, lineOf(m, "train.py:145"), "time"), 0.25, "3.6% / 21.4% < 0.25 → floor");
  assert.equal(th.heatOf(m, lineOf(m, "train.py:1"), "time"), 0);
  assert.ok(Math.abs(th.heatOf(m, lineOf(m, "train.py:165"), "time") - 16.23 / 21.38) < 0.01);
  assert.equal(th.heatOf(m, lineOf(m, "train.py:120"), "mem"), 1);
  assert.ok(th.heatOf(m, top, "gpu") > 0.9);
  assert.equal(th.heatMetric("mem"), "mem");
  assert.equal(th.heatMetric("copy"), "time");
  assert.equal(th.heatMetric(null), "time");
  assert.equal(th.HEAT_WASH.await, "wash-await");
  assert.equal(th.heatForMetric("memory"), "mem");
});

withModel("ml-training", "allocation sites: peak / allocated, leaks pinned, default = most likely leak", (m) => {
  const peak = allocationSites(m, "peak", 8);
  assert.equal(loc(peak.rows[0]), "train.py:120");
  assert.equal(peak.scale, m.memory.peak);
  assert.equal(loc(peak.defaultSite), "metrics.py:42");
  for (const l of peak.pinnedLeaks) assert.ok(!peak.rows.includes(l));
  assert.equal(peak.rows.length + peak.more, m.rank.lines.memory.length);
  const alloc = allocationSites(m, "allocated", 3);
  for (let i = 1; i < alloc.rows.length; i++) assert.ok(alloc.rows[i - 1].malloc >= alloc.rows[i].malloc);
  assert.equal(alloc.scale, alloc.rows[0].usage);
  assert.equal(allocationSites(m, "allocated", 3).rows[0], alloc.rows[0], "memoised ranking");
});

withModel("cpu-only", "no allocation sites", (m) => {
  const s = allocationSites(m, "peak");
  assert.deepEqual(s.rows, []);
  assert.equal(s.defaultSite, null);
});

withModel("ml-training", "flame search: share counts each matching stack once", async (m) => {
  const tree = await m.flame("cpu");
  const r = st.searchFlame(tree, "train");
  assert.ok(r.matches.length > 0);
  assert.ok(r.share > 0 && r.share <= 100);
  // Every stack passes through `<module>` in train.py → basename match covers everything.
  assert.ok(Math.abs(r.share - (100 * r.outermost.reduce((a, n) => a + n.total, 0)) / tree.total) < 1e-9);
  for (const n of r.outermost) for (let p = n.parent; p; p = p.parent) assert.ok(!r.matches.includes(p));
  const none = st.searchFlame(tree, "no-such-frame-xyz");
  assert.deepEqual([none.matches.length, none.share], [0, 0]);
  assert.equal(st.searchFlame(tree, "  ").matches.length, 0);
  const sync = st.searchFlame(tree, "cudastreamsynchronize");
  assert.ok(sync.share > 0 && sync.share < r.share);
});

test("simplifyNativeName collapses templates and parameter lists", () => {
  const long =
    "at::autocast::WrapFunction_<at::autocast::CastPolicy, (c10::DeviceType)1, at::Tensor (at::Tensor const&, at::Tensor const&), &at::_ops::linear::call, at::Tensor, c10::guts::typelist::typelist<at::Tensor const&>>::call(at::Tensor const&, at::Tensor const&)";
  assert.equal(st.simplifyNativeName(long), "at::autocast::WrapFunction_<…>::call(…)");
  assert.equal(st.simplifyNativeName("std::vector<int, std::allocator<int>>::push_back(int const&)"), "std::vector<…>::push_back(…)");
  assert.equal(st.simplifyNativeName("cblas_dgemm"), "cblas_dgemm");
  assert.equal(st.simplifyNativeName("foo()"), "foo()");
  assert.equal(st.simplifyNativeName("std::ostream::operator<<(int)"), "std::ostream::operator<<(…)");
  assert.equal(st.simplifyNativeName("Functor::operator()(float)"), "Functor::operator()(…)");
  assert.equal(st.simplifyNativeName("(anonymous namespace)::run(int)"), "(anonymous namespace)::run(…)");
  assert.equal(st.simplifyNativeName("broken<tpl"), "broken<tpl");
});

test("file tint slots and self ramp steps", () => {
  assert.equal(st.fileColorIndex("/home/dev/llm-train/train.py"), st.fileColorIndex("/home/dev/llm-train/train.py"));
  const slots = new Set(["a.py", "b.py", "c.py", "d.py", "e.py", "f.py", "g.py", "h.py", "i.py", "j.py"].map(st.fileColorIndex));
  assert.ok([...slots].every((s) => s >= 0 && s < 8));
  assert.ok(slots.size > 3);
  assert.equal(st.selfRampStep(0, 10), 0);
  assert.equal(st.selfRampStep(10, 10), 5);
  assert.equal(st.selfRampStep(5, 10), 3);
  assert.equal(st.selfRampStep(1, 10), 0);
  assert.equal(st.selfRampStep(2, 10), 1);
  assert.equal(st.selfRampStep(3, 0), 0);
});

withModel("ml-training", "flame maxSelf and lens-of-main-thread leaf at time t", async (m) => {
  const tree = await m.flame("cpu");
  assert.ok(tree.maxSelf > 0 && tree.maxSelf <= tree.total);
  const tl = await m.timeline();
  const i = tl.byThread[tl.mainIdx][2000];
  const leaf = tl.pyLeafAt(tl.mainIdx, (tl.t0[i] + tl.t1[i]) / 2);
  assert.ok(leaf);
  assert.equal(leaf.run, i);
  assert.equal(leaf.frame.kind, "py");
  const frames = tl.frameAt(tl.stack[i], leaf.depth);
  assert.equal(frames, leaf.frame);
  for (let d = leaf.depth + 1; d < tl.maxDepth[tl.mainIdx]; d++) {
    const f = tl.frameAt(tl.stack[i], d);
    if (f) assert.equal(f.kind, "native", "deeper frames are native");
  }
  assert.equal(tl.pyLeafAt(tl.mainIdx, -10), null);
});
