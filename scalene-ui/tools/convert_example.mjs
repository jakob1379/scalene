#!/usr/bin/env node
// Convert upstream scalene-gui/example-profile.js to JSON.
//
//   node tools/convert_example.mjs <example-profile.js> <out.json | ->
//
// example-profile.js is a JS *object literal* (`const example_profile = {...};`
// with unquoted keys and trailing commas), so JSON.parse cannot read it. We
// evaluate it in an empty node:vm context (no require, no process, no globals)
// with a timeout and serialize the resulting object. gen_fixtures.py calls this
// when node is available and falls back to its own tokenizer otherwise.
import fs from "node:fs";
import vm from "node:vm";

const [, , src, out = "-"] = process.argv;
if (!src) {
  console.error("usage: convert_example.mjs <example-profile.js> <out.json | ->");
  process.exit(2);
}
const code = fs.readFileSync(src, "utf8");
const context = vm.createContext(Object.create(null));
const value = vm.runInContext(`${code}\n;example_profile`, context, { timeout: 5000 });
// Round-trip through JSON inside this realm so prototypes from the vm context don't leak.
const json = JSON.stringify(value, null, 4);
if (json === undefined) throw new Error("example_profile is not serializable");
if (out === "-") process.stdout.write(json + "\n");
else fs.writeFileSync(out, json + "\n");
