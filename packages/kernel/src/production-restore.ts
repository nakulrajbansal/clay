import { RequestId } from "@clay/schema";
import { BackupAuthenticationV1 } from "@clay/schema/backup";
import { CatalogRestoreJobV2 } from "@clay/schema/archive";
import { AuthenticatedFormat5RestoreGrantV1 } from "@clay/schema/restore";
import { captureAppImportRequest, deriveLifecycleId } from "./app-lifecycle-request";
import { sha256HexSync } from "./state-digest";
import { importAuthorityArchive, restoreAuthorityArchiveAsNew } from "./archive-authority";
import { browserDurableFileNames, deleteBrowserNamespaceStorage, openBrowserCatalogProbe, openBrowserProductionTarget } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { physicalNamespaceEntry } from "./durable-inventory";
import { ClayError } from "./errors";
import { assertLifecycleRecoveryInventory, withBrowserLifecycleLock } from "./lifecycle-recovery-inventory";
import { createLiveWriteGuard, type LiveWriteSession } from "./live-write-guard";
import { ProductionStoreAuthority, productionLifecycleContext, assertLifecycleSurvivorReadable } from "./production-authority";
import { mintProductionAuthorityId, commitCopiedSampleReattestation } from "./production-mutation-coordinator";
import { encodeAuthorityIdBytes } from "./production-operation-id";
import type { TargetEvidenceV1, WriteFenceV1 } from "@clay/schema/catalog";

type Grant = AuthenticatedFormat5RestoreGrantV1;
type Staged = { grant: Grant; payload: Uint8Array; source: TargetEvidenceV1; catalogGeneration: string;
  authorityId: string; displayName: string; shellId: string };
const staged = new WeakMap<ProductionStoreAuthority, Map<string, Staged>>();
const invalid = (message: string) => new ClayError("E_CATALOG_CONFLICT", message);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Internal worker capability entry: its sole production caller receives this
 * payload from the private trusted-shell verifier BEFORE parsing any ZIP. */
export async function stageProductionRestore(authority: ProductionStoreAuthority, verified: {
  payload: Uint8Array; archiveSha256: string; authentication: BackupAuthenticationV1;
  freshness: "current" | "unknown" | "future" | "replay" | "fork";
}): Promise<Grant> {
  if (verified.freshness !== "current" && verified.freshness !== "unknown")
    throw invalid("Archive freshness is not current or independently imported; restore is denied");
  const before = authority.inspectAuthority();
  const payload = verified.payload.slice();
  try {
    const archive = await importAuthorityArchive(payload);
    try {
      if (archive.authority.kind !== "format5_internal_consistency" || archive.invalidPanels.length)
        throw invalid("An intact authenticated format 5 archive is required");
      if (!same(before, authority.inspectAuthority())) throw invalid("Restore source changed during validation");
      const entry = archive.authority.evidence.catalogAuthority.entry;
      const grant = AuthenticatedFormat5RestoreGrantV1.parse({
        schema: 1, kind: "authenticated_format5_restore_as_new",
        validationId: encodeAuthorityIdBytes("restoreval", crypto.getRandomValues(new Uint8Array(17))),
        archiveFormat: 5, cryptographicallyAuthenticated: true,
        authentication: BackupAuthenticationV1.parse(verified.authentication), freshness: verified.freshness,
        archiveSha256: verified.archiveSha256, archiveTarget: archive.authority.evidence.target,
        preservedAppInstanceId: before.target.appInstanceId,
        destinationAppInstanceId: mintProductionAuthorityId("app"),
        installMode: "new_app_only", validatedAt: new Date().toISOString(),
      });
      const ledger = staged.get(authority) ?? new Map<string, Staged>();
      while (ledger.size >= 4) {
        const oldest = ledger.keys().next().value!;
        ledger.get(oldest)!.payload.fill(0); ledger.delete(oldest);
      }
      ledger.set(grant.validationId, { grant, payload, source: before.target,
        catalogGeneration: before.catalog.catalogGeneration, authorityId: before.catalog.authorityIncarnationId,
        displayName: `${entry.displayName.slice(0, 29).trimEnd()} (restored)`, shellId: entry.shellId });
      staged.set(authority, ledger);
      return structuredClone(grant);
    } finally { archive.store.close(); }
  } catch (error) { payload.fill(0); throw error; }
}

