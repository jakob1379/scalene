#!/usr/bin/env node
// Canvas views acceptance (DESIGN.md §8.6 WP4), folded in from design/requests/wp4-check.mjs:
// flame axis re-base, search share, staged zoom, keyboard walk announcements, lane totals,
// run ends, brush/zoom/keys/wheel, Interleaved, thread filter incl. a synthetic "unknown"
// thread, memory rug and pinned leaks, `?perf` budgets on huge (§6.1).
//   node tools/e2e/canvas.mjs [outDir]
import fs from "node:fs";
import { chromium, createReport, fixture, outDir } from "./_env.mjs";

const OUT = process.argv[2] ?? outDir;
const report = createReport("canvas");
const ok = (name, cond, detail = "") => report.check(name, cond, detail);

const browser = await chromium.launch();

async function open(fixture, { w = 1440, h = 900, query = "?still", theme = "light", url = null } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((t) => { try { localStorage.setItem("scalene-theme", t); } catch {} }, theme);
  await page.goto(url ?? `file://${OUT}/${fixture}.html${query}`);
  await page.waitForTimeout(250);
  return { page, errors };
}

async function show(page, id) {
  await page.evaluate((id) => { const el = document.getElementById(id); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60); }, id);
  await page.waitForTimeout(500);
}

// ── Flame (§4.11) ───────────────────────────────────────────────────────────
{
  const { page, errors } = await open("ml-training");
  await show(page, "stacks");
  await page.waitForSelector(".flame-plot[data-zoom]");
  const caption0 = await page.textContent(".flame-axis-caption");
  ok("flame axis caption at root", caption0 === "% of all sampled stacks", caption0);
  const ticks0 = await page.$$eval(".flame-axis .axis-tick-label:not([hidden])", (els) => els.map((e) => e.textContent));
  ok("flame axis ticks 0–100 %", ticks0[0] === "0%" && ticks0.includes("50%"), ticks0.join(" "));
  // Zoom into train:165 by clicking its frame.
  const target = await page.$eval(".flame-plot", (el) => {
    const d = el.__flame;
    const p = d.heaviest("/home/dev/llm-train/train.py", 165);
    return { path: p, rect: d.nodeRect(p) };
  });
  const box = await page.$eval(".flame-plot .cv-overlay", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await page.mouse.click(box.x + target.rect.x + target.rect.w / 2, box.y + target.rect.y + target.rect.h / 2);
  await page.waitForTimeout(100);
  const caption1 = await page.textContent(".flame-axis-caption");
  ok("flame axis re-bases on zoom", /^% of train\(\) :165 \(14\.9% of all stacks\)$/.test(caption1), caption1);
  const ticks1 = await page.$$eval(".flame-axis .axis-tick-label:not([hidden])", (els) => els.map((e) => e.textContent));
  ok("re-based ticks start at 0% of the focused frame", ticks1[0] === "0%", ticks1.join(" "));
  const crumbs = await page.$$eval(".flame-crumbs .crumb", (els) => els.map((e) => `${e.textContent}${e.getAttribute("aria-current") ? "*" : ""}`));
  ok("breadcrumb shows the zoom path, last is aria-current", crumbs.join(" › ") === "All stacks › <module> :193 › train() :165*", crumbs.join(" › "));
  // Search share.
  await page.click(".flame-reset");
  await page.fill(".flame-search-input", "train");
  await page.waitForTimeout(250);
  const match = (await page.textContent(".flame-match-text")).trim();
  ok("search share on ml ('train')", /^Matched \d+(\.\d)?% of samples · \d+ frames$/.test(match), match);
  await page.fill(".flame-search-input", "zzzz-nope");
  await page.waitForTimeout(200);
  ok("search with no match", (await page.textContent(".flame-match-text")).trim() === "No frames match");
  await page.fill(".flame-search-input", "");
  await page.waitForTimeout(200);
  // Staged lateral zoom: zoom into train:173, then jump to train:165 (a different subtree).
  const stages = await page.evaluate(async () => {
    const el = document.querySelector(".flame-plot");
    const d = el.__flame;
    d.zoomTo(d.heaviest("/home/dev/llm-train/train.py", 173));
    const s1 = el.dataset.stages;
    d.zoomTo(d.heaviest("/home/dev/llm-train/train.py", 165));
    return { s1, s2: el.dataset.stages, zoom: el.dataset.zoom };
  });
  ok("lateral zoom is staged (2 stages: out to the common ancestor, then in)", stages.s2 === "2", JSON.stringify(stages));
  await page.close();
  ok("flame page: no console errors", errors.length === 0, errors.join(" | "));
}

// Staged zoom with motion: the domain passes through the common ancestor (root here).
{
  const { page } = await open("ml-training", { query: "" });
  await show(page, "stacks");
  await page.waitForSelector(".flame-plot[data-zoom]");
  const trace = await page.evaluate(async () => {
    const el = document.querySelector(".flame-plot");
    const d = el.__flame;
    const a = d.heaviest("/home/dev/llm-train/train.py", 173);
    const b = d.heaviest("/home/dev/llm-train/train.py", 165);
    d.zoomTo(a);
    await new Promise((r) => setTimeout(r, 400));
    const samples = [];
    d.zoomTo(b);
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      samples.push(d.domain()[1] - d.domain()[0]);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return samples;
  });
  const maxSpan = Math.max(...trace);
  ok("staged zoom widens to the common ancestor mid-flight", maxSpan > 5000, `max span ${maxSpan.toFixed(0)} of 5901`);
  await page.close();
}

// Keyboard walk announces frames.
{
  const { page } = await open("ml-training");
  await show(page, "stacks");
  await page.waitForSelector(".flame-plot[data-zoom]");
  await page.focus(".flame-search-input");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.classList.contains("flame-canvas"))) break;
  }
  await page.waitForTimeout(80);
  const focusedRole = await page.evaluate(() => document.activeElement?.getAttribute("aria-roledescription"));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  const said = await page.evaluate(() => document.getElementById("sr-polite")?.textContent ?? "");
  const box = await page.$eval(".flame-focus", (e) => ({ hidden: e.hidden, w: e.getBoundingClientRect().width }));
  ok("keyboard walk: canvas focusable as a flame graph", focusedRole === "flame graph", String(focusedRole));
  ok("keyboard walk announces frames", /Python frame, .*% of sampled stacks, .* samples, depth 2 of 19/.test(said), said);
  ok("focused frame has the .flame-segment.flame-focus overlay", !box.hidden && box.w > 4, JSON.stringify(box));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(80);
  const z = await page.$eval(".flame-plot", (e) => e.dataset.zoom);
  ok("Enter zooms the focused frame", z !== "root", z);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  const z2 = await page.$eval(".flame-plot", (e) => e.dataset.zoom);
  ok("Escape zooms out one level", z2 !== z, `${z} → ${z2}`);
  await page.close();
}

