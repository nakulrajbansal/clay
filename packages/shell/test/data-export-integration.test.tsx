/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  ClayStore, InProcessAsyncStore, deriveInverse, type ForwardOpT,
} from "@clay/kernel";
import {
  decodeProjectionArtifactV1, projectPlaintextV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
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

describe("Data view local projection integration", () => {
  it("previews the exact filtered, sorted, visible view instead of all loaded rows", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "status", label: "Status", type: "enum", required: false,
        values: ["open", "done"] },
    ] }];
    store.commit({ intent: "tasks", summary: "Tasks.", migration: {
      operations, inverse: deriveInverse(operations, store.registrySnapshot()),
    } });
    store.insert("tasks", { title: "Alpha", status: "done" });
    store.insert("tasks", { title: "Beta", status: "open" });
    store.insert("tasks", { title: "Zed", status: "open" });
    const requested: ProjectionRequestV1[] = [];
    const projectExport = vi.fn(async (request: ProjectionRequestV1) => {
      requested.push(request);
      return projectPlaintextV1(store, request);
    });
    const worker = {
      registryTables: async () => [...store.registrySnapshot().values()],
      semanticTrace: async () => store.semanticSchemaTrace(),
      getSetting: async () => null,
      sampleCount: async () => 0,
      operationBatches: async () => [],
      restorableRows: async () => [],
      projectExport,
    } as unknown as WorkerClient;
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<DataView
      worker={worker} store={new InProcessAsyncStore(store)} initialTable="tasks"
      onWrite={() => undefined} onClose={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />));
    await waitFor(() => document.body.textContent?.includes("Zed") ?? false);

    const filter = document.body.querySelector<HTMLSelectElement>('select[aria-label="Filter records"]')!;
    await act(async () => {
      filter.value = "status\u0000open";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const sort = document.body.querySelector<HTMLButtonElement>('button[aria-label="Sort by Title"]')!;
    await act(async () => { sort.click(); sort.click(); });
    const statusChoice = [...document.body.querySelectorAll<HTMLLabelElement>(".field-picker label")]
      .find(label => label.textContent?.trim() === "Status")!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => statusChoice.click());

    const visibleScreen = [...document.body.querySelectorAll<HTMLTableRowElement>(
      ".dataview-grid tbody tr:not(.dataview-new):not(.dataview-hist)",
    )].map(row => row.querySelector<HTMLElement>('td[data-grid-column="0"]')?.textContent?.trim());
    expect(visibleScreen).toEqual(["Zed", "Beta"]);

    const preview = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for current Data view"]',
    )!;
    expect(preview).not.toBeNull();
    expect([...document.body.querySelectorAll("button")]
      .some(button => button.textContent === "⬇ CSV")).toBe(false);
    await act(async () => preview.click());
    await waitFor(() => document.body.querySelector(".export-dialog tbody") !== null);

    expect(projectExport).toHaveBeenCalledTimes(1);
    expect(requested[0]).toMatchObject({
      kind: "current_view",
      view: {
        filter: { op: "eq", value: "open" },
        sort: { dir: "desc" },
      },
    });
    expect(requested[0]?.fieldIds).toHaveLength(1);
    const projection = decodeProjectionArtifactV1(projectPlaintextV1(store, requested[0]!));
    expect(projection.manifest.fields.map(field => field.label)).toEqual(["Title"]);
    expect(projection.rows).toEqual([["Zed"], ["Beta"]]);
    const previewRows = [...document.body.querySelectorAll(".export-dialog tbody tr")]
      .map(row => row.querySelector(".projection-cell-value")?.textContent);
    expect(previewRows).toEqual(["Zed", "Beta"]);

    const closeExport = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Close export preview"]',
    )!;
    await act(async () => closeExport.click());
    const share = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Create read-only share for current Data view"]',
    )!;
    expect(share).not.toBeNull();
    await act(async () => share.click());
    await waitFor(() => document.body.querySelector(".share-dialog tbody") !== null);
    expect(projectExport).toHaveBeenCalledTimes(2);
    expect(document.body.querySelectorAll(".share-dialog input[data-field-id]")).toHaveLength(1);
    const sharedRows = [...document.body.querySelectorAll(".share-dialog tbody tr")]
      .map(row => row.textContent?.trim());
    expect(sharedRows).toEqual(["Zed", "Beta"]);
    expect(document.body.textContent).not.toContain("Canonical hidden value");

    await act(async () => root.unmount());
    store.close();
  });
});
