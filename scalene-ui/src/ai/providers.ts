/**
 * One plain-`fetch` call per AI provider, ported from upstream
 * `scalene-gui/{openai,anthropic,gemini,azure,ollama,amazon}.ts`. Request
 * bodies, headers and endpoints match upstream; Amazon Bedrock is signed with
 * our own SigV4 (`./sigv4`) instead of the AWS SDK.
 *
 * Every `send*` function resolves to the model's raw text (no post-processing;
 * see `postProcessResponse` in ./index) or rejects with an `AiError`. Nothing
 * here touches the DOM, `alert`, or storage.
 */

import {
  DEFAULTS,
  ENDPOINTS,
  FALLBACK_MODELS,
  providerInfo,
  type ModelOption,
  type ProviderId,
} from "./catalog";
import { signRequest } from "./sigv4";

export * from "./catalog";

// ---------------------------------------------------------------------------
// Configuration per provider (the fields of the upstream settings form)
// ---------------------------------------------------------------------------

export interface OpenAIConfig {
  apiKey: string;
  /** Selected model (`#language-model-openai`). */
  model: string;
  /** Overrides `model` when non-empty. */
  customModel: string;
  /** OpenAI-compatible server: chat-completions URL, or a base ending in /vN. */
  customUrl: string;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  customModel: string;
  /** Full Messages endpoint of an Anthropic-compatible server. */
  customUrl: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  customModel: string;
  /** Base URL replacing https://generativelanguage.googleapis.com/v1beta. */
  customUrl: string;
}

export interface AzureConfig {
  apiKey: string;
  /** Resource endpoint, e.g. https://myres.openai.azure.com */
  endpoint: string;
  /** Deployment name from the select. */
  model: string;
  /** Deployment name override. */
  customModel: string;
  apiVersion: string;
}

export interface AmazonConfig {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional, for temporary credentials (not in upstream). */
  sessionToken: string;
  region: string;
  /** Bedrock model or inference-profile id. */
  model: string;
}

export interface OllamaConfig {
  host: string;
  port: string;
  model: string;
}

export interface ProviderConfigs {
  amazon: AmazonConfig;
  anthropic: AnthropicConfig;
  "azure-openai": AzureConfig;
  gemini: GeminiConfig;
  openai: OpenAIConfig;
  local: OllamaConfig;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AiErrorKind =
  /** Required settings are empty (see `checkReady`). */
  | "missing-credentials"
  /** The provider rejected the key / credentials. */
  | "invalid-key"
  /** Billing / quota problem (OpenAI `insufficient_quota`). */
  | "quota"
  | "rate-limit"
  | "model-not-found"
  | "bad-request"
  /** Provider-side 5xx / overloaded. */
  | "server"
  /** fetch failed: offline, wrong URL, server not running, or CORS. */
  | "network"
  | "aborted"
  /** The call succeeded but produced no usable text / code. */
  | "empty-response"
  | "unknown";

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly provider: ProviderId;
  readonly status?: number;
  /** Parsed error body or underlying exception, for a "details" disclosure. */
  readonly detail?: unknown;

  constructor(provider: ProviderId, kind: AiErrorKind, message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "AiError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

export function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}

/** What every `send*` returns. */
export interface ProviderReply {
  /** The model's message text, untouched. */
  text: string;
  /** The model id actually requested. */
  model: string;
}

/** System prompt used by OpenAI, Anthropic, Gemini and Azure (verbatim). */
export const CODE_ONLY_SYSTEM_PROMPT =
  "You are a Python programming assistant who ONLY responds with blocks of commented, optimized code. You never respond with text. Just code, starting with ``` and ending with ```.";

/** System prompt used for Ollama (verbatim). */
export const OLLAMA_SYSTEM_PROMPT = "You are an expert code assistant who only responds in Python code.";

/** Bedrock `max_tokens` / `max_completion_tokens` ("arbitrary large number" upstream). */
export const AMAZON_MAX_TOKENS = 65536;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
}

async function request(
  provider: ProviderId,
  url: string,
  init: RequestInit,
  networkHint: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isAbort(e)) throw new AiError(provider, "aborted", "Request cancelled.", undefined, e);
    throw new AiError(provider, "network", networkHint, undefined, e);
  }
}

/** Parse a JSON body; non-JSON bodies become `{ __text: body }`. */
async function readJson(provider: ProviderId, res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (isAbort(e)) throw new AiError(provider, "aborted", "Request cancelled.", undefined, e);
    throw new AiError(provider, "network", "The connection dropped while reading the response.", res.status, e);
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __text: text };
  }
}

