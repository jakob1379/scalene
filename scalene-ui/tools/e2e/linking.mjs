#!/usr/bin/env node
// Cross-view linking audit (DESIGN.md §8.6 WP6): every jump source of §4.8.12 lands on the
// code row, focused, selected, flashed (M14) and announced, with the detail open; every
// "show in" link (§4.11.6, §4.12.3) lands focused in its view; every hover source of §4.4.6
// drives the scope's link caption; and every window global of §7.3 works, including load()
// re-rendering another fixture, loadFile, loadDemo and loadFetch.
//   node tools/e2e/linking.mjs [--only jump,show,hover,globals,load]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, createReport, fixture, onlyFilter, openPage, outDir, fixturesDir } from "./_env.mjs";

const report = createReport("linking");
const check = report.check;
const want = onlyFilter();
const browser = await chromium.launch();

const ML = "/home/dev/llm-train";
const TRAIN = `${ML}/train.py`;
const LOADER = `${ML}/data/loader.py`;

/**
 * Before an action: record every row that gets the M14 flash class and every polite
 * announcement, so the landing check can see them after the fact.
 */
const RECORDER = () => {
  window.__flashes = [];
  window.__polite = [];
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      const t = m.target;
      if (m.type === "attributes" && t.classList && t.classList.contains("m-flash")) window.__flashes.push(t.dataset.key || "?");
      if (t.id === "sr-polite" || (t.parentElement && t.parentElement.id === "sr-polite")) {
        const s = document.getElementById("sr-polite").textContent.trim();
        if (s) window.__polite.push(s);
      }
    }
  });
  const start = () => mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true, characterData: true });
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
};

async function open(name = "ml-training", o = {}) {
  const r = await openPage(browser, name, { q: "", init: RECORDER, ...o });
  // The overview is painted and its intro clock started (motion on by default).
  await r.page.waitForFunction(() => globalThis.__scaleneOverview && globalThis.__scaleneOverview.started, null, { timeout: 15000 });
  await r.page.waitForTimeout(o.settle ?? 1100);
  return r;
}

/** Expected landing key from an aria-label ending "go to <base> line N" / "go to function f in <base>". */
function expectedFromLabel(label) {
  const m = /go to (?:(\S+) line (\d+)|function (\S+) in (\S+))\s*$/i.exec(label || "");
  if (!m) return null;
  return m[1] ? { key: `L:${m[2]}`, base: m[1] } : { fn: m[3], base: m[4] };
}

