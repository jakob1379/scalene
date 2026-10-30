// §4.0.7 timeline: per-thread run ends, sampling interval, thread labels,
// phases (§4.4.3), buckets (§4.4.4), suspended tasks, merged segments.
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const { buildModel } = mod("model/model");
const t = mod("model/timeline");

function checkRunEnds(tl) {
  for (const idx of tl.byThread) {
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const nominal = tl.t0[i] + tl.count[i] * tl.dt;
      assert.ok(tl.t1[i] <= nominal + 1e-9, "never longer than count × dt");
      assert.ok(tl.t1[i] > tl.t0[i], "positive duration");
      // Next later run of the same thread caps the end.
      for (let q = k + 1; q < idx.length; q++) {
        const j = idx[q];
        if (tl.t0[j] > tl.t0[i]) {
          assert.ok(tl.t1[i] <= tl.t0[j] + 1e-9);
          break;
        }
      }
    }
  }
}

withModel("ml-training", "runs, threads, run-end rule", async (m) => {
  const tl = await m.timeline();
  assert.equal(tl.n, 4933);
  assert.equal(tl.threads.length, 5);
  assert.equal(tl.mainIdx, 0);
  assert.equal(tl.threads[0].label, "main");
  assert.ok(Math.abs(tl.dt - 0.01) < 0.0005);
  assert.equal(tl.byThread.reduce((a, x) => a + x.length, 0), tl.n);
  checkRunEnds(tl);
  assert.equal(Math.max(...tl.maxDepth), 19);
  const share = tl.threads.reduce((a, x) => a + x.share, 0);
  assert.ok(Math.abs(share - 100) < 1e-9);
});

withModel("ml-training", "phases: main-thread loop phase dominates; merged and ordered", async (m) => {
  const tl = await m.timeline();
  assert.ok(tl.phases.length > 0);
  const loop = tl.phases.find((p) => p.label === "for step in range(cfg.max_steps)");
  assert.ok(loop, tl.phases.map((p) => p.label).join(" | "));
  assert.equal(loop.loop, true);
  assert.equal(loop.line, 152);
  const byKey = new Map();
  for (const p of tl.phases) byKey.set(p.key, (byKey.get(p.key) ?? 0) + p.share);
  assert.ok(byKey.get(loop.key) > 50, "the training loop is most of the main thread");
  for (let i = 1; i < tl.phases.length; i++) assert.ok(tl.phases[i].t0 >= tl.phases[i - 1].t0);
  const total = tl.phases.reduce((a, p) => a + p.samples, 0);
  assert.ok(total <= tl.phaseSamples);
});

withModel("ml-training", "bucketize: thread-seconds are conserved", async (m) => {
  const tl = await m.timeline();
  const nb = 400;
  const b = tl.bucketize(nb, 0, m.tMax);
  const bw = m.tMax / nb;
  let area = 0;
  for (let k = 0; k < nb; k++) area += (b.busy[k] + b.gil[k] + b.wait[k]) * bw;
  let dur = 0;
  for (let i = 0; i < tl.n; i++) dur += Math.min(tl.t1[i], m.tMax) - tl.t0[i];
  assert.ok(Math.abs(area - dur) < dur * 1e-4, `${area} vs ${dur}`);
  let busy = 0;
  let split = 0;
  for (let k = 0; k < nb; k++) {
    busy += b.busy[k];
    split += b.py[k] + b.native[k];
  }
  assert.ok(Math.abs(busy - split) < 1e-3 * busy);
  assert.ok(Math.max(...b.busy) <= 5 + 1e-6, "never more busy threads than threads");
  const main = tl.bucketize(nb, 0, m.tMax, 0);
  assert.ok(Math.max(...main.busy.map((v, k) => v + main.gil[k] + main.wait[k])) <= 1 + 1e-6);
});

withModel("ml-training", "runAt and merged segments per lane", async (m) => {
  const tl = await m.timeline();
  const i = tl.byThread[0][100];
  assert.equal(tl.runAt(0, (tl.t0[i] + tl.t1[i]) / 2), i);
  assert.equal(tl.runAt(0, -5), -1);
  const seg = tl.segments(0);
  assert.equal(seg.rows.length, tl.maxDepth[0]);
  assert.equal(tl.segments(0), seg, "cached");
  for (const row of seg.rows) {
    for (let k = 1; k < row.n; k++) assert.ok(row.t0[k] >= row.t1[k - 1] - 0.5 * tl.dt, "no overlap within a row");
  }
  // Root row: 4,232 of the main thread's runs share `<module>:193`; jitter
  // gaps must not split them, so the row has only a handful of segments.
  assert.ok(seg.rows[0].n < 40, `root row segments ${seg.rows[0].n}`);
  const samples = seg.rows[0].samples.reduce((a, v) => a + v, 0);
  assert.equal(samples, tl.threads[0].samples);
  const f = tl.frameAt(seg.rows[0].stack[0], 0);
  assert.equal(f.kind, "py");
});

