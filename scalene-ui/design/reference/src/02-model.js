/* ---------- profile normalisation + derived model ---------- */
const unesc = (s) => String(s == null ? "" : s).replace(/\\u(003[cCeE]|0026)/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function mkLine(r, F) {
  const py = +r.n_cpu_percent_python || 0, c = +r.n_cpu_percent_c || 0, sys = +r.n_sys_percent || 0;
  const no = r.lineno;
  const L = {
    F, no, text: unesc(r.line).replace(/\r?\n$/, ""), py, c, sys, total: py + c + sys,
    peak: +(r.n_peak_mb != null ? r.n_peak_mb : r.n_growth_mb) || 0, avg: +r.n_avg_mb || 0, pyFrac: +r.n_python_fraction || 0,
    usage: +r.n_usage_fraction || 0, copy: +r.n_copy_mb_s || 0, malloc: +r.n_malloc_mb || 0, mallocs: +r.n_mallocs || 0,
    ms: Array.isArray(r.memory_samples) ? r.memory_samples : [],
    gpu: +r.n_gpu_percent || 0, gpuPeak: +r.n_gpu_peak_memory_mb || 0, gpuAvg: +r.n_gpu_avg_memory_mb || 0,
    aw: +r.n_async_await_percent || 0, cMean: +r.n_async_concurrency_mean || 0, cPeak: +r.n_async_concurrency_peak || 0,
    tasks: r.async_task_names || [], coro: !!r.is_coroutine, core: +r.n_core_utilization || 0,
    cs: Array.isArray(r.cpu_samples_list) ? r.cpu_samples_list : [],
    rs: r.start_region_line != null ? r.start_region_line : no, re: r.end_region_line != null ? r.end_region_line : no,
    fs: r.start_function_line || 0, fe: r.end_function_line || 0,
    os: r.start_outermost_loop, oe: r.end_outermost_loop,
    nrt: +r.nrt_time_ms || 0, nrtPct: +r.nrt_percent || 0, nc: +r.nc_time_ms || 0,
    overlap: r.cpu_samples_nc_overlap_percent,
  };
  L.hasMemData = L.avg + L.peak + L.ms.length + (L.usage >= 0.01 ? 1 : 0) > 0;
  return L;
}

function buildModel(p) {
  const M = { p };
  M.empty = !p || JSON.stringify(p) === "{}";
  if (M.empty) return M;
  M.elapsed = +p.elapsed_time_sec || 0;
  M.hasMem = !!p.memory;
  M.hasGpu = !!p.gpu;
  M.isAsync = !!p.async_profile;
  M.gpuName = p.gpu_device || "GPU";
  M.maxFp = +p.max_footprint_mb || 0;
  M.program = p.program || "";
  M.args = Array.isArray(p.args) ? p.args.slice(1) : [];
  const entries = Object.entries(p.files || {});
  let maxAlloc = 0;
  M.hasNeuron = false;
  for (const [, fd] of entries) for (const l of fd.lines || []) {
    maxAlloc += +l.n_malloc_mb || 0;
    if ((+l.nc_time_ms || 0) > 0 || (+l.nrt_time_ms || 0) > 0 || (+l.nrt_percent || 0) > 0) M.hasNeuron = true;
  }
  M.showGpu = M.hasGpu && !M.hasNeuron;
  entries.sort((a, b) => (+b[1].percent_cpu_time || 0) - (+a[1].percent_cpu_time || 0));
  M.files = []; M.hidden = []; M.lines = []; M.fns = [];
  M.cpu = { py: 0, c: 0, sys: 0 };
  let idx = 0;
  for (const [name, fd] of entries) {
    idx++;
    const F = { name, idx, pct: +fd.percent_cpu_time || 0, base: basename(name), dir: dirname(name), lines: [], byNo: new Map(), fns: [], imports: fd.imports || [], leaks: fd.leaks || {} };
    F.py = F.c = F.sys = F.maxPeak = F.nrt = F.nc = 0; F.peakLine = null;
    for (const r of fd.lines || []) {
      const L = mkLine(r, F); F.lines.push(L); F.byNo.set(L.no, L);
      F.py += L.py; F.c += L.c; F.sys += L.sys; F.nrt += L.nrt; F.nc += L.nc;
      if (L.peak > F.maxPeak) { F.maxPeak = L.peak; F.peakLine = L; }
      const lk = F.leaks[String(L.no)]; if (lk) L.leak = { p: +lk.likelihood || 0, v: +lk.velocity_mb_s || 0 };
    }
    F.lines.sort((a, b) => a.no - b.no);
    F.total = F.py + F.c + F.sys;
    M.cpu.py += F.py; M.cpu.c += F.c; M.cpu.sys += F.sys;
    for (const r of fd.functions || []) {
      const fn = mkLine(r, F); fn.name = String(r.line || "").trim(); fn.isFn = true; F.fns.push(fn);
    }
    F.fns.sort((a, b) => a.no - b.no);
    // docstring / triple-quoted string styling
    const docs = stringLines(F.lines.map((l) => l.text)); F.lines.forEach((l, i) => (l.doc = docs[i]));
    F.excluded = F.pct < 1.0 && F.maxPeak < 0.01 * maxAlloc;
    (F.excluded ? M.hidden : M.files).push(F);
    deriveFile(M, F);
  }
  M.cpu.total = M.cpu.py + M.cpu.c + M.cpu.sys;
  M.unattributed = Math.max(0, 100 - M.cpu.total);
  for (const F of M.files) { for (const L of F.lines) M.lines.push(L); for (const fn of F.fns) M.fns.push(fn); }
  M.byTime = M.lines.filter((l) => l.total > 0).sort((a, b) => b.total - a.total);
  M.byMem = M.lines.filter((l) => l.peak > 0).sort((a, b) => b.peak - a.peak || b.malloc - a.malloc);
  M.fnByTime = M.fns.filter((f) => f.total > 0).sort((a, b) => b.total - a.total);
  M.fnByMem = M.fns.filter((f) => f.peak > 0).sort((a, b) => b.peak - a.peak);
  M.maxLineTotal = M.byTime.length ? M.byTime[0].total : 1;
  M.maxLinePeak = M.byMem.length ? M.byMem[0].peak : 1;
  M.leaks = [];
  for (const F of M.files) for (const L of F.lines) if (L.leak) M.leaks.push(L);
  M.leaks.sort((a, b) => b.leak.p - a.leak.p);
  M.gpuPeak = 0; M.gpuMaxUtil = 0; M.gpuMaxLine = null;
  for (const L of M.lines) { if (L.gpuPeak > M.gpuPeak) M.gpuPeak = L.gpuPeak; if (L.gpu > M.gpuMaxUtil && L.total >= 1) { M.gpuMaxUtil = L.gpu; M.gpuMaxLine = L; } }
  M.samples = (p.samples || []).filter((s) => Array.isArray(s) && isFinite(s[0]) && isFinite(s[1])).sort((a, b) => a[0] - b[0]);
  M.tMax = Math.max(M.elapsed, M.samples.length ? M.samples[M.samples.length - 1][0] / 1e9 : 0);
  M.peakT = null;
  for (const s of M.samples) if (M.peakT === null || s[1] > M.peakS[1]) { M.peakT = s[0] / 1e9; M.peakS = s; }
  M.peakLine = null;
  if (p.max_footprint_fname && p.max_footprint_lineno) {
    const F = M.files.concat(M.hidden).find((f) => f.name === p.max_footprint_fname);
    if (F) M.peakLine = F.byNo.get(p.max_footprint_lineno) || null;
  }
  buildTimeline(M);
  return M;
}

/* per-file derived data: visibility predicates, regions, AI availability, function membership */
function deriveFile(M, F) {
  const byNo = F.byNo;
  const regionTotal = (L) => { let t = 0; for (let n = L.rs + 1; n <= L.re; n++) { const x = byNo.get(n); if (x) t += x.total; } return t; };
  const regionMem = (L) => { let t = 0; for (let n = L.rs + 1; n <= L.re; n++) { const x = byNo.get(n); if (x && x.hasMemData) t++; } return t; };
  const profiledFns = new Set();
  const seenRegion = new Set();
  for (const L of F.lines) {
    L.hasGpu = M.showGpu && L.gpu >= 1;
    L.data = L.total > 1.0 || L.hasMemData || L.hasGpu || L.nrt > 0 || L.nc > 0 || (M.isAsync && L.aw >= 1);
    if (L.fs > 0 && (L.total > 1.0 || L.hasMemData || L.hasGpu || L.nrt > 0 || L.nc > 0)) profiledFns.add(L.fs + "," + L.fe);
  }
  for (const L of F.lines) {
    const multi = L.rs !== L.re;
    L.regionTotal = multi ? regionTotal(L) : L.total;
    const key = L.rs + "," + L.re;
    L.regionHead = false;
    if (multi && !seenRegion.has(key)) { seenRegion.add(key); L.regionHead = true; }
    if (L.regionHead && (L.regionTotal >= 1 || regionMem(L) > 0)) L.data = true;
    L.inFn = L.fs > 0 && profiledFns.has(L.fs + "," + L.fe);
    L.aiLine = multi ? L.regionTotal >= 1 : L.total >= 1;
    L.aiRegion = L.aiLine && L.regionHead && L.re - L.rs <= 50 ? [L.rs, L.re] : null;
    // enclosing named function (functions[].lineno is co_firstlineno)
    let best = null;
    if (L.fs > 0) for (const fn of F.fns) if (fn.no <= L.fs && fn.no >= L.fs - 6) best = fn;
    L.fn = best;
  }
  for (const fn of F.fns) { const L = byNo.get(fn.no); if (L) L.fnHead = fn; }
}

/* ---------- stacks + timeline ---------- */
const GC_RE = /(?:\b|_)(?:gc[._]collect|PyGC|_PyGC_|gc_collect_main|gc_collect_region|deallocate|collect_with_callback|subtract_refs|move_unreachable|untrack_tuples|untrack_dicts|deduce_unreachable|delete_garbage|handle_weakrefs|invoke_gc_callback|move_legacy_finalizers?)(?:_|\b)/;
const GIL_NAMES = new Set(["take_gil", "_PyEval_LockGIL", "PyGILState_Ensure"]);
const IO_NAMES = new Set("read write pread pread64 pwrite pwrite64 readv writev recv recvfrom recvmsg send sendto sendmsg select pselect poll ppoll epoll_wait epoll_pwait kevent accept accept4 connect open openat close fsync fdatasync fread fwrite lseek pthread_cond_wait pthread_cond_timedwait __psynch_cvwait _io_FileIO_write".split(" "));
const IO_RE = /^\[await\]|^_{1,2}(read|write|pread|pwrite|recv|send|select|poll|open|close)$|^_io_FileIO_read(all|into)?$|^_io_BufferedReader_read|^_io_BufferedWriter_write/;
const IO_FILE_RE = /\b_io\b|socket\.py|selectors\.py|selector_events\.py|\basyncio\b|subprocess\.py/;
function classifyFrame(f) {
  const n = f.display_name || "";
  if (GC_RE.test(n)) return "gc";
  if (GIL_NAMES.has(n)) return "gil";
  if (IO_NAMES.has(n) || IO_RE.test(n)) return "io";
  if (f.kind === "py" && IO_FILE_RE.test(f.filename_or_module || "")) return "io";
  return null;
}
const frameName = (f) => f.display_name || (f.ip != null ? "0x" + Number(f.ip).toString(16) : "??");
const frameKey = (f) => f.kind + "|" + (f.filename_or_module || "") + "|" + (f.kind === "py" ? f.line : "x") + "|" + (f.display_name || "");

function lookupLine(M, file, no) {
  const F = M.fileByName ? M.fileByName.get(file) : null;
  return F ? F.byNo.get(no) || null : null;
}

function buildTimeline(M) {
  const p = M.p;
  M.fileByName = new Map(); for (const F of M.files.concat(M.hidden)) M.fileByName.set(F.name, F);
  const CS = p.combined_stacks || [];
  M.stacks = CS.map(([frames, hits]) => {
    let gc = false, io = false, gil = false;
    for (const f of frames) { const c = classifyFrame(f); if (c === "gc") gc = true; else if (c === "gil") gil = true; else if (c === "io") io = true; }
    if (gil) io = false;
    const leaf = frames[frames.length - 1] || {};
    const isAwait = /^\[await\]/.test(leaf.display_name || "");
    const pyF = frames.filter((f) => f.kind === "py");
    return { frames, hits: +hits || 0, gc, io, gil, isAwait, leafKind: leaf.kind || "py", pyLeaf: pyF[pyF.length - 1] || null, pyF };
  });
  M.stackHits = M.stacks.reduce((a, s) => a + s.hits, 0);
  const EV = (p.combined_stacks_timeline || []).filter((e) => e && isFinite(e.t_sec) && M.stacks[e.stack_index]);
  M.ev = EV;
  M.threads = [];
  if (!EV.length) { M.tl = null; return; }
  const main = p.main_thread_id == null ? null : p.main_thread_id;
  const tids = new Map();
  for (const e of EV) { const t = e.thread_id == null ? null : e.thread_id; if (!tids.has(t)) tids.set(t, { id: t, n: 0, ev: 0 }); const T = tids.get(t); T.n += e.count || 1; T.ev++; }
  const ids = Array.from(tids.keys()).sort((a, b) => (a === main ? -1 : b === main ? 1 : a === null ? -1 : b === null ? 1 : a - b));
  let w = 0;
  M.threads = ids.map((id, i) => { const T = tids.get(id); T.idx = i; T.main = id === main; T.label = T.main ? "main" : id === null ? "unknown" : "thread " + (++w); return T; });
  const tIndex = new Map(M.threads.map((T) => [T.id, T.idx]));
  // sampling interval: median per-sample gap of consecutive same-thread events
  const lastT = new Map(); const gaps = [];
  for (const e of EV) { const t = e.thread_id == null ? null : e.thread_id; if (lastT.has(t)) { const prev = lastT.get(t); const g = (e.t_sec - prev.t_sec) / (prev.count || 1); if (g > 0) gaps.push(g); } lastT.set(t, e); if (gaps.length > 4000) break; }
  gaps.sort((a, b) => a - b);
  const interval = gaps.length ? clamp(gaps[gaps.length >> 1], 0.0005, 0.2) : 0.01;
  M.interval = interval;
  const n = EV.length;
  const t0 = new Float64Array(n), t1 = new Float64Array(n), si = new Int32Array(n), th = new Int16Array(n), cnt = new Float32Array(n);
  const nextIdx = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const e = EV[i]; const tid = e.thread_id == null ? null : e.thread_id;
    t0[i] = e.t_sec; si[i] = e.stack_index; th[i] = tIndex.get(tid); cnt[i] = e.count || 1;
    const nx = nextIdx.get(tid);
    const nominal = e.t_sec + cnt[i] * interval;
    t1[i] = nx != null ? Math.min(EV[nx].t_sec > e.t_sec ? EV[nx].t_sec : nominal, nominal) : nominal;
    nextIdx.set(tid, i);
  }
  const tEnd = Math.max(M.elapsed, t1[n - 1]);
  M.tMax = Math.max(M.tMax || 0, tEnd);
  M.tl = { t0, t1, si, th, cnt, n };
  // annotation totals (share of samples)
  let gc = 0, io = 0, gil = 0, all = 0, aw = 0;
  for (let i = 0; i < n; i++) { const s = M.stacks[si[i]]; const c = cnt[i]; all += c; if (s.isAwait) aw += c; if (s.gc) gc += c; if (s.io) io += c; if (s.gil) gil += c; }
  M.tlTotals = { gc, io, gil, all, aw };
  // per-thread max depth
  for (const T of M.threads) T.maxDepth = 0;
  for (let i = 0; i < n; i++) { const d = M.stacks[si[i]].frames.length; const T = M.threads[th[i]]; if (d > T.maxDepth) T.maxDepth = d; }
  M.phases = buildPhases(M);
}

