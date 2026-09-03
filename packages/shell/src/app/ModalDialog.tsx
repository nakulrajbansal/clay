import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "button:not([disabled]):not([tabindex='-1'])", "[href]:not([tabindex='-1'])",
  "input:not([disabled]):not([tabindex='-1'])", "select:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled]):not([tabindex='-1'])", "[tabindex]:not([tabindex='-1'])",
].join(",");

let modalScrollLocks = 0;
let priorBodyOverflow = "";

type ModalLayer = { backdrop: HTMLDivElement; dialog: HTMLElement };
const modalLayers: ModalLayer[] = [];

function syncModalLayers(): void {
  const top = modalLayers.at(-1);
  modalLayers.forEach((layer, index) => {
    const active = layer === top;
    layer.backdrop.inert = !active;
    layer.backdrop.style.zIndex = String(100 + index);
    if (active) {
      layer.backdrop.removeAttribute("aria-hidden");
      layer.dialog.setAttribute("aria-modal", "true");
    } else {
      layer.backdrop.setAttribute("aria-hidden", "true");
      layer.dialog.removeAttribute("aria-modal");
    }
  });
}

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
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    const layer = backdrop && dialog ? { backdrop, dialog } : null;
    if (layer) { modalLayers.push(layer); syncModalLayers(); }
    if (modalScrollLocks++ === 0) {
      priorBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const app = document.querySelector<HTMLElement>(".app")
      ?? document.querySelector<HTMLElement>("#root > *");
    const priorInert = app?.inert ?? false;
    const priorHidden = app?.getAttribute("aria-hidden") ?? null;
    if (app) { app.inert = true; app.setAttribute("aria-hidden", "true"); }
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog?.contains(document.activeElement)) return;
      const items = dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter(item => !item.hasAttribute("disabled") && item.getClientRects().length > 0) : [];
      const target = items.find(item => item.hasAttribute("autofocus"))
        ?? items[0] ?? dialog;
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (layer) {
        const index = modalLayers.indexOf(layer);
        if (index >= 0) modalLayers.splice(index, 1);
        syncModalLayers();
      }
      modalScrollLocks = Math.max(0, modalScrollLocks - 1);
      if (modalScrollLocks === 0) document.body.style.overflow = priorBodyOverflow;
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
    const top = modalLayers.at(-1);
    if (top && top.dialog !== dialogRef.current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
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
    <div ref={backdropRef} className={props.backdropClassName} onKeyDown={onKeyDown}
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
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