function kindForStatus(status: number): AiErrorKind {
  if (status === 401 || status === 403) return "invalid-key";
  if (status === 404) return "model-not-found";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  if (status >= 400) return "bad-request";
  return "unknown";
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function chatCompletionText(data: unknown): string | undefined {
  const choices = obj(data).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return str(obj(obj(choices[0]).message).content);
}

function emptyReply(provider: ProviderId, data: unknown): AiError {
  return new AiError(provider, "empty-response", "The model returned no answer.", undefined, data);
}

// ---------------------------------------------------------------------------
// OpenAI (+ compatible servers)
// ---------------------------------------------------------------------------

/** Model actually requested: custom model, else the select, else upstream fallback "gpt-4". */
export function openaiModel(cfg: OpenAIConfig): string {
  return cfg.customModel.trim() || cfg.model || FALLBACK_MODELS.openai;
}

/**
 * Chat endpoint. Upstream used the custom URL verbatim (so it had to be the
 * full .../chat/completions URL); a bare base ending in /vN now gets the path
 * appended too.
 */
export function openaiChatUrl(cfg: OpenAIConfig): string {
  const custom = cfg.customUrl.trim();
  if (!custom) return ENDPOINTS.openaiChat;
  if (/\/v\d+\/?$/.test(custom)) return trimSlash(custom) + "/chat/completions";
  return custom;
}

/** Base URL for /models: the custom URL minus any trailing /chat/completions. */
export function openaiBaseUrl(cfg: OpenAIConfig): string {
  const custom = cfg.customUrl.trim();
  if (!custom) return ENDPOINTS.openaiBase;
  return trimSlash(custom).replace(/\/chat\/completions$/, "");
}

function openaiError(data: unknown, status: number, model: string): AiError | null {
  const err = obj(obj(data).error);
  if (!Object.keys(err).length && status < 400) return null;
  const code = str(err.code) ?? "";
  const type = str(err.type) ?? "";
  const message = str(err.message) ?? str(obj(data).__text) ?? `HTTP ${status}`;
  if (code === "invalid_api_key" || status === 401) {
    return new AiError("openai", "invalid-key", "Invalid OpenAI API key. Check the key and try again.", status, data);
  }
  if (code === "insufficient_quota") {
    return new AiError("openai", "quota", "You need to add funds to your OpenAI account to use this feature.", status, data);
  }
  if (code === "model_not_found") {
    return new AiError(
      "openai",
      "model-not-found",
      `Model "${model}" is not available to this account (some models need a funded account).`,
      status,
      data,
    );
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return new AiError("openai", "rate-limit", "Rate limit exceeded. Please wait a moment and try again.", status, data);
  }
  if (type === "invalid_request_error" || code === "invalid_request_error") {
    return new AiError("openai", "bad-request", `OpenAI rejected the request: ${message}`, status, data);
  }
  return new AiError("openai", kindForStatus(status), `OpenAI API error: ${message}`, status, data);
}

export async function sendPromptToOpenAI(prompt: string, cfg: OpenAIConfig, signal?: AbortSignal): Promise<ProviderReply> {
  const model = openaiModel(cfg);
  const url = openaiChatUrl(cfg);
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: CODE_ONLY_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    user: "scalene-user",
  });
  const res = await request(
    "openai",
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body,
      signal,
    },
    `Could not reach ${url}. Check your connection${cfg.customUrl ? " and the custom URL" : ""}.`,
  );
  const data = await readJson("openai", res);
  const err = openaiError(data, res.status, model);
  if (err) throw err;
  const text = chatCompletionText(data);
  if (text === undefined) throw emptyReply("openai", data);
  return { text, model };
}

export type KeyStatus =
  /** No key entered. */
  | "empty"
  | "valid"
  | "invalid"
  /** Not checked: provider without a check, custom URL, or the check failed to run. */
  | "unchecked";

/**
 * Upstream `isValidApiKey`: GET https://api.openai.com/v1/completions and
 * treat error codes invalid_api_key / invalid_request_error / model_not_found
 * / insufficient_quota as an invalid key. Skipped for custom URLs.
 */
