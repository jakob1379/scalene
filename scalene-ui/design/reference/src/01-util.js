/* ---------- utilities, formatters, icons ---------- */
const D = document;
const $ = (s, r = D) => r.querySelector(s);
const $$ = (s, r = D) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rmq = matchMedia("(prefers-reduced-motion: reduce)");
let REDUCED = rmq.matches || /[?&]reduced/.test(location.search);
if (rmq.addEventListener) rmq.addEventListener("change", (e) => { REDUCED = e.matches; });
const STILL = /[?&]still/.test(location.search); // screenshot helper: skip entry motion
const tok = (name) => getComputedStyle(D.documentElement).getPropertyValue(name).trim();
const DPR = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));
const now = () => performance.now();
const easeOut = (t) => 1 - Math.pow(1 - t, 4); // ~ cubic-bezier(.22,1,.36,1)
const easeStd = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) * 0.35 + (1 - Math.pow(1 - t, 3)) * 0.65;
const basename = (p) => String(p).split(/[\\/]/).pop();
const dirname = (p) => { const s = String(p).split(/[\\/]/); s.pop(); return s.join("/"); };

/* One formatter per quantity (concept.md §6). */
function fPct(v) {
  if (v == null || !isFinite(v)) return "—";
  if (v <= 0) return "0%";
  if (v < 0.05) return "<0.1%";
  if (v > 99.95 && v < 100.05) return "100%";
  return v.toFixed(1) + "%";
}
function fTime(s) {
  if (s == null || !isFinite(s)) return "—";
  if (s <= 0) return "0 s";
  if (s < 1e-3) return (s * 1e6).toFixed(0) + " µs";
  if (s < 0.01) return (s * 1e3).toFixed(1) + " ms";
  if (s < 0.9995) return (s * 1e3).toFixed(0) + " ms";
  if (s < 9.995) return s.toFixed(2) + " s";
  if (s < 59.95) return s.toFixed(1) + " s";
  if (s < 3600) { let m = Math.floor(s / 60), r = Math.round(s - m * 60); if (r === 60) { m++; r = 0; } return m + " m " + String(r).padStart(2, "0") + " s"; }
  const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
  return h + " h " + String(m).padStart(2, "0") + " m";
}
function fMem(mb) { // input in MiB (Scalene's *_mb fields are MiB)
  if (mb == null || !isFinite(mb)) return "—";
  if (mb <= 0) return "0 B";
  if (mb >= 1048576) return (mb / 1048576).toFixed(2) + " TiB";
  if (mb >= 1024) { const g = mb / 1024; return g.toFixed(g >= 100 ? 0 : g >= 10 ? 1 : 2) + " GiB"; }
  if (mb >= 100) return mb.toFixed(0) + " MiB";
  if (mb >= 10) return mb.toFixed(1) + " MiB";
  if (mb >= 1) return mb.toFixed(2) + " MiB";
  if (mb * 1024 >= 1) return (mb * 1024).toFixed(0) + " KiB";
  return Math.round(mb * 1048576) + " B";
}
const fRate = (mbs) => fMem(mbs) + "/s";
const fInt = (n) => Math.round(n).toLocaleString("en-US");
const splitUnit = (s) => { const m = /^([<>]?[\d.,]+)\s*(.*)$/.exec(s); return m ? [m[1], m[2]] : [s, ""]; };

