import { RequestId } from "@clay/schema/standalone/index";
import { TargetEvidenceV1 } from "@clay/schema/standalone/catalog";
import type {
  PendingTargetLifecycleJobV1 as PendingTargetLifecycleJob,
  TargetEvidenceV1 as TargetEvidence,
  WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import { copyAppStateToFreshTarget } from "./app-generation";
import {
  captureAppLifecycleRequest,
  captureAppImportRequest,
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
  assertLifecycleSurvivorReadable,
} from "./production-authority";
import { mintProductionAuthorityId, commitCopiedSampleReattestation } from "./production-mutation-coordinator";
import { productionOperationIdV2 } from "./production-operation-id";
import { captureTableImport } from "./production-import";
import { readProductionRequestReceipt } from "./production-request-journal";
import { decodeProductionResponse } from "./production-response-envelope";
import { StateMerkleIndex } from "./state-merkle-index";
import { ClayStore } from "./store";
import { TargetAuthorityStore } from "./target-authority";
import { assertLifecycleRecoveryInventory, withBrowserLifecycleLock } from "./lifecycle-recovery-inventory";

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

function exactDataRecord(
  input: unknown,
  keys: readonly string[],
  message: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype
        && Object.getPrototypeOf(input) !== null)) throw invalid(message);
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length || actual.some(key => typeof key !== "string"
      || !keys.includes(key))) throw invalid(message);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw invalid(message);
    copy[key] = descriptor.value;
  }
  return copy;
}

function exactRequestId(value: unknown, message: string): string {
  const parsed = RequestId.safeParse(value);
  if (!parsed.success) throw invalid(message);
  return parsed.data;
}

function assertCreatedBlankTarget(
  context: ReturnType<typeof productionLifecycleContext>,
  createRequestId: string,
): { authorityIncarnationId: string; selected: TargetEvidence } {
  const catalog = DeviceCatalog.openExisting(context.driver);
  const snapshot = catalog.snapshot();
  const selected = catalog.selectedTargetStorage().target;
  const target = TargetAuthorityStore.open(context.driver).evidence();
  const receipt = catalog.appLifecycleReceipt(createRequestId);
  const entry = snapshot.entries.find(candidate =>
    candidate.appInstanceId === selected.appInstanceId);
  if (!sameTarget(selected, target) || !receipt || receipt.schema !== 2 || receipt.kind !== "create"
      || receipt.requestedAppInstanceId !== null
      || receipt.resultingSelectedAppInstanceId !== selected.appInstanceId
      || !entry || entry.shellId !== "blank")
    throw new ClayError(
      "E_GENERATION_NOT_SELECTED",
      "new-app import is not bound to the selected blank app creation",
    );
  return { authorityIncarnationId: snapshot.authorityIncarnationId, selected };
}

function assertPristineNewApp(context: ReturnType<typeof productionLifecycleContext>): void {
  if (context.store.headVersion() !== 0 || context.store.history().length !== 0
      || context.store.registrySnapshot().size !== 0
      || context.store.livePanels().length !== 0 || context.store.rowHistoryCount() !== 0)
    throw new ClayError(
      "E_CONFLICT", "the new app changed after its import preview",
    );
}

function captureImportRequest(input: unknown, undo: boolean): Record<string, unknown> {
  const captured = captureAppImportRequest(input);
  const firstRun = typeof captured === "object" && captured !== null && Object.hasOwn(captured, "firstRunTarget");
  return exactDataRecord(captured, [firstRun ? "firstRunTarget" : "createRequestId", "requestId",
    undo ? "importRequestId" : "payload"], "new-app import request is invalid");
}

