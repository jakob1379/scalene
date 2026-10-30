// Build the self-contained prototype pages: node build.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, "src", f), "utf8");
const fixtures = path.join(here, "..", "..", "fixtures");
const js = fs.readdirSync(path.join(here, "src")).filter((f) => /^\d\d-.*\.js$/.test(f)).sort().map(src).join("\n");
const css = src("style.css");
const shell = src("shell.html");
const pages = { "index.html": "ml-training.json", "index-async.html": "async-server.json", "index-cpu.html": "cpu-only.json", "index-empty.html": "empty.json", "index-huge.html": "huge.json", "index-neuron.html": "neuron.json", "index-example.html": "example.json" };
for (const [out, fx] of Object.entries(pages)) {
  const data = fs.readFileSync(path.join(fixtures, fx), "utf8").replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
  const html = shell.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => js).replace("/*__DATA__*/", () => data);
  fs.writeFileSync(path.join(here, out), html);
  console.log(out, (html.length / 1e6).toFixed(2) + " MB");
}
