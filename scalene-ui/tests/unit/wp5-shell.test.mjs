// WP5 shell (DESIGN.md §4.15–4.17, §4.20, §6.2.3): profile validation for the loader,
// palette ranking helpers (group order, fuzzy filters) and the search results the palette
// shows for "loss.item", "train" and "Timeline", and the shortcuts map.
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const loader = mod("views/shell/loader");
const P = mod("views/shell/palette");
const S = mod("views/shell/shortcuts");
const { runNow } = mod("model/lazy");
const { buildSearchIndex } = mod("model/search");

test("loader: validateProfileText accepts profiles and {}, rejects bad JSON and non-profiles", () => {
  assert.equal(loader.validateProfileText("{}").ok, true);
  assert.equal(loader.validateProfileText('{"files": {}}').ok, true);
  assert.equal(loader.validateProfileText('{"files": {"a.py": {"lines": []}}, "elapsed_time_sec": 1}').ok, true);
  const bad = loader.validateProfileText('{"files": {');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /JSON|Expected|Unexpected/);
  assert.deepEqual(loader.validateProfileText('{"version": 1}'), { ok: false, message: 'This JSON is not a Scalene profile (no "files" section)' });
  assert.deepEqual(loader.validateProfileText('{"files": []}'), { ok: false, message: 'This JSON is not a Scalene profile (no "files" section)' });
  for (const t of ["[]", "3", '"x"', "null"]) assert.equal(loader.validateProfileText(t).ok, false, t);
  assert.equal(loader.filesLabel(1), "1 file");
  assert.equal(loader.filesLabel(6), "6 files");
  assert.equal(loader.PROGRESS_BYTES, 2 * 1024 * 1024);
});

test("palette: code-like text searches Lines first, names search Functions/Files, labels win on prefix", () => {
  assert.equal(P.isCodeLike("loss.item"), true);
  assert.equal(P.isCodeLike("x = 1"), true);
  assert.equal(P.isCodeLike("scaler.scale("), true);
  assert.equal(P.isCodeLike("train_step"), true);
  assert.equal(P.isCodeLike("train"), false);
  assert.equal(P.isCodeLike("Timeline"), false);
  assert.deepEqual(P.groupOrder("", { sections: false, actions: false }), ["hotspots", "sections", "actions"]);
  assert.deepEqual(P.groupOrder("loss.item", { sections: false, actions: false }), ["lines", "functions", "files", "sections", "actions"]);
  assert.deepEqual(P.groupOrder("train", { sections: false, actions: false }), ["functions", "files", "lines", "sections", "actions"]);
  assert.deepEqual(P.groupOrder("Timeline", { sections: true, actions: false }), ["sections", "functions", "files", "lines", "actions"]);
});

test("palette: label filter ranks prefix matches first and searches keywords", () => {
  const secs = ["Overview", "Code", "Stacks", "Timeline", "Memory"].map((label) => ({ label }));
  const t = P.filterLabels(secs, "Timeline");
  assert.equal(t[0].item.label, "Timeline");
  assert.equal(t[0].prefix, true);
  const acts = P.filterLabels(P.ACTIONS, "ollama");
  assert.equal(acts[0].item.id, "ai", "keywords reach Open AI settings");
  assert.equal(P.filterLabels(P.ACTIONS, "theme")[0].item.id, "theme");
  assert.equal(P.filterLabels(P.ACTIONS, "").length, P.ACTIONS.length);
  assert.equal(P.filterLabels(secs, "zzz").length, 0);
});

test("palette: weak fuzzy hits drop when a strong one exists; base-name file matches win", () => {
  const hits = [{ score: 20, n: "train" }, { score: 11.7, n: "ThreadedPrefetcher._next_indices" }, { score: 18, n: "train_step" }];
  assert.deepEqual(P.strongHits(hits).map((h) => h.n), ["train", "train_step"]);
  assert.deepEqual(P.strongHits([]), []);
  const files = [{ item: { base: "train.py" } }, { item: { base: "loader.py" } }];
  assert.deepEqual(P.preferBaseNames(files, "train").map((f) => f.item.base), ["train.py"]);
  assert.deepEqual(P.preferBaseNames(files, "llm-train/").length, 2, "path-like queries keep path matches");
  assert.deepEqual(P.preferBaseNames(files, "zz").length, 2, "no base match: keep the path matches");
});

