/* ---------- app shell: topbar, load(), navigation, theme, motion orchestration ---------- */
const APP = { M: null, entered: false };
window.APP = APP;

const LOGO = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.2 12 5" stroke="var(--cpu-py)" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M12 5l8 14.2" stroke="var(--mem-py)" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M20 19.2H4" stroke="var(--gpu)" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>`;

function topbarHTML(M) {
  const prog = M && !M.empty ? basename(M.program) || "profile" : "No profile loaded";
  const args = M && !M.empty ? M.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ") : "";
  const secs = M && !M.empty ? [["overview", "Overview"], ["code", "Code"], M.flameCpu.total || M.flameMem.total ? ["stacks", "Stacks"] : null, M.tl ? ["timeline", "Timeline"] : null, M.hasMem ? ["memory", "Memory"] : null].filter(Boolean) : [];
  const dark = D.documentElement.getAttribute("data-theme") !== "light";
  return `<a class="brand" href="https://github.com/plasma-umass/scalene" target="_blank" rel="noopener" aria-label="Scalene on GitHub">${LOGO}<b>Scalene</b></a>
    <span class="tb-sep"></span>
    <div class="prog" title="${esc(M && M.program ? M.program + " " + args : "")}"><span class="name">${esc(prog)}</span><span class="args">${esc(args)}</span></div>
    <nav class="nav" aria-label="Sections">${secs.map(([id, l]) => `<a href="#${id}" data-sec="${id}">${l}</a>`).join("")}<span class="nav-ind"></span></nav>
    <div class="tb-actions">
      ${M && !M.empty ? `<button class="btn search-btn" id="find-btn" aria-label="Search files, functions and lines">${icon("search")}<span class="lbl">Search</span><span class="kbd">⌘K</span></button>
      <button class="btn" id="ai-btn" aria-label="AI optimization settings">${icon("spark")}<span>AI</span></button>` : ""}
      <button class="btn ghost icon" id="load-btn" title="Load another profile (.json)" aria-label="Load another profile">${icon("upload")}</button>
      <button class="btn ghost icon" id="theme-btn" aria-label="Switch to ${dark ? "light" : "dark"} theme" title="Switch to ${dark ? "light" : "dark"} theme">${icon(dark ? "sun" : "moon")}</button>
    </div>`;
}

function footerHTML() {
  const v = esc(window.SCALENE_VERSION || "2.4.0"), d = esc(window.SCALENE_DATE || "2026.10.28");
  return `<span><a href="https://github.com/plasma-umass/scalene" target="_blank" rel="noopener">Scalene</a> version ${v}, ${d}</span><span class="sp"></span>
    <a href="https://github.com/plasma-umass/scalene/issues/new/choose" target="_blank" rel="noopener">Report an issue or request a feature</a>
    <a href="https://github.com/plasma-umass/scalene/issues/58" target="_blank" rel="noopener">Share your success story</a>
    <a href="#" id="foot-load">Load another profile</a>`;
}

function emptyHTML() {
  return `<section class="card empty-state" aria-labelledby="empty-h"><div class="in">
    <div style="width:56px;height:56px;border-radius:14px;display:grid;place-items:center;background:var(--sunken);border:1px solid var(--line)">${LOGO.replace("<svg", '<svg style="width:30px;height:30px"')}</div>
    <h1 id="empty-h">Open a Scalene profile</h1>
    <p>Drop a profile (<code>.json</code>) anywhere on this page.</p>
    <label class="btn primary" for="fileinput" style="height:36px;padding:0 16px">${icon("upload")}Choose a profile…</label>
    <ol class="steps" aria-label="How to create a profile">
      <li><b>1</b><span>Profile your program<br><code>scalene --json --outfile profile.json your_program.py</code></span></li>
      <li><b>2</b><span>Open it here, or run <code>scalene view</code> to open the most recent profile in your browser.</span></li>
    </ol></div></section>`;
}

