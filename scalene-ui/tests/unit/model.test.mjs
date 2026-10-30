// Model goldens (Appendix A): split, outside, top-8 lines, GPU mean, memory
// peak and time, leaks order, functions, regions, caps — plus normalization
// edge cases, immutability of the raw profile and the build-time budget.
import assert from "node:assert/strict";
import { fixture, lineOf, loc, mod, r1, test, withModel } from "./_harness.mjs";

const { buildModel, ProfileError } = mod("model/model");
const { parseProfile } = mod("model/normalize");
const { fmtMem, fmtPct, fmtTime } = mod("core/format");

function splitOf(m) {
  return [r1(m.split.py), r1(m.split.nat), r1(m.split.sys), r1(m.split.outside)];
}

function topLines(m, n = 8) {
  return m.rank.lines.time.slice(0, n).map((l) => `${loc(l)} ${fmtPct(l.total)} ${fmtTime(l.sec)}`);
}

// ── ml-training (A.1) ───────────────────────────────────────────────────────

withModel("ml-training", "split, outside, caps", (m) => {
  assert.deepEqual(splitOf(m), [11.6, 61.9, 26.1, 0.4]);
  assert.equal(m.base, "train.py");
  assert.deepEqual(m.args, ["--config", "configs/gpt-small.json", "--max-steps", "200"]);
  assert.equal(fmtTime(m.elapsed), "54.1\u00a0s");
  const want = {
    memory: true, gpu: true, neuron: false, async: false, coreUtil: true, gpuMemory: true, regions: true,
    functionBounds: true, cpuSamples: true, startTime: true, stacks: true, timeline: true, threadIds: true,
    memStacks: true, peakLocation: true, peakPyFraction: true, leaks: true, elapsed: true,
  };
  assert.deepEqual(m.caps, want);
  assert.equal(m.elapsedSource, "recorded");
  assert.equal(m.files.length, 6);
  assert.equal(m.hiddenFiles.length, 0);
  assert.deepEqual(m.files.map((f) => f.no), [1, 2, 3, 4, 5, 6]);
  assert.equal(m.files[0].base, "train.py");
});

withModel("ml-training", "top-8 lines by time and their totals", (m) => {
  assert.deepEqual(topLines(m), [
    "train.py:173 21.4% 11.6\u00a0s",
    "train.py:165 16.2% 8.78\u00a0s",
    "train.py:120 4.9% 2.64\u00a0s",
    "train.py:17 4.5% 2.41\u00a0s",
    "train.py:145 3.6% 1.94\u00a0s",
    "loader.py:33 2.9% 1.57\u00a0s",
    "train.py:167 2.6% 1.39\u00a0s",
    "metrics.py:39 2.4% 1.30\u00a0s",
  ]);
  const top8 = m.rank.lines.time.slice(0, 8).reduce((a, l) => a + l.total, 0);
  assert.equal(fmtPct(top8), "58.4%");
  assert.equal(m.rank.lines.time.length - 8, 100);
  assert.equal(lineOf(m, "train.py:173").timeRank, 1);
  assert.equal(r1(m.maxLineTotal), 21.4);
});

withModel("ml-training", "GPU readout: time-weighted main-thread mean 66.9%, device peak 8.62\u00a0GiB", (m) => {
  assert.equal(m.gpu.method, "main-thread");
  assert.equal(r1(m.gpu.mean), 66.9);
  assert.equal(fmtMem(m.gpu.devicePeak), "8.62\u00a0GiB");
  assert.equal(loc(m.gpu.busiest), "train.py:173");
  assert.equal(fmtPct(m.gpu.busiest.gpu), "96.4%");
  assert.equal(m.gpu.name, "GPU");
});

