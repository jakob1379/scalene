/**
 * Overview section (DESIGN.md §2.3–2.4, §4.2–4.6, §5.2 M1–M6, §5.3.1).
 *
 * Layout: hero card (headline + meta | readouts) → Instrument card (scope |
 * hotspots) → findings. At `lg+` the scope and hotspots sit side by side; at
 * `xxl` the findings become a third column; on phones (`xs`) the nodes are
 * MOVED (not re-created) into headline → time split → hotspots → readouts
 * 2–4 → scope → findings, keeping focus and state (§2.4.5).
 */

import { bpAtLeast } from "../../core/layout";
import { createDisposer, h } from "../../core/dom";
import { DUR, EASE_CSS } from "../../core/motion";
import type { AppState } from "../../core/store";
import type { HotspotList } from "../../model/hotspots";
import type { ViewContext, ViewHandle } from "../app";
import { mountFindings } from "./findings";
import { mountHeadline } from "./headline";
import { mountHotspots } from "./hotspots";
import { gridColumns, mountReadouts } from "./readouts";
import { mountScope, type ScopeHandle } from "./scope";

export interface OverviewMode {
  phone: boolean;
  side: boolean;
  short: boolean;
  xxl: boolean;
}

/** Layout mode for a breakpoint state (`wide` = viewport ≥ 900 px, for short hosts). */
export function overviewMode(layout: AppState["layout"], wide: boolean): OverviewMode {
  const short = layout.short;
  return {
    short,
    phone: layout.bp === "xs" && !short,
    side: short ? wide : bpAtLeast(layout.bp, "lg"),
    xxl: layout.bp === "xxl" && !short,
  };
}

/** Rows shown in the hotspot list (§2.4.2): 3 + "Show all" on phones, 5 in short hosts, else 8. */
export function hotspotRows(mode: OverviewMode): { n: number; showAll: boolean } {
  if (mode.short) return { n: 5, showAll: false };
  if (mode.phone) return { n: 3, showAll: true };
  return { n: 8, showAll: false };
}

/** Exposed for tests and tooling: `window.__scaleneOverview.scope.debugLayout()`. */
interface OverviewDebug {
  scope: Pick<ScopeHandle, "debugLayout">;
  mode(): OverviewMode;
  /** The intro origin (M1–M6): the first frame's timestamp (mount time until that frame). */
  t0: number;
  /** True once the origin is known (the first frame committed), or at once on the still path. */
  started: boolean;
}

/**
 * M1 (reveal), M3/M5/M6 (bars grow): the parts mark elements with `.m-reveal` / `.m-grow`
 * and an inline `--d` delay; here they become Web Animations. They are created pending (the
 * first painted frame shows their start state) and the caller pins every start time to the
 * intro origin, so DOM motion and the canvas sweep share one clock and the stagger is
 * deterministic (§5.5 `intro(plan)`). Later DOM moves (phone order) do not replay them.
 */
function introAnimations(root: HTMLElement, instant: boolean): Animation[] {
  const reveal = Array.from(root.querySelectorAll<HTMLElement>(".m-reveal"));
  const grow = Array.from(root.querySelectorAll<HTMLElement>(".m-grow"));
  for (const el of reveal.concat(grow)) el.classList.remove("m-reveal", "m-grow");
  const out: Animation[] = [];
  if (instant || typeof Element.prototype.animate !== "function") return out;
  const delayOf = (el: HTMLElement) => parseFloat(el.style.getPropertyValue("--d")) || 0;
  for (const el of reveal) {
    const delay = delayOf(el);
    out.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.d3, delay, easing: "linear", fill: "backwards" }));
    out.push(el.animate([{ transform: "translateY(6px)" }, { transform: "none" }], { duration: 320, delay, easing: EASE_CSS.out, fill: "backwards" }));
  }
  for (const el of grow) {
    // `--dur` lets a meter share its count-up's duration (one clock per readout tile).
    const duration = parseFloat(el.style.getPropertyValue("--dur")) || DUR.d5;
    out.push(el.animate([{ transform: "scaleX(0)" }, { transform: "none" }], { duration, delay: delayOf(el), easing: EASE_CSS.out, fill: "backwards" }));
  }
  return out;
}

