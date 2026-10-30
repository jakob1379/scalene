// AI proposal card (DESIGN.md §4.14.3, M22): setup / working / result / error, rendered
// inline after the anchor row by the code view through renderAiCard(). The element is
// reused across renders (the code view keeps it while virtualized), and its content is
// rebuilt only when the controller's state object changes.
import { CHOOSE_PROVIDER_MESSAGE, providerLabel, resolvedModel, type AiError, type OptimizationResult } from "../../ai/index";
import { segmented } from "../../core/controls";
import { h, VISUALLY_HIDDEN, type Child } from "../../core/dom";
import { NBSP } from "../../core/format";
import { icon } from "../../core/icons";
import { bindTooltip } from "../../core/tooltip";
import type { LineM } from "../../model/model";
import { highlight, stringLines } from "../../model/syntax";
import type { ViewContext } from "../app";
import { aiHandle, type AiCardState } from "./controller";
import {
  baseIndent,
  diffStats,
  durationLabel,
  elapsedLabel,
  errorDetail,
  errorView,
  lineDiff,
  parseAnchor,
  rangeLabel,
  reindent,
  shortModel,
  splitLines,
  AI_PRIVACY,
} from "./logic";

const COPIED_MS = 1200;
const PRIVACY = AI_PRIVACY;
const DISCLAIMER = "AI-generated suggestions may not always be correct.";

interface CardRec {
  anchor: string;
  state: AiCardState | null;
  timers: number[];
  disposers: (() => void)[];
}

const records = new WeakMap<HTMLElement, CardRec>();

function motionOff(): boolean {
  const c = document.documentElement.classList;
  return c.contains("motion-reduce") || c.contains("motion-still");
}

/** Python source → highlighted spans (one element per line). */
function codeLines(lines: readonly string[]): HTMLElement[] {
  const inStr = stringLines(lines);
  return lines.map((text, i) =>
    h(
      "span",
      { class: "ai-line" },
      text ? highlight(text, inStr[i]).map((s) => (s.cls ? h("span", { class: s.cls }, s.text) : s.text)) : "​",
    ),
  );
}

