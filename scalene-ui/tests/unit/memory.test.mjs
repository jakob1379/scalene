// §4.0.7 footprint helpers: peak, interpolation ("not sampled" outside the
// range), M4 downsampling (old profiles have 2,846 points).
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const mm = mod("model/memory");
const S = (...pairs) => Float64Array.from(pairs.flat());

test("peakInfo: first max point", () => {
  assert.deepEqual(mm.peakInfo(S([0, 1], [1, 5], [2, 5], [3, 2])), { t: 1, mb: 5, index: 1 });
  assert.equal(mm.peakInfo(S()), null);
});

test("footprintAt: exact, interpolated, outside → null", () => {
  const s = S([1, 10], [3, 30], [4, 0]);
  assert.deepEqual(mm.footprintAt(s, 1), { mb: 10, interpolated: false });
  assert.deepEqual(mm.footprintAt(s, 2), { mb: 20, interpolated: true });
  assert.deepEqual(mm.footprintAt(s, 3.5), { mb: 15, interpolated: true });
  assert.deepEqual(mm.footprintAt(s, 4), { mb: 0, interpolated: false });
  assert.equal(mm.footprintAt(s, 0.5), null);
  assert.equal(mm.footprintAt(s, 4.5), null);
  assert.equal(mm.footprintAt(S(), 1), null);
  assert.equal(mm.pairAtOrBefore(s, 3.2), 1);
  assert.equal(mm.pairAtOrBefore(s, 0), -1);
});

test("m4: first/min/max/last per column, sorted, peak preserved", () => {
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push([i / 100, Math.sin(i / 7) * 10 + (i === 517 ? 100 : 0)]);
  const s = S(...pts);
  const out = mm.m4(s, 0, 9.99, 50);
  assert.ok(out.length / 2 <= 50 * 4 + 2, `${out.length / 2} points`);
  for (let i = 2; i < out.length; i += 2) assert.ok(out[i] >= out[i - 2], "time order");
  assert.equal(mm.seriesMax(out), mm.seriesMax(s), "the peak survives");
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 2], 9.99);
  // Small series are returned unchanged.
  const small = S([0, 1], [1, 2]);
  assert.equal(mm.m4(small, 0, 1, 100), small);
});

test("m4 keeps one point beyond each edge of a zoomed domain", () => {
  const pts = [];
  for (let i = 0; i < 400; i++) pts.push([i, i % 13]);
  const out = mm.m4(S(...pts), 100.5, 199.5, 20);
  assert.equal(out[0], 100, "neighbour before the domain");
  assert.equal(out[out.length - 2], 200, "neighbour after the domain");
});

test("sampleTimes / seriesMax", () => {
  assert.deepEqual(Array.from(mm.sampleTimes(S([1, 5], [2, 7]))), [1, 2]);
  assert.equal(mm.seriesMax(S([1, -0.06], [2, -1])), 0);
});

withModel("example", "2,846 legacy samples downsample to the plot width", (m) => {
  const s = m.memory.samples;
  const out = mm.m4(s, 0, m.tMax, 600);
  assert.ok(out.length / 2 <= 2402);
  assert.equal(mm.seriesMax(out), mm.seriesMax(s));
});
