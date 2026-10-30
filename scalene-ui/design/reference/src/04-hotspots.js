/* ---------- ranked hotspots + findings ---------- */
const HS = { kind: "lines", metric: "time", n: 8 };

function hotspotsHTML(M) {
  return `<div class="row2">
  <section class="card" id="hotspots" aria-labelledby="hs-h">
    <div class="card-h rv" style="--d:180ms">
      <h2 id="hs-h">${icon("flame")}Hotspots</h2>
      <span class="desc" id="hs-desc"></span><span class="spacer"></span>
      <div class="seg" role="group" aria-label="Rank by" data-seg="kind"><span class="thumb"></span>
        <button aria-pressed="true" data-v="lines">Lines</button><button aria-pressed="false" data-v="functions">Functions</button><button aria-pressed="false" data-v="files">Files</button></div>
      ${M.hasMem ? `<div class="seg" role="group" aria-label="Metric" data-seg="metric"><span class="thumb"></span><button aria-pressed="true" data-v="time">Time</button><button aria-pressed="false" data-v="mem">Memory</button></div>` : ""}
    </div>
    <div class="hs-cols micro rv" style="--d:200ms" id="hs-cols"></div>
    <ol class="hs-list" id="hs-list" aria-describedby="hs-desc"></ol>
    <div class="hs-foot rv" style="--d:300ms" id="hs-foot"></div>
  </section>
  <section class="card" id="findings-card" aria-labelledby="fd-h">
    <div class="card-h rv" style="--d:220ms"><h2 id="fd-h">${icon("info")}Findings</h2><span class="desc">rule-based, from this profile</span></div>
    <ul class="findings" id="findings"></ul>
  </section></div>`;
}

function hsItems(M) {
  const t = HS.metric === "time";
  if (HS.kind === "files") {
    const arr = M.files.slice().sort((a, b) => (t ? b.pct - a.pct : b.maxPeak - a.maxPeak));
    return arr.map((F) => ({ key: "F:" + F.name, F, v: t ? F.pct : F.maxPeak, segs: t ? [[F.py, "var(--cpu-py)"], [F.c, "var(--cpu-native)"], [F.sys, "hatch"]] : [[F.maxPeak, "var(--mem-py)"]], code: F.base, codeCls: "", loc: F.dir.replace(/^.*?([^/]+\/[^/]+)$/, "…/$1"), fnName: "", t2: t ? fTime((F.pct / 100) * M.elapsed) : "", badges: [], target: () => APP.jumpTo(F, null) }));
  }
  const src = HS.kind === "functions" ? (t ? M.fnByTime : M.fnByMem) : t ? M.byTime : M.byMem;
  return src.map((L) => {
    const segs = t ? [[L.py, "var(--cpu-py)"], [L.c, "var(--cpu-native)"], [L.sys, "hatch"]] : [[L.peak * L.pyFrac, "var(--mem-py)"], [L.peak * (1 - L.pyFrac), "var(--mem-native)"]];
    const badges = [];
    if (L.leak) badges.push(`<span class="badge danger">${icon("leak")}${fRate(L.leak.v)}</span>`);
    if (M.showGpu && L.gpu >= 1) badges.push(`<span class="badge"><i class="sw" style="background:var(--gpu)"></i>${esc(M.gpuName)} ${fPct(L.gpu)}</span>`);
    if (M.isAsync && L.aw >= 1) badges.push(`<span class="badge"><i class="sw" style="background:var(--async)"></i>await ${fPct(L.aw)}</span>`);
    if (L.copy >= 10) badges.push(`<span class="badge"><i class="sw" style="background:var(--copy)"></i>copy ${fRate(L.copy)}</span>`);
    return {
      key: (L.isFn ? "Fn:" : "L:") + L.F.name + ":" + L.no, L, v: t ? L.total : L.peak, segs,
      code: L.isFn ? L.name + "()" : L.text.trim(), codeCls: L.isFn ? "" : "py",
      loc: `${L.F.base}:${L.no}`, fnName: !L.isFn && L.fn ? L.fn.name + "()" : "",
      t2: t ? fTime((L.total / 100) * M.elapsed) : L.usage > 0 ? fPct(L.usage * 100) : "", badges: badges.slice(0, 2),
      target: () => APP.jumpTo(L.F, L.no),
    };
  });
}

