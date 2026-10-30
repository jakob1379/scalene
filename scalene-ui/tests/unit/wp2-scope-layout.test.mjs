// WP2 (DESIGN.md §4.4.1–4.4.3, §4.4.7): scope channel geometry per breakpoint, PHASE cell
// partition (must-fix 2), count ticks, and the annotation self-check used by debugLayout().
import assert from "node:assert/strict";
import { mod, test, withModel } from "./_harness.mjs";

const L = mod("views/overview/scope-layout");
const { checkAnnotations } = mod("views/overview/scope");

const ML = { phase: true, memory: true, threads: true, tasks: false, topRows: 5 };

function noOverlap(channels) {
  for (let i = 1; i < channels.length; i++) {
    const a = channels[i - 1].rect;
    const b = channels[i].rect;
    assert.ok(b.y >= a.y + a.h, `${channels[i].id} starts below ${channels[i - 1].id}`);
  }
}

test("metrics: gutters and heights per breakpoint (§4.4.1–4.4.2)", () => {
  const lg = L.scopeMetrics("lg", false, false);
  assert.equal(lg.gutterL, 104);
  assert.equal(lg.gutterR, 52);
  assert.equal(lg.phaseH, 18);
  assert.equal(lg.threadsH, 40);
  assert.equal(lg.topRowH, 12);
  const xxl = L.scopeMetrics("xxl", false, false);
  assert.deepEqual([xxl.gutterL, xxl.phaseH, xxl.threadsH, xxl.topRowH], [120, 20, 52, 14]);
  const md = L.scopeMetrics("md", false, true);
  assert.deepEqual([md.gutterL, md.threadsH, md.topRowH, md.target], [96, 32, 10, 220]);
  assert.equal(L.scopeMetrics("sm", false, true).gutterL, 88);
  const xs = L.scopeMetrics("xs", false, true);
  assert.deepEqual([xs.gutterL, xs.gutterR, xs.labelRow, xs.threadsH, xs.target], [0, 0, 14, 36, 236]);
  const short = L.scopeMetrics("sm", true, false);
  assert.equal(short.threadsH, 48);
  assert.equal(short.target, 200);
  assert.equal(L.scopeMetrics("sm", true, true).target, 150);
});

test("short hosts drop PHASE and TOP LINES", () => {
  const m = L.scopeMetrics("sm", true, false);
  assert.deepEqual(L.effectivePresence(ML, m), { ...ML, phase: false, topRows: 0 });
  assert.deepEqual(L.effectivePresence(ML, L.scopeMetrics("lg", false, false)), ML);
});

test("layout: channel order, 8 px gaps, rug under memory, memory takes the free height", () => {
  const m = L.scopeMetrics("lg", false, false);
  const g = L.layoutChannels(747, 330, ML, m);
  assert.deepEqual(g.channels.map((c) => c.id), ["phase", "memory", "rug", "threads", "top"]);
  noOverlap(g.channels);
  const by = Object.fromEntries(g.channels.map((c) => [c.id, c.rect]));
  assert.equal(by.phase.h, 18);
  assert.equal(by.memory.y - (by.phase.y + by.phase.h), 8);
  assert.equal(by.rug.y - (by.memory.y + by.memory.h), 2);
  assert.equal(by.rug.h, 6);
  assert.equal(by.threads.h, 40);
  assert.equal(by.top.h, 60);
  assert.ok(by.memory.h >= 72);
  assert.equal(g.plot.x, 104);
  assert.equal(g.plot.w, 747 - 104 - 52);
  // everything (plot + axis) fits the canvas exactly
  assert.ok(Math.abs(g.axis.y + g.axis.h - 330) <= 1, `axis bottom ${g.axis.y + g.axis.h}`);
  for (const c of g.channels) {
    assert.equal(c.rect.x, g.plot.x);
    assert.equal(c.rect.w, g.plot.w);
  }
  assert.equal(L.requiredHeight(ML, m), 330 - (by.memory.h - 72));
});

