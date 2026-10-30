// Keyboard shortcuts dialog (DESIGN.md §6.2.3, `?`): the keyboard map, grouped by scope.
// Scopes whose section is absent drop out. A real modal: inert background, Tab stays
// inside, Esc / × / Close return focus to the opener.
import type { ModalHandle } from "../../core/a11y";
import { modKeyLabel } from "../../core/controls";
import { h, uid } from "../../core/dom";
import { icon } from "../../core/icons";
import type { SectionId } from "../../core/store";
import type { OverlayApi, ShellContext } from "../app";

export interface ShortcutGroup {
  title: string;
  /** Section that must be present for this group to show (null = always). */
  section: SectionId | null;
  rows: readonly [keys: string[][], what: string][];
}

/** §6.2.3, verbatim scopes. Each key list is alternatives; each inner list is one chord. */
export function shortcutGroups(mod: string): ShortcutGroup[] {
  return [
    {
      title: "Global",
      section: null,
      rows: [
        [[["/"], [mod]], "Search lines, functions, files and commands"],
        [[["?"]], "Show this list"],
        [[["Esc"]], "Close the topmost layer, then clear the selection"],
      ],
    },
    {
      title: "Hotspots",
      section: "overview",
      rows: [
        [[["↑"], ["↓"], ["j"], ["k"]], "Move between hotspots"],
        [[["Home"], ["End"]], "First / last hotspot"],
        [[["Enter"]], "Open the line"],
        [[["f"]], "Show in stacks"],
      ],
    },
    {
      title: "Signal",
      section: "overview",
      rows: [
        [[["←"], ["→"]], "Move the cursor (Shift: ×10)"],
        [[["Home"], ["End"]], "Start / end of the run"],
        [[["Shift", "←"], ["Shift", "→"]], "Select a range"],
        [[["Enter"]], "Open the line under the cursor"],
        [[["Esc"]], "Clear the cursor and range"],
      ],
    },
    {
      title: "Code table",
      section: "code",
      rows: [
        [[["↑"], ["↓"], ["j"], ["k"]], "Move between rows"],
        [[["PgUp"], ["PgDn"], ["Home"], ["End"]], "Page / first / last row"],
        [[["Enter"], ["Space"]], "Toggle details"],
        [[["e"]], "Open in editor"],
        [[["o"]], "Optimize the line with AI"],
        [[["Shift", "O"]], "Optimize the region with AI"],
        [[["s"]], "Show in stacks"],
        [[["t"]], "Show in timeline"],
      ],
    },
    {
      title: "Minimap",
      section: "code",
      rows: [
        [[["↑"], ["↓"]], "Step through hot lines"],
        [[["PgUp"], ["PgDn"], ["Home"], ["End"]], "Jump through the file"],
        [[["Enter"]], "Open the line"],
      ],
    },
    {
      title: "Flame graph",
      section: "stacks",
      rows: [
        [[["↑"]], "Parent frame"],
        [[["↓"]], "Heaviest child"],
        [[["←"], ["→"]], "Sibling frames"],
        [[["Enter"]], "Zoom into the frame"],
        [[["Esc"]], "Zoom out"],
        [[["g"]], "Go to source"],
        [[["Home"]], "Back to the root"],
        [[["/"]], "Search frames"],
      ],
    },
    {
      title: "Timeline",
      section: "timeline",
      rows: [
        [[["↑"], ["↓"]], "Rows"],
        [[["←"], ["→"]], "Segments"],
        [[["W"], ["S"], ["+"], ["−"]], "Zoom in / out"],
        [[["A"], ["D"], ["Alt", "←"], ["Alt", "→"]], "Pan"],
        [[["0"]], "Reset the zoom"],
        [[["Enter"]], "Go to source"],
        [[["Shift", "Enter"]], "Zoom to the segment"],
      ],
    },
    {
      title: "Dialogs",
      section: null,
      rows: [
        [[["Tab"]], "Cycle inside the dialog"],
        [[["Esc"]], "Close and return focus"],
      ],
    },
  ];
}

export function createShortcuts(shell: ShellContext): OverlayApi {
  let layer: HTMLElement | null = null;
  let modal: ModalHandle | null = null;
  let open = false;

  const presentSections = (): Set<string> =>
    new Set(["overview", "code", "stacks", "timeline", "memory"].filter((id) => document.getElementById(id)?.classList.contains("report-section")));

  const keyRow = (alts: string[][]) =>
    h(
      "span",
      { class: "sc-keys" },
      alts.map((chord, i) => [
        i > 0 ? h("span", { class: "sc-or" }, chord.length > 1 || alts[i - 1].length > 1 ? "or" : "/") : null,
        h(
          "span",
          { class: "sc-chord" },
          chord.map((k, j) => [j > 0 ? h("span", { class: "sc-plus", "aria-hidden": "true" }, "+") : null, h("kbd", { class: "key-chip" }, k)]),
        ),
      ]),
    );

  const build = (): HTMLElement => {
    const titleId = uid("sc-title");
    const mod = modKeyLabel("K");
    const present = presentSections();
    const groups = shortcutGroups(mod).filter((g) => g.section === null || present.has(g.section));
    const closeBtn = h("button", { type: "button", class: "icon-btn sc-close", "aria-label": "Close keyboard shortcuts", onClick: () => close() }, icon("x"));
    const dialog = h(
      "div",
      { class: "sc", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
      h(
        "header",
        { class: "sc-head" },
        h("h2", { id: titleId, class: "sc-title" }, "Keyboard shortcuts"),
        h("span", { class: "sc-sub" }, "Everything a pointer can do, the keyboard can too."),
        closeBtn,
      ),
      h(
        "div",
        { class: "sc-body", tabindex: "0", role: "region", "aria-label": "Shortcut list" },
        groups.map((g) =>
          h(
            "section",
            { class: "sc-group" },
            h("h3", { class: "sc-group-title micro" }, g.title),
            h(
              "dl",
              { class: "sc-list" },
              g.rows.map(([keys, what]) => h("div", { class: "kbd-row" }, h("dt", null, keyRow(keys)), h("dd", null, what))),
            ),
          ),
        ),
      ),
      h("footer", { class: "sc-foot" }, h("button", { type: "button", class: "btn btn-primary btn-compact", onClick: () => close() }, "Close")),
    );
    return h("div", { class: "sc-layer" }, h("div", { class: "sc-scrim", "aria-hidden": "true", onClick: () => close() }), dialog);
  };

  function show(): void {
    if (open) return;
    open = true;
    // Rebuilt per open: the scopes follow the sections of the current profile.
    layer?.remove();
    layer = build();
    shell.layerRoot.appendChild(layer);
    shell.tooltip.hide();
    shell.store.update((s) => ({ layers: { ...s.layers, shortcuts: true } }));
    const dialog = layer.querySelector(".sc") as HTMLElement;
    modal = shell.modals.open(dialog, { onEscape: () => close(), initialFocus: dialog.querySelector<HTMLElement>(".sc-close") });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "?" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        close();
      }
    };
    dialog.addEventListener("keydown", onKey);
  }

  function close(): void {
    if (!open) return;
    open = false;
    modal?.close();
    modal = null;
    layer?.remove();
    layer = null;
    shell.store.update((s) => ({ layers: { ...s.layers, shortcuts: false } }));
  }

  return {
    open: show,
    close,
    isOpen: () => open,
    destroy() {
      close();
    },
  };
}