function renderHotspots(M, opts = {}) {
  const list = $("#hs-list"); if (!list) return;
  const t = HS.metric === "time";
  const all = hsItems(M); const items = all.slice(0, HS.n);
  const max = items.length ? Math.max(...items.map((i) => i.v)) || 1 : 1;
  const unit = HS.kind === "lines" ? "lines" : HS.kind;
  $("#hs-desc").textContent = t ? `ranked by share of run time · bars scaled to #1` : `ranked by peak memory · bars scaled to #1`;
  $("#hs-cols").innerHTML = `<span></span><span>${t ? "Share of run time" : "Peak memory"}</span><span style="text-align:right">${t ? "%" : "peak"}</span><span style="text-align:right">${t ? "time" : HS.kind === "files" ? "" : "alloc"}</span><span>${HS.kind === "files" ? "File" : HS.kind === "functions" ? "Function" : "Code"}</span><span></span><span style="text-align:right">${HS.kind === "files" ? "Directory" : "Location"}</span>`;
  // FLIP: remember old positions
  const old = new Map(); if (opts.flip) for (const li of list.children) old.set(li.dataset.key, { top: li.getBoundingClientRect().top, w: li.querySelector(".fill").getBoundingClientRect().width });
  list.innerHTML = items.map((it, i) => {
    const sum = it.segs.reduce((a, s) => a + s[0], 0) || 1;
    const fill = it.segs.map(([v, c]) => (v > 0 ? `<i style="flex:${v / sum};${c === "hatch" ? "--c:var(--cpu-sys)" : "background:" + c}" class="${c === "hatch" ? "hatch-bg" : ""}"></i>` : "")).join("");
    const vtxt = t ? fPct(it.v) : fMem(it.v);
    return `<li class="hs" tabindex="0" data-key="${esc(it.key)}" data-i="${i}" aria-label="#${i + 1} ${esc(it.code)} ${vtxt} at ${esc(it.loc)}">
      <span class="rk">${i + 1}</span>
      <div class="meter"><div class="grad"></div><div class="fill grow" style="width:${(it.v / max) * 100}%;--d:${opts.enter ? 260 + i * 30 : 0}ms">${fill}</div></div>
      <span class="v">${vtxt}</span><span class="t2">${it.t2}</span>
      <span class="code">${it.codeCls === "py" ? hiPy(it.code) : esc(it.code)}</span>
      <span class="bdg">${it.badges.slice(0, 1).join("")}</span>
      <span class="loc">${it.fnName ? `<span class="fn">${esc(it.fnName)}</span>` : ""}<span class="fl">${esc(it.loc)}</span></span></li>`;
  }).join("");
  list._items = items;
  const fills = $$(".fill", list);
  if (opts.enter) { /* bars grow from the baseline in rank order (handled by entry sequence) */ }
  else if (opts.flip && !REDUCED) {
    for (const li of list.children) {
      const o = old.get(li.dataset.key); const f = li.querySelector(".fill");
      if (o) {
        const dy = o.top - li.getBoundingClientRect().top; const nw = f.getBoundingClientRect().width || 1;
        li.style.transform = `translateY(${dy}px)`; f.style.transform = `scaleX(${o.w / nw})`; f.classList.remove("grow");
        requestAnimationFrame(() => { li.style.transition = `transform var(--dur-4) var(--ease-standard)`; f.style.transition = `transform var(--dur-4) var(--ease-standard)`; li.style.transform = ""; f.style.transform = ""; });
      } else { li.style.opacity = "0"; requestAnimationFrame(() => { li.style.transition = `opacity var(--dur-3) linear ${Number(li.dataset.i) * 20}ms`; li.style.opacity = "1"; }); f.classList.add("in"); }
    }
  } else fills.forEach((f) => f.classList.add("in"));
  // footer: pareto
  let cum = 0; for (const it of items) cum += it.v;
  const denom = t ? M.cpu.total || 100 : 0;
  const rest = all.length - items.length;
  $("#hs-foot").innerHTML = t
    ? `<span>Top ${items.length} ${unit} = <b>${fPct(cum)}</b> of run time</span><div class="pareto" aria-hidden="true"><i class="grow in" style="width:${clamp(cum / denom, 0, 1) * 100}%"></i></div><span>${rest > 0 ? `${fInt(rest)} more ${unit} with samples` : ""}</span><span class="spacer" style="flex:1"></span><button class="btn ghost" data-a="code">${icon("code")}Open code view</button>`
    : `<span>Peak memory per ${HS.kind === "files" ? "file (largest line peak)" : HS.kind === "functions" ? "function" : "line"}; bar scaled to #1 · memory peaks overlap in time, so they do not add up</span><span class="spacer" style="flex:1"></span><button class="btn ghost" data-a="code">${icon("code")}Open code view</button>`;
}

