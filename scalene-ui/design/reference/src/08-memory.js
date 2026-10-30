/* ---------- memory over time + allocators ---------- */
function memoryHTML(M) {
  if (!M.hasMem) return "";
  const gr = clamp(+M.p.growth_rate || 0, 0, 100);
  return `<section class="card" id="memory" aria-labelledby="mm-h">
    <div class="card-h"><h2 id="mm-h">${icon("mem")}Memory</h2><span class="desc">program footprint over time · select an allocation site to see when it allocated</span></div>
    <div class="mem-grid">
      <div class="mem-chart">
        <div class="memstats">
          <div><span class="l">Peak</span><span class="v">${fMem(M.maxFp)}</span></div>
          <div><span class="l">At</span><span class="v">${M.peakT != null ? fTime(M.peakT) : "—"}${M.peakLine ? ` <span class="mono" style="font-size:12.5px;color:var(--fg-3);font-weight:500">${esc(M.peakLine.F.base)}:${M.peakLine.no}</span>` : ""}</span></div>
          <div><span class="l" title="Share of allocated memory that stayed live">Growth</span><span class="v">${fPct(gr)}</span></div>
          ${M.p.native_allocations_mb > 0 ? `<div><span class="l" title="Allocated by native threads with no Python frame">Native threads</span><span class="v">${fMem(M.p.native_allocations_mb)}</span></div>` : ""}
          <div><span class="l">Leaks</span><span class="v" style="${M.leaks.length ? "color:var(--danger)" : ""}">${M.leaks.length || "none"}</span></div>
        </div>
        <canvas id="mm-cv" aria-label="Memory footprint over time, peak ${fMem(M.maxFp)}"></canvas>
      </div>
      <div class="mem-side"><div class="micro" style="margin:2px 8px 8px">Largest allocation sites <span style="text-transform:none;letter-spacing:0;font-weight:500">· peak</span></div><div id="mm-alloc" role="listbox" aria-label="Allocation sites"></div></div>
    </div>
  </section>`;
}