function render(M) {
  APP.M = M; APP.entered = false;
  if (M && !M.empty) { M.flameCpu = buildFlame(M, M.p.combined_stacks || [], false); M.flameMem = buildFlame(M, M.p.memory_stacks || [], true); }
  $(".topbar").innerHTML = topbarHTML(M);
  $("footer.foot").innerHTML = footerHTML();
  D.title = M && M.program ? "Scalene - " + M.program : "Scalene";
  if (!M || M.empty) { $("#app").innerHTML = emptyHTML(); bindTopbar(); return; }
  $("#app").innerHTML = heroHTML(M) + hotspotsHTML(M) + codeHTML(M) + stacksHTML(M) + timelineHTML(M) + memoryHTML(M);
  if (!$("#ai-drawer")) D.body.insertAdjacentHTML("beforeend", aiDrawerHTML(M));
  APP.scope = mountScope(M);
  mountHotspots(M); renderFindings(M);
  mountCode(M);
  APP.flame = mountFlame(M);
  APP.timeline = mountTimeline(M);
  APP.memory = mountMemory(M);
  APP.ai = mountAI(M);
  bindTopbar(); scrollSpy(); revealOnView();
  enter();
}

function bindTopbar() {
  const tb = $(".topbar");
  tb.onclick = (e) => {
    const b = e.target.closest("button, a[data-sec]"); if (!b) return;
    if (b.id === "theme-btn") toggleTheme();
    else if (b.id === "load-btn") $("#fileinput").click();
    else if (b.id === "ai-btn") APP.ai && APP.ai.open();
    else if (b.id === "find-btn") palette.open();
    else if (b.dataset.sec) { e.preventDefault(); $("#" + b.dataset.sec).scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); history.replaceState(null, "", "#" + b.dataset.sec); }
  };
  const fl = $("#foot-load"); if (fl) fl.onclick = (e) => { e.preventDefault(); $("#fileinput").click(); };
}

function toggleTheme() {
  const r = D.documentElement; const next = r.getAttribute("data-theme") === "light" ? "dark" : "light";
  r.classList.add("theme-anim"); r.setAttribute("data-theme", next); store.set("scalene-theme", next);
  setTimeout(() => r.classList.remove("theme-anim"), 260);
  hatchCache = new Map();
  const b = $("#theme-btn"); if (b) { b.innerHTML = icon(next === "dark" ? "sun" : "moon"); b.setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} theme`); b.title = b.getAttribute("aria-label"); }
  redrawAll();
}
function redrawAll() {
  APP.scope && APP.scope.redraw(); APP.flame && APP.flame.redraw(); APP.timeline && APP.timeline.redraw(); APP.memory && APP.memory.redraw();
  if (APP.M && CV.sel) drawInspectorCharts(APP.M, CV.sel);
}

/* entry choreography: reveal order = importance (headline → readouts → signal → hotspots) */
function enter() {
  const root = D.documentElement;
  if (STILL || REDUCED) {
    root.classList.add("no-motion");
    $$(".rv, .grow").forEach((x) => x.classList.add("in"));
    APP.entered = true; APP.scope && APP.scope.play(); return;
  }
  requestAnimationFrame(() => {
    $$(".rv").forEach((x) => x.classList.add("in"));
    $$("#overview .grow, #hs-list .grow").forEach((x) => x.classList.add("in"));
    $$("#overview [data-count]").forEach((el, i) => countUp(el, el.dataset.count, 700, 60 + i * 40));
    APP.scope && APP.scope.play();
    APP.entered = true;
  });
}
function revealOnView() {
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      const id = e.target.id; io.unobserve(e.target);
      if (id === "stacks") APP.flame && APP.flame.reveal(); if (id === "timeline") APP.timeline && APP.timeline.reveal(); if (id === "memory") APP.memory && APP.memory.reveal();
    }
  }, { threshold: 0.12 });
  ["stacks", "timeline", "memory"].forEach((id) => { const el = $("#" + id); if (el) io.observe(el); });
}
function scrollSpy() {
  const links = $$(".nav a"); const ind = $(".nav-ind"); if (!links.length) return;
  const set = (id) => { links.forEach((a) => a.setAttribute("aria-current", String(a.dataset.sec === id))); const a = links.find((x) => x.dataset.sec === id); if (a && ind) { ind.style.width = a.offsetWidth - 20 + "px"; ind.style.transform = `translateX(${a.offsetLeft + 10}px)`; } };
  const io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) set(e.target.id); }, { rootMargin: "-30% 0px -60% 0px" });
  links.forEach((a) => { const s = $("#" + a.dataset.sec); if (s) io.observe(s); });
  set("overview");
}

/* jump to a line: switch file, reveal folded line, scroll, flash, select */
APP.jumpTo = (F, no) => {
  const M = APP.M; if (!M || !F) return;
  if (CV.view !== "lines") { CV.view = "lines"; const seg = $('#code .seg[data-seg="view"]'); seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === "lines"))); seg._place(); }
  if (CV.F !== F) selectFile(M, F, { keepSel: true });
  if (no == null) { $("#code").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" }); return; }
  const L = F.byNo.get(no); if (!L) return;
  if (CV.sortK) CV.sortK = null;
  if (!visibleIn(L)) CV.open.add(no);
  renderLines(M); setSel(M, L);
  const row = $(`#lines .lrow[data-no="${no}"]`);
  if (row) {
    row.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" });
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
    setTimeout(() => row.focus({ preventScroll: true }), REDUCED ? 0 : 450);
  }
};
let vsApi = null;
APP.vsNavigate = (file, line, editor) => {
  try { if (!vsApi && typeof acquireVsCodeApi === "function") vsApi = acquireVsCodeApi(); } catch (e) { /* not in VS Code */ }
  if (vsApi) { vsApi.postMessage({ command: "jumpToLine", filePath: escape(file), lineNumber: line }); return; }
  const F = APP.M && APP.M.fileByName.get(file);
  if (editor || !F) { location.href = `vscode://file/${file}:${line}:1`; return; }
  APP.jumpTo(F, line);
};
window.vsNavigate = (f, l) => APP.vsNavigate(decodeURIComponentSafe(f), l);
function decodeURIComponentSafe(s) { try { return /%/.test(s) ? decodeURIComponent(s) : s; } catch (e) { return unescape(s); } }

