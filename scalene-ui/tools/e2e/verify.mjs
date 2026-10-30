#!/usr/bin/env node
// Review-round verification suite (round 1 verifier): re-checks the hand-off fixes and the
// blocker/major findings that no other suite pins, and measures the §6.1 budgets.
//
//   node tools/e2e/verify.mjs [--only allfiles,focuskeep,memcallout,copy,coarse,scopecard,recheck,mustfix,perf,resize,intro]
//
// Results: out/e2e/verify.json (+ out/e2e/perf.json with the measured numbers); screenshots in
// design/screens/e2e/verify/.
import fs from "node:fs";
import path from "node:path";
import { chromium, createReport, onlyFilter, openPage, outDir, shotsDir } from "./_env.mjs";

const want = onlyFilter();
const { check, finish } = createReport("verify");
const SHOTS = shotsDir("verify");
const browser = await chromium.launch();
const settle = (page) =>
  page.waitForFunction(
    () => document.getElementById("scalene-app")?.getAttribute("aria-busy") !== "true" && (document.querySelector(".empty-state") !== null || performance.getEntriesByName("scalene:idle-done").length > 0),
    null,
    { timeout: 60000 },
  );
const open = async (name, o = {}) => {
  const r = await openPage(browser, name, o);
  await settle(r.page);
  await r.page.waitForTimeout(150);
  return r;
};
const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, cls: String(a?.className ?? ""), body: a === document.body, skip: Boolean(a?.closest(".skip-link")) || /^Skip/.test((a?.textContent ?? "").trim()), inLayer: Boolean(a?.closest("#layer-root")), inPanel: Boolean(a?.closest(".fn-panel")) };
  });
const perf = {};

// ── 1. "All files" popover: Tab leaves past the trigger, Shift+Tab returns (major popup-tab…) ──
if (want("allfiles")) {
  const { context, page, errors } = await open("huge", { w: 1440, h: 900 });
  await page.evaluate(() => document.getElementById("code")?.scrollIntoView({ block: "start" }));
  await page.waitForSelector("#code .fn-all", { timeout: 15000 });
  await page.focus("#code .fn-all");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const a0 = await active(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(80);
  const a1 = await active(page);
  const closed = await page.evaluate(() => !document.querySelector(".fn-panel") && document.querySelector("#code .fn-all")?.getAttribute("aria-expanded") === "false");
  check("allfiles: Tab from an option closes the popover and moves past the trigger (never the skip link / layer)", a0.inPanel && !a1.body && !a1.skip && !a1.inLayer && closed, { a0, a1, closed });
  await page.focus("#code .fn-all");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(80);
  const a2 = await active(page);
  check("allfiles: Shift+Tab returns to the All files trigger", /fn-all/.test(a2.cls), a2);
  check("allfiles: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
  // Phone: the switcher's bottom sheet is modal: Tab cycles inside.
  const p = await open("huge", { w: 390, h: 844 });
  await p.page.evaluate(() => document.getElementById("code")?.scrollIntoView({ block: "start" }));
  const sw = await p.page.waitForSelector("#code .fn-switcher", { timeout: 15000 }).catch(() => null);
  if (sw) {
    await p.page.focus("#code .fn-switcher");
    await p.page.keyboard.press("Enter");
    await p.page.waitForTimeout(200);
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await p.page.keyboard.press("Tab");
      seen.push(await active(p.page));
    }
    check("allfiles (xs sheet): Tab stays inside the modal sheet", seen.every((s) => s.inPanel), seen.map((s) => s.cls.slice(0, 24)));
  } else check("allfiles (xs sheet): switcher present", false, "no .fn-switcher at 390");
  await p.context.close();
}

// ── 2. Virtual list: the focused code row survives being scrolled out of range ──
if (want("focuskeep")) {
  const { context, page } = await open("ml-training", { w: 1440, h: 900 });
  await page.evaluate(() => window.vsNavigate(escape("/home/dev/llm-train/train.py"), 173));
  await page.waitForTimeout(1500);
  const before = await active(page);
  await page.evaluate(() => window.scrollBy(0, 2600));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ body: document.activeElement === document.body, row: Boolean(document.activeElement?.closest(".cv-row")), key: document.activeElement?.closest("[data-key]")?.getAttribute("data-key") ?? null }));
  check("focuskeep: focused code row stays focused after scrolling it out of the rendered range", !before.body && after.row && !after.body, { before: before.cls.slice(0, 30), after });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  const next = await page.evaluate(() => ({ row: Boolean(document.activeElement?.closest(".cv-row")), top: Math.round(document.activeElement?.getBoundingClientRect().top ?? -1) }));
  check("focuskeep: ArrowDown continues from the kept row and brings it back on screen", next.row && next.top >= 0 && next.top < 900, next);
  await context.close();
}