/** Wait until focus is on a code row (or `ms` passes), then describe the landing. */
async function landing(page, ms = 4000) {
  await page
    .waitForFunction(() => {
      const a = document.activeElement;
      return !!a && !!document.getElementById("code")?.contains(a) && /^(L|H):/.test(a.dataset?.key || "");
    }, null, { timeout: ms })
    .catch(() => {});
  await page.waitForTimeout(250); // smooth scroll + lens measure settle
  return page.evaluate(() => {
    const a = document.activeElement;
    const code = document.getElementById("code");
    const lens = document.querySelector("#code .cv-lens");
    const dock = document.querySelector("#code .code-dock");
    const r = a ? a.getBoundingClientRect() : { top: -1, bottom: -1 };
    return {
      key: a?.dataset?.key ?? null,
      role: a?.getAttribute("role") ?? null,
      inCode: !!code && !!a && code.contains(a),
      file: code?.__code ? code.__code.file() : null,
      panel: lens ? lens.getAttribute("aria-label") : dock && !dock.hidden ? dock.getAttribute("aria-label") : null,
      selected: Array.from(document.querySelectorAll("#code .cv-row.is-selected")).map((e) => e.dataset.key),
      flashed: window.__flashes.slice(),
      polite: window.__polite.slice(-3),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vh: innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

/**
 * The §4.8.12 landing contract: focus on the row (`role=row`) inside #code, the row selected
 * and flashed, the detail (lens/dock) open for it, the row on screen, a polite announcement
 * naming it, no horizontal overflow. `exp` = { key } | { keyRe } | { fn }, plus optional `base`.
 */
function landed(name, r, exp, errors = []) {
  const problems = [];
  if (!r.inCode || r.role !== "row") problems.push("focus not on a code row");
  if (exp.key && r.key !== exp.key) problems.push(`key ${r.key} ≠ ${exp.key}`);
  if (exp.keyRe && !exp.keyRe.test(r.key || "")) problems.push(`key ${r.key} !~ ${exp.keyRe}`);
  if (exp.fn && !/^H:/.test(r.key || "")) problems.push(`function target should land on its header (got ${r.key})`);
  if (exp.base && !(r.file || "").endsWith(`/${exp.base}`)) problems.push(`file ${r.file} is not ${exp.base}`);
  if (!r.selected.includes(r.key)) problems.push("row not selected");
  if (!r.flashed.includes(r.key)) problems.push("row not flashed (M14)");
  if (!r.panel) problems.push("detail not open");
  else if (/^L:/.test(r.key || "") && !r.panel.endsWith(`line ${r.key.slice(2)}`)) problems.push(`detail is "${r.panel}"`);
  if (!(r.top >= 0 && r.bottom <= r.vh)) problems.push(`row off screen (${r.top}..${r.bottom} of ${r.vh})`);
  if (/^L:/.test(r.key || "") && !r.polite.some((s) => s.includes(`line ${r.key.slice(2)} selected`))) problems.push(`no announcement (${JSON.stringify(r.polite)})`);
  if (r.overflow) problems.push(`overflow ${r.overflow}px`);
  if (errors.length) problems.push(`errors: ${errors.slice(0, 2).join(" | ")}`);
  return check(`jump: ${name}`, problems.length === 0, problems.length ? problems.join("; ") : `${r.key} in ${path.basename(r.file || "")}, ${r.panel}`);
}

/** Center of a debugLayout rect inside the scope canvas, in client coordinates. */
async function scopePoint(page, rect, fx = 0.5, fy = 0.5) {
  const box = await page.locator("#overview .scope-canvas").boundingBox();
  return { x: box.x + rect.x + rect.w * fx, y: box.y + rect.y + rect.h * fy };
}

async function mountSection(page, id) {
  await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: "start" }), id);
  await page.waitForTimeout(700);
}

// ── 1. Jump sources (§4.8.12) ───────────────────────────────────────────────
if (want("jump")) {
  // Overview sources: the code section is not mounted yet (motion on, lazy mounts after the intro).
  {
    const { context, page, errors } = await open("ml-training", { settle: 300 });
    const mounted = await page.evaluate(() => !!document.getElementById("code").__code);
    check("lazy sections wait for the intro (code not mounted at +300 ms with motion on)", !mounted, `mounted ${mounted}`);
    await page.locator("#overview .hs-row").first().click();
    landed("hotspot #1 click (code not mounted yet)", await landing(page), { key: "L:173", base: "train.py" }, errors);
    await context.close();
  }
  for (const [label, sel] of [
    ["headline chip", "#overview h1.headline button"],
    ["readout reference", "#overview .ro-tile button.ro-ref, #overview .ro-tile .chip-code"],
    ["finding evidence", "#overview .fd-ref"],
  ]) {
    const { context, page, errors } = await open();
    const btn = page.locator(sel).first();
    const aria = (await btn.count()) ? await btn.getAttribute("aria-label") : null;
    const exp = expectedFromLabel(aria);
    if (!exp) {
      check(`jump: ${label}`, false, `no target button (${sel}) or unparsable label "${aria}"`);
    } else {
      await btn.click();
      landed(`${label} "${aria}"`, await landing(page), exp, errors);
    }
    await context.close();
  }
  {
    const { context, page, errors } = await open();
    const card = page.locator("#overview .fd-card.is-linked-card").first();
    if (await card.count()) {
      await card.locator(".fd-title").click();
      landed("finding card click", await landing(page), { keyRe: /^(L|H):/ }, errors);
    } else check("jump: finding card click", false, "no linked finding card");
    await context.close();
  }
  // Scope: TOP LINES row 1 (= hotspot #1), a labelled PHASE cell, keyboard Enter at the cursor.
  {
    const { context, page, errors } = await open();
    const d = await page.evaluate(() => globalThis.__scaleneOverview.scope.debugLayout());
    const top = d.channels.find((c) => c.id === "top");
    const rows = await page.evaluate(() => document.querySelectorAll("#overview .hs-row").length);
    if (top) {
      // Row 1 of the TOP LINES channel (rows are equal height; at most 5).
      const n = Math.min(5, rows);
      const p = await scopePoint(page, { x: top.rect.x, y: top.rect.y, w: top.rect.w, h: top.rect.h / n }, 0.5, 0.5);
      await page.mouse.click(p.x, p.y);
      landed("scope TOP LINES row 1 click", await landing(page), { key: "L:173", base: "train.py" }, errors);
    } else check("jump: scope TOP LINES row 1 click", false, "no TOP LINES channel");
    await context.close();
  }
  {
    const { context, page, errors } = await open();
    const d = await page.evaluate(() => globalThis.__scaleneOverview.scope.debugLayout());
    const cell = d.phaseCells.filter((c) => c.kind === "label").sort((a, b) => b.rect.w - a.rect.w)[0];
    if (cell) {
      const p = await scopePoint(page, cell.rect);
      await page.mouse.click(p.x, p.y);
      landed(`scope PHASE cell "${cell.label}" click`, await landing(page), { keyRe: /^L:\d+$/ }, errors);
    } else check("jump: scope PHASE cell click", false, "no labelled phase cell");
    await context.close();
  }
  {
    const { context, page, errors } = await open();
    await page.keyboard.press("Tab");
    await page.focus("#overview .scope-canvas .cv-overlay");
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight".replace("Shift+", "")); // 5 % into the run
    await page.keyboard.press("PageDown"); // +10 %
    await page.keyboard.press("PageDown");
    await page.keyboard.press("Enter");
    landed("scope keyboard Enter at the cursor", await landing(page), { keyRe: /^L:\d+$/ }, errors);
    await context.close();
  }
  // Code-view sources: minimap slider Enter, function view row.
  {
    const { context, page, errors } = await open();
    await mountSection(page, "code");
    await page.keyboard.press("Tab");
    await page.focus("#code .cv-ribbon");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    const now = await page.evaluate(() => document.querySelector("#code .cv-ribbon").getAttribute("aria-valuenow"));
    await page.evaluate(() => { window.__flashes.length = 0; });
    await page.keyboard.press("Enter");
    landed(`minimap slider Enter (line ${now})`, await landing(page), { key: `L:${now}` }, errors);
    await context.close();
  }
  // Flame: double-click a Python frame (§4.11.6: click zooms, double-click navigates).
  {
    const { context, page, errors } = await open();
    await mountSection(page, "stacks");
    await page.waitForSelector("#stacks .flame-plot[data-zoom]", { timeout: 10000 });
    const t = await page.$eval("#stacks .flame-plot", (el, file) => {
      const d = el.__flame;
      const p = d.heaviest(file, 165);
      return { path: p, rect: p ? d.nodeRect(p) : null };
    }, TRAIN);
    if (t.rect) {
      const box = await page.locator("#stacks .flame-plot .cv-overlay").boundingBox();
      await page.mouse.dblclick(box.x + t.rect.x + Math.min(t.rect.w / 2, 30), box.y + t.rect.y + t.rect.h / 2);
      landed("flame frame double-click (train:165)", await landing(page), { key: "L:165", base: "train.py" }, errors);
    } else check("jump: flame frame double-click", false, "frame train.py:165 not found");
    await context.close();
  }
  // Timeline: click a Python segment, and Enter on the focused segment.
  for (const how of ["click", "Enter"]) {
    const { context, page, errors } = await open();
    await mountSection(page, "timeline");
    await page.waitForSelector("#timeline .tl-chart:not([hidden])", { timeout: 15000 });
    await page.keyboard.press("Tab"); // keyboard modality for the focus path
    await page.evaluate((file) => document.querySelector("#timeline .tl-chart").__timeline.api.focusLine({ file, line: 120 }), TRAIN);
    await page.waitForTimeout(700);
    const f = await page.evaluate(() => {
      const t = document.querySelector("#timeline .tl-chart").__timeline;
      const fo = t.focus();
      return fo ? { fo, rect: t.segRect(fo.lane, fo.depth, fo.idx) } : null;
    });
    if (!f || !f.rect) {
      check(`jump: timeline segment ${how}`, false, `focusLine(train.py:120) gave no focused segment ${JSON.stringify(f)}`);
    } else if (how === "click") {
      const box = await page.locator("#timeline .tl-canvas").boundingBox();
      await page.mouse.click(box.x + f.rect.x + f.rect.w / 2, box.y + f.rect.y + f.rect.h / 2);
      landed("timeline segment click (train.py:120)", await landing(page), { key: "L:120", base: "train.py" }, errors);
    } else {
      await page.focus("#timeline .tl-canvas");
      await page.keyboard.press("Enter");
      landed("timeline focused segment Enter (train.py:120)", await landing(page), { key: "L:120", base: "train.py" }, errors);
    }
    await context.close();
  }
  // Memory: the peak location chip, a site double-click, a site Enter.
  for (const how of ["peak chip", "site double-click", "site Enter"]) {
    const { context, page, errors } = await open();
    await mountSection(page, "memory");
    await page.waitForSelector("#memory .mem-site", { timeout: 10000 });
    let exp = null;
    if (how === "peak chip") {
      const b = page.locator("#memory .mem-at-loc").first();
      exp = expectedFromLabel(await b.getAttribute("aria-label"));
      await b.click();
    } else {
      const site = page.locator("#memory .mem-site").first();
      const loc = (await site.locator(".mem-site-loc").textContent()).trim(); // "train.py:120"
      const [base, line] = loc.split(":");
      exp = { key: `L:${line}`, base };
      if (how === "site double-click") await site.dblclick();
      else {
        await page.keyboard.press("Tab");
        await site.focus();
        await page.keyboard.press("Enter");
      }
    }
    landed(`memory ${how}`, await landing(page), exp ?? { keyRe: /^L:/ }, errors);
    await context.close();
  }
  // Palette: a Lines result and a Functions result.
  {
    const { context, page, errors } = await open();
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".palette input", { timeout: 3000 }).catch(() => {});
    await page.keyboard.type("loss.item", { delay: 15 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    landed("palette Lines result (loss.item)", await landing(page), { keyRe: /^L:\d+$/, base: "train.py" }, errors);
    await page.evaluate(() => { window.__flashes.length = 0; });
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(150);
    await page.keyboard.type("train", { delay: 15 });
    await page.waitForTimeout(300);
    const clicked = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('[role="listbox"] [role="option"]'));
      const groupOf = (o) => o.closest('[role="group"]')?.getAttribute("aria-label") || o.closest('[role="group"]')?.querySelector("[id]")?.textContent || "";
      const fn = opts.find((o) => /function/i.test(groupOf(o)) || /function/i.test(o.getAttribute("aria-label") || ""));
      if (!fn) return null;
      fn.click();
      return fn.textContent.trim().slice(0, 40);
    });
    if (clicked) landed(`palette Functions result ("${clicked}")`, await landing(page), { fn: "train", base: "train.py" }, errors);
    else check("jump: palette Functions result", false, "no option in a Functions group");
    await context.close();
  }
  // vsNavigate (outside VS Code) into another file.
  {
    const { context, page, errors } = await open();
    await page.evaluate((f) => window.vsNavigate(escape(f), 33), LOADER);
    landed("vsNavigate(loader.py, 33)", await landing(page), { key: "L:33", base: "loader.py" }, errors);
    await context.close();
  }
  // Reduced motion: the same contract, instant scroll, flash kept (§5.4).
  {
    const { context, page, errors } = await open("ml-training", { reduced: true, settle: 200 });
    await page.locator("#overview .hs-row").nth(1).click();
    landed("hotspot #2 click under reduced motion", await landing(page), { key: "L:165", base: "train.py" }, errors);
    await context.close();
  }
  // The dock layout (xl, ≥ 1600 px): same contract with the dock instead of the lens.
  {
    const { context, page, errors } = await open("ml-training", { w: 1920, h: 1080 });
    await page.locator("#overview h1.headline button").first().click();
    const r = await landing(page);
    const dock = await page.evaluate(() => !!document.querySelector("#code .code-dock:not([hidden])") && !document.querySelector("#code .cv-lens"));
    landed("headline chip at 1920 (dock)", r, { keyRe: /^(L|H):/ }, errors);
    check("jump at 1920 opens the dock, not the lens", dock, `dock ${dock}`);
    await context.close();
  }
  // Phone (390, isMobile): hotspot tap lands on the row with the inline lens.
  {
    const { context, page, errors } = await open("ml-training", { w: 390, h: 844 });
    await page.locator("#overview .hs-row").first().tap();
    landed("hotspot #1 tap at 390×844", await landing(page), { key: "L:173", base: "train.py" }, errors);
    await context.close();
  }
  // async-server: the event-loop line in the headline, a chip into another file.
  {
    const { context, page, errors } = await open("async-server");
    const chips = page.locator("#overview h1.headline button");
    const n = await chips.count();
    for (let i = 0; i < n; i++) {
      const aria = await chips.nth(i).getAttribute("aria-label");
      const exp = expectedFromLabel(aria);
      if (!exp) continue;
      await page.evaluate(() => { window.__flashes.length = 0; scrollTo(0, 0); });
      await page.waitForTimeout(300);
      await chips.nth(i).click();
      landed(`async-server headline "${aria}"`, await landing(page), exp, errors);
    }
    await context.close();
  }
}

