// §4.2 headline: shortCode (token-safe chips), golden headline strings for
// the 7 non-empty fixtures (Appendix A), chip budget, segment shapes, meta.
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const h = mod("model/headline");

test("shortCode: rule 1 keeps short balanced text verbatim", () => {
  assert.equal(h.shortCode("  loss_value = loss.item()\n"), "loss_value = loss.item()");
  assert.equal(h.shortCode("torch.save(state, path)"), "torch.save(state, path)");
  assert.equal(h.shortCode("assert dist >= 0, \"negative density\""), null); // 35 chars, no rule applies
  assert.equal(h.shortCode(""), null);
  assert.equal(h.shortCode("   "), null);
});

test("shortCode: rule 2 assignments (call rhs, else target = …)", () => {
  assert.equal(h.shortCode('digest = hashlib.pbkdf2_hmac("sha256", token.encode(), TOKEN_SALT, 1_000)'), "hashlib.pbkdf2_hmac(…)");
  assert.equal(h.shortCode('logits = neuron_model(enc["input_ids"], enc["attention_mask"])[0]'), "neuron_model(…)");
  assert.equal(h.shortCode("z1 = [i for i in range(0,300000)][299999]"), "z1 = …");
  assert.equal(h.shortCode("self.total_tokens += batch.numel() * self.world_size_factor"), "self.total_tokens += …");
  assert.equal(h.shortCode("out = self.layer_norm_final(hidden_states).float().contiguous()"), "….contiguous()");
  assert.equal(h.shortCode("y = model.encode(batch).mean(dim=1)"), "model.encode(…).mean(…)");
  assert.equal(h.shortCode("acc: float = compute_accuracy(logits, labels, ignore_index=-100)"), "compute_accuracy(…)");
  assert.equal(h.shortCode("counter += [x for x in range(100000) if x % 7 == 0][0]"), "counter += …");
  assert.equal(h.shortCode("enc = tokenizer("), "tokenizer(…)"); // unbalanced continuation line
  assert.equal(h.shortCode("value = await self._backend.get(key, default=None, timeout=1.0)"), "await self._backend.get(…)");
  assert.equal(h.shortCode("x = a.very.long.dotted.module.path.function_name(argument_one)"), "….function_name(…)");
  // Comparisons are not assignments.
  assert.equal(h.shortCode("result_is_the_same_value == other_value_compared_here"), null);
});

test("shortCode: rule 3 call statements", () => {
  assert.equal(h.shortCode("asyncio.run(main(parser.parse_args()))"), "asyncio.run(…)");
  assert.equal(h.shortCode("await asyncio.sleep(rng.uniform(0.005, 0.025))"), "await asyncio.sleep(…)");
  assert.equal(h.shortCode("self.last_token_logits.append(logits[:, -1, :].detach().float().cpu())"), "self.last_token_logits.append(…)");
  assert.equal(h.shortCode("self.last_token_logits.append(logits[:, -1, :].detach().float().cpu())", 22), "….append(…)");
  assert.equal(h.shortCode("return torch.jit.load(path_to_the_compiled_model_file)"), "return torch.jit.load(…)");
  assert.equal(h.shortCode("torch.save(state, path)", 22), "torch.save(…)");
});

test("shortCode: rule 4 compound headers keep whole tokens", () => {
  assert.equal(h.shortCode("for step in range(cfg.max_steps):"), "for step in …");
  assert.equal(h.shortCode("while not self.queue.empty() and self.running:"), "while not self.queue.empty() …");
  assert.equal(h.shortCode("async with self.pool.acquire() as connection:"), "async with self.pool.acquire() …");
  assert.equal(h.shortCode("for step in range(cfg.max_steps):", 20), "for step in …");
  assert.equal(h.shortCode("def very_long_function_name_that_never_ends(a, b, c):"), "def …");
});

