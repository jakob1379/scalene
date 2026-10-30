// "Back to train.py:173" (round 1 review, no-way-back-after-show-in): after a cross-view
// jump (Show in stacks / timeline) a small pill floats at the bottom centre of the viewport
// until it is used, dismissed (× or Esc while it has focus) or the profile changes. It returns
// to where the jump started: the selected code row, or the scroll position and focused control.
import { h } from "../../core/dom";
import { icon } from "../../core/icons";

export interface ReturnChip {
  show(label: string, onReturn: () => void): void;
  hide(): void;
  isShown(): boolean;
  destroy(): void;
}

export function createReturnChip(layerRoot: HTMLElement): ReturnChip {
  let el: HTMLElement | null = null;
  const hide = () => {
    el?.remove();
    el = null;
  };
  return {
    show(label, onReturn) {
      hide();
      const back = h(
        "button",
        { type: "button", class: "btn btn-secondary btn-compact return-chip-back", onClick: () => (hide(), onReturn()) },
        icon("arrow-left"),
        h("span", { class: "btn-label" }, "Back to ", h("span", { class: "return-chip-label" }, label)),
      );
      const close = h("button", { type: "button", class: "icon-btn return-chip-close", "aria-label": "Dismiss the way back", onClick: () => hide() }, icon("x"));
      el = h(
        "div",
        {
          class: "return-chip",
          role: "navigation",
          "aria-label": "Way back",
          onKeydown: (ev: KeyboardEvent) => {
            if (ev.key === "Escape") {
              ev.stopPropagation();
              hide();
            }
          },
        },
        back,
        close,
      );
      layerRoot.appendChild(el);
    },
    hide,
    isShown: () => el !== null,
    destroy: hide,
  };
}