withModel("ml-training", 'palette search: "loss.item" lines, "train" function + file, hotspots first', (m) => {
  const ix = runNow(buildSearchIndex(m));
  const r1 = ix.query("loss.item", { lines: 50, functions: 8, files: 8 });
  assert.ok(r1.lines.length >= 1);
  assert.equal(r1.lines[0].line.text.trim(), "loss_value = loss.item()", "hot lines first");
  assert.equal(r1.lines[0].line.no, 173);
  const r2 = ix.query("train", { lines: 50, functions: 8, files: 8 });
  const fns = P.strongHits(r2.functions);
  assert.equal(fns[0].item.name, "train");
  assert.ok(!fns.some((f) => f.item.name.includes("Prefetcher")), "scattered subsequences are dropped");
  const files = P.strongHits(P.preferBaseNames(r2.files, "train"));
  assert.deepEqual(files.map((f) => f.item.base), ["train.py"]);
  const secs = P.filterLabels(Object.values(P.SECTION_LABELS).map((label) => ({ label })), "Timeline");
  assert.equal(secs[0].item.label, "Timeline");
});

withModel("ml-training", 'palette: "loss" opens the loss.item() line, never adamw.py (round 1)', (m) => {
  const ix = runNow(buildSearchIndex(m));
  const r = ix.query("loss", { lines: 50, functions: 8, files: 8 });
  assert.ok(!r.files.some((f) => f.item.base === "adamw.py"), "no subsequence scattered across a path");
  const order = P.groupOrder("loss", { sections: false, actions: false }, P.bestStrengths(r));
  assert.equal(order[0], "lines", `group order ${order.join(",")}`);
  assert.equal(r.lines[0].line.text.trim(), "loss_value = loss.item()");
  assert.equal(r.lines[0].strength, 3);
  // Names still win for name-like queries; directory segments still find library files.
  const t = ix.query("train", { lines: 50, functions: 8, files: 8 });
  assert.deepEqual(P.groupOrder("train", { sections: false, actions: false }, P.bestStrengths(t)).slice(0, 3), ["functions", "files", "lines"]);
  const o = ix.query("optim", { lines: 50, functions: 8, files: 8 });
  assert.ok(o.files.some((f) => f.item.base === "adamw.py"), "a whole directory segment (torch/optim/) still matches");
});

test("palette: group order follows the best hit's strength; ties keep the default order", () => {
  const q = { sections: false, actions: false };
  assert.deepEqual(P.groupOrder("loss", q, { lines: 3, functions: 0, files: 1 }).slice(0, 3), ["lines", "files", "functions"]);
  assert.deepEqual(P.groupOrder("loss", q, { lines: 2, functions: 2, files: 0 }).slice(0, 3), ["functions", "lines", "files"]);
  assert.deepEqual(P.groupOrder("a.b", q, { lines: 2, functions: 3, files: 0 }).slice(0, 3), ["functions", "lines", "files"]);
  const sr = mod("model/search");
  assert.equal(sr.bestMatch("loss", "loss_value").strength, 3);
  assert.equal(sr.bestMatch("oss", "loss_value").strength, 2);
  assert.equal(sr.bestMatch("lsv", "loss_value").strength, 1);
  assert.equal(sr.bestMatch("item", "lossitem item").positions[0], 9, "prefers the word-start occurrence");
  assert.ok(sr.minFuzzyScore("loss") > 0 && sr.minFuzzyScore("ab") === 0);
});

test("shortcuts: §6.2.3 scopes, each tied to its section", () => {
  const groups = S.shortcutGroups("Ctrl K");
  assert.deepEqual(groups.map((g) => g.title), ["Global", "Hotspots", "Signal", "Code table", "Minimap", "Flame graph", "Timeline", "Dialogs"]);
  assert.deepEqual(groups.map((g) => g.section), [null, "overview", "overview", "code", "code", "stacks", "timeline", null]);
  const code = groups.find((g) => g.title === "Code table");
  for (const k of ["e", "o", "s", "t"]) assert.ok(code.rows.some(([keys]) => keys.some((chord) => chord.length === 1 && chord[0] === k)), k);
  assert.ok(code.rows.some(([keys]) => keys.some((chord) => chord.join("+") === "Shift+O")));
  assert.ok(groups[0].rows[0][0].some((c) => c[0] === "Ctrl K"));
});
