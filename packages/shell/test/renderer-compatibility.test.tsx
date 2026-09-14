/** @vitest-environment jsdom */
import { act, createRef, lazy, Suspense, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ModalDialog, ModalScopedPortal } from "../src/app/ModalDialog";
import { LazySurfaceBoundary } from "../src/app/LazySurfaceBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.restoreAllMocks(); document.body.replaceChildren(); });
async function mount(element: React.ReactNode) {
  const host = document.createElement("div"); host.id = "root"; document.body.append(host);
  root = createRoot(host); await act(async () => root.render(element)); return host;
}
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("preserves controlled input, checkbox, select, blur/focusout and native propagation", async () => {
  const events: string[] = [];
  function Controls() {
    const [value, setValue] = useState("before"), [checked, setChecked] = useState(false), [choice, setChoice] = useState("a");
    return <form onSubmit={event => event.preventDefault()} onBlur={() => events.push("blur")}>
      <input aria-label="Name" value={value} onChange={event => setValue(event.currentTarget.value)} />
      <input aria-label="Selected" type="checkbox" checked={checked} onChange={event => setChecked(event.currentTarget.checked)} />
      <select aria-label="Choice" value={choice} onChange={event => setChoice(event.currentTarget.value)}>
        <option value="a">A</option><option value="b">B</option>
      </select><output>{`${value}:${checked}:${choice}`}</output>
    </form>;
  }
  const host = await mount(<Controls />);
  host.addEventListener("input", () => events.push("native-capture"), true);
  host.addEventListener("input", () => events.push("native-bubble"));
  await act(async () => type(host.querySelector("input")!, "after"));
  await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
  const select = host.querySelector("select")!;
  await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => host.querySelector("input")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(host.querySelector("output")!.textContent).toBe("after:true:b");
  expect(events).toEqual(["native-capture", "native-bubble", "native-capture", "native-bubble", "blur"]);
});

it("attaches refs before layout effects, reads external stores, and cleans subscriptions and iframes", async () => {
  let snapshot = 0; const listeners = new Set<() => void>(); const phases: string[] = [];
  const frame = createRef<HTMLIFrameElement>();
  function Probe() {
    const local = useRef<HTMLSpanElement>(null);
    const value = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => snapshot);
    useLayoutEffect(() => { phases.push(local.current?.textContent ?? "missing"); return () => { phases.push("cleanup"); }; }, []);
    return <><span ref={local}>{value}</span><iframe ref={frame} title="Owned panel" sandbox="allow-scripts" /></>;
  }
  const host = await mount(<Probe />);
  expect(phases).toEqual(["0"]); expect(frame.current?.isConnected).toBe(true);
  expect(frame.current?.getAttribute("sandbox")).toBe("allow-scripts");
  await act(async () => { snapshot = 1; for (const listener of listeners) listener(); });
  expect(host.querySelector("span")!.textContent).toBe("1");
  await act(async () => root.unmount());
  expect(listeners.size).toBe(0); expect(frame.current).toBeNull(); expect(phases).toEqual(["0", "cleanup"]);
});

it("resolves lazy/Suspense and contains a rejected surface without discarding its recovery action", async () => {
  let resolve!: (value: { default: () => React.JSX.Element }) => void;
  const View = lazy(() => new Promise<{ default: () => React.JSX.Element }>(done => { resolve = done; }));
  const host = await mount(<LazySurfaceBoundary label="owned view"><Suspense fallback={<p role="status">Loading view</p>}><View /></Suspense></LazySurfaceBoundary>);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Loading view");
  await act(async () => resolve({ default: () => <button>Loaded view</button> }));
  expect(host.querySelector("button")?.textContent).toBe("Loaded view");
  function Broken(): React.JSX.Element { throw new Error("owned fixture failure"); }
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(async () => root.render(<LazySurfaceBoundary key="failed" label="owned view"><Broken /></LazySurfaceBoundary>));
  expect(host.querySelector('[role="alert"]')?.getAttribute("aria-label")).toBe("owned view failed to load");
  expect(host.querySelector("button")?.textContent).toBe("Reload Clay");
});

it("retains drag/drop payload, preventDefault, and explicit native capture across a portal", async () => {
  const events: string[] = []; const dataTransfer = { getData: () => "owned-panel" };
  const portal = document.createElement("div"); document.body.append(portal);
  portal.addEventListener("drop", () => events.push("capture"), true);
  await mount(createPortal(<div onDragOver={event => event.preventDefault()}
    onDrop={event => { events.push(event.dataTransfer.getData("text/plain")); event.stopPropagation(); }}>Drop panel</div>, portal));
  const target = portal.firstElementChild!;
  const over = new Event("dragover", { bubbles: true, cancelable: true }); target.dispatchEvent(over);
  expect(over.defaultPrevented).toBe(true);
  const drop = new Event("drop", { bubbles: true }); Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
  await act(async () => target.dispatchEvent(drop)); expect(events).toEqual(["capture", "owned-panel"]);
});

