// Durable UI state (DESIGN.md §8.3). One store per page; views subscribe with selectors.

export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
export type DisplayMode = "profiled-functions" | "profiled-lines" | "all";
export type Metric = "time" | "memory" | "gpu" | "await";
export type ColumnKey =
  | "line"
  | "time"
  | "mem"
  | "gpu"
  | "await"
  | "idle"
  | "nrt"
  | "nc"
  | "trend"
  | "copy"
  | "gpumem"
  | "alloc"
  | "avg"
  | "source";
export interface SortState {
  key: ColumnKey;
  dir: "desc" | "asc";
}
export type Target = { file: string; line: number } | { file: string; fn: string };
export type SectionId = "overview" | "code" | "stacks" | "timeline" | "memory";
export type FlameColorMode = "kind" | "file" | "self";

export interface AppState {
  theme: "light" | "dark";
  themeSource: "user" | "system" | "vscode";
  reducedMotion: boolean;
  layout: { bp: Breakpoint; short: boolean; coarse: boolean };
  selection: Target | null; // sticky; drives lens/dock, scope overlay, outlines
  hover: Target | null; // transient linked highlight
  hotspots: { kind: "lines" | "functions" | "files"; metric: Metric; showAll: boolean };
  code: {
    file: string | null;
    view: "lines" | "functions";
    wrap: boolean;
    perFile: Record<string, { mode: DisplayMode; sort: SortState | null; unfolded: number[] }>;
  };
  flame: {
    tab: "cpu" | "memory";
    zoom: { cpu: string | null; memory: string | null };
    search: string;
    color: { cpu: FlameColorMode; memory: FlameColorMode };
  };
  timeline: {
    view: "lanes" | "interleaved";
    thread: string;
    domain: [number, number] | null;
    expanded: string[];
  };
  memory: { siteOrder: "peak" | "allocated"; site: { file: string; line: number } | null };
  range: [number, number] | null; // scope brush (seconds)
  layers: { drawer: boolean; palette: boolean; shortcuts: boolean; fileSheet: boolean };
}

export interface Store<S> {
  get(): S;
  set(patch: Partial<S>): void; // shallow merge + notify
  update(fn: (s: S) => Partial<S>): void;
  subscribe<T>(select: (s: S) => T, cb: (v: T, prev: T) => void): () => void; // fires on !Object.is
}

interface Sub<S> {
  select: (s: S) => unknown;
  cb: (v: unknown, prev: unknown) => void;
  last: unknown;
  live: boolean;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  let subs: Sub<S>[] = [];

  function notify(): void {
    for (const sub of subs.slice()) {
      if (!sub.live) continue;
      const v = sub.select(state);
      if (Object.is(v, sub.last)) continue;
      const prev = sub.last;
      sub.last = v;
      sub.cb(v, prev);
    }
  }

  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      notify();
    },
    update(fn) {
      state = { ...state, ...fn(state) };
      notify();
    },
    subscribe(select, cb) {
      const sub: Sub<S> = {
        select,
        cb: cb as (v: unknown, prev: unknown) => void,
        last: select(state),
        live: true,
      };
      subs.push(sub);
      return () => {
        sub.live = false;
        subs = subs.filter((s) => s !== sub);
      };
    },
  };
}

/** Initial state for a page; per-profile parts are reset by `resetProfileState`. */
export function initialAppState(layout: AppState["layout"], theme: AppState["theme"], reduced: boolean): AppState {
  return {
    theme,
    themeSource: "system",
    reducedMotion: reduced,
    layout,
    selection: null,
    hover: null,
    hotspots: { kind: "lines", metric: "time", showAll: false },
    code: { file: null, view: "lines", wrap: layout.bp === "xs", perFile: {} },
    flame: {
      tab: "cpu",
      zoom: { cpu: null, memory: null },
      search: "",
      color: { cpu: "kind", memory: "self" },
    },
    timeline: { view: "lanes", thread: "all", domain: null, expanded: [] },
    memory: { siteOrder: "peak", site: null },
    range: null,
    layers: { drawer: false, palette: false, shortcuts: false, fileSheet: false },
  };
}

/** The profile-dependent slice of the state, reset on every `load()`. */
export function profileStateReset(s: AppState): Partial<AppState> {
  const fresh = initialAppState(s.layout, s.theme, s.reducedMotion);
  return {
    selection: null,
    hover: null,
    hotspots: fresh.hotspots,
    code: { ...fresh.code, wrap: s.code.wrap },
    flame: fresh.flame,
    timeline: fresh.timeline,
    memory: fresh.memory,
    range: null,
  };
}

/** Structural equality for targets (selection/hover comparisons). */
export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.file !== b.file) return false;
  if ("line" in a && "line" in b) return a.line === b.line;
  if ("fn" in a && "fn" in b) return a.fn === b.fn;
  return false;
}
