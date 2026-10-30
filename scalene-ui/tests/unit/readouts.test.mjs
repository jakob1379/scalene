// §4.3 readouts: slot selection per fixture and the tile content
// (values, captions with denominators, short captions, visuals).
import assert from "node:assert/strict";
import { plain, withModel } from "./_harness.mjs";

const SLOTS = {
  "ml-training": ["time", "peak", "gpu", "leaks"],
  huge: ["time", "peak", "gpu", "leaks"],
  "async-server": ["time", "peak", "await", "elapsed"],
  neuron: ["time", "peak", "neuron", "elapsed"],
  "cpu-only": ["time", "elapsed", "busiest"],
  basic: ["time", "peak", "elapsed", "busiest"],
  example: ["time", "peak", "elapsed", "busiest"],
};

for (const [name, kinds] of Object.entries(SLOTS)) {
  withModel(name, `readout slots ${kinds.join(" · ")}`, (m) => {
    assert.deepEqual(m.readouts.map((r) => r.kind), kinds);
    for (const r of m.readouts) {
      assert.ok(r.label);
      assert.ok(r.short !== undefined);
      if (r.kind !== "leaks") assert.ok(r.caption.length >= 1 && r.caption.length <= 2, `${r.kind} caption lines`);
      if (r.value) assert.equal(r.number + (r.unit && !r.value.includes(`${r.number}${r.unit}`) ? `\u00a0${r.unit}` : r.unit), r.value);
    }
    const time = m.readouts[0];
    assert.equal(time.countUp, false, "the time split never counts");
    assert.equal(time.parts.length, 3);
    assert.equal(time.visual.kind, "split");
  });
}

const tile = (m, kind) => m.readouts.find((r) => r.kind === kind);
const captions = (r) => r.caption.map(plain);

withModel("ml-training", "tile content", (m) => {
  const time = tile(m, "time");
  assert.deepEqual(time.parts.map((p) => `${p.label} ${p.text}`), ["Python 11.6%", "native 61.9%", "system 26.1%"]);
  assert.deepEqual(captions(time), ["share of run time · 0.4% outside profiled files"]);
  assert.equal(time.short, "of run · 0.4% outside");
  assert.equal(time.parts[2].hatch, "system");

  const peak = tile(m, "peak");
  assert.equal(peak.value, "3.11\u00a0GiB");
  assert.deepEqual([peak.number, peak.unit], ["3.11", "GiB"]);
  assert.deepEqual(captions(peak), ["at 52.9\u00a0s · train.py:120 · Python 1.0%", "growth 52.2% · +212\u00a0MiB native threads"]);
  assert.equal(peak.short, "at 52.9\u00a0s");
  assert.equal(peak.tooltip, "3184.65\u00a0MiB = 3.11\u00a0GiB, at 52.93\u00a0s");
  assert.equal(peak.visual.kind, "split");
  const ref = peak.caption[0].find((s) => s.t === "ref");
  assert.deepEqual(ref.target, { file: "/home/dev/llm-train/train.py", line: 120 });

  const gpu = tile(m, "gpu");
  assert.equal(gpu.value, "66.9%");
  assert.deepEqual(captions(gpu), ["mean while the main thread ran (time-weighted)", "peak device memory 8.62\u00a0GiB · busiest train.py:173 96.4%"]);
  assert.equal(gpu.short, "mean while running");
  assert.deepEqual(gpu.visual, { kind: "meter", value: m.gpu.mean, max: 100, token: "gpu" });

  const leaks = tile(m, "leaks");
  assert.equal(leaks.value, "2");
  assert.equal(leaks.danger, true);
  assert.deepEqual(leaks.leaks.items.map((x) => `${x.label} · ${x.rate} (${x.likelihood})`), [
    "metrics.py:42 · 5.71\u00a0MiB/s (99.7%)",
    "loader.py:33 · 288\u00a0KiB/s (96.2%)",
  ]);
  assert.equal(leaks.leaks.more, 0);
  assert.equal(leaks.short, "grows 5.71\u00a0MiB/s");
});

