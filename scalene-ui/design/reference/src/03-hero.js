/* ---------- hero: headline, readouts, the "signal" scope ---------- */
const NUMW = ["zero", "One", "Two", "Three", "Four", "Five"];

function headlineHTML(M) {
  const prog = basename(M.program) || "This program";
  let s = `<b>${esc(prog)}</b> ran for <b>${fTime(M.elapsed)}</b>.`;
  const tot = M.cpu.total; let acc = 0, k = 0;
  for (const L of M.byTime) { acc += L.total; k++; if (acc >= tot / 3 || k >= 5) break; }
  if (k && tot > 0) {
    const fns = new Set(M.byTime.slice(0, k).map((L) => (L.fn ? L.fn.name : "")));
    const one = fns.size === 1 ? [...fns][0] : "";
    s += ` ${NUMW[k]} line${k > 1 ? "s" : ""}${one ? ` in <code>${esc(one)}()</code>` : ""} account${k > 1 ? "" : "s"} for <b>${fPct(acc)}</b> of the time`;
    s += M.hasMem && M.maxFp > 0 ? `; memory peaked at <b>${fMem(M.maxFp)}</b>.` : ".";
  } else if (M.hasMem && M.maxFp > 0) s += ` Memory peaked at <b>${fMem(M.maxFp)}</b>.`;
  return s;
}

function metaHTML(M) {
  const bits = [];
  if (M.p.start_time_absolute) {
    const d = new Date(M.p.start_time_absolute * 1000);
    bits.push(`Profiled ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`);
  }
  bits.push(`${M.files.length} file${M.files.length === 1 ? "" : "s"}${M.hidden.length ? ` <span title="Files under 1% of time with little memory activity">(+${M.hidden.length} below threshold)</span>` : ""}`);
  if (M.threads.length > 1) bits.push(`${M.threads.length} threads`);
  if (M.isAsync) bits.push("async");
  if (M.hasGpu) bits.push(M.hasNeuron ? "AWS Neuron" : esc(M.gpuName));
  if (!M.hasMem) bits.push("CPU only");
  bits.push(`Scalene ${esc(window.SCALENE_VERSION || "2.4.0")}`);
  return bits.map((b, i) => (i ? '<span class="dot"></span>' : "") + `<span>${b}</span>`).join("");
}

