// AI settings drawer (DESIGN.md §4.14.4, must-fix 23): a real modal (role=dialog,
// aria-modal, inert background, focus trap, Esc / × / Done / scrim close and focus return).
// Every provider and field of the upstream form, rendered from `providerInfo(id).fields`
// with the upstream element ids; persistence only through the controller (saveSettings).
// Network only on explicit actions: model Refresh, Ollama Check, and the debounced OpenAI key
// check while typing. Picking Local does not probe localhost (a missing server would log a
// console error the user did not ask for, round 1).
import {
  checkReady,
  envFilledFields,
  listModels,
  modelOptions,
  PROVIDERS,
  providerInfo,
  providerLabel,
  resolvedModel,
  updateProviderField,
  validateApiKey,
  type AiSettings,
  type ModelOption,
  type PromptStyle,
  type ProviderFieldSpec,
  type ProviderId,
} from "../../ai/index";
import type { ModalHandle } from "../../core/a11y";
import { disclosure, segmented, type Choice, type Disclosure } from "../../core/controls";
import { h, uid, VISUALLY_HIDDEN } from "../../core/dom";
import { icon } from "../../core/icons";
import { DUR } from "../../core/motion";
import { bindTooltip } from "../../core/tooltip";
import type { ShellContext } from "../app";
import type { AiControllerHandle } from "./controller";
import { AI_PRIVACY, FIELD_IDS, resolveFocusField, shortModel } from "./logic";

export interface AiDrawerLegacy {
  toggleServiceFields(): void;
  togglePassword(btn: HTMLElement): void;
  toggleAdvanced(el: HTMLElement): void;
  refreshModels(provider: "openai" | "gemini"): void;
  checkApiKey(value: string): void;
}

export interface AiDrawer {
  open(focusField?: string): void;
  close(): void;
  isOpen(): boolean;
  /** Settings or profile changed outside the drawer: refresh every control. */
  sync(): void;
  readonly legacy: AiDrawerLegacy;
  destroy(): void;
}

const KEY_CHECK_DEBOUNCE_MS = 600;

/** Short second line on each provider tile. */
const TILE_NOTE: Record<ProviderId, string> = {
  amazon: "AWS credentials",
  anthropic: "API key",
  "azure-openai": "Key + endpoint",
  gemini: "API key",
  openai: "API key",
  local: "Runs on your machine",
};

const PROMPT_STYLES: readonly { value: PromptStyle; label: string; note: string }[] = [
  {
    value: "auto",
    label: "Auto (recommended)",
    note: "Runtime goals use Scalene's classic insights prompt; memory goals use the targeted memory prompt.",
  },
  { value: "insights", label: "Scalene insights (classic)", note: "The upstream prompt with the line's profile numbers, for either goal." },
  { value: "targeted", label: "Targeted", note: "A focused prompt for the selected goal: runtime performance or memory efficiency." },
];

interface FieldRef {
  provider: ProviderId;
  spec: ProviderFieldSpec;
  id: string;
  input: HTMLInputElement | HTMLSelectElement;
  msg: HTMLElement;
  env: HTMLElement;
  /** Validation message (URL / port format), shown in `msg` when set. */
  invalid: string | null;
}

interface PanelRef {
  provider: ProviderId;
  el: HTMLElement;
  readiness: HTMLElement;
  adv: Disclosure | null;
  fields: FieldRef[];
  tile: HTMLLabelElement;
  radio: HTMLInputElement;
  tileState: HTMLElement;
}

const fieldValue = (s: AiSettings, p: ProviderId, field: string): string =>
  String((s.providers[p] as unknown as Record<string, unknown>)[field] ?? "");

const isUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v.trim());

function validationMessage(spec: ProviderFieldSpec, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (spec.kind === "url" && !isUrl(v)) return "Enter a full URL that starts with https:// (or http:// for a local server).";
  if (spec.kind === "number") {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return "Enter a port number between 1 and 65535.";
  }
  return null;
}

/** Visible label of a provider field ("API key"), lower-cased for sentences. */
const fieldLabel = (p: ProviderId, field: string): string =>
  providerInfo(p).fields.find((f) => f.field === field)?.label ?? field;

