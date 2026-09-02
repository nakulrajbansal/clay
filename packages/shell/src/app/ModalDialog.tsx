import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "button:not([disabled])", "[href]", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ModalDialog(props: {
  role?: "dialog" | "alertdialog";
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  className: string;
  backdropClassName: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".app")
      ?? document.querySelector<HTMLElement>("#root > *");
    const priorInert = app?.inert ?? false;
    const priorHidden = app?.getAttribute("aria-hidden") ?? null;
    if (app) { app.inert = true; app.setAttribute("aria-hidden", "true"); }
    const frame = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("[autofocus]")
        ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)
        ?? dialogRef.current;
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (app) {
        app.inert = priorInert;
        if (priorHidden === null) app.removeAttribute("aria-hidden");
        else app.setAttribute("aria-hidden", priorHidden);
      }
      const target = props.returnFocusRef?.current ?? previousFocus.current;
      target?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(item => !item.hasAttribute("disabled") && item.getClientRects().length > 0);
    if (items.length === 0) { event.preventDefault(); dialog.focus(); return; }
    const first = items[0]!;
    const last = items.at(-1)!;
    const active = document.activeElement;
    if (!(active instanceof Node) || !dialog.contains(active)) {
      event.preventDefault(); first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault(); first.focus();
    }
  };

  return createPortal(
    <div className={props.backdropClassName} onKeyDown={onKeyDown}
      onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section ref={dialogRef} className={props.className} role={props.role ?? "dialog"}
        aria-modal="true" aria-label={props.ariaLabel}
        aria-labelledby={props.ariaLabelledBy} aria-describedby={props.ariaDescribedBy}
        tabIndex={-1}>
        {props.children}
      </section>
    </div>,
    document.body,
  );
}