export async function validateOpenAIKey(cfg: OpenAIConfig, signal?: AbortSignal): Promise<KeyStatus> {
  if (!cfg.apiKey) return "empty";
  if (cfg.customUrl.trim()) return "unchecked";
  let res: Response;
  try {
    res = await fetch(ENDPOINTS.openaiKeyCheck, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      signal,
    });
  } catch (e) {
    if (isAbort(e)) throw new AiError("openai", "aborted", "Request cancelled.", undefined, e);
    return "unchecked";
  }
  const data = await readJson("openai", res);
  const code = str(obj(obj(data).error).code) ?? "";
  const badCodes = ["invalid_api_key", "invalid_request_error", "model_not_found", "insufficient_quota"];
  return badCodes.includes(code) ? "invalid" : "valid";
}

/** Upstream `fetchOpenAIModels`: chat-capable ids (gpt / o1 / o3 / o4, minus instruct / realtime / audio), sorted. */
export async function fetchOpenAIModels(cfg: OpenAIConfig, signal?: AbortSignal): Promise<string[]> {
  if (!cfg.apiKey && !cfg.customUrl.trim()) {
    throw new AiError("openai", "missing-credentials", "Please enter an OpenAI API key first.");
  }
  const url = `${openaiBaseUrl(cfg)}/models`;
  const res = await request(
    "openai",
    url,
    { method: "GET", headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal },
    `Could not reach ${url}.`,
  );
  const data = await readJson("openai", res);
  const err = openaiError(data, res.status, "");
  if (err) throw err;
  const list = obj(data).data;
  if (!Array.isArray(list)) throw emptyReply("openai", data);
  return list
    .map((m) => str(obj(m).id) ?? "")
    .filter((id) => id.includes("gpt") || id.includes("o1") || id.includes("o3") || id.includes("o4"))
    .filter((id) => !id.includes("instruct") && !id.includes("realtime") && !id.includes("audio"))
    .sort();
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export function anthropicModel(cfg: AnthropicConfig): string {
  return cfg.customModel.trim() || cfg.model || FALLBACK_MODELS.anthropic;
}

export async function sendPromptToAnthropic(
  prompt: string,
  cfg: AnthropicConfig,
  signal?: AbortSignal,
): Promise<ProviderReply> {
  const model = anthropicModel(cfg);
  const url = cfg.customUrl.trim() || ENDPOINTS.anthropicMessages;
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
    system: CODE_ONLY_SYSTEM_PROMPT,
  });
  const res = await request(
    "anthropic",
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body,
      signal,
    },
    `Could not reach ${url}. Check your connection${cfg.customUrl ? " and the custom URL" : ""}.`,
  );
  const data = await readJson("anthropic", res);
  const err = obj(obj(data).error);
  if (Object.keys(err).length || res.status >= 400) {
    const type = str(err.type) ?? "";
    const message = str(err.message) ?? str(obj(data).__text) ?? `HTTP ${res.status}`;
    if (type === "authentication_error" || res.status === 401) {
      throw new AiError("anthropic", "invalid-key", "Invalid Anthropic API key. Please check your API key and try again.", res.status, data);
    }
    if (type === "rate_limit_error" || res.status === 429) {
      throw new AiError("anthropic", "rate-limit", "Rate limit exceeded. Please wait a moment and try again.", res.status, data);
    }
    if (type === "not_found_error") {
      throw new AiError("anthropic", "model-not-found", `Anthropic API error: ${message}`, res.status, data);
    }
    if (type === "overloaded_error") {
      throw new AiError("anthropic", "server", "Anthropic is overloaded. Please try again shortly.", res.status, data);
    }
    throw new AiError("anthropic", kindForStatus(res.status), `Anthropic API error: ${message}`, res.status, data);
  }
  const content = obj(data).content;
  if (!Array.isArray(content) || content.length === 0) throw emptyReply("anthropic", data);
  // Upstream read content[0].text; joining all text blocks is identical for normal replies.
  const text = content
    .filter((b) => str(obj(b).type) === "text" || str(obj(b).text) !== undefined)
    .map((b) => str(obj(b).text) ?? "")
    .join("");
  return { text, model };
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

export function geminiModel(cfg: GeminiConfig): string {
  return cfg.customModel.trim() || cfg.model || FALLBACK_MODELS.gemini;
}

function geminiBase(cfg: GeminiConfig): string {
  return trimSlash(cfg.customUrl) || ENDPOINTS.geminiBase;
}

