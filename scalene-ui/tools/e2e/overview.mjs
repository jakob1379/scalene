#!/usr/bin/env node
// Overview acceptance (DESIGN.md §8.6 WP2), folded in from design/screens/wp2/tools/check.mjs:
// first screens 1440×900 / 390×844 / 1000×400 (no load-time page scroll), golden headline and
// readouts (Appendix A), scope geometry (`debugLayout()`), cpu-only channels/findings, intro
// settles by 900 ms = `?still`, reduced motion = final frame at 40 ms, hotspots keyboard →
// focused code row, hover overlay ≤ 2 ms (`?perf`), theme toggle redraws the scope in place.
// Review round 1 adds: callout ∩ trace = ∅ and y labels off the data (geometry), width-independent
// THREADS (threads), short-host CPU-only scope (short), M8 re-rank overlap (m8), touch tap (touch),
// readout intro clock (introro), outline/aria (a11y), hidden-files action (hidden).
//   node tools/e2e/overview.mjs [--only first,golden,geometry,cpu,intro,reduced,keyboard,perf,theme,threads,short,m8,touch,introro,a11y,hidden]
import fs from "node:fs";
import path from "node:path";
import { chromium, createReport, onlyFilter, pageUrl, pngDiff, shotsDir } from "./_env.mjs";

const want = onlyFilter();
const shotDir = shotsDir("overview");
const url = (f, q = "") => pageUrl(f, q);
const report = createReport("overview");
const record = (name, ok, detail = "") => report.check(name, ok, detail);

const browser = await chromium.launch();
async function open(f, { w = 1440, h = 900, q = "still", theme = "light", reduced = false, wait = "load" } = {}) {
  const phone = w <= 390;
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, colorScheme: theme, reducedMotion: reduced ? "reduce" : "no-preference" });
  await context.addInitScript((t) => { try { localStorage.setItem("scalene-theme", t); } catch {} }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url(f, q), { waitUntil: wait });
  await page.waitForFunction(() => globalThis.__scaleneOverview && globalThis.__scaleneOverview.started, null, { timeout: 10000, polling: "raf" });
  return { page, context, errors };
}

const diff = (a, b) => pngDiff(browser, a, b);

function checkAnnotations(list) {
  const errors = [];
  const eps = 0.51;
  const shrink = (r) => ({ x: r.x + eps, y: r.y + eps, w: r.w - 2 * eps, h: r.h - 2 * eps });
  const inside = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const a of list) if (!inside(a.bounds, shrink(a.rect))) errors.push(`${a.kind} "${a.text ?? ""}" leaves bounds`);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (hit(shrink(list[i].rect), shrink(list[j].rect))) errors.push(`${list[i].kind} "${list[i].text ?? ""}" × ${list[j].kind} "${list[j].text ?? ""}"`);
  return errors;
}

