// WP4 flame graph logic (DESIGN.md §4.11): zoom plans (M11/M12), re-based axis, captions,
// keyboard walk, announcements, tooltips, label fitting and search share (Appendix A.1).
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const fm = mod("views/stacks/flamemodel");
const sh = mod("views/stacks/shared");
const st = mod("model/stacks");

const TRAIN = "/home/dev/llm-train/train.py";

test("fitChars: end / middle / py modes never exceed the cell budget", () => {
  assert.equal(sh.fitChars("short", 10, "end"), "short");
  assert.equal(sh.fitChars("abcdefghij", 8, "end"), "abcdefg…");
  assert.equal(sh.fitChars("abcdefghij", 5, "end"), "", "fewer than 6 real characters → no label (round 1)");
  assert.equal(sh.fitChars("torch::autograd::Engine::execute", 12, "middle"), "torch:…ecute");
  assert.equal(sh.fitChars("train:173", 6, "py"), "train", "py labels drop :line first");
  assert.equal(sh.fitChars("train() :173", 7, "py"), "train()", "then the call parens");
  assert.equal(sh.fitChars("save_checkpoint:120", 8, "py"), "save_ch…");
  assert.equal(sh.fitChars("x", 1, "end"), "x");
  assert.equal(sh.fitChars("abc", 1, "end"), "", "fewer than 2 cells → no label");
  for (const n of [2, 3, 7, 11, 20]) {
    for (const mode of ["end", "middle", "py"]) assert.ok(sh.fitChars("operator<<(std::ostream&, int):12", n, mode).length <= n);
  }
});

test("frameLabelText: py 'train() :173' (never 'train:173'), native simplified, unresolved hex", () => {
  assert.equal(sh.frameLabelText("py", "train", 173), "train() :173");
  assert.equal(sh.frameLabelText("py", "<module>", 193), "<module> :193");
  assert.equal(sh.frameLabelText("await", "[await] sleep", 59), "[await] sleep :59");
  assert.equal(sh.frameLabelText("native", "std::vector<int, std::allocator<int> >::push_back(int const&)", null), "std::vector<…>::push_back(…)");
  assert.equal(sh.frameLabelText("unresolved", "0x7f3e4bf52287", null), "0x7f3e4bf52287");
  assert.equal(sh.fitModeFor("native"), "middle");
  assert.equal(sh.fitModeFor("py"), "py");
});

test("threadSlot: 5 slots then 'other', never cycling back onto main", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 11].map(sh.threadSlot), [0, 1, 2, 3, 4, 5, 5, 5]);
});

test("lowerBound / upperBound", () => {
  const a = Float64Array.from([1, 2, 2, 3, 5]);
  assert.equal(sh.lowerBound(a, 2), 1);
  assert.equal(sh.upperBound(a, 2), 3);
  assert.equal(sh.lowerBound(a, 0), 0);
  assert.equal(sh.lowerBound(a, 9), 5);
});

withModel("ml-training", "zoom plans: descendant/ancestor = 1 stage, lateral = 2 via the common ancestor", async (m) => {
  const tree = await m.flame("cpu");
  const a = st.heaviestNode(tree, TRAIN, 173);
  const b = st.heaviestNode(tree, TRAIN, 165);
  assert.ok(a && b && a !== b);
  const common = fm.commonAncestor(a, b);
  assert.equal(common, a.parent, "both lines sit under <module>:193");
  assert.equal(common.name, "<module>");
  assert.deepEqual(fm.zoomPlan(tree.root, a), [a], "zoom in");
  assert.deepEqual(fm.zoomPlan(a, tree.root), [tree.root], "zoom out");
  assert.deepEqual(fm.zoomPlan(a, a.parent), [a.parent]);
  assert.deepEqual(fm.zoomPlan(a, b), [common, b], "lateral jump is staged");
  assert.deepEqual(fm.zoomPlan(a, a), [a]);
  assert.deepEqual(fm.domainOf(a), [a.x0, a.x1]);
  assert.deepEqual(fm.lerpDomain([0, 10], [4, 6], 0.5), [2, 8]);
});