function geminiError(data: unknown, status: number): AiError | null {
  const err = obj(obj(data).error);
  if (!Object.keys(err).length && status < 400) return null;
  const code = typeof err.code === "number" ? err.code : status;
  const st = str(err.status) ?? "";
  const message = str(err.message) ?? str(obj(data).__text) ?? `HTTP ${status}`;
  // Google reports a bad key as 400 INVALID_ARGUMENT "API key not valid".
  if (st === "UNAUTHENTICATED" || code === 401 || code === 403 || /api key not valid/i.test(message)) {
    return new AiError("gemini", "invalid-key", "Invalid Gemini API key. Please check your API key and try again.", status, data);
  }
  if (st === "RESOURCE_EXHAUSTED" || code === 429) {
    return new AiError("gemini", "rate-limit", "Rate limit exceeded. Please wait a moment and try again.", status, data);
  }
  if (st === "NOT_FOUND" || code === 404) {
    return new AiError("gemini", "model-not-found", `Gemini API error: ${message}`, status, data);
  }
  if (st === "INVALID_ARGUMENT" || code === 400) {
    return new AiError("gemini", "bad-request", `Gemini API error: ${message}`, status, data);
  }
  return new AiError("gemini", kindForStatus(code), `Gemini API error: ${message}`, status, data);
}

export async function sendPromptToGemini(prompt: string, cfg: GeminiConfig, signal?: AbortSignal): Promise<ProviderReply> {
  const model = geminiModel(cfg);
  const url = `${geminiBase(cfg)}/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: CODE_ONLY_SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
  });
  const res = await request(
    "gemini",
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body, signal },
    `Could not reach ${geminiBase(cfg)}. Check your connection${cfg.customUrl ? " and the custom URL" : ""}.`,
  );
  const data = await readJson("gemini", res);
  const err = geminiError(data, res.status);
  if (err) throw err;
  const candidates = obj(data).candidates;
  const parts = Array.isArray(candidates) && candidates.length ? obj(obj(candidates[0]).content).parts : undefined;
  if (!Array.isArray(parts)) throw emptyReply("gemini", data);
  return { text: parts.map((p) => str(obj(p).text) ?? "").join(""), model };
}

/** Upstream `fetchGeminiModels`: models supporting generateContent whose id contains "gemini", sorted. */
export async function fetchGeminiModels(cfg: GeminiConfig, signal?: AbortSignal): Promise<string[]> {
  if (!cfg.apiKey) throw new AiError("gemini", "missing-credentials", "Please enter a Gemini API key first.");
  const url = `${geminiBase(cfg)}/models?key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await request("gemini", url, { method: "GET", signal }, `Could not reach ${geminiBase(cfg)}.`);
  const data = await readJson("gemini", res);
  const err = geminiError(data, res.status);
  if (err) throw err;
  const models = obj(data).models;
  if (!Array.isArray(models)) throw emptyReply("gemini", data);
  return models
    .filter((m) => {
      const methods = obj(m).supportedGenerationMethods;
      return Array.isArray(methods) && methods.includes("generateContent");
    })
    .map((m) => (str(obj(m).name) ?? "").replace("models/", ""))
    .filter((id) => id.includes("gemini"))
    .sort();
}

// ---------------------------------------------------------------------------
// Azure OpenAI
// ---------------------------------------------------------------------------

export function azureDeployment(cfg: AzureConfig): string {
  return cfg.customModel.trim() || cfg.model || FALLBACK_MODELS["azure-openai"];
}

export function azureChatUrl(cfg: AzureConfig): string {
  const version = cfg.apiVersion.trim() || DEFAULTS.azureApiVersion;
  return `${trimSlash(cfg.endpoint)}/openai/deployments/${azureDeployment(cfg)}/chat/completions?api-version=${version}`;
}

