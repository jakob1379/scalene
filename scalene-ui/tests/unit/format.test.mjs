// §4.0.2 formatters: every row's examples plus the edge cases (0, negative,
// NaN, 99.96, 1023.99\u00a0MiB, 0.0009\u00a0MiB).
import assert from "node:assert/strict";
import { mod, test } from "./_harness.mjs";

const f = mod("core/format");

test("fmtPct: examples and edges", () => {
  assert.equal(f.fmtPct(21.4), "21.4%");
  assert.equal(f.fmtPct(0.4), "0.4%");
  assert.equal(f.fmtPct(0.04), "<0.1%");
  assert.equal(f.fmtPct(0.05), "0.1%");
  assert.equal(f.fmtPct(0), "0%");
  assert.equal(f.fmtPct(-3), "0%");
  assert.equal(f.fmtPct(NaN), "—");
  assert.equal(f.fmtPct(Infinity), "—");
  assert.equal(f.fmtPct(null), "—");
  assert.equal(f.fmtPct(undefined), "—");
  assert.equal(f.fmtPct(99.94), "99.9%");
  assert.equal(f.fmtPct(99.96), "100%");
  assert.equal(f.fmtPct(100), "100%");
  assert.equal(f.fmtPct(100.04), "100%");
  assert.equal(f.fmtPct(100.06), "100.1%");
  assert.equal(f.fmtPct(37.55), "37.5%"); // toFixed semantics (binary float)
});

test("fmtUtil follows fmtPct", () => {
  assert.equal(f.fmtUtil(66.93), "66.9%");
  assert.equal(f.fmtUtil(96.4), "96.4%");
  assert.equal(f.fmtUtil(0), "0%");
});

test("fmtTime: examples, unit boundaries and rounding carries", () => {
  assert.equal(f.fmtTime(0.368), "368\u00a0ms");
  assert.equal(f.fmtTime(2.64), "2.64\u00a0s");
  assert.equal(f.fmtTime(54.11), "54.1\u00a0s");
  assert.equal(f.fmtTime(227), "3\u00a0m\u00a047\u00a0s");
  assert.equal(f.fmtTime(226.887), "3\u00a0m\u00a047\u00a0s");
  assert.equal(f.fmtTime(0), "0\u00a0s");
  assert.equal(f.fmtTime(-1), "0\u00a0s");
  assert.equal(f.fmtTime(NaN), "—");
  assert.equal(f.fmtTime(0.0000123), "12\u00a0µs");
  assert.equal(f.fmtTime(0.0005), "500\u00a0µs");
  assert.equal(f.fmtTime(0.0012), "1.2\u00a0ms");
  assert.equal(f.fmtTime(0.00994), "9.9\u00a0ms");
  assert.equal(f.fmtTime(0.00999), "10\u00a0ms"); // rounds to 10.0 → integer-ms rule
  assert.equal(f.fmtTime(0.01), "10\u00a0ms");
  assert.equal(f.fmtTime(0.9994), "999\u00a0ms");
  assert.equal(f.fmtTime(0.9996), "1.00\u00a0s");
  assert.equal(f.fmtTime(9.996), "10.0\u00a0s");
  assert.equal(f.fmtTime(15.66), "15.7\u00a0s");
  assert.equal(f.fmtTime(59.96), "1\u00a0m\u00a000\u00a0s");
  assert.equal(f.fmtTime(61), "1\u00a0m\u00a001\u00a0s");
  assert.equal(f.fmtTime(3599.6), "1\u00a0h\u00a000\u00a0m");
  assert.equal(f.fmtTime(3900), "1\u00a0h\u00a005\u00a0m");
  assert.equal(f.fmtTime(7199), "2\u00a0h\u00a000\u00a0m");
});