function assertImportBinding(
  context: ReturnType<typeof productionLifecycleContext>, captured: Record<string, unknown>, importRequestId: string,
): { authorityIncarnationId: string; selected: TargetEvidence } {
  if (!Object.hasOwn(captured, "firstRunTarget"))
    return assertCreatedBlankTarget(context, exactRequestId(captured.createRequestId, "new-app creation request identity is invalid"));
  const initial = TargetEvidenceV1.parse(captured.firstRunTarget);
  const catalog = DeviceCatalog.openExisting(context.driver);
  const snapshot = catalog.snapshot();
  const selected = catalog.selectedTargetStorage().target;
  const receipt = readProductionRequestReceipt(context.driver, importRequestId);
  if ((!receipt && snapshot.entries.length !== 1) || !sameTarget(selected, TargetAuthorityStore.open(context.driver).evidence())
      || selected.appInstanceId !== initial.appInstanceId || selected.activeGenerationId !== initial.activeGenerationId
      || selected.lineageEpoch !== initial.lineageEpoch
      || (receipt ? receipt.appInstanceId !== initial.appInstanceId
        || receipt.activeGenerationId !== initial.activeGenerationId || receipt.lineageEpoch !== initial.lineageEpoch
        || receipt.expectedProtectionRevision !== initial.protectionRevision || receipt.expectedStateSha256 !== initial.stateSha256
        : !sameTarget(selected, initial)))
    throw new ClayError("E_CONFLICT", "first-run import is not bound to the sole authority-selected target");
  if (!receipt) assertPristineNewApp(context);
  return { authorityIncarnationId: snapshot.authorityIncarnationId, selected };
}

function importedTableResult(value: unknown): {
  table: string; imported: number; columns: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("new-app import returned invalid authority evidence");
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).length !== 3 || typeof record.table !== "string"
      || !Number.isSafeInteger(record.imported) || Number(record.imported) < 1
      || !Number.isSafeInteger(record.columns) || Number(record.columns) < 1)
    throw invalid("new-app import returned invalid authority evidence");
  return {
    table: record.table,
    imported: Number(record.imported),
    columns: Number(record.columns),
  };
}

function assertImportedTableReadback(
  context: ReturnType<typeof productionLifecycleContext>,
  value: unknown,
): { table: string; imported: number; columns: number } {
  const result = importedTableResult(value);
  const registry = context.store.registrySnapshot();
  const table = registry.get(result.table);
  const count = Number(context.driver.select(
    `SELECT COUNT(*) AS count FROM "${result.table.replace(/"/g, "\"\"")}"`,
  )[0]?.count);
  const panels = context.store.livePanels();
  if (!table || table.columns.filter(column => !column.inactive).length !== result.columns
      || !Number.isSafeInteger(count) || count !== result.imported
      || !panels.some(panel => panel.declared_queries.some(query => query.from === result.table)))
    throw invalid("new-app import failed durable read-back");
  return result;
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
      const published = catalog.publishDeclaredAppGeneration({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        jobId: job.jobId,
        publishedTarget: target,
        fence,
        nowMs,
      });
      let finalTarget = target;
      if (job.kind === "fork" && openedStore.sampleRowProvenance().length > 0) {
        const reattestationRequestId = mintProductionAuthorityId("req");
        finalTarget = commitCopiedSampleReattestation({ kind: "fork", driver: targetSession.driver,
          store: openedStore, fence, expectedCatalogGeneration: published.catalogGeneration, expectedTarget: target,
          requestId: reattestationRequestId, nowMs, sourceSha256: job.expectedTarget.stateSha256,
          sourceAuthorityIncarnationId: job.authorityIncarnationId });
        catalog.finalizeLifecycleReattestation(job.requestId, reattestationRequestId, nowMs);
      }
      const audited = enumerateCanonicalStateV1(targetSession.driver, registry);
      const merkle = StateMerkleIndex.open(targetSession.driver).audit();
      if (audited.stateSha256 !== finalTarget.stateSha256
          || audited.stateSha256 !== merkle.stateSha256
          || audited.leaves.length !== merkle.leafCount)
        throw invalid("lifecycle target failed canonical read-back");
    });
  });
  if (!openedStore) throw invalid("lifecycle target did not produce a Store");
  return openedStore;
}

/** Resume every catalog-declared physical target or cleanup before normal boot inventory. */
export async function reconcilePendingBrowserLifecycle(): Promise<void> {
  return withBrowserLifecycleLock(reconcilePendingBrowserLifecycleUnlocked);
}

