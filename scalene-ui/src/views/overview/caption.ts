/**
 * Readout captions that fit (DESIGN.md §4.3.2: "Caption: 12/16, max 2 lines, always states the
 * denominator"; §2.3 md: one caption line; §1.3.7: nothing hides silently).
 *
 * A caption is a list of semantic lines (model `ReadoutSpec.caption`), each a run of phrases
 * separated by " · ". Phrases are inline-blocks, so lines only ever break between whole phrases
 * (never inside a code chip or a ref). `fit()` then gives every shown semantic line one visual
 * line (the last shown line gets any spare rows) and drops the phrases that do not fit, whole and
 * from the end. When the denominator phrase itself does not fit on line 1, the compact
 * denominator (`ReadoutSpec.short`, §4.0.3) takes its place. Dropped text stays reachable: a
 * tooltip on the caption and a visually hidden span carry the full caption.
 */

import type { HeadSeg } from "../../model/headline";
import { h, type Child } from "../../core/dom";

export const PHRASE_SEP = " · ";

/** Split one caption line into phrases at " · " (only inside text segments). */
export function splitPhrases(line: readonly HeadSeg[]): HeadSeg[][] {
  const out: HeadSeg[][] = [[]];
  for (const seg of line) {
    if (seg.t !== "text") {
      out[out.length - 1].push(seg);
      continue;
    }
    const parts = seg.s.split(PHRASE_SEP);
    parts.forEach((p, i) => {
      if (i > 0) out.push([]);
      if (p) out[out.length - 1].push({ t: "text", s: p });
    });
  }
  return out.filter((p) => p.length > 0);
}

/** Plain text of segments (chips and refs as shown). */
export function plainText(segs: readonly HeadSeg[]): string {
  return segs.map((s) => s.s).join("");
}

/**
 * Hyphens between letters become non-breaking (U+2011), so "time-weighted" never splits at the
 * line end. Only used for display text; the model strings are unchanged.
 */
export function noBreakHyphens(s: string): string {
  return s.replace(/([A-Za-z])-(?=[A-Za-z])/g, "$1‑");
}

export interface CaptionPlan {
  /** Visible phrases per semantic line (0 = the line is hidden). */
  visible: number[];
  /** Line 1 shows the compact denominator instead of its phrases. */
  alt: boolean;
}

/**
 * Decide what fits. `endRows[i][k]` is the visual row (0-based, relative to semantic line i's top)
 * on which phrase k of line i ends when everything is shown; `budget` is the number of visual
 * rows for the whole caption. Lines are filled in order, each from its first phrase, dropping
 * whole phrases from the end of a line. While line 1 is plain text it keeps one row per later
 * line in reserve and, if its first phrase needs more than its share, gives way to the compact
 * denominator (`hasAlt`). When line 1 opens with a code chip or ref (the subject the value is
 * about, e.g. "of await time at `await asyncio.sleep(…)`"), it is kept whole first.
 */
export function planCaption(endRows: readonly (readonly number[])[], budget: number, hasAlt: boolean, firstHasSubject = false): CaptionPlan {
  const n = endRows.length;
  const visible = endRows.map(() => 0);
  let alt = false;
  let remaining = Math.max(0, budget);
  for (let i = 0; i < n && remaining > 0; i++) {
    const rows = endRows[i];
    const reserve = i === 0 && !firstHasSubject ? Math.min(n - 1, remaining - 1) : 0;
    const avail = Math.max(1, remaining - reserve);
    const k = rows.findIndex((r) => r >= avail);
    let used = 0;
    if (k === -1) {
      visible[i] = rows.length;
      used = rows.length ? rows[rows.length - 1] + 1 : 0;
    } else if (k > 0) {
      visible[i] = k;
      used = rows[k - 1] + 1;
    } else if (i === 0 && hasAlt) {
      alt = true;
      used = 1;
    }
    remaining -= used;
  }
  return { visible, alt };
}

interface Phrase {
  el: HTMLElement;
  sep: HTMLElement | null;
  text: string;
}

interface Line {
  el: HTMLElement;
  phrases: Phrase[];
}

export interface FitCaption {
  el: HTMLElement;
  /** Re-fit to `budget` visual rows; returns true when something is dropped or replaced. */
  fit(budget: number): boolean;
  /** Full caption text (for the tooltip), or null when nothing is hidden. */
  hiddenText(): string | null;
  fullText: string;
}

/**
 * Build the caption DOM. `render` turns a phrase's segments into nodes (chips and refs become
 * buttons there); `alt` is the compact denominator for line 1.
 */