/** Inline text with `backtick` spans rendered as code. */
function withCode(text: string): Child[] {
  return text.split(/(`[^`]+`)/).map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? h("code", { class: "ai-inline-code" }, part.slice(1, -1)) : part));
}

/** Original source lines start..end (unescaped model text). */
function originalLines(ctx: ViewContext, file: string, start: number, end: number): string[] {
  const f = ctx.model.fileByName.get(file);
  const out: string[] = [];
  if (!f) return out;
  for (let n = start; n <= end; n++) out.push(f.byNo.get(n)?.text ?? "");
  return out;
}

function lineAt(ctx: ViewContext, file: string, line: number): LineM | null {
  return ctx.model.fileByName.get(file)?.byNo.get(line) ?? null;
}

/** Clipboard write with a textarea fallback (file:// pages, older webviews). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = h("textarea", { class: VISUALLY_HIDDEN, readonly: true, "aria-hidden": "true" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ── State renderers ─────────────────────────────────────────────────────────────

interface Parts {
  mark: Child;
  title: Child;
  meta?: Child;
  headActions?: Child;
  body?: Child;
  foot?: Child;
}

function frame(p: Parts): HTMLElement {
  return h(
    "div",
    { class: "ai-card-inner" },
    h(
      "div",
      { class: "ai-card-head" },
      h("span", { class: "ai-card-mark", "aria-hidden": "true" }, p.mark),
      h("div", { class: "ai-card-titles" }, h("h3", { class: "ai-card-title" }, p.title), p.meta ? h("p", { class: "ai-card-meta" }, p.meta) : null),
      p.headActions ? h("div", { class: "ai-card-head-actions" }, p.headActions) : null,
    ),
    p.body ? h("div", { class: "ai-card-body" }, p.body) : null,
    p.foot ? h("div", { class: "ai-card-foot" }, p.foot) : null,
  );
}

function dismissButton(ctx: ViewContext, anchor: string, rec: CardRec): HTMLButtonElement {
  const b = h(
    "button",
    { type: "button", class: "icon-btn ai-card-dismiss", "aria-label": "Dismiss this proposal", onClick: () => ctx.ai.dismiss(anchor) },
    icon("x"),
  );
  rec.disposers.push(bindTooltip(ctx.tooltip, b, { title: "Dismiss" }));
  return b;
}

function renderSetup(ctx: ViewContext, anchor: string, s: Extract<AiCardState, { status: "setup" }>, rec: CardRec): HTMLElement {
  const { file, line } = parseAnchor(anchor);
  const info = aiHandle(ctx.ai)?.requestOf(anchor);
  const l = lineAt(ctx, file, line);
  const range = info?.mode === "region" && l ? rangeLabel(l.region[0], l.region[1]) : rangeLabel(line, line);
  if (s.missing.length === 0) {
    // The provider became ready while the card was open: one click runs the request.
    return frame({
      mark: icon("spark"),
      title: `Ready to optimize ${range}`,
      meta: ctx.ai.providerSummary(),
      headActions: dismissButton(ctx, anchor, rec),
      body: h("p", { class: "ai-privacy-line" }, icon("info", 14), h("span", null, PRIVACY)),
      foot: h(
        "div",
        { class: "ai-card-actions" },
        h(
          "button",
          { type: "button", class: "btn btn-primary btn-compact", "data-primary": "", onClick: () => aiHandle(ctx.ai)?.retry(anchor) },
          icon("spark"),
          h("span", { class: "btn-label" }, `Optimize ${range}`),
        ),
        h("button", { type: "button", class: "btn btn-ghost btn-compact", onClick: () => ctx.ai.dismiss(anchor) }, "Dismiss"),
      ),
    });
  }
  return frame({
    mark: icon("spark"),
    title: `Set up an AI provider to optimize ${range}`,
    meta: s.message || "No AI provider is set up.",
    headActions: dismissButton(ctx, anchor, rec),
    body: h("p", { class: "ai-privacy-line" }, icon("info", 14), h("span", null, PRIVACY)),
    foot: h(
      "div",
      { class: "ai-card-actions" },
      h(
        "button",
        // No provider chosen yet: open on the provider tiles, not on the default's key field.
        { type: "button", class: "btn btn-primary btn-compact", "data-primary": "", onClick: () => ctx.ai.openSettings(s.message === CHOOSE_PROVIDER_MESSAGE ? undefined : s.missing[0]) },
        icon("spark"),
        h("span", { class: "btn-label" }, "Set up AI provider"),
      ),
      h("button", { type: "button", class: "btn btn-ghost btn-compact", onClick: () => ctx.ai.dismiss(anchor) }, "Dismiss"),
    ),
  });
}

function renderWorking(ctx: ViewContext, anchor: string, s: Extract<AiCardState, { status: "working" }>, rec: CardRec): HTMLElement {
  const { file } = parseAnchor(anchor);
  const elapsed = h("span", { class: "ai-elapsed num" }, elapsedLabel(Date.now() - s.startedAt));
  const tick = window.setInterval(() => {
    if (ctx.ai.card(anchor) !== s) {
      window.clearInterval(tick);
      return;
    }
    elapsed.textContent = elapsedLabel(Date.now() - s.startedAt);
  }, 1000);
  rec.timers.push(tick);
  // Skeleton bars shaped like the code being rewritten: indentation and length of the
  // first three original lines (static, no shimmer).
  const src = originalLines(ctx, file, s.start, s.end).filter((t) => t.trim());
  const shapes = (src.length ? src : ["    x", "    xxxxxxxxxxxxxxxxxxxx", "    xxxxxxxxxxxxxx"]).slice(0, 3);
  while (shapes.length < 3) shapes.push(shapes[shapes.length - 1] ?? "xxxxxxxxxxxx");
  const bars = shapes.map((t, i) => {
    const indent = t.length - t.trimStart().length;
    const len = Math.max(8, Math.min(72, t.trim().length - (i === 1 ? 4 : 0)));
    return h("span", { class: "ai-skel", style: { "--ai-indent": `${Math.min(indent, 24)}ch`, "--ai-len": `${len}ch` } });
  });
  const model = shortModel(s.model);
  const modelEl = h("span", { class: "ai-meta-model" }, model);
  if (model !== s.model) rec.disposers.push(bindTooltip(ctx.tooltip, modelEl, { title: "Model", code: s.model }));
  return frame({
    mark: icon("spark"),
    title: `Optimizing ${rangeLabel(s.start, s.end)}`,
    meta: [s.provider, " · ", modelEl, " · ", elapsed],
    headActions: h(
      "button",
      { type: "button", class: "btn btn-secondary btn-compact ai-cancel", "data-primary": "", onClick: () => ctx.ai.cancel(anchor) },
      icon("x"),
      h("span", { class: "btn-label" }, "Cancel"),
    ),
    body: h("div", { class: "ai-skeleton", "aria-hidden": "true" }, bars),
  });
}

function renderResult(ctx: ViewContext, anchor: string, s: Extract<AiCardState, { status: "result" }>, rec: CardRec, card: HTMLElement): HTMLElement {
  const r: OptimizationResult = s.result;
  const { file } = parseAnchor(anchor);
  const handle = aiHandle(ctx.ai);
  const orig = originalLines(ctx, file, r.startLine, r.endLine);
  // Line proposals keep the clicked line's indentation (upstream); region proposals align
  // with the block they replace (its base indentation), not with the clicked line inside it.
  const proposal = reindent(r.code, r.mode === "region" ? baseIndent(orig) : r.leadingSpaces);
  const rows = lineDiff(orig, r.startLine, splitLines(r.code));
  const stats = diffStats(rows);

  // Proposal view: highlighted, keeps the clicked line's indentation.
  const proposalEl = h("pre", { class: "ai-code code", tabindex: "0", "aria-label": `Proposed code for ${rangeLabel(r.startLine, r.endLine)}` }, codeLines(proposal));

  // Diff view: LCS line diff, − rows then + rows, both highlighted.
  const buildDiff = () => {
    const a = rows.filter((x) => x.op !== "add").map((x) => x.text);
    const b = rows.filter((x) => x.op !== "del").map((x) => x.text);
    const aStr = stringLines(a);
    const bStr = stringLines(b);
    let ia = 0;
    let ib = 0;
    const out = rows.map((row) => {
      const inStr = row.op === "del" ? aStr[ia] : bStr[ib];
      if (row.op !== "add") ia++;
      if (row.op !== "del") ib++;
      const sign = row.op === "del" ? "−" : row.op === "add" ? "+" : "";
      const spoken = row.op === "del" ? "Removed: " : row.op === "add" ? "Added: " : "";
      return h(
        "div",
        { class: ["ai-drow", `is-${row.op}`] },
        h("span", { class: "ai-dno num", "aria-hidden": "true" }, row.no === null ? "" : String(row.no)),
        h("span", { class: "ai-dsign", "aria-hidden": "true" }, sign),
        h(
          "code",
          { class: "ai-dcode" },
          spoken ? h("span", { class: VISUALLY_HIDDEN }, spoken) : null,
          row.text ? highlight(row.text, inStr).map((sp) => (sp.cls ? h("span", { class: sp.cls }, sp.text) : sp.text)) : "​",
        ),
      );
    });
    return h(
      "div",
      { class: "ai-diff code", tabindex: "0", role: "group", "aria-label": `Diff for ${rangeLabel(r.startLine, r.endLine)}: ${stats.removed} removed, ${stats.added} added` },
      h("div", { class: "ai-diff-rows" }, out),
    );
  };
  let diffEl: HTMLElement | null = null;
  const viewHost = h("div", { class: "ai-view" });
  const showView = (v: "proposal" | "diff") => {
    if (v === "diff") diffEl ??= buildDiff();
    viewHost.replaceChildren(v === "diff" ? (diffEl as HTMLElement) : proposalEl);
    card.dataset.view = v;
  };
  const toggle = segmented({
    label: "Show the proposal or the diff",
    options: [
      { value: "proposal", label: "Proposal" },
      { value: "diff", label: "Diff" },
    ],
    value: s.view,
    onChange: (v) => {
      handle?.patchResult(anchor, { view: v });
      rec.state = ctx.ai.card(anchor);
      showView(v);
    },
  });
  rec.disposers.push(() => toggle.destroy());
  showView(s.view);

  const statBadge = h(
    "span",
    { class: "ai-diffstat num", "aria-label": `${stats.added} lines added, ${stats.removed} removed` },
    h("span", { class: "ai-add" }, `+${stats.added}`),
    h("span", { class: "ai-del" }, `−${stats.removed}`),
  );

  // Copy: icon swaps to ✓ "Copied" for 1.2 s (M22); a toast on failure.
  const copyLabel = h("span", { class: "btn-label" }, "Copy");
  const copyIcon = h("span", { class: "ai-copy-icon" }, icon("copy"));
  const copyBtn = h("button", { type: "button", class: "btn btn-secondary btn-compact ai-copy", "data-primary": "" }, copyIcon, copyLabel);
  copyBtn.addEventListener("click", () => {
    void copyText(r.code).then((ok) => {
      if (!ok) {
        ctx.toast.show({ kind: "error", text: "Couldn't copy to the clipboard. Select the code and copy it instead." });
        return;
      }
      copyIcon.replaceChildren(icon("check"));
      copyLabel.textContent = "Copied";
      copyBtn.classList.add("is-copied");
      ctx.announce.polite("Proposal copied to the clipboard");
      const t = window.setTimeout(() => {
        copyIcon.replaceChildren(icon("copy"));
        copyLabel.textContent = "Copy";
        copyBtn.classList.remove("is-copied");
      }, COPIED_MS);
      rec.timers.push(t);
    });
  });

  // Show prompt: disclosure with the exact prompt, mono, scrollable (max 320 px).
  const promptId = `ai-prompt-${Math.random().toString(36).slice(2, 8)}`;
  const promptPanel = h("pre", { id: promptId, class: "ai-prompt code", tabindex: "0", hidden: !s.showPrompt }, r.prompt);
  const promptBtn = h(
    "button",
    { type: "button", class: "btn btn-ghost btn-compact ai-prompt-btn", "aria-expanded": String(s.showPrompt), "aria-controls": promptId },
    h("span", { class: "disclosure-chevron" }, icon("chevron-right")),
    h("span", { class: "btn-label" }, "Show prompt"),
  );
  promptBtn.addEventListener("click", () => {
    const open = promptPanel.hidden === true;
    promptPanel.hidden = !open;
    promptBtn.setAttribute("aria-expanded", String(open));
    handle?.patchResult(anchor, { showPrompt: open });
    rec.state = ctx.ai.card(anchor);
  });

  const model = shortModel(r.model);
  const modelEl = h("span", { class: "ai-meta-model" }, model);
  if (model !== r.model) rec.disposers.push(bindTooltip(ctx.tooltip, modelEl, { title: "Model", code: r.model }));

  return frame({
    mark: icon("spark"),
    title: `Proposal for ${rangeLabel(r.startLine, r.endLine)}`,
    meta: [providerLabel(r.provider), " · ", modelEl, " · ", h("span", { class: "num" }, durationLabel(r.elapsedMs))],
    headActions: [statBadge, toggle.el, dismissButton(ctx, anchor, rec)],
    body: [viewHost, promptPanel],
    foot: [
      h(
        "div",
        { class: "ai-card-actions" },
        copyBtn,
        h(
          "button",
          { type: "button", class: "btn btn-ghost btn-compact ai-regen", onClick: () => handle?.retry(anchor) },
          icon("sync"),
          h("span", { class: "btn-label" }, "Regenerate"),
        ),
        promptBtn,
      ),
      h("p", { class: "ai-disclaimer" }, icon("info", 14), h("span", null, DISCLAIMER)),
    ],
  });
}

function renderError(ctx: ViewContext, anchor: string, s: Extract<AiCardState, { status: "error" }>, rec: CardRec): HTMLElement {
  const { file, line } = parseAnchor(anchor);
  const e: AiError = s.error;
  const handle = aiHandle(ctx.ai);
  const model = resolvedModel(e.provider, ctx.ai.settings().providers);
  const view = errorView(e, { providerLabel: providerLabel(e.provider), model });
  const l = lineAt(ctx, file, line);
  const range = s.mode === "region" && l ? rangeLabel(l.region[0], l.region[1]) : rangeLabel(line, line);

  const retry: HTMLButtonElement = h(
    "button",
    {
      type: "button",
      class: "btn btn-secondary btn-compact ai-retry",
      "data-primary": "",
      onClick: () => {
        if (retry.getAttribute("aria-disabled") !== "true") handle?.retry(anchor);
      },
    },
    icon("sync"),
    h("span", { class: "btn-label" }, "Retry"),
  );
  if (view.retryDelayMs > 0) {
    const until = Date.now() + view.retryDelayMs;
    const label = retry.querySelector(".btn-label") as HTMLElement;
    const update = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        retry.removeAttribute("aria-disabled");
        label.textContent = "Retry";
        return true;
      }
      retry.setAttribute("aria-disabled", "true");
      label.textContent = `Retry in ${left}${NBSP}s`;
      return false;
    };
    update();
    const t = window.setInterval(() => {
      if (update()) window.clearInterval(t);
    }, 250);
    rec.timers.push(t);
  }
  const actions: HTMLElement[] = [retry];
  if (view.actions.includes("settings")) {
    actions.push(
      h(
        "button",
        { type: "button", class: "btn btn-primary btn-compact", onClick: () => ctx.ai.openSettings(view.focusField ?? undefined) },
        icon("spark"),
        h("span", { class: "btn-label" }, "Open AI settings"),
      ),
    );
  }
  if (view.actions.includes("model")) {
    actions.push(
      h(
        "button",
        { type: "button", class: "btn btn-primary btn-compact", onClick: () => ctx.ai.openSettings(view.focusField ?? "model") },
        h("span", { class: "btn-label" }, "Choose another model"),
      ),
    );
  }
  actions.push(h("button", { type: "button", class: "btn btn-ghost btn-compact", onClick: () => ctx.ai.dismiss(anchor) }, "Dismiss"));

  const detailsId = `ai-err-${Math.random().toString(36).slice(2, 8)}`;
  const details = h("pre", { id: detailsId, class: "ai-error-detail code", hidden: true, tabindex: "0" }, errorDetail(e));
  const detailsBtn = h(
    "button",
    { type: "button", class: "btn btn-ghost btn-compact ai-details-btn", "aria-expanded": "false", "aria-controls": detailsId },
    h("span", { class: "disclosure-chevron" }, icon("chevron-right")),
    h("span", { class: "btn-label" }, "Details"),
  );
  detailsBtn.addEventListener("click", () => {
    const open = details.hidden === true;
    details.hidden = !open;
    detailsBtn.setAttribute("aria-expanded", String(open));
  });

  return frame({
    mark: icon("alert"),
    title: `Couldn't optimize ${range}`,
    meta: [providerLabel(e.provider), e.status ? ` · HTTP ${e.status}` : ""],
    headActions: dismissButton(ctx, anchor, rec),
    body: [
      h("p", { class: "ai-error-msg" }, withCode(view.message)),
      view.hint ? h("p", { class: "ai-error-hint" }, withCode(view.hint)) : null,
      details,
    ],
    foot: h("div", { class: "ai-card-actions" }, actions, detailsBtn),
  });
}

