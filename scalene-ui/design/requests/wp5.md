# WP5 → integrator requests

> **Resolved by WP6** (`design/WP6-INTEGRATION.md` §1): #1 budget amended; #2 a profile that fails to build keeps the current report; #3 redundant `02-layout.css` rules removed; #4 no change needed.

Changes WP5 needs (or recommends) in files it does not own. WP5 works around each one locally;
none blocks WP5 acceptance.

| # | File (owner) | What | Why |
|---|---|---|---|
| 1 | `build.mjs` (WP1) / DESIGN.md §6.1 | The size budget fails once all packages land: sandbox build of the current tree = **922 KiB raw, 238 KiB gzip** vs ≤ 900 / ≤ 200. Amend §6.1 (e.g. ≤ 1,000 KiB raw / ≤ 260 KiB gzip) or add a minify step. | Measured per package from `dist/scalene-gui-bundle.js`: WP5 views 92.5 KiB raw / 24.9 KiB gz (+ CSS 70/80 = 22 KiB raw); overview 115.5/31.2, code 148.1/38.9, stacks 51.7/15.2, timeline 60.8/16.9, memory 22.7/6.8, core 77.0/23.1, model 112.2/31.6, ai port 64.3/15.8, all CSS 115.5/22.1. |
| 2 | `src/views/app.ts` (WP1) `load()` | When `buildModel()` throws, keep the current report instead of `teardown()` + `renderEmpty()`. | §4.15: "Errors: an error toast … The current report stays." The loader validates JSON and the `files` section before calling `shell.actions.load`, so this only matters for profiles that parse but fail to build; today they replace the open report with the empty state. |
| 3 | `src/styles/02-layout.css` (WP1) | `.empty-state { … gap: 16px; padding: 32px 24px }` and `.site-footer .footer-inner { display: flex … }` can be deleted. | WP5's `.empty-card` and footer grid override them in `80-shell.css` (same or higher specificity, later file). The `empty-state` class stays on the card because `tools/check.mjs` detects the empty state with it. |
| 4 | `src/views/app.ts` (WP1) | Optional: expose `ShellContext.actions.openAiSettings` to also accept a provider field name (WP5's `openSettings(focusField)` already accepts both element ids and field names such as `"apiKey"`). | No change needed; documented so WP3's lens/row actions can pass `ready().missing[0]` directly. |

Facade (§7.3) status: no change requested. `registerLegacyAiHandlers` is called by
`createAiController` with all six handlers (`toggleServiceFields`, `togglePassword`,
`toggleAdvanced`, `refreshOpenAIModels`, `refreshGeminiModels`, `checkApiKey`); they create the
drawer DOM on first use so the globals work before the drawer was ever opened. `loadFile`,
`loadDemo`, `loadFetch` go through `app.loader` (WP5 `mountLoader`). `proposeOptimizationLine` /
`Region` reach `AiController.request` unchanged.