test("shortCode: ellipsis only between tokens", () => {
  const samples = [
    "loss_value = loss.item()",
    "chunk = self.tokens[start : start + self.block_size + 1].astype(np.int64)",
    "scaler.scale(loss).backward()",
    "for batch_index, (inputs, targets) in enumerate(train_loader):",
    "x = y",
  ];
  for (const s of samples) {
    const c = h.shortCode(s);
    if (c === null) continue;
    assert.ok(c.length <= 32, c);
    for (const piece of c.split("…").slice(0, -1)) assert.ok(piece === "" || /[\s.(]$/.test(piece), `${s} → ${c}`);
  }
});

const GOLDEN = {
  "ml-training": "train.py ran for 54.1\u00a0s. Two lines in train() account for 37.6% of the time; memory peaked at 3.11\u00a0GiB.",
  "async-server":
    "bench_server.py ran for 15.7\u00a0s. 59.6% of it is the event loop (asyncio.run(…)), mostly waiting. The busiest code, hashlib.pbkdf2_hmac(…) (21.6%, handlers.py:51), runs inside a coroutine, so the loop stalls while it runs.",
  "cpu-only": "nbody.py ran for 22.2\u00a0s. Three lines in accelerations() account for 32.0% of the time.",
  neuron: "infer_bert.py ran for 26.2\u00a0s. neuron_model(…) (infer_bert.py:66) takes 37.7% of the time; memory peaked at 742\u00a0MiB.",
  basic: "testme.py ran for 1.68\u00a0s. Two lines in doit2() account for 41.6% of the time; memory peaked at 10.2\u00a0MiB.",
  example: "This program ran for 12.7\u00a0s. z1 = … (testme.py:14) takes 34.6% of the time; memory peaked at 46.2\u00a0MiB.",
  huge: "run_sim.py ran for 3\u00a0m\u00a047\u00a0s. Time is spread out: the busiest function, update_basis(), takes 5.8%; memory peaked at 2.38\u00a0GiB.",
};

for (const [name, want] of Object.entries(GOLDEN)) {
  withModel(name, "golden headline", (m) => {
    assert.equal(m.headline.plain, want);
    const chips = m.headline.segments.filter((s) => s.t === "code");
    assert.ok(chips.length <= 2, "at most 2 code chips");
    for (const c of chips) {
      assert.ok(c.s.length <= 32);
      assert.ok(c.full.trim().length > 0, "chip carries its full text");
      assert.ok("line" in c.target || "fn" in c.target);
    }
  });
}

withModel("ml-training", "segments: bold program/numbers, function chip targets train()", (m) => {
  const segs = m.headline.segments;
  assert.deepEqual(segs[0], { t: "num", s: "train.py" });
  assert.deepEqual(segs.filter((s) => s.t === "num").map((s) => s.s), ["train.py", "54.1\u00a0s", "37.6%", "3.11\u00a0GiB"]);
  const chip = segs.find((s) => s.t === "code");
  assert.equal(chip.s, "train()");
  assert.deepEqual(chip.target, { file: "/home/dev/llm-train/train.py", fn: "train" });
});

withModel("async-server", "event-loop branch: 2 chips + a ref", (m) => {
  const segs = m.headline.segments;
  assert.equal(segs.filter((s) => s.t === "code").length, 2);
  const ref = segs.find((s) => s.t === "ref");
  assert.equal(ref.s, "handlers.py:51");
  assert.deepEqual(ref.target, { file: "/srv/catalog-api/catalog/handlers.py", line: 51 });
});

withModel("neuron", "k = 1 chip carries the full source as tooltip", (m) => {
  const chip = m.headline.segments.find((s) => s.t === "code");
  assert.equal(chip.full, 'logits = neuron_model(enc["input_ids"], enc["attention_mask"])[0]');
  assert.deepEqual(chip.target, { file: "/home/ubuntu/neuron-bert/infer_bert.py", line: 66 });
});

const META = {
  "ml-training": "Profiled Oct 27, 2026, 14:22 · 6 files · 5 threads · GPU · 10\u00a0ms sampling · Scalene 2.4.0",
  huge: "Profiled Oct 21, 2026, 02:17 · 24 files (+16 below 1%) · 12 threads · GPU · 10\u00a0ms sampling · Scalene 2.4.0",
  "async-server": "Profiled Oct 26, 2026, 09:41 · 5 files · async · 10\u00a0ms sampling · Scalene 2.4.0",
  "cpu-only": "Profiled Oct 25, 2026, 21:13 · 1 file · CPU only · 10\u00a0ms sampling · Scalene 2.4.0",
  neuron: "Profiled Oct 24, 2026, 18:05 · 2 files · AWS Neuron · Scalene 2.4.0",
  basic: "1 file · Scalene 2.4.0",
};

for (const [name, want] of Object.entries(META)) {
  withModel(name, "meta line", (m) => {
    const text = h.buildMeta(m).map((x) => (x.extra ? `${x.text} ${x.extra}` : x.text)).join(" · ");
    assert.equal(text, want);
  });
}

test("no CPU samples: rule 6", () => {
  const { buildModel } = mod("model/model");
  const m = buildModel({
    program: "/x/idle.py",
    elapsed_time_sec: 2.5,
    memory: true,
    gpu: false,
    max_footprint_mb: 12,
    growth_rate: 0,
    samples: [],
    files: { "/x/idle.py": { percent_cpu_time: 0, functions: [], imports: [], lines: [{ lineno: 1, line: "pass\n" }] } },
  });
  assert.equal(m.headline.plain, "idle.py ran for 2.50\u00a0s; no CPU samples were attributed to profiled files; memory peaked at 12.0\u00a0MiB.");
});