withModel("async-server", "tile content", (m) => {
  assert.deepEqual(captions(tile(m, "time")), ["share of run time"]);
  const peak = tile(m, "peak");
  assert.equal(peak.value, "50.1\u00a0MiB");
  assert.deepEqual(captions(peak), ["at 15.2\u00a0s · cache.py:24 · Python 90.0%", "growth 15.9%"]);
  const aw = tile(m, "await");
  assert.equal(aw.value, "35.8%");
  assert.deepEqual(captions(aw), ["of await time at await asyncio.sleep(…) · bench_server.py:59", "15.5 tasks suspended on average, 22 at most"]);
  assert.equal(aw.short, "of await time");
  const el = tile(m, "elapsed");
  assert.equal(el.value, "15.7\u00a0s");
  assert.deepEqual(captions(el), ["wall clock · 1 thread · 14,656 samples", "10\u00a0ms sampling"]);
  assert.equal(el.short, "wall clock");
});

withModel("cpu-only", "tile content", (m) => {
  assert.deepEqual(tile(m, "time").parts.map((p) => p.text), ["94.3%", "4.6%", "1.1%"]);
  assert.deepEqual(captions(tile(m, "elapsed")), ["wall clock · 1 thread · 2,222 samples", "10\u00a0ms sampling"]);
  const fn = tile(m, "busiest");
  assert.equal(fn.value, "86.8%");
  assert.deepEqual(captions(fn), ["accelerations() · nbody.py:32 · 19.3\u00a0s"]);
  assert.deepEqual(fn.caption[0][0].target, { file: "/home/ana/sim/nbody.py", fn: "accelerations" });
});

withModel("neuron", "tile content", (m) => {
  assert.deepEqual(tile(m, "time").parts.map((p) => p.text), ["17.1%", "34.2%", "48.7%"]);
  assert.equal(captions(tile(m, "peak"))[0], "at 10.7\u00a0s · infer_bert.py:23 · Python 0%");
  const n = tile(m, "neuron");
  assert.equal(n.value, "9.89\u00a0s");
  assert.deepEqual(captions(n), ["37.8% of run in NRT · NC 8.69\u00a0s (33.2%)", "device idle in 78.5% of CPU samples"]);
  assert.equal(n.visual.kind, "meters");
  assert.equal(tile(m, "elapsed").value, "26.2\u00a0s");
});

withModel("basic", "tile content", (m) => {
  assert.deepEqual(tile(m, "time").parts.map((p) => p.text), ["79.2%", "17.6%", "3.2%"]);
  assert.equal(tile(m, "peak").value, "10.2\u00a0MiB");
  assert.equal(captions(tile(m, "peak"))[0], "at 1.62\u00a0s · testme.py:13 · Python 100%");
  assert.equal(tile(m, "elapsed").value, "1.68\u00a0s");
  assert.deepEqual(captions(tile(m, "elapsed")), ["wall clock"]);
  assert.equal(tile(m, "busiest").value, "67.9%");
});

withModel("example", "absent fields say 'not recorded'", (m) => {
  const time = tile(m, "time");
  assert.deepEqual(captions(time), ["share of run time · 0.1% outside profiled files"]);
  const peak = tile(m, "peak");
  assert.equal(peak.value, "46.2\u00a0MiB");
  assert.equal(captions(peak)[0], "at 377\u00a0ms · location not recorded");
  assert.deepEqual(peak.visual, { kind: "neutral", note: "split not recorded" });
  assert.equal(tile(m, "busiest").value, "76.6%");
});

withModel("huge", "tile content", (m) => {
  assert.deepEqual(tile(m, "time").parts.map((p) => p.text), ["75.2%", "17.2%", "7.2%"]);
  assert.equal(captions(tile(m, "time"))[0], "share of run time · 0.5% outside profiled files");
  assert.equal(captions(tile(m, "peak"))[0], "at 49.5\u00a0s · thermal.py:169 · Python 5.0%");
  assert.equal(tile(m, "gpu").value, "22.8%");
  assert.match(captions(tile(m, "gpu"))[1], /^peak device memory 6\.75\u00a0GiB · busiest /);
  assert.deepEqual(tile(m, "leaks").leaks.items.map((x) => `${x.label} ${x.rate} ${x.likelihood}`), [
    "registry.py:90 11\u00a0KiB/s 99.1%",
    "statistics.py:66 4\u00a0KiB/s 95.0%",
  ]);
});
