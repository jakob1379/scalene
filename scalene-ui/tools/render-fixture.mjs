#!/usr/bin/env node
// Render template/index.html.template with fixture profiles, the way Scalene's
// generate_html() does, in both modes:
//
//   out/<name>.html          standalone (bundle and favicon inlined)
//   out/<name>.linked.html   non-standalone (<script src="scalene-gui-bundle.js">)
//
// Usage:
//   node tools/render-fixture.mjs [--fixtures ml-training,empty] [--out out]
//                                 [--mode both|standalone|linked] [--engine node|python]
//                                 [--favicon path/to/favicon.ico]
//
// The default engine implements the Jinja subset the template uses: {{ x }},
// {{ ((profile or '') | trim or '""') | replace('<', '\\u003c') }} (names, literals, `or`,
// the trim/replace filters), {% if x %}/{% if not x %}/{% else %}/{% endif %}, {# #}.
// `--engine python` renders with the real jinja2 package instead (parity check).
// Synthetic fixtures exercise the template guards: "blank" (profile = ""), "ws" (a
// whitespace-only file) and "scriptbreak" (basic.json whose source holds </script> and
// <!--<script, which must not end the inline <script>).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCALENE_VERSION = "2.4.0";
const SCALENE_DATE = "2026.10.23";

function parseArgs(argv) {
  const opts = { fixtures: null, out: path.join(root, "out"), mode: "both", engine: "node", favicon: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--fixtures") opts.fixtures = next().split(",").filter(Boolean);
    else if (a === "--out") opts.out = path.resolve(next());
    else if (a === "--mode") opts.mode = next();
    else if (a === "--engine") opts.engine = next();
    else if (a === "--favicon") opts.favicon = path.resolve(next());
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!["both", "standalone", "linked"].includes(opts.mode)) throw new Error(`bad --mode ${opts.mode}`);
  if (!["node", "python"].includes(opts.engine)) throw new Error(`bad --engine ${opts.engine}`);
  return opts;
}

// ── Jinja subset ───────────────────────────────────────────────────────────────

const TAG_RE = /\{%-?\s*(if|else|endif)\b\s*(.*?)\s*-?%\}/g;

function evalCond(expr, vars) {
  const m = /^(not\s+)?([A-Za-z_]\w*)$/.exec(expr.trim());
  if (!m) throw new Error(`unsupported condition: ${expr}`);
  const v = Boolean(vars[m[2]]);
  return m[1] ? !v : v;
}

// Expressions: names, '…' literals, (…), `a or b`, and the filters `trim` and
// `replace(old, new)` — enough for
//   {{ ((profile or '') | trim or '""') | replace('<', '\\u003c') }}
// with Jinja semantics (Python truthiness, str.strip() whitespace, literal escapes).
const PY_SPACE = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

function pyStrip(text) {
  let a = 0;
  let b = text.length;
  while (a < b && PY_SPACE.includes(text[a])) a++;
  while (b > a && PY_SPACE.includes(text[b - 1])) b--;
  return text.slice(a, b);
}

/** Jinja string literal body → value (its lexer decodes Python unicode escapes). */
function unescapeLiteral(body) {
  const simple = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, e) => {
    if (e[0] === "u" || e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    return e in simple ? simple[e] : m;
  });
}

const FILTERS = {
  trim: (v) => pyStrip(toStr(v)),
  replace: (v, from, to) => toStr(v).split(toStr(from)).join(toStr(to)),
};

const toStr = (v) => (v === undefined || v === null ? "" : String(v));

function evalExpr(expr, vars) {
  const toks = [];
  const re = /\s*(?:([A-Za-z_]\w*)|'((?:[^'\\]|\\.)*)'|(\|)|(\()|(\))|(,))/y;
  const text = expr.trim();
  re.lastIndex = 0;
  while (re.lastIndex < text.length) {
    const at = re.lastIndex;
    const m = re.exec(text);
    if (!m || m.index !== at) throw new Error(`unsupported expression: {{ ${expr} }}`);
    if (m[1] !== undefined) toks.push({ k: m[1] === "or" ? "or" : "name", v: m[1] });
    else if (m[2] !== undefined) toks.push({ k: "str", v: unescapeLiteral(m[2]) });
    else toks.push({ k: m[0].trim() });
  }
  let i = 0;
  const peek = () => toks[i] && toks[i].k;
  const take = (k) => {
    if (peek() !== k) throw new Error(`unsupported expression: {{ ${expr} }}`);
    return toks[i++];
  };
  function primary() {
    if (peek() === "(") {
      take("(");
      const v = orExpr();
      take(")");
      return v;
    }
    if (peek() === "str") return take("str").v;
    const name = take("name").v;
    return vars[name];
  }
  function filtered() {
    let v = primary();
    while (peek() === "|") {
      take("|");
      const name = take("name").v;
      const args = [];
      if (peek() === "(") {
        take("(");
        while (peek() !== ")") {
          args.push(orExpr());
          if (peek() === ",") take(",");
        }
        take(")");
      }
      if (!FILTERS[name]) throw new Error(`unsupported filter ${name} in {{ ${expr} }}`);
      v = FILTERS[name](v, ...args);
    }
    return v;
  }
  function orExpr() {
    let v = filtered();
    while (peek() === "or") {
      take("or");
      const rhs = filtered();
      if (!v) v = rhs;
    }
    return v;
  }
  const v = orExpr();
  if (i !== toks.length) throw new Error(`unsupported expression: {{ ${expr} }}`);
  return toStr(v);
}

