#!/usr/bin/env node
// Token checks (DESIGN.md §3.2, §3.7):
//  1. src/styles/00-tokens.css is exactly the §3.2 token block of DESIGN.md;
//  2. the mono stack contains no ligature face (must-fix 1);
//  3. the §3.7 contrast table, recomputed from the tokens (WCAG 2.x relative
//     luminance): text ≥ 4.5, graphics and control boundaries ≥ 3.0, both themes;
//  4. radii stay on the §3.2 scale: every `border-radius` in src/styles is a `--r-*` token
//     (or a calc() of one), 0, 50% or a ≤ 2 px hairline rounding of a tiny mark — never an
//     off-scale literal like 4px or 18px (round 1 review).
//
// Usage: node tools/check-tokens.mjs [--verbose]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { radiusViolations } from "./css-ownership.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");
const tokensPath = path.join(root, "src", "styles", "00-tokens.css");
const css = fs.readFileSync(tokensPath, "utf8");
const failures = [];

// ── 1. Exact copy of §3.2 ─────────────────────────────────────────────────────
{
  const design = fs.readFileSync(path.join(root, "DESIGN.md"), "utf8");
  const m = /### 3\.2 Token block[^\n]*\n+```css\n([\s\S]*?)\n```/.exec(design);
  if (!m) failures.push("DESIGN.md: §3.2 token block not found");
  else {
    const norm = (s) => s.replace(/[ \t]+$/gm, "").trim();
    if (norm(m[1]) !== norm(css)) {
      const a = norm(m[1]).split("\n");
      const b = norm(css).split("\n");
      const i = a.findIndex((line, k) => line !== b[k]);
      failures.push(`00-tokens.css differs from DESIGN.md §3.2 (first difference at line ${i + 1}: ${JSON.stringify(b[i] ?? "<eof>")})`);
    }
  }
}

// ── Parse the light (:root) and dark blocks ─────────────────────────────────────
function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`block ${selector} not found`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error(`block ${selector} not closed`);
}

function declarations(text) {
  const out = {};
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().replace(/\s+/g, " ");
  return out;
}

const light = declarations(block(":root"));
const dark = { ...light, ...declarations(block(':root[data-theme="dark"]')) };

function resolve(tokens, value, depth = 0) {
  const m = /^var\(--([\w-]+)\)$/.exec(value);
  if (!m) return value;
  if (depth > 8 || !(m[1] in tokens)) throw new Error(`cannot resolve ${value}`);
  return resolve(tokens, tokens[m[1]], depth + 1);
}

function rgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`not an opaque hex colour: ${value}`);
}

function luminance([r, g, b]) {
  const ch = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a, b) {
  const la = luminance(rgb(a));
  const lb = luminance(rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── 2. Ligature-free mono stack ──────────────────────────────────────────────────
for (const face of ["Cascadia Code", "JetBrains Mono", "Fira Code"]) {
  if (light["font-mono"].includes(`"${face}"`)) failures.push(`--font-mono contains the ligature face "${face}"`);
}

// ── 3. Contrast table (§3.7) ───────────────────────────────────────────────────
const TEXT = 4.5;
const GRAPHIC = 3.0;
const INK_LIGHT = "#FFFFFF"; // label ink at/after the ramp split (light theme)
const INK_DARK = "#07090D"; //  … dark theme

function pairs(theme) {
  const t = theme === "light" ? light : dark;
  const c = (name) => resolve(t, t[name]);
  const list = [];
  const add = (label, fg, bg, target) => list.push({ label, fg, bg, target });
  for (const n of ["fg", "fg-2", "fg-3"]) add(`--${n} on --surface`, c(n), c("surface"), TEXT);
  add("--fg-3 on --sunken", c("fg-3"), c("sunken"), TEXT);
  add("--fg-3 on --raised", c("fg-3"), c("raised"), TEXT);
  add("--control on --surface", c("control"), c("surface"), GRAPHIC);
  add("--control on --page", c("control"), c("page"), GRAPHIC);
  for (const n of ["cpu-py", "cpu-native", "cpu-sys", "mem-py", "mem-native", "copy", "gpu", "gpu-mem", "async", "gil", "gc"]) {
    add(`--${n} on --surface`, c(n), c("surface"), GRAPHIC);
  }
  add("--danger on --surface (text)", c("danger"), c("surface"), TEXT);
  add("--danger on --danger-wash", c("danger"), c("danger-wash"), TEXT);
  add("frame Python : native", c("frame-py"), c("frame-native"), GRAPHIC);
  for (const k of ["py", "native", "await", "unresolved", "root"]) {
    add(`--frame-${k}-ink on --frame-${k}`, c(`frame-${k}-ink`), c(`frame-${k}`), TEXT);
  }
  if (theme === "dark") add("--frame-native vs --surface", c("frame-native"), c("surface"), GRAPHIC);
  add("--frame-lod vs --surface", c("frame-lod"), c("surface"), GRAPHIC);
  for (const n of ["syn-text", "syn-kw", "syn-str", "syn-num", "syn-com", "syn-builtin"]) {
    add(`--${n} on --surface`, c(n), c("surface"), TEXT);
  }
  for (const w of ["wash-cpu", "wash-mem", "wash-gpu", "wash-await", "select", "flash"]) {
    add(`--syn-com on --${w}`, c("syn-com"), c(w), TEXT);
  }
  for (const n of ["thread-0", "thread-1", "thread-2", "thread-3", "thread-4", "thread-other"]) {
    add(`--${n} on --surface`, c(n), c("surface"), GRAPHIC);
  }
  for (const ramp of ["cpu", "mem"]) {
    const split = Number(t[`${ramp}-ramp-ink-split`]);
    for (let i = 0; i <= 5; i++) {
      const ink = i < split ? c("fg") : theme === "light" ? INK_LIGHT : INK_DARK;
      add(`--${ramp}-ramp-${i} label`, ink, c(`${ramp}-ramp-${i}`), TEXT);
    }
  }
  for (const s of ["page", "surface", "raised", "raised-2", "sunken"]) add(`focus ring on --${s}`, c("focus"), c(s), GRAPHIC);
  return list;
}

let checked = 0;
for (const theme of ["light", "dark"]) {
  for (const p of pairs(theme)) {
    const ratio = contrast(p.fg, p.bg);
    checked++;
    const ok = ratio + 1e-9 >= p.target;
    if (!ok) failures.push(`${theme}: ${p.label} = ${ratio.toFixed(2)} (target ${p.target})`);
    if (verbose) console.log(`${ok ? "ok  " : "FAIL"} ${theme.padEnd(5)} ${p.label.padEnd(36)} ${ratio.toFixed(2).padStart(6)}  ≥ ${p.target}`);
  }
}

// ── 4. Radius scale ───────────────────────────────────────────────────────────
let radiusChecked = 0;
{
  const dir = path.join(root, "src", "styles");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".css")).sort()) {
    if (f === "00-tokens.css") continue;
    radiusChecked++;
    failures.push(...radiusViolations(f, fs.readFileSync(path.join(dir, f), "utf8")));
  }
}

if (failures.length) {
  console.error(`check-tokens failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`check-tokens passed: tokens match DESIGN.md §3.2, mono stack is ligature-free, ${checked} contrast pairs meet §3.7, radii on scale in ${radiusChecked} stylesheets`);