export async function sendPromptToAzureOpenAI(prompt: string, cfg: AzureConfig, signal?: AbortSignal): Promise<ProviderReply> {
  const model = azureDeployment(cfg);
  const url = azureChatUrl(cfg);
  const body = JSON.stringify({
    messages: [
      { role: "system", content: CODE_ONLY_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    user: "scalene-user",
  });
  const res = await request(
    "azure-openai",
    url,
    { method: "POST", headers: { "Content-Type": "application/json", "api-key": cfg.apiKey }, body, signal },
    `Could not reach ${trimSlash(cfg.endpoint) || "the Azure endpoint"}. Check the endpoint URL.`,
  );
  const data = await readJson("azure-openai", res);
  const err = obj(obj(data).error);
  if (Object.keys(err).length || res.status >= 400) {
    const code = str(err.code) ?? "";
    const message = str(err.message) ?? str(obj(data).__text) ?? `HTTP ${res.status}`;
    let kind: AiErrorKind = kindForStatus(res.status);
    if (code === "DeploymentNotFound" || code === "model_not_found") kind = "model-not-found";
    else if (code === "insufficient_quota") kind = "quota";
    else if (code === "invalid_request_error") kind = "bad-request";
    const text =
      kind === "invalid-key"
        ? "Invalid Azure OpenAI API key, or the key does not belong to this endpoint."
        : kind === "model-not-found"
          ? `No Azure deployment named "${model}" at this endpoint.`
          : `Azure OpenAI error: ${message}`;
    throw new AiError("azure-openai", kind, text, res.status, data);
  }
  const text = chatCompletionText(data);
  if (text === undefined) throw emptyReply("azure-openai", data);
  return { text, model };
}

// ---------------------------------------------------------------------------
// Ollama (local)
// ---------------------------------------------------------------------------

/** http://host:port; a host typed with a scheme is accepted as-is. */
export function ollamaBaseUrl(cfg: OllamaConfig): string {
  const host = cfg.host.trim() || DEFAULTS.ollamaHost;
  const port = String(cfg.port).trim() || DEFAULTS.ollamaPort;
  if (/^https?:\/\//i.test(host)) {
    const base = trimSlash(host);
    return /:\d+$/.test(base.replace(/^https?:\/\//i, "")) ? base : `${base}:${port}`;
  }
  return `http://${host}:${port}`;
}

const OLLAMA_UNREACHABLE = (base: string) =>
  `No Ollama server found at ${base}. Start it with \`ollama serve\` and install a model, e.g. \`ollama pull codellama\`.`;

/** Upstream `fetchModelNames`: GET /api/tags -> model names. */
export async function fetchOllamaModels(cfg: OllamaConfig, signal?: AbortSignal): Promise<string[]> {
  const base = ollamaBaseUrl(cfg);
  const res = await request("local", `${base}/api/tags`, { method: "GET", signal }, OLLAMA_UNREACHABLE(base));
  if (!res.ok) throw new AiError("local", "network", OLLAMA_UNREACHABLE(base), res.status);
  const data = await readJson("local", res);
  const models = obj(data).models;
  if (!Array.isArray(models)) throw new AiError("local", "network", OLLAMA_UNREACHABLE(base), res.status, data);
  return models.map((m) => str(obj(m).name) ?? "").filter((n) => n.length > 0);
}

/**
 * Upstream `sendPromptToOllama`: POST /api/chat with stream:false, parse the
 * (possibly NDJSON) reply, concatenating `message.content` until `done`.
 * Retries up to 3 attempts on failure, as upstream.
 */
export async function sendPromptToOllama(prompt: string, cfg: OllamaConfig, signal?: AbortSignal): Promise<ProviderReply> {
  const base = ollamaBaseUrl(cfg);
  const url = `${base}/api/chat`;
  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: "system", content: OLLAMA_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    stream: false,
    temperature: 0.3,
    frequency_penalty: 0,
    presence_penalty: 0,
    user: "scalene-user",
  });
  const retries = 3;
  let lastError: AiError | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await request(
        "local",
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body, signal },
        OLLAMA_UNREACHABLE(base),
      );
      if (!res.ok) {
        const data = await readJson("local", res);
        const message = str(obj(data).error) ?? `HTTP ${res.status}`;
        const kind: AiErrorKind = res.status === 404 ? "model-not-found" : kindForStatus(res.status);
        throw new AiError("local", kind, `Ollama error: ${message}`, res.status, data);
      }
      const text = await res.text();
      let aggregated = "";
      for (const chunk of text.split("\n")) {
        if (!chunk.trim()) continue;
        const json = obj(JSON.parse(chunk) as unknown);
        const content = str(obj(json.message).content);
        if (content) aggregated += content;
        if (json.done) break;
      }
      return { text: aggregated, model: cfg.model };
    } catch (e) {
      if (isAbort(e) || (isAiError(e) && e.kind === "aborted")) {
        throw isAiError(e) ? e : new AiError("local", "aborted", "Request cancelled.", undefined, e);
      }
      lastError = isAiError(e) ? e : new AiError("local", "unknown", `Ollama reply could not be read: ${String(e)}`, undefined, e);
      // A missing model will not appear on retry.
      if (lastError.kind === "model-not-found") break;
    }
  }
  throw lastError ?? new AiError("local", "unknown", "Ollama request failed.");
}

// ---------------------------------------------------------------------------
// Amazon Bedrock (InvokeModel, SigV4-signed)
// ---------------------------------------------------------------------------

/** Upstream picks the Anthropic body/response shape when the id starts with "us.anthropic". */
export function isBedrockAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("us.anthropic");
}

