/** @vitest-environment jsdom */
import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { act } from "preact/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import * as modalDialogModule from "../src/app/ModalDialog";
import "../src/app/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ModalDialog } = modalDialogModule;
const ModalScopedPortal = (modalDialogModule as typeof modalDialogModule & {
  ModalScopedPortal?: ComponentType<{ children: ReactNode }>;
}).ModalScopedPortal;

it.each([false, true])("restores the background after whole-tree removal (delayed child: %s)", async delayed => {
  const host = document.createElement("div"); host.id = "root";
  document.body.replaceChildren(host); document.body.style.overflow = "clip";
  const root = createRoot(host);
  function Probe({ show, child = true }: { show: boolean; child?: boolean }): React.JSX.Element {
    return <main className="app"><button>Underlying app</button>{show &&
      <ModalDialog className="parent-dialog" backdropClassName="modal-backdrop" ariaLabel="Parent" onClose={() => undefined}>
        {child && <ModalDialog className="child-dialog" backdropClassName="modal-backdrop" ariaLabel="Child" onClose={() => undefined}>
          <button>Inside</button>
        </ModalDialog>}
      </ModalDialog>}</main>;
  }
  try {
    await act(async () => root.render(<Probe show child={!delayed} />));
    if (delayed) await act(async () => root.render(<Probe show />));
    const app = host.querySelector<HTMLElement>(".app")!;
    expect(app.inert).toBe(true);
    await act(async () => root.render(<Probe show={false} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(app.inert).toBe(false); expect(app.hasAttribute("aria-hidden")).toBe(false);
    expect(document.body.style.overflow).toBe("clip");
  } finally { await act(async () => root.unmount()); document.body.style.overflow = ""; }
});

it("keeps modal feedback accessible inside the active focus trap", async () => {
  const appSource = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
  expect(appSource).toContain("<ModalScopedPortal>");
  expect(appSource).toContain("</ModalScopedPortal>");
  expect(ModalScopedPortal).toBeTypeOf("function");
  if (!ModalScopedPortal) return;

  let closes = 0;
  function Probe(): React.JSX.Element {
    return <div className="app">
      <button className="outside-action">Outside action</button>
      <ModalScopedPortal>
        <div className="toasts" data-modal-scoped-feedback
          aria-live="polite" aria-atomic="true">
          <div className="toast toast-danger" role="alert">
            Export failed
            <button className="toast-action"
              onKeyDown={event => event.stopPropagation()}>Try again</button>
          </div>
        </div>
      </ModalScopedPortal>
      <ModalDialog className="probe-dialog" backdropClassName="modal-backdrop"
        ariaLabel="Probe" onClose={() => { closes++; }}><button>Inside action</button></ModalDialog>
    </div>;
  }
  const host = document.createElement("div");
  host.id = "root";
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));

  const app = host.querySelector<HTMLElement>(".app")!;
  const dialog = document.body.querySelector<HTMLElement>(".probe-dialog")!;
  const alert = dialog.querySelector<HTMLElement>('.toast[role="alert"]')!;
  const action = alert.querySelector<HTMLButtonElement>(".toast-action")!;
  expect(app.inert).toBe(true);
  expect(app.getAttribute("aria-hidden")).toBe("true");
  expect(app.querySelector(".toast-action")).toBeNull();
  expect(alert.textContent).toContain("Export failed");
  expect(alert.closest('[aria-live="polite"]')).not.toBeNull();
  expect(dialog.contains(action)).toBe(true);

  action.focus();
  await act(async () => void action.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Tab", bubbles: true,
  })));
  expect(document.activeElement).toBe(dialog);
  expect(document.activeElement).not.toBe(app.querySelector(".outside-action"));

  action.focus();
  await act(async () => void action.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", bubbles: true,
  })));
  expect(closes).toBe(1);

  await act(async () => root.unmount());
});

it("exposes only the top modal layer to interaction and assistive technology", async () => {
  function Probe(): React.JSX.Element {
    const [child, setChild] = useState(false);
    return <ModalDialog className="parent-dialog" backdropClassName="modal-backdrop parent-backdrop"
      ariaLabel="Parent" onClose={() => undefined}>
      <button onClick={() => setChild(true)}>Open child</button>
      {child ? <ModalDialog className="child-dialog" backdropClassName="modal-backdrop child-backdrop"
        ariaLabel="Child" onClose={() => setChild(false)}><button>Child action</button></ModalDialog> : null}
    </ModalDialog>;
  }
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  const parent = document.body.querySelector<HTMLElement>(".parent-dialog")!;
  const parentBackdrop = document.body.querySelector<HTMLElement>(".parent-backdrop")!;
  expect(parent.getAttribute("aria-modal")).toBe("true");

  await act(async () => document.body.querySelector<HTMLButtonElement>(".parent-dialog button")!.click());
  const child = document.body.querySelector<HTMLElement>(".child-dialog")!;
  const childBackdrop = document.body.querySelector<HTMLElement>(".child-backdrop")!;
  expect(parent.hasAttribute("aria-modal")).toBe(false);
  expect(parentBackdrop.inert).toBe(true);
  expect(parentBackdrop.getAttribute("aria-hidden")).toBe("true");
  expect(child.getAttribute("aria-modal")).toBe("true");
  expect(childBackdrop.inert).toBe(false);

  await act(async () => root.unmount());
  expect(document.body.querySelector(".modal-backdrop")).toBeNull();
});

it("restores an explicit trigger inside the newly exposed parent", async () => {
  function Probe(): React.JSX.Element {
    const [child, setChild] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    return <ModalDialog className="parent-dialog" backdropClassName="modal-backdrop parent-backdrop"
      ariaLabel="Parent" onClose={() => undefined}>
      <button>First parent action</button>
      <button ref={trigger} onClick={() => setChild(true)}>Export trigger</button>
      {child ? <ModalDialog className="child-dialog" backdropClassName="modal-backdrop child-backdrop"
        ariaLabel="Child" onClose={() => setChild(false)} returnFocusRef={trigger}>
        <button>Child action</button>
      </ModalDialog> : null}
    </ModalDialog>;
  }
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  const trigger = [...document.body.querySelectorAll<HTMLButtonElement>(".parent-dialog button")]
    .find(button => button.textContent === "Export trigger")!;
  await act(async () => trigger.click());
  const child = document.body.querySelector<HTMLElement>(".child-dialog")!;
  await act(async () => void child.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(trigger);
  await act(async () => root.unmount());
});

it("returns focus to the newly exposed parent instead of an outside trigger", async () => {
  function Probe(): React.JSX.Element {
    const [child, setChild] = useState(false);
    const outside = useRef<HTMLButtonElement>(null);
    return <>
      <button ref={outside}>Outside trigger</button>
      <ModalDialog className="parent-dialog" backdropClassName="modal-backdrop parent-backdrop"
        ariaLabel="Parent" onClose={() => undefined}>
        <button onClick={() => setChild(true)}>Open child</button>
        {child ? <ModalDialog className="child-dialog" backdropClassName="modal-backdrop child-backdrop"
          ariaLabel="Child" onClose={() => setChild(false)} returnFocusRef={outside}>
          <button>Child action</button>
        </ModalDialog> : null}
      </ModalDialog>
    </>;
  }
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  await act(async () => document.body.querySelector<HTMLButtonElement>(".parent-dialog button")!.click());
  const child = document.body.querySelector<HTMLElement>(".child-dialog")!;
  await act(async () => void child.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  const parent = document.body.querySelector<HTMLElement>(".parent-dialog")!;
  expect(parent.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.textContent).not.toBe("Outside trigger");
  await act(async () => root.unmount());
});
