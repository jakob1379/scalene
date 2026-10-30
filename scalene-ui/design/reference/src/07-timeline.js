/* ---------- thread timeline: annotation lanes + per-thread flame charts ---------- */
function timelineHTML(M) {
  if (!M.tl) return "";
  const multi = M.threads.length > 1;
  return `<section class="card" id="timeline" aria-labelledby="tl-h">
    <div class="card-h"><h2 id="tl-h">${icon("lanes")}Timeline</h2><span class="desc">${fInt(M.tl.n)} sample runs over ${fTime(M.tMax)}${multi ? ` · ${M.threads.length} threads` : ""} · x = time, rows = stack depth</span><span class="spacer"></span>
      ${multi ? `<div class="seg" role="group" aria-label="Layout" data-seg="mode"><span class="thumb"></span><button aria-pressed="true" data-v="lanes">Swimlanes</button><button aria-pressed="false" data-v="inter">Interleaved</button></div>
      <label class="field" style="height:30px"><select id="tl-thread" aria-label="Thread" style="height:30px;border-color:var(--line-strong);background:var(--raised)"><option value="">All threads</option>${M.threads.map((T, i) => `<option value="${i}">${esc(T.label)}${T.id != null && !T.main ? "" : ""}</option>`).join("")}</select></label>` : ""}
    </div>
    <div class="viz-tools">
      <div class="legend" id="tl-legend"><span><i class="sw tl-py"></i>Python</span><span><i class="sw tl-nat"></i>native</span>${M.stacks.some((s) => s.isAwait) ? `<span><i class="sw hatch" style="--c:var(--async)"></i>[await]</span>` : ""}<span style="color:var(--fg-3)">· drag to zoom · double-click to reset · ⌘/Ctrl + wheel zooms</span></div>
      <span class="spacer" style="flex:1"></span><span class="matchinfo num" id="tl-range"></span>
      <button class="btn ghost icon" id="tl-out" aria-label="Zoom out">${icon("minus")}</button><button class="btn ghost icon" id="tl-in" aria-label="Zoom in">${icon("plus")}</button><button class="btn ghost" id="tl-reset">${icon("reset")}Reset</button>
    </div>
    <div class="chart" id="tl-chart"><canvas id="tl-cv" tabindex="0" aria-label="Thread timeline. A and D pan, W and S zoom."></canvas></div>
  </section>`;
}

