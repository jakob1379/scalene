// Shell-level contracts (DESIGN.md §2.1 section presence, §4.16 empty state,
// §4.19 tooltip binding) and the model extensions the shell reads instead of
// the raw profile.
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const { presentSections, isEmptyProfile } = mod("views/app");
const { bindTooltip } = mod("core/tooltip");

const SECTIONS = {
  "ml-training": "overview,code,stacks,timeline,memory",
  "async-server": "overview,code,stacks,timeline,memory",
  "cpu-only": "overview,code,stacks,timeline",
  neuron: "overview,code,memory",
  basic: "overview,code,memory",
  example: "overview,code,memory",
  huge: "overview,code,stacks,timeline,memory",
};
for (const [name, ids] of Object.entries(SECTIONS)) {
  withModel(name, `sections present: ${ids}`, (m) => assert.equal(presentSections(m).join(","), ids));
}

test("empty-state inputs: \"\", null, non-objects, {}, missing or empty files", () => {
  for (const p of ["", null, undefined, 42, "text", [], {}, { files: {} }, { files: null }, { files: [] }, { program: "x.py" }]) {
    assert.equal(isEmptyProfile(p), true, JSON.stringify(p));
  }
  assert.equal(isEmptyProfile({ files: { "a.py": { lines: [] } } }), false);
});

withModel("ml-training", "stack depth (Appendix A: depth 19) and entrypoint dir come from the model", (m) => {
  assert.equal(m.stackDepth.cpu, 19);
  assert.ok(m.stackDepth.memory > 0);
  assert.equal(typeof m.entrypointDir, "string");
  assert.ok(m.entrypointDir.length > 0);
});

withModel("neuron", "no stacks → stack depth 0", (m) => {
  assert.equal(m.stackDepth.cpu, 0);
});

/** Element stand-in with listeners and :focus-visible matching. */
function fakeControl() {
  const listeners = new Map();
  return {
    focusVisible: true,
    addEventListener: (t, fn) => listeners.set(t, (listeners.get(t) ?? new Set()).add(fn)),
    removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
    matches(sel) {
      return sel === ":focus-visible" && this.focusVisible;
    },
    fire(t, ev = {}) {
      for (const fn of Array.from(listeners.get(t) ?? [])) fn(ev);
    },
    count: () => Array.from(listeners.values()).reduce((a, s) => a + s.size, 0),
  };
}

function fakeTooltip() {
  const log = [];
  return { log, show: (at, c, o) => log.push(["show", c.title, o.delay, o.describe === at]), move() {}, hide: () => log.push(["hide"]) };
}

test("bindTooltip: 300\u00a0ms hover intent, instant on keyboard focus, closes on leave/Esc, disposer unbinds", () => {
  const t = fakeTooltip();
  const el = fakeControl();
  const off = bindTooltip(t, el, () => ({ title: "Load a profile" }));
  el.fire("pointerenter");
  el.fire("pointerleave");
  el.fire("focus");
  el.fire("keydown", { key: "Escape" });
  el.focusVisible = false;
  el.fire("focus"); // mouse focus: no tooltip
  el.fire("blur"); // nothing open → no extra hide
  assert.deepEqual(t.log, [
    ["show", "Load a profile", 300, true],
    ["hide"],
    ["show", "Load a profile", 0, true],
    ["hide"],
  ]);
  off();
  assert.equal(el.count(), 0);
});

test("bindTooltip: a null content function shows nothing", () => {
  const t = fakeTooltip();
  const el = fakeControl();
  bindTooltip(t, el, () => null);
  el.fire("pointerenter");
  el.fire("pointerleave");
  assert.deepEqual(t.log, []);
});

test("runIntro: the instant path (reduced motion / ?still) runs every step's final state in time order", () => {
  const { runIntro } = mod("core/motion");
  const ran = [];
  const plan = [300, 0, 120].map((at) => ({ at, run: (immediate) => ran.push([at, immediate]) }));
  runIntro(plan, true).cancel();
  assert.deepEqual(ran, [[0, true], [120, true], [300, true]]);
});