function kpiHTML(M) {
  const t = splitUnit(fTime(M.elapsed));
  const c = M.cpu; const tot = c.total || 1;
  const tiles = [];
  tiles.push(`<div class="kpi rv" style="--d:40ms"><div class="micro"><span class="led" style="--c:var(--fg-2)"></span>Elapsed</div>
    <div class="val"><span data-count="${t[0]}">${t[0]}</span><small>${t[1]}</small></div>
    <div class="cap">wall clock${M.threads.length > 1 ? ` · ${M.threads.length} threads sampled` : ""}</div></div>`);
  tiles.push(`<div class="kpi rv" style="--d:80ms"><div class="micro"><span class="led" style="--c:var(--cpu-py)"></span>Where the time went</div>
    <div class="split-vals">
      <div class="sv"><span class="v num" data-count="${fPct(c.py)}">${fPct(c.py)}</span><span class="l"><i class="sw" style="background:var(--cpu-py)"></i>Python</span></div>
      <div class="sv"><span class="v num" data-count="${fPct(c.c)}">${fPct(c.c)}</span><span class="l"><i class="sw" style="background:var(--cpu-native)"></i>native</span></div>
      <div class="sv"><span class="v num" data-count="${fPct(c.sys)}">${fPct(c.sys)}</span><span class="l"><i class="sw hatch" style="--c:var(--cpu-sys)"></i>system</span></div>
    </div>
    <div class="stackbar" role="img" aria-label="Python ${fPct(c.py)}, native ${fPct(c.c)}, system ${fPct(c.sys)} of run time">
      <i class="grow" style="--d:160ms;flex:${c.py};background:var(--cpu-py)"></i><i class="grow" style="--d:200ms;flex:${c.c};background:var(--cpu-native)"></i><i class="grow hatch-bg" style="--d:240ms;flex:${c.sys};--c:var(--cpu-sys)"></i>${M.unattributed > 0.05 ? `<i style="flex:${M.unattributed}"></i>` : ""}
    </div>
    <div class="cap">share of run time${M.unattributed >= 0.05 ? ` · ${fPct(M.unattributed)} outside profiled files` : ""}</div></div>`);
  if (M.hasMem) {
    const m = splitUnit(fMem(M.maxFp)); const hasPf = M.p.max_footprint_python_fraction != null; const pf = clamp(+M.p.max_footprint_python_fraction || 0, 0, 1);
    const where = M.peakLine ? `<code>${esc(M.peakLine.F.base)}:${M.peakLine.no}</code>` : "";
    tiles.push(`<div class="kpi rv" style="--d:120ms"><div class="micro"><span class="led" style="--c:var(--mem-py)"></span>Peak memory</div>
      <div class="val"><span data-count="${m[0]}">${m[0]}</span><small>${m[1]}</small></div>
      ${hasPf ? `<div class="minibar" role="img" aria-label="Python ${fPct(pf * 100)}, native ${fPct((1 - pf) * 100)} of the peak allocation"><i class="grow" style="--d:220ms;flex:${pf};background:var(--mem-py)"></i><i class="grow" style="--d:260ms;flex:${1 - pf};background:var(--mem-native)"></i></div>` : `<div class="minibar"><i class="grow" style="--d:220ms;flex:1;background:var(--mem-py);opacity:.5"></i></div>`}
      <div class="cap">${M.peakT != null ? `at <b>${fTime(M.peakT)}</b>` : ""}${where ? ` · ${where}` : ""}${hasPf ? ` · Python ${fPct(pf * 100)}` : ""}<br>growth <b>${fPct(clamp(+M.p.growth_rate || 0, 0, 100))}</b>${M.p.native_allocations_mb > 0 ? ` · +${fMem(M.p.native_allocations_mb)} native threads` : ""}</div></div>`);
  }
  if (M.hasNeuron) {
    const nrt = M.lines.reduce((a, l) => a + l.nrt, 0) / 1000, nc = M.lines.reduce((a, l) => a + l.nc, 0) / 1000;
    const ov = M.p.cpu_samples_nc_overlap_percent_overall; const v = splitUnit(fTime(nrt));
    tiles.push(`<div class="kpi rv" style="--d:160ms"><div class="micro"><span class="led" style="--c:var(--gpu)"></span>Neuron runtime</div>
      <div class="val"><span data-count="${v[0]}">${v[0]}</span><small>${v[1]} · ${fPct((nrt / (M.elapsed || 1)) * 100)}</small></div>
      <div class="cap">NRT time, share of elapsed<br>NeuronCore busy <b>${fTime(nc)}</b>${ov != null ? ` · device idle in <b>${fPct(100 - ov)}</b> of CPU samples` : ""}</div></div>`);
  } else if (M.showGpu) {
    const g = splitUnit(fMem(M.gpuPeak)); const L = M.gpuMaxLine;
    tiles.push(`<div class="kpi rv" style="--d:160ms"><div class="micro"><span class="led" style="--c:var(--gpu)"></span>${esc(M.gpuName)} memory</div>
      <div class="val"><span data-count="${g[0]}">${g[0]}</span><small>${g[1]}</small></div>
      <div class="cap">peak device memory${L ? `<br>busiest line <b>${fPct(L.gpu)}</b> util · <code>${esc(L.F.base)}:${L.no}</code>` : ""}</div></div>`);
  } else if (M.isAsync) {
    const top = M.lines.filter((l) => l.aw > 0).sort((a, b) => b.aw - a.aw)[0];
    const peak = Math.max(0, ...M.lines.map((l) => l.cPeak));
    tiles.push(`<div class="kpi rv" style="--d:160ms"><div class="micro"><span class="led" style="--c:var(--async)"></span>Await</div>
      <div class="val"><span data-count="${peak}">${peak}</span><small>tasks peak</small></div>
      <div class="cap">suspended at once${top ? `<br>most await: <b>${fPct(top.aw)}</b> · <code>${esc(top.F.base)}:${top.no}</code>` : ""}</div></div>`);
  } else if (M.byTime.length) {
    const L = M.byTime[0]; const v = splitUnit(fPct(L.total));
    tiles.push(`<div class="kpi rv" style="--d:160ms"><div class="micro"><span class="led" style="--c:var(--cpu-py)"></span>Hottest line</div>
      <div class="val"><span data-count="${v[0]}%">${v[0]}%</span><small>${fTime((L.total / 100) * M.elapsed)}</small></div>
      <div class="cap"><code>${esc(L.F.base)}:${L.no}</code> · <code>${esc(L.text.trim().slice(0, 40))}</code></div></div>`);
  }
  return `<div class="kpis" style="grid-template-columns:${tiles.length === 4 ? "" : tiles.length === 3 ? "minmax(150px,.8fr) minmax(300px,1.7fr) minmax(220px,1.2fr)" : "1fr 2fr"}">${tiles.join("")}</div>`;
}

