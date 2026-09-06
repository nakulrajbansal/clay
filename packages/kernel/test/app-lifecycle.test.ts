import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver, type DbDriver } from "../src/index";
import { copyAppStateToFreshTarget } from "../src/app-generation";
import { captureAppLifecycleRequest } from "../src/app-lifecycle-request";
import { DeviceCatalog } from "../src/device-catalog";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const digest = (char: string): string => `sha256:${char.repeat(64)}`;

async function seededCatalog(): Promise<{ driver: DbDriver; catalog: DeviceCatalog }> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const catalog = DeviceCatalog.initializeFresh(driver);
  catalog.seedSelectedTarget({
    target: {
      appInstanceId: id("app", "a"),
      activeGenerationId: id("gen", "b"),
      lineageEpoch: "0",
      protectionRevision: "0",
      digestSchema: 1,
      stateSha256: digest("c"),
    },
    namespaceId: id("ns", "d"),
    storageKey: "default",
    displayName: "Projects",
    shellId: "tracker",
    operationId: id("op", "e"),
    at: "2026-09-06T00:00:00.000Z",
  });
  return { driver, catalog };
}

function lease(catalog: DeviceCatalog) {
  const before = catalog.snapshot();
  return catalog.acquireWriteLease({
    expectedAuthorityIncarnationId: before.authorityIncarnationId,
    expectedCatalogGeneration: before.catalogGeneration,
    expectedWriteEpoch: before.writeEpoch,
    releaseId: id("rel", "f"),
    nowMs: 1_000,
    ttlMs: 60_000,
  });
}

