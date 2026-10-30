#!/usr/bin/env node
// Unit tests: runs tests/unit/*.test.mjs with plain node:assert against the
// compiled CommonJS output (default build/, override with SCALENE_BUILD_DIR).
//
//   node build.mjs && node tools/unit.mjs            all tests
//   node tools/unit.mjs format headline              only files whose name contains a filter
//
// Dates are asserted in UTC (DESIGN.md Appendix A), so TZ is pinned before
// any test module loads. Exit code 1 when any test fails.
process.env.TZ = "UTC";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests", "unit");
const filters = process.argv.slice(2);

const { registry } = await import(pathToFileURL(path.join(testDir, "_harness.mjs")).href);

const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();

let passed = 0;
let failed = 0;
let skipped = 0;
const started = performance.now();

for (const file of files) {
  registry.length = 0;
  try {
    await import(pathToFileURL(path.join(testDir, file)).href);
  } catch (e) {
    failed++;
    console.log(`not ok - ${file}: failed to load\n  ${String(e && e.stack ? e.stack : e).split("\n").join("\n  ")}`);
    continue;
  }
  console.log(`# ${file}`);
  for (const t of registry) {
    if (t.skip) {
      skipped++;
      console.log(`ok - ${t.name} # SKIP ${t.skip}`);
      continue;
    }
    try {
      await t.fn();
      passed++;
      console.log(`ok - ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`not ok - ${t.name}\n  ${String(e && e.stack ? e.stack : e).split("\n").slice(0, 12).join("\n  ")}`);
    }
  }
}

const ms = (performance.now() - started).toFixed(0);
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (${files.length} files, ${ms} ms)`);
process.exit(failed > 0 ? 1 : 0);