function heroHTML(M) {
  const leg = [`<span><i class="sw" style="background:var(--mem-py)"></i>Memory footprint</span>`];
  if (M.tl) leg.push(`<span><i class="sw" style="background:var(--cpu-py)"></i>Python</span>`, `<span><i class="sw" style="background:var(--cpu-native)"></i>native</span>`, `<span><i class="sw hatch" style="--c:var(--cpu-sys)"></i>I/O · GIL wait</span>`);
  if (M.isAsync && M.tl) leg.push(`<span><i class="sw" style="background:var(--async)"></i>suspended tasks</span>`);
  if (!M.hasMem) leg.shift();
  return `<section id="overview" class="card hero" aria-labelledby="hl">
    <div class="hero-top"><div class="grow">
      <h1 id="hl" class="headline rv">${headlineHTML(M)}</h1>
      <div class="meta rv" style="--d:60ms">${metaHTML(M)}</div>
    </div></div>
    ${kpiHTML(M)}
    <div class="scope-wrap">
      <div class="scope-head rv" style="--d:120ms"><span class="micro">Signal</span><span class="desc" style="color:var(--fg-3);font-size:12.5px">The run over time — hover to read values, drag to select a range</span><div class="legend">${leg.join("")}</div></div>
      <div class="scope" id="scope" role="img"${M.hasMem && M.tl ? "" : ' style="height:210px"'} aria-label="Signal: ${M.hasMem ? `memory footprint peaks at ${fMem(M.maxFp)} at ${fTime(M.peakT || 0)}; ` : ""}CPU activity over ${fTime(M.tMax)}">
        <canvas id="scope-base"></canvas><canvas id="scope-ov"></canvas>
        <div class="scope-readout" id="scope-ro" aria-hidden="true"></div>
        <div class="range-chip" id="range-chip"></div>
      </div>
    </div>
  </section>`;
}

/* memory axis scale in "nice" binary units */
function memScale(maxMb) {
  if (!(maxMb > 0)) return { max: 1, step: 1 };
  if (maxMb >= 1024) { const g = maxMb / 1024; const st = niceStep(g, 4.5); return { max: Math.ceil((g * 1.03) / st) * st * 1024, step: st * 1024 }; }
  const st = niceStep(maxMb, 4.5); return { max: Math.ceil((maxMb * 1.03) / st) * st, step: st };
}

