/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { AsyncStore, Query, QueryRow, RegTable } from "@clay/kernel";
import { DataView } from "../src/app/DataView";
import { OPERATIONAL_VIEWS_KEY } from "../src/app/operational-views";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 2_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

describe("saved view restoration", () => {
  it("opens the exact persisted filter and field visibility from Today", async () => {
    const viewId = "view_018f4c2a7b3170018000000000000061";
    const tables = [{
      name: "tasks",
      columns: [
        { name: "title", type: "text", required: true },
        { name: "status", type: "enum", required: false, values: ["open", "done"] },
      ],
    }] as RegTable[];
    const rows: QueryRow[] = [{
      id: "018f4c2a-7b31-7001-8000-000000000062", title: "Still open", status: "open",
    }, {
      id: "018f4c2a-7b31-7001-8000-000000000063", title: "Already done", status: "done",
    }];
    const store = {
      query: async (query: Query) => query.includeDeleted ? [] : rows,
    } as AsyncStore;
    const library = {
      format: 1, revision: 4,
      views: [{
        id: viewId, name: "Completed work", table: "tasks", search: "",
        filters: [{ field: "status", op: "eq", value: "done" }],
        orderBy: [], visibleFields: ["title"],
        createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
      }],
    };
    const worker = {
      registryTables: async () => tables,
      semanticTrace: async () => null,
      getSetting: async (key: string) => key === OPERATIONAL_VIEWS_KEY ? library : null,
      sampleCount: async () => 0,
      operationBatches: async () => [],
      restorableRows: async () => [],
      recordFilter: async () => null,
    } as unknown as WorkerClient;
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<DataView
      worker={worker} store={store} initialSavedViewId={viewId}
      onWrite={() => undefined} onImport={() => undefined} onClose={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />));

    await waitFor(() => document.body.textContent?.includes("Already done") ?? false);
    expect(document.body.textContent).not.toContain("Still open");
    expect(document.body.querySelector('th[data-field="status"]')).toBeNull();
    expect(document.body.textContent).toContain("Completed work");

    await act(async () => root.unmount());
  });
});
