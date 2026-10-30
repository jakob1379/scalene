/**
 * Static AI-provider data: ids, labels, model option lists, defaults and the
 * per-provider form fields. Mirrors the "AI optimization options" form of
 * upstream `scalene-gui/index.html.template` so the UI can render it from data.
 *
 * No runtime dependencies, no DOM.
 */

/** Provider ids, identical to the upstream `#service-select` option values. */
export type ProviderId =
  | "amazon"
  | "anthropic"
  | "azure-openai"
  | "gemini"
  | "openai"
  | "local";

/** Upstream `#service-select` order (alphabetical by label, Ollama last). */
export const PROVIDER_IDS: readonly ProviderId[] = [
  "amazon",
  "anthropic",
  "azure-openai",
  "gemini",
  "openai",
  "local",
];

export interface ModelOption {
  /** Model id sent to the API (Azure: deployment name). */
  value: string;
  /** Human label shown in the select. */
  label: string;
}

/** OpenAI: `#language-model-openai` (default gpt-5.2). */
export const OPENAI_MODELS: readonly ModelOption[] = [
  { value: "gpt-5.2", label: "GPT-5.2" },
  { value: "gpt-5.2-pro", label: "GPT-5.2 Pro" },
  { value: "gpt-5.1", label: "GPT-5.1" },
  { value: "gpt-5", label: "GPT-5" },
  { value: "gpt-5-mini", label: "GPT-5 mini" },
  { value: "gpt-5-nano", label: "GPT-5 nano" },
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4.1-nano", label: "GPT-4.1 nano" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "o3-pro", label: "o3-pro" },
  { value: "o3", label: "o3" },
  { value: "o3-mini", label: "o3-mini" },
  { value: "o4-mini", label: "o4-mini" },
];