test("layout: canvas height = max(required, target or available)", () => {
  const m = L.scopeMetrics("md", false, true);
  const req = L.requiredHeight(ML, m);
  assert.equal(L.canvasHeight(ML, m, null), Math.max(req, 220));
  assert.equal(L.canvasHeight(ML, m, 1000), 1000);
  assert.equal(L.canvasHeight(ML, m, 10), req);
});

test("layout xs: a 14 px label row above every labelled channel, no gutters", () => {
  const m = L.scopeMetrics("xs", false, true);
  const g = L.layoutChannels(358, L.canvasHeight(ML, m, null), ML, m);
  for (const c of g.channels) {
    if (c.id === "rug") assert.equal(c.labelRow, null);
    else {
      assert.ok(c.labelRow, `${c.id} has a label row`);
      assert.equal(c.labelRow.h, 14);
      assert.equal(c.rect.y, c.labelRow.y + 14);
    }
  }
  assert.equal(g.plot.x, 0);
  assert.equal(g.plot.w, 358);
});

test("layout: CPU-only (PHASE + TOP LINES) spreads the rows (pitch ≤ 32 px), strips stay ≤ 20 px", () => {
  const p = { phase: true, memory: false, threads: false, tasks: false, topRows: 5 };
  const m = L.scopeMetrics("lg", false, false);
  const top = (h) => L.layoutChannels(700, h, p, m).channels.find((c) => c.id === "top").rect.h;
  assert.equal(top(L.requiredHeight(p, m)), 60);
  assert.ok(top(200) > 60 && top(200) <= 5 * L.TOP_ROW_MAX);
  assert.equal(top(2000), 5 * L.TOP_ROW_MAX);
  assert.equal(L.TOP_ROW_MAX, 32);
  // Review round 1: never 48 px barcodes; the strip itself is at most 20 px tall.
  for (const pitch of [10, 12, 14, 20, 32, 48]) assert.ok(L.topBarHeight(pitch) <= Math.min(20, pitch - 2) + 1e-9, `bar at pitch ${pitch}`);
  assert.equal(L.topBarHeight(32), 20);
  assert.equal(L.topBarHeight(12), 10);
});

test("layout: without MEMORY, THREADS (or TASKS) takes the free height", () => {
  const m = L.scopeMetrics("lg", false, false);
  const p = { phase: false, memory: false, threads: true, tasks: true, topRows: 0 };
  const g = L.layoutChannels(700, 300, p, m);
  const th = g.channels.find((c) => c.id === "threads").rect.h;
  assert.ok(th > 40);
  assert.equal(g.channels.find((c) => c.id === "tasks").rect.h, 40);
  assert.equal(L.anyChannel({ phase: false, memory: false, threads: false, tasks: false, topRows: 0 }), false);
});

// ── PHASE cells ─────────────────────────────────────────────────────────────

const ph = (key, t0, t1) => ({ key, label: `phase ${key}`, t0, t1 });
const px = (t) => t; // 1\u00a0s = 1 px

test("phase cells: ≥ 64 px labelled, 12–63 px hatched, never an unlabelled empty box", () => {
  const cells = L.layoutPhaseCells([ph("a", 0, 100), ph("b", 100, 130)], px);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].kind, "label");
  assert.equal(cells[0].label, "phase a");
  assert.equal(cells[1].kind, "short");
  assert.equal(cells[1].label, null);
});

test("phase cells: tiny cells merge into a group; ≥ 64 px groups are labelled 'N short phases'", () => {
  const tiny = Array.from({ length: 10 }, (_, i) => ph(`t${i}`, i * 8, i * 8 + 7));
  const cells = L.layoutPhaseCells(tiny, px);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].kind, "group");
  assert.equal(cells[0].members.length, 10);
  assert.equal(cells[0].label, "10 short phases");
  const small = L.layoutPhaseCells(tiny.slice(0, 3), px);
  assert.equal(small[0].kind, "group");
  assert.equal(small[0].label, null, "a 23 px group is hatched, not labelled");
});

