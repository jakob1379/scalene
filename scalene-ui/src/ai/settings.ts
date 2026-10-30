/**
 * AI settings: the typed model of upstream's "AI optimization options" form,
 * persisted in localStorage under the SAME keys upstream used (element ids of
 * the `.persistent` inputs, plus `scalene-api-key` / `scalene-service-select`)
 * so existing users keep their configuration. Also: environment-key prefill
 * from `scalene view --api-keys-from-env` and upstream's default-provider rule.
 *
 * No DOM access; storage and fetch are injectable for tests.
 */

import { DEFAULTS, PROVIDER_IDS, isProviderId, type ProviderId } from "./catalog";
import type { ProviderConfigs } from "./providers";
import type { OptimizationTarget, PromptStyle } from "./prompts";

export interface AiSettings {
  /** Selected provider (`#service-select`). */
  provider: ProviderId;
  /** Optimization target radio. */
  target: OptimizationTarget;
  /** "Include GPU optimizations" checkbox. Upstream resets it to `profile.gpu` on load. */
  useGpu: boolean;
  /** Prompt selection; see `PromptStyle`. Not in the upstream form. */
  promptStyle: PromptStyle;
  providers: ProviderConfigs;
}

/** Credentials served by `scalene view --api-keys-from-env` (field -> first non-empty env var). */
export interface EnvApiKeys {
  /** OPENAI_API_KEY */
  openai?: string;
  /** ANTHROPIC_API_KEY */
  anthropic?: string;
  /** GEMINI_API_KEY, else GOOGLE_API_KEY */
  gemini?: string;
  /** AZURE_OPENAI_API_KEY */
  azure?: string;
  /** AZURE_OPENAI_ENDPOINT */
  azureUrl?: string;
  /** AWS_ACCESS_KEY_ID */
  awsAccessKey?: string;
  /** AWS_SECRET_ACCESS_KEY */
  awsSecretKey?: string;
  /** AWS_DEFAULT_REGION, else AWS_REGION */
  awsRegion?: string;
}

export const ENV_API_KEY_FIELDS: readonly (keyof EnvApiKeys)[] = [
  "openai",
  "anthropic",
  "gemini",
  "azure",
  "azureUrl",
  "awsAccessKey",
  "awsSecretKey",
  "awsRegion",
];

/** Same-origin endpoint served by upstream `launchbrowser.py`. */
export const ENV_API_KEYS_PATH = "/env-api-keys.json";

/** Minimal Storage surface (window.localStorage satisfies it). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** Storage keys of the top-level settings. Upstream values are strings "true"/"false" for booleans. */
export const STORAGE_KEYS = {
  /** Written by upstream persistence (`#service-select` is `.persistent`). Read first. */
  provider: "service-select",
  /** Written by upstream `toggleServiceFields`. Read as a fallback; both are written. */
  providerLegacy: "scalene-service-select",
  /** Radio pair: memory wins when "optimize-memory" is "true" (upstream restore order). */
  targetPerformance: "optimize-performance",
  targetMemory: "optimize-memory",
  useGpu: "use-gpu-checkbox",
  /** New in this UI. */
  promptStyle: "scalene-ai-prompt-style",
} as const;

interface FieldBinding {
  provider: ProviderId;
  field: string;
  key: string;
  env?: keyof EnvApiKeys;
}

