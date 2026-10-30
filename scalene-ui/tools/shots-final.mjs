#!/usr/bin/env node
// Screenshot set for a review round (design/screens/final/ by default): every fixture of the set
// at 2560×1440, 1440×900, 1024×768, 390×844 (phone, touch, DPR 2) and 1000×400 (Jupyter host), in
// light and dark, first screen (`?still`, final frames). At 1440×900 each section is also shot
// (`-code`, `-stacks`, `-timeline`, `-memory`). Restart-safe: existing files are kept unless --force.
//
//   node tools/shots-final.mjs [--fixtures ml-training,huge] [--out design/screens/final] [--force]
//
// Requires `node build.mjs` and `node tools/render-fixture.mjs` first.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const fixtures = (arg("--fixtures") ?? "ml-training,async-server,cpu-only,neuron,huge,empty").split(",").filter(Boolean);
const outDir = path.resolve(arg("--out") ?? path.join(root, "design", "screens", "final"));
const force = argv.includes("--force");
const SIZES = [
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844, phone: true },
  { width: 1000, height: 400 },
];
const SECTIONS = ["code", "stacks", "timeline", "memory"];

fs.mkdirSync(outDir, { recursive: true });
const { chromium } = require("playwright");
const browser = await chromium.launch();
let shot = 0;
let kept = 0;
const problems = [];
try {
  for (const fx of fixtures) {
    const file = path.join(root, "out", `${fx}.html`);
    if (!fs.existsSync(file)) {
      problems.push(`${fx}: out/${fx}.html not rendered`);
      continue;
    }
    for (const theme of ["light", "dark"]) {
      for (const vp of SIZES) {
        const base = `${fx}-${vp.width}x${vp.height}-${theme}`;
        const wantSections = vp.width === 1440;
        const targets = [base, ...(wantSections ? SECTIONS.map((s) => `${base}-${s}`) : [])];
        if (!force && targets.every((t) => fs.existsSync(path.join(outDir, `${t}.png`)))) {
          kept += targets.length;
          continue;
        }
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: !!vp.phone,
          hasTouch: !!vp.phone,
          deviceScaleFactor: vp.phone ? 2 : 1,
          colorScheme: theme,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`${pathToFileURL(file).href}?still`, { waitUntil: "load" });
        await page.waitForFunction(
          () =>
            document.getElementById("scalene-app")?.getAttribute("aria-busy") !== "true" &&
            (document.querySelector(".empty-state") !== null || performance.getEntriesByName("scalene:idle-done").length > 0),
          null,
          { timeout: 60000 },
        );
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(outDir, `${base}.png`) });
        shot++;
        if (wantSections) {
          for (const s of SECTIONS) {
            const has = await page.evaluate((id) => {
              const el = document.getElementById(id);
              if (!el) return false;
              el.scrollIntoView({ block: "start" });
              return true;
            }, s);
            if (!has) continue;
            await page.waitForTimeout(400);
            await page.screenshot({ path: path.join(outDir, `${base}-${s}.png`) });
            shot++;
          }
        }
        const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (ov) problems.push(`${base}: horizontal overflow ${ov}px`);
        for (const e of errors) problems.push(`${base}: ${e}`);
        await context.close();
      }
    }
    console.log(`${fx}: done`);
  }
} finally {
  await browser.close();
}
console.log(`${shot} screenshots written, ${kept} kept, into ${path.relative(root, outDir)}`);
for (const p of problems) console.log(`PROBLEM ${p}`);
process.exit(problems.length ? 1 : 0);
