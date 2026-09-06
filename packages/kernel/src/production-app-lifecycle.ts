import type {
  PendingTargetLifecycleJobV1 as PendingTargetLifecycleJob,
  TargetEvidenceV1 as TargetEvidence,
  WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import { copyAppStateToFreshTarget } from "./app-generation";
import {
  captureAppLifecycleRequest,
  deriveLifecycleId,
  lifecycleRequestSha256,
} from "./app-lifecycle-request";
import { enumerateCanonicalStateV1 } from "./canonical-state";
import {
  browserDurableFileNames,
  browserDurableInventory,
  deleteBrowserNamespaceStorage,
  openBrowserCatalogProbe,
  openBrowserProductionTarget,
  type DbDriver,
} from "./db";
import { DeviceCatalog } from "./device-catalog";
import {
  physicalNamespaceEntry,
  type DurableNamespaceInventoryEntry,
} from "./durable-inventory";
import { ClayError } from "./errors";
import {
  createLiveWriteGuard,
  type LiveWriteSession,
} from "./live-write-guard";
import {
  ProductionStoreAuthority,
  productionLifecycleContext,
} from "./production-authority";
import { mintProductionAuthorityId } from "./production-mutation-coordinator";
import { StateMerkleIndex } from "./state-merkle-index";
import { ClayStore } from "./store";
import { TargetAuthorityStore } from "./target-authority";

function invalid(message: string): ClayError {
  return new ClayError("E_CATALOG_UNAVAILABLE", message);
}

function sameTarget(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function physicalForLifecycleJob(
  job: PendingTargetLifecycleJob,
): DurableNamespaceInventoryEntry {
  return {
    storageKey: job.target.storageKey,
    userFile: job.target.userFile,
    systemFile: job.target.systemFile,
    kind: job.target.storageKind,
  };
}

function acquireLifecycleFence(
  session: LiveWriteSession,
  releaseId: string,
  nowMs: number,
  leaseTtlMs: number,
): WriteFence {
  const catalog = DeviceCatalog.openExisting(session.driver);
  const snapshot = catalog.snapshot();
  if (catalog.revisionReservations().some(reservation => reservation.state === "reserved"))
    throw invalid("lifecycle operation cannot cross an active target reservation");
  return session.authority.run(() => catalog.acquireWriteLease({
    expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
    expectedCatalogGeneration: snapshot.catalogGeneration,
    expectedWriteEpoch: snapshot.writeEpoch,
    releaseId,
    nowMs,
    ttlMs: leaseTtlMs,
  }));
}

function initializeDeclaredBrowserTarget(
  sourceDriver: DbDriver,
  sourceStore: ClayStore,
  targetSession: LiveWriteSession,
  job: PendingTargetLifecycleJob,
  fence: WriteFence,
  nowMs: number,
): ClayStore {
  if (job.kind === "cleanup") throw invalid("cleanup job cannot initialize a target");
  let openedStore: ClayStore | null = null;
  targetSession.authority.run(() => {
    targetSession.driver.tx(() => {
      const catalog = DeviceCatalog.openExisting(targetSession.driver);
      catalog.assertWriteFence(fence, nowMs);
      const persisted = catalog.pendingLifecycleJobs().find(item => item.jobId === job.jobId);
      if (!persisted || JSON.stringify(persisted) !== JSON.stringify(job)
          || !sameTarget(catalog.selectedTargetStorage().target, job.expectedTarget))
        throw invalid("lifecycle target declaration changed before physical creation");
      openedStore = job.kind === "fork"
        ? copyAppStateToFreshTarget(
          sourceDriver, targetSession.driver, sourceStore.validationRegistrySnapshot(),
        )
        : ClayStore.fromDriver(targetSession.driver);
      if (openedStore.getSetting<number>("current_version") === undefined)
        openedStore.setSetting("current_version", openedStore.headVersion());
      const registry = openedStore.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(targetSession.driver, registry);
      StateMerkleIndex.createSchema(targetSession.driver);
      StateMerkleIndex.initialize(targetSession.driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(targetSession.driver);
      const target = TargetAuthorityStore.initialize(targetSession.driver, {
        schema: 1,
        appInstanceId: job.target.appInstanceId,
        activeGenerationId: job.target.generationId,
        lineageEpoch: "0",
        lineageEpochHighWater: "0",
        protectionRevision: "0",
        protectionRevisionHighWater: "0",
        digestSchema: 1,
      }).evidence();
      const replacementCleanup = job.kind === "reset" ? {
        jobId: deriveLifecycleId(
          "job", job.authorityIncarnationId, job.operationId, "reset-cleanup-job",
        ),
        operationId: deriveLifecycleId(
          "op", job.authorityIncarnationId, job.operationId, "reset-cleanup-operation",
        ),
        requestSha256: job.requestSha256,
      } : undefined;
      catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        jobId: job.jobId,
        publishedTarget: target,
        replacementCleanup,
        fence,
        nowMs,
      });
      const audited = enumerateCanonicalStateV1(targetSession.driver, registry);
      const merkle = StateMerkleIndex.open(targetSession.driver).audit();
      if (audited.stateSha256 !== target.stateSha256
          || audited.stateSha256 !== merkle.stateSha256
          || audited.leaves.length !== merkle.leafCount)
        throw invalid("lifecycle target failed canonical read-back");
    });
  });
  if (!openedStore) throw invalid("lifecycle target did not produce a Store");
  return openedStore;
}

async function completeBrowserCleanup(job: PendingTargetLifecycleJob): Promise<void> {
  if (job.kind !== "cleanup") throw invalid("lifecycle cleanup job is invalid");
  await deleteBrowserNamespaceStorage(physicalForLifecycleJob(job));
  const session = createLiveWriteGuard(await openBrowserCatalogProbe());
  try {
    const nowMs = Date.now();
    const fence = acquireLifecycleFence(
      session, mintProductionAuthorityId("rel"), nowMs, 60_000,
    );
    session.authority.run(() => {
      const catalog = DeviceCatalog.openExisting(session.driver);
      catalog.completeLifecycleCleanup({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        jobId: job.jobId,
        cleanupConfirmed: true,
        fence,
        nowMs,
      });
    });
  } finally {
    session.driver.close();
  }
}

/** Resume every catalog-declared physical target or cleanup before normal boot inventory. */
export async function reconcilePendingBrowserLifecycle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const names = await browserDurableFileNames();
    if (!names.includes("/clay-device-catalog-v1.db")) return;
    const probe = await openBrowserCatalogProbe();
    let job: PendingTargetLifecycleJob | null = null;
    let selectedStorage: ReturnType<DeviceCatalog["selectedTargetStorage"]> | null = null;
    try {
      if (DeviceCatalog.isAbsent(probe)) return;
      const catalog = DeviceCatalog.openExisting(probe);
      const jobs = catalog.pendingLifecycleJobs();
      if (jobs.length === 0) return;
      if (jobs.length !== 1) throw invalid("multiple lifecycle recoveries are ambiguous");
      job = jobs[0]!;
      selectedStorage = catalog.selectedTargetStorage();
    } finally {
      probe.close();
    }
    if (!job || !selectedStorage) throw invalid("lifecycle recovery evidence is incomplete");
    if (job.kind === "cleanup") {
      await completeBrowserCleanup(job);
      continue;
    }

    // Pending targets are disposable until publication. Rebuild the exact
    // declaration to recover absent, half-created, or unpublished files.
    await deleteBrowserNamespaceStorage(physicalForLifecycleJob(job));
    const sourcePhysical = physicalNamespaceEntry(
      selectedStorage.storageKey, selectedStorage.namespaceId,
    );
    const sourceSession = createLiveWriteGuard(
      await openBrowserProductionTarget(sourcePhysical),
    );
    let sourceStore: ClayStore | null = null;
    try {
      sourceSession.authority.run(() => {
        const catalog = DeviceCatalog.openExisting(sourceSession.driver);
        const persisted = catalog.pendingLifecycleJobs().find(item => item.jobId === job!.jobId);
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(job)
            || !sameTarget(catalog.selectedTargetStorage().target, job!.expectedTarget)
            || !sameTarget(
              TargetAuthorityStore.open(sourceSession.driver).evidence(), job!.expectedTarget,
            ))
          throw invalid("lifecycle recovery source identity changed");
        sourceStore = ClayStore.fromDriver(sourceSession.driver);
        const census = enumerateCanonicalStateV1(
          sourceSession.driver, sourceStore.validationRegistrySnapshot(),
        );
        const merkle = StateMerkleIndex.open(sourceSession.driver).audit();
        if (census.stateSha256 !== job!.expectedTarget.stateSha256
            || census.stateSha256 !== merkle.stateSha256
            || census.leaves.length !== merkle.leafCount)
          throw invalid("lifecycle recovery source failed canonical read-back");
      });
      if (!sourceStore) throw invalid("lifecycle recovery source did not produce a Store");
      const openedSource = sourceStore as ClayStore;
      const nowMs = Date.now();
      const fence = acquireLifecycleFence(
        sourceSession, mintProductionAuthorityId("rel"), nowMs, 60_000,
      );
      const targetSession = createLiveWriteGuard(
        await openBrowserProductionTarget(physicalForLifecycleJob(job)),
      );
      let targetStore: ClayStore | null = null;
      let cleanup: PendingTargetLifecycleJob | null = null;
      try {
        targetStore = initializeDeclaredBrowserTarget(
          sourceSession.driver, openedSource, targetSession, job, fence, nowMs,
        );
        cleanup = DeviceCatalog.openExisting(targetSession.driver).pendingLifecycleJobs()
          .find(item => item.kind === "cleanup") ?? null;
      } catch (error) {
        try { targetSession.driver.close(); } catch { /* already closed */ }
        throw error;
      }
      targetStore.close();
      openedSource.close();
      if (cleanup) await completeBrowserCleanup(cleanup);
    } finally {
      try { sourceSession.driver.close(); } catch { /* already closed */ }
    }
  }
  throw invalid("lifecycle recovery did not converge");
}