// ── 3. Memory section chart: peak callout clear of the footprint trace (major peak-callout…) ──
if (want("memcallout")) {
  for (const fx of ["ml-training", "async-server", "huge", "neuron"]) {
    for (const [w, h] of [[1440, 900], [1024, 768], [390, 844], [2560, 1440]]) {
      const { context, page } = await open(fx, { w, h });
      const has = await page.evaluate(() => Boolean(document.getElementById("memory")));
      if (!has) {
        await context.close();
        continue;
      }
      await page.evaluate(() => document.getElementById("memory").scrollIntoView({ block: "start" }));
      await page.waitForTimeout(700);
      const r = await page.evaluate(() => {
        const card = [document.getElementById("memory"), ...document.querySelectorAll("#memory *")].find((e) => e && e.__memory);
        const api = card?.__memory;
        if (!api) return { err: "no __memory" };
        const p = api.peak();
        const geo = api.geo();
        if (!p) return { err: "no plan" };
        if (!p.rect) return { kind: p.kind };
        const b = p.trace;
        const r = p.rect;
        const m = 4;
        let hit = false;
        const c0 = Math.max(0, Math.floor(r.x - m - b.x0));
        const c1 = Math.min(b.top.length - 1, Math.ceil(r.x + r.w + m - b.x0));
        for (let c = c0; c <= c1; c++) {
          const t = b.top[c];
          if (Number.isNaN(t)) continue;
          if (t <= r.y + r.h + m && b.bottom[c] >= r.y - m) hit = true;
        }
        const plot = geo?.plot;
        const inside = plot ? r.x >= plot.x && r.y >= plot.y && r.x + r.w <= plot.x + plot.w && r.y + r.h <= plot.y + plot.h : null;
        return { kind: p.kind, hit, inside, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } };
      });
      check(`memcallout ${fx} ${w}x${h}: callout/label never within 4 px of the trace, inside the plot`, !r.err && (r.kind === "gutter" || (!r.hit && r.inside)), r);
      if (w === 1440) await page.screenshot({ path: path.join(SHOTS, `memcallout-${fx}-1440.png`) });
      await context.close();
    }
  }
}

// ── 4. Copy hand-offs ──
if (want("copy")) {
  const { context, page } = await open("ml-training", { w: 1440, h: 900 });
  const c = await page.evaluate(() => ({
    legend: Array.from(document.querySelectorAll("#overview .lg-item")).map((e) => e.textContent.trim()),
    leakRates: Array.from(document.querySelectorAll("#overview .ro-leak-rate")).map((e) => e.textContent.trim()),
    ai: document.querySelector("header.appbar .appbar-ai-label")?.textContent.trim() ?? null,
    aiLabel: document.querySelector("header.appbar .appbar-ai")?.getAttribute("aria-label") ?? null,
    setupVisible: (() => {
      const b = document.querySelector("header.appbar .appbar-ai-setup");
      return !!b && b.getClientRects().length > 0;
    })(),
  }));
  check("copy: scope legend says 'I/O & waits' (the §4.12 term), never bare 'waiting'", c.legend.includes("I/O & waits") && !c.legend.includes("waiting"), c.legend);
  check("copy: readout leak rates read 'grows 5.71 MiB/s'", c.leakRates.length > 0 && c.leakRates.every((t) => /^grows \d/.test(t)), c.leakRates);
  check("copy: app bar reads 'AI fixes' with a visible 'Set up' badge until a provider is ready", /^AI fixes\s*Set up$/.test(c.ai ?? "") && c.setupVisible && c.aiLabel === "AI fixes — set up a provider", c);
  // Hotspots › Functions: "train()" like headline, lens and code.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("#overview [role='radio'], #overview button")).find((e) => e.textContent.trim() === "Functions");
    b?.click();
  });
  await page.waitForTimeout(700);
  const fns = await page.evaluate(() => Array.from(document.querySelectorAll("#overview .hs-row .hs-code")).slice(0, 4).map((e) => e.textContent.trim()));
  check("copy: Hotspots › Functions rows read 'train()' (no ƒ glyph)", fns.length > 0 && fns.every((t) => /\(\)$|^</.test(t) && !t.includes("ƒ")), fns);
  // Shortcuts dialog: "Signal", not "Signal (scope)".
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("?");
  await page.waitForTimeout(300);
  const sc = await page.evaluate(() => Array.from(document.querySelectorAll("[role='dialog'] h3, [role='dialog'] h4, [role='dialog'] .kbd-group-title")).map((e) => e.textContent.trim()));
  check("copy: shortcuts dialog groups say 'Signal', never the internal 'scope'", sc.includes("Signal") && !sc.some((t) => /scope/i.test(t)), sc);
  await page.keyboard.press("Escape");
  // Lens wording at the 500 cap; flame memory caption without a unit.
  await page.evaluate(() => window.vsNavigate(escape("/home/dev/llm-train/train.py"), 173));
  await page.waitForTimeout(1400);
  const lens = await page.evaluate(() => Array.from(document.querySelectorAll("#code .cd-caption")).map((e) => e.textContent.trim()).filter((t) => /main-thread/.test(t)));
  check("copy: lens says '≥ 500 main-thread samples' at Scalene's per-line cap", lens.some((t) => /^≥ 500 main-thread samples/.test(t)), lens);
  await context.close();
}

