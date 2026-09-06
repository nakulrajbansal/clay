import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver } from "../src/index";
import { ProductionStoreAuthority } from "../src/production-authority";
import { activeSampleRowCount } from "../src/production-samples";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

async function freshAuthority(char: string): Promise<ProductionStoreAuthority> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const namespaceId = opaque("ns", char);
  return ProductionStoreAuthority.initializeFresh(driver, {
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
      const provenance = authority.readSetting<Record<string, string[]>>("sample_rows")!;
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
      expect(authority.readSetting("sample_rows")).toEqual(provenance);

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
      expect(authority.readSetting<Record<string, string[]>>("sample_rows")).toEqual({
        items: rows.map(row => String(row.id)),
      });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(2);
      const replay = await authority.executeMutation(fillRequest);
      expect(replay).toEqual({ ...filled, replayed: true });
      expect(authority.query({ from: "items" })).toHaveLength(2);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(2);
    } finally {
      authority.close();
    }
  });

  it("fails closed on malformed retained provenance before reserving or deleting", async () => {
    const authority = await freshAuthority("r");
    try {
      await authority.executeMutation({
        requestId: opaque("req", "r"), route: "starter.seed", payload: sampleSeed(),
      });
      await authority.executeMutation({
        requestId: opaque("req", "s"),
        route: "setting.set",
        payload: { key: "sample_rows", value: { items: "not-an-id-array" } },
      });
      const reservationsBefore = authority.inspectAuthority().targetReservations.length;
      const historyBefore = authority.readRowHistoryCount();

      await expect(authority.executeMutation({
        requestId: opaque("req", "t"), route: "samples.remove", payload: {},
      })).rejects.toMatchObject({
        code: "E_TARGET_AUTHORITY_INVALID",
        message: expect.stringMatching(/row ids.*array/i),
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

  it("retains provenance while its table is rewound and counts it again after roll-forward", async () => {
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
      expect(activeSampleRowCount(store)).toBe(1);

      store.rollbackTo(0);
      expect(activeSampleRowCount(store)).toBe(0);
      expect(store.getSetting("sample_rows")).toEqual({ items: [String(row.id)] });

      store.rollForwardTo(1);
      expect(activeSampleRowCount(store)).toBe(1);
    } finally {
      store.close();
    }
  });
});
