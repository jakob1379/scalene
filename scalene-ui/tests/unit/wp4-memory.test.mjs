// WP4 memory section logic (DESIGN.md §4.13): chart geometry per breakpoint, nearest allocation
// moment (hover readout), allocation sites with pinned leaks and default selection (Appendix A.1).
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const mv = mod("views/memory/memoryview");
const sites = mod("model/sites");
const { fmtMem, fmtRate } = mod("core/format");

test("chart height per breakpoint (240 lg/md, 200 sm, 180 xs, 160 short)", () => {
  assert.equal(mv.chartHeight("lg", false), 240);
  assert.equal(mv.chartHeight("md", false), 240);
  assert.equal(mv.chartHeight("sm", false), 200);
  assert.equal(mv.chartHeight("xs", false), 180);
  assert.equal(mv.chartHeight("lg", true), 160);
});

test("chart geometry: plot, 10 px rug directly under it, axis below, 52 px y gutter", () => {
  const g = mv.chartGeometry(800, 240);
  assert.equal(g.plot.w, 800 - 52);
  assert.equal(g.rug.h, 10);
  assert.ok(g.rug.y >= g.plot.y + g.plot.h && g.rug.y - (g.plot.y + g.plot.h) <= 4, "rug sits directly under the plot");
  assert.ok(g.rug.y + g.rug.h + 20 <= 240, "the time axis fits below the rug");
  const small = mv.chartGeometry(300, 160);
  assert.ok(small.plot.h >= 40);
});

test("nearestEvent: within the pixel tolerance only", () => {
  const t = Float64Array.from([1, 2, 3, 10]);
  assert.equal(mv.nearestEvent(t, 2.04, 0.05), 1);
  assert.equal(mv.nearestEvent(t, 2.5, 0.1), -1);
  assert.equal(mv.nearestEvent(t, 11, 2), 3);
  assert.equal(mv.nearestEvent(new Float64Array(0), 1, 1), -1);
});

withModel("ml-training", "sites: peak order, leaks outside the top 8 pinned, default = most likely leak", (m) => {
  const s = sites.allocationSites(m, "peak", 8);
  const loc = (l) => `${l.file.base}:${l.no}`;
  assert.equal(loc(s.rows[0]), "train.py:120");
  assert.equal(fmtMem(s.rows[0].peak), "1.20\u00a0GiB");
  assert.equal(loc(s.rows[1]), "loader.py:18");
  assert.deepEqual(s.pinnedLeaks.map(loc), ["loader.py:33"]);
  assert.equal(loc(s.defaultSite), "metrics.py:42");
  assert.equal(fmtRate(s.defaultSite.leak.velocity), "5.71\u00a0MiB/s");
  assert.ok(s.defaultSite.memSamples.length / 2 > 0, "the default site has rug moments");
  const a = sites.allocationSites(m, "allocated", 25);
  for (let i = 1; i < a.rows.length; i++) assert.ok(a.rows[i - 1].malloc >= a.rows[i].malloc);
});
