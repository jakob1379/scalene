#!/usr/bin/env node
// Code view acceptance (DESIGN.md §8.6 WP3), folded in from design/screens/wp3/wp3-check.cjs:
// column sets per fixture, display modes/folds vs the upstream predicates, sorting cycle,
// jumpTo from hotspots/palette/flame landing focused with the lens open, DOM budget on huge
// sparse.py, scroll frame times, role=table semantics, minimap slider keyboard, dock ≥ 1600,
// wrap on xs without overflow, function view.
//   node tools/e2e/code.mjs [--only columns,modes,...]
import path from "node:path";
import { chromium, createReport, onlyFilter, root } from "./_env.mjs";

const report = createReport("code");
const check = (name, ok, detail) => report.check(name, ok, detail === undefined ? "" : detail);
const T = onlyFilter();

async function open(browser, fixture, w, hgt, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: w, height: hgt },
    colorScheme: opts.theme || "light",
    isMobile: !!opts.mobile,
    hasTouch: !!opts.mobile,
    deviceScaleFactor: opts.mobile ? 3 : 1,
    reducedMotion: opts.reduce ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + path.join(root, "out", fixture + ".html") + (opts.anim ? "" : "?still"));
  await page.waitForTimeout(250);
  // Force-mount the code section (as nav/jumpTo do).
  await page.evaluate(() => document.getElementById("code").scrollIntoView({ block: "start" }));
  await page.waitForFunction(() => !!(document.getElementById("code") && document.getElementById("code").__code));
  await page.waitForTimeout(200);
  return { page, context, errors };
}


