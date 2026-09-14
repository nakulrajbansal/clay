/** @vitest-environment jsdom */
import { useState } from "react";
import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PrivateMetricsSummary } from "@clay/kernel";
import { PrivateMetricsView } from "../src/app/PrivateMetricsView";
import { ShapeMapView } from "../src/app/ShapeMapView";
import { ImportWizard } from "../src/app/ImportWizard";
import type { WorkerClient } from "../src/app/worker-client";

const rate = { numerator: 0, denominator: 0, value: null };
const summary: PrivateMetricsSummary = {
  schemaVersion: 1, scope: "current_app", windowDays: 30, collectionEnabled: true,
  activation: { activated: false, firstKeepElapsed: null, proofLoopComplete: false,
    proofLoopElapsed: null, d14Strict: "not_eligible", d14Window: "not_eligible", situationalLensUses: 0 },
  reshape: { started: 0, previewRate: rate, firstPassPreviewRate: rate, keepRate: rate,
    repairSaveRate: rate, discardByDiff: [] },
  trust: { previewsShown: 0, receiptsOpened: 0, shapeMapOpened: 0, historyOpened: 0,
    rewindAttempted: 0, rewindSucceeded: 0, rewindSuccessRate: rate, exportsSucceeded: 0 },
  recovery: { faultsSeen: 0, completed: 0, succeeded: 0, successRate: rate, byMethod: [] },
};
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); document.body.style.overflow = "";
});
async function open(surface: "metrics" | "shape" | "import") {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  const host = document.createElement("div"); host.id = "root"; document.body.append(host);
  document.body.style.overflow = "clip";
  function Probe() {
    const [show, setShow] = useState(false);
    const close = () => setShow(false);
    return <main className="app"><button onClick={() => setShow(true)}>Open surface</button>
      <button id="destination">Destination</button>
      {show && (surface === "metrics" ? <PrivateMetricsView summary={summary} persistent
        onClose={close} onToggle={async () => true} onCopy={async () => true} onClear={async () => true} />
        : surface === "shape" ? <ShapeMapView tables={[]} panels={[]} history={[]} persistent
          onClose={close} onOpenData={() => undefined} onAskAbout={() => undefined}
          onOpenHistory={() => document.getElementById("destination")!.focus()} />
        : <ImportWizard appInstanceId="app_fixture" targetTable="Tasks" worker={{} as WorkerClient}
          onClose={close} onCommitted={() => undefined} onError={() => undefined} />)}
    </main>;
  }
  root = createRoot(host); await act(async () => root!.render(<Probe />));
  const trigger = host.querySelector("button")!; trigger.focus();
  await act(async () => trigger.click());
  await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
  return { trigger, app: host.querySelector<HTMLElement>(".app")!, dialog: document.querySelector<HTMLElement>('[role="dialog"]')! };
}
for (const surface of ["metrics", "shape", "import"] as const) it(`${surface}: one native modal trap, scroll lock, Escape and trigger restoration`, async () => {
  const { app, dialog, trigger } = await open(surface);
  expect(dialog).not.toBeNull(); expect(app.contains(dialog)).toBe(false);
  expect(app.inert).toBe(true); expect(app.getAttribute("aria-hidden")).toBe("true");
  expect(document.body.style.overflow).toBe("hidden");
  const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea, [href]')];
  expect(document.activeElement).toBe(controls[0]);
  controls.at(-1)!.focus();
  await act(async () => { controls.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); });
  expect(document.activeElement).toBe(controls[0]);
  await act(async () => { controls[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect(app.inert).toBe(false); expect(app.hasAttribute("aria-hidden")).toBe(false);
  expect(document.body.style.overflow).toBe("clip");
});
it("metrics confirmation owns its first Escape, leaving the outer dialog open", async () => {
  const { dialog } = await open("metrics");
  const clear = [...dialog.querySelectorAll("button")].find(b => b.textContent === "Clear private metrics…")!;
  await act(async () => clear.click());
  const group = dialog.querySelector('[role="group"]')!;
  await act(async () => { group.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.body.contains(dialog)).toBe(true); expect(dialog.querySelector('[role="group"]')).toBeNull();
  expect(document.activeElement).toBe(clear);
});
it("Shape map navigation hands focus to the destination instead of its old trigger", async () => {
  const { dialog } = await open("shape");
  await act(async () => [...dialog.querySelectorAll("button")].find(b => b.textContent === "Open the full timeline")!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.getElementById("destination"));
});
