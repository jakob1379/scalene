// Tick algorithms (upstream names, §4.0.2, §7.5): pickNiceTickInterval with
// max(2, floor(px / 80)) ticks, niceMemStep in the display unit, labels.
import assert from "node:assert/strict";
import { mod, test } from "./_harness.mjs";

const a = mod("charts/axis");

test("pickNiceTickInterval: 1/2/5 × 10^k with max(2, floor(px/80)) ticks", () => {
  const cases = [
    [54.11, 400, 20], // 5 ticks: 10.82 → 20
    [54.11, 800, 10], // 10 ticks: 5.41 → 10
    [54.11, 1200, 5], // 15 ticks: 3.6 → 5
    [226.9, 795, 50], // 9 ticks: 25.2 → 50
    [15.66, 600, 5], // 7 ticks: 2.24 → 5
    [1, 100, 0.5], // 2 ticks (minimum): 0.5 → 0.5
    [100, 160, 50], // 2 ticks: 50 → 50
    [100, 1000, 10], // 12 ticks: 8.3 → 10
    [3.2, 1600, 0.2], // 20 ticks: 0.16 → 0.2
    [0.0123, 400, 0.005], // 5 ticks: 0.00246 → 0.005
    [1000, 80, 500], // 2 ticks: 500 → 500
  ];
  for (const [total, px, want] of cases) {
    const got = a.pickNiceTickInterval(total, px);
    assert.ok(Math.abs(got - want) < want * 1e-9, `pick(${total}, ${px}) = ${got}, want ${want}`);
  }
  assert.equal(a.pickNiceTickInterval(0, 400), 0);
  assert.equal(a.pickNiceTickInterval(-5, 400), 0);
  assert.equal(a.pickNiceTickInterval(10, 0), 0);
  assert.equal(a.pickNiceTickInterval(NaN, 400), 0);
});

test("formatTimelineTickLabel: upstream rules with spaced units", () => {
  assert.equal(a.formatTimelineTickLabel(0, 10), "0");
  assert.equal(a.formatTimelineTickLabel(10, 10), "10 s");
  assert.equal(a.formatTimelineTickLabel(1.5, 0.5), "1.5 s");
  assert.equal(a.formatTimelineTickLabel(2.25, 0.05), "2.25 s");
  assert.equal(a.formatTimelineTickLabel(1.005, 0.005), "1.005 s");
  assert.equal(a.formatTimelineTickLabel(0.25, 0.05), "250 ms");
  assert.equal(a.formatTimelineTickLabel(0.0005, 0.0005), "0.50 ms");
  assert.equal(a.formatTimelineTickLabel(150, 50), "150 s");
});

test("formatMemoryTickLabel: binary units, decimals by step", () => {
  assert.equal(a.formatMemoryTickLabel(0, 1024), "0");
  assert.equal(a.formatMemoryTickLabel(1024, 1024), "1 GiB");
  assert.equal(a.formatMemoryTickLabel(1536, 512), "1.5 GiB");
  assert.equal(a.formatMemoryTickLabel(512, 512), "512 MiB");
  assert.equal(a.formatMemoryTickLabel(2560, 51.2), "2.50 GiB");
  assert.equal(a.formatMemoryTickLabel(25, 5), "25 MiB");
  assert.equal(a.formatMemoryTickLabel(2.5, 0.5), "2.5 MiB");
  assert.equal(a.formatMemoryTickLabel(0.5, 0.25), "512 KiB");
  assert.equal(a.formatMemoryTickLabel(0.5 / 1024, 0.25 / 1024), "0.50 KiB");
});

test("formatMemoryTickLabel: one unit per axis from maxMiB (round 1: '205 MiB … 1.0 GiB')", () => {
  // ml-training memory flame: max 3244 MiB, 16 ticks → 0.2 GiB steps, all in GiB.
  const step = a.niceMemStep(3244, 16);
  assert.ok(Math.abs(step - 0.2 * 1024) < 1e-9);
  const labels = a.memoryTicksN(3244, 16).ticks.map((t) => t.label);
  assert.deepEqual(labels.slice(0, 6), ["0", "0.2 GiB", "0.4 GiB", "0.6 GiB", "0.8 GiB", "1.0 GiB"]);
  assert.equal(labels[labels.length - 1], "3.0 GiB"); // 3244 MiB = 3.17 GiB
  assert.ok(labels.slice(1).every((l) => l.endsWith(" GiB")), labels.join(", "));
  // 3.17 GiB axis (Appendix A peak 3.11 GiB) at 3 ticks: 0 / 2 / 4 GiB.
  assert.deepEqual(a.memoryScale(3.17 * 1024, 3).ticks.ticks.map((t) => t.label), ["0", "2 GiB", "4 GiB"]);
  // 1500 MiB with 3 ticks: 0.5 GiB steps, never "512 MiB".
  assert.deepEqual(a.memoryTicksN(1500, 3).ticks.map((t) => t.label), ["0", "0.5 GiB", "1.0 GiB"]);
  assert.deepEqual(a.memoryScale(1500, 3).ticks.ticks.map((t) => t.label), ["0", "0.5 GiB", "1.0 GiB", "1.5 GiB"]);
  // The scale top may pass 1 GiB while the data max (and so the unit) stays in MiB.
  assert.deepEqual(a.memoryScale(1000, 2).ticks.ticks.map((t) => t.label), ["0", "500 MiB", "1000 MiB", "1500 MiB"]);
  assert.equal(a.formatMemoryTickLabel(204.8, 204.8, 3244), "0.2 GiB");
  assert.equal(a.formatMemoryTickLabel(512, 256, 0.9), "524288 KiB", "explicit max wins");
});

