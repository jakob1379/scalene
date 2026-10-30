#!/usr/bin/env node
// WP5 acceptance checks in Chromium (DESIGN.md §8.6 WP5): AI cards with a mocked fetch for
// every provider and every AiError kind, Cancel / Regenerate, the settings drawer as a real
// modal that saves to the upstream storage keys, network silence on load (file:// and
// http://), env-key prefill, the loader (invalid JSON drop, {} → empty state, file input),
// the palette ("loss.item", "train", "Timeline"), the shortcuts dialog, and screenshots.
//
// Folded in from tools/wp5-check.mjs (DESIGN.md §8.6 WP5).
//   node build.mjs && node tools/render-fixture.mjs --fixtures ml-training,cpu-only,empty
//   node tools/e2e/shell-ai.mjs [--only ai,drawer,network,loader,palette,shots] [--shots-dir design/screens/e2e/shell-ai]
//
// Uses require("playwright") and chromium.launch() with no options.
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(process.env.SCALENE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const outDir = path.join(root, "out");
const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const only = argVal("--only", "") ? new Set(argVal("--only").split(",")) : null;
const shotsDir = path.resolve(argVal("--shots-dir", process.env.SHOTS || path.join(root, "design", "screens", "e2e", "shell-ai")));
const want = (k) => !only || only.has(k);

const { chromium } = require("playwright");
const browser = await chromium.launch();
const failures = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) failures.push(msg);
  return cond;
};
const pageUrl = (name, q = "?still") => `${pathToFileURL(path.join(outDir, `${name}.html`)).href}${q}`;

const REPLY = "```python\n# keep the running loss on the device: .item() syncs every step\nloss_sum += loss.detach()\nif (step + 1) % cfg.log_interval == 0:\n    loss_value = (loss_sum / cfg.log_interval).item()\n    loss_sum.zero_()\n```";
const REPLY2 = "```python\nloss_value = loss.detach()  # regenerated\n```";

/** Credentials per provider (localStorage keys of src/ai/settings.ts). */
const CREDS = {
  amazon: { "aws-access-key": "AKIAEXAMPLE", "aws-secret-key": "secret", "aws-region": "us-east-1" },
  anthropic: { "anthropic-api-key": "sk-ant-test" },
  "azure-openai": { "azure-api-key": "az-key", "azure-api-url": "https://example.openai.azure.com" },
  gemini: { "gemini-api-key": "AIza-test" },
  openai: { "scalene-api-key": "sk-test" },
  local: { "language-model-local": "codellama" },
};

/** Success payload per provider for REPLY text. */
function success(provider, text) {
  switch (provider) {
    case "amazon":
    case "anthropic":
      return { status: 200, body: JSON.stringify({ content: [{ type: "text", text }] }) };
    case "gemini":
      return { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) };
    case "local":
      return { status: 200, body: JSON.stringify({ message: { content: text }, done: true }) + "\n" };
    default:
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) };
  }
}

/**
 * Init script: seeds localStorage and replaces window.fetch with a scripted mock.
 * routes: [{ match (regex source), status, body, headers, hang, reject, delay }], first match wins;
 * a route with `seq` returns its bodies in turn.
 */
function mockInit({ storage, routes }) {
  localStorage.clear();
  for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  window.__calls = [];
  window.__aborted = 0;
  const counters = new Map();
  window.fetch = (url, init = {}) =>
    new Promise((resolve, reject) => {
      const u = String(url);
      window.__calls.push({ url: u, method: init.method || "GET", headers: init.headers || {}, body: init.body || null });
      const i = routes.findIndex((r) => new RegExp(r.match).test(u));
      const r = routes[i];
      if (!r) return reject(new TypeError(`unmocked ${u}`));
      const n = counters.get(i) || 0;
      counters.set(i, n + 1);
      const step = r.seq ? r.seq[Math.min(n, r.seq.length - 1)] : r;
      if (init.signal) init.signal.addEventListener("abort", () => {
        window.__aborted++;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
      if (step.hang) return;
      setTimeout(() => {
        if (step.reject) reject(new TypeError("Failed to fetch"));
        else resolve(new Response(step.body ?? "", { status: step.status ?? 200, headers: step.headers ?? { "content-type": "application/json" } }));
      }, step.delay ?? 60);
    });
}

async function open(name, { storage = {}, routes = [], viewport = { width: 1440, height: 900 }, theme = "light", query = "?still" } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(mockInit, { storage, routes });
  await page.goto(pageUrl(name, query));
  await page.waitForFunction(() => document.getElementById("scalene-app")?.getAttribute("aria-busy") !== "true");
  await page.waitForTimeout(150);
  return { context, page, errors };
}

/** Jump to train.py:173 and request a proposal through the legacy global. */
async function request(page, line = 173, mode = "line") {
  await page.evaluate(() => {
    const f = Object.keys(profile.files).find((n) => n.endsWith("train.py"));
    window.vsNavigate(escape(f), 173);
  });
  await page.waitForTimeout(250);
  await page.evaluate(
    ({ line, mode }) => {
      const f = Object.keys(profile.files).find((n) => n.endsWith("train.py"));
      const g = mode === "region" ? window.proposeOptimizationRegion : window.proposeOptimizationLine;
      g(escape(f), 0, encodeURIComponent(JSON.stringify({ lineno: line })));
    },
    { line, mode },
  );
}

const cardState = (page) =>
  page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".ai-card"));
    const c = cards[0];
    return c
      ? {
          n: cards.length,
          status: c.dataset.status,
          label: c.getAttribute("aria-label"),
          text: c.innerText,
          buttons: Array.from(c.querySelectorAll("button")).map((b) => (b.getAttribute("aria-label") || b.innerText).trim()),
        }
      : { n: 0 };
  });