async function reconcilePendingBrowserLifecycleUnlocked(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const names = await browserDurableFileNames();
    if (!names.includes("/clay-device-catalog-v1.db")) return;
    const probeSession = createLiveWriteGuard(await openBrowserCatalogProbe());
    const probe = probeSession.driver;
    let job: PendingTargetLifecycleJob | null = null;
    let fence: WriteFence;
    let selectedStorage: ReturnType<DeviceCatalog["selectedTargetStorage"]> | null = null;
    try {
      if (DeviceCatalog.isAbsent(probe)) return;
      const catalog = DeviceCatalog.openExisting(probe);
      const jobs = catalog.pendingLifecycleJobs();
      if (jobs.length === 0) return;
      if (jobs.length !== 1) throw invalid("multiple lifecycle recoveries are ambiguous");
      job = jobs[0]!;
      selectedStorage = catalog.selectedTargetStorage();
      fence = acquireLifecycleFence(probeSession, mintProductionAuthorityId("rel"), Date.now(), 60_000);
      job = probeSession.authority.run(() => catalog.claimPendingLifecycleRecovery({
        expectedJob: job!, fence, nowMs: Date.now(),
      }));
      // Only this claimed namespace may be incomplete. Every live pair and every
      // unrelated file still has to pass the exact census before deletion starts.
      const liveFiles = ["/clay-device-catalog-v1.db", ...catalog.activeTargetStorageInventory()
        .flatMap(item => {
          const physical = physicalNamespaceEntry(item.storageKey, item.namespaceId);
          return [physical.userFile, physical.systemFile];
        })];
      assertLifecycleRecoveryInventory(await browserDurableFileNames(), liveFiles, job.target);
      if (job.kind === "cleanup") {
        // A catalog entry alone is not proof of a usable survivor. Recheck its
        // physical authority and canonical state before resuming any unlink.
        const survivor = createLiveWriteGuard(await openBrowserProductionTarget(
          physicalNamespaceEntry(selectedStorage.storageKey, selectedStorage.namespaceId),
        ));
        try { assertLifecycleSurvivorReadable(survivor, selectedStorage); }
        finally { survivor.driver.close(); }
      }
      await deleteBrowserNamespaceStorage(physicalForLifecycleJob(job), () =>
        catalog.assertLifecycleRecoveryClaim(job!, fence, Date.now()));
      if (job.kind === "cleanup") {
        probeSession.authority.run(() => catalog.completeLifecycleCleanup({
          expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
          jobId: job!.jobId, cleanupConfirmed: true, fence, nowMs: Date.now(),
        }));
      }
    } finally {
      probe.close();
    }
    if (!job || !selectedStorage) throw invalid("lifecycle recovery evidence is incomplete");
    if (job.kind === "cleanup") {
      continue;
    }

    // Deletion above completed while the durable claim and cross-tab lock were held.
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
        catalog.assertLifecycleRecoveryClaim(job!, fence, Date.now());
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
      const targetSession = createLiveWriteGuard(
        await openBrowserProductionTarget(physicalForLifecycleJob(job)),
      );
      let targetStore: ClayStore | null = null;
      try {
        targetStore = initializeDeclaredBrowserTarget(
          sourceSession.driver, openedSource, targetSession, job, fence, Date.now(),
        );
      } catch (error) {
        try { targetSession.driver.close(); } catch { /* already closed */ }
        throw error;
      }
      targetStore.close();
      openedSource.close();
    } finally {
      try { sourceSession.driver.close(); } catch { /* already closed */ }
    }
  }
  throw invalid("lifecycle recovery did not converge");
}

/** Commit a reviewed table only into the exact blank target created by its receipt. */
export async function executeProductionNewAppImport(
  authority: ProductionStoreAuthority,
  input: unknown,
): Promise<Readonly<{
  appInstanceId: string;
  table: string;
  imported: number;
  columns: number;
  version: 1;
}>> {
  const captured = captureImportRequest(input, false);
  const requestId = exactRequestId(
    captured.requestId, "new-app import request identity is invalid",
  );
  const payload = captureTableImport(captured.payload);
  const context = productionLifecycleContext(authority);
  const created = assertImportBinding(context, captured, requestId);
  const replay = readProductionRequestReceipt(context.driver, requestId);
  if (!replay) assertPristineNewApp(context);
  const committed = await authority.executeMutation({
    requestId,
    route: "table.import",
    payload,
  });
  const result = assertImportedTableReadback(context, committed.result);
  if (context.store.headVersion() !== 1 || context.store.history().length !== 1)
    throw invalid("new-app import history failed durable read-back");
  return Object.freeze({
    appInstanceId: created.selected.appInstanceId,
    ...result,
    version: 1 as const,
  });
}

