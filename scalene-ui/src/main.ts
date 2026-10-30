// Bundle entry (DESIGN.md §8.2): inject CSS, initialise host/theme/motion/layout before the
// first paint, create the app shell, install the window globals. The bundle never calls
// load() itself: the template (or the embedding host) does, exactly once.
import { createBus, type Events } from "./core/bus";
import { createHost } from "./core/host";
import { createLayout } from "./core/layout";
import { createMotion } from "./core/motion";
import { createStore, initialAppState, type AppState } from "./core/store";
import { STORAGE_KEYS, storageGet } from "./core/storage";
import { createTheme } from "./core/theme";
import { CSS } from "./generated/styles";
import { installGlobals } from "./scalene-gui";
import { createApp } from "./views/app";

const STYLE_ID = "scalene-ui-css";

function injectCss(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

let pending: { profile: unknown } | null = null;

/** `?perf`: record long tasks and slow events for the perf scripts (§6.1.8). */
function installPerfObserver(): void {
  const log: { longtasks: PerformanceEntry[]; events: PerformanceEntry[] } = { longtasks: [], events: [] };
  (window as unknown as { __scalenePerf: typeof log }).__scalenePerf = log;
  if (typeof PerformanceObserver !== "function") return;
  const observe = (type: string, into: PerformanceEntry[], extra: Record<string, unknown> = {}) => {
    try {
      new PerformanceObserver((list) => into.push(...list.getEntries())).observe({ type, buffered: true, ...extra });
    } catch {
      // Entry type not supported by this browser.
    }
  };
  observe("longtask", log.longtasks);
  observe("event", log.events, { durationThreshold: 16 });
}

function boot(): void {
  injectCss();
  const host = createHost();
  if (host.flags.perf) installPerfObserver();
  const bus = createBus<Events>();
  const theme = createTheme((t) => bus.emit("theme:changed", { theme: t }));
  const motion = createMotion(host.flags);
  motion.onMotionChange((reduced) => bus.emit("motion:changed", { reduced }));
  const layout = createLayout((l) => bus.emit("layout:changed", l));

  const state = initialAppState(layout.current(), theme.current(), motion.reduced);
  const wrap = storageGet(STORAGE_KEYS.codeWrap);
  if (wrap === "1" || wrap === "0") state.code.wrap = wrap === "1";
  state.themeSource = theme.source();
  const store = createStore<AppState>(state);

  const app = createApp({ host, bus, store, theme, motion, layout });
  installGlobals(app);
  host.startHeartbeat();
  if (pending) app.load(pending.profile);
}

if (document.body) {
  boot();
} else {
  // Loaded from <head> by a foreign host: queue a load() that arrives before the body.
  (window as unknown as { load: (p: unknown) => void }).load = (profile) => {
    pending = { profile };
  };
  document.addEventListener("DOMContentLoaded", boot, { once: true });
}