async function waitStatus(page, status, timeout = 4000) {
  try {
    await page.waitForFunction((s) => document.querySelector(".ai-card")?.dataset.status === s, status, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function shot(page, name) {
  fs.mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

// ── 1. Every provider's happy path renders a result card (proposal + diff) ───────
if (want("ai")) {
  for (const provider of Object.keys(CREDS)) {
    const routes = [];
    if (provider === "openai") routes.push({ match: "/v1/completions$", status: 400, body: JSON.stringify({ error: { type: "invalid_request_error", code: null } }) });
    routes.push({ match: ".", ...success(provider, REPLY) });
    const { context, page, errors } = await open("ml-training", { storage: { "service-select": provider, ...CREDS[provider] }, routes });
    await request(page);
    const done = await waitStatus(page, "result");
    const s = await cardState(page);
    ok(done, `${provider}: no result card (status ${s.status}: ${s.text?.slice(0, 160)})`);
    ok(s.n === 1, `${provider}: expected one card, got ${s.n}`);
    ok(/Proposal for line 173/.test(s.text ?? ""), `${provider}: result header missing`);
    ok(/loss_sum \+= loss\.detach\(\)/.test(s.text ?? ""), `${provider}: proposal code missing`);
    const calls = await page.evaluate(() => window.__calls.map((c) => c.url));
    const expectHost = { amazon: "bedrock-runtime.us-east-1.amazonaws.com", anthropic: "api.anthropic.com", "azure-openai": "example.openai.azure.com", gemini: "generativelanguage.googleapis.com", openai: "api.openai.com", local: "localhost:11434" }[provider];
    ok(calls.some((u) => u.includes(expectHost)), `${provider}: request did not go to ${expectHost} (${calls.join(", ")})`);
    await page.click('.ai-card .seg-item[data-value="diff"]');
    await page.waitForTimeout(80);
    const diff = await page.evaluate(() => ({
      add: document.querySelectorAll(".ai-card .ai-drow.is-add").length,
      del: document.querySelectorAll(".ai-card .ai-drow.is-del").length,
      first: document.querySelector(".ai-card .ai-drow.is-del .ai-dno")?.textContent,
    }));
    ok(diff.add === 5 && diff.del === 1 && diff.first === "173", `${provider}: diff rows ${JSON.stringify(diff)}`);
    if (provider === "anthropic") {
      await shot(page, "ai-result-diff-light");
      await page.click('.ai-card .seg-item[data-value="proposal"]');
      await page.click(".ai-card .ai-prompt-btn");
      const prompt = await page.evaluate(() => {
        const p = document.querySelector(".ai-card .ai-prompt");
        return p && !p.hidden ? p.textContent : "";
      });
      ok(prompt.includes("loss_value = loss.item()"), "anthropic: Show prompt does not show the prompt");
    }
    for (const e of errors) failures.push(`${provider}: ${e}`);
    await context.close();
  }

  // ── 2. Every AiError kind renders its copy and actions ─────────────────────────
  const anth = (status, body, extra = {}) => ({ match: "api.anthropic.com", status, body: JSON.stringify(body), ...extra });
  const KINDS = [
    { kind: "invalid-key", provider: "anthropic", route: anth(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }), copy: /Invalid Anthropic API key/, actions: ["Retry", "Open AI settings", "Dismiss"] },
    { kind: "quota", provider: "openai", route: { match: "chat/completions", status: 429, body: JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }) }, copy: /The provider reports that the quota is exhausted\./, actions: ["Retry", "Dismiss"] },
    { kind: "rate-limit", provider: "anthropic", route: anth(429, { error: { type: "rate_limit_error", message: "slow down" } }), copy: /Rate limited, try again in a moment\./, actions: ["Retry in 5\u00a0s", "Dismiss"] },
    { kind: "model-not-found", provider: "anthropic", route: anth(404, { error: { type: "not_found_error", message: "model: nope" } }), copy: /Model not found: claude-sonnet-4-5-20250929\./, actions: ["Retry", "Choose another model", "Dismiss"] },
    { kind: "bad-request", provider: "anthropic", route: anth(400, { error: { type: "invalid_request_error", message: "max_tokens too large" } }), copy: /Anthropic API error: max_tokens too large/, actions: ["Retry", "Dismiss"] },
    { kind: "server", provider: "anthropic", route: anth(529, { error: { type: "overloaded_error", message: "Overloaded" } }), copy: /Anthropic is overloaded/, actions: ["Retry", "Dismiss"] },
    { kind: "network", provider: "anthropic", route: { match: "api.anthropic.com", reject: true }, copy: /Couldn't reach Anthropic \(network or CORS\)\./, actions: ["Retry", "Dismiss"] },
    { kind: "network (local)", provider: "local", route: { match: "11434", reject: true }, copy: /Couldn't reach the Ollama server \(network or CORS\)\.[\s\S]*ollama serve[\s\S]*OLLAMA_ORIGINS/, actions: ["Retry", "Dismiss"] },
    { kind: "empty-response", provider: "anthropic", route: anth(200, { content: [{ type: "text", text: "   " }] }), copy: /The provider returned no code\./, actions: ["Retry", "Dismiss"] },
    { kind: "unknown", provider: "local", route: { match: "11434", status: 200, body: "this is not json" }, copy: /Ollama reply could not be read/, actions: ["Retry", "Dismiss"] },
  ];
  for (const k of KINDS) {
    const { context, page, errors } = await open("ml-training", { storage: { "service-select": k.provider, ...CREDS[k.provider] }, routes: [{ match: "/v1/completions$", status: 400, body: "{}" }, k.route] });
    await request(page);
    const got = await waitStatus(page, "error", 5000);
    const s = await cardState(page);
    ok(got, `${k.kind}: no error card (status ${s.status})`);
    ok(k.copy.test(s.text ?? ""), `${k.kind}: copy mismatch: ${JSON.stringify(s.text)}`);
    const visible = (s.buttons ?? []).filter((b) => b !== "Dismiss this proposal" && b !== "Details");
    ok(JSON.stringify(visible) === JSON.stringify(k.actions), `${k.kind}: actions ${JSON.stringify(visible)} ≠ ${JSON.stringify(k.actions)}`);
    ok((s.buttons ?? []).includes("Details"), `${k.kind}: no Details disclosure`);
    if (k.kind === "rate-limit") {
      await shot(page, "ai-error-rate-limit-light");
      const disabled = await page.evaluate(() => document.querySelector(".ai-card .ai-retry")?.getAttribute("aria-disabled"));
      ok(disabled === "true", "rate-limit: Retry should be disabled for 5 s");
    }
    if (k.kind === "invalid-key") {
      await page.click(".ai-card >> text=Open AI settings");
      await page.waitForTimeout(100);
      const focus = await page.evaluate(() => document.activeElement?.id);
      ok(focus === "anthropic-api-key", `invalid-key: Open AI settings focused "${focus}", expected anthropic-api-key`);
    }
    if (k.kind === "model-not-found") {
      await page.click(".ai-card >> text=Choose another model");
      await page.waitForTimeout(100);
      const focus = await page.evaluate(() => document.activeElement?.id);
      ok(focus === "language-model-anthropic", `model-not-found: focused "${focus}"`);
    }
    for (const e of errors) failures.push(`${k.kind}: ${e}`);
    await context.close();
  }

  // Missing credentials → setup card (no network), "Set up AI provider" focuses the first missing field.
  {
    const { context, page, errors } = await open("ml-training", { storage: { "service-select": "amazon" }, routes: [] });
    await request(page);
    await waitStatus(page, "setup");
    const s = await cardState(page);
    ok(s.status === "setup" && /Set up an AI provider to optimize line 173/.test(s.text) && /AWS access key ID and secret key/.test(s.text), `setup card: ${JSON.stringify(s.text)}`);
    ok(/Scalene sends the selected code, up to 9 lines before it and its profile numbers, never the file name\./.test(s.text), "setup card: privacy line missing (same sentence as the drawer)");
    ok((await page.evaluate(() => window.__calls.length)) === 0, "setup card: a network request was made");
    await shot(page, "ai-setup-light");
    await page.click(".ai-card >> text=Set up AI provider");
    await page.waitForTimeout(100);
    ok((await page.evaluate(() => document.activeElement?.id)) === "aws-access-key", "setup: drawer did not focus aws-access-key");
    for (const e of errors) failures.push(`setup: ${e}`);
    await context.close();
  }

  // First-time user (no stored provider, no environment keys): choose a provider, never "enter AWS keys".
  {
    const { context, page, errors } = await open("ml-training", { routes: [] });
    await request(page);
    await waitStatus(page, "setup");
    const s = await cardState(page);
    ok(/Choose an AI provider — Anthropic, OpenAI, Google Gemini, Azure OpenAI, Amazon Bedrock or a local Ollama model — and add its key\./.test(s.text) && !/AWS/.test(s.text), `first-time setup card: ${JSON.stringify(s.text)}`);
    await page.click(".ai-card >> text=Set up AI provider");
    await page.waitForTimeout(100);
    const focus = await page.evaluate(() => ({ id: document.activeElement?.id ?? "", role: document.activeElement?.getAttribute("role") ?? document.activeElement?.type ?? "" }));
    ok(focus.id !== "aws-access-key" && /radio/.test(focus.role), `first-time setup: drawer should focus the provider choice (got ${JSON.stringify(focus)})`);
    for (const e of errors) failures.push(`first-time setup: ${e}`);
    await context.close();
  }

  // Cancel aborts; Regenerate replaces the card.
  {
    const { context, page, errors } = await open("ml-training", {
      storage: { "service-select": "anthropic", ...CREDS.anthropic },
      routes: [{ match: "api.anthropic.com", seq: [{ hang: true }, success("anthropic", REPLY), success("anthropic", REPLY2)] }],
    });
    await request(page);
    ok(await waitStatus(page, "working"), "cancel: no working card");
    const w = await cardState(page);
    ok(/Optimizing line 173/.test(w.text) && /Anthropic · claude-sonnet-4-5/.test(w.text), `working header: ${JSON.stringify(w.text)}`);
    await shot(page, "ai-working-light");
    await page.click(".ai-card .ai-cancel");
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({ cards: document.querySelectorAll(".ai-card").length, aborted: window.__aborted, toast: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent) }));
    ok(after.cards === 0, "cancel: card not removed");
    ok(after.aborted >= 1, "cancel: fetch signal not aborted");
    ok(after.toast.some((t) => t.includes("Request cancelled")), `cancel: toast missing (${after.toast})`);
    await request(page);
    ok(await waitStatus(page, "result"), "regenerate: first result missing");
    await page.click(".ai-card .ai-regen");
    await page.waitForFunction(() => document.querySelector(".ai-card")?.innerText.includes("regenerated"), null, { timeout: 4000 }).catch(() => {});
    const r = await cardState(page);
    ok(r.n === 1 && r.status === "result" && r.text.includes("regenerated") && !r.text.includes("loss_sum"), `regenerate: ${JSON.stringify(r)}`);
    ok((await page.evaluate(() => window.__calls.filter((c) => c.url.includes("anthropic")).length)) === 3, "regenerate: expected 3 provider calls");
    // Copy: icon swaps to "Copied".
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.click(".ai-card .ai-copy");
    await page.waitForTimeout(120);
    const copied = await page.evaluate(() => document.querySelector(".ai-card .ai-copy")?.innerText.trim());
    ok(copied === "Copied" || (await page.evaluate(() => Array.from(document.querySelectorAll(".toast")).some((t) => t.textContent.includes("copy")))), `copy: label "${copied}"`);
    for (const e of errors) failures.push(`cancel/regenerate: ${e}`);
    await context.close();
  }

  // Region proposal: anchor stays on the clicked line, header names the region.
  {
    const { context, page, errors } = await open("ml-training", { storage: { "service-select": "anthropic", ...CREDS.anthropic }, routes: [{ match: "anthropic", ...success("anthropic", REPLY) }] });
    await request(page, 173, "region");
    ok(await waitStatus(page, "result"), "region: no result");
    const s = await cardState(page);
    ok(/Proposal for lines 152–184/.test(s.text), `region header: ${JSON.stringify(s.text?.slice(0, 80))}`);
    await shot(page, "ai-region-light");
    for (const e of errors) failures.push(`region: ${e}`);
    await context.close();
  }

  // Dark theme result screenshot.
  {
    const { context, page } = await open("ml-training", { theme: "dark", storage: { "service-select": "anthropic", ...CREDS.anthropic }, routes: [{ match: "anthropic", ...success("anthropic", REPLY) }] });
    await request(page);
    await waitStatus(page, "result");
    await page.evaluate(() => document.querySelector(".ai-card")?.scrollIntoView({ block: "center" }));
    await shot(page, "ai-result-dark");
    await context.close();
  }
}

// ── 3. Drawer: a real modal that saves to the upstream storage keys ─────────────
if (want("drawer")) {
  const { context, page, errors } = await open("ml-training", { routes: [] });
  await page.click(".appbar-ai");
  await page.waitForTimeout(350);
  const m = await page.evaluate(() => {
    const d = document.querySelector(".ai-drawer");
    return {
      role: d?.getAttribute("role"),
      modal: d?.getAttribute("aria-modal"),
      label: document.getElementById(d?.getAttribute("aria-labelledby") ?? "")?.textContent,
      mainInert: document.getElementById("main")?.inert,
      appInert: document.getElementById("scalene-app")?.inert,
      footInert: document.getElementById("scalene-footer")?.inert,
      ids: ["service-select", "api-key", "anthropic-api-key", "gemini-api-key", "azure-api-key", "azure-api-url", "azure-api-version", "aws-access-key", "aws-secret-key", "aws-session-token", "aws-region", "language-model-amazon", "local-ip", "local-port", "language-model-local", "local-models-list", "language-model-openai", "openai-custom-model", "openai-custom-url", "language-model-anthropic", "anthropic-custom-model", "anthropic-custom-url", "language-model-gemini", "gemini-custom-model", "gemini-custom-url", "language-model-azure", "azure-custom-model", "optimize-performance", "optimize-memory", "use-gpu-checkbox", "accelerator-name", "valid-api-key", "install-models-message"].filter((id) => document.querySelectorAll(`#${id}`).length !== 1),
      value: document.getElementById("service-select")?.value,
    };
  });
  ok(m.role === "dialog" && m.modal === "true" && m.label === "AI optimization", `drawer semantics ${JSON.stringify(m)}`);
  ok(m.appInert && m.footInert, `drawer: background not inert ${JSON.stringify(m)}`);
  ok(m.ids.length === 0, `drawer: upstream ids missing or duplicated: ${m.ids.join(", ")}`);
  ok(m.value === "amazon", `drawer: #service-select.value = ${m.value}`);
  await shot(page, "drawer-light-1440");
  // 40 Tabs stay inside.
  let escaped = 0;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    if (!(await page.evaluate(() => document.querySelector(".ai-drawer")?.contains(document.activeElement)))) escaped++;
  }
  ok(escaped === 0, `drawer: focus left the drawer ${escaped} times in 40 Tabs`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({ hidden: document.querySelector(".ai-layer")?.hidden, focus: document.activeElement?.classList.contains("appbar-ai"), inert: document.getElementById("scalene-app")?.inert }));
  ok(closed.hidden && closed.focus && !closed.inert, `drawer: Esc close/focus return ${JSON.stringify(closed)}`);

  // Saves: provider, keys, model, target, GPU, advanced fields → upstream keys.
  await page.click(".appbar-ai");
  await page.waitForTimeout(300);
  await page.click(".ai-tile:has-text('Anthropic')");
  await page.fill("#anthropic-api-key", "sk-ant-typed");
  await page.selectOption("#language-model-anthropic", "claude-opus-4-5-20251124");
  await page.click("#optimize-memory");
  await page.click("#use-gpu-checkbox");
  await page.click(".ai-tile:has-text('Azure OpenAI')");
  await page.click(".ai-panel[data-provider='azure-openai'] .ai-adv .disclosure-btn");
  await page.fill("#azure-api-version", "2025-01-01");
  await page.fill("#azure-api-url", "not a url");
  await page.keyboard.press("Tab");
  const invalid = await page.evaluate(() => document.getElementById("azure-api-url")?.getAttribute("aria-invalid") !== null && document.getElementById("azure-api-url-msg")?.textContent);
  ok(Boolean(invalid), "drawer: invalid URL not flagged");
  await page.click(".ai-tile:has-text('OpenAI') >> nth=-1");
  await page.fill("#api-key", "sk-openai-typed");
  await page.click(".ai-tile:has-text('Local')");
  await page.waitForTimeout(150);
  // Picking Local never probes localhost by itself (round 1: console error without a server).
  const tagsBefore = await page.evaluate(() => window.__calls.filter((c) => c.url.includes("/api/tags")).length);
  ok(tagsBefore === 0, "drawer: picking Local probed Ollama without a Check");
  await page.click(".ai-panel[data-provider='local'] .ai-check");
  await page.waitForTimeout(300);
  const ollamaMsg = await page.evaluate(() => Array.from(document.querySelectorAll(".ai-panel[data-provider='local'] .ai-msg")).map((m) => m.textContent).join(" ").trim());
  ok(/No Ollama server at localhost:11434\. Start it with ollama serve, then pull a model|models? found|has no models/.test(ollamaMsg), `drawer: Ollama Check message ${JSON.stringify(ollamaMsg)}`);
  await page.fill("#local-port", "11500");
  await page.click(".ai-tile:has-text('Amazon Bedrock')");
  await page.click(".ai-panel[data-provider='amazon'] .ai-adv .disclosure-btn");
  await page.fill("#aws-session-token", "tok");
  await page.click("#aws-secret-key ~ .ai-reveal, .ai-panel[data-provider='amazon'] .ai-reveal");
  const revealed = await page.evaluate(() => ({ type: document.getElementById("aws-secret-key")?.type, pressed: document.querySelector(".ai-panel[data-provider='amazon'] .ai-reveal")?.getAttribute("aria-pressed") }));
  ok(revealed.type === "text" && revealed.pressed === "true", `drawer: Show/Hide ${JSON.stringify(revealed)}`);
  await page.waitForTimeout(450);
  const ls = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
  const expectLs = {
    "service-select": "amazon",
    "scalene-service-select": "amazon",
    "anthropic-api-key": "sk-ant-typed",
    "language-model-anthropic": "claude-opus-4-5-20251124",
    "optimize-memory": "true",
    "optimize-performance": "false",
    "use-gpu-checkbox": "false",
    "azure-api-version": "2025-01-01",
    "scalene-api-key": "sk-openai-typed",
    "local-port": "11500",
    "aws-session-token": "tok",
  };
  for (const [k, v] of Object.entries(expectLs)) ok(ls[k] === v, `drawer storage: ${k} = ${JSON.stringify(ls[k])}, expected ${JSON.stringify(v)}`);
  // ml-training has gpu: true → the switch starts on; one click turns it off ("false").
  const calls = await page.evaluate(() => window.__calls.map((c) => c.url));
  ok(calls.every((u) => u.includes("11434") || u.includes("11500") || u.includes("api.openai.com")), `drawer: unexpected requests ${calls.join(", ")}`);
  ok(calls.some((u) => u.includes("/api/tags")), "drawer: Check did not probe Ollama");
  await shot(page, "drawer-amazon-light-1440");
  for (const e of errors.filter((e) => !e.includes("unmocked"))) failures.push(`drawer: ${e}`);
  await context.close();

  // Drawer on a phone (full-screen sheet), dark, and in the 1000×400 iframe; no overflow.
  for (const [vp, theme, tag] of [[{ width: 390, height: 844 }, "dark", "drawer-dark-390"], [{ width: 1000, height: 400 }, "light", "drawer-light-1000x400"], [{ width: 1440, height: 900 }, "dark", "drawer-dark-1440"]]) {
    const o = await open("ml-training", { viewport: vp, theme });
    await o.page.evaluate(() => window.toggleServiceFields && document.querySelector(".appbar-ai, .appbar-more") && null);
    await o.page.evaluate(() => document.querySelector(".appbar-ai").click());
    await o.page.waitForTimeout(350);
    const ov = await o.page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth);
    ok(ov, `${tag}: horizontal overflow with the drawer open`);
    await shot(o.page, tag);
    await o.context.close();
  }

  // Legacy globals drive the drawer.
  {
    const o = await open("ml-training", { storage: {}, routes: [{ match: "/v1/models", status: 200, body: JSON.stringify({ data: [{ id: "gpt-zz-1" }, { id: "gpt-zz-2" }] }) }, { match: "/v1/completions$", status: 401, body: JSON.stringify({ error: { code: "invalid_api_key" } }) }] });
    await o.page.evaluate(() => document.querySelector(".appbar-ai").click());
    await o.page.waitForTimeout(250);
    await o.page.evaluate(() => {
      document.getElementById("service-select").value = "openai";
      window.toggleServiceFields();
      window.checkApiKey("sk-bad");
    });
    await o.page.waitForTimeout(300);
    const st = await o.page.evaluate(() => ({ provider: localStorage.getItem("service-select"), key: localStorage.getItem("scalene-api-key"), status: document.getElementById("valid-api-key")?.textContent }));
    ok(st.provider === "openai" && st.key === "sk-bad" && /Key rejected/.test(st.status ?? ""), `legacy: ${JSON.stringify(st)}`);
    await o.page.evaluate(() => window.refreshOpenAIModels());
    await o.page.waitForTimeout(300);
    const opts = await o.page.evaluate(() => Array.from(document.querySelectorAll("#language-model-openai option")).map((x) => x.value));
    ok(opts.includes("gpt-zz-1") && opts.includes("gpt-5.2"), `legacy refresh: options ${opts.join(",")}`);
    await o.page.evaluate(() => {
      const btn = document.querySelector(".ai-panel[data-provider='openai'] .ai-reveal");
      window.togglePassword(btn);
      window.toggleAdvanced(document.getElementById("openai-custom-url"));
    });
    const t = await o.page.evaluate(() => ({ type: document.getElementById("api-key").type, adv: document.querySelector(".ai-panel[data-provider='openai'] .ai-adv")?.hasAttribute("data-open") }));
    ok(t.type === "text" && t.adv, `legacy toggles: ${JSON.stringify(t)}`);
    await o.context.close();
  }
}

