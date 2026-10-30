/**
 * One formatter per quantity (DESIGN.md §4.0.2). Every number on screen goes
 * through one of these, so units, decimals and edge cases are identical in
 * every view. Locale is fixed to en-US-style output for determinism: no
 * `toLocaleString`, no Intl (hosts differ).
 *
 * Conventions: a no-break space (U+00A0, `NBSP`) joins number and unit, so
 * prose never wraps between "128" and "MiB" (round 1 review); `%` attaches
 * directly. Axis tick labels (never wrapped) keep a plain space.
 * Memory inputs are MiB (Scalene's `*_mb` fields) and print in binary units.
 */

/** No-break space between a number and its unit (§4.0.2). */
export const NBSP = "\u00a0";

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── Percentages ─────────────────────────────────────────────────────────────

/** Share in percent (0–100): "21.4%", "<0.1%", "100%", "—" for missing. */
export function fmtPct(v: number | null | undefined): string {
  if (!finite(v)) return "—";
  if (v <= 0) return "0%";
  if (v < 0.05) return "<0.1%";
  if (v >= 99.95 && v < 100.05) return "100%";
  return `${v.toFixed(1)}%`;
}

/** Device utilisation (0–100). Same rules as `fmtPct`, one decimal. */
export function fmtUtil(v: number | null | undefined): string {
  return fmtPct(v);
}

// ── Time ────────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Duration in seconds: "368 ms", "2.64 s", "54.1 s", "3 m 47 s", "1 h 05 m".
 * Thresholds are applied to the rounded value, so 9.996 s prints "10.0 s",
 * never "10.00 s".
 */
export function fmtTime(s: number | null | undefined): string {
  if (!finite(s)) return "—";
  if (s <= 0) return `0${NBSP}s`;
  if (s < 0.0009995) return `${Math.max(1, Math.round(s * 1e6))}${NBSP}µs`;
  if (s < 0.00995) return `${(s * 1e3).toFixed(1)}${NBSP}ms`;
  if (s < 0.9995) return `${Math.round(s * 1e3)}${NBSP}ms`;
  if (s < 9.995) return `${s.toFixed(2)}${NBSP}s`;
  if (s < 59.95) return `${s.toFixed(1)}${NBSP}s`;
  const whole = Math.round(s);
  if (whole < 3600) {
    return `${Math.floor(whole / 60)}${NBSP}m${NBSP}${pad2(whole % 60)}${NBSP}s`;
  }
  const minutes = Math.round(s / 60);
  return `${Math.floor(minutes / 60)}${NBSP}h${NBSP}${pad2(minutes % 60)}${NBSP}m`;
}

/** "12.0 s – 18.5 s" (en dash between plain spaces, so a range may wrap at the dash only). */
export function fmtRange(a: number, b: number): string {
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}

// ── Memory ──────────────────────────────────────────────────────────────────

const KIB_PER_MIB = 1024;
const MIB_PER_GIB = 1024;
const MIB_PER_TIB = 1024 * 1024;

function gibDecimals(g: number): number {
  return g < 9.995 ? 2 : g < 99.95 ? 1 : 0;
}

/**
 * Memory in MiB → binary units: "3.11 GiB", "98.3 MiB", "742 MiB", "22 KiB",
 * "944 B". Unit and decimals are chosen on the rounded value, so 1023.99 MiB
 * prints "1.00 GiB" and 0.99995 MiB prints "1.00 MiB".
 */
export function fmtMem(mib: number | null | undefined): string {
  if (!finite(mib)) return "—";
  if (mib <= 0) return `0${NBSP}B`;
  if (mib >= 1023.5 * MIB_PER_GIB) return `${(mib / MIB_PER_TIB).toFixed(2)}${NBSP}TiB`;
  if (mib >= 1023.5) {
    const g = mib / MIB_PER_GIB;
    return `${g.toFixed(gibDecimals(g))}${NBSP}GiB`;
  }
  if (mib >= 99.95) return `${Math.round(mib)}${NBSP}MiB`;
  if (mib >= 9.995) return `${mib.toFixed(1)}${NBSP}MiB`;
  const kib = mib * KIB_PER_MIB;
  if (kib >= 1023.5) return `${mib.toFixed(2)}${NBSP}MiB`;
  const bytes = kib * 1024;
  if (bytes >= 1023.5) return `${Math.round(kib)}${NBSP}KiB`;
  const b = Math.round(bytes);
  return b >= 1 ? `${b}${NBSP}B` : `<1${NBSP}B`;
}

/** Rate in MiB/s, adaptive unit: "5.71 MiB/s", "288 KiB/s". */
export function fmtRate(mibPerS: number | null | undefined): string {
  if (!finite(mibPerS)) return "—";
  return `${fmtMem(mibPerS)}/s`;
}

// ── Counts, dates, locations ────────────────────────────────────────────────

