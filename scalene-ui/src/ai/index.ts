/**
 * Public API of the AI optimization-proposal feature (UI-agnostic, no DOM).
 *
 *   const env = await fetchEnvApiKeys();
 *   let settings = syncSettingsWithProfile(loadSettings({ env }), profile);
 *   const avail = computeProposalAvailability(profile.files[f].lines);
 *   const req = requestFromProfile(profile, f, lineno, "line");
 *   const { code } = await proposeOptimization(req, settings, abort.signal);
 *
 * See notes/ai.md for the full contract.
 */

import { providerInfo, type ModelOption, type ProviderId } from "./catalog";
import {
  AiError,
  isBedrockAnthropicModel,
  fetchGeminiModels,
  fetchOllamaModels,
  fetchOpenAIModels,
  resolvedModel,
  sendPromptToProvider,
  staticModels,
  validateOpenAIKey,
  type KeyStatus,
} from "./providers";
import {
  buildOptimizationPrompt,
  buildProposalContext,
  effectivePromptKind,
  type ProfileLine,
  type ProposalContext,
  type ProposalMode,
} from "./prompts";
import { acceleratorName, type AiSettings } from "./settings";

export * from "./providers";
export * from "./prompts";
export * from "./settings";
export { signRequest, deriveSigningKey, type AwsCredentials, type SignRequestInput, type SignedRequest } from "./sigv4";

// ---------------------------------------------------------------------------
// Response post-processing (upstream optimizations.ts / providers)
// ---------------------------------------------------------------------------

/** Upstream provider cleanup `replace(/^\s*[\r\n]/gm, "")`: drops every blank line. */
export function stripBlankLines(text: string): string {
  return text.replace(/^\s*[\r\n]/gm, "");
}

/** Upstream amazon.ts: drop `<reasoning>...</reasoning>` blocks (non-Anthropic Bedrock models). */
export function removeReasoning(text: string): string {
  return text.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, "");
}

/**
 * Upstream `extractPythonCodeBlock` (used for Ollama): concatenate every
 * fenced block (```python ... ``` or ``` ... ```), separated by a blank line.
 */
export function extractPythonCodeBlock(markdown: string): string {
  const pattern = /```python\s*([\s\S]*?)```|```([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let extracted = "";
  while ((match = pattern.exec(markdown)) !== null) {
    const block = match[1] ? match[1] : match[2];
    if (extracted && block) extracted += "\n\n";
    extracted += block;
  }
  return extracted;
}

/**
 * Upstream `extractCode`: when the first non-blank line opens a fence
 * (``` or ```lang), take the text after it up to the next ```; otherwise the
 * text up to the first ```. Deviation: a reply that starts with prose and
 * contains a fenced block (upstream returned just the prose) yields the
 * fenced code instead.
 */
export function extractCode(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i === lines.length) return "";
  const firstLine = lines[i].trim();
  let block: string;
  const fenceAt = text.indexOf(firstLine);
  if (firstLine === "```") {
    block = text.slice(fenceAt + 3);
  } else if (firstLine.startsWith("```")) {
    const word = firstLine.slice(3).trim();
    block = word.length > 0 && !word.includes(" ") ? text.slice(fenceAt + firstLine.length) : text;
  } else if (text.includes("```")) {
    return extractPythonCodeBlock(text);
  } else {
    block = text;
  }
  const end = block.indexOf("```");
  return end === -1 ? block : block.slice(0, end);
}

