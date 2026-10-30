// WP3 code view logic (DESIGN.md §4.7–4.10): column budget, meter backgrounds, wrapped
// heights, lens partitioning, minimap geometry, function ranking, breakpoint layout, and the
// §4.8.5 / §4.8.8 item lists the view renders (display modes, folds, ranking, lens/AI order).
import assert from "node:assert/strict";
import { lineOf, mod, test, withModel } from "./_harness.mjs";

const cols = mod("views/code/columns");
const src = mod("views/code/source");
const det = mod("views/code/detail");
const mini = mod("views/code/minimap");
const fns = mod("views/code/functions");
const sec = mod("views/code/codesection");
const nav = mod("views/code/filenav");
const vis = mod("model/visibility");
const th = mod("model/thresholds");

// ── Column budget (§4.8.3) ─────────────────────────────────────────────────

/** Body width of the code table at a viewport width (gutter, rail, dock, ribbon, borders). */
function bodyWidth(vw) {
  const gutter = vw >= 2200 ? 40 : vw >= 1280 ? 32 : vw >= 1024 ? 24 : vw >= 600 ? 20 : 16;
  const content = Math.min(2360, vw - 2 * gutter);
  const gap = vw >= 2200 ? 24 : vw >= 1600 ? 20 : vw >= 600 ? 16 : 12;
  const rail = vw >= 2200 ? 280 + gap : 0;
  const dock = vw >= 2200 ? 420 + gap : vw >= 1600 ? 380 + gap : 0;
  const ribbon = vw >= 1280 ? 56 : vw >= 1024 ? 48 : 0;
  return content - rail - dock - 2 - ribbon;
}

const bp = (vw) => (vw >= 2200 ? "xxl" : vw >= 1600 ? "xl" : vw >= 1280 ? "lg" : vw >= 1024 ? "md" : vw >= 600 ? "sm" : "xs");

withModel("ml-training", "columns at 2560 = line, time, mem, gpu, trend, copy, gpumem, alloc, avg, source (Appendix A.1)", (m) => {
  const present = th.profileColumns(m);
  assert.deepEqual(cols.fitColumns(present, bodyWidth(2560), "xxl"), ["line", "time", "mem", "gpu", "trend", "copy", "gpumem", "alloc", "avg", "source"]);
});

withModel("ml-training", "columns shrink by priority as the width drops; source keeps its minimum", (m) => {
  const present = th.profileColumns(m);
  for (const vw of [2560, 1920, 1440, 1280, 1024, 800, 600]) {
    const c = cols.fitColumns(present, bodyWidth(vw), bp(vw));
    const fixed = cols.fixedWidth(c, bp(vw));
    assert.ok(bodyWidth(vw) - fixed >= cols.sourceMin(bp(vw)) || c.length === 3, `source ≥ min at ${vw}`);
    assert.ok(c.includes("line") && c.includes("time") && c.includes("source"), `always line/time/source at ${vw}`);
  }
  // Priority order: mem (2) before gpu (3) before trend (6) …
  const min = cols.sourceMin("lg");
  assert.deepEqual(cols.fitColumns(present, 52 + 124 + 132 + min, "lg"), ["line", "time", "mem", "source"]);
  assert.deepEqual(cols.fitColumns(present, 52 + 124 + 132 + 104 + min, "lg"), ["line", "time", "mem", "gpu", "source"]);
  // "while Σ + next ≤ available − sourceMin": the first column that does not fit stops the walk.
  // gpu (104 px) does not fit but trend (76 px) would: the walk still stops at gpu.
  assert.deepEqual(cols.fitColumns(present, 52 + 124 + 132 + 90 + min, "lg"), ["line", "time", "mem", "source"]);
});

