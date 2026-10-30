// Ribbon minimap (DESIGN.md §4.8.9, graft from C): one canvas row per source line of the
// current file (≤ 4 px, aggregated by max below a device pixel): memory peak marks on the
// left, a neutral code silhouette in the middle, heat bars of the heat metric on the right,
// global hotspot rank pins (de-overlapped, with leaders), and the viewport window. It is a
// `role=slider`: click or drag scrubs (instant), arrows step through hot lines, Enter jumps.
import { createCanvasPair, crisp, roundRect, setFont, uiFont, type CanvasPair } from "../../core/canvas";
import { h } from "../../core/dom";
import { fmtMem, fmtPct, fmtUtil } from "../../core/format";
import type { FileM, LineM } from "../../model/model";
import type { HeatMetric } from "../../model/thresholds";
import type { ViewContext } from "../app";

export interface MinimapPin {
  rank: number;
  line: number;
}

export interface Minimap {
  /** The sticky ribbon element (append into the ribbon column). */
  el: HTMLElement;
  setFile(file: FileM, metric: HeatMetric): void;
  setMetric(metric: HeatMetric): void;
  setPins(pins: MinimapPin[]): void;
  /** First and last visible line numbers (null hides the window: ranked mode). */
  setWindow(first: number | null, last: number | null): void;
  redraw(): void;
  destroy(): void;
}

export interface MinimapOptions {
  ctx: ViewContext;
  inset(): number;
  onScrub(line: number): void;
  onActivate(line: number): void;
}

const PIN_R = 7;
const PIN_STEP = 15;
const MAX_ROW = 4;

/** Layout of one ribbon row geometry: line number → y (CSS px) for a height and line count. */
export function ribbonScale(nLines: number, height: number): { row: number; content: number } {
  if (nLines <= 0 || height <= 0) return { row: 0, content: 0 };
  const row = Math.min(MAX_ROW, height / nLines);
  return { row, content: row * nLines };
}

/**
 * De-overlap pins (§4.8.9): sorted by y, each pin moves down to at least `step` below the
 * previous one; if the stack runs past `max`, it is pushed back up from the bottom.
 */
export function placePins(ys: readonly number[], step: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const p of order) {
    const y = Math.max(min, p.y, prev + step);
    out[p.i] = y;
    prev = y;
  }
  // Push back from the bottom when the stack overflows.
  let limit = max;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k].i;
    if (out[i] > limit) out[i] = limit;
    limit = out[i] - step;
  }
  return out;
}

function heatValue(l: LineM, metric: HeatMetric): number {
  return metric === "time" ? l.total : metric === "mem" ? l.peak : metric === "gpu" ? l.gpu : l.await;
}

