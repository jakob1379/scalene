#!/usr/bin/env node
// Browser check matrix (DESIGN.md §8.6 WP6, §6.2.9): load every rendered fixture in both
// template modes and both themes in Chromium at the reference widths (320 … 2560, phones with
// isMobile + DPR 3) plus the 1000×400 Jupyter host, and fail on console errors, page errors,
// horizontal overflow, a zoomed visual viewport, wrong layout classes, a wrong document.title,
// a wrong section skeleton or a missing shell. In standalone mode the overflow check is
// repeated with the code lens open (a hotspot jump) and with the AI settings drawer open.
// Also checks that the theme toggle works, keeps the scroll position and persists.
//
// Usage:
//   node tools/check.mjs [--fixtures ml-training,empty] [--modes standalone,linked]
//                        [--widths 320,360,390,600,1024,1440,2560] [--theme light,dark]
//                        [--no-render] [--no-shots] [--no-interactions] [--shots-dir dir]
//                        [--e2e]   (then run the acceptance suites: node tools/e2e.mjs)
//
// Requires `node build.mjs` first; renders fixtures with tools/render-fixture.mjs unless
// --no-render is given. Uses require("playwright") and chromium.launch() with no options.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");

const REF_WIDTHS = [320, 360, 390, 600, 1024, 1440, 2560];
const PHONE_MAX = 390;
const SHOT_SIZES = new Set(["390x844", "1440x900", "1000x400", "2560x1440"]);