describe("worker-owned app lifecycle catalog", () => {
  it("declares an exact pending physical target before publishing an app", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      const fence = lease(catalog);
      const expectedTarget = catalog.selectedTargetStorage().target;
      const target = {
        appInstanceId: id("app", "g"),
        generationId: id("gen", "h"),
        namespaceId: id("ns", "i"),
        storageKey: id("ns", "i"),
        userFile: `/${id("ns", "i")}-user.db`,
        systemFile: `/${id("ns", "i")}-system.db`,
        storageKind: "generation" as const,
        displayName: "Inventory",
        shellId: "inventory",
      };
      const job = catalog.declareAppGeneration({
        kind: "create",
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget,
        target,
        jobId: id("job", "j"),
        operationId: id("op", "k"),
        requestSha256: digest("d"),
        fence,
        nowMs: 2_000,
      });

      expect(job).toMatchObject({
        kind: "create",
        jobId: id("job", "j"),
        operationId: id("op", "k"),
        expectedTarget,
        target,
      });
      expect(catalog.pendingLifecycleJobs()).toEqual([job]);
      expect(catalog.legacyBootstrapManifest()).toEqual([{
        storageKey: target.storageKey,
        userFile: target.userFile,
        systemFile: target.systemFile,
        kind: "generation",
        appInstanceId: target.appInstanceId,
        generationId: target.generationId,
        namespaceId: target.namespaceId,
        operationId: id("op", "k"),
        displayName: target.displayName,
        shellId: target.shellId,
        selected: true,
      }]);
      expect(catalog.snapshot()).toMatchObject({
        catalogGeneration: "3",
        selectedAppInstanceId: expectedTarget.appInstanceId,
      });
      expect(catalog.activeTargetStorageInventory()).toHaveLength(1);
    } finally {
      driver.close();
    }
  });

  it("publishes only the declared target identity and clears its pending declaration", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      const fence = lease(catalog);
      const expectedTarget = catalog.selectedTargetStorage().target;
      const target = {
        appInstanceId: id("app", "g"), generationId: id("gen", "h"),
        namespaceId: id("ns", "i"), storageKey: id("ns", "i"),
        userFile: `/${id("ns", "i")}-user.db`,
        systemFile: `/${id("ns", "i")}-system.db`, storageKind: "generation" as const,
        displayName: "Inventory", shellId: "inventory",
      };
      const job = catalog.declareAppGeneration({
        kind: "create", expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget, target, jobId: id("job", "j"), operationId: id("op", "k"),
        requestSha256: digest("d"), fence, nowMs: 2_000,
      });
      const publishedTarget = {
        appInstanceId: target.appInstanceId,
        activeGenerationId: target.generationId,
        lineageEpoch: "0",
        protectionRevision: "0",
        digestSchema: 1 as const,
        stateSha256: digest("f"),
      };

      const snapshot = catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: job.declaredCatalogGeneration,
        jobId: job.jobId,
        publishedTarget,
        fence,
        nowMs: 3_000,
      });

      expect(snapshot).toMatchObject({
        catalogGeneration: "4",
        selectedAppInstanceId: target.appInstanceId,
        entries: expect.arrayContaining([expect.objectContaining({
          appInstanceId: target.appInstanceId,
          activeGenerationId: target.generationId,
          displayName: "Inventory",
          stateSha256: digest("f"),
        })]),
      });
      expect(catalog.pendingLifecycleJobs()).toEqual([]);
      expect(catalog.legacyBootstrapManifest()).toEqual([]);
      expect(catalog.activeTargetStorageInventory()).toHaveLength(2);
    } finally {
      driver.close();
    }
  });

  it("binds a fork declaration and its immutable descriptor to the selected source", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      const fence = lease(catalog);
      const source = catalog.selectedTargetStorage().target;
      const target = {
        appInstanceId: id("app", "g"), generationId: id("gen", "h"),
        namespaceId: id("ns", "i"), storageKey: id("ns", "i"),
        userFile: `/${id("ns", "i")}-user.db`,
        systemFile: `/${id("ns", "i")}-system.db`, storageKind: "generation" as const,
        displayName: "Projects (copy)", shellId: "tracker",
      };
      const job = catalog.declareAppGeneration({
        kind: "fork", expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget: source, target, jobId: id("job", "j"), operationId: id("op", "k"),
        requestSha256: digest("d"), fence, nowMs: 2_000,
      });
      catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: job.declaredCatalogGeneration, jobId: job.jobId,
        publishedTarget: {
          appInstanceId: target.appInstanceId, activeGenerationId: target.generationId,
          lineageEpoch: "0", protectionRevision: "0", digestSchema: 1,
          stateSha256: source.stateSha256,
        },
        fence, nowMs: 3_000,
      });

      expect(catalog.generationDescriptors()).toContainEqual(expect.objectContaining({
        generationId: target.generationId,
        sourceProvenanceId: id("op", "e"),
      }));
    } finally {
      driver.close();
    }
  });

  it("tombstones the selected app, selects a deterministic fallback, and declares cleanup", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      let fence = lease(catalog);
      const source = catalog.selectedTargetStorage().target;
      const second = {
        appInstanceId: id("app", "g"), generationId: id("gen", "h"),
        namespaceId: id("ns", "i"), storageKey: id("ns", "i"),
        userFile: `/${id("ns", "i")}-user.db`,
        systemFile: `/${id("ns", "i")}-system.db`, storageKind: "generation" as const,
        displayName: "Inventory", shellId: "inventory",
      };
      const create = catalog.declareAppGeneration({
        kind: "create", expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget: source, target: second, jobId: id("job", "j"),
        operationId: id("op", "k"), requestSha256: digest("d"), fence, nowMs: 2_000,
      });
      catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: create.declaredCatalogGeneration, jobId: create.jobId,
        publishedTarget: {
          appInstanceId: second.appInstanceId, activeGenerationId: second.generationId,
          lineageEpoch: "0", protectionRevision: "0", digestSchema: 1,
          stateSha256: digest("f"),
        },
        fence, nowMs: 3_000,
      });
      fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: catalog.snapshot().authorityIncarnationId,
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedWriteEpoch: catalog.snapshot().writeEpoch,
        releaseId: id("rel", "r"), nowMs: 4_000, ttlMs: 60_000,
      });
      const selected = catalog.selectedTargetStorage().target;

      const deleted = catalog.deleteSelectedApp({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget: selected,
        jobId: id("job", "l"), operationId: id("op", "m"),
        requestSha256: digest("e"), fence, nowMs: 5_000,
      });

      expect(deleted.snapshot).toMatchObject({
        selectedAppInstanceId: source.appInstanceId,
        entries: [expect.objectContaining({ appInstanceId: source.appInstanceId })],
      });
      expect(driver.select(
        "SELECT tombstoned FROM catalog.app_entries WHERE app_instance_id = ?",
        [second.appInstanceId],
      )).toEqual([{ tombstoned: 1 }]);
      expect(deleted.cleanupJob).toMatchObject({
        kind: "cleanup",
        target: expect.objectContaining({
          appInstanceId: second.appInstanceId,
          generationId: second.generationId,
          storageKey: second.storageKey,
        }),
        expectedTarget: source,
      });
      expect(catalog.pendingLifecycleJobs()).toEqual([deleted.cleanupJob]);
      expect(catalog.activeTargetStorageInventory()).toHaveLength(1);
      driver.exec(
        "UPDATE catalog.catalog_generation_events SET event_kind = 'lifecycle_cleaned' WHERE event_kind = 'app_deleted'",
      );
      expect(() => DeviceCatalog.openExisting(driver)).toThrow(/catalog|tombstone|deletion/i);
      driver.exec(
        "UPDATE catalog.catalog_generation_events SET event_kind = 'app_deleted' WHERE event_kind = 'lifecycle_cleaned'",
      );

      const resumed = DeviceCatalog.openExisting(driver);
      resumed.completeLifecycleCleanup({
        expectedCatalogGeneration: deleted.snapshot.catalogGeneration,
        jobId: deleted.cleanupJob.jobId,
        cleanupConfirmed: true,
        fence,
        nowMs: 6_000,
      });
      expect(resumed.pendingLifecycleJobs()).toEqual([]);
      expect(driver.select(
        "SELECT tombstoned FROM catalog.app_entries WHERE app_instance_id = ?",
        [second.appInstanceId],
      )).toEqual([{ tombstoned: 1 }]);
    } finally {
      driver.close();
    }
  });

  it("resets through a fresh declared generation and only then tombstones the original", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      const fence = lease(catalog);
      const original = catalog.selectedTargetStorage();
      const replacement = {
        appInstanceId: id("app", "g"), generationId: id("gen", "h"),
        namespaceId: id("ns", "i"), storageKey: id("ns", "i"),
        userFile: `/${id("ns", "i")}-user.db`,
        systemFile: `/${id("ns", "i")}-system.db`, storageKind: "generation" as const,
        displayName: "Projects", shellId: "tracker",
      };
      const pending = catalog.declareAppGeneration({
        kind: "reset", expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget: original.target, target: replacement,
        jobId: id("job", "j"), operationId: id("op", "k"),
        requestSha256: digest("d"), fence, nowMs: 2_000,
      });
      expect(catalog.snapshot().selectedAppInstanceId).toBe(original.target.appInstanceId);

      const snapshot = catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: pending.declaredCatalogGeneration,
        jobId: pending.jobId,
        publishedTarget: {
          appInstanceId: replacement.appInstanceId,
          activeGenerationId: replacement.generationId,
          lineageEpoch: "0", protectionRevision: "0", digestSchema: 1,
          stateSha256: digest("f"),
        },
        replacementCleanup: {
          jobId: id("job", "l"), operationId: id("op", "m"),
          requestSha256: digest("e"),
        },
        fence,
        nowMs: 3_000,
      });

      expect(snapshot.selectedAppInstanceId).toBe(replacement.appInstanceId);
      expect(snapshot.entries).toEqual([expect.objectContaining({
        appInstanceId: replacement.appInstanceId,
        activeGenerationId: replacement.generationId,
      })]);
      expect(driver.select(
        "SELECT tombstoned FROM catalog.app_entries WHERE app_instance_id = ?",
        [original.target.appInstanceId],
      )).toEqual([{ tombstoned: 1 }]);
      expect(catalog.pendingLifecycleJobs()).toEqual([expect.objectContaining({
        kind: "cleanup",
        target: expect.objectContaining({
          appInstanceId: original.target.appInstanceId,
          generationId: original.target.activeGenerationId,
          storageKey: original.storageKey,
        }),
      })]);
      driver.exec(
        "UPDATE catalog.catalog_generation_events SET event_kind = 'lifecycle_cleaned' WHERE event_kind = 'app_deleted'",
      );
      expect(() => DeviceCatalog.openExisting(driver)).toThrow(/catalog|tombstone|deletion/i);
    } finally {
      driver.close();
    }
  });
});