/** Resolve {% if %} blocks (nesting allowed) into the kept text. */
function renderBlocks(text, vars) {
  const out = [];
  const stack = []; // { active, taken }
  let last = 0;
  const emitting = () => stack.every((s) => s.active);
  for (const m of text.matchAll(TAG_RE)) {
    if (emitting()) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, tag, arg] = m;
    if (tag === "if") {
      const active = evalCond(arg, vars);
      stack.push({ active, taken: active });
    } else if (tag === "else") {
      const top = stack[stack.length - 1];
      if (!top) throw new Error("{% else %} without {% if %}");
      top.active = !top.taken;
      top.taken = true;
    } else {
      if (!stack.pop()) throw new Error("{% endif %} without {% if %}");
    }
  }
  if (stack.length) throw new Error("unclosed {% if %}");
  out.push(text.slice(last));
  return out.join("");
}

export function renderTemplate(template, vars) {
  // Jinja's default keep_trailing_newline=False drops one trailing newline of the source.
  const source = template.replace(/\r?\n$/, "");
  const noComments = source.replace(/\{#[\s\S]*?#\}/g, "");
  const blocks = renderBlocks(noComments, vars);
  // Substitute in one pass so inserted values (the bundle, the profile) are never re-scanned.
  return blocks.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expr) => evalExpr(expr, vars));
}

function renderWithPython(templatePath, vars, scratchDir) {
  const varsFile = path.join(scratchDir, ".render-vars.json");
  fs.writeFileSync(varsFile, JSON.stringify(vars));
  const script = [
    "import json, sys, jinja2",
    "tpl_path, vars_path = sys.argv[1], sys.argv[2]",
    "env = jinja2.Environment(loader=jinja2.FileSystemLoader(__import__('os').path.dirname(tpl_path)))",
    "tpl = env.get_template(__import__('os').path.basename(tpl_path))",
    "sys.stdout.write(tpl.render(**json.load(open(vars_path, encoding='utf-8'))))",
  ].join("\n");
  try {
    return execFileSync("python3", ["-c", script, templatePath, varsFile], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
  } finally {
    fs.rmSync(varsFile, { force: true });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function listFixtures() {
  const dir = path.join(root, "fixtures");
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  return [...names, ...Object.keys(SYNTHETIC)];
}

/** A source line that would end an inline <script> if the template did not escape '<'. */
export const SCRIPT_BREAK_LINE = 'html = "</script><script>window.__pwned=1</script><!-- <script>"';

/** Synthetic fixtures (template guards, §7.1): name → profile text. */
export const SYNTHETIC = {
  blank: () => "",
  ws: () => "\n",
  scriptbreak: () => {
    const p = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "basic.json"), "utf8"));
    const file = Object.values(p.files)[0];
    file.lines[0].line = SCRIPT_BREAK_LINE + "\n";
    file.lines[1].line = "# <!--<script> stays in a comment\n";
    return JSON.stringify(p, null, 4);
  },
};

/** The profile text exactly as generate_html() reads it (file content, verbatim). */
export function profileText(name) {
  if (SYNTHETIC[name]) return SYNTHETIC[name]();
  return fs.readFileSync(path.join(root, "fixtures", `${name}.json`), "utf8");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const templatePath = path.join(root, "template", "index.html.template");
  const bundlePath = path.join(root, "dist", "scalene-gui-bundle.js");
  if (!fs.existsSync(bundlePath)) {
    console.error("dist/scalene-gui-bundle.js not found: run `node build.mjs` first");
    process.exit(1);
  }
  const template = fs.readFileSync(templatePath, "utf8");
  const guiJs = fs.readFileSync(bundlePath, "utf8");
  const favicon = opts.favicon && fs.existsSync(opts.favicon) ? fs.readFileSync(opts.favicon) : null;
  fs.mkdirSync(opts.out, { recursive: true });
  if (opts.mode !== "standalone") {
    fs.copyFileSync(bundlePath, path.join(opts.out, "scalene-gui-bundle.js"));
    if (favicon) fs.writeFileSync(path.join(opts.out, "favicon.ico"), favicon);
  }

  const names = opts.fixtures ?? listFixtures();
  const modes = opts.mode === "both" ? [true, false] : [opts.mode === "standalone"];
  for (const name of names) {
    const profile = profileText(name);
    for (const standalone of modes) {
      const vars = {
        profile,
        scalene_version: SCALENE_VERSION,
        scalene_date: SCALENE_DATE,
        standalone,
        gui_js: standalone ? guiJs : "",
        favicon_base64: standalone && favicon ? favicon.toString("base64") : "",
      };
      const html =
        opts.engine === "python" ? renderWithPython(templatePath, vars, opts.out) : renderTemplate(template, vars);
      const file = path.join(opts.out, `${name}${standalone ? "" : ".linked"}.html`);
      fs.writeFileSync(file, html);
      console.log(`${path.relative(root, file)}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
