// §4.6.2 findings: expected ids, order and evidence per fixture (Appendix A),
// sentence templates, and the GIL rule on a synthetic profile.
import assert from "node:assert/strict";
import { mod, plain, test, withModel } from "./_harness.mjs";

const { buildModel } = mod("model/model");
const { FINDINGS_VISIBLE, THRESHOLDS } = mod("model/findings");

const EXPECTED = {
  "ml-training": ["gpu-sync train.py:173", "leak metrics.py:42", "leak loader.py:33", "peak train.py:120", "copy train.py:120", "native"],
  "async-server": ["loop-blocked handlers.py:51", "peak cache.py:24"],
  "cpu-only": ["python"],
  neuron: ["peak infer_bert.py:23", "neuron-idle preprocess.py:45"],
  basic: ["peak testme.py:13", "copy testme.py:23", "python"],
  example: ["python"],
  huge: ["leak registry.py:90", "leak statistics.py:66", "peak thermal.py:169", "python"],
};

for (const [name, want] of Object.entries(EXPECTED)) {
  withModel(name, `finding ids: ${want.map((x) => x.split(" ")[0]).join(" · ")}`, (m) => {
    assert.deepEqual(m.findings.map((f) => (f.ref ? `${f.id} ${f.ref.label}` : f.id)), want);
    for (const f of m.findings) {
      const chips = f.sentence.filter((s) => s.t === "code");
      assert.ok(chips.length <= 1, "at most one code chip");
      for (const c of chips) assert.ok(c.s.length <= THRESHOLDS.chipMax);
      assert.ok(["high", "medium", "low"].includes(f.severity));
      assert.ok(f.title && f.token && f.icon);
    }
    const rank = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < m.findings.length; i++) assert.ok(rank[m.findings[i - 1].severity] <= rank[m.findings[i].severity]);
  });
}

withModel("ml-training", "sentences", (m) => {
  const by = (id) => m.findings.filter((f) => f.id === id).map((f) => plain(f.sentence));
  assert.deepEqual(by("gpu-sync"), [
    "loss.item() takes 21.4% of run time (11.6\u00a0s), 66% of it system time, while the GPU is 96.4% busy — likely a host-device synchronization.",
  ]);
  assert.deepEqual(by("leak"), [
    "….append(…) grows about 5.71\u00a0MiB/s (likelihood 99.7%); peak 614\u00a0MiB.",
    "chunk = … grows about 288\u00a0KiB/s (likelihood 96.2%); peak 30.4\u00a0MiB.",
  ]);
  assert.deepEqual(by("peak"), ["at 52.9\u00a0s in torch.save(…) (train.py:120); this line's own peak is 1.20\u00a0GiB."]);
  assert.deepEqual(by("copy"), ["torch.save(…) copies 22.0\u00a0MiB/s on average — check Python↔native conversions."]);
  assert.deepEqual(by("native"), ["61.9% of run time is native. Python-level edits help less; see which native calls in Call stacks."]);
  assert.equal(m.findings[0].title, "The host waits on the GPU");
  assert.equal(m.findings[1].title, "Possible leak at metrics.py:42");
  assert.equal(m.findings[3].title, "Memory peaks at 3.11\u00a0GiB");
  assert.equal(FINDINGS_VISIBLE, 3);
  assert.equal(m.findings.length - FINDINGS_VISIBLE, 3, '"Show 3 more"');
});

withModel("async-server", "loop-blocked sentence", (m) => {
  assert.equal(plain(m.findings[0].sentence), "hashlib.pbkdf2_hmac(…) takes 21.6% of run time inside a coroutine; the event loop cannot run other tasks meanwhile.");
});

withModel("neuron", "neuron-idle sentence (recurring work only)", (m) => {
  const f = m.findings.find((x) => x.id === "neuron-idle");
  assert.equal(plain(f.sentence), "tokenizer(…) takes 11.4% of run time with the device idle in 100% of its samples, throughout the run.");
});

withModel("cpu-only", "python sentence", (m) => {
  assert.equal(plain(m.findings[0].sentence), "94.3% of run time runs in the interpreter; vectorizing the hot loop would help most.");
});

withModel("basic", "copy finding", (m) => {
  const f = m.findings.find((x) => x.id === "copy");
  assert.equal(plain(f.sentence), "z = z * z copies 13.5\u00a0MiB/s on average — check Python↔native conversions.");
});

test("gil rule: ≥ 2 % of samples waiting for the GIL names the busiest waiting thread", () => {
  const py = (name, line) => ({ kind: "py", display_name: name, filename_or_module: "/a/x.py", line, ip: null, offset: null });
  const nat = (name) => ({ kind: "native", display_name: name, filename_or_module: "/lib/libpython.so", line: null, ip: 1, offset: 0 });
  const events = [];
  for (let i = 0; i < 90; i++) events.push({ t_sec: i * 0.01, stack_index: 0, count: 1, thread_id: 1 });
  for (let i = 0; i < 10; i++) events.push({ t_sec: i * 0.01 + 0.005, stack_index: 1, count: 1, thread_id: 2 });
  events.sort((a, b) => a.t_sec - b.t_sec);
  const m = buildModel({
    elapsed_time_sec: 1,
    memory: false,
    gpu: false,
    max_footprint_mb: 0,
    growth_rate: 0,
    samples: [],
    main_thread_id: 1,
    combined_stacks: [
      [[py("<module>", 1), py("work", 2)], 90],
      [[py("<module>", 1), py("worker", 3), nat("take_gil")], 10],
    ],
    combined_stacks_timeline: events,
    files: {
      "/a/x.py": {
        percent_cpu_time: 40,
        functions: [],
        imports: [],
        lines: [1, 2, 3].map((n) => ({ lineno: n, line: `l${n}\n`, n_cpu_percent_python: n === 2 ? 30 : 5, n_cpu_percent_c: 0, n_sys_percent: 0 })),
      },
    },
  });
  const gil = m.findings.find((f) => f.id === "gil");
  assert.ok(gil);
  assert.equal(plain(gil.sentence), "10.0% of samples are waiting to take the GIL; the busiest waiting thread is thread 1.");
  assert.equal(gil.title, "Threads wait for the GIL");
});