// Round 1 (source-column-starved): the code keeps ≥ 640 px at lg+ and ≥ 420 at sm/md (400 in
// short hosts); Alloc / Avg (and Copy / GPU mem at md) move to the detail panel first.
withModel("ml-training", "round 1: the source column is never starved (1440, 1024, 1000×400)", (m) => {
  const present = th.profileColumns(m);
  const at1440 = cols.fitColumns(present, bodyWidth(1440), "lg");
  assert.deepEqual(at1440, ["line", "time", "mem", "gpu", "trend", "copy", "gpumem", "source"]);
  assert.ok(bodyWidth(1440) - cols.fixedWidth(at1440, "lg") >= 640);
  const at1024 = cols.fitColumns(present, bodyWidth(1024), "md");
  assert.deepEqual(at1024, ["line", "time", "mem", "gpu", "trend", "source"]);
  assert.ok(bodyWidth(1024) - cols.fixedWidth(at1024, "md") >= 420);
  // Jupyter 1000×400: sm + short, no ribbon.
  const w = 1000 - 2 * 20 - 2;
  const short = cols.fitColumns(present, w, "sm", true);
  assert.deepEqual(short, ["line", "time", "mem", "gpu", "trend", "source"]);
  assert.ok(w - cols.fixedWidth(short, "sm") >= 400);
  // 2560 still shows every column (Appendix A.1).
  assert.equal(cols.fitColumns(present, bodyWidth(2560), "xxl").length, 10);
});

withModel("neuron", "neuron columns include idle / nrt / nc and no GPU columns", (m) => {
  const c = cols.fitColumns(th.profileColumns(m), bodyWidth(2560), "xxl");
  for (const k of ["idle", "nrt", "nc"]) assert.ok(c.includes(k), k);
  assert.ok(!c.includes("gpu") && !c.includes("gpumem"));
});

withModel("cpu-only", "cpu-only columns: line, time, source", (m) => {
  assert.deepEqual(cols.fitColumns(th.profileColumns(m), bodyWidth(2560), "xxl"), ["line", "time", "source"]);
});

withModel("async-server", "async columns include await (priority 3) and no GPU", (m) => {
  const c = cols.fitColumns(th.profileColumns(m), bodyWidth(1440), "lg");
  assert.ok(c.includes("await") && !c.includes("gpu"));
});

test("xs keeps only line + a 72 px time column", () => {
  const all = ["line", "time", "mem", "gpu", "trend", "copy", "gpumem", "alloc", "avg", "source"];
  assert.deepEqual(cols.fitColumns(all, 358, "xs"), ["line", "time", "source"]);
  assert.equal(cols.columnWidth("time", "xs"), 72);
  assert.equal(cols.meterWidth("time", "xs"), 24);
  assert.equal(cols.gridTemplate(["line", "time", "source"], "xs"), "52px 72px minmax(0, 1fr)");
  assert.deepEqual([cols.sourceMin("xs"), cols.sourceMin("sm"), cols.sourceMin("md"), cols.sourceMin("lg"), cols.sourceMin("xxl")], [160, 420, 420, 640, 640]);
  assert.deepEqual([cols.sourceMin("sm", true), cols.sourceMin("md", true), cols.sourceMin("lg", true)], [400, 400, 640]);
});

// ── Meter backgrounds (§3.3, one element per cell) ─────────────────────────

test("meterBackground: Python → native → system stops, hatch tile over system, sunken track", () => {
  const segs = cols.timeSegments(0.1, 7.2, 14.1);
  const bg = cols.meterBackground(segs, 21.4, 64);
  const layers = bg.split(/,\s*(?![^()]*\))/);
  // hatch layer first, then the stop gradient, then the track colour
  assert.match(layers[0], /^repeating-linear-gradient\(45deg/);
  assert.match(bg, /var\(--cpu-py\) 0px 2px/); // 0.1 / 21.4 × 64 = 0.3 px → 2 px minimum
  assert.match(bg, /var\(--cpu-native\) 2px /);
  assert.match(bg, /var\(--cpu-sys\) /);
  assert.equal(layers[layers.length - 1].trim(), "var(--sunken)");
  // full row #1 fills the whole 64 px track
  assert.match(bg, /transparent 64px\)/);
});

