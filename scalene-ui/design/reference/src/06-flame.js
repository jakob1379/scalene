/* ---------- stacks: icicle flame graph (CPU + memory) ---------- */
function stacksHTML(M) {
  const hasCpu = M.flameCpu && M.flameCpu.total > 0, hasMem = M.flameMem && M.flameMem.total > 0;
  if (!hasCpu && !hasMem) return "";
  return `<section class="card" id="stacks" aria-labelledby="st-h">
    <div class="card-h"><h2 id="st-h">${icon("flame")}Call stacks</h2><span class="desc" id="st-desc"></span><span class="spacer"></span>
      ${hasCpu && hasMem ? `<div class="seg" role="group" aria-label="Stacks" data-seg="tab"><span class="thumb"></span><button aria-pressed="true" data-v="cpu">CPU</button><button aria-pressed="false" data-v="mem">Memory</button></div>` : ""}
    </div>
    <div class="viz-tools">
      <label class="searchbox">${icon("search")}<input id="fl-q" type="search" placeholder="Find function or file" aria-label="Find in stacks" autocomplete="off"></label>
      <span class="matchinfo" id="fl-match"></span><span class="spacer" style="flex:1"></span>
      <div class="legend" id="fl-legend"></div>
      <button class="btn ghost" id="fl-reset" hidden>${icon("reset")}Reset zoom</button>
    </div>
    <nav class="crumbs" id="fl-crumbs" aria-label="Zoom path"></nav>
    <div class="chart scroll" id="fl-chart"><canvas id="fl-cv" tabindex="0" aria-label="Flame graph. Arrow keys move between frames, Enter zooms, Escape zooms out."></canvas></div>
  </section>`;
}

