/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  ClayStore, InProcessAsyncStore, deriveInverse, type ForwardOpT,
} from "@clay/kernel";
import { attachmentSelectionError, RecordDetail } from "../src/app/RecordDetail";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 2_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

describe("connected work record detail", () => {
  it("rejects oversized files before reading browser bytes", () => {
    expect(attachmentSelectionError({
      name: "huge.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1,
    })).toMatch(/10 MB/);
    expect(attachmentSelectionError({
      name: "receipt.pdf", type: "application/pdf", size: 1024,
    })).toBeNull();
  });

  it("renders safe rich-note previews and verified local file metadata", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "projects", columns: [
      { name: "name", type: "text", required: true },
      { name: "notes", type: "rich_text", required: false },
      { name: "files", type: "attachment", required: false },
    ] }];
    store.commit({ intent: "rich project", summary: "Rich project.",
      migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
    const project = store.insert("projects", { name: "Apollo", notes: "**Verify** receipts" });
    await store.addAttachment({ table: "projects", rowId: String(project.id), field: "files",
      name: "receipt.pdf", mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) });
    const worker = {
      attachmentsForRecord: async (table: string, rowId: string, field: string) =>
        store.attachmentsForRecord(table, rowId, field),
      readAttachment: async (id: string) => store.readAttachment(id),
    } as unknown as WorkerClient;
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await act(async () => root.render(<RecordDetail
      table={store.registrySnapshot().get("projects")!}
      recordId={String(project.id)} tables={[...store.registrySnapshot().values()]}
      store={new InProcessAsyncStore(store)} worker={worker}
      onNavigate={() => undefined} onClose={() => undefined} onWrite={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />));
    await waitFor(() => document.body.textContent?.includes("receipt.pdf") ?? false);
    expect(document.body.textContent).toContain("4 B");
    const preview = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Preview")!;
    await act(async () => preview.click());
    expect(document.body.querySelector(".rich-note-preview strong")?.textContent).toBe("Verify");
    expect(document.body.querySelector(".rich-note-preview script")).toBeNull();
    await act(async () => root.unmount());
    store.close();
  });

  it("shows editable fields, linked chips, and incoming related records", async () => {
    const store = await ClayStore.openMemory();
    const first: ForwardOpT[] = [{ op: "create_table", table: "customers", columns: [
      { name: "name", type: "text", required: true },
      { name: "notes", type: "rich_text", required: false },
    ] }];
    store.commit({ intent: "customers", summary: "Customers.",
      migration: { operations: first, inverse: deriveInverse(first, store.registrySnapshot()) } });
    const second: ForwardOpT[] = [{ op: "create_table", table: "jobs", columns: [
      { name: "title", type: "text", required: true },
      { name: "customer", type: "relation", required: false,
        relation: { target_table: "customers", cardinality: "one",
          unique_targets: false, display_field: "name" } },
    ] }];
    store.commit({ intent: "jobs", summary: "Jobs.",
      migration: { operations: second, inverse: deriveInverse(second, store.registrySnapshot()) } });
    const customer = store.insert("customers", { name: "Acme", notes: "Priority account" });
    const job = store.insert("jobs", { title: "Install", customer: customer.id });
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const navigated: { table: string; id: string }[] = [];
    await act(async () => {
      root.render(<RecordDetail
        table={store.registrySnapshot().get("customers")!}
        recordId={String(customer.id)}
        tables={[...store.registrySnapshot().values()]}
        store={new InProcessAsyncStore(store)}
        onNavigate={(table, id) => navigated.push({ table, id })}
        onClose={() => undefined}
        onWrite={() => undefined}
        onError={message => { throw new Error(message); }}
        onInfo={() => undefined}
      />);
    });
    await waitFor(() => document.body.textContent?.includes("Install") ?? false);
    expect(document.body.textContent).toContain("Priority account");
    expect(document.body.textContent).toContain("Related records");
    expect(document.body.textContent).toContain("Install");
    const related = [...document.body.querySelectorAll<HTMLButtonElement>(".related-row")]
      .find(button => button.textContent?.includes("Install"))!;
    related.click();
    expect(navigated).toEqual([{ table: "jobs", id: job.id }]);
    await act(async () => root.unmount());
    store.close();
  });
});
