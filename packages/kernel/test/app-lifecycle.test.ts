import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver, type DbDriver } from "../src/index";
import { copyAppStateToFreshTarget } from "../src/app-generation";
import { captureAppLifecycleRequest, captureAppImportRequest } from "../src/app-lifecycle-request";
import { DeviceCatalog } from "../src/device-catalog";
import { pendingRowsForArchive } from "../src/catalog-pending";

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
  it.each(["switch", "rename"] as const)("retains canonical %s no-op receipts and denies stale historical replay", async kind => {
    const { driver, catalog } = await seededCatalog();
    try {
      const fence = lease(catalog);
      const selected = catalog.selectedTargetStorage().target;
      const operationId = id("op", "p");
      const args = { expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        operationId, fence, nowMs: 2_000, recordNoop: true };
      const after = kind === "switch"
        ? catalog.selectApp({ ...args, appInstanceId: selected.appInstanceId })
        : catalog.updateSelectedAppMetadata({ ...args, displayName: "Projects", shellId: "tracker" });
      const receipt = catalog.recordAppLifecycleReceipt({ kind, requestId: id("req", "q"),
        requestSha256: digest("a"), jobId: id("job", "r"), operationId,
        requestedAppInstanceId: selected.appInstanceId, expectedCatalogGeneration: after.catalogGeneration,
        completedAt: new Date(2_000).toISOString() });
      expect(receipt).toMatchObject({ schema: 2, resultTarget: selected, resultDisplayName: "Projects" });
      expect(catalog.assertAppLifecycleReplay(receipt)).toEqual(receipt);
      const refreshed = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: catalog.snapshot().authorityIncarnationId,
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedWriteEpoch: catalog.snapshot().writeEpoch, releaseId: id("rel", "s"), nowMs: 3_000, ttlMs: 60_000,
      });
      expect(catalog.assertAppLifecycleReplay(receipt)).toEqual(receipt);
      catalog.updateSelectedAppMetadata({ expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        displayName: "Later rename", shellId: "tracker", operationId: id("op", "t"), fence: refreshed, nowMs: 4_000 });
      expect(() => catalog.assertAppLifecycleReplay(receipt)).toThrow(/stale|result/);
    } finally { driver.close(); }
  });
  it("rejects every unrecognized physical pending row instead of filtering it away", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      driver.exec(`INSERT INTO catalog.pending_jobs(
        job_id,authority_incarnation_id,app_instance_id,generation_id,namespace_id,
        kind,state,operation_id,source_archive_sha256,source_provenance_id,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id("job", "q"), catalog.snapshot().authorityIncarnationId, id("app", "a"),
        id("gen", "b"), id("ns", "d"), "future_delete", "prepared", id("op", "r"),
        digest("a"), "unknown-v1", "2026-09-06T00:00:00.000Z", "2026-09-06T00:00:00.000Z",
      ]);
      expect(() => catalog.snapshot()).toThrow(/validation|pending/);
      expect(() => catalog.pendingLifecycleJobs()).toThrow(/validation|pending/);
    } finally { driver.close(); }
  });
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
        requestId: id("req", "n"),
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
        selectedAppInstanceId: expectedTarget.appInstanceId,
      });
      expect(catalog.activeTargetStorageInventory()).toHaveLength(1);
      expect(() => pendingRowsForArchive(driver)).toThrow(/unfinished lifecycle/);
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
        kind: "create", requestId: id("req", "n"),
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
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

      const recoveryFence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: catalog.snapshot().authorityIncarnationId,
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedWriteEpoch: catalog.snapshot().writeEpoch,
        releaseId: id("rel", "t"), nowMs: 2_100, ttlMs: 60_000,
      });
      const claimed = catalog.claimPendingLifecycleRecovery({ expectedJob: job, fence: recoveryFence, nowMs: 2_200 });
      expect(claimed.recoveryFence).toEqual(recoveryFence);
      expect(() => catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        jobId: job.jobId, publishedTarget, fence, nowMs: 2_300,
      })).toThrow(/fence|stale|lease/i);

      const snapshot = catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        jobId: job.jobId,
        publishedTarget,
        fence: recoveryFence,
        nowMs: 3_000,
      });

      expect(snapshot).toMatchObject({
        selectedAppInstanceId: target.appInstanceId,
        entries: expect.arrayContaining([expect.objectContaining({
          appInstanceId: target.appInstanceId,
          activeGenerationId: target.generationId,
          displayName: "Inventory",
          stateSha256: digest("f"),
        })]),
      });
      expect(catalog.pendingLifecycleJobs()).toEqual([]);
      expect(catalog.appLifecycleReceipt(id("req", "n"))).toMatchObject({
        kind: "create",
        requestSha256: digest("d"),
        resultingSelectedAppInstanceId: target.appInstanceId,
      });
      expect(catalog.legacyBootstrapManifest()).toEqual([]);
      expect(catalog.activeTargetStorageInventory()).toHaveLength(2);
      // An old snapshot must never authorize physical deletion after publication won.
      expect(() => catalog.claimPendingLifecycleRecovery({
        expectedJob: claimed, fence: recoveryFence, nowMs: 3_100,
      })).toThrow(/claim|pending|stale/i);
      expect(() => pendingRowsForArchive(driver)).toThrow(/cannot omit lifecycle receipts/);
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
        kind: "create", requestId: id("req", "n"),
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget: source, target: second, jobId: id("job", "j"),
        operationId: id("op", "k"), requestSha256: digest("d"), fence, nowMs: 2_000,
      });
      catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        jobId: create.jobId,
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
        requestId: id("req", "o"),
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

      fence = catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: deleted.snapshot.authorityIncarnationId,
        expectedCatalogGeneration: deleted.snapshot.catalogGeneration,
        expectedWriteEpoch: deleted.snapshot.writeEpoch,
        releaseId: id("rel", "s"), nowMs: 5_500, ttlMs: 60_000,
      });
      const resumed = DeviceCatalog.openExisting(driver);
      resumed.completeLifecycleCleanup({
        expectedCatalogGeneration: resumed.snapshot().catalogGeneration,
        jobId: deleted.cleanupJob.jobId,
        cleanupConfirmed: true,
        fence,
        nowMs: 6_000,
      });
      expect(resumed.pendingLifecycleJobs()).toEqual([]);
      expect(resumed.appLifecycleReceipt(id("req", "o"))).toMatchObject({
        kind: "delete",
        requestedAppInstanceId: second.appInstanceId,
        resultingSelectedAppInstanceId: source.appInstanceId,
      });
    } finally {
      driver.close();
    }
  });

  it("refuses to delete the last usable app", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      const fence = lease(catalog);
      expect(() => catalog.deleteSelectedApp({
        requestId: id("req", "n"),
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget: catalog.selectedTargetStorage().target,
        jobId: id("job", "j"), operationId: id("op", "k"),
        requestSha256: digest("d"), fence, nowMs: 2_000,
      })).toThrow("the last live app cannot be deleted");
    } finally {
      driver.close();
    }
  });

  it("durably replays exact metadata receipts and rejects cross-route request reuse", async () => {
    const { driver, catalog } = await seededCatalog();
    try {
      const fence = lease(catalog);
      const selected = catalog.selectedTargetStorage().target;
      const operationId = id("op", "p");
      const requestId = id("req", "q");
      const jobId = id("job", "r");
      const completedAt = new Date(2_000).toISOString();
      const after = catalog.updateSelectedAppMetadata({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        displayName: "Renamed Projects",
        shellId: "tracker",
        operationId,
        fence,
        nowMs: 2_000,
      });
      const input = {
        kind: "rename" as const,
        requestId,
        requestSha256: digest("a"),
        jobId,
        operationId,
        requestedAppInstanceId: selected.appInstanceId,
        expectedCatalogGeneration: after.catalogGeneration,
        completedAt,
      };

      const receipt = catalog.recordAppLifecycleReceipt(input);
      expect(receipt).toMatchObject({
        kind: "rename",
        requestId,
        resultingSelectedAppInstanceId: selected.appInstanceId,
        completedCatalogGeneration: after.catalogGeneration,
      });
      expect(catalog.recordAppLifecycleReceipt(input)).toEqual(receipt);
      expect(DeviceCatalog.openExisting(driver).appLifecycleReceipt(requestId)).toEqual(receipt);
      expect(() => catalog.recordAppLifecycleReceipt({
        ...input,
        kind: "switch",
      })).toThrow(/reused/i);
      // A pre-review v1 receipt must not strand an otherwise valid user's app.
      // It remains historical evidence only, never an authorization to replay.
      const legacy = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
      legacy.schema = 1;
      delete legacy.resultTarget; delete legacy.resultDisplayName; delete legacy.resultShellId;
      driver.exec("UPDATE catalog.pending_jobs SET state = ? WHERE job_id = ?", [JSON.stringify(legacy), jobId]);
      expect(() => DeviceCatalog.openExisting(driver).snapshot()).not.toThrow();
      expect(() => catalog.assertAppLifecycleReplay(catalog.appLifecycleReceipt(requestId)!)).toThrow(/canonical|stale/);
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
        panels: [{
          panel_id: "projects_table",
          title: "Projects",
          placement: { region: "main", order: 0 },
          code: "export default function(clay){/* lifecycle copy fixture */}",
          declared_queries: [{ from: "projects" }],
          declared_writes: [],
        }],
        diff: [],
      });
      source.insert("projects", { name: "Source row" });

      const sourceHistory = source.history();
      const sourcePanels = source.livePanels();

      const fork = copyAppStateToFreshTarget(
        sourceDriver, targetDriver, source.validationRegistrySnapshot(),
      );
      expect(fork.query({ from: "projects" })).toEqual(source.query({ from: "projects" }));
      expect(fork.history()).toEqual(sourceHistory);
      expect(fork.livePanels()).toEqual(sourcePanels);
      fork.insert("projects", { name: "Fork-only row" });
      expect(source.query({ from: "projects" })).toHaveLength(1);
      expect(fork.query({ from: "projects" })).toHaveLength(2);
      expect(source.history()).toEqual(sourceHistory);
      expect(source.livePanels()).toEqual(sourcePanels);
      fork.close();
    } finally {
      try { source.close(); } catch { /* already closed */ }
      try { targetDriver.close(); } catch { /* closed with fork */ }
    }
  });
});

describe("lifecycle request capture", () => {
  it("caps the complete import envelope at exactly 2,000,000 UTF-8 bytes", () => {
    const request = { createRequestId: id("req", "a"), requestId: id("req", "b"), payload: {
      table: "records", columns: [{ name: "name", type: "text" }], rows: [{ name: "x".repeat(999_900) }, { name: "" }],
    } };
    const remaining = 2_000_000 - new TextEncoder().encode(JSON.stringify(request)).byteLength;
    request.payload.rows[1]!.name = "x".repeat(remaining);
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBe(2_000_000);
    expect(() => captureAppImportRequest(request)).not.toThrow();
    request.payload.rows[1]!.name += "x";
    expect(() => captureAppImportRequest(request)).toThrow(/2,000,000/);
  });
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