function acquire(session: LiveWriteSession, catalog: DeviceCatalog): WriteFenceV1 {
  const before = catalog.snapshot();
  return session.authority.run(() => catalog.acquireWriteLease({
    expectedAuthorityIncarnationId: before.authorityIncarnationId,
    expectedCatalogGeneration: before.catalogGeneration, expectedWriteEpoch: before.writeEpoch,
    releaseId: mintProductionAuthorityId("rel"), nowMs: Date.now(), ttlMs: 60_000,
  }));
}

function assertSource(catalog: DeviceCatalog, proof: Staged): void {
  if (catalog.snapshot().authorityIncarnationId !== proof.authorityId
      || !same(catalog.selectedTargetStorage().target, proof.source)) throw invalid("Restore source changed after validation");
  // A lease can change while an owner reviews a file. No selection, metadata,
  // user write or other catalog transition may be hidden behind that suffix.
  if (!catalog.hasOnlyLeaseSuffix(proof.catalogGeneration, proof.source.appInstanceId))
    throw invalid("Restore catalog changed after validation");
}

export async function executeProductionRestore(authority: ProductionStoreAuthority, input: unknown): Promise<ProductionStoreAuthority> {
  const captured = captureAppImportRequest(input) as Record<string, unknown>;
  if (Object.keys(captured).sort().join(",") !== "grant,requestId") throw invalid("Restore request is invalid");
  const grant = AuthenticatedFormat5RestoreGrantV1.parse(captured.grant);
  const requestId = RequestId.parse(captured.requestId);
  const requestSha256 = `sha256:${sha256HexSync(new TextEncoder().encode(JSON.stringify({ grant, requestId })))}`;
  const installed = await withBrowserLifecycleLock(async () => {
    const context = productionLifecycleContext(authority);
    const catalog = DeviceCatalog.openExisting(context.driver);
    const authorityId = catalog.snapshot().authorityIncarnationId;
    const operationId = deriveLifecycleId("op", authorityId, requestId, "restore-operation");
    const jobId = deriveLifecycleId("job", authorityId, requestId, "restore-request");
    const receipt = catalog.appLifecycleReceipt(requestId);
    if (receipt) {
      if (receipt.requestSha256 !== requestSha256 || receipt.operationId !== operationId || receipt.jobId !== jobId
          || (receipt.kind !== "restore" && receipt.kind !== "restore_aborted")) throw invalid("Restore request identity was reused");
      if (receipt.kind === "restore_aborted") throw new ClayError("E_CANCELLED", "Interrupted restore was not published. Validate the archive again to retry safely.");
      catalog.assertAppLifecycleReplay(receipt);
      return false;
    }
    const proof = staged.get(authority)?.get(grant.validationId);
    if (!proof) throw new ClayError("E_CANCELLED", "No restore was published for this request and the grant expired; validate the archive again");
    if (!same(proof.grant, grant)) throw invalid("Restore grant was not issued by this worker");
    assertSource(catalog, proof);
    const generationId = deriveLifecycleId("gen", authorityId, requestId, "restore-generation");
    const namespaceId = deriveLifecycleId("ns", authorityId, requestId, "restore-namespace");
    const physical = physicalNamespaceEntry(namespaceId, namespaceId);
    // The recovery job may only own files created after its declaration. Never
    // turn a pre-existing orphan, valid pair or sidecar into cleanup authority.
    const names = await browserDurableFileNames();
    if (names.some(name => [physical.userFile, physical.systemFile].some(file => name === file || name.startsWith(`${file}-`))))
      throw invalid("Restore destination is not fresh; an existing file is kept untouched");
    const fence = acquire({ driver: context.driver, authority: context.writeAuthority }, catalog);
    let declared = false;
    try {
      const job = context.writeAuthority.run(() => {
        assertSource(catalog, proof);
        return CatalogRestoreJobV2.parse(catalog.beginRestoreJob({
          jobId, appInstanceId: grant.destinationAppInstanceId, generationId, namespaceId, operationId,
          sourceArchiveSha256: grant.archiveSha256, sourceProvenanceId: grant.validationId,
          expectedCatalogGeneration: catalog.snapshot().catalogGeneration, expectedSourceTarget: proof.source,
          fence, nowMs: Date.now(), intent: { requestId, requestSha256, sourceTarget: proof.source,
            sourceCatalogGeneration: proof.catalogGeneration, grant },
        }));
      });
      declared = true;
      const restored = await restoreAuthorityArchiveAsNew(proof.payload, {
        schema: 1, appInstanceId: grant.destinationAppInstanceId, generationId, namespaceId,
        operationId, restoredAt: new Date().toISOString(),
      }, async () => {
        const pending = DeviceCatalog.openForRestoreRecovery(context.driver);
        pending.assertRestoreClaim(job, fence, Date.now(), "install");
        return openBrowserProductionTarget(physical);
      }, {
        wrapFreshDriver: driver => {
          const session = createLiveWriteGuard(driver);
          return { driver: session.driver, runAuthorized: write => session.authority.run(() => {
            DeviceCatalog.openForRestoreRecovery(session.driver).assertRestoreClaim(job, fence, Date.now(), "install");
            write();
          }) };
        },
        afterAuthorityReadBack: installed => {
          const pending = DeviceCatalog.openForRestoreRecovery(installed.driver);
          pending.assertRestoreClaim(job, fence, Date.now(), "install");
          const nowMs = Date.now();
          const added = pending.addAppTarget({ expectedCatalogGeneration: pending.snapshot().catalogGeneration,
            target: installed.target, namespaceId, storageKey: namespaceId, operationId,
            displayName: proof.displayName, shellId: proof.shellId, select: true, fence, nowMs,
            sourceArchiveSha256: grant.archiveSha256, sourceProvenanceId: grant.validationId }, jobId);
          if (installed.store.sampleRowProvenance().length === 0) return installed.target;
          const reattestationRequestId = mintProductionAuthorityId("req");
          const final = commitCopiedSampleReattestation({ kind: "restore", driver: installed.driver, store: installed.store, fence,
            expectedCatalogGeneration: added.catalogGeneration, expectedTarget: installed.target,
            requestId: reattestationRequestId, nowMs, sourceSha256: grant.archiveSha256,
            sourceAuthorityIncarnationId: installed.sourceAuthority.evidence.catalogAuthority.authorityIncarnationId });
          DeviceCatalog.openExisting(installed.driver).finalizeLifecycleReattestation(requestId, reattestationRequestId, nowMs);
          return final;
        },
      });
      restored.store.close();
      return true;
    } finally {
      if (declared) {
        // Never attempt eager catch-delete: a commit/readback/transport outcome
        // may be ambiguous. Boot recovery alone can claim an unpublished job.
        proof.payload.fill(0); staged.get(authority)?.delete(grant.validationId);
        authority.close();
      }
    }
  });
  return installed ? ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] }) : authority;
}