withModel("ml-training", "axis re-bases to the focused frame: 0–100 % (CPU), 0–focused MiB (memory)", async (m) => {
  const tree = await m.flame("cpu");
  const root = fm.axisValues("cpu", tree.root, 1300);
  assert.equal(root[0].label, "0%");
  assert.equal(root[root.length - 1].label, "100%");
  assert.ok(root.every((v, i) => i === 0 || v.frac > root[i - 1].frac));
  const a = st.heaviestNode(tree, TRAIN, 165);
  const zoomed = fm.axisValues("cpu", a, 1300);
  assert.deepEqual(
    zoomed.map((v) => v.label),
    root.map((v) => v.label),
    "the same 0–100 % labels, now relative to the frame",
  );
  assert.equal(fm.axisWeight(a, 0), a.x0);
  assert.equal(fm.axisWeight(a, 1), a.x1);
  assert.equal(fm.axisCaption("cpu", tree.root, tree), "% of all sampled stacks");
  assert.equal(fm.axisCaption("cpu", a, tree), "% of train() :165 (14.9% of all stacks)");
  assert.ok(fm.axisValues("cpu", tree.root, 390).length <= 6, "max ticks = px / 80");
  const mem = await m.flame("memory");
  const save = st.heaviestNode(mem, TRAIN, 120);
  const mv = fm.axisValues("memory", save, 1300);
  assert.equal(mv[0].label, "0");
  assert.ok(mv.every((v) => v.frac >= 0 && v.frac <= 1 + 1e-9));
  assert.ok(/ GiB$|MiB$/.test(mv[mv.length - 1].label));
  assert.equal(fm.axisCaption("memory", mem.root, mem), "attributed allocation");
  assert.match(fm.axisCaption("memory", save, mem), /^in save_checkpoint\(\) :120 \(36\.8% of attributed allocation\)$/);
});

withModel("ml-training", "descriptions and root labels (Appendix A.1)", async (m) => {
  const cpu = await m.flame("cpu");
  const mem = await m.flame("memory");
  assert.equal(fm.flameDescription("cpu", cpu), "336 stitched Python + native stacks · 5,901 samples · width = share of sampled stacks, not of run time");
  assert.equal(fm.flameDescription("memory", mem), "30 allocation stacks · 3.17\u00a0GiB attributed · width = share of attributed allocation (cumulative volume, not live size)");
  assert.equal(fm.rootLabel("cpu", cpu), "All stacks · 5,901 samples");
  assert.equal(fm.rootLabel("memory", mem), "All stacks · 3.17\u00a0GiB");
});

withModel("ml-training", "keyboard walk announces frames: name, place, kind, share, samples, depth", async (m) => {
  const tree = await m.flame("cpu");
  const n = st.heaviestNode(tree, TRAIN, 173);
  const text = fm.announceText("cpu", n, tree);
  assert.match(text, /^train, train\.py line 173, Python frame, \d+\.\d% of sampled stacks, [\d,]+ samples, depth 2 of 19$/);
  assert.equal(fm.announceText("cpu", tree.root, tree), "All stacks, 5,901 samples, depth 0 of 19");
  const nat = tree.nodes.find((x) => x.kind === "native");
  assert.match(fm.announceText("cpu", nat, tree), /, native frame, /);
  const mem = await m.flame("memory");
  const save = st.heaviestNode(mem, TRAIN, 120);
  assert.match(fm.announceText("memory", save, mem), /^save_checkpoint, train\.py line 120, Python frame, 1\.17\u00a0GiB, 36\.8% of attributed allocation, depth \d of 5$/);
});

withModel("ml-training", "walk: ↑ parent, ↓ heaviest child, ←/→ same depth inside the zoom, Home root", async (m) => {
  const tree = await m.flame("cpu");
  const n = st.heaviestNode(tree, TRAIN, 173);
  assert.equal(fm.walk(tree, n, "ArrowUp", tree.root), n.parent);
  assert.equal(fm.walk(tree, n, "ArrowDown", tree.root), n.children[0]);
  assert.equal(fm.walk(tree, n, "Home", tree.root), tree.root);
  assert.equal(fm.walk(tree, tree.root, "ArrowUp", tree.root), tree.root);
  assert.equal(fm.walk(tree, n, "x", tree.root), null);
  const right = fm.walk(tree, n, "ArrowRight", tree.root);
  assert.equal(right.depth, n.depth);
  assert.ok(right.x0 >= n.x1 - 1e-9, "next frame to the right");
  assert.equal(fm.walk(tree, right, "ArrowLeft", tree.root), n);
  // Zoomed into n: siblings are outside the view, so ←/→ stay.
  assert.equal(fm.walk(tree, n, "ArrowRight", n), n);
  assert.ok(fm.inZoom(n.parent, n) && fm.inZoom(n.children[0], n) && !fm.inZoom(right, n));
});

