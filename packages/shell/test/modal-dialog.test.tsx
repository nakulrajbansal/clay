/** @vitest-environment jsdom */
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ModalDialog } from "../src/app/ModalDialog";
import "../src/app/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  await act(async () => child.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  const parent = document.body.querySelector<HTMLElement>(".parent-dialog")!;
  expect(parent.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.textContent).not.toBe("Outside trigger");
  await act(async () => root.unmount());
});