function mountMemory(M) {
  const cv = $("#mm-cv"); if (!cv) return null;
  const S = { sel: M.leaks[0] || M.byMem[0] || null, hoverX: null, reveal: REDUCED || STILL ? -1e9 : null };
  const list = $("#mm-alloc");
  const top = M.byMem.slice(0, 8);
  list.innerHTML = top.map((L, i) => `<div class="alloc${L === S.sel ? " on" : ""}" role="option" tabindex="0" aria-selected="${L === S.sel}" data-i="${i}">
    <span class="a1">${esc(L.F.base)}:${L.no} · ${esc(L.text.trim())}</span><span class="a2">${fMem(L.peak)}</span>
    ${meterHTML([[L.peak * L.pyFrac, "var(--mem-py)"], [L.peak * (1 - L.pyFrac), "var(--mem-native)"]], L.peak / (M.maxFp || 1))}
    ${L.leak ? `<span class="badge danger" style="grid-column:1/-1;justify-self:start;margin-top:4px">${icon("leak")}possible leak · ${fRate(L.leak.v)}</span>` : ""}</div>`).join("");
  const pick = (el) => { if (!el) return; S.sel = top[+el.dataset.i]; $$(".alloc", list).forEach((a) => { a.classList.toggle("on", a === el); a.setAttribute("aria-selected", String(a === el)); }); draw(); };
  list.addEventListener("click", (e) => pick(e.target.closest(".alloc")));
  list.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { pick(e.target.closest(".alloc")); e.preventDefault(); } });
  list.addEventListener("dblclick", (e) => { const el = e.target.closest(".alloc"); if (el) { const L = top[+el.dataset.i]; APP.jumpTo(L.F, L.no); } });

  function draw() {
    const w = cv.parentElement.clientWidth - 0; const h = innerWidth < 720 ? 200 : 260;
    const ctx = fitCanvas(cv, w, h); ctx.clearRect(0, 0, w, h);
    const T = M.tMax || 1; const pl = 4, pr = 64, pt = 12, pb = 24; const pw = w - pl - pr, ph = h - pt - pb;
    const sc = memScale(M.maxFp); const X = (t) => pl + (t / T) * pw, Y = (mb) => pt + ph - (mb / sc.max) * ph;
    const C = { fg: tok("--fg"), fg2: tok("--fg-2"), fg3: tok("--fg-3"), grid: tok("--grid"), lineS: tok("--line-strong"), mem: tok("--mem-py"), dng: tok("--danger"), surf: tok("--surface") };
    const glow = tok("--glow") === "1";
    ctx.font = "11px " + tok("--font-ui"); ctx.textBaseline = "middle";
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) { const y = crisp(Y(v)); ctx.strokeStyle = v === 0 ? C.lineS : C.grid; ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(pl + pw, y); ctx.stroke(); ctx.fillStyle = C.fg3; ctx.textAlign = "left"; ctx.fillText(fMemTick(v, sc.step), pl + pw + 8, y); }
    const step = niceStep(T, Math.max(3, Math.floor(pw / 110)));
    for (let t = 0; t <= T + 1e-9; t += step) { const x = crisp(X(t)); ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, pt + ph); ctx.stroke(); ctx.fillStyle = C.fg3; ctx.textAlign = t === 0 ? "left" : "center"; ctx.fillText(fTick(t, step), X(t), h - 10); }
    const rev = S.reveal == null ? 0 : clamp((now() - S.reveal) / 800, 0, 1); const clipX = pl + pw * (1 - Math.pow(1 - rev, 2.2));
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, clipX, h); ctx.clip();
    if (M.samples.length) {
      const pts = M.samples.map((s) => [X(s[0] / 1e9), Y(s[1])]);
      const area = new Path2D(); area.moveTo(pts[0][0], Y(0)); for (const p of pts) area.lineTo(p[0], p[1]); area.lineTo(pts[pts.length - 1][0], Y(0)); area.closePath();
      const g = ctx.createLinearGradient(0, pt, 0, pt + ph); g.addColorStop(0, hexA(C.mem, glow ? 0.28 : 0.18)); g.addColorStop(1, hexA(C.mem, 0.02)); ctx.fillStyle = g; ctx.fill(area);
      const ln = new Path2D(); pts.forEach((p, i) => (i ? ln.lineTo(p[0], p[1]) : ln.moveTo(p[0], p[1])));
      if (glow) { ctx.save(); ctx.shadowColor = hexA(C.mem, 0.7); ctx.shadowBlur = 10; ctx.strokeStyle = hexA(C.mem, 0.55); ctx.lineWidth = 2; ctx.stroke(ln); ctx.restore(); }
      ctx.strokeStyle = C.mem; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke(ln);
    }
    // selected allocation site: footprint at each of its allocation events
    if (S.sel && S.sel.ms.length) {
      const c = S.sel.leak ? C.dng : C.fg;
      ctx.strokeStyle = hexA(c, 0.45); ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); S.sel.ms.forEach((s, i) => { const x = X(s[0] / 1e9), y = Y(s[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
      for (const s of S.sel.ms) { ctx.fillStyle = C.surf; ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(s[0] / 1e9), Y(s[1]), 3.2, 0, 7); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
    if (M.peakS && rev >= 1 - 1e-6 || (M.peakS && S.reveal == null && false)) {
      const x = X(M.peakT), y = Y(M.peakS[1]); ctx.fillStyle = C.surf; ctx.strokeStyle = C.mem; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fill(); ctx.stroke();
      ctx.font = "600 12px " + tok("--font-ui"); ctx.fillStyle = C.fg; ctx.textAlign = x > pl + pw - 160 ? "right" : "left"; ctx.fillText(`peak ${fMem(M.maxFp)} · ${fTime(M.peakT)}`, x + (ctx.textAlign === "right" ? -10 : 10), y - 2);
    }
    if (S.sel) { ctx.font = "11.5px " + tok("--font-ui"); ctx.fillStyle = C.fg2; ctx.textAlign = "left"; ctx.fillText(`● ${S.sel.F.base}:${S.sel.no} — ${S.sel.ms.length} allocation event${S.sel.ms.length === 1 ? "" : "s"} (footprint at each)`, pl + 8, pt + 8); }
    if (S.hoverX != null) {
      const x = clamp(S.hoverX, pl, pl + pw); const t = ((x - pl) / pw) * T; ctx.strokeStyle = hexA(C.fg, 0.5); ctx.beginPath(); ctx.moveTo(crisp(x), pt); ctx.lineTo(crisp(x), pt + ph); ctx.stroke();
      const sm = M.samples; let v = 0; if (sm.length) { const ns = t * 1e9; let i = sm.findIndex((s) => s[0] >= ns); if (i <= 0) v = sm[Math.max(0, i)][1]; else { const a = sm[i - 1], b = sm[i]; v = a[1] + ((b[1] - a[1]) * (ns - a[0])) / Math.max(1, b[0] - a[0]); } if (i < 0) v = sm[sm.length - 1][1]; }
      ctx.fillStyle = C.mem; ctx.beginPath(); ctx.arc(x, Y(v), 3.5, 0, 7); ctx.fill();
      S.tipText = `<div class="tt" style="font-family:var(--font-ui)">${fMem(v)}</div><div class="hint">footprint at ${fTime(t)}</div>`;
    }
    if (S.reveal != null && rev < 1) requestAnimationFrame(draw);
  }
  cv.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(); S.hoverX = e.clientX - r.left; draw(); APP.tip(S.tipText, e); });
  cv.addEventListener("pointerleave", () => { S.hoverX = null; APP.tip(null); draw(); });
  draw();
  return { redraw: draw, reveal() { if (S.reveal == null) { S.reveal = REDUCED || STILL ? -1e9 : now(); draw(); } } };
}