function mountTimeline(M) {
  const cv = $("#tl-cv"); if (!cv || !M.tl) return null;
  const T = M.tMax; const tl = M.tl;
  const S = { d0: 0, d1: T, mode: "lanes", only: null, open: new Set([0]), hover: null, drag: null, reveal: REDUCED || STILL ? -1e9 : null, layout: null };
  if (M.threads.length <= 2) M.threads.forEach((_, i) => S.open.add(i));
  const ROWH = Math.max(...M.threads.map((x) => x.maxDepth)) > 12 ? 12 : 14;
  // ---- precompute merged segments per thread per depth
  const lanes = M.threads.map((Th) => ({ Th, rows: Array.from({ length: Th.maxDepth }, () => []) }));
  const ann = { gc: [], io: [], gil: [] };
  const push = (arr, a, b) => { const l = arr[arr.length - 1]; if (l && a <= l.b + M.interval * 0.5) l.b = Math.max(l.b, b); else arr.push({ a, b }); };
  for (let i = 0; i < tl.n; i++) {
    const st = M.stacks[tl.si[i]]; const a = tl.t0[i], b = tl.t1[i], c = tl.cnt[i]; const lane = lanes[tl.th[i]];
    for (let d = 0; d < st.frames.length; d++) {
      const f = st.frames[d]; const k = f.kind + "|" + (f.filename_or_module || "") + "|" + (f.display_name || (f.kind === "native" ? f.ip : "")); const row = lane.rows[d]; const last = row[row.length - 1];
      if (last && last.k === k && a - last.b <= M.interval * 0.5) { last.b = Math.max(last.b, b); last.n += c; }
      else row.push({ a, b, k, f, n: c, aw: st.isAwait && d === st.frames.length - 1 });
    }
    if (st.gc) push(ann.gc, a, b); if (st.io) push(ann.io, a, b); if (st.gil) push(ann.gil, a, b);
  }
  const lowerBound = (row, t) => { let lo = 0, hi = row.length; while (lo < hi) { const m = (lo + hi) >> 1; if (row[m].b < t) lo = m + 1; else hi = m; } return lo; };

  function layout(w) {
    const narrow = w < 640; const gx = narrow ? 8 : 150; const pw = w - gx - 12;
    let y = 28; const items = [];
    for (const [k, lbl, c] of [["gc", "GC", "--mem-native"], ["io", "I/O", "--async"], ["gil", "GIL", "--gil"]]) {
      const tot = M.tlTotals[k] / (M.tlTotals.all || 1);
      items.push({ type: "ann", k, lbl, c, y, h: 12, tot }); y += 16;
    }
    y += 8;
    const showLanes = S.mode === "inter" ? [{ inter: true }] : lanes.map((ln, i) => ({ i })).filter((x) => S.only == null || x.i === S.only);
    for (const L of showLanes) {
      if (L.inter) { const depth = Math.max(...lanes.map((l) => l.rows.length)); items.push({ type: "head", y, h: 22, inter: true }); y += 22; items.push({ type: "flame", y, h: depth * ROWH, inter: true, depth }); y += depth * ROWH + 8; continue; }
      const ln = lanes[L.i]; const open = S.open.has(L.i) || S.only === L.i;
      items.push({ type: "head", y, h: 22, i: L.i, open }); y += narrow ? 22 : 0;
      if (open) { items.push({ type: "flame", y: y + (narrow ? 0 : 22), h: ln.rows.length * ROWH, i: L.i, depth: ln.rows.length }); y += (narrow ? 0 : 22) + ln.rows.length * ROWH + 10; }
      else { items.push({ type: "act", y: y + (narrow ? 0 : 3), h: 16, i: L.i }); y += (narrow ? 0 : 0) + 24; }
    }
    return { w, h: y + 6, gx, pw, items, narrow };
  }
  const tx = (t) => S.layout.gx + ((t - S.d0) / (S.d1 - S.d0)) * S.layout.pw;
  const xt = (x) => S.d0 + ((x - S.layout.gx) / S.layout.pw) * (S.d1 - S.d0);

  function colors() {
    const surf = tok("--sunken"), dark = tok("--glow") === "1"; const f = (c, a) => mixHex(c, surf, a);
    const steel = mixHex(tok("--cpu-native"), tok("--fg-3"), 0.5);
    return { py: f(tok("--cpu-py"), dark ? 0.46 : 0.34), nat: f(steel, dark ? 0.32 : 0.22), mixed: f(steel, dark ? 0.22 : 0.14), pyE: tok("--cpu-py"), natE: tok("--cpu-native"), aw: f(tok("--async"), 0.24), awE: tok("--async"), fg: tok("--fg"), fg2: tok("--fg-2"), fg3: tok("--fg-3"), grid: tok("--grid"), line: tok("--line"), lineS: tok("--line-strong"), surf, sys: tok("--cpu-sys"), card: tok("--surface") };
  }
  function draw() {
    const lg = $("#tl-legend"); if (lg) { const C0 = colors(); const a = lg.querySelector(".tl-py"), b = lg.querySelector(".tl-nat"); if (a) a.style.cssText = `width:14px;height:10px;background:${C0.py};box-shadow:inset 0 1.5px 0 ${C0.pyE}`; if (b) b.style.cssText = `width:14px;height:10px;background:${C0.nat}`; }
    const host = $("#tl-chart"); const w = host.clientWidth; const Lo = (S.layout = layout(w));
    const ctx = fitCanvas(cv, w, Lo.h); const C = colors(); ctx.clearRect(0, 0, w, Lo.h);
    const rev = S.reveal == null ? 0 : clamp((now() - S.reveal) / 700, 0, 1); const clipX = Lo.gx + Lo.pw * (1 - Math.pow(1 - rev, 2.2));
    // axis + grid
    const span = S.d1 - S.d0; const step = niceStep(span, Math.max(3, Math.floor(Lo.pw / 100)));
    ctx.font = "11px " + tok("--font-ui"); ctx.textBaseline = "middle";
    ctx.fillStyle = C.fg3; ctx.textAlign = "left"; if (!Lo.narrow) ctx.fillText("time", 12, 13);
    for (let t = Math.ceil(S.d0 / step) * step; t <= S.d1 + 1e-9; t += step) {
      const x = crisp(tx(t)); ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 22); ctx.lineTo(x, Lo.h); ctx.stroke();
      ctx.strokeStyle = C.lineS; ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, 22); ctx.stroke();
      const lbl = fTick(t, step); const lw = ctx.measureText(lbl).width; ctx.fillStyle = C.fg3; ctx.textAlign = "center";
      if (tx(t) - lw / 2 > Lo.gx - 4 && tx(t) + lw / 2 < w - 2) ctx.fillText(lbl, tx(t), 10);
    }
    ctx.strokeStyle = C.lineS; ctx.beginPath(); ctx.moveTo(Lo.gx, crisp(22)); ctx.lineTo(Lo.gx + Lo.pw, crisp(22)); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, S.reveal == null ? Lo.gx : clipX, Lo.h); ctx.clip();
    for (const it of Lo.items) {
      if (it.type === "ann") {
        ctx.fillStyle = C.surf; ctx.fillRect(Lo.gx, it.y, Lo.pw, it.h);
        const col = tok(it.c); const segs = ann[it.k]; ctx.fillStyle = col;
        for (let j = lowerBound(segs, S.d0); j < segs.length && segs[j].a <= S.d1; j++) { const a = tx(segs[j].a), b = tx(segs[j].b); ctx.fillRect(a, it.y + 1, Math.max(1, b - a), it.h - 2); }
        if (!Lo.narrow) { ctx.fillStyle = col; ctx.fillRect(12, it.y + 3, 6, 6); ctx.fillStyle = C.fg2; ctx.textAlign = "left"; ctx.font = "600 11px " + tok("--font-ui"); ctx.fillText(it.lbl, 24, it.y + 6.5); ctx.font = "11px " + tok("--font-ui"); ctx.fillStyle = C.fg3; ctx.textAlign = "right"; ctx.fillText(fPct(it.tot * 100) + " of samples", Lo.gx - 10, it.y + 6.5); }
      } else if (it.type === "head") {
        ctx.font = "600 12px " + tok("--font-ui"); ctx.textAlign = "left"; ctx.fillStyle = C.fg;
        if (it.inter) { ctx.fillText("All threads (interleaved)", 12, it.y + 11); continue; }
        const Th = M.threads[it.i]; const share = Th.n / (M.tlTotals.all || 1);
        ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(0, crisp(it.y)); ctx.lineTo(w, crisp(it.y)); ctx.stroke();
        const chev = it.open ? "▾" : "▸"; ctx.fillStyle = C.fg3; ctx.fillText(chev, 10, it.y + 12);
        ctx.fillStyle = C.fg; ctx.fillText(Th.label, 24, it.y + 12);
        ctx.font = "11px " + tok("--font-ui"); ctx.fillStyle = C.fg3; const nw = ctx.measureText(Th.label).width;
        if (it.open && !Lo.narrow) ctx.fillText(`${fPct(share * 100)} of samples`, 24, it.y + 28); else ctx.fillText(`· ${fPct(share * 100)}`, 30 + nw, it.y + 12);
      } else if (it.type === "act") {
        // collapsed lane: per-pixel activity by leaf kind
        const nb = Math.max(10, Math.floor(Lo.pw / 2)); const bw = Lo.pw / nb; const py = new Float32Array(nb), na = new Float32Array(nb), wt = new Float32Array(nb), aw = new Float32Array(nb);
        const cap = (span / nb) / M.interval;
        for (let i = 0; i < tl.n; i++) { if (tl.th[i] !== it.i) continue; const a = Math.max(tl.t0[i], S.d0), b = Math.min(tl.t1[i], S.d1); if (b <= a) continue; const st = M.stacks[tl.si[i]]; const k0 = clamp(Math.floor(((a - S.d0) / span) * nb), 0, nb - 1), k1 = clamp(Math.floor(((b - S.d0) / span) * nb), 0, nb - 1); for (let k = k0; k <= k1; k++) { const ov = Math.min(b, S.d0 + ((k + 1) * span) / nb) - Math.max(a, S.d0 + (k * span) / nb); if (ov <= 0) continue; const v = (tl.cnt[i] * ov) / Math.max(1e-9, tl.t1[i] - tl.t0[i]) / cap; (st.isAwait ? aw : st.io || st.gil ? wt : st.leafKind === "native" ? na : py)[k] += v; } }
        ctx.fillStyle = C.surf; ctx.fillRect(Lo.gx, it.y, Lo.pw, it.h);
        for (let k = 0; k < nb; k++) { let yb = it.y + it.h; const x = Lo.gx + k * bw; const seg = (v, c) => { if (v <= 0.01) return; const hh = Math.min(1, v) * it.h; ctx.fillStyle = c; ctx.fillRect(x, yb - hh, Math.max(1, bw - 0.5), hh); yb -= hh; }; seg(py[k], C.pyE); seg(na[k], C.natE); seg(wt[k], hatch(ctx, C.sys, C.card)); seg(aw[k], C.awE); }
      } else if (it.type === "flame") {
        const rowsOf = it.inter ? null : lanes[it.i].rows; ctx.font = "10.5px " + tok("--font-mono");
        const drawRows = (rows) => {
          for (let d = 0; d < rows.length; d++) {
            const row = rows[d]; const y = it.y + d * ROWH;
            let lastPx = -1;
            for (let j = lowerBound(row, S.d0); j < row.length && row[j].a <= S.d1; j++) {
              const s = row[j]; const a = tx(s.a), b = tx(s.b); const bw = b - a;
              if (bw < 1.5) { const px = Math.floor(a); if (px !== lastPx) { ctx.fillStyle = C.mixed; ctx.fillRect(px, y, Math.max(1, Math.ceil(b) - px), ROWH - 1); lastPx = Math.ceil(b) - 1; } continue; }
              const nat = s.f.kind === "native"; ctx.fillStyle = s.aw ? hatch(ctx, C.awE, C.aw) : nat ? C.nat : C.py; ctx.fillRect(a, y, Math.max(0.6, bw - (bw > 3 ? 1 : 0)), ROWH - 1);
              if (bw > 3 && !nat) { ctx.fillStyle = s.aw ? C.awE : C.pyE; ctx.fillRect(a, y, bw - 1, 1); }
              if (S.hover && S.hover.s === s) { ctx.strokeStyle = C.fg; ctx.lineWidth = 1.5; ctx.strokeRect(a + 0.75, y + 0.75, bw - 1.5, ROWH - 2.5); }
              if (bw > 40) { ctx.save(); ctx.beginPath(); ctx.rect(Math.max(a, Lo.gx) + 3, y, bw - 6, ROWH); ctx.clip(); ctx.fillStyle = C.fg; ctx.textAlign = "left"; ctx.textBaseline = "middle"; const nm = frameName(s.f); ctx.fillText(truncMid(ctx, nm, Math.min(b, w) - Math.max(a, Lo.gx) - 8), Math.max(a, Lo.gx) + 4, y + ROWH / 2); ctx.restore(); }
            }
          }
        };
        if (it.inter) lanes.forEach((l) => drawRows(l.rows)); else drawRows(rowsOf);
      }
    }
    ctx.restore();
    // brush
    if (S.drag) { const a = tx(Math.min(S.drag[0], S.drag[1])), b = tx(Math.max(S.drag[0], S.drag[1])); ctx.fillStyle = hexA(C.fg, 0.08); ctx.fillRect(a, 22, b - a, Lo.h - 22); ctx.strokeStyle = hexA(C.fg, 0.6); ctx.strokeRect(crisp(a), 22, b - a, Lo.h - 23); }
    if (S.cursor != null && !S.drag) { const x = crisp(S.cursor); ctx.strokeStyle = hexA(C.fg, 0.5); ctx.beginPath(); ctx.moveTo(x, 22); ctx.lineTo(x, Lo.h); ctx.stroke(); }
    $("#tl-range").textContent = `${fTime(S.d0)} – ${fTime(S.d1)}${S.d1 - S.d0 < T * 0.999 ? ` · ${(T / (S.d1 - S.d0)).toFixed(1)}×` : ""}`;
    if (S.reveal != null && rev < 1) requestAnimationFrame(draw);
  }

  function hit(x, y) {
    const Lo = S.layout; if (!Lo) return null;
    for (const it of Lo.items) {
      if (y < it.y || y >= it.y + it.h) continue;
      if (it.type === "head") return { head: it };
      if (it.type === "flame") {
        const d = Math.floor((y - it.y) / ROWH); const t = xt(x); const ls = it.inter ? lanes : [lanes[it.i]];
        for (const ln of ls) { const row = ln.rows[d]; if (!row) continue; const j = lowerBound(row, t); if (row[j] && row[j].a <= t) return { s: row[j], th: ln.Th }; }
      }
      if (it.type === "ann") { const segs = ann[it.k]; const j = lowerBound(segs, xt(x)); if (segs[j] && segs[j].a <= xt(x)) return { ann: it, seg: segs[j] }; }
    }
    return null;
  }
  const rel = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener("pointermove", (e) => {
    const [x, y] = rel(e); S.cursor = x >= S.layout.gx ? x : null;
    if (S.drag) { S.drag[1] = clamp(xt(x), S.d0, S.d1); draw(); return; }
    const h = hit(x, y); S.hover = h && h.s ? h : null; cv.style.cursor = h && h.head ? "pointer" : h && h.s ? "pointer" : "crosshair";
    if (h && h.s) {
      const f = h.s.f; const L0 = f.kind === "py" ? lookupLine(M, f.filename_or_module, f.line) : null; const L = L0 && L0.fn ? L0.F.byNo.get(L0.fn.no) || L0 : L0;
      APP.tip(`<div class="tk"><i class="sw" style="background:${h.s.aw ? "var(--async)" : f.kind === "native" ? "var(--cpu-native)" : "var(--cpu-py)"}"></i>${h.s.aw ? "await" : f.kind === "native" ? "native" : "Python"} · ${esc(h.th.label)}${h.th.id != null ? ` <span style="font-weight:400;text-transform:none;letter-spacing:0">(id ${h.th.id})</span>` : ""}</div><div class="tt">${esc(frameName(f))}</div><div class="tl">${esc(f.kind === "py" ? basename(f.filename_or_module) + (L ? ":" + L.no : "") : f.filename_or_module || "")}</div><div class="tv"><b>${fTime(h.s.b - h.s.a)}</b><span>${h.s.a.toFixed(3)}–${h.s.b.toFixed(3)} s · ${fInt(h.s.n)} sample${h.s.n === 1 ? "" : "s"}</span></div>${L ? `<pre>${esc(L.text.trim())}</pre>` : ""}`, e);
    } else if (h && h.ann) APP.tip(`<div class="tt" style="font-family:var(--font-ui)">${h.ann.lbl} during ${h.seg.a.toFixed(3)}–${h.seg.b.toFixed(3)} s</div><div class="hint">${fTime(h.seg.b - h.seg.a)}</div>`, e);
    else APP.tip(null);
    draw();
  });
  cv.addEventListener("pointerleave", () => { S.hover = null; S.cursor = null; APP.tip(null); draw(); });
  cv.addEventListener("pointerdown", (e) => { const [x, y] = rel(e); const h = hit(x, y); if (h && h.head) return; if (x < S.layout.gx) return; S.drag = [xt(x), xt(x)]; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointerup", (e) => {
    const [x, y] = rel(e);
    if (S.drag) { const a = Math.min(...S.drag), b = Math.max(...S.drag); S.drag = null; if (tx(b) - tx(a) > 5) { setDomain([a, b]); return; } }
    const h = hit(x, y);
    if (h && h.head && !h.head.inter) { if (S.open.has(h.head.i)) S.open.delete(h.head.i); else S.open.add(h.head.i); draw(); return; }
    if (h && h.s && h.s.f.kind === "py") { const L = lookupLine(M, h.s.f.filename_or_module, h.s.f.line); if (L) APP.jumpTo(L.F, L.fn ? L.fn.no : L.no); }
    draw();
  });
  cv.addEventListener("dblclick", () => setDomain([0, T]));
  cv.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) return;
    e.preventDefault(); const [x] = rel(e); const t = xt(x); const span = S.d1 - S.d0;
    if (e.ctrlKey || e.metaKey) { const k = Math.exp(e.deltaY * 0.002); const ns = clamp(span * k, M.interval * 4, T); const a = t - ((t - S.d0) / span) * ns; S.d0 = clamp(a, 0, T - ns); S.d1 = S.d0 + ns; }
    else { const dt = ((e.shiftKey ? e.deltaY : e.deltaX) / S.layout.pw) * span; S.d0 = clamp(S.d0 + dt, 0, T - span); S.d1 = S.d0 + span; }
    draw();
  }, { passive: false });
  cv.addEventListener("keydown", (e) => {
    const span = S.d1 - S.d0; const c = (S.d0 + S.d1) / 2; let a = S.d0, b = S.d1;
    if (e.key === "w") { a = c - span / 4; b = c + span / 4; } else if (e.key === "s") { a = c - span; b = c + span; }
    else if (e.key === "a") { a -= span * 0.2; b -= span * 0.2; } else if (e.key === "d") { a += span * 0.2; b += span * 0.2; } else return;
    e.preventDefault(); setDomain([a, b], 140);
  });
  function setDomain(r, dur = 280) {
    let [a, b] = r; const ns = clamp(b - a, M.interval * 4, T); a = clamp(a, 0, T - ns); b = a + ns;
    const a0 = S.d0, b0 = S.d1; tween("tl", dur, (k) => { S.d0 = a0 + (a - a0) * k; S.d1 = b0 + (b - b0) * k; draw(); });
  }
  $("#tl-reset").addEventListener("click", () => setDomain([0, T]));
  $("#tl-in").addEventListener("click", () => { const c = (S.d0 + S.d1) / 2, s = (S.d1 - S.d0) / 4; setDomain([c - s, c + s]); });
  $("#tl-out").addEventListener("click", () => { const c = (S.d0 + S.d1) / 2, s = S.d1 - S.d0; setDomain([c - s, c + s]); });
  const seg = $('#timeline .seg[data-seg="mode"]'); if (seg) initSeg(seg, (v) => { S.mode = v; draw(); });
  const sel = $("#tl-thread"); if (sel) sel.addEventListener("change", () => { S.only = sel.value === "" ? null : +sel.value; if (S.only != null) S.mode = "lanes"; draw(); });
  draw();
  return { redraw: draw, setDomain, reveal() { if (S.reveal == null) { S.reveal = REDUCED || STILL ? -1e9 : now(); draw(); } }, state: S };
}
