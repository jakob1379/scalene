/**
 * Findings (DESIGN.md §4.6): deterministic rule cards from `model.findings`.
 * At most three are shown, then "Show N more". When there are no findings
 * the block is not rendered at all (must-fix 17).
 */

import { createDisposer, h } from "../../core/dom";
import { icon } from "../../core/icons";
import { FINDINGS_VISIBLE, type Finding } from "../../model/findings";
import type { ViewContext } from "../app";
import { renderSegments, spokenTarget, wireTarget } from "./headline";

export interface FindingsHandle {
  /** Null when the profile has no findings. */
  el: HTMLElement | null;
  /** `short` hosts show at most two in one row. */
  setLimit(n: number): void;
  destroy(): void;
}

const SEVERITY: Record<Finding["severity"], string> = { high: "High", medium: "Medium", low: "Low" };

/** "Propose a fix" on a finding about one line (the code row's Optimize trigger, §4.8.7). */
function proposeButton(ctx: ViewContext, f: Finding): HTMLElement | null {
  const t = f.ref?.target;
  if (!t || !("line" in t)) return null;
  // Shown once the AI controller has the profile and allows a proposal here (syncAi).
  const b = h("button", { type: "button", class: "btn btn-ghost btn-compact fd-ai", hidden: true, dataset: { file: t.file, line: String(t.line) }, "aria-label": `Propose a fix for ${spokenTarget(t)} with AI` }, icon("spark", 14), "Propose a fix");
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ctx.ai.request(t.file, t.line, "line");
    void ctx.nav.jumpTo(t, { focus: true, open: false, source: "finding" });
  });
  return b;
}

function card(ctx: ViewContext, f: Finding, i: number): HTMLElement {
  const target = f.ref?.target ?? null;
  const ref = f.ref
    ? (() => {
        const b = h("button", { type: "button", class: "fd-ref", "aria-label": `Evidence: go to ${spokenTarget(f.ref.target)}` }, h("span", { class: "mono" }, f.ref.label), icon("chevron-right", 14));
        wireTarget(ctx, b, f.ref.target, "finding");
        return b;
      })()
    : null;
  const ai = proposeButton(ctx, f);
  const children = [
    h("span", { class: "fd-icon", style: { "--c": `var(--${f.token})` }, "aria-hidden": "true" }, icon(f.icon, 16)),
    h(
      "div",
      { class: "fd-body" },
      // h4 under the "Findings" h3 (outline: h1 headline → h2 Overview → h3 → h4, §6.2.1).
      h("h4", { class: "fd-title" }, f.title),
      h("p", { class: "fd-text" }, renderSegments(ctx, f.sentence, "finding")),
      ref || ai ? h("div", { class: "fd-actions" }, ref, ai) : null,
    ),
  ];
  const art = h("article", { class: "fd-card", dataset: { severity: f.severity, id: f.id }, "aria-label": `${SEVERITY[f.severity]} severity: ${f.title}` }, children);
  if (target) {
    art.classList.add("is-linked-card");
    art.addEventListener("click", (ev) => {
      if ((ev.target as Element).closest("button")) return;
      void ctx.nav.jumpTo(target, { focus: true, open: true, source: "finding" });
    });
    art.addEventListener("mouseenter", () => ctx.bus.emit("hover:line", { target, source: "finding" }));
    art.addEventListener("mouseleave", () => ctx.bus.emit("hover:line", { target: null, source: "finding" }));
  }
  return h("li", { class: "fd-item", style: { "--i": String(i) } }, art);
}

export function mountFindings(ctx: ViewContext, labelDelay: number): FindingsHandle {
  const list = ctx.model.findings;
  if (list.length === 0) return { el: null, setLimit() {}, destroy() {} };
  const disposer = createDisposer();
  let expanded = false;
  let limit = FINDINGS_VISIBLE;
  const items = list.map((f, i) => card(ctx, f, i));
  // One finding: the card takes two thirds and a muted note says the other rules were checked,
  // so the row is not an empty grid (review round 1). Two findings fill two halves.
  const note =
    list.length === 1
      ? h(
          "li",
          { class: "fd-note" },
          h("p", null, "No other finding. The rules for GPU waits, event-loop blocking, leaks, the memory peak, GIL contention, heavy copying and native code did not match this profile."),
        )
      : null;
  const ul = h("ul", { class: "fd-list", role: "list", dataset: { count: String(Math.min(list.length, FINDINGS_VISIBLE)) } }, items, note);
  const more = h("button", { type: "button", class: "btn btn-ghost btn-compact fd-more", "aria-expanded": "false" }, "");
  const head = h(
    "div",
    { class: "fd-head" },
    h("h3", { id: "findings-label", class: "micro fd-label m-reveal", style: { "--d": `${labelDelay}ms` } }, "Findings"),
    h("span", { class: "fd-sub" }, "rule-based, from this profile"),
    more,
  );
  const el = h("section", { class: "ov-findings", "aria-labelledby": "findings-label" }, head, ul);
  const sync = () => {
    const n = expanded ? list.length : Math.min(limit, list.length);
    items.forEach((li, i) => (li.hidden = i >= n));
    ul.dataset.count = String(n);
    const hiddenCount = list.length - Math.min(limit, list.length);
    more.hidden = hiddenCount <= 0;
    more.textContent = expanded ? "Show fewer" : `Show ${hiddenCount} more`;
    more.setAttribute("aria-expanded", String(expanded));
    el.classList.toggle("is-expanded", expanded);
  };
  more.addEventListener("click", () => {
    expanded = !expanded;
    sync();
    if (expanded) items[Math.min(limit, items.length - 1)]?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  });
  sync();
  const syncAi = () => {
    for (const b of Array.from(el.querySelectorAll<HTMLElement>(".fd-ai"))) {
      b.hidden = !ctx.ai.availability(b.dataset.file ?? "").get(Number(b.dataset.line))?.line;
    }
  };
  disposer.add(ctx.ai.onChange((anchor) => anchor === null && syncAi()));
  queueMicrotask(syncAi);
  return {
    el,
    setLimit(n) {
      limit = n;
      sync();
    },
    destroy() {
      disposer.dispose();
      el.remove();
    },
  };
}
