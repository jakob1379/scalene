# WP5 AI + Shell — status

> **WP6:** this package's browser acceptance script now lives in the repo as `tools/e2e/shell-ai.mjs` (run all suites with `node tools/e2e.mjs`); see `design/WP6-INTEGRATION.md`.

**State: done, acceptance passing** (DESIGN.md §8.6 WP5). All WP1 stubs in `src/views/ai/*` and
`src/views/shell/*` are replaced. Verified in a sandbox copy of the tree (the shared tree also
contains other packages' in-progress files).

```sh
node build.mjs && node tools/render-fixture.mjs --fixtures ml-training,cpu-only,empty
node tools/unit.mjs wp5                 # 23 tests (wp5-ai, wp5-shell); full suite 340 pass in the current tree
node tools/e2e/shell-ai.mjs             # Chromium acceptance: 163 checks + screenshots → design/screens/e2e/shell-ai/
node tools/e2e/shell-ai.mjs --only ai   # subsets: ai, drawer, network, loader, palette, footer, motion
```

## 1. What exists

| File | Contents |
|---|---|
| `src/views/ai/controller.ts` | `AiController` (§8.5, exact) + `AiControllerHandle` (shell lifecycle and WP5 internals: `setSettings`, `retry`, `patchResult`, `requestOf`, `env`, `accelerator`, `closeSettings`). Env keys fetched once at boot (`fetchEnvApiKeys`, http(s) only), settings via `loadSettings`/`saveSettings` (text edits debounced 300 ms), `syncSettingsWithProfile` on each load (not treated as a user edit), per-file availability cache, one card per anchor `file:line`, AbortController per request, superseded requests ignored, polite/assertive announcements, `ai:open-settings` bus listener, legacy drawer globals registered through `registerLegacyAiHandlers`. Setup cards follow the settings live (become "Ready to optimize …" once configured). |
| `src/views/ai/card.ts` | `renderAiCard(el, anchor, ctx)`: reuses `el`, rebuilds only when the state object changes. States: setup (privacy line, Set up AI provider → drawer focused on the first missing field), working (header, provider · model · live elapsed in 1 s ticks, 3 static skeleton bars shaped like the code being rewritten, Cancel), result (Proposal \| Diff segmented, highlighted proposal re-indented to the clicked line, LCS diff with original line numbers and −/+ washed gutters, diffstat, Copy → ✓ Copied 1.2 s, Regenerate, Show prompt disclosure, Dismiss, disclaimer), error (§4.14.5 copy, Retry — disabled with a countdown for rate limits, Open AI settings / Choose another model, Details disclosure). M22: unfold on appear (grid rows 0fr → 1fr), height eases between states, focus follows the primary action. Follows the code table's wrap mode. |
| `src/views/ai/drawer.ts` | Settings drawer (§4.14.4): real modal through `shell.modals` (inert background, Tab trap, Esc/×/Done/scrim, focus return), 440 px right drawer / full-screen sheet on `xs`, M20 slide. Six provider tiles (radiogroup `#service-select` with a `value` property), every catalog field with the upstream ids, Show/Hide (`aria-pressed`, `aria-controls`), Advanced options, model selects from `modelOptions` with Refresh (OpenAI, Gemini) and Ollama Check (also on picking Local), OpenAI key status `#valid-api-key` (600 ms debounce), "from environment" badges (env var in tooltip, part of the description while shown), per-provider readiness line, URL/port validation, Optimize for (`#optimize-performance`/`#optimize-memory`), `#use-gpu-checkbox` + `#accelerator-name`, Prompt style, footer note. |
| `src/views/ai/logic.ts` | Pure helpers: `FIELD_IDS`, `resolveFocusField`, `keyFieldId`, `shortModel`, `dedent`/`reindent`/`splitLines`, `lineDiff` (LCS, capped), `diffStats`, `errorView` (§4.14.5 table), `errorDetail`, labels. |
| `src/views/shell/loader.ts` | §4.15: file input, drag-and-drop anywhere (full-viewport overlay, M25), validation (`{}` → empty state, no `files` → "This JSON is not a Scalene profile (no "files" section)"), progress toast above 2 MiB, success toast "Loaded x.json · N files", persistent error toast (report stays), `loadDemo`, `loadFetch`. |
| `src/views/shell/empty.ts` | §4.16: centered card, logo 40, two copyable CLI steps, Choose a profile…, dashed drop zone, demo button when `example_profile` exists. |
| `src/views/shell/footer.ts` | §4.17: version/date from `#scalene-footer`, issue and success-story links, Load another profile, units note, Reduce motion switch, Keyboard shortcuts; version only in the empty state. |
| `src/views/shell/palette.ts` | §4.20: modal combobox + grouped listbox (Top hotspots, Lines, Functions, Files, Sections, Actions), lazy sliced index, code-like queries search Lines first, prefix label matches first, weak fuzzy hits and path-only file matches dropped, match underlines, 8 rows per group + "Show all N matching lines" (≤ 50), ↑/↓/PgUp/PgDn/Enter/Esc, instant open/close. |
| `src/views/shell/shortcuts.ts` | §6.2.3 keyboard map as a modal dialog; scopes of absent sections drop out; `?` toggles. |
| `src/styles/70-ai.css`, `80-shell.css` | Token-only styles, both themes, all breakpoints, reduced-motion paths. |
| `tests/unit/wp5-ai.test.mjs`, `wp5-shell.test.mjs` | Helpers, error table, id/storage-key parity, prompt sanity on every fixture, controller state machine with mocked fetch/storage, loader validation, palette ranking and search results. |
| `tools/e2e/shell-ai.mjs` (was `tools/wp5-check.mjs`) | Chromium acceptance script (below). |

## 2. Acceptance (§8.6 WP5)

| Criterion | Result | Evidence |
|---|---|---|
| Every provider's happy path renders a result card (proposal + diff) with a mocked fetch | pass | `wp5-check --only ai`: Amazon Bedrock (SigV4 via WebCrypto on file://), Anthropic, Azure OpenAI, Gemini, OpenAI (+ key check), Ollama → result card, proposal text, request host, diff = 5 added / 1 removed with original line 173 |
| Every AiError kind renders its copy and actions | pass | invalid-key, quota, rate-limit (Retry disabled 5 s), model-not-found, bad-request, server, network, network (Ollama hint), empty-response, unknown; missing credentials → setup card (no request); aborted → removed silently; unit test covers the full `errorView` table incl. missing-credentials |
| Cancel aborts | pass | fetch signal aborted, card removed, toast "Request cancelled" |
| Regenerate replaces the card | pass | one card, new content, 3 provider calls in total |
| Drawer is a real modal | pass | role=dialog, aria-modal, `#scalene-app` and footer inert, 40 Tab/Shift+Tab presses stay inside, Esc closes and focus returns to the AI button |
| Drawer saves to the upstream storage keys (test reads localStorage) | pass | `service-select` + `scalene-service-select`, `anthropic-api-key`, `language-model-anthropic`, `optimize-memory`/`optimize-performance`, `use-gpu-checkbox`, `azure-api-version`, `scalene-api-key`, `local-port`, `aws-session-token`; env values never written |
| No network request on page load (file://) | pass | zero non-file requests in 1.5 s |
| http:// load: only `/env-api-keys.json` and `/heartbeat` | pass | local server, 10.6 s window; env prefill selects Anthropic, badge shown, app-bar dot ready |
| Invalid JSON drop → error toast, report stays | pass | overlay on dragenter, hidden after drop, `role=alert` toast "Couldn't load bad.json: …", overview still mounted |
| `{}` → empty state | pass | drop of `{}` shows the empty card, title "Scalene", footer version only |
| Loader extras | pass | non-profile JSON message, file input success toast "Loaded cpu-only.json · N files", huge.json (15.4 MiB) shows "Reading huge.json · 15.4 MiB…" then "Loaded huge.json · 40 files"; hosted demo (`example_profile`) button loads it |
| Palette results for "loss.item", "train", "Timeline" | pass | Lines first with `loss_value = loss.item()` (Enter lands on the code row); Functions `train` + Files `train.py`; Sections `Timeline` first (Enter focuses `#timeline-h`); on huge.json the sliced index builds on open and 5 keystrokes render in < 250 ms |
| Reduced motion | pass | drawer/card animations are opacity-only ≤ 120 ms (the M14 jump flash is allowed) |
| WP1 skeleton checks still pass | pass | `tools/check.mjs` on ml-training, empty, blank, cpu-only, example: 40 loads, no console errors, no overflow |

Screenshots (looked at): `design/screens/wp5/` — cards (setup, working, result diff light/dark,
region, rate-limit error), drawer (1440 light/dark, 390 dark sheet, 1000×400, env prefill,
after edits), empty state (1440 light/dark, 390, 1000×400), palette (empty query, loss.item,
train at 1440 light/dark, 390, 1000×400), shortcuts (1440 light/dark, 390), loader error toast,
footer.

## 3. Deviations and notes

- Progress toast size uses binary units ("16.1 MiB"), per principle 3 (§4.15 writes "MB").
- Setup card title reads "Set up an AI provider to optimize line N" with `ready.message` below
  (§4.14.3 allows either text); it turns into "Ready to optimize line N" + one-click run once the
  drawer completes the setup.
- Region proposals are indented to the base indentation of the block they replace (line
  proposals keep `result.leadingSpaces`, as §4.14.3 says); upstream used the clicked line's
  indentation for both, which misaligns region code.
- Card anchor = `file:clickedLine` (for regions the clicked line, as upstream showed region
  results under the anchor line); headers name the real range ("lines 152–184").
- Network error copy for Ollama says "the Ollama server" instead of "Local (Ollama)".
- Bundle budget: see `design/requests/wp5.md` #1 (the combined tree is 922 KiB raw / 238 KiB gzip
  vs §6.1 900 / 200; WP5 = 92.5 KiB JS + 22 KiB CSS raw). Every other build check passes, and the
  strict type-check of the whole tree is clean.

## 4. Gaps

- Live LLM calls were not made (no credentials); all provider paths are verified with mocked
  `fetch` responses matching each API's documented shape.
- `requests/wp5.md` #2 (keep the report when `buildModel` throws) is a WP1 change.
