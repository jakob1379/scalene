// Safe localStorage access. Storage can be blocked (private mode, sandboxed iframes):
// every call is wrapped, reads fall back to null, and the first failed write is reported once.

/** Every key the UI core persists (AI settings keys live in src/ai/settings.ts). */
export const STORAGE_KEYS = {
  theme: "scalene-theme",
  reducedMotion: "scalene-reduced-motion",
  codeWrap: "scalene-code-wrap",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

let failureListener: (() => void) | null = null;
let failureReported = false;

function backend(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function reportFailure(): void {
  if (failureReported) return;
  failureReported = true;
  failureListener?.();
}

export function storageGet(key: string): string | null {
  try {
    return backend()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false (and reports once) when the value could not be saved. */
export function storageSet(key: string, value: string): boolean {
  try {
    const s = backend();
    if (!s) throw new Error("no storage");
    s.setItem(key, value);
    return true;
  } catch {
    reportFailure();
    return false;
  }
}

export function storageRemove(key: string): void {
  try {
    backend()?.removeItem(key);
  } catch {
    // Nothing stored means nothing to remove.
  }
}

/** Register the one-time "storage blocked" notifier (the shell shows an info toast). */
export function onStorageFailure(cb: () => void): void {
  failureListener = cb;
}
