// Toasts (DESIGN.md §4.18): bottom-right stack, max 3 visible, info/success auto-dismiss
// after 4 s (paused on hover/focus), errors persist until closed.
import { h } from "./dom";
import { icon, type IconName } from "./icons";

export interface ToastSpec {
  kind: "info" | "success" | "error";
  text: string;
  action?: { label: string; run(): void };
  sticky?: boolean;
}

export interface Toast {
  show(t: ToastSpec): () => void;
}

export interface ToastController extends Toast {
  destroy(): void;
}

const AUTO_DISMISS_MS = 4000;
const OUT_MS = 90;
const MAX_VISIBLE = 3;
const ICONS: Record<ToastSpec["kind"], IconName> = { info: "info", success: "check", error: "alert" };

export function createToasts(root: HTMLElement): ToastController {
  const stack = h("div", { class: "toast-stack" });
  root.appendChild(stack);

  const relayout = () => {
    const items = Array.from(stack.children) as HTMLElement[];
    items.forEach((el, i) => el.classList.toggle("is-collapsed", i < items.length - MAX_VISIBLE));
  };

  const show = (t: ToastSpec): (() => void) => {
    const isError = t.kind === "error";
    const sticky = t.sticky ?? isError;
    let timer = 0;
    let closed = false;

    const dismiss = () => {
      if (closed) return;
      closed = true;
      window.clearTimeout(timer);
      el.classList.remove("is-visible");
      window.setTimeout(() => {
        el.remove();
        relayout();
      }, OUT_MS);
    };
    const arm = () => {
      if (sticky || closed) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    };
    const pause = () => window.clearTimeout(timer);

    const actionBtn = t.action
      ? h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-compact toast-action",
            onClick: () => {
              t.action?.run();
              dismiss();
            },
          },
          t.action.label,
        )
      : null;
    const el = h(
      "div",
      {
        class: `toast toast-${t.kind}`,
        role: isError ? "alert" : "status",
        "aria-live": isError ? "assertive" : "polite",
        onPointerenter: pause,
        onPointerleave: arm,
        onFocusin: pause,
        onFocusout: arm,
      },
      h("span", { class: "toast-icon" }, icon(ICONS[t.kind])),
      h("span", { class: "toast-text" }, t.text),
      actionBtn,
      h(
        "button",
        { type: "button", class: "icon-btn icon-btn-sm toast-close", "aria-label": "Dismiss notification", onClick: dismiss },
        icon("x"),
      ),
    );
    stack.appendChild(el);
    relayout();
    requestAnimationFrame(() => el.classList.add("is-visible"));
    arm();
    return dismiss;
  };

  return {
    show,
    destroy() {
      stack.remove();
    },
  };
}
