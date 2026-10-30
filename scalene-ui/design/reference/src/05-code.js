/* ---------- code view: every line is a channel strip with meters ---------- */
const CV = { F: null, mode: "functions", sortK: null, view: "lines", sel: null, open: new Set(), cols: null, insp: true };

function codeHTML(M) {
  return `<section class="card code-card" id="code" aria-labelledby="code-h">
    <div class="card-h">
      <h2 id="code-h">${icon("code")}Code</h2><span class="desc" id="code-desc">per-line meters · time bars scaled to the hottest line (${fPct(M.maxLineTotal)})</span><span class="spacer"></span>
      <div class="seg" role="group" aria-label="Show" data-seg="view"><span class="thumb"></span><button aria-pressed="true" data-v="lines">Lines</button><button aria-pressed="false" data-v="functions">Functions</button></div>
      <div class="seg" role="group" aria-label="Which lines" data-seg="mode"><span class="thumb"></span>
        <button aria-pressed="true" data-v="functions" title="Lines with samples plus the rest of every profiled function">Profiled functions</button><button aria-pressed="false" data-v="lines" title="Only lines with samples">Hot lines</button><button aria-pressed="false" data-v="all" title="Every line of the file">All</button></div>
    </div>
    <div class="code-layout">
      <div class="filetabs" role="tablist" aria-label="Files" id="filetabs"></div>
      <div class="code-main" style="min-width:0">
        <div class="fileinfo" id="fileinfo"></div>
        <div class="code-body" id="code-body"><div class="lines" id="lines" role="grid" aria-label="Line profile"></div><aside class="insp" id="insp" hidden aria-label="Line details"></aside></div>
      </div>
    </div>
  </section>`;
}

function colsFor(M, w) {
  const C = [{ k: "ln", w: "40px", h: "Line", sort: (L) => -L.no }];
  const narrow = w < 640;
  C.push({ k: "time", w: narrow ? "82px" : "minmax(116px,156px)", h: "Time", u: "% of run", sort: (L) => L.total });
  if (M.hasMem && !narrow) {
    C.push({ k: "mem", w: "minmax(108px,140px)", h: "Memory", u: "peak", sort: (L) => L.peak });
    if (w >= 1060) C.push({ k: "trend", w: "58px", h: "Trend", u: "", sort: (L) => (L.leak ? 1e9 + L.leak.v : L.ms.length) });
    if (w >= 1500) C.push({ k: "avg", w: "70px", h: "Avg", u: "", sort: (L) => L.avg }, { k: "alloc", w: "62px", h: "Alloc", u: "", sort: (L) => L.usage });
    if (w >= 1180 && M.lines.some((l) => l.copy >= 1)) C.push({ k: "copy", w: "76px", h: "Copy", u: "/s", sort: (L) => L.copy });
  }
  if (M.showGpu && !narrow) { C.push({ k: "gpu", w: "minmax(92px,112px)", h: M.gpuName, u: "util", sort: (L) => L.gpu }); if (w >= 1500) C.push({ k: "gpumem", w: "74px", h: M.gpuName + " mem", u: "", sort: (L) => L.gpuPeak }); }
  if (M.isAsync && !narrow) C.push({ k: "await", w: "minmax(96px,124px)", h: "Await", u: "% of await", sort: (L) => L.aw });
  if (M.hasNeuron && !narrow) C.push({ k: "unused", w: "70px", h: "Unused", u: "device", sort: (L) => (L.overlap != null ? 100 - L.overlap : -1) }, { k: "nrt", w: "110px", h: "NRT", u: "% elapsed", sort: (L) => L.nrt }, { k: "nc", w: "110px", h: "NC", u: "time", sort: (L) => L.nc });
  C.push({ k: "src", w: "minmax(0,1fr)", h: "Source" });
  return C;
}

