/**
 * Headline + meta line (DESIGN.md §4.2). The sentence comes from
 * `model.headline` (segments); this view renders numbers as <strong>, code
 * chips and refs as buttons that jump to the line, and emits `hover:line`
 * on hover/focus so the scope lights up when the line ran.
 */

import type { Source } from "../../core/bus";
import { bindTooltip } from "../../core/tooltip";
import { h, type Child } from "../../core/dom";
import { basename } from "../../core/format";
import type { Target } from "../../core/store";
import { buildMeta, type HeadSeg } from "../../model/headline";
import type { ViewContext } from "../app";

/** Spoken target for aria-labels: "train.py line 173" / "function train in train.py". */
export function spokenTarget(t: Target): string {
  return "line" in t ? `${basename(t.file)} line ${t.line}` : `function ${t.fn} in ${basename(t.file)}`;
}

/**
 * Render a segment list (headline, readout captions, finding sentences).
 * Chips and refs become buttons wired to `nav.jumpTo` and `hover:line`.
 */
export function renderSegments(ctx: ViewContext, segs: readonly HeadSeg[], source: Source, opts: { refClass?: string; chipClass?: string } = {}): Child[] {
  const out: Child[] = [];
  // Punctuation glued to a chip ("(", "),", "…)") stays on the chip's line: the text around a
  // chip is split at its last/first whitespace and the glued parts share a nowrap span.
  const pieces = segs.map((s) => ({ seg: s, text: s.t === "text" ? s.s : "" }));
  for (let i = 0; i < pieces.length; i++) {
    const { seg } = pieces[i];
    if (seg.t === "text") {
      if (pieces[i].text) out.push(pieces[i].text);
      continue;
    }
    if (seg.t === "num") {
      out.push(h("strong", { class: "num" }, seg.s));
      continue;
    }
    const el = seg.t === "code" ? chipButton(ctx, seg, source, opts.chipClass) : refButton(ctx, seg, source, opts.refClass);
    const prev = pieces[i - 1];
    const next = pieces[i + 1];
    let before = "";
    let after = "";
    if (prev && prev.seg.t === "text") {
      const m = /(\S*)$/.exec(prev.text);
      before = m ? m[1] : "";
      if (before) {
        prev.text = prev.text.slice(0, prev.text.length - before.length);
        const last = out[out.length - 1];
        if (typeof last === "string") out[out.length - 1] = prev.text;
        if (!prev.text && typeof last === "string") out.pop();
      }
    }
    if (next && next.seg.t === "text") {
      const m = /^(\S*)/.exec(next.text);
      after = m ? m[1] : "";
      next.text = next.text.slice(after.length);
    }
    out.push(before || after ? h("span", { class: "seg-glue" }, before, el, after) : el);
  }
  return out;
}

function chipButton(ctx: ViewContext, s: Extract<HeadSeg, { t: "code" }>, source: Source, cls?: string): HTMLElement {
  const b = h("button", { type: "button", class: ["chip-code", cls ?? ""], "aria-label": `${s.full} — go to ${spokenTarget(s.target)}` }, s.s);
  wireTarget(ctx, b, s.target, source);
  bindTooltip(ctx.tooltip, b, { code: s.full, hint: `Go to ${spokenTarget(s.target)}` });
  return b;
}

function refButton(ctx: ViewContext, s: Extract<HeadSeg, { t: "ref" }>, source: Source, cls?: string): HTMLElement {
  const b = h("button", { type: "button", class: ["seg-ref", cls ?? ""], "aria-label": `Go to ${spokenTarget(s.target)}` }, s.s);
  wireTarget(ctx, b, s.target, source);
  return b;
}

/** Click → jump (focus lands on the code row, lens open); hover/focus → linked highlight. */
export function wireTarget(ctx: ViewContext, el: HTMLElement, target: Target, source: Source): void {
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void ctx.nav.jumpTo(target, { focus: true, open: true, source });
  });
  const on = () => ctx.bus.emit("hover:line", { target, source });
  const off = () => ctx.bus.emit("hover:line", { target: null, source });
  el.addEventListener("mouseenter", on);
  el.addEventListener("focus", on);
  el.addEventListener("mouseleave", off);
  el.addEventListener("blur", off);
}