// ── 4. Network: nothing on file:// load; only env keys + heartbeat on http:// ───
if (want("network")) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const seen = [];
  page.on("request", (r) => seen.push(r.url()));
  await page.goto(pageUrl("ml-training", ""));
  await page.waitForTimeout(1500);
  const extra = seen.filter((u) => !u.startsWith("file:") && !u.startsWith("data:"));
  ok(extra.length === 0, `file:// load made requests: ${extra.join(", ")}`);
  await context.close();

  // http:// — a tiny server for out/ that also answers /env-api-keys.json and /heartbeat.
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/env-api-keys.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ anthropic: "sk-ant-from-env", awsRegion: "eu-west-1" }));
      return;
    }
    if (req.url === "/heartbeat") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const file = path.join(outDir, decodeURIComponent(req.url.split("?")[0]));
    if (file.startsWith(outDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "application/javascript" });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  const seen2 = [];
  p2.on("request", (r) => seen2.push(new URL(r.url()).pathname));
  await p2.goto(`http://127.0.0.1:${port}/ml-training.html`);
  await p2.waitForTimeout(10600);
  const allowed = new Set(["/ml-training.html", "/env-api-keys.json", "/heartbeat"]);
  const bad = seen2.filter((u) => !allowed.has(u));
  ok(bad.length === 0, `http:// load made unexpected requests: ${bad.join(", ")}`);
  ok(seen2.includes("/env-api-keys.json"), "http:// load did not fetch /env-api-keys.json");
  ok(seen2.includes("/heartbeat"), "http:// load did not send a heartbeat within 10.6 s");
  // Env prefill: default provider follows the env (anthropic), badge shown, nothing stored.
  await p2.evaluate(() => document.querySelector(".appbar-ai").click());
  await p2.waitForTimeout(300);
  const env = await p2.evaluate(() => ({
    provider: document.getElementById("service-select").value,
    key: document.getElementById("anthropic-api-key").value,
    badge: !document.getElementById("anthropic-api-key-env").hidden,
    stored: localStorage.getItem("anthropic-api-key"),
    region: localStorage.getItem("aws-region"),
    dot: document.querySelector(".appbar-ai-dot")?.classList.contains("is-ready"),
  }));
  ok(env.provider === "anthropic" && env.key === "sk-ant-from-env" && env.badge, `env prefill: ${JSON.stringify(env)}`);
  await p2.click("#optimize-memory");
  await p2.waitForTimeout(400);
  const stored = await p2.evaluate(() => ({ key: localStorage.getItem("anthropic-api-key"), region: localStorage.getItem("aws-region"), target: localStorage.getItem("optimize-memory") }));
  ok(stored.key === null && stored.region === null && stored.target === "true", `env values written to storage: ${JSON.stringify(stored)}`);
  ok(env.dot === true, "env prefill: app-bar AI dot not ready");
  await shot(p2, "drawer-env-light");
  await ctx2.close();
  server.close();

  // Jupyter-like host (round 1): only "/" is served, everything else gets an empty reply.
  // One heartbeat probe, then silence: no /env-api-keys.json request, no error every 10 s.
  const jhits = [];
  const jserver = http.createServer((req, res) => {
    jhits.push(req.url);
    if (req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(outDir, "ml-training.html")));
      return;
    }
    req.socket.destroy(); // like upstream's send_response(404) without end_headers: ERR_EMPTY_RESPONSE
  });
  await new Promise((r) => jserver.listen(0, "127.0.0.1", r));
  const ctx3 = await browser.newContext({ viewport: { width: 1000, height: 400 } });
  const p3 = await ctx3.newPage();
  const consoleErrors = [];
  const preq = []; // page-level requests (the network stack may retry an empty reply once)
  p3.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  p3.on("request", (r) => preq.push(new URL(r.url()).pathname));
  await p3.goto(`http://127.0.0.1:${jserver.address().port}/?still`);
  await p3.waitForTimeout(10800);
  const beats = preq.filter((u) => u === "/heartbeat").length;
  ok(beats === 1, `jupyter host: heartbeat should stop after the first failure (saw ${beats} in 10.8 s)`);
  ok(!preq.includes("/env-api-keys.json"), `jupyter host: env keys requested although /heartbeat failed (${preq.join(", ")})`);
  ok(consoleErrors.length <= 1, `jupyter host: ${consoleErrors.length} console errors (${consoleErrors.join(" | ")})`);
  await ctx3.close();
  jserver.close();
}

