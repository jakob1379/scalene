// App shell (DESIGN.md §2.1, §6.1.1, §8.3): page anatomy, lazy sections, empty-state
// switch, layer root, the Nav (jumpTo dispatcher) and global keys.
import type { Announcer, ModalManager } from "../core/a11y";
import { createAnnouncer, createModalManager } from "../core/a11y";
import type { Bus, Events, JumpOptions } from "../core/bus";
import { sectionHeader } from "../core/controls";
import { createDisposer, ensureById, h, isTypingTarget, VISUALLY_HIDDEN } from "../core/dom";
import { fmtLoc } from "../core/format";
import type { HostController } from "../core/host";
import type { LayoutController } from "../core/layout";
import type { MotionApi, MotionController } from "../core/motion";
import { idle, nextFrame } from "../core/schedule";
import { onStorageFailure } from "../core/storage";
import type { AppState, SectionId, Store, Target } from "../core/store";
import { profileStateReset } from "../core/store";
import type { ThemeApi, ThemeController } from "../core/theme";
import type { Toast } from "../core/toast";
import { createToasts } from "../core/toast";
import type { Tooltip, TooltipController } from "../core/tooltip";
import { createTooltip } from "../core/tooltip";
import { buildModel, type Model } from "../model/model";
import { parseProfileText } from "../model/normalize";
import { renderCombinedStacksTimeline } from "../scalene-gui";
import type { HostApi } from "../core/host";
import { createAiController, type AiController, type AiControllerHandle } from "./ai/controller";
import { mountAppBar, type AppBarHandle } from "./appbar";
import { mountCodeSection } from "./code/codesection";
import { mountMemory } from "./memory/memoryview";
import { mountOverview } from "./overview/overview";
import { emptyKind, mountEmpty, type EmptyKind } from "./shell/empty";
import { mountFooter } from "./shell/footer";
import { createReturnChip } from "./shell/returnchip";
import { mountLoader } from "./shell/loader";
import { createPalette } from "./shell/palette";
import { createShortcuts } from "./shell/shortcuts";
import { mountStacksSection } from "./stacks/stackssection";

// ── Contracts (§8.3) ────────────────────────────────────────────────────────────

export interface Nav {
  jumpTo(target: Target, opts?: JumpOptions): Promise<void>; // §4.8.12; mounts Code if needed
  /**
   * Scroll to a section and focus its heading. `toSelection` (app-bar nav, Sections menu,
   * palette): for Code with a selected line, return to that row instead of the section top.
   */
  showSection(id: SectionId, opts?: { focus?: boolean; tab?: "cpu" | "memory"; toSelection?: boolean }): Promise<void>;
  showInStacks(target: Target): Promise<void>; // §4.11.6
  showInTimeline(target: Target): Promise<void>;
  openInEditor(file: string, line: number): void; // host bridge (§7.4)
  /** Scroll to Code and open its file list with the files below 1% expanded (overview meta). */
  showHiddenFiles(): Promise<void>;
}
// Views register handlers the Nav calls (only the owning view implements them):
export interface CodeApi {
  reveal(target: Target, opts: JumpOptions): Promise<void>;
  currentFile(): string | null;
  /** Open the file list with the hidden (below 1%) group expanded. */
  showHiddenFiles(): void;
}
export interface StacksApi {
  focusLine(target: Target): void;
  selectTab(tab: "cpu" | "memory"): void;
}
export interface TimelineApi {
  focusLine(target: Target): void;
  setDomain(r: [number, number] | null, animate: boolean): void;
}

export interface ViewContext {
  model: Model;
  store: Store<AppState>;
  bus: Bus<Events>;
  nav: Nav;
  tooltip: Tooltip;
  toast: Toast;
  announce: Announcer;
  theme: ThemeApi;
  motion: MotionApi;
  host: HostApi;
  ai: AiController;
  registerApi(name: "code" | "stacks" | "timeline", api: CodeApi | StacksApi | TimelineApi): void;
}
export interface ViewHandle {
  destroy(): void;
}
export type MountFn = (host: HTMLElement, ctx: ViewContext) => ViewHandle;

