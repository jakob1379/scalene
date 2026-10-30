// Footer and meta (DESIGN.md §4.17): static, never covers content. Version and date come
// from the template's #scalene-footer data-version / data-date. In the empty state only the
// version line remains.
import { h } from "../../core/dom";
import { icon } from "../../core/icons";
import type { ShellContext, ShellViewHandle } from "../app";

const REPO = "https://github.com/plasma-umass/scalene";
export const UNITS_NOTE = "Times are shares of sampled time × wall clock. Memory uses binary units (1 MiB = 2²⁰ bytes).";

export function mountFooter(el: HTMLElement, shell: ShellContext): ShellViewHandle {
  const motionSwitch = h(
    "button",
    { type: "button", role: "switch", class: "switch footer-motion", "aria-checked": "false" },
    h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-thumb" })),
    h("span", { class: "switch-label" }, "Reduce motion"),
  );
  motionSwitch.addEventListener("click", () => shell.actions.setReducedMotion(!shell.motion.reduced));
  const syncMotion = () => motionSwitch.setAttribute("aria-checked", String(shell.motion.reduced));
  const offMotion = shell.bus.on("motion:changed", syncMotion);

  const link = (href: string, text: string) => h("a", { class: "footer-link", href, target: "_blank", rel: "noopener" }, text);

  const render = () => {
    const empty = shell.model() === null;
    const { version, date } = shell.meta;
    const versionLine = h(
      "span",
      { class: "footer-version" },
      h("a", { class: "footer-brand", href: REPO, target: "_blank", rel: "noopener" }, "Scalene"),
      version ? ` ${version}` : "",
      date ? `, ${date}` : "",
    );
    syncMotion();
    el.replaceChildren(
      h(
        "div",
        { class: "footer-inner" },
        h(
          "div",
          { class: "footer-row" },
          versionLine,
          empty ? null : link(`${REPO}/issues/new/choose`, "Report an issue or request a feature"),
          empty ? null : link(`${REPO}/issues/58`, "Share your success story"),
          empty ? null : h("span", { class: "footer-spacer" }),
          empty
            ? null
            : h(
                "button",
                { type: "button", class: "footer-action", onClick: () => shell.actions.openFilePicker() },
                icon("upload", 14),
                "Load another profile",
              ),
          empty ? null : motionSwitch,
          empty
            ? null
            : h(
                "button",
                { type: "button", class: "footer-action", "aria-keyshortcuts": "?", onClick: () => shell.actions.openShortcuts() },
                "Keyboard shortcuts",
                h("kbd", { class: "key-chip" }, "?"),
              ),
        ),
        empty ? null : h("p", { class: "footer-note" }, UNITS_NOTE),
      ),
    );
  };
  render();
  return {
    update: render,
    destroy() {
      offMotion();
      el.replaceChildren();
    },
  };
}