// ── 5. Loader: invalid JSON drop keeps the report; {} → empty state; file input ──
if (want("loader")) {
  const { context, page, errors } = await open("ml-training");
  const dropText = async (name, text) =>
    page.evaluate(
      ({ name, text }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], name, { type: "application/json" }));
        window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
        const shown = !document.querySelector(".drop-overlay").hidden;
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        return shown;
      },
      { name, text },
    );
  const overlayShown = await dropText("bad.json", '{"files": {');
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({
    toasts: Array.from(document.querySelectorAll(".toast-error")).map((t) => t.textContent),
    role: document.querySelector(".toast-error")?.getAttribute("role"),
    overview: Boolean(document.querySelector("#overview")),
    overlayHidden: document.querySelector(".drop-overlay").hidden,
    title: document.title,
  }));
  ok(overlayShown, "drop: overlay not shown on dragenter");
  ok(st.overlayHidden, "drop: overlay still visible after drop");
  ok(st.toasts.some((t) => t.startsWith("Couldn't load bad.json:")) && st.role === "alert", `drop: error toast ${JSON.stringify(st)}`);
  ok(st.overview && st.title.startsWith("Scalene - "), "drop: the report did not stay");
  await shot(page, "loader-error-toast-light");
  await dropText("other.json", '{"version": 1}');
  await page.waitForTimeout(200);
  const notProfile = await page.evaluate(() => Array.from(document.querySelectorAll(".toast-error")).map((t) => t.textContent));
  ok(notProfile.some((t) => t.includes('no "files" section')), `drop: non-profile JSON message ${notProfile}`);
  // Valid profile through the file input.
  await page.setInputFiles("#fileinput", path.join(root, "fixtures", "cpu-only.json"));
  await page.waitForTimeout(600);
  const loaded = await page.evaluate(() => ({ toasts: Array.from(document.querySelectorAll(".toast-success")).map((t) => t.textContent), title: document.title }));
  ok(loaded.toasts.some((t) => /^Loaded cpu-only\.json · \d+ files?/.test(t)), `file input: ${JSON.stringify(loaded)}`);
  // {} → empty state.
  await dropText("empty.json", "{}");
  await page.waitForTimeout(300);
  const empty = await page.evaluate(() => ({ empty: Boolean(document.querySelector(".empty-card")), title: document.title, footer: document.getElementById("scalene-footer")?.innerText }));
  ok(empty.empty && empty.title === "Scalene", `{}: empty state ${JSON.stringify(empty)}`);
  ok(!/Report an issue/.test(empty.footer ?? ""), "{}: footer should show only the version");
  for (const e of errors) failures.push(`loader: ${e}`);
  await context.close();

  // Hosted demo: the global example_profile adds "Load the demo profile" to the empty state.
  {
    const demo = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "cpu-only.json"), "utf8"));
    const context2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await context2.newPage();
    await p2.addInitScript((d) => {
      window.example_profile = d;
    }, demo);
    await p2.goto(pageUrl("empty"));
    await p2.waitForTimeout(200);
    const btn = await p2.$("text=Load the demo profile");
    ok(Boolean(btn), "demo: button missing on the empty state");
    if (btn) {
      await btn.click();
      await p2.waitForTimeout(300);
      ok(await p2.evaluate(() => Boolean(document.querySelector("#overview")) && document.title.startsWith("Scalene - ")), "demo: profile did not load");
    }
    await context2.close();
  }

  // Large files show a progress toast until the report renders (§4.15).
  if (fs.existsSync(path.join(root, "fixtures", "huge.json"))) {
    const o = await open("cpu-only");
    await o.page.evaluate(() => {
      window.__toastTexts = [];
      new MutationObserver(() => {
        for (const t of document.querySelectorAll(".toast")) if (!window.__toastTexts.includes(t.textContent)) window.__toastTexts.push(t.textContent);
      }).observe(document.body, { childList: true, subtree: true });
    });
    await o.page.setInputFiles("#fileinput", path.join(root, "fixtures", "huge.json"));
    await o.page.waitForFunction(() => document.title !== "Scalene - " && window.__toastTexts.some((t) => t.startsWith("Loaded huge.json")), null, { timeout: 30000 }).catch(() => {});
    const texts = await o.page.evaluate(() => window.__toastTexts);
    ok(texts.some((t) => /^Reading huge\.json · \d+(\.\d)?\sMiB…/.test(t)), `large file: progress toast missing (${texts})`);
    ok(texts.some((t) => /^Loaded huge\.json · \d+ files/.test(t)), `large file: success toast missing (${texts})`);
    // Palette on the stress profile: the index builds in slices, typing stays fast.
    await o.page.keyboard.press("Control+k");
    await o.page.waitForFunction(() => /lines indexed/.test(document.querySelector(".pal-status")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
    const t = await o.page.evaluate(async () => {
      const input = document.querySelector(".pal-input");
      const t0 = performance.now();
      for (const q of ["d", "de", "def", "def ", "def p"]) {
        input.value = q;
        input.dispatchEvent(new Event("input"));
      }
      return { ms: performance.now() - t0, rows: document.querySelectorAll(".pal-opt").length };
    });
    ok(t.ms < 250 && t.rows > 0, `huge palette: 5 keystrokes took ${t.ms.toFixed(0)} ms (${t.rows} rows)`);
    for (const e of o.errors) failures.push(`large file: ${e}`);
    await o.context.close();
  }

  // Empty fixture: card content and buttons.
  // empty.json is `{}` (Scalene ran, no samples); "blank" is a missing/empty profile (§4.16).
  for (const [fixture, theme, vp, tag] of [["empty", "light", { width: 1440, height: 900 }, "empty-light-1440"], ["empty", "dark", { width: 1440, height: 900 }, "empty-dark-1440"], ["empty", "light", { width: 390, height: 844 }, "empty-light-390"], ["empty", "dark", { width: 1000, height: 400 }, "empty-dark-1000x400"], ["blank", "light", { width: 1000, height: 400 }, "blank-light-1000x400"]]) {
    const o = await open(fixture, { theme, viewport: vp });
    const e = await o.page.evaluate(() => {
      const choose = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes("Choose a profile"));
      return { h1: document.querySelector("h1")?.textContent, choose: Boolean(choose), chooseBottom: choose ? Math.round(choose.getBoundingClientRect().bottom) : null, steps: document.querySelectorAll(".empty-step").length, ov: document.documentElement.scrollWidth === document.documentElement.clientWidth };
    });
    const title = fixture === "empty" ? "Scalene collected no samples" : "No profile loaded";
    // Jupyter (1000×400): the primary action is on the first screen (round 1).
    const fold = vp.height <= 520 ? e.chooseBottom !== null && e.chooseBottom <= 380 : true;
    ok(e.h1 === title && e.choose && e.steps === 2 && e.ov && fold, `${tag}: ${JSON.stringify(e)}`);
    await shot(o.page, tag);
    for (const err of o.errors) failures.push(`${tag}: ${err}`);
    await o.context.close();
  }
}