// ── Shell contracts (model-independent pieces: loader, empty state, footer, palette) ──

export interface ShellActions {
  load(raw: unknown, meta?: { name?: string }): void;
  openFilePicker(): void;
  openPalette(): void;
  openShortcuts(): void;
  openAiSettings(focusField?: string): void;
  toggleTheme(): void;
  useSystemTheme(): void;
  setReducedMotion(on: boolean): void;
}

export interface ShellContext {
  store: Store<AppState>;
  bus: Bus<Events>;
  tooltip: TooltipController;
  toast: Toast;
  announce: Announcer;
  theme: ThemeController;
  motion: MotionController;
  host: HostController;
  modals: ModalManager;
  layerRoot: HTMLElement;
  fileInput: HTMLInputElement;
  meta: { version: string; date: string };
  model(): Model | null;
  nav(): Nav | null;
  ai(): AiController;
  actions: ShellActions;
}

export interface ShellViewHandle extends ViewHandle {
  update(): void;
}
export interface OverlayApi {
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface LoaderApi {
  loadFile(): void;
  loadDemo(): void;
  loadFetch(): void;
  destroy(): void;
}

export interface SectionInfo {
  id: SectionId;
  label: string;
}

export interface App {
  load(raw: unknown, meta?: { name?: string }): void;
  readonly shell: ShellContext;
  readonly loader: LoaderApi;
  model(): Model | null;
  nav(): Nav | null;
  codeApi(): CodeApi | null;
  stacksApi(): StacksApi | null;
  timelineApi(): TimelineApi | null;
  /** Mount a lazy section synchronously; false when the section is absent. */
  ensureSection(id: SectionId): boolean;
}

export interface AppDeps {
  host: HostController;
  bus: Bus<Events>;
  store: Store<AppState>;
  theme: ThemeController;
  motion: MotionController;
  layout: LayoutController;
}

// ── Sections ───────────────────────────────────────────────────────────────────

interface SectionDef {
  id: SectionId;
  label: string;
  title: string;
  preparing: string;
  mount: MountFn;
  reserve(model: Model): number;
}

interface SectionSlot {
  def: SectionDef;
  el: HTMLElement;
  handle: ViewHandle | null;
}

/** Extra section classes; `combined-stacks-section` is part of the upstream test contract (§7.5). */
const SECTION_CLASS: Partial<Record<SectionId, string>> = { stacks: "combined-stacks-section" };

function maxStackDepth(model: Model): number {
  return model.caps.stacks ? model.stackDepth.cpu : model.stackDepth.memory;
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: "overview",
    label: "Overview",
    title: "Overview",
    preparing: "",
    mount: mountOverview,
    reserve: () => 0,
  },
  {
    id: "code",
    label: "Code",
    title: "Code",
    preparing: "Preparing the code view…",
    mount: mountCodeSection,
    reserve: (m) => 208 + 24 * Math.min(40, m.files[0]?.lines.length ?? 0),
  },
  {
    id: "stacks",
    label: "Stacks",
    title: "Call stacks",
    preparing: "Preparing call stacks…",
    mount: mountStacksSection,
    reserve: (m) => 140 + 20 * Math.min(60, maxStackDepth(m) + 1),
  },
  {
    id: "timeline",
    label: "Timeline",
    title: "Timeline",
    preparing: "Preparing the timeline…",
    mount: renderCombinedStacksTimeline,
    reserve: () => 520,
  },
  {
    id: "memory",
    label: "Memory",
    title: "Memory",
    preparing: "Preparing the memory view…",
    mount: mountMemory,
    reserve: () => 420,
  },
];

/** Section presence rules (§2.1). */
export function presentSections(model: Model): SectionId[] {
  const ids: SectionId[] = ["overview", "code"];
  if (model.caps.stacks || model.caps.memStacks) ids.push("stacks");
  if (model.caps.timeline) ids.push("timeline");
  if (model.caps.memory && model.memory !== null && model.memory.peak > 0) ids.push("memory");
  return ids;
}

