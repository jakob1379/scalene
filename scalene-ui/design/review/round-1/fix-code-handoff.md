# Round 1: code fixer hand-offs to other owners

The code fixes are only in `src/views/code/*` and `src/styles/30-code.css`, plus their tests
(`tests/unit/wp3-code.test.mjs`, `tools/e2e/code.mjs`) and the spec text in `DESIGN.md`.
The items below need a change in another area. None of them blocks the code fixes.

## shell-ai-core (build.mjs, core/*, views/shell/*, views/app.ts)

1. **Bundle gzip budget: the headroom is now about 0.05 KiB** (259.95 of 260 KiB gz, 991.8 KiB raw).
   I measured the current tree with every area's changes:
   - with the pre-fix code files (commit `208baef`): 258.52 KiB gz;
   - with the round-1 code files: 259.95 KiB gz.

   So the ten code fixes cost +1.43 KiB gz (+4.2 KiB raw). This is net of the savings: one
   `headerCell()` shared by the line and function tables, a smaller `buildActs()`, and removing dead
   code (the `.cv-val` CSS, an unused re-export, an `|| true` branch).

   Note: checkpoint commit `e1d4a1b` captured a mid-work snapshot of the code files. Compare against
   `208baef`, not `HEAD`.

   Any more growth will break the build. Please plan a build-level saving or a new budget.
2. **The virtual list drops focus when the user scrolls the focused row away** (`core/virtual.ts`).
   `update()` recycles every row outside the overscan, including the one that has
   `document.activeElement`. After a wheel scroll, focus is then on `<body>` and the next Tab
   starts from the top.
   - What the code view does now: it keeps focus across its own rebuilds. After `setItems()` and
     `refresh()`, `keepFocus()` moves focus back to the roving row.
   - What it cannot do: catch recycling that a scroll causes.
   - Suggested fix: skip the element that contains `document.activeElement` when recycling, or
     re-mount it off-screen.
3. **Palette wording** (`views/shell/palette.ts:91`): the command says "Hot lines only". The toolbar
   modes are now **Hot + context | Hot only | All lines**. For consistency, consider "Show hot lines
   only (Hot only)" or "Hot only". The mode values (`profiled-functions`, `profiled-lines`, `all`)
   and the globals `expandAll()` / `collapseAll()` are unchanged.
4. **Shortcuts dialog** (optional): the finding `hover-only-tooltips-code` also suggested listing the
   column definitions in the `?` dialog. The headers are now Tab stops with `aria-description`, so
   this is no longer required. The texts are in `COLUMN_SPECS[key].help` (`views/code/columns.ts`)
   if you want them there.
5. Overview hand-off 3 (`showHiddenFiles` on `CodeApi`) is still open. `CodeApi` is declared in
   `views/app.ts`. The code section's `__code.showHidden()` hook is unchanged and is ready to back
   that API.

## Everyone

6. **DESIGN.md**: I edited only the code sections, to match the fixes:
   - §4.7: the tab entry reads "peak 1.20 GiB";
   - §4.8.1: toolbar mode names and tooltips; the file bar path's focus rule;
   - §4.8.2: fold wording;
   - §4.8.3: source minimum widths and focusable headers;
   - §4.8.4: the clipped-line fade;
   - §4.8.5: mode names; a fold moves focus to its first line;
   - §4.8.7: compact or hidden row actions;
   - §4.9: "When it ran" is left out when the line has no CPU time.
7. The code e2e suite has 12 new `round1` checks (`node tools/e2e/code.mjs --only round1`).
   - They call `window.vsNavigate(escape(path), line)` to jump. Keep that global working outside
     VS Code.
   - They read `[role="tooltip"]` to check the header definition on focus.
