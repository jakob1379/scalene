// Upstream-compatible facade (DESIGN.md §7.3, §7.5): the window globals hosts and old
// HTML call, plus the test-contract names. Everything delegates to the app and to the
// APIs the views register; nothing here renders on its own.
import { pickNiceTickInterval, formatTimelineTickLabel, formatMemoryTickLabel,
  renderTimelineAxis, renderTimelineGridlines, renderMemoryAxis, renderMemoryGridlines } from "./charts/axis";
import { makeFileSourceLookup, type SourceLookup } from "./model/source";
import { mountTimeline, renderTimelineFrames, type TimelineMount } from "./views/timeline/timeline";
import { decodeFilename } from "./core/host";
import type { DisplayMode, SectionId } from "./core/store";
import type { App, ViewContext } from "./views/app";

export function renderCombinedStacksTimeline(host: HTMLElement, ctx: ViewContext): TimelineMount {
  const sourceLookup = makeFileSourceLookup(ctx.model);
  return renderTimelineContent(host, ctx, sourceLookup);
}

function renderTimelineContent(host: HTMLElement, ctx: ViewContext, sourceLookup: SourceLookup): TimelineMount {
  // dispatches Lanes / Interleaved / single-thread; frames are drawn by renderTimelineFrames(…, sourceLookup)
  return mountTimeline(host, ctx, { sourceLookup, drawFrames: renderTimelineFrames });
}

/** Axis helpers, re-exported for hosts and tests that import them from the entry. */
export { pickNiceTickInterval, formatTimelineTickLabel, formatMemoryTickLabel,
  renderTimelineAxis, renderTimelineGridlines, renderMemoryAxis, renderMemoryGridlines };

/** Drawer handlers behind the legacy AI globals (registered by views/ai, WP5). */
export interface LegacyAiHandlers {
  toggleServiceFields(): void;
  togglePassword(btn: HTMLElement): void;
  toggleAdvanced(el: HTMLElement): void;
  refreshOpenAIModels(): void;
  refreshGeminiModels(): void;
  checkApiKey(value: string): void;
}

const aiHandlers: Partial<LegacyAiHandlers> = {};

export function registerLegacyAiHandlers(handlers: Partial<LegacyAiHandlers>): void {
  Object.assign(aiHandlers, handlers);
}

const DISPLAY_MODES: readonly DisplayMode[] = ["profiled-functions", "profiled-lines", "all"];

/** "file-N" → the file whose upstream `fileIteration` number is N. */
function fileById(app: App, id: string): string | null {
  const n = Number(/^file-(\d+)$/.exec(id)?.[1]);
  const file = app.model()?.files.concat(app.model()?.hiddenFiles ?? []).find((f) => f.no === n);
  return file ? file.name : null;
}

function setAllModes(app: App, mode: DisplayMode): void {
  const model = app.model();
  if (!model) return;
  const store = app.shell.store;
  store.update((s) => {
    const perFile = { ...s.code.perFile };
    for (const f of [...model.files, ...model.hiddenFiles]) {
      perFile[f.name] = { mode, sort: perFile[f.name]?.sort ?? null, unfolded: [] };
    }
    return { code: { ...s.code, perFile } };
  });
}

function setFileMode(app: App, file: string, mode: DisplayMode): void {
  app.shell.store.update((s) => ({
    code: {
      ...s.code,
      perFile: { ...s.code.perFile, [file]: { mode, sort: s.code.perFile[file]?.sort ?? null, unfolded: [] } },
    },
  }));
}

function showSection(app: App, id: SectionId, tab?: "cpu" | "memory"): void {
  void app.nav()?.showSection(id, { focus: true, tab });
}

