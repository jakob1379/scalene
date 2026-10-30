// WP2 (DESIGN.md §2.4.2, §2.4.5, §4.3, §4.5): overview layout modes, hotspot row counts,
// readout grid and count-up eligibility, hotspot keys, and the per-fixture slot sets the
// view renders (Appendix A).
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const ov = mod("views/overview/overview");
const ro = mod("views/overview/readouts");
const hs = mod("views/overview/hotspots");
const { hotspotList } = mod("model/hotspots");

const lay = (bp, short = false) => ({ bp, short, coarse: false });

test("layout modes: side by side at lg+, stacked below, phone order on xs, short by width", () => {
  assert.deepEqual(ov.overviewMode(lay("lg"), true), { short: false, phone: false, side: true, xxl: false });
  assert.equal(ov.overviewMode(lay("xl"), true).side, true);
  assert.deepEqual(ov.overviewMode(lay("xxl"), true), { short: false, phone: false, side: true, xxl: true });
  assert.equal(ov.overviewMode(lay("md"), true).side, false);
  assert.equal(ov.overviewMode(lay("sm"), false).side, false);
  assert.deepEqual(ov.overviewMode(lay("xs"), false), { short: false, phone: true, side: false, xxl: false });
  // Jupyter iframe: side by side only when the host is ≥ 900 px wide; never phone order.
  assert.deepEqual(ov.overviewMode(lay("sm", true), true), { short: true, phone: false, side: true, xxl: false });
  assert.equal(ov.overviewMode(lay("sm", true), false).side, false);
  assert.equal(ov.overviewMode(lay("xs", true), false).phone, false);
  assert.equal(ov.overviewMode(lay("xxl", true), true).xxl, false);
});

test("hotspot rows: 3 + 'Show all' on phones, 5 in short hosts, 8 elsewhere", () => {
  assert.deepEqual(ov.hotspotRows(ov.overviewMode(lay("xs"), false)), { n: 3, showAll: true });
  assert.deepEqual(ov.hotspotRows(ov.overviewMode(lay("sm", true), true)), { n: 5, showAll: false });
  for (const bp of ["sm", "md", "lg", "xl", "xxl"]) assert.deepEqual(ov.hotspotRows(ov.overviewMode(lay(bp), true)), { n: 8, showAll: false });
});

test("readout grid: 1.6 fr time split, 1 fr for the others", () => {
  assert.equal(ro.gridColumns(4), "minmax(0, 1.6fr) repeat(3, minmax(0, 1fr))");
  assert.equal(ro.gridColumns(3), "minmax(0, 1.6fr) repeat(2, minmax(0, 1fr))");
  assert.equal(ro.gridColumns(1), "minmax(0, 1fr)");
});

test("count-up only for one plain number with a unit (never the time split or '3\u00a0m\u00a047\u00a0s')", () => {
  assert.equal(ro.countable({ countUp: true, number: "3.11", unit: "GiB" }), true);
  assert.equal(ro.countable({ countUp: true, number: "66.9", unit: "%" }), true);
  assert.equal(ro.countable({ countUp: true, number: "3\u00a0m\u00a047\u00a0s", unit: "" }), false);
  assert.equal(ro.countable({ countUp: false, number: "2", unit: "" }), false);
  assert.equal(ro.countable({ countUp: true, number: "<0.1", unit: "%" }), false);
});

test("hotspot keys are stable per kind and target", () => {
  assert.equal(hs.itemKey({ kind: "line", target: { file: "/a/train.py", line: 173 } }), "line|/a/train.py|173");
  assert.equal(hs.itemKey({ kind: "function", target: { file: "/a/train.py", fn: "train" } }), "function|/a/train.py|fn:train");
});

const SLOTS = {
  "ml-training": ["time", "peak", "gpu", "leaks"],
  huge: ["time", "peak", "gpu", "leaks"],
  "async-server": ["time", "peak", "await", "elapsed"],
  neuron: ["time", "peak", "neuron", "elapsed"],
  "cpu-only": ["time", "elapsed", "busiest"],
  basic: ["time", "peak", "elapsed", "busiest"],
};
for (const [name, kinds] of Object.entries(SLOTS)) {
  withModel(name, `readout slots render in order: ${kinds.join(" · ")}`, (m) => {
    assert.deepEqual(m.readouts.map((r) => r.kind), kinds);
    // xs completes the 2 × 2 grid after the hotspots with an Elapsed tile only when needed.
    const secondary = kinds.length - 1;
    const wantsExtra = secondary % 2 === 1 && !kinds.includes("elapsed");
    assert.equal(wantsExtra, name === "ml-training" || name === "huge");
  });
}

withModel("ml-training", "TOP LINES rows follow the hotspot list (same ranks, same sample times)", (m) => {
  const list = hotspotList(m, "lines", "time", 8);
  const top5 = list.items.slice(0, 5);
  assert.deepEqual(top5.map((i) => i.rank), [1, 2, 3, 4, 5]);
  assert.equal(top5[0].times.length, top5[0].line.cpuTimes.length);
  const mem = hotspotList(m, "lines", "memory", 8);
  assert.ok(mem.items[0].times.length > 0, "memory rows use allocation times");
});

withModel("async-server", "event-loop hotspot carries the waiting badge (must-fix 28)", (m) => {
  const list = hotspotList(m, "lines", "time", 8);
  assert.equal(list.items[0].badge?.kind, "loop");
  assert.match(list.items[0].badge.text, /waiting/);
});

withModel("cpu-only", "no THREADS channel; findings hold exactly the python card", (m) => {
  assert.equal(m.sampling.threads.length <= 1, true);
  assert.deepEqual(m.findings.map((f) => f.id), ["python"]);
});