test("fmtMem: binary units, decimals by magnitude, carries", () => {
  assert.equal(f.fmtMem(3184.65), "3.11\u00a0GiB");
  assert.equal(f.fmtMem(98.3), "98.3\u00a0MiB");
  assert.equal(f.fmtMem(742.24), "742\u00a0MiB");
  assert.equal(f.fmtMem(22 / 1024), "22\u00a0KiB");
  assert.equal(f.fmtMem(0), "0\u00a0B");
  assert.equal(f.fmtMem(-0.06), "0\u00a0B");
  assert.equal(f.fmtMem(NaN), "—");
  assert.equal(f.fmtMem(1023.99), "1.00\u00a0GiB");
  assert.equal(f.fmtMem(1023.4), "1023\u00a0MiB");
  assert.equal(f.fmtMem(0.0009), "944\u00a0B");
  assert.equal(f.fmtMem(1 / 1024), "1\u00a0KiB");
  assert.equal(f.fmtMem(0.99995), "1.00\u00a0MiB");
  assert.equal(f.fmtMem(1.2), "1.20\u00a0MiB");
  assert.equal(f.fmtMem(9.996), "10.0\u00a0MiB");
  assert.equal(f.fmtMem(99.96), "100\u00a0MiB");
  assert.equal(f.fmtMem(1229), "1.20\u00a0GiB");
  assert.equal(f.fmtMem(12 * 1024), "12.0\u00a0GiB");
  assert.equal(f.fmtMem(150 * 1024), "150\u00a0GiB");
  assert.equal(f.fmtMem(1024 * 1024 * 2.5), "2.50\u00a0TiB");
  assert.equal(f.fmtMem(1e-9), "<1\u00a0B");
});

test("fmtRate: adaptive units per second", () => {
  assert.equal(f.fmtRate(5.711977), "5.71\u00a0MiB/s");
  assert.equal(f.fmtRate(0.2811), "288\u00a0KiB/s");
  assert.equal(f.fmtRate(0.010969), "11\u00a0KiB/s");
  assert.equal(f.fmtRate(21.955), "22.0\u00a0MiB/s");
  assert.equal(f.fmtRate(NaN), "—");
});

test("fmtCount: grouping", () => {
  assert.equal(f.fmtCount(5901), "5,901");
  assert.equal(f.fmtCount(41604), "41,604");
  assert.equal(f.fmtCount(1234567.4), "1,234,567");
  assert.equal(f.fmtCount(12), "12");
  assert.equal(f.fmtCount(-1200), "-1,200");
  assert.equal(f.fmtCount(NaN), "—");
});

test("fmtDate: 24 h, en-US month (TZ=UTC)", () => {
  assert.equal(f.fmtDate(1793110937.318442), "Oct 27, 2026, 14:22");
  assert.equal(f.fmtDate(1792549065.003912), "Oct 21, 2026, 02:17");
  assert.equal(f.fmtDate(NaN), "");
});

test("fmtRange, fmtLoc, basename, dirname, splitUnit", () => {
  assert.equal(f.fmtRange(12, 18.5), "12.0\u00a0s – 18.5\u00a0s");
  assert.equal(f.fmtLoc("/home/dev/llm-train/train.py", 173), "train.py:173");
  assert.equal(f.fmtLoc("[12]", 3), "[12]:3");
  assert.equal(f.basename("C:\\work\\x.py"), "x.py");
  assert.equal(f.basename("<exec_3>"), "<exec_3>");
  assert.equal(f.dirname("/home/dev/llm-train/train.py"), "/home/dev/llm-train/");
  assert.equal(f.dirname("[12]"), "");
  assert.deepEqual(f.splitUnit("3.11\u00a0GiB"), ["3.11", "GiB"]);
  assert.deepEqual(f.splitUnit("66.9%"), ["66.9", "%"]);
  assert.deepEqual(f.splitUnit("<0.1%"), ["<0.1", "%"]);
  assert.deepEqual(f.splitUnit("3\u00a0m\u00a047\u00a0s"), ["3\u00a0m\u00a047\u00a0s", ""]);
  assert.deepEqual(f.splitUnit("5.71\u00a0MiB/s"), ["5.71", "MiB/s"]);
});

test("bidi / zero-width controls: visible in labels, isolated badge spans in code (round 1)", () => {
  const f = mod("core/format");
  const name = "/a/zero​width‮RTL-override.py";
  assert.equal(f.basename(name), "zero⟨U+200B⟩width⟨U+202E⟩RTL-override.py");
  assert.equal(f.fmtLoc(name, 21), "zero⟨U+200B⟩width⟨U+202E⟩RTL-override.py:21");
  assert.equal(f.dirname("/x⁦y/a.py"), "/x⟨U+2066⟩y/");
  assert.equal(f.basename("/home/dev/train.py"), "train.py", "plain names untouched");
  const { highlight } = mod("model/syntax");
  const spans = highlight("x = 1  # ‮evil⁦ end");
  const ctl = spans.filter((s) => s.cls.startsWith("t-ctl"));
  assert.deepEqual(ctl.map((s) => s.cls), ["t-ctl u202e", "t-ctl u2066"]);
  assert.equal(spans.map((s) => s.text).join(""), "x = 1  # ‮evil⁦ end", "span text stays verbatim");
  assert.deepEqual(highlight("plain = 1").map((s) => s.cls).filter((c) => c.startsWith("t-ctl")), []);
});