withModel("ml-training", "memory: peak 3.11\u00a0GiB at 52.9\u00a0s (train.py:120), allocated 3.27\u00a0GiB", (m) => {
  assert.equal(fmtMem(m.memory.peak), "3.11\u00a0GiB");
  assert.equal(fmtTime(m.memory.peakT), "52.9\u00a0s");
  assert.equal(loc(m.memory.peakLine), "train.py:120");
  assert.equal(fmtMem(m.memory.allocated), "3.27\u00a0GiB");
  assert.equal(r1(m.memory.growth), 52.2);
  assert.equal(fmtMem(m.memory.native), "212\u00a0MiB");
  assert.equal(m.memory.pyFrac, 0.01);
  const save = lineOf(m, "train.py:120");
  assert.equal(fmtMem(save.peak), "1.20\u00a0GiB");
  assert.equal(fmtPct(100 * save.usage), "33.0%");
  assert.equal(save.copy.toFixed(1), "22.0");
  assert.equal(fmtMem(lineOf(m, "loader.py:18").peak), "800\u00a0MiB");
  assert.equal(fmtMem(lineOf(m, "metrics.py:42").peak), "614\u00a0MiB");
});

withModel("ml-training", "leaks sorted by likelihood: metrics.py:42 then loader.py:33", (m) => {
  assert.deepEqual(
    m.leaks.map((l) => `${loc(l)} ${fmtPct(100 * l.leak.likelihood)}`),
    ["metrics.py:42 99.7%", "loader.py:33 96.2%"],
  );
  assert.deepEqual(m.files.find((f) => f.base === "metrics.py").leaks.map(loc), ["metrics.py:42"]);
});

withModel("ml-training", "functions and membership: train(), save_checkpoint(), region 152–184", (m) => {
  const train = m.rank.functions.time[0];
  assert.equal(train.name, "train");
  assert.equal(fmtPct(train.total), "47.1%");
  assert.equal(fmtTime(train.sec), "25.5\u00a0s");
  assert.equal(fmtMem(train.peak), "2.01\u00a0MiB");
  assert.equal(fmtPct(train.gpu), "81.8%");
  assert.deepEqual(train.range, [124, 189]);
  const save = m.files[0].functions.find((f) => f.name === "save_checkpoint");
  assert.equal(fmtPct(save.total), "4.9%");
  assert.equal(fmtMem(save.peak), "1.20\u00a0GiB");
  assert.equal(lineOf(m, "train.py:173").fn, train);
  assert.equal(lineOf(m, "train.py:165").fn, train);
  assert.equal(lineOf(m, "train.py:120").fn, save);
  const head = lineOf(m, "train.py:152");
  assert.deepEqual(head.region, [152, 184]);
  assert.equal(head.regionHead, true);
  assert.equal(fmtPct(head.regionTotal), "43.4%");
  assert.equal(lineOf(m, "train.py:153").regionHead, false);
  // Decorated function: lineno is the decorator line.
  const evaluate = m.files[0].functions.find((f) => f.name === "evaluate");
  if (evaluate) assert.match(m.files[0].byNo.get(evaluate.no).text, /^\s*@/);
});

withModel("ml-training", "sampling summary and time domain", (m) => {
  assert.deepEqual(m.sampling.threads.map((t) => t.label), ["main", "thread 1", "thread 2", "thread 3", "thread 4"]);
  assert.equal(m.sampling.runs, 4933);
  assert.ok(Math.abs(m.sampling.dt - 0.01) < 0.0005, `dt ${m.sampling.dt}`);
  assert.equal(m.stackSamples, 5901);
  assert.ok(m.tMax >= m.elapsed && m.tMax < m.elapsed + 1);
});

// ── async-server (A.2) ──────────────────────────────────────────────────────

withModel("async-server", "split clamps outside to 0; await, loop line, concurrency", (m) => {
  assert.deepEqual(splitOf(m), [12.3, 32.4, 55.3, 0]);
  assert.ok(m.split.total > 100, "files sum to one ulp above 100");
  assert.equal(m.split.outside, 0);
  assert.equal(loc(m.async.loopLine), "bench_server.py:99");
  const top = m.async.topAwait;
  assert.equal(loc(top), "bench_server.py:59");
  assert.equal(fmtPct(top.await), "35.8%");
  assert.equal(top.concMean.toFixed(1), "15.5");
  assert.equal(top.concPeak, 22);
  assert.equal(m.caps.async, true);
  assert.equal(m.caps.gpu, false);
  assert.equal(m.leaks.length, 0, "growth without leak");
  assert.equal(m.caps.leaks, true);
  assert.equal(fmtMem(m.memory.peak), "50.1\u00a0MiB");
  assert.equal(fmtTime(m.memory.peakT), "15.2\u00a0s");
  assert.equal(loc(m.memory.peakLine), "cache.py:24");
  assert.equal(m.sampling.threads.length, 1);
  assert.equal(m.stackSamples, 14656);
  assert.equal(lineOf(m, "handlers.py:51").coro, true);
});