/** Execute a serialized worker-owned lifecycle transition. */
export async function executeProductionAppLifecycle(
  authority: ProductionStoreAuthority,
  input: unknown,
): Promise<ProductionStoreAuthority> {
  const request = captureAppLifecycleRequest(input);
  const context = productionLifecycleContext(authority);
  const session: LiveWriteSession = {
    driver: context.driver,
    authority: context.writeAuthority,
  };
  const nowMs = Date.now();
  const catalog = DeviceCatalog.openExisting(context.driver);
  const before = catalog.snapshot();
  const selected = catalog.selectedTargetStorage().target;
  const target = TargetAuthorityStore.open(context.driver).evidence();
  if (!sameTarget(selected, target))
    throw invalid("catalog and target authority disagree before lifecycle operation");
  const fence = acquireLifecycleFence(
    session, mintProductionAuthorityId("rel"), nowMs, context.leaseTtlMs,
  );
  const authorityId = before.authorityIncarnationId;
  const operationId = deriveLifecycleId(
    "op", authorityId, request.requestId, `${request.kind}-operation`,
  );
  const requestSha256 = lifecycleRequestSha256(request);

  if (request.kind === "switch") {
    context.writeAuthority.run(() => DeviceCatalog.openExisting(context.driver).selectApp({
      expectedCatalogGeneration: DeviceCatalog.openExisting(context.driver)
        .snapshot().catalogGeneration,
      appInstanceId: request.appInstanceId,
      operationId,
      fence,
      nowMs,
    }));
    authority.close();
    return ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  }

  if (request.kind === "rename") {
    if (request.appInstanceId !== selected.appInstanceId)
      throw new ClayError("E_GENERATION_NOT_SELECTED", "only the selected app can be renamed");
    const current = DeviceCatalog.openExisting(context.driver).snapshot().entries.find(entry =>
      entry.appInstanceId === selected.appInstanceId);
    if (!current) throw invalid("selected app metadata is unavailable");
    context.writeAuthority.run(() => {
      const activeCatalog = DeviceCatalog.openExisting(context.driver);
      activeCatalog.updateSelectedAppMetadata({
        expectedCatalogGeneration: activeCatalog.snapshot().catalogGeneration,
        displayName: request.displayName,
        shellId: request.shellId ?? current.shellId,
        operationId,
        fence,
        nowMs,
      });
    });
    authority.close();
    return ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  }

  if (request.kind === "delete") {
    if (request.appInstanceId !== selected.appInstanceId)
      throw new ClayError("E_GENERATION_NOT_SELECTED", "only the selected app can be deleted");
    const cleanupJobId = deriveLifecycleId(
      "job", authorityId, request.requestId, "delete-cleanup-job",
    );
    const deleted = context.writeAuthority.run(() => {
      const activeCatalog = DeviceCatalog.openExisting(context.driver);
      return activeCatalog.deleteSelectedApp({
        expectedCatalogGeneration: activeCatalog.snapshot().catalogGeneration,
        expectedTarget: selected,
        jobId: cleanupJobId,
        operationId,
        requestSha256,
        fence,
        nowMs,
      });
    });
    authority.close();
    await completeBrowserCleanup(deleted.cleanupJob);
    return ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  }

  if (request.kind !== "create" && request.kind !== "fork" && request.kind !== "reset")
    throw invalid("lifecycle request kind is unavailable");
  const current = DeviceCatalog.openExisting(context.driver).snapshot().entries.find(entry =>
    entry.appInstanceId === selected.appInstanceId);
  if (!current) throw invalid("selected app metadata is unavailable");
  const displayName = request.kind === "create" ? request.displayName
    : request.kind === "fork"
      ? `${current.displayName.slice(0, 33).trimEnd()} (copy)`
      : current.displayName;
  const shellId = request.kind === "create" ? request.shellId : current.shellId;
  const appInstanceId = deriveLifecycleId(
    "app", authorityId, request.requestId, `${request.kind}-app`,
  );
  const generationId = deriveLifecycleId(
    "gen", authorityId, request.requestId, `${request.kind}-generation`,
  );
  const namespaceId = deriveLifecycleId(
    "ns", authorityId, request.requestId, `${request.kind}-namespace`,
  );
  const pendingJobId = deriveLifecycleId(
    "job", authorityId, request.requestId, `${request.kind}-job`,
  );
  const physical = physicalNamespaceEntry(namespaceId, namespaceId);
  let declared = false;
  try {
    const pending = context.writeAuthority.run(() => {
      const activeCatalog = DeviceCatalog.openExisting(context.driver);
      const job = activeCatalog.declareAppGeneration({
        kind: request.kind,
        expectedCatalogGeneration: activeCatalog.snapshot().catalogGeneration,
        expectedTarget: selected,
        target: {
          appInstanceId,
          generationId,
          namespaceId,
          storageKey: physical.storageKey,
          userFile: physical.userFile,
          systemFile: physical.systemFile,
          storageKind: physical.kind,
          displayName,
          shellId,
        },
        jobId: pendingJobId,
        operationId,
        requestSha256,
        fence,
        nowMs,
      });
      declared = true;
      return job;
    });
    // Creating files before this durable catalog declaration is forbidden.
    const targetSession = createLiveWriteGuard(await openBrowserProductionTarget(physical));
    let targetStore: ClayStore | null = null;
    let cleanup: PendingTargetLifecycleJob | null = null;
    try {
      targetStore = initializeDeclaredBrowserTarget(
        context.driver, context.store, targetSession, pending, fence, nowMs,
      );
      cleanup = DeviceCatalog.openExisting(targetSession.driver).pendingLifecycleJobs()
        .find(item => item.kind === "cleanup") ?? null;
    } catch (error) {
      try { targetSession.driver.close(); } catch { /* already closed */ }
      throw error;
    }
    targetStore.close();
    authority.close();
    if (cleanup) await completeBrowserCleanup(cleanup);
    return ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  } catch (error) {
    if (declared) {
      try { authority.close(); } catch { /* fail closed after a durable declaration */ }
    }
    throw error;
  }
}