// ── 6. Palette and shortcuts ─────────────────────────────────────────────────────
if (want("palette")) {
  const { context, page, errors } = await open("ml-training");
  const search = async (q) => {
    await page.fill(".pal-input", q);
    await page.waitForTimeout(250);
    return page.evaluate(() =>
      Array.from(document.querySelectorAll(".pal-group")).map((g) => ({
        group: g.querySelector(".pal-group-label")?.firstChild?.textContent,
        options: Array.from(g.querySelectorAll(".pal-opt")).map((o) => o.querySelector(".pal-main")?.textContent),
      })),
    );
  };
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => ({ dialog: document.querySelector(".pal")?.getAttribute("aria-modal"), focus: document.activeElement?.classList.contains("pal-input"), inert: document.getElementById("scalene-app")?.inert }));
  ok(opened.dialog === "true" && opened.focus && opened.inert, `palette open: ${JSON.stringify(opened)}`);
  const empty = await search("");
  ok(empty[0]?.group === "Top hotspots" && empty[0].options.length === 5, `palette empty query: ${JSON.stringify(empty.map((g) => g.group))}`);
  await shot(page, "palette-empty-light");
  const r1 = await search("loss.item");
  ok(r1[0]?.group === "Lines" && r1[0].options.some((t) => t.includes("loss.item()")), `palette "loss.item": ${JSON.stringify(r1)}`);
  await shot(page, "palette-loss-item-light");
  const r2 = await search("train");
  const fn = r2.find((g) => g.group === "Functions");
  const fi = r2.find((g) => g.group === "Files");
  ok(fn?.options[0] === "train" && fi?.options[0] === "train.py", `palette "train": ${JSON.stringify(r2)}`);
  await shot(page, "palette-train-light");
  const r3 = await search("Timeline");
  ok(r3[0]?.group === "Sections" && r3[0].options[0] === "Timeline", `palette "Timeline": ${JSON.stringify(r3)}`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const tl = await page.evaluate(() => ({ closed: document.querySelector(".pal-layer")?.hidden, focus: document.activeElement?.id, top: document.getElementById("timeline")?.getBoundingClientRect().top }));
  ok(tl.closed && tl.focus === "timeline-h" && Math.abs(tl.top) < 140, `palette Timeline → section: ${JSON.stringify(tl)}`);
  // loss.item → Enter jumps to the code row.
  await page.keyboard.press("/");
  await page.waitForTimeout(200);
  await search("loss.item");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  const row = await page.evaluate(() => ({ text: document.activeElement?.textContent ?? "", sel: document.activeElement?.getAttribute("aria-selected") }));
  ok(row.text.includes("loss.item()"), `palette jump: focus on ${JSON.stringify(row.text.slice(0, 80))}`);
  // Shortcuts dialog.
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await page.waitForTimeout(200);
  const sc = await page.evaluate(() => ({ open: Boolean(document.querySelector(".sc[role=dialog][aria-modal=true]")), groups: Array.from(document.querySelectorAll(".sc-group-title")).map((g) => g.textContent) }));
  ok(sc.open && sc.groups.includes("Flame graph") && sc.groups.includes("Timeline"), `shortcuts: ${JSON.stringify(sc)}`);
  await shot(page, "shortcuts-light-1440");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  ok(!(await page.evaluate(() => Boolean(document.querySelector(".sc")))), "shortcuts: Esc did not close");
  for (const e of errors) failures.push(`palette: ${e}`);
  await context.close();

  for (const [theme, vp, tag] of [["dark", { width: 1440, height: 900 }, "palette-train-dark-1440"], ["light", { width: 390, height: 844 }, "palette-train-light-390"], ["dark", { width: 1000, height: 400 }, "palette-train-dark-1000x400"]]) {
    const o = await open("ml-training", { theme, viewport: vp });
    await o.page.evaluate(() => document.querySelector(".appbar-search").click());
    await o.page.fill(".pal-input", "train");
    await o.page.waitForTimeout(300);
    ok(await o.page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), `${tag}: overflow`);
    await shot(o.page, tag);
    await o.context.close();
  }
  for (const [theme, vp, tag] of [["dark", { width: 1440, height: 900 }, "shortcuts-dark-1440"], ["light", { width: 390, height: 844 }, "shortcuts-light-390"]]) {
    const o = await open("ml-training", { theme, viewport: vp });
    await o.page.keyboard.press("?");
    await o.page.waitForTimeout(200);
    await shot(o.page, tag);
    await o.context.close();
  }
}

