// Load a profile (DESIGN.md §4.15): file picker, drag and drop anywhere (full-viewport
// overlay, M25), JSON parsing with validation, progress toast for large files, success and
// error toasts. A failed load never replaces the current report.
import { h } from "../../core/dom";
import { fmtMem } from "../../core/format";
import { icon } from "../../core/icons";
import { parseProfileText } from "../../model/normalize";
import type { LoaderApi, ShellContext } from "../app";

declare const example_profile: unknown;

/** Above this size a progress toast shows until the report renders. */
export const PROGRESS_BYTES = 2 * 1024 * 1024;

export type Validation = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** Parse and validate profile JSON text (§4.15). `{}` is valid (→ empty state). */
export function validateProfileText(text: string): Validation {
  // Python's NaN/±Infinity tokens are accepted (as absent values), like the template path.
  const r = parseProfileText(text);
  return r.ok ? validateProfile(r.value) : { ok: false, message: r.message };
}

export function validateProfile(value: unknown): Validation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "This JSON is not a Scalene profile (expected an object)" };
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return { ok: true, value: obj };
  const files = obj.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return { ok: false, message: 'This JSON is not a Scalene profile (no "files" section)' };
  }
  return { ok: true, value: obj };
}

/** "6 files" / "1 file". */
export function filesLabel(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
    reader.readAsText(file);
  });
}

const hasFiles = (ev: DragEvent): boolean => Array.from(ev.dataTransfer?.types ?? []).includes("Files");

export function mountLoader(shell: ShellContext): LoaderApi {
  // Failure toasts stay until dismissed or until a later profile loads (§4.15, §4.18).
  let failToasts: (() => void)[] = [];
  const offLoaded = shell.bus.on("profile:loaded", () => {
    for (const dismiss of failToasts.splice(0)) dismiss();
  });
  const fail = (name: string, message: string) => {
    failToasts.push(shell.toast.show({ kind: "error", text: `Couldn't load ${name}: ${message}` }));
    shell.announce.assertive(`Couldn't load ${name}`);
  };

  /** One pipeline for every entry point: text → validate → load → toast. */
  const ingest = async (name: string, text: Promise<string>, bytes: number | null): Promise<void> => {
    const progress =
      bytes !== null && bytes > PROGRESS_BYTES
        ? shell.toast.show({ kind: "info", text: `Reading ${name} · ${fmtMem(bytes / 1048576)}…`, sticky: true })
        : null;
    try {
      let raw: string;
      try {
        raw = await text;
      } catch (e) {
        fail(name, e instanceof Error ? e.message : String(e));
        return;
      }
      // Let the progress toast paint before the (synchronous) parse and render.
      if (progress) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const v = validateProfileText(raw);
      if (!v.ok) {
        fail(name, v.message);
        return;
      }
      shell.actions.load(v.value, { name });
      const model = shell.model();
      if (model) {
        shell.toast.show({ kind: "success", text: `Loaded ${name} · ${filesLabel(model.files.length)}` });
        window.scrollTo({ top: 0, behavior: "auto" });
      }
    } finally {
      progress?.();
    }
  };

  const loadFileObject = (file: File) => ingest(file.name || "profile.json", readAsText(file), file.size);

  const loadFile = () => {
    const file = shell.fileInput.files?.[0];
    if (!file) return;
    void loadFileObject(file).finally(() => {
      shell.fileInput.value = "";
    });
  };
  const onChange = () => loadFile();
  shell.fileInput.addEventListener("change", onChange);

  // ── Drag and drop anywhere (§4.15, M25) ───────────────────────────────────
  const overlay = h(
    "div",
    { class: "drop-overlay", hidden: true, "aria-hidden": "true" },
    h(
      "div",
      { class: "drop-panel" },
      h("span", { class: "drop-icon" }, icon("upload", 32)),
      h("p", { class: "drop-title" }, "Drop a Scalene profile (.json)"),
      h("p", { class: "drop-note" }, "If the file can't be read, the current report stays open."),
    ),
  );
  shell.layerRoot.appendChild(overlay);
  let depth = 0;
  const showOverlay = (on: boolean) => {
    overlay.hidden = !on;
    document.documentElement.classList.toggle("is-dragging-file", on);
  };
  const onDragEnter = (ev: DragEvent) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth++;
    showOverlay(true);
  };
  const onDragOver = (ev: DragEvent) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    if (overlay.hidden) showOverlay(true);
  };
  const onDragLeave = (ev: DragEvent) => {
    if (!hasFiles(ev)) return;
    depth = Math.max(0, depth - 1);
    // Leaving the window: relatedTarget is null (and depth reaches 0).
    if (depth === 0 || ev.relatedTarget === null) {
      depth = 0;
      showOverlay(false);
    }
  };
  const onDrop = (ev: DragEvent) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth = 0;
    showOverlay(false);
    const file = ev.dataTransfer?.files?.[0];
    if (file) void loadFileObject(file);
  };
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  return {
    loadFile,
    loadDemo() {
      if (typeof example_profile !== "undefined") shell.actions.load(example_profile, { name: "demo profile" });
    },
    loadFetch() {
      const text = fetch("profile.json", { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`the server answered ${r.status}${r.statusText ? ` ${r.statusText}` : ""}`);
        return r.text();
      });
      void ingest("profile.json", text, null);
    },
    destroy() {
      offLoaded();
      failToasts = [];
      shell.fileInput.removeEventListener("change", onChange);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      overlay.remove();
    },
  };
}