/* tooltip (glass), positioned near the pointer and flipped at edges */
APP.tip = (html, e) => {
  const t = $("#tip"); if (!html) { t.classList.remove("on"); return; }
  t.innerHTML = html; t.classList.add("on");
  const r = t.getBoundingClientRect(); let x = e.clientX + 14, y = e.clientY + 16;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14; if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  t.style.left = Math.max(8, x) + "px"; t.style.top = Math.max(8, y) + "px";
};

/* command palette: files, functions, lines */
const palette = {
  open() {
    if (!APP.M) return; let p = $("#palette");
    if (!p) {
      D.body.insertAdjacentHTML("beforeend", `<div class="scrim on" id="pal-scrim"></div><div id="palette" role="dialog" aria-modal="true" aria-label="Search" style="position:fixed;z-index:95;top:12vh;left:50%;transform:translateX(-50%);width:min(640px,calc(100vw - 24px));background:var(--raised);border:1px solid var(--line-strong);border-radius:12px;box-shadow:var(--shadow-float);overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)">${icon("search")}<input id="pal-q" placeholder="Jump to a file, function or line of code…" style="flex:1;border:0;outline:0;background:transparent;font-size:15px" autocomplete="off"><span class="kbd">esc</span></div>
        <div id="pal-r" role="listbox" style="max-height:52vh;overflow:auto;padding:6px"></div></div>`);
      p = $("#palette"); const q = $("#pal-q");
      const run = () => palette.search(q.value); q.addEventListener("input", run);
      q.addEventListener("keydown", (e) => {
        const items = $$("#pal-r [data-i]"); let i = items.findIndex((x) => x.getAttribute("aria-selected") === "true");
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { i = clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, items.length - 1); items.forEach((x, j) => x.setAttribute("aria-selected", String(j === i))); items[i] && items[i].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        if (e.key === "Enter" && items[i]) { palette.go(+items[i].dataset.i); }
        if (e.key === "Escape") palette.close();
      });
      $("#pal-r").addEventListener("click", (e) => { const it = e.target.closest("[data-i]"); if (it) palette.go(+it.dataset.i); });
      $("#pal-scrim").addEventListener("click", () => palette.close());
      run();
    }
    $("#pal-q").focus();
  },
  close() { const p = $("#palette"); if (p) { p.remove(); $("#pal-scrim").remove(); } },
  search(q) {
    const M = APP.M; q = q.trim().toLowerCase(); const res = [];
    for (const F of M.files) if (!q || F.name.toLowerCase().includes(q)) res.push({ k: "File", t: F.base, s: fPct(F.pct), go: () => APP.jumpTo(F, null) });
    for (const fn of M.fnByTime.concat(M.fns.filter((f) => !f.total))) if (q && fn.name.toLowerCase().includes(q)) res.push({ k: "Function", t: fn.name + "()", s: `${fn.F.base}:${fn.no} · ${fPct(fn.total)}`, go: () => APP.jumpTo(fn.F, fn.no) });
    const ls = q ? M.lines.filter((L) => L.text.toLowerCase().includes(q)).sort((a, b) => b.total - a.total) : M.byTime.slice(0, 6);
    for (const L of ls.slice(0, 30)) res.push({ k: "Line", t: L.text.trim(), s: `${L.F.base}:${L.no}${L.total ? " · " + fPct(L.total) : ""}`, go: () => APP.jumpTo(L.F, L.no), code: true });
    palette.res = res.slice(0, 60);
    $("#pal-r").innerHTML = palette.res.map((r, i) => `<div data-i="${i}" role="option" aria-selected="${i === 0}" style="display:grid;grid-template-columns:70px 1fr auto;gap:10px;align-items:center;padding:8px 10px;border-radius:7px;cursor:pointer"><span class="micro">${r.k}</span><span style="${r.code ? "font-family:var(--font-mono);font-size:12.5px;" : ""}white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.code ? hiPy(r.t) : esc(r.t)}</span><span style="color:var(--fg-3);font-size:12px;white-space:nowrap" class="num">${esc(r.s)}</span></div>`).join("") || `<div class="hint" style="padding:12px">No matches.</div>`;
  },
  go(i) { const r = palette.res[i]; palette.close(); r && r.go(); },
};

