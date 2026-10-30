// §4.0.8 edge cases on small synthetic profiles: elapsed 0, memory without
// samples, GPU with no activity, async without [await] stacks, out-of-range
// growth, leak keys sorted as strings, and Files × GPU / Await hotspots.
import assert from "node:assert/strict";
import { mod, plain, test, withModel } from "./_harness.mjs";

const { buildModel } = mod("model/model");
const { hotspotList } = mod("model/hotspots");

function line(n, extra = {}) {
  return { lineno: n, line: `x${n} = f(${n})\n`, n_cpu_percent_python: 0, n_cpu_percent_c: 0, n_sys_percent: 0, ...extra };
}

function profile(over = {}, lines = [line(1, { n_cpu_percent_python: 40 }), line(2, { n_cpu_percent_python: 20 })]) {
  return {
    program: "/w/app.py",
    elapsed_time_sec: 10,
    memory: false,
    gpu: false,
    max_footprint_mb: 0,
    growth_rate: 0,
    samples: [],
    files: { "/w/app.py": { percent_cpu_time: 60, functions: [], imports: [], lines, leaks: {} } },
    ...over,
  };
}

const tile = (m, kind) => m.readouts.find((r) => r.kind === kind);

test("elapsed_time_sec 0 / missing / NaN / negative with no samples: run length absent, never '0 s' (round 1)", () => {
  const { fmtTime } = mod("core/format");
  const { ofRun, fileShare } = mod("model/phrases");
  for (const elapsed of [0, undefined, NaN, -3, Infinity, "54"]) {
    const over = { elapsed_time_sec: elapsed };
    if (elapsed === undefined) delete over.elapsed_time_sec;
    const p = profile(over);
    if (elapsed === undefined) delete p.elapsed_time_sec;
    const m = buildModel(p);
    assert.equal(m.elapsedSource, "absent", String(elapsed));
    assert.equal(m.caps.elapsed, false);
    assert.equal(m.headline.plain, "app.py ran for an unrecorded time. x1 = f(1) (app.py:1) takes 40.0% of the time.");
    const top = m.rank.lines.time[0];
    assert.ok(Number.isNaN(top.sec), "seconds are absent");
    assert.equal(fmtTime(top.sec), "—");
    assert.equal(ofRun(top.total, top.sec), "40.0% of run", "the share stands alone");
    assert.equal(fileShare(60, m.elapsed), "60.0% of run");
    assert.ok(!m.readouts.some((r) => r.kind === "elapsed"), "no Elapsed tile");
    const hs = hotspotList(m, "lines", "time");
    assert.equal(hs.items[0].secondary, "", "no '0 s' hotspot secondary");
    assert.ok(!/0\u00a0s|—/.test(hs.items[0].ariaLabel), hs.items[0].ariaLabel);
  }
});

test("elapsed_time_sec missing but samples span 54 s: derived lower bound, 'at least' in the headline", () => {
  const lines = [line(1, { n_cpu_percent_python: 40, cpu_samples_list: [1, 20, 54.1] }), line(2, { n_cpu_percent_python: 20 })];
  const p = profile({ start_time_perf: 0, memory: true, max_footprint_mb: 64, samples: [[0.5, 10], [30, 64]] }, lines);
  delete p.elapsed_time_sec;
  const m = buildModel(p);
  assert.equal(m.elapsedSource, "derived");
  assert.equal(m.caps.elapsed, true);
  assert.ok(Math.abs(m.elapsed - 54.1) < 1e-9, String(m.elapsed));
  assert.match(m.headline.plain, /^app\.py ran for at least 54\.1\u00a0s\./);
  assert.ok(!m.readouts.some((r) => r.kind === "elapsed"), "a derived length gets no Elapsed tile");
});

test("memory: true but no samples → peak still shown, time 'not sampled'", () => {
  const m = buildModel(profile({ memory: true, max_footprint_mb: 64 }));
  const peak = tile(m, "peak");
  assert.equal(peak.value, "64.0\u00a0MiB");
  assert.equal(plain(peak.caption[0]), "time not sampled · location not recorded");
  assert.equal(peak.short, "time not sampled");
  assert.equal(m.memory.peakT, null);
  assert.equal(m.findings.find((f) => f.id === "peak"), undefined, "no peak finding without a location");
});

test("gpu: true with every n_gpu_percent = 0 → 0.0% and 'no GPU activity sampled'", () => {
  const m = buildModel(profile({ gpu: true, gpu_device: "GPU" }));
  const gpu = tile(m, "gpu");
  assert.equal(gpu.value, "0.0%");
  assert.deepEqual(gpu.caption.map(plain), ["no GPU activity sampled"]);
  assert.deepEqual(m.rank.lines.gpu, []);
});

test("async_profile without [await] stacks: Await tile from line fields", () => {
  const lines = [line(1, { n_cpu_percent_python: 30, n_async_await_percent: 80, n_async_concurrency_mean: 3, n_async_concurrency_peak: 5 }), line(2, { n_cpu_percent_python: 30 })];
  const m = buildModel(profile({ async_profile: true }, lines));
  const aw = tile(m, "await");
  assert.equal(aw.value, "80.0%");
  assert.deepEqual(aw.caption.map(plain), ["of await time at x1 = f(1) · app.py:1", "3.0 tasks suspended on average, 5 at most"]);
  assert.equal(m.async.loopLine, null);
});

test("growth_rate outside [0, 100] is clamped for display", () => {
  assert.equal(buildModel(profile({ memory: true, max_footprint_mb: 5, growth_rate: -12 })).memory.growth, 0);
  assert.equal(buildModel(profile({ memory: true, max_footprint_mb: 5, growth_rate: 250 })).memory.growth, 100);
});