function mountHotspots(M) {
  const list = $("#hs-list"); if (!list) return;
  renderHotspots(M, { enter: true });
  $$("#hotspots .seg").forEach((seg) => {
    initSeg(seg, (v) => { HS[seg.dataset.seg] = v; renderHotspots(M, { flip: true }); });
  });
  const itemOf = (li) => list._items[Number(li.dataset.i)];
  list.addEventListener("click", (e) => { const li = e.target.closest(".hs"); if (li) itemOf(li).target(); });
  list.addEventListener("keydown", (e) => {
    const li = e.target.closest(".hs"); if (!li) return;
    if (e.key === "Enter") { itemOf(li).target(); e.preventDefault(); }
    if (e.key === "ArrowDown" || e.key === "j") { (li.nextElementSibling || li).focus(); e.preventDefault(); }
    if (e.key === "ArrowUp" || e.key === "k") { (li.previousElementSibling || li).focus(); e.preventDefault(); }
  });
  const link = (li) => { const it = li && itemOf(li); APP.scope && APP.scope.setLine(it && it.L && !it.L.isFn ? it.L : null); };
  list.addEventListener("pointerover", (e) => link(e.target.closest(".hs")));
  list.addEventListener("pointerleave", () => link(null));
  list.addEventListener("focusin", (e) => link(e.target.closest(".hs")));
  list.addEventListener("focusout", () => link(null));
  $("#hs-foot").addEventListener("click", (e) => { if (e.target.closest("[data-a=code]")) $("#code").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" }); });
}

/* segmented control with a sliding thumb (indicator moves = which option is active) */
function initSeg(seg, onChange) {
  const thumb = seg.querySelector(".thumb");
  const place = (instant) => {
    const b = seg.querySelector('button[aria-pressed="true"]'); if (!b || !thumb) return;
    if (instant) thumb.style.transition = "none";
    thumb.style.width = b.offsetWidth + "px"; thumb.style.transform = `translateX(${b.offsetLeft - 2}px)`;
    if (instant) { thumb.offsetWidth; thumb.style.transition = ""; }
  };
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.getAttribute("aria-pressed") === "true") return;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    place(false); onChange(b.dataset.v);
  });
  requestAnimationFrame(() => place(true));
  seg._place = place;
}

