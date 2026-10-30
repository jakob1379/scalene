// §7.5 upstream test contract: re-implements the checks of upstream
// tests/test_combined_stacks_gui.py against our TS entry, bundle and
// template (DESIGN.md §8.6 WP1 acceptance 4). Template rendering uses the
// real jinja2 (as Scalene's generate_html does) when python3 has it.
//
// With SCALENE_SRC=<path to a Scalene checkout> the last test also calls
// upstream's own scalene_utility.generate_html (both modes) and
// launchbrowser.generate_html on our template and bundle, and requires
// tools/render-fixture.mjs to produce byte-identical pages.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { renderTemplate, SCRIPT_BREAK_LINE, SYNTHETIC } from "../../tools/render-fixture.mjs";
import { skip, test } from "./_harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TS_ENTRY = path.join(root, "src", "scalene-gui.ts");
const BUNDLE = path.join(root, "dist", "scalene-gui-bundle.js");
const TEMPLATE = path.join(root, "template", "index.html.template");

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

function maybe(name, file, fn) {
  const text = read(file);
  if (text === null) skip(name, `${path.relative(root, file)} not built yet`);
  else test(name, () => fn(text));
}

maybe("bundle contains the toggle globals and axis class names", BUNDLE, (src) => {
  for (const sym of ["toggleCombinedStacks", "toggleCombinedStacksTimeline", "toggleMemoryStacks", "timeline-axis", "timeline-gridlines", "memory-axis", "memory-gridlines"]) {
    assert.ok(src.includes(sym), `bundle is missing ${sym}`);
  }
});

maybe("bundle can be inlined in <script> and carries no fixture marker text", BUNDLE, (src) => {
  assert.ok(!src.includes("</script"), "</script would end the inline script");
  assert.ok(!src.includes("<!--"));
  assert.ok(!src.includes("marker_native_symbol"));
  assert.ok(!src.includes("user_inner_function"));
});

maybe("bundle parses as one classic script (tab re-indentation kept it valid)", BUNDLE, (src) => {
  assert.doesNotThrow(() => new vm.Script(src, { filename: "scalene-gui-bundle.js" }));
});

maybe("TS entry names the timeline and memory axis helpers", TS_ENTRY, (src) => {
  for (const sym of ["pickNiceTickInterval", "formatTimelineTickLabel", "renderTimelineAxis", "renderTimelineGridlines", "formatMemoryTickLabel", "renderMemoryAxis", "renderMemoryGridlines"]) {
    assert.ok(src.includes(sym), `expected ${sym} in TS source`);
  }
});

maybe("timeline tooltips use the source lookup (upstream text slicing)", TS_ENTRY, (src) => {
  assert.ok(src.includes("makeFileSourceLookup"));
  assert.ok(src.includes("renderTimelineFrames"));
  assert.ok(src.includes("renderTimelineContent"));
  const marker = "renderCombinedStacksTimeline";
  const start = src.indexOf(`export function ${marker}`);
  assert.notEqual(start, -1, `${marker} definition not found`);
  let end = src.indexOf("\nexport function ", start + marker.length + 10);
  if (end === -1) end = src.indexOf("\nfunction ", start + marker.length + 10);
  const body = end > start ? src.slice(start, end) : src.slice(start);
  assert.ok(body.includes("makeFileSourceLookup"), `${marker} must construct makeFileSourceLookup`);
  assert.ok(body.includes("renderTimelineContent"), `${marker} must call renderTimelineContent`);
  const cStart = src.indexOf("function renderTimelineContent");
  assert.notEqual(cStart, -1, "renderTimelineContent not found");
  const cEnd = src.indexOf("\nfunction ", cStart + 30);
  const cBody = cEnd > cStart ? src.slice(cStart, cEnd) : src.slice(cStart);
  assert.ok(cBody.includes("sourceLookup"), "renderTimelineContent must pass sourceLookup");
});

maybe("template: test-contract CSS and no 'experimental' badge", TEMPLATE, (tpl) => {
  assert.ok(tpl.includes(".combined-stacks-section"));
  assert.ok(tpl.includes(".flame-segment"));
  assert.ok(!tpl.toLowerCase().includes("experimental"));
  assert.ok(!tpl.includes("bg-warning text-dark"));
  assert.ok(
    tpl.includes(`const profile = {{ ((profile or '') | trim or '""') | replace('<', '\\\\u003c') }};`),
    "empty/whitespace guard and '<' escaping",
  );
});

