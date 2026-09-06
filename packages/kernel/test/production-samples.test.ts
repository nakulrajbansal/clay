import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver } from "../src/index";
import { ProductionStoreAuthority } from "../src/production-authority";
import {
  activeSampleRowCount,
  captureSampleFill,
  executeCapturedSampleFill,
  executeCapturedSampleRemoval,
} from "../src/production-samples";
import {
  assertExactSampleProvenance,
  decodeProductionResponse,
} from "../src/production-response-envelope";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

async function freshAuthority(char: string): Promise<ProductionStoreAuthority> {
  return (await freshAuthoritySession(char)).authority;
}

async function freshAuthoritySession(char: string) {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const namespaceId = opaque("ns", char);
  const authority = await ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: namespaceId,
    displayName: "Sample test",
    shellId: "blank",
    appInstanceId: opaque("app", char),
    generationId: opaque("gen", char),
    namespaceId,
    adoptionOperationId: opaque("op", char),
    releaseId: opaque("rel", char),
    nowMs: Date.now(),
    leaseTtlMs: 60_000,
  });
  return { authority, driver };
}

function sampleSeed() {
  return {
    schema: 1,
    shellId: "tracker",
    shellName: "Tracker",
    tables: [{
      name: "items",
      columns: [{ name: "title", type: "text", required: true }],
      sampleRows: [{ title: "Alpha" }, { title: "Beta" }],
    }],
    panels: [],
  };
}

