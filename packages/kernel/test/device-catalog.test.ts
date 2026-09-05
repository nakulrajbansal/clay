import { describe, expect, it } from "vitest";
import {
  AppCatalogSnapshotV1,
  CatalogCasPublicationV1,
  CatalogRevisionReservationV1,
  WriteFenceV1,
} from "@clay/schema/catalog";
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
      app_instance_id,display_name,active_generation_id,
      journal_genesis_generation_id,journal_genesis_lineage_epoch,
      journal_genesis_protection_revision,journal_genesis_state_sha256,current_lineage_epoch,
      lineage_epoch_high_water,current_protection_revision,revision_high_water,
      digest_schema,state_sha256,tombstoned
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [ids.app, "Field Service", ids.generation, ids.generation, "2", "7", state,
      "2", "4", "7", "7", 1, state],
  );
  driver.exec(
    "UPDATE catalog.catalog_root SET selected_app_instance_id=?,catalog_generation='1' WHERE singleton=1",
    [ids.app],
  );
  driver.exec(
    `INSERT INTO catalog.catalog_generation_events(
      catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,
      target_generation_id,target_lineage_epoch,target_protection_revision,
      target_digest_schema,target_state_sha256
    ) VALUES ('1','app_seed',?,?,'0',?,?,?,?,?,?)`,
    [ids.app, ids.operation, at, ids.generation, "2", "7", 1, state],
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

  it("durably reserves the next selected-target revision under one current fence", async () => {
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
      const input = {
        expectedCatalogGeneration: "2",
        expectedTarget,
        operationId: id("op", "h"),
        requestSha256: `sha256:${"d".repeat(64)}`,
        fence,
        nowMs: 2_000,
      };
      const reservation = catalog.reserveSelectedProtectionRevision(input);
      expect(CatalogRevisionReservationV1.parse(reservation)).toMatchObject({
        reservedCatalogGeneration: "3",
        finalizedCatalogGeneration: null,
        revision: "8",
        state: "reserved",
        expectedProtectionRevision: "7",
        expectedStateSha256: expectedTarget.stateSha256,
        requestSha256: input.requestSha256,
      });
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "3",
        entries: [{ currentProtectionRevision: "7", revisionHighWater: "8" }],
      });
      expect(catalog.revisionReservations()).toEqual([reservation]);
      expect(catalog.reserveSelectedProtectionRevision(input)).toEqual(reservation);
      expect(catalog.revisionReservations()).toEqual([reservation]);
      expectCode(() => catalog.reserveSelectedProtectionRevision({
        ...input,
        requestSha256: `sha256:${"f".repeat(64)}`,
      }), "E_CATALOG_CONFLICT");
    } finally {
      driver.close();
    }
  });

  it("abandons a catalog revision permanently and allocates beyond the gap", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      const catalog = DeviceCatalog.openExisting(driver);
      const initial = catalog.snapshot();
      const fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
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
      const firstInput = {
        expectedCatalogGeneration: "2",
        expectedTarget,
        operationId: id("op", "h"),
        requestSha256: `sha256:${"d".repeat(64)}`,
        fence,
        nowMs: 2_000,
      };
      const first = catalog.reserveSelectedProtectionRevision(firstInput);
      const abandonInput = {
        expectedCatalogGeneration: first.reservedCatalogGeneration,
        expectedTarget,
        operationId: firstInput.operationId,
        requestSha256: firstInput.requestSha256,
        fence,
        nowMs: 3_000,
      };
      const abandoned = catalog.abandonSelectedProtectionRevision(abandonInput);
      expect(abandoned).toMatchObject({
        revision: "8",
        state: "abandoned",
        finalizedCatalogGeneration: "4",
        finalizedAt: "1970-01-01T00:00:03.000Z",
      });
      expect(catalog.abandonSelectedProtectionRevision({
        ...abandonInput, nowMs: 3_001,
      })).toEqual(abandoned);
      const second = catalog.reserveSelectedProtectionRevision({
        ...firstInput,
        expectedCatalogGeneration: "4",
        operationId: id("op", "j"),
        nowMs: 4_000,
      });
      expect(second).toMatchObject({
        revision: "9", state: "reserved", reservedCatalogGeneration: "5",
      });
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "5",
        entries: [{ currentProtectionRevision: "7", revisionHighWater: "9" }],
      });
    } finally {
      driver.close();
    }
  });

  it("publishes only the exact reserved target and finalizes its catalog journal row", async () => {
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
      const operationId = id("op", "h");
      const requestSha256 = `sha256:${"d".repeat(64)}`;
      const reservation = catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: "2",
        expectedTarget,
        operationId,
        requestSha256,
        fence,
        nowMs: 2_000,
      });
      const publishedTarget = {
        ...expectedTarget,
        protectionRevision: reservation.revision,
        stateSha256: `sha256:${"f".repeat(64)}`,
      };
      const publicationInput = {
        expectedCatalogGeneration: reservation.reservedCatalogGeneration,
        expectedTarget,
        publishedTarget,
        operationId,
        requestSha256,
        fence,
        nowMs: 3_000,
      };
      const publication = catalog.publishSelectedTarget(publicationInput);
      expect(CatalogCasPublicationV1.parse(publication)).toMatchObject({
        catalogGeneration: "4",
        selectedAppInstanceId: ids.app,
        publishedTarget,
      });
      expect(catalog.snapshot().entries[0]).toMatchObject({
        currentProtectionRevision: "8",
        revisionHighWater: "8",
        stateSha256: publishedTarget.stateSha256,
      });
      expect(catalog.revisionReservations()).toEqual([
        expect.objectContaining({
          ...reservation,
          state: "committed",
          finalizedCatalogGeneration: "4",
          finalizedWriteEpoch: fence.writeEpoch,
          finalizedLeaseId: fence.leaseId,
          finalizedReleaseId: fence.releaseId,
          publishedActiveGenerationId: ids.generation,
          publishedLineageEpoch: "2",
          stateSha256: publishedTarget.stateSha256,
          finalizedAt: "1970-01-01T00:00:03.000Z",
        }),
      ]);
      const after = catalog.snapshot();
      expect(catalog.publishSelectedTarget({ ...publicationInput, nowMs: 3_001 })).toEqual(publication);
      expectCode(() => catalog.publishSelectedTarget({
        ...publicationInput,
        requestSha256: `sha256:${"a".repeat(64)}`,
        nowMs: 3_002,
      }), "E_CATALOG_CONFLICT");
      expect(catalog.snapshot()).toEqual(after);
      const foreignAuthority = id("auth", "y");
      const foreignLease = id("lease", "x");
      driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?, 'authority', ?)",
        [foreignAuthority, "1970-01-01T00:00:01.000Z"],
      );
      driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?, 'lease', ?)",
        [foreignLease, "1970-01-01T00:00:01.000Z"],
      );
      driver.exec(
        `INSERT INTO catalog.leases(
          lease_id,authority_incarnation_id,write_epoch,release_id,
          issued_at_ms,expires_at_ms,revoked
        ) VALUES (?,?,?,?,?,?,1)`,
        [foreignLease, foreignAuthority, fence.writeEpoch, fence.releaseId, "1500", "6000"],
      );
      driver.exec(
        `INSERT INTO catalog.catalog_generation_events(
          catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at
        ) VALUES ('5','lease_issued',?,NULL,?,?)`,
        [ids.app, fence.writeEpoch, "1970-01-01T00:00:01.500Z"],
      );
      driver.exec("UPDATE catalog.catalog_root SET catalog_generation='5' WHERE singleton=1");
      driver.exec(
        "UPDATE catalog.revision_reservations SET finalized_lease_id=? WHERE operation_id=?",
        [foreignLease, operationId],
      );
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects generation activation before a lineage journal exists", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      const catalog = DeviceCatalog.openExisting(driver);
      const initial = catalog.snapshot();
      const fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: "1", expectedWriteEpoch: "0",
        releaseId: id("rel", "r"), nowMs: 1_000, ttlMs: 5_000,
      });
      const expectedTarget = {
        appInstanceId: ids.app, activeGenerationId: ids.generation,
        lineageEpoch: "2", protectionRevision: "7", digestSchema: 1 as const,
        stateSha256: `sha256:${"e".repeat(64)}`,
      };
      const operationId = id("op", "h");
      const requestSha256 = `sha256:${"d".repeat(64)}`;
      const reservation = catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: "2", expectedTarget, operationId,
        requestSha256, fence, nowMs: 2_000,
      });
      const generation = id("gen", "m"), namespace = id("ns", "n");
      const generationOperation = id("op", "p");
      const finalizedAt = "1970-01-01T00:00:03.000Z";
      for (const [value, kind] of [
        [generation, "generation"], [namespace, "namespace"],
        [generationOperation, "operation"],
      ] as const) driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
        [value, kind, finalizedAt],
      );
      const state = `sha256:${"f".repeat(64)}`;
      driver.exec(
        `INSERT INTO catalog.generations(
          generation_id,app_instance_id,namespace_id,storage_key,operation_id,
          lineage_epoch,first_revision,digest_schema,state_sha256,
          source_archive_sha256,source_provenance_id,sealed_at,read_back_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [generation, ids.app, namespace, "replacement", generationOperation,
          "3", reservation.revision, 1, state, null, null, finalizedAt, finalizedAt],
      );
      driver.exec(
        `UPDATE catalog.revision_reservations SET state='committed',
          finalized_catalog_generation='4',finalized_write_epoch=?,finalized_lease_id=?,
          finalized_release_id=?,published_active_generation_id=?,published_lineage_epoch='3',
          state_sha256=?,finalized_at=? WHERE operation_id=?`,
        [fence.writeEpoch, fence.leaseId, fence.releaseId, generation, state, finalizedAt, operationId],
      );
      driver.exec(
        `INSERT INTO catalog.catalog_generation_events(
          catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at
        ) VALUES ('4','revision_committed',?,?,?,?)`,
        [ids.app, operationId, fence.writeEpoch, finalizedAt],
      );
      driver.exec(
        `UPDATE catalog.app_entries SET active_generation_id=?,current_lineage_epoch='3',
          current_protection_revision=?,state_sha256=? WHERE app_instance_id=?`,
        [generation, reservation.revision, state, ids.app],
      );
      driver.exec("UPDATE catalog.catalog_root SET catalog_generation='4' WHERE singleton=1");
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally { driver.close(); }
  });

  it("rejects reservation lifecycle times outside the issuing lease", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      const catalog = DeviceCatalog.openExisting(driver);
      const initial = catalog.snapshot();
      const fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: "1",
        expectedWriteEpoch: "0",
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 5_000,
      });
      catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: "2",
        expectedTarget: {
          appInstanceId: ids.app,
          activeGenerationId: ids.generation,
          lineageEpoch: "2",
          protectionRevision: "7",
          digestSchema: 1,
          stateSha256: `sha256:${"e".repeat(64)}`,
        },
        operationId: id("op", "h"),
        requestSha256: `sha256:${"d".repeat(64)}`,
        fence,
        nowMs: 2_000,
      });
      driver.exec(
        "UPDATE catalog.revision_reservations SET reserved_at='1970-01-01T00:00:20.000Z'",
      );
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects a non-successor finalization generation", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      const catalog = DeviceCatalog.openExisting(driver);
      const initial = catalog.snapshot();
      const fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: "1",
        expectedWriteEpoch: "0",
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 10_000,
      });
      const expectedTarget = {
        appInstanceId: ids.app,
        activeGenerationId: ids.generation,
        lineageEpoch: "2",
        protectionRevision: "7",
        digestSchema: 1 as const,
        stateSha256: `sha256:${"e".repeat(64)}`,
      };
      const reservation = catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: "2",
        expectedTarget,
        operationId: id("op", "h"),
        requestSha256: `sha256:${"d".repeat(64)}`,
        fence,
        nowMs: 2_000,
      });
      catalog.abandonSelectedProtectionRevision({
        expectedCatalogGeneration: reservation.reservedCatalogGeneration,
        expectedTarget,
        operationId: reservation.operationId,
        requestSha256: reservation.requestSha256,
        fence,
        nowMs: 3_000,
      });
      driver.exec(
        "UPDATE catalog.revision_reservations SET reserved_catalog_generation='2'",
      );
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects catalog-generation reuse across revision journal events", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      const catalog = DeviceCatalog.openExisting(driver);
      const initial = catalog.snapshot();
      const fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: initial.authorityIncarnationId,
        expectedCatalogGeneration: "1",
        expectedWriteEpoch: "0",
        releaseId: id("rel", "r"),
        nowMs: 1_000,
        ttlMs: 10_000,
      });
      const expectedTarget = {
        appInstanceId: ids.app,
        activeGenerationId: ids.generation,
        lineageEpoch: "2",
        protectionRevision: "7",
        digestSchema: 1 as const,
        stateSha256: `sha256:${"e".repeat(64)}`,
      };
      const first = catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: "2",
        expectedTarget,
        operationId: id("op", "h"),
        requestSha256: `sha256:${"d".repeat(64)}`,
        fence,
        nowMs: 2_000,
      });
      catalog.abandonSelectedProtectionRevision({
        expectedCatalogGeneration: first.reservedCatalogGeneration,
        expectedTarget,
        operationId: first.operationId,
        requestSha256: first.requestSha256,
        fence,
        nowMs: 3_000,
      });
      const second = catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: "4",
        expectedTarget,
        operationId: id("op", "j"),
        requestSha256: `sha256:${"f".repeat(64)}`,
        fence,
        nowMs: 4_000,
      });
      catalog.abandonSelectedProtectionRevision({
        expectedCatalogGeneration: second.reservedCatalogGeneration,
        expectedTarget,
        operationId: second.operationId,
        requestSha256: second.requestSha256,
        fence,
        nowMs: 5_000,
      });
      driver.exec(
        `UPDATE catalog.revision_reservations
         SET reserved_catalog_generation='3',finalized_catalog_generation='4'
         WHERE revision='9'`,
      );
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects deletion of the immutable app journal genesis", async () => {
    const driver = await attachedCatalog();
    try {
      const ids = seedValidCatalog(driver);
      const replacementGeneration = id("gen", "f");
      const replacementNamespace = id("ns", "k");
      const at = "2026-09-04T20:00:00.000Z";
      driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'generation',?)",
        [replacementGeneration, at],
      );
      driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'namespace',?)",
        [replacementNamespace, at],
      );
      driver.exec("DELETE FROM catalog.generations WHERE generation_id=?", [ids.generation]);
      driver.exec(
        `INSERT INTO catalog.generations(
          generation_id,app_instance_id,namespace_id,storage_key,operation_id,
          lineage_epoch,first_revision,digest_schema,state_sha256,
          source_archive_sha256,source_provenance_id,sealed_at,read_back_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [replacementGeneration, ids.app, replacementNamespace, "replacement", ids.operation,
          "3", "8", 1, `sha256:${"f".repeat(64)}`, null, null, at, at],
      );
      driver.exec(
        `UPDATE catalog.app_entries SET active_generation_id=?,journal_genesis_generation_id=?,
          journal_genesis_lineage_epoch='3',journal_genesis_protection_revision='8',
          journal_genesis_state_sha256=?,current_lineage_epoch='3',
          current_protection_revision='8',revision_high_water='8',state_sha256=?
         WHERE app_instance_id=?`,
        [replacementGeneration, replacementGeneration, `sha256:${"f".repeat(64)}`,
          `sha256:${"f".repeat(64)}`, ids.app],
      );
      driver.exec(
        "DELETE FROM catalog.id_registry WHERE id_value IN (?,?)",
        [ids.generation, ids.namespace],
      );
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally {
      driver.close();
    }
  });

  it("rejects catalog-generation rollback after later lease issuance", async () => {
    const driver = await attachedCatalog();
    try {
      seedValidCatalog(driver);
      const catalog = DeviceCatalog.openExisting(driver);
      const before = catalog.snapshot();
      const first = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: before.authorityIncarnationId,
        expectedCatalogGeneration: before.catalogGeneration,
        expectedWriteEpoch: before.writeEpoch,
        releaseId: id("rel", "r"), nowMs: 1_000, ttlMs: 1_000,
      });
      const afterFirst = catalog.snapshot();
      catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: afterFirst.authorityIncarnationId,
        expectedCatalogGeneration: afterFirst.catalogGeneration,
        expectedWriteEpoch: first.writeEpoch,
        releaseId: id("rel", "s"), nowMs: 2_000, ttlMs: 1_000,
      });
      driver.exec("UPDATE catalog.catalog_root SET catalog_generation='2' WHERE singleton=1");
      expectCode(() => DeviceCatalog.openExisting(driver), "E_CATALOG_UNAVAILABLE");
    } finally { driver.close(); }
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

  it("rejects an exhausted write epoch without its generation history", async () => {
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
      }), "E_CATALOG_UNAVAILABLE");
      expect(driver.select("SELECT write_epoch FROM catalog.catalog_root")[0]?.write_epoch)
        .toBe("18446744073709551615");
    } finally {
      driver.close();
    }
  });
});
