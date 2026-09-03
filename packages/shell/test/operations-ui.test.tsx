/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  ClayStore, InProcessAsyncStore, deriveInverse,
  type AutomationDefinition, type AutomationDefinitionInput, type AsyncStore,
  type BatchMutation, type ForwardOpT, type Query, type QueryRow, type RegTable,
} from "@clay/kernel";
import { AutomationCenter } from "../src/app/AutomationCenter";
import { CommandPalette } from "../src/app/CommandPalette";
import { DataView, loadAllTableRows, reconcileVisibleFieldNames } from "../src/app/DataView";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 2_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input value setter unavailable");
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function taskStore(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", type: "text", required: true },
    { name: "status", type: "enum", required: false, values: ["open", "done"] },
  ] }];
  store.commit({ intent: "tasks", summary: "Tasks.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  return store;
}

async function mount(node: React.ReactNode): Promise<{
  container: HTMLDivElement; unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, unmount: async () => { await act(async () => root.unmount()); } };
}

describe("Daily Workbench UI", () => {
  it("keeps user visibility choices while surfacing replacement fields", () => {
    expect([...reconcileVisibleFieldNames(
      new Set(["title", "customer"]),
      ["title", "customer", "status"],
      ["title", "status", "customer_link"],
    )]).toEqual(["title", "customer_link"]);
  });

  it("activates the same first item that the palette renders", async () => {
    let openedData = 0;
    const worker = { globalSearch: async () => [{
      table: "tasks", id: "018f0000-0000-7000-8000-000000000001",
      label: "Call Acme", secondary: "open", matchedFields: ["title"], score: 80,
      updatedAt: "2026-09-02T12:00:00.000Z",
    }] } as unknown as WorkerClient;
    const { unmount } = await mount(<CommandPalette worker={worker} tables={[]}
      onClose={() => undefined} onOpenRecord={() => undefined}
      onOpenData={() => { openedData++; }} onWrite={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined} />);
    await waitFor(() => document.body.textContent?.includes("Call Acme") ?? false);
    await act(async () => document.body.querySelector<HTMLInputElement>(".command-search-row input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(openedData).toBe(1);
    await unmount();
  });

  it("opens a global result directly from keyboard-ready search", async () => {
    const opened: Array<{ table: string; id: string }> = [];
    const worker = {
      globalSearch: async () => [{
        table: "tasks", id: "018f0000-0000-7000-8000-000000000001",
        label: "Call Acme", secondary: "open", matchedFields: ["title"],
        score: 80, updatedAt: "2026-09-02T12:00:00.000Z",
      }],
    } as unknown as WorkerClient;
    const { container, unmount } = await mount(<CommandPalette
      worker={worker} tables={[]} onClose={() => undefined}
      onOpenRecord={(table, id) => opened.push({ table, id })}
      onOpenData={() => undefined} onWrite={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />);
    await waitFor(() => document.body.textContent?.includes("Call Acme") ?? false);
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".command-results > button")]
      .find(button => button.textContent?.includes("Call Acme"))!.click());
    expect(opened).toEqual([{
      table: "tasks", id: "018f0000-0000-7000-8000-000000000001",
    }]);
    await unmount();
  });

  it("makes the first matching record the keyboard action for a nonempty search", async () => {
    const opened: Array<{ table: string; id: string }> = [];
    const table = { name: "tasks", columns: [{ name: "title", type: "text", required: true }] };
    const worker = { globalSearch: async (query: string) => query ? [{
      table: "tasks", id: "018f0000-0000-7000-8000-000000000001",
      label: "Alice task", secondary: "open", matchedFields: ["title"], score: 100,
      updatedAt: "2026-09-02T12:00:00.000Z",
    }] : [] } as unknown as WorkerClient;
    const { unmount } = await mount(<CommandPalette worker={worker} tables={[table as never]}
      onClose={() => undefined} onOpenRecord={(name, id) => opened.push({ table: name, id })}
      onOpenData={() => undefined} onWrite={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined} />);
    const search = document.body.querySelector<HTMLInputElement>(".command-search-row input")!;
    await act(async () => typeInto(search, "Alice"));
    await waitFor(() => document.body.textContent?.includes("Alice task") ?? false);
    const result = [...document.body.querySelectorAll<HTMLButtonElement>(".command-results > button")]
      .find(button => button.textContent?.includes("Alice task"))!;
    expect(result.tabIndex).toBe(0);
    expect(result.getAttribute("aria-current")).toBe("true");
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true,
    })));
    expect(opened).toEqual([{ table: "tasks", id: "018f0000-0000-7000-8000-000000000001" }]);
    await unmount();
  });

  it("ignores a stale table load after the user switches tables", async () => {
    let releaseActive!: (rows: QueryRow[]) => void;
    let releaseDeleted!: (rows: QueryRow[]) => void;
    const active = new Promise<QueryRow[]>(resolve => { releaseActive = resolve; });
    const deleted = new Promise<QueryRow[]>(resolve => { releaseDeleted = resolve; });
    const tables = [
      { name: "tasks", columns: [{ name: "title", type: "text", required: true }] },
      { name: "projects", columns: [{ name: "name", type: "text", required: true }] },
    ] as RegTable[];
    const store = { query: async (query: Query) => {
      if (query.from === "tasks") return query.includeDeleted ? deleted : active;
      return query.includeDeleted ? [] : [{
        id: "018f0000-0000-7000-8000-000000000010", name: "Current project",
      }];
    } } as AsyncStore;
    const worker = {
      registryTables: async () => tables,
      semanticTrace: async () => null,
      restorableRows: async () => [], operationBatches: async () => [],
      sampleCount: async () => 0,
      getSetting: async () => undefined, compareAndSetSetting: async () => ({ ok: true }),
    } as unknown as WorkerClient;
    const { unmount } = await mount(<DataView store={store} worker={worker}
      onClose={() => undefined} onImport={() => undefined}
      onError={message => { throw new Error(message); }}
      onInfo={() => undefined} onWrite={() => undefined} />);
    await waitFor(() => [...document.body.querySelectorAll<HTMLButtonElement>(".dataview-tables button")]
      .some(button => button.textContent === "projects"));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".dataview-tables button")]
      .find(button => button.textContent === "projects")!.click());
    await waitFor(() => document.body.textContent?.includes("Current project") ?? false);
    await act(async () => {
      releaseActive([{ id: "018f0000-0000-7000-8000-000000000011", title: "Stale task" }]);
      releaseDeleted([]);
      await active; await deleted;
    });
    expect(document.body.textContent).toContain("Current project");
    expect(document.body.textContent).not.toContain("Stale task");
    await unmount();
  });

  it("archives a visible selection as one atomic batch", async () => {
    const store = await taskStore();
    store.insert("tasks", { title: "First", status: "open" });
    store.insert("tasks", { title: "Second", status: "open" });
    let initializedResolve!: () => void;
    const initialized = new Promise<void>(resolve => { initializedResolve = resolve; });
    let archivedResolve!: () => void;
    const archived = new Promise<void>(resolve => { archivedResolve = resolve; });
    const worker = {
      registryTables: async () => [...store.registrySnapshot().values()],
      semanticTrace: async () => store.semanticSchemaTrace(),
      sampleCount: async () => 0,
      operationBatches: async () => { initializedResolve(); return []; },
      getSetting: async () => null,
      restorableRows: async () => [],
      applyBatch: async (summary: string, mutations: BatchMutation[]) =>
        store.applyBatch({ source: "user", summary, mutations }),
      recordFilter: async () => null,
    } as unknown as WorkerClient;
    const { container, unmount } = await mount(<DataView
      worker={worker} store={new InProcessAsyncStore(store)} initialTable="tasks"
      onImport={() => undefined} onWrite={() => undefined} onClose={() => undefined}
      onError={message => { throw new Error(message); }}
      onInfo={message => { if (message.startsWith("Archived")) archivedResolve(); }}
      onSchemaChange={() => undefined} onRecovery={() => undefined}
    />);
    await waitFor(() => document.body.textContent?.includes("Second") ?? false);
    await act(async () => { await initialized; });
    const importInput = document.body.querySelector<HTMLInputElement>(
      '.dataview-import input[type="file"]')!;
    expect(importInput.style.display).not.toBe("none");
    expect(document.body.querySelector('button[aria-label="Sort by title"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Rename title column"]')).not.toBeNull();
    const editable = document.body.querySelector<HTMLTableCellElement>("td.cell-editable")!;
    expect(document.body.querySelectorAll('td[data-grid-cell][tabindex="0"]')).toHaveLength(1);
    await act(async () => editable.focus());
    await act(async () => editable.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true,
    })));
    expect(editable.querySelector("input")).not.toBeNull();
    const editor = editable.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      typeInto(editor, "Canceled edit");
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.textContent).not.toContain("Canceled edit");
    expect(store.query({ from: "tasks" }).some(row => row.title === "Canceled edit")).toBe(false);
    await act(async () => {
      document.body.querySelector<HTMLInputElement>('input[aria-label="Select all visible records"]')!.click();
    });
    await waitFor(() => document.body.textContent?.includes("2 selected") ?? false);
    const searchInput = document.body.querySelector<HTMLInputElement>(".dataview-search")!;
    await act(async () => typeInto(searchInput, "First"));
    await waitFor(() => !document.body.textContent?.includes("2 selected"));
    expect(document.body.querySelector('[aria-label="Bulk actions"]')).toBeNull();
    await act(async () => typeInto(searchInput, ""));
    await waitFor(() => document.body.textContent?.includes("Second") ?? false);
    await act(async () => {
      document.body.querySelector<HTMLInputElement>('input[aria-label="Select all visible records"]')!.click();
    });
    await waitFor(() => document.body.textContent?.includes("2 selected") ?? false);
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(".bulk-bar .danger")!.click();
      await archived;
    });
    expect(document.body.textContent).not.toContain("2 selected");
    expect(store.operationBatches(1)[0]).toMatchObject({ changed: 2, summary: "Archive 2 selected tasks" });
    await unmount();
    store.close();
  });

  it("guards row creation against double activation", async () => {
    const store = await taskStore();
    let addedResolve!: () => void;
    const added = new Promise<void>(resolve => { addedResolve = resolve; });
    const worker = {
      registryTables: async () => [...store.registrySnapshot().values()],
      semanticTrace: async () => store.semanticSchemaTrace(), sampleCount: async () => 0,
      operationBatches: async () => [], getSetting: async () => null,
      restorableRows: async () => [], recordFilter: async () => null,
    } as unknown as WorkerClient;
    const { unmount } = await mount(<DataView worker={worker}
      store={new InProcessAsyncStore(store)} initialTable="tasks"
      onImport={() => undefined} onWrite={() => addedResolve()} onClose={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined} />);
    await waitFor(() => document.body.querySelector('.dataview-new input[aria-label="title"]') !== null);
    const input = document.body.querySelector<HTMLInputElement>('.dataview-new input[aria-label="title"]')!;
    await act(async () => typeInto(input, "Only once"));
    const add = document.body.querySelector<HTMLButtonElement>(".dataview-new .primary")!;
    await act(async () => { add.click(); add.click(); await added; });
    await waitFor(() => document.body.querySelector<HTMLButtonElement>(".dataview-new .primary")
      ?.textContent === "+ Add");
    expect(store.query({ from: "tasks" })).toHaveLength(1);
    await unmount(); store.close();
  });

  it("Escape cancels inline editors without closing the Data workspace", async () => {
    const store = await taskStore(); store.insert("tasks", { title: "First" });
    let initializedResolve!: () => void;
    const initialized = new Promise<void>(resolve => { initializedResolve = resolve; });
    const worker = {
      registryTables: async () => [...store.registrySnapshot().values()],
      semanticTrace: async () => store.semanticSchemaTrace(), sampleCount: async () => 0,
      operationBatches: async () => { initializedResolve(); return []; }, getSetting: async () => null,
      restorableRows: async () => [], recordFilter: async () => null,
    } as unknown as WorkerClient;
    let closes = 0;
    const { unmount } = await mount(<DataView worker={worker}
      store={new InProcessAsyncStore(store)} initialTable="tasks"
      onImport={() => undefined} onWrite={() => undefined} onClose={() => { closes++; }}
      onError={message => { throw new Error(message); }} onInfo={() => undefined} />);
    await waitFor(() => document.body.querySelector('button[aria-label="Rename title column"]') !== null);
    await act(async () => { await initialized; });
    const escape = async (selector: string): Promise<void> => {
      await waitFor(() => document.body.querySelector(selector) !== null);
      const target = document.body.querySelector<HTMLElement>(selector)!;
      await act(async () => target
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(closes).toBe(0); expect(document.body.querySelector(".dataview")).not.toBeNull();
    };
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Rename title column"]')!.click());
    await escape(".dataview-col-edit");
    await act(async () => document.body.querySelector<HTMLButtonElement>(".dataview-addcol-btn")!.click());
    await escape('select[aria-label="new column type"]');
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Save view"))!.click());
    await escape(".save-work-view input");
    await unmount(); store.close();
  });

  it("shows search failures inline without claiming there are no matches", async () => {
    const errors: string[] = [];
    const worker = { globalSearch: async () => {
      throw new Error("Global search is limited to 20,000 records; narrow the table first.");
    } } as unknown as WorkerClient;
    const { unmount } = await mount(<CommandPalette worker={worker} tables={[]}
      onClose={() => undefined} onOpenRecord={() => undefined} onOpenData={() => undefined}
      onWrite={() => undefined} onError={message => errors.push(message)} onInfo={() => undefined} />);
    await waitFor(() => document.body.querySelector(".command-error") !== null);
    expect(document.body.textContent).toContain("20,000 records");
    expect(document.body.textContent).not.toContain("No records found");
    expect(errors).toHaveLength(1);
    await unmount();
  });
});