// Upstream's _build_profile(with_combined_stacks=…), rendered through jinja2.
function demoProfile(withStacks) {
  const p = {
    alloc_samples: 0, args: [], async_profile: false, elapsed_time_sec: 1.0, start_time_absolute: 0.0, start_time_perf: 0.0,
    entrypoint_dir: "/tmp", filename: "demo.py",
    files: { "demo.py": { functions: [], imports: [], leaks: {}, lines: [], percent_cpu_time: 100.0 } },
    gpu: false, gpu_device: "", growth_rate: 0.0, max_footprint_fname: null, max_footprint_lineno: null, max_footprint_mb: 0.0,
    max_footprint_python_fraction: 0.0, memory: false, program: "demo.py", samples: [], stacks: [], native_stacks: [],
  };
  if (withStacks) {
    p.combined_stacks = [[[
      { kind: "py", display_name: "user_outer_function", filename_or_module: "/app/work.py", line: 10, ip: null, offset: null },
      { kind: "py", display_name: "user_inner_function", filename_or_module: "/app/work.py", line: 42, ip: null, offset: null },
      { kind: "native", display_name: "marker_native_symbol", filename_or_module: "/lib/libmarker.dylib", line: null, ip: 140735000000, offset: 32 },
    ], 7]];
  }
  return p;
}

/** Upstream's line record shape (all metrics 0), as in test_timeline_tooltip_source_line_reaches_embedded_profile. */
function zeroLine(lineno, line) {
  const z = {};
  for (const k of ["n_cpu_percent_python", "n_cpu_percent_c", "n_sys_percent", "n_core_utilization", "n_peak_mb", "n_avg_mb",
    "n_python_fraction", "n_copy_mb_s", "n_malloc_mb", "n_mallocs", "n_growth_mb", "n_usage_fraction", "n_gpu_percent",
    "n_gpu_avg_memory_mb", "n_gpu_peak_memory_mb"]) z[k] = 0;
  return { lineno, line, ...z, memory_samples: [] };
}

// Same Environment/loader/render call as scalene_utility.generate_html (Jinja defaults).
const RENDER = `
import json, sys
from jinja2 import Environment, FileSystemLoader
args = json.loads(sys.stdin.read())
env = Environment(loader=FileSystemLoader(args["dir"]))
t = env.get_template("index.html.template")
sys.stdout.write(t.render(profile=args["profile"], gui_js=args["gui_js"], scalene_version="2.4.0",
    scalene_date="2026.10.23", standalone=args["standalone"], favicon_base64=""))
`;