/* main-thread "phases": outermost loop or top-level statement the program is in, over time */
function buildPhases(M) {
  const tl = M.tl; if (!tl) return [];
  const mainIdx = M.threads.findIndex((T) => T.main); if (mainIdx < 0) return [];
  const keyCache = new Map();
  const keyOf = (s) => {
    if (keyCache.has(s)) return keyCache.get(s);
    const st = M.stacks[s]; const py = st.pyF; let res = null;
    if (py.length && !st.isAwait) {
      for (let d = 0; d < Math.min(2, py.length) && !res; d++) {
        const L = lookupLine(M, py[d].filename_or_module, py[d].line);
        if (L && L.os != null && L.oe != null && L.oe > L.os && L.no >= L.os && L.no <= L.oe) {
          const H = L.F.byNo.get(L.os); const txt = H ? H.text.trim() : "loop";
          if (/^(for|while|async for)\b/.test(txt)) res = { key: L.F.name + ":" + L.os, label: txt.replace(/:\s*$/, ""), file: L.F, no: L.os };
        }
      }
      if (!res) {
        const f = py[Math.min(1, py.length - 1)];
        const L = lookupLine(M, f.filename_or_module, f.line);
        const label = L ? L.text.trim() : f.display_name + "()";
        res = { key: (f.filename_or_module || "") + ":" + f.line, label, file: L ? L.F : null, no: f.line };
      }
    }
    keyCache.set(s, res); return res;
  };
  const segs = [];
  for (let i = 0; i < tl.n; i++) {
    if (tl.th[i] !== mainIdx) continue;
    const k = keyOf(tl.si[i]); if (!k) continue;
    const last = segs[segs.length - 1];
    if (last && last.key === k.key && tl.t0[i] - last.t1 < M.tMax * 0.004) { last.t1 = Math.max(last.t1, tl.t1[i]); last.n += tl.cnt[i]; }
    else segs.push({ key: k.key, label: k.label, file: k.file, no: k.no, t0: tl.t0[i], t1: tl.t1[i], n: tl.cnt[i] });
  }
  // drop slivers, then re-merge neighbours with identical keys
  const minDur = M.tMax * 0.015;
  const kept = segs.filter((s) => s.t1 - s.t0 >= minDur);
  const out = [];
  for (const s of kept) { const last = out[out.length - 1]; if (last && last.key === s.key) { last.t1 = s.t1; last.n += s.n; } else out.push({ ...s }); }
  return out.slice(0, 24);
}