it("keeps explicit inline cancellation ahead of dialog dismissal, without escaping the Tab trap", async () => {
  let cancellations = 0, closes = 0;
  await mount(<ModalDialog ariaLabel="Editor" className="owned-editor" backdropClassName="owned-backdrop"
    onClose={() => { closes++; }}><input aria-label="Draft" data-modal-escape-owner="true" onKeyDown={event => {
      if (event.key === "Escape") { cancellations++; event.preventDefault(); event.stopPropagation(); }
    }} /></ModalDialog>);
  const input = document.querySelector("input")!; input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(cancellations).toBe(1); expect(closes).toBe(0);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(document.querySelector(".owned-editor"));
});

it("keeps a failed modal non-dismissible with the same focus, inert and scroll-lock recovery contract", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  function Broken(): React.JSX.Element { throw new Error("owned lazy modal failure"); }
  function Probe() {
    const [open, setOpen] = useState(false);
    return <div className="app"><button onClick={() => setOpen(true)}>Open failed surface</button>
      {open && <LazySurfaceBoundary label="tools" modal><Broken /></LazySurfaceBoundary>}
    </div>;
  }
  const host = await mount(<Probe />); const trigger = host.querySelector("button")!; trigger.focus();
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe("tools failed to load");
  expect(document.body.style.overflow).toBe("hidden");
  expect(host.querySelector<HTMLElement>(".app")?.inert).toBe(true);
  await act(async () => dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => dialog!.parentElement!.click());
  expect(document.querySelector('[role="alertdialog"]')).toBe(dialog);
  expect(dialog?.querySelector("button")?.textContent).toBe("Reload Clay");
  await act(async () => root.render(<div className="app"><button>Recovered</button></div>));
  expect(document.body.style.overflow).toBe("");
  expect(host.querySelector<HTMLElement>(".app")?.getAttribute("aria-hidden")).toBeNull();
});

it("traps nested portals, Escape and native-stopped events, locks the background, and restores triggers", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
  function Probe() {
    const [open, setOpen] = useState(false), [child, setChild] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null), nested = useRef<HTMLButtonElement>(null);
    return <div className="app"><button ref={trigger} onClick={() => setOpen(true)}>Open tools</button>
      <ModalScopedPortal><button data-modal-scoped-feedback onKeyDown={event => event.stopPropagation()}>Feedback</button></ModalScopedPortal>
      {open && <ModalDialog ariaLabel="Tools" className="owned-parent" backdropClassName="owned-backdrop"
        onClose={() => setOpen(false)} returnFocusRef={trigger}>
        <button ref={nested} onClick={() => setChild(true)}>Open child</button><button>Last action</button>
        {child && <ModalDialog ariaLabel="Child tools" className="owned-child" backdropClassName="owned-child-backdrop"
          onClose={() => setChild(false)} returnFocusRef={nested}><button onKeyDown={event => event.stopPropagation()}>Child action</button></ModalDialog>}
      </ModalDialog>}
    </div>;
  }
  const host = await mount(<Probe />); const trigger = host.querySelector("button")!; trigger.focus();
  await act(async () => trigger.click());
  const app = host.querySelector<HTMLElement>(".app")!;
  expect(app.inert).toBe(true); expect(app.getAttribute("aria-hidden")).toBe("true"); expect(document.body.style.overflow).toBe("hidden");
  const parent = document.querySelector<HTMLElement>(".owned-parent")!;
  const feedback = parent.querySelector<HTMLButtonElement>("[data-modal-scoped-feedback]")!;
  feedback.focus();
  await act(async () => feedback.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement?.textContent).toBe("Open child");
  await act(async () => parent.querySelector<HTMLButtonElement>("button")!.click());
  expect(parent.parentElement!.inert).toBe(true); expect(parent.parentElement!.getAttribute("aria-hidden")).toBe("true");
  const child = document.querySelector<HTMLElement>(".owned-child")!;
  await act(async () => child.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement?.textContent).toBe("Open child"); expect(parent.parentElement!.inert).toBe(false);
  // Moving a portal between destinations may remount its DOM; use the live control.
  await act(async () => parent.querySelector("[data-modal-scoped-feedback]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector(".owned-parent")).toBeNull(); expect(app.inert).toBe(false);
  expect(app.hasAttribute("aria-hidden")).toBe(false); expect(document.body.style.overflow).toBe(""); expect(document.activeElement).toBe(trigger);
});