describe("fresh generation copies", () => {
  it("forks canonical app state into an empty target without mutating the source", async () => {
    const sourceDriver = await openMemoryDriver();
    const targetDriver = await openMemoryDriver();
    const source = ClayStore.fromDriver(sourceDriver);
    try {
      const operations = [{
        op: "create_table" as const,
        table: "projects",
        columns: [{ name: "name", type: "text" as const, required: true }],
      }];
      source.commit({
        intent: "create projects",
        summary: "Creates projects.",
        semanticOrigin: "direct",
        migration: {
          operations,
          inverse: deriveInverse(operations, source.registrySnapshot()),
        },
        panels: [],
        diff: [],
      });
      source.insert("projects", { name: "Source row" });

      const fork = copyAppStateToFreshTarget(
        sourceDriver, targetDriver, source.validationRegistrySnapshot(),
      );
      expect(fork.query({ from: "projects" })).toEqual(source.query({ from: "projects" }));
      fork.insert("projects", { name: "Fork-only row" });
      expect(source.query({ from: "projects" })).toHaveLength(1);
      expect(fork.query({ from: "projects" })).toHaveLength(2);
      fork.close();
    } finally {
      try { source.close(); } catch { /* already closed */ }
      try { targetDriver.close(); } catch { /* closed with fork */ }
    }
  });
});

describe("lifecycle request capture", () => {
  it("captures exact descriptor-only fields without invoking nested getters", () => {
    let getterCalls = 0;
    const request = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(request, {
      kind: { value: "create", enumerable: true },
      requestId: { value: id("req", "a"), enumerable: true },
      displayName: {
        enumerable: true,
        get() { getterCalls += 1; return "Projects"; },
      },
      shellId: { value: "tracker", enumerable: true },
    });

    expect(() => captureAppLifecycleRequest(request)).toThrow("plain data");
    expect(getterCalls).toBe(0);
  });

  it("rejects an aggregate request over two million UTF-8 bytes before durable work", () => {
    const request = {
      kind: "create",
      requestId: id("req", "a"),
      displayName: "x".repeat(2_000_001),
      shellId: "tracker",
    };
    expect(() => captureAppLifecycleRequest(request)).toThrow(/budget|display name/);
  });
});
