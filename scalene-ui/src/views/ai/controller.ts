// AI controller (DESIGN.md §4.14, §8.5): the one owner of AI settings, proposal cards and
// in-flight requests. Built on the public API of src/ai (no DOM, no network of its own):
// env keys are fetched once at boot (http(s) pages only), nothing else touches the network
// until the user asks for a proposal, refreshes models or checks the Ollama server.
import {
  AiError,
  acceleratorName,
  checkReady,
  computeProposalAvailability,
  fetchEnvApiKeys,
  isAiError,
  loadSettings,
  preparePrompt,
  providerChosen,
  proposeOptimization,
  providerLabel,
  requestFromProfile,
  resolvedModel,
  saveSettings,
  syncSettingsWithProfile,
  type AiSettings,
  type EnvApiKeys,
  type OptimizationResult,
  type ProfileForAi,
  type ProposalAvailability,
  type Readiness,
} from "../../ai/index";
import { storageRemove, storageSet } from "../../core/storage";
import type { Model } from "../../model/model";
import { registerLegacyAiHandlers } from "../../scalene-gui";
import type { ShellContext } from "../app";
import { createAiDrawer, type AiDrawer } from "./drawer";
import { anchorOf, errorView, parseAnchor, rangeLabel, shortModel } from "./logic";

export type AiCardState =
  | { status: "setup"; message: string; missing: string[] }
  | { status: "working"; startedAt: number; provider: string; model: string; mode: "line" | "region"; start: number; end: number }
  | { status: "result"; result: OptimizationResult; view: "proposal" | "diff"; showPrompt: boolean }
  | { status: "error"; error: AiError; mode: "line" | "region" };

export interface AiController {
  settings(): AiSettings;
  ready(): Readiness;
  providerSummary(): string; // "Anthropic · claude-sonnet-4-5" | "No AI provider set up"
  availability(file: string): Map<number, ProposalAvailability>; // cached per file
  request(file: string, line: number, mode: "line" | "region"): void;
  cancel(anchor: string): void;
  dismiss(anchor: string): void;
  card(anchor: string): AiCardState | null; // anchor = `${file}:${startLine}`
  anchors(file: string): string[]; // for building code items
  openSettings(focusField?: string): void;
  onChange(cb: (anchor: string | null) => void): () => void; // null = settings changed
}

/** Where a card's request came from (for Retry / Regenerate). */
export interface AiRequestInfo {
  file: string;
  line: number;
  mode: "line" | "region";
}

/** The shell's handle: the public controller plus per-profile lifecycle and WP5 internals. */
export interface AiControllerHandle extends AiController {
  load(model: Model | null): void;
  destroy(): void;
  /** Environment credentials served by `scalene view --api-keys-from-env` ({} on file://). */
  env(): EnvApiKeys;
  /** Replace the settings; persists through saveSettings (text edits debounced 300 ms). */
  setSettings(next: AiSettings, opts?: { debounce?: boolean }): void;
  /** Re-run the request that produced this card (Retry, Regenerate). */
  retry(anchor: string): void;
  /** View-only changes of a result card (proposal/diff, prompt disclosure); no re-render event. */
  patchResult(anchor: string, patch: { view?: "proposal" | "diff"; showPrompt?: boolean }): void;
  requestOf(anchor: string): AiRequestInfo | null;
  model(): Model | null;
  /** `acceleratorName(profile)`: "GPU" or the profile's accelerator ("Neuron", …). */
  accelerator(): string;
  closeSettings(): void;
  isSettingsOpen(): boolean;
}

const MAX_LINES_PER_REGION = 50;
const SAVE_DEBOUNCE_MS = 300;
const NOT_SET_UP = "No AI provider set up";

const handles = new WeakMap<object, AiControllerHandle>();

/** The WP5 handle behind a ViewContext's `ai` (null for foreign implementations). */
export function aiHandle(ai: AiController): AiControllerHandle | null {
  return handles.get(ai) ?? null;
}