/* loading other profiles: picker + drag & drop, with honest errors */
function loadText(text, name) {
  try { const obj = JSON.parse(text); window.load(obj); }
  catch (e) { toast(`Could not read ${esc(name || "that file")}: it is not valid JSON (${esc(e.message)}).`); }
}
function toast(html) {
  let t = $("#toast"); if (!t) { D.body.insertAdjacentHTML("beforeend", `<div id="toast" role="alert" style="position:fixed;z-index:130;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 24px));padding:12px 16px;border-radius:10px;background:var(--raised);border:1px solid var(--line-strong);box-shadow:var(--shadow-float);font-size:13px"></div>`); t = $("#toast"); }
  t.innerHTML = html; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 6000);
}
function bindGlobal() {
  const fi = $("#fileinput");
  fi.addEventListener("change", () => { const f = fi.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => loadText(r.result, f.name); r.readAsText(f); fi.value = ""; });
  let depth = 0; const ov = $("#drop");
  addEventListener("dragenter", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) { depth++; ov.classList.add("on"); e.preventDefault(); } });
  addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) ov.classList.remove("on"); });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => { e.preventDefault(); depth = 0; ov.classList.remove("on"); const f = e.dataTransfer.files[0]; if (f) { const r = new FileReader(); r.onload = () => loadText(r.result, f.name); r.readAsText(f); } });
  addEventListener("keydown", (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test((D.activeElement || {}).tagName || "");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette.open(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); palette.open(); }
    else if (e.key === "Escape") palette.close();
  });
  let rt = 0; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (!APP.M || APP.M.empty) return; APP.scope && APP.scope.redraw(); renderLines(APP.M); renderInspector(APP.M); APP.flame && APP.flame.redraw(); APP.timeline && APP.timeline.redraw(); APP.memory && APP.memory.redraw(); $$(".seg").forEach((s) => s._place && s._place(true)); }, 120); });
  if (/^http/.test(location.protocol)) setInterval(() => { try { const x = new XMLHttpRequest(); x.open("GET", "/heartbeat"); x.send(); } catch (e) { /* offline */ } }, 10000);
}

window.load = (profile) => {
  let p = profile;
  if (typeof p === "string") { try { p = p.trim() ? JSON.parse(p) : {}; } catch (e) { p = {}; } }
  render(buildModel(p || {}));
};
window.toggleReduced = () => {};
window.loadFile = () => $("#fileinput").click();
window.expandAll = () => { CV.mode = "all"; APP.M && renderLines(APP.M); };
window.collapseAll = () => { CV.mode = "lines"; APP.M && renderLines(APP.M); };

D.addEventListener("DOMContentLoaded", () => {
  bindGlobal();
  const el = $("#profile-data"); let p = {};
  try { p = el && el.textContent.trim() ? JSON.parse(el.textContent) : {}; } catch (e) { p = {}; }
  window.load(p);
});