/* nice ticks (1-2-5) — same algorithm family as upstream pickNiceTickInterval */
function niceStep(range, maxTicks) {
  if (!(range > 0)) return 0;
  const raw = range / Math.max(1, maxTicks);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function fTick(sec, step) {
  if (sec === 0) return "0";
  if (step >= 60 && sec >= 60) { const m = sec / 60; return (Number.isInteger(m) ? m : m.toFixed(1)) + " m"; }
  if (sec >= 1 || step >= 1) { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3; return sec.toFixed(d) + " s"; }
  return (sec * 1000).toFixed(step >= 0.001 ? 0 : 2) + " ms";
}
function fMemTick(mb, step) {
  if (mb === 0) return "0";
  if (mb >= 1024) { const d = step >= 1024 ? 0 : step >= 102.4 ? 1 : 2; return (mb / 1024).toFixed(d) + " GiB"; }
  if (mb >= 1) { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2; return mb.toFixed(d) + " MiB"; }
  return (mb * 1024).toFixed(step * 1024 >= 1 ? 0 : 1) + " KiB";
}

/* inline SVG icon set (16px, 1.5 stroke) */
const ICONS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  spark: '<path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6Z"/><path d="M13 1.8v2.4M11.8 3h2.4"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13.5 9.6A5.5 5.5 0 0 1 6.4 2.5a5.5 5.5 0 1 0 7.1 7.1Z"/>',
  upload: '<path d="M8 10.5V2.5M5 5.5l3-3 3 3"/><path d="M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/>',
  chev: '<path d="M6 4l4 4-4 4"/>',
  chevd: '<path d="M4 6l4 4 4-4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  jump: '<path d="M6 3.5H3.5v9h9V10"/><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5"/>',
  flame: '<path d="M8 14.5c-2.8 0-4.5-1.9-4.5-4.3 0-2.6 2.1-3.7 2.6-6.7 1.4.9 2 2.2 2.1 3.4.6-.5.9-1.3.9-2.1 1.6 1.2 3.4 3.1 3.4 5.4 0 2.4-1.7 4.3-4.5 4.3Z"/>',
  lanes: '<path d="M2 3.5h7M2 8h12M2 12.5h9"/>',
  mem: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"/>',
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  leak: '<path d="M2 12.5 6 8.5l2.5 2.5L14 5.5"/><path d="M10.5 5.5H14V9"/>',
  gpu: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><circle cx="10.5" cy="8" r="2"/><path d="M4 7h2.5M4 9h2.5"/>',
  sync: '<path d="M13 5.5A5 5 0 0 0 3.6 4.4M3 10.5a5 5 0 0 0 9.4 1.1"/><path d="M13.5 2.5v3h-3M2.5 13.5v-3h3"/>',
  peak: '<path d="M1.5 13.5h13"/><path d="M2.5 11 6 7l2.5 2L13 3"/><circle cx="13" cy="3" r="1"/>',
  cpu: '<rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  wait: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  minus: '<path d="M3.5 8h9"/>', plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  reset: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/>',
  file: '<path d="M4 1.5h5.5L12.5 4.5v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"/><path d="M9.5 1.5v3h3"/>',
  fn: '<path d="M10.5 2.5c-1.8 0-2.5.9-2.8 2.7L6.3 12c-.3 1.6-1 2-2.3 2"/><path d="M4.5 6.5h6"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  link: '<path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6M9 7a3 3 0 0 0-4.2 0l-2 2A3 3 0 0 0 7 13.2l.6-.6"/>',
  info: '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.8v.1"/>',
};
const icon = (n, cls = "") => `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[n] || ""}</svg>`;

/* canvas helper: size a canvas to its CSS box at device pixel ratio */
function fitCanvas(cv, w, h) {
  const r = DPR();
  const W = Math.max(1, Math.round(w * r)), H = Math.max(1, Math.round(h * r));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  cv.style.height = h + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return ctx;
}
const crisp = (x) => Math.round(x * DPR()) / DPR() + 0.5 / DPR();
function hexA(hex, a) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function mixHex(a, b, t) { // t = weight of a
  const pa = parseInt(a.replace("#", ""), 16), pb = parseInt(b.replace("#", ""), 16);
  const ch = (s) => Math.round((((pa >> s) & 255) * t + ((pb >> s) & 255) * (1 - t)));
  return "#" + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("");
}
let hatchCache = new Map();
function hatch(ctx, color, bg) {
  const k = color + bg;
  if (hatchCache.has(k)) return hatchCache.get(k);
  const c = D.createElement("canvas"); const r = DPR();
  c.width = c.height = Math.round(6 * r);
  const x = c.getContext("2d"); x.scale(r, r);
  x.fillStyle = mixHex(color, bg, 0.5); x.fillRect(0, 0, 6, 6);
  x.strokeStyle = color; x.lineWidth = 2;
  x.beginPath(); x.moveTo(-1, 7); x.lineTo(7, -1); x.moveTo(-1, 1); x.lineTo(1, -1); x.moveTo(5, 7); x.lineTo(7, 5); x.stroke();
  const p = ctx.createPattern(c, "repeat");
  if (p && p.setTransform) p.setTransform(new DOMMatrix().scale(1 / r));
  hatchCache.set(k, p);
  return p;
}
function truncMid(ctx, s, w) {
  if (ctx.measureText(s).width <= w) return s;
  if (w < 14) return "";
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + "…").width <= w) lo = m; else hi = m - 1; }
  return lo > 0 ? s.slice(0, lo) + "…" : "";
}

