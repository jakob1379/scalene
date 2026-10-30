// Round 1 canvas fixes (design/review/round-1/fix-canvas.md): label truncation without
// ellipsis soup, "train() :173" frame references, the LOD dominant-kind colour rule and its
// census on ml-training, nested axis-label strides, zoom/range announcements, memory copy
// pluralisation and the 24/32 px timeline lane headers.
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";
import { recordingContext } from "./_dom.mjs";

const sh = mod("views/stacks/shared");
const fm = mod("views/stacks/flamemodel");
const fr = mod("views/timeline/frames");
const lay = mod("views/timeline/layout");
const mv = mod("views/memory/memoryview");
const st = mod("model/stacks");

const TRAIN = "/home/dev/llm-train/train.py";
const ell = (s) => (s.match(/…/g) ?? []).length;
const real = (s) => s.replace(/…/g, "").length;

test("fitChars: never two ellipses; truncated labels keep ≥ 6 real characters or vanish (flame-label-degenerate-truncation)", () => {
  const natives = [
    "torch::autograd::python::PythonEngine::thread_init(int, std::shared_ptr<torch::autograd::ReadyQueue> const&, bool)",
    "at::native::_local_scalar_dense_cuda(at::Tensor const&)",
    "void at::native::elementwise_kernel<128, 4, at::native::gpu_kernel_impl<at::native::CUDAFunctor_add<float> >(at::TensorIteratorBase&, at::native::CUDAFunctor_add<float> const&)::{lambda(int)#1}>(int, at::native::gpu_kernel_impl<…>)",
    "std::vector<int, std::allocator<int> >::push_back(int const&)",
    "method_vectorcall_VARARGS",
    "cublasLtMatmul",
    "Foo::operator()(int) const",
  ];
  for (const raw of natives) {
    const label = sh.frameLabelText("native", raw, null);
    for (let n = 2; n <= 60; n++) {
      const out = sh.fitChars(label, n, "middle");
      assert.ok(out.length <= n, `${raw} @${n}: ${out}`);
      assert.ok(ell(out) <= (label.length <= n ? ell(label) : 1), `one ellipsis at most: ${out}`);
      if (ell(out) > 0 && out !== label) assert.ok(real(out) >= 6, `degenerate label "${out}" must be dropped`);
      assert.ok(!/……|…\(…\)|…<…>/.test(out), `no ellipsis soup: ${out}`);
    }
  }
  // The examples from the review: collapsed groups go first, then the identifier is cut once.
  assert.equal(sh.fitChars("at::native::_local_scalar_dense_cuda(…)", 7, "middle"), "at:…uda");
  assert.equal(sh.fitChars("at::native::_local_scalar_dense_cuda(…)", 5, "middle"), "", "'at:……)' → no label");
  assert.equal(sh.fitChars("std::vector<…>::push_back(…)", 25, "middle"), "std::vector<…>::push_back");
  assert.equal(sh.fitChars("std::vector<…>::push_back(…)", 22, "middle"), "std::vector::push_back");
  assert.equal(sh.fitChars("method_vectorcall_VARARGS", 4, "middle"), "", "'me…S' → no label");
  assert.equal(sh.fitChars("0x7f3e4bf52287", 6, "end"), "", "hex ips follow the same rule ('0x7f3…')");
  assert.equal(sh.fitChars("0x7f3e4bf52287", 9, "end"), "0x7f3e4b…");
  assert.equal(sh.fitChars("Foo::operator()", 40, "middle"), "Foo::operator()", "fits: verbatim");
  for (let n = 2; n < 20; n++) {
    const py = sh.fitChars("save_checkpoint() :120", n, "py");
    assert.ok(py === "" || ell(py) === 0 || real(py) >= 6, py);
  }
});

