// Empty / demo state (DESIGN.md §4.16): shown for "", {}, a non-object, or a profile
// without files. One centered card: what this is, the two CLI steps (copyable), the file
// picker, the drop hint and, on the hosted demo, the demo profile. The copy says which case
// it is: nothing loaded ("" / not an object), a profile with no samples ({} — Scalene ran but
// sampled nothing), or a first load that could not be read. In short hosts (Jupyter, ≤ 520 px
// tall) the picker moves above the compact one-row steps so it is on the first screen.
import { h } from "../../core/dom";
import { icon, logoMark } from "../../core/icons";
import { bindTooltip } from "../../core/tooltip";
import type { ShellContext, ViewHandle } from "../app";

declare const example_profile: unknown;

/** Which empty state: nothing loaded, a profile without samples, or an unreadable first load. */
export type EmptyKind = "none" | "no-samples" | "error";

/** `{}` (and any object without files) means Scalene ran but collected no samples. */
export function emptyKind(value: unknown): EmptyKind {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? "no-samples" : "none";
}

/** Title and lede of each empty state (§4.16). */
export function emptyCopy(kind: EmptyKind, detail?: string): { title: string; lede: (string | { code: string })[] } {
  if (kind === "no-samples") {
    return {
      title: "Scalene collected no samples",
      lede: [
        "Your program may have finished before Scalene took a sample, or spent its time outside the profiled files. Try a longer run, or ",
        { code: "--profile-all" },
        ".",
      ],
    };
  }
  if (kind === "error") {
    return {
      title: "Couldn't read this profile",
      lede: [`${detail ? `${detail}. ` : ""}Choose a Scalene JSON profile, or create one with the steps below.`],
    };
  }
  return {
    title: "No profile loaded",
    lede: ["Open a Scalene JSON profile to see where your program spends time and memory. Scalene writes ", { code: "{}" }, " when it collected no samples."],
  };
}

const STEPS: readonly { title: string; command: string }[] = [
  { title: "Profile your program", command: "scalene --json --outfile profile.json your_program.py" },
  { title: "Open the report", command: "scalene view profile.json" },
];

async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  try {
    const ta = h("textarea", { class: "visually-hidden", "aria-hidden": "true" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function mountEmpty(host: HTMLElement, shell: ShellContext, opts: { kind?: EmptyKind; detail?: string } = {}): ViewHandle {
  const disposers: (() => void)[] = [];
  const timers: number[] = [];
  const copyText = emptyCopy(opts.kind ?? "none", opts.detail);

  const step = (n: number, s: (typeof STEPS)[number]) => {
    const label = h("span", { class: "btn-label" }, "Copy");
    const ico = h("span", { class: "empty-copy-icon" }, icon("copy"));
    const btn = h(
      "button",
      { type: "button", class: "btn btn-ghost btn-compact empty-copy", "aria-label": `Copy: ${s.command}` },
      ico,
      label,
    );
    btn.addEventListener("click", () => {
      void copy(s.command).then((ok) => {
        if (!ok) {
          shell.toast.show({ kind: "error", text: "Couldn't copy to the clipboard. Select the command and copy it instead." });
          return;
        }
        ico.replaceChildren(icon("check"));
        label.textContent = "Copied";
        shell.announce.polite("Command copied");
        timers.push(
          window.setTimeout(() => {
            ico.replaceChildren(icon("copy"));
            label.textContent = "Copy";
          }, 1200),
        );
      });
    });
    disposers.push(bindTooltip(shell.tooltip, btn, { title: "Copy the command" }));
    return h(
      "li",
      { class: "empty-step" },
      h("span", { class: "empty-step-no", "aria-hidden": "true" }, String(n)),
      h(
        "div",
        { class: "empty-step-text" },
        h("span", { class: "empty-step-title" }, s.title),
        h("code", { class: "empty-cmd" }, s.command),
      ),
      btn,
    );
  };

  const demo =
    typeof example_profile !== "undefined"
      ? h(
          "button",
          { type: "button", class: "btn btn-secondary", onClick: () => shell.actions.load(example_profile, { name: "demo profile" }) },
          icon("play"),
          h("span", { class: "btn-label" }, "Load the demo profile"),
        )
      : null;

  const steps = h("ol", { class: "empty-steps", "aria-label": "How to get a profile" }, STEPS.map((s, i) => step(i + 1, s)));
  const cta = h(
    "div",
    { class: "empty-cta" },
    h(
      "div",
      { class: "empty-actions" },
      h(
        "button",
        { type: "button", class: "btn btn-primary empty-choose", onClick: () => shell.actions.openFilePicker() },
        icon("upload"),
        h("span", { class: "btn-label" }, opts.kind === "error" ? "Choose another profile…" : "Choose a profile…"),
      ),
      demo,
    ),
    h("div", { class: "empty-drop", "aria-hidden": "true" }, icon("upload", 14), "or drop a .json file anywhere"),
  );
  const card = h(
    "section",
    { class: "card empty-state empty-card", "aria-labelledby": "empty-h", dataset: { kind: opts.kind ?? "none" } },
    h(
      "div",
      { class: "empty-head" },
      h("span", { class: "empty-mark", "aria-hidden": "true" }, logoMark(40)),
      h("h1", { id: "empty-h", class: "empty-title" }, copyText.title),
    ),
    h(
      "p",
      { class: "empty-lede" },
      copyText.lede.map((part) => (typeof part === "string" ? part : h("code", { class: "chip-code" }, part.code))),
    ),
    steps,
    cta,
  );
  host.appendChild(card);

  // Short hosts: the picker comes before the steps in the DOM too (reading and focus order
  // follow the visual order), so the primary action is on the first 400 px screen.
  const place = (short: boolean) => {
    if (short) steps.before(cta);
    else steps.after(cta);
  };
  place(shell.store.get().layout.short);
  disposers.push(shell.store.subscribe((st) => st.layout.short, place));

  return {
    destroy() {
      for (const t of timers) window.clearTimeout(t);
      for (const d of disposers.splice(0)) d();
      card.remove();
    },
  };
}