// ── 5. Coarse pointers: view-owned targets ≥ 32 px (minor coarse-pointer-targets-24px) ──
if (want("coarse")) {
  const { context, page } = await open("ml-training", { w: 390, h: 844 });
  await page.evaluate(() => document.getElementById("code")?.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(600);
  const t = await page.evaluate(() => {
    const hit = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const a = getComputedStyle(el, "::after");
      const extra = a.content && a.content !== "none" && a.position === "absolute" ? -2 * parseFloat(a.top || "0") : 0;
      return Math.round(r.height + Math.max(0, extra));
    };
    return {
      hsMore: hit(document.querySelector("#overview .hs-more")),
      fdRef: hit(document.querySelector("#overview .fd-ref")),
      cvHead: hit(document.querySelector("#code .cv-h-btn")),
    };
  });
  const okAll = Object.values(t).every((v) => v === null || v >= 32);
  check("coarse: .hs-more / .fd-ref hit areas and .cv-h-btn are ≥ 32 px on a coarse phone", okAll && t.cvHead !== null, t);
  await context.close();
}

// ── 6. Blocker scope-card-sc-row-collision: readout card rows are one flex line, both themes ──
if (want("scopecard")) {
  for (const theme of ["light", "dark"]) {
    const { context, page } = await open("ml-training", { w: 1440, h: 900, theme });
    const box = await page.locator("#overview .scope-canvas").boundingBox();
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.4);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".scope-card .sc-row"));
      return {
        n: rows.length,
        display: rows.map((e) => getComputedStyle(e).display),
        oneLine: rows.every((e) => {
          const kids = Array.from(e.children).map((k) => k.getBoundingClientRect());
          return kids.length < 2 || kids.every((k) => Math.abs(k.top + k.height / 2 - (kids[0].top + kids[0].height / 2)) < 6);
        }),
        swatchPhase: (() => {
          const s = document.querySelector(".scope-card .sw-phase");
          return s ? getComputedStyle(s).boxShadow : null;
        })(),
      };
    });
    check(`scopecard (${theme}): .sc-row computed flex, swatch · label · value on one line`, r.n > 0 && r.display.every((d) => d === "flex") && r.oneLine, r);
    const card = await page.locator(".scope-card").boundingBox();
    if (card) await page.screenshot({ path: path.join(SHOTS, `scopecard-${theme}.png`), clip: { x: Math.max(0, card.x - 40), y: Math.max(0, card.y - 40), width: Math.min(1440, card.width + 80), height: card.height + 80 } });
    await context.close();
  }
}