/* bucketize the timeline for the scope: per-bucket sampled threads by leaf kind + waits */
function bucketize(M, nb, ta, tb) {
  const tl = M.tl; const R = { py: new Float32Array(nb), nat: new Float32Array(nb), wait: new Float32Array(nb), aw: new Float32Array(nb), thr: M.threads.map(() => new Float32Array(nb)), nb, ta, tb };
  if (!tl) return R;
  const span = tb - ta, bw = span / nb, cap = bw / M.interval;
  for (let i = 0; i < tl.n; i++) {
    let a = tl.t0[i], b = tl.t1[i]; if (b <= ta || a >= tb) continue;
    const st = M.stacks[tl.si[i]]; const dur = Math.max(b - a, 1e-9); const c = tl.cnt[i];
    a = Math.max(a, ta); b = Math.min(b, tb);
    let k0 = Math.floor((a - ta) / bw), k1 = Math.min(nb - 1, Math.floor((b - ta) / bw));
    for (let k = k0; k <= k1; k++) {
      const ov = Math.min(b, ta + (k + 1) * bw) - Math.max(a, ta + k * bw); if (ov <= 0) continue;
      const v = (c * ov) / dur / cap;
      if (st.isAwait) { R.aw[k] += v; continue; }
      if (st.io || st.gil) R.wait[k] += v; else if (st.leafKind === "native") R.nat[k] += v; else R.py[k] += v;
      R.thr[tl.th[i]][k] += v;
    }
  }
  return R;
}