export function createAiDrawer(shell: ShellContext, ai: AiControllerHandle): AiDrawer {
  const titleId = uid("ai-title");
  const descId = uid("ai-desc");
  const remote: Partial<Record<ProviderId, ModelOption[]>> = {};
  const disposers: (() => void)[] = [];
  let modal: ModalHandle | null = null;
  let open = false;
  let hideTimer = 0;
  let keyTimer = 0;
  let keyAbort: AbortController | null = null;
  let keyStatus: "idle" | "checking" | "valid" | "invalid" | "unchecked" | "custom" = "idle";

  const settings = () => ai.settings();
  const apply = (next: AiSettings, debounce = false) => {
    ai.setSettings(next, { debounce });
    refresh();
  };

  // ── Header ────────────────────────────────────────────────────────────────
  const statusDot = h("span", { class: "ai-status-dot", "aria-hidden": "true" });
  const statusText = h("span", { class: "ai-status-text" });
  const closeBtn = h(
    "button",
    { type: "button", class: "icon-btn ai-close", "aria-label": "Close AI settings", onClick: () => close() },
    icon("x"),
  );
  disposers.push(bindTooltip(shell.tooltip, closeBtn, { title: "Close (Esc)" }));
  const head = h(
    "header",
    { class: "ai-dh" },
    h("span", { class: "ai-dh-mark", "aria-hidden": "true" }, icon("spark")),
    h(
      "div",
      { class: "ai-dh-text" },
      h("h2", { id: titleId, class: "ai-dh-title" }, "AI optimization"),
      h("p", { class: "ai-status", "aria-live": "polite" }, statusDot, statusText),
    ),
    closeBtn,
  );

  // ── Provider tiles (radiogroup #service-select, upstream order) ───────────
  const groupName = uid("ai-provider");
  const providerLabelId = uid("ai-pl");
  const tiles = h("div", { id: "service-select", class: "ai-tiles", role: "radiogroup", "aria-labelledby": providerLabelId });
  const fieldsHost = h("div", { class: "ai-panels" });
  const panels = new Map<ProviderId, PanelRef>();

  const selectProvider = (p: ProviderId, user: boolean) => {
    const s = settings();
    if (s.provider !== p) apply({ ...s, provider: p });
    else refresh();
    void user;
  };

  // Compatibility: upstream code reads and writes `#service-select`.value.
  Object.defineProperty(tiles, "value", {
    configurable: true,
    get: () => settings().provider,
    set: (v: unknown) => {
      if (PROVIDERS.some((p) => p.id === v)) selectProvider(v as ProviderId, false);
    },
  });

  const buildField = (p: ProviderId, spec: ProviderFieldSpec): { row: HTMLElement; ref: FieldRef } => {
    const id = FIELD_IDS[p][spec.field] ?? uid("ai-field");
    const msgId =
      p === "openai" && spec.field === "apiKey" ? "valid-api-key" : p === "local" && spec.kind === "model" ? "install-models-message" : `${id}-msg`;
    const envId = `${id}-env`;
    const hintId = spec.hint ? `${id}-hint` : null;
    const env = h("span", { id: envId, class: "ai-env", hidden: true }, icon("check", 12), "from environment");
    const msg = h("p", { id: msgId, class: "ai-msg", "aria-live": "polite" });
    // The env badge joins the description only while it is shown (see refresh()).
    const describedBy = [msgId, hintId].filter(Boolean).join(" ");
    let input: HTMLInputElement | HTMLSelectElement;
    const trailing: HTMLElement[] = [];

    if (spec.kind === "model") {
      const sel = h("select", { id, class: "select-input ai-select", "aria-describedby": describedBy });
      sel.addEventListener("change", () => apply(updateProviderField(settings(), p, "model" as never, sel.value as never)));
      input = sel;
      if (p === "local") {
        trailing.push(
          h(
            "button",
            { type: "button", class: "btn btn-secondary ai-check", "data-action": "check", onClick: () => void checkOllama() },
            icon("sync"),
            h("span", { class: "btn-label" }, "Check"),
          ),
        );
      } else if (providerInfo(p).canListModels) {
        const refreshBtn = h(
          "button",
          {
            type: "button",
            class: "icon-btn ai-refresh",
            "aria-label": `Refresh the ${providerLabel(p)} model list`,
            "data-action": "refresh",
            onClick: () => void refreshModels(p as "openai" | "gemini"),
          },
          icon("sync"),
        );
        disposers.push(bindTooltip(shell.tooltip, refreshBtn, { title: "Refresh the model list", hint: "Asks the provider which models this key can use." }));
        trailing.push(refreshBtn);
      }
    } else {
      const secret = spec.kind === "secret";
      const inp = h("input", {
        id,
        class: "text-input ai-input",
        type: secret ? "password" : spec.kind === "url" ? "url" : "text",
        inputmode: spec.kind === "number" ? "numeric" : undefined,
        placeholder: spec.placeholder,
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        "aria-describedby": describedBy,
      });
      inp.addEventListener("input", () => {
        apply(updateProviderField(settings(), p, spec.field as never, inp.value as never), true);
        if (p === "openai" && (spec.field === "apiKey" || spec.field === "customUrl")) scheduleKeyCheck();
      });
      inp.addEventListener("change", () => validateField(ref));
      input = inp;
      if (secret) {
        const reveal = h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-compact ai-reveal",
            "aria-pressed": "false",
            "aria-controls": id,
            "aria-label": `Show ${spec.label}`,
            onClick: (ev: MouseEvent) => togglePassword(ev.currentTarget as HTMLElement),
          },
          icon("eye"),
          h("span", { class: "btn-label", "aria-hidden": "true" }, "Show"),
        );
        trailing.push(reveal);
      }
    }

    const label = h("label", { class: "ai-label", for: id }, spec.label);
    const help = spec.helpUrl
      ? h(
          "a",
          { class: "ai-help", href: spec.helpUrl, target: "_blank", rel: "noopener noreferrer" },
          "Get a key",
          h("span", { class: VISUALLY_HIDDEN }, ` for ${providerLabel(p)} (opens in a new tab)`),
          icon("external", 12),
        )
      : null;
    const control =
      spec.kind === "model"
        ? h(
            "div",
            { class: "ai-control", id: p === "local" ? "local-models-list" : undefined },
            h("span", { class: "select-box ai-select-box" }, input, icon("chevron-down")),
            trailing,
          )
        : h("div", { class: "ai-control" }, input, trailing);
    const row = h(
      "div",
      { class: ["ai-field", `ai-field-${spec.kind}`], dataset: { field: spec.field } },
      h("div", { class: "ai-label-row" }, label, env, h("span", { class: "ai-label-gap" }), help),
      control,
      msg,
      spec.hint ? h("p", { id: hintId, class: "ai-hint" }, spec.hint) : null,
    );
    const ref: FieldRef = { provider: p, spec, id, input, msg, env, invalid: null };
    if (spec.envVars?.length) {
      disposers.push(
        bindTooltip(shell.tooltip, env, { title: "Filled from the environment", code: spec.envVars.join(" or "), hint: "Served by scalene view --api-keys-from-env; never written to storage." }),
      );
    }
    return { row, ref };
  };

  for (const info of PROVIDERS) {
    const p = info.id;
    const radio = h("input", { type: "radio", name: groupName, value: p, class: "ai-tile-radio" });
    radio.addEventListener("change", () => {
      if (radio.checked) selectProvider(p, true);
    });
    const tileState = h("span", { class: "ai-tile-state" });
    const tile = h(
      "label",
      { class: "ai-tile" },
      radio,
      h("span", { class: "ai-tile-dot", "aria-hidden": "true" }),
      h("span", { class: "ai-tile-name" }, info.label),
      h("span", { class: "ai-tile-note" }, TILE_NOTE[p]),
      tileState,
    );
    tiles.append(tile);

    const fields: FieldRef[] = [];
    const basic: HTMLElement[] = [];
    const advanced: HTMLElement[] = [];
    for (const spec of info.fields) {
      const { row, ref } = buildField(p, spec);
      fields.push(ref);
      (spec.advanced ? advanced : basic).push(row);
    }
    const adv = advanced.length
      ? disclosure({ label: "Advanced options", content: h("div", { class: "ai-adv-body" }, advanced), class: "ai-adv" })
      : null;
    const readiness = h("p", { class: "ai-readiness", "aria-live": "polite" });
    const note = info.note
      ? h(
          "p",
          { class: "ai-note" },
          h(
            "a",
            { href: info.noteUrl, target: "_blank", rel: "noopener noreferrer" },
            "Run AI locally with Ollama",
            h("span", { class: VISUALLY_HIDDEN }, " (opens in a new tab)"),
            icon("external", 12),
          ),
          ". Nothing leaves this machine; the server is contacted only when you press Check.",
        )
      : null;
    let body: HTMLElement[] = basic;
    if (p === "local") {
      // Server : Port on one row, then the model (§4.14.4).
      const [host, port, ...rest] = basic;
      body = [h("div", { class: "ai-hostport" }, host, h("span", { class: "ai-colon", "aria-hidden": "true" }, ":"), port), ...rest];
    }
    const el = h(
      "div",
      { class: "ai-panel", dataset: { provider: p }, role: "group", "aria-label": `${info.label} settings` },
      note,
      readiness,
      body,
      adv ? adv.el : null,
    );
    fieldsHost.append(el);
    panels.set(p, { provider: p, el, readiness, adv, fields, tile, radio, tileState });
  }

  // ── Global options ────────────────────────────────────────────────────────
  const target: Choice<"performance" | "memory"> = segmented({
    label: "Optimize for",
    options: [
      { value: "performance", label: "Runtime performance" },
      { value: "memory", label: "Memory efficiency" },
    ],
    value: settings().target,
    onChange: (v) => apply({ ...settings(), target: v }),
  });
  disposers.push(() => target.destroy());
  const [perfBtn, memBtn] = target.buttons();
  perfBtn.id = "optimize-performance";
  memBtn.id = "optimize-memory";

  const accelName = h("span", { id: "accelerator-name" }, ai.accelerator());
  const gpuSwitch = h(
    "button",
    { type: "button", role: "switch", class: "switch ai-switch", id: "use-gpu-checkbox", "aria-checked": "false" },
    h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-thumb" })),
    h("span", { class: "switch-label" }, "Include ", accelName, " optimizations"),
  );
  gpuSwitch.addEventListener("click", () => apply({ ...settings(), useGpu: !settings().useGpu }));

  const promptSel = h(
    "select",
    { id: "ai-prompt-style", class: "select-input ai-select" },
    PROMPT_STYLES.map((o) => h("option", { value: o.value }, o.label)),
  );
  const promptNote = h("p", { class: "ai-hint", id: uid("ai-prompt-note") });
  promptSel.setAttribute("aria-describedby", promptNote.id);
  promptSel.addEventListener("change", () => apply({ ...settings(), promptStyle: promptSel.value as PromptStyle }));
  const globalAdv = disclosure({
    label: "Prompt",
    class: "ai-adv ai-adv-global",
    content: h(
      "div",
      { class: "ai-adv-body" },
      h(
        "div",
        { class: "ai-field" },
        h("div", { class: "ai-label-row" }, h("label", { class: "ai-label", for: "ai-prompt-style" }, "Prompt style")),
        h("div", { class: "ai-control" }, h("span", { class: "select-box ai-select-box" }, promptSel, icon("chevron-down"))),
        promptNote,
      ),
    ),
  });

  // ── Body, footer, layer ───────────────────────────────────────────────────
  const section = (label: string, id: string | null, ...children: (HTMLElement | null)[]) =>
    h("section", { class: "ai-section" }, h("h3", { class: "ai-section-label micro", id }, label), children);

  const body = h(
    "div",
    { class: "ai-db" },
    h(
      "p",
      { id: descId, class: "ai-privacy" },
      AI_PRIVACY,
    ),
    section("Provider", providerLabelId, tiles, fieldsHost),
    section("Optimize for", null, target.el, gpuSwitch),
    section("Advanced", null, globalAdv.el),
  );
  const doneBtn = h("button", { type: "button", class: "btn btn-primary ai-done", onClick: () => close() }, "Done");
  const foot = h(
    "footer",
    { class: "ai-df" },
    h(
      "p",
      { class: "ai-df-text" },
      "Proposals are sent from your browser directly to the provider. Keys are stored in this browser's localStorage. AI-generated suggestions may not always be correct.",
    ),
    doneBtn,
  );
  const panel = h(
    "section",
    { class: "ai-drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": descId },
    head,
    body,
    foot,
  );
  const scrim = h("div", { class: "ai-scrim", "aria-hidden": "true", onClick: () => close() });
  const layer = h("div", { class: "ai-layer", hidden: true }, scrim, panel);
  shell.layerRoot.appendChild(layer);

  // ── Sync (settings → controls) ────────────────────────────────────────────
  function refreshSelects(p: ProviderId): void {
    const ref = panels.get(p)?.fields.find((f) => f.spec.kind === "model");
    if (!ref) return;
    const s = settings();
    const sel = ref.input as HTMLSelectElement;
    const opts = modelOptions(p, s, remote[p] ?? providerInfo(p).models);
    const current = fieldValue(s, p, "model");
    const sig = opts.map((o) => o.value).join("\n");
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.replaceChildren(
        ...(opts.length
          ? opts.map((o) => h("option", { value: o.value }, o.label))
          : [h("option", { value: "" }, p === "local" ? "No models yet: press Check" : "No models")]),
      );
    }
    sel.value = current;
    if (sel.value !== current && opts.length === 0) sel.value = "";
  }

  function validateField(ref: FieldRef): void {
    if (ref.spec.kind === "model") return;
    ref.invalid = validationMessage(ref.spec, (ref.input as HTMLInputElement).value);
    renderFieldMsg(ref);
  }

  /** Replace a live message only when it changed (no repeated announcements). */
  function setMsg(el: HTMLElement, sig: string, cls: string, ...content: (Node | string)[]): void {
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.className = cls;
    el.replaceChildren(...content);
  }

  function renderFieldMsg(ref: FieldRef): void {
    if (ref.spec.kind === "model") return; // owned by refreshModels / checkOllama
    if (ref.provider === "openai" && ref.spec.field === "apiKey") {
      renderKeyStatus(ref);
      return;
    }
    if (ref.invalid) setMsg(ref.msg, `invalid:${ref.invalid}`, "ai-msg is-error", icon("alert", 12), ref.invalid);
    else setMsg(ref.msg, "", "ai-msg");
    ref.input.toggleAttribute("aria-invalid", ref.invalid !== null);
  }

  function renderKeyStatus(ref: FieldRef): void {
    const s = settings().providers.openai;
    if (!s.apiKey) setMsg(ref.msg, "", "ai-msg");
    else if (s.customUrl.trim()) setMsg(ref.msg, "custom", "ai-msg", "Not checked (custom URL)");
    else if (keyStatus === "checking") setMsg(ref.msg, "checking", "ai-msg is-busy", icon("sync", 12), "Checking the key\u2026");
    else if (keyStatus === "valid") setMsg(ref.msg, "valid", "ai-msg is-ok", icon("check", 12), "Key accepted");
    else if (keyStatus === "invalid") setMsg(ref.msg, "invalid", "ai-msg is-error", icon("x", 12), "Key rejected");
    else if (keyStatus === "unchecked") setMsg(ref.msg, "unchecked", "ai-msg", "Not checked (api.openai.com could not be reached)");
    else setMsg(ref.msg, "", "ai-msg");
    ref.input.toggleAttribute("aria-invalid", keyStatus === "invalid" && !s.customUrl.trim());
  }

  function refresh(): void {
    const s = settings();
    const env = ai.env();
    const fromEnv = envFilledFields(s, env);
    const ready = checkReady(s);
    for (const ref of panels.values()) {
      const active = ref.provider === s.provider;
      ref.el.hidden = !active;
      ref.radio.checked = active;
      ref.tile.classList.toggle("is-selected", active);
      const r = checkReady(s, ref.provider);
      ref.tile.classList.toggle("is-ready", r.ready);
      ref.tileState.textContent = r.ready ? "Configured" : "";
      ref.tileState.hidden = !r.ready;
      for (const f of ref.fields) {
        if (f.spec.kind === "model") {
          refreshSelects(ref.provider);
        } else {
          const v = fieldValue(s, ref.provider, f.spec.field);
          if (document.activeElement !== f.input && f.input.value !== v) f.input.value = v;
        }
        const envOn = fromEnv.some((e) => e.provider === ref.provider && e.field === f.spec.field);
        if (f.env.hidden === envOn) {
          f.env.hidden = !envOn;
          const ids = (f.input.getAttribute("aria-describedby") ?? "").split(" ").filter((x) => x && x !== f.env.id);
          f.input.setAttribute("aria-describedby", (envOn ? [f.env.id, ...ids] : ids).join(" "));
        }
        renderFieldMsg(f);
      }
      if (active) {
        const info = providerInfo(ref.provider);
        if (r.ready) {
          const modelId = resolvedModel(ref.provider, s.providers);
          setMsg(
            ref.readiness,
            `ready:${modelId}`,
            "ai-readiness is-ready",
            icon("check", 14),
            h("span", null, "Ready. Proposals use ", h("code", { class: "ai-model-chip" }, modelId), "."),
          );
        } else {
          const missing = r.missing.map((f) => fieldLabel(ref.provider, f));
          const text =
            ref.provider === "local" && r.missing.includes("model")
              ? "Needs a model from a running Ollama server. Press Check to look for one."
              : `Needs: ${missing.join(", ")}${info.id === "openai" ? " (or a custom URL)" : ""}.`;
          setMsg(ref.readiness, `missing:${text}`, "ai-readiness", icon("info", 14), h("span", null, text));
        }
      }
    }
    statusDot.classList.toggle("is-ready", ready.ready);
    const status = ready.ready
      ? `Ready \u00b7 ${providerLabel(s.provider)} \u00b7 ${shortModel(resolvedModel(s.provider, s.providers))}`
      : `${providerLabel(s.provider)} is not set up yet`;
    if (statusText.textContent !== status) statusText.textContent = status;
    target.set(s.target);
    gpuSwitch.setAttribute("aria-checked", String(s.useGpu));
    accelName.textContent = ai.accelerator();
    promptSel.value = s.promptStyle;
    promptNote.textContent = PROMPT_STYLES.find((o) => o.value === s.promptStyle)?.note ?? "";
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function busy(btn: HTMLElement | null, on: boolean): void {
    if (!btn) return;
    btn.classList.toggle("is-busy", on);
    if (on) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
  }

  async function refreshModels(p: "openai" | "gemini"): Promise<void> {
    const ref = panels.get(p)?.fields.find((f) => f.spec.kind === "model");
    if (!ref) return;
    const btn = ref.input.closest(".ai-control")?.querySelector<HTMLElement>("[data-action=refresh]") ?? null;
    busy(btn, true);
    setMsg(ref.msg, "busy", "ai-msg is-busy", icon("sync", 12), "Asking the provider for models\u2026");
    const result = await listModels(p, settings());
    busy(btn, false);
    if (result.source === "remote") remote[p] = result.models;
    if (result.error) {
      const text = `${result.error.message} Showing the built-in list.`;
      setMsg(ref.msg, `error:${text}`, "ai-msg is-error", icon("alert", 12), text);
    } else {
      const n = result.models.length;
      setMsg(ref.msg, `ok:${n}`, "ai-msg is-ok", icon("check", 12), `${n} model${n === 1 ? "" : "s"} available to this key`);
    }
    refreshSelects(p);
  }

  async function checkOllama(): Promise<void> {
    const ref = panels.get("local")?.fields.find((f) => f.spec.kind === "model");
    if (!ref) return;
    const btn = ref.input.closest(".ai-control")?.querySelector<HTMLElement>("[data-action=check]") ?? null;
    busy(btn, true);
    setMsg(ref.msg, "busy", "ai-msg is-busy", icon("sync", 12), "Looking for an Ollama server\u2026");
    const result = await listModels("local", settings());
    busy(btn, false);
    if (result.error || result.models.length === 0) {
      remote.local = [];
      const noServer = result.error?.kind === "network";
      const cfg = settings().providers.local;
      const where = `${cfg.host || "localhost"}:${cfg.port || "11434"}`;
      if (noServer) {
        // Pulling a model does not start a server: say what to run, in order.
        setMsg(ref.msg, "noserver", "ai-msg is-error", icon("alert", 12), `No Ollama server at ${where}. Start it with `, h("code", null, "ollama serve"), ", then pull a model: ", h("code", null, "ollama pull codellama"), ".");
      } else {
        setMsg(ref.msg, "nomodels", "ai-msg is-error", icon("alert", 12), `The Ollama server at ${where} has no models. Run: `, h("code", null, "ollama pull codellama"));
      }
    } else {
      remote.local = result.models;
      const n = result.models.length;
      setMsg(ref.msg, `ok:${n}`, "ai-msg is-ok", icon("check", 12), `${n} model${n === 1 ? "" : "s"} found`);
      const s = settings();
      if (!s.providers.local.model || !result.models.some((m) => m.value === s.providers.local.model)) {
        apply(updateProviderField(s, "local", "model", result.models[0].value));
      }
    }
    refreshSelects("local");
    refresh();
  }

  function scheduleKeyCheck(immediate = false): void {
    window.clearTimeout(keyTimer);
    keyAbort?.abort();
    keyAbort = null;
    const cfg = settings().providers.openai;
    if (!cfg.apiKey || cfg.customUrl.trim()) {
      keyStatus = cfg.customUrl.trim() ? "custom" : "idle";
      refresh();
      return;
    }
    const runCheck = async () => {
      keyStatus = "checking";
      refresh();
      const ac = new AbortController();
      keyAbort = ac;
      try {
        const st = await validateApiKey("openai", settings(), ac.signal);
        if (keyAbort !== ac) return;
        keyStatus = st === "valid" ? "valid" : st === "invalid" ? "invalid" : "unchecked";
      } catch {
        if (keyAbort !== ac) return;
        keyStatus = "unchecked";
      }
      keyAbort = null;
      refresh();
    };
    if (immediate) void runCheck();
    else {
      keyStatus = "idle";
      keyTimer = window.setTimeout(() => void runCheck(), KEY_CHECK_DEBOUNCE_MS);
    }
  }

  function togglePassword(btn: HTMLElement): void {
    const id = btn.getAttribute("aria-controls");
    const input = id ? (document.getElementById(id) as HTMLInputElement | null) : null;
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", String(show));
    const label = btn.querySelector(".btn-label");
    if (label) label.textContent = show ? "Hide" : "Show";
  }

  function toggleAdvanced(el: HTMLElement): void {
    const host = el.closest(".ai-adv");
    const current = panels.get(settings().provider)?.adv ?? null;
    const target = Array.from(panels.values()).find((p) => p.adv?.el === host)?.adv ?? (host === globalAdv.el ? globalAdv : current);
    if (target) target.set(!target.isOpen());
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  const motionOff = () => shell.motion.reduced || shell.motion.still;

  function focusTarget(focusField?: string): HTMLElement {
    const p = settings().provider;
    const id = resolveFocusField(p, focusField);
    const el = id ? (document.getElementById(id) as HTMLElement | null) : null;
    if (el && panel.contains(el)) {
      const adv = el.closest(".ai-adv");
      const pref = Array.from(panels.values()).find((x) => x.adv?.el === adv);
      if (pref?.adv && !pref.adv.isOpen()) pref.adv.set(true);
      if (!el.closest("[hidden]")) return el;
    }
    return panels.get(p)?.radio ?? closeBtn;
  }

  function show(focusField?: string): void {
    refresh();
    if (open) {
      const el = focusTarget(focusField);
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
      return;
    }
    window.clearTimeout(hideTimer);
    open = true;
    layer.hidden = false;
    layer.classList.remove("is-closing");
    shell.store.update((s) => ({ layers: { ...s.layers, drawer: true } }));
    // Next frame: start the slide-in from the off-screen state (M20).
    void layer.offsetWidth;
    layer.classList.add("is-open");
    shell.tooltip.hide();
    const initial = focusTarget(focusField);
    modal = shell.modals.open(panel, { onEscape: () => close(), initialFocus: initial });
    initial.scrollIntoView({ block: "nearest" });
  }

  function close(): void {
    if (!open) return;
    open = false;
    window.clearTimeout(keyTimer);
    modal?.close();
    modal = null;
    layer.classList.remove("is-open");
    layer.classList.add("is-closing");
    shell.store.update((s) => ({ layers: { ...s.layers, drawer: false } }));
    hideTimer = window.setTimeout(
      () => {
        layer.hidden = true;
        layer.classList.remove("is-closing");
      },
      motionOff() ? 0 : DUR.d3,
    );
  }

  refresh();

  return {
    open: show,
    close,
    isOpen: () => open,
    sync: refresh,
    legacy: {
      toggleServiceFields() {
        const picked = Array.from(panels.values()).find((p) => p.radio.checked)?.provider;
        if (picked && picked !== settings().provider) selectProvider(picked, false);
        else refresh();
      },
      togglePassword,
      toggleAdvanced,
      refreshModels: (p) => void refreshModels(p),
      checkApiKey(value) {
        const s = settings();
        apply(updateProviderField(s, "openai", "apiKey", String(value ?? "")));
        scheduleKeyCheck(true);
      },
    },
    destroy() {
      if (open) close();
      window.clearTimeout(hideTimer);
      window.clearTimeout(keyTimer);
      keyAbort?.abort();
      for (const d of disposers.splice(0)) d();
      layer.remove();
    },
  };
}
