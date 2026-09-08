import { describe, expect, it } from "vitest";
import { ClayStore, openMemoryDriver } from "../src/index";
import {
  armProductionAuthorityFailureForTest,
  ProductionStoreAuthority,
} from "../src/production-authority";
import { captureTableImport, executeCapturedTableImport } from "../src/production-import";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

async function freshAuthority(char: string): Promise<ProductionStoreAuthority> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const namespaceId = opaque("ns", char);
  return ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: namespaceId,
    displayName: "Import test",
    shellId: "blank",
    appInstanceId: opaque("app", char),
    generationId: opaque("gen", char),
    namespaceId,
    adoptionOperationId: opaque("op", char),
    releaseId: opaque("rel", char),
    nowMs: Date.now(),
    leaseTtlMs: 60_000,
  });
}

describe("production table import authority", () => {
  it("publishes schema, rows, starter panel, and receipt in one authority revision", async () => {
    const authority = await freshAuthority("i");
    try {
      const request = {
        requestId: opaque("req", "i"),
        route: "table.import",
        payload: {
          table: "expenses",
          columns: [
            { name: "item", type: "text" },
            { name: "amount", type: "number" },
          ],
          rows: [
            { item: "Coffee", amount: 4.5 },
            { item: "Rent", amount: 1200 },
          ],
        },
      };

      const committed = await authority.executeMutation(request);

      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        evidence: { protectionRevision: "1" },
        result: { table: "expenses", imported: 2, columns: 2 },
      });
      expect(authority.readStore().registrySnapshot().get("expenses")?.columns.map(column => column.name))
        .toEqual(["item", "amount"]);
      expect(authority.query({ from: "expenses" })).toMatchObject(request.payload.rows);
      expect(authority.readStore().livePanels()).toEqual([
        expect.objectContaining({
          panel_id: "expenses_view",
          declared_queries: [expect.objectContaining({ from: "expenses", limit: 500 })],
          version: 1,
        }),
      ]);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(1);

      await expect(authority.executeMutation(structuredClone(request))).resolves.toEqual({
        ...committed,
        replayed: true,
      });
      expect(authority.query({ from: "expenses" })).toHaveLength(2);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("publishes and undoes a first-run import through exact authority receipts", async () => {
    const authority = await freshAuthority("v");
    try {
      const activationRequest = {
        requestId: opaque("req", "v"),
        route: "table.import",
        payload: {
          table: "jobs",
          columns: [{ name: "name", type: "text" }],
          rows: [{ name: "One" }, { name: "Two" }],
          activation: {
            operationId: "import-operation-00001",
            appId: "default",
            review: {
              sourceRows: 2,
              acceptedRows: 2,
              skippedRows: 0,
              truncatedRows: 0,
              sourceColumns: 1,
              acceptedColumns: 1,
              truncatedColumns: 0,
            },
          },
        },
      };
      const activated = await authority.executeMutation(activationRequest);
      expect(activated).toMatchObject({
        changed: true,
        evidence: { protectionRevision: "1" },
        result: {
          table: "jobs",
          imported: 2,
          publication: {
            operationId: "import-operation-00001",
            kind: "import",
            import: { batchIds: [expect.any(String)], rowIds: [expect.any(String), expect.any(String)] },
          },
        },
      });
      expect(authority.readSetting("first_run_publication_v1")).toEqual(
        (activated.result as { publication: unknown }).publication,
      );
      expect(authority.readSetting("release_a_first_success_v1")).toMatchObject({
        revision: 2,
        steps: { realRecord: { state: "complete", source: "import" } },
      });

      const undoRequest = {
        requestId: opaque("req", "w"),
        route: "firstRun.undoImport",
        payload: {
          operationId: "import-operation-00001",
          appId: "default",
          expectedRevision: 1,
        },
      };
      const undone = await authority.executeMutation(undoRequest);
      expect(undone).toMatchObject({
        changed: true,
        evidence: { protectionRevision: "2" },
        result: { operationId: "import-operation-00001", undone: true },
      });
      expect(authority.query({ from: "jobs" })).toEqual([]);
      expect(authority.readStore().registrySnapshot().has("jobs")).toBe(true);
      expect(authority.readSetting("release_a_first_success_v1")).toMatchObject({
        steps: { realRecord: { state: "pending" }, everyday: { state: "pending" } },
      });
      await expect(authority.executeMutation(structuredClone(undoRequest))).resolves.toEqual({
        ...undone,
        replayed: true,
      });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(2);
    } finally {
      authority.close();
    }
  });

  it("rejects nested accessors without invoking them or reserving a revision", async () => {
    const authority = await freshAuthority("j");
    try {
      let getterCalls = 0;
      const column: Record<string, unknown> = { name: "title", type: "text" };
      Object.defineProperty(column, "values", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return ["unsafe"];
        },
      });
      const request = {
        requestId: opaque("req", "j"),
        route: "table.import",
        payload: { table: "items", columns: [column], rows: [{ title: "Safe" }] },
      };

      expect(() => authority.executeMutation(request)).toThrowError(expect.objectContaining({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: expect.stringMatching(/plain data propert/i),
      }));
      expect(getterCalls).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rolls schema, rows, and panel back together when live publication fails", async () => {
    const authority = await freshAuthority("k");
    try {
      armProductionAuthorityFailureForTest(authority, "after_live_mutation");
      await expect(authority.executeMutation({
        requestId: opaque("req", "k"),
        route: "table.import",
        payload: {
          table: "rollback_me",
          columns: [{ name: "title", type: "text" }],
          rows: [{ title: "Must not survive" }],
        },
      })).rejects.toMatchObject({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: "injected failure after live mutation",
      });

      expect(authority.readStore().registrySnapshot().has("rollback_me")).toBe(false);
      expect(authority.readStore().livePanels()).toEqual([]);
      expect(authority.inspectAuthority().target.protectionRevision).toBe("0");
      expect(authority.inspectAuthority().targetReservations).toEqual([
        expect.objectContaining({ state: "abandoned" }),
      ]);
      expect(authority.inspectAuthority().catalogReservations).toEqual([
        expect.objectContaining({ state: "abandoned" }),
      ]);
    } finally {
      authority.close();
    }
  });

  it("rejects aggregate UTF-8 payloads above two million bytes before reservation", async () => {
    const authority = await freshAuthority("l");
    try {
      const chunk = "é".repeat(350_000);
      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: opaque("req", "l"),
        route: "table.import",
        payload: {
          table: "oversized",
          columns: [{ name: "title", type: "text" }],
          rows: [{ title: chunk }, { title: chunk }, { title: chunk }],
        },
      }))).rejects.toMatchObject({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: expect.stringMatching(/aggregate capture limit/i),
      });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
      expect(authority.readStore().registrySnapshot().has("oversized")).toBe(false);
    } finally {
      authority.close();
    }
  });

  it("stages every typed row before reservation and rejects a late malformed value", async () => {
    const authority = await freshAuthority("m");
    try {
      await expect(authority.executeMutation({
        requestId: opaque("req", "m"),
        route: "table.import",
        payload: {
          table: "dated_items",
          columns: [{ name: "due_date", type: "date" }],
          rows: [{ due_date: "2026-09-01" }, { due_date: "not-a-date" }],
        },
      })).rejects.toMatchObject({ code: "E_VALIDATION" });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
      expect(authority.readStore().registrySnapshot().has("dated_items")).toBe(false);
      expect(authority.readStore().livePanels()).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("detaches captured rows before queued publication", async () => {
    const authority = await freshAuthority("n");
    try {
      const row = { title: "Captured title" };
      const pending = authority.executeMutation({
        requestId: opaque("req", "n"),
        route: "table.import",
        payload: {
          table: "detached_items",
          columns: [{ name: "title", type: "text" }],
          rows: [row],
        },
      });
      row.title = "Caller changed this";
      await pending;
      expect(authority.query({ from: "detached_items" })[0]?.title).toBe("Captured title");
    } finally {
      authority.close();
    }
  });

  it("allocates a panel identity without overwriting an unrelated live panel", async () => {
    const authority = await freshAuthority("o");
    try {
      const originalCode = `export default function (clay) {
  clay.db.watch({ from: "existing", limit: 10 }, rows => clay.ui.render(h(Table, {
    rows, columns: [{ field: "title", label: "Title" }]
  })));
}`;
      await authority.executeMutation({
        requestId: opaque("req", "o"),
        route: "starter.seed",
        payload: {
          schema: 1,
          shellId: "custom",
          shellName: "Custom",
          tables: [{
            name: "existing",
            columns: [{ name: "title", type: "text", required: false }],
            sampleRows: [],
          }],
          panels: [{
            panel_id: "expenses_view",
            title: "Original panel",
            placement: { region: "main", order: 0, w: 4 },
            code: originalCode,
            declared_queries: [{ from: "existing", limit: 10 }],
            declared_writes: [],
          }],
        },
      });
      await authority.executeMutation({
        requestId: opaque("req", "p"),
        route: "table.import",
        payload: {
          table: "expenses",
          columns: [{ name: "amount", type: "number" }],
          rows: [{ amount: 12 }],
        },
      });

      const panels = authority.readStore().livePanels();
      expect(panels).toHaveLength(2);
      expect(panels.find(panel => panel.panel_id === "expenses_view")).toMatchObject({
        title: "Original panel", code: originalCode,
      });
      expect(panels).toContainEqual(expect.objectContaining({
        panel_id: "expenses_view_2",
        declared_queries: [expect.objectContaining({ from: "expenses" })],
      }));
    } finally {
      authority.close();
    }
  });

  it("does not reactivate or merge into a rewound table tombstone", async () => {
    const store = await ClayStore.openMemory();
    try {
      executeCapturedTableImport(store, captureTableImport({
        table: "expenses",
        columns: [{ name: "amount", type: "number" }],
        rows: [{ amount: 10 }],
      }));
      store.rollbackTo(0, { truncate: true });

      const result = executeCapturedTableImport(store, captureTableImport({
        table: "expenses",
        columns: [{ name: "amount", type: "number" }],
        rows: [{ amount: 20 }],
      }));
      expect(result.table).toBe("expenses_2");
      expect(store.query({ from: "expenses_2" })).toMatchObject([{ amount: 20 }]);
      expect(store.validationRegistrySnapshot().get("expenses")?.inactive).toBe(true);
    } finally {
      store.close();
    }
  });
});