// ── 7. Footer ───────────────────────────────────────────────────────────────────
if (want("footer")) {
  const { context, page, errors } = await open("ml-training");
  const f = await page.evaluate(() => {
    const el = document.getElementById("scalene-footer");
    el.scrollIntoView();
    return { text: el.innerText, sw: el.querySelector("[role=switch]")?.getAttribute("aria-checked") };
  });
  ok(/Scalene 2\.4\.0, 2026\.10\.23/.test(f.text) && /Report an issue or request a feature/.test(f.text) && /Share your success story/.test(f.text) && /Load another profile/.test(f.text) && /binary units/.test(f.text) && /Keyboard shortcuts/.test(f.text), `footer: ${JSON.stringify(f.text)}`);
  await page.click(".footer-motion");
  const reduced = await page.evaluate(() => ({ cls: document.documentElement.classList.contains("motion-reduce"), ls: localStorage.getItem("scalene-reduced-motion"), sw: document.querySelector(".footer-motion").getAttribute("aria-checked") }));
  ok(reduced.cls && reduced.ls === "1" && reduced.sw === "true", `footer reduce motion: ${JSON.stringify(reduced)}`);
  await page.waitForTimeout(100);
  await shot(page, "footer-light-1440");
  for (const e of errors) failures.push(`footer: ${e}`);
  await context.close();
}