withModel("ml-training", "frame references: 'train() :165' in crumbs/captions, spoken zoom announcements (cross-view-terms, zoom-changes)", async (m) => {
  const tree = await m.flame("cpu");
  const a = st.heaviestNode(tree, TRAIN, 165);
  assert.equal(fm.shortRef(a), "train() :165");
  assert.equal(fm.shortRef(tree.root), "All stacks");
  assert.equal(fm.zoomAnnouncement("cpu", a, tree, false), "Zoomed into train, train.py line 165, 14.9% of samples");
  assert.equal(fm.zoomAnnouncement("cpu", tree.root, tree, true), "Zoomed out to All stacks");
  assert.match(fm.zoomAnnouncement("cpu", a.parent, tree, true), /^Zoomed out to <module>, train\.py line 193, [\d.]+% of samples$/);
  const mem = await m.flame("memory");
  const save = st.heaviestNode(mem, TRAIN, 120);
  assert.equal(fm.zoomAnnouncement("memory", save, mem, false), "Zoomed into save_checkpoint, train.py line 120, 1.17 GiB, 36.8% of attributed allocation");
});

test("lodPick: ≥ 60 % one kind → its fill; two kinds ≥ 80 % → 50/50 mix; else the neutral fallback", () => {
  assert.deepEqual(sh.lodPick([7, 3, 0, 0]), [0, -1]);
  assert.deepEqual(sh.lodPick([6, 4, 0, 0]), [0, -1], "exactly 60 %");
  assert.deepEqual(sh.lodPick([5, 4, 1, 0]), [0, 1], "two kinds = 90 %");
  assert.deepEqual(sh.lodPick([0, 1, 4, 5]), [3, 2]);
  assert.deepEqual(sh.lodPick([3, 3, 2, 2]), [-1, -1], "mixed kinds");
  assert.deepEqual(sh.lodPick([0, 0, 0, 0]), [-1, -1]);
});

test("labelStride: nested strides (each divides the next), monotone in the tick spacing (flame-axis-thinning-flicker)", () => {
  const S = sh.LABEL_STRIDES;
  for (let i = 1; i < S.length; i++) assert.equal(S[i] % S[i - 1], 0, `${S[i]} is a multiple of ${S[i - 1]}`);
  let prev = Infinity;
  for (let spacing = 2; spacing <= 200; spacing += 1) {
    const s = sh.labelStride(spacing, 30);
    assert.ok(S.includes(s));
    assert.ok(s <= prev, "a wider spacing never needs a larger stride");
    assert.ok(spacing * s >= 36 || s === S[S.length - 1]);
    prev = s;
  }
  assert.equal(sh.labelStride(120, 30), 1);
  assert.equal(sh.labelStride(20, 30), 2);
  assert.equal(sh.labelStride(10, 30), 10);
});

/** Light-ish palette with distinct kind colours, so the census can tell LOD from kind fills. */
function censusTheme() {
  const t = {
    "frame-py": "#1f6feb",
    "frame-native": "#8ab4f8",
    "frame-await": "#c297ff",
    "frame-unresolved": "#b0b8c4",
    "frame-root": "#e6e9ee",
    "frame-lod": "#7d8ba3",
    surface: "#ffffff",
    "frame-dim": "0.78",
    "font-mono": "monospace",
  };
  const tokens = new Proxy(t, { get: (o, k) => (k in o ? o[k] : "#000000") });
  return { current: () => "census", set() {}, tokens: () => tokens, num: (n) => (n === "frame-dim" ? 0.78 : n.endsWith("ink-split") ? 4 : 0) };
}

/** Painted area per fill colour (CSS px²) of one frame panel draw. */
function census(calls) {
  const area = new Map();
  let fill = "";
  for (const c of calls) {
    if (c[0] === "=fillStyle") fill = typeof c[1] === "string" ? c[1].toLowerCase() : "pattern";
    else if (c[0] === "fillRect" && fill !== "pattern") area.set(fill, (area.get(fill) ?? 0) + Math.max(0, c[3]) * Math.max(0, c[4]));
  }
  return area;
}

