/**
 * DOM pieces shared by the canvas views (flame, timeline), round 1:
 *
 * - `createTapCard`: on touch, a tap selects a frame/segment and pins its details (the
 *   hover tooltip's content) in a small card with real buttons ("Zoom", "Open line"), so
 *   touch users reach everything the tooltip shows (principle 8). A second tap on the same
 *   item runs the primary action; × or Esc closes it.
 * - `createShowInCaption`: after "Show in stacks / timeline" the section says what it shows
 *   ("Showing train.py:173 · loss_value = loss.item() · in 19.6% of stack samples") with
 *   "× Clear" and "← Back to code".
 */

import { h } from "../../core/dom";
import { basename, fmtLoc, fmtPct } from "../../core/format";
import { icon, type IconName } from "../../core/icons";
import type { Target } from "../../core/store";
import type { TooltipContent } from "../../core/tooltip";
import { shortCode } from "../../model/headline";
import type { Model } from "../../model/model";
import { pyFnName } from "./shared";

export interface TapAction {
  label: string;
  icon?: IconName;
  run(): void;
}

export interface TapCard {
  el: HTMLElement;
  /** Show `content` anchored under (or above) the rect, in the host's coordinates. */
  show(content: TooltipContent, actions: TapAction[], anchor: { x: number; y: number; w: number; h: number }, bounds: { w: number; h: number }): void;
  hide(): void;
  isOpen(): boolean;
}

/** True for pointers without hover (touch, pen): a tap selects before it acts. */
export function isTouchPointer(type: string | undefined | null): boolean {
  return type === "touch" || type === "pen";
}

export function createTapCard(onClose?: () => void): TapCard {
  const el = h("div", { class: "tap-card", role: "group", "aria-label": "Frame details", hidden: true });
  let open = false;
  const close = () => {
    if (!open) return;
    open = false;
    el.hidden = true;
    onClose?.();
  };
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  });
  return {
    el,
    show(c, actions, anchor, bounds) {
      const closeBtn = h("button", { type: "button", class: "icon-btn icon-btn-sm tap-card-close", "aria-label": "Close details" }, icon("x"));
      closeBtn.addEventListener("click", close);
      const btns = actions.map((a) => {
        const b = h("button", { type: "button", class: "btn btn-compact tap-card-btn" }, a.icon ? icon(a.icon) : null, h("span", { class: "btn-label" }, a.label));
        b.addEventListener("click", () => a.run());
        return b;
      });
      const parts: HTMLElement[] = [h("div", { class: "tap-card-head" }, c.kind ? h("span", { class: "tt-kind" }, c.kind) : null, closeBtn)];
      if (c.title) parts.push(h("div", { class: c.mono ? "tap-card-title code" : "tap-card-title" }, c.title));
      if (c.rows?.length) parts.push(h("div", { class: "tt-rows tap-card-rows" }, c.rows.map(([k, v]) => [h("span", { class: "tt-label" }, k), h("span", { class: "tt-value" }, v)])));
      if (c.code) parts.push(h("pre", { class: "tt-code code tap-card-code" }, c.code));
      if (btns.length) parts.push(h("div", { class: "tap-card-actions" }, btns));
      el.replaceChildren(...parts);
      el.hidden = false;
      open = true;
      // Below the item, else above it; clamped to the host.
      const w = Math.min(bounds.w, 360);
      el.style.width = `${w}px`;
      const ht = el.offsetHeight || 140;
      let top = anchor.y + anchor.h + 6;
      if (top + ht > bounds.h && anchor.y - 6 - ht >= 0) top = anchor.y - 6 - ht;
      const left = Math.max(0, Math.min(bounds.w - w, anchor.x + Math.min(anchor.w, 24) - 24));
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(0, top))}px)`;
    },
    hide: close,
    isOpen: () => open,
  };
}

/**
 * The "Show in …" landing caption of one section: `show(target)` after a jump, cleared by
 * "× Clear" (the outline of the selected line then stays off until the selection changes),
 * "← Back to code", or a selection of another line (`selectionChanged`).
 */
export interface ShowInCaption {
  show(target: Target): void;
  clear(): void;
  /** Store selection changed: ends a caption about another line; re-enables the outline. */
  selectionChanged(sel: Target | null): void;
  /** True after "Clear" until the selection changes: linking must not re-outline the selection. */
  suppressed(): boolean;
}

export function createShowInCaption(o: {
  host: HTMLElement;
  model: Model;
  jump(target: Target): void;
  /** Clear pressed: drop the outline, keep focus in the section. */
  onClear(): void;
}): ShowInCaption {
  let current: Target | null = null;
  let suppress = false;
  const clear = () => {
    current = null;
    o.host.replaceChildren();
    o.host.hidden = true;
  };
  return {
    show(target) {
      suppress = false;
      current = target;
      const isLine = "line" in target;
      const line = isLine ? o.model.fileByName.get(target.file)?.byNo.get(target.line) ?? null : null;
      const code = line ? shortCode(line.text, 44) : null;
      const share = h("span", { class: "showin-share", hidden: true });
      const btn = (ic: IconName, label: string, run: () => void) => {
        const b = h("button", { type: "button", class: "btn btn-ghost btn-compact" }, icon(ic), h("span", { class: "btn-label" }, label));
        b.addEventListener("click", run);
        return b;
      };
      o.host.replaceChildren(
        h(
          "div",
          { class: "showin-chip", role: "status" },
          h(
            "span",
            { class: "showin-text" },
            h("span", null, "Showing"),
            h("span", { class: "mono showin-loc" }, isLine ? fmtLoc(target.file, target.line) : `${pyFnName(target.fn)} · ${basename(target.file)}`),
            code ? h("span", { class: "code showin-code" }, code) : null,
            share,
          ),
          h(
            "span",
            { class: "showin-actions" },
            btn("x", "Clear", () => {
              clear();
              suppress = true;
              o.onClear();
            }),
            btn("arrow-left", "Back to code", () => {
              clear();
              o.jump(target);
            }),
          ),
        ),
      );
      o.host.hidden = false;
      if (isLine) {
        void o.model.callContext(target.file, target.line).then((cc) => {
          if (current === target && cc && cc.total > 0) {
            share.textContent = `in ${fmtPct(cc.share)} of stack samples`;
            share.hidden = false;
          }
        });
      }
    },
    clear,
    selectionChanged(sel) {
      suppress = false;
      if (current && !sameTarget(current, sel)) clear();
    },
    suppressed: () => suppress,
  };
}

export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b || a.file !== b.file) return false;
  if ("line" in a) return "line" in b && a.line === b.line;
  return "fn" in b && a.fn === b.fn;
}