// ── 6b. Re-checks of round-1 blocker/major findings without a dedicated check elsewhere ──
if (want("recheck")) {
  const clipped = (sel) =>
    Array.from(document.querySelectorAll(sel)).flatMap((root) =>
      Array.from(root.querySelectorAll("*"))
        .filter((e) => e.children.length === 0 && e.getClientRects().length && e.getBoundingClientRect().width > 1 && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible")
        .map((e) => e.textContent.trim().slice(0, 40)),
    );
  {
    // readout-captions-drop-context-at-1440 + busiest-function-no-denominator
    const { context, page } = await open("ml-training", { w: 1440, h: 900 });
    const r = await page.evaluate((src) => {
      const clippedFn = (0, eval)(src);
      return { tiles: Array.from(document.querySelectorAll("#overview .ro-tile")).map((t) => t.innerText.replace(/\s+/g, " ").trim()), clipped: clippedFn("#overview .ro-tile") };
    }, `(${clipped})`);
    check("recheck readout-captions 1440 (ml): no clipped caption text; Peak says 'stayed live', GPU keeps its method", r.clipped.length === 0 && r.tiles.some((t) => /stayed live/.test(t)) && r.tiles.some((t) => /mean · main thread/.test(t)), r);
    // hundred-more-opens-one-file: "N more lines" expands in place.
    const before = await page.evaluate(() => ({ rows: document.querySelectorAll("#overview .hs-row").length, y: Math.round(scrollY) }));
    await page.click("#overview .hs-more");
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({ rows: document.querySelectorAll("#overview .hs-row").length, y: Math.round(scrollY), pareto: document.querySelector("#overview .hs-pareto")?.textContent.trim() ?? null }));
    check("recheck hundred-more: 'N more lines' expands the ranking in place (no jump to one file)", after.rows > before.rows && Math.abs(after.y - before.y) < 4, { before, after });
    // memory-axis-mixed-units: the memory flame axis uses one unit.
    await page.evaluate(() => window.toggleMemoryStacks());
    await page.waitForTimeout(1200);
    const ax = await page.evaluate(() => Array.from(document.querySelectorAll("#stacks .memory-axis *")).filter((e) => e.children.length === 0).map((e) => e.textContent.trim()).filter(Boolean));
    const units = new Set(ax.map((t) => (t.match(/[KMG]iB|B$/) ?? [null])[0]).filter(Boolean));
    check("recheck memory-axis-mixed-units: memory flame axis labels share one unit", ax.length >= 3 && units.size === 1, ax);
    await context.close();
  }
  {
    const { context, page } = await open("cpu-only", { w: 1440, h: 900 });
    const t = await page.evaluate(() => Array.from(document.querySelectorAll("#overview .ro-tile")).map((e) => e.innerText.replace(/\s+/g, " ").trim()));
    check("recheck busiest-function-no-denominator (cpu-only 1440): 'of run · accelerations()'", t.some((x) => /of run · accelerations\(\)/.test(x)), t);
    await context.close();
    const s = await open("cpu-only", { w: 1000, h: 400 });
    const t2 = await s.page.evaluate(() => Array.from(document.querySelectorAll("#overview .ro-tile")).map((e) => e.innerText.replace(/\s+/g, " ").trim()));
    check("recheck busiest-function-no-denominator (cpu-only 1000×400 compact): keeps 'of run'", t2.some((x) => /busiest/i.test(x) && /of run/.test(x)), t2);
    await s.context.close();
  }
  {
    // short-hotspot-rows-lose-file-and-waiting (async-server 1000×400)
    const { context, page } = await open("async-server", { w: 1000, h: 400 });
    const r = await page.evaluate(() => ({
      files: Array.from(document.querySelectorAll("#overview .hs-loc-file")).map((e) => ({ t: e.textContent.trim(), cut: e.scrollWidth > e.clientWidth + 1 })),
      rows: Array.from(document.querySelectorAll("#overview .hs-row")).map((e) => e.innerText.replace(/\s+/g, " ").trim()),
    }));
    check("recheck short-hotspot-rows (async 1000×400): file:line never truncated; event-loop row says 'loop · waiting'", r.files.length > 0 && r.files.every((f) => !f.cut && !/^…/.test(f.t)) && r.rows.some((x) => /loop · waiting/.test(x)), r);
    await page.screenshot({ path: path.join(SHOTS, "recheck-async-1000x400.png") });
    await context.close();
  }
  for (const theme of ["light", "dark"]) {
    // linked-overlay-opaque-band: the hover band over the footprint stays translucent (shot).
    const { context, page } = await open("ml-training", { w: 1440, h: 900, theme });
    const row = await page.locator("#overview .hs-row").nth(2).boundingBox();
    await page.mouse.move(row.x + 60, row.y + row.height / 2);
    await page.waitForTimeout(400);
    const card = await page.locator("#overview .scope-canvas").boundingBox();
    await page.screenshot({ path: path.join(SHOTS, `recheck-linked-overlay-${theme}.png`), clip: { x: card.x, y: Math.max(0, card.y - 40), width: card.width, height: card.height + 40 } });
    check(`recheck linked overlay (${theme}): screenshot written`, true, `design/screens/e2e/verify/recheck-linked-overlay-${theme}.png`);
    await context.close();
  }
}