export function createMinimap(o: MinimapOptions): Minimap {
  const { ctx } = o;
  const host = h("div", { class: "cv-ribbon-canvas" });
  const el = h(
    "div",
    {
      class: "cv-ribbon",
      role: "slider",
      tabindex: "0",
      "aria-orientation": "vertical",
      "aria-valuemin": "1",
    },
    host,
  );
  const pair: CanvasPair = createCanvasPair(host);
  let file: FileM | null = null;
  let metric: HeatMetric = "time";
  let pins: MinimapPin[] = [];
  let win: [number, number] | null = null;
  let cursor: number | null = null;
  let hoverLine: number | null = null;
  let nLines = 0;
  let hot: number[] = [];
  let width = 0;
  let height = 0;
  let dragging = false;
  let destroyed = false;

  const lineAtY = (y: number): number => {
    const { row } = ribbonScale(nLines, height);
    if (!(row > 0)) return 1;
    return Math.max(1, Math.min(nLines, Math.floor(y / row) + 1));
  };

  const resize = () => {
    const r = host.getBoundingClientRect();
    width = Math.round(r.width);
    height = Math.round(r.height);
    if (width > 0 && height > 0) pair.resize(width, height);
  };

  const fileMax = (): number => {
    if (!file) return 0;
    let mx = 0;
    for (const l of file.lines) mx = Math.max(mx, heatValue(l, metric));
    return mx;
  };

  function drawBase(): void {
    const ctx2 = pair.b;
    ctx2.save();
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
    ctx2.clearRect(0, 0, pair.base.width, pair.base.height);
    ctx2.restore();
    if (!file || width <= 0 || height <= 0) return;
    const t = ctx.theme.tokens();
    const dpr = pair.dpr;
    const { row } = ribbonScale(nLines, height);
    const narrow = width < 52;
    const memW = narrow ? 8 : 10;
    const silX = memW + 2;
    const silW = narrow ? 6 : 8;
    const heatX = silX + silW + 2;
    const heatW = Math.max(8, width - heatX - 2);
    const maxHeat = fileMax();
    const maxPeak = file.peak;
    // Aggregate per device-pixel row (by max).
    const rows = Math.max(1, Math.ceil(height * dpr));
    const agg = new Map<number, { l: LineM; v: number; peak: number; sil: [number, number] }>();
    for (const l of file.lines) {
      const y0 = (l.no - 1) * row;
      const bucket = Math.min(rows - 1, Math.floor(y0 * dpr));
      const v = heatValue(l, metric);
      const text = l.text.replace(/\t/g, "    ");
      const indent = text.length - text.trimStart().length;
      const len = text.trimEnd().length;
      const sil: [number, number] = [indent, len];
      const cur = agg.get(bucket);
      if (!cur) agg.set(bucket, { l, v, peak: l.peak, sil });
      else {
        if (v > cur.v) {
          cur.v = v;
          cur.l = l;
        }
        if (l.peak > cur.peak) cur.peak = l.peak;
        if (sil[1] > cur.sil[1]) cur.sil = [Math.min(cur.sil[0], sil[0]), sil[1]];
      }
    }
    const rowH = Math.max(row, 1 / dpr);
    const g = pair.b;
    for (const [bucket, a] of agg) {
      const y = bucket / dpr;
      const hh = Math.max(rowH - (row >= 3 ? 1 : 0), 1 / dpr);
      // Code silhouette: indent + length mapped onto silW (80 columns = full width).
      if (a.sil[1] > 0) {
        const x0 = silX + Math.min(silW - 1, (a.sil[0] / 80) * silW);
        const x1 = silX + Math.min(silW, (a.sil[1] / 80) * silW);
        g.fillStyle = t["line-strong"];
        g.fillRect(x0, y, Math.max(1, x1 - x0), hh);
      }
      // Memory peak marks (left), right-aligned toward the silhouette.
      if (a.peak > 0 && maxPeak > 0) {
        const w = Math.max(1.5, (a.peak / maxPeak) * memW);
        g.fillStyle = t["mem-py"];
        g.fillRect(memW - w, y, w, hh);
      }
      // Heat bars (right): Python / native / system for time.
      if (a.v > 0 && maxHeat > 0) {
        const total = Math.max(1.5, (a.v / maxHeat) * heatW);
        const l = a.l;
        if (metric === "time" && l.total > 0) {
          let x = heatX;
          const parts: [number, string][] = [
            [l.py, t["cpu-py"]],
            [l.nat, t["cpu-native"]],
            [l.sys, t["cpu-sys"]],
          ];
          for (const [v, c] of parts) {
            if (v <= 0) continue;
            const w = (v / l.total) * total;
            g.fillStyle = c;
            g.fillRect(x, y, w, hh);
            x += w;
          }
        } else if (metric === "mem") {
          const pyW = total * Math.min(1, Math.max(0, l.pyFrac));
          g.fillStyle = t["mem-py"];
          g.fillRect(heatX, y, pyW, hh);
          g.fillStyle = t["mem-native"];
          g.fillRect(heatX + pyW, y, total - pyW, hh);
        } else {
          g.fillStyle = t[metric === "gpu" ? "gpu" : "async"];
          g.fillRect(heatX, y, total, hh);
        }
      }
    }
    drawPins(g, t, row);
  }

  function drawPins(g: CanvasRenderingContext2D, t: Readonly<Record<string, string>>, row: number): void {
    if (!file || !pins.length) return;
    const own = pins.filter((p) => file!.byNo.has(p.line) || p.line <= nLines);
    if (!own.length) return;
    const ys = own.map((p) => (p.line - 0.5) * row);
    const placed = placePins(ys, PIN_STEP, PIN_R + 1, height - PIN_R - 1);
    const cx = width - PIN_R - 1;
    setFont(g, uiFont(ctx.theme, 9.5, 600));
    g.textAlign = "center";
    g.textBaseline = "middle";
    own.forEach((p, i) => {
      const y = placed[i];
      const y0 = ys[i];
      if (Math.abs(y - y0) > 1) {
        g.strokeStyle = t["fg-2"];
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx - PIN_R - 4, crisp(y0, pair.dpr));
        g.lineTo(cx - PIN_R + 1, crisp(y0, pair.dpr));
        g.lineTo(cx - PIN_R + 1, y);
        g.stroke();
      }
      g.beginPath();
      g.arc(cx, y, PIN_R, 0, Math.PI * 2);
      g.fillStyle = t["fg"];
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = t["surface"];
      g.stroke();
      g.fillStyle = t["surface"];
      g.fillText(String(p.rank), cx, y + 0.5);
    });
  }

  function drawOverlay(): void {
    pair.clearOverlay();
    if (!file || width <= 0 || height <= 0) return;
    const t = ctx.theme.tokens();
    const g = pair.o;
    const { row } = ribbonScale(nLines, height);
    if (win) {
      const y0 = (win[0] - 1) * row;
      const y1 = Math.max(y0 + 4, win[1] * row);
      g.save();
      roundRect(g, 0.5, Math.max(0.5, y0 - 1), width - 1, Math.min(height - 1, y1 - y0 + 2), 3);
      g.globalAlpha = 0.1;
      g.fillStyle = t["fg"];
      g.fill();
      g.globalAlpha = 0.4;
      g.lineWidth = 1;
      g.strokeStyle = t["fg"];
      g.stroke();
      g.restore();
    }
    for (const [line, alphaV] of [
      [hoverLine, 0.55],
      [cursor, 1],
    ] as [number | null, number][]) {
      if (line === null) continue;
      const y = crisp((line - 0.5) * row, pair.dpr);
      g.save();
      g.globalAlpha = alphaV;
      g.fillStyle = t["fg"];
      g.fillRect(0, y - 0.5, width, 1);
      g.restore();
    }
  }

  const describe = (line: number): string => {
    if (!file) return "";
    const l = file.byNo.get(line);
    let v = "no samples";
    if (l) {
      if (metric === "time") v = l.total > 0 ? `${fmtPct(l.total)} of run` : "no CPU time";
      else if (metric === "mem") v = l.peak > 0 ? `peak ${fmtMem(l.peak)}` : "no allocations";
      else if (metric === "gpu") v = l.gpu >= 1 ? `GPU ${fmtUtil(l.gpu)} busy` : "no GPU activity";
      else v = l.await >= 1 ? `${fmtPct(l.await)} of await` : "no await time";
    }
    return `${file.base} line ${line}, ${v}`;
  };

  const syncAria = () => {
    if (!file) return;
    el.setAttribute("aria-label", `Hot lines in ${file.base}`);
    el.setAttribute("aria-valuemax", String(nLines));
    const now = cursor ?? (win ? Math.round((win[0] + win[1]) / 2) : 1);
    el.setAttribute("aria-valuenow", String(now));
    el.setAttribute("aria-valuetext", describe(now));
  };

  const redraw = () => {
    if (destroyed) return;
    resize();
    drawBase();
    drawOverlay();
  };

  // Height = the visible code viewport, capped by the table (CSS sets the sticky top).
  const ro = new ResizeObserver(() => requestAnimationFrame(redraw));
  ro.observe(host);

  // ── Pointer: scrub and hover ─────────────────────────────────────────────
  const yOf = (ev: PointerEvent) => ev.clientY - host.getBoundingClientRect().top;
  el.addEventListener("pointerdown", (ev) => {
    if (!file || ev.button !== 0) return;
    dragging = true;
    el.setPointerCapture(ev.pointerId);
    cursor = lineAtY(yOf(ev));
    o.onScrub(cursor);
    syncAria();
    drawOverlay();
    ev.preventDefault();
    el.focus({ preventScroll: true });
  });
  el.addEventListener("pointermove", (ev) => {
    if (!file) return;
    const line = lineAtY(yOf(ev));
    if (dragging) {
      if (line !== cursor) {
        cursor = line;
        o.onScrub(line);
        syncAria();
      }
    }
    hoverLine = line;
    drawOverlay();
    const l = file.byNo.get(line);
    const rows: [string, string][] = [];
    if (l) {
      if (l.total > 0) rows.push(["time", `${fmtPct(l.total)} of run`]);
      if (l.peak > 0) rows.push(["peak", fmtMem(l.peak)]);
      if (ctx.model.caps.gpu && l.gpu >= 1) rows.push(["GPU", `${fmtUtil(l.gpu)} busy`]);
      if (ctx.model.caps.async && l.await >= 1) rows.push(["await", fmtPct(l.await)]);
    }
    ctx.tooltip.show(
      { x: ev.clientX, y: ev.clientY },
      { title: `${file.base}:${line}`, code: l?.text.trim() || undefined, rows: rows.length ? rows : [["", l ? "no samples" : "not in this profile"]], hint: "Click or drag to scroll there" },
    );
  });
  const endDrag = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      el.releasePointerCapture(ev.pointerId);
    } catch {
      // already released
    }
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("pointerleave", () => {
    hoverLine = null;
    drawOverlay();
    ctx.tooltip.hide();
  });

  // ── Keyboard: hot lines, pages, ends ─────────────────────────────────────
  el.addEventListener("keydown", (ev) => {
    if (!file || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const from = cursor ?? (win ? Math.round((win[0] + win[1]) / 2) : 1);
    let next: number | null = null;
    switch (ev.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = hot.find((n) => n > from) ?? hot[hot.length - 1] ?? null;
        break;
      case "ArrowUp":
      case "ArrowLeft": {
        for (let i = hot.length - 1; i >= 0; i--) {
          if (hot[i] < from) {
            next = hot[i];
            break;
          }
        }
        if (next === null) next = hot[0] ?? null;
        break;
      }
      case "PageDown":
        next = Math.min(nLines, from + Math.max(1, Math.round(nLines * 0.1)));
        break;
      case "PageUp":
        next = Math.max(1, from - Math.max(1, Math.round(nLines * 0.1)));
        break;
      case "Home":
        next = 1;
        break;
      case "End":
        next = nLines;
        break;
      case "Enter":
        ev.preventDefault();
        o.onActivate(from);
        return;
      case "Escape":
        if (cursor !== null) {
          cursor = null;
          drawOverlay();
          syncAria();
        }
        return;
      default:
        return;
    }
    ev.preventDefault();
    if (next === null) return;
    cursor = next;
    o.onScrub(next);
    syncAria();
    drawOverlay();
    ctx.announce.polite(describe(next));
  });
  el.addEventListener("blur", () => {
    if (cursor !== null) {
      cursor = null;
      drawOverlay();
    }
  });

  const offTheme = ctx.bus.on("theme:changed", () => requestAnimationFrame(redraw));

  return {
    el,
    setFile(f, met) {
      file = f;
      metric = met;
      nLines = f.lines.length ? Math.max(f.lines[f.lines.length - 1].no, f.lines.length) : 0;
      hot = f.lines.filter((l) => l.cls === "data").map((l) => l.no);
      cursor = null;
      win = null;
      syncAria();
      redraw();
    },
    setMetric(met) {
      if (met === metric) return;
      metric = met;
      drawBase();
      syncAria();
    },
    setPins(p) {
      pins = p;
      drawBase();
    },
    setWindow(first, last) {
      const next: [number, number] | null = first !== null && last !== null ? [first, last] : null;
      if (next?.[0] === win?.[0] && next?.[1] === win?.[1]) return;
      win = next;
      if (!dragging) syncAria();
      drawOverlay();
    },
    redraw,
    destroy() {
      destroyed = true;
      ro.disconnect();
      offTheme();
      pair.destroy();
      el.remove();
    },
  };
}
