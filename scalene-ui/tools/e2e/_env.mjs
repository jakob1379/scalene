// Shared setup for the browser acceptance suites in tools/e2e/ (DESIGN.md §8.6 WP6).
// Every suite reads rendered pages from out/ (node build.mjs && node tools/render-fixture.mjs),
// uses require("playwright") with chromium.launch() and no options, prints one
// "PASS  name — detail" / "FAIL  name — detail" line per check, writes its results to
// out/e2e/<suite>.json and exits 1 when a check fails.
//
// Environment: SCALENE_ROOT=<tree> runs a suite against another tree's out/ (default: this repo);
// SHOTS=<dir> moves the screenshots (default: design/screens/e2e/<suite>/, gitignored).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** The repository's scalene-ui directory. */
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The tree whose out/ is tested. */
export const root = path.resolve(process.env.SCALENE_ROOT || repo);
export const outDir = path.join(root, "out");
export const fixturesDir = path.join(repo, "fixtures");

export const { chromium } = require("playwright");

/** file:// URL of a rendered fixture page (`q` is the query string with or without "?"). */
export function pageUrl(name, q = "still") {
  const query = q ? (q.startsWith("?") ? q : `?${q}`) : "";
  return `${pathToFileURL(path.join(outDir, `${name}.html`)).href}${query}`;
}

/** The screenshot directory of a suite (created). */
export function shotsDir(suite) {
  const dir = path.resolve(process.env.SHOTS || path.join(repo, "design", "screens", "e2e", suite));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `--only a,b` filter: true when no filter is given or `name` contains one of the parts. */
export function onlyFilter(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--only");
  const parts = i >= 0 && argv[i + 1] ? argv[i + 1].split(",").filter(Boolean) : null;
  return (name) => !parts || parts.some((p) => name.includes(p));
}

/** Read a fixture JSON from the repository. */
export function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8"));
}

/**
 * A result log: `check(name, ok, detail)` prints and records one check; `finish()` writes
 * out/e2e/<suite>.json, prints the tally and returns the process exit code.
 */
export function createReport(suite) {
  const results = [];
  const check = (name, ok, detail = "") => {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    results.push({ name, ok: !!ok, detail: text });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? `  — ${text}` : ""}`);
    return !!ok;
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    const dir = path.join(outDir, "e2e");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${suite}.json`), JSON.stringify({ suite, at: new Date().toISOString(), results }, null, 2));
    console.log(`\n${suite}: ${results.length - failed.length}/${results.length} passed`);
    return failed.length ? 1 : 0;
  };
  return { check, finish, results };
}

/**
 * Open a page in a fresh context. Options: w, h, theme (stored before load), q (query),
 * reduced (prefers-reduced-motion), mobile (defaults to w ≤ 390: isMobile, touch, DPR 3),
 * wait ("load" | "domcontentloaded"), init (extra init script), initArg.
 * Returns { context, page, errors } where `errors` collects console errors and page errors.
 */
export async function openPage(browser, name, o = {}) {
  const w = o.w ?? 1440;
  const h = o.h ?? 900;
  const mobile = o.mobile ?? w <= 390;
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: o.theme === "dark" ? "dark" : "light",
    reducedMotion: o.reduced ? "reduce" : "no-preference",
  });
  await context.route(/googletagmanager\.com/, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  if (o.theme) await context.addInitScript((t) => { try { localStorage.setItem("scalene-theme", t); } catch {} }, o.theme);
  if (o.init) await context.addInitScript(o.init, o.initArg);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(o.url ?? pageUrl(name, o.q ?? "still"), { waitUntil: o.wait ?? "load" });
  return { context, page, errors };
}

/** Pixel diff ratio of two PNG buffers (channel delta > 24), computed in a browser page. */
export async function pngDiff(browser, a, b) {
  const page = await browser.newPage();
  const r = await page.evaluate(async ([A, B]) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + s; });
    const [ia, ib] = await Promise.all([load(A), load(B)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, w, h).data;
    x.clearRect(0, 0, w, h); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, w, h).data;
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > 24) bad++;
    return { ratio: bad / (w * h), w, h };
  }, [a.toString("base64"), b.toString("base64")]);
  await page.close();
  return r;
}