// ── 8. Reduced motion: drawer, palette and cards use opacity-only fades ≤ 120 ms ──
// ── 7b. Popups in #layer-root: Tab leaves relative to the trigger; no dangling aria-controls ──
if (want("popups")) {
  const active = (page) => page.evaluate(() => {
    const a = document.activeElement;
    return { cls: a?.className ?? "", text: (a?.textContent ?? "").trim().slice(0, 40), skip: Boolean(a?.closest(".skip-link")) || /skip/i.test(a?.textContent ?? ""), inLayer: Boolean(a?.closest("#layer-root")) };
  });
  const dangling = (page) => page.evaluate(() => Array.from(document.querySelectorAll("[aria-controls]")).flatMap((el) => el.getAttribute("aria-controls").split(/\s+/).filter((id) => id && !document.getElementById(id)).map((id) => `${el.className}→${id}`)));
  {
    const { context, page, errors } = await open("ml-training", { viewport: { width: 1440, height: 900 } });
    ok((await dangling(page)).length === 0, `aria-controls points at missing ids: ${(await dangling(page)).join(", ")}`);
    await page.focus("header.appbar .appbar-program");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    const inPop = await page.evaluate(() => Boolean(document.activeElement?.closest(".appbar-program-popover")) && Boolean(document.getElementById(document.querySelector(".appbar-program").getAttribute("aria-controls") ?? "")));
    ok(inPop, "program popover: focus did not move in, or aria-controls missing while open");
    await page.keyboard.press("Tab");
    const a1 = await active(page);
    ok(!a1.skip && !a1.inLayer && !(await page.evaluate(() => Boolean(document.querySelector(".appbar-program-popover")))), `program popover: Tab went to ${JSON.stringify(a1)}`);
    await page.keyboard.press("Shift+Tab");
    await page.focus("header.appbar .appbar-program");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    await page.keyboard.press("Shift+Tab");
    const a2 = await active(page);
    ok(/appbar-program/.test(a2.cls), `program popover: Shift+Tab should return to the trigger (got ${JSON.stringify(a2)})`);
    for (const e of errors) failures.push(`popups 1440: ${e}`);
    await context.close();
  }
  {
    // Skip to code moves focus, not only the scroll position (round 1).
    const { context, page } = await open("ml-training", { viewport: { width: 1440, height: 900 } });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    const sk = await page.evaluate(() => ({ id: document.activeElement?.id, hash: location.hash }));
    ok(sk.id === "code-h" && sk.hash === "#code", `Skip to code: focus ${JSON.stringify(sk)}`);
    await context.close();
  }
  for (const [vp, btn, tag] of [[{ width: 1024, height: 768 }, ".appbar-sections", "Sections menu"], [{ width: 390, height: 844 }, ".appbar-more", "More menu"]]) {
    const { context, page, errors } = await open("ml-training", { viewport: vp });
    const sel = `header.appbar ${btn}`;
    if (!(await page.locator(sel).isVisible().catch(() => false))) {
      ok(false, `${tag}: trigger ${sel} not visible at ${vp.width}`);
      await context.close();
      continue;
    }
    await page.focus(sel);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    const opened = await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "true" && Boolean(document.getElementById(document.querySelector(s).getAttribute("aria-controls") ?? "")), sel);
    ok(opened, `${tag}: menu not open with a live aria-controls`);
    await page.keyboard.press("Tab");
    const a = await active(page);
    const closed = await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "false" && !document.querySelector(s).hasAttribute("aria-controls"), sel);
    ok(!a.skip && !a.inLayer && closed, `${tag}: Tab went to ${JSON.stringify(a)} (closed ${closed})`);
    for (const e of errors) failures.push(`popups ${tag}: ${e}`);
    await context.close();
  }
}