// ── 1. First-screen rules (§1.3.1) ─────────────────────────────────────────
if (want("first")) {
  for (const [w, h] of [[1440, 900], [390, 844], [1000, 400]]) {
    const { page, context, errors } = await open("ml-training", { w, h });
    // requests/wp2.md R1 (fixed): mounting the code section must not scroll the window.
    await page.waitForTimeout(1500);
    const loadScroll = await page.evaluate(() => window.scrollY);
    record(`no load-time page scroll ${w}x${h}`, loadScroll === 0, `scrollY ${loadScroll} after 1.5 s`);
    const r = await page.evaluate((vh) => {
      const vis = (el) => !!el && el.getBoundingClientRect().top >= -0.5 && el.getBoundingClientRect().bottom <= vh + 0.5 && el.getBoundingClientRect().height > 0;
      const rows = Array.from(document.querySelectorAll("#overview .hs-row")).filter((x) => !x.hidden);
      const tiles = Array.from(document.querySelectorAll("#overview .ov-hero .ro-tile"));
      return {
        headline: vis(document.querySelector("#overview h1.headline")),
        time: vis(document.querySelector('#overview .ro-tile[data-kind="time"]')),
        tiles: tiles.length && tiles.every(vis),
        scope: vis(document.querySelector("#overview .scope-canvas")),
        rowsVisible: rows.filter(vis).length,
        rows: rows.length,
        overflow: document.documentElement.scrollWidth !== document.documentElement.clientWidth,
      };
    }, h);
    let ok, detail;
    if (w === 1440) { ok = r.headline && r.tiles && r.scope && r.rowsVisible === 8; detail = `headline ${r.headline}, readouts ${r.tiles}, signal ${r.scope}, hotspots ${r.rowsVisible}/8`; }
    else if (w === 390) { ok = r.headline && r.time && r.rowsVisible >= 3; detail = `headline ${r.headline}, time split ${r.time}, hotspots ${r.rowsVisible}/3`; }
    else { ok = r.headline && r.tiles && r.scope && r.rowsVisible >= 5; detail = `headline ${r.headline}, readouts ${r.tiles}, signal ${r.scope}, hotspots ${r.rowsVisible}/5`; }
    record(`first screen ${w}x${h}`, ok && !r.overflow && errors.length === 0, detail + (r.overflow ? " OVERFLOW" : "") + (errors.length ? ` errors: ${errors[0]}` : ""));
    await context.close();
  }
}

// ── 2. Golden headline + readouts (Appendix A) ─────────────────────────────
const GOLD = {
  "ml-training": {
    headline: "train.py ran for 54.1 s. Two lines in train() account for 37.6% of the time; memory peaked at 3.11 GiB.",
    // Review round 1: "growth 52.2%" reads as "memory grew 52%"; the caption now says what it is.
    readouts: [["11.6%", "61.9%", "26.1%", "0.4% outside profiled files"], ["3.11 GiB", "at 52.9 s", "train.py:120", "Python 1.0%", "52.2% stayed live", "212 MiB from native threads"], ["66.9%", "mean · main thread · time", "8.62 GiB", "train.py:173", "96.4%"], ["2", "metrics.py:42", "5.71 MiB/s", "loader.py:33", "288 KiB/s"]],
  },
  "async-server": {
    headline: "bench_server.py ran for 15.7 s. 59.6% of it is the event loop (asyncio.run(…)), mostly waiting. The busiest code, hashlib.pbkdf2_hmac(…) (21.6%, handlers.py:51), runs inside a coroutine, so the loop stalls while it runs.",
    readouts: [["12.3%", "32.4%", "55.3%"], ["50.1 MiB", "at 15.2 s", "cache.py:24", "Python 90.0%", "15.9% stayed live"], ["35.8%", "asyncio.sleep(…)", "bench_server.py:59", "15.5 tasks suspended on average, 22 at most"], ["15.7 s", "1 thread", "14,656 samples"]],
  },
  "cpu-only": {
    headline: "nbody.py ran for 22.2 s. Three lines in accelerations() account for 32.0% of the time.",
    readouts: [["94.3%", "4.6%", "1.1%"], ["22.2 s", "1 thread", "2,222 samples"], ["86.8%", "of run", "accelerations()", "nbody.py:32", "19.3 s"]],
  },
  neuron: {
    headline: "infer_bert.py ran for 26.2 s. neuron_model(…) (infer_bert.py:66) takes 37.7% of the time; memory peaked at 742 MiB.",
    readouts: [["17.1%", "34.2%", "48.7%"], ["742 MiB", "at 10.7 s", "infer_bert.py:23"], ["9.89 s", "37.8% of run in NRT", "NC 8.69 s (33.2%)", "device idle in 78.5% of CPU samples"], ["26.2 s"]],
  },
  huge: {
    headline: "run_sim.py ran for 3 m 47 s. Time is spread out: the busiest function, update_basis(), takes 5.8%; memory peaked at 2.38 GiB.",
    readouts: [["75.2%", "17.2%", "7.2%", "0.5% outside"], ["2.38 GiB", "at 49.5 s", "thermal.py:169"], ["22.8%", "6.75 GiB"], ["2", "registry.py:90", "11 KiB/s", "statistics.py:66", "4 KiB/s"]],
  },
};
if (want("golden")) {
  for (const [f, g] of Object.entries(GOLD)) {
    const { page, context, errors } = await open(f);
    const got = await page.evaluate(() => ({
      h1: document.querySelector("#overview h1.headline").textContent.replace(/\s+/g, " ").trim(),
      tiles: Array.from(document.querySelectorAll("#overview .ov-hero .ro-tile")).map((t) => t.textContent.replace(/\s+/g, " ")),
      visible: Array.from(document.querySelectorAll("#overview .ov-hero .ro-tile")).every((t) => t.getBoundingClientRect().bottom <= innerHeight),
    }));
    record(`golden headline ${f}`, got.h1 === g.headline, got.h1 === g.headline ? "" : `got "${got.h1}"`);
    const missing = [];
    g.readouts.forEach((parts, i) => parts.forEach((p) => { if (!(got.tiles[i] ?? "").includes(p)) missing.push(`#${i + 1} "${p}"`); }));
    record(`golden readouts ${f}`, missing.length === 0 && got.tiles.length === g.readouts.length && got.visible && errors.length === 0, missing.length ? `missing ${missing.join(", ")}` : `${got.tiles.length} tiles visible`);
    await context.close();
  }
}

