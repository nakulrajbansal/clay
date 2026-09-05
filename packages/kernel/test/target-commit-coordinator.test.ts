import { describe, expect, it } from "vitest";
import {
  CatalogReservationRecoveryV1,
  type TargetAuthorityHeaderV1,
} from "@clay/schema/catalog";
import { type DbDriver } from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { DeviceCatalog } from "../src/device-catalog";
import { LiveWriteGuard } from "../src/live-write-guard";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";
import { TargetCommitCoordinator } from "../src/target-commit-coordinator";
import { seededStore } from "./helpers";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const header: TargetAuthorityHeaderV1 = {
  schema: 1,
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "0",
  lineageEpochHighWater: "0",
  protectionRevision: "0",
  protectionRevisionHighWater: "0",
  digestSchema: 1,
};

function seedCatalogForTarget(driver: DbDriver, target: {
  appInstanceId: string;
  activeGenerationId: string;
  lineageEpoch: string;
  protectionRevision: string;
  digestSchema: 1;
  stateSha256: string;
}) {
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  DeviceCatalog.initializeFresh(driver);
  const namespaceId = id("ns", "c");
  const operationId = id("op", "z");
  const at = "2026-09-05T00:00:00.000Z";
  for (const [value, kind] of [
    [target.appInstanceId, "app"],
    [target.activeGenerationId, "generation"],
    [namespaceId, "namespace"],
    [operationId, "operation"],
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
    [target.activeGenerationId, target.appInstanceId, namespaceId, "default", operationId,
      target.lineageEpoch, target.protectionRevision, target.digestSchema, target.stateSha256,
      null, null, at, at],
  );
  driver.exec(
    `INSERT INTO catalog.app_entries(
      app_instance_id,display_name,active_generation_id,
      journal_genesis_generation_id,journal_genesis_lineage_epoch,
      journal_genesis_protection_revision,journal_genesis_state_sha256,current_lineage_epoch,
      lineage_epoch_high_water,current_protection_revision,revision_high_water,
      digest_schema,state_sha256,tombstoned
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [target.appInstanceId, "Projects", target.activeGenerationId,
      target.activeGenerationId, target.lineageEpoch, target.protectionRevision,
      target.stateSha256, target.lineageEpoch, target.lineageEpoch,
      target.protectionRevision, target.protectionRevision,
      target.digestSchema, target.stateSha256],
  );
  driver.exec(
    "UPDATE catalog.catalog_root SET selected_app_instance_id=?,catalog_generation='1' WHERE singleton=1",
    [target.appInstanceId],
  );
  driver.exec(
    `INSERT INTO catalog.catalog_generation_events(
      catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,
      target_generation_id,target_lineage_epoch,target_protection_revision,
      target_digest_schema,target_state_sha256
    ) VALUES ('1','app_seed',?,?,'0',?,?,?,?,?,?)`,
    [target.appInstanceId, operationId, at, target.activeGenerationId,
      target.lineageEpoch, target.protectionRevision, target.digestSchema, target.stateSha256],
  );
  const catalog = DeviceCatalog.openExisting(driver);
  const beforeLease = catalog.snapshot();
  const fence = catalog.acquireWriteLease({
    expectedAuthorityIncarnationId: beforeLease.authorityIncarnationId,
    expectedCatalogGeneration: beforeLease.catalogGeneration,
    expectedWriteEpoch: beforeLease.writeEpoch,
    releaseId: id("rel", "r"),
    nowMs: Date.parse("2026-09-04T23:59:59.000Z"),
    ttlMs: 300_000,
  });
  return { fence, expectedCatalogGeneration: catalog.snapshot().catalogGeneration };
}

function commitClock(): () => number {
  const instants = [
    Date.parse("2026-09-05T00:00:00.000Z"),
    Date.parse("2026-09-05T00:01:00.000Z"),
  ];
  let index = 0;
  return () => instants[Math.min(index++, instants.length - 1)]!;
}

describe("guarded target commit coordinator", () => {
  it("returns a canonical no-op without mutation or revision reservation", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      const expectedTarget = target.evidence();
      const unchanged = census.leaves[0]!.seed;
      const guard = new LiveWriteGuard(driver);
      const coordinator = new TargetCommitCoordinator(guard);
      let invoked = false;
      expect(coordinator.commit({
        expectedTarget,
        operationId: id("op", "c"),
        changes: [{ key: unchanged.key, fields: unchanged.fields }],
        mutate: () => { invoked = true; },
      })).toEqual({ changed: false, evidence: expectedTarget });
      expect(invoked).toBe(false);
      expect(TargetAuthorityStore.open(guard).reservations()).toEqual([]);
      expect(TargetAuthorityStore.open(guard).header()).toEqual(header);
    } finally {
      clay.close();
    }
  });

  it("rejects a meaningful change before guarded publication is implemented", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const changed = census.leaves[0]!.seed;
      const fields = changed.fields.map(field => field.kind === "text"
        ? { ...field, value: `${field.value} changed` } : field);
      const guard = new LiveWriteGuard(driver);
      const coordinator = new TargetCommitCoordinator(
        guard, clay.validationRegistrySnapshot(),
      );
      let invoked = false;
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "d"),
        changes: [{ key: changed.key, fields }],
        mutate: () => { invoked = true; },
      })).toThrow();
      expect(invoked).toBe(false);
      expect(TargetAuthorityStore.open(guard).reservations()).toEqual([]);
    } finally {
      clay.close();
    }
  });

  it("rolls back target allocation when catalog reservation CAS fails", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const guard = new LiveWriteGuard(driver);
      const catalog = DeviceCatalog.openExisting(guard);
      const beforeCatalog = catalog.snapshot();
      const changed = census.leaves[0]!.seed;
      const fields = changed.fields.map(field => field.kind === "text"
        ? { ...field, value: `${field.value} changed` } : field);
      const coordinator = new TargetCommitCoordinator(guard, registry, commitClock());
      let invoked = false;
      expect(() => coordinator.commit({
        expectedTarget,
        expectedCatalogGeneration: "1",
        fence: catalogContext.fence,
        operationId: id("op", "n"),
        changes: [{ key: changed.key, fields }],
        mutate: () => { invoked = true; },
      })).toThrow();
      expect(invoked).toBe(false);
      expect(TargetAuthorityStore.open(guard).header()).toMatchObject({
        protectionRevision: "0", protectionRevisionHighWater: "0",
      });
      expect(TargetAuthorityStore.open(guard).reservations()).toEqual([]);
      expect(catalog.snapshot()).toEqual(beforeCatalog);
      expect(catalog.revisionReservations()).toEqual([]);
    } finally {
      clay.close();
    }
  });

  it("validates the final lease before mutation at the exact expiry boundary", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const guard = new LiveWriteGuard(driver);
      const changed = census.leaves[0]!.seed;
      const fields = changed.fields.map(field => field.kind === "text"
        ? { ...field, value: `${field.value} changed` } : field);
      const ClockedCoordinator = TargetCommitCoordinator as unknown as new (
        guarded: LiveWriteGuard,
        registryValue: typeof registry,
        clock: () => number,
      ) => TargetCommitCoordinator;
      const instants = [
        Date.parse("2026-09-05T00:00:00.000Z"),
        Date.parse("2026-09-05T00:04:59.000Z"),
      ];
      let clockIndex = 0;
      const coordinator = new ClockedCoordinator(guard, registry,
        () => instants[Math.min(clockIndex++, instants.length - 1)]!);
      let invoked = false;
      expect(() => coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "q"),
        changes: [{ key: changed.key, fields }],
        mutate: () => { invoked = true; },
      })).toThrow();
      expect(invoked).toBe(false);
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { revision: "1", state: "reserved" },
      ]);
      const catalog = DeviceCatalog.openExisting(guard);
      expect(catalog.revisionReservations()).toMatchObject([
        { revision: "1", state: "reserved" },
      ]);
      expect(catalog.snapshot().catalogGeneration).toBe("3");
    } finally {
      clay.close();
    }
  });

  it("takes over an expired lease and abandons both mirrored reservations", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      const expectedTarget = target.evidence();
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const guard = new LiveWriteGuard(driver);
      const catalog = DeviceCatalog.openExisting(guard);
      const operationId = id("op", "t");
      const requestSha256 = `sha256:${"d".repeat(64)}`;
      guard.runAuthorized(() => {
        const targetReservation = TargetAuthorityStore.open(guard).reserveProtectionRevision(
          operationId, "2026-09-05T00:00:00.000Z", expectedTarget, requestSha256,
        );
        const catalogReservation = catalog.reserveSelectedProtectionRevision({
          expectedCatalogGeneration: catalogContext.expectedCatalogGeneration,
          expectedTarget,
          operationId,
          requestSha256,
          fence: catalogContext.fence,
          nowMs: Date.parse("2026-09-05T00:00:00.000Z"),
        });
        expect(catalogReservation.revision).toBe(targetReservation.revision);
      });
      expect(catalog.snapshot().catalogGeneration).toBe("3");
      const recoveryNow = Date.parse("2026-09-05T00:05:00.000Z");
      const coordinator = new TargetCommitCoordinator(guard, registry, () => recoveryNow);
      const recover = coordinator as unknown as {
        recoverExpiredReservation(input: {
          expectedAuthorityIncarnationId: string;
          expectedCatalogGeneration: string;
          expectedWriteEpoch: string;
          operationId: string;
          releaseId: string;
          ttlMs: number;
        }): unknown;
      };
      const recovery = CatalogReservationRecoveryV1.parse(recover.recoverExpiredReservation({
        expectedAuthorityIncarnationId: catalogContext.fence.authorityIncarnationId,
        expectedCatalogGeneration: "3",
        expectedWriteEpoch: catalogContext.fence.writeEpoch,
        operationId,
        releaseId: id("rel", "s"),
        ttlMs: 300_000,
      }));
      expect(recovery).toMatchObject({
        catalogGeneration: "4",
        fence: { writeEpoch: "2", releaseId: id("rel", "s") },
        abandonedReservation: {
          operationId,
          revision: "1",
          state: "abandoned",
          finalizedCatalogGeneration: "4",
          finalizedWriteEpoch: "2",
        },
      });
      expect(TargetAuthorityStore.open(guard).header()).toMatchObject({
        protectionRevision: "0", protectionRevisionHighWater: "1",
      });
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { operationId, revision: "1", state: "abandoned" },
      ]);
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "4",
        writeEpoch: "2",
        entries: [{ currentProtectionRevision: "0", revisionHighWater: "1" }],
      });
      expect(catalog.assertWriteFence(recovery.fence, recoveryNow)).toEqual(recovery.fence);
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Recovered" } : field);
      const committed = coordinator.commit({
        expectedTarget,
        expectedCatalogGeneration: recovery.catalogGeneration,
        fence: recovery.fence,
        operationId: id("op", "u"),
        changes: [{ key: row.key, fields }],
        mutate: () => guard.exec(
          "UPDATE projects SET name = ? WHERE id = ?", ["Recovered", rowId],
        ),
      });
      expect(committed.evidence.protectionRevision).toBe("2");
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
        { revision: "2", state: "committed" },
      ]);
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "6",
        entries: [{ currentProtectionRevision: "2", revisionHighWater: "2" }],
      });
      guard.runAuthorized(() => {
        guard.exec(
          "UPDATE catalog.catalog_generation_events SET event_kind='revision_abandoned' WHERE catalog_generation='4'",
        );
        guard.exec(
          `INSERT INTO catalog.catalog_generation_events(
            catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at
          ) VALUES ('7','lease_issued',?,NULL,?,?)`,
          [expectedTarget.appInstanceId, recovery.fence.writeEpoch,
            "2026-09-05T00:05:00.000Z"],
        );
        guard.exec(
          "UPDATE catalog.catalog_root SET catalog_generation='7' WHERE singleton=1",
        );
      });
      try {
        DeviceCatalog.openExisting(guard);
        expect.fail("expected E_CATALOG_UNAVAILABLE");
      } catch (error) {
        expect(error).toMatchObject({ code: "E_CATALOG_UNAVAILABLE" });
      }
    } finally {
      clay.close();
    }
  });

  it("keeps target and catalog authorities outside the public kernel API", async () => {
    const publicApi = await import("../src/index");
    expect(publicApi).not.toHaveProperty("DeviceCatalog");
    expect(publicApi).not.toHaveProperty("TargetCommitCoordinator");
    expect(publicApi).not.toHaveProperty("LiveWriteGuard");
  });

  it("commits target and selected catalog head on one operation and revision", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Catalog committed" } : field);
      const guard = new LiveWriteGuard(driver);
      const catalog = DeviceCatalog.openExisting(guard);
      const coordinator = new TargetCommitCoordinator(guard, registry, commitClock());
      const operationId = id("op", "m");
      const unexpectedOperationId = id("op", "n");
      const operationSequence = [
        operationId, operationId, operationId,
        unexpectedOperationId, operationId, unexpectedOperationId,
      ];
      let operationReads = 0;
      const result = coordinator.commit({
        expectedTarget,
        expectedCatalogGeneration: catalogContext.expectedCatalogGeneration,
        fence: catalogContext.fence,
        get operationId() {
          return operationSequence[
            Math.min(operationReads++, operationSequence.length - 1)
          ]!;
        },
        changes: [{ key: row.key, fields }],
        mutate: () => guard.exec(
          "UPDATE projects SET name = ? WHERE id = ?", ["Catalog committed", rowId],
        ),
      });
      expect(operationReads).toBe(1);
      expect(result).toMatchObject({ changed: true, evidence: { protectionRevision: "1" } });
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Catalog committed");
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { operationId, revision: "1", state: "committed",
          stateSha256: result.evidence.stateSha256 },
      ]);
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "4",
        entries: [{
          currentProtectionRevision: "1",
          revisionHighWater: "1",
          stateSha256: result.evidence.stateSha256,
        }],
      });
      expect(catalog.revisionReservations()).toMatchObject([
        { operationId, revision: "1", state: "committed",
          stateSha256: result.evidence.stateSha256 },
      ]);
    } finally {
      clay.close();
    }
  });

  it("commits one meaningful row change with Merkle, header, and journal atomically", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Changed" } : field);
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const guard = new LiveWriteGuard(driver);
      const catalog = DeviceCatalog.openExisting(guard);
      const coordinator = new TargetCommitCoordinator(guard, registry, commitClock());
      const result = coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields }],
        mutate: () => guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Changed", rowId]),
      });
      expect(result).toMatchObject({ changed: true, evidence: {
        protectionRevision: "1", stateSha256: expect.stringMatching(/^sha256:/),
      } });
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Changed");
      expect(TargetAuthorityStore.open(guard).header()).toMatchObject({
        protectionRevision: "1", protectionRevisionHighWater: "1",
      });
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { revision: "1", state: "committed",
          finalizedAt: "2026-09-05T00:01:00.000Z" },
      ]);
      let targetOnlyReplayMutation = false;
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields }],
        mutate: () => { targetOnlyReplayMutation = true; },
      })).toThrow("committed replay requires catalog authority");
      expect(targetOnlyReplayMutation).toBe(false);
      let retriedMutation = false;
      const retry = coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      });
      expect(retry).toEqual(result);
      expect(retriedMutation).toBe(false);
      expect(TargetAuthorityStore.open(guard).reservations()).toHaveLength(1);
      const beforeExpiredRetry = catalog.snapshot();
      const expiredRetry = new TargetCommitCoordinator(
        guard, registry, () => Date.parse("2026-09-05T00:05:00.000Z"),
      );
      expect(expiredRetry.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      })).toEqual(result);
      expect(retriedMutation).toBe(false);
      expect(catalog.snapshot()).toEqual(beforeExpiredRetry);
      expect(catalog.revisionReservations()).toHaveLength(1);
      const replacementFence = guard.runAuthorized(() => catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: catalogContext.fence.authorityIncarnationId,
        expectedCatalogGeneration: beforeExpiredRetry.catalogGeneration,
        expectedWriteEpoch: catalogContext.fence.writeEpoch,
        releaseId: id("rel", "s"),
        nowMs: Date.parse("2026-09-05T00:05:00.000Z"),
        ttlMs: 300_000,
      }));
      const afterReplacementLease = catalog.snapshot();
      expect(afterReplacementLease.writeEpoch).toBe(replacementFence.writeEpoch);
      expect(expiredRetry.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      })).toEqual(result);
      expect(retriedMutation).toBe(false);
      expect(catalog.snapshot()).toEqual(afterReplacementLease);
      const alteredFields = fields.map(field => field.kind === "text"
        ? { ...field, value: `${field.value} altered` } : field);
      expect(() => coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields: alteredFields }],
        mutate: () => { retriedMutation = true; },
      })).toThrow();
      expect(() => coordinator.commit({
        expectedTarget: { ...expectedTarget, stateSha256: `sha256:${"f".repeat(64)}` },
        ...catalogContext,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      })).toThrow();
      expect(retriedMutation).toBe(false);
      guard.runAuthorized(() => guard.exec(
        "UPDATE sys.target_revision_reservations SET state_sha256 = ? WHERE operation_id = ?",
        [`sha256:${"e".repeat(64)}`, id("op", "e")],
      ));
      expect(() => TargetAuthorityStore.open(guard).evidence()).toThrow();
      expect(() => coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "e"),
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      })).toThrow();
    } finally {
      clay.close();
    }
  });

  it("rolls back a failed mutation and leaves one abandoned reservation gap", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Broken" } : field);
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const guard = new LiveWriteGuard(driver);
      const catalog = DeviceCatalog.openExisting(guard);
      const coordinator = new TargetCommitCoordinator(guard, registry, commitClock());
      expect(() => coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "f"),
        changes: [{ key: row.key, fields }],
        mutate: () => {
          guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Broken", rowId]);
          throw new Error("injected mutation failure");
        },
      })).toThrow();
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Apollo");
      expect(TargetAuthorityStore.open(guard).header()).toMatchObject({
        protectionRevision: "0", protectionRevisionHighWater: "1",
      });
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
      expect(catalog.revisionReservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "4",
        entries: [{
          currentProtectionRevision: "0",
          revisionHighWater: "1",
          stateSha256: expectedTarget.stateSha256,
        }],
      });
      expect(TargetAuthorityStore.open(guard).evidence()).toEqual(expectedTarget);
    } finally {
      clay.close();
    }
  });

  it("rejects mutation of the caller-owned change set after request fingerprinting", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Changed" } : field);
      const changes = [{ key: row.key, fields }];
      let outerMapCalls = 0;
      let fieldMapCalls = 0;
      Object.defineProperty(fields, "map", {
        configurable: true,
        value: () => {
          fieldMapCalls++;
          return fields;
        },
      });
      Object.defineProperty(changes, "map", {
        configurable: true,
        value: (callback: (
          change: (typeof changes)[number],
          index: number,
          array: typeof changes,
        ) => unknown) => {
          outerMapCalls++;
          return [callback(changes[0]!, 0, changes)];
        },
      });
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const guard = new LiveWriteGuard(driver);
      const catalog = DeviceCatalog.openExisting(guard);
      const coordinator = new TargetCommitCoordinator(guard, registry, commitClock());
      expect(() => coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "g"),
        changes,
        mutate: () => {
          const mutable = changes[0]!.fields.find(field =>
            field.name === `field/${name.semantic!.fieldId}`)! as { value: string };
          mutable.value = "Tampered";
          guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Tampered", rowId]);
        },
      })).toThrow();
      expect(outerMapCalls).toBe(0);
      expect(fieldMapCalls).toBe(0);
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Apollo");
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
      expect(catalog.revisionReservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "4",
        entries: [{
          currentProtectionRevision: "0",
          revisionHighWater: "1",
          stateSha256: expectedTarget.stateSha256,
        }],
      });
    } finally {
      clay.close();
    }
  });

  it("rejects a thenable mutation result before Merkle publication", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Async" } : field);
      const catalogContext = seedCatalogForTarget(driver, expectedTarget);
      const guard = new LiveWriteGuard(driver);
      const catalog = DeviceCatalog.openExisting(guard);
      const coordinator = new TargetCommitCoordinator(guard, registry, commitClock());
      expect(() => coordinator.commit({
        expectedTarget,
        ...catalogContext,
        operationId: id("op", "h"),
        changes: [{ key: row.key, fields }],
        mutate: (() => {
          guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Async", rowId]);
          return Promise.resolve();
        }) as unknown as () => void,
      })).toThrow();
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Apollo");
      expect(TargetAuthorityStore.open(guard).reservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
      expect(catalog.revisionReservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "4",
        entries: [{
          currentProtectionRevision: "0",
          revisionHighWater: "1",
          stateSha256: expectedTarget.stateSha256,
        }],
      });
    } finally {
      clay.close();
    }
  });
});