export interface HeadlineHandle {
  el: HTMLElement;
  headline: HTMLElement;
  meta: HTMLElement;
  /** Phones and short hosts: the compact sentence where one exists (§2.4.2: ≤ 4 lines on xs). */
  setCompact(on: boolean): void;
  destroy(): void;
}

/**
 * Compact event-loop headline for phones and short hosts (review round 1): "P ran for E.
 * 59.6% is the event loop, mostly waiting; `chip` (21.6%) blocks it." Built from the full
 * sentence's own segments (same numbers, chips and targets); null for every other branch.
 */
export function compactSegments(segs: readonly HeadSeg[]): HeadSeg[] | null {
  const plain = segs.map((x) => x.s).join("");
  const m = /of it is the event loop \(/.exec(plain);
  if (!m) return null;
  const firstStop = segs.findIndex((x) => x.t === "text" && x.s.startsWith("."));
  const loopPct = segs.find((x, i) => i > firstStop && x.t === "num");
  if (firstStop < 0 || !loopPct) return null;
  const out: HeadSeg[] = segs.slice(0, firstStop).map((x) => ({ ...x }));
  const waiting = /mostly waiting/.test(plain) ? "mostly waiting" : "running callbacks";
  out.push({ t: "text", s: ". " }, { ...loopPct }, { t: "text", s: ` is the event loop, ${waiting}` });
  const chips = segs.filter((x) => x.t === "code");
  const busy = chips.length >= 2 ? chips[1] : null;
  const pct = /\((\d[\d.,]*%),/.exec(plain.slice(plain.indexOf("busiest code")));
  if (busy && pct) {
    const blocks = /inside a coroutine/.test(plain);
    out.push({ t: "text", s: blocks ? "; " : "; the busiest code is " }, { ...busy }, { t: "text", s: ` (${pct[1]})${blocks ? " blocks it." : "."}` });
  } else out.push({ t: "text", s: "." });
  return out;
}

export function mountHeadline(ctx: ViewContext): HeadlineHandle {
  const { model } = ctx;
  const headline = h(
    "h1",
    { class: "headline m-reveal", style: { "--d": "0ms" } },
    renderSegments(ctx, model.headline.segments, "headline"),
  );
  const compact = compactSegments(model.headline.segments);
  let isCompact = false;
  const items = buildMeta(model);
  const metaChildren: Child[] = [];
  items.forEach((it, i) => {
    if (i > 0) metaChildren.push(h("span", { class: "meta-dot", "aria-hidden": "true" }));
    if (it.kind === "files" && it.extra) {
      const hidden = model.hiddenFiles;
      const btn = h(
        "button",
        {
          type: "button",
          class: "meta-more",
          "aria-label": `${hidden.length} more files below 1% of time with little memory — show in the code view`,
          onClick: () => void ctx.nav.showHiddenFiles(),
        },
        it.extra,
      );
      bindTooltip(ctx.tooltip, btn, () => ({
        title: `${hidden.length} files below 1% of time with little memory`,
        rows: hidden.slice(0, 8).map((f): [string, string] => [f.base, `${f.pct < 0.05 ? "<0.1" : f.pct.toFixed(1)}% of run`]),
        hint: hidden.length > 8 ? `+${hidden.length - 8} more in the code view` : "Listed in the code view's file navigator",
      }));
      metaChildren.push(h("span", { class: "meta-item" }, it.text, " ", btn));
    } else {
      metaChildren.push(h("span", { class: "meta-item" }, it.text));
    }
  });
  const meta = h("p", { class: "meta m-reveal", style: { "--d": "30ms" } }, metaChildren);
  const el = h("div", { class: "ov-head" }, headline, meta);
  return {
    el,
    headline,
    meta,
    setCompact(on) {
      if (!compact || on === isCompact) return;
      isCompact = on;
      const focused = headline.contains(document.activeElement);
      headline.replaceChildren();
      headline.append(h("span", { class: "hl-text" }, renderSegments(ctx, on ? compact : model.headline.segments, "headline")));
      headline.classList.toggle("is-compact", on);
      // The full sentence stays available (the compact one drops the second clause's details).
      if (on) headline.setAttribute("title", model.headline.plain);
      else headline.removeAttribute("title");
      if (focused) headline.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    },
    destroy() {
      el.remove();
    },
  };
}