/** Callout clear of the footprint trace (review round 1): no trace column within 3 px of the box. */
function calloutVsTrace(d) {
  if (!d.callout || !d.trace || !d.trace.length) return [];
  const r = d.callout.rect;
  const errs = [];
  for (let i = 0; i < d.trace.length; i += 3) {
    const [x, top, bottom] = [d.trace[i], d.trace[i + 1], d.trace[i + 2]];
    if (x < r.x - 3 || x > r.x + r.w + 3) continue;
    if (top <= r.y + r.h + 3 && bottom >= r.y - 3) {
      errs.push(`callout covers the trace at x=${x.toFixed(0)}`);
      break;
    }
  }
  return errs;
}

// ── 3. Scope geometry (§4.4.7, must-fix 5) ─────────────────────────────────
if (want("geometry")) {
  for (const f of ["ml-training", "huge", "async-server"]) {
    for (const [w, h] of [[390, 844], [1000, 400], [1024, 768], [1440, 900]]) {
      for (const withRange of [false, true]) {
        const { page, context } = await open(f, { w, h });
        if (withRange) {
          await page.focus("#overview .scope-canvas .cv-overlay");
          for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight");
          await page.keyboard.press("Tab"); // the time cursor leaves; the range stays
        }
        await page.waitForTimeout(50);
        const d = await page.evaluate(() => globalThis.__scaleneOverview.scope.debugLayout());
        const errs = checkAnnotations(d.annotations);
        for (const c of d.channels) {
          const p = d.plot;
          if (c.rect.x < p.x - 0.5 || c.rect.x + c.rect.w > p.x + p.w + 0.5 || c.rect.y < p.y - 0.5 || c.rect.y + c.rect.h > p.y + p.h + 0.5) errs.push(`channel ${c.id} outside plot`);
        }
        if (withRange && !d.chip) errs.push("range chip missing");
        errs.push(...calloutVsTrace(d));
        // y-tick labels sit in the right gutter, never on the data (also on phones).
        for (const t of d.ticks) if (t.kind === "ytick" && t.rect.x < d.plot.x + d.plot.w - 0.5) errs.push(`ytick "${t.text}" inside the plot`);
        record(`geometry ${f} ${w}x${h}${withRange ? " +range" : ""}`, errs.length === 0, errs.length ? errs.slice(0, 4).join("; ") : `${d.annotations.length} annotations, callout ${d.callout ? d.callout.plan : "none"}, channels ${d.channels.map((c) => c.id).join("/")}`);
        await context.close();
      }
    }
  }
}

