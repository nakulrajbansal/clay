/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  ClayStore, InProcessAsyncStore, deriveInverse, type ForwardOpT,
} from "@clay/kernel";
import { RecordDetail } from "../src/app/RecordDetail";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runWrite = <T,>(operation: () => Promise<T>): Promise<T> => operation();

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 3_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

it("offers the one-record export boundary without writing the record", async () => {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "files", label: "Files", type: "attachment", required: false },
  ] }];
  store.commit({ intent: "tasks", summary: "Tasks.", migration: {
    operations, inverse: deriveInverse(operations, store.registrySnapshot()),
  } });
  const row = store.insert("tasks", { title: "Canonical record" });
  const worker = { attachmentsForRecord: async () => [] } as unknown as WorkerClient;
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  const beforeHistory = store.rowHistoryCount();
  let exports = 0;
  await act(async () => root.render(<RecordDetail
    table={store.registrySnapshot().get("tasks")!}
    recordId={String(row.id)} tables={[store.registrySnapshot().get("tasks")!]}
    store={new InProcessAsyncStore(store)} worker={worker}
    runWrite={runWrite} onNavigate={() => undefined} onClose={() => undefined} onWrite={() => undefined}
    onExport={() => { exports++; }}
    onError={message => { throw new Error(message); }} onInfo={() => undefined}
  />));
  await waitFor(() => document.body.textContent?.includes("Canonical record") ?? false);
  const button = document.body.querySelector<HTMLButtonElement>(
    'button[aria-label="Preview Print / CSV for this record"]',
  )!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(exports).toBe(1);
  expect(store.rowHistoryCount()).toBe(beforeHistory);
  expect(store.query({ from: "tasks" })[0]?.title).toBe("Canonical record");
  await act(async () => root.unmount());
  store.close();
});