(async () => {
  const browser = await chromium.launch();

  // 1. Column sets per fixture at 2560.
  if (T("columns")) {
    const want = {
      "ml-training": "line,time,mem,gpu,trend,copy,gpumem,alloc,avg,source",
      neuron: null,
      "cpu-only": "line,time,source",
    };
    for (const fx of Object.keys(want)) {
      const { page, context, errors } = await open(browser, fx, 2560, 1440);
      const cols = await page.evaluate(() => document.getElementById("code").__code.table().columns.join(","));
      if (fx === "neuron") {
        check(`columns ${fx} @2560 has idle/nrt/nc, no GPU`, /idle/.test(cols) && /nrt/.test(cols) && /nc/.test(cols) && !/gpu/.test(cols), cols);
      } else check(`columns ${fx} @2560`, cols === want[fx], cols);
      check(`no console errors ${fx}`, errors.length === 0, errors.slice(0, 3));
      await context.close();
    }
  }

  // 2. Display modes / folds: ml train.py "Profiled functions" lists every data row.
  if (T("modes")) {
    const { page, context } = await open(browser, "ml-training", 1440, 900);
    const r = await page.evaluate(() => {
      const d = document.getElementById("code").__code.table();
      const listed = new Set(d.items.filter((i) => i.kind === "line").map((i) => i.line.no));
      const file = d.items.find((i) => i.kind === "line").line.file;
      const data = file.lines.filter((l) => l.cls === "data").map((l) => l.no);
      const missing = data.filter((n) => !listed.has(n));
      const folds = d.items.filter((i) => i.kind === "fold").length;
      return { file: file.base, data: data.length, listed: listed.size, missing, folds };
    });
    check("ml train.py Profiled functions shows every data row", r.file === "train.py" && r.missing.length === 0 && r.folds > 0, r);
    // Rendered DOM: every rendered data row is a line row, and no rendered fold hides a data line.
    const dom = await page.evaluate(async () => {
      const bad = [];
      const step = 300;
      const code = document.getElementById("code");
      const top = code.getBoundingClientRect().top + scrollY;
      const end = top + code.offsetHeight;
      const d = document.getElementById("code").__code.table();
      const file = d.items.find((i) => i.kind === "line").line.file;
      const dataNos = new Set(file.lines.filter((l) => l.cls === "data").map((l) => l.no));
      const seen = new Set();
      for (let y = top; y < end; y += step) {
        scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const row of code.querySelectorAll(".cv-body > .cv-row.cv-line")) seen.add(Number(row.dataset.key.slice(2)));
        for (const f of code.querySelectorAll(".cv-body > .cv-row.cv-fold .cv-fold-text")) {
          const m = /·\s*(\d+)(?:–(\d+))?/.exec(f.textContent);
          if (!m) continue;
          const a = +m[1], b = +(m[2] || m[1]);
          for (const n of dataNos) if (n >= a && n <= b) bad.push(n);
        }
      }
      const unseen = [...dataNos].filter((n) => !seen.has(n));
      return { bad, unseen };
    });
    check("DOM: no data row inside a fold; every data row rendered while scrolling", dom.bad.length === 0 && dom.unseen.length === 0, dom);
    // Hot lines / All lines counts.
    const counts = await page.evaluate(async () => {
      const seg = document.getElementById("display-mode-file-1");
      const out = {};
      for (const [label, btn] of [["hot", 1], ["all", 2], ["pf", 0]]) {
        seg.querySelectorAll('[role="radio"]')[btn].click();
        await new Promise((r) => setTimeout(r, 60));
        const d = document.getElementById("code").__code.table();
        out[label] = { lines: d.items.filter((i) => i.kind === "line").length, folds: d.items.filter((i) => i.kind === "fold").length, value: seg.value };
      }
      return out;
    });
    check("display modes: hot < pf < all lines; all has no folds", counts.hot.lines < counts.pf.lines && counts.pf.lines < counts.all.lines && counts.all.folds === 0 && counts.all.lines === 193, counts);
    // Fold reveal: click the first fold reveals only that fold.
    const fold = await page.evaluate(async () => {
      const d0 = document.getElementById("code").__code.table();
      const before = d0.items.filter((i) => i.kind === "fold").length;
      document.getElementById("code").scrollIntoView();
      await new Promise((r) => setTimeout(r, 100));
      const f = document.querySelector("#code .cv-row.cv-fold");
      f.click();
      await new Promise((r) => setTimeout(r, 100));
      const d1 = document.getElementById("code").__code.table();
      return { before, after: d1.items.filter((i) => i.kind === "fold").length, mode: document.getElementById("display-mode-file-1").value };
    });
    check("fold click reveals exactly one fold, mode unchanged", fold.after === fold.before - 1 && fold.mode === "profiled-functions", fold);
    await context.close();
  }

  // 3. Sorting cycle + aria.
  if (T("sort")) {
    const { page, context } = await open(browser, "ml-training", 1440, 900);
    const r = await page.evaluate(async () => {
      const q = (s) => document.querySelector(s);
      const states = [];
      const firstRows = [];
      for (let i = 0; i < 3; i++) {
        q('#code .cv-h-time .cv-h-btn').click();
        await new Promise((r) => setTimeout(r, 80));
        const d = document.getElementById("code").__code.table();
        states.push(q("#code .cv-h-time").getAttribute("aria-sort") + "/" + q("#code .cv-h-line").getAttribute("aria-sort"));
        firstRows.push(d.items[0].key);
      }
      const t = q("#code .cv-table");
      const rows = [...document.querySelectorAll("#code .cv-body > .cv-row")];
      return {
        states, firstRows,
        role: t.getAttribute("role"), rowcount: t.getAttribute("aria-rowcount"),
        items: document.getElementById("code").__code.table().items.length,
        rowindexOk: rows.every((r) => +r.getAttribute("aria-rowindex") >= 2),
        headerRole: q("#code .cv-head").getAttribute("role") + ">" + q("#code .cv-head-row").getAttribute("role"),
        cells: rows.filter((r) => r.classList.contains("cv-line")).every((r) => [...r.children].every((c) => c.getAttribute("role") === "cell")),
        label: rows.find((r) => r.classList.contains("cv-line"))?.getAttribute("aria-label"),
      };
    });
    check("sort cycle desc → asc → source", r.states.join(",") === "descending/none,ascending/none,none/ascending", r.states);
    check("ranked order puts the hottest line first (L:173) then source order", r.firstRows[0] === "L:173" && r.firstRows[2] !== "L:173", r.firstRows);
    check("role=table with aria-rowcount = items + header", r.role === "table" && +r.rowcount === r.items + 1, { rowcount: r.rowcount, items: r.items });
    check("rowgroup > row > columnheader; rows have aria-rowindex and role=cell children", r.headerRole === "rowgroup>row" && r.rowindexOk && r.cells, r.headerRole);
    check("row aria-label summarises columns", /^Line \d+, .*: /.test(r.label || ""), r.label);
    await context.close();
  }

  // 4. jumpTo lands focused on the row with the lens open (lg) / dock (xl).
  if (T("jump")) {
    for (const [w, hgt, expect] of [[1440, 900, "lens"], [1599, 900, "lens"], [1600, 900, "dock"], [390, 844, "lens"]]) {
      const { page, context } = await open(browser, "ml-training", w, hgt, { mobile: w < 600 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.evaluate(() => vsNavigate(escape("/home/dev/llm-train/train.py"), 173));
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const a = document.activeElement;
        const lens = document.querySelector("#code .cv-lens");
        const dock = document.querySelector("#code .code-dock");
        const rect = a.getBoundingClientRect();
        return {
          focused: a.dataset ? a.dataset.key : null,
          lens: lens ? lens.getAttribute("aria-label") : null,
          lensVisible: lens ? lens.getBoundingClientRect().top < innerHeight : false,
          dock: dock && !dock.hidden ? dock.getAttribute("aria-label") : null,
          rowTop: Math.round(rect.top), vh: innerHeight,
          sel: !!document.querySelector('#code .cv-row.is-selected[data-key="L:173"]'),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      const okPanel = expect === "lens" ? r.lens === "Details for train.py line 173" && r.lensVisible : r.dock === "Details for train.py line 173" && !r.lens;
      check(`jumpTo @${w}: focus on L:173, ${expect} open, row visible`, r.focused === "L:173" && okPanel && r.sel && r.rowTop > 0 && r.rowTop < r.vh && r.overflow === 0, r);
      await context.close();
    }
    // Jump into a folded line and a hidden-file / other file + function target.
    const { page, context } = await open(browser, "ml-training", 1440, 900);
    const r = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 50));
      vsNavigate(escape("/home/dev/llm-train/train.py"), 5); // inside the first fold
      await new Promise((r) => setTimeout(r, 300));
      const a = document.activeElement.dataset.key;
      const mode = document.getElementById("display-mode-file-1").value;
      return { a, mode };
    });
    check("jumpTo a folded line reveals its fold only (mode kept)", r.a === "L:5" && r.mode === "profiled-functions", r);
    await context.close();
  }

  // 4b. Real entry points with motion on and the code section NOT yet mounted: hotspot click,
  // hotspot keyboard (Enter), and the vsNavigate global (palette / flame / findings share
  // nav.jumpTo). Each must land focused on the row with the detail open and the row on screen.
  if (T("entry")) {
    const landing = async (page) =>
      page.evaluate(() => {
        const a = document.activeElement;
        const lens = document.querySelector("#code .cv-lens");
        const dock = document.querySelector("#code .code-dock");
        const r = a.getBoundingClientRect();
        return {
          focused: a.dataset ? a.dataset.key || null : null,
          panel: lens ? lens.getAttribute("aria-label") : dock && !dock.hidden ? dock.getAttribute("aria-label") : null,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          vh: innerHeight,
          flash: !!document.querySelector("#code .cv-row.m-flash"),
        };
      });
    for (const [w, hgt, theme] of [[1440, 900, "dark"], [1920, 1080, "light"], [1000, 400, "light"]]) {
      const context = await browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      // WP5's in-progress controller can reject with AbortError on load (requests/wp3.md §3).
      page.on("pageerror", (e) => { if (!/AbortError/.test(String(e))) errors.push(String(e)); });
      await page.goto("file://" + path.join(root, "out", "ml-training.html"));
      await page.waitForTimeout(1200); // intro settles; code is not mounted yet
      const mountedBefore = await page.evaluate(() => !!document.getElementById("code").__code);
      const row = page.locator(".hs-row").first();
      const label = await row.getAttribute("aria-label");
      await row.click();
      await page.waitForTimeout(1600);
      const r = await landing(page);
      check(`hotspot #1 click @${w}x${hgt}: lands focused on L:173 with details`, r.focused === "L:173" && /line 173/.test(r.panel || "") && r.top >= 0 && r.bottom <= r.vh && errors.length === 0, { ...r, mountedBefore, label, errors });
      // Keyboard: back to the top, focus the hotspot list, ArrowDown to #2, Enter.
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(300);
      await page.locator(".hs-row").nth(1).focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1600);
      const k = await landing(page);
      check(`hotspot #2 Enter @${w}x${hgt}: focus on L:165 with details`, k.focused === "L:165" && /line 165/.test(k.panel || "") && k.top >= 0 && k.bottom <= k.vh, k);
      // Another file (loader.py:33) through the global used by every other entry point.
      await page.evaluate(() => vsNavigate(escape("/home/dev/llm-train/data/loader.py"), 33));
      await page.waitForTimeout(1600);
      const g = await landing(page);
      const file = await page.evaluate(() => document.getElementById("code").__code.file());
      check(`vsNavigate loader.py:33 @${w}x${hgt}: file switched, focus on L:33 with details`, /loader\.py$/.test(file) && g.focused === "L:33" && /line 33/.test(g.panel || "") && g.top >= 0 && g.bottom <= g.vh, { ...g, file });
      await context.close();
    }
  }

  // 4i. Palette (WP5) and flame (WP4) entry points: same landing contract.
  if (T("palflame")) {
    const landing = (page) =>
      page.evaluate(() => {
        const a = document.activeElement;
        const lens = document.querySelector("#code .cv-lens");
        const r = a.getBoundingClientRect();
        return { key: a.dataset ? a.dataset.key || null : null, inCode: document.getElementById("code").contains(a), panel: lens ? lens.getAttribute("aria-label") : null, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
      });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto("file://" + path.join(root, "out", "ml-training.html"));
    await page.waitForTimeout(1200);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await page.keyboard.type("loss.item", { delay: 20 });
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1600);
    const p1 = await landing(page);
    check("palette 'loss.item' → Enter: lands focused on the row with the lens open", /^L:\d+$/.test(p1.key || "") && p1.inCode && p1.panel && p1.panel.endsWith(`line ${p1.key.slice(2)}`) && p1.top >= 0 && p1.bottom <= p1.vh, p1);
    // Flame: keyboard into the CPU flame, walk down the heaviest path, `g` = go to source.
    await page.evaluate(() => { scrollTo(0, 0); });
    const cv = await page.evaluate(() => !!document.querySelector('#stacks canvas[role="application"], #stacks [role="application"]'));
    let f1 = null;
    if (cv) {
      await page.evaluate(() => document.getElementById("stacks").scrollIntoView());
      await page.waitForTimeout(600);
      await page.keyboard.press("Tab"); // establish keyboard modality
      await page.evaluate(() => document.querySelector('#stacks [role="application"]').focus());
      await page.waitForTimeout(100);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(40);
        await page.keyboard.press("g");
        await page.waitForTimeout(1400);
        f1 = await landing(page);
        if (f1.inCode) break;
        await page.evaluate(() => document.querySelector('#stacks [role="application"]').focus());
      }
    }
    check("flame keyboard `g` → lands focused on the row with the lens open", !cv || (f1 && /^L:\d+$/.test(f1.key || "") && f1.panel && f1.panel.endsWith(`line ${f1.key.slice(2)}`) && f1.top >= 0 && f1.bottom <= f1.vh), { flame: cv, f1 });
    await context.close();
  }

  // 4c. Row content integrity across file switches: item keys repeat between files (L:51 in
  // both), so pooled rows must re-render. Every rendered line row must show its own file's
  // text and number, and every fold its own range.
  if (T("content")) {
    const sameAsModel = (page) =>
      page.evaluate(() => {
        const d = document.getElementById("code").__code.table();
        const byKey = new Map(d.items.map((i) => [i.key, i]));
        const bad = [];
        let n = 0;
        for (const el of document.querySelectorAll("#code .cv-body > .cv-row.cv-line")) {
          const it = byKey.get(el.dataset.key);
          const shown = (el.querySelector(".cv-src") || {}).textContent.replace(/\n/g, "");
          const want = it && it.line ? it.line.text.replace(/\t/g, "    ") : null;
          const num = el.querySelector(".cv-c-line").textContent;
          n++;
          if (!it || shown !== want || num !== String(it.line.no)) bad.push({ key: el.dataset.key, shown: shown.slice(0, 40), want: want && want.slice(0, 40) });
        }
        for (const el of document.querySelectorAll("#code .cv-body > .cv-row.cv-fold")) {
          const it = byKey.get(el.dataset.key);
          const txt = el.textContent;
          n++;
          if (!it || !txt.includes(it.start === it.end ? `· ${it.start}` : `· ${it.start}–${it.end}`)) bad.push({ key: el.dataset.key, txt: txt.slice(0, 60) });
        }
        return { n, bad: bad.slice(0, 5), file: document.getElementById("code").__code.file() };
      });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto("file://" + path.join(root, "out", "async-server.html") + "?still");
    await page.waitForTimeout(300);
    await page.evaluate(() => vsNavigate(escape("/srv/catalog-api/bench_server.py"), 51));
    await page.waitForTimeout(500);
    const a = await sameAsModel(page);
    await page.evaluate(() => vsNavigate(escape("/srv/catalog-api/catalog/handlers.py"), 51));
    await page.waitForTimeout(500);
    const b = await sameAsModel(page);
    // Switch through the tab strip as well (no jump), in All lines mode.
    await page.evaluate(() => expandAll());
    await page.waitForTimeout(200);
    await page.evaluate(() => [...document.querySelectorAll("#code .fn-tab")].find((t) => /cache\.py/.test(t.textContent)).click());
    await page.waitForTimeout(300);
    const c = await sameAsModel(page);
    check("file switch: every rendered row shows its own file's line text and number", a.bad.length === 0 && b.bad.length === 0 && c.bad.length === 0 && /handlers/.test(b.file) && /cache/.test(c.file), { a, b, c });
    await context.close();
  }

  // 4e. Table keyboard (§4.8.11): one tab stop, arrows / j k / PageDown / Home / End move
  // (always on screen, under the sticky chrome), Enter toggles the detail, Esc closes it, then
  // clears the selection.
  if (T("keys")) {
    const { page, context } = await open(browser, "ml-training", 1440, 900);
    const state = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        const r = a.getBoundingClientRect();
        const inset = 52 + 40 + 32;
        return {
          key: a.dataset ? a.dataset.key || null : null,
          onScreen: r.top >= inset - 1 && r.bottom <= innerHeight + 1,
          stops: document.querySelectorAll('#code .cv-body [tabindex="0"]').length,
          lens: !!document.querySelector("#code .cv-lens"),
          sel: document.querySelector("#code .cv-row.is-selected")?.dataset.key || null,
        };
      });
    await page.evaluate(() => document.querySelector('#code .cv-body [tabindex="0"]').focus());
    const s0 = await state();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("j");
    const s1 = await state();
    await page.keyboard.press("k");
    const s2 = await state();
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(100);
    const s3 = await state();
    await page.keyboard.press("End");
    await page.waitForTimeout(100);
    const s4 = await state();
    await page.keyboard.press("Home");
    await page.waitForTimeout(100);
    const s5 = await state();
    // To a data row (17), open, close, clear.
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    const s6 = await state();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const s7 = await state();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const s8 = await state();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    const s9 = await state();
    const ok =
      s0.stops === 1 && s1.key !== s0.key && s2.key !== s1.key && s3.onScreen && s4.onScreen && s5.key === s0.key &&
      s7.lens && s7.sel === s6.key && s7.key === s6.key && !s8.lens && s8.sel === s6.key && s8.key === s6.key && !s9.sel && [s1, s2, s3, s4, s5, s6].every((x) => x.onScreen && x.stops === 1);
    check("table keyboard: one tab stop; ↓ j k PgDn End Home stay on screen; Enter opens, Esc closes, Esc clears", ok, { s0, s1, s2, s3, s4, s5, s6, s7, s8, s9 });
    await context.close();
  }

  // 4f. Upstream globals that drive the code section (§7.3, §4.8.5).
  if (T("globals")) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto("file://" + path.join(root, "out", "ml-training.html") + "?still");
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const code = document.getElementById("code");
      const seg = () => document.querySelector('[id^="display-mode-file-"]');
      const out = {};
      toggleDisplay("file-3");
      await wait(150);
      out.toggle = [code.__code.file().split("/").pop(), seg().id, Math.round(code.getBoundingClientRect().top) < innerHeight];
      expandAll();
      await wait(100);
      out.expand = seg().value;
      collapseAll();
      await wait(100);
      out.collapse = seg().value;
      seg().value = "profiled-functions";
      onFileDisplayModeChange("file-3");
      await wait(100);
      out.onchange = [seg().value, code.__code.table().items.filter((i) => i.kind === "fold").length > 0];
      return out;
    });
    check("globals: toggleDisplay(file-N), expandAll, collapseAll, onFileDisplayModeChange", r.toggle[0] === "adamw.py" && r.toggle[1] === "display-mode-file-3" && r.toggle[2] && r.expand === "all" && r.collapse === "profiled-lines" && r.onchange[0] === "profiled-functions", r);
    await context.close();
  }

  // 4g. Reduced motion (§5.4): jump lands instantly, sort / lens / file switch never move
  // anything (no transform/translate animations inside #code); the flash (colour) stays.
  if (T("reduce")) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("file://" + path.join(root, "out", "ml-training.html"));
    await page.waitForTimeout(600);
    const anims = () =>
      page.evaluate(() =>
        document.getAnimations()
          .filter((a) => a.effect && a.effect.target && document.getElementById("code").contains(a.effect.target))
          .map((a) => {
            const kf = a.effect.getKeyframes();
            const props = [...new Set(kf.flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p))))];
            return { props: props.join(","), dur: a.effect.getTiming().duration };
          }),
      );
    await page.evaluate(() => vsNavigate(escape("/home/dev/llm-train/train.py"), 173));
    await page.waitForTimeout(40);
    const a1 = await page.evaluate(() => ({ key: document.activeElement.dataset.key, top: Math.round(document.activeElement.getBoundingClientRect().top) }));
    const j = await anims();
    await page.evaluate(() => document.querySelector("#code .cv-h-time .cv-h-btn").click());
    await page.waitForTimeout(30);
    const s1 = await anims();
    const acted = await page.evaluate(() => !!document.querySelector("#code .cv-row.is-acted"));
    await page.evaluate(() => [...document.querySelectorAll("#code .fn-tab")][1].click());
    await page.waitForTimeout(30);
    const f1 = await anims();
    const all = [...j, ...s1, ...f1];
    const moving = all.filter((x) => /transform|translate|scale|top|left|height/.test(x.props));
    const longOpacity = all.filter((x) => x.props === "opacity" && x.dur > 120);
    check("reduced motion: instant jump, no moving animations in the code view, flash kept, acted highlight on sort", a1.key === "L:173" && a1.top > 0 && a1.top < 900 && moving.length === 0 && longOpacity.length === 0 && j.some((x) => /background/.test(x.props)) && acted, { a1, j, s1, f1, acted });
    await context.close();
  }

  // 4h. Motion allowed: sort = FLIP translate on ≤ 60 rows, 280 ms (M9); lens open slides the
  // rows below (M16, 200 ms); file switch = 120 ms opacity cross-fade (M10).
  if (T("motion")) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto("file://" + path.join(root, "out", "ml-training.html"));
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById("code").scrollIntoView());
    await page.waitForTimeout(500);
    const anims = () =>
      page.evaluate(() =>
        document.getAnimations()
          .filter((a) => a.effect && a.effect.target && document.getElementById("code").contains(a.effect.target))
          .map((a) => ({ props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p))))].join(","), dur: a.effect.getTiming().duration })),
      );
    await page.evaluate(() => document.querySelector("#code .cv-h-time .cv-h-btn").click());
    await page.waitForTimeout(20);
    const sort = await anims();
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector("#code .cv-h-line .cv-h-btn").click());
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#code .cv-row.cv-line[data-key="L:17"]').click());
    await page.waitForTimeout(20);
    const lens = await anims();
    await page.waitForTimeout(400);
    await page.evaluate(() => [...document.querySelectorAll("#code .fn-tab")][1].click());
    await page.waitForTimeout(20);
    const sw = await anims();
    const flips = sort.filter((x) => x.props === "translate");
    const ok = flips.length > 0 && flips.length <= 60 && flips.every((x) => x.dur === 280) && lens.some((x) => x.props === "translate" && x.dur === 200) && sw.some((x) => x.props === "opacity" && x.dur === 120);
    check("motion: sort FLIP ≤ 60 rows @280 ms, lens slides rows @200 ms, file cross-fade 120 ms", ok, { flips: flips.length, sortDur: [...new Set(sort.map((x) => x.props + ":" + x.dur))], lens: [...new Set(lens.map((x) => x.props + ":" + x.dur))], sw: [...new Set(sw.map((x) => x.props + ":" + x.dur))] });
    await context.close();
  }

  // 4d. Overflow matrix (§6.2.9) with the code section mounted and the detail open.
  if (T("overflow")) {
    const out = [];
    for (const fx of ["ml-training", "huge", "neuron"]) {
      for (const w of [320, 360, 390, 600, 1024, 1440, 2560]) {
        const phone = w <= 390;
        const context = await browser.newContext({ viewport: { width: w, height: phone ? 780 : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1 });
        const page = await context.newPage();
        await page.goto("file://" + path.join(root, "out", fx + ".html") + "?still");
        await page.waitForTimeout(200);
        const target = fx === "ml-training" ? ["/home/dev/llm-train/train.py", 173] : fx === "neuron" ? ["/home/ubuntu/neuron-bert/infer_bert.py", 66] : ["/opt/bigsim/src/bigsim/physics/fluids.py", 495];
        await page.evaluate(([f, l]) => vsNavigate(escape(f), l), target);
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, scale: visualViewport.scale, panel: !!(document.querySelector("#code .cv-lens") || document.querySelector("#code .code-dock:not([hidden]) .cd-head")) }));
        if (r.sw !== r.cw || r.scale !== 1 || !r.panel) out.push({ fx, w, ...r });
        await context.close();
      }
    }
    check("overflow matrix 320–2560 (ml, huge, neuron) with the detail open: no horizontal overflow", out.length === 0, out);
  }

  // 5. DOM budget on huge sparse.py in All lines + scroll smoothness.
  if (T("dom")) {
    for (const [w, hgt] of [[1440, 900], [2560, 1440]]) {
      const { page, context } = await open(browser, "huge", w, hgt);
      const r = await page.evaluate(async () => {
        const code = document.getElementById("code");
        const f = [...document.querySelectorAll("#code .fn-tab, #code .fn-rail-item")].find((t) => (t.dataset.file || "").endsWith("/sparse.py"));
        f.click();
        await new Promise((r) => setTimeout(r, 100));
        expandAll();
        await new Promise((r) => setTimeout(r, 100));
        const d = code.__code.table();
        const top = code.getBoundingClientRect().top + scrollY;
        let max = 0;
        let maxRendered = 0;
        for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          scrollTo(0, top + frac * code.offsetHeight);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          max = Math.max(max, code.querySelectorAll("*").length);
          maxRendered = Math.max(maxRendered, code.__code.table().rendered);
        }
        // Scroll smoothness: 120 frames of 48 px.
        scrollTo(0, top + 200);
        await new Promise((r) => requestAnimationFrame(r));
        const deltas = [];
        let last = performance.now();
        await new Promise((resolve) => {
          let n = 0;
          const tick = (t) => {
            deltas.push(t - last);
            last = t;
            scrollBy(0, 48);
            if (++n < 120) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        deltas.shift();
        deltas.sort((a, b) => a - b);
        return {
          file: code.__code.file(), lines: d.items.filter((i) => i.kind === "line").length,
          maxNodes: max, maxRendered, all: document.querySelectorAll("*").length,
          p50: +deltas[Math.floor(deltas.length * 0.5)].toFixed(1), p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1), worst: +deltas[deltas.length - 1].toFixed(1),
        };
      });
      check(`huge sparse.py All lines @${w}x${hgt}: code view < 2,500 DOM nodes`, r.maxNodes < 2500 && r.lines === 1283, r);
      // Scroll smoothness of the code view itself: 240 frames of 24 px with the app bar's
      // backdrop blur neutralised (WP1's layer; it dominates software-raster frames at
      // 2560, see design/requests/wp3.md). The page as shipped is reported alongside.
      const run = (css) =>
        page.evaluate(async (css) => {
          const st = document.createElement("style");
          st.textContent = css;
          document.head.append(st);
          const code = document.getElementById("code");
          scrollTo(0, code.getBoundingClientRect().top + scrollY + 200);
          await new Promise((r) => setTimeout(r, 200));
          const deltas = [];
          let last = performance.now();
          await new Promise((resolve) => {
            let n = 0;
            const tick = (t) => {
              deltas.push(t - last);
              last = t;
              scrollBy(0, 24);
              if (++n < 240) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          });
          st.remove();
          deltas.shift();
          const slow = deltas.filter((d) => d > 20).length;
          deltas.sort((a, b) => a - b);
          return { p50: +deltas[Math.floor(deltas.length * 0.5)].toFixed(1), p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1), worst: +deltas[deltas.length - 1].toFixed(1), slow };
        }, css);
      const own = await run(".appbar{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}");
      const shipped = await run("");
      check(`huge sparse.py scroll @${w}: code view p95 frame ≤ 20 ms (60 fps)`, own.p95 <= 20, { own, shipped, first: { p50: r.p50, p95: r.p95, worst: r.worst } });
      await context.close();
    }
  }

  // 6. Minimap slider keyboard.
  if (T("minimap")) {
    const { page, context } = await open(browser, "ml-training", 1440, 900);
    const r = await page.evaluate(() => {
      const s = document.querySelector("#code .cv-ribbon");
      return { role: s.getAttribute("role"), label: s.getAttribute("aria-label"), min: s.getAttribute("aria-valuemin"), max: s.getAttribute("aria-valuemax"), now: s.getAttribute("aria-valuenow") };
    });
    await page.focus("#code .cv-ribbon");
    await page.keyboard.press("Home");
    await page.waitForTimeout(100);
    const home = await page.evaluate(() => document.querySelector("#code .cv-ribbon").getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    const s1 = await page.evaluate(() => ({ now: document.querySelector("#code .cv-ribbon").getAttribute("aria-valuenow"), text: document.querySelector("#code .cv-ribbon").getAttribute("aria-valuetext"), y: scrollY }));
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    const s2 = await page.evaluate(() => ({ now: document.querySelector("#code .cv-ribbon").getAttribute("aria-valuenow"), y: scrollY }));
    await page.keyboard.press("End");
    await page.waitForTimeout(100);
    const end = await page.evaluate(() => document.querySelector("#code .cv-ribbon").getAttribute("aria-valuenow"));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ key: document.activeElement.dataset ? document.activeElement.dataset.key : null }));
    check("minimap is a slider with label and range", r.role === "slider" && r.label === "Hot lines in train.py" && r.min === "1" && r.max === "193", r);
    check("minimap keys: Home → 1, ↓ steps through hot lines, End → last, Enter jumps", home === "1" && +s1.now > 1 && +s2.now > +s1.now && end === "193" && after.key !== null, { home, s1, s2, end, after });
    await context.close();
  }

  // 7. Wrap on xs without overflow; columns on xs.
  if (T("xs")) {
    for (const fx of ["ml-training", "huge", "async-server", "neuron"]) {
      const { page, context } = await open(browser, fx, 390, 844, { mobile: true });
      const r = await page.evaluate(async () => {
        const code = document.getElementById("code");
        const d = code.__code.table();
        const t = code.querySelector(".cv-table");
        // Scroll through and record any row whose content overflows its allotted height.
        let overlap = 0;
        const top = code.getBoundingClientRect().top + scrollY;
        for (let y = top; y < top + Math.min(code.offsetHeight, 6000); y += 600) {
          scrollTo(0, y);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const rows = [...code.querySelectorAll(".cv-body > .cv-row.cv-line")];
          for (const row of rows) {
            const src = row.querySelector(".cv-src");
            if (src && src.getBoundingClientRect().height > row.getBoundingClientRect().height + 1) overlap++;
          }
        }
        return { cols: d.columns.join(","), wrap: t.classList.contains("is-wrap"), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, overlap };
      });
      check(`xs ${fx}: wrap on, line/time/source, no overflow, no overlapping wrapped rows`, r.wrap && r.cols === "line,time,source" && r.sw === r.cw && r.overlap === 0, r);
      await context.close();
    }
  }

  // 8. Function view.
  if (T("functions")) {
    const { page, context } = await open(browser, "ml-training", 1440, 900);
    const r = await page.evaluate(async () => {
      const seg = document.querySelector('#code .code-toolbar [role="radiogroup"]');
      seg.querySelectorAll('[role="radio"]')[1].click();
      await new Promise((r) => setTimeout(r, 80));
      const rows = [...document.querySelectorAll("#code .cfv-row")];
      const first = rows[0]?.dataset.fn;
      const sort = document.querySelector("#code .cfv-table .cv-h-time").getAttribute("aria-sort");
      rows[0].click();
      await new Promise((r) => setTimeout(r, 400));
      return { n: rows.length, first, sort, active: document.activeElement.dataset.key, view: document.getElementById("code").__code.table().items.some((i) => i.kind === "lens") };
    });
    check("function view: rows by time desc, click → Lines + function header focused with detail", r.n === 5 && r.first === "train" && r.sort === "descending" && /^H:/.test(r.active || "") && r.view, r);
    await context.close();
  }

  // 9. Round 1 fixes (design/review/round-1/fix-code.md).
  if (T("round1")) {
    const inCode = (page) => page.evaluate(() => {
      const e = document.activeElement;
      return { inCode: !!(e && e.closest && e.closest("#code")), tag: e ? e.tagName : null, label: (e && (e.getAttribute("aria-label") || e.dataset.key || "")) || "" };
    });

    // code-sort-fold-focus-lost: Enter on every header button / fold keeps focus in #code.
    {
      const { page, context } = await open(browser, "ml-training", 1440, 900);
      const n = await page.$$eval("#code .cv-table:not(.cfv-table) .cv-h-btn", (bs) => bs.length);
      const lost = [];
      for (let i = 0; i < n; i++) {
        const lab = await page.evaluate((i) => { const b = document.querySelectorAll("#code .cv-table:not(.cfv-table) .cv-h-btn")[i]; b.focus(); return b.getAttribute("aria-label"); }, i);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(120);
        const a = await inCode(page);
        if (!a.inCode || a.label !== lab) lost.push({ lab, a });
        await page.keyboard.press("Enter"); // asc, then source order: focus must survive each
        await page.keyboard.press("Enter");
        await page.waitForTimeout(120);
        const b = await inCode(page);
        if (!b.inCode || b.label !== lab) lost.push({ lab, b });
      }
      check("round1: Enter on every code header button keeps focus on that button", n >= 6 && lost.length === 0, { n, lost: lost.slice(0, 3) });
      const folds = [];
      for (const key of ["Enter", " "]) {
        await page.evaluate(() => document.querySelector("#code .cv-fold").focus());
        await page.keyboard.press(key);
        await page.waitForTimeout(150);
        const a = await inCode(page);
        const y0 = await page.evaluate(() => scrollY);
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
        const b = await inCode(page);
        folds.push({ key, a, b, row: /^L:/.test(a.label) || /^Line /.test(a.label), scrolled: (await page.evaluate(() => scrollY)) - y0 });
      }
      check("round1: Enter / Space on a fold moves focus to the first revealed line; ArrowDown stays in the table", folds.every((f) => f.a.inCode && f.row && f.b.inCode && f.b.tag === "DIV"), folds);
      // Function view: sorting keeps focus too.
      await page.evaluate(() => document.querySelectorAll('#code .code-toolbar [role="radiogroup"]')[0].querySelectorAll('[role="radio"]')[1].click());
      await page.waitForTimeout(150);
      await page.evaluate(() => document.querySelector("#code .cfv-table .cv-h-mem .cv-h-btn").focus());
      await page.keyboard.press("Enter");
      await page.waitForTimeout(120);
      const fv = await inCode(page);
      check("round1: sorting the function view keeps focus on the header", fv.inCode && /Memory/.test(fv.label), fv);
      await context.close();
    }

    // hover-only-tooltips-code + code-path-empty-tab-stop.
    {
      const { page, context } = await open(browser, "ml-training", 1440, 900);
      const r = await page.evaluate(() => {
        const heads = [...document.querySelectorAll("#code .cv-table:not(.cfv-table) .cv-h")];
        const bad = heads.filter((h) => !h.querySelector("button") && h.tabIndex !== 0).map((h) => h.dataset.col);
        const desc = heads.filter((h) => h.classList.contains("cv-h-info")).map((h) => `${h.dataset.col}:${(h.getAttribute("aria-description") || "").slice(0, 30)}`);
        const path = document.querySelector("#code .code-path");
        return { bad, desc, pathTab: path.getAttribute("tabindex"), pathLabel: path.getAttribute("aria-label"), described: document.getElementById("code-table").getAttribute("aria-describedby") };
      });
      await page.keyboard.press("Tab"); // establish keyboard modality for :focus-visible
      await page.evaluate(() => document.querySelector("#code .cv-h-trend").focus());
      await page.waitForTimeout(150);
      const tip = await page.evaluate(() => { const t = document.querySelector('[role="tooltip"]'); return t && getComputedStyle(t).visibility !== "hidden" && getComputedStyle(t).opacity !== "0" ? t.textContent.slice(0, 60) : null; });
      check("round1: every code column header is a Tab stop; Footprint/Source carry their definition (focus tooltip + aria-description)", r.bad.length === 0 && r.desc.length === 2 && r.desc.every((d) => d.split(":")[1].length > 10) && /Footprint/i.test(tip || ""), { ...r, tip });
      check("round1: the file path is not an empty Tab stop when it fits; the table is described by the file bar", r.pathTab === null && r.pathLabel === null && r.described === "code-filebar", r);
      // Toolbar wording and labelled tab memory.
      const t = await page.evaluate(() => ({
        modes: [...document.querySelectorAll('#code .code-toolbar [role="radiogroup"]')[1].querySelectorAll('[role="radio"]')].map((b) => b.textContent.trim()),
        tab: document.querySelector("#code .fn-tab.is-active .fn-peak")?.textContent,
        folds: [...document.querySelectorAll("#code .cv-fold-text")].map((f) => f.textContent).slice(0, 3),
      }));
      check("round1: display modes read Hot + context | Hot only | All lines; tab memory says peak", t.modes.join("|") === "Hot + context|Hot only|All lines" && /^peak \d/.test(t.tab || ""), t);
      check("round1: folds with sampled lines say 'below 1% each', never 'without samples'", t.folds[0] === "15 lines without samples · 1–15" && t.folds[1] === "32 lines below 1% each · 19–50 · together 0.2% of run", t.folds);
      await context.close();
    }

    // source-column-starved + row-actions-cover-source-narrow + code-clip-hard-edge.
    for (const [w, hgt, dpr, min] of [[1440, 900, 1, 640], [1024, 768, 1, 420], [1000, 400, 1, 400], [640, 400, 2, 380]]) {
      const context = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      await page.goto("file://" + path.join(root, "out", "ml-training.html") + "?still");
      await page.waitForTimeout(300);
      await page.evaluate(() => window.vsNavigate(escape("/home/dev/llm-train/train.py"), 173));
      await page.waitForTimeout(1400);
      const r = await page.evaluate(() => {
        const row = document.querySelector('#code .cv-line[data-key="L:173"]');
        const src = row.querySelector(".cv-src");
        const range = document.createRange();
        range.selectNodeContents(src);
        const textRight = Math.min(range.getBoundingClientRect().right, src.getBoundingClientRect().right);
        const btns = [...row.querySelectorAll(".cv-act")].map((b) => b.getBoundingClientRect().left);
        const srcW = document.querySelector("#code .cv-h-source").getBoundingClientRect().width;
        // Clipped rows fade; unclipped rows do not.
        const rows = [...document.querySelectorAll("#code .cv-body > .cv-line")];
        const wrong = rows.filter((r) => {
          const s = r.querySelector(".cv-src");
          const clipped = s.scrollWidth > s.clientWidth + 1;
          const masked = getComputedStyle(s).maskImage !== "none";
          return clipped !== masked && Math.abs(s.scrollWidth - s.clientWidth) > 8;
        }).map((r) => r.dataset.key);
        return { srcW: Math.round(srcW), textRight: Math.round(textRight), btnLeft: btns.length ? Math.round(Math.min(...btns)) : null, wrong };
      });
      check(`round1: ${w}×${hgt}: source ≥ ${min} px; the jumped-to row's actions never cover its code; only clipped lines fade`, r.srcW >= min && (r.btnLeft === null || r.btnLeft >= r.textRight) && r.wrong.length === 0, r);
      await context.close();
    }

    // when-it-ran-misattributes: no "worker thread" note for a line without CPU time.
    {
      const { page, context } = await open(browser, "ml-training", 1920, 1080);
      const blocks = async (line) => {
        await page.evaluate((line) => window.vsNavigate(escape("/home/dev/llm-train/train.py"), line), line);
        await page.waitForTimeout(900);
        return page.evaluate(() => ({ heads: [...document.querySelectorAll(".code-dock .cd-block-title")].map((x) => x.textContent.trim()), text: document.querySelector(".code-dock").textContent }));
      };
      const b152 = await blocks(152);
      const b173 = await blocks(173);
      check("round1: detail has no 'When it ran' / worker-thread note for a line with no CPU time; keeps it for sampled lines", !/When it ran/i.test(b152.heads.join("|")) && !/worker thread/.test(b152.text) && /When it ran/i.test(b173.heads.join("|")), { b152: b152.heads, b173: b173.heads });
      await context.close();
    }
  }

  await browser.close();
  process.exit(report.finish());
})().catch((e) => { console.error(e); process.exit(2); });