/** Anthropic: `#language-model-anthropic` (default Sonnet 4.5). Ids verbatim from upstream. */
export const ANTHROPIC_MODELS: readonly ModelOption[] = [
  { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { value: "claude-opus-4-5-20251124", label: "Claude Opus 4.5" },
  { value: "claude-haiku-4-5-20251015", label: "Claude Haiku 4.5" },
];

/** Google Gemini: `#language-model-gemini` (default gemini-3-pro-preview). */
export const GEMINI_MODELS: readonly ModelOption[] = [
  { value: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
  { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { value: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
];

/** Amazon Bedrock: `#language-model-amazon` (default Sonnet 4.5 inference profile). */
export const AMAZON_MODELS: readonly ModelOption[] = [
  { value: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Claude Sonnet 4.5" },
  { value: "us.anthropic.claude-opus-4-5-20251124-v1:0", label: "Claude Opus 4.5" },
  { value: "us.anthropic.claude-haiku-4-5-20251015-v1:0", label: "Claude Haiku 4.5" },
];

/** Azure OpenAI: `#language-model-azure` (default gpt-4.1). Values are deployment names. */
export const AZURE_MODELS: readonly ModelOption[] = [
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "o3-mini", label: "o3-mini" },
];

/** Ollama has no static list: models come from `GET /api/tags`. */
export const OLLAMA_MODELS: readonly ModelOption[] = [];

/** Initial values of the upstream form (the `selected` option / `value=` attribute). */
export const DEFAULTS = {
  openaiModel: "gpt-5.2",
  anthropicModel: "claude-sonnet-4-5-20250929",
  geminiModel: "gemini-3-pro-preview",
  amazonModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  amazonRegion: "us-east-1",
  azureModel: "gpt-4.1",
  azureApiVersion: "2024-02-15-preview",
  ollamaHost: "localhost",
  ollamaPort: "11434",
} as const;

/**
 * Model used when the select is empty and no custom model is set: upstream's
 * `customModel || select.value || <fallback>` (note: these differ from the
 * select defaults above; that is how upstream is written).
 */
export const FALLBACK_MODELS = {
  openai: "gpt-4",
  anthropic: "claude-sonnet-4-5-20250929",
  gemini: "gemini-2.0-flash",
  "azure-openai": "gpt-5.2",
} as const;

/** Default public endpoints. */
export const ENDPOINTS = {
  openaiChat: "https://api.openai.com/v1/chat/completions",
  openaiBase: "https://api.openai.com/v1",
  /** Upstream key check: a GET here answers with an error whose code tells key validity. */
  openaiKeyCheck: "https://api.openai.com/v1/completions",
  anthropicMessages: "https://api.anthropic.com/v1/messages",
  geminiBase: "https://generativelanguage.googleapis.com/v1beta",
} as const;

// ---------------------------------------------------------------------------
// Form description
// ---------------------------------------------------------------------------

export type FieldKind =
  /** Password input with a Show/Hide toggle. */
  | "secret"
  | "text"
  | "url"
  | "number"
  /** Model select (options = provider `models`, or the remote list). */
  | "model";

export interface ProviderFieldSpec {
  /** Key inside `AiSettings.providers[provider]`. */
  field: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  /** Link the label points to (e.g. where to create an API key). */
  helpUrl?: string;
  /** Upstream hides it behind "Advanced options". */
  advanced?: boolean;
  /** Needed before a proposal can be requested (see `checkReady`). */
  required?: boolean;
  /** Environment variable(s) `scalene view --api-keys-from-env` can prefill it from. */
  envVars?: readonly string[];
  /** Short hint for the UI (tooltip / helper text). */
  hint?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  /** Label in the provider select. */
  label: string;
  /** Short explanatory line shown above the fields (upstream: Ollama only). */
  note?: string;
  noteUrl?: string;
  models: readonly ModelOption[];
  defaultModel: string;
  /** Upstream had a refresh button / live listing for this provider. */
  canListModels: boolean;
  /** Upstream showed a check/cross next to the key (OpenAI only). */
  canValidateKey: boolean;
  fields: readonly ProviderFieldSpec[];
}

const CUSTOM_MODEL_HINT = "Overrides the model dropdown when set.";

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "amazon",
    label: "Amazon Bedrock",
    models: AMAZON_MODELS,
    defaultModel: DEFAULTS.amazonModel,
    canListModels: false,
    canValidateKey: false,
    fields: [
      { field: "accessKeyId", label: "Access Key ID", kind: "text", placeholder: "AKIA...", required: true, envVars: ["AWS_ACCESS_KEY_ID"] },
      { field: "secretAccessKey", label: "Secret Key", kind: "secret", placeholder: "secret access key", required: true, envVars: ["AWS_SECRET_ACCESS_KEY"] },
      { field: "region", label: "Region", kind: "text", placeholder: "us-east-1", envVars: ["AWS_DEFAULT_REGION", "AWS_REGION"] },
      { field: "model", label: "Model", kind: "model", required: true },
      { field: "sessionToken", label: "Session token", kind: "secret", placeholder: "only for temporary credentials", advanced: true, hint: "New in this UI: for STS / SSO temporary credentials." },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: ANTHROPIC_MODELS,
    defaultModel: DEFAULTS.anthropicModel,
    canListModels: false,
    canValidateKey: false,
    fields: [
      { field: "apiKey", label: "API key", kind: "secret", placeholder: "sk-ant-...", helpUrl: "https://console.anthropic.com/", required: true, envVars: ["ANTHROPIC_API_KEY"] },
      { field: "model", label: "Model", kind: "model" },
      { field: "customModel", label: "Custom model", kind: "text", placeholder: "overrides dropdown", advanced: true, hint: CUSTOM_MODEL_HINT },
      { field: "customUrl", label: "Custom URL", kind: "url", placeholder: "for compatible servers", advanced: true, hint: "Full Messages endpoint URL of an Anthropic-compatible server." },
    ],
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    models: AZURE_MODELS,
    defaultModel: DEFAULTS.azureModel,
    canListModels: false,
    canValidateKey: false,
    fields: [
      { field: "apiKey", label: "API key", kind: "secret", placeholder: "Azure API key", required: true, envVars: ["AZURE_OPENAI_API_KEY"] },
      { field: "endpoint", label: "Endpoint URL", kind: "url", placeholder: "https://....openai.azure.com", required: true, envVars: ["AZURE_OPENAI_ENDPOINT"] },
      { field: "model", label: "Model", kind: "model", hint: "Azure deployment name." },
      { field: "customModel", label: "Custom model", kind: "text", placeholder: "overrides dropdown", advanced: true, hint: "Deployment name; overrides the dropdown." },
      { field: "apiVersion", label: "API version", kind: "text", placeholder: DEFAULTS.azureApiVersion, advanced: true },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    models: GEMINI_MODELS,
    defaultModel: DEFAULTS.geminiModel,
    canListModels: true,
    canValidateKey: false,
    fields: [
      { field: "apiKey", label: "API key", kind: "secret", placeholder: "AIza...", helpUrl: "https://aistudio.google.com/apikey", required: true, envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
      { field: "model", label: "Model", kind: "model" },
      { field: "customModel", label: "Custom model", kind: "text", placeholder: "overrides dropdown", advanced: true, hint: CUSTOM_MODEL_HINT },
      { field: "customUrl", label: "Custom URL", kind: "url", placeholder: "for compatible servers", advanced: true, hint: "Base URL (default https://generativelanguage.googleapis.com/v1beta)." },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: OPENAI_MODELS,
    defaultModel: DEFAULTS.openaiModel,
    canListModels: true,
    canValidateKey: true,
    fields: [
      { field: "apiKey", label: "API key", kind: "secret", placeholder: "sk-...", helpUrl: "https://platform.openai.com/api-keys", required: true, envVars: ["OPENAI_API_KEY"], hint: "Optional when a custom URL is set." },
      { field: "model", label: "Model", kind: "model" },
      { field: "customModel", label: "Custom model", kind: "text", placeholder: "overrides dropdown", advanced: true, hint: CUSTOM_MODEL_HINT },
      { field: "customUrl", label: "Custom URL", kind: "url", placeholder: "for compatible servers", advanced: true, hint: "Chat-completions URL (or a .../v1 base) of an OpenAI-compatible server such as vLLM." },
    ],
  },
  {
    id: "local",
    label: "Local (Ollama)",
    note: "Run AI locally with Ollama.",
    noteUrl: "https://ollama.ai/",
    models: OLLAMA_MODELS,
    defaultModel: "",
    canListModels: true,
    canValidateKey: false,
    fields: [
      { field: "host", label: "Server", kind: "text", placeholder: DEFAULTS.ollamaHost },
      { field: "port", label: "Port", kind: "number", placeholder: DEFAULTS.ollamaPort },
      { field: "model", label: "Model", kind: "model", required: true, hint: "Listed from the running server. None? Run: ollama pull codellama" },
    ],
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  const info = PROVIDERS.find((p) => p.id === id);
  if (!info) throw new Error(`Unknown AI provider: ${id}`);
  return info;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}