// ── 3b. THREADS: the same scale and sentence at every width (review round 1) ──
if (want("threads")) {
  const seen = [];
  for (const [w, h] of [[1000, 400], [1440, 900], [2560, 1440]]) {
    const { page, context } = await open("ml-training", { w, h });
    await page.waitForFunction(() => globalThis.__scaleneOverview.scope.debugLayout().threads, null, { timeout: 10000 });
    const d = await page.evaluate(() => globalThis.__scaleneOverview.scope.debugLayout());
    seen.push({ size: `${w}x${h}`, top: d.threads.top, sentence: (/Up to [^.]*\./.exec(d.description) || [""])[0] });
    await context.close();
  }
  const same = seen.every((x) => x.top === seen[0].top && x.sentence === seen[0].sentence);
  record("THREADS scale and concurrency sentence are width-independent", same && /Up to 5 threads busy at the same moment/.test(seen[0].sentence), seen.map((x) => `${x.size}: 0–${x.top}, "${x.sentence}"`).join("; "));
}

// ── 3c. Short host, CPU-only: never an empty signal card (§4.4.2) ──────────
if (want("short")) {
  for (const theme of ["light", "dark"]) {
    const { page, context } = await open("cpu-only", { w: 1000, h: 400, theme });
    const r = await page.evaluate(() => {
      const d = globalThis.__scaleneOverview.scope.debugLayout();
      const pane = document.querySelector("#overview .ov-scope");
      return { channels: d.channels.map((c) => c.id), plotH: d.plot.h, visible: !!pane && !pane.closest("[hidden]") && pane.getBoundingClientRect().width > 0, noScope: document.querySelector("#overview .ov-inst").classList.contains("no-scope") };
    });
    const ok = (r.visible && r.channels.length > 0 && r.plotH > 0) || (!r.visible && r.noScope);
    record(`cpu-only 1000x400 ${theme}: scope has a channel or is absent`, ok, JSON.stringify(r));
    const keys = await page.evaluate(() => Array.from(document.querySelectorAll('#overview .ro-tile[data-kind="time"] .ro-sk')).map((k) => (k.getBoundingClientRect().width > 0 ? k.textContent : "")));
    record(`short time split keeps its labels (${theme})`, keys.join(",") === "Py,native,sys", keys.join(","));
    await context.close();
  }
}

// ── 4. cpu-only: no THREADS channel, no empty findings card ────────────────
if (want("cpu")) {
  const { page, context } = await open("cpu-only");
  const r = await page.evaluate(() => ({
    channels: globalThis.__scaleneOverview.scope.debugLayout().channels.map((c) => c.id),
    cards: Array.from(document.querySelectorAll("#overview .fd-card")).filter((c) => !c.closest("[hidden]")).map((c) => c.dataset.id),
    emptyText: /no notable/i.test(document.querySelector("#overview").textContent),
  }));
  const top = await page.evaluate(() => {
    const d = globalThis.__scaleneOverview.scope.debugLayout();
    const c = d.channels.find((x) => x.id === "top");
    return c ? { h: c.rect.h, rows: d.annotations.filter((a) => a.kind === "rank").length } : null;
  });
  record("cpu-only channels", !r.channels.includes("threads") && r.channels.includes("phase") && r.channels.includes("top"), r.channels.join("/"));
  record("cpu-only TOP LINES: one row per visible hotspot, rows ≤ 32 px (no barcode wall)", !!top && top.rows === 8 && top.h / top.rows <= 32.01, JSON.stringify(top));
  record("cpu-only findings", r.cards.length === 1 && r.cards[0] === "python" && !r.emptyText, r.cards.join(","));
  const grid = await page.evaluate(() => {
    const list = document.querySelector("#overview .fd-list");
    const card = list.querySelector(".fd-item:not([hidden])").getBoundingClientRect();
    const note = list.querySelector(".fd-note");
    return { ratio: card.width / list.getBoundingClientRect().width, note: !!note && note.getBoundingClientRect().width > 0 };
  });
  record("one finding: the card spans two thirds and a note fills the row", grid.ratio > 0.6 && grid.note, JSON.stringify(grid));
  await context.close();
}