withModel("async-server", "HTML in render.py is unescaped once (no \\u003c left)", (m) => {
  const render = m.files.find((f) => f.base === "render.py");
  const all = render.lines.map((l) => l.text).join("\n");
  assert.ok(!all.includes("\\u003c") && !all.includes("\\u003e") && !all.includes("\\u0026"));
  assert.ok(all.includes("</ul></body></html>"));
});

// ── cpu-only (A.3) ──────────────────────────────────────────────────────────

withModel("cpu-only", "time-only profile", (m) => {
  assert.deepEqual(splitOf(m), [94.3, 4.6, 1.1, 0]);
  assert.equal(m.memory, null);
  assert.equal(m.gpu, null);
  assert.equal(m.caps.memory, false);
  assert.equal(m.caps.memStacks, false);
  assert.equal(m.caps.peakLocation, false);
  const fn = m.rank.functions.time[0];
  assert.equal(`${fn.name} ${fmtPct(fn.total)} ${fmtTime(fn.sec)}`, "accelerations 86.8% 19.3\u00a0s");
  assert.equal(m.sampling.threads.length, 1);
  assert.equal(m.stackSamples, 2222);
  assert.ok(m.rank.lines.time.slice(0, 3).every((l) => l.fn === fn));
});

// ── neuron (A.4) ────────────────────────────────────────────────────────────

withModel("neuron", "Neuron hides GPU; NRT/NC totals; line 66", (m) => {
  assert.deepEqual(splitOf(m), [17.1, 34.2, 48.7, 0]);
  assert.equal(m.caps.neuron, true);
  assert.equal(m.caps.gpu, false);
  assert.equal(m.gpu, null);
  assert.equal(m.caps.stacks, false);
  assert.equal(m.caps.timeline, false);
  assert.equal(fmtTime(m.neuron.nrtMs / 1000), "9.89\u00a0s");
  assert.equal(fmtTime(m.neuron.ncMs / 1000), "8.69\u00a0s");
  assert.equal(fmtPct(m.neuron.idleOverall), "78.5%");
  const l = lineOf(m, "infer_bert.py:66");
  const elapsedMs = m.elapsed * 1000;
  assert.equal(fmtPct((100 * l.neuron.nrtMs) / elapsedMs), "37.0%");
  assert.equal(fmtTime(l.neuron.nrtMs / 1000), "9.69\u00a0s");
  assert.equal(fmtPct(l.neuron.nrtPct), "98.0%");
  assert.equal(fmtPct((100 * l.neuron.ncMs) / elapsedMs), "32.5%");
  assert.equal(fmtPct(l.neuron.idlePct), "12.4%");
  assert.equal(fmtMem(m.memory.peak), "742\u00a0MiB");
  assert.equal(fmtTime(m.memory.peakT), "10.7\u00a0s");
  assert.equal(loc(m.memory.peakLine), "infer_bert.py:23");
});

// ── basic (A.5) ─────────────────────────────────────────────────────────────

withModel("basic", "mid-age format: indentation membership, no cpu samples", (m) => {
  assert.deepEqual(splitOf(m), [79.2, 17.6, 3.2, 0]);
  assert.equal(m.caps.cpuSamples, false);
  assert.equal(m.caps.startTime, false);
  assert.equal(m.caps.functionBounds, false);
  assert.equal(m.caps.regions, true);
  assert.equal(m.caps.coreUtil, true);
  assert.equal(m.caps.stacks, false);
  assert.equal(m.files[0].dense, true);
  const [a, b] = m.rank.lines.time;
  assert.equal(a.fn.name, "doit2");
  assert.equal(b.fn.name, "doit2");
  assert.equal(fmtPct(m.rank.functions.time[0].total), "67.9%");
  assert.equal(fmtMem(m.memory.peak), "10.2\u00a0MiB");
  assert.equal(loc(m.memory.peakLine), "testme.py:13");
  assert.equal(lineOf(m, "testme.py:13").fn.name, "doit1");
  assert.ok(m.files[0].lines.every((l) => l.cpuTimes.length === 0));
});

