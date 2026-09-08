/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  ClayStore, InProcessAsyncStore, deriveInverse, type ForwardOpT,
} from "@clay/kernel";
import { projectPlaintextV1, type ProjectionRequestV1 } from "@clay/kernel/projection";
import { DataView } from "../src/app/DataView";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 3_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

describe("Data export pending-write barrier", () => {
  it("waits for inline and record-detail commits before projection", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
      { name: "title", label: "Title", type: "text", required: true },
    ] }];
    store.commit({ intent: "tasks", summary: "Tasks.", migration: {
      operations, inverse: deriveInverse(operations, store.registrySnapshot()),
    } });
    store.insert("tasks", { title: "Before" });
    const base = new InProcessAsyncStore(store);
    let release!: () => void;
    let gate = Promise.resolve();
    const holdWrite = (): void => {
      gate = new Promise<void>(resolve => { release = resolve; });
    };
    const delayed = new Proxy(base, {
      get(target, property): unknown {
        if (property === "update") return async (
          ...args: Parameters<InProcessAsyncStore["update"]>
        ) => { await gate; return target.update(...args); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as InProcessAsyncStore;
    const projectExport = vi.fn(async (request: ProjectionRequestV1) =>
      projectPlaintextV1(store, request));
    const worker = {
      registryTables: async () => [...store.registrySnapshot().values()],
      semanticTrace: async () => store.semanticSchemaTrace(),
      getSetting: async () => null,
      sampleCount: async () => 0,
      operationBatches: async () => [],
      restorableRows: async () => [],
      projectExport,
    } as unknown as WorkerClient;
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<DataView
      worker={worker} store={delayed} initialTable="tasks"
      onImport={() => undefined} onWrite={() => undefined} onClose={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />));
    await waitFor(() => document.body.textContent?.includes("Before") ?? false);

    const cell = document.body.querySelector<HTMLElement>("td[data-grid-cell]")!;
    holdWrite();
    await act(async () => cell.click());
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="title"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "After");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const preview = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for current Data view"]',
    )!;
    await act(async () => { input.blur(); preview.click(); await Promise.resolve(); });
    expect(projectExport).not.toHaveBeenCalled();

    release();
    await waitFor(() => document.body.querySelector(".export-dialog tbody") !== null);
    expect(projectExport).toHaveBeenCalledOnce();
    expect(document.body.querySelector(".export-dialog tbody")?.textContent).toContain("After");
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>(".export-dialog button")]
      .find(button => button.textContent === "Cancel")!;
    await act(async () => cancel.click());
    await waitFor(() => document.body.querySelector(".export-dialog") === null);
    const openRecord = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label*="record details"]',
    )!;
    await act(async () => openRecord.click());
    await waitFor(() => document.body.querySelector("#record-title") !== null);
    const recordInput = document.body.querySelector<HTMLInputElement>("#record-title")!;
    holdWrite();
    await act(async () => {
      setter.call(recordInput, "Record after");
      recordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const recordExport = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for this record"]',
    )!;
    await act(async () => {
      recordInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      recordExport.click();
      await Promise.resolve();
    });
    expect(projectExport).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => projectExport.mock.calls.length === 2);
    await waitFor(() => document.body.querySelector(".export-dialog tbody") !== null);
    expect(document.body.querySelector(".export-dialog tbody")?.textContent)
      .toContain("Record after");
    await act(async () => root.unmount());
    store.close();
  });
});