// ── 5. Intro settles by 900 ms and matches ?still ──────────────────────────
if (want("intro")) {
  for (const theme of ["light", "dark"]) {
    const still = await open("ml-training", { q: "still", theme });
    await still.page.waitForTimeout(600);
    await still.page.evaluate(() => window.scrollTo(0, 0));
    const a = await still.page.screenshot();
    await still.context.close();
    const anim = await open("ml-training", { q: "", theme, wait: "domcontentloaded" });
    const frames = {};
    for (const at of [120, 300, 650]) {
      await anim.page.waitForFunction((ms) => performance.now() - globalThis.__scaleneOverview.t0 >= ms, at, { polling: "raf" });
      const sweep = await anim.page.evaluate(() => globalThis.__scaleneOverview.scope.debugLayout().sweep);
      frames[at] = sweep;
      if (theme === "dark") await anim.page.screenshot({ path: path.join(shotDir, `intro-ml-1440-${at}ms-${theme}.png`) });
    }
    await anim.page.waitForFunction(() => performance.now() - globalThis.__scaleneOverview.t0 >= 900, null, { polling: "raf" });
    const state = await anim.page.evaluate(() => ({
      sweep: globalThis.__scaleneOverview.scope.debugLayout().sweep,
      running: document.getAnimations().filter((x) => x.playState === "running").length,
      elapsed: performance.now() - globalThis.__scaleneOverview.t0,
    }));
    await anim.page.evaluate(() => window.scrollTo(0, 0));
    const b = await anim.page.screenshot();
    if (theme === "dark") fs.writeFileSync(path.join(shotDir, `intro-ml-1440-900ms-${theme}.png`), b);
    await anim.context.close();
    const d = await diff(a, b);
    record(`intro settles by 900 ms (${theme})`, state.sweep === 1 && state.running === 0 && d.ratio < 0.005, `sweep@120=${frames[120].toFixed(2)} @300=${frames[300].toFixed(2)} @650=${frames[650].toFixed(2)}; at ${state.elapsed.toFixed(0)} ms sweep ${state.sweep}, running anims ${state.running}, diff vs ?still ${(d.ratio * 100).toFixed(3)}%`);
  }
}

// ── 6. Reduced motion: final frame at 40 ms ────────────────────────────────
if (want("reduced")) {
  const ctxr = await open("ml-training", { q: "", reduced: true, wait: "domcontentloaded" });
  await ctxr.page.waitForFunction(() => performance.now() - globalThis.__scaleneOverview.t0 >= 40, null, { polling: "raf" });
  await ctxr.page.evaluate(() => window.scrollTo(0, 0));
  const early = await ctxr.page.screenshot();
  const anims = await ctxr.page.evaluate(() => document.getAnimations().map((a) => {
    const kf = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
    const props = new Set(kf.flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p))));
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
    return { props: Array.from(props), dur: Number(t.duration) || 0 };
  }));
  await ctxr.page.waitForTimeout(1500);
  await ctxr.page.evaluate(() => window.scrollTo(0, 0));
  const late = await ctxr.page.screenshot();
  await ctxr.context.close();
  const d = await diff(early, late);
  const badAnims = anims.filter((a) => a.props.some((p) => p !== "opacity") || a.dur > 120);
  record("reduced motion = final frame at 40 ms", d.ratio < 0.005 && badAnims.length === 0, `diff ${(d.ratio * 100).toFixed(3)}%, animations ${anims.length} (non-opacity or > 120 ms: ${badAnims.length})`);
}