// ── 6c. Must-fix register spot checks (§1.4 rows 1, 22, 24, 27) ──
if (want("mustfix")) {
  const { context, page } = await open("ml-training", { w: 1440, h: 900 });
  await page.evaluate(() => window.vsNavigate(escape("/home/dev/llm-train/train.py"), 173));
  await page.waitForTimeout(1200);
  const lig = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("code, kbd, .code, .mono, .chip-code, .cv-src"));
    const bad = els.filter((e) => !/none|no-common-ligatures/.test(getComputedStyle(e).fontVariantLigatures));
    return { n: els.length, bad: bad.slice(0, 5).map((e) => e.className || e.tagName), mono: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() };
  });
  check("mustfix 1: every code surface has font-variant-ligatures none; no ligature face in --font-mono", lig.n > 50 && lig.bad.length === 0 && !/Cascadia Code|JetBrains Mono|Fira Code/.test(lig.mono), lig);
  const fresh = await open("ml-training", { w: 1440, h: 900 });
  await fresh.page.keyboard.press("Tab");
  const skip = await fresh.page.evaluate(() => {
    const a = document.activeElement;
    const r = a?.getBoundingClientRect();
    return { text: a?.textContent?.trim(), x: Math.round(r?.x ?? -1), y: Math.round(r?.y ?? -1), w: Math.round(r?.width ?? 0) };
  });
  check("mustfix 22: first Tab focuses a visible 'Skip to main content' at (8, 8)", /^Skip to main content/.test(skip.text ?? "") && skip.x >= 0 && skip.x <= 16 && skip.y >= 0 && skip.y <= 16 && skip.w > 40, skip);
  await fresh.context.close();
  await page.evaluate(() => document.getElementById("code").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector("#code .cv-h[data-col='time'] .cv-h-btn")?.click());
  await page.waitForTimeout(500);
  const sorted = await page.evaluate(() => Array.from(document.querySelectorAll("#code [role='columnheader'][aria-sort]")).map((e) => [e.dataset.col, e.getAttribute("aria-sort")]));
  check("mustfix 24: the sorted code column carries aria-sort", sorted.some(([, v]) => v === "descending" || v === "ascending"), sorted);
  await context.close();
  const ex = await open("example", { w: 1440, h: 900 });
  const txt = await ex.page.evaluate(() => document.getElementById("overview").innerText);
  check("mustfix 27: example.json shows no measured 0 for absent fields (no 'utilization 0', no '0 s' run)", !/utilization\s*0(\.0)?\s*%|ran for 0\s?s/i.test(txt), txt.slice(0, 160));
  await ex.context.close();
}

// ── 7. §6.1 budgets (perf.json) ──
const LONGTASKS = () => {
  window.__lt = [];
  window.__ev = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__ev.push([e.name, e.duration]);
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {}
};
async function heapMB(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const u = await cdp.send("Runtime.getHeapUsage");
  await cdp.detach();
  return Math.round((u.usedSize / 1048576) * 10) / 10;
}
const nextPaint = (page, fn) =>
  page.evaluate(
    (src) =>
      new Promise((res) => {
        const t0 = performance.now();
        (0, eval)(src)();
        requestAnimationFrame(() => setTimeout(() => res(Math.round((performance.now() - t0) * 10) / 10), 0));
      }),
    `(${fn})`,
  );
