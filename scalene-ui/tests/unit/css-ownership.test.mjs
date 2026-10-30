// Stylesheet ownership (round 1 review, scope-card-sc-row-collision): a bare class selector may be
// defined by one package stylesheet only (build.mjs runs the same check).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cssClassCollisions } from "../../tools/css-ownership.mjs";
import { test } from "./_harness.mjs";

const styles = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "styles");

test("css ownership: the round-1 .sc-row collision is detected; contextual overrides are not", () => {
  const files = [
    ["03-controls.css", ".chip-code { padding: 1px 6px; }"],
    ["20-overview.css", ".sc-row { display: flex; }\n.chip-code:focus-visible { outline-offset: 1px; }\n.short .hs-row { height: 32px; }"],
    ["80-shell.css", "/* shortcuts */ .sc-row { display: grid; }\n@media (max-width: 600px) { .short .hs-row { height: 40px; } }"],
  ];
  assert.deepEqual(cssClassCollisions(files), [".sc-row is defined in 20-overview.css and 80-shell.css"]);
});

test("css ownership: src/styles has no cross-package class collisions", () => {
  const files = fs
    .readdirSync(styles)
    .filter((f) => f.endsWith(".css"))
    .sort()
    .map((f) => [f, fs.readFileSync(path.join(styles, f), "utf8")]);
  assert.deepEqual(cssClassCollisions(files), []);
});

test("css ownership: the shortcuts dialog rows are .kbd-row, the scope card owns .sc-row", () => {
  const shell = fs.readFileSync(path.join(styles, "80-shell.css"), "utf8");
  assert.ok(!/\.sc-row\b/.test(shell), "80-shell.css must not style .sc-row");
  assert.ok(/\.kbd-row\s*\{[^}]*display:\s*grid/.test(shell));
});

test("radius scale: off-scale literals are flagged; tokens, calc(token), 0, 50% and ≤ 2 px pass", async () => {
  const { radiusViolations } = await import("../../tools/css-ownership.mjs");
  const css = [
    ".a { border-radius: 4px; }",
    ".b { border-radius: 18px; }",
    ".c { border-radius: var(--r-sm); }",
    ".d { border-radius: calc(var(--r-sm) - 2px); }",
    ".e { border-radius: 50%; }",
    ".f { border-radius: 2px; }",
    ".g { border-radius: var(--r-xs) 0 0 var(--r-xs); }",
    ".h { border-top-left-radius: 5px; }",
  ].join("\n");
  const v = radiusViolations("x.css", css);
  assert.equal(v.length, 3, v.join("\n"));
  assert.match(v[0], /^x\.css:1: border-radius 4px/);
  assert.match(v[1], /18px/);
  assert.match(v[2], /^x\.css:8:/);
});

test("radius scale: the shell/AI/control stylesheets use only scale radii", async () => {
  const { radiusViolations } = await import("../../tools/css-ownership.mjs");
  for (const f of fs.readdirSync(styles).filter((x) => /^(0[1-4]|10|70|80|90)-.*\.css$/.test(x))) {
    assert.deepEqual(radiusViolations(f, fs.readFileSync(path.join(styles, f), "utf8")), []);
  }
});