/** Provider field -> storage key (upstream element id), and its env-var fallback. */
export const FIELD_BINDINGS: readonly FieldBinding[] = [
  // OpenAI. The key input was not `.persistent`; upstream saved it as "scalene-api-key".
  { provider: "openai", field: "apiKey", key: "scalene-api-key", env: "openai" },
  { provider: "openai", field: "model", key: "language-model-openai" },
  { provider: "openai", field: "customModel", key: "openai-custom-model" },
  { provider: "openai", field: "customUrl", key: "openai-custom-url" },
  // Anthropic
  { provider: "anthropic", field: "apiKey", key: "anthropic-api-key", env: "anthropic" },
  { provider: "anthropic", field: "model", key: "language-model-anthropic" },
  { provider: "anthropic", field: "customModel", key: "anthropic-custom-model" },
  { provider: "anthropic", field: "customUrl", key: "anthropic-custom-url" },
  // Gemini
  { provider: "gemini", field: "apiKey", key: "gemini-api-key", env: "gemini" },
  { provider: "gemini", field: "model", key: "language-model-gemini" },
  { provider: "gemini", field: "customModel", key: "gemini-custom-model" },
  { provider: "gemini", field: "customUrl", key: "gemini-custom-url" },
  // Azure OpenAI
  { provider: "azure-openai", field: "apiKey", key: "azure-api-key", env: "azure" },
  { provider: "azure-openai", field: "endpoint", key: "azure-api-url", env: "azureUrl" },
  { provider: "azure-openai", field: "model", key: "language-model-azure" },
  { provider: "azure-openai", field: "customModel", key: "azure-custom-model" },
  { provider: "azure-openai", field: "apiVersion", key: "azure-api-version" },
  // Amazon Bedrock
  { provider: "amazon", field: "accessKeyId", key: "aws-access-key", env: "awsAccessKey" },
  { provider: "amazon", field: "secretAccessKey", key: "aws-secret-key", env: "awsSecretKey" },
  { provider: "amazon", field: "sessionToken", key: "aws-session-token" },
  { provider: "amazon", field: "region", key: "aws-region", env: "awsRegion" },
  { provider: "amazon", field: "model", key: "language-model-amazon" },
  // Ollama
  { provider: "local", field: "host", key: "local-ip" },
  { provider: "local", field: "port", key: "local-port" },
  { provider: "local", field: "model", key: "language-model-local" },
];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Fresh provider configs with the upstream form's initial values. */
export function defaultProviderConfigs(): ProviderConfigs {
  return {
    amazon: { accessKeyId: "", secretAccessKey: "", sessionToken: "", region: DEFAULTS.amazonRegion, model: DEFAULTS.amazonModel },
    anthropic: { apiKey: "", model: DEFAULTS.anthropicModel, customModel: "", customUrl: "" },
    "azure-openai": { apiKey: "", endpoint: "", model: DEFAULTS.azureModel, customModel: "", apiVersion: DEFAULTS.azureApiVersion },
    gemini: { apiKey: "", model: DEFAULTS.geminiModel, customModel: "", customUrl: "" },
    openai: { apiKey: "", model: DEFAULTS.openaiModel, customModel: "", customUrl: "" },
    local: { host: DEFAULTS.ollamaHost, port: DEFAULTS.ollamaPort, model: "" },
  };
}

/**
 * Upstream `getDefaultProvider`: the first provider (alphabetical) with
 * environment credentials, else the first option of the select ("amazon").
 */
export function defaultProvider(env: EnvApiKeys = {}): ProviderId {
  if (env.awsAccessKey && env.awsSecretKey) return "amazon";
  if (env.anthropic) return "anthropic";
  if (env.azure) return "azure-openai";
  if (env.gemini) return "gemini";
  if (env.openai) return "openai";
  return PROVIDER_IDS[0];
}