// ── example (A.6) ───────────────────────────────────────────────────────────

withModel("example", "very old format: sparse lines, absent fields are absent", (m) => {
  assert.equal(m.base, "");
  assert.deepEqual(splitOf(m), [72.6, 25.1, 2.2, 0.1]);
  assert.equal(m.caps.coreUtil, false, "no Core utilization 0%");
  assert.equal(m.caps.regions, false);
  assert.equal(m.caps.leaks, false);
  assert.equal(m.caps.peakLocation, false);
  assert.equal(m.caps.peakPyFraction, false);
  assert.equal(m.caps.gpuMemory, false);
  assert.equal(m.files[0].dense, false);
  assert.ok(m.files[0].lines.every((l) => l.fn === null && l.coreUtil === null && l.gpuPeak === null));
  assert.equal(m.memory.pyFrac, null);
  assert.equal(m.memory.peakLine, null);
  assert.equal(fmtMem(m.memory.peak), "46.2\u00a0MiB");
  assert.equal(m.memory.samples.length / 2, 2846);
  for (let i = 2; i < m.memory.samples.length; i += 2) assert.ok(m.memory.samples[i] >= m.memory.samples[i - 2]);
  assert.ok(m.tMax > m.elapsed, "sample times past elapsed extend the domain");
  for (const fn of m.files[0].functions) {
    for (let i = 2; i < fn.memSamples.length; i += 2) assert.ok(fn.memSamples[i] >= fn.memSamples[i - 2], "function samples sorted");
  }
  assert.equal(fmtPct(m.rank.functions.time[0].total), "76.6%");
});

// ── huge (A.7) ──────────────────────────────────────────────────────────────

withModel("huge", "stress profile goldens", (m) => {
  assert.deepEqual(splitOf(m), [75.2, 17.2, 7.2, 0.5]);
  assert.equal(m.files.length, 24);
  assert.equal(m.hiddenFiles.length, 16);
  assert.equal(m.files.concat(m.hiddenFiles).reduce((a, f) => a + f.lines.length, 0), 11739);
  assert.equal(m.files.concat(m.hiddenFiles).reduce((a, f) => a + f.functions.length, 0), 241);
  assert.equal(fmtTime(m.elapsed), "3\u00a0m\u00a047\u00a0s");
  assert.equal(r1(m.gpu.mean), 22.8);
  assert.equal(fmtMem(m.gpu.devicePeak), "6.75\u00a0GiB");
  assert.equal(fmtMem(m.memory.peak), "2.38\u00a0GiB");
  assert.equal(fmtTime(m.memory.peakT), "49.5\u00a0s");
  assert.equal(loc(m.memory.peakLine), "thermal.py:169");
  assert.deepEqual(m.leaks.map((l) => `${loc(l)} ${fmtPct(100 * l.leak.likelihood)}`), ["registry.py:90 99.1%", "statistics.py:66 95.0%"]);
  const top = m.rank.lines.time[0];
  assert.equal(`${loc(top)} ${fmtPct(top.total)}`, "fluids.py:495 4.2%");
  assert.ok(top.text.includes("assert dist >= 0"), "escaped >= renders verbatim");
  assert.equal(m.sampling.threads.length, 12);
  assert.equal(m.sampling.runs, 41604);
  assert.equal(m.stackSamples, 51784);
  // File numbers run over all files in share order (hidden ones included).
  const all = m.files.concat(m.hiddenFiles).sort((a, b) => a.no - b.no);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].pct >= all[i].pct);
});

withModel("huge", "model build stays within budget (§6.1: ≤ 250\u00a0ms)", () => {
  const raw = fixture("huge");
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    buildModel(raw);
    times.push(performance.now() - t);
  }
  const best = Math.min(...times);
  console.log(`  # huge build: ${times.map((t) => t.toFixed(0)).join(" / ")} ms`);
  assert.ok(best < 250, `huge build ${best.toFixed(0)} ms`);
});

