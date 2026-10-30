// Host integration: VS Code webview bridge, editor links, server heartbeat, query flags.
// DESIGN.md §2.5, §7.2, §7.4.

export interface HostApi {
  readonly isVsCode: boolean;
  readonly isHttp: boolean;
  openInEditor(rawFile: string, line: number): void;
  flags: { still: boolean; motion: "reduce" | null; perf: boolean };
}

export interface HostController extends HostApi {
  /** Post a message to the VS Code extension (no-op outside VS Code). */
  post(message: unknown): void;
  /**
   * Start the 10 s heartbeat (http(s) pages only). Idempotent. It stops after the first
   * failed or non-ok answer: `scalene view` always answers 200, so a failure means the host
   * (e.g. the Jupyter iframe server) has no keep-alive endpoint, and retrying would only log
   * a network error every 10 s.
   */
  startHeartbeat(): void;
  /**
   * Result of the first heartbeat (starts it if needed): true when the page is served by a
   * Scalene server that answers /heartbeat; false on file://, in VS Code or Jupyter.
   */
  probe(): Promise<boolean>;
  destroy(): void;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

const HEARTBEAT_MS = 10_000;

let cachedVsCode: VsCodeApi | null | undefined;

/** acquireVsCodeApi() may be called only once per webview: cache the result. */
function vscodeApi(): VsCodeApi | null {
  if (cachedVsCode !== undefined) return cachedVsCode;
  try {
    cachedVsCode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  } catch {
    cachedVsCode = null;
  }
  return cachedVsCode;
}

function hasVsCode(): boolean {
  try {
    return typeof acquireVsCodeApi === "function";
  } catch {
    return false;
  }
}

/** Parse the test/debug switches `?motion=reduce`, `?still`, `?perf`. */
export function readFlags(search: string): HostApi["flags"] {
  const q = new URLSearchParams(search);
  return {
    still: q.has("still"),
    motion: q.get("motion") === "reduce" ? "reduce" : null,
    perf: q.has("perf"),
  };
}

export function createHost(): HostController {
  const isHttp = location.protocol === "http:" || location.protocol === "https:";
  const isVsCode = hasVsCode();
  let heartbeat = 0;
  let started = false;
  let resolveProbe: (ok: boolean) => void = () => {};
  const probed = new Promise<boolean>((r) => (resolveProbe = r));

  const post = (message: unknown) => {
    vscodeApi()?.postMessage(message);
  };

  return {
    isVsCode,
    isHttp,
    flags: readFlags(location.search),
    post,
    openInEditor(rawFile, line) {
      if (isVsCode) {
        // Same shape upstream sent: the extension expects escape()-encoded paths.
        post({ command: "jumpToLine", filePath: escape(rawFile), lineNumber: Math.trunc(line) });
        return;
      }
      location.href = `vscode://file/${rawFile}:${Math.trunc(line)}:1`;
    },
    startHeartbeat() {
      if (started) return;
      started = true;
      if (!isHttp || typeof fetch !== "function") {
        resolveProbe(false);
        return;
      }
      const stop = () => {
        if (heartbeat) window.clearInterval(heartbeat);
        heartbeat = 0;
      };
      let first = true;
      const beat = () => {
        fetch("/heartbeat", { cache: "no-store" }).then(
          (res) => {
            if (first) resolveProbe(res.ok);
            first = false;
            if (!res.ok) stop();
          },
          () => {
            if (first) resolveProbe(false);
            first = false;
            stop();
          },
        );
      };
      beat();
      heartbeat = window.setInterval(beat, HEARTBEAT_MS);
    },
    probe() {
      this.startHeartbeat();
      return probed;
    },
    destroy() {
      if (heartbeat) window.clearInterval(heartbeat);
      heartbeat = 0;
      resolveProbe(false);
    },
  };
}

/**
 * Decode a filename that upstream passed through `escape()` (and some hosts through
 * `encodeURIComponent`). Non-ASCII `%uXXXX` sequences need `unescape`.
 */
export function decodeFilename(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    try {
      return unescape(encoded);
    } catch {
      return encoded;
    }
  }
}