test("phase cells: tiny cells never merge across empty time (time without samples stays empty)", () => {
  const cells = L.layoutPhaseCells([ph("a", 0, 5), ph("b", 200, 205)], px);
  assert.equal(cells.length, 2);
  assert.ok(cells.every((c) => c.kind === "short"));
});

test("phase cells: 2 px gaps between touching cells, extents never overlap", () => {
  const cells = L.layoutPhaseCells([ph("a", 0, 100), ph("b", 100, 200), ph("c", 200, 300)], px);
  assert.equal(cells[0].x, 0);
  assert.equal(cells[0].w, 99);
  assert.equal(cells[1].x, 101);
  assert.equal(cells[1].w, 98);
  assert.equal(cells[2].x, 201);
  for (let i = 1; i < cells.length; i++) assert.ok(cells[i].x >= cells[i - 1].x + cells[i - 1].w + 2 - 1e-9);
  assert.equal(L.phaseCellAt(cells, 150), 1);
  assert.equal(L.phaseCellAt(cells, 350), -1);
});

withModel("ml-training", "phase cells on the real timeline (600 px plot): ordered, disjoint, kinds by width", async (m) => {
  const tl = await m.timeline();
  for (const w of [320, 600, 1200]) {
    const x = (t) => (t / m.tMax) * w;
    const cells = L.layoutPhaseCells(tl.phases, x);
    assert.ok(cells.length > 0);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      assert.ok(c.w >= 1);
      if (c.kind === "label") assert.ok(c.x1 - c.x0 >= 64 && c.label);
      if (c.kind === "short") assert.ok(c.x1 - c.x0 < 64 && c.label === null);
      if (i > 0) assert.ok(c.x >= cells[i - 1].x + cells[i - 1].w, "cells do not overlap");
    }
    const members = cells.reduce((a, c) => a + c.members.length, 0);
    assert.equal(members, tl.phases.length, "every phase is in exactly one cell");
  }
  // The training loop dominates and is labelled at any desktop width.
  const big = L.layoutPhaseCells(tl.phases, (t) => (t / m.tMax) * 600).find((c) => c.kind === "label" && /for step in/.test(c.label));
  assert.ok(big, "the training loop phase is a labelled cell");
});

test("count ticks: 0 and ceil(max), plus a middle tick when max ≥ 4", () => {
  assert.deepEqual(L.countTicks(0), [0, 1]);
  assert.deepEqual(L.countTicks(2.3), [0, 3]);
  assert.deepEqual(L.countTicks(3), [0, 3]);
  assert.deepEqual(L.countTicks(4.2), [0, 3, 5]);
  assert.deepEqual(L.countTicks(22), [0, 11, 22]);
  assert.equal(L.bucketCount(600), 300);
  assert.equal(L.bucketCount(4), 8);
});

test("annotation check: flags overlaps and escapes, accepts touching rects", () => {
  const bounds = { x: 0, y: 0, w: 100, h: 50 };
  const ok = [
    { kind: "ytick", rect: { x: 0, y: 0, w: 20, h: 10 }, bounds },
    { kind: "ytick", rect: { x: 0, y: 10, w: 20, h: 10 }, bounds },
  ];
  assert.deepEqual(checkAnnotations(ok), []);
  const bad = [...ok, { kind: "callout", rect: { x: 10, y: 5, w: 30, h: 10 }, bounds }, { kind: "chip", rect: { x: 90, y: 45, w: 20, h: 10 }, bounds }];
  const errors = checkAnnotations(bad);
  assert.ok(errors.some((e) => e.includes("overlaps")));
  assert.ok(errors.some((e) => e.includes("leaves its bounds")));
});