/** Integer with thousands separators: "5,901". */
export function fmtCount(n: number | null | undefined): string {
  if (!finite(n)) return "—";
  const r = Math.round(n);
  const sign = r < 0 ? "-" : "";
  const digits = String(Math.abs(r));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Epoch seconds → "Oct 27, 2026, 14:22" (local time, 24 h). */
export function fmtDate(epochSec: number | null | undefined): string {
  if (!finite(epochSec)) return "";
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Invisible format characters that can reorder or hide text: bidi embeddings, overrides and
 * isolates (U+202A–U+202E, U+2066–U+2069), marks (U+200E/F, U+061C) and zero-width
 * characters (U+200B–U+200D, U+2060–U+2064, U+FEFF). "Trojan Source" uses them.
 */
export const CONTROL_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** "U+202E" for a control character. */
export function codepointLabel(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * A label (file name, location, function) with every invisible control shown as a visible
 * escape "⟨U+202E⟩", so a right-to-left override cannot reverse "RTL-override.py:21" into
 * "12:yp.edirrevo-LTR" (round 1). Display only: lookups keep the raw name.
 */
export function visibleControls(s: string): string {
  CONTROL_RE.lastIndex = 0;
  return CONTROL_RE.test(s) ? s.replace(CONTROL_RE, (ch) => `⟨${codepointLabel(ch)}⟩`) : s;
}

/** Last path component; Jupyter keys ("[12]", "<exec_3>") stay verbatim; controls made visible. */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return visibleControls(i < 0 ? path : path.slice(i + 1));
}

/** Directory part including the trailing separator ("" when there is none); controls made visible. */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? "" : visibleControls(path.slice(0, i + 1));
}

/** "train.py:173" (the full path belongs in the tooltip). */
export function fmtLoc(file: string, line: number): string {
  return `${basename(file)}:${line}`;
}

/**
 * Split a formatted value into number and unit: "3.11 GiB" → ["3.11", "GiB"].
 * Compound values ("3 m 47 s") stay whole: ["3 m 47 s", ""].
 */
export function splitUnit(s: string): [string, string] {
  const m = /^([<>]?[\d.,]+)\s*(\D*)$/.exec(s);
  return m ? [m[1], m[2]] : [s, ""];
}

// ── Axis ticks (upstream names; DESIGN.md §4.0.2, §7.5) ────────────────────

/** Minimum spacing between tick labels in CSS px. */
export const TICK_SPACING_PX = 80;

/** Round `raw` up to the next 1 / 2 / 5 × 10^k. */
export function niceCeil(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const decade = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / decade;
  // Guard against log10 rounding (e.g. 1000 → 999.9999 / 100).
  const factor = normalized <= 1 + 1e-9 ? 1 : normalized <= 2 + 1e-9 ? 2 : normalized <= 5 + 1e-9 ? 5 : 10;
  return factor * decade;
}

/**
 * Upstream `pickNiceTickInterval`: a 1/2/5 × 10^k step so that at most
 * `max(2, floor(px / 80))` ticks fit. Unit-agnostic (seconds or MiB).
 * Returns 0 for non-positive input.
 */
export function pickNiceTickInterval(total: number, pixelWidth: number): number {
  if (!(total > 0) || !(pixelWidth > 0)) return 0;
  const maxTicks = Math.max(2, Math.floor(pixelWidth / TICK_SPACING_PX));
  return niceCeil(total / maxTicks);
}

/**
 * Upstream `formatTimelineTickLabel`: "0"; ≥ 1 s → decimals from the step
 * (0/1/2/3) + " s"; < 1 s → milliseconds (0 or 2 decimals) + " ms".
 */
export function formatTimelineTickLabel(sec: number, stepSec: number): string {
  if (sec === 0) return "0";
  if (sec >= 1) {
    const digits = stepSec >= 1 ? 0 : stepSec >= 0.1 ? 1 : stepSec >= 0.01 ? 2 : 3;
    return `${sec.toFixed(digits)} s`;
  }
  const digits = stepSec >= 0.001 ? 0 : 2;
  return `${(sec * 1000).toFixed(digits)} ms`;
}

/** Decimals that print every multiple of `step` exactly (0–3): 0.2 → 1, 0.05 → 2, 2 → 0. */
function stepDigits(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  for (let d = 0; d < 3; d++) {
    const x = step * Math.pow(10, d);
    if (Math.abs(x - Math.round(x)) < 1e-6 * Math.max(1, x)) return d;
  }
  return 3;
}

/** Display unit of a memory axis whose largest value is `maxMiB` (§4.0.2). */
export function memAxisUnit(maxMiB: number): { mib: number; name: "GiB" | "MiB" | "KiB" } {
  return maxMiB >= MIB_PER_GIB ? { mib: MIB_PER_GIB, name: "GiB" } : maxMiB >= 1 ? { mib: 1, name: "MiB" } : { mib: 1 / KIB_PER_MIB, name: "KiB" };
}

/**
 * Upstream `formatMemoryTickLabel` with binary unit names: "0"; the unit is
 * the **axis** unit — GiB when `maxMiB` ≥ 1024, MiB when ≥ 1, else KiB — so one
 * axis never mixes units ("0, 0.2 GiB, 0.4 GiB …", not "205 MiB … 1.0 GiB");
 * decimals come from the step in that unit. Without `maxMiB` (upstream's
 * two-argument call) the value itself picks the unit.
 */
export function formatMemoryTickLabel(mib: number, stepMiB: number, maxMiB?: number): string {
  if (mib === 0) return "0";
  const unit = memAxisUnit(maxMiB !== undefined && maxMiB > 0 && Number.isFinite(maxMiB) ? maxMiB : mib);
  return `${(mib / unit.mib).toFixed(stepDigits(stepMiB / unit.mib))} ${unit.name}`;
}

/**
 * Memory axis step: 1/2/5 × 10^k **in the display unit** of `maxMiB`
 * (KiB below 1 MiB, MiB below 1 GiB, else GiB), returned in MiB, so ticks
 * land on round binary values (1 GiB, 2 GiB, 512 MiB …).
 */
export function niceMemStep(maxMiB: number, maxTicks: number): number {
  if (!(maxMiB > 0) || !Number.isFinite(maxMiB)) return 0;
  const unit = memAxisUnit(maxMiB).mib;
  const ticks = Math.max(1, Math.floor(maxTicks));
  return niceCeil(maxMiB / unit / ticks) * unit;
}
