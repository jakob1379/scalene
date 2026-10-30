// §4.0.4 / §4.8.5 visibility: our row classes must reproduce upstream's
// `makeProfileLine` + `applyFileDisplayMode` (scalene-gui.ts) on every
// fixture and mode. The port below is upstream's code with only the
// documented fixes: region de-dup per file (upstream keyed it without the
// file name) and region lines looked up by lineno (upstream indexed the
// array, which breaks on sparse files).
import assert from "node:assert/strict";
import { fixture, FIXTURES, mod, test, withModel } from "./_harness.mjs";

const v = mod("model/visibility");
const maxLinesPerRegion = 50;

function upstreamClasses(prof, filename) {
  let hasNeuronData = false;
  for (const f in prof.files) {
    for (const line of prof.files[f].lines) {
      if ((line.nc_time_ms ?? 0) > 0 || (line.nrt_time_ms ?? 0) > 0 || (line.nrt_percent ?? 0) > 0) hasNeuronData = true;
    }
  }
  const lines = prof.files[filename].lines;
  const byNo = new Map(lines.map((l) => [l.lineno, l]));
  const memoryResults = (l) => l.n_avg_mb + l.n_peak_mb + l.memory_samples.length + (l.n_usage_fraction >= 0.01 ? 1 : 0);
  const profiledFunctions = new Set();
  for (const line of lines) {
    const total = line.n_cpu_percent_python + line.n_cpu_percent_c + line.n_sys_percent;
    const nrt = (line.nrt_time_ms !== undefined && line.nrt_time_ms > 0) || (line.nc_time_ms !== undefined && line.nc_time_ms > 0);
    const has = total > 1.0 || memoryResults(line) || (line.n_gpu_percent >= 1.0 && prof.gpu && !hasNeuronData) || nrt;
    if (has && line.start_function_line > 0) profiledFunctions.add(`${line.start_function_line},${line.end_function_line}`);
  }
  const showedExplosion = {};
  const out = new Map();
  for (const line of lines) {
    const total_time = line.n_cpu_percent_python + line.n_cpu_percent_c + line.n_sys_percent;
    let total_region_time = 0;
    let region_has_memory_results = 0;
    let region_has_gpu_results = false;
    for (let lineno = line.start_region_line; lineno < line.end_region_line; lineno++) {
      const currline = byNo.get(lineno + 1); // upstream: lines[lineno] (0-based array)
      if (!currline) continue;
      total_region_time += currline.n_cpu_percent_python + currline.n_cpu_percent_c + currline.n_sys_percent;
      region_has_memory_results += memoryResults(currline);
      region_has_gpu_results = region_has_gpu_results || line.n_gpu_percent >= 1.0;
    }
    const has_memory_results = memoryResults(line);
    const has_gpu_results = line.n_gpu_percent >= 1.0;
    const has_nrt_results = (line.nrt_time_ms !== undefined && line.nrt_time_ms > 0) || (line.nc_time_ms !== undefined && line.nc_time_ms > 0);
    const start = line.start_region_line;
    const end = line.end_region_line;
    let showExplosion;
    const regionKey = `${start - 1},${end}`;
    if (start === end || regionKey in showedExplosion) showExplosion = false;
    else if (start && end) {
      showedExplosion[regionKey] = true;
      showExplosion = true;
    } else showExplosion = false;
    showExplosion = showExplosion && end - start <= maxLinesPerRegion;
    const has_async_results = prof.async_profile && (line.n_async_await_percent || 0) >= 1.0;
    const hasProfileData =
      total_time > 1.0 ||
      has_memory_results ||
      (has_gpu_results && prof.gpu && !hasNeuronData) ||
      has_nrt_results ||
      has_async_results ||
      (showExplosion &&
        start !== end &&
        (total_region_time >= 1.0 || region_has_memory_results || (region_has_gpu_results && prof.gpu && !hasNeuronData)));
    const functionKey = line.start_function_line > 0 ? `${line.start_function_line},${line.end_function_line}` : "";
    const inProfiledFunction = functionKey !== "" && profiledFunctions.has(functionKey);
    out.set(line.lineno, hasProfileData ? "" : inProfiledFunction ? "function-context" : "empty-profile");
  }
  return out;
}

