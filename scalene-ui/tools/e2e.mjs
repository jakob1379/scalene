#!/usr/bin/env node
// Browser acceptance suite runner (DESIGN.md §8.6 WP6). Runs every suite in tools/e2e/ one
// after another (they measure frame and draw times, so never in parallel) and prints a tally.
//
//   node tools/e2e.mjs [--suites overview,code,canvas,shell-ai,linking,verify] [--prepare]
//
// --prepare runs `node build.mjs` and `node tools/render-fixture.mjs` first; otherwise the
// suites read the pages already in out/. Each suite also runs on its own:
// `node tools/e2e/<suite>.mjs [--only …]`. Results: out/e2e/<suite>.json and out/e2e/summary.json.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = ["overview", "code", "canvas", "shell-ai", "linking", "verify"];

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const suites = arg("--suites") ? arg("--suites").split(",").filter(Boolean) : SUITES;
for (const s of suites) if (!SUITES.includes(s)) throw new Error(`unknown suite ${s} (known: ${SUITES.join(", ")})`);

if (argv.includes("--prepare")) {
  execFileSync(process.execPath, [path.join(root, "build.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(root, "tools", "render-fixture.mjs")], { stdio: "inherit" });
}

function run(suite) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(root, "tools", "e2e", `${suite}.mjs`)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pass = 0;
    let fail = 0;
    let tally = null;
    const onLine = (line) => {
      if (/^PASS\b/.test(line)) pass++;
      else if (/^FAIL\b/.test(line)) fail++;
      const m = /^[\w-]+: (\d+)\/(\d+) passed$/.exec(line.trim());
      if (m) tally = { passed: Number(m[1]), total: Number(m[2]) };
    };
    const pipe = (stream, out) => {
      let buf = "";
      stream.on("data", (d) => {
        out.write(d);
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      stream.on("end", () => buf && onLine(buf));
    };
    console.log(`\n━━ ${suite} ━━`);
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on("close", (code) => {
      const total = tally ? tally.total : pass + fail;
      const passed = tally ? tally.passed : pass;
      resolve({ suite, code, passed, total, seconds: Math.round((Date.now() - t0) / 1000) });
    });
  });
}

const results = [];
for (const s of suites) results.push(await run(s));

console.log("\n━━ e2e summary ━━");
for (const r of results) {
  const status = r.code === 0 ? "ok  " : "FAIL";
  console.log(`${status} ${r.suite.padEnd(10)} ${String(r.passed).padStart(4)}/${String(r.total).padEnd(4)} ${r.seconds}s${r.code > 1 ? ` (exit ${r.code})` : ""}`);
}
fs.mkdirSync(path.join(root, "out", "e2e"), { recursive: true });
fs.writeFileSync(path.join(root, "out", "e2e", "summary.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const bad = results.filter((r) => r.code !== 0);
if (bad.length) {
  console.error(`\ne2e failed: ${bad.map((r) => r.suite).join(", ")}`);
  process.exit(1);
}
console.log(`\ne2e passed: ${results.reduce((a, r) => a + r.total, 0)} checks in ${results.length} suites`);