export function bedrockInvokeUrl(region: string, modelId: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
}

/** InvokeModel body exactly as upstream `amazon.ts` builds it. */
export function bedrockRequestBody(prompt: string, modelId: string): Record<string, unknown> {
  const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  if (isBedrockAnthropicModel(modelId)) {
    return { anthropic_version: "bedrock-2023-05-31", max_tokens: AMAZON_MAX_TOKENS, messages };
  }
  return { max_completion_tokens: AMAZON_MAX_TOKENS, messages };
}

export async function sendPromptToAmazon(
  prompt: string,
  cfg: AmazonConfig,
  signal?: AbortSignal,
  now?: Date,
): Promise<ProviderReply> {
  const region = cfg.region.trim() || DEFAULTS.amazonRegion;
  const modelId = cfg.model;
  const url = bedrockInvokeUrl(region, modelId);
  const body = JSON.stringify(bedrockRequestBody(prompt, modelId));
  let signed;
  try {
    signed = await signRequest({
      method: "POST",
      url,
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      region,
      service: "bedrock",
      credentials: {
        accessKeyId: cfg.accessKeyId.trim(),
        secretAccessKey: cfg.secretAccessKey.trim(),
        sessionToken: cfg.sessionToken.trim() || undefined,
      },
      date: now,
    });
  } catch (e) {
    throw new AiError("amazon", "unknown", e instanceof Error ? e.message : String(e), undefined, e);
  }
  const res = await request(
    "amazon",
    url,
    { method: "POST", headers: signed.headers, body, signal },
    `Could not reach Amazon Bedrock in region "${region}". Check the region and your connection.`,
  );
  const data = await readJson("amazon", res);
  if (!res.ok) {
    // Bedrock errors: {"message": "..."} plus header x-amzn-ErrorType: "ValidationException:..."
    const errorType = (res.headers.get("x-amzn-errortype") ?? "").split(":")[0];
    const message = str(obj(data).message) ?? str(obj(data).Message) ?? str(obj(data).__text) ?? `HTTP ${res.status}`;
    let kind = kindForStatus(res.status);
    if (/UnrecognizedClient|InvalidSignature|AccessDenied|ExpiredToken/i.test(errorType + message)) kind = "invalid-key";
    else if (/Throttling|TooManyRequests/i.test(errorType)) kind = "rate-limit";
    else if (/ResourceNotFound/i.test(errorType)) kind = "model-not-found";
    else if (/Validation/i.test(errorType)) kind = "bad-request";
    throw new AiError("amazon", kind, `Amazon Bedrock error: ${message}`, res.status, data);
  }
  if (isBedrockAnthropicModel(modelId)) {
    const content = obj(data).content;
    if (!Array.isArray(content) || content.length === 0) throw emptyReply("amazon", data);
    return { text: str(obj(content[0]).text) ?? "", model: modelId };
  }
  const text = chatCompletionText(data);
  if (text === undefined) throw emptyReply("amazon", data);
  return { text, model: modelId };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The model id a proposal would use with these settings. */
export function resolvedModel(provider: ProviderId, configs: ProviderConfigs): string {
  switch (provider) {
    case "openai":
      return openaiModel(configs.openai);
    case "anthropic":
      return anthropicModel(configs.anthropic);
    case "gemini":
      return geminiModel(configs.gemini);
    case "azure-openai":
      return azureDeployment(configs["azure-openai"]);
    case "amazon":
      return configs.amazon.model;
    case "local":
      return configs.local.model;
  }
}

export function sendPromptToProvider(
  provider: ProviderId,
  prompt: string,
  configs: ProviderConfigs,
  signal?: AbortSignal,
): Promise<ProviderReply> {
  switch (provider) {
    case "openai":
      return sendPromptToOpenAI(prompt, configs.openai, signal);
    case "anthropic":
      return sendPromptToAnthropic(prompt, configs.anthropic, signal);
    case "gemini":
      return sendPromptToGemini(prompt, configs.gemini, signal);
    case "azure-openai":
      return sendPromptToAzureOpenAI(prompt, configs["azure-openai"], signal);
    case "amazon":
      return sendPromptToAmazon(prompt, configs.amazon, signal);
    case "local":
      return sendPromptToOllama(prompt, configs.local, signal);
  }
}

/** Static options for a provider's model select (empty for Ollama). */
export function staticModels(provider: ProviderId): readonly ModelOption[] {
  return providerInfo(provider).models;
}