// ── 2. Show in stacks / timeline (§4.11.6, §4.12.3) ─────────────────────────
if (want("show")) {
  {
    const { context, page, errors } = await open();
    await page.keyboard.press("Tab");
    await page.locator("#overview .hs-row").first().focus();
    await page.keyboard.press("f");
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const a = document.activeElement;
      const fl = document.querySelector("#stacks .flame-plot");
      return { inStacks: !!document.getElementById("stacks")?.contains(a), role: a?.getAttribute("role"), zoom: fl?.__flame ? fl.__flame.zoom() : null, focus: fl?.__flame ? fl.__flame.focus() : null, hash: location.hash, polite: window.__polite.slice(-1)[0] || "" };
    });
    check("show: hotspot `f` → flame focused on the line's frame", r.inStacks && r.role === "application" && r.focus && /173/.test(r.polite), JSON.stringify({ ...r, errors }));
    await context.close();
  }
  for (const [key, id] of [["s", "stacks"], ["t", "timeline"]]) {
    const { context, page, errors } = await open();
    await page.evaluate((f) => window.vsNavigate(escape(f), 120), TRAIN);
    await landing(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(1500);
    const r = await page.evaluate((id) => {
      const a = document.activeElement;
      const tl = document.querySelector("#timeline .tl-chart")?.__timeline;
      const fl = document.querySelector("#stacks .flame-plot")?.__flame;
      const sec = document.getElementById(id).getBoundingClientRect();
      return {
        inView: !!document.getElementById(id)?.contains(a),
        role: a?.getAttribute("role"),
        focus: id === "timeline" ? (tl ? tl.focus() : null) : fl ? fl.focus() : null,
        onScreen: sec.top < innerHeight && sec.bottom > 0,
        polite: window.__polite.slice(-1)[0] || "",
      };
    }, id);
    check(`show: code row \`${key}\` → ${id} focused on train.py:120`, r.inView && r.role === "application" && r.focus && r.onScreen && /120/.test(r.polite), JSON.stringify({ ...r, errors }));
    await context.close();
  }
  // Scope range → "Open in timeline": the timeline mounts and zooms to the brushed range (WP4 R2).
  {
    const { context, page, errors } = await open("ml-training", { settle: 1100 });
    await page.keyboard.press("Tab");
    await page.focus("#overview .scope-canvas .cv-overlay");
    await page.keyboard.press("Home");
    for (let i = 0; i < 3; i++) await page.keyboard.press("PageDown");
    for (let i = 0; i < 25; i++) await page.keyboard.press("Shift+ArrowRight");
    const text = await page.evaluate(() => document.querySelector("#overview .range-text")?.textContent || "");
    const mountedBefore = await page.evaluate(() => !!document.querySelector("#timeline .tl-chart"));
    await page.locator("#overview .range-open").click();
    await page.waitForFunction(() => document.querySelector("#timeline .tl-chart:not([hidden])"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const t = document.querySelector("#timeline .tl-chart")?.__timeline;
      const sec = document.getElementById("timeline").getBoundingClientRect();
      return { domain: t ? t.domain() : null, top: Math.round(sec.top), hash: location.hash };
    });
    const m = /([\d.]+)\ss\s*[–-]\s*([\d.]+)\ss/.exec(text);
    const want0 = m ? Number(m[1]) : NaN;
    const want1 = m ? Number(m[2]) : NaN;
    const okDomain = r.domain && Math.abs(r.domain[0] - want0) < 0.2 && Math.abs(r.domain[1] - want1) < 0.2;
    check("show: scope range → Open in timeline zooms the timeline to the range", okDomain && r.top < 200 && r.hash === "#timeline", JSON.stringify({ range: text, mountedBefore, ...r, errors }));
    await context.close();
  }
}

