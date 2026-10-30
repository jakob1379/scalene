// WP6 integration changes (design/WP6-INTEGRATION.md): sliced lane segments (WP4 R5), mono
// frame-tooltip titles (WP4 R1), and the integrator's shell rules.
import assert from "node:assert/strict";
import { fixture, mod, test, withModel } from "./_harness.mjs";

const { buildModel } = mod("model/model");
const fm = mod("views/stacks/flamemodel");
const fr = mod("views/timeline/frames");
const st = mod("model/stacks");
const src = mod("model/source");
const app = mod("views/app");

const TRAIN = "/home/dev/llm-train/train.py";

function sameRows(a, b, where) {
  assert.equal(a.rows.length, b.rows.length, `${where}: depth`);
  a.rows.forEach((r, d) => {
    const q = b.rows[d];
    assert.equal(r.n, q.n, `${where} depth ${d}: n`);
    assert.deepEqual(Array.from(r.t0), Array.from(q.t0), `${where} depth ${d}: t0`);
    assert.deepEqual(Array.from(r.t1), Array.from(q.t1), `${where} depth ${d}: t1`);
    assert.deepEqual(Array.from(r.stack), Array.from(q.stack), `${where} depth ${d}: stack`);
    assert.deepEqual(Array.from(r.samples), Array.from(q.samples), `${where} depth ${d}: samples`);
  });
}

for (const name of ["ml-training", "async-server", "huge"]) {
  withModel(name, "segmentsSliced(lane) builds the same merged segments as segments(lane)", async () => {
    // Fresh models (the harness caches one per fixture, and other tests build its lanes):
    // `tl` builds sliced, `ref` builds synchronously.
    const tl = await buildModel(fixture(name), { version: "2.4.0" }).timeline();
    const ref = await buildModel(fixture(name), { version: "2.4.0" }).timeline();
    for (let lane = 0; lane < tl.threads.length; lane++) {
      const p1 = tl.segmentsSliced(lane);
      const p2 = tl.segmentsSliced(lane);
      assert.equal(p1, p2, "concurrent calls share one build");
      const sliced = await p1;
      assert.equal(tl.segments(lane), sliced, "segments() returns the cached sliced build");
      assert.equal(await tl.segmentsSliced(lane), sliced, "later calls resolve to the same object");
      sameRows(sliced, ref.segments(lane), `${name} lane ${lane}`);
    }
  });
}

withModel("ml-training", "segments() during a pending sliced build: one object per lane", async () => {
  const tl = await buildModel(fixture("ml-training"), { version: "2.4.0" }).timeline();
  const lane = tl.threads.length - 1;
  const pending = tl.segmentsSliced(lane);
  const sync = tl.segments(lane); // wins the race
  assert.equal(await pending, sync);
});

withModel("ml-training", "frame tooltips mark their titles as code (mono, ligatures off)", async (m) => {
  const tree = await m.flame("cpu");
  const lookup = src.makeFileSourceLookup(m);
  const n = st.heaviestNode(tree, TRAIN, 165);
  assert.equal(fm.frameTooltip("cpu", n, tree, lookup, () => true).mono, true);
  assert.notEqual(fm.frameTooltip("cpu", tree.root, tree, lookup, () => true).mono, true, "the root label is prose");
  const tl = await m.timeline();
  const ref = fr.segmentRef(tl, 0, 1, 0);
  assert.equal(fr.describeSegment(tl, ref, () => "").mono, true);
});

test("shell: section presence and empty-profile rules", () => {
  assert.equal(app.isEmptyProfile(""), true);
  assert.equal(app.isEmptyProfile({}), true);
  assert.equal(app.isEmptyProfile({ files: {} }), true);
  assert.equal(app.isEmptyProfile({ files: { "a.py": {} } }), false);
  const cpu = buildModel(fixture("cpu-only"), { version: "2.4.0" });
  assert.deepEqual(app.presentSections(cpu), ["overview", "code", "stacks", "timeline"]);
});

withModel("ml-training", "section presence with memory", (ml) => {
  assert.deepEqual(app.presentSections(ml), ["overview", "code", "stacks", "timeline", "memory"]);
});