if (want("perf")) {
  for (const fx of ["huge", "ml-training"]) {
    const budget = fx === "huge" ? { model: 250, overview: 1000, long: 200, nodes: 8000, toggle: 100, heap: 300, hover: 50 } : { model: 40, overview: 300, long: 100, nodes: 5000, toggle: 60, heap: 80, hover: 30 };
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const { context, page } = await openPage(browser, fx, { w: 1440, h: 900, q: "", init: LONGTASKS });
      await settle(page);
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const t = performance.timing;
        const dcl = t.domContentLoadedEventStart - t.navigationStart;
        const mark = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
        const ov = mark("scalene:overview");
        return {
          // load() entry → model built (normalize, model, rankings; §6.1 "model.build()").
          model: Math.round(mark("scalene:model") - (mark("scalene:load") ?? dcl)),
          overview: Math.round(ov - dcl),
          longAfter: window.__lt.filter(([s]) => s > ov).map(([, d]) => Math.round(d)),
          nodes: document.querySelectorAll("*").length,
        };
      });
      r.heap = await heapMB(page);
      runs.push(r);
      if (k === 2) {
        // Interaction timings on the last run: hover a hotspot, theme toggle ×3, file switch, sort.
        await page.mouse.move(5, 5);
        await page.waitForTimeout(300);
        await page.evaluate(() => (window.__ev = []));
        // Hover moves between hotspot rows, one per 300 ms (Event Timing durations, input → paint).
        for (const i of [1, 3, 2, 5, 1]) {
          const row = await page.locator("#overview .hs-row").nth(i).boundingBox();
          await page.mouse.move(row.x + 60, row.y + row.height / 2);
          await page.waitForTimeout(300);
        }
        const hoverEv = await page.evaluate(() => window.__ev.filter(([n]) => n === "mouseenter").map(([, d]) => Math.round(d)));
        const theme = [];
        for (let i = 0; i < 3; i++) {
          theme.push(await nextPaint(page, () => document.querySelector("header.appbar .appbar-theme").click()));
          await page.waitForTimeout(300);
        }
        await page.evaluate(() => document.getElementById("code").scrollIntoView({ block: "start" }));
        await page.waitForTimeout(800);
        const fileSwitch = [];
        for (let i = 0; i < 2; i++) {
          fileSwitch.push(
            await nextPaint(page, () => {
              const tabs = Array.from(document.querySelectorAll("#code [role='tab']"));
              const cur = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
              (tabs[(cur + 1) % tabs.length] ?? tabs[0])?.click();
            }),
          );
          await page.waitForTimeout(400);
        }
        const sort = [];
        for (let i = 0; i < 2; i++) {
          sort.push(await nextPaint(page, () => document.querySelector("#code .cv-h[data-col='time'] .cv-h-btn, #code .cv-h-btn")?.click()));
          await page.waitForTimeout(400);
        }
        Object.assign(r, { hoverEventsOver16: hoverEv, theme, fileSwitch, sort });
      }
      await context.close();
    }
    const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[1];
    const last = runs[2];
    const longMax = Math.max(0, ...runs.flatMap((r) => r.longAfter));
    perf[fx] = { budget, runs, median: { model: med("model"), overview: med("overview"), nodes: med("nodes"), heap: med("heap") }, longMax, theme: last.theme, fileSwitch: last.fileSwitch, sort: last.sort, hoverEventsOver16: last.hoverEventsOver16 };
    check(`perf ${fx}: DCL → model ≤ ${budget.model} ms`, med("model") <= budget.model, `${med("model")} ms (runs ${runs.map((r) => r.model).join("/")})`);
    check(`perf ${fx}: DCL → scalene:overview ≤ ${budget.overview} ms`, med("overview") <= budget.overview, `${med("overview")} ms (runs ${runs.map((r) => r.overview).join("/")})`);
    check(`perf ${fx}: no long task > ${budget.long} ms after scalene:overview`, longMax <= budget.long, `max ${longMax} ms; ${JSON.stringify(runs.map((r) => r.longAfter))}`);
    check(`perf ${fx}: DOM nodes after load < ${budget.nodes}`, med("nodes") < budget.nodes, `${med("nodes")}`);
    check(`perf ${fx}: JS heap after load < ${budget.heap} MB`, med("heap") < budget.heap, `${med("heap")} MB`);
    // Event Timing durations (input → next paint, 8 ms granularity); headless software raster adds
    // a frame now and then, so the check is on the median and the max is reported.
    const hv = [...last.hoverEventsOver16].sort((a, b) => a - b);
    const hvMed = hv.length ? hv[Math.floor(hv.length / 2)] : 0;
    perf[fx].hoverMedian = hvMed;
    check(`perf ${fx}: hotspot hover event duration median < ${budget.hover} ms`, hvMed < budget.hover, `median ${hvMed} ms; distinct durations ≥ 16 ms: ${JSON.stringify(last.hoverEventsOver16)}`);
    check(`perf ${fx}: theme toggle → next paint < ${budget.toggle} ms`, last.theme.every((d) => d < budget.toggle), `${last.theme.join(" / ")} ms`);
    check(`perf ${fx}: file switch → next paint < ${budget.toggle} ms`, last.fileSwitch.every((d) => d < budget.toggle), `${last.fileSwitch.join(" / ")} ms`);
    check(`perf ${fx}: column sort → next paint < ${budget.toggle} ms`, last.sort.every((d) => d < budget.toggle), `${last.sort.join(" / ")} ms`);
  }
}

