// Shared helpers for tests/unit/*.test.mjs (driven by tools/unit.mjs).
// Tests load the compiled CommonJS modules from build/ (or SCALENE_BUILD_DIR)
// and the JSON fixtures from fixtures/ (large fixtures are generated and may
// be absent: tests that need them are skipped, not failed).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

export const buildDir = process.env.SCALENE_BUILD_DIR ? path.resolve(process.env.SCALENE_BUILD_DIR) : path.join(root, "build");

/** @type {{ name: string, fn: () => unknown, skip?: string }[]} */
export const registry = [];

/** Register a test. */
export function test(name, fn) {
  registry.push({ name, fn });
}

/** Register a skipped test with a reason. */
export function skip(name, reason) {
  registry.push({ name, fn: () => {}, skip: reason });
}

/** require() a compiled module, e.g. `mod("core/format")`. */
export function mod(id) {
  return require(path.join(buildDir, `${id}.js`));
}

const fixtureCache = new Map();

/** Parsed fixture JSON (cached), or null when the file is absent. */
export function fixture(name) {
  if (fixtureCache.has(name)) return fixtureCache.get(name);
  const p = path.join(root, "fixtures", `${name}.json`);
  const value = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  fixtureCache.set(name, value);
  return value;
}

const modelCache = new Map();

/** Built model for a fixture (cached), or null when the fixture is absent. */
export function model(name) {
  if (modelCache.has(name)) return modelCache.get(name);
  const raw = fixture(name);
  const m = raw === null ? null : mod("model/model").buildModel(raw, { version: "2.4.0" });
  modelCache.set(name, m);
  return m;
}

/** Register a test that needs a fixture model; skipped when the fixture is absent. */
export function withModel(name, title, fn) {
  if (fixture(name) === null) skip(`${name}: ${title}`, `fixtures/${name}.json not generated`);
  else test(`${name}: ${title}`, () => fn(model(name)));
}

export const FIXTURES = ["ml-training", "async-server", "cpu-only", "neuron", "basic", "example", "huge"];

/** Plain text of a segment list. */
export function plain(segs) {
  return segs.map((s) => s.s).join("");
}

/** Line in a model by `base:line` (e.g. "train.py:173"). */
export function lineOf(m, loc) {
  const [base, no] = loc.split(":");
  for (const f of m.files.concat(m.hiddenFiles)) if (f.base === base) return f.byNo.get(Number(no)) ?? null;
  return null;
}

/** "train.py:173" for a line. */
export function loc(line) {
  return `${line.file.base}:${line.no}`;
}

/** Round to one decimal (golden values are quoted that way). */
export function r1(v) {
  return Math.round(v * 10) / 10;
}
