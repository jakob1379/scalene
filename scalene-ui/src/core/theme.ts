// Theme resolution, persistence and the token cache canvas code reads (DESIGN.md §3.1–3.2, §4.1.6).
//
// Resolution: stored choice → VS Code body class → prefers-color-scheme. The result is
// written to <html data-theme>. Without a stored choice the app follows live changes of
// the media query and of the VS Code body class.
import { STORAGE_KEYS, storageGet, storageRemove, storageSet } from "./storage";

export type ThemeName = "light" | "dark";
export type ThemeSource = "user" | "system" | "vscode";

export interface ThemeApi {
  current(): ThemeName;
  set(choice: ThemeName | "system"): void;
  tokens(): Readonly<Record<string, string>>; // e.g. tokens()["cpu-py"], ["font-mono"]; cached per theme
  num(name: string): number; // numeric tokens, e.g. "glow", "frame-dim"
}

export interface ThemeController extends ThemeApi {
  source(): ThemeSource;
  toggle(): void;
  /** Drop cached token values (theme or responsive overrides changed). */
  invalidate(): void;
  destroy(): void;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function storedChoice(): ThemeName | null {
  const v = storageGet(STORAGE_KEYS.theme);
  return v === "light" || v === "dark" ? v : null;
}

function vscodeTheme(): { theme: ThemeName; highContrast: boolean } | null {
  const b = document.body;
  if (!b) return null;
  if (b.classList.contains("vscode-high-contrast")) {
    return { theme: b.classList.contains("vscode-high-contrast-light") ? "light" : "dark", highContrast: true };
  }
  if (b.classList.contains("vscode-dark")) return { theme: "dark", highContrast: false };
  if (b.classList.contains("vscode-light")) return { theme: "light", highContrast: false };
  return null;
}

function systemTheme(): ThemeName {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

interface Resolved {
  theme: ThemeName;
  source: ThemeSource;
  highContrast: boolean;
}

export function resolveTheme(): Resolved {
  const vs = vscodeTheme();
  const stored = storedChoice();
  if (stored) return { theme: stored, source: "user", highContrast: vs?.highContrast ?? false };
  if (vs) return { theme: vs.theme, source: "vscode", highContrast: vs.highContrast };
  return { theme: systemTheme(), source: "system", highContrast: false };
}

function applyTheme(r: Resolved): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", r.theme);
  if (r.highContrast) root.setAttribute("data-contrast", "high");
  else root.removeAttribute("data-contrast");
}

/**
 * @param onChange called synchronously after the theme attribute changed and the token
 *   cache was invalidated (the shell emits `theme:changed` from it).
 */
export function createTheme(onChange: (theme: ThemeName, source: ThemeSource) => void): ThemeController {
  let resolved = resolveTheme();
  applyTheme(resolved);

  let style: CSSStyleDeclaration | null = null;
  // One token cache per theme (and contrast): toggling back and forth reuses the values read
  // the first time, so a toggle no longer forces a style recalculation from script for every
  // token every view reads (round 1: theme toggle over the 60 ms budget on ml-training).
  const caches = new Map<string, Map<string, string>>();
  const cacheFor = (r: Resolved): Map<string, string> => {
    const key = `${r.theme}|${r.highContrast ? "hc" : ""}`;
    let c = caches.get(key);
    if (!c) caches.set(key, (c = new Map()));
    return c;
  };
  let cache = cacheFor(resolved);
  const read = (name: string): string => {
    let v = cache.get(name);
    if (v === undefined) {
      style ??= getComputedStyle(document.documentElement);
      v = style.getPropertyValue(`--${name}`).trim();
      cache.set(name, v);
    }
    return v;
  };
  const tokenView: Readonly<Record<string, string>> = new Proxy({} as Record<string, string>, {
    get: (_t, key) => (typeof key === "string" ? read(key) : undefined),
    has: (_t, key) => typeof key === "string" && read(key) !== "",
  });

  /** Responsive token overrides changed: every theme's values may differ now. */
  const invalidate = () => {
    caches.clear();
    cache = cacheFor(resolved);
    style = null;
  };

  const commit = (next: Resolved) => {
    const changed = next.theme !== resolved.theme || next.highContrast !== resolved.highContrast;
    resolved = next;
    applyTheme(next);
    if (!changed) return;
    cache = cacheFor(next);
    style = null;
    onChange(next.theme, next.source);
  };

  // Follow the system / VS Code only while no explicit choice is stored.
  const followSystem = () => {
    if (resolved.source !== "user") commit(resolveTheme());
  };
  const mql = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  mql?.addEventListener("change", followSystem);
  let observer: MutationObserver | null = null;
  if (document.body && typeof MutationObserver === "function") {
    observer = new MutationObserver(followSystem);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  const api: ThemeController = {
    current: () => resolved.theme,
    source: () => resolved.source,
    set(choice) {
      if (choice === "system") {
        storageRemove(STORAGE_KEYS.theme);
        commit(resolveTheme());
        return;
      }
      storageSet(STORAGE_KEYS.theme, choice);
      commit({ theme: choice, source: "user", highContrast: resolved.highContrast });
    },
    toggle() {
      api.set(resolved.theme === "dark" ? "light" : "dark");
    },
    tokens: () => tokenView,
    num(name) {
      const v = parseFloat(read(name));
      return Number.isFinite(v) ? v : 0;
    },
    invalidate,
    destroy() {
      mql?.removeEventListener("change", followSystem);
      observer?.disconnect();
    },
  };
  return api;
}