/** Settings as a first-time user sees them (env credentials prefilled). */
export function defaultSettings(env: EnvApiKeys = {}): AiSettings {
  const settings: AiSettings = {
    provider: defaultProvider(env),
    target: "performance",
    useGpu: false,
    promptStyle: "auto",
    providers: defaultProviderConfigs(),
  };
  for (const b of FIELD_BINDINGS) {
    const v = b.env ? env[b.env] : undefined;
    if (v) setField(settings, b, v);
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function getField(s: AiSettings, b: FieldBinding): string {
  return String((s.providers[b.provider] as unknown as Record<string, string>)[b.field] ?? "");
}

function setField(s: AiSettings, b: FieldBinding, value: string): void {
  (s.providers[b.provider] as unknown as Record<string, string>)[b.field] = value;
}

/** window.localStorage when usable (it can throw in private windows / sandboxes), else null. */
export function browserStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

function read(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Quota / disabled storage: settings just won't persist.
  }
}

export interface SettingsIO {
  /** Defaults to `browserStorage()`; pass null to disable persistence. */
  storage?: StorageLike | null;
  /** Environment credentials (from `fetchEnvApiKeys`). */
  env?: EnvApiKeys;
}

/**
 * Load settings. Per field, as upstream `restoreState`: the stored value when
 * the key exists (even if empty), else the environment value, else the form
 * default. The provider comes from storage, else `defaultProvider(env)`.
 */
export function loadSettings(io: SettingsIO = {}): AiSettings {
  const storage = io.storage === undefined ? browserStorage() : io.storage;
  const env = io.env ?? {};
  const settings = defaultSettings(env);

  const savedProvider = read(storage, STORAGE_KEYS.provider) ?? read(storage, STORAGE_KEYS.providerLegacy);
  if (isProviderId(savedProvider)) settings.provider = savedProvider;

  const mem = read(storage, STORAGE_KEYS.targetMemory);
  const perf = read(storage, STORAGE_KEYS.targetPerformance);
  settings.target = mem === "true" || perf === "false" ? "memory" : "performance";

  const gpu = read(storage, STORAGE_KEYS.useGpu);
  if (gpu !== null) settings.useGpu = gpu === "true";

  const style = read(storage, STORAGE_KEYS.promptStyle);
  if (style === "auto" || style === "insights" || style === "targeted") settings.promptStyle = style;

  for (const b of FIELD_BINDINGS) {
    const v = read(storage, b.key);
    if (v !== null) setField(settings, b, v);
  }
  return settings;
}

/**
 * Did the user (or the environment) pick the provider? True when a provider is stored
 * (upstream keys) or `--api-keys-from-env` served any credential. False means
 * `settings.provider` is only the select's first option (Amazon Bedrock), so setup copy must
 * not ask a first-time user for AWS keys.
 */
export function providerChosen(io: SettingsIO = {}): boolean {
  const storage = io.storage === undefined ? browserStorage() : io.storage;
  if (isProviderId(read(storage, STORAGE_KEYS.provider) ?? read(storage, STORAGE_KEYS.providerLegacy))) return true;
  return Object.values(io.env ?? {}).some((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * Persist settings. With `prev`, only fields that differ from `prev` are
 * written (like upstream's per-input change events). Without it, every field
 * is written except values the user never set: a field with no stored key
 * whose value equals its default or the environment value is skipped, so
 * environment credentials do not get copied into localStorage.
 */
export function saveSettings(next: AiSettings, prev?: AiSettings, io: SettingsIO = {}): void {
  const storage = io.storage === undefined ? browserStorage() : io.storage;
  if (!storage) return;
  const env = io.env ?? {};
  const defaults = defaultSettings({});

  const shouldWrite = (key: string, value: string, prevValue: string | undefined, defaultValue: string, envValue?: string) => {
    if (prev) return value !== prevValue;
    if (read(storage, key) !== null) return read(storage, key) !== value;
    return value !== defaultValue && value !== (envValue ?? "") && value !== "";
  };

  const storedProvider = read(storage, STORAGE_KEYS.provider);
  const providerChanged = prev
    ? next.provider !== prev.provider
    : storedProvider !== null
      ? storedProvider !== next.provider
      : next.provider !== defaultProvider(env);
  if (providerChanged) {
    write(storage, STORAGE_KEYS.provider, next.provider);
    write(storage, STORAGE_KEYS.providerLegacy, next.provider);
  }
  if (!prev || next.target !== prev.target) {
    write(storage, STORAGE_KEYS.targetPerformance, String(next.target === "performance"));
    write(storage, STORAGE_KEYS.targetMemory, String(next.target === "memory"));
  }
  if (!prev || next.useGpu !== prev.useGpu) write(storage, STORAGE_KEYS.useGpu, String(next.useGpu));
  if (shouldWrite(STORAGE_KEYS.promptStyle, next.promptStyle, prev?.promptStyle, defaults.promptStyle)) {
    write(storage, STORAGE_KEYS.promptStyle, next.promptStyle);
  }

  for (const b of FIELD_BINDINGS) {
    const value = getField(next, b);
    const envValue = b.env ? env[b.env] : undefined;
    if (shouldWrite(b.key, value, prev ? getField(prev, b) : undefined, getField(defaults, b), envValue)) {
      write(storage, b.key, value);
    }
  }
}

/** Immutable update helper for one provider field: `updateProviderField(s, "openai", "apiKey", k)`. */
export function updateProviderField<P extends ProviderId, F extends keyof ProviderConfigs[P]>(
  settings: AiSettings,
  provider: P,
  field: F,
  value: ProviderConfigs[P][F],
): AiSettings {
  return {
    ...settings,
    providers: { ...settings.providers, [provider]: { ...settings.providers[provider], [field]: value } },
  };
}

// ---------------------------------------------------------------------------
// Environment keys
// ---------------------------------------------------------------------------

export interface EnvFetchOptions {
  fetch?: typeof fetch;
  /** Page location; defaults to `globalThis.location`. */
  location?: { protocol: string };
  signal?: AbortSignal;
}

/**
 * Upstream `loadEnvApiKeys`: GET /env-api-keys.json from the local Scalene
 * server (same origin, `cache: "no-store"`). The server answers `{}` unless
 * `scalene view --api-keys-from-env` was used, and 403 for cross-origin or
 * foreign-Host requests. Pages opened from a file have no server: skipped.
 * Never throws; returns only non-empty string fields.
 */
export async function fetchEnvApiKeys(opts: EnvFetchOptions = {}): Promise<EnvApiKeys> {
  const loc = opts.location ?? (globalThis as { location?: { protocol: string } }).location;
  if (!loc || !loc.protocol.startsWith("http")) return {};
  const doFetch = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  if (!doFetch) return {};
  try {
    const res = await doFetch(ENV_API_KEYS_PATH, { cache: "no-store", signal: opts.signal });
    if (!res.ok) return {};
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return {};
    const keys: EnvApiKeys = {};
    for (const field of ENV_API_KEY_FIELDS) {
      const value = (data as Record<string, unknown>)[field];
      if (typeof value === "string" && value) keys[field] = value;
    }
    return keys;
  } catch {
    return {};
  }
}

/** Which provider fields currently hold the environment's value (for a "from environment" badge). */
export function envFilledFields(settings: AiSettings, env: EnvApiKeys): { provider: ProviderId; field: string }[] {
  return FIELD_BINDINGS.filter((b) => b.env && env[b.env] && getField(settings, b) === env[b.env]).map((b) => ({
    provider: b.provider,
    field: b.field,
  }));
}

// ---------------------------------------------------------------------------
// Profile coupling
// ---------------------------------------------------------------------------

/** Accelerator label used in prompts and the GPU checkbox: `gpu_device` when `gpu`, else "GPU". */
export function acceleratorName(profile: { gpu?: boolean; gpu_device?: string }): string {
  return profile.gpu && profile.gpu_device ? profile.gpu_device : "GPU";
}

/** Upstream `display()` forces the GPU checkbox to `profile.gpu` whenever a profile loads. */
export function syncSettingsWithProfile(settings: AiSettings, profile: { gpu?: boolean }): AiSettings {
  const gpu = Boolean(profile.gpu);
  return settings.useGpu === gpu ? settings : { ...settings, useGpu: gpu };
}
