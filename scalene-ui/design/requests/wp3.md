# WP3 (Code) → integrator / WP1 requests

> **Resolved by WP6** (`design/WP6-INTEGRATION.md` §1): §1 the app bar is opaque without backdrop blur at `xxl`; §2 budget amended in §6.1; §3 no `AbortError` reaches the page (checked by every e2e suite and the matrix).

## 1. App bar backdrop blur costs scroll frames at 2560 px (10-appbar.css:9–10)

**What:** drop `backdrop-filter: blur(12px) saturate(140%)` on `.appbar` (use the opaque `--page`
background it already falls back to), or keep it only below `xxl` (`@media (max-width: 2199.98px)`).

**Why:** the code view's 60 fps acceptance (§4.8.10, scroll on huge `sparse.py` in All lines).
Measured in headless Chromium at 2560×1440, 300 frames of 24 px scroll, frames over 20 ms
(`design/screens/wp3/perf-layers.cjs`, two rounds): **base 34 / 16**, **without the app-bar blur 1 / 1**.
Every other code-view layer (source masks, washes, meters, sparklines, ribbon, tab fade) is
within run-to-run noise. At 1440 the blur is affordable (p95 16.7 ms). The code file bar
already uses an opaque `--surface` for the same reason (comment in `30-code.css`).

## 2. Bundle budget (build.mjs size check)

Not a change request, a heads-up: with WP2–WP5 in progress the bundle is already over the
200 KiB gzip budget in a full build (238.6 KiB gzip, 923 KiB raw on the full tree at 06:55; the raw 900 KiB budget is exceeded too). WP3's share is
~150 KiB raw / ~44 KiB gzip (`views/code`, comments already stripped by `removeComments`), plus ~25 KiB of CSS. A size pass (WP6) will need every package; WP3 can trim on request.

## 3. Unhandled `AbortError` on page load (WP5, in progress)

`views/ai/controller.ts` aborts in-flight requests on load/destroy (lines ~271/288 in the
working copy); a page load surfaced `pageerror: AbortError: The user aborted a request.` in
the WP3 entry-point checks. The rejection should be caught (§4.14.5: `aborted` → silent).