/** Undo only the still-latest, receipt-bound table import in its created app. */
export async function undoProductionNewAppImport(
  authority: ProductionStoreAuthority,
  input: unknown,
): Promise<Readonly<{ appInstanceId: string; undone: true; version: 0 }>> {
  const captured = captureImportRequest(input, true);
  const importRequestId = exactRequestId(
    captured.importRequestId, "new-app import receipt identity is invalid",
  );
  const requestId = exactRequestId(
    captured.requestId, "new-app import Undo request identity is invalid",
  );
  const context = productionLifecycleContext(authority);
  const created = assertImportBinding(context, captured, importRequestId);
  const undoReplay = readProductionRequestReceipt(context.driver, requestId);
  if (!undoReplay) {
    const receipt = readProductionRequestReceipt(context.driver, importRequestId);
    const response = receipt?.responseJson ? decodeProductionResponse(receipt.responseJson) : null;
    if (!receipt || receipt.state !== "committed"
        || receipt.operationId !== productionOperationIdV2(
          created.authorityIncarnationId, importRequestId, "table.import",
        )
        || receipt.appInstanceId !== created.selected.appInstanceId
        || receipt.activeGenerationId !== created.selected.activeGenerationId
        || receipt.lineageEpoch !== created.selected.lineageEpoch
        || receipt.resultingProtectionRevision !== created.selected.protectionRevision
        || receipt.resultingStateSha256 !== created.selected.stateSha256
        || !response || response.kind !== "envelope" || response.route !== "table.import")
      throw new ClayError(
        "E_CONFLICT", "new-app import is no longer the latest recoverable change",
      );
    assertImportedTableReadback(context, response.result);
    if (context.store.headVersion() !== 1 || context.store.history().length !== 1)
      throw new ClayError(
        "E_CONFLICT", "new-app import is no longer the latest recoverable change",
      );
  }
  await authority.executeMutation({
    requestId,
    route: "timeline.makeLatest",
    payload: { version: 0 },
  });
  if (context.store.headVersion() !== 0 || context.store.history().length !== 0
      || context.store.registrySnapshot().size !== 0 || context.store.livePanels().length !== 0)
    throw invalid("new-app import Undo failed durable read-back");
  return Object.freeze({
    appInstanceId: created.selected.appInstanceId,
    undone: true as const,
    version: 0 as const,
  });
}

/** Execute one serialized worker-owned lifecycle transition. */
export async function executeProductionAppLifecycle(
  authority: ProductionStoreAuthority,
  input: unknown,
): Promise<ProductionStoreAuthority> {
  const request = captureAppLifecycleRequest(input);
  return withBrowserLifecycleLock(() => executeProductionAppLifecycleUnlocked(authority, request));
}

