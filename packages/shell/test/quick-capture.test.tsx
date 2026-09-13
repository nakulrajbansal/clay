/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AsyncStore, BatchReceipt, RegTable } from "@clay/kernel";
import {
  CommandPalette,
  QUICK_CAPTURE_LAST_TABLE_SETTING,
} from "../src/app/CommandPalette";
import { createWorkerMutationContext, type WorkerClient } from "../src/app/worker-client";
import { beginPresentationIntent, readPresentationIntent } from "../src/app/presentation-intent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => sessionStorage.clear()); // Owned jsdom storage only.
const appInstanceId = `app_${"a".repeat(26)}`;

async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input value setter unavailable");
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

describe("quick capture", () => {
  it("unlocks a retained draft only after exact terminal cancellation, never when a commit won", async () => {
    const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
    const intent = beginPresentationIntent(sessionStorage, appInstanceId, "capture", "daily.capture",
      { appInstanceId, table: "tasks", tableId, row: { title: "Original" } }, createWorkerMutationContext);
    const tables = [{ name: "tasks", semantic: { tableId }, columns: [{ name: "title", type: "text", required: true }] }] as unknown as RegTable[];
    const calls: unknown[][] = []; let outcome = "recorded";
    const worker = { createMutationContext: createWorkerMutationContext, globalSearch: async () => [], getSetting: async () => tableId,
      cancelPresentation: async (...args: unknown[]) => { calls.push(args); return { status: outcome }; } } as unknown as WorkerClient;
    const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<CommandPalette worker={worker} appInstanceId={appInstanceId} tables={tables} captureMode
        onClose={() => {}} onOpenRecord={() => {}} onOpenData={() => {}} onWrite={() => {}} onError={() => {}} onInfo={() => {}} />));
      await settle();
      const click = async () => act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent === "Cancel pending capture and edit")!.click(); });
      await click();
      expect(readPresentationIntent(sessionStorage, appInstanceId, "capture")).toEqual(intent);
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.disabled).toBe(true);
      outcome = "cancelled"; await click();
      expect(readPresentationIntent(sessionStorage, appInstanceId, "capture")).toBeNull();
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.disabled).toBe(false);
      expect(calls).toEqual([[intent.route, intent.payload, { requestId: intent.requestId }], [intent.route, intent.payload, { requestId: intent.requestId }]]);
    } finally { await act(async () => root.unmount()); }
  });
  it("retries the original payload and identity after a lost response, even across midnight", async () => {
    const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
    const tables = [{ name: "tasks", semantic: { tableId }, columns: [
      { name: "due", type: "date", required: true },
    ] }] as unknown as RegTable[];
    const calls: unknown[][] = [];
    let resolutions = 0;
    const worker = {
      createMutationContext: createWorkerMutationContext, globalSearch: async () => [], getSetting: async () => tableId,
      mutationOutcome: async () => ({ status: "not_invoked" }),
      resolveDailyHomeDate: async () => ++resolutions === 1 ? "2026-09-13" : "2026-09-14",
      quickCapture: async (...args: unknown[]) => {
        calls.push(structuredClone(args));
        if (calls.length === 1) throw new Error("response lost after commit");
        return { id: "018f4c2a-7b31-7001-8000-000000000091", created: [{ table: "tasks", id: "row" }] };
      },
    } as unknown as WorkerClient;
    const host = document.createElement("div"); document.body.replaceChildren(host);
    let root = createRoot(host);
    const render = () => root.render(<CommandPalette worker={worker} appInstanceId={appInstanceId} store={{} as AsyncStore}
      tables={tables} captureMode onClose={() => {}} onOpenRecord={() => {}} onOpenData={() => {}}
      onWrite={() => {}} onError={() => {}} onInfo={() => {}} />);
    try {
      await act(async () => render());
      await settle();
      await act(async () => typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Due"]')!, "tomorrow"));
      const submit = async () => {
        await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
        await settle();
      };
      await submit(); await act(async () => root.unmount()); root = createRoot(host);
      await act(async () => render()); await settle(); await submit();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      expect(resolutions).toBe(1);
    } finally { await act(async () => root.unmount()); }
  });
  it("opens the last record type and inserts through the authority-backed Store port", async () => {
    const taskTableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
    const tables = [{
      name: "tasks",
      semantic: { tableId: taskTableId },
      columns: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "due_on", label: "Due", type: "date", required: false },
      ],
    }, {
      name: "contacts",
      semantic: { tableId: "tbl_018f4c2a-7b31-7001-8000-000000000002" },
      columns: [{ name: "name", type: "text", required: true }],
    }] as unknown as RegTable[];
    const captures: Array<{ table: string; row: Record<string, unknown>; tableId: string }> = [];
    const undone: string[] = [];
    const receipt: BatchReceipt = {
      id: "018f4c2a-7b31-7001-8000-000000000091",
      at: "2026-09-06T12:00:00.000Z",
      source: "user",
      summary: "Quick capture in tasks",
      changed: 1,
      created: [{ table: "tasks", id: "018f4c2a-7b31-7001-8000-000000000011" }],
      undone: false,
    };
    const worker = {
      createMutationContext: createWorkerMutationContext,
      mutationOutcome: async () => ({ status: "not_invoked" }),
      globalSearch: async () => [],
      getSetting: async (key: string) => key === QUICK_CAPTURE_LAST_TABLE_SETTING ? taskTableId : null,
      resolveDailyHomeDate: async (value: string) => value === "tomorrow" ? "2026-09-07" : value,
      quickCapture: async (table: string, row: Record<string, unknown>, tableId: string) => {
        captures.push({ table, row, tableId });
        return receipt;
      },
      undoQuickCapture: async (batchId: string) => {
        undone.push(batchId);
        return { ...receipt, undone: true };
      },
    } as unknown as WorkerClient;
    let directInsertCalled = false;
    const store = {
      insert: async () => { directInsertCalled = true; throw new Error("must not insert directly"); },
    } as unknown as AsyncStore;
    const opened: Array<{ table: string; id: string }> = [];
    const writes: string[] = [];
    let undoAction: { label: string; run: () => void } | undefined;
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);

    await act(async () => root.render(<CommandPalette
      worker={worker}
      appInstanceId={appInstanceId}
      store={store}
      tables={tables}
      captureMode
      onClose={() => undefined}
      onOpenRecord={(table, id) => opened.push({ table, id })}
      onOpenData={() => undefined}
      onWrite={table => writes.push(table)}
      onError={message => { throw new Error(message); }}
      onInfo={(_message, action) => { undoAction = action; }}
    />));
    await settle();

    expect(document.body.textContent).toContain("New Tasks");
    const title = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    const due = document.querySelector<HTMLInputElement>('input[aria-label="Due"]')!;
    await act(async () => {
      typeInto(title, "Send quote");
      typeInto(due, "tomorrow");
    });
    const form = document.querySelector<HTMLFormElement>("form.command-create")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await settle();

    expect(directInsertCalled).toBe(false);
    expect(captures).toEqual([{
      table: "tasks",
      tableId: taskTableId,
      row: { title: "Send quote", due_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    }]);
    expect(opened).toEqual([{ table: "tasks", id: receipt.created[0]!.id }]);
    expect(writes).toEqual(["tasks"]);
    expect(undoAction?.label).toBe("Undo");
    await act(async () => { undoAction?.run(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(undone).toEqual([receipt.id]);
    expect(writes).toEqual(["tasks", "tasks"]);

    await act(async () => root.unmount());
  });
});