function proposeOptimization(app: App, fname: string, fileNo: number, encodedLine: string, mode: "line" | "region"): void {
  const model = app.model();
  if (!model) return;
  let name = unescape(fname);
  if (!model.fileByName.has(name)) name = fileById(app, `file-${fileNo}`) ?? name;
  let lineno = NaN;
  try {
    lineno = Number((JSON.parse(decodeURIComponent(encodedLine)) as { lineno?: unknown }).lineno);
  } catch {
    lineno = Number(encodedLine);
  }
  if (!model.fileByName.has(name) || !Number.isFinite(lineno)) return;
  app.shell.ai().request(name, lineno, mode);
}

/** Install the window globals of §7.3. The bundle never calls `load` itself. */
export function installGlobals(app: App): void {
  const { host } = app.shell;
  const globals: Record<string, unknown> = {
    load: (profile: unknown) => app.load(profile),
    vsNavigate(filename: string, lineno: number | string) {
      const line = Math.trunc(Number(lineno));
      if (host.isVsCode) {
        // `filename` is already escape()-encoded, exactly what the extension expects.
        host.post({ command: "jumpToLine", filePath: filename, lineNumber: line });
        return;
      }
      const decoded = decodeFilename(filename);
      if (app.model()?.fileByName.has(decoded)) {
        void app.nav()?.jumpTo({ file: decoded, line }, { source: "code" });
      } else {
        location.href = `vscode://file/${decoded}:${line}:1`;
      }
    },
    proposeOptimizationLine: (fname: string, fileNo: number, encodedLineJSON: string) =>
      proposeOptimization(app, fname, fileNo, encodedLineJSON, "line"),
    proposeOptimizationRegion: (fname: string, fileNo: number, encodedLineJSON: string) =>
      proposeOptimization(app, fname, fileNo, encodedLineJSON, "region"),
    expandAll: () => setAllModes(app, "all"),
    collapseAll: () => setAllModes(app, "profiled-lines"),
    toggleDisplay(id: string) {
      const file = fileById(app, id);
      if (!file) return;
      app.shell.store.update((s) => ({ code: { ...s.code, file } }));
      showSection(app, "code");
    },
    onFileDisplayModeChange(id: string) {
      const file = fileById(app, id);
      const el = document.getElementById(`display-mode-${id}`) as (HTMLElement & { value?: unknown }) | null;
      const mode = el?.value as DisplayMode | undefined;
      if (file && mode && DISPLAY_MODES.includes(mode)) setFileMode(app, file, mode);
    },
    toggleCombinedStacks: () => showSection(app, "stacks", "cpu"),
    toggleMemoryStacks: () => showSection(app, "stacks", "memory"),
    toggleCombinedStacksTimeline: () => showSection(app, "timeline"),
    changeTimelineViewMode(selectEl: { value: string }) {
      const v = String(selectEl?.value ?? "");
      app.ensureSection("timeline");
      app.shell.store.update((s) => {
        if (v === "interleaved") return { timeline: { ...s.timeline, view: "interleaved", thread: "all" } };
        if (v === "swimlanes") return { timeline: { ...s.timeline, view: "lanes", thread: "all" } };
        return { timeline: { ...s.timeline, thread: v } };
      });
    },
    loadFile: () => app.loader.loadFile(),
    loadDemo: () => app.loader.loadDemo(),
    loadFetch: () => app.loader.loadFetch(),
    toggleServiceFields: () => aiHandlers.toggleServiceFields?.(),
    togglePassword: (btn: HTMLElement) => aiHandlers.togglePassword?.(btn),
    toggleAdvanced: (el: HTMLElement) => aiHandlers.toggleAdvanced?.(el),
    refreshOpenAIModels: () => aiHandlers.refreshOpenAIModels?.(),
    refreshGeminiModels: () => aiHandlers.refreshGeminiModels?.(),
    checkApiKey: (value: string) => aiHandlers.checkApiKey?.(value),
    toggleReduced: () => undefined, // legacy no-op, kept for back-compat
  };
  Object.assign(window as unknown as Record<string, unknown>, globals);
}