function meterHTML(segs, frac, maxW = 100) {
  const sum = segs.reduce((a, s) => a + s[0], 0);
  if (!(sum > 0) || !(frac > 0)) return `<div class="meter"><div class="grad"></div></div>`;
  const inner = segs.map(([v, c]) => (v > 0 ? `<i style="flex:${v / sum};${c === "hatch" ? "--c:var(--cpu-sys)" : "background:" + c}" class="${c === "hatch" ? "hatch-bg" : ""}"></i>` : "")).join("");
  return `<div class="meter"><div class="grad"></div><div class="fill" style="width:${clamp(frac, 0.012, 1) * maxW}%">${inner}</div></div>`;
}
function sparkSVG(M, L) {
  if (!L.ms.length || !(M.maxFp > 0)) return "";
  const T = M.tMax || 1, w = 56, h = 16;
  const pts = L.ms.map((s) => [clamp((s[0] / 1e9 / T) * w, 0, w), h - 1 - clamp(s[1] / M.maxFp, 0, 1) * (h - 2)]);
  let mi = 0; L.ms.forEach((s, i) => { if (s[1] > L.ms[mi][1]) mi = i; });
  const c = L.leak ? "var(--danger)" : "var(--mem-py)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-label="${L.leak ? "possible leak, " : ""}footprint when this line allocated"><path d="M0 ${h - 0.5}H${w}" stroke="var(--line-strong)" stroke-width="1"/>${pts.length > 1 ? `<path d="M${pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L")}" fill="none" stroke="${c}" stroke-width="1.25" stroke-linejoin="round"/>` : ""}<circle cx="${pts[mi][0].toFixed(1)}" cy="${pts[mi][1].toFixed(1)}" r="1.8" fill="${c}"/></svg>`;
}

function cellHTML(M, k, L) {
  const hot = (v, th) => (v >= th ? " hot" : "");
  switch (k) {
    case "ln": return `<span class="ln" role="button" tabindex="-1" title="Open ${esc(L.F.base)}:${L.no} in your editor">${L.no}</span>`;
    case "time": return L.total > 0 ? `<div class="cell">${meterHTML([[L.py, "var(--cpu-py)"], [L.c, "var(--cpu-native)"], [L.sys, "hatch"]], L.total / M.maxLineTotal)}<span class="val${hot(L.total, 5)}">${fPct(L.total)}</span></div>` : `<div class="cell empty">${meterHTML([], 0)}<span class="val"></span></div>`;
    case "mem": return L.peak > 0 ? `<div class="cell">${meterHTML([[L.peak * L.pyFrac, "var(--mem-py)"], [L.peak * (1 - L.pyFrac), "var(--mem-native)"]], L.peak / (M.maxFp || L.peak))}<span class="val${hot(L.peak / (M.maxFp || 1), 0.1)}">${fMem(L.peak)}</span></div>` : `<div class="cell empty">${meterHTML([], 0)}<span class="val"></span></div>`;
    case "trend": return `<span>${sparkSVG(M, L)}</span>`;
    case "avg": return `<span class="txt">${L.avg > 0 ? fMem(L.avg) : ""}</span>`;
    case "alloc": return `<span class="txt">${L.usage >= 0.01 ? fPct(L.usage * 100) : ""}</span>`;
    case "copy": return `<span class="txt">${L.copy >= 1 ? fRate(L.copy) : ""}</span>`;
    case "gpu": return L.gpu >= 1 ? `<div class="cell">${meterHTML([[L.gpu, "var(--gpu)"]], L.gpu / 100)}<span class="val${hot(L.gpu, 50)}">${fPct(L.gpu)}</span></div>` : `<div class="cell empty">${meterHTML([], 0)}<span class="val"></span></div>`;
    case "gpumem": return `<span class="txt">${L.gpuPeak >= 1 && L.gpu >= 1 ? fMem(L.gpuPeak) : ""}</span>`;
    case "await": { const mx = Math.max(...M.lines.map((l) => l.aw)) || 1; return L.aw >= 1 ? `<div class="cell">${meterHTML([[L.aw, "var(--async)"]], L.aw / mx)}<span class="val${hot(L.aw, 10)}">${fPct(L.aw)}</span></div>` : `<div class="cell empty">${meterHTML([], 0)}<span class="val"></span></div>`; }
    case "unused": { if (L.overlap == null || !(L.total >= 1 || L.nrt > 0)) return `<span></span>`; const u = 100 - L.overlap; const c = u < 30 ? "var(--mem-py)" : u < 60 ? "var(--copy)" : "var(--danger)"; return `<span class="txt"><i class="sw" style="background:${c};border-radius:50%;width:6px;height:6px;margin-right:6px"></i>${fPct(u)}</span>`; }
    case "nrt": { const v = (L.nrt / 1000 / (M.elapsed || 1)) * 100; return L.nrt > 0 ? `<div class="cell">${meterHTML([[v, "var(--gpu-mem)"]], v / 100)}<span class="val">${fPct(v)}</span></div>` : `<span></span>`; }
    case "nc": return L.nc > 0 ? `<div class="cell">${meterHTML([[L.nc, "var(--gpu)"]], L.nc / 1000 / (M.elapsed || 1))}<span class="val">${fTime(L.nc / 1000)}</span></div>` : `<span></span>`;
    case "src": {
      const wash = L.total >= 1 ? `<span class="wash" style="opacity:${(0.3 + 0.7 * clamp(L.total / M.maxLineTotal, 0, 1)).toFixed(2)}"></span>` : "";
      return `<div class="src">${wash}<span>${L.doc ? esc(L.text) : hiPy(L.text)}</span></div>`;
    }
  }
  return "<span></span>";
}

function rowHTML(M, L, cols) {
  const cls = ["lrow"]; if (!L.data) cls.push("cold"); if (L.doc) cls.push("doc"); if (L.fnHead && CV.sortK == null && !(L.fnHead.total >= 0.5 || L.fnHead.peak >= 1)) cls.push("fnhead"); if (CV.sel === L) cls.push("sel");
  const chip = "";
  const leak = L.leak && !cols.some((c) => c.k === "trend") ? `<span class="badge danger leakb">${icon("leak")}${fRate(L.leak.v)}</span>` : "";
  const acts = (L.aiLine ? `<button data-a="opt" title="Propose an optimization for this line">${icon("spark")}Optimize</button>` : "") + (L.aiRegion ? `<button data-a="optr" title="Propose an optimization for lines ${L.aiRegion[0]}–${L.aiRegion[1]}">${icon("spark")}Region ${L.aiRegion[0]}–${L.aiRegion[1]}</button>` : "") + `<button data-a="ins" title="Inspect line">${icon("eye")}</button>`;
  return `<div class="${cls.join(" ")}" role="row" data-no="${L.no}" tabindex="${CV.sel === L ? 0 : -1}" aria-selected="${CV.sel === L}">${cols.map((c) => cellHTML(M, c.k, L)).join("")}${chip}${leak}<div class="act">${acts}</div></div>`;
}

function fnRowHTML(M, fn) {
  const mx = M.fnByTime.length ? M.fnByTime[0].total : 1;
  return `<div class="fnrow" role="row" aria-label="Function ${esc(fn.name)}">${icon("fn")}<span class="nm">${esc(fn.name)}()</span>
    ${fn.total > 0 ? `<span class="fm">${meterHTML([[fn.py, "var(--cpu-py)"], [fn.c, "var(--cpu-native)"], [fn.sys, "hatch"]], fn.total / mx)}</span><span><b>${fPct(fn.total)}</b> of run · ${fTime((fn.total / 100) * M.elapsed)}</span>` : ""}
    ${fn.peak >= 1 ? `<span>peak <b>${fMem(fn.peak)}</b></span>` : ""}${M.showGpu && fn.gpu >= 1 ? `<span>${esc(M.gpuName)} <b>${fPct(fn.gpu)}</b></span>` : ""}${M.isAsync && fn.aw >= 1 ? `<span>await <b>${fPct(fn.aw)}</b></span>` : ""}${fn.coro ? `<span class="badge">async def</span>` : ""}</div>`;
}

function visibleIn(L) { if (CV.mode === "all" || CV.open.has(L.no)) return true; if (L.data) return true; return CV.mode === "functions" && L.inFn; }

function renderFileTabs(M) {
  const ft = $("#filetabs"); if (!ft) return;
  const maxPct = Math.max(...M.files.map((f) => f.pct), 1);
  ft.innerHTML = M.files.map((F) => `<button class="ftab" role="tab" aria-selected="${F === CV.F}" data-f="${F.idx}" title="${esc(F.name)}">
    <span class="fn">${esc(F.base)}</span><span class="fp">${fPct(F.pct)}</span>
    <span class="fbar"><i style="width:${(F.py / maxPct) * 100}%;background:var(--cpu-py)"></i><i style="width:${(F.c / maxPct) * 100}%;background:var(--cpu-native)"></i><i class="hatch-bg" style="width:${(F.sys / maxPct) * 100}%;--c:var(--cpu-sys)"></i></span>
    <span class="fd">${M.hasMem && F.maxPeak > 0 ? `<span>peak ${fMem(F.maxPeak)}</span>` : ""}${Object.keys(F.leaks).length ? `<span style="color:var(--danger)">leak</span>` : ""}${!M.hasMem || !F.maxPeak ? `<span>${fTime((F.pct / 100) * M.elapsed)}</span>` : ""}</span></button>`).join("") +
    (M.hidden.length ? `<span class="hint" style="align-self:center;padding:0 8px;white-space:nowrap">+${M.hidden.length} file${M.hidden.length > 1 ? "s" : ""} below 1%</span>` : "");
}

function renderFileInfo(M) {
  const F = CV.F; const el = $("#fileinfo"); if (!F || !el) return;
  const shown = F.lines.filter(visibleIn).length;
  el.innerHTML = `<span class="path" title="${esc(F.name)}">${esc(F.name)}</span><span class="spacer" style="flex:1"></span>
    <span class="stat"><b>${fPct(F.pct)}</b> of run time · ${fTime((F.pct / 100) * M.elapsed)}</span>
    ${M.hasMem ? `<span class="stat">peak <b>${fMem(F.maxPeak)}</b></span>` : ""}
    ${M.hasNeuron && F.nrt > 0 ? `<span class="stat">NRT <b>${fPct((F.nrt / 1000 / M.elapsed) * 100)}</b> of elapsed</span>` : ""}${M.hasNeuron && F.nc > 0 ? `<span class="stat">NC <b>${fPct((F.nc / 1000 / M.elapsed) * 100)}</b></span>` : ""}
    <span class="stat">${fInt(shown)} of ${fInt(F.lines.length)} lines shown</span>`;
}

function renderLines(M, opts = {}) {
  const host = $("#lines"); if (!host || !CV.F) return;
  if (CV.view === "functions") return renderFnTable(M);
  const w = host.clientWidth || 1000; const cols = colsFor(M, w); CV.cols = cols;
  const fixedW = cols.reduce((a, c) => { const m = /(\d+)px\)?$/.exec(c.w); return a + (c.k === "src" ? 0 : m ? +m[1] : 60) + 12; }, 40);
  CV.srcChars = Math.max(10, Math.floor((w - fixedW) / 7.9));
  const tpl = cols.map((c) => c.w).join(" ");
  const F = CV.F;
  const old = new Map(); if (opts.flip && !REDUCED) for (const r of host.querySelectorAll(".lrow")) old.set(r.dataset.no, r.getBoundingClientRect().top);
  let rows = "";
  if (CV.sortK) {
    const c = cols.find((x) => x.k === CV.sortK) || colsFor(M, 2000).find((x) => x.k === CV.sortK);
    const arr = F.lines.filter((L) => c.sort(L) > 0).sort((a, b) => c.sort(b) - c.sort(a));
    rows = arr.map((L) => rowHTML(M, L, cols)).join("") || `<div class="hint" style="padding:16px">No lines with this metric.</div>`;
  } else {
    let run = [];
    const flush = () => { if (!run.length) return; rows += `<button class="fold" data-from="${run[0].no}" data-to="${run[run.length - 1].no}"><span class="ln">⋯</span>${run.length} line${run.length > 1 ? "s" : ""} without samples <span style="opacity:.7">(${run[0].no}${run.length > 1 ? "–" + run[run.length - 1].no : ""})</span></button>`; run = []; };
    for (const L of F.lines) {
      if (visibleIn(L)) { flush(); const fn = L.fnHead; if (fn && (fn.total >= 0.5 || fn.peak >= 1)) rows += fnRowHTML(M, fn); rows += rowHTML(M, L, cols); }
      else run.push(L);
    }
    flush();
  }
  const head = cols.map((c) => {
    if (c.k === "src") return `<span>Source <span class="u">· ${esc(F.base)}</span></span>`;
    if (c.k === "ln") return `<button data-sort="" aria-sort="${CV.sortK ? "none" : "ascending"}" title="Source order" class="r">#</button>`;
    const s = CV.sortK === c.k ? "descending" : "none";
    const r = ["avg", "alloc", "copy", "gpumem", "unused"].includes(c.k) ? " r" : "";
    return `<button data-sort="${c.k}" aria-sort="${s}" class="${r}" title="Rank lines by ${esc(c.h)}${c.u ? " (" + esc(c.u) + ")" : ""}">${esc(c.h)}${c.u ? `<span class="u">${esc(c.u)}</span>` : ""}${s === "descending" ? `<svg class="i" viewBox="0 0 16 16" style="width:12px;height:12px"><path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/></svg>` : ""}</button>`;
  }).join("");
  host.style.setProperty("--cols", tpl);
  host.innerHTML = `<div class="lhead" role="row">${head}</div>${rows}`;
  if (old.size) {
    for (const r of host.querySelectorAll(".lrow")) {
      const o = old.get(r.dataset.no); const n = r.getBoundingClientRect().top;
      if (o != null && Math.abs(o - n) > 1 && Math.abs(o - n) < 2000) { r.style.transform = `translateY(${o - n}px)`; requestAnimationFrame(() => { r.style.transition = "transform var(--dur-4) var(--ease-standard)"; r.style.transform = ""; }); }
      else if (o == null) { r.style.opacity = "0"; requestAnimationFrame(() => { r.style.transition = "opacity var(--dur-3) linear"; r.style.opacity = ""; }); }
    }
  }
  renderFileInfo(M);
}