/* rule-based findings: deterministic, offline, each links to its evidence */
function findings(M) {
  const out = [];
  const gs = M.lines.filter((L) => M.showGpu && L.total >= 3 && L.sys >= 0.5 * L.total && L.gpu >= 50).sort((a, b) => b.total - a.total)[0];
  if (gs) out.push({ c: "var(--gpu)", ic: "sync", score: gs.total + 20, L: gs, title: "The host waits on the GPU",
    body: `<code>${esc(gs.text.trim())}</code> takes <b>${fPct(gs.total)}</b> of run time (${fTime((gs.total / 100) * M.elapsed)}), ${fPct(gs.sys)} of it system time, while the ${esc(M.gpuName)} is ${fPct(gs.gpu)} busy — likely a host–device synchronization.` });
  const cb = M.lines.filter((L) => M.isAsync && L.coro && L.total >= 5 && L.py + L.c >= 0.5 * L.total).sort((a, b) => b.total - a.total)[0];
  if (cb) out.push({ c: "var(--async)", ic: "wait", score: cb.total + 20, L: cb, title: "CPU work blocks the event loop",
    body: `<code>${esc(cb.text.trim())}</code> runs inside a coroutine and uses <b>${fPct(cb.total)}</b> of run time; nothing else can run while it does.` });
  for (const L of M.leaks.slice(0, 2)) out.push({ c: "var(--danger)", ic: "leak", score: 18 + L.leak.p, L, title: `Possible leak at ${L.F.base}:${L.no}`,
    body: `<code>${esc(L.text.trim())}</code> grows about <b>${fRate(L.leak.v)}</b> (likelihood ${fPct(L.leak.p * 100)}); peak ${fMem(L.peak)}.` });
  if (M.hasMem && M.peakLine) out.push({ c: "var(--mem-py)", ic: "peak", score: 12, L: M.peakLine, title: `Peak ${fMem(M.maxFp)} at ${fTime(M.peakT || 0)}`,
    body: `The footprint maximum was set by <code>${esc(M.peakLine.text.trim())}</code> (${esc(M.peakLine.F.base)}:${M.peakLine.no}).` });
  const nat = M.cpu.c / (M.cpu.total || 1);
  if (nat >= 0.5) out.push({ c: "var(--cpu-native)", ic: "cpu", score: 8, L: M.byTime.find((l) => l.c > l.py) || null, title: "Most time is in native code",
    body: `<b>${fPct(M.cpu.c)}</b> of run time is spent in compiled libraries; Python itself takes ${fPct(M.cpu.py)}. Speed-ups come from calling native code less often, not from tuning Python loops.` });
  else if (M.cpu.py / (M.cpu.total || 1) >= 0.5) out.push({ c: "var(--cpu-py)", ic: "cpu", score: 9, L: M.byTime[0], title: "Most time is in Python",
    body: `<b>${fPct(M.cpu.py)}</b> of run time runs in the interpreter — vectorising or moving hot loops to native code is likely to pay off.` });
  const idle = M.lines.filter((L) => M.hasNeuron && L.total >= 5 && L.overlap != null && 100 - L.overlap >= 60).sort((a, b) => b.total - a.total)[0];
  if (idle) out.push({ c: "var(--gpu)", ic: "gpu", score: idle.total + 15, L: idle, title: "The accelerator idles during CPU work",
    body: `<code>${esc(idle.text.trim())}</code> takes <b>${fPct(idle.total)}</b> of run time, and the NeuronCore is idle in ${fPct(100 - idle.overlap)} of its samples — overlap it with device work.` });
  const cp = M.lines.filter((l) => l.copy >= 10).sort((a, b) => b.copy - a.copy)[0];
  if (cp) out.push({ c: "var(--copy)", ic: "copy", score: 6, L: cp, title: "Heavy memory copying",
    body: `<code>${esc(cp.text.trim())}</code> copies <b>${fRate(cp.copy)}</b> on average across the run.` });
  if (M.tl && M.tlTotals.gil / (M.tlTotals.all || 1) >= 0.02) out.push({ c: "var(--gil)", ic: "lanes", score: 7, L: null, title: "Threads wait for the GIL",
    body: `${fPct((M.tlTotals.gil / M.tlTotals.all) * 100)} of stack samples are waiting to acquire the GIL.` });
  return out.sort((a, b) => b.score - a.score);
}

function renderFindings(M) {
  const ul = $("#findings"); if (!ul) return;
  const all = findings(M); let open = false;
  const draw = () => {
    const show = open ? all : all.slice(0, 3);
    ul.innerHTML = show.map((f, i) => `<li class="finding rv" style="--d:${260 + i * 40}ms;--c:${f.c}" tabindex="0" data-i="${i}">
      <span class="ic">${icon(f.ic)}</span><div><h3>${f.title}</h3><p>${f.body}</p>${f.L ? `<span class="go">${esc(f.L.F.base)}:${f.L.no} ${icon("chev")}</span>` : ""}</div></li>`).join("") +
      (all.length > 3 ? `<li><button class="btn ghost" id="fd-more" style="width:100%;justify-content:center">${open ? "Show fewer" : `Show ${all.length - 3} more`}</button></li>` : "");
    if (!all.length) ul.innerHTML = `<li class="hint" style="padding:8px">No notable patterns detected.</li>`;
    if (APP.entered) $$(".rv", ul).forEach((x) => x.classList.add("in"));
    const more = $("#fd-more"); if (more) more.onclick = () => { open = !open; draw(); };
  };
  draw();
  const fOf = (li) => all[Number(li.dataset.i)];
  ul.addEventListener("click", (e) => { const li = e.target.closest(".finding"); if (li && fOf(li).L) APP.jumpTo(fOf(li).L.F, fOf(li).L.no); });
  ul.addEventListener("keydown", (e) => { const li = e.target.closest(".finding"); if (li && e.key === "Enter" && fOf(li).L) APP.jumpTo(fOf(li).L.F, fOf(li).L.no); });
  ul.addEventListener("pointerover", (e) => { const li = e.target.closest(".finding"); APP.scope && APP.scope.setLine(li && fOf(li).L ? fOf(li).L : null); });
  ul.addEventListener("pointerleave", () => APP.scope && APP.scope.setLine(null));
}