test("niceMemStep: 1/2/5 steps in the display unit", () => {
  const GiB = 1024;
  const cases = [
    [3184.65, 3, 2 * GiB], // 3.11 GiB / 3 = 1.04 → 2 GiB
    [3184.65, 4, 1 * GiB], // 0.78 → 1 GiB
    [2436.6, 3, 1 * GiB], // 2.38 / 3 = 0.79 → 1 GiB
    [1200, 3, 0.5 * GiB], // 1.17 / 3 = 0.39 → 0.5 GiB = 512 MiB
    [742.24, 3, 500], // MiB unit: 247 → 500 MiB
    [50.1, 3, 20], // 16.7 → 20 MiB
    [10.25, 3, 5], // 3.4 → 5 MiB
    [0.5, 3, 200 / 1024], // KiB unit: 512 KiB / 3 = 170.7 → 200 KiB
  ];
  for (const [max, n, want] of cases) {
    const got = a.niceMemStep(max, n);
    assert.ok(Math.abs(got - want) < want * 1e-9, `niceMemStep(${max}, ${n}) = ${got}, want ${want}`);
  }
  assert.equal(a.niceMemStep(0, 3), 0);
  assert.equal(a.niceMemStep(-1, 3), 0);
});

test("timeTicks: multiples inside the domain, labels and edge anchoring", () => {
  const t = a.timeTicks(0, 54.11, 795);
  assert.equal(t.step, 10);
  assert.deepEqual(t.ticks.map((x) => x.label), ["0", "10 s", "20 s", "30 s", "40 s", "50 s"]);
  assert.equal(t.ticks[0].edge, "start");
  assert.equal(t.ticks[1].edge, "middle");
  assert.ok(Math.abs(t.ticks[5].frac - 50 / 54.11) < 1e-12);
  const z = a.timeTicks(12.03, 18.5, 400);
  assert.equal(z.step, 2);
  assert.deepEqual(z.ticks.map((x) => x.value), [14, 16, 18]);
  const e = a.timeTicks(0, 20, 400);
  assert.equal(e.ticks[e.ticks.length - 1].edge, "end");
  assert.deepEqual(a.timeTicks(5, 5, 400).ticks, []);
});

test("memoryTicks / memoryScale", () => {
  const m = a.memoryTicks(3174.6, 600); // 7 ticks max → 0.44 GiB → 0.5 GiB
  assert.equal(m.step, 512);
  assert.deepEqual(m.ticks.map((x) => x.label), ["0", "0.5 GiB", "1.0 GiB", "1.5 GiB", "2.0 GiB", "2.5 GiB", "3.0 GiB"]);
  const s = a.memoryScale(3184.65, 3);
  assert.equal(s.step, 2048);
  assert.equal(s.top, 4096);
  assert.deepEqual(s.ticks.ticks.map((x) => x.label), ["0", "2 GiB", "4 GiB"]);
  const small = a.memoryScale(50.1, 3);
  assert.equal(small.top, 60);
  assert.deepEqual(small.ticks.ticks.map((x) => x.label), ["0", "20 MiB", "40 MiB", "60 MiB"]);
  assert.equal(a.memoryScale(0).step, 0);
});

test("withAlpha resolves token colours", () => {
  const c = mod("charts/color");
  assert.equal(c.withAlpha("#62D286", 0.6), "rgba(98, 210, 134, 0.6)");
  assert.equal(c.withAlpha("#fff", 0.5), "rgba(255, 255, 255, 0.5)");
  assert.equal(c.withAlpha("rgb(14 17 22 / 0.5)", 0.5), "rgba(14, 17, 22, 0.25)");
  assert.equal(c.withAlpha("rgb(1, 2, 3)", 1), "rgba(1, 2, 3, 1)");
  assert.equal(c.withAlpha("red", 0.5), "red");
});