function render(profileText, standalone, guiJs) {
  const r = spawnSync("python3", ["-P", "-c", RENDER], {
    input: JSON.stringify({ dir: path.dirname(TEMPLATE), profile: profileText, standalone, gui_js: guiJs }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `jinja2 render failed: ${r.stderr}`);
  return r.stdout;
}

const jinjaOk = read(TEMPLATE) !== null && spawnSync("python3", ["-P", "-c", "import jinja2"]).status === 0;
const JINJA_SKIP = "python3 + jinja2, template and bundle are needed";

function jinjaTest(name, fn) {
  if (!jinjaOk || read(BUNDLE) === null) skip(name, JINJA_SKIP);
  else test(name, () => fn(read(BUNDLE)));
}

jinjaTest("section present when combined_stacks populated (standalone)", (bundle) => {
  const html = render(JSON.stringify(demoProfile(true)), true, bundle);
  for (const s of [".combined-stacks-section", ".flame-segment", "toggleCombinedStacks", "marker_native_symbol",
    "user_outer_function", "user_inner_function"]) assert.ok(html.includes(s), `missing ${s}`);
});

jinjaTest("no marker text when combined_stacks is missing", (bundle) => {
  const html = render(JSON.stringify(demoProfile(false)), true, bundle);
  assert.ok(!html.includes("marker_native_symbol") && !html.includes("user_inner_function"));
});

jinjaTest("minimal profile without stacks fields renders (Scalene + CSS)", (bundle) => {
  const p = demoProfile(false);
  delete p.stacks;
  delete p.native_stacks;
  const html = render(JSON.stringify(p), true, bundle);
  assert.ok(html.includes("Scalene"));
  assert.ok(html.includes(".combined-stacks-section"));
});

jinjaTest("timeline tooltip source line reaches the embedded profile", (bundle) => {
  const marker = "leaf_user_code_line_abc123";
  const p = demoProfile(true);
  p.files["demo.py"].lines = [...Array.from({ length: 9 }, (_, i) => zeroLine(i + 1, `# filler ${i + 1}`)), zeroLine(10, marker)];
  p.combined_stacks[0][0][0].filename_or_module = "demo.py";
  p.combined_stacks[0][0][0].line = 10;
  p.combined_stacks_timeline = [{ t_sec: 0.0, stack_index: 0, count: 1 }];
  assert.ok(render(JSON.stringify(p), true, bundle).includes(marker));
});

jinjaTest("static HTML has no experimental badge", (bundle) => {
  const p = demoProfile(true);
  p.combined_stacks_timeline = [{ t_sec: 0.0, stack_index: 0, count: 1 }];
  const html = render(JSON.stringify(p), true, bundle);
  assert.ok(!html.toLowerCase().includes("experimental"));
  assert.ok(!html.includes("bg-warning text-dark"));
});

jinjaTest("CSS rules present in both modes; linked mode references the bundle file", (bundle) => {
  for (const standalone of [true, false]) {
    const html = render(JSON.stringify(demoProfile(true)), standalone, bundle);
    assert.ok(html.includes(".combined-stacks-section") && html.includes(".flame-segment"));
    if (!standalone) assert.ok(html.includes('src="scalene-gui-bundle.js"') && !html.includes("toggleCombinedStacks"));
  }
});

jinjaTest("empty and whitespace-only profile text render valid JS (trim + `or '\"\"'` guard)", (bundle) => {
  // "" (not {}) so the app can tell "no profile" from "a profile with no samples" (§4.16).
  for (const text of ["", "\n", "  \r\n\t"]) {
    for (const standalone of [true, false]) assert.match(render(text, standalone, bundle), /const profile = "";/);
  }
  assert.match(render("{}\n", true, bundle), /const profile = \{\};/);
});

/**
 * The inline profile <script> exactly as the HTML tokenizer delimits it: from the element that
 * declares `const profile` to the first `</script` (any case). An unescaped '<' in the profile
 * could end the element early (`</script>`) or switch it into the escaped states (`<!--<script`).
 */
function inlineProfileScript(html) {
  const start = html.indexOf("const profile = ");
  assert.notEqual(start, -1, "const profile not found");
  const end = html.toLowerCase().indexOf("</script", start);
  return html.slice(start, end);
}

const hostile = () => {
  const p = demoProfile(true);
  p.files["demo.py"].lines = [
    zeroLine(1, SCRIPT_BREAK_LINE),
    zeroLine(2, "# <!--<script> and <!-- and --> and <SCRIPT>"),
    zeroLine(3, "s = '</SCRIPT >' + \"\\u003c\""),
  ];
  return p;
};

jinjaTest("source text with </script> or <!--<script cannot end the inline profile script (both modes)", (bundle) => {
  const p = hostile();
  for (const text of [JSON.stringify(p), JSON.stringify(p, null, 4) + "\n"]) {
    for (const standalone of [true, false]) {
      const script = inlineProfileScript(render(text, standalone, bundle));
      assert.ok(!script.includes("<"), "an unescaped '<' reached the inline script");
      assert.ok(script.includes("function clickToLoadFile"), "the profile script was cut short");
      const ctx = {};
      vm.runInNewContext(`${script}\nglobalThis.out = profile;`, ctx);
      assert.deepEqual(JSON.parse(JSON.stringify(ctx.out)), p, "the escaped literal parses to the same data");
      assert.equal(ctx.out.files["demo.py"].lines[0].line, SCRIPT_BREAK_LINE);
    }
  }
});

test("render-fixture synthetic fixtures: ws is whitespace, scriptbreak carries </script>", () => {
  assert.equal(SYNTHETIC.blank(), "");
  assert.equal(SYNTHETIC.ws().trim(), "");
  assert.ok(SYNTHETIC.scriptbreak().includes("</script>"));
  const tpl = read(TEMPLATE);
  if (tpl === null) return;
  const html = renderTemplate(tpl, { profile: SYNTHETIC.scriptbreak(), standalone: false, scalene_version: "x", scalene_date: "y" });
  assert.ok(!inlineProfileScript(html).includes("<"));
});

jinjaTest("tools/render-fixture.mjs matches jinja2 byte for byte", (bundle) => {
  const tpl = read(TEMPLATE);
  for (const profile of ["", "\n", " \u00a0\t\r\n", "{}\n", JSON.stringify(demoProfile(true)), JSON.stringify(hostile()), SYNTHETIC.scriptbreak()]) {
    for (const standalone of [true, false]) {
      const vars = { profile, scalene_version: "2.4.0", scalene_date: "2026.10.23", standalone, gui_js: bundle, favicon_base64: "" };
      assert.equal(renderTemplate(tpl, vars), render(profile, standalone, bundle), `standalone=${standalone} profile=${profile.slice(0, 20)}`);
    }
  }
});

// Upstream's real generate_html functions, run against our template and bundle. Their
// heavy imports (cloudpickle, …) are stubbed; jinja2 is the real package. Each module's
// `__file__` points at a staging copy of scalene/ whose scalene-gui/ holds our template,
// our bundle and the upstream assets standalone mode embeds.
const UPSTREAM = `
import json, os, shutil, sys, types
src, stage, jobs = sys.argv[1], sys.argv[2], json.loads(sys.stdin.read())
sys.path.insert(0, src)
import jinja2  # must be the real package
class Stub(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"): raise AttributeError(name)
        return Stub(self.__name__ + "." + name)
    def __call__(self, *a, **k): return Stub("call")
    def __mro_entries__(self, bases): return (object,)
for _ in range(40):
    try:
        import scalene.scalene_utility as su, scalene.launchbrowser as lb, scalene.scalene_config as cfg
        break
    except ModuleNotFoundError as e:
        parts = e.name.split(".")
        if parts[0] in ("scalene", "jinja2"): raise
        for i in range(1, len(parts) + 1):
            sys.modules.setdefault(".".join(parts[:i]), Stub(".".join(parts[:i])))
        for k in [k for k in sys.modules if k.startswith("scalene")]: del sys.modules[k]
gui = os.path.join(stage, "scalene", "scalene-gui")
os.makedirs(gui, exist_ok=True)
up = os.path.join(src, "scalene", "scalene-gui")
for a in ("jquery-3.6.0.slim.min.js", "bootstrap.min.css", "bootstrap.bundle.min.js", "prism.css", "favicon.ico", "scalene-image.png"):
    shutil.copy(os.path.join(up, a), gui)
shutil.copy(jobs["template"], os.path.join(gui, "index.html.template"))
shutil.copy(jobs["bundle"], os.path.join(gui, "scalene-gui-bundle.js"))
su.__file__ = lb.__file__ = os.path.join(stage, "scalene", "scalene_utility.py")
out = {"version": cfg.scalene_version, "date": cfg.scalene_date, "favicon": os.path.join(gui, "favicon.ico"), "pages": []}
for i, job in enumerate(jobs["profiles"]):
    for kind in ("standalone", "utility-linked", "launchbrowser"):
        dest = os.path.join(stage, "%d-%s.html" % (i, kind))
        if kind == "launchbrowser":
            if not os.path.exists(job): continue  # upstream asserts the "demo" name for missing files
            lb.generate_html(job, dest)
        else:
            su.generate_html(job, dest, standalone=(kind == "standalone"))
        out["pages"].append({"profile": job, "kind": kind, "html": dest})
print(json.dumps(out))
`;

const upstreamSrc = process.env.SCALENE_SRC ? path.resolve(process.env.SCALENE_SRC) : null;
const upstreamOk = upstreamSrc && fs.existsSync(path.join(upstreamSrc, "scalene", "scalene_utility.py"));
if (!jinjaOk || read(BUNDLE) === null || !upstreamOk) {
  skip("upstream generate_html() renders exactly what tools/render-fixture.mjs renders", upstreamOk ? JINJA_SKIP : "set SCALENE_SRC to a Scalene checkout");
} else {
  test("upstream generate_html() renders exactly what tools/render-fixture.mjs renders", () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "scalene-upstream-"));
    try {
      const profiles = ["basic", "example", "empty", "cpu-only"].map((n) => path.join(root, "fixtures", `${n}.json`)).filter((f) => fs.existsSync(f));
      profiles.push(path.join(stage, "missing-profile.json")); // generate_html renders profile = "" for a missing file
      const r = spawnSync("python3", ["-P", "-c", UPSTREAM, upstreamSrc, stage], {
        input: JSON.stringify({ template: TEMPLATE, bundle: BUNDLE, profiles }),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(r.status, 0, `upstream render failed:\n${r.stderr}`);
      const res = JSON.parse(r.stdout);
      const tpl = read(TEMPLATE);
      const bundle = read(BUNDLE);
      const favicon = fs.readFileSync(res.favicon).toString("base64");
      assert.ok(res.pages.length >= 3 * profiles.length - 1);
      for (const page of res.pages) {
        const standalone = page.kind === "standalone";
        const vars = {
          profile: fs.existsSync(page.profile) ? fs.readFileSync(page.profile, "utf8") : "",
          scalene_version: res.version,
          scalene_date: res.date,
          standalone,
          gui_js: standalone ? bundle : "",
          favicon_base64: standalone ? favicon : "",
        };
        const ours = renderTemplate(tpl, vars);
        const theirs = fs.readFileSync(page.html, "utf8");
        assert.ok(ours === theirs, `${path.basename(page.profile)} [${page.kind}] differs from upstream generate_html()`);
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
}
