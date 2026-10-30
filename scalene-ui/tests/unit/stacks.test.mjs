// §4.0.7 / §4.11 flame trees and §4.9 call context (Appendix A.1, A.7).
import assert from "node:assert/strict";
import { mod, withModel } from "./_harness.mjs";

const s = mod("model/stacks");
const { fmtMem, fmtPct } = mod("core/format");

function checkLayout(tree) {
  for (const n of tree.nodes) {
    let x = n.x0;
    let sum = 0;
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      assert.ok(Math.abs(c.x0 - x) < 1e-6, "children are contiguous from the parent's left edge");
      x = c.x1;
      sum += c.total;
      if (i > 0) assert.ok(n.children[i - 1].total >= c.total, "heaviest left");
      assert.equal(c.depth, n.depth + 1);
    }
    assert.ok(sum <= n.total + 1e-6);
    assert.ok(Math.abs(n.total - sum - n.self) < 1e-6 * Math.max(1, n.total), "self = total − Σ children");
  }
  for (const row of tree.byDepth) for (let i = 1; i < row.length; i++) assert.ok(row[i].x0 >= row[i - 1].x1 - 1e-6);
}

withModel("ml-training", "CPU flame: 336 stacks, 5,901 samples, depth 19", async (m) => {
  const tree = await m.flame("cpu");
  assert.equal(tree.stacks, 336);
  assert.equal(tree.total, 5901);
  assert.equal(tree.maxDepth, 19);
  assert.equal(tree.root.name, "All stacks");
  checkLayout(tree);
  const unresolved = tree.nodes.filter((n) => n.kind === "unresolved");
  assert.ok(unresolved.length > 0);
  assert.ok(unresolved.every((n) => /^0x[0-9a-f]+$/.test(n.name)));
  assert.ok(tree.nodes.some((n) => n.kind === "native" && n.name.length > 300), "very long demangled names kept verbatim");
  const hot = s.heaviestNode(tree, "/home/dev/llm-train/train.py", 173);
  assert.ok(hot && hot.kind === "py" && hot.line === 173);
  assert.equal(s.nodeAt(tree, hot.depth, (hot.x0 + hot.x1) / 2), hot);
  assert.equal(s.nodeAt(tree, 0, -1), null);
  assert.equal(s.ancestry(hot)[0], tree.root);
  assert.ok(s.isDescendant(hot, tree.root));
  assert.equal(tree.byPath.get(hot.path), hot);
  assert.equal(await m.flame("cpu"), tree, "lazy value is memoised");
});

withModel("ml-training", "call context of train.py:173: in 1,157 of 5,901 stack samples (19.6%)", async (m) => {
  const cc = await m.callContext("/home/dev/llm-train/train.py", 173);
  assert.equal(cc.hits, 1157);
  assert.equal(cc.total, 5901);
  assert.equal(fmtPct(cc.share), "19.6%");
  assert.equal(cc.summary, "in 1,157 of 5,901 stack samples (19.6%)");
  assert.ok(cc.callsInto.length > 0 && cc.callsInto.length <= 4);
  assert.ok(cc.calledFrom.length > 0 && cc.calledFrom.length <= 2);
  for (let i = 1; i < cc.callsInto.length; i++) assert.ok(cc.callsInto[i - 1].hits >= cc.callsInto[i].hits);
  assert.ok(cc.callsInto.reduce((a, e) => a + e.hits, 0) <= cc.hits);
  assert.equal(cc.calledFrom[0].name, "<module>");
  const none = await m.callContext("/home/dev/llm-train/train.py", 1);
  assert.equal(none.hits, 0);
  assert.deepEqual(none.callsInto, []);
});

withModel("ml-training", "memory flame: 30 stacks, 3.17\u00a0GiB; save_checkpoint:120 = 1.17\u00a0GiB (36.8%)", async (m) => {
  const tree = await m.flame("memory");
  assert.equal(tree.kind, "memory");
  assert.equal(tree.stacks, 30);
  assert.equal(fmtMem(tree.total), "3.17\u00a0GiB");
  checkLayout(tree);
  const node = tree.nodes.find((n) => n.name === "save_checkpoint" && n.line === 120);
  assert.ok(node);
  assert.equal(fmtMem(node.total), "1.17\u00a0GiB");
  assert.equal(fmtPct((100 * node.total) / tree.total), "36.8%");
});

withModel("huge", "deep CPU flame: 3,183 stacks, 51,784 samples, depth 38", async (m) => {
  const t0 = performance.now();
  const tree = await m.flame("cpu");
  console.log(`  # huge flame build (sliced): ${(performance.now() - t0).toFixed(0)} ms, ${tree.nodes.length} nodes`);
  assert.equal(tree.stacks, 3183);
  assert.equal(tree.total, 51784);
  assert.equal(tree.maxDepth, 38);
  checkLayout(tree);
});

withModel("async-server", "await frames get their own kind", async (m) => {
  const tree = await m.flame("cpu");
  assert.ok(tree.nodes.some((n) => n.kind === "await" && n.name.startsWith("[await]")));
});

withModel("neuron", "no stacks: flames and call context are null", async (m) => {
  assert.equal(await m.flame("cpu"), null);
  assert.equal(await m.flame("memory"), null);
  assert.equal(await m.callContext("/home/ubuntu/neuron-bert/infer_bert.py", 66), null);
});

withModel("cpu-only", "no memory stacks", async (m) => {
  assert.equal(await m.flame("memory"), null);
  assert.ok(await m.flame("cpu"));
});