withModel("async-server", "single thread; suspended tasks per instant", async (m) => {
  const tl = await m.timeline();
  assert.equal(tl.threads.length, 1);
  assert.ok(tl.maxTasks >= 12 && tl.maxTasks <= 40, `maxTasks ${tl.maxTasks}`);
  const tasks = tl.tasks(200, 0, m.tMax);
  const mean = tasks.reduce((a, v) => a + v, 0) / tasks.length;
  assert.ok(mean > 1, `mean suspended ${mean}`);
  assert.ok(Math.max(...tasks) <= tl.maxTasks + 1e-6);
  assert.ok(tl.phases.length > 0, "PHASE channel present");
  assert.ok(tl.phases.every((p) => !p.label.startsWith("[await]")));
  checkRunEnds(tl);
});

withModel("huge", "12 lanes in order main, then first appearance", async (m) => {
  const tl = await m.timeline();
  assert.deepEqual(tl.threads.map((x) => x.label), ["main", ...Array.from({ length: 11 }, (_, i) => `thread ${i + 1}`)]);
  assert.equal(tl.n, 41604);
  assert.equal(Math.max(...tl.maxDepth), 38);
  checkRunEnds(tl);
  const t0 = performance.now();
  for (let k = 0; k < 5; k++) tl.bucketize(600, 0, m.tMax);
  const ms = (performance.now() - t0) / 5;
  console.log(`  # huge bucketize(600): ${ms.toFixed(2)} ms`);
  assert.ok(ms < 30);
});

withModel("neuron", "no timeline", async (m) => {
  assert.equal(await m.timeline(), null);
});

function synthetic(events, mainId = 7) {
  const frame = (name, line) => ({ kind: "py", display_name: name, filename_or_module: "/a/x.py", line, ip: null, offset: null });
  return buildModel({
    elapsed_time_sec: 2,
    memory: false,
    gpu: false,
    max_footprint_mb: 0,
    growth_rate: 0,
    samples: [],
    main_thread_id: mainId,
    combined_stacks: [
      [[frame("<module>", 1), frame("work", 3)], 10],
      [[frame("<module>", 1), frame("idle", 5)], 10],
    ],
    combined_stacks_timeline: events,
    files: {
      "/a/x.py": {
        percent_cpu_time: 100,
        functions: [],
        imports: [],
        lines: [1, 2, 3, 4, 5].map((n) => ({ lineno: n, line: `l${n}\n`, n_cpu_percent_python: n === 3 ? 100 : 0, n_cpu_percent_c: 0, n_sys_percent: 0 })),
      },
    },
  });
}

test("sampling interval: median same-thread gap per sample, clamped", () => {
  const ev = Array.from({ length: 20 }, (_, i) => ({ t_sec: i * 0.04, stack_index: 0, count: 2, thread_id: 7 }));
  assert.ok(Math.abs(synthetic(ev).sampling.dt - 0.02) < 1e-12);
  const fast = Array.from({ length: 20 }, (_, i) => ({ t_sec: i * 0.0001, stack_index: 0, count: 1, thread_id: 7 }));
  assert.equal(synthetic(fast).sampling.dt, 0.0005);
  const one = [{ t_sec: 0, stack_index: 0, count: 3, thread_id: 7 }];
  assert.equal(synthetic(one).sampling.dt, t.DEFAULT_DT);
});

test("run ends use the same thread's next run, not another thread's (fixes upstream truncation)", async () => {
  const ev = [
    { t_sec: 0.0, stack_index: 0, count: 5, thread_id: 7 },
    { t_sec: 0.01, stack_index: 1, count: 1, thread_id: 9 },
    { t_sec: 0.05, stack_index: 1, count: 5, thread_id: 7 },
    { t_sec: 0.06, stack_index: 0, count: 1, thread_id: 9 },
  ];
  const m = synthetic(ev);
  const tl = await m.timeline();
  assert.deepEqual(tl.threads.map((x) => x.label), ["main", "thread 1"]);
  assert.ok(Math.abs(tl.t1[0] - 0.05) < 1e-9, `main run 0 ends at its next run: ${tl.t1[0]}`);
  assert.ok(Math.abs(tl.t1[2] - (0.05 + 5 * tl.dt)) < 1e-9, "last run: count × dt");
});

test("legacy timeline without thread ids: one 'unknown' lane, phases from all runs", async () => {
  const ev = [
    { t_sec: 0.0, stack_index: 0, count: 5 },
    { t_sec: 0.05, stack_index: 1, count: 5 },
  ];
  const m = synthetic(ev, null);
  assert.equal(m.caps.threadIds, false);
  const tl = await m.timeline();
  assert.deepEqual(tl.threads.map((x) => x.label), ["unknown"]);
  assert.equal(tl.mainIdx, -1);
  assert.deepEqual(tl.phases.map((p) => p.label), ["l3", "l5"]);
  assert.equal(tl.phases[0].share, 50);
});