/* main-thread stack at time t (binary search over that thread's events) */
function stackAt(M, t, threadIdx = 0) {
  const tl = M.tl; if (!tl) return null;
  if (!M._thrEv) { M._thrEv = M.threads.map(() => []); for (let i = 0; i < tl.n; i++) M._thrEv[tl.th[i]].push(i); }
  const arr = M._thrEv[threadIdx] || []; let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (tl.t0[arr[m]] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  if (best < 0) return null; const i = arr[best];
  if (t > tl.t1[i] + M.interval) return null;
  return M.stacks[tl.si[i]];
}

/* flame tree from [[frames, weight], ...] */
function buildFlame(M, entries, isMem) {
  const root = { name: "all", key: "root", v: 0, ch: new Map(), depth: 0, kind: "root" };
  for (const [frames, w0] of entries) {
    const w = +w0 || 0; if (w <= 0) continue; root.v += w; let node = root;
    for (const f of frames) {
      const k = frameKey(f); let c = node.ch.get(k);
      if (!c) { c = { name: frameName(f), file: f.filename_or_module || "", line: f.line, kind: f.kind, key: k, v: 0, ch: new Map(), depth: node.depth + 1, parent: node, isAwait: /^\[await\]/.test(f.display_name || "") }; node.ch.set(k, c); }
      c.v += w; node = c;
    }
  }
  const flat = []; let maxD = 0;
  (function lay(n, x0) {
    n.x0 = x0; n.x1 = x0 + n.v / (root.v || 1); flat.push(n); if (n.depth > maxD) maxD = n.depth;
    const kids = Array.from(n.ch.values()).sort((a, b) => b.v - a.v); n.kids = kids;
    let x = x0; for (const k of kids) { lay(k, x); x = k.x1; }
    n.self = n.v - kids.reduce((a, k) => a + k.v, 0);
  })(root, 0);
  return { root, flat, maxD, isMem, total: root.v };
}