/** Runs BEFORE strict inventory classification, including half-created pairs. */
export async function reconcilePendingBrowserRestore(): Promise<void> {
  if (!(await browserDurableFileNames()).includes("/clay-device-catalog-v1.db")) return;
  // A read-only hint avoids re-entering the physical lock from normal lifecycle
  // boot. It never authorizes unlink; the exact job is re-read/claimed below.
  const probe = await openBrowserCatalogProbe();
  try {
    if (DeviceCatalog.isAbsent(probe) || DeviceCatalog.openForRestoreRecovery(probe).pendingRestoreJobs().length === 0) return;
  } finally { probe.close(); }
  await withBrowserLifecycleLock(async () => {
    if (!(await browserDurableFileNames()).includes("/clay-device-catalog-v1.db")) return;
    const session = createLiveWriteGuard(await openBrowserCatalogProbe());
    try {
      if (DeviceCatalog.isAbsent(session.driver)) return;
      const catalog = DeviceCatalog.openForRestoreRecovery(session.driver);
      const pending = catalog.pendingRestoreJobs();
      if (pending.length === 0) return;
      const fence = acquire(session, catalog);
      const job = session.authority.run(() => catalog.claimRestoreRecovery(pending[0]!, fence, Date.now()));
      const selected = catalog.selectedTargetStorage();
      const physical = physicalNamespaceEntry(job.namespaceId, job.namespaceId);
      const liveFiles = ["/clay-device-catalog-v1.db", ...catalog.activeTargetStorageInventory().flatMap(item => {
        const entry = physicalNamespaceEntry(item.storageKey, item.namespaceId);
        return [entry.userFile, entry.systemFile];
      })];
      assertLifecycleRecoveryInventory(await browserDurableFileNames(), liveFiles, physical);
      const survivor = createLiveWriteGuard(await openBrowserProductionTarget(
        physicalNamespaceEntry(selected.storageKey, selected.namespaceId)));
      try { assertLifecycleSurvivorReadable(survivor, selected, true); }
      finally { survivor.driver.close(); }
      await deleteBrowserNamespaceStorage(physical, () => catalog.assertRestoreClaim(job, fence, Date.now(), "cleanup"));
      session.authority.run(() => catalog.finishRestoreCleanup(job, fence, Date.now()));
    } finally { session.driver.close(); }
  });
}
