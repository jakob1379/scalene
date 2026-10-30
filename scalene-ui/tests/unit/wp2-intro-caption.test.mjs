// WP2 (DESIGN.md §4.3.2, §4.3.4, §4.4.9, §5.2 M2/M4, §5.3.1): readout caption fitting (max 2
// rows, md 1, whole phrases only, compact denominator fallback), the M2 count-up text, and the
// compositor sweep's timing maths (CSS linear() easing, beam crossing time, settle budget).
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const cap = mod("views/overview/caption");
const ro = mod("views/overview/readouts");
const intro = mod("views/overview/scope-intro");
const ov = mod("views/overview/overview");

const text = (s) => ({ t: "text", s });
const ref = (s) => ({ t: "ref", s, target: { file: "a.py", line: 1 } });
const code = (s) => ({ t: "code", s, full: s, target: { file: "a.py", line: 1 } });

test("captions split into phrases at ' · ' only inside text (chips and refs stay whole)", () => {
  const line = [text("at 52.9\u00a0s · "), ref("train.py:120"), text(" · Python 1.0%")];
  const ph = cap.splitPhrases(line);
  assert.equal(ph.length, 3);
  assert.deepEqual(ph.map(cap.plainText), ["at 52.9\u00a0s", "train.py:120", "Python 1.0%"]);
  const awaitLine = [text("of await time at "), code("await asyncio.sleep(…)"), text(" · "), ref("bench_server.py:59")];
  assert.deepEqual(cap.splitPhrases(awaitLine).map(cap.plainText), ["of await time at await asyncio.sleep(…)", "bench_server.py:59"]);
  assert.equal(cap.noBreakHyphens("(time-weighted) 1-2"), "(time‑weighted) 1-2");
});

test("caption plan: a plain line 1 that needs two rows gives way to the compact denominator (GPU)", () => {
  // "mean while the main thread ran (time-weighted)" wraps (ends on row 1); line 2's first
  // phrase fits on one row, its second does not.
  const plan = cap.planCaption([[1], [0, 1]], 2, true, false);
  assert.deepEqual(plan, { visible: [0, 1], alt: true });
});

test("caption plan: whole phrases drop from the end of each line (Peak)", () => {
  // "at 52.9\u00a0s · train.py:120 · Python 1.0%" fits in one row; "growth 52.2% · +212\u00a0MiB native threads" too.
  assert.deepEqual(cap.planCaption([[0, 0, 0], [0, 0]], 2, true, false), { visible: [3, 2], alt: false });
  // Narrow tile: "Python 1.0%" wraps to row 1 → dropped; line 2 keeps its first phrase only.
  assert.deepEqual(cap.planCaption([[0, 0, 1], [0, 1]], 2, true, false), { visible: [2, 1], alt: false });
});

test("caption plan: a line 1 that opens with a code chip is kept whole first (Await)", () => {
  // "of await time at `await asyncio.sleep(…)`" takes two rows, the ref would need a third:
  // the chip stays (it is what the value is about), the ref and line 2 drop.
  assert.deepEqual(cap.planCaption([[1, 2], [0]], 2, true, true), { visible: [1, 0], alt: false });
  // With room for everything nothing drops.
  assert.deepEqual(cap.planCaption([[0, 0], [0]], 2, true, true), { visible: [2, 1], alt: false });
});

test("caption plan: md budget of one row, single-line captions may use both rows, budget 0 hides", () => {
  assert.deepEqual(cap.planCaption([[0, 0, 1], [0]], 1, true, false), { visible: [2, 0], alt: false });
  assert.deepEqual(cap.planCaption([[1], [0]], 1, true, false), { visible: [0, 0], alt: true });
  // One semantic line ("share of run time · 0.4% outside profiled files") may wrap onto row 2.
  assert.deepEqual(cap.planCaption([[0, 1]], 2, true, false), { visible: [2], alt: false });
  assert.deepEqual(cap.planCaption([[0, 1]], 0, true, false), { visible: [0], alt: false });
  // A later line whose first phrase cannot fit its row is dropped, never cut.
  assert.deepEqual(cap.planCaption([[0], [1]], 2, true, false), { visible: [1, 0], alt: false });
});

test("M2 count-up text keeps the final decimals and grouping from the first frame, monotonic", () => {
  assert.equal(ro.countText("3.11", 0), "0.00");
  assert.equal(ro.countText("3.11", 1), "3.11");
  assert.equal(ro.countText("66.9", 0.5), "33.4");
  assert.equal(ro.countText("14,656", 0.5), "7,328");
  assert.equal(ro.countText("2", 0.49), "0");
  assert.equal(ro.countText("3\u00a0m\u00a047\u00a0s", 0.3), "3\u00a0m\u00a047\u00a0s"); // not a plain number: never counted
  let prev = -1;
  for (let k = 0; k <= 1.0001; k += 0.01) {
    const v = parseFloat(ro.countText("742", Math.min(1, k)).replace(/,/g, ""));
    assert.ok(v >= prev, `monotonic at ${k}`);
    prev = v;
  }
});

test("one clock per readout tile: label, value, count-up and meter start together (review round 1)", () => {
  for (let i = 0; i < 4; i++) {
    const c = ro.tileClock(i, 60);
    assert.equal(c.reveal, 60 + ro.TILE_STAGGER * i);
    assert.equal(c.count, c.reveal, "the count-up starts when its label reveals");
    assert.equal(c.meter, c.count, "the meter grows on the count-up's clock");
    assert.equal(c.duration, 600);
    // Settled well inside the 900 ms intro budget (§5.3.1).
    assert.ok(c.count + c.duration <= 900 - 100, `tile ${i} settles at ${c.count + c.duration} ms`);
  }
});

test("M4 sweep: linear() easing samples 1 − (1 − t)^2.2; timing = 120\u00a0ms + 640\u00a0ms; crossing time inverts it", () => {
  const css = intro.sweepLinearEasing(48);
  assert.match(css, /^linear\(0, /);
  assert.match(css, /, 1\)$/);
  assert.equal(css.slice(7, -1).split(",").length, 49);
  assert.equal(intro.sweepAt(0), 0);
  assert.equal(intro.sweepAt(120), 0);
  assert.equal(intro.sweepAt(760), 1);
  // §5.3.1 filmstrip: at 300\u00a0ms the beam is about half-way (≈ 45–51 % of the x range).
  const mid = intro.sweepAt(300);
  assert.ok(mid > 0.45 && mid < 0.53, `sweep at 300\u00a0ms = ${mid}`);
  for (const f of [0, 0.1, 0.5, 0.9, 0.977, 1]) assert.ok(Math.abs(intro.sweepAt(intro.crossingTime(f)) - f) < 1e-9, `crossing ${f}`);
  assert.equal(intro.SWEEP_START, 120);
  assert.equal(intro.SETTLE_MS, 900);
  assert.equal(ov.INTRO_SETTLE_MS, 900);
});

withModel("ml-training", "the beam reaches the real peak (52.9\u00a0s of 54.1\u00a0s) by ≈ 650\u00a0ms and its ping ends before 900\u00a0ms", (m) => {
  {
    const frac = m.memory.peakT / m.tMax;
    const at = intro.crossingTime(frac);
    assert.ok(at > 600 && at < 700, `crossing at ${at.toFixed(0)} ms`);
    const ping = Math.min(240, intro.SETTLE_MS - 20 - at);
    assert.ok(at + ping <= intro.SETTLE_MS - 20 + 1e-9);
    // The callout fade (140\u00a0ms) also settles by 900\u00a0ms.
    assert.ok(at + 140 < intro.SETTLE_MS);
  }
});