function parseArgs(argv) {
  const o = {
    fixtures: null,
    modes: ["standalone", "linked"],
    widths: REF_WIDTHS,
    themes: ["light", "dark"],
    render: true,
    shots: true,
    interactions: true,
    e2e: false,
    shotsDir: path.join(root, "design", "screens", "matrix"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--fixtures") o.fixtures = next().split(",").filter(Boolean);
    else if (a === "--modes") o.modes = next().split(",").filter(Boolean);
    else if (a === "--widths") o.widths = next().split(",").map(Number);
    else if (a === "--theme" || a === "--themes") o.themes = next().split(",").filter(Boolean);
    else if (a === "--no-render") o.render = false;
    else if (a === "--no-shots") o.shots = false;
    else if (a === "--no-interactions") o.interactions = false;
    else if (a === "--e2e") o.e2e = true;
    else if (a === "--shots-dir") o.shotsDir = path.resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function expectedBp(width) {
  if (width < 600) return "xs";
  if (width < 1024) return "sm";
  if (width < 1280) return "md";
  if (width < 1600) return "lg";
  if (width < 2200) return "xl";
  return "xxl";
}

function fixtureNames() {
  return [
    ...fs
      .readdirSync(path.join(root, "fixtures"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort(),
    "blank",
    "ws",
    "scriptbreak",
  ];
}

/** Title and section skeleton a fixture must produce (§2.1 presence rules, §4.17 title). */
function expectations(name) {
  if (name === "blank" || name === "ws") return { title: "Scalene", empty: true, sections: [] };
  const file = name === "scriptbreak" ? "basic" : name; // synthetic: basic.json + "</script>" in its source
  const p = JSON.parse(fs.readFileSync(path.join(root, "fixtures", `${file}.json`), "utf8"));
  if (!p || typeof p !== "object" || !p.files || Object.keys(p.files).length === 0) {
    return { title: "Scalene", empty: true, sections: [] };
  }
  const stacks = (p.combined_stacks ?? []).length > 0;
  const memStacks = (p.memory_stacks ?? []).reduce((a, e) => a + (Number(e[1]) || 0), 0) > 0;
  const sections = ["overview", "code"];
  if (stacks || memStacks) sections.push("stacks");
  if (stacks && (p.combined_stacks_timeline ?? []).length > 0) sections.push("timeline");
  if (p.memory === true && Number(p.max_footprint_mb) > 0) sections.push("memory");
  return { title: p.program ? `Scalene - ${p.program}` : "Scalene", empty: false, sections };
}

function viewports(widths) {
  const list = widths.map((w) => ({ width: w, height: w <= PHONE_MAX ? 844 : w >= 2200 ? 1440 : 900 }));
  list.push({ width: 1000, height: 400 }); // Jupyter iframe (short)
  return list;
}

async function inspect(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const bar = document.querySelector("header.appbar");
    const barBox = bar ? bar.getBoundingClientRect() : null;
    return {
      scrollWidth: html.scrollWidth,
      clientWidth: html.clientWidth,
      scale: window.visualViewport ? window.visualViewport.scale : 1,
      classes: html.className,
      theme: html.getAttribute("data-theme"),
      title: document.title,
      appbarHeight: barBox ? barBox.height : 0,
      busy: document.getElementById("scalene-app")?.getAttribute("aria-busy") ?? null,
      sections: Array.from(document.querySelectorAll("main#main > section.report-section")).map((s) => s.id),
      empty: Boolean(document.querySelector(".empty-state")),
      skipLinks: Array.from(document.querySelectorAll(".skip-link")).length,
      // §7.1: profile text must never end the inline <script> (scriptbreak fixture).
      pwned: window.__pwned !== undefined,
      profileDefined: typeof profile !== "undefined",
      // Visible app-bar controls (empty state: logo, Load and Theme only, §4.16).
      barControls: bar
        ? Array.from(bar.querySelectorAll("a, button"))
            .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
            .map((el) => el.getAttribute("aria-label") || el.textContent.trim())
        : [],
    };
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const names = o.fixtures ?? fixtureNames();
  if (o.render) {
    execFileSync(process.execPath, [path.join(root, "tools", "render-fixture.mjs"), "--fixtures", names.join(",")], {
      stdio: "inherit",
    });
  }
  if (o.shots) fs.mkdirSync(o.shotsDir, { recursive: true });

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const failures = [];
  let pages = 0;

  const openPage = async (url, vp, theme) => {
    const phone = vp.width <= PHONE_MAX;
    const context = await browser.newContext({
      viewport: vp,
      isMobile: phone,
      hasTouch: phone,
      deviceScaleFactor: phone ? 3 : 1,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    // Non-standalone pages include the upstream analytics loader; keep checks offline.
    await context.route(/googletagmanager\.com/, (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(url, { waitUntil: "load" });
    // Settled: the report finished mounting its lazy sections (or the empty state is up).
    await page.waitForFunction(
      () =>
        document.getElementById("scalene-app")?.getAttribute("aria-busy") !== "true" &&
        (document.querySelector(".empty-state") !== null || performance.getEntriesByName("scalene:idle-done").length > 0),
      null,
      { timeout: 30000 },
    );
    await page.waitForTimeout(100);
    return { context, page, errors };
  };

  // Overflow with the lens open and with the drawer open (§6.2.9), standalone pages only.
  const interact = async (page, fail) => {
    const lens = await page.evaluate(async () => {
      const row = document.querySelector("#overview .hs-row");
      if (!row) return null;
      row.click();
      for (let i = 0; i < 40 && !document.querySelector("#code .cv-lens, #code .code-dock:not([hidden])"); i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 150));
      return {
        open: !!document.querySelector("#code .cv-lens, #code .code-dock:not([hidden])"),
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      };
    });
    if (lens) {
      if (!lens.open) fail("hotspot jump did not open the detail");
      if (lens.sw !== lens.cw) fail(`horizontal overflow with the lens open (${lens.sw} ≠ ${lens.cw})`);
    }
    const drawer = await page.evaluate(async () => {
      const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      let btn = document.querySelector("header.appbar .appbar-ai");
      if (!visible(btn)) {
        // short / xs: the AI entry lives in the ⋯ menu.
        const more = document.querySelector("header.appbar .appbar-more");
        if (visible(more)) {
          more.click();
          await new Promise((r) => setTimeout(r, 50));
          btn = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((m) => /AI/.test(m.textContent));
        }
      }
      if (!btn) return null;
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const dlg = document.querySelector(".ai-drawer");
      const out = { open: visible(dlg), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, scale: visualViewport ? visualViewport.scale : 1 };
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return out;
    });
    if (drawer) {
      if (!drawer.open) fail("AI drawer did not open");
      if (drawer.sw !== drawer.cw) fail(`horizontal overflow with the drawer open (${drawer.sw} ≠ ${drawer.cw})`);
      if (drawer.scale !== 1) fail(`visualViewport.scale ${drawer.scale} with the drawer open`);
    }
  };

  for (const theme of o.themes)
  for (const name of names) {
    const expect = expectations(name);
    const { title } = expect;
    const isEmpty = expect.empty;
    for (const mode of o.modes) {
      const file = path.join(outDir, `${name}${mode === "linked" ? ".linked" : ""}.html`);
      if (!fs.existsSync(file)) {
        failures.push(`${name} [${mode}]: ${path.relative(root, file)} not rendered`);
        continue;
      }
      const url = `${pathToFileURL(file).href}?still`;
      for (const vp of viewports(o.widths)) {
        const tag = `${name} [${mode}] ${theme} ${vp.width}x${vp.height}`;
        const { context, page, errors } = await openPage(url, vp, theme);
        pages++;
        const r = await inspect(page);
        const fail = (msg) => failures.push(`${tag}: ${msg}`);
        for (const e of errors.splice(0)) fail(e);
        if (r.scrollWidth !== r.clientWidth) fail(`horizontal overflow (scrollWidth ${r.scrollWidth} ≠ clientWidth ${r.clientWidth})`);
        if (r.scale !== 1) fail(`visualViewport.scale = ${r.scale}`);
        const bp = expectedBp(vp.width);
        if (!r.classes.split(/\s+/).includes(`bp-${bp}`)) fail(`expected class bp-${bp}, got "${r.classes}"`);
        const short = vp.height <= 520;
        if (r.classes.split(/\s+/).includes("short") !== short) fail(`"short" class should be ${short}`);
        if (r.title !== title) fail(`document.title "${r.title}" ≠ "${title}"`);
        if (r.appbarHeight < 39) fail("app bar not rendered");
        if (r.skipLinks < 1) fail("skip links missing");
        if (r.pwned) fail("profile source text ran as script (template did not escape '<')");
        if (!r.profileDefined) fail("the template's `const profile` is not defined");
        if (r.theme !== theme) fail(`data-theme "${r.theme}" ≠ "${theme}"`);
        if (isEmpty) {
          if (!r.empty) fail("empty state not shown");
          if (r.sections.length) fail(`empty state shows sections ${r.sections.join(",")}`);
          if (r.barControls.length !== 3) fail(`empty app bar should show logo, Load, Theme (got ${r.barControls.join(" | ")})`);
        } else if (r.sections.join(",") !== expect.sections.join(",")) {
          fail(`section skeleton ${r.sections.join(",") || "none"} ≠ expected ${expect.sections.join(",")}`);
        }
        if (o.shots && mode === "standalone" && SHOT_SIZES.has(`${vp.width}x${vp.height}`)) {
          await page.screenshot({ path: path.join(o.shotsDir, `${name}-${vp.width}x${vp.height}-${theme}.png`) });
        }
        if (o.interactions && mode === "standalone" && !isEmpty) {
          await interact(page, fail);
          for (const e of errors.splice(0)) fail(`after interactions: ${e}`);
        }
        await context.close();
      }
    }
  }

  // Theme toggle: flips data-theme, keeps scroll, persists across reloads.
  const themeFixture = names.find((n) => n !== "empty" && n !== "blank");
  if (themeFixture && o.modes.includes("standalone")) {
    const url = `${pathToFileURL(path.join(outDir, `${themeFixture}.html`)).href}?still`;
    const { context, page, errors } = await openPage(url, { width: 1440, height: 900 }, "light");
    const fail = (msg) => failures.push(`theme toggle (${themeFixture}): ${msg}`);
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await page.evaluate(() => ({ y: window.scrollY, theme: document.documentElement.dataset.theme }));
    // A real pointer click: Playwright's element click would scroll the sticky bar "into view".
    const box = await page.locator("header.appbar .appbar-theme").boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    else fail("theme button not found");
    const after = await page.evaluate(() => ({
      y: window.scrollY,
      theme: document.documentElement.dataset.theme,
      label: document.querySelector("header.appbar .appbar-theme")?.getAttribute("aria-label"),
    }));
    if (after.theme === before.theme) fail("data-theme did not change");
    if (after.y !== before.y) fail(`scrollY changed ${before.y} → ${after.y}`);
    if (after.label !== `Switch to ${before.theme} theme`) fail(`theme button label "${after.label}"`);
    await page.reload({ waitUntil: "load" });
    const persisted = await page.evaluate(() => document.documentElement.dataset.theme);
    if (persisted !== after.theme) fail(`theme not persisted (reload shows ${persisted})`);
    for (const e of errors) fail(e);
    await context.close();
  }

  await browser.close();
  if (failures.length) {
    console.error(`\ncheck failed: ${failures.length} problem(s) on ${pages} page loads`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`check passed: ${pages} page loads (${o.themes.join(" + ")}, ${o.modes.join(" + ")}), no console errors, no overflow`);
  if (o.e2e) execFileSync(process.execPath, [path.join(root, "tools", "e2e.mjs")], { stdio: "inherit" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
