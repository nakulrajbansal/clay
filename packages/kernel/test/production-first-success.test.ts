import { describe, expect, it } from "vitest";
import { openMemoryDriver } from "../src/index";
import { ProductionStoreAuthority } from "../src/production-authority";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

async function authoritySession(char: string): Promise<ProductionStoreAuthority> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const namespaceId = opaque("ns", char);
  return ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: namespaceId,
    displayName: "First success test",
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

const starter = {
  schema: 1,
  shellId: "tracker",
  shellName: "Tracker",
  tables: [{
    name: "items",
    columns: [{ name: "title", type: "text", required: true }],
    sampleRows: [{ title: "Example" }],
  }],
  panels: [],
};

const startedWithRealRecord = {
  version: 2,
  revision: 2,
  dismissed: false,
  start: { state: "complete", path: "recommended", shellId: "tracker" },
  steps: {
    realRecord: { state: "complete", source: "create" },
    everyday: { state: "pending" },
    reshapePreview: { state: "pending" },
    reshapeKept: { state: "pending" },
  },
};

describe("production first-success authority", () => {
  it("completes an everyday action atomically for only a canonical non-sample row", async () => {
    const authority = await authoritySession("f");
    try {
      await authority.executeMutation({
        requestId: opaque("req", "a"), route: "starter.seed", payload: starter,
      });
      await authority.executeMutation({
        requestId: opaque("req", "b"), route: "setting.set",
        payload: { key: "release_a_first_success_v1", value: startedWithRealRecord },
      });
      const sample = authority.query({ from: "items" })[0]!;
      const beforeSample = authority.inspectAuthority().target;
      await expect(authority.executeMutation({
        requestId: opaque("req", "c"), route: "firstSuccess.completeEveryday",
        payload: { action: "open", table: "items", rowId: String(sample.id) },
      })).rejects.toThrow(/sample|canonical real record/i);
      expect(authority.inspectAuthority().target).toEqual(beforeSample);
      expect(authority.readSetting("release_a_first_success_v1"))
        .toEqual(startedWithRealRecord);

      const inserted = await authority.executeMutation({
        requestId: opaque("req", "d"), route: "store.insert",
        payload: { table: "items", row: { title: "Call the real customer" } },
      });
      const rowId = String((inserted.result as { id: unknown }).id);
      const completed = await authority.executeMutation({
        requestId: opaque("req", "e"), route: "firstSuccess.completeEveryday",
        payload: { action: "open", table: "items", rowId },
      });
      expect(completed).toMatchObject({
        changed: true,
        replayed: false,
        result: {
          version: 2,
          revision: 3,
          steps: { everyday: { state: "complete", action: "open" } },
        },
      });
      expect(authority.readSetting("release_a_first_success_v1"))
        .toEqual(completed.result);

      const revision = completed.evidence.protectionRevision;
      const duplicate = await authority.executeMutation({
        requestId: opaque("req", "g"), route: "firstSuccess.completeEveryday",
        payload: { action: "open", table: "items", rowId },
      });
      expect(duplicate).toMatchObject({
        changed: false,
        replayed: false,
        evidence: { protectionRevision: revision },
        result: completed.result,
      });
      expect(authority.readSetting("release_a_first_success_v1"))
        .toEqual(completed.result);
    } finally {
      authority.close();
    }
  });
});