export function createAiController(shell: ShellContext): AiControllerHandle {
  let env: EnvApiKeys = {};
  let settings = loadSettings({ env });
  let lastSaved = settings;
  let edited = false;
  let model: Model | null = null;
  let profile: ProfileForAi | null = null;
  let saveTimer = 0;
  let probed = false;
  let drawer: AiDrawer | null = null;
  let destroyed = false;

  const cards = new Map<string, AiCardState>();
  const requests = new Map<string, AiRequestInfo>();
  const inflight = new Map<string, AbortController>();
  const availability = new Map<string, Map<number, ProposalAvailability>>();
  const listeners = new Set<(anchor: string | null) => void>();

  const emit = (anchor: string | null) => {
    for (const cb of Array.from(listeners)) {
      try {
        cb(anchor);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
  };

  // Until a provider is stored, served from the environment or edited in the drawer, the
  // select's first option (Amazon Bedrock) is only a default: ask to choose one, not for AWS keys.
  const readiness = (): Readiness => checkReady(settings, settings.provider, { chosen: edited || providerChosen({ env }) });

  const persist = () => {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    if (!probed) {
      // One probe write through core storage: a blocked store shows the one-time toast (§4.18).
      probed = true;
      if (storageSet("scalene-ai-probe", "1")) storageRemove("scalene-ai-probe");
    }
    saveSettings(settings, lastSaved, { env });
    lastSaved = settings;
  };

  const getDrawer = (): AiDrawer => {
    if (!drawer) drawer = createAiDrawer(shell, handle);
    return drawer;
  };

  // ── Requests ──────────────────────────────────────────────────────────────

  const abort = (anchor: string) => {
    const ac = inflight.get(anchor);
    if (!ac) return false;
    inflight.delete(anchor);
    ac.abort();
    return true;
  };

  const setCard = (anchor: string, state: AiCardState | null) => {
    if (state) cards.set(anchor, state);
    else cards.delete(anchor);
    emit(anchor);
  };

  const fail = (anchor: string, info: AiRequestInfo, error: AiError) => {
    setCard(anchor, { status: "error", error, mode: info.mode });
    const view = errorView(error, { providerLabel: providerLabel(error.provider), model: resolvedModel(error.provider, settings.providers) });
    shell.announce.assertive(`AI proposal for ${rangeLabel(info.line, info.line)} failed: ${view.message}`);
  };

  const run = (info: AiRequestInfo) => {
    const anchor = anchorOf(info.file, info.line);
    abort(anchor);
    requests.set(anchor, info);
    const ready = readiness();
    if (!ready.ready) {
      setCard(anchor, { status: "setup", message: ready.message || "No AI provider is set up", missing: ready.missing });
      shell.announce.polite(`Set up an AI provider to optimize ${rangeLabel(info.line, info.line)}`);
      return;
    }
    if (!profile) return;
    let request;
    let start = info.line;
    let end = info.line;
    let modelId = resolvedModel(settings.provider, settings.providers);
    try {
      request = requestFromProfile(profile, info.file, info.line, info.mode);
      const prepared = preparePrompt(request, settings);
      start = prepared.context.startLine;
      end = prepared.context.endLine;
      modelId = prepared.model;
    } catch (e) {
      fail(anchor, info, new AiError(settings.provider, "unknown", e instanceof Error ? e.message : String(e), undefined, e));
      return;
    }
    const ac = new AbortController();
    inflight.set(anchor, ac);
    const used = settings;
    setCard(anchor, {
      status: "working",
      startedAt: Date.now(),
      provider: providerLabel(used.provider),
      model: modelId,
      mode: info.mode,
      start,
      end,
    });
    shell.announce.polite(`Optimizing ${rangeLabel(start, end)} with ${providerLabel(used.provider)}`);
    proposeOptimization(request, used, ac.signal).then(
      (result) => {
        if (inflight.get(anchor) !== ac) return; // superseded or cancelled
        inflight.delete(anchor);
        setCard(anchor, { status: "result", result, view: "proposal", showPrompt: false });
        shell.announce.polite(`Proposal ready for ${rangeLabel(result.startLine, result.endLine)}`);
      },
      (e: unknown) => {
        if (inflight.get(anchor) !== ac) return;
        inflight.delete(anchor);
        const error = isAiError(e) ? e : new AiError(used.provider, "unknown", e instanceof Error ? e.message : String(e), undefined, e);
        if (error.kind === "aborted" || ac.signal.aborted) {
          setCard(anchor, null); // removed silently (§4.14.5)
          return;
        }
        fail(anchor, info, error);
      },
    );
  };

  // ── Public controller ─────────────────────────────────────────────────────

  const handle: AiControllerHandle = {
    settings: () => settings,
    ready: () => checkReady(settings),
    providerSummary() {
      if (!checkReady(settings).ready) return NOT_SET_UP;
      return `${providerLabel(settings.provider)} · ${shortModel(resolvedModel(settings.provider, settings.providers))}`;
    },
    availability(file) {
      let m = availability.get(file);
      if (!m) {
        const lines = profile?.files?.[file]?.lines;
        m = Array.isArray(lines) ? computeProposalAvailability(lines, MAX_LINES_PER_REGION) : new Map();
        availability.set(file, m);
      }
      return m;
    },
    request(file, line, mode) {
      if (!model || !model.fileByName.has(file) || !Number.isFinite(line)) {
        shell.toast.show({ kind: "info", text: "This file is not in the profile" });
        return;
      }
      run({ file, line: Math.trunc(line), mode });
    },
    cancel(anchor) {
      const had = abort(anchor);
      if (cards.has(anchor)) setCard(anchor, null);
      if (had) {
        shell.toast.show({ kind: "info", text: "Request cancelled" });
        shell.announce.polite("Request cancelled");
      }
    },
    dismiss(anchor) {
      abort(anchor);
      requests.delete(anchor);
      if (cards.has(anchor)) setCard(anchor, null);
    },
    card: (anchor) => cards.get(anchor) ?? null,
    anchors: (file) => Array.from(cards.keys()).filter((a) => parseAnchor(a).file === file),
    openSettings(focusField) {
      getDrawer().open(focusField);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    // ── Lifecycle ───────────────────────────────────────────────────────────
    load(m) {
      for (const ac of Array.from(inflight.values())) ac.abort();
      inflight.clear();
      cards.clear();
      requests.clear();
      availability.clear();
      model = m;
      profile = m ? (m.raw as ProfileForAi) : null;
      if (profile) {
        // The GPU toggle follows profile.gpu on every load (upstream display()); not a user edit.
        settings = syncSettingsWithProfile(settings, profile);
        lastSaved = { ...lastSaved, useGpu: settings.useGpu };
      }
      drawer?.sync();
      emit(null);
    },
    destroy() {
      destroyed = true;
      for (const ac of Array.from(inflight.values())) ac.abort();
      inflight.clear();
      if (saveTimer) persist();
      drawer?.destroy();
      drawer = null;
      listeners.clear();
    },

    // ── WP5 internals ───────────────────────────────────────────────────────
    env: () => env,
    setSettings(next, opts = {}) {
      if (next === settings) return;
      edited = true;
      settings = next;
      window.clearTimeout(saveTimer);
      if (opts.debounce) saveTimer = window.setTimeout(persist, SAVE_DEBOUNCE_MS);
      else persist();
      emit(null);
      // Setup cards follow the settings live: once the provider is ready they offer to run.
      const ready = readiness();
      for (const [anchor, s] of Array.from(cards)) {
        if (s.status !== "setup") continue;
        const missing = ready.ready ? [] : ready.missing;
        if (missing.join() !== s.missing.join() || (ready.message || "") !== s.message) {
          setCard(anchor, { status: "setup", message: ready.ready ? "" : ready.message, missing });
        }
      }
    },
    retry(anchor) {
      const info = requests.get(anchor);
      if (info) run(info);
    },
    patchResult(anchor, patch) {
      const s = cards.get(anchor);
      if (!s || s.status !== "result") return;
      cards.set(anchor, { ...s, ...patch });
    },
    requestOf: (anchor) => requests.get(anchor) ?? null,
    model: () => model,
    accelerator: () => (profile ? acceleratorName(profile) : "GPU"),
    closeSettings() {
      drawer?.close();
    },
    isSettingsOpen: () => drawer?.isOpen() ?? false,
  };
  handles.set(handle, handle);

  // Boot: environment keys (never throws; no request on file://), then reload the settings
  // with them unless the user already edited something.
  // Only a host that answers /heartbeat (scalene view) can serve /env-api-keys.json; asking
  // the Jupyter iframe server or a static host would only log a failed request.
  const hostProbe = (shell as { host?: { probe?: () => Promise<boolean> } }).host?.probe;
  void (hostProbe ? hostProbe.call(shell.host) : Promise.resolve(true))
    .then((ok) => (ok ? fetchEnvApiKeys() : {}))
    .then((keys) => {
    if (destroyed || Object.keys(keys).length === 0) return;
    env = keys;
    if (edited) return;
    settings = loadSettings({ env });
    if (profile) settings = syncSettingsWithProfile(settings, profile);
    lastSaved = settings;
    drawer?.sync();
    emit(null);
  });

  // Views that only have the bus (or older code paths) can open the drawer through it.
  shell.bus.on("ai:open-settings", ({ focusField }) => getDrawer().open(focusField));

  registerLegacyAiHandlers({
    toggleServiceFields: () => getDrawer().legacy.toggleServiceFields(),
    togglePassword: (btn) => getDrawer().legacy.togglePassword(btn),
    toggleAdvanced: (el) => getDrawer().legacy.toggleAdvanced(el),
    refreshOpenAIModels: () => getDrawer().legacy.refreshModels("openai"),
    refreshGeminiModels: () => getDrawer().legacy.refreshModels("gemini"),
    checkApiKey: (value) => getDrawer().legacy.checkApiKey(value),
  });

  return handle;
}
