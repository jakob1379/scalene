# Round 1 fixes: code

Scope:
- Code: `src/views/code/*` (`codeview.ts`, `columns.ts`, `functions.ts`, `detail.ts`, `filenav.ts`,
  `codesection.ts`) and `src/styles/30-code.css`.
- Tests: `tests/unit/wp3-code.test.mjs` and `tools/e2e/code.mjs` (new `round1` block).
- Spec text: the code sections of `DESIGN.md`.

Hand-offs: `fix-code-handoff.md`. Screenshots after the fixes: `fix-code/`.

**Verification** (main tree, final state):
- `node build.mjs`: passes, 991.8 KiB, 259.95 KiB gz. The ten fixes cost +1.43 KiB gz in total:
  pre-fix code files (commit 208baef) with every other area's current changes give 258.52 KiB gz.
  Part of the cost is offset by sharing the header builder between the two tables and removing dead
  code. See hand-off 1 about the shared budget.
- `node tools/unit.mjs`: 390 passed, 0 failed, 1 skipped. The new unit tests cover:
  - the source-width budget at 1440, 1024, 1000×400 and 2560;
  - `sourceMin` for short hosts;
  - the fold wording on every fold of `train.py`;
  - the mode tooltips.
- `node tools/e2e/code.mjs`: **60/60**, including 12 new `round1` checks:
  - Enter on every header button, three times each, keeps focus on that button;
  - Enter and Space on a fold move focus to its first line, and ArrowDown stays in the table;
  - sorting the function view keeps focus;
  - every header is a Tab stop, and Footprint / Source show their definition on focus;
  - the file path is not a Tab stop when it fits, and the table is described by the file bar;
  - mode labels, the tab "peak" label and the fold wording;
  - at 1440, 1024, 1000×400 and 640×400 @2×: the source width minimum, the jumped-to row's
    actions never start left of its text, and only clipped lines fade;
  - the detail panel has no "When it ran" for line 152 (no CPU time) and has it for line 173.
- `tools/e2e/linking.mjs`: 70/70. One earlier run had a flaky `flame frame double-click`
  announcement; it passed in 3 reruns, and it also passes on the round-0 code files.
- `tools/e2e/shell-ai.mjs`: 187/187.
- `tools/check.mjs` (ml-training, huge, async-server, cpu-only, neuron; standalone; both themes; all
  widths): 80 page loads, no console errors, no overflow.
- `tools/check-tokens.mjs`: passes. I also fixed an older off-scale radius in `30-code.css`: the wash
  used `3px 0 0 3px`, now `var(--r-xs)`.