function renderFnTable(M) {
  const host = $("#lines"); const F = CV.F;
  const fns = F.fns.slice().sort((a, b) => b.total - a.total || b.peak - a.peak);
  const mx = Math.max(...fns.map((f) => f.total), 0.0001), mxm = M.maxFp || Math.max(...fns.map((f) => f.peak), 1);
  host.innerHTML = `<table class="ftable"><thead><tr><th>Function</th><th style="width:220px">Time <span style="text-transform:none;letter-spacing:0;font-weight:500">% of run</span></th>${M.hasMem ? `<th style="width:200px">Memory <span style="text-transform:none;letter-spacing:0;font-weight:500">peak</span></th>` : ""}${M.showGpu ? `<th style="width:150px">${esc(M.gpuName)} util</th>` : ""}${M.isAsync ? `<th style="width:120px">Await</th>` : ""}<th style="width:80px;text-align:right">Line</th></tr></thead><tbody>
    ${fns.map((f) => `<tr data-no="${f.no}" style="cursor:pointer"><td class="nm">${esc(f.name)}()${f.coro ? ' <span class="badge">async</span>' : ""}</td>
      <td><div class="cell">${meterHTML([[f.py, "var(--cpu-py)"], [f.c, "var(--cpu-native)"], [f.sys, "hatch"]], f.total / mx)}<span class="val${f.total >= 5 ? " hot" : ""}">${fPct(f.total)}</span></div></td>
      ${M.hasMem ? `<td><div class="cell">${meterHTML([[f.peak * f.pyFrac, "var(--mem-py)"], [f.peak * (1 - f.pyFrac), "var(--mem-native)"]], f.peak / mxm)}<span class="val">${f.peak > 0 ? fMem(f.peak) : ""}</span></div></td>` : ""}
      ${M.showGpu ? `<td><div class="cell">${meterHTML([[f.gpu, "var(--gpu)"]], f.gpu / 100)}<span class="val">${f.gpu >= 1 ? fPct(f.gpu) : ""}</span></div></td>` : ""}
      ${M.isAsync ? `<td class="txt">${f.aw >= 1 ? fPct(f.aw) : ""}</td>` : ""}
      <td style="text-align:right;color:var(--fg-3)" class="mono">${f.no}</td></tr>`).join("")}
  </tbody></table>`;
  renderFileInfo(M);
}