/** Canonicalize newlines and drop leading blank lines / trailing whitespace (indentation is kept). */
export function tidyCode(code: string): string {
  return code
    .replace(/\r?\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
}

/** The per-provider pipeline upstream applied between the API reply and display. */
export function postProcessResponse(provider: ProviderId, raw: string, model: string): string {
  let code: string;
  switch (provider) {
    case "local":
      code = raw.includes("```") ? extractPythonCodeBlock(raw) : raw;
      break;
    case "amazon": {
      const text = isBedrockAnthropicModel(model) ? raw : removeReasoning(raw);
      code = extractCode(text.trim());
      break;
    }
    default:
      code = extractCode(stripBlankLines(raw));
  }
  return tidyCode(code);
}

// ---------------------------------------------------------------------------
// Readiness, key validation, model lists
// ---------------------------------------------------------------------------

export interface Readiness {
  ready: boolean;
  /** Provider fields (keys of `settings.providers[provider]`) that must be filled. */
  missing: string[];
  /** User-facing explanation when not ready (upstream alert texts). */
  message: string;
}

/** Setup copy when no provider was chosen yet (the default is only the select's first option). */
export const CHOOSE_PROVIDER_MESSAGE =
  "Choose an AI provider — Anthropic, OpenAI, Google Gemini, Azure OpenAI, Amazon Bedrock or a local Ollama model — and add its key.";

/**
 * Can a proposal be requested with these settings? (upstream pre-checks, plus Azure/Bedrock
 * ones). With `opts.chosen === false` (no stored provider, no environment keys) the message
 * asks to choose a provider instead of naming the default's fields.
 */
export function checkReady(settings: AiSettings, provider: ProviderId = settings.provider, opts: { chosen?: boolean } = {}): Readiness {
  const p = settings.providers;
  const missing: string[] = [];
  let message = "";
  const need = (ok: boolean, field: string) => {
    if (!ok) missing.push(field);
  };
  switch (provider) {
    case "openai":
      need(Boolean(p.openai.apiKey) || Boolean(p.openai.customUrl.trim()), "apiKey");
      message = "To activate proposed optimizations, enter an OpenAI API key in the AI settings.";
      break;
    case "anthropic":
      need(Boolean(p.anthropic.apiKey), "apiKey");
      message = "To activate proposed optimizations, enter an Anthropic API key in the AI settings.";
      break;
    case "gemini":
      need(Boolean(p.gemini.apiKey), "apiKey");
      message = "To activate proposed optimizations, enter a Google Gemini API key in the AI settings.";
      break;
    case "azure-openai":
      need(Boolean(p["azure-openai"].apiKey), "apiKey");
      need(Boolean(p["azure-openai"].endpoint.trim()), "endpoint");
      message = "To activate proposed optimizations, enter an Azure OpenAI API key and endpoint URL in the AI settings.";
      break;
    case "amazon":
      need(Boolean(p.amazon.accessKeyId.trim()), "accessKeyId");
      need(Boolean(p.amazon.secretAccessKey.trim()), "secretAccessKey");
      need(Boolean(p.amazon.model), "model");
      message = "To activate proposed optimizations, enter your AWS access key ID and secret key in the AI settings.";
      break;
    case "local":
      need(Boolean(p.local.model), "model");
      message = "You must be connected to a running Ollama server to activate proposed optimizations.";
      break;
  }
  if (missing.length && opts.chosen === false) message = CHOOSE_PROVIDER_MESSAGE;
  return { ready: missing.length === 0, missing, message: missing.length ? message : "" };
}

const keyStatusCache = new Map<string, KeyStatus>();

/**
 * Key check for the key indicator. Only OpenAI has a remote check (upstream
 * `checkApiKey`); other providers report "empty" or "unchecked".
 */
export async function validateApiKey(
  provider: ProviderId,
  settings: AiSettings,
  signal?: AbortSignal,
): Promise<KeyStatus> {
  const p = settings.providers;
  switch (provider) {
    case "openai": {
      const cfg = p.openai;
      const cacheKey = `${cfg.apiKey}\u0000${cfg.customUrl.trim()}`;
      const cached = keyStatusCache.get(cacheKey);
      if (cached) return cached;
      const status = await validateOpenAIKey(cfg, signal);
      if (status === "valid" || status === "invalid") keyStatusCache.set(cacheKey, status);
      return status;
    }
    case "anthropic":
      return p.anthropic.apiKey ? "unchecked" : "empty";
    case "gemini":
      return p.gemini.apiKey ? "unchecked" : "empty";
    case "azure-openai":
      return p["azure-openai"].apiKey ? "unchecked" : "empty";
    case "amazon":
      return p.amazon.accessKeyId && p.amazon.secretAccessKey ? "unchecked" : "empty";
    case "local":
      return "unchecked";
  }
}

export interface ModelListResult {
  models: ModelOption[];
  /** "remote" = fetched from the provider; "static" = the built-in list. */
  source: "remote" | "static";
  /** Why the remote list is not used (missing key, network, empty server...). */
  error?: AiError;
}

function asOptions(ids: readonly string[]): ModelOption[] {
  return ids.map((id) => ({ value: id, label: id }));
}

/**
 * Models for the provider's select. OpenAI and Gemini fetch the live list
 * (falling back to the built-in one when it is empty or fails, as upstream's
 * refresh buttons did); Ollama lists the local server's models; the others
 * return their built-in lists. Never rejects.
 */
export async function listModels(
  provider: ProviderId,
  settings: AiSettings,
  signal?: AbortSignal,
): Promise<ModelListResult> {
  const fallback = (error?: unknown): ModelListResult => ({
    models: [...staticModels(provider)],
    source: "static",
    error: error instanceof AiError ? error : error ? new AiError(provider, "unknown", String(error), undefined, error) : undefined,
  });
  try {
    if (provider === "openai") {
      const ids = await fetchOpenAIModels(settings.providers.openai, signal);
      return ids.length ? { models: asOptions(ids), source: "remote" } : fallback();
    }
    if (provider === "gemini") {
      const ids = await fetchGeminiModels(settings.providers.gemini, signal);
      return ids.length ? { models: asOptions(ids), source: "remote" } : fallback();
    }
    if (provider === "local") {
      const ids = await fetchOllamaModels(settings.providers.local, signal);
      if (ids.length) return { models: asOptions(ids), source: "remote" };
      return {
        models: [],
        source: "remote",
        error: new AiError("local", "empty-response", "The Ollama server has no models installed. Run: ollama pull codellama"),
      };
    }
    return fallback();
  } catch (e) {
    return fallback(e);
  }
}

/** Options for a model select, with the current selection kept even when it is not in `models`. */
export function modelOptions(
  provider: ProviderId,
  settings: AiSettings,
  models: readonly ModelOption[] = staticModels(provider),
): ModelOption[] {
  const selected = (settings.providers[provider] as { model: string }).model;
  const out = [...models];
  if (selected && !out.some((m) => m.value === selected)) out.unshift({ value: selected, label: selected });
  return out;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface OptimizationRequest {
  /** "line": the clicked line (lightning). "region": its enclosing loop/function (explosion). */
  mode: ProposalMode;
  /** Clicked line number (for regions: the line carrying the region button). */
  lineno: number;
  /** All lines of the file, as in `profile.files[name].lines`. */
  lines: readonly ProfileLine[];
  /** `profile.files[name].imports` (used by the targeted prompts). */
  imports?: readonly string[];
  /** `acceleratorName(profile)`; default "GPU". */
  gpuDeviceName?: string;
  /** File name, informational only (not part of the prompt, as upstream). */
  fileName?: string;
}

/** Minimal profile shape `requestFromProfile` needs (the real Profile type is assignable). */
export interface ProfileForAi {
  gpu?: boolean;
  gpu_device?: string;
  files: Record<string, { lines: readonly ProfileLine[]; imports?: readonly string[] }>;
}

export function requestFromProfile(
  profile: ProfileForAi,
  fileName: string,
  lineno: number,
  mode: ProposalMode,
): OptimizationRequest {
  const file = profile.files[fileName];
  if (!file) throw new Error(`File not in profile: ${fileName}`);
  return {
    mode,
    lineno,
    lines: file.lines,
    imports: file.imports ?? [],
    gpuDeviceName: acceleratorName(profile),
    fileName,
  };
}

export interface PreparedProposal {
  provider: ProviderId;
  model: string;
  prompt: string;
  /** Which prompt was built. */
  promptKind: "insights" | "performance" | "memory";
  context: ProposalContext;
}

/** Build the prompt without sending it (for a "show prompt" disclosure or tests). */
export function preparePrompt(request: OptimizationRequest, settings: AiSettings): PreparedProposal {
  const context = buildProposalContext(request.lines, request.lineno, request.mode);
  const prompt = buildOptimizationPrompt(context, {
    target: settings.target,
    useGpu: settings.useGpu,
    gpuDeviceName: request.gpuDeviceName || "GPU",
    style: settings.promptStyle,
    imports: request.imports ?? [],
  });
  return {
    provider: settings.provider,
    model: resolvedModel(settings.provider, settings.providers),
    prompt,
    promptKind: effectivePromptKind(settings.promptStyle, settings.target),
    context,
  };
}

export interface OptimizationResult {
  /** Proposed code: what upstream displayed and copied on click (newlines canonicalized). */
  code: string;
  /** The model's reply before code extraction. */
  raw: string;
  prompt: string;
  promptKind: PreparedProposal["promptKind"];
  provider: ProviderId;
  model: string;
  mode: ProposalMode;
  /** Lines the proposal replaces (inclusive). */
  startLine: number;
  endLine: number;
  /** Leading whitespace of the clicked line; upstream indents the shown code by it. */
  leadingSpaces: number;
  elapsedMs: number;
}

export interface ProposeOptions {
  /** Pre-check the OpenAI key as upstream did before every proposal (cached). Default true. */
  validateKey?: boolean;
}

/**
 * Request an optimization proposal. Rejects with `AiError`:
 * "missing-credentials" (see `checkReady`), "invalid-key", "quota",
 * "rate-limit", "model-not-found", "bad-request", "server", "network",
 * "aborted" (signal), "empty-response" (no code in the reply).
 */
export async function proposeOptimization(
  request: OptimizationRequest,
  settings: AiSettings,
  signal?: AbortSignal,
  options: ProposeOptions = {},
): Promise<OptimizationResult> {
  const provider = settings.provider;
  const readiness = checkReady(settings);
  if (!readiness.ready) throw new AiError(provider, "missing-credentials", readiness.message);

  if (provider === "openai" && options.validateKey !== false) {
    const status = await validateApiKey("openai", settings, signal);
    if (status === "invalid") {
      throw new AiError("openai", "invalid-key", "You must enter a valid OpenAI API key to activate proposed optimizations.");
    }
  }

  const prepared = preparePrompt(request, settings);
  const started = Date.now();
  const reply = await sendPromptToProvider(provider, prepared.prompt, settings.providers, signal);
  const code = postProcessResponse(provider, reply.text, reply.model);
  if (!code.trim()) {
    throw new AiError(provider, "empty-response", "The model did not return any code. Try again or pick another model.", undefined, reply.text);
  }
  return {
    code,
    raw: reply.text,
    prompt: prepared.prompt,
    promptKind: prepared.promptKind,
    provider,
    model: reply.model,
    mode: request.mode,
    startLine: prepared.context.startLine,
    endLine: prepared.context.endLine,
    leadingSpaces: prepared.context.leadingSpaces,
    elapsedMs: Date.now() - started,
  };
}

/** Provider label for messages ("Amazon Bedrock", "Local (Ollama)", ...). */
export function providerLabel(provider: ProviderId): string {
  return providerInfo(provider).label;
}