// ── 8. Resize storm (major resize-relayouts-every-section) ──
if (want("resize")) {
  for (const fx of ["ml-training", "huge"]) {
    const { context, page } = await openPage(browser, fx, { w: 1440, h: 900, q: "still", init: LONGTASKS });
    await settle(page);
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      window.__lt = [];
      window.__frames = [];
      let last = performance.now();
      const loop = (t) => {
        window.__frames.push(t - last);
        last = t;
        if (!window.__stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    for (let w = 1440; w >= 1280; w -= 8) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      window.__stop = true;
      const f = window.__frames.slice(1).sort((a, b) => a - b);
      const p95 = f[Math.floor(f.length * 0.95)] ?? 0;
      return { frames: f.length, p95: Math.round(p95 * 10) / 10, max: Math.round((f[f.length - 1] ?? 0) * 10) / 10, longTasks: window.__lt.map(([, d]) => Math.round(d)), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    perf[`resize-${fx}`] = r;
    check(`resize ${fx}: 1440→1280 drag in 8 px steps: no long task > 50 ms, frame p95 ≤ 34 ms, no overflow`, r.longTasks.every((d) => d <= 50) && r.p95 <= 34 && r.overflow === 0, r);
    await context.close();
  }
}

// ── 9. Signature intro at 2560 dark (major glow-plus-lighter-drops-frames) ──
if (want("intro")) {
  const fps = [];
  for (let k = 0; k < 3; k++) {
    const { context, page } = await openPage(browser, "ml-training", {
      w: 2560,
      h: 1440,
      theme: "dark",
      q: "",
      init: () => {
        window.__frames = [];
        let last = performance.now();
        const loop = (t) => {
          window.__frames.push([t, t - last]);
          last = t;
          if (t < 4000) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      },
    });
    await settle(page);
    await page.waitForTimeout(1600);
    const r = await page.evaluate(() => {
      const ov = performance.getEntriesByName("scalene:overview")[0]?.startTime ?? 0;
      // Frames that start after the overview paint, during the sweep (M4: 120 → 760 ms) and the
      // whole intro window (0 → 900 ms); the frame that spans the boot render is excluded.
      const stat = (a, b) => {
        const win = window.__frames.filter(([t, d]) => t - d >= ov + a && t <= ov + b);
        const span = win.reduce((s, [, d]) => s + d, 0);
        return { fps: span ? Math.round((win.length / span) * 1000 * 10) / 10 : 0, maxGap: Math.round(Math.max(0, ...win.map(([, d]) => d)) * 10) / 10 };
      };
      const sweep = stat(120, 760);
      const intro = stat(0, 900);
      return { fps: sweep.fps, maxGap: sweep.maxGap, introFps: intro.fps, introMaxGap: intro.maxGap };
    });
    fps.push(r);
    await context.close();
  }
  perf.intro2560dark = fps;
  check("intro: ml-training 2560×1440 dark sweep (120–760 ms) runs at ≥ 55 fps, no frame > 50 ms (3 runs)", fps.every((r) => r.fps >= 55 && r.maxGap <= 50), fps);
}

fs.mkdirSync(path.join(outDir, "e2e"), { recursive: true });
if (Object.keys(perf).length) {
  const file = path.join(outDir, "e2e", "perf.json");
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...perf, at: new Date().toISOString() }, null, 2));
}
await browser.close();
process.exit(finish());