// ── 7. Hotspots keyboard (one Tab stop, arrows, Enter jumps) ────────────────
if (want("keyboard")) {
  const { page, context, errors } = await open("ml-training");
  const stops = await page.evaluate(() => document.querySelectorAll('#overview .hs-list [tabindex="0"]').length);
  await page.focus('#overview .hs-controls .seg:last-child [aria-checked="true"]');
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await page.keyboard.press("j");
  const third = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await page.keyboard.press("End");
  const last = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await page.keyboard.press("Home");
  const home = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  const linked = await page.evaluate(() => globalThis.__scaleneOverview.scope.debugLayout());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const landed = await page.evaluate(() => {
    const a = document.activeElement;
    return { inCode: !!a && !!a.closest("#code"), role: a?.getAttribute("role"), label: a?.getAttribute("aria-label") ?? a?.textContent?.slice(0, 60), hash: location.hash };
  });
  const ok = stops === 1 && /^1\. loss_value/.test(first ?? "") && /^2\./.test(second ?? "") && /^3\./.test(third ?? "") && /^8\./.test(last ?? "") && /^1\./.test(home ?? "");
  record("hotspots keyboard: one Tab stop, ↑/↓ j/k Home/End", ok, `stops ${stops}; ${first?.slice(0, 40)} → ${second?.slice(0, 3)} → ${third?.slice(0, 3)} → ${last?.slice(0, 3)} → ${home?.slice(0, 3)}`);
  record("Enter jumps; focus lands on the code row", landed.inCode && landed.role === "row", `active: role=${landed.role} inCode=${landed.inCode} "${landed.label}"` + (errors.length ? ` errors: ${errors[0]}` : ""));
  void linked;
  await context.close();
}

// ── 8. Hover on hotspot #1 draws its overlay in ≤ 2 ms (?perf) ──────────────
if (want("perf")) {
  for (const f of ["ml-training", "huge"]) {
    const { page, context } = await open(f, { q: "still&perf" });
    const times = [];
    for (let i = 0; i < 6; i++) {
      await page.hover("#overview .hs-row >> nth=0");
      await page.waitForTimeout(30);
      times.push(await page.evaluate(() => globalThis.__scaleneOverview.scope.debugLayout().overlayMs));
      await page.mouse.move(5, 5);
      await page.waitForTimeout(20);
    }
    const caption = await page.evaluate(() => { document.querySelector("#overview .hs-row").dispatchEvent(new MouseEvent("mouseenter")); return document.querySelector("#overview .scope-desc").textContent; });
    const measures = await page.evaluate(() => performance.getEntriesByName("scalene:scope-overlay").length);
    const max = Math.max(...times);
    record(`hover overlay ≤ 2 ms (${f})`, max <= 2, `overlay draws ${times.map((t) => t.toFixed(2)).join(", ")} ms; measures ${measures}; caption "${caption}"`);
    await context.close();
  }
}

// ── 9. Theme toggle redraws the scope in place (§4.1.6) ───────────────────
if (want("theme")) {
  const dark = await open("ml-training", { theme: "dark" });
  await dark.page.waitForTimeout(300);
  const a = await dark.page.locator("#overview .scope-canvas").screenshot();
  await dark.context.close();
  const light = await open("ml-training", { theme: "light" });
  await light.page.evaluate(() => window.scrollTo(0, 120));
  await light.page.waitForTimeout(200);
  const before = await light.page.evaluate(() => scrollY);
  const t0 = Date.now();
  await light.page.click(".appbar-theme");
  const ms = Date.now() - t0;
  await light.page.waitForTimeout(100);
  await light.page.evaluate(() => window.scrollTo(0, 0));
  await light.page.waitForTimeout(100);
  const b = await light.page.locator("#overview .scope-canvas").screenshot();
  const after = await light.page.evaluate(() => document.documentElement.dataset.theme);
  await light.context.close();
  const d = await diff(a, b);
  record("theme toggle redraws the scope in place", after === "dark" && d.ratio < 0.01, `theme ${after}, diff vs dark load ${(d.ratio * 100).toFixed(3)}%, scrollY kept ${before}, click ${ms} ms`);
}