function upstreamVisible(classes, mode) {
  const shown = [];
  for (const [no, cls] of classes) {
    if (mode === "all") shown.push(no);
    else if (mode === "profiled-lines") {
      if (cls !== "empty-profile" && cls !== "function-context") shown.push(no);
    } else if (cls !== "empty-profile") shown.push(no);
  }
  return shown;
}

const OURS = { data: "", context: "function-context", empty: "empty-profile" };
const MODES = ["profiled-functions", "profiled-lines", "all"];

for (const name of FIXTURES) {
  withModel(name, "row classes and display modes match upstream on every file", (m) => {
    const raw = fixture(name);
    for (const file of m.files.concat(m.hiddenFiles)) {
      const up = upstreamClasses(raw, file.name);
      for (const l of file.lines) assert.equal(OURS[l.cls], up.get(l.no), `${file.base}:${l.no} (${l.text.trim().slice(0, 40)})`);
      for (const mode of MODES) {
        assert.deepEqual(v.visibleLines(file, mode).map((l) => l.no), upstreamVisible(up, mode), `${file.base} ${mode}`);
      }
    }
  });
}

withModel("basic", "upstream example: 52 lines → 11 visible by default", (m) => {
  const f = m.files[0];
  assert.equal(f.lines.length, 52);
  assert.equal(v.shownCount(f, "profiled-functions"), 11);
  assert.equal(v.shownCount(f, "profiled-lines"), 11);
  assert.equal(v.shownCount(f, "all"), 52);
});

withModel("ml-training", "hot region head stays visible; context rows; no hidden data row", (m) => {
  const train = m.files[0];
  const head = train.byNo.get(152);
  assert.equal(head.total, 0);
  assert.equal(head.cls, "data", "for-loop header of a hot region is a data row");
  const shown = new Set(v.visibleLines(train, "profiled-functions").map((l) => l.no));
  for (const l of train.lines) if (l.cls === "data") assert.ok(shown.has(l.no));
  assert.ok(train.lines.some((l) => l.cls === "context"));
  const items = v.buildCodeItems(train, "profiled-functions", null, []);
  const itemLines = items.filter((i) => i.kind === "line").map((i) => i.line.no);
  assert.deepEqual(itemLines, [...shown]);
});

function checkStructure(file, mode) {
  const items = v.buildCodeItems(file, mode, null, []);
  const keys = new Set();
  let covered = 0;
  let last = 0;
  for (const it of items) {
    assert.ok(!keys.has(it.key), `unique key ${it.key}`);
    keys.add(it.key);
    if (it.kind === "line") {
      assert.ok(it.line.no > last, "source order");
      last = it.line.no;
      covered++;
    } else if (it.kind === "fold" || it.kind === "gap") {
      assert.ok(it.start > last && it.end >= it.start);
      assert.equal(it.count, it.end - it.start + 1);
      last = it.end;
      if (it.kind === "fold") covered += file.lines.filter((l) => l.no >= it.start && l.no <= it.end).length;
    }
  }
  assert.equal(covered, file.lines.length, "every line is a row or inside a fold: nothing hides silently");
  return items;
}

for (const name of FIXTURES) {
  withModel(name, "folds and gaps cover every line in every mode", (m) => {
    for (const file of m.files.concat(m.hiddenFiles)) for (const mode of MODES) checkStructure(file, mode);
  });
}

withModel("ml-training", "folds: one per hidden run, split at function headers; reveal one fold only", (m) => {
  const train = m.files[0];
  const items = checkStructure(train, "profiled-lines");
  const folds = items.filter((i) => i.kind === "fold");
  assert.ok(folds.length > 3);
  // Consecutive folds only where a function header separates them.
  for (let i = 1; i < items.length; i++) {
    if (items[i].kind === "fold") assert.notEqual(items[i - 1].kind, "fold");
  }
  const headers = items.filter((i) => i.kind === "fnHeader");
  assert.equal(headers.length, train.functions.length);
  for (const h of headers) {
    const next = items[items.indexOf(h) + 1];
    const start = next.kind === "line" ? next.line.no : next.start;
    assert.equal(start, h.fn.no, `${h.fn.name} header sits right before its first line`);
  }
  const target = folds[1];
  const revealed = v.buildCodeItems(train, "profiled-lines", null, [target.start]);
  assert.equal(revealed.filter((i) => i.kind === "fold").length, folds.length - 1);
  const revealedLines = revealed.filter((i) => i.kind === "line" && i.line.no >= target.start && i.line.no <= target.end);
  assert.equal(revealedLines.length, target.count);
  const hiddenLine = target.start;
  assert.equal(v.foldStartFor(train, "profiled-lines", hiddenLine), target.start);
  assert.equal(v.foldStartFor(train, "profiled-lines", 173), null);
  const t = folds.find((f) => f.total > 0);
  if (t) assert.ok(t.total > 0, "fold carries its share of run");
});