withModel("ml-training", "LOD census: the main lane at full range is ≤ 20 % neutral LOD grey (timeline-lod-grey-slab, -not-in-legend)", async (m) => {
  const tl = await m.timeline();
  await tl.segmentsSliced(0);
  for (const dpr of [1, 2]) {
    const ctx = recordingContext();
    const panel = fr.renderTimelineFrames(
      { ctx2d: ctx, tl, lanes: [0], interleaved: false, x: 194, y: 262, w: 1147, rowH: 12, depth: 16, domain: [0, m.tMax], theme: censusTheme(), dpr },
      () => "",
    );
    const area = census(ctx.calls);
    const total = Array.from(area.values()).reduce((a, b) => a + b, 0);
    const lod = area.get("#7d8ba3") ?? 0;
    assert.ok(total > 0);
    assert.ok(lod / total <= 0.2, `dpr ${dpr}: LOD grey is ${((100 * lod) / total).toFixed(1)} % of painted area`);
    assert.ok((area.get("#1f6feb") ?? 0) > lod, "Python frames out-paint the neutral grey");
    assert.ok(panel.lodColumns > 0 && panel.lodMixed <= panel.lodColumns);
  }
});

test("timeline range text: precise below 1 s of span, spoken 'Showing … of …' (zoom-changes-not-announced)", () => {
  assert.equal(lay.fmtDomain(10.9, 52.4), "10.9 s – 52.4 s");
  assert.equal(lay.fmtDomain(28.4, 28.44), "28.400 s – 28.440 s");
  assert.notEqual(lay.fmtDomain(28.4, 28.404).split(" – ")[0], lay.fmtDomain(28.4, 28.404).split(" – ")[1]);
  assert.equal(lay.domainAnnouncement([28.4, 28.44], 54.1), "Showing 28.400 s to 28.440 s of 54.1 s");
  assert.equal(lay.domainAnnouncement([0, 54.1], 54.1), "Showing the whole run, 54.1 s");
});

test("memory copy: pluralised counts, no plot jargon (memory-section-copy, pluralization-counts)", () => {
  assert.equal(mv.momentsText(3, 1), "3 allocation events shown as ticks under the chart · 1 episode");
  assert.equal(mv.momentsText(1, 0), "1 allocation event shown as ticks under the chart");
  assert.equal(mv.momentsText(100, 200), "100 allocation events shown as ticks under the chart · 200 episodes");
  assert.ok(!/rug/.test(mv.momentsText(5, 5)));
});

withModel("ml-training", "lane headers: 24 px targets, 32 px on coarse pointers, reserved in the layout (timeline-lane-heads-touch-target)", async (m) => {
  const tl = await m.timeline();
  const lanes = tl.threads.map((t) => ({ idx: t.idx, key: t.label, maxDepth: tl.maxDepth[t.idx] }));
  const base = { width: 1300, bp: "lg", short: false, view: "lanes", filter: null, lanes, expanded: new Set(["main"]), full: new Set(), memory: true };
  for (const [coarse, hh] of [[false, 24], [true, 32]]) {
    assert.equal(lay.headHeight(coarse), hh);
    const L = lay.computeLayout({ ...base, coarse });
    const worker = L.items.find((i) => i.kind === "lane" && i.laneKey === "thread 1");
    assert.equal(worker.h, hh, "a collapsed lane is one header tall");
    assert.ok(worker.bodyY >= worker.y && worker.bodyY + 16 <= worker.y + hh, "the activity strip sits inside the header row");
    const main = L.items.find((i) => i.kind === "lane" && i.laneKey === "main");
    assert.ok(main.h >= hh + 16 + hh + 4, "gutter fits header + share + 'show all' button");
    const xs = lay.computeLayout({ ...base, coarse, width: 358, bp: "xs" });
    for (const it of xs.items.filter((i) => i.kind === "lane")) assert.ok(it.bodyY - it.y >= hh, "xs: the label row is reserved above the rows");
  }
});
