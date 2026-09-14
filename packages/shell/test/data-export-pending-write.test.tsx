/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
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
  it("carries a delayed mutation barrier across unmount and reopen before export", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
      { name: "title", label: "Title", type: "text", required: true },
    ] }];
    store.commit({ intent: "tasks", summary: "Tasks.", migration: {
      operations, inverse: deriveInverse(operations, store.registrySnapshot()),
    } });
    store.insert("tasks", { title: "Before reopen" });
    const base = new InProcessAsyncStore(store);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
    const delayed = new Proxy(base, {
      get(target, property): unknown {
        if (property === "update") return async (
          ...args: Parameters<InProcessAsyncStore["update"]>
        ) => {
          markWriteStarted();
          await writeGate;
          return target.update(...args);
        };
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
    const view = <DataView
      worker={worker} store={delayed} initialTable="tasks"
      onWrite={() => undefined} onClose={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />;
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(view));
    await waitFor(() => document.body.textContent?.includes("Before reopen") ?? false);

    const cell = document.body.querySelector<HTMLElement>("td[data-grid-cell]")!;
    await act(async () => cell.click());
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="title"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "After reopen");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await writeStarted;

    await act(async () => root.render(null));
    await act(async () => root.render(view));
    await waitFor(() => document.body.textContent?.includes("Before reopen") ?? false);
    const preview = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for current Data view"]',
    )!;
    expect(preview.disabled).toBe(true);
    await act(async () => { preview.click(); await Promise.resolve(); });
    expect(projectExport).not.toHaveBeenCalled();

    releaseWrite();
    await waitFor(() => !document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for current Data view"]',
    )!.disabled);
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for current Data view"]',
    )!.click());
    await waitFor(() => document.body.querySelector(".export-dialog tbody") !== null);
    expect(projectExport).toHaveBeenCalledOnce();
    expect(document.body.querySelector(".export-dialog tbody")?.textContent).toContain("After reopen");

    await act(async () => root.unmount());
    store.close();
  });

  it("serializes rich-note saves across detail close and reopen", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "notes", columns: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "body", label: "Body", type: "rich_text", required: false },
    ] }];
    store.commit({ intent: "notes", summary: "Notes.", migration: {
      operations, inverse: deriveInverse(operations, store.registrySnapshot()),
    } });
    store.insert("notes", { title: "Plan", body: "A" });
    const base = new InProcessAsyncStore(store);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let markBothCompleted!: () => void;
    const bothCompleted = new Promise<void>(resolve => { markBothCompleted = resolve; });
    const updatePayloads: unknown[] = [];
    let activeUpdates = 0;
    let maxActiveUpdates = 0;
    let completedUpdates = 0;
    const delayed = new Proxy(base, {
      get(target, property): unknown {
        if (property === "update") return async (
          ...args: Parameters<InProcessAsyncStore["update"]>
        ) => {
          if (!Object.hasOwn(args[2], "body")) return target.update(...args);
          updatePayloads.push(args[2].body);
          activeUpdates++;
          maxActiveUpdates = Math.max(maxActiveUpdates, activeUpdates);
          if (updatePayloads.length === 1) {
            markFirstStarted();
            await firstGate;
          }
          try { return await target.update(...args); }
          finally {
            activeUpdates--;
            completedUpdates++;
            if (completedUpdates === 2) markBothCompleted();
          }
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as InProcessAsyncStore;
    const worker = {
      registryTables: async () => [...store.registrySnapshot().values()],
      semanticTrace: async () => store.semanticSchemaTrace(),
      getSetting: async () => null,
      sampleCount: async () => 0,
      operationBatches: async () => [],
      restorableRows: async () => [],
    } as unknown as WorkerClient;
    const errors: string[] = [];
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<DataView
      worker={worker} store={delayed} initialTable="notes"
      onWrite={() => undefined} onClose={() => undefined}
      onError={message => errors.push(message)} onInfo={() => undefined}
    />));
    await waitFor(() => document.body.textContent?.includes("Plan") ?? false);
    const openRecord = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>(
      'button[aria-label*="record details"]',
    )!;
    await act(async () => openRecord().click());
    await waitFor(() => document.body.querySelector(".rich-note-editor textarea") !== null);
    const textareaSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value",
    )!.set!;
    const firstEditor = document.body.querySelector<HTMLTextAreaElement>(
      ".rich-note-editor textarea",
    )!;
    await act(async () => {
      textareaSetter.call(firstEditor, "AB");
      firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      firstEditor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Close record details"]',
      )!.click();
    });
    await firstStarted;
    await waitFor(() => document.body.querySelector(".record-detail") === null);

    await act(async () => openRecord().click());
    await waitFor(() => document.body.querySelector(".rich-note-editor textarea") !== null);
    const reopenedEditor = document.body.querySelector<HTMLTextAreaElement>(
      ".rich-note-editor textarea",
    )!;
    const reopenedDraft = reopenedEditor.value;
    await act(async () => {
      textareaSetter.call(reopenedEditor, "AC");
      reopenedEditor.dispatchEvent(new Event("input", { bubbles: true }));
      reopenedEditor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const payloadsBeforeRelease = [...updatePayloads];

    await act(async () => {
      releaseFirst();
      await bothCompleted;
      await Promise.resolve();
    });
    const canonicalBody = store.query({ from: "notes" })[0]?.body;
    await act(async () => root.unmount());
    store.close();

    expect(reopenedDraft).toBe("AB");
    expect(payloadsBeforeRelease).toEqual(["AB"]);
    expect(updatePayloads).toEqual(["AB", "AC"]);
    expect(maxActiveUpdates).toBe(1);
    expect(canonicalBody).toBe("AC");
    expect(errors).toEqual([]);
  });

  it("holds record archive inside the export write barrier", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
      { name: "title", label: "Title", type: "text", required: true },
    ] }];
    store.commit({ intent: "tasks", summary: "Tasks.", migration: {
      operations, inverse: deriveInverse(operations, store.registrySnapshot()),
    } });
    store.insert("tasks", { title: "Archive me" });
    const base = new InProcessAsyncStore(store);
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
    let archiveStarted!: () => void;
    const started = new Promise<void>(resolve => { archiveStarted = resolve; });
    const delayed = new Proxy(base, {
      get(target, property): unknown {
        if (property === "softDelete") return async (
          ...args: Parameters<InProcessAsyncStore["softDelete"]>
        ) => {
          archiveStarted();
          await archiveGate;
          return target.softDelete(...args);
        };
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
      onWrite={() => undefined} onClose={() => undefined}
      onConfirm={async () => true}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />));
    await waitFor(() => document.body.textContent?.includes("Archive me") ?? false);
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      'button[aria-label*="record details"]',
    )!.click());
    await waitFor(() => document.body.querySelector(".record-detail") !== null);
    await waitFor(() => document.body.querySelector('button[aria-label="Preview Print / CSV for this record"]') !== null);
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>(".record-detail-actions button")]
        .find(button => button.textContent === "Archive")!.click();
      await started;
    });
    const preview = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for this record"]',
    )!;
    expect(preview.disabled).toBe(true);
    await act(async () => { preview.click(); await Promise.resolve(); });
    expect(projectExport).not.toHaveBeenCalled();
    releaseArchive();
    await waitFor(() => document.body.querySelector(".record-detail") === null);
    await act(async () => root.unmount());
    store.close();
  });

  it("blocks writes from export preparation through request capture", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
      { name: "title", label: "Title", type: "text", required: true },
    ] }];
    store.commit({ intent: "tasks", summary: "Tasks.", migration: {
      operations, inverse: deriveInverse(operations, store.registrySnapshot()),
    } });
    store.insert("tasks", { title: "Stable snapshot" });
    const base = new InProcessAsyncStore(store);
    let holdExportReload = false;
    let releaseExportReload!: () => void;
    const exportReloadGate = new Promise<void>(resolve => { releaseExportReload = resolve; });
    let markExportReloadStarted!: () => void;
    const exportReloadStarted = new Promise<void>(resolve => {
      markExportReloadStarted = resolve;
    });
    const softDelete = vi.fn((...args: Parameters<InProcessAsyncStore["softDelete"]>) =>
      base.softDelete(...args));
    const guardedStore = new Proxy(base, {
      get(target, property): unknown {
        if (property === "softDelete") return softDelete;
        if (property === "query") return async (
          ...args: Parameters<InProcessAsyncStore["query"]>
        ) => {
          if (holdExportReload && args[0].includeDeleted !== true) {
            holdExportReload = false;
            markExportReloadStarted();
            await exportReloadGate;
          }
          return target.query(...args);
        };
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
      worker={worker} store={guardedStore} initialTable="tasks"
      onWrite={() => undefined} onClose={() => undefined}
      onConfirm={async () => true}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />));
    await waitFor(() => document.body.textContent?.includes("Stable snapshot") ?? false);
    holdExportReload = true;
    act(() => {
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Preview Print / CSV for current Data view"]',
      )!.click();
    });
    await exportReloadStarted;
    expect(document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for current Data view"]',
    )!.disabled).toBe(true);
    const searchInput = document.body.querySelector<HTMLInputElement>('input[type="search"]')!;
    const searchSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      searchSetter.call(searchInput, "Stable");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const archive = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label^="Archive Stable snapshot"]',
    )!;
    await act(async () => { archive.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(softDelete).not.toHaveBeenCalled();
    releaseExportReload();
    await waitFor(() => projectExport.mock.calls.length === 1);
    expect(projectExport.mock.calls[0]?.[0]).toMatchObject({ view: { search: "Stable" } });
    expect(softDelete).not.toHaveBeenCalled();
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>(".export-dialog button")]
      .find(button => button.textContent === "Cancel")!;
    await act(async () => cancel.click());
    await waitFor(() => softDelete.mock.calls.length === 1);
    await act(async () => root.unmount());
    store.close();
  });

  it("abandons record export when navigation changes during preparation", async () => {
    const store = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
      { name: "title", label: "Title", type: "text", required: true },
    ] }];
    store.commit({ intent: "tasks", summary: "Tasks.", migration: {
      operations, inverse: deriveInverse(operations, store.registrySnapshot()),
    } });
    store.insert("tasks", { title: "Leave this record" });
    const base = new InProcessAsyncStore(store);
    let holdReload = false;
    let releaseReload!: () => void;
    const reloadGate = new Promise<void>(resolve => { releaseReload = resolve; });
    let markReloadStarted!: () => void;
    const reloadStarted = new Promise<void>(resolve => { markReloadStarted = resolve; });
    const delayed = new Proxy(base, {
      get(target, property): unknown {
        if (property === "query") return async (
          ...args: Parameters<InProcessAsyncStore["query"]>
        ) => {
          if (holdReload && args[0].includeDeleted !== true) {
            holdReload = false; markReloadStarted(); await reloadGate;
          }
          return target.query(...args);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as InProcessAsyncStore;
    const projectExport = vi.fn(async (request: ProjectionRequestV1) =>
      projectPlaintextV1(store, request));
    const worker = {
      registryTables: async () => [...store.registrySnapshot().values()],
      semanticTrace: async () => store.semanticSchemaTrace(),
      getSetting: async () => null, sampleCount: async () => 0,
      operationBatches: async () => [], restorableRows: async () => [], projectExport,
    } as unknown as WorkerClient;
    const errors: string[] = [];
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<DataView
      worker={worker} store={delayed} initialTable="tasks"
      onWrite={() => undefined} onClose={() => undefined}
      onError={message => errors.push(message)} onInfo={() => undefined}
    />));
    await waitFor(() => document.body.textContent?.includes("Leave this record") ?? false);
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      'button[aria-label*="record details"]',
    )!.click());
    await waitFor(() => document.body.querySelector('button[aria-label="Preview Print / CSV for this record"]') !== null);
    holdReload = true;
    act(() => document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Print / CSV for this record"]',
    )!.click());
    await reloadStarted;
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Close record details"]',
    )!.click());
    releaseReload();
    await waitFor(() => errors.includes("The record changed while export was preparing. Try again.")
      || projectExport.mock.calls.length > 0);
    expect(errors).toContain("The record changed while export was preparing. Try again.");
    expect(projectExport).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    store.close();
  });

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
      onWrite={() => undefined} onClose={() => undefined}
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