// ── 3. Linked overlays: hover sources drive the scope's link caption (§4.4.6) ─
if (want("hover")) {
  const { context, page, errors } = await open();
  const caption = () => page.evaluate(() => document.querySelector("#overview .scope-desc .link-loc")?.textContent ?? null);
  const base = await page.evaluate(() => document.querySelector("#overview .scope-desc").textContent);
  const hoverCheck = async (name, sel, expectRe) => {
    const el = page.locator(sel).first();
    if (!(await el.count())) return check(`hover: ${name}`, false, `no element ${sel}`);
    await el.hover();
    await page.waitForTimeout(120);
    const c = await caption();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(120);
    const after = await caption();
    return check(`hover: ${name} → scope link caption`, c !== null && expectRe.test(c) && after === null, `"${c}" (after leave: ${after})`);
  };
  await hoverCheck("hotspot row #1", "#overview .hs-row", /^train\.py:173$/);
  await hoverCheck("headline chip", "#overview h1.headline button", /\S/);
  await hoverCheck("finding card", "#overview .fd-card.is-linked-card", /\S/);
  await hoverCheck("readout reference", "#overview .ro-tile .ro-ref", /\S/);
  // Views further down: hover there, read the caption from the DOM (the scope is off screen).
  await mountSection(page, "code");
  await hoverCheck("code row", "#code .cv-row[data-key^='L:']", /^train\.py:\d+$/);
  await mountSection(page, "memory");
  await hoverCheck("memory site", "#memory .mem-site", /^\S+\.py:\d+$/);
  await mountSection(page, "stacks");
  {
    const t = await page.$eval("#stacks .flame-plot", (el, file) => { const d = el.__flame; const p = d.heaviest(file, 173); return p ? d.nodeRect(p) : null; }, TRAIN);
    const box = await page.locator("#stacks .flame-plot .cv-overlay").boundingBox();
    if (t && box) {
      await page.mouse.move(box.x + t.x + Math.min(t.w / 2, 30), box.y + t.y + t.h / 2);
      await page.waitForTimeout(120);
      const c = await caption();
      // WP4 R1: the frame name in the tooltip is code (mono, ligatures off, §3.5, §4.11.6).
      const tt = await page.evaluate(() => {
        const el = document.querySelector(".tooltip.is-visible .tt-title");
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { text: el.textContent, code: el.classList.contains("code"), lig: cs.fontVariantLigatures, mono: /mono|Menlo|Consolas|Courier/i.test(cs.fontFamily) };
      });
      await page.mouse.move(2, 2);
      check("hover: flame frame → scope link caption", c === "train.py:173", `"${c}"`);
      check("hover: flame tooltip title is code (mono, ligatures off)", !!tt && tt.code && tt.lig === "none" && tt.mono, JSON.stringify(tt));
    } else check("hover: flame frame → scope link caption", false, "frame not found");
  }
  await mountSection(page, "timeline");
  {
    await page.waitForSelector("#timeline .tl-chart:not([hidden])", { timeout: 15000 });
    await page.evaluate((file) => document.querySelector("#timeline .tl-chart").__timeline.api.focusLine({ file, line: 120 }), TRAIN);
    await page.waitForTimeout(700);
    const f = await page.evaluate(() => { const t = document.querySelector("#timeline .tl-chart").__timeline; const fo = t.focus(); return fo ? t.segRect(fo.lane, fo.depth, fo.idx) : null; });
    const box = await page.locator("#timeline .tl-canvas").boundingBox();
    if (f && box) {
      await page.mouse.move(box.x + f.x + f.w / 2, box.y + f.y + f.h / 2);
      await page.waitForTimeout(120);
      const c = await caption();
      await page.mouse.move(2, 2);
      check("hover: timeline segment → scope link caption", c === "train.py:120", `"${c}"`);
    } else check("hover: timeline segment → scope link caption", false, "segment not found");
  }
  // select:line is sticky: after a jump the caption names the selection until Esc.
  await page.evaluate((f) => window.vsNavigate(escape(f), 165), TRAIN);
  await landing(page);
  await page.mouse.move(2, 2);
  // A focused row is a hover source too (focus = hover, §4.4.6): move focus off the table.
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(150);
  const sticky = await caption();
  await page.keyboard.press("Escape"); // global: clears the selection (§6.2.3)
  await page.waitForTimeout(150);
  const cleared = await caption();
  const restored = await page.evaluate(() => document.querySelector("#overview .scope-desc").textContent);
  check("hover: selection is sticky in the scope caption until Esc", sticky === "train.py:165" && cleared === null && restored === base, `selected "${sticky}", after Esc "${cleared}"`);
  check("hover: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ── 4. Window globals (§7.3) ────────────────────────────────────────────────
if (want("globals")) {
  const { context, page, errors } = await open("ml-training", { q: "still" });
  const names = ["load", "vsNavigate", "proposeOptimizationLine", "proposeOptimizationRegion", "expandAll", "collapseAll", "toggleDisplay", "onFileDisplayModeChange", "toggleCombinedStacks", "toggleMemoryStacks", "toggleCombinedStacksTimeline", "changeTimelineViewMode", "loadFile", "loadDemo", "loadFetch", "toggleServiceFields", "togglePassword", "toggleAdvanced", "refreshOpenAIModels", "refreshGeminiModels", "checkApiKey", "toggleReduced"];
  const missing = await page.evaluate((n) => n.filter((k) => typeof window[k] !== "function"), names);
  check("globals: all 22 §7.3 functions installed", missing.length === 0, missing.join(", ") || `${names.length} functions`);
  const raw = await page.evaluate(() => typeof globalThis.profile === "object" && globalThis.profile !== null && "files" in globalThis.profile && Array.isArray(globalThis.profile.combined_stacks_timeline ?? []));
  check("globals: globalThis.profile is the raw profile object", raw);

  // Sections: heading focus, hash, tab.
  for (const [fn, id, tab] of [["toggleCombinedStacks", "stacks", "CPU"], ["toggleMemoryStacks", "stacks", "Memory"], ["toggleCombinedStacksTimeline", "timeline", null]]) {
    await page.evaluate((fn) => window[fn](), fn);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({
      active: document.activeElement?.id,
      hash: location.hash,
      tab: document.querySelector('#stacks [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
      top: Math.round(document.activeElement?.closest("section")?.getBoundingClientRect().top ?? -999),
    }));
    check(`globals: ${fn}() → #${id}-h focused${tab ? `, ${tab} tab` : ""}`, r.active === `${id}-h` && r.hash === `#${id}` && (!tab || (r.tab || "").startsWith(tab)) && r.top >= 0 && r.top < 120, JSON.stringify(r));
  }
  // Display modes.
  await page.evaluate(() => window.expandAll());
  await page.waitForTimeout(150);
  const allMode = await page.evaluate(() => document.getElementById("display-mode-file-1")?.value);
  await page.evaluate(() => window.collapseAll());
  await page.waitForTimeout(150);
  const hotMode = await page.evaluate(() => document.getElementById("display-mode-file-1")?.value);
  check("globals: expandAll() → All lines, collapseAll() → Hot lines", allMode === "all" && hotMode === "profiled-lines", `${allMode} / ${hotMode}`);
  const f2 = await page.evaluate(async () => {
    window.toggleDisplay("file-2");
    await new Promise((r) => setTimeout(r, 300));
    return { file: document.getElementById("code").__code.file(), hash: location.hash };
  });
  check("globals: toggleDisplay('file-2') → second file current, code section shown", !!f2.file && !/train\.py$/.test(f2.file) && f2.hash === "#code", JSON.stringify(f2));
  const mode = await page.evaluate(async () => {
    window.toggleDisplay("file-1");
    await new Promise((r) => setTimeout(r, 200));
    const el = document.getElementById("display-mode-file-1");
    el.value = "profiled-functions";
    window.onFileDisplayModeChange("file-1");
    await new Promise((r) => setTimeout(r, 200));
    return { value: el.value, checked: el.querySelector('[aria-checked="true"]')?.textContent?.trim() ?? null };
  });
  check("globals: onFileDisplayModeChange('file-1') applies the written mode", mode.value === "profiled-functions", JSON.stringify(mode));
  // Timeline view modes.
  for (const [v, view, filt] of [["interleaved", "interleaved", null], ["swimlanes", "lanes", null], ["main", "lanes", "main"]]) {
    const r = await page.evaluate(async (v) => {
      window.changeTimelineViewMode({ value: v });
      await new Promise((r) => setTimeout(r, 400));
      const t = document.querySelector("#timeline .tl-chart").__timeline;
      return { view: t.view(), filter: t.filter(), select: document.getElementById("timeline-view-mode")?.value ?? null };
    }, v);
    const okFilter = filt === null ? true : r.filter !== null && r.filter !== -1 && r.filter !== "all";
    check(`globals: changeTimelineViewMode({value: "${v}"}) → ${view}${filt ? " filtered to main" : ""}`, r.view === view && okFilter, JSON.stringify(r));
  }
  // AI entry points (no provider configured → setup card under the line).
  const ai = await page.evaluate(async (f) => {
    window.vsNavigate(escape(f), 173);
    await new Promise((r) => setTimeout(r, 400));
    window.proposeOptimizationLine(escape(f), 1, encodeURIComponent(JSON.stringify({ lineno: 173 })));
    await new Promise((r) => setTimeout(r, 500));
    const card = document.querySelector("#code .ai-card");
    return { card: !!card, text: card ? card.textContent.replace(/\s+/g, " ").slice(0, 80) : null };
  }, TRAIN);
  check("globals: proposeOptimizationLine → AI card for line 173 (setup state without a provider)", ai.card && /173/.test(ai.text || ""), JSON.stringify(ai));
  const region = await page.evaluate(async (f) => {
    window.proposeOptimizationRegion(escape(f), 1, encodeURIComponent(JSON.stringify({ lineno: 165 })));
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelectorAll("#code .ai-card").length;
  }, TRAIN);
  check("globals: proposeOptimizationRegion → a second AI card", region >= 2, `${region} cards`);
  const legacy = await page.evaluate(async () => {
    const out = {};
    window.toggleServiceFields();
    out.drawer = !!document.querySelector("#service-select");
    window.toggleReduced();
    out.reduced = window.toggleReduced() === undefined;
    return out;
  });
  check("globals: toggleServiceFields() builds the drawer DOM; toggleReduced() is a no-op", legacy.drawer && legacy.reduced, JSON.stringify(legacy));
  // vsNavigate outside the profile → vscode:// fallback (navigation intercepted).
  const href = await page.evaluate(() => {
    let to = null;
    const desc = Object.getOwnPropertyDescriptor(window.Location.prototype, "href");
    try {
      Object.defineProperty(window.location, "href", { configurable: true, set: (v) => { to = v; }, get: () => desc.get.call(window.location) });
    } catch {
      return "cannot intercept";
    }
    window.vsNavigate(escape("/elsewhere/ünïcode.py"), 7);
    return to;
  });
  check("globals: vsNavigate outside the profile → vscode://file/<decoded>:<line>:1", href === "cannot intercept" || href === "vscode://file//elsewhere/ünïcode.py:7:1", String(href));
  check("globals: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ── 5. load() re-render, loadFile, loadDemo, loadFetch (§7.3, §4.15) ────────
if (want("load")) {
  const cpu = fs.readFileSync(path.join(fixturesDir, "cpu-only.json"), "utf8");
  const asyncRaw = fixture("async-server");
  const { context, page, errors } = await open("ml-training", { q: "still" });
  const state = () =>
    page.evaluate(() => ({
      title: document.title,
      sections: Array.from(document.querySelectorAll("main#main > section.report-section")).map((s) => s.id).join(","),
      h1: document.querySelector("#overview h1.headline")?.textContent?.slice(0, 40) ?? null,
      empty: !!document.querySelector(".empty-state"),
      nodes: document.querySelectorAll("*").length,
      toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent.replace(/\s+/g, " ").trim()),
    }));
  const s0 = await state();
  // load(object) with a different fixture re-renders everything.
  await page.evaluate((p) => window.load(p), asyncRaw);
  await page.waitForTimeout(600);
  const s1 = await state();
  check("load(asyncObject) re-renders the report", s1.title === "Scalene - /srv/catalog-api/bench_server.py" && /^bench_server\.py ran/.test(s1.h1 || "") && s1.sections === "overview,code,stacks,timeline,memory", JSON.stringify(s1));
  // Same object within 1 s: skipped (idempotent).
  const skipped = await page.evaluate(async () => {
    const before = document.querySelector("#overview");
    window.load(globalThis.profile);
    await new Promise((r) => setTimeout(r, 100));
    return document.querySelector("#overview") === before;
  });
  check("load(sameObject) within 1 s is skipped", skipped);
  // Jumps work in the re-rendered report (the Nav and the views were rebuilt).
  await page.evaluate(() => window.vsNavigate(escape("/srv/catalog-api/catalog/handlers.py"), 51));
  landed("after load(async): vsNavigate(handlers.py, 51)", await landing(page), { key: "L:51", base: "handlers.py" });
  // load(JSON text) of a third fixture.
  await page.evaluate((t) => window.load(t), cpu);
  await page.waitForTimeout(600);
  const s2 = await state();
  check("load(jsonText) re-renders (cpu-only: no memory section)", s2.title === "Scalene - /home/ana/sim/nbody.py" && s2.sections === "overview,code,stacks,timeline", JSON.stringify(s2));
  // Bad JSON: error toast, the report stays.
  await page.evaluate(() => window.load("{ nope"));
  await page.waitForTimeout(300);
  const s3 = await state();
  check("load('{ nope') → error toast, report stays", s3.title === s2.title && s3.toasts.some((t) => /Couldn't load/.test(t)), JSON.stringify(s3.toasts));
  // A profile that parses but fails to build: the report stays (WP5 request #2, §4.15).
  await page.evaluate(() => {
    const files = {};
    Object.defineProperty(files, "boom.py", { enumerable: true, get() { throw new Error("broken file entry"); } });
    window.load({ files });
  });
  await page.waitForTimeout(300);
  const s4 = await state();
  check("load(profile that fails to build) → error toast, report stays", s4.title === s2.title && s4.sections === s2.sections && s4.toasts.some((t) => /Couldn't read this profile/.test(t)), JSON.stringify({ title: s4.title, toasts: s4.toasts }));
  // "" and {} → empty state, title reset.
  await page.evaluate(() => window.load(""));
  await page.waitForTimeout(300);
  const s5 = await state();
  check('load("") → empty state, title "Scalene"', s5.empty && s5.title === "Scalene" && s5.sections === "", JSON.stringify(s5));
  // Back to a report from the empty state.
  await page.evaluate((p) => window.load(p), asyncRaw);
  await page.waitForTimeout(400);
  const s6 = await state();
  check("load(object) from the empty state renders the report again; earlier load errors are dismissed", !s6.empty && s6.sections.startsWith("overview,code") && !s6.toasts.some((t) => /Couldn't/.test(t)), JSON.stringify({ sections: s6.sections, toasts: s6.toasts }));
  // The template's clickToLoadFile() (from a real click) opens the picker; the chosen file loads.
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "legacy-load";
    b.textContent = "Load";
    b.setAttribute("onclick", "clickToLoadFile()");
    b.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999";
    document.body.appendChild(b);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null), page.click("#legacy-load")]);
  if (chooser) {
    await chooser.setFiles(path.join(fixturesDir, "cpu-only.json"));
    await page.waitForTimeout(800);
    const s7 = await state();
    check("clickToLoadFile() → picker → cpu-only.json loaded with a success toast", s7.title === "Scalene - /home/ana/sim/nbody.py" && s7.toasts.some((t) => /Loaded cpu-only\.json/.test(t)), JSON.stringify({ title: s7.title, toasts: s7.toasts }));
  } else check("clickToLoadFile() opens the file picker", false, "no filechooser event");
  // loadFile() (upstream: the #fileinput onchange handler) reads the chosen file. Hold back the
  // input's own change listener once so the global does the work.
  await page.evaluate(() => window.addEventListener("change", (e) => { if (e.target.id === "fileinput") e.stopImmediatePropagation(); }, { capture: true, once: true }));
  await page.setInputFiles("#fileinput", path.join(fixturesDir, "async-server.json"));
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => document.title);
  await page.evaluate(() => window.loadFile());
  await page.waitForTimeout(900);
  const s8 = await state();
  check("loadFile() reads the file chosen in #fileinput", before === "Scalene - /home/ana/sim/nbody.py" && s8.title === "Scalene - /srv/catalog-api/bench_server.py" && s8.toasts.some((t) => /Loaded async-server\.json/.test(t)), JSON.stringify({ before, title: s8.title, toasts: s8.toasts }));
  // Back to cpu-only for the demo check below (it must change the title again).
  await page.evaluate((t) => window.load(t), cpu);
  await page.waitForTimeout(400);
  // loadDemo(): loads the hosted demo's example_profile when the page defines it.
  const demo = await page.evaluate(async (p) => {
    window.example_profile = p;
    window.loadDemo();
    await new Promise((r) => setTimeout(r, 500));
    return document.title;
  }, asyncRaw);
  check("loadDemo() loads example_profile", demo === "Scalene - /srv/catalog-api/bench_server.py", demo);
  // The deliberately broken profile above logs its build error (console.error); nothing else may.
  const unexpected = errors.filter((e) => !/broken file entry/.test(e));
  check("load/loadFile/loadDemo: no unexpected console errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  void s0;
  await context.close();

  // loadFetch() over http: GET profile.json next to the page.
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/profile.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(cpu);
    } else if (u.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(outDir, "ml-training.html")));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = await openPage(browser, "ml-training", { url: `http://127.0.0.1:${port}/index.html?still` });
  await h.page.waitForFunction(() => globalThis.__scaleneOverview && globalThis.__scaleneOverview.started, null, { timeout: 15000 });
  await h.page.evaluate(() => window.loadFetch());
  await h.page.waitForTimeout(1000);
  const fetched = await h.page.evaluate(() => ({ title: document.title, toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent.replace(/\s+/g, " ").trim()) }));
  // Over http the page also probes /env-api-keys.json (404 here) and /heartbeat: those 404s are expected.
  const realErrors = h.errors.filter((e) => !/404|Not Found/i.test(e));
  check("loadFetch() over http → profile.json loaded", fetched.title === "Scalene - /home/ana/sim/nbody.py" && realErrors.length === 0, JSON.stringify({ ...fetched, errors: realErrors }));
  await h.context.close();
  server.close();
}

await browser.close();
process.exit(report.finish());