function mountScope(M) {
  const host = $("#scope"); if (!host) return null;
  const base = $("#scope-base"), ov = $("#scope-ov"), ro = $("#scope-ro"), chip = $("#range-chip");
  const S = { sweep: REDUCED || STILL ? 1 : 0, hoverX: null, drag: null, range: null, line: null, G: null, B: null };
  const T = M.tMax || M.elapsed || 1;

  function geom() {
    const w = host.clientWidth, h = host.clientHeight; const narrow = w < 640;
    const x0 = narrow ? 14 : 112, x1 = w - (narrow ? 14 : 70), pw = x1 - x0;
    const short = h < 220;
    const hasPhase = M.phases && M.phases.length > 0 && !short;
    const thrN = M.threads.length > 1 && h >= 240 ? Math.min(M.threads.length, 12) : 0;
    const axisH = 20; let y = 6; const ch = {};
    if (hasPhase) { ch.phase = { y0: y, y1: y + 20 }; y += 30; }
    const cpuH = !M.tl ? 0 : M.hasMem ? (short ? 34 : h < 280 ? 44 : 58) : 0;
    const taskH = M.isAsync && M.tl ? (short ? 0 : 34) : 0;
    const thrH = thrN ? thrN * 5 + (thrN - 1) * 2 : 0;
    const fixed = (cpuH ? cpuH + 12 : 0) + (taskH ? taskH + 12 : 0) + (thrH ? thrH + 12 : 0) + axisH + 4;
    const flexH = h - y - fixed;
    if (M.hasMem) { ch.mem = { y0: y, y1: y + flexH }; y += flexH + 12; }
    if (M.tl) { const hh = cpuH || flexH; ch.cpu = { y0: y, y1: y + hh }; y += hh + 12; }
    if (taskH) { ch.task = { y0: y, y1: y + taskH }; y += taskH + 12; }
    if (thrH) { ch.thr = { y0: y, y1: y + thrH, n: thrN }; y += thrH + 12; }
    ch.axis = { y0: h - axisH, y1: h };
    return { w, h, x0, x1, pw, narrow, ch };
  }
  const tx = (t) => S.G.x0 + (t / T) * S.G.pw;
  const xt = (x) => clamp(((x - S.G.x0) / S.G.pw) * T, 0, T);

  function memAt(t) {
    const sm = M.samples; if (!sm.length) return null;
    const ns = t * 1e9; if (ns <= sm[0][0]) return sm[0][1]; if (ns >= sm[sm.length - 1][0]) return sm[sm.length - 1][1];
    let lo = 0, hi = sm.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sm[m][0] <= ns) lo = m; else hi = m; }
    const a = sm[lo], b = sm[hi]; return a[1] + ((b[1] - a[1]) * (ns - a[0])) / Math.max(1, b[0] - a[0]);
  }

  function drawBase() {
    const G = (S.G = geom()); const ctx = fitCanvas(base, G.w, G.h); fitCanvas(ov, G.w, G.h);
    const col = { fg: tok("--fg"), fg2: tok("--fg-2"), fg3: tok("--fg-3"), line: tok("--line"), lineS: tok("--line-strong"), grid: tok("--grid"), sunk: tok("--sunken"), surf: tok("--surface"), mem: tok("--mem-py"), py: tok("--cpu-py"), nat: tok("--cpu-native"), sys: tok("--cpu-sys"), aw: tok("--async") };
    const glow = tok("--glow") === "1";
    ctx.clearRect(0, 0, G.w, G.h);
    const nb = Math.max(20, Math.floor(G.pw / (G.narrow ? 3 : 4)));
    if (!S.B || S.B.nb !== nb) S.B = bucketize(M, nb, 0, T);
    const B = S.B;
    // time grid + axis
    const step = niceStep(T, Math.max(3, Math.floor(G.pw / 110)));
    ctx.font = "11px " + tok("--font-ui"); ctx.textBaseline = "middle";
    const top = G.ch.phase ? G.ch.phase.y1 + 4 : 4;
    for (let t = 0; t <= T + 1e-9; t += step) {
      const x = crisp(tx(t));
      ctx.strokeStyle = col.grid; ctx.lineWidth = 1 / DPR() * DPR(); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, G.ch.axis.y0 - 2); ctx.stroke();
      ctx.fillStyle = col.fg3; ctx.textAlign = t === 0 ? "left" : "center";
      const lbl = fTick(t, step); const lw = ctx.measureText(lbl).width;
      if (tx(t) + lw / 2 < G.x1 + 4 || t === 0) ctx.fillText(lbl, t === 0 ? G.x0 : tx(t), G.ch.axis.y0 + 10);
    }
    // channel labels
    const label = (txt, sub, c, y) => {
      if (G.narrow) return;
      ctx.textAlign = "left"; ctx.fillStyle = col.fg3; ctx.font = "600 10.5px " + tok("--font-ui");
      ctx.save(); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(26, y + 7, 3, 0, 7); ctx.fill(); ctx.restore();
      ctx.fillStyle = col.fg2; ctx.fillText(txt.split("").join(String.fromCharCode(8202)), 36, y + 7);
      if (sub) { ctx.font = "11px " + tok("--font-ui"); ctx.fillStyle = col.fg3; ctx.fillText(sub, 36, y + 22); }
    };
    const clipX = G.x0 + G.pw * S.sweep;
    // ---- memory channel
    if (G.ch.mem) {
      const { y0, y1 } = G.ch.mem; const sc = memScale(M.maxFp); const ty = (mb) => y1 - (mb / sc.max) * (y1 - y0);
      label("MEMORY", "footprint", col.mem, y0);
      ctx.font = "11px " + tok("--font-ui"); ctx.textAlign = "left";
      const every = (y1 - y0) / (sc.max / sc.step) < (G.narrow ? 34 : 22) ? 2 : 1; let ti = 0;
      for (let v = 0; v <= sc.max + 1e-9; v += sc.step, ti++) {
        const y = crisp(ty(v)); ctx.strokeStyle = v === 0 ? col.lineS : col.grid; ctx.beginPath(); ctx.moveTo(G.x0, y); ctx.lineTo(G.x1, y); ctx.stroke();
        if (ti % every) continue;
        ctx.fillStyle = col.fg3; if (v > 0 || (!G.narrow && !G.ch.cpu)) ctx.fillText(fMemTick(v, sc.step), G.narrow ? G.x1 - 44 : G.x1 + 8, y + (G.narrow ? -7 : 0));
      }
      if (M.samples.length) {
        ctx.save(); ctx.beginPath(); ctx.rect(G.x0 - 2, 0, clipX - G.x0 + 2, G.h); ctx.clip();
        const pts = M.samples.map((s) => [tx(s[0] / 1e9), ty(s[1])]);
        const path = new Path2D(); path.moveTo(pts[0][0], y1); for (const p of pts) path.lineTo(p[0], p[1]); path.lineTo(pts[pts.length - 1][0], y1); path.closePath();
        const gr = ctx.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, hexA(col.mem, glow ? 0.30 : 0.20)); gr.addColorStop(1, hexA(col.mem, 0.02));
        ctx.fillStyle = gr; ctx.fill(path);
        const ln = new Path2D(); ln.moveTo(pts[0][0], pts[0][1]); for (const p of pts) ln.lineTo(p[0], p[1]);
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        if (glow) { ctx.save(); ctx.shadowColor = hexA(col.mem, 0.7); ctx.shadowBlur = 10; ctx.strokeStyle = hexA(col.mem, 0.6); ctx.lineWidth = 2; ctx.stroke(ln); ctx.restore(); }
        ctx.strokeStyle = col.mem; ctx.lineWidth = 1.5; ctx.stroke(ln);
        ctx.restore();
        // peak marker
        if (M.peakS && tx(M.peakT) <= clipX + 1) {
          const px = tx(M.peakT), py = ty(M.peakS[1]);
          ctx.fillStyle = col.surf; ctx.strokeStyle = col.mem; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 4, 0, 7); ctx.fill(); ctx.stroke();
          if (glow) { ctx.save(); ctx.shadowColor = col.mem; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(px, py, 2, 0, 7); ctx.fillStyle = col.mem; ctx.fill(); ctx.restore(); }
          const txt = `peak ${fMem(M.maxFp)}`, sub = `at ${fTime(M.peakT)}${M.peakLine ? " · " + M.peakLine.F.base + ":" + M.peakLine.no : ""}`;
          ctx.font = "600 12px " + tok("--font-ui"); const w1 = ctx.measureText(txt).width; ctx.font = "11px " + tok("--font-ui"); const w2 = ctx.measureText(sub).width;
          const bw = Math.max(w1, w2) + 16; let bx = px - bw - 10; if (bx < G.x0 + 4) bx = px + 10; const by = clamp(py - 6, y0, y1 - 40);
          ctx.fillStyle = hexA(col.surf, 0.88); ctx.strokeStyle = col.line; ctx.lineWidth = 1; roundRect(ctx, bx, by, bw, 36, 6); ctx.fill(); ctx.stroke();
          ctx.textAlign = "left"; ctx.fillStyle = col.fg; ctx.font = "600 12px " + tok("--font-ui"); ctx.fillText(txt, bx + 8, by + 12);
          ctx.fillStyle = col.fg3; ctx.font = "11px " + tok("--font-ui"); ctx.fillText(sub, bx + 8, by + 26);
        }
      }
    }
    // ---- CPU channel: stacked bars of sampled threads by leaf frame kind
    if (G.ch.cpu) {
      const { y0, y1 } = G.ch.cpu; let mx = 0;
      for (let k = 0; k < B.nb; k++) mx = Math.max(mx, B.py[k] + B.nat[k] + B.wait[k]);
      const ymax = Math.max(1, Math.ceil(mx - 0.05)); const ty = (v) => y1 - (v / ymax) * (y1 - y0);
      label("CPU", ymax > 1 ? `threads (0–${ymax})` : "activity", col.py, y0);
      ctx.strokeStyle = col.lineS; ctx.beginPath(); ctx.moveTo(G.x0, crisp(y1)); ctx.lineTo(G.x1, crisp(y1)); ctx.stroke();
      if (ymax > 1) { ctx.strokeStyle = col.grid; for (let v = 1; v < ymax; v++) { const y = crisp(ty(v)); ctx.beginPath(); ctx.moveTo(G.x0, y); ctx.lineTo(G.x1, y); ctx.stroke(); } }
      if (!G.narrow) { ctx.fillStyle = col.fg3; ctx.font = "11px " + tok("--font-ui"); ctx.textAlign = "left"; ctx.fillText(String(ymax), G.x1 + 8, y0 + 4); }
      const bw = G.pw / B.nb; const wpat = hatch(ctx, col.sys, col.surf);
      for (let k = 0; k < B.nb; k++) {
        const x = G.x0 + k * bw; if (x > clipX) break;
        let yb = y1; const w = Math.max(1, bw - 1);
        const seg = (v, f) => { if (v <= 0.002) return; const hh = (v / ymax) * (y1 - y0); ctx.fillStyle = f; ctx.fillRect(x, yb - hh, w, hh); yb -= hh; };
        seg(B.py[k], col.py); seg(B.nat[k], col.nat); seg(B.wait[k], wpat);
      }
    }
    if (G.ch.task) {
      const { y0, y1 } = G.ch.task; let mx = 0; for (let k = 0; k < B.nb; k++) mx = Math.max(mx, B.aw[k]);
      const ymax = Math.max(1, Math.ceil(mx)); label("TASKS", `suspended (0–${ymax})`, col.aw, y0);
      ctx.strokeStyle = col.lineS; ctx.beginPath(); ctx.moveTo(G.x0, crisp(y1)); ctx.lineTo(G.x1, crisp(y1)); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(G.x0, 0, clipX - G.x0, G.h); ctx.clip();
      const bw = G.pw / B.nb; const pth = new Path2D(); pth.moveTo(G.x0, y1);
      for (let k = 0; k < B.nb; k++) { const y = y1 - (B.aw[k] / ymax) * (y1 - y0); pth.lineTo(G.x0 + k * bw, y); pth.lineTo(G.x0 + (k + 1) * bw, y); }
      pth.lineTo(G.x1, y1); pth.closePath(); ctx.fillStyle = hexA(col.aw, 0.22); ctx.fill(pth); ctx.strokeStyle = col.aw; ctx.lineWidth = 1.25; ctx.stroke(pth); ctx.restore();
    }
    if (G.ch.thr) {
      const { y0, n } = G.ch.thr; label("THREADS", `${M.threads.length} sampled`, col.fg2, y0 - 3);
      const bw = G.pw / B.nb;
      for (let i = 0; i < n; i++) {
        const y = y0 + i * 7; ctx.fillStyle = col.sunk; ctx.fillRect(G.x0, y, G.pw, 5);
        const arr = B.thr[i];
        for (let k = 0; k < B.nb; k++) { const x = G.x0 + k * bw; if (x > clipX) break; const v = clamp(arr[k], 0, 1); if (v < 0.02) continue; ctx.fillStyle = hexA(col.fg2, 0.18 + 0.72 * v); ctx.fillRect(x, y, Math.max(1, bw - 0.5), 5); }
      }
    }
    // ---- phase ribbon
    if (G.ch.phase) {
      const { y0, y1 } = G.ch.phase; label("PHASE", "", col.fg3, y0 + 3);
      ctx.font = "11.5px " + tok("--font-mono"); ctx.textBaseline = "middle";
      const P = M.phases; const a0 = tx(P[0].t0), b0 = Math.min(tx(P[P.length - 1].t1), clipX);
      // one continuous ribbon, partitioned at phase boundaries (gaps = time in no phase)
      ctx.save(); ctx.beginPath(); ctx.rect(G.x0 - 1, 0, Math.max(0, clipX - G.x0 + 1), G.h); ctx.clip();
      for (let i = 0; i < P.length; i++) {
        const ph = P[i]; const a = tx(ph.t0), b = tx(ph.t1);
        const joinPrev = i > 0 && ph.t0 - P[i - 1].t1 < T * 0.004, joinNext = i < P.length - 1 && P[i + 1].t0 - ph.t1 < T * 0.004;
        ctx.fillStyle = col.sunk; ctx.fillRect(a, y0, Math.max(1, b - a), y1 - y0);
        ctx.strokeStyle = col.lineS; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(a, crisp(y0)); ctx.lineTo(b, crisp(y0)); ctx.moveTo(a, crisp(y1) - 1); ctx.lineTo(b, crisp(y1) - 1);
        ctx.moveTo(crisp(a), y0); ctx.lineTo(crisp(a), y1); if (!joinNext) { ctx.moveTo(crisp(b), y0); ctx.lineTo(crisp(b), y1); }
        ctx.stroke(); void joinPrev;
        const avail = b - a - 14; const full = ctx.measureText(ph.label).width;
        if (avail >= full || avail >= 90) {
          ctx.save(); ctx.beginPath(); ctx.rect(a + 4, y0, Math.max(0, b - a - 8), y1 - y0); ctx.clip();
          ctx.fillStyle = col.fg2; ctx.textAlign = "left"; ctx.fillText(truncMid(ctx, ph.label, avail), a + 7, (y0 + y1) / 2 + 0.5); ctx.restore();
        }
      }
      ctx.restore(); void a0; void b0;
    }
  }

  function drawOverlay() {
    const G = S.G; if (!G) return; const ctx = ov.getContext("2d"); ctx.setTransform(DPR(), 0, 0, DPR(), 0, 0); ctx.clearRect(0, 0, G.w, G.h);
    const fg = tok("--fg"), mem = tok("--mem-py"), surf = tok("--surface"), glow = tok("--glow") === "1";
    const bottom = G.ch.axis.y0 - 2, top = G.ch.phase ? G.ch.phase.y1 + 4 : 4;
    // sweep beam
    if (S.sweep < 1) {
      const x = G.x0 + G.pw * S.sweep; const gr = ctx.createLinearGradient(x - 60, 0, x, 0);
      gr.addColorStop(0, hexA(mem, 0)); gr.addColorStop(1, hexA(mem, glow ? 0.16 : 0.08)); ctx.fillStyle = gr; ctx.fillRect(x - 60, top, 60, bottom - top);
      ctx.strokeStyle = hexA(fg, 0.85); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(crisp(x), top); ctx.lineTo(crisp(x), bottom); ctx.stroke();
    }
    // selected range / brush
    const rg = S.drag || S.range;
    if (rg) {
      const a = tx(Math.min(rg[0], rg[1])), b = tx(Math.max(rg[0], rg[1]));
      ctx.fillStyle = hexA(fg, 0.06); ctx.fillRect(a, top, b - a, bottom - top);
      ctx.strokeStyle = hexA(fg, 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(crisp(a), top); ctx.lineTo(crisp(a), bottom); ctx.moveTo(crisp(b), top); ctx.lineTo(crisp(b), bottom); ctx.stroke();
    }
    // linked line overlay: when this line ran / allocated
    if (S.line) {
      const L = S.line; const p0 = +M.p.start_time_perf || 0;
      if (G.ch.cpu && L.cs.length) {
        const { y1 } = G.ch.cpu; ctx.strokeStyle = hexA(fg, 0.9); ctx.lineWidth = 1; ctx.beginPath();
        for (const v of L.cs) { const x = crisp(tx(v - p0)); ctx.moveTo(x, y1 + 2); ctx.lineTo(x, y1 + 8); }
        ctx.stroke();
      }
      if (G.ch.mem && L.ms.length) {
        const sc = memScale(M.maxFp); const { y0, y1 } = G.ch.mem;
        for (const s of L.ms) { const x = tx(s[0] / 1e9), y = y1 - (s[1] / sc.max) * (y1 - y0); ctx.fillStyle = surf; ctx.strokeStyle = fg; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); ctx.stroke(); }
      }
      ctx.font = "600 11.5px " + tok("--font-ui"); ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const msg = `${L.F.base}:${L.no} — ${L.cs.length ? `${fInt(L.cs.length)} main-thread samples` : "no main-thread samples"}${L.ms.length ? ` · ${L.ms.length} allocation events` : ""}`;
      if (!G.narrow) { const yy = (G.ch.mem || G.ch.cpu).y0 + 9; const mw = ctx.measureText(msg).width; ctx.fillStyle = hexA(surf, 0.85); ctx.fillRect(G.x0 + 4, yy - 9, mw + 12, 18); ctx.fillStyle = fg; ctx.fillText(msg, G.x0 + 10, yy); }
    }
    // hover cursor
    if (S.hoverX != null && !S.drag) {
      const x = clamp(S.hoverX, G.x0, G.x1); ctx.strokeStyle = hexA(fg, 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(crisp(x), top); ctx.lineTo(crisp(x), bottom); ctx.stroke();
      const t = xt(x);
      if (G.ch.mem && M.samples.length) { const sc = memScale(M.maxFp); const v = memAt(t); const { y0, y1 } = G.ch.mem; const y = y1 - (v / sc.max) * (y1 - y0); ctx.fillStyle = mem; ctx.strokeStyle = surf; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.stroke(); ctx.fill(); }
    }
  }

  function readout(x) {
    const G = S.G; if (x == null || x < G.x0 - 4 || x > G.x1 + 4) { ro.classList.remove("on"); return; }
    const t = xt(x); const B = S.B; const k = clamp(Math.floor(((x - G.x0) / G.pw) * B.nb), 0, B.nb - 1);
    let h = `<div class="t"><span>${fTime(t)}</span><span style="color:var(--fg-3);font-weight:500">of ${fTime(T)}</span></div>`;
    if (M.hasMem && M.samples.length) h += `<div class="r"><i class="sw" style="background:var(--mem-py)"></i>Memory footprint<b>${fMem(memAt(t))}</b></div>`;
    if (M.tl) {
      const tot = B.py[k] + B.nat[k] + B.wait[k];
      h += `<div class="r"><i class="sw" style="background:var(--cpu-py)"></i>Sampled threads<b>${tot.toFixed(1)}</b></div>`;
      if (tot > 0.01) h += `<div class="r" style="color:var(--fg-3)">&nbsp;&nbsp;&nbsp;Python ${fPct((B.py[k] / tot) * 100)} · native ${fPct((B.nat[k] / tot) * 100)} · wait ${fPct((B.wait[k] / tot) * 100)}</div>`;
      if (M.isAsync) h += `<div class="r"><i class="sw" style="background:var(--async)"></i>Suspended tasks<b>${B.aw[k].toFixed(1)}</b></div>`;
      const ph = (M.phases || []).find((p) => t >= p.t0 && t <= p.t1);
      if (ph) h += `<div class="r" style="color:var(--fg-3)"><span>Phase</span><b style="font-family:var(--font-mono);font-weight:500;font-size:11.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ph.label)}</b></div>`;
      const st = stackAt(M, t, 0);
      if (st && st.pyLeaf) { const f = st.pyLeaf; const L = lookupLine(M, f.filename_or_module, f.line); h += `<div class="stk">main ▸ ${esc(frameName(f))}() · ${esc(basename(f.filename_or_module))}:${f.line}${L ? `<br>${esc(L.text.trim().slice(0, 60))}` : ""}</div>`; }
    }
    ro.innerHTML = h; ro.classList.add("on");
    const rw = ro.offsetWidth; let left = x + 14; if (left + rw > G.w - 8) left = x - rw - 14; ro.style.left = Math.max(8, left) + "px";
  }

  // interactions
  const pos = (e) => { const r = host.getBoundingClientRect(); return e.clientX - r.left; };
  host.addEventListener("pointermove", (e) => {
    const x = pos(e); S.hoverX = x;
    if (S.drag) S.drag[1] = xt(x);
    readout(S.drag ? null : x); drawOverlay();
  });
  host.addEventListener("pointerleave", () => { S.hoverX = null; ro.classList.remove("on"); drawOverlay(); });
  host.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; const x = pos(e); if (x < S.G.x0 || x > S.G.x1) return; S.drag = [xt(x), xt(x)]; host.setPointerCapture(e.pointerId); });
  host.addEventListener("pointerup", (e) => {
    if (!S.drag) return; const [a, b] = S.drag; S.drag = null;
    if (Math.abs(tx(b) - tx(a)) > 6) setRange([Math.min(a, b), Math.max(a, b)]);
    else {
      // click: jump to the phase under the pointer, if any
      const G = S.G, y = e.clientY - host.getBoundingClientRect().top;
      if (G.ch.phase && y >= G.ch.phase.y0 && y <= G.ch.phase.y1) { const t = xt(pos(e)); const ph = M.phases.find((p) => t >= p.t0 && t <= p.t1); if (ph && ph.file) APP.jumpTo(ph.file, ph.no); }
    }
    drawOverlay();
  });
  function setRange(r) {
    S.range = r;
    if (r) {
      chip.innerHTML = `<span class="num">Selected <b>${fTime(r[0])} – ${fTime(r[1])}</b></span><button class="btn ghost" data-a="tl" style="height:24px">Open in timeline ${icon("chevd")}</button><button class="btn ghost icon" data-a="clr" style="height:24px;width:24px" aria-label="Clear selection">${icon("x")}</button>`;
      chip.classList.add("on");
    } else chip.classList.remove("on");
    APP.timeline && APP.timeline.setDomain(r || [0, T]);
    drawOverlay();
  }
  chip.addEventListener("pointerdown", (e) => e.stopPropagation());
  chip.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.a === "clr") setRange(null); else $("#timeline").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); });

  function play() {
    if (REDUCED || STILL) { S.sweep = 1; drawBase(); drawOverlay(); return; }
    const t0 = now() + 140, dur = 900;
    const f = () => { const t = clamp((now() - t0) / dur, 0, 1); S.sweep = t <= 0 ? 0 : 1 - Math.pow(1 - t, 2.2); drawBase(); drawOverlay(); if (t < 1) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }
  drawBase(); drawOverlay();
  return {
    play, redraw() { S.B = null; drawBase(); drawOverlay(); },
    setLine(L) { S.line = L; drawOverlay(); },
    get sweep() { return S.sweep; }, set sweep(v) { S.sweep = v; drawBase(); drawOverlay(); },
    clearRange() { setRange(null); },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