/** The intro is settled (pixel-identical to `?still`) this long after its first frame (§5.3.1). */
export const INTRO_SETTLE_MS = 900;

export function mountOverview(host: HTMLElement, ctx: ViewContext): ViewHandle {
  const { store, bus } = ctx;
  const disposer = createDisposer();
  const instant = ctx.motion.reduced || ctx.host.flags.still;

  // ── Parts ──
  const headline = mountHeadline(ctx);
  const readouts = mountReadouts(ctx, 60);
  const n = ctx.model.readouts.length;
  let delay = 60 + 30 * (n + (readouts.extra ? 1 : 0));
  const scope = mountScope(ctx);
  delay += 30;
  const hot = mountHotspots(ctx, delay);
  delay += 30;
  const findings = mountFindings(ctx, delay);
  scope.el.querySelector<HTMLElement>(".scope-title")?.style.setProperty("--d", `${delay - 60}ms`);

  // ── Containers ──
  const readoutGrid = h("div", { class: "ov-readouts", style: { "--ro-cols": gridColumns(n) }, dataset: { n: String(n) } });
  const hero = h("div", { class: "card ov-hero" }, headline.el, readoutGrid);
  const inst = h("div", { class: ["card", "ov-inst", scope.present ? "" : "no-scope"] });
  const hotCard = h("div", { class: "card ov-hotcard" });
  const readCard = h("div", { class: "card ov-readcard" }, h("div", { class: "ov-readouts ov-readouts-rest" }));
  const scopeCard = h("div", { class: "card ov-scopecard" });
  const root = h("div", { class: ["ov", findings.el ? "has-findings" : "no-findings"] }, hero, inst, hotCard, readCard, scopeCard, findings.el);
  // Outline (§6.2.1): the headline is the page's h1; the section heading "Overview" follows it
  // (visually hidden), then h3 Hotspots / Findings and h4 finding titles.
  headline.el.append(h("h2", { id: "overview-h", class: "visually-hidden", tabindex: "-1" }, "Overview"));
  host.append(root);
  const restGrid = readCard.firstElementChild as HTMLElement;

  // ── Layout (and the phone order) ──
  const wideMq = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 900px)") : null;
  let mode: OverviewMode | null = null;

  const place = (parent: HTMLElement, child: HTMLElement, before: Node | null = null) => {
    if (child.parentElement !== parent || (before && child.nextSibling !== before)) parent.insertBefore(child, before);
  };

  function applyLayout(): void {
    const next = overviewMode(store.get().layout, Boolean(wideMq?.matches));
    const changed = !mode || mode.phone !== next.phone || mode.side !== next.side || mode.short !== next.short || mode.xxl !== next.xxl;
    mode = next;
    if (!changed) return;
    const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    root.dataset.layout = next.phone ? "phone" : next.side ? "side" : "stack";
    root.classList.toggle("is-short", next.short);
    root.classList.toggle("is-xxl", next.xxl);
    headline.setCompact(next.phone || next.short);
    if (next.phone) {
      place(readoutGrid, readouts.tiles[0]);
      for (const t of readouts.tiles.slice(0, 1)) place(readoutGrid, t);
      for (const t of readouts.tiles.slice(1)) place(restGrid, t);
      if (readouts.extra) place(restGrid, readouts.extra);
      place(hotCard, hot.el);
      if (scope.present) place(scopeCard, scope.el);
      readCard.hidden = readouts.tiles.length + (readouts.extra ? 1 : 0) <= 1;
      hotCard.hidden = false;
      scopeCard.hidden = !scope.present || !scope.drawable();
      inst.hidden = true;
      readoutGrid.style.setProperty("--ro-cols", "minmax(0, 1fr)");
    } else {
      for (const t of readouts.tiles) place(readoutGrid, t);
      if (readouts.extra?.parentElement) readouts.extra.remove();
      if (scope.present) place(inst, scope.el);
      place(inst, hot.el);
      inst.hidden = false;
      hotCard.hidden = true;
      readCard.hidden = true;
      scopeCard.hidden = true;
      readoutGrid.style.setProperty("--ro-cols", gridColumns(n));
    }
    const rows = hotspotRows(next);
    hot.setVisible(rows.n, rows.showAll);
    findings.setLimit(next.short ? 2 : 3);
    scope.setMode(next.side && !next.phone ? "side" : "stack");
    syncScopePresence();
    if (focused && document.activeElement !== focused && focused.isConnected) focused.focus({ preventScroll: true });
  }

  /** A layout mode without a drawable channel hides the scope; the hotspots take the full width. */
  function syncScopePresence(): void {
    const on = scope.present && scope.drawable();
    inst.classList.toggle("no-scope", !on);
    if (mode?.phone) scopeCard.hidden = !on;
  }
  scope.onDrawable(() => syncScopePresence());

  disposer.add(store.subscribe((s) => s.layout, () => applyLayout()));
  if (wideMq) {
    const onWide = () => applyLayout();
    wideMq.addEventListener("change", onWide);
    disposer.add(() => wideMq.removeEventListener("change", onWide));
  }
  applyLayout();

  // ── Linking (§4.4.6, §4.5.4) ──
  // Downstream (TOP LINES, minimap pins) always gets the top 8, also while the list is expanded.
  const publish = (list: HotspotList) => {
    const top = list.items.slice(0, 8);
    scope.setTopLines(top, list.metric);
    bus.emit("hotspots:changed", { items: top });
  };
  hot.onItems(publish);
  hot.onHover((item) => {
    scope.link({ item: item ?? undefined, target: item ? item.target : null }, "hotspot");
    bus.emit("hover:line", { target: item ? item.target : null, source: "hotspot" });
  });
  disposer.add(
    bus.on("hover:line", ({ target, source }) => {
      if (source !== "hotspot") hot.highlight(target);
      if (source !== "hotspot" && source !== "scope") scope.link({ target }, source);
    }),
  );
  publish(hot.list());

  // ── Intro (M1–M6): one clock whose origin is the first painted frame (mount work and the
  // other sections' first layout must not eat the first 100–200 ms of the choreography). ──
  const debug: OverviewDebug = { scope, mode: () => mode as OverviewMode, t0: performance.now(), started: instant };
  readouts.intro(instant);
  hot.intro(instant);
  const anims = introAnimations(root, instant);
  // The intro origin: the start time every pending animation above receives on the first frame
  // that paints the overview (or that frame's time when the engine has no Web Animations).
  const clockNow = () => {
    const ct = document.timeline?.currentTime;
    return typeof ct === "number" ? ct : performance.now();
  };
  const origin: Promise<number> = anims.length
    ? anims[0].ready.then(
        (a) => (typeof a.startTime === "number" ? a.startTime : clockNow()),
        () => clockNow(),
      )
    : new Promise((resolve) => requestAnimationFrame(() => resolve(clockNow())));
  scope.intro(instant, instant ? undefined : origin);
  if (!instant) {
    // Every Web Animation above (and the scope's stage) was created pending in this task, so they
    // all start on the first frame that paints the overview; that start time is the origin of the
    // main-thread parts (count-ups) too.
    let frame = 0;
    let settle = 0;
    let alive = true;
    void origin.then((o) => {
      if (!alive) return;
      debug.t0 = o;
      debug.started = true;
      const tick = () => {
        frame = readouts.tick(clockNow() - o) ? requestAnimationFrame(tick) : 0;
      };
      tick();
      settle = window.setTimeout(() => performance.mark("scalene:overview-settled"), Math.max(0, o + INTRO_SETTLE_MS - performance.now()));
    });
    disposer.add(() => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    });
  }
  (globalThis as { __scaleneOverview?: OverviewDebug }).__scaleneOverview = debug;

  return {
    destroy() {
      disposer.dispose();
      scope.destroy();
      hot.destroy();
      findings.destroy();
      readouts.destroy();
      headline.destroy();
      if ((globalThis as { __scaleneOverview?: OverviewDebug }).__scaleneOverview === debug) delete (globalThis as { __scaleneOverview?: OverviewDebug }).__scaleneOverview;
      host.replaceChildren();
    },
  };
}
