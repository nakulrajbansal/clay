import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";

// Native autofocus only participates in the browser's document autofocus cycle.
// Editors and confirmations mounted later need the same commit-time focus as
// the former renderer. Keep that behavior explicit and local to these controls.
function focusControl<K extends "input" | "select" | "button">(tag: K) {
  return forwardRef<HTMLElementTagNameMap[K], ComponentPropsWithoutRef<K>>((props, forwarded) => {
    const element = useRef<HTMLElementTagNameMap[K]>(null);
    useImperativeHandle(forwarded, () => element.current!);
    useLayoutEffect(() => { if (props.autoFocus) element.current?.focus(); }, []);
    return createElement(tag, { ...props, ref: element });
  });
}
export const FocusInput = focusControl("input");
export const FocusSelect = focusControl("select");
export const FocusButton = focusControl("button");
