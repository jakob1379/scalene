// Pure helpers for the AI views (DESIGN.md §4.14): no DOM, unit-tested in Node.
// Line diff (LCS), indentation handling, model-name shortening, the AiError copy table
// (§4.14.5) and the upstream element ids of the settings drawer (§4.14.4).
import type { AiError, AiErrorKind, ProviderId } from "../../ai/index";
import { NBSP } from "../../core/format";

// ── Element ids (upstream `.persistent` inputs; storage keys per src/ai/settings.ts) ──

/** Provider field → upstream element id. Equal to the storage key except OpenAI's key ("api-key"). */
export const FIELD_IDS: Readonly<Record<ProviderId, Readonly<Record<string, string>>>> = {
  amazon: {
    accessKeyId: "aws-access-key",
    secretAccessKey: "aws-secret-key",
    sessionToken: "aws-session-token",
    region: "aws-region",
    model: "language-model-amazon",
  },
  anthropic: {
    apiKey: "anthropic-api-key",
    model: "language-model-anthropic",
    customModel: "anthropic-custom-model",
    customUrl: "anthropic-custom-url",
  },
  "azure-openai": {
    apiKey: "azure-api-key",
    endpoint: "azure-api-url",
    model: "language-model-azure",
    customModel: "azure-custom-model",
    apiVersion: "azure-api-version",
  },
  gemini: {
    apiKey: "gemini-api-key",
    model: "language-model-gemini",
    customModel: "gemini-custom-model",
    customUrl: "gemini-custom-url",
  },
  openai: {
    apiKey: "api-key",
    model: "language-model-openai",
    customModel: "openai-custom-model",
    customUrl: "openai-custom-url",
  },
  local: { host: "local-ip", port: "local-port", model: "language-model-local" },
};

export function fieldElementId(provider: ProviderId, field: string): string | null {
  return FIELD_IDS[provider][field] ?? null;
}

/** Resolve a focus request (a provider field name or an element id) to an element id. */
export function resolveFocusField(provider: ProviderId, focus: string | undefined): string | null {
  if (!focus) return null;
  const own = FIELD_IDS[provider][focus];
  if (own) return own;
  for (const p of Object.keys(FIELD_IDS) as ProviderId[]) {
    if (Object.values(FIELD_IDS[p]).includes(focus)) return focus;
  }
  return null;
}

/** The credential field to focus for an `invalid-key` error. */
export function keyFieldId(provider: ProviderId): string {
  if (provider === "amazon") return FIELD_IDS.amazon.accessKeyId;
  if (provider === "local") return FIELD_IDS.local.host;
  return FIELD_IDS[provider].apiKey;
}

// ── Model names ─────────────────────────────────────────────────────────────────

/**
 * Short model label: "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5",
 * "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5". Other ids unchanged.
 */
export function shortModel(id: string): string {
  let s = id.trim();
  s = s.replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
  s = s.replace(/-v\d+(?::\d+)?$/, "");
  s = s.replace(/-(?:19|20)\d{6}$/, "");
  return s || id;
}

// ── Indentation ─────────────────────────────────────────────────────────────────

const indentOf = (s: string): number => {
  let n = 0;
  while (n < s.length && (s[n] === " " || s[n] === "\t")) n++;
  return n;
};

/** Split code into lines (canonical newlines, no trailing newline). */
export function splitLines(code: string): string[] {
  const text = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return text === "" ? [] : text.split("\n");
}

/** Smallest indentation over the non-blank lines (0 when all are blank). */
export function baseIndent(lines: readonly string[]): number {
  let min = Infinity;
  for (const l of lines) if (l.trim()) min = Math.min(min, indentOf(l));
  return Number.isFinite(min) ? min : 0;
}

/** Remove the common indentation (tabs count as one column, as Python sees them). */
export function dedent(lines: readonly string[]): string[] {
  const k = baseIndent(lines);
  return lines.map((l) => (l.trim() ? l.slice(k) : ""));
}

/** Dedent, then indent every non-blank line by `spaces` (upstream: the clicked line's indentation). */
export function reindent(code: string, spaces: number): string[] {
  const pad = " ".repeat(Math.max(0, Math.min(64, Math.floor(spaces))));
  return dedent(splitLines(code)).map((l) => (l ? pad + l : l));
}

// ── Line diff (LCS) ─────────────────────────────────────────────────────────────

export interface DiffRow {
  op: "same" | "del" | "add";
  text: string;
  /** Original line number for "same"/"del" rows, null for "add". */
  no: number | null;
}

/** Above this many cells the LCS table is skipped (all removed, then all added). */
const LCS_CELL_CAP = 250_000;

/**
 * Line diff of the original block (lines `startLine…`) against the proposal, by longest common
 * subsequence. Both sides are dedented first and compared without trailing whitespace, so a
 * proposal returned at a different base indentation still lines up.
 */