withModel("ml-training", "tooltip: kind chip, location, share · samples, self, of caller, source line, hint", async (m) => {
  const tree = await m.flame("cpu");
  const n = st.heaviestNode(tree, TRAIN, 165);
  const src = mod("model/source");
  const lookup = src.makeFileSourceLookup(m);
  const tip = fm.frameTooltip("cpu", n, tree, lookup, (f) => src.hasSource(m, f));
  assert.equal(tip.kind, "PYTHON FRAME");
  assert.equal(tip.title, "train");
  const rows = Object.fromEntries(tip.rows);
  assert.equal(rows.Location, "train.py:165");
  assert.equal(rows["Sampled stacks"], "14.9% · 878 samples");
  assert.ok(rows.Self.endsWith("%"));
  assert.ok(rows["Of caller"].endsWith("%"));
  assert.equal(tip.code, "scaler.scale(loss).backward()");
  assert.equal(tip.hint, "Click to zoom · double-click to open the line");
  const outside = tree.nodes.find((x) => x.kind === "py" && !src.hasSource(m, x.file));
  if (outside) {
    const t2 = fm.frameTooltip("cpu", outside, tree, lookup, (f) => src.hasSource(m, f));
    assert.equal(t2.hint, "Click to zoom · source not in this profile");
    assert.equal(t2.code, undefined);
  }
  const unres = tree.nodes.find((x) => x.kind === "unresolved");
  assert.equal(fm.frameTooltip("cpu", unres, tree, lookup, () => true).kind, "UNRESOLVED");
  const mem = await m.flame("memory");
  const save = st.heaviestNode(mem, TRAIN, 120);
  const mt = Object.fromEntries(fm.frameTooltip("memory", save, mem, lookup, () => true).rows);
  assert.equal(mt.Attributed, "1.17\u00a0GiB · 36.8%");
});

withModel("ml-training", "search share: 'train' matches report the share of samples", async (m) => {
  const tree = await m.flame("cpu");
  const s = st.searchFlame(tree, "train");
  const sum = fm.matchSummary("cpu", s.share, s.matches.length);
  assert.equal(`${sum.lead}${sum.value}${sum.tail}`, `Matched 91.3% of samples · ${s.matches.length} frames`);
  assert.equal(fm.matchSummary("cpu", 0, 0), null);
  assert.equal(fm.matchSummary("memory", 12.5, 1).tail, " of allocation · 1 frame");
});

withModel("ml-training", "Show in stacks: zoom to the parent of the heaviest node; function ranges", async (m) => {
  const tree = await m.flame("cpu");
  const n = fm.nodeForLine(tree, TRAIN, 173);
  assert.equal(n, st.heaviestNode(tree, TRAIN, 173));
  assert.equal(fm.showInStacksZoom(n), n.parent);
  assert.equal(fm.showInStacksZoom(tree.root), tree.root);
  const fnNode = fm.nodeForRange(tree, TRAIN, [152, 184]);
  assert.ok(fnNode && fnNode.line >= 152 && fnNode.line <= 184);
  assert.equal(fm.nodeForLine(tree, TRAIN, 1), null);
});

withModel("huge", "huge: tree depth 38 and every row sorted for binary-search hit testing", async (m) => {
  const tree = await m.flame("cpu");
  assert.equal(tree.maxDepth, 38);
  const caption = fm.axisCaption("cpu", tree.root, tree);
  assert.equal(caption, "% of all sampled stacks");
  for (const row of tree.byDepth) for (let i = 1; i < row.length; i++) assert.ok(row[i].x0 >= row[i - 1].x1 - 1e-6);
});
