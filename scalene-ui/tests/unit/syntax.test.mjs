// §4.0.5 highlighter: upstream stringLines semantics, token classes,
// lossless spans (code renders verbatim), memoisation.
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const s = mod("model/syntax");
const spans = (line, inString = false) => s.highlight(line, inString).map((x) => [x.cls, x.text]);
const cls = (line, text) => s.highlight(line).find((x) => x.text === text)?.cls;

test("stringLines: opening, inner and closing lines; one-line docstrings are not marked", () => {
  assert.deepEqual(s.stringLines(['"""doc"""', "x = 1"]), [false, false]);
  assert.deepEqual(s.stringLines(['"""', "inner", '"""', "y"]), [true, true, true, false]);
  assert.deepEqual(s.stringLines(["s = '''a", "b'''", "c"]), [true, true, false]);
  // A different delimiter inside does not close the string.
  assert.deepEqual(s.stringLines(['"""', "'''", '"""', "z"]), [true, true, true, false]);
  assert.deepEqual(s.stringLines(['x = """a""" + """b', 'c"""', "d"]), [true, true, false]);
  assert.deepEqual(s.stringLines([]), []);
});

test("keywords, def names, builtins, decorators", () => {
  assert.deepEqual(spans("def train(cfg):"), [["t-kw", "def"], ["", " "], ["t-def", "train"], ["", "(cfg):"]]);
  assert.equal(cls("class GPT(nn.Module):", "GPT"), "t-def");
  assert.equal(cls("async def fetch(x):", "async"), "t-kw");
  assert.equal(cls("async def fetch(x):", "fetch"), "t-def");
  assert.equal(cls("    return len(self.items)", "return"), "t-kw");
  assert.equal(cls("    return len(self.items)", "len"), "t-bi");
  assert.equal(cls("    return len(self.items)", "self"), "t-bi");
  assert.deepEqual(spans("@torch.no_grad()"), [["t-dec", "@torch.no_grad"], ["", "()"]]);
  assert.equal(cls("x = a @ b", "@"), undefined, "matrix multiply is not a decorator");
  assert.equal(cls("    match command:", "match"), "t-kw");
  assert.equal(cls("        case 1:", "case"), "t-kw");
  assert.ok(!s.highlight("match = re.match(p, s)").some((x) => x.cls === "t-kw"), "soft keyword only as a statement");
  assert.equal(cls("x = None if a is not b else True", "None"), "t-kw");
});

test("strings, numbers, comments", () => {
  assert.equal(cls('name = f"{x}!"', 'f"{x}!"'), "t-str");
  assert.equal(cls("p = r'\\d+'", "r'\\d+'"), "t-str");
  assert.equal(cls("b = rb'\\x00'", "rb'\\x00'"), "t-str");
  assert.equal(cls('s = "a \\" b"', '"a \\" b"'), "t-str");
  assert.equal(cls('d = """one line"""', '"""one line"""'), "t-str");
  assert.equal(cls("s = 'unterminated", "'unterminated"), "t-str");
  for (const n of ["1_000", "0x1F", "0o17", "0b1010", "3.5e-3j", ".5", "10.", "42"]) assert.equal(cls(`v = ${n}`, n), "t-num", n);
  assert.deepEqual(spans("x1 = y2"), [["", "x1 = y2"]], "digits inside identifiers are not numbers");
  assert.deepEqual(spans("x = 1  # note"), [["", "x = "], ["t-num", "1"], ["", "  "], ["t-com", "# note"]]);
  assert.deepEqual(spans("s = '#not a comment'"), [["", "s = "], ["t-str", "'#not a comment'"]]);
});

test("inside a triple-quoted string: the whole line is docstring style", () => {
  assert.deepEqual(spans("    Returns the loss.", true), [["t-com", "    Returns the loss."]]);
  assert.deepEqual(spans("", true), []);
});

test("operators render verbatim (ligature-prone sequences untouched)", () => {
  const line = 'assert dist >= 0 and a != b and f -> g == h, "negative density"';
  assert.equal(s.highlight(line).map((x) => x.text).join(""), line);
  assert.ok(s.highlight(line).some((x) => x.text.includes(">=")));
});

test("highlightCached memoises per key", () => {
  s.clearHighlightCache();
  const a = s.highlightCached("f:1", "def a(): pass", false);
  assert.equal(s.highlightCached("f:1", "def a(): pass", false), a);
  assert.notEqual(s.highlightCached("f:2", "def a(): pass", false), a);
});

for (const name of ["ml-training", "async-server", "huge"]) {
  withModel(name, "spans are lossless for every source line", (m) => {
    for (const f of m.files.concat(m.hiddenFiles)) {
      for (const l of f.lines) {
        const out = s.highlight(l.text, l.doc);
        assert.equal(out.map((x) => x.text).join(""), l.text, `${f.base}:${l.no}`);
        for (let i = 1; i < out.length; i++) assert.notEqual(out[i].cls, out[i - 1].cls, "adjacent spans merged");
      }
    }
  });
}

withModel("ml-training", "docstring flags come from stringLines", (m) => {
  const docs = m.files.flatMap((f) => f.lines.filter((l) => l.doc));
  assert.ok(docs.length > 0);
  assert.ok(docs.every((l) => !/^\s*def\s/.test(l.text)));
});