withModel("example", "sparse file: gap items in All lines; folds absorb missing lines elsewhere", (m) => {
  const f = m.files[0];
  const all = checkStructure(f, "all");
  const gaps = all.filter((i) => i.kind === "gap");
  const missing = f.lines[f.lines.length - 1].no - f.lines.length;
  assert.equal(gaps.reduce((a, g) => a + g.count, 0), missing);
  assert.equal(gaps[0].key, `G:${gaps[0].start}`);
  checkStructure(f, "profiled-functions");
});

withModel("ml-training", "ranked mode: visible rows only, keyless last both ways, ties by lineno", (m) => {
  const train = m.files[0];
  const desc = v.buildCodeItems(train, "profiled-functions", { key: "time", dir: "desc" }, []);
  assert.ok(desc.every((i) => i.kind === "line"), "no folds or headers when ranked");
  assert.equal(desc[0].line.no, 173);
  assert.equal(desc[1].line.no, 165);
  const asc = v.buildCodeItems(train, "profiled-functions", { key: "time", dir: "asc" }, []);
  const keyed = (items) => items.filter((i) => i.line.total > 0);
  assert.equal(asc.length, desc.length);
  assert.ok(keyed(asc).length > 0);
  assert.equal(asc.slice(0, keyed(asc).length).every((i) => i.line.total > 0), true, "zeros last in ascending order too");
  for (let i = 1; i < keyed(asc).length; i++) assert.ok(asc[i - 1].line.total <= asc[i].line.total);
  const zeros = asc.filter((i) => i.line.total === 0).map((i) => i.line.no);
  assert.deepEqual(zeros, [...zeros].sort((a, b) => a - b));
  const bySource = v.buildCodeItems(train, "profiled-functions", { key: "line", dir: "asc" }, []);
  assert.ok(bySource.some((i) => i.kind === "fnHeader"), "# sorts back to source order");
  const mem = v.rankLines(train.lines, { key: "mem", dir: "desc" });
  assert.equal(mem[0].no, 120);
});

withModel("ml-training", "lens and AI cards follow their anchor rows", (m) => {
  const train = m.files[0];
  const items = v.buildCodeItems(train, "profiled-functions", null, [], { lensAfter: "L:173", aiAnchors: [173, 165] });
  const i173 = items.findIndex((i) => i.key === "L:173");
  assert.deepEqual(items.slice(i173, i173 + 3).map((i) => i.kind), ["line", "lens", "aiCard"]);
  assert.equal(items[i173 + 1].anchor, "L:173");
  const i165 = items.findIndex((i) => i.key === "L:165");
  assert.equal(items[i165 + 1].key, "ai:165");
  const ranked = v.buildCodeItems(train, "profiled-functions", { key: "time", dir: "desc" }, [], { lensAfter: "L:165" });
  assert.deepEqual(ranked.slice(0, 3).map((i) => i.key), ["L:173", "L:165", "lens"]);
  const header = items.find((i) => i.kind === "fnHeader");
  const withFnLens = v.buildCodeItems(train, "profiled-functions", null, [], { lensAfter: header.key });
  assert.equal(withFnLens[withFnLens.findIndex((i) => i.key === header.key) + 1].kind, "lens");
});

test("sort values per column", () => {
  const line = {
    total: 3, peak: 2, gpu: 50, await: 0, copy: 4, gpuPeak: null, usage: 0.2, avg: 1,
    neuron: { nrtMs: 0, nrtPct: 12, ncMs: 5, idlePct: 40 },
  };
  assert.equal(v.sortValue(line, "time"), 3);
  assert.equal(v.sortValue(line, "nrt"), 12, "nrt falls back to nrt_percent");
  assert.equal(v.sortValue(line, "idle"), 40);
  assert.equal(v.sortValue(line, "gpumem"), null);
  assert.equal(v.sortValue({ ...line, neuron: null }, "idle"), null);
  assert.equal(v.isSortable("trend"), false);
  assert.equal(v.isSortable("source"), false);
  assert.equal(v.isSortable("alloc"), true);
});