export function lineDiff(original: readonly string[], startLine: number, proposal: readonly string[]): DiffRow[] {
  const a = dedent(original);
  const b = dedent(proposal);
  const n = a.length;
  const m = b.length;
  const key = (s: string) => s.trimEnd();
  const rows: DiffRow[] = [];
  if (n * m > LCS_CELL_CAP) {
    a.forEach((t, i) => rows.push({ op: "del", text: t, no: startLine + i }));
    b.forEach((t) => rows.push({ op: "add", text: t, no: null }));
    return rows;
  }
  // dp[i][j] = LCS length of a[i:] and b[j:], flattened.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = key(a[i]) === key(b[j]) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) {
      rows.push({ op: "same", text: b[j], no: startLine + i });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      rows.push({ op: "del", text: a[i], no: startLine + i });
      i++;
    } else {
      rows.push({ op: "add", text: b[j], no: null });
      j++;
    }
  }
  for (; i < n; i++) rows.push({ op: "del", text: a[i], no: startLine + i });
  for (; j < m; j++) rows.push({ op: "add", text: b[j], no: null });
  return rows;
}

export function diffStats(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.op === "add") added++;
    else if (r.op === "del") removed++;
  }
  return { added, removed };
}

// ── Error copy (§4.14.5) ────────────────────────────────────────────────────────

export type ErrorAction = "retry" | "settings" | "model";

export interface ErrorView {
  /** Main sentence (never empty). */
  message: string;
  /** Second line (Local network hint), or null. */
  hint: string | null;
  /** Actions in display order; "retry" is always first. */
  actions: ErrorAction[];
  /** Milliseconds before Retry is enabled (rate limit). */
  retryDelayMs: number;
  /** Drawer field to focus for "settings" / "model". */
  focusField: string | null;
  /** Remove the card without a message (aborted). */
  silent: boolean;
}

/** Card copy and actions for an AiError (DESIGN.md §4.14.5). */
export function errorView(e: Pick<AiError, "kind" | "message" | "provider">, opts: { providerLabel: string; model: string }): ErrorView {
  const base: ErrorView = { message: e.message || "The request failed.", hint: null, actions: ["retry"], retryDelayMs: 0, focusField: null, silent: false };
  const kind: AiErrorKind = e.kind;
  switch (kind) {
    case "missing-credentials":
    case "invalid-key":
      return { ...base, actions: ["retry", "settings"], focusField: keyFieldId(e.provider) };
    case "quota":
      return { ...base, message: "The provider reports that the quota is exhausted." };
    case "rate-limit":
      return { ...base, message: "Rate limited, try again in a moment.", retryDelayMs: 5000 };
    case "model-not-found":
      return { ...base, message: `Model not found: ${opts.model}.`, actions: ["retry", "model"], focusField: fieldElementId(e.provider, "model") };
    case "network":
      return {
        ...base,
        message: `Couldn't reach ${e.provider === "local" ? "the Ollama server" : opts.providerLabel} (network or CORS).`,
        hint: e.provider === "local" ? "Is `ollama serve` running? Origins other than localhost and file:// need `OLLAMA_ORIGINS`." : null,
      };
    case "empty-response":
      return { ...base, message: "The provider returned no code." };
    case "aborted":
      return { ...base, actions: [], silent: true };
    default:
      return base;
  }
}

/** "Details" disclosure text: status, error message, and an excerpt of the response body. */
export function errorDetail(e: Pick<AiError, "kind" | "status" | "detail" | "message">, max = 1200): string {
  const parts: string[] = [`kind: ${e.kind}`];
  if (e.status !== undefined) parts.push(`status: ${e.status}`);
  let body = "";
  const d = e.detail as unknown;
  if (d !== undefined && d !== null) {
    if (typeof d === "string") body = d;
    else if (d instanceof Error) body = `${d.name}: ${d.message}`;
    else {
      const rec = d as Record<string, unknown>;
      if (typeof rec.__text === "string") body = rec.__text;
      else {
        try {
          body = JSON.stringify(d, null, 2);
        } catch {
          body = String(d);
        }
      }
    }
  }
  if (body && body !== "{}") parts.push(body.length > max ? `${body.slice(0, max)}…` : body);
  else parts.push(e.message);
  return parts.join("\n");
}

// ── Labels ─────────────────────────────────────────────────────────────────────

/** The one privacy sentence, shared by the setup/confirm cards and the settings drawer. */
export const AI_PRIVACY =
  "Proposals go from your browser straight to the provider you choose. Scalene sends the selected code, up to 9 lines before it and its profile numbers, never the file name.";

/** "line 173" / "lines 152–184". */
export function rangeLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

/** Live elapsed time in whole seconds (1 s ticks): "0 s", "48 s", "2 min 05 s". */
export function elapsedLabel(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}${NBSP}s`;
  return `${Math.floor(s / 60)}${NBSP}min${NBSP}${String(s % 60).padStart(2, "0")}${NBSP}s`;
}

/** Duration of a finished request: "850 ms", "6.2 s", "48 s", "2 min 05 s". */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}${NBSP}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}${NBSP}s`;
  return elapsedLabel(ms);
}

/** Anchor key of a card: `${file}:${line}` (file names may contain ":"). */
export function anchorOf(file: string, line: number): string {
  return `${file}:${line}`;
}

export function parseAnchor(anchor: string): { file: string; line: number } {
  const i = anchor.lastIndexOf(":");
  return { file: anchor.slice(0, i), line: Number(anchor.slice(i + 1)) };
}