async function executeProductionAppLifecycleUnlocked(
  authority: ProductionStoreAuthority,
  request: ReturnType<typeof captureAppLifecycleRequest>,
): Promise<ProductionStoreAuthority> {
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
  const authorityId = before.authorityIncarnationId;
  const operationId = deriveLifecycleId(
    "op", authorityId, request.requestId, "lifecycle-operation",
  );
  const receiptJobId = deriveLifecycleId(
    "job", authorityId, request.requestId, "lifecycle-request",
  );
  const requestSha256 = lifecycleRequestSha256(request);
  const replay = catalog.appLifecycleReceipt(request.requestId);
  if (replay) {
    if (replay.kind !== request.kind || replay.requestSha256 !== requestSha256
        || replay.operationId !== operationId || replay.jobId !== receiptJobId)
      throw new ClayError("E_CATALOG_CONFLICT", "lifecycle request identity was reused");
    catalog.assertAppLifecycleReplay(replay);
    return authority;
  }
  const fence = acquireLifecycleFence(
    session, mintProductionAuthorityId("rel"), nowMs, context.leaseTtlMs,
  );
  const completedAt = new Date(nowMs).toISOString();

  if (request.kind === "switch") {
    context.writeAuthority.run(() => context.driver.tx(() => {
      const activeCatalog = DeviceCatalog.openExisting(context.driver);
      const after = activeCatalog.selectApp({
        recordNoop: true,
        expectedCatalogGeneration: activeCatalog.snapshot().catalogGeneration,
        appInstanceId: request.appInstanceId,
        operationId,
        fence,
        nowMs,
      });
      activeCatalog.recordAppLifecycleReceipt({
        kind: "switch",
        requestId: request.requestId,
        requestSha256,
        jobId: receiptJobId,
        operationId,
        requestedAppInstanceId: request.appInstanceId,
        expectedCatalogGeneration: after.catalogGeneration,
        completedAt,
      });
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
    if (request.shellId !== null && context.store.history().length > 0
        && (request.shellId !== context.store.getSetting("shell_id")
          || request.displayName !== current.displayName))
      throw new ClayError("E_CONFLICT", "resume the committed starter; existing history cannot be relabeled as another starter");
    context.writeAuthority.run(() => context.driver.tx(() => {
      const activeCatalog = DeviceCatalog.openExisting(context.driver);
      const after = activeCatalog.updateSelectedAppMetadata({
        recordNoop: true,
        expectedCatalogGeneration: activeCatalog.snapshot().catalogGeneration,
        displayName: request.displayName,
        shellId: request.shellId ?? current.shellId,
        operationId,
        fence,
        nowMs,
      });
      activeCatalog.recordAppLifecycleReceipt({
        kind: "rename",
        requestId: request.requestId,
        requestSha256,
        jobId: receiptJobId,
        operationId,
        requestedAppInstanceId: request.appInstanceId,
        expectedCatalogGeneration: after.catalogGeneration,
        completedAt,
      });
    }));
    authority.close();
    return ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  }

  if (request.kind === "delete") {
    if (request.appInstanceId !== selected.appInstanceId)
      throw new ClayError("E_GENERATION_NOT_SELECTED", "only the selected app can be deleted");
    const fallback = catalog.activeTargetStorageInventory()
      .filter(candidate => candidate.target.appInstanceId !== selected.appInstanceId)
      .sort((left, right) => left.target.appInstanceId.localeCompare(right.target.appInstanceId))[0];
    if (!fallback) throw new ClayError("E_CATALOG_CONFLICT", "the last live app cannot be deleted");
    const inventory = await browserDurableInventory();
    const physical = physicalNamespaceEntry(fallback.storageKey, fallback.namespaceId);
    if (inventory.state !== "complete" || !inventory.catalogPresent
        || !inventory.namespaces.some(item => item.userFile === physical.userFile && item.systemFile === physical.systemFile))
      throw invalid("deletion fallback physical inventory is unavailable");
    const survivor = createLiveWriteGuard(await openBrowserProductionTarget(physical));
    try { assertLifecycleSurvivorReadable(survivor, fallback); }
    finally { survivor.driver.close(); }
    context.writeAuthority.run(() => {
      const activeCatalog = DeviceCatalog.openExisting(context.driver);
      return activeCatalog.deleteSelectedApp({
        expectedCatalogGeneration: activeCatalog.snapshot().catalogGeneration,
        expectedTarget: selected,
        requestId: request.requestId,
        jobId: receiptJobId,
        operationId,
        requestSha256,
        fence,
        nowMs: Date.now(),
      });
    });
    authority.close();
    await reconcilePendingBrowserLifecycleUnlocked();
    return ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  }

  if (request.kind !== "create" && request.kind !== "fork")
    throw invalid("lifecycle request kind is unavailable");
  const current = DeviceCatalog.openExisting(context.driver).snapshot().entries.find(entry =>
    entry.appInstanceId === selected.appInstanceId);
  if (!current) throw invalid("selected app metadata is unavailable");
  const displayName = request.kind === "create"
    ? request.displayName
    : `${current.displayName.slice(0, 33).trimEnd()} (copy)`;
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
  const physical = physicalNamespaceEntry(namespaceId, namespaceId);
  let declared = false;
  try {
    const pending = context.writeAuthority.run(() => {
      const activeCatalog = DeviceCatalog.openExisting(context.driver);
      const job = activeCatalog.declareAppGeneration({
        kind: request.kind,
        requestId: request.requestId,
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
        jobId: receiptJobId,
        operationId,
        requestSha256,
        fence,
        nowMs,
      });
      declared = true;
      return job;
    });
    // No target file may exist before the declaration above commits.
    const targetSession = createLiveWriteGuard(await openBrowserProductionTarget(physical));
    let targetStore: ClayStore | null = null;
    try {
      targetStore = initializeDeclaredBrowserTarget(
        context.driver, context.store, targetSession, pending, fence, Date.now(),
      );
    } catch (error) {
      try { targetSession.driver.close(); } catch { /* already closed */ }
      throw error;
    }
    targetStore.close();
    authority.close();
    return ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  } catch (error) {
    if (declared) {
      try { authority.close(); } catch { /* durable declaration recovers on next boot */ }
    }
    throw error;
  }
}