test("leak keys arrive sorted as strings; leaks sort by likelihood", () => {
  const lines = Array.from({ length: 12 }, (_, i) => line(i + 1, { n_cpu_percent_python: 5, n_peak_mb: 200 }));
  const p = profile({ memory: true, max_footprint_mb: 400, growth_rate: 20 }, lines);
  p.files["/w/app.py"].leaks = {
    10: { likelihood: 0.96, velocity_mb_s: 1 },
    11: { likelihood: 0.999, velocity_mb_s: 0.5 },
    9: { likelihood: 0.999, velocity_mb_s: 2 },
  };
  const m = buildModel(p);
  assert.deepEqual(m.leaks.map((l) => l.no), [9, 11, 10]);
  assert.deepEqual(m.findings.filter((f) => f.id === "leak").map((f) => f.ref.label), ["app.py:9", "app.py:11", "app.py:10"]);
  const leaks = tile(m, "leaks");
  assert.equal(leaks.leaks.items.length, 2);
  assert.equal(leaks.leaks.more, 1);
});

test("Jupyter cell keys and paths with spaces stay verbatim", () => {
  const p = profile();
  p.files = { "[12]": p.files["/w/app.py"], "/w/my dir/é.py": { percent_cpu_time: 1, functions: [], imports: [], lines: [line(1, { n_cpu_percent_python: 1 })] } };
  const m = buildModel(p);
  assert.deepEqual(m.files.map((f) => `${f.dir}|${f.base}`), ["|[12]", "/w/my dir/|é.py"]);
});

test("hidden files: < 1 % of time and peak < 1 % of all allocation; counted and kept", () => {
  const p = profile({ memory: true, max_footprint_mb: 100 }, [line(1, { n_cpu_percent_python: 40, n_malloc_mb: 100, n_peak_mb: 50 })]);
  p.files["/w/tiny.py"] = { percent_cpu_time: 0.5, functions: [], imports: [], lines: [line(1, { n_cpu_percent_python: 0.5 })] };
  const m = buildModel(p);
  assert.deepEqual(m.hiddenFiles.map((f) => f.base), ["tiny.py"]);
  assert.equal(m.hiddenFiles[0].no, 2, "file numbers include hidden files");
  assert.equal(m.fileByName.get("/w/tiny.py").hidden, true);
  // Upstream parity: with nothing allocated, `peak < 0.01 × 0` is false, so no file hides.
  const cpu = profile();
  cpu.files["/w/tiny.py"] = p.files["/w/tiny.py"];
  assert.equal(buildModel(cpu).hiddenFiles.length, 0);
});

withModel("ml-training", "Files × GPU / Await: time-weighted file GPU mean", (m) => {
  const gpu = hotspotList(m, "files", "gpu");
  assert.ok(gpu.items.length > 0);
  assert.ok(gpu.items.every((i) => i.value > 0 && i.value <= 100 && i.meter.max === 100));
  for (let i = 1; i < gpu.items.length; i++) assert.ok(gpu.items[i - 1].value >= gpu.items[i].value);
  assert.equal(gpu.subtitle, "mean util. while running · lines ≥ 1% of run");
  assert.equal(hotspotList(m, "files", "await").items.length, 0);
});

withModel("async-server", "Files × Await sums await shares", (m) => {
  const aw = hotspotList(m, "files", "await");
  assert.equal(aw.items[0].code, "bench_server.py");
  const sum = aw.items.reduce((a, i) => a + i.value, 0);
  assert.ok(Math.abs(sum - 100) < 1, `await shares add up (${sum})`);
});

test("Python NaN/Infinity tokens: parsed as absent in load(text) and the loader (round 1)", () => {
  const { replaceNonFiniteTokens, parseProfileText } = mod("model/normalize");
  const { validateProfileText } = mod("views/shell/loader");
  assert.equal(replaceNonFiniteTokens('{"a": NaN, "b": [Infinity, -Infinity], "s": "NaN Infinity \\" NaN"}'), '{"a": null, "b": [null, null], "s": "NaN Infinity \\" NaN"}');
  assert.equal(replaceNonFiniteTokens('{"a": 1}'), '{"a": 1}');
  const p = profile();
  const text = JSON.stringify(p, null, 4).replace('"growth_rate": 0', '"growth_rate": Infinity').replace('"n_cpu_percent_c": 0', '"n_cpu_percent_c": NaN');
  assert.ok(/Infinity/.test(text) && /NaN/.test(text));
  const r = parseProfileText(text);
  assert.equal(r.ok, true);
  assert.equal(r.value.growth_rate, null);
  assert.equal(validateProfileText(text).ok, true, "file picker / drag-and-drop path");
  assert.equal(parseProfileText('{"files": ').ok, false);
  assert.match(parseProfileText('{"files": ').message, /JSON/);
  const m = buildModel(text);
  assert.equal(m.headline.plain.startsWith("app.py ran for 10.0 s."), true);
});

test("growth_rate absent or non-finite → 'growth not recorded', never 'growth 0%' (round 1)", () => {
  for (const g of [undefined, NaN, Infinity, null]) {
    const p = profile({ memory: true, max_footprint_mb: 64, growth_rate: g });
    if (g === undefined) delete p.growth_rate;
    const m = buildModel(p);
    assert.equal(m.memory.growthRecorded, false, String(g));
    assert.ok(plain(tile(m, "peak").caption[1]).includes("growth not recorded"));
  }
  const m = buildModel(profile({ memory: true, max_footprint_mb: 64, growth_rate: 0 }));
  assert.ok(plain(tile(m, "peak").caption[1]).includes("growth 0%"), "a recorded 0 stays 0%");
});