| id | result |
|---|---|
| code-sort-fold-focus-lost | **Fixed** (I reproduced it first: all 7 sortable headers and the fold sent focus to `<body>`).<br>• **Headers:** `renderHead()` records the focused column (`.cv-h[data-col]`) and, after `replaceChildren`, focuses the same column's control (`refocusHeader`, `preventScroll`). The function view does the same for its header and its focused row, and it also keeps the roving row on the same function after a re-sort.<br>• **Folds:** `unfold()` sets the roving key to the first revealed line before writing the store.<br>• **General guard:** `setItems()` and `redraw()` call `keepFocus()` whenever focus was in the table body and ends up on `<body>`. It focuses the roving row if it is rendered, otherwise the first visible focusable row, and it never scrolls. This covers re-rank, fold, lens close and AI-card rebuilds.<br>• **Tests:** e2e checks Enter on every header (×3) and Enter / Space on a fold, then ArrowDown. |
| fold-copy-says-without-samples | **Fixed.** Pure `foldText(file, start, end, total)` in `codeview.ts`:<br>• nothing sampled: "15 lines without samples · 1–15";<br>• otherwise: "32 lines below 1% each · 19–50 · together 0.2% of run";<br>• one line: "1 line below 1% · 95 · <0.1% of run";<br>• "at most 1%" when a folded line is exactly 1.0%.<br>The mode tooltips now state the real §4.0.4 predicate and name only the activities the profile records, e.g. "Only hot lines with more than 1% of run time, or any memory or GPU activity. The rest is folded." The DESIGN.md §4.8.2 template is updated. A unit test checks every fold of `train.py`: "without samples" appears exactly when no line in it has time or `cpu_samples_list` entries. |
| source-column-starved | **Fixed.** `sourceMin` is now 640 at lg+ and 420 at md/sm (400 in short hosts); it was 420 / 320 / 240. Alloc, Avg, Copy and GPU mem therefore move to the detail panel first. ml-training, before → after:<br>• 1440×900: source 502 → **662 px**, starting at x 849 → **689**; clipped rows 7/43 → 1/43; columns line…gpumem.<br>• 1024×768: 354 → **438 px**; 15/39 → 12/39.<br>• 1000×400: 302 → **470 px**; 12/28 → 7/28.<br>• 2560: still every column (Appendix A.1).<br>The covering-actions part is fixed with row-actions-cover-source-narrow below. |
| row-actions-cover-source-narrow | **Fixed.** `syncRowActions()` measures, once the row is mounted, whether the buttons (not the fade) would reach the end of the line's text (first visual row when wrapping).<br>• If they would: the row gets a compact icon-only group (✦ ⋯) instead.<br>• If that row's detail panel (lens or dock) is open: no group at all, because the panel carries the same actions.<br>• Rows rendered before mounting are measured in a rAF that runs before the next paint, so the full group never flashes over the code.<br>• The icon buttons have tooltips with their shortcut (o, Shift+O, Enter).<br>• e2e at 1440, 1024, 1000×400 and 640×400 @2×: the jumped-to row's buttons start right of its text. In a probe, hovering long line 74 shows only ⋯ (`fix-code/jump-*-L74-hover.png`).<br>Screenshots: `fix-code/jump-*.png`. |
| code-clip-hard-edge | **Fixed** (partly a misread). There already was a 20 px always-on fade, but it was barely visible, so the edge looked cut.<br>• The row now gets `is-clipped` from its column count. This is deterministic (no layout read): `textCols × charW > code box width`.<br>• Only clipped rows get the mask, now 28 px like the memory sites and with the `-webkit-` prefix. Lines that fit are never faded.<br>• The source tooltip with the full line uses the same predicate.<br>• e2e: on every rendered row, masked ⇔ clipped. |
| code-toolbar-functions-ambiguous | **Fixed.** The display modes are now **Hot + context \| Hot only \| All lines**, next to the **Lines \| Functions** view switch. The mode values, `#display-mode-file-N`, `expandAll()` and `collapseAll()` are unchanged. The tooltips are the precise predicates (see the fold row above). e2e checks the labels. |
| file-tabs-unlabeled-memory | **Fixed.** Tab, sheet and menu entries read "58.8%  peak 1.20 GiB" (the rail already had "peak"). The full sentence stays in the tooltip and the aria-label. e2e checks the label. |
| when-it-ran-misattributes | **Fixed.** `whenBlock()` returns null when the line has no `cpu_samples_list` entries and no CPU time. The "worker thread or native only" note now appears only when `total > 0`. e2e: line 152 in the 1920 dock shows Time, Memory, GPU, Call context; line 173 keeps "When it ran". |
| hover-only-tooltips-code | **Fixed.** Every column header is a Tab stop. Footprint and Source (and the function view's Footprint and Function) are focusable info headers (`bindHeaderInfo`):<br>• the definition shows on keyboard focus, on hover and on a tap or click (touch closes tooltips on pointerdown, so the tap re-opens it until blur);<br>• it is also the header's `aria-description`;<br>• focus ring with `-2px` offset.<br>e2e: focus on Footprint shows its definition. |
| code-path-empty-tab-stop | **Fixed.** `.code-path` has no tabindex, role or aria-label while it fits. While the directory is ellipsized, it becomes `tabindex=0 role="group" aria-label=<full path>`, so its tooltip shows the full path. This is re-checked on resize. The file-bar summary is visible text, and the table now has `aria-describedby="code-filebar"`. e2e checks it. |

No finding was skipped:
- **row-actions-cover-source-narrow** and the "actions cover the selected line" part of
  **source-column-starved** overlap. They are fixed once, in `syncRowActions`.
- **code-clip-hard-edge** was partly a misread: a 20 px fade existed. The fix makes it visible
  (28 px) and limits it to lines that are actually clipped.

What I chose: the actions are never moved to a second line or over the metric cells. A second line
would break the deterministic row heights (§4.8.10). Over the metric cells, they would hide the
selected row's values.