describe("production sample-row authority", () => {
  it("soft-deletes only active sample rows and reports their recovery contract", async () => {
    const authority = await freshAuthority("m");
    try {
      await authority.executeMutation({
        requestId: opaque("req", "m"), route: "starter.seed", payload: sampleSeed(),
      });
      expect(authority.sampleRowCount()).toBe(2);
      expect(authority.readSetting("sample_rows")).toBeUndefined();
      const historyBefore = authority.readRowHistoryCount();

      const removed = await authority.executeMutation({
        requestId: opaque("req", "n"), route: "samples.remove", payload: {},
      });

      expect(removed).toMatchObject({
        changed: true,
        replayed: false,
        evidence: { protectionRevision: "2" },
        result: {
          affected: 2,
          recovery: { kind: "soft_delete", recoverable: 2 },
        },
      });
      expect(authority.query({ from: "items" })).toEqual([]);
      expect(authority.readStore().restorableRows("items")).toHaveLength(2);
      expect(authority.readRowHistoryCount() - historyBefore).toBe(2);
      expect(authority.readSetting("sample_rows")).toBeUndefined();

      const historyAfterRemoval = authority.readRowHistoryCount();
      const reservationsAfterRemoval = authority.inspectAuthority().targetReservations.length;
      const noOp = await authority.executeMutation({
        requestId: opaque("req", "q"), route: "samples.remove", payload: {},
      });
      expect(noOp).toMatchObject({
        changed: false,
        replayed: false,
        evidence: { protectionRevision: "2" },
        result: {
          affected: 0,
          recovery: { kind: "soft_delete", recoverable: 2 },
        },
      });
      expect(authority.readRowHistoryCount()).toBe(historyAfterRemoval);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(
        reservationsAfterRemoval,
      );
    } finally {
      authority.close();
    }
  });

  it("fills captured sample rows and records their row-level provenance atomically", async () => {
    const authority = await freshAuthority("o");
    try {
      const bundle = sampleSeed();
      bundle.tables[0]!.sampleRows = [];
      await authority.executeMutation({
        requestId: opaque("req", "o"), route: "starter.seed", payload: bundle,
      });

      const fillRequest = {
        requestId: opaque("req", "p"),
        route: "samples.fill",
        payload: {
          tables: [{
            table: "items",
            rows: [{ title: "Generated one" }, { title: "Generated two" }],
          }],
        },
      };
      const filled = await authority.executeMutation(fillRequest);

      expect(filled).toMatchObject({
        changed: true,
        replayed: false,
        evidence: { protectionRevision: "2" },
        result: { added: 2, tables: 1 },
      });
      const rows = authority.query({ from: "items" });
      expect(rows).toMatchObject([
        { title: "Generated one" },
        { title: "Generated two" },
      ]);
      expect(authority.sampleRowCount()).toBe(2);
      expect(authority.readSetting("sample_rows")).toBeUndefined();
      expect(authority.inspectAuthority().targetReservations).toHaveLength(2);
      const replay = await authority.executeMutation(fillRequest);
      expect(replay).toEqual({ ...filled, replayed: true });
      expect(authority.query({ from: "items" })).toHaveLength(2);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(2);
    } finally {
      authority.close();
    }
  });

  it("persists a route-bound receipt envelope with exact fill provenance", async () => {
    const { authority, driver } = await freshAuthoritySession("7");
    try {
      const bundle = sampleSeed();
      bundle.tables[0]!.sampleRows = [];
      await authority.executeMutation({
        requestId: opaque("req", "7"), route: "starter.seed", payload: bundle,
      });
      const requestId = opaque("req", "2");
      const filled = await authority.executeMutation({
        requestId,
        route: "samples.fill",
        payload: { tables: [{ table: "items", rows: [{ title: "One" }, { title: "Two" }] }] },
      });
      expect(filled.result).toEqual({ added: 2, tables: 1 });
      const rows = authority.query({ from: "items" });
      const tableId = authority.readStore().semanticSchemaTrace().tables
        .find(table => table.name === "items")!.tableId;
      const exactProvenance = rows
        .map(row => ({ tableId, rowId: String(row.id) }))
        .sort((left, right) => left.rowId.localeCompare(right.rowId));
      const receipt = driver.select(
        "SELECT response_json FROM sys.production_request_receipts WHERE request_id=?",
        [requestId],
      );
      expect(decodeProductionResponse(String(receipt[0]!.response_json))).toEqual({
        kind: "envelope",
        route: "samples.fill",
        result: { added: 2, tables: 1 },
        sampleProvenance: exactProvenance,
      });
    } finally {
      authority.close();
    }
  });

  it("rejects same-cardinality ledger substitution before proof", async () => {
    const driver = await openMemoryDriver();
    const store = ClayStore.fromDriver(driver);
    try {
      const operations = [{
        op: "create_table" as const,
        table: "items",
        columns: [{ name: "title", type: "text" as const, required: false }],
      }];
      store.commit({
        intent: "create items",
        summary: "Created items.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
        panels: [],
      });
      const ownerRow = store.insert("items", { title: "Owner row" });
      driver.exec(`CREATE TRIGGER sys.forge_sample_provenance
        AFTER INSERT ON settings WHEN NEW.key='sample_provenance_v1'
        BEGIN
          UPDATE settings
          SET value_json=json_set(value_json,'$.entries[0].rowId','${String(ownerRow.id)}')
          WHERE key='sample_provenance_v1';
        END`);
      const operationId = opaque("op", "5");
      const outcome = executeCapturedSampleFill(
        store,
        captureSampleFill({
          tables: [{ table: "items", rows: [{ title: "One" }, { title: "Two" }] }],
        }),
        operationId,
      );
      const persisted = store.sampleRowProvenance()
        .filter(entry => entry.operationId === operationId)
        .map(({ tableId, rowId }) => ({ tableId, rowId }));
      expect(outcome.sampleProvenance).toHaveLength(2);
      expect(persisted).toHaveLength(2);
      expect(outcome.sampleProvenance.some(entry => entry.rowId === String(ownerRow.id))).toBe(false);
      expect(persisted.some(entry => entry.rowId === String(ownerRow.id))).toBe(true);
      expect(() => assertExactSampleProvenance(
        outcome.sampleProvenance, persisted, 2, "sample fill",
      )).toThrow(/sample fill.*provenance/i);
    } finally {
      store.close();
    }
  });

  it("keeps an empty fill as a receipt-only no-op with zero provenance", async () => {
    const { authority, driver } = await freshAuthoritySession("2");
    try {
      const requestId = opaque("req", "2");
      const before = authority.inspectAuthority();
      const result = await authority.executeMutation({
        requestId, route: "samples.fill", payload: { tables: [] },
      });
      expect(result).toMatchObject({
        changed: false,
        replayed: false,
        result: { added: 0, tables: 0 },
        evidence: before.target,
      });
      expect(authority.readSetting("sample_provenance_v1")).toBeUndefined();
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
      expect(driver.select(
        "SELECT state,response_json FROM sys.production_request_receipts WHERE request_id=?",
        [requestId],
      )).toEqual([{
        state: "no_op",
        response_json: expect.stringContaining('"route":"samples.fill"'),
      }]);
      await expect(authority.executeMutation({
        requestId, route: "samples.fill", payload: { tables: [] },
      })).resolves.toEqual({ ...result, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("rejects forged retained provenance before reserving or deleting", async () => {
    const authority = await freshAuthority("r");
    try {
      await authority.executeMutation({
        requestId: opaque("req", "r"), route: "starter.seed", payload: sampleSeed(),
      });
      const reservationsBefore = authority.inspectAuthority().targetReservations.length;
      const historyBefore = authority.readRowHistoryCount();

      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: opaque("req", "s"),
        route: "setting.set",
        payload: { key: "sample_rows", value: { items: "not-an-id-array" } },
      }))).rejects.toMatchObject({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: expect.stringMatching(/reserved setting.*sample_rows/i),
      });

      expect(authority.query({ from: "items" })).toHaveLength(2);
      expect(authority.readRowHistoryCount()).toBe(historyBefore);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(reservationsBefore);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(reservationsBefore);
    } finally {
      authority.close();
    }
  });

  it("rejects oversized aggregate UTF-8 fill input before reservation", async () => {
    const authority = await freshAuthority("u");
    try {
      const chunk = "é".repeat(350_000);
      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: opaque("req", "u"),
        route: "samples.fill",
        payload: {
          tables: [{
            table: "items",
            rows: [{ title: chunk }, { title: chunk }, { title: chunk }],
          }],
        },
      }))).rejects.toMatchObject({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: expect.stringMatching(/aggregate capture limit/i),
      });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rejects escaped aggregate JSON above 2,000,000 bytes before reservation", async () => {
    const authority = await freshAuthority("6");
    try {
      const escaped = "\\".repeat(999_950);
      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: opaque("req", "6"),
        route: "samples.fill",
        payload: { tables: [{ table: "items", rows: [{ title: escaped }] }] },
      }))).rejects.toThrow(/2,000,000 UTF-8 bytes/i);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("reserves sample provenance against every generic setting mutation", async () => {
    const authority = await freshAuthority("2");
    try {
      const requests = [
        { route: "setting.set", payload: { key: "sample_rows", value: { items: ["mine"] } } },
        { route: "setting.delete", payload: { key: "sample_rows" } },
        {
          route: "setting.compareAndSet",
          payload: { key: "sample_rows", expectedRevision: 0, value: { items: ["mine"] } },
        },
        {
          route: "setting.set",
          payload: { key: "sample_provenance_v1", value: { schema: 1, entries: [] } },
        },
      ] as const;
      for (let index = 0; index < requests.length; index++) {
        const candidate = requests[index]!;
        await expect(Promise.resolve().then(() => authority.executeMutation({
          requestId: opaque("req", String(index + 2)),
          route: candidate.route,
          payload: candidate.payload,
        }))).rejects.toMatchObject({
          code: "E_TARGET_AUTHORITY_INVALID",
          message: expect.stringMatching(/reserved setting.*sample_(?:rows|provenance_v1)/i),
        });
      }
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("uses a null-prototype accumulator for a legitimate constructor table", async () => {
    const authority = await freshAuthority("3");
    try {
      const bundle = sampleSeed();
      bundle.tables[0]!.name = "constructor";
      bundle.tables[0]!.sampleRows = [];
      await authority.executeMutation({
        requestId: opaque("req", "3"), route: "starter.seed", payload: bundle,
      });
      const filled = await authority.executeMutation({
        requestId: opaque("req", "4"), route: "samples.fill",
        payload: { tables: [{ table: "constructor", rows: [{ title: "Safe" }] }] },
      });
      expect(filled.result).toEqual({ added: 1, tables: 1 });
      expect(authority.query({ from: "constructor" })).toMatchObject([{ title: "Safe" }]);
    } finally {
      authority.close();
    }
  });

  it("returns exact insert coordinates independently from the ledger", async () => {
    const driver = await openMemoryDriver();
    const store = ClayStore.fromDriver(driver);
    try {
      const operations = [{
        op: "create_table" as const,
        table: "items",
        columns: [{ name: "title", type: "text" as const, required: false }],
      }];
      store.commit({
        intent: "create items",
        summary: "Created items.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
        panels: [],
      });
      const outcome = executeCapturedSampleFill(
        store,
        captureSampleFill({ tables: [{ table: "items", rows: [{ title: "Direct" }] }] }),
        opaque("op", "4"),
      );
      const row = store.query({ from: "items" })[0]!;
      const tableId = store.validationRegistrySnapshot().get("items")!.semantic!.tableId;
      expect(outcome).toEqual({
        result: { added: 1, tables: 1 },
        sampleProvenance: [{ tableId, rowId: String(row.id) }],
      });
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(Object.isFrozen(outcome.sampleProvenance)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("fails closed if a trusted ledger coordinate no longer has one physical row", async () => {
    const driver = await openMemoryDriver();
    const store = ClayStore.fromDriver(driver);
    try {
      const operations = [{
        op: "create_table" as const,
        table: "items",
        columns: [{ name: "title", type: "text" as const, required: false }],
      }];
      store.commit({
        intent: "create items",
        summary: "Created items.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
        panels: [],
      });
      const row = store.insert("items", { title: "Sample" });
      const tableId = store.validationRegistrySnapshot().get("items")!.semantic!.tableId;
      store.recordSampleRowProvenance([{
        tableId,
        rowId: String(row.id),
        operationId: opaque("op", "5"),
      }]);
      driver.exec('DELETE FROM "items" WHERE id = ?', [String(row.id)]);
      expect(() => activeSampleRowCount(store)).toThrow(/missing row/i);
      expect(() => executeCapturedSampleRemoval(store)).toThrow(/missing row/i);
      const fill = captureSampleFill({
        tables: [{ table: "items", rows: [{ title: "Another" }] }],
      });
      expect(() => executeCapturedSampleFill(store, fill, opaque("op", "6")))
        .toThrow(/missing row/i);
      expect(store.query({ from: "items" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects fill and removal accessors without invoking getters", async () => {
    const authority = await freshAuthority("v");
    try {
      let getterCalls = 0;
      const row: Record<string, unknown> = {};
      Object.defineProperty(row, "title", {
        enumerable: true,
        get: () => { getterCalls += 1; return "unsafe"; },
      });
      expect(() => authority.executeMutation({
        requestId: opaque("req", "v"),
        route: "samples.fill",
        payload: { tables: [{ table: "items", rows: [row] }] },
      })).toThrowError(expect.objectContaining({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: expect.stringMatching(/plain data propert/i),
      }));

      const removalPayload: Record<string, unknown> = {};
      Object.defineProperty(removalPayload, "unexpected", {
        enumerable: true,
        get: () => { getterCalls += 1; return true; },
      });
      expect(() => authority.executeMutation({
        requestId: opaque("req", "w"),
        route: "samples.remove",
        payload: removalPayload,
      })).toThrowError(expect.objectContaining({ code: "E_TARGET_AUTHORITY_INVALID" }));
      expect(getterCalls).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rejects a null removal payload before authority reservation", async () => {
    const authority = await freshAuthority("6");
    try {
      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: opaque("req", "6"),
        route: "samples.remove",
        payload: null,
      }))).rejects.toMatchObject({ code: "E_TARGET_AUTHORITY_INVALID" });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rejects unauthenticated legacy setting provenance instead of deleting from it", async () => {
    const store = await ClayStore.openMemory();
    try {
      const operations = [{
        op: "create_table" as const,
        table: "items",
        columns: [{ name: "title", type: "text" as const, required: false }],
      }];
      store.commit({
        intent: "create items",
        summary: "Created items.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
        panels: [],
      });
      const row = store.insert("items", { title: "Sample" });
      store.setSetting("sample_rows", { items: [String(row.id)] });
      expect(() => activeSampleRowCount(store))
        .toThrow(/legacy sample provenance.*unauthenticated/i);
    } finally {
      store.close();
    }
  });
});