describe("Automation Center UI", () => {
  it("requires the save, simulate, then enable flow", async () => {
    const store = await taskStore();
    const table = store.registrySnapshot().get("tasks")!;
    let saved: AutomationDefinition | null = null;
    const savedRule = (): AutomationDefinition => {
      if (!saved) throw new Error("rule was not saved");
      return saved;
    };
    const worker = {
      listAutomations: async () => saved ? [saved] : [],
      automationRuns: async () => [],
      upsertAutomation: async (input: AutomationDefinitionInput) => {
        saved = {
          ...input,
          id: input.id ?? "auto_018f0000000070008000000000000001",
          createdAt: "2026-09-02T12:00:00.000Z",
          updatedAt: "2026-09-02T12:00:00.000Z",
        } as AutomationDefinition;
        return saved;
      },
      simulateAutomation: async () => ({
        automationId: savedRule().id,
        matchedRecords: 1, plannedMutations: 0, plannedNotifications: 1,
        sampleLabels: ["Call Acme"],
      }),
      notifications: async () => [],
    } as unknown as WorkerClient;
    const { container, unmount } = await mount(<AutomationCenter
      worker={worker} tables={[table]} notifications={[]}
      onNotifications={() => undefined} onClose={() => undefined}
      onOpenRecord={() => undefined} onWrite={() => undefined}
      onError={message => { throw new Error(message); }} onInfo={() => undefined}
    />);
    await waitFor(() => document.body.textContent?.includes("New rule") ?? false);
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent?.includes("New rule"))!.click();
    });
    const inputs = document.body.querySelectorAll<HTMLInputElement>(".automation-builder input");
    const name = inputs[0]!;
    const condition = inputs[1]!;
    await act(async () => {
      typeInto(name, "Follow up");
      typeInto(condition, "Call");
    });
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Save and simulate")!.click();
    });
    await waitFor(() => document.body.textContent?.includes("Simulation") ?? false);
    expect(savedRule().enabled).toBe(false);
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Enable rule")!.click();
    });
    await waitFor(() => savedRule().enabled === true);
    expect(saved).toMatchObject({ name: "Follow up", enabled: true });
    await unmount();
    store.close();
  });
});
