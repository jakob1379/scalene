// §4.5 hotspot lists: ranks, values, secondary values, badges, meters,
// Pareto footer, TOP LINES sample times, aria labels.
import assert from "node:assert/strict";
import { mod, withModel } from "./_harness.mjs";

const h = mod("model/hotspots");

withModel("ml-training", "lines × time", (m) => {
  const list = h.hotspotList(m, "lines", "time");
  assert.equal(list.items.length, 8);
  assert.deepEqual(list.items.map((i) => i.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  const first = list.items[0];
  assert.equal(first.valueText, "21.4%");
  assert.equal(first.secondary, "11.6\u00a0s");
  assert.equal(first.code, "loss_value = loss.item()");
  assert.equal(first.location, "train() · train.py:173");
  assert.deepEqual(first.target, { file: "/home/dev/llm-train/train.py", line: 173 });
  assert.equal(first.ariaLabel, "1. loss_value = loss.item(), train.py line 173 in train, 21.4% of run, 11.6 seconds");
  assert.deepEqual(first.badge, { kind: "gpu", text: "GPU 96%" });
  assert.equal(first.times, first.line.cpuTimes);
  assert.ok(first.times.length > 0 && first.times.length <= 500);
  assert.equal(first.meter.max, first.value, "scaled to row #1");
  assert.deepEqual(first.meter.parts.map((p) => p.token), ["cpu-py", "cpu-native", "cpu-sys"]);
  assert.deepEqual(list.items[5].badge, { kind: "leak", text: "↗ leak" });
  assert.equal(h.paretoText(list), "Top 8 lines = 58.4% of run time");
  assert.equal(list.more, 100);
  assert.equal(list.subtitle, "by share of run time · bars scaled to #1");
});

withModel("ml-training", "lines × memory: by peak, no Pareto (peaks overlap)", (m) => {
  const list = h.hotspotList(m, "lines", "memory");
  assert.equal(list.items[0].line.no, 120);
  assert.equal(list.items[0].valueText, "1.20\u00a0GiB");
  assert.equal(list.items[0].secondary, "33.0% of alloc.");
  assert.equal(list.pareto, null);
  assert.equal(h.paretoText(list), null);
  for (const it of list.items) {
    const times = it.times;
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
    assert.equal(times.length, it.line.memSamples.length / 2);
  }
  assert.deepEqual(list.items[0].meter.parts.map((p) => p.token), ["mem-py", "mem-native"]);
});

withModel("ml-training", "lines × gpu: absolute meter, population ≥ 1% of run", (m) => {
  const list = h.hotspotList(m, "lines", "gpu");
  assert.ok(list.items.every((i) => i.line.total >= 1));
  assert.ok(list.items.every((i) => i.meter.max === 100));
  for (let i = 1; i < list.items.length; i++) assert.ok(list.items[i - 1].value >= list.items[i].value);
  assert.ok(list.items.every((i) => i.badge?.kind !== "gpu"), "no GPU badge on the GPU metric");
});

withModel("ml-training", "functions × time and files × time", (m) => {
  const fns = h.hotspotList(m, "functions", "time");
  const train = fns.items[0];
  assert.equal(train.code, "train");
  assert.equal(train.valueText, "47.1%");
  assert.equal(train.location, "train.py:124");
  assert.deepEqual(train.target, { file: "/home/dev/llm-train/train.py", fn: "train" });
  const union = train.fn.members.reduce((a, l) => a + l.cpuTimes.length, 0);
  assert.equal(train.times.length, union, "union of member lines' samples");
  for (let i = 1; i < train.times.length; i++) assert.ok(train.times[i] >= train.times[i - 1]);
  const files = h.hotspotList(m, "files", "time");
  assert.equal(files.items[0].code, "train.py");
  assert.equal(files.items[0].valueText, "58.8%");
  assert.equal(files.items[0].kind, "file");
  assert.match(files.items[0].location, /^peak /);
});

withModel("async-server", "event-loop badge, await metric", (m) => {
  const list = h.hotspotList(m, "lines", "time");
  assert.deepEqual(list.items[0].badge, { kind: "loop", text: "event loop · waiting" });
  const aw = h.hotspotList(m, "lines", "await");
  assert.equal(aw.items[0].line.no, 59);
  assert.equal(aw.items[0].valueText, "35.8%");
  assert.equal(aw.items[0].secondary, "15.5 tasks");
  assert.equal(aw.subtitle, "by share of await time");
  assert.match(h.paretoText(aw), /^Top 8 lines = .*% of await time$/);
  assert.deepEqual(h.availableMetrics(m), ["time", "memory", "await"]);
});

withModel("cpu-only", "metrics and short lists", (m) => {
  assert.deepEqual(h.availableMetrics(m), ["time"]);
  const five = h.hotspotList(m, "lines", "time", 5);
  assert.equal(five.items.length, 5);
  assert.equal(h.paretoText(five), "Top 5 lines = 46.2% of run time");
  assert.match(h.paretoText({ ...five, kind: "files", items: five.items.slice(0, 1) }), /^Top file = .*% of run time$/);
});

withModel("huge", "hotspot #1 keeps >= verbatim", (m) => {
  const it = h.hotspotList(m, "lines", "time").items[0];
  assert.equal(it.code, 'assert dist >= 0, "negative density"');
  assert.equal(it.valueText, "4.2%");
});

withModel("basic", "copy badge uses fmtRate: same text as the copy finding (round 1)", (m) => {
  const { fmtRate } = mod("core/format");
  const list = h.hotspotList(m, "lines", "time");
  const row = list.items.find((i) => i.line && i.line.no === 23);
  assert.ok(row, "testme.py:23 in the top lines");
  assert.deepEqual(row.badge, { kind: "copy", text: `copy ${fmtRate(row.line.copy ?? 13.5)}` });
  assert.equal(row.badge.text, "copy 13.5 MiB/s");
});