// ── 7d. Forced colors (Windows High Contrast): selected states and data marks survive ──
if (want("forced")) {
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, forcedColors: "active" });
    const page = await context.newPage();
    await page.goto(pageUrl("ml-training"));
    await page.waitForFunction(() => document.getElementById("scalene-app")?.getAttribute("aria-busy") !== "true");
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const bg = (el, pseudo) => (el ? getComputedStyle(el, pseudo ?? null).backgroundColor : null);
      const transparent = (c) => !c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
      const on = document.querySelector('.seg-item[aria-checked="true"]');
      const off = document.querySelector('.seg-item[aria-checked="false"]');
      const segs = Array.from(document.querySelectorAll(".meter .meter__seg")).slice(0, 20).map((e) => bg(e));
      return {
        selectedDiffers: bg(on) !== bg(off) && !transparent(bg(on)),
        meterVisible: segs.length > 0 && segs.some((c) => !transparent(c)),
        navUnderline: !transparent(bg(document.querySelector(".appbar-nav-link[aria-current]"), "::after")),
      };
    });
    ok(r.selectedDiffers && r.meterVisible && r.navUnderline, `forced colors (${scheme}): ${JSON.stringify(r)}`);
    await shot(page, `forced-colors-${scheme}`);
    await context.close();
  }
}

// ── 7c. Way back after Show in stacks / timeline (round 1) ─────────────────────
if (want("wayback")) {
  const { context, page, errors } = await open("ml-training", { viewport: { width: 1440, height: 900 } });
  const st = () => page.evaluate(() => ({ y: Math.round(scrollY), hash: location.hash, chip: document.querySelector(".return-chip")?.textContent ?? null, active: document.activeElement?.getAttribute("aria-label") ?? "" }));
  await page.locator("#overview .hs-row").first().click();
  await page.waitForTimeout(700);
  const atLine = await st();
  ok(/^Line 173/.test(atLine.active), `wayback: hotspot #1 did not focus line 173 (${JSON.stringify(atLine)})`);
  await page.locator("#code button", { hasText: "Show in stacks" }).first().click();
  await page.waitForTimeout(700);
  const inStacks = await st();
  ok(inStacks.hash === "#stacks" && inStacks.chip === "Back to train.py:173" && inStacks.y > atLine.y + 200, `wayback: no return chip after Show in stacks (${JSON.stringify(inStacks)})`);
  await page.locator(".return-chip-back").click();
  await page.waitForTimeout(700);
  const back1 = await st();
  ok(/^Line 173/.test(back1.active) && Math.abs(back1.y - atLine.y) < 120 && back1.chip === null, `wayback: chip did not return to line 173 (${JSON.stringify(back1)})`);
  await page.locator("#code button", { hasText: "Show in timeline" }).first().click();
  await page.waitForTimeout(700);
  await page.goBack();
  await page.waitForTimeout(700);
  const back2 = await st();
  ok(/^Line 173/.test(back2.active) && Math.abs(back2.y - atLine.y) < 120, `wayback: browser Back did not return to line 173 (${JSON.stringify(back2)})`);
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator("header.appbar nav a", { hasText: "Code" }).first().click();
  await page.waitForTimeout(700);
  const nav = await st();
  ok(/^Line 173/.test(nav.active) && Math.abs(nav.y - atLine.y) < 120, `wayback: nav Code did not return to the selected row (${JSON.stringify(nav)})`);
  for (const e of errors) failures.push(`wayback: ${e}`);
  await context.close();
}

if (want("motion")) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(mockInit, { storage: { "service-select": "anthropic", ...CREDS.anthropic }, routes: [{ match: "anthropic", ...success("anthropic", REPLY) }] });
  await page.goto(pageUrl("ml-training", ""));
  await page.waitForFunction(() => document.getElementById("scalene-app")?.getAttribute("aria-busy") !== "true");
  await page.waitForTimeout(1200);
  const anims = () =>
    page.evaluate(() =>
      document.getAnimations().map((a) => {
        const kf = a.effect?.getKeyframes?.() ?? [];
        const props = new Set(kf.flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p))));
        return { props: [...props], ms: Number(a.effect?.getTiming?.().duration) || 0, name: a.animationName || a.transitionProperty || "" };
      }),
    );
  await page.evaluate(() => document.querySelector(".appbar-ai").click());
  await page.waitForTimeout(30);
  const d = (await anims()).filter((a) => !a.props.every((p) => p === "opacity") || a.ms > 120);
  ok(d.length === 0, `reduced motion: drawer animations ${JSON.stringify(d)}`);
  const pos = await page.evaluate(() => getComputedStyle(document.querySelector(".ai-drawer")).transform);
  ok(pos === "none", `reduced motion: drawer transform ${pos}`);
  await page.keyboard.press("Escape");
  await request(page);
  await waitStatus(page, "result");
  await page.click(".ai-card .ai-regen");
  await page.waitForTimeout(20);
  // The jump flash (M14) is a colour change and stays under reduced motion (§5.4).
  const c = (await anims()).filter((a) => a.name !== "m-flash" && (!a.props.every((p) => p === "opacity") || a.ms > 120));
  ok(c.length === 0, `reduced motion: card animations ${JSON.stringify(c)}`);
  await context.close();
}

await browser.close();
for (const f of failures) console.log(`FAIL  ${f}`);
fs.mkdirSync(path.join(outDir, "e2e"), { recursive: true });
fs.writeFileSync(
  path.join(outDir, "e2e", "shell-ai.json"),
  JSON.stringify({ suite: "shell-ai", at: new Date().toISOString(), checks, failures }, null, 2),
);
console.log(`\nshell-ai: ${checks - failures.length}/${checks} passed`);
process.exit(failures.length ? 1 : 0);