function selectFile(M, F, opts = {}) {
  if (CV.F === F && !opts.force) return;
  CV.F = F; CV.open.clear(); CV.sortK = null;
  if (!opts.keepSel) CV.sel = F.lines.filter((l) => l.total > 0).sort((a, b) => b.total - a.total)[0] || null;
  renderFileTabs(M); renderLines(M); renderInspector(M);
}

function renderInspector(M) {
  const el = $("#insp"), body = $("#code-body"); if (!el) return;
  const L = CV.sel;
  const mobile = innerWidth < 1280;
  if (!L || CV.view !== "lines" || (!CV.insp && !mobile) || (mobile && !CV.inspOpen)) { el.hidden = true; body.classList.remove("has-insp"); return; }
  el.hidden = false; body.classList.add("has-insp");
  const T = M.elapsed;
  const fn = L.fn ? `in <code>${esc(L.fn.name)}()</code>` : "module level";
  const reg = L.rs !== L.re ? ` · region ${L.rs}–${L.re}` : "";
  let h = `<div class="insp-in"><h3>${esc(L.F.base)}:${L.no}<button class="btn ghost icon x" data-a="close" aria-label="Close details">${icon("x")}</button></h3>
    <div class="ctx">${fn}${reg}</div><pre>${L.doc ? esc(L.text.trim()) : hiPy(L.text.trim())}</pre>`;
  h += `<div class="blk"><div class="micro"><span class="sw" style="background:var(--cpu-py)"></span>Time</div>
    <div class="big">${fPct(L.total)}<small>of run · ${fTime((L.total / 100) * T)}</small></div>
    <div class="stackbar" style="margin-top:8px">${L.total > 0 ? `<i style="flex:${L.py};background:var(--cpu-py)"></i><i style="flex:${L.c};background:var(--cpu-native)"></i><i class="hatch-bg" style="flex:${L.sys};--c:var(--cpu-sys)"></i>` : ""}</div>
    <div class="kv"><span class="k"><i class="sw" style="background:var(--cpu-py)"></i>Python</span><b>${fPct(L.py)}</b><span class="k"><i class="sw" style="background:var(--cpu-native)"></i>native</span><b>${fPct(L.c)}</b><span class="k"><i class="sw hatch" style="--c:var(--cpu-sys)"></i>system</span><b>${fPct(L.sys)}</b>${L.core ? `<span class="k">core utilization</span><b>${fPct(L.core * 100)}</b>` : ""}</div></div>`;
  h += `<div class="blk"><div class="micro">When it ran <span style="text-transform:none;letter-spacing:0;font-weight:500">· ${L.cs.length ? fInt(L.cs.length) + " main-thread samples" : "no main-thread samples"}${L.ms.length ? " · " + L.ms.length + " allocation events" : ""}</span></div><canvas id="ins-act" height="34" aria-label="Times this line was sampled"></canvas></div>`;
  if (M.hasMem && (L.peak > 0 || L.malloc > 0)) {
    h += `<div class="blk"><div class="micro"><span class="sw" style="background:var(--mem-py)"></span>Memory</div>
      <div class="big">${fMem(L.peak)}<small>peak · avg ${fMem(L.avg)}</small></div>
      <div class="kv"><span class="k">Python share</span><b>${fPct(L.pyFrac * 100)}</b><span class="k">allocated (sampled)</span><b>${fMem(L.malloc)}</b><span class="k">share of all allocation</span><b>${fPct(L.usage * 100)}</b>${L.copy > 0 ? `<span class="k">copy rate</span><b>${fRate(L.copy)}</b>` : ""}${L.leak ? `<span class="k" style="color:var(--danger)">${icon("leak")}possible leak</span><b style="color:var(--danger)">${fRate(L.leak.v)} · ${fPct(L.leak.p * 100)}</b>` : ""}</div>
      ${L.ms.length ? `<canvas id="ins-mem" height="96" style="margin-top:10px" aria-label="Program footprint at each allocation by this line"></canvas>` : ""}</div>`;
  }
  if (M.showGpu && (L.gpu > 0 || L.gpuPeak > 0)) h += `<div class="blk"><div class="micro"><span class="sw" style="background:var(--gpu)"></span>${esc(M.gpuName)}</div><div class="big">${fPct(L.gpu)}<small>busy while this line ran</small></div><div class="kv"><span class="k">device memory peak</span><b>${fMem(L.gpuPeak)}</b><span class="k">device memory avg</span><b>${fMem(L.gpuAvg)}</b></div></div>`;
  if (M.isAsync && (L.aw > 0 || L.coro)) h += `<div class="blk"><div class="micro"><span class="sw" style="background:var(--async)"></span>Async</div><div class="big">${fPct(L.aw)}<small>of all await time</small></div><div class="kv"><span class="k">tasks suspended here (mean / peak)</span><b>${L.cMean.toFixed(1)} / ${L.cPeak}</b><span class="k">coroutine</span><b>${L.coro ? "yes" : "no"}</b></div>${L.tasks.length ? `<div class="hint">${L.tasks.length >= 100 ? "100+ tasks" : L.tasks.length + " tasks"}: ${esc(L.tasks.slice(0, 6).join(", "))}${L.tasks.length > 6 ? "…" : ""}</div>` : ""}</div>`;
  h += `<div class="acts">${L.aiLine ? `<button class="btn" data-a="opt">${icon("spark")}Optimize line</button>` : ""}${L.aiRegion ? `<button class="btn" data-a="optr">${icon("spark")}Optimize ${L.aiRegion[0]}–${L.aiRegion[1]}</button>` : ""}
    <button class="btn ghost" data-a="edit">${icon("jump")}Open in editor</button>${M.flameCpu && M.flameCpu.total ? `<button class="btn ghost" data-a="flame">${icon("flame")}Show in stacks</button>` : ""}</div></div>`;
  el.innerHTML = h;
  requestAnimationFrame(() => drawInspectorCharts(M, L));
}