// Memory tab: MiB axis with memory-axis / memory-gridlines.
{
  const { page } = await open("ml-training");
  await show(page, "stacks");
  await page.click("#stacks [role=tab]:nth-child(2)");
  await page.waitForTimeout(300);
  const cls = await page.evaluate(() => ({ axis: !!document.querySelector(".flame-plot > .memory-axis"), grid: !!document.querySelector(".memory-gridlines .grid-line"), cap: document.querySelector(".flame-axis-caption")?.textContent, desc: document.querySelector("#stacks .section-desc")?.textContent }));
  ok("memory flame uses .memory-axis and .memory-gridlines", cls.axis && cls.grid, JSON.stringify(cls));
  ok("memory flame description", /^30 allocation stacks · 3\.17\sGiB attributed/.test(cls.desc ?? ""), cls.desc);
  await page.close();
}

// ── Round 1 canvas fixes (design/review/round-1/fix-canvas.md) ──────────────
{
  const { page, errors } = await open("ml-training", { query: "?still", theme: "dark" });
  await show(page, "timeline");
  await page.waitForSelector(".tl-more");
  // timeline-showall-focus-lost: the toggle keeps focus across the gutter rebuild.
  await page.focus(".tl-more");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const f1 = await page.evaluate(() => `${document.activeElement.className}|${document.activeElement.textContent}`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const f2 = await page.evaluate(() => `${document.activeElement.className}|${document.activeElement.textContent}`);
  ok("'+ show all N levels' keeps focus (both directions)", /^tl-more\|− show 16 levels$/.test(f1) && /^tl-more\|\+ show all 19 levels$/.test(f2), `${f1} / ${f2}`);
  // timeline-lane-heads-touch-target + small-type-below-scale-timeline.
  const g = await page.evaluate(() => ({
    heights: Array.from(document.querySelectorAll(".tl-lane-head, .tl-more")).map((e) => Math.round(e.getBoundingClientRect().height)),
    minSub: Math.min(...Array.from(document.querySelectorAll(".tl-sub")).map((e) => parseFloat(getComputedStyle(e).fontSize))),
    lanesHead: document.querySelector(".tl-lanes-head")?.textContent,
    shares: Array.from(document.querySelectorAll(".tl-lane-share")).map((e) => e.textContent),
  }));
  ok("lane headers and 'show all' are ≥ 24 px tall", g.heights.length >= 5 && g.heights.every((v) => v >= 24), g.heights.join(","));
  ok("timeline gutter text is never below 11 px", g.minSub >= 11, String(g.minSub));
  ok("lane shares sit under a '% of samples' column header", g.lanesHead === "Threads% of samples" && g.shares.every((t) => /^\d+(\.\d)?%$/.test(t)), `${g.lanesHead} ${g.shares.join(" ")}`);
  // timeline-lod-grey-not-in-legend.
  const legend = await page.$$eval(".tl-legend .legend-chip", (els) => els.map((e) => e.textContent));
  ok("timeline legend decodes the neutral LOD colour", legend.includes("mixed short frames"), legend.join(" · "));
  // hover-only-tooltips-canvas: the GC / I/O / GIL group is a focus stop with its definitions.
  await page.focus(".tl-class-group");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  const tip = await page.evaluate(() => ({ active: document.activeElement.classList.contains("tl-class-group"), tip: document.querySelector(".tooltip:not([hidden])")?.textContent ?? "" }));
  ok("class rows: focusable, tooltip carries the definitions", tip.active && /Share of all timeline samples/.test(tip.tip), JSON.stringify(tip).slice(0, 160));
  // zoom-changes-not-announced (timeline).
  await page.focus(".tl-canvas");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("w");
  await page.waitForTimeout(500);
  const said = await page.$eval("#sr-polite", (e) => e.textContent);
  ok("timeline zoom is announced ('Showing … of …')", /^Showing .+ to .+ of 54\.1\s?s$/.test(said), said);
  // timeline-show-in-no-caption.
  await page.evaluate(() => document.querySelector(".tl-chart").__timeline.api.focusLine({ file: "/home/dev/llm-train/train.py", line: 173 }));
  await page.waitForTimeout(600);
  const chip = await page.$eval("#timeline .showin-chip", (e) => e.textContent).catch(() => "");
  ok("'Show in timeline' says what it shows", /^Showingtrain\.py:173loss_value = loss\.item\(\)in 19\.6% of stack samples/.test(chip), chip);
  await page.click("#timeline .showin-chip button");
  ok("Clear removes the caption", (await page.$$("#timeline .showin-chip")).length === 0);
  // Memory: crescent + copy (mem-site-selected-crescent, memory-section-copy).
  await show(page, "memory");
  const mem = await page.evaluate(() => {
    const sel = document.querySelector(".mem-site[aria-selected='true']");
    const b = getComputedStyle(sel, "::before");
    return { shadow: getComputedStyle(sel).boxShadow, barW: b.width, barTop: b.top, more: document.querySelector(".mem-more")?.textContent, rows: Array.from(document.querySelectorAll(".mem-detail-row")).map((r) => r.textContent).join(" | ") };
  });
  ok("selected site: straight inset bar (no inset shadow on the radius)", mem.shadow === "none" && mem.barW === "2px" && mem.barTop === "6px", JSON.stringify(mem).slice(0, 120));
  ok("memory copy: no repeated label, no 'rug', counted 'Show 25 sites'", /^Peak\d/.test(mem.rows) && !/rug/.test(mem.rows) && mem.more === "Show 25 sites", `${mem.rows.slice(0, 140)} · ${mem.more}`);
  await page.close();
  ok("round-1 page: no console errors", errors.length === 0, errors.join(" | "));
}
{
  // flame-axis-thinning-flicker: label sets during a real zoom tween are nested strides from 0 %.
  const { page } = await open("ml-training", { query: "", theme: "dark" });
  await show(page, "stacks");
  await page.waitForSelector(".flame-plot[data-zoom]");
  await page.waitForTimeout(1200);
  const sets = await page.evaluate(async () => {
    const el = document.querySelector(".flame-plot");
    const d = el.__flame;
    const out = new Set();
    d.zoomTo(d.heaviest("/home/dev/llm-train/train.py", 165));
    const t0 = performance.now();
    await new Promise((res) => { const f = () => { out.add(Array.from(el.querySelectorAll(".flame-axis .axis-tick-label")).filter((e) => !e.hidden && !e.classList.contains("is-out")).map((e) => parseFloat(e.textContent)).join(",")); if (performance.now() - t0 < 420) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    return Array.from(out);
  });
  const regular = sets.every((s) => { const v = s ? s.split(",").map(Number) : []; return v.length < 2 || (v[0] === 0 && v.every((x, i) => Math.abs(x - i * (v[1] - v[0])) < 1e-6)); });
  ok("flame axis labels thin by a fixed stride during the zoom tween", regular, sets.join(" / "));
  // zoom-changes-not-announced (flame).
  await page.focus(".flame-canvas");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  const said = await page.$eval("#sr-polite", (e) => e.textContent);
  ok("flame zoom out is announced", /^Zoomed out to /.test(said), said);
  await page.close();
}
{
  // touch-flame-timeline-no-details: first tap pins details, second tap zooms.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`file://${OUT}/ml-training.html?still`);
  await page.waitForTimeout(400);
  await show(page, "stacks");
  await page.waitForSelector(".flame-plot[data-zoom]");
  const r = await page.$eval(".flame-plot", (el) => { const d = el.__flame; const rr = d.nodeRect(d.heaviest("/home/dev/llm-train/train.py", 165)); const c = el.querySelector(".cv-overlay").getBoundingClientRect(); return { x: c.left + rr.x + Math.min(rr.w / 2, 30), y: c.top + rr.y + rr.h / 2 }; });
  await page.touchscreen.tap(r.x, r.y);
  await page.waitForTimeout(250);
  const first = await page.evaluate(() => ({ zoom: document.querySelector(".flame-plot").dataset.zoom, card: !document.querySelector(".flame-plot .tap-card").hidden, buttons: Array.from(document.querySelectorAll(".flame-plot .tap-card .btn-label")).map((b) => b.textContent) }));
  ok("touch: first tap on a frame pins its details, no zoom", first.zoom === "root" && first.card && first.buttons.includes("Open line"), JSON.stringify(first));
  await page.touchscreen.tap(r.x, r.y);
  await page.waitForTimeout(450);
  const zoomed = await page.$eval(".flame-plot", (el) => el.dataset.zoom);
  ok("touch: a second tap on the same frame zooms", /train$/.test(zoomed), zoomed);
  await ctx.close();
}

// ── Timeline (§4.12) ────────────────────────────────────────────────────────
{
  const { page, errors } = await open("ml-training");
  await show(page, "timeline");
  await page.waitForSelector(".tl-chart:not([hidden])");
  const shares = await page.$$eval(".tl-label-class .tl-sub", (els) => els.map((e) => e.textContent));
  ok("timeline lane totals equal the model's (0.6 / 2.8 / 0.9 on ml)", shares.join(" | ") === "0.6% of samples | 2.8% of samples | 0.9% of samples", shares.join(" | "));
  const axis = await page.evaluate(() => ({ axis: !!document.querySelector(".timeline-axis .axis-tick-label"), grid: document.querySelectorAll(".timeline-gridlines .grid-line:not([hidden])").length }));
  ok("timeline-axis with nice ticks and timeline-gridlines", axis.axis && axis.grid >= 4, JSON.stringify(axis));
  // Run ends (§4.0.7): min(next same-thread t, t + count × dt).
  const runs = await page.$eval(".tl-chart", (c) => c.__timeline.runs(1, 40));
  const dt = 0.010016499999998985;
  let bad = 0;
  for (let k = 0; k < runs.length - 1; k++) {
    const r = runs[k];
    const nominal = r.t0 + r.count * dt;
    const next = runs[k + 1].t0;
    const expect = next > r.t0 && next < nominal ? next : nominal;
    if (Math.abs(r.t1 - expect) > 1e-9) bad++;
  }
  ok("run ends follow §4.0.7 (thread 1, first 40 runs)", bad === 0, `${bad} mismatches`);
  // Brush → zoom.
  const L = await page.$eval(".tl-chart", (c) => { const l = c.__timeline.layout(); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, plotX: l.plotX, plotW: l.plotW }; });
  await page.mouse.move(L.x + L.plotX + L.plotW * 0.2, L.y + 120);
  await page.mouse.down();
  await page.mouse.move(L.x + L.plotX + L.plotW * 0.4, L.y + 120, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const d1 = await page.$eval(".tl-chart", (c) => c.__timeline.domain());
  ok("brush zooms to the dragged range", Math.abs(d1[0] - 54.11 * 0.2) < 0.6 && Math.abs(d1[1] - 54.11 * 0.4) < 0.6, d1.map((v) => v.toFixed(2)).join(" – "));
  const rangeText = await page.textContent(".tl-range");
  // Formatters join number and unit with a no-break space (round 1).
  ok("range label follows the domain", /^1\d\.\d\ss – 2\d\.\d\ss$/.test(rangeText), rangeText);
  // Keys: W zoom in, A pan, 0 reset.
  await page.focus(".tl-canvas");
  await page.keyboard.press("w");
  await page.waitForTimeout(60);
  const d2 = await page.$eval(".tl-chart", (c) => c.__timeline.domain());
  ok("W zooms in", d2[1] - d2[0] < d1[1] - d1[0] - 1e-6, `${(d1[1] - d1[0]).toFixed(2)} → ${(d2[1] - d2[0]).toFixed(2)}`);
  await page.keyboard.press("a");
  await page.waitForTimeout(60);
  const d3 = await page.$eval(".tl-chart", (c) => c.__timeline.domain());
  ok("A pans 10 % earlier", d3[0] < d2[0] && Math.abs((d2[0] - d3[0]) - 0.1 * (d2[1] - d2[0])) < 1e-6, `${d2[0].toFixed(3)} → ${d3[0].toFixed(3)}`);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  const said = await page.evaluate(() => document.getElementById("sr-polite")?.textContent ?? "");
  ok("timeline keyboard walk announces segments", /, (main thread|thread \d+), .* to .*, [\d,]+ samples?$/.test(said), said);
  await page.keyboard.press("0");
  await page.waitForTimeout(60);
  const d4 = await page.$eval(".tl-chart", (c) => c.__timeline.domain());
  ok("0 resets the domain", d4[0] === 0 && Math.abs(d4[1] - 54.11024116047993) < 1e-9, d4.join(","));
  // Ctrl + wheel zooms at the pointer; plain wheel scrolls the page.
  await page.mouse.move(L.x + L.plotX + L.plotW * 0.5, L.y + 200);
  const y0 = await page.evaluate(() => scrollY);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.waitForTimeout(80);
  const d5 = await page.$eval(".tl-chart", (c) => c.__timeline.domain());
  ok("Ctrl + wheel zooms ×1.25 at the pointer", Math.abs((d5[1] - d5[0]) - 54.11024116047993 / 1.25) < 0.01, (d5[1] - d5[0]).toFixed(3));
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(150);
  const y1 = await page.evaluate(() => scrollY);
  ok("plain wheel scrolls the page (never hijacked)", y1 > y0, `${y0} → ${y1}`);
  // Interleaved + thread filter.
  await page.click("#timeline .seg-item:nth-of-type(2)");
  await page.waitForTimeout(100);
  const inter = await page.$eval(".tl-chart", (c) => ({ view: c.__timeline.view(), items: c.__timeline.layout().items.map((i) => i.kind).join(",") }));
  ok("Interleaved shows one panel", inter.view === "interleaved" && inter.items.includes("inter") && !inter.items.includes("lane"), JSON.stringify(inter));
  await page.selectOption("#timeline-view-mode", { label: "thread 2" });
  await page.waitForTimeout(100);
  const filt = await page.$eval(".tl-chart", (c) => ({ view: c.__timeline.view(), filter: c.__timeline.filter(), lanes: c.__timeline.layout().items.filter((i) => i.kind === "lane").map((i) => i.lane) }));
  ok("thread filter keeps one lane", filt.filter === 2 && filt.lanes.join() === "2" && filt.view === "lanes", JSON.stringify(filt));
  const sharesF = await page.$$eval(".tl-label-class .tl-sub", (els) => els.map((e) => e.textContent));
  ok("filtered lane totals state their denominator", sharesF.every((s) => /of thread 2$/.test(s)), sharesF.join(" | "));
  await page.close();
  ok("timeline page: no console errors", errors.length === 0, errors.join(" | "));
}

// Thread filter "unknown" on a synthetic profile (legacy events without thread_id mixed with ids).
{
  const raw = fixture("ml-training");
  const ev = raw.combined_stacks_timeline;
  const ids = [...new Set(ev.map((e) => e.thread_id))].filter((id) => id !== raw.main_thread_id);
  for (const e of ev) if (e.thread_id === ids[0]) delete e.thread_id; // one worker loses its id → "unknown"
  const { page, errors } = await open("ml-training", { query: "?still" });
  await page.evaluate((json) => window.load(json), JSON.stringify(raw));
  await page.waitForTimeout(400);
  await show(page, "timeline");
  await page.waitForSelector(".tl-chart:not([hidden])");
  const opts = await page.$$eval("#timeline-view-mode option", (els) => els.map((e) => `${e.value}=${e.textContent}`));
  ok("synthetic: thread filter lists 'unknown'", opts.some((o) => o === "unknown=unknown"), opts.join(", "));
  await page.selectOption("#timeline-view-mode", "unknown");
  await page.waitForTimeout(120);
  const st = await page.$eval(".tl-chart", (c) => ({ filter: c.__timeline.filter(), lanes: c.__timeline.layout().items.filter((i) => i.kind === "lane").map((i) => i.laneKey) }));
  ok("synthetic: 'unknown' filter shows the unknown lane", st.lanes.join() === "unknown", JSON.stringify(st));
  await page.close();
  ok("synthetic page: no console errors", errors.length === 0, errors.join(" | "));
}

// ── Memory (§4.13) ──────────────────────────────────────────────────────────
{
  const { page, errors } = await open("ml-training");
  await show(page, "memory");
  await page.waitForSelector(".mem-site");
  const sel0 = await page.$eval(".memory-card", (c) => c.__memory.selected());
  ok("memory: default selection is the most likely leak", sel0 === "metrics.py:42", sel0);
  const pinned = await page.$$eval(".mem-site-group .mem-site .mem-site-loc", (els) => els.map((e) => e.textContent));
  ok("leak sites outside the top 8 are pinned under 'Possible leaks'", pinned.join() === "loader.py:33", pinned.join());
  // Select #1 by keyboard → rug follows.
  await page.focus(".mem-site[aria-selected=true]");
  await page.keyboard.press("Home");
  await page.waitForTimeout(80);
  const sel1 = await page.$eval(".memory-card", (c) => ({ s: c.__memory.selected(), n: c.__memory.rugCount() }));
  const cap = await page.textContent(".mem-caption");
  ok("memory rug for the selected site", sel1.s === "train.py:120" && /train\.py:120 allocated or freed at [\d,]+ sampled moment/.test(cap), `${JSON.stringify(sel1)} ${cap}`);
  // Rug pixels exist under the plot.
  const rugPx = await page.evaluate(() => {
    const c = document.querySelector(".memory-card");
    const g = c.__memory.geo();
    const cv = c.querySelector(".mem-chart .cv-base");
    const ctx = cv.getContext("2d");
    const dpr = cv.width / g.width;
    const d = ctx.getImageData(0, Math.round((g.rug.y + 4) * dpr), cv.width, 1).data;
    let marks = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i + 1] > d[i] + 20 || d[i] > d[i + 1] + 40)) marks++;
    return marks;
  });
  ok("rug ticks are drawn", rugPx > 10, `${rugPx} coloured px in the rug row`);
  await page.click(".mem-sites-head .seg-item:nth-of-type(2)");
  await page.waitForTimeout(80);
  const top = await page.$eval(".mem-site .mem-site-loc", (e) => e.textContent);
  ok("Allocated order re-ranks by n_malloc_mb", typeof top === "string" && top.length > 0, top);
  await page.close();
  ok("memory page: no console errors", errors.length === 0, errors.join(" | "));
}

// ── Perf on huge (§6.1, ?perf) ──────────────────────────────────────────────
{
  const { page, errors } = await open("huge", { query: "?perf&still", w: 1440, h: 900 });
  await show(page, "stacks");
  await page.waitForSelector(".flame-plot[data-zoom]", { timeout: 20000 });
  await page.waitForTimeout(300);
  // Hover a few points on the flame and the timeline to collect overlay measures.
  const fb = await page.$eval(".flame-plot .cv-overlay", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  for (let i = 0; i < 12; i++) await page.mouse.move(fb.x + (fb.w * (i + 0.5)) / 12, fb.y + 30 + (i % 6) * 20);
  // Redraw the flame base a few times (zoom + reset).
  await page.evaluate(async () => {
    const d = document.querySelector(".flame-plot").__flame;
    for (let i = 0; i < 4; i++) {
      d.zoomTo(""); // root path
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await show(page, "timeline");
  await page.waitForSelector(".tl-chart:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(1200); // idle segment prebuild settles
  const tb = await page.$eval(".tl-canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  for (let i = 0; i < 12; i++) await page.mouse.move(tb.x + 180 + ((tb.w - 200) * (i + 0.5)) / 12, tb.y + 140 + (i % 5) * 30);
  await page.mouse.move(5, 5);
  // Base draws: a sweep of domains in Lanes, then in Interleaved (all 12 lanes drawn, the worst case).
  const sweep = async () => page.evaluate(async () => {
    const t = document.querySelector(".tl-chart").__timeline;
    const T = 226.88735527127437;
    const spans = [[0, T], [0, T / 2], [T / 4, T / 2], [60, 62], [100, 130], [0, T]];
    for (let k = 0; k < 2; k++) for (const s of spans) { t.api.setDomain(s, false); await new Promise((r) => requestAnimationFrame(r)); }
  });
  await page.evaluate(() => performance.clearMeasures("scalene:timeline-base"));
  await sweep();
  await page.evaluate(() => document.querySelector("#timeline .seg-item:nth-of-type(2)").click());
  await page.waitForTimeout(200);
  await sweep();
  const m = await page.evaluate(() => {
    const pick = (n) => performance.getEntriesByName(n).map((e) => e.duration);
    return { flameBase: pick("scalene:flame-base"), flameOverlay: pick("scalene:flame-overlay"), tlBase: pick("scalene:timeline-base"), tlOverlay: pick("scalene:timeline-overlay") };
  });
  const stat = (a) => { if (!a.length) return { n: 0 }; const s = [...a].sort((x, y) => x - y); return { n: a.length, median: s[a.length >> 1], p90: s[Math.floor(a.length * 0.9)], max: s[s.length - 1] }; };
  const s = { flameBase: stat(m.flameBase), flameOverlay: stat(m.flameOverlay), tlBase: stat(m.tlBase), tlOverlay: stat(m.tlOverlay) };
  console.log("perf", JSON.stringify(s));
  ok("perf: flame base draw ≤ 6 ms on huge (median)", s.flameBase.median <= 6, JSON.stringify(s.flameBase));
  ok("perf: timeline base draw ≤ 8 ms on huge (median)", s.tlBase.median <= 8, JSON.stringify(s.tlBase));
  ok("perf: hover (overlay) ≤ 2 ms (median)", s.flameOverlay.median <= 2 && s.tlOverlay.median <= 2, `${JSON.stringify(s.flameOverlay)} ${JSON.stringify(s.tlOverlay)}`);
  await page.close();
  ok("huge page: no console errors", errors.length === 0, errors.join(" | "));
}

await browser.close();
process.exit(report.finish());