withModel("ml-training", "model build ≤ 40\u00a0ms", () => {
  const raw = fixture("ml-training");
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    buildModel(raw);
    times.push(performance.now() - t);
  }
  console.log(`  # ml build: ${times.map((t) => t.toFixed(1)).join(" / ")} ms`);
  assert.ok(Math.min(...times) < 40);
});

// ── Normalization edge cases (§4.0.1, §4.0.8) ───────────────────────────────

test("empty inputs → null (empty state); bad JSON text → ProfileError", () => {
  for (const x of ["", "   ", null, undefined, 42, [], {}, { files: {} }, { files: null }, "{}", "[]"]) {
    assert.equal(buildModel(x), null, JSON.stringify(x));
  }
  assert.throws(() => buildModel("{ not json"), ProfileError);
  assert.equal(parseProfile("{oops").kind, "error");
});

test("JSON text is accepted", () => {
  const text = JSON.stringify(fixture("basic"));
  assert.equal(buildModel(text).headline.plain, buildModel(fixture("basic")).headline.plain);
});

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test("the raw profile is never mutated", () => {
  const raw = deepFreeze(structuredClone(fixture("basic")));
  const before = JSON.stringify(raw);
  const m = buildModel(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(m.raw, raw);
  const ex = deepFreeze(structuredClone(fixture("example")));
  buildModel(ex);
});

test("NaN / Infinity count as absent; unsorted samples sorted; negatives kept raw", () => {
  const m = buildModel({
    elapsed_time_sec: 10,
    memory: true,
    gpu: true,
    max_footprint_mb: Infinity,
    growth_rate: 140,
    samples: [[3e9, 5], [1e9, -0.06], [2e9, 7]],
    files: {
      "/a/x.py": {
        percent_cpu_time: 50,
        functions: [],
        imports: [],
        lines: [
          { lineno: 1, line: "x = 1 \\u003c 2\r\n", n_cpu_percent_python: 50, n_cpu_percent_c: NaN, n_sys_percent: 0, n_core_utilization: NaN, n_gpu_percent: 10 },
          { lineno: 2, line: "y = 2\n", n_cpu_percent_python: 0, n_cpu_percent_c: 0, n_sys_percent: 0, n_gpu_peak_memory_mb: Infinity },
        ],
      },
    },
  });
  assert.equal(m.caps.coreUtil, false);
  assert.equal(m.caps.gpuMemory, false);
  const l = m.files[0].byNo.get(1);
  assert.equal(l.text, "x = 1 < 2");
  assert.equal(l.nat, 0);
  assert.equal(l.total, 50);
  assert.equal(m.memory.peak, 0);
  assert.equal(m.memory.growth, 100, "growth clamped to [0, 100]");
  assert.deepEqual(Array.from(m.memory.samples), [1, -0.06, 2, 7, 3, 5]);
  assert.equal(m.gpu.method, "all-lines");
  assert.equal(r1(m.gpu.mean), 10);
  assert.equal(m.files[0].byNo.get(2).text, "y = 2");
});

test("lines are looked up by lineno, never by index", () => {
  const m = buildModel({
    elapsed_time_sec: 1,
    memory: false,
    gpu: false,
    max_footprint_mb: 0,
    growth_rate: 0,
    samples: [],
    files: {
      "[12]": {
        percent_cpu_time: 100,
        functions: [],
        imports: [],
        lines: [
          { lineno: 7, line: "b()\n", n_cpu_percent_python: 60, n_cpu_percent_c: 0, n_sys_percent: 0 },
          { lineno: 3, line: "a()\n", n_cpu_percent_python: 40, n_cpu_percent_c: 0, n_sys_percent: 0 },
          { lineno: 7, line: "dup\n", n_cpu_percent_python: 1, n_cpu_percent_c: 0, n_sys_percent: 0 },
        ],
      },
    },
  });
  const f = m.files[0];
  assert.equal(f.base, "[12]");
  assert.equal(f.dir, "");
  assert.deepEqual(f.lines.map((l) => l.no), [3, 7]);
  assert.equal(f.byNo.get(7).text, "b()");
  assert.equal(f.dense, false);
  assert.equal(m.headline.plain, "This program ran for 1.00\u00a0s. b() ([12]:7) takes 60.0% of the time.");
});