function drawInspectorCharts(M, L) {
  const T = M.tMax || 1; const fg = tok("--fg"), fg3 = tok("--fg-3"), mem = tok("--mem-py"), line = tok("--line-strong"), grid = tok("--grid"), dng = tok("--danger");
  const a = $("#ins-act");
  if (a) {
    const w = a.clientWidth; const ctx = fitCanvas(a, w, 34); ctx.clearRect(0, 0, w, 34);
    ctx.fillStyle = tok("--sunken"); ctx.fillRect(0, 0, w, 20);
    const p0 = +M.p.start_time_perf || 0; ctx.strokeStyle = hexA(tok("--cpu-py"), 0.85); ctx.lineWidth = 1; ctx.beginPath();
    for (const v of L.cs) { const x = crisp(((v - p0) / T) * w); ctx.moveTo(x, 3); ctx.lineTo(x, 17); } ctx.stroke();
    ctx.fillStyle = mem; for (const s of L.ms) { ctx.beginPath(); ctx.arc((s[0] / 1e9 / T) * w, 10, 2, 0, 7); ctx.fill(); }
    ctx.font = "10.5px " + tok("--font-ui"); ctx.fillStyle = fg3; ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.fillText("0", 0, 23); ctx.textAlign = "right"; ctx.fillText(fTime(T), w, 23);
  }
  const m = $("#ins-mem");
  if (m) {
    const w = m.clientWidth, h = 96; const ctx = fitCanvas(m, w, h); ctx.clearRect(0, 0, w, h);
    const sc = memScale(M.maxFp); const pl = 0, pr = 48, pt = 6, pb = 16; const pw = w - pl - pr, ph = h - pt - pb;
    ctx.font = "10.5px " + tok("--font-ui"); ctx.textBaseline = "middle";
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) { const y = crisp(pt + ph - (v / sc.max) * ph); ctx.strokeStyle = v ? grid : line; ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(pl + pw, y); ctx.stroke(); ctx.fillStyle = fg3; ctx.textAlign = "left"; ctx.fillText(fMemTick(v, sc.step), pl + pw + 6, y); }
    // global footprint, faint, for context
    ctx.strokeStyle = hexA(mem, 0.35); ctx.lineWidth = 1; ctx.beginPath(); M.samples.forEach((s, i) => { const x = pl + (s[0] / 1e9 / T) * pw, y = pt + ph - (s[1] / sc.max) * ph; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    const c = L.leak ? dng : mem; ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath();
    L.ms.forEach((s, i) => { const x = pl + (s[0] / 1e9 / T) * pw, y = pt + ph - (s[1] / sc.max) * ph; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.fillStyle = c; L.ms.forEach((s) => { ctx.beginPath(); ctx.arc(pl + (s[0] / 1e9 / T) * pw, pt + ph - (s[1] / sc.max) * ph, 2, 0, 7); ctx.fill(); });
    ctx.fillStyle = fg3; ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.fillText("0 s", pl, h - 12); ctx.textAlign = "right"; ctx.fillText(fTime(T), pl + pw, h - 12);
    void fg;
  }
}

function setSel(M, L, opts = {}) {
  CV.sel = L;
  $$("#lines .lrow.sel").forEach((r) => { r.classList.remove("sel"); r.tabIndex = -1; r.setAttribute("aria-selected", "false"); });
  const row = L && $(`#lines .lrow[data-no="${L.no}"]`);
  if (row) { row.classList.add("sel"); row.tabIndex = 0; row.setAttribute("aria-selected", "true"); if (opts.focus) row.focus({ preventScroll: !opts.scroll }); }
  if (opts.open) { CV.inspOpen = true; CV.insp = true; }
  renderInspector(M);
}

function mountCode(M) {
  CV.F = M.files[0] || null; if (!CV.F) return;
  CV.sel = CV.F.lines.filter((l) => l.total > 0).sort((a, b) => b.total - a.total)[0] || null;
  renderFileTabs(M); renderLines(M); renderInspector(M);
  $$("#code .seg").forEach((seg) => initSeg(seg, (v) => {
    if (seg.dataset.seg === "view") { CV.view = v; renderLines(M); renderInspector(M); }
    else { CV.mode = v; CV.open.clear(); renderLines(M, { flip: true }); }
  }));
  $("#filetabs").addEventListener("click", (e) => { const b = e.target.closest(".ftab"); if (b) selectFile(M, M.files.find((f) => f.idx === +b.dataset.f)); });
  const lines = $("#lines");
  lines.addEventListener("click", (e) => {
    const sb = e.target.closest("[data-sort]");
    if (sb) { const k = sb.dataset.sort || null; CV.sortK = CV.sortK === k ? null : k; renderLines(M, { flip: true }); return; }
    const fold = e.target.closest(".fold");
    if (fold) { for (let n = +fold.dataset.from; n <= +fold.dataset.to; n++) CV.open.add(n); renderLines(M); return; }
    const tr = e.target.closest("tr[data-no]");
    if (tr) { CV.view = "lines"; const seg = $('#code .seg[data-seg="view"]'); seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === "lines"))); seg._place(); APP.jumpTo(CV.F, +tr.dataset.no); return; }
    const row = e.target.closest(".lrow"); if (!row) return;
    const L = CV.F.byNo.get(+row.dataset.no);
    const a = e.target.closest("[data-a]");
    if (e.target.closest(".ln")) { APP.vsNavigate(L.F.name, L.no); return; }
    if (a && a.dataset.a === "opt") return APP.ai.request(L, "line", row);
    if (a && a.dataset.a === "optr") return APP.ai.request(L, "region", row);
    setSel(M, L, { open: true });
  });
  lines.addEventListener("pointerover", (e) => { const row = e.target.closest(".lrow"); APP.scope && APP.scope.setLine(row ? CV.F.byNo.get(+row.dataset.no) : CV.sel); });
  lines.addEventListener("pointerleave", () => APP.scope && APP.scope.setLine(null));
  lines.addEventListener("keydown", (e) => {
    const row = e.target.closest(".lrow"); if (!row) return;
    const go = (r) => { if (r && r.classList.contains("lrow")) { setSel(M, CV.F.byNo.get(+r.dataset.no), { focus: true, scroll: true }); r.scrollIntoView({ block: "nearest" }); } };
    const sib = (dir) => { let r = row; do { r = dir > 0 ? r.nextElementSibling : r.previousElementSibling; } while (r && !r.classList.contains("lrow")); return r; };
    if (e.key === "ArrowDown" || e.key === "j") { go(sib(1)); e.preventDefault(); }
    else if (e.key === "ArrowUp" || e.key === "k") { go(sib(-1)); e.preventDefault(); }
    else if (e.key === "Enter") { setSel(M, CV.F.byNo.get(+row.dataset.no), { open: true }); e.preventDefault(); }
    else if (e.key === "o") { const L = CV.F.byNo.get(+row.dataset.no); if (L.aiLine) APP.ai.request(L, "line", row); }
    else if (e.key === "Escape") { CV.inspOpen = false; renderInspector(M); }
  });
  $("#insp").addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]"); if (!a) return; const L = CV.sel;
    if (a.dataset.a === "close") { CV.insp = false; CV.inspOpen = false; renderInspector(M); }
    else if (a.dataset.a === "opt") APP.ai.request(L, "line", $(`#lines .lrow[data-no="${L.no}"]`));
    else if (a.dataset.a === "optr") APP.ai.request(L, "region", $(`#lines .lrow[data-no="${L.no}"]`));
    else if (a.dataset.a === "edit") APP.vsNavigate(L.F.name, L.no, true);
    else if (a.dataset.a === "flame") APP.flame && APP.flame.showLine(L);
  });
}