export function buildCaption(lines: readonly (readonly HeadSeg[])[], alt: string | null, render: (segs: HeadSeg[]) => Child[]): FitCaption {
  const model: Line[] = [];
  const els: HTMLElement[] = [];
  const texts: string[] = [];
  for (const segs of lines) {
    const phrases = splitPhrases(segs);
    const parts: Phrase[] = [];
    const children: Child[] = [];
    phrases.forEach((p, k) => {
      const display = p.map((s): HeadSeg => (s.t === "text" ? { t: "text", s: noBreakHyphens(s.s) } : s));
      const sep = k < phrases.length - 1 ? h("span", { class: "ro-sep", "aria-hidden": "true" }, " ·") : null;
      const el = h("span", { class: "ro-ph" }, render(display), sep);
      parts.push({ el, sep, text: plainText(p) });
      if (k > 0) children.push(" ");
      children.push(el);
    });
    const el = h("span", { class: "ro-cap-line" }, children);
    model.push({ el, phrases: parts });
    els.push(el);
    texts.push(parts.map((p) => p.text).join(PHRASE_SEP));
  }
  const altEl = alt ? h("span", { class: "ro-ph ro-ph-alt", hidden: true }, noBreakHyphens(alt)) : null;
  if (altEl && model[0]) model[0].el.append(altEl);
  const sr = h("span", { class: "visually-hidden" }, "");
  const first = lines.length ? splitPhrases(lines[0])[0] ?? [] : [];
  const firstHasSubject = first.some((seg) => seg.t === "code" || seg.t === "ref");
  const el = h("p", { class: "ro-cap" }, els, sr);
  const fullText = texts.join(PHRASE_SEP);
  let hidden: string[] = [];

  function reset(): void {
    for (const ln of model) {
      ln.el.hidden = false;
      for (const p of ln.phrases) {
        p.el.hidden = false;
        if (p.sep) p.sep.hidden = false;
      }
    }
    if (altEl) altEl.hidden = true;
  }

  return {
    el,
    fullText,
    hiddenText: () => (hidden.length ? fullText : null),
    fit(budget) {
      reset();
      hidden = [];
      if (!model.length || !el.isConnected || el.clientWidth === 0) {
        sr.textContent = "";
        return false;
      }
      // Read everything first (one layout), then write.
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
      const endRows = model.map((ln) => {
        const top = ln.el.getBoundingClientRect().top;
        // Rows are counted by rounding: a chip can make a line box a pixel taller than 16.
        return ln.phrases.map((p) => Math.max(0, Math.round((p.el.getBoundingClientRect().bottom - top) / lh) - 1));
      });
      const plan = planCaption(endRows, budget, Boolean(altEl), firstHasSubject);
      model.forEach((ln, i) => {
        const vis = i === 0 && plan.alt ? 0 : plan.visible[i];
        if (vis === 0 && !(i === 0 && plan.alt)) {
          ln.el.hidden = true;
          hidden.push(texts[i]);
          return;
        }
        ln.phrases.forEach((p, k) => {
          if (k >= vis) {
            p.el.hidden = true;
            hidden.push(p.text);
          }
        });
        if (vis > 0 && ln.phrases[vis - 1]?.sep) (ln.phrases[vis - 1].sep as HTMLElement).hidden = true;
      });
      if (plan.alt && altEl) altEl.hidden = false;
      // A phrase that wrapped to a new row leaves no dangling " ·" at the end of the row above.
      for (const ln of model) {
        if (ln.el.hidden) continue;
        const shown = ln.phrases.filter((p) => !p.el.hidden);
        const tops = shown.map((p) => p.el.getBoundingClientRect().top);
        const cut: HTMLElement[] = [];
        for (let k = 0; k + 1 < shown.length; k++) {
          const sep = shown[k].sep;
          if (sep && !sep.hidden && tops[k + 1] > tops[k] + 2) cut.push(sep);
        }
        for (const sep of cut) sep.hidden = true;
        // Hiding a separator can pull the next phrase back up: then the separator returns.
        if (cut.length) {
          const after = shown.map((p) => p.el.getBoundingClientRect().top);
          for (let k = 0; k + 1 < shown.length; k++) if (shown[k].sep && cut.includes(shown[k].sep as HTMLElement) && after[k + 1] <= after[k] + 2) (shown[k].sep as HTMLElement).hidden = false;
        }
      }
      // Screen readers get the dropped parts right after the visible ones (the alt text is a
      // shortened copy of line 1, so line 1's full text is read instead of it).
      sr.textContent = hidden.length ? ` (${hidden.join(PHRASE_SEP)})` : "";
      if (plan.alt && altEl) altEl.setAttribute("aria-hidden", "true");
      return hidden.length > 0;
    },
  };
}