// ── 10. M8 re-rank: no text over text while rows move (review round 1) ────
if (want("m8")) {
  const { page, context } = await open("ml-training", { q: "", theme: "dark" });
  await page.waitForTimeout(1200);
  const frames = await page.evaluate(async () => {
    const btn = Array.from(document.querySelectorAll("#overview .hs-controls [role=radio]")).find((b) => b.textContent.trim() === "Memory");
    const out = [];
    const eff = (el) => {
      let o = 1;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
      return o;
    };
    btn.click();
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const els = Array.from(document.querySelectorAll("#overview .hs-list > .hs-row:not([hidden]), #overview .hs-list > .hs-ghost"));
        const boxes = els.map((el) => {
          const r = el.getBoundingClientRect();
          const bg = getComputedStyle(el).backgroundColor;
          const val = el.querySelector(".hs-val");
          return { ghost: el.classList.contains("hs-ghost"), moving: el.classList.contains("is-moving") && getComputedStyle(el).transform !== "none", top: r.top, bottom: r.bottom, o: eff(el), valO: val ? eff(val) : 0, opaque: /^rgb\(/.test(bg) || /, 1\)$/.test(bg) };
        });
        out.push({ t: performance.now() - t0, boxes });
        if (performance.now() - t0 < 700) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return out;
  });
  const bad = [];
  for (const f of frames) {
    const vis = f.boxes.filter((b) => b.o > 0.05);
    for (let i = 0; i < vis.length; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        const a = vis[i];
        const b = vis[j];
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlap <= 2) continue;
        // Allowed only under an opaque moving row (the slab hides what is beneath).
        const cover = (a.moving && a.opaque) || (b.moving && b.opaque);
        if (!cover) bad.push(`${f.t.toFixed(0)} ms: rows overlap ${overlap.toFixed(0)} px`);
      }
    }
    for (const b of f.boxes) if (b.moving && b.valO > 0.5 && !b.ghost) bad.push(`${f.t.toFixed(0)} ms: a moving row shows its new value`);
  }
  record("M8: leaving rows fade before rows move; moving rows hide what they pass", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${frames.length} frames sampled`);
  await context.close();
}

// ── 11. Touch: a tap reads, a second tap opens (review round 1) ───────────
if (want("touch")) {
  const { page, context } = await open("ml-training", { w: 390, h: 844 });
  const box = await page.locator("#overview .scope-canvas .cv-overlay").boundingBox();
  await page.evaluate((y) => window.scrollTo(0, y - 100), box.y + (await page.evaluate(() => scrollY)));
  await page.waitForTimeout(200);
  const b2 = await page.locator("#overview .scope-canvas .cv-overlay").boundingBox();
  const y0 = await page.evaluate(() => scrollY);
  const at = { x: b2.x + b2.width * 0.3, y: b2.y + 120 };
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(250);
  const first = await page.evaluate(() => {
    const c = document.querySelector("#overview .scope-card");
    return { on: c.classList.contains("is-on") && c.classList.contains("is-touch"), open: !!c.querySelector(".sc-open"), y: scrollY };
  });
  record("touch: first tap shows the readout card (no jump)", first.on && first.open && first.y === y0, JSON.stringify(first));
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(1500);
  const y2 = await page.evaluate(() => scrollY);
  record("touch: a second tap at the same place opens the line", y2 > y0 + 200, `scrollY ${y0} → ${y2}`);
  await context.close();
}

// ── 12. Readout intro: one clock per tile; Pareto bar grows with M5 ───────
if (want("introro")) {
  const { page, context } = await open("ml-training", { q: "", theme: "dark", wait: "domcontentloaded" });
  const bad = [];
  let pareto = null;
  for (const at of [20, 60, 100, 160, 250, 400]) {
    await page.waitForFunction((ms) => performance.now() - globalThis.__scaleneOverview.t0 >= ms, at, { polling: "raf" });
    const r = await page.evaluate(() => {
      const eff = (el) => {
        let o = 1;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
        return o;
      };
      const tiles = Array.from(document.querySelectorAll("#overview .ov-hero .ro-tile")).map((t) => ({ label: eff(t.querySelector(".ro-label")), value: eff(t.querySelector(".ro-value, .ro-split")), cap: t.querySelector(".ro-cap, .ro-leaks") ? eff(t.querySelector(".ro-cap, .ro-leaks")) : 0 }));
      const cum = document.querySelector("#overview .hs-cum-fill");
      const m = cum ? new DOMMatrix(getComputedStyle(cum).transform) : null;
      return { tiles, cum: m ? m.a : 1 };
    });
    r.tiles.forEach((t, i) => {
      if (t.value > t.label + 0.15 || t.cap > t.label + 0.15) bad.push(`${at} ms tile ${i + 1}: value/caption ahead of its label (${t.value.toFixed(2)}/${t.cap.toFixed(2)} vs ${t.label.toFixed(2)})`);
    });
    if (at === 250) pareto = r.cum;
  }
  record("readout intro: no value or caption before its label", bad.length === 0, bad.slice(0, 3).join("; "));
  record("Pareto bar grows with the row meters (not full at 250 ms)", pareto !== null && pareto < 0.5, `scaleX at 250 ms = ${pareto}`);
  await context.close();
}

// ── 13. Outline and listbox semantics (review round 1) ─────────────────────
if (want("a11y")) {
  const { page, context } = await open("ml-training");
  const heads = await page.evaluate(() => Array.from(document.querySelectorAll("#overview h1, #overview h2, #overview h3, #overview h4")).map((h) => h.tagName.toLowerCase()));
  record("overview outline starts with the h1, then h2 Overview", heads[0] === "h1" && heads[1] === "h2" && !heads.slice(2).includes("h2"), heads.join(" "));
  await page.focus('#overview .hs-controls .seg:last-child [aria-checked="true"]');
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  const sel = await page.evaluate(() => ({ focused: document.activeElement.getAttribute("aria-selected"), others: Array.from(document.querySelectorAll('#overview .hs-row[aria-selected="true"]')).length }));
  record("hotspots: selection follows focus (aria-selected on the focused option only)", sel.focused === "true" && sel.others === 1, JSON.stringify(sel));
  await page.focus("#overview .scope-canvas .cv-overlay");
  await page.keyboard.press("End");
  const y0 = await page.evaluate(() => scrollY);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ y: scrollY, live: Array.from(document.querySelectorAll('[aria-live="polite"]')).map((n) => n.textContent).join(" | ") }));
  record("scope: Enter where no line ran says so; ArrowDown does not scroll", after.y === y0 && /No Python line/.test(after.live), JSON.stringify(after).slice(0, 160));
  // Memory metric: the secondary column is never cut mid-token.
  await page.click('#overview .hs-controls [role=radio]:has-text("Memory")');
  await page.waitForTimeout(700);
  const clipped = await page.evaluate(() => Array.from(document.querySelectorAll("#overview .hs-row:not([hidden]) .hs-sec")).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  record("hotspots Memory: '% of alloc.' secondary is never clipped", clipped.length === 0, clipped.join(", "));
  await context.close();
}

// ── 14. "(+16 below 1%)" opens the hidden files (review round 1) ───────────
if (want("hidden")) {
  const { page, context } = await open("huge", { q: "" });
  await page.waitForTimeout(1200);
  await page.click("#overview .meta-more");
  await page.waitForTimeout(2200);
  const r = await page.evaluate(() => {
    const lists = Array.from(document.querySelectorAll("#code .fn-list, .fn-list"));
    const vis = lists.filter((l) => !l.hidden && l.getBoundingClientRect().height > 0 && /below 1%|hidden|more file/i.test(l.getAttribute("aria-label") || ""));
    return { open: vis.length > 0, inCode: document.getElementById("code").getBoundingClientRect().top < innerHeight };
  });
  record("hidden-files meta button opens the hidden list in the code navigator", r.open && r.inCode, JSON.stringify(r));
  await context.close();
}

await browser.close();
process.exit(report.finish());