function mountFlame(M) {
  const cv = $("#fl-cv"); if (!cv) return null;
  const S = { tab: M.flameCpu && M.flameCpu.total ? "cpu" : "mem", z0: 0, z1: 1, zoom: null, q: "", hover: null, focus: null, reveal: REDUCED || STILL ? -1e9 : null, matched: null };
  const ROW = 22;
  const tree = () => (S.tab === "cpu" ? M.flameCpu : M.flameMem);
  let byDepth = null;
  const index = () => { const t = tree(); byDepth = []; for (const n of t.flat) { (byDepth[n.depth] = byDepth[n.depth] || []).push(n); } for (const a of byDepth) if (a) a.sort((x, y) => x.x0 - y.x0); };
  index(); S.zoom = tree().root;

  function desc() {
    const t = tree();
    if (S.tab === "cpu") $("#st-desc").textContent = `${fInt(M.stacks.length)} stitched Python + native stacks · ${fInt(t.total)} samples · width = share of sampled stacks`;
    else $("#st-desc").textContent = `${fInt((M.p.memory_stacks || []).length)} allocation stacks · ${fMem(t.total)} attributed · width = share of sampled allocation (MiB)`;
    const C = colors(); const chip = (fill, edge) => `<i class="sw" style="width:14px;height:10px;background:${fill};${edge ? `box-shadow:inset 0 1.5px 0 ${edge}` : ""}"></i>`;
    $("#fl-legend").innerHTML = S.tab === "cpu"
      ? `<span>${chip(C.py, C.pyE)}Python</span><span>${chip(C.nat)}native</span>${M.stacks.some((s) => s.isAwait) ? `<span><i class="sw hatch" style="--c:var(--async)"></i>[await]</span>` : ""}`
      : `<span>${chip(C.py, C.pyE)}Python frames (allocation sites)</span>`;
  }
  function colors() {
    const surf = tok("--sunken"), dark = tok("--glow") === "1"; const f = (c, a) => mixHex(c, surf, a);
    const base = S.tab === "cpu" ? [tok("--cpu-py"), tok("--cpu-native")] : [tok("--mem-py"), tok("--mem-native")];
    const steel = mixHex(base[1], tok("--fg-3"), 0.5);
    return { py: f(base[0], dark ? 0.46 : 0.34), nat: f(steel, dark ? 0.32 : 0.22), aw: f(tok("--async"), dark ? 0.26 : 0.2), pyE: base[0], natE: null, awE: tok("--async"), fg: tok("--fg"), fg3: tok("--fg-3"), surf, dim: f(tok("--fg-3"), 0.12) };
  }
  const matches = (n) => { if (!S.q) return true; const q = S.q.toLowerCase(); return n.name.toLowerCase().includes(q) || basename(n.file).toLowerCase().includes(q); };

  function draw() {
    const t = tree(); const host = $("#fl-chart"); const w = host.clientWidth;
    const depth = Math.max(1, t.maxD); const h = depth * ROW + 6;
    const ctx = fitCanvas(cv, w, h); const C = colors(); ctx.clearRect(0, 0, w, h);
    ctx.font = "11.5px " + tok("--font-mono"); ctx.textBaseline = "middle";
    const span = S.z1 - S.z0; const elapsedReveal = S.reveal == null ? 0 : now() - S.reveal;
    let matchedV = 0; const zoomDesc = (n) => { let p = n; while (p) { if (p === S.zoom) return true; p = p.parent; } return false; };
    for (const n of t.flat) {
      if (n.depth === 0) continue;
      const x = ((n.x0 - S.z0) / span) * w, x2 = ((n.x1 - S.z0) / span) * w; let bw = x2 - x;
      if (x2 < 0 || x > w || bw < 0.9) continue;
      let y = (n.depth - 1) * ROW + 3; let rh = ROW - 2;
      const rf = clamp((elapsedReveal - (n.depth - 1) * 16) / 260, 0, 1); if (rf <= 0) continue;
      const re = easeOut(rf); rh = rh * re;
      const isM = matches(n); if (S.q && isM && !(n.parent && matches(n.parent))) matchedV += n.v;
      const inZoom = zoomDesc(n) || !S.zoom || S.zoom.depth === 0;
      const fill = !isM ? C.dim : n.isAwait ? hatch(ctx, C.awE, C.aw) : n.kind === "native" ? C.nat : C.py;
      const edge = n.isAwait ? C.awE : n.kind === "native" ? null : C.pyE;
      const xx = Math.max(x, -2), ww = Math.min(x2, w + 2) - xx - (bw > 3 ? 1 : 0);
      ctx.globalAlpha = (inZoom ? 1 : 0.55) * (isM ? 1 : 0.9) * (bw < 3 ? 0.55 : 1);
      ctx.fillStyle = fill; ctx.fillRect(xx, y, ww, rh);
      if (isM && edge && ww > 3) { ctx.fillStyle = edge; ctx.fillRect(xx, y, ww, 1.25); }
      if (S.hover === n || S.focus === n) { ctx.globalAlpha = 1; ctx.strokeStyle = C.fg; ctx.lineWidth = 1.5; ctx.strokeRect(xx + 0.75, y + 0.75, ww - 1.5, rh - 1.5); }
      if (ww > 34 && rf > 0.6) {
        ctx.globalAlpha = isM ? 1 : 0.55; ctx.save(); ctx.beginPath(); ctx.rect(xx + 5, y, ww - 10, rh); ctx.clip();
        const nm = n.name, ln = n.kind === "py" && n.line != null ? ":" + n.line : "";
        const tx = Math.max(xx, 0) + 6; const avail = Math.min(ww, w - tx) - 10;
        const lbl = truncMid(ctx, nm, avail - (ln ? ctx.measureText(ln).width : 0));
        ctx.fillStyle = C.fg; ctx.textAlign = "left"; ctx.fillText(lbl || truncMid(ctx, nm, avail), tx, y + rh / 2 + 0.5);
        if (lbl && ln) { ctx.fillStyle = C.fg3; ctx.fillText(ln, tx + ctx.measureText(lbl).width, y + rh / 2 + 0.5); }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    S.matched = S.q ? matchedV / (t.total || 1) : null;
    $("#fl-match").innerHTML = S.q ? `matched <b>${fPct(S.matched * 100)}</b> of ${S.tab === "cpu" ? "samples" : "allocation"}` : "";
    if (S.reveal != null && elapsedReveal < depth * 16 + 300) requestAnimationFrame(draw);
  }
  function crumbs() {
    const path = []; let p = S.zoom; while (p && p.depth > 0) { path.unshift(p); p = p.parent; }
    $("#fl-crumbs").innerHTML = `<button data-d="0">all</button>` + path.map((n, i) => `<span aria-hidden="true">›</span>${i === path.length - 1 ? `<span class="cur">${esc(n.name)}${n.line != null && n.kind === "py" ? ":" + n.line : ""}</span>` : `<button data-k="${i}">${esc(n.name)}</button>`}`).join("");
    $("#fl-crumbs")._path = path; $("#fl-reset").hidden = !(S.zoom && S.zoom.depth > 0);
  }
  function zoomTo(n) {
    S.zoom = n; const a0 = S.z0, a1 = S.z1; const b0 = n.depth ? n.x0 : 0, b1 = n.depth ? n.x1 : 1;
    tween("flame", 280, (k) => { S.z0 = a0 + (b0 - a0) * k; S.z1 = a1 + (b1 - a1) * k; draw(); });
    crumbs();
  }
  function hit(e) {
    const r = cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    const d = Math.floor((y - 3) / ROW) + 1; const arr = byDepth[d]; if (!arr) return null;
    const f = S.z0 + (x / r.width) * (S.z1 - S.z0);
    let lo = 0, hi = arr.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].x1 <= f) lo = m + 1; else if (arr[m].x0 > f) hi = m - 1; else return arr[m]; }
    return null;
  }
  function tipFor(n, e) {
    const t = tree(); const share = n.v / (t.total || 1);
    const L = n.kind === "py" ? lookupLine(M, n.file, n.line) : null;
    const val = S.tab === "cpu" ? `${fInt(n.v)} samples` : fMem(n.v);
    const self = S.tab === "cpu" ? `${fInt(n.self)} self` : `${fMem(n.self)} self`;
    APP.tip(`<div class="tk"><i class="sw" style="background:${n.isAwait ? "var(--async)" : n.kind === "native" ? (S.tab === "cpu" ? "var(--cpu-native)" : "var(--mem-native)") : S.tab === "cpu" ? "var(--cpu-py)" : "var(--mem-py)"}"></i>${n.isAwait ? "await" : n.kind === "native" ? "native" : "Python"} frame</div>
      <div class="tt">${esc(n.name)}</div><div class="tl">${esc(n.kind === "py" ? basename(n.file) + ":" + n.line : n.file || "unresolved module")}</div>
      <div class="tv"><b>${fPct(share * 100)}</b><span>${val} · ${self}</span></div>
      <div class="hint" style="margin-top:2px">${S.tab === "cpu" ? "share of sampled stacks" : "share of attributed allocation"}${n.parent && n.parent.depth ? ` · ${fPct((n.v / n.parent.v) * 100)} of caller` : ""}</div>
      ${L ? `<pre>${esc(L.text.trim())}</pre>` : ""}<div class="hint" style="margin-top:6px">Click to zoom${n.kind === "py" ? " · double-click to open the line" : ""}</div>`, e);
  }
  cv.addEventListener("pointermove", (e) => { const n = hit(e); if (n !== S.hover) { S.hover = n; draw(); } if (n) tipFor(n, e); else APP.tip(null); cv.style.cursor = n ? "pointer" : "default"; });
  cv.addEventListener("pointerleave", () => { S.hover = null; APP.tip(null); draw(); });
  cv.addEventListener("click", (e) => { const n = hit(e); if (n) zoomTo(n === S.zoom ? n.parent || tree().root : n); });
  cv.addEventListener("dblclick", (e) => { const n = hit(e); if (n && n.kind === "py") { const L = lookupLine(M, n.file, n.line); if (L) APP.jumpTo(L.F, L.no); } });
  cv.addEventListener("keydown", (e) => {
    let n = S.focus || S.zoom; const t = tree();
    if (!n || n.depth === 0) n = t.root.kids[0];
    const sib = (dir) => { const arr = byDepth[n.depth]; const i = arr.indexOf(n); return arr[i + dir] || n; };
    if (e.key === "ArrowDown") n = (n.kids && n.kids[0]) || n; else if (e.key === "ArrowUp") n = n.parent && n.parent.depth ? n.parent : n;
    else if (e.key === "ArrowRight") n = sib(1); else if (e.key === "ArrowLeft") n = sib(-1);
    else if (e.key === "Enter") { zoomTo(n); e.preventDefault(); return; }
    else if (e.key === "Escape") { zoomTo(S.zoom && S.zoom.parent ? S.zoom.parent : t.root); e.preventDefault(); return; }
    else return;
    e.preventDefault(); S.focus = n; draw();
    const r = cv.getBoundingClientRect(); APP.tip(null); tipFor(n, { clientX: r.left + ((n.x0 + n.x1) / 2 - S.z0) / (S.z1 - S.z0) * r.width, clientY: r.top + n.depth * ROW + 10 });
  });
  cv.addEventListener("blur", () => { APP.tip(null); });
  $("#fl-crumbs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.d === "0") zoomTo(tree().root); else zoomTo($("#fl-crumbs")._path[+b.dataset.k]); });
  $("#fl-reset").addEventListener("click", () => zoomTo(tree().root));
  $("#fl-q").addEventListener("input", (e) => { S.q = e.target.value.trim(); draw(); });
  const seg = $('#stacks .seg[data-seg="tab"]');
  if (seg) initSeg(seg, (v) => { S.tab = v; index(); S.zoom = tree().root; S.z0 = 0; S.z1 = 1; S.reveal = REDUCED ? -1e9 : now(); desc(); crumbs(); draw(); });
  desc(); crumbs();
  return {
    redraw() { desc(); draw(); },
    reveal() { if (S.reveal == null) { S.reveal = REDUCED || STILL ? -1e9 : now(); draw(); } },
    showLine(L) { // zoom to the heaviest frame for this line
      if (S.tab !== "cpu" && seg) seg.querySelector('[data-v="cpu"]').click();
      const t = tree(); let best = null; for (const n of t.flat) if (n.kind === "py" && n.file === L.F.name && n.line === L.no && (!best || n.v > best.v)) best = n;
      $("#stacks").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
      if (best) { S.q = ""; $("#fl-q").value = ""; setTimeout(() => zoomTo(best), REDUCED ? 0 : 350); }
    },
    zoomTo, state: S,
  };
}