/* count-up keeping final formatting (unit and decimals) */
function countUp(el, finalText, dur = 700, delay = 0) {
  const m = /^([<>]?)([\d,]*\.?\d+)(.*)$/.exec(finalText);
  if (!m || REDUCED || STILL) { el.textContent = finalText; return; }
  const target = parseFloat(m[2].replace(/,/g, "")); const dec = (m[2].split(".")[1] || "").length; const comma = m[2].includes(",");
  const t0 = now() + delay;
  el.setAttribute("aria-label", finalText);
  const step = () => {
    const t = clamp((now() - t0) / dur, 0, 1); const v = target * easeOut(t);
    let s = v.toFixed(dec); if (comma) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    el.textContent = m[1] + s + m[3];
    if (t < 1) requestAnimationFrame(step); else el.textContent = finalText;
  };
  el.textContent = m[1] + (0).toFixed(dec) + m[3];
  requestAnimationFrame(step);
}

/* lightweight tween runner (cancels the previous tween of the same key) */
const tweens = new Map();
function tween(key, dur, fn, ease = easeStd, done) {
  const prev = tweens.get(key); if (prev) prev.cancel = true;
  const st = { cancel: false }; tweens.set(key, st);
  if (REDUCED || dur <= 0) { fn(1); done && done(); return; }
  const t0 = now();
  const f = () => { if (st.cancel) return; const t = clamp((now() - t0) / dur, 0, 1); fn(ease(t)); if (t < 1) requestAnimationFrame(f); else { tweens.delete(key); done && done(); } };
  requestAnimationFrame(f);
}

/* minimal, calm Python highlighter (per line) */
const PY_KW = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" "));
const PY_BI = new Set("print len range int float str list dict set tuple object super self cls isinstance enumerate zip map filter sum min max abs open sorted any all next iter type getattr setattr hasattr".split(" "));
function hiPy(line) {
  let out = "", i = 0; const n = line.length;
  const re = /(#.*$)|([rbuRBUfF]{0,2}(?:"""|'''|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?))|(@[\w.]+)|(\b\d[\d_]*\.?\d*(?:[eE][-+]?\d+)?j?\b|\b0[xob][\da-fA-F_]+\b)|([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(i, m.index)); i = re.lastIndex;
    if (m[1]) out += `<span class="tk-com">${esc(m[1])}</span>`;
    else if (m[2]) {
      let s = m[2];
      if (s.endsWith('"""') || s.endsWith("'''")) { // triple quote: highlight to the end of line or closing
        const q = s.slice(-3); const close = line.indexOf(q, re.lastIndex);
        if (close >= 0) { s = line.slice(m.index, close + 3); re.lastIndex = i = close + 3; } else { s = line.slice(m.index); re.lastIndex = i = n; }
      }
      out += `<span class="tk-str">${esc(s)}</span>`;
    } else if (m[3]) out += `<span class="tk-dec">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="tk-num">${esc(m[4])}</span>`;
    else if (m[5]) out += PY_KW.has(m[5]) ? `<span class="tk-kw">${m[5]}</span>` : PY_BI.has(m[5]) ? `<span class="tk-bi">${m[5]}</span>` : m[5];
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + esc(line.slice(i));
}
/* upstream stringLines(): lines inside/opening/closing a triple-quoted string */
function stringLines(texts) {
  const res = new Array(texts.length).fill(false); let open = null;
  for (let i = 0; i < texts.length; i++) {
    const s = texts[i]; const startIn = open !== null;
    for (let j = 0; j < s.length - 2; j++) {
      const t = s.substr(j, 3);
      if (t === '"""' || t === "'''") { if (open === null) { open = t; j += 2; } else if (open === t) { open = null; j += 2; } }
    }
    res[i] = startIn || open !== null;
  }
  return res;
}
