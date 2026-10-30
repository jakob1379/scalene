// §4.20 palette index: substring lines (hot first), fuzzy functions/files,
// and the source lookup used by stack views (§7.5 makeFileSourceLookup).
import assert from "node:assert/strict";
import { loc, mod, test, withModel } from "./_harness.mjs";

const sr = mod("model/search");
const { makeFileSourceLookup, hasSource } = mod("model/source");

test("fuzzyMatch: subsequence with contiguity and word-start bonuses", () => {
  assert.equal(sr.fuzzyMatch("xyz", "train"), null);
  const a = sr.fuzzyMatch("trn", "train");
  assert.deepEqual(a.positions, [0, 1, 4]);
  const contiguous = sr.fuzzyMatch("tra", "train").score;
  const scattered = sr.fuzzyMatch("tra", "t_r_a_i_n").score;
  assert.ok(contiguous > scattered);
  assert.ok(sr.fuzzyMatch("mf", "MetricTracker.flush").score > sr.fuzzyMatch("mf", "summarize_info").score);
});

withModel("ml-training", "lines: loss.item → train.py:173 first; functions and files", async (m) => {
  const index = await m.search();
  assert.ok(index.size > 500);
  const r = index.query("loss.item");
  assert.equal(loc(r.lines[0].line), "train.py:173");
  assert.equal(r.lines[0].line.text.slice(r.lines[0].start, r.lines[0].end), "loss.item");
  const t = index.query("train");
  assert.equal(t.functions[0].item.name, "train");
  assert.equal(t.files[0].item.base, "train.py");
  assert.ok(t.lines.length <= sr.MAX_LINE_RESULTS);
  assert.deepEqual(index.query("   "), { lines: [], functions: [], files: [] });
  assert.equal(index.query("LOSS.ITEM").lines.length, r.lines.length, "case-insensitive");
  assert.equal(index.query("e", { lines: 3 }).lines.length, 3);
  assert.equal(await m.search(), index);
});

withModel("huge", "index builds lazily and queries fast", async (m) => {
  const t0 = performance.now();
  const index = await m.search();
  const built = performance.now() - t0;
  const t1 = performance.now();
  const r = index.query("dist");
  const q = performance.now() - t1;
  console.log(`  # huge search: build ${built.toFixed(0)} ms (sliced), query ${q.toFixed(1)} ms`);
  assert.ok(r.lines.length > 0);
  assert.ok(q < 30);
});

withModel("ml-training", "makeFileSourceLookup: unescaped, right-trimmed; '' when absent", (m) => {
  const lookup = makeFileSourceLookup(m);
  assert.equal(lookup("/home/dev/llm-train/train.py", 173), "        loss_value = loss.item()");
  assert.equal(lookup("/home/dev/llm-train/train.py", 99999), "");
  const opt = "/home/dev/llm-train/.venv/lib/python3.12/site-packages/torch/optim/optimizer.py";
  assert.equal(lookup(opt, 10), "", "frames whose file is not in the profile");
  assert.equal(hasSource(m, opt), false);
  assert.equal(hasSource(m, "/home/dev/llm-train/train.py"), true);
});

withModel("example", "sparse lookup by lineno", (m) => {
  const lookup = makeFileSourceLookup(m);
  const f = m.files[0];
  const l = f.lines[3];
  assert.equal(lookup(f.name, l.no), l.text.trimEnd());
  assert.equal(lookup(f.name, l.no + 1 === f.lines[4].no ? -1 : l.no + 1), "");
});
