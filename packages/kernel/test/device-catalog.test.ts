import { describe, expect, it } from "vitest";
import { AppCatalogSnapshotV1, CatalogCasPublicationV1, WriteFenceV1 } from "@clay/schema";
import {
  ClayError,
  openMemoryDriver,
  type DbDriver,
} from "../src/index";
import { DeviceCatalog } from "../src/device-catalog";

async function attachedCatalog(): Promise<DbDriver> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  return driver;
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    expect.fail(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ClayError);
    expect((error as ClayError).code).toBe(code);
  }
}

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

type SeededCatalogIds = { app: string; generation: string; namespace: string; operation: string };

function seedValidCatalog(driver: DbDriver): SeededCatalogIds {
  DeviceCatalog.initializeFresh(driver);
  const ids = {
    app: id("app", "a"),
    generation: id("gen", "b"),
    namespace: id("ns", "c"),
    operation: id("op", "d"),
  };
  const at = "2026-09-04T20:00:00.000Z";
  const state = `sha256:${"e".repeat(64)}`;
  for (const [value, kind] of [
    [ids.app, "app"], [ids.generation, "generation"],
    [ids.namespace, "namespace"], [ids.operation, "operation"],
  ] as const) driver.exec(
    "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
    [value, kind, at],
  );
  driver.exec(
    `INSERT INTO catalog.generations(
      generation_id,app_instance_id,namespace_id,storage_key,operation_id,
      lineage_epoch,first_revision,digest_schema,state_sha256,
      source_archive_sha256,source_provenance_id,sealed_at,read_back_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ids.generation, ids.app, ids.namespace, "default", ids.operation,
      "2", "7", 1, state, null, null, at, at],
  );
  driver.exec(
    `INSERT INTO catalog.app_entries(
      app_instance_id,display_name,active_generation_id,current_lineage_epoch,
      lineage_epoch_high_water,current_protection_revision,revision_high_water,
      digest_schema,state_sha256,tombstoned
    ) VALUES (?,?,?,?,?,?,?,?,?,0)`,
    [ids.app, "Field Service", ids.generation, "2", "4", "7", "9", 1, state],
  );
  driver.exec(
    "UPDATE catalog.catalog_root SET selected_app_instance_id=?, catalog_generation='1' WHERE singleton=1",
    [ids.app],
  );
  return ids;
}

describe("worker-owned device catalog root", () => {
  it("does not initialize an absent catalog during ordinary open", async () => {
    const driver = await attachedCatalog();
    try {
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
      expect(driver.select(
        "SELECT name FROM catalog.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it("explicitly initializes one strict fresh authority and reads it back", async () => {
    const driver = await attachedCatalog();
    try {
      const initialized = DeviceCatalog.initializeFresh(driver).snapshot();
      expect(AppCatalogSnapshotV1.parse(initialized)).toEqual(initialized);
      expect(initialized).toMatchObject({
        schema: 1,
        catalogGeneration: "0",
        selectedAppInstanceId: null,
        entries: [],
        writeEpoch: "0",
      });
      expect(DeviceCatalog.openExisting(driver).snapshot()).toEqual(initialized);
      expectCode(() => DeviceCatalog.initializeFresh(driver), "E_CATALOG_CONFLICT");
      expect(DeviceCatalog.openExisting(driver).snapshot()).toEqual(initialized);
    } finally {
      driver.close();
    }
  });

  it("fails closed when catalog schema is partial instead of repairing it", async () => {
    const driver = await attachedCatalog();
    try {
      DeviceCatalog.initializeFresh(driver);
      driver.exec("DROP TABLE catalog.app_entries");
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
      expectCode(() => DeviceCatalog.initializeFresh(driver), "E_CATALOG_CONFLICT");
    } finally {
      driver.close();
    }
  });

  it("rejects exact table names backed by a malformed table shape", async () => {
    const driver = await attachedCatalog();
    try {
      DeviceCatalog.initializeFresh(driver);
      driver.exec("DROP TABLE catalog.leases");
      driver.exec("CREATE TABLE catalog.leases(lease_id TEXT)");
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects a full column shape whose closed constraints were removed", async () => {
    const driver = await attachedCatalog();
    try {
      DeviceCatalog.initializeFresh(driver);
      driver.exec("DROP TABLE catalog.leases");
      driver.exec(`CREATE TABLE catalog.leases(
        lease_id TEXT PRIMARY KEY,
        authority_incarnation_id TEXT NOT NULL,
        write_epoch TEXT NOT NULL,
        release_id TEXT NOT NULL,
        issued_at_ms TEXT NOT NULL,
        expires_at_ms TEXT NOT NULL,
        revoked INTEGER NOT NULL
      )`);
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects executable catalog objects outside the closed schema", async () => {
    const driver = await attachedCatalog();
    try {
      DeviceCatalog.initializeFresh(driver);
      driver.exec(`CREATE TRIGGER catalog.catalog_root_side_effect
        AFTER UPDATE ON catalog_root BEGIN DELETE FROM app_entries; END`);
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("opens one fully linked non-empty physical catalog", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      expect(DeviceCatalog.openExisting(driver).snapshot()).toMatchObject({
        catalogGeneration: "1",
        selectedAppInstanceId: ids.app,
        entries: [{ appInstanceId: ids.app, activeGenerationId: ids.generation }],
      });
    } finally {
      driver.close();
    }
  });

  it("publishes one selected target with lease, expected-target, and catalog CAS", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      const catalog = DeviceCatalog.openExisting(driver);
      const beforeLease = catalog.snapshot();
      const fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: beforeLease.authorityIncarnationId,
        expectedCatalogGeneration: "1",
        expectedWriteEpoch: "0",
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 5_000,
      });
      const expectedTarget = {
        appInstanceId: ids.app,
        activeGenerationId: ids.generation,
        lineageEpoch: "2",
        protectionRevision: "7",
        digestSchema: 1 as const,
        stateSha256: `sha256:${"e".repeat(64)}`,
      };
      const publishedTarget = {
        ...expectedTarget,
        protectionRevision: "8",
        stateSha256: `sha256:${"f".repeat(64)}`,
      };
      expect(CatalogCasPublicationV1.parse(catalog.publishSelectedTarget({
        expectedCatalogGeneration: "2",
        expectedTarget,
        publishedTarget,
        fence,
        nowMs: 2_000,
      }))).toMatchObject({
        catalogGeneration: "3",
        selectedAppInstanceId: ids.app,
        publishedTarget,
      });
      expect(catalog.snapshot().entries[0]).toMatchObject({
        currentProtectionRevision: "8",
        revisionHighWater: "9",
        stateSha256: publishedTarget.stateSha256,
      });
      const after = catalog.snapshot();
      expectCode(() => catalog.publishSelectedTarget({
        expectedCatalogGeneration: "2",
        expectedTarget,
        publishedTarget,
        fence,
        nowMs: 2_001,
      }), "E_CATALOG_CONFLICT");
      expect(catalog.snapshot()).toEqual(after);
    } finally {
      driver.close();
    }
  });

  it.each([
    ["missing retained namespace identity", (driver: DbDriver, ids: SeededCatalogIds) =>
      driver.exec("DELETE FROM catalog.id_registry WHERE id_value=?", [ids.namespace])],
    ["orphan generation owner", (driver: DbDriver, ids: SeededCatalogIds) =>
      driver.exec("UPDATE catalog.generations SET app_instance_id=? WHERE generation_id=?",
        [id("app", "f"), ids.generation])],
    ["missing active generation", (driver: DbDriver, ids: SeededCatalogIds) =>
      driver.exec("DELETE FROM catalog.generations WHERE generation_id=?", [ids.generation])],
    ["mismatched generation lineage", (driver: DbDriver, ids: SeededCatalogIds) =>
      driver.exec("UPDATE catalog.generations SET lineage_epoch='3' WHERE generation_id=?", [ids.generation])],
    ["mismatched generation digest", (driver: DbDriver, ids: SeededCatalogIds) =>
      driver.exec("UPDATE catalog.generations SET state_sha256=? WHERE generation_id=?",
        [`sha256:${"f".repeat(64)}`, ids.generation])],
    ["selected tombstone", (driver: DbDriver, ids: SeededCatalogIds) =>
      driver.exec("UPDATE catalog.app_entries SET tombstoned=1 WHERE app_instance_id=?", [ids.app])],
    ["malformed physical storage key", (driver: DbDriver, ids: SeededCatalogIds) =>
      driver.exec("UPDATE catalog.generations SET storage_key='../escape' WHERE generation_id=?",
        [ids.generation])],
  ] as const)("rejects %s", async (_name, corrupt) => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      corrupt(driver, ids);
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("acquires one expiring origin lease and invalidates every older epoch", async () => {
    const driver = await attachedCatalog();
    try {
      const catalog = DeviceCatalog.initializeFresh(driver);
      const initial = catalog.snapshot();
      const first = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: "0",
        expectedWriteEpoch: "0",
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 5_000,
      });
      expect(WriteFenceV1.parse(first)).toEqual(first);
      expect(first.writeEpoch).toBe("1");
      expect(catalog.snapshot()).toMatchObject({ catalogGeneration: "1", writeEpoch: "1" });
      expect(catalog.assertWriteFence(first, 5_999)).toEqual(first);
      expectCode(() => catalog.assertWriteFence(first, 6_000), "E_STALE_WRITE_EPOCH");
      expectCode(() => catalog.assertWriteFence(first, 999), "E_STALE_WRITE_EPOCH");

      const beforeStale = catalog.snapshot();
      expectCode(() => catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: "1",
        expectedWriteEpoch: "0",
        releaseId: id("rel", "r"),
        nowMs: 2_000,
        ttlMs: 5_000,
      }), "E_STALE_WRITE_EPOCH");
      expect(catalog.snapshot()).toEqual(beforeStale);

      const second = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: "1",
        expectedWriteEpoch: "1",
        releaseId: id("rel", "r"),
        nowMs: 2_000,
        ttlMs: 5_000,
      });
      expect(second.writeEpoch).toBe("2");
      expectCode(() => catalog.assertWriteFence(first, 2_001), "E_STALE_WRITE_EPOCH");
      expect(catalog.assertWriteFence(second, 2_001)).toEqual(second);
    } finally {
      driver.close();
    }
  });

  it("rejects multiple unrevoked leases for the current write epoch", async () => {
    const driver = await attachedCatalog();
    try {
      const catalog = DeviceCatalog.initializeFresh(driver);
      const initial = catalog.snapshot();
      const current = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: initial.catalogGeneration,
        expectedWriteEpoch: initial.writeEpoch,
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 5_000,
      });
      const duplicateLeaseId = id("lease", "s");
      driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'lease',?)",
        [duplicateLeaseId, "1970-01-01T00:00:01.000Z"],
      );
      driver.exec(
        `INSERT INTO catalog.leases(
          lease_id,authority_incarnation_id,write_epoch,release_id,
          issued_at_ms,expires_at_ms,revoked
        ) VALUES (?,?,?,?,?,?,0)`,
        [duplicateLeaseId, initial.authorityIncarnationId, current.writeEpoch,
          current.releaseId, "1000", "6000"],
      );
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects a persisted lease longer than the five-minute authority cap", async () => {
    const driver = await attachedCatalog();
    try {
      const catalog = DeviceCatalog.initializeFresh(driver);
      const initial = catalog.snapshot();
      catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: initial.catalogGeneration,
        expectedWriteEpoch: initial.writeEpoch,
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 5_000,
      });
      driver.exec("UPDATE catalog.leases SET expires_at_ms='301001' WHERE revoked=0");
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("fails closed instead of wrapping an exhausted write epoch", async () => {
    const driver = await attachedCatalog();
    try {
      const catalog = DeviceCatalog.initializeFresh(driver);
      const authority = catalog.snapshot().authorityIncarnationId;
      driver.exec("UPDATE catalog.catalog_root SET write_epoch = '18446744073709551615'");
      expectCode(() => catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: authority,
        expectedCatalogGeneration: "0",
        expectedWriteEpoch: "18446744073709551615",
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 5_000,
      }), "E_STALE_WRITE_EPOCH");
      expect(catalog.snapshot().writeEpoch).toBe("18446744073709551615");
    } finally {
      driver.close();
    }
  });
});