/** `""`, `{}`, a non-object, or no `files` entries → empty state (§4.16). */
export function isEmptyProfile(p: unknown): boolean {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return true;
  const files = (p as { files?: unknown }).files;
  return !files || typeof files !== "object" || Object.keys(files).length === 0;
}

const SAME_PROFILE_WINDOW_MS = 1000;
/**
 * With motion on, lazy sections start mounting after the overview intro settles (origin +
 * 900 ms, §5.2), so their mount work never stalls the intro's main-thread parts (count-ups,
 * the axis chip). A scroll, `jumpTo`, nav, the palette or a hash still mount at once.
 */
const LAZY_AFTER_INTRO_MS = 1050;

// ── App ────────────────────────────────────────────────────────────────────────

export function createApp(deps: AppDeps): App {
  const { host, bus, store, theme, motion } = deps;
  const root = ensureById("scalene-app", () => {
    const el = h("div");
    document.body.prepend(el);
    return el;
  });
  root.classList.add("scalene-app");

  // Template footer (data-version / data-date), adopted and re-rendered by the footer view.
  const footerEl = ensureById("scalene-footer", () => {
    const el = h("footer");
    root.after(el);
    return el;
  });
  const meta = { version: footerEl.dataset.version ?? "", date: footerEl.dataset.date ?? "" };
  footerEl.classList.add("site-footer");
  if (footerEl.tagName !== "FOOTER") footerEl.setAttribute("role", "contentinfo");

  const layerRoot = ensureById("layer-root", () => h("div"));
  layerRoot.classList.add("layer-root");
  document.body.appendChild(layerRoot);

  const fileInput = ensureById("fileinput", () =>
    h("input", { type: "file", accept: ".json,application/json", hidden: true, tabindex: "-1" }),
  ) as HTMLInputElement;
  if (!fileInput.isConnected) layerRoot.appendChild(fileInput);

  const skipMain = h("a", { class: "skip-link", href: "#main" }, "Skip to main content");
  const skipCode = h("a", { class: "skip-link", href: "#code" }, "Skip to code");
  // A fragment link only scrolls; move focus to the Code heading too (screen-reader cursor,
  // Safari's sequential start point). showSection mounts the lazy section and focuses #code-h.
  skipCode.addEventListener("click", (ev) => {
    if (!nav || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    void nav.showSection("code", { focus: true });
  });
  const header = h("header", { class: "appbar" });
  const main = h("main", { id: "main", tabindex: "-1" });
  root.replaceChildren(skipMain, skipCode, header, main);

  const announcer = createAnnouncer(layerRoot);
  const tooltip = createTooltip(layerRoot);
  const toasts = createToasts(layerRoot);
  const modals = createModalManager(() => [root, footerEl]);
  onStorageFailure(() =>
    toasts.show({ kind: "info", text: "Settings can't be saved in this browser (storage blocked)" }),
  );

  let model: Model | null = null;
  let nav: Nav | null = null;
  const apis: { code: CodeApi | null; stacks: StacksApi | null; timeline: TimelineApi | null } = {
    code: null,
    stacks: null,
    timeline: null,
  };
  let slots = new Map<SectionId, SectionSlot>();
  let viewCtx: ViewContext | null = null;
  let profileDisposer = createDisposer();
  let emptyHandle: ViewHandle | null = null;
  let lastRaw: unknown = undefined;
  let lastLoadAt = 0;
  /** Error toasts of failed loads: persistent (§4.18) until the next load succeeds. */
  let loadErrors: (() => void)[] = [];
  const loadError = (text: string) => loadErrors.push(toasts.show({ kind: "error", text }));

  const actions: ShellActions = {
    load: (r, m) => load(r, m),
    openFilePicker: () => fileInput.click(),
    openPalette: () => palette.open(),
    openShortcuts: () => shortcuts.open(),
    openAiSettings: (field) => ai.openSettings(field),
    toggleTheme: () => theme.toggle(),
    useSystemTheme: () => theme.set("system"),
    setReducedMotion: (on) => motion.setPreference(on ? true : null),
  };

  const shell: ShellContext = {
    store,
    bus,
    tooltip,
    toast: toasts,
    announce: announcer,
    theme,
    motion,
    host,
    modals,
    layerRoot,
    fileInput,
    meta,
    model: () => model,
    nav: () => nav,
    ai: () => ai,
    actions,
  };

  const ai: AiControllerHandle = createAiController(shell);
  const returnChip = createReturnChip(layerRoot);
  const loader = mountLoader(shell);
  const palette = createPalette(shell);
  const shortcuts = createShortcuts(shell);
  const appbar: AppBarHandle = mountAppBar(header, shell);
  const footer = mountFooter(footerEl, shell);

  // Core singletons → store (one place keeps durable state in sync).
  bus.on("theme:changed", ({ theme: t }) => store.set({ theme: t, themeSource: theme.source() }));
  bus.on("motion:changed", ({ reduced }) => store.set({ reducedMotion: reduced }));
  bus.on("layout:changed", (layout) => {
    theme.invalidate(); // responsive token overrides changed
    store.set({ layout });
  });

  // ── Lazy section mounting ────────────────────────────────────────────────────

  const mountSlot = (slot: SectionSlot) => {
    if (slot.handle || !viewCtx) return;
    slot.el.replaceChildren();
    slot.el.removeAttribute("aria-busy");
    try {
      slot.handle = slot.def.mount(slot.el, viewCtx);
    } catch (e) {
      slot.handle = { destroy() {} };
      slot.el.append(h("p", { class: "section-error" }, `This section could not be displayed: ${e instanceof Error ? e.message : String(e)}`));
      setTimeout(() => {
        throw e;
      });
    }
  };

  const ensureSection = (id: SectionId): boolean => {
    const slot = slots.get(id);
    if (!slot) return false;
    mountSlot(slot);
    return true;
  };

  const placeholder = (def: SectionDef, m: Model): HTMLElement => {
    const el = h("section", {
      id: def.id,
      class: ["report-section", SECTION_CLASS[def.id] ?? ""],
      "aria-labelledby": `${def.id}-h`,
      "aria-busy": "true",
    });
    const title = def.id === "stacks" && !m.caps.stacks ? "Memory stacks" : def.title;
    el.append(
      sectionHeader({ section: def.id, title }),
      h("div", { class: "section-placeholder", style: { height: `${def.reserve(m)}px` } }, def.preparing),
    );
    return el;
  };

  const scheduleLazyMounts = (lazy: SectionSlot[]) => {
    if (motion.instant) {
      startLazyMounts(lazy);
      return;
    }
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      window.clearTimeout(timer);
      window.removeEventListener("scroll", go);
      startLazyMounts(lazy);
    };
    const timer = window.setTimeout(go, LAZY_AFTER_INTRO_MS);
    window.addEventListener("scroll", go, { passive: true });
    profileDisposer.add(() => {
      started = true;
      window.clearTimeout(timer);
      window.removeEventListener("scroll", go);
    });
  };

  const startLazyMounts = (lazy: SectionSlot[]) => {
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const slot = lazy.find((s) => s.el === e.target);
            if (slot) mountSlot(slot);
            io.unobserve(e.target);
          }
        },
        { rootMargin: "100% 0px" },
      );
      for (const s of lazy) io.observe(s.el);
      profileDisposer.add(() => io.disconnect());
    }
    // Idle mounting, one section per idle period, so no single task gets long.
    let i = 0;
    const next = () => {
      while (i < lazy.length && lazy[i].handle) i++;
      if (i >= lazy.length) {
        performance.mark("scalene:idle-done");
        return;
      }
      mountSlot(lazy[i++]);
      cancelIdle = idle(next);
    };
    let cancelIdle = idle(next);
    profileDisposer.add(() => cancelIdle());
  };

  // ── Nav ─────────────────────────────────────────────────────────────────────

  const scrollBehavior = (): ScrollBehavior => (motion.reduced || motion.still ? "auto" : "smooth");

  const focusHeading = (id: SectionId) => {
    const heading = document.getElementById(`${id}-h`);
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  };

  // ── Way back after a cross-view jump (round 1: no-way-back-after-show-in) ──────

  interface Origin {
    y: number;
    target: { file: string; line: number } | null;
    focus: HTMLElement | null;
    label: string;
  }
  let origin: Origin | null = null;

  const sectionAt = (el: Element | null): SectionId | null => {
    for (const [id, slot] of slots) if (el && slot.el.contains(el)) return id;
    let current: SectionId | null = null;
    for (const [id, slot] of slots) if (slot.el.getBoundingClientRect().top <= 96) current = id;
    return current ?? (slots.keys().next().value as SectionId | undefined) ?? null;
  };

  /** Where a Show in stacks / timeline starts: the selected code row, else scroll + focus. */
  const captureOrigin = (): Origin => {
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const section = sectionAt(active);
    const sel = store.get().selection;
    const line = sel && "line" in sel && model?.fileByName.has(sel.file) ? { file: sel.file, line: sel.line } : null;
    if (section === "code" && line) return { y: window.scrollY, target: line, focus: active, label: fmtLoc(line.file, line.line) };
    const def = SECTIONS.find((d) => d.id === section);
    return { y: window.scrollY, target: null, focus: active, label: def ? def.label : "where you were" };
  };

  const restore = (o: Pick<Origin, "y" | "target" | "focus">) => {
    returnChip.hide();
    if (!nav) return;
    if (o.target && model?.fileByName.has(o.target.file)) {
      void nav.jumpTo(o.target, { open: false, flash: false, focus: true });
      return;
    }
    window.scrollTo({ top: o.y, behavior: scrollBehavior() });
    if (o.focus?.isConnected) o.focus.focus({ preventScroll: true });
  };

  /**
   * Same-document history: the start of a cross-view jump gets an "origin" entry and the jump a
   * "jump" entry, so browser Back returns (popstate below). Repeated jumps replace the jump entry.
   */
  const recordJump = (o: Origin, to: SectionId) => {
    origin = o;
    try {
      const st = history.state as { scalene?: string } | null;
      if (st && st.scalene === "jump") history.replaceState({ scalene: "jump", to }, "", `#${to}`);
      else {
        history.replaceState({ scalene: "origin", y: o.y, target: o.target }, "");
        history.pushState({ scalene: "jump", to }, "", `#${to}`);
      }
    } catch {
      // Sandboxed iframes may refuse history access; the chip still works.
    }
    returnChip.show(o.label, () => {
      try {
        if ((history.state as { scalene?: string } | null)?.scalene === "jump") {
          history.back(); // popstate restores
          return;
        }
      } catch {
        // fall through
      }
      if (origin) restore(origin);
    });
  };

  window.addEventListener("popstate", (ev) => {
    const st = ev.state as { scalene?: string; y?: number; target?: { file: string; line: number } | null; to?: SectionId } | null;
    if (!st || !st.scalene || !model) return;
    if (st.scalene === "origin") {
      const o = origin ?? { y: st.y ?? 0, target: st.target ?? null, focus: null };
      origin = null;
      restore(o);
    } else if (st.scalene === "jump" && st.to && slots.has(st.to)) {
      returnChip.hide();
      const slot = slots.get(st.to);
      if (slot) {
        mountSlot(slot);
        slot.el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      }
    }
  });

  const createNav = (): Nav => {
    const reveal = (id: SectionId) => {
      const slot = slots.get(id);
      if (!slot) return;
      mountSlot(slot);
      slot.el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    };
    const navApi: Nav = {
      async jumpTo(target, opts = {}) {
        returnChip.hide();
        const o: JumpOptions = { focus: true, open: true, flash: true, ...opts };
        if (!model?.fileByName.has(target.file)) {
          // Frames from files outside the profile cannot jump (§4.0.8).
          toasts.show({ kind: "info", text: "This file is not in the profile" });
          return;
        }
        if (!ensureSection("code")) return;
        if (apis.code) await apis.code.reveal(target, o);
        else reveal("code");
      },
      async showSection(id, opts = {}) {
        const slot = slots.get(id);
        if (!slot) return;
        returnChip.hide();
        const sel = store.get().selection;
        if (id === "code" && opts.toSelection && sel && "line" in sel && model?.fileByName.has(sel.file)) {
          // Back to the line being read, not ~2,000 px above it at the section top.
          await navApi.jumpTo(sel, { open: false, flash: false, focus: opts.focus !== false });
          try {
            history.replaceState(null, "", "#code");
          } catch {
            // see below
          }
          return;
        }
        mountSlot(slot);
        if (opts.tab) apis.stacks?.selectTab(opts.tab);
        slot.el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        if (opts.focus !== false) focusHeading(id);
        try {
          history.replaceState(null, "", `#${id}`);
        } catch {
          // Sandboxed iframes may refuse history access; the hash is a convenience.
        }
      },
      async showInStacks(target) {
        if (!slots.has("stacks")) return;
        recordJump(captureOrigin(), "stacks");
        if (!ensureSection("stacks")) return;
        apis.stacks?.selectTab("cpu");
        apis.stacks?.focusLine(target);
        bus.emit("stacks:show", { target });
        reveal("stacks");
      },
      async showInTimeline(target) {
        if (!slots.has("timeline")) return;
        recordJump(captureOrigin(), "timeline");
        if (!ensureSection("timeline")) return;
        apis.timeline?.focusLine(target);
        bus.emit("timeline:show", { target });
        reveal("timeline");
      },
      openInEditor: (file, line) => host.openInEditor(file, line),
      async showHiddenFiles() {
        await navApi.showSection("code", { focus: false });
        // The file list opens once the scroll has settled: the popover closes on scroll.
        await new Promise<void>((resolve) => {
          const done = () => {
            window.removeEventListener("scrollend", done);
            resolve();
          };
          if ("onscrollend" in globalThis) window.addEventListener("scrollend", done);
          window.setTimeout(done, "onscrollend" in globalThis ? 1200 : 700);
        });
        apis.code?.showHiddenFiles();
      },
    };
    return navApi;
  };

  // ── load() ──────────────────────────────────────────────────────────────────

  const teardown = () => {
    returnChip.hide();
    origin = null;
    for (const slot of Array.from(slots.values())) slot.handle?.destroy();
    slots = new Map();
    profileDisposer.dispose();
    profileDisposer = createDisposer();
    emptyHandle?.destroy();
    emptyHandle = null;
    apis.code = apis.stacks = apis.timeline = null;
    viewCtx = null;
    nav = null;
    tooltip.hide();
    main.replaceChildren();
  };

  const parse = (input: unknown, name: string): { ok: true; value: unknown } | { ok: false; message: string } => {
    if (typeof input !== "string") return { ok: true, value: input };
    if (input.trim() === "") return { ok: true, value: "" };
    const r = parseProfileText(input);
    if (r.ok) return r;
    loadError(`Couldn't load ${name}: ${r.message}`);
    return r;
  };

  const renderEmpty = (kind: EmptyKind = "none", detail?: string) => {
    model = null;
    root.classList.add("is-empty");
    skipCode.hidden = true;
    emptyHandle = mountEmpty(main, shell, { kind, detail });
    appbar.setModel(null, []);
    document.title = "Scalene";
  };

  const renderReport = (m: Model) => {
    model = m;
    root.classList.remove("is-empty");
    nav = createNav();
    viewCtx = {
      model: m,
      store,
      bus,
      nav,
      tooltip,
      toast: toasts,
      announce: announcer,
      theme,
      motion,
      host,
      ai,
      registerApi(name, api) {
        if (name === "code") apis.code = api as CodeApi;
        else if (name === "stacks") apis.stacks = api as StacksApi;
        else apis.timeline = api as TimelineApi;
      },
    };
    const present = new Set(presentSections(m));
    const defs = SECTIONS.filter((d) => present.has(d.id));
    for (const def of defs) {
      const el =
        def.id === "overview"
          ? h("section", { id: "overview", class: "report-section", "aria-labelledby": "overview-h" })
          : placeholder(def, m);
      main.appendChild(el);
      slots.set(def.id, { def, el, handle: null });
    }
    skipCode.hidden = !present.has("code");
    appbar.setModel(
      m,
      defs.map((d) => ({ id: d.id, label: d.label })),
    );
    document.title = m.program ? `Scalene - ${m.program}` : "Scalene";
    const overview = slots.get("overview");
    if (overview) mountSlot(overview);
    scheduleLazyMounts(Array.from(slots.values()).filter((s) => s.def.id !== "overview"));
  };

  const jumpToHashAfterPaint = async () => {
    await nextFrame();
    performance.mark("scalene:overview");
    const id = location.hash.slice(1) as SectionId;
    if (id && id !== "overview" && slots.has(id)) void nav?.showSection(id, { focus: false });
  };

  function load(input: unknown, loadMeta: { name?: string } = {}): void {
    performance.mark("scalene:load");
    const parsed = parse(input, loadMeta.name ?? "profile");
    if (!parsed.ok) {
      // §4.15: the current report stays; a first load falls back to the empty state (never a
      // blank page with aria-busy stuck on).
      if (!model && !emptyHandle) {
        teardown();
        renderEmpty("error", parsed.message);
        footer.update();
      }
      root.removeAttribute("aria-busy");
      return;
    }
    const value = parsed.value;
    const now = performance.now();
    if (value !== null && typeof value === "object" && value === lastRaw && now - lastLoadAt < SAME_PROFILE_WINDOW_MS) return;
    let built: Model | null = null;
    if (!isEmptyProfile(value)) {
      try {
        built = buildModel(value, { version: meta.version, date: meta.date });
        performance.mark("scalene:model");
      } catch (e) {
        loadError(`Couldn't read this profile: ${e instanceof Error ? e.message : String(e)}`);
        console.error(e);
        // §4.15: the current report stays (only a first load falls through to the empty state).
        if (model) return;
      }
    }
    lastRaw = value;
    lastLoadAt = now;
    (globalThis as { profile?: unknown }).profile = value;

    teardown();
    store.update(profileStateReset);
    root.setAttribute("aria-busy", "true");
    try {
      if (built) {
        for (const dismiss of loadErrors.splice(0)) dismiss();
        renderReport(built);
      } else renderEmpty(isEmptyProfile(value) ? emptyKind(value) : "error");
      ai.load(built);
      footer.update();
    } finally {
      root.removeAttribute("aria-busy");
    }
    if (built) {
      bus.emit("profile:loaded", { model: built });
      void jumpToHashAfterPaint();
    }
  }

  // ── Global keys (§6.2.3) ────────────────────────────────────────────────────

  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented) return;
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && !ev.altKey && ev.key.toLowerCase() === "k") {
      if (!model) return;
      ev.preventDefault();
      actions.openPalette();
      return;
    }
    if (mod || ev.altKey || isTypingTarget(ev.target) || modals.topmost()) return;
    if (ev.key === "/" && model) {
      ev.preventDefault();
      actions.openPalette();
    } else if (ev.key === "?" && model) {
      ev.preventDefault();
      actions.openShortcuts();
    } else if (ev.key === "Escape") {
      const s = store.get();
      if (s.selection) store.set({ selection: null });
      else if (s.range) {
        store.set({ range: null });
        bus.emit("range:set", { range: null, source: "global" });
      }
    }
  });

  // Visually hidden note for assistive tech while the first load is pending.
  main.append(h("p", { class: VISUALLY_HIDDEN }, "Loading profile…"));

  return {
    load,
    shell,
    loader,
    model: () => model,
    nav: () => nav,
    codeApi: () => apis.code,
    stacksApi: () => apis.stacks,
    timelineApi: () => apis.timeline,
    ensureSection,
  };
}
