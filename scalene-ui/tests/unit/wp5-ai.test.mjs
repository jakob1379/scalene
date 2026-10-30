// WP5 AI views (DESIGN.md §4.14, §8.5): pure helpers (diff, indentation, model names, the
// AiError copy table, upstream element ids) and the AiController state machine with a
// mocked fetch and storage (setup → working → result / error, cancel, regenerate,
// persistence through saveSettings).
import assert from "node:assert/strict";
import { fixture, mod, model, test, withModel } from "./_harness.mjs";

const L = mod("views/ai/logic");
const ai = mod("ai/index");

// ── Pure helpers ────────────────────────────────────────────────────────────────

test("shortModel drops date stamps, Bedrock prefixes and version suffixes", () => {
  assert.equal(L.shortModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(L.shortModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5");
  assert.equal(L.shortModel("gpt-5.2"), "gpt-5.2");
  assert.equal(L.shortModel("gemini-3-pro-preview"), "gemini-3-pro-preview");
  assert.equal(L.shortModel("codellama:7b"), "codellama:7b");
});

test("dedent / reindent keep relative indentation and use the clicked line's indent", () => {
  assert.deepEqual(L.dedent(["    a", "      b", "", "    c"]), ["a", "  b", "", "c"]);
  assert.deepEqual(L.reindent("x = 1\nif x:\n    y = 2\n", 8), ["        x = 1", "        if x:", "            y = 2"]);
  assert.deepEqual(L.reindent("\r\n  a\r\n\r\n  b", 2), ["", "  a", "", "  b"]);
  assert.equal(L.baseIndent(["", "   "]), 0);
  assert.deepEqual(L.splitLines("a\r\nb\n\n"), ["a", "b"]);
});

test("lineDiff: LCS rows with original line numbers; indentation-insensitive", () => {
  const rows = L.lineDiff(["        loss_value = loss.item()"], 173, ["loss_sum += loss.detach()", "loss_value = loss.item()"]);
  assert.deepEqual(
    rows.map((r) => [r.op, r.no, r.text]),
    [
      ["add", null, "loss_sum += loss.detach()"],
      ["same", 173, "loss_value = loss.item()"],
    ],
  );
  const r2 = L.lineDiff(["a", "b", "c", "d"], 10, ["a", "x", "c", "d", "e"]);
  assert.deepEqual(r2.map((r) => `${r.op}:${r.text}:${r.no}`), ["same:a:10", "del:b:11", "add:x:null", "same:c:12", "same:d:13", "add:e:null"]);
  assert.deepEqual(L.diffStats(r2), { added: 2, removed: 1 });
  // Pure replacement, empty proposal, empty original.
  assert.deepEqual(L.lineDiff(["a"], 1, []).map((r) => r.op), ["del"]);
  assert.deepEqual(L.lineDiff([], 1, ["a"]).map((r) => r.op), ["add"]);
  // Very large inputs skip the table (all removed, then all added) instead of allocating it.
  const big = Array.from({ length: 600 }, (_, i) => `x${i}`);
  const r3 = L.lineDiff(big, 1, big.map((s) => s + "y"));
  assert.equal(r3.length, 1200);
  assert.equal(r3[0].op, "del");
  assert.equal(r3[1199].op, "add");
});

test("errorView: §4.14.5 copy and actions for every AiError kind", () => {
  const v = (kind, provider = "anthropic", message = "msg") => L.errorView({ kind, provider, message }, { providerLabel: ai.providerLabel(provider), model: "claude-x" });
  assert.deepEqual(v("missing-credentials"), { message: "msg", hint: null, actions: ["retry", "settings"], retryDelayMs: 0, focusField: "anthropic-api-key", silent: false });
  assert.deepEqual(v("invalid-key", "amazon").actions, ["retry", "settings"]);
  assert.equal(v("invalid-key", "amazon").focusField, "aws-access-key");
  assert.equal(v("invalid-key", "openai").focusField, "api-key");
  assert.equal(v("quota").message, "The provider reports that the quota is exhausted.");
  assert.equal(v("rate-limit").message, "Rate limited, try again in a moment.");
  assert.equal(v("rate-limit").retryDelayMs, 5000);
  assert.equal(v("model-not-found").message, "Model not found: claude-x.");
  assert.deepEqual(v("model-not-found").actions, ["retry", "model"]);
  assert.equal(v("model-not-found", "gemini").focusField, "language-model-gemini");
  assert.equal(v("network").message, "Couldn't reach Anthropic (network or CORS).");
  assert.equal(v("network").hint, null);
  assert.equal(v("network", "local").message, "Couldn't reach the Ollama server (network or CORS).");
  assert.match(v("network", "local").hint, /ollama serve.*OLLAMA_ORIGINS/);
  assert.equal(v("empty-response").message, "The provider returned no code.");
  assert.equal(v("aborted").silent, true);
  assert.deepEqual(v("aborted").actions, []);
  for (const k of ["bad-request", "server", "unknown"]) assert.equal(v(k, "anthropic", "Anthropic API error: x").message, "Anthropic API error: x");
  assert.equal(v("unknown", "anthropic", "").message, "The request failed.");
});

test("setup copy: provider-specific fields only once a provider is chosen; one privacy sentence", () => {
  const settings = ai.defaultSettings({});
  assert.equal(settings.provider, "amazon", "the select's first option is only a default");
  assert.equal(ai.checkReady(settings, "amazon", { chosen: false }).message, ai.CHOOSE_PROVIDER_MESSAGE);
  assert.match(ai.checkReady(settings, "amazon", { chosen: true }).message, /AWS access key ID and secret key in the AI settings\.$/);
  assert.match(ai.CHOOSE_PROVIDER_MESSAGE, /Anthropic, OpenAI, Google Gemini, Azure OpenAI, Amazon Bedrock or a local Ollama model/);
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  assert.equal(ai.providerChosen({ storage, env: {} }), false);
  assert.equal(ai.providerChosen({ storage, env: { anthropic: "sk" } }), true, "environment keys pick the provider");
  storage.setItem("service-select", "amazon");
  assert.equal(ai.providerChosen({ storage, env: {} }), true, "a stored choice counts, even Amazon");
  assert.match(L.AI_PRIVACY, /never the file name\.$/);
});

test("errorDetail: status plus a bounded body excerpt", () => {
  const d = L.errorDetail({ kind: "rate-limit", status: 429, message: "m", detail: { error: { type: "rate_limit_error" } } });
  assert.match(d, /^kind: rate-limit\nstatus: 429\n\{/);
  assert.match(L.errorDetail({ kind: "network", message: "Could not reach x", detail: new TypeError("Failed to fetch") }), /TypeError: Failed to fetch/);
  assert.match(L.errorDetail({ kind: "server", message: "m", detail: { __text: "<html>502</html>" } }), /<html>502<\/html>/);
  assert.ok(L.errorDetail({ kind: "server", message: "m", detail: "x".repeat(5000) }).length < 1300);
  assert.match(L.errorDetail({ kind: "unknown", message: "only the message" }), /only the message$/);
});

test("FIELD_IDS are the upstream element ids and match the storage keys of src/ai/settings.ts", () => {
  const ids = Object.values(L.FIELD_IDS).flatMap((m) => Object.values(m)).sort();
  const spec = ["api-key", "language-model-openai", "openai-custom-model", "openai-custom-url", "anthropic-api-key", "language-model-anthropic", "anthropic-custom-model", "anthropic-custom-url", "gemini-api-key", "language-model-gemini", "gemini-custom-model", "gemini-custom-url", "azure-api-key", "azure-api-url", "language-model-azure", "azure-custom-model", "azure-api-version", "aws-access-key", "aws-secret-key", "aws-session-token", "aws-region", "language-model-amazon", "local-ip", "local-port", "language-model-local"].sort();
  assert.deepEqual(ids, spec);
  for (const b of ai.FIELD_BINDINGS) {
    const id = L.FIELD_IDS[b.provider][b.field];
    assert.equal(b.key === "scalene-api-key" ? "api-key" : b.key, id, `${b.provider}.${b.field}`);
  }
  // Every catalog field has an id.
  for (const p of ai.PROVIDERS) for (const f of p.fields) assert.ok(L.FIELD_IDS[p.id][f.field], `${p.id}.${f.field}`);
});

test("resolveFocusField accepts provider field names and element ids", () => {
  assert.equal(L.resolveFocusField("amazon", "accessKeyId"), "aws-access-key");
  assert.equal(L.resolveFocusField("openai", "apiKey"), "api-key");
  assert.equal(L.resolveFocusField("openai", "language-model-openai"), "language-model-openai");
  assert.equal(L.resolveFocusField("openai", "anthropic-api-key"), "anthropic-api-key");
  assert.equal(L.resolveFocusField("openai", "model"), "language-model-openai");
  assert.equal(L.resolveFocusField("openai", "nonsense"), null);
  assert.equal(L.resolveFocusField("openai", undefined), null);
});

test("labels: ranges, live elapsed (1\u00a0s ticks), durations, anchors with colons", () => {
  assert.equal(L.rangeLabel(173, 173), "line 173");
  assert.equal(L.rangeLabel(152, 184), "lines 152\u2013184");
  assert.equal(L.elapsedLabel(0), "0\u00a0s");
  assert.equal(L.elapsedLabel(5999), "5\u00a0s");
  assert.equal(L.elapsedLabel(125_000), "2\u00a0min\u00a005\u00a0s");
  assert.equal(L.durationLabel(301), "301\u00a0ms");
  assert.equal(L.durationLabel(6200), "6.2\u00a0s");
  assert.equal(L.durationLabel(48_000), "48\u00a0s");
  assert.deepEqual(L.parseAnchor(L.anchorOf("C:\\proj\\a.py", 12)), { file: "C:\\proj\\a.py", line: 12 });
});

// ── src/ai bug check: prompts over every fixture are well-formed ────────────────

for (const name of ["ml-training", "async-server", "cpu-only", "neuron", "basic", "example"]) {
  test(`${name}: every eligible line and region builds a prompt without NaN/undefined`, () => {
    const p = fixture(name);
    if (!p) return;
    const settings = ai.defaultSettings();
    let n = 0;
    for (const [file, data] of Object.entries(p.files)) {
      const avail = ai.computeProposalAvailability(data.lines ?? [], 50);
      for (const [lineno, a] of avail) {
        for (const mode of ["line", "region"]) {
          if (mode === "line" ? !a.line : !a.region) continue;
          for (const target of ["performance", "memory"]) {
            const req = ai.requestFromProfile(p, file, lineno, mode);
            const prep = ai.preparePrompt(req, { ...settings, target });
            assert.ok(!/NaN|undefined|Infinity/.test(prep.prompt), `${file}:${lineno} ${mode} ${target}: ${prep.prompt.match(/.{0,40}(NaN|undefined|Infinity).{0,40}/)?.[0]}`);
            assert.ok(prep.context.startLine <= lineno || mode === "region");
            n++;
            if (n > 400) return;
          }
        }
      }
    }
  });
}

// ── Controller state machine (mocked fetch + storage) ───────────────────────────

class MemStorage {
  constructor() {
    this.m = new Map();
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(k, String(v));
  }
  removeItem(k) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  get length() {
    return this.m.size;
  }
}

function setupEnv() {
  globalThis.window ??= globalThis;
  globalThis.localStorage = new MemStorage();
  const { createBus } = mod("core/bus");
  const toasts = [];
  const said = [];
  const shell = {
    bus: createBus(),
    toast: { show: (t) => (toasts.push(t), () => {}) },
    announce: { polite: (s) => said.push(["polite", s]), assertive: (s) => said.push(["assertive", s]) },
  };
  const { createAiController } = mod("views/ai/controller");
  return { ctrl: createAiController(shell), toasts, said, shell };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const REPLY = "```python\nloss_sum += loss.detach()\nloss_value = loss.item()\n```";

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}

withModel("ml-training", "controller: setup without credentials, then working → result with Anthropic", async (m) => {
  const { ctrl, said } = setupEnv();
  ctrl.load(m);
  const file = m.files.find((f) => f.base === "train.py").name;
  const anchor = `${file}:173`;
  assert.equal(ctrl.providerSummary(), "No AI provider set up");
  assert.equal(ctrl.availability(file).get(173).line, true);
  assert.equal(ctrl.settings().useGpu, true, "GPU toggle follows profile.gpu");

  const calls = mockFetch(() => new Response(JSON.stringify({ content: [{ type: "text", text: REPLY }] }), { status: 200 }));
  ctrl.request(file, 173, "line");
  let s = ctrl.card(anchor);
  assert.equal(s.status, "setup");
  assert.deepEqual(s.missing, ["accessKeyId", "secretAccessKey"]);
  assert.equal(s.message, ai.CHOOSE_PROVIDER_MESSAGE, "first-time user: choose a provider, no AWS key request (round 1)");
  assert.ok(!/AWS/.test(s.message));
  assert.equal(calls.length, 0, "no network for the setup card");
  assert.deepEqual(ctrl.anchors(file), [anchor]);

  const next = ai.updateProviderField({ ...ctrl.settings(), provider: "anthropic" }, "anthropic", "apiKey", "sk-ant-1");
  ctrl.setSettings(next);
  assert.equal(localStorage.getItem("service-select"), "anthropic");
  assert.equal(localStorage.getItem("scalene-service-select"), "anthropic");
  assert.equal(localStorage.getItem("anthropic-api-key"), "sk-ant-1");
  assert.equal(localStorage.getItem("use-gpu-checkbox"), null, "the profile-driven GPU toggle is not a user edit");
  assert.equal(ctrl.providerSummary(), "Anthropic \u00b7 claude-sonnet-4-5");

  ctrl.request(file, 173, "line");
  s = ctrl.card(anchor);
  assert.equal(s.status, "working");
  assert.equal(s.provider, "Anthropic");
  assert.equal(s.model, "claude-sonnet-4-5-20250929");
  assert.deepEqual([s.start, s.end, s.mode], [173, 173, "line"]);
  await tick(5);
  s = ctrl.card(anchor);
  assert.equal(s.status, "result");
  assert.equal(s.view, "proposal");
  assert.equal(s.result.code, "loss_sum += loss.detach()\nloss_value = loss.item()");
  assert.equal(s.result.startLine, 173);
  assert.equal(s.result.leadingSpaces, 8);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.anthropic\.com/);
  assert.ok(said.some(([k, t]) => k === "polite" && t === "Proposal ready for line 173"));

  // View-only patch keeps the card (no new request), Regenerate replaces it.
  ctrl.patchResult(anchor, { view: "diff", showPrompt: true });
  assert.equal(ctrl.card(anchor).view, "diff");
  ctrl.retry(anchor);
  assert.equal(ctrl.card(anchor).status, "working");
  await tick(5);
  assert.equal(ctrl.card(anchor).status, "result");
  assert.equal(ctrl.card(anchor).view, "proposal");
  assert.equal(calls.length, 2);
  assert.deepEqual(ctrl.anchors(file), [anchor], "one card per anchor");

  ctrl.dismiss(anchor);
  assert.equal(ctrl.card(anchor), null);
  ctrl.load(null);
  assert.deepEqual(ctrl.anchors(file), []);
});

withModel("ml-training", "controller: Cancel aborts the request and removes the card; errors become error cards", async (m) => {
  const { ctrl, toasts, said } = setupEnv();
  localStorage.setItem("service-select", "anthropic");
  localStorage.setItem("anthropic-api-key", "sk");
  ctrl.setSettings(ai.loadSettings());
  ctrl.load(m);
  const file = m.files.find((f) => f.base === "train.py").name;
  const anchor = `${file}:173`;
  let aborted = 0;
  mockFetch(
    (_u, init) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => {
          aborted++;
          rej(new DOMException("aborted", "AbortError"));
        });
      }),
  );
  ctrl.request(file, 173, "line");
  assert.equal(ctrl.card(anchor).status, "working");
  ctrl.cancel(anchor);
  assert.equal(ctrl.card(anchor), null);
  assert.equal(aborted, 1);
  assert.ok(toasts.some((t) => t.text === "Request cancelled"));
  await tick(5);
  assert.equal(ctrl.card(anchor), null, "the aborted promise does not resurrect the card");

  mockFetch(() => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow" } }), { status: 429 }));
  ctrl.request(file, 173, "region");
  await tick(5);
  const s = ctrl.card(anchor);
  assert.equal(s.status, "error");
  assert.equal(s.error.kind, "rate-limit");
  assert.equal(s.mode, "region");
  assert.ok(said.some(([k]) => k === "assertive"));
  assert.deepEqual(ctrl.requestOf(anchor), { file, line: 173, mode: "region" });

  // A newer request for the same anchor supersedes an older in-flight one.
  let n = 0;
  mockFetch(async () => {
    n++;
    const mine = n;
    await tick(mine === 1 ? 20 : 1);
    return new Response(JSON.stringify({ content: [{ type: "text", text: mine === 1 ? "```python\nold()\n```" : "```python\nnew()\n```" }] }), { status: 200 });
  });
  ctrl.request(file, 173, "line");
  ctrl.request(file, 173, "line");
  await tick(40);
  assert.equal(ctrl.card(anchor).result.code, "new()");
});

test("controller: requests for files outside the profile toast instead of throwing", () => {
  const m = model("ml-training");
  if (!m) return;
  const { ctrl, toasts } = setupEnv();
  ctrl.load(m);
  ctrl.request("/nope.py", 3, "line");
  assert.ok(toasts.some((t) => t.text === "This file is not in the profile"));
  assert.deepEqual(ctrl.anchors("/nope.py"), []);
});
