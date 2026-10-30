# WP2 Overview — requests to other owners / the integrator

> **Resolved by WP6** (`design/WP6-INTEGRATION.md` §1): R1 fixed in WP3's `revealIn` and guarded by `tools/e2e/overview.mjs` (no load-time scroll at 1440/390/1000×400); R2 lazy mounts start after the intro settles (`views/app.ts`); R3 budget amended in §6.1 (≤ 1,000 KiB raw / ≤ 260 KiB gzip).

## R1 (WP3, `src/views/code/filenav.ts:379`) — the page scrolls ~280 px on load

`syncTabs()` calls `.fn-tab.is-active.scrollIntoView({ block: "nearest", inline: "nearest" })` when the
code section mounts (idle / IntersectionObserver). At 1440×900 the tab strip is below the fold, so
`block: "nearest"` scrolls the **window** down by ~278 px and the first screen (headline, readouts,
§1.3.1) is no longer at the top on load. Reproduce: open `out/ml-training.html?still` at 1440×900, wait
800 ms, `scrollY === 278`.

Fix: scroll only the strip horizontally, never the page, e.g.
`strip.scrollLeft = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2` (or compute the
nearest-inline delta by hand). Same pattern at lines 295, 359 and 527 if those can run while the
section is off-screen.

WP2's acceptance screenshots reset `scrollTo(0, 0)` after load until this lands.

## R2 (WP1 / integrator, `src/views/app.ts` `scheduleLazyMounts`) — lazy sections mount during the intro

At 1440×900 the code section is inside the `IntersectionObserver` root margin (`100% 0px`) and mounts
in the same second as the overview, and `requestIdleCallback` mounts the others between intro frames.
Measured on ml-training (headless Chromium): long tasks of 99–189 ms between the overview's first frame
and +900 ms; on huge.json 109–300 ms. The overview's intro is now compositor-driven (transform/opacity
Web Animations, `views/overview/scope-intro.ts`), so the sweep, bars and reveals stay fluid, but the
main-thread parts (M2 count-ups, the axis time chip's text) still stall while a section mounts.

Suggested fix: when motion is on (`!motion.instant`), start `scheduleLazyMounts` after the overview
settles — `performance.mark("scalene:overview-settled")` is emitted by WP2 at origin + 900 ms; a
`setTimeout(…, 1000)` after mounting the overview is equivalent — unless a section is forced
(`jumpTo`, nav, palette, hash). Under `?still` / reduced motion keep today's behaviour.

## R3 (integrator, `build.mjs` §6.1 budget) — the full tree is over the bundle budget

With every package's current files the bundle is 925 KiB raw / ~238 KiB gzip, over the 900 / 200 KiB
checks (`build checks failed`). WP2's share: ~140 KiB of compiled JS (`views/overview/*`, scope.ts
69 KiB of it) + ~29 KiB of CSS source. Nothing here is generated or duplicated; the budget needs the
spec owner's decision (amend §6.1, or allow a minify step as WP1-STATUS D1 already proposed).
WP2's sandbox runs raise the limit locally only to keep testing; the repo's `build.mjs` is unchanged.