test("meterBackground: avg tick on top, empty meter is only the track, waiting hatch at 135°", () => {
  const bg = cols.meterBackground(cols.memSegments(100, 0.25), 400, 56, 50);
  assert.ok(bg.startsWith("linear-gradient(var(--fg-2), var(--fg-2)) 6.5px 0 / 1px 100% no-repeat"), bg);
  assert.match(bg, /var\(--mem-py\) 0px 3.5px/);
  assert.match(bg, /var\(--mem-native\) 3.5px 14px/);
  assert.equal(cols.meterBackground([], 10, 64), "var(--sunken)");
  assert.match(cols.meterBackground([{ value: 3, token: "async", hatch: "waiting" }], 10, 40), /repeating-linear-gradient\(135deg/);
});

test("sparkUri: data-URI SVG with baseline, polyline and max dot", () => {
  const samples = Float64Array.from([0, 10, 5, 40, 10, 20]);
  const uri = cols.sparkUri(samples, 10, 40, "#007137", "#CDD2DA");
  assert.match(uri, /^url\("data:image\/svg\+xml,/);
  const svg = decodeURIComponent(uri.slice('url("data:image/svg+xml,'.length, -2));
  assert.match(svg, /<polyline points='[\d., ]+'/);
  assert.match(svg, /<circle cx='32' cy='1.5'/); // max point (t=5, 40\u00a0MiB) at the top centre
  assert.match(svg, /stroke='#CDD2DA'/);
});

// ── Wrapped rows (§4.8.10) ──────────────────────────────────────────────────

test("tab expansion and hanging indent for wrapped rows", () => {
  assert.equal(src.expandTabs("\tx\ty"), "    x   y");
  // Hanging indent: continuation lines start under the indent + 2 (capped at half the width).
  assert.equal(src.leadingColumns("        return x"), 8);
  assert.equal(src.hangFor(8, 40), 10);
  assert.equal(src.hangFor(30, 40), 20);
  assert.equal(src.textColumns("\tif a >= b:"), 14);
  const spans = src.expandSpans([{ cls: "", text: "\t" }, { cls: "t-kw", text: "return" }, { cls: "", text: "\t1" }]);
  assert.deepEqual(spans.map((s) => s.text), ["    ", "return", "  1"]);
});

test("word-aware wrap: breaks after spaces / commas / brackets, before .attr, never inside the indent", () => {
  // "import torch.nn.functional as F" at 28 columns: the last fitting opportunity is after "functional ".
  assert.deepEqual(src.wrapBreaks("import torch.nn.functional as F", 28, 2), [27]);
  // Fits → no break; one column too narrow → breaks before the last word.
  assert.deepEqual(src.wrapBreaks("x = foo(a, b)", 13, 2), []);
  assert.deepEqual(src.wrapBreaks("x = foo(a, b)", 12, 2), [11]);
  // Indented line: never breaks inside the leading spaces; a token longer than the
  // continuation width (cpl − hang) breaks hard, like overflow-wrap: anywhere.
  const t = "        return some_long_name_without_spaces_here";
  const hang = src.hangFor(src.leadingColumns(t), 20);
  assert.equal(hang, 10);
  assert.deepEqual(src.wrapBreaks(t, 20, hang), [15, 25, 35, 45]);
  assert.equal(src.wrappedRows(t, 20, hang), 5);
  // A space run at the edge hangs: the next line starts at the next word.
  assert.deepEqual(src.wrapBreaks("aaaa    bbbb", 6, 0), [8]);
  // Never a sliver: an opportunity that leaves the line < 1/3 full is skipped for a hard break.
  assert.deepEqual(src.wrapBreaks("a = xxxxxxxxxxxxxxxxxxxxxxxx", 20, 0), [20]);
  // Lookahead: the break that finishes the line in one more row wins ("cfg.warmup_steps" whole
  // on the next row would need 17 > 15 columns, so the dot break finishes in 2 rows).
  assert.deepEqual(src.wrapBreaks("        if step < cfg.warmup_steps:", 25, 10), [21]);
  // A soft break that fills half the line is preferred over a dot break.
  assert.deepEqual(src.wrapBreaks("progress = (step - cfg.warmup_steps) / max(1, cfg.max_steps - cfg.warmup_steps)", 24, 2), [19, 39, 62]);
  // … and a soft break that fills a third of the line beats splitting "cfg.max_steps".
  assert.deepEqual(src.wrapBreaks("    progress = (step - cfg.warmup_steps) / max(1, cfg.max_steps - cfg.warmup_steps)", 25, 6), [23, 43, 50, 66]);
  // Before ".name" (attribute access), after "(" / "[" / ",".
  assert.deepEqual(src.wrapBreaks("torch.backends.cuda.matmul", 20, 2), [19]);
  assert.deepEqual(src.wrapBreaks("f(alpha,beta,gamma)", 13, 0), [13]);
  // Every visual line fits its width (first line cpl, continuations cpl − hang).
  for (const line of ["        val_loader = ThreadedPrefetcher(val_set, cfg.batch_size, num_workers=1, seed=1)", '    """Linear warmup followed by cosine decay down to min_lr."""', "x" + "y".repeat(90)]) {
    for (const cpl of [12, 24, 31, 40]) {
      const h2 = src.hangFor(src.leadingColumns(line), cpl);
      const b = src.wrapBreaks(line, cpl, h2);
      const cuts = [0, ...b, line.length];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const seg = line.slice(cuts[k], cuts[k + 1]).replace(/ +$/, "");
        assert.ok(seg.length <= (k === 0 ? cpl : cpl - h2), `${cpl}: "${seg}"`);
        assert.ok(k === 0 || line[cuts[k]] !== " ", "continuations start at text");
      }
    }
  }
  // Wide (CJK) characters take two columns.
  assert.equal(src.charCols("数".codePointAt(0)), 2);
  assert.equal(src.charCols("a".codePointAt(0)), 1);
  assert.deepEqual(src.wrapBreaks("数据数据数据", 6, 0), [3]);
});

test("renderWrappedSpans splits spans at the breaks with unselectable newline spans", () => {
  const saved = globalThis.document;
  globalThis.document = {
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    createElement: (tag) => ({ tagName: tag, className: "", textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
  };
  try {
    const spans = [{ cls: "t-kw", text: "import" }, { cls: "", text: " torch.nn.functional " }, { cls: "t-kw", text: "as" }, { cls: "", text: " F" }];
    const nodes = src.renderWrappedSpans(spans, [27]);
    const text = nodes.map((n) => n.textContent).join("");
    assert.equal(text, "import torch.nn.functional \nas F");
    const brk = nodes.find((n) => n.className === "cv-wbr");
    assert.ok(brk && brk.attrs["aria-hidden"] === "true");
    // Classes survive the split; a break inside a span splits it in two.
    const mid = src.renderWrappedSpans([{ cls: "t-str", text: '"abcdef"' }], [4]);
    assert.deepEqual(mid.map((n) => [n.className ?? "", n.textContent]), [["t-str", '"abc'], ["cv-wbr", "\n"], ["t-str", 'def"']]);
  } finally {
    globalThis.document = saved;
  }
});

// ── Detail panel (§4.9) ─────────────────────────────────────────────────────

test("revealIn scrolls only its box, on one axis, clearing the fade padding", () => {
  const box = (l, r, t, b) => ({ scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: l, right: r, top: t, bottom: b }) });
  const el = (l, r, t, b) => ({ getBoundingClientRect: () => ({ left: l, right: r, top: t, bottom: b }) });
  const strip = box(0, 300, 0, 40);
  nav.revealIn(strip, el(400, 480, 0, 40), "x", 32);
  assert.equal(strip.scrollLeft, 212); // right edge lands 32 px inside
  assert.equal(strip.scrollTop, 0);
  const s2 = box(0, 300, 0, 40);
  nav.revealIn(s2, el(-50, 30, 0, 40), "x", 32);
  assert.equal(s2.scrollLeft, -82);
  const s3 = box(0, 300, 0, 40);
  nav.revealIn(s3, el(100, 200, 0, 40), "x", 32);
  assert.equal(s3.scrollLeft, 0); // already visible: no scroll
  // An item wider than the box aligns its start (never overshoots past the left pad).
  const s4 = box(0, 100, 0, 40);
  nav.revealIn(s4, el(150, 400, 0, 40), "x", 10);
  assert.equal(s4.scrollLeft, 140);
  const rail = box(0, 280, 100, 500);
  nav.revealIn(rail, el(0, 280, 600, 640), "y", 8);
  assert.equal(rail.scrollTop, 148);
});

test("middleEllipsis keeps the head and the tail of long kernel paths", () => {
  assert.equal(det.middleEllipsis("short", 34), "short");
  const k = "/var/tmp/neuron-compile-cache/neuronxcc-2.15/MODULE_744187612+d41d8cd9/model.neff";
  const e = det.middleEllipsis(k, 34);
  assert.equal(Array.from(e).length, 34);
  assert.ok(e.startsWith("/var/tmp/neuro") && e.endsWith("d41d8cd9/model.neff") && e.includes("…"), e);
});

test("partitionBlocks keeps reading order and balances the tallest column", () => {
  assert.deepEqual(det.partitionBlocks([150, 86, 260, 110, 220], 3), [[0, 1], [2], [3, 4]]);
  assert.deepEqual(det.partitionBlocks([150, 86], 3), [[0], [1]]);
  assert.deepEqual(det.partitionBlocks([100, 100, 100, 100], 2), [[0, 1], [2, 3]]);
  assert.deepEqual(det.partitionBlocks([10, 20, 30], 1), [[0, 1, 2]]);
  assert.deepEqual(det.partitionBlocks([], 3), []);
});

// ── Minimap (§4.8.9) ─────────────────────────────────────────────────────────

test("ribbon rows are ≤ 4 px and fill the height for long files", () => {
  assert.deepEqual(mini.ribbonScale(100, 800), { row: 4, content: 400 });
  const s = mini.ribbonScale(1283, 776);
  assert.ok(Math.abs(s.row - 776 / 1283) < 1e-9 && Math.abs(s.content - 776) < 1e-9);
  assert.deepEqual(mini.ribbonScale(0, 500), { row: 0, content: 0 });
});

test("rank pins de-overlap downward in 15 px steps and push back from the bottom", () => {
  assert.deepEqual(mini.placePins([100, 104, 110], 15, 8, 500), [100, 115, 130]);
  assert.deepEqual(mini.placePins([110, 100], 15, 8, 500), [115, 100]); // input order kept
  assert.deepEqual(mini.placePins([2], 15, 8, 500), [8]); // clamped below the top
  assert.deepEqual(mini.placePins([490, 495], 15, 8, 492), [477, 492]);
});

// ── Function view (§4.10) ──────────────────────────────────────────────────

withModel("ml-training", "function view: Time ↓ default, keyless last both ways, null = first line", (m) => {
  const f = m.files[0];
  const desc = fns.rankFunctions(f.functions, { key: "time", dir: "desc" }).map((x) => x.name);
  assert.equal(desc[0], "train");
  const byLine = fns.rankFunctions(f.functions, null).map((x) => x.no);
  assert.deepEqual(byLine, byLine.slice().sort((a, b) => a - b));
  const memAsc = fns.rankFunctions(f.functions, { key: "mem", dir: "asc" });
  const keyless = memAsc.findIndex((x) => !(x.peak > 0));
  if (keyless >= 0) assert.ok(memAsc.slice(keyless).every((x) => !(x.peak > 0)), "zero peaks last in asc");
  const memDesc = fns.rankFunctions(f.functions, { key: "mem", dir: "desc" });
  assert.equal(memDesc[0].name, "save_checkpoint");
});

withModel("neuron", "function columns drop the line-only Neuron columns", (m) => {
  const c = fns.functionColumns(m, m.files[0]);
  assert.ok(!c.includes("idle") && !c.includes("nrt") && !c.includes("nc"));
});

withModel("ml-training", "function source shows the def line, not the decorator", (m) => {
  const ev = m.files[0].functions.find((f) => f.name === "evaluate");
  assert.match(m.files[0].byNo.get(ev.no).text, /@torch\.no_grad/);
  assert.match(fns.defLine(ev).text, /^\s*def evaluate\(/);
});

// ── Layout per breakpoint (§2.4.3) ──────────────────────────────────────────

test("code layout: switcher / tabs / rail, dock at xl+, lens columns 1 / 2 / 3", () => {
  const L = (b, short = false) => sec.codeLayout({ bp: b, short, coarse: false });
  assert.deepEqual([L("xs").nav, L("sm").nav, L("md").nav, L("lg").nav, L("xl").nav, L("xxl").nav, L("lg", true).nav], ["switcher", "switcher", "tabs", "tabs", "tabs", "rail", "switcher"]);
  assert.deepEqual([L("lg").dock, L("xl").dock, L("xxl").dock, L("xl", true).dock], [false, true, true, false]);
  assert.deepEqual([L("xs").lensCols, L("sm").lensCols, L("md").lensCols, L("lg").lensCols, L("lg", true).lensCols], [1, 2, 3, 3, 2]);
  assert.equal(L("xs").sheet, "bottom");
  assert.equal(L("sm").sheet, "popover");
});

// ── Items the view renders (§4.8.5, §4.8.8, visibility.ts) ──────────────────

withModel("ml-training", "train.py Profiled functions: every data row listed, every hidden run is one fold", (m) => {
  const f = m.files[0];
  assert.equal(f.base, "train.py");
  const items = vis.buildCodeItems(f, "profiled-functions", null, []);
  const listed = new Set(items.filter((i) => i.kind === "line").map((i) => i.line.no));
  for (const l of f.lines) {
    if (l.cls === "data") assert.ok(listed.has(l.no), `data row ${l.no} listed`);
    if (l.cls === "empty") assert.ok(!listed.has(l.no), `empty row ${l.no} folded`);
  }
  // Folds tile the hidden lines exactly (no line hidden silently, no overlap).
  const folded = new Set();
  for (const it of items) if (it.kind === "fold") for (let n = it.start; n <= it.end; n++) folded.add(n);
  for (const l of f.lines) assert.equal(listed.has(l.no) !== folded.has(l.no), true, `line ${l.no} is either listed or folded`);
  // Hot lines ⊂ Profiled functions ⊂ All lines.
  const hot = vis.visibleLines(f, "profiled-lines").length;
  const pf = vis.visibleLines(f, "profiled-functions").length;
  assert.ok(hot < pf && pf < f.lines.length);
  assert.equal(vis.buildCodeItems(f, "all", null, []).filter((i) => i.kind === "fold").length, 0);
});

withModel("ml-training", "revealing one fold shows only that fold; jump target fold found by foldStartFor", (m) => {
  const f = m.files[0];
  const start = vis.foldStartFor(f, "profiled-functions", 5);
  assert.equal(start, 1);
  const before = vis.buildCodeItems(f, "profiled-functions", null, []).filter((i) => i.kind === "fold").length;
  const after = vis.buildCodeItems(f, "profiled-functions", null, [start]);
  assert.equal(after.filter((i) => i.kind === "fold").length, before - 1);
  assert.ok(after.some((i) => i.key === "L:5"));
});

// Round 1 (fold-copy-says-without-samples): the fold says what it holds.
withModel("ml-training", "round 1: fold copy — 'without samples' only when nothing was sampled, else 'below 1% each'", (m) => {
  const cv = mod("views/code/codeview");
  const f = m.files[0];
  const folds = vis.buildCodeItems(f, "profiled-functions", null, []).filter((i) => i.kind === "fold");
  assert.equal(cv.foldText(f, 1, 15, 0), "15 lines without samples · 1–15");
  const f19 = folds.find((i) => i.start === 19);
  assert.equal(cv.foldText(f, f19.start, f19.end, f19.total), "32 lines below 1% each · 19–50 · together 0.2% of run");
  for (const it of folds) {
    const text = cv.foldText(f, it.start, it.end, it.total);
    const lines = f.lines.filter((l) => l.no >= it.start && l.no <= it.end);
    const sampled = lines.some((l) => l.total > 0 || l.cpuTimes.length > 0);
    assert.equal(/without samples/.test(text), !sampled, `${it.start}–${it.end}: ${text}`);
    assert.ok(lines.every((l) => l.total <= 1), "folded lines are ≤ 1% each");
    if (it.total > 0) assert.match(text, /of run$/);
  }
  // One line: no "each", no "together".
  const one = f.lines.find((l) => l.total > 0 && l.total < 1);
  assert.equal(cv.foldText(f, one.no, one.no, one.total), `1 line below 1% · ${one.no} · ${one.total < 0.05 ? "<0.1%" : `${one.total.toFixed(1)}%`} of run`);
});

// Round 1 (code-toolbar-functions-ambiguous): mode tooltips state the real predicate.
test("round 1: display-mode tooltips name the profile's activities", () => {
  const all = { memory: true, gpu: true, neuron: false, async: true };
  assert.equal(sec.modeDescription("profiled-lines", all), "Only hot lines with more than 1% of run time, or any memory, GPU or await activity. The rest is folded.");
  assert.match(sec.modeDescription("profiled-functions", { memory: true, gpu: false, neuron: false, async: false }), /^Hot lines with more than 1% of run time, or any memory activity, plus every other line of the functions that contain them/);
  assert.equal(sec.modeDescription("profiled-lines", { memory: false, gpu: false, neuron: false, async: false }), "Only hot lines with more than 1% of run time. The rest is folded.");
  assert.equal(sec.modeDescription("all", all), "Every line of the file.");
});

withModel("ml-training", "ranked by Time: hottest first, keyless last, no folds or headers; lens and AI follow their row", (m) => {
  const f = m.files[0];
  const items = vis.buildCodeItems(f, "profiled-functions", { key: "time", dir: "desc" }, [], { lensAfter: "L:173", aiAnchors: [173] });
  assert.equal(items[0].key, "L:173");
  assert.equal(items[1].kind, "lens");
  assert.equal(items[2].kind, "aiCard");
  assert.ok(!items.some((i) => i.kind === "fold" || i.kind === "fnHeader"));
  const lines = items.filter((i) => i.kind === "line").map((i) => i.line);
  const firstZero = lines.findIndex((l) => !(l.total > 0));
  assert.ok(firstZero > 0 && lines.slice(firstZero).every((l) => !(l.total > 0)));
  const asc = vis.buildCodeItems(f, "profiled-functions", { key: "time", dir: "asc" }, []).filter((i) => i.kind === "line").map((i) => i.line);
  assert.ok(asc[0].total > 0 && asc[0].total <= asc[1].total, "asc: smallest non-zero first");
  assert.ok(!(asc[asc.length - 1].total > 0), "asc: keyless still last");
});

withModel("example", "sparse old profile: gap items in All lines, nothing folded", (m) => {
  const items = vis.buildCodeItems(m.files[0], "all", null, []);
  assert.ok(items.some((i) => i.kind === "gap"));
  assert.ok(!items.some((i) => i.kind === "fold"));
});

// ── Row labels and tooltips (§4.8.4, §4.8.11) ──────────────────────────────

withModel("ml-training", "row aria-label and time tooltip carry units and denominators", (m) => {
  const l = lineOf(m, "train.py:173");
  const label = cols.rowAriaLabel(l, m, th.profileColumns(m));
  assert.equal(label, "Line 173, 21.4% of run time, peak memory none sampled, GPU 96.4% busy: loss_value = loss.item()");
  const env = cols.cellEnv(m, "lg");
  const tip = cols.cellTooltip("time", l, env);
  assert.equal(tip.title, "21.4% of run · 11.6\u00a0s");
  assert.deepEqual(tip.rows, [["Python", "0.1%"], ["native", "7.2%"], ["system", "14.1%"]]);
  assert.equal(cols.cellTooltip("mem", l, env), null, "empty cell has no tooltip");
  const ckpt = lineOf(m, "train.py:120");
  assert.equal(cols.cellTooltip("alloc", ckpt, env).title, "33.0% of all allocation in the program");
  assert.equal(cols.cellTooltip("copy", ckpt, env).title, "22.0\u00a0MiB/s copied (average over run)");
});

withModel("neuron", "neuron line 66: NRT 37.0% of run, idle 12.4% low", (m) => {
  const l = lineOf(m, "infer_bert.py:66");
  const env = cols.cellEnv(m, "xxl");
  assert.equal(cols.cellTooltip("nrt", l, env).title, "9.69\u00a0s in Neuron Runtime · 37.0% of run");
  assert.deepEqual(cols.cellTooltip("nrt", l, env).rows[0], ["share of all NRT time", "98.0%"]);
  assert.match(cols.cellTooltip("idle", l, env).title, /^12\.4% of this line's CPU samples had the device idle/);
  assert.match(cols.cellTooltip("idle", l, env).hint, /^low/);
});