// ── Entry point (§8.5) ──────────────────────────────────────────────────────────

function cleanup(rec: CardRec): void {
  for (const t of rec.timers.splice(0)) {
    window.clearInterval(t);
    window.clearTimeout(t);
  }
  for (const d of rec.disposers.splice(0)) d();
}

/**
 * Render (or update in place) the card for `anchor`. Returns `el` itself when it is this
 * anchor's card, so callers can keep the node; a new element otherwise.
 */
export function renderAiCard(el: HTMLElement | null, anchor: string, ctx: ViewContext): HTMLElement {
  const state = ctx.ai.card(anchor);
  let card = el;
  let rec = card ? records.get(card) : undefined;
  if (!card || !rec || rec.anchor !== anchor) {
    card = h("div", { class: "ai-card", role: "region", tabindex: "-1" });
    rec = { anchor, state: undefined as unknown as null, timers: [], disposers: [] };
    records.set(card, rec);
    if (!motionOff()) {
      // M22: the card unfolds from its row (grid rows 0fr → 1fr) and its content fades in.
      card.classList.add("is-entering");
      requestAnimationFrame(() => requestAnimationFrame(() => card?.classList.remove("is-entering")));
    }
  }
  if (rec.state === state && card.firstChild) return card;

  const { file, line } = parseAnchor(anchor);
  const base = file.split(/[\\/]/).pop() || file;
  card.setAttribute("aria-label", `AI proposal for ${base} line ${line}`);
  const prevHeight = card.isConnected && card.firstChild ? card.getBoundingClientRect().height : 0;
  cleanup(rec);
  rec.state = state;
  card.dataset.status = state?.status ?? "none";
  card.dataset.anchor = anchor;
  let inner: HTMLElement;
  switch (state?.status) {
    case "setup":
      inner = renderSetup(ctx, anchor, state, rec);
      break;
    case "working":
      inner = renderWorking(ctx, anchor, state, rec);
      break;
    case "result":
      inner = renderResult(ctx, anchor, state, rec, card);
      break;
    case "error":
      inner = renderError(ctx, anchor, state, rec);
      break;
    default:
      inner = h("div", { class: "ai-card-inner" });
  }
  const hadFocus = card.contains(document.activeElement);
  card.replaceChildren(inner);
  // Focus follows the work: the new state's primary action (Cancel → Copy, Regenerate → Cancel…).
  if (hadFocus) (card.querySelector<HTMLElement>("[data-primary]") ?? card).focus({ preventScroll: true });

  // M22 state change: content fades in and the height eases from the old to the new size.
  if (prevHeight > 0 && !motionOff()) {
    const next = card.getBoundingClientRect().height;
    inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "linear" });
    if (Math.abs(next - prevHeight) > 2 && typeof card.animate === "function") {
      card.animate([{ height: `${prevHeight}px` }, { height: `${next}px` }], { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
  }
  return card;
}
