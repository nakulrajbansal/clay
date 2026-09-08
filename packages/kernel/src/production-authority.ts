import { AppInstanceId, GenerationId, NamespaceId, OperationId } from "@clay/schema";
import type { ArchiveRestoreAsNewIdentityV1 as ArchiveRestoreIdentity } from "@clay/schema/archive";
import {
  TargetEvidenceV1,
  type TargetEvidenceV1 as TargetEvidence,
  type WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import type {
  BackupAuthenticationV1 as BackupAuthentication,
  BackupPublicationReceiptV1 as BackupPublicationReceipt,
  BackupPublicationRequestV1 as BackupPublicationRequest,
  BackupRecordV1 as BackupRecord,
  BackupStageValidationV1 as BackupStageValidation,
} from "@clay/schema/backup";
import type { ArchiveSealMaterialV1 } from "./archive-authority";
import type { AsyncStore, StoreMutationContext } from "./asyncstore";
import { enumerateCanonicalStateV1 } from "./canonical-state";
import {
  browserDurableFileNames,
  browserDurableInventory,
  deleteBrowserGenerationNamespace,
  openBrowserCatalogProbe,
  openBrowserProductionTarget,
  type DbDriver,
} from "./db";
import { DeviceCatalog, type LegacyBootstrapEntry } from "./device-catalog";
import {
  physicalNamespaceEntry,
  type DurableFileInventory,
  type DurableNamespaceInventoryEntry,
} from "./durable-inventory";
import { ClayError } from "./errors";
import {
  createLiveWriteGuard,
  type LiveWriteSession,
} from "./live-write-guard";
import {
  armProductionMutationFailureForTest,
  commitRestoredSampleReattestation,
  mintProductionAuthorityId,
  ProductionMutationCoordinator,
  type ProductionBackupSelection,
  type ProductionMutationTestFailure,
  type ProductionMutationResult,
} from "./production-mutation-coordinator";
import { assertLiveSampleProvenance } from "./sample-provenance-proof";
import { activeSampleRowCount, restoredSampleProvenanceCount } from "./production-samples";
import { StateMerkleIndex } from "./state-merkle-index";
import { sha256HexSync } from "./state-digest";
import { ClayStore, exportStoreArchiveReadOnly } from "./store";
import { TargetCommitCoordinator } from "./target-commit-coordinator";
import { TargetAuthorityStore } from "./target-authority";

export type ProductionBootInfo = {
  persistent: true;
  seeded: boolean;
  shellId: string | null;
  adopted: boolean;
  selectedAppInstanceId: string;
  catalogGeneration: string;
  apps: Array<{ id: string; name: string; shellId: string }>;
};

export type ProductionArchiveExport = Readonly<{
  format: 5;
  bytes: Uint8Array;
  filename: string;
  target: TargetEvidence;
  catalogGeneration: string;
}>;

export type ProductionAuthenticatedArchiveExport = Readonly<{
  format: 5;
  bytes: Uint8Array;
  filename: string;
  target: TargetEvidence;
  catalogGeneration: string;
  authentication: BackupAuthentication;
}>;

export type ProductionAuthenticatedRestoreInspection = Readonly<{
  archiveSha256: string;
  target: TargetEvidence;
  authentication: BackupAuthentication;
  displayName: string;
  shellId: string;
}>;

export type ProductionRestoredAuthority = Readonly<{
  authority: ProductionStoreAuthority;
  target: TargetEvidence;
  boot: ProductionBootInfo;
}>;

export type ProductionAuthorityInspection = {
  catalog: ReturnType<DeviceCatalog["snapshot"]>;
  target: TargetEvidence;
  targetReservations: ReturnType<TargetAuthorityStore["reservations"]>;
  catalogReservations: ReturnType<DeviceCatalog["revisionReservations"]>;
};

export type ExistingOpenInput = {
  inventory: DurableFileInventory;
  storageKey: string;
  releaseId: string;
  nowMs: number;
  leaseTtlMs: number;
};

export type LegacyAdoptionInput = ExistingOpenInput & {
  displayName: string;
  shellId?: string;
  appInstanceId: string;
  generationId: string;
  namespaceId: string;
  adoptionOperationId: string;
};

export type ManifestTargetAdoptionInput = {
  inventory: DurableFileInventory;
  entry: LegacyBootstrapEntry;
  releaseId: string;
  nowMs: number;
  leaseTtlMs: number;
  select?: boolean;
};

export type ProductionBrowserBootInput = {
  requestedAppId: string | null;
  appCache: Array<{ id: string; name: string; shellId: string }>;
};

const CACHE_APP_ID = /^(?:default|[a-zA-Z0-9_-]{1,80})$/;
const CACHE_SHELL_ID = /^[a-z0-9_-]{1,64}$/;

function captureDataField(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw invalid("boot hint field is not plain data");
  return descriptor.value;
}

function captureBootApp(value: unknown): ProductionBrowserBootInput["appCache"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw invalid("boot app hint must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !keys.includes("id") || !keys.includes("name")
      || !keys.includes("shellId")) throw invalid("boot app hint has unknown fields");
  const id = captureDataField(value, "id");
  const name = captureDataField(value, "name");
  const shellId = captureDataField(value, "shellId");
  if (typeof id !== "string" || !CACHE_APP_ID.test(id)
      || typeof name !== "string" || name !== name.trim() || name.length < 1 || name.length > 40
      || typeof shellId !== "string" || !CACHE_SHELL_ID.test(shellId))
    throw invalid("boot app hint is invalid");
  return { id, name, shellId };
}

export function captureBrowserBootInput(value: unknown): ProductionBrowserBootInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw invalid("browser boot input must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("requestedAppId") || !keys.includes("appCache"))
    throw invalid("browser boot input has unknown fields");
  const requested = captureDataField(value, "requestedAppId");
  const source = captureDataField(value, "appCache");
  if (requested !== null && (typeof requested !== "string" || !CACHE_APP_ID.test(requested)))
    throw invalid("requested app hint is invalid");
  if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype
      || source.length > 1_000) throw invalid("boot app hint list is invalid");
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key))))
    throw invalid("boot app hint list has extra properties");
  const appCache: ProductionBrowserBootInput["appCache"] = [];
  for (let index = 0; index < source.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (!descriptor || !("value" in descriptor)) throw invalid("boot app hint list is sparse");
    appCache.push(captureBootApp(descriptor.value));
  }
  if (new Set(appCache.map(entry => entry.id)).size !== appCache.length)
    throw invalid("boot app hints contain duplicate identities");
  if (requested !== null && !appCache.some(entry => entry.id === requested)
      && !/^app_[a-z2-7]{26}$/.test(requested))
    throw invalid("requested app is missing from boot hints");
  return { requestedAppId: requested as string | null, appCache };
}

type ProductionStoreReaderMethod =
  | "attachmentStorage" | "attachmentsForRecord" | "attemptStats" | "automationRuns"
  | "fieldProvenance" | "getSetting" | "globalSearch" | "headVersion" | "history"
  | "listAutomations" | "listNotifications" | "livePanels" | "operationBatches"
  | "panelProvenance" | "previewRelationConversion"
  | "privateMetricsSummary" | "query" | "readAttachment" | "registrySnapshot"
  | "restorableRows" | "rowHistory" | "semanticSchemaTrace" | "simulateAutomation"
  | "suggestions";

export type ProductionStoreReader = Readonly<Pick<
  ClayStore, ProductionStoreReaderMethod
>>;

const PINNED_READS = Object.freeze({
  attachmentStorage: ClayStore.prototype.attachmentStorage,
  attachmentsForRecord: ClayStore.prototype.attachmentsForRecord,
  attemptStats: ClayStore.prototype.attemptStats,
  automationRuns: ClayStore.prototype.automationRuns,
  fieldProvenance: ClayStore.prototype.fieldProvenance,
  getSetting: ClayStore.prototype.getSetting,
  globalSearch: ClayStore.prototype.globalSearch,
  headVersion: ClayStore.prototype.headVersion,
  history: ClayStore.prototype.history,
  listAutomations: ClayStore.prototype.listAutomations,
  listNotifications: ClayStore.prototype.listNotifications,
  livePanels: ClayStore.prototype.livePanels,
  operationBatches: ClayStore.prototype.operationBatches,
  panelProvenance: ClayStore.prototype.panelProvenance,

  previewRelationConversion: ClayStore.prototype.previewRelationConversion,
  privateMetricsSummary: ClayStore.prototype.privateMetricsSummary,
  query: ClayStore.prototype.query,
  readAttachment: ClayStore.prototype.readAttachment,
  registrySnapshot: ClayStore.prototype.registrySnapshot,
  restorableRows: ClayStore.prototype.restorableRows,
  rowHistory: ClayStore.prototype.rowHistory,
  semanticSchemaTrace: ClayStore.prototype.semanticSchemaTrace,
  simulateAutomation: ClayStore.prototype.simulateAutomation,
  suggestions: ClayStore.prototype.suggestions,
});

function createStoreReader(store: ClayStore): ProductionStoreReader {
  const reader: ProductionStoreReader = {
    attachmentStorage: PINNED_READS.attachmentStorage.bind(store),
    attachmentsForRecord: PINNED_READS.attachmentsForRecord.bind(store),
    attemptStats: PINNED_READS.attemptStats.bind(store),
    automationRuns: PINNED_READS.automationRuns.bind(store),
    fieldProvenance: PINNED_READS.fieldProvenance.bind(store),
    getSetting: PINNED_READS.getSetting.bind(store),
    globalSearch: PINNED_READS.globalSearch.bind(store),
    headVersion: PINNED_READS.headVersion.bind(store),
    history: PINNED_READS.history.bind(store),
    listAutomations: PINNED_READS.listAutomations.bind(store),
    listNotifications: PINNED_READS.listNotifications.bind(store),
    livePanels: PINNED_READS.livePanels.bind(store),
    operationBatches: PINNED_READS.operationBatches.bind(store),
    panelProvenance: PINNED_READS.panelProvenance.bind(store),

    previewRelationConversion: PINNED_READS.previewRelationConversion.bind(store),
    privateMetricsSummary: PINNED_READS.privateMetricsSummary.bind(store),
    query: PINNED_READS.query.bind(store),
    readAttachment: PINNED_READS.readAttachment.bind(store),
    registrySnapshot: PINNED_READS.registrySnapshot.bind(store),
    restorableRows: PINNED_READS.restorableRows.bind(store),
    rowHistory: PINNED_READS.rowHistory.bind(store),
    semanticSchemaTrace: PINNED_READS.semanticSchemaTrace.bind(store),
    simulateAutomation: PINNED_READS.simulateAutomation.bind(store),
    suggestions: PINNED_READS.suggestions.bind(store),
  };
  return Object.freeze(reader);
}

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

const ARCHIVE_SEAL_KEYS = ["backupTrustKey", "keyId", "seriesId", "generation"] as const;
const MAX_UINT64 = (1n << 64n) - 1n;

function captureSealBytes(value: unknown, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)
      || Object.getPrototypeOf(value) !== Uint8Array.prototype
      || !(value.buffer instanceof ArrayBuffer)
      || value.byteLength !== length)
    throw new ClayError("E_VALIDATION", `${label} is malformed`);
  const copy = Uint8Array.prototype.slice.call(value) as Uint8Array;
  if (copy.every(byte => byte === 0)) {
    copy.fill(0);
    throw new ClayError("E_VALIDATION", `${label} must not be all zero`);
  }
  return copy;
}

function captureArchiveSealMaterial(raw: ArchiveSealMaterialV1): ArchiveSealMaterialV1 {
  if (!raw || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype)
    throw new ClayError("E_VALIDATION", "archive seal material is malformed");
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== ARCHIVE_SEAL_KEYS.length
      || ARCHIVE_SEAL_KEYS.some(key => !ownKeys.includes(key)))
    throw new ClayError("E_VALIDATION", "archive seal material has unknown or missing fields");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values: Partial<Record<typeof ARCHIVE_SEAL_KEYS[number], unknown>> = {};
  for (const key of ARCHIVE_SEAL_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor))
      throw new ClayError("E_VALIDATION", "archive seal material cannot use accessors");
    values[key] = descriptor.value;
  }
  const backupTrustKey = captureSealBytes(values.backupTrustKey, 32, "Backup Trust Key");
  const keyId = captureSealBytes(values.keyId, 16, "Backup Trust Key ID");
  const seriesId = captureSealBytes(values.seriesId, 16, "backup series ID");
  if (keyId.every((byte, index) => byte === seriesId[index])) {
    backupTrustKey.fill(0); keyId.fill(0); seriesId.fill(0);
    throw new ClayError("E_VALIDATION", "backup key and series IDs must differ");
  }
  if (typeof values.generation !== "bigint"
      || values.generation < 1n || values.generation > MAX_UINT64) {
    backupTrustKey.fill(0); keyId.fill(0); seriesId.fill(0);
    throw new ClayError("E_VALIDATION", "backup generation is outside uint64");
  }
  return { backupTrustKey, keyId, seriesId, generation: values.generation };
}

function sealBytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function acquireBootFence(
  session: LiveWriteSession,
  input: Pick<ExistingOpenInput, "releaseId" | "nowMs" | "leaseTtlMs">,
): WriteFence {
  const catalog = DeviceCatalog.openExisting(session.driver);
  const snapshot = catalog.snapshot();
  const targetReserved = TargetAuthorityStore.open(session.driver).reservations()
    .filter(reservation => reservation.state === "reserved");
  const catalogReserved = catalog.revisionReservations()
    .filter(reservation => reservation.state === "reserved");
  if (targetReserved.length === 0 && catalogReserved.length === 0)
    return session.authority.run(() => catalog.acquireWriteLease({
      expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
      expectedCatalogGeneration: snapshot.catalogGeneration,
      expectedWriteEpoch: snapshot.writeEpoch,
      releaseId: input.releaseId,
      nowMs: input.nowMs,
      ttlMs: input.leaseTtlMs,
    }));
  if (targetReserved.length !== 1 || catalogReserved.length !== 1
      || targetReserved[0]!.operationId !== catalogReserved[0]!.operationId)
    throw invalid("boot found incomplete mirrored reservation recovery evidence");
  return new TargetCommitCoordinator(
    session, undefined, () => input.nowMs,
  ).recoverExpiredReservation({
    expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
    expectedCatalogGeneration: snapshot.catalogGeneration,
    expectedWriteEpoch: snapshot.writeEpoch,
    operationId: targetReserved[0]!.operationId,
    releaseId: input.releaseId,
    ttlMs: input.leaseTtlMs,
  }).fence;
}

export function planLegacyBootstrap(
  inventory: DurableFileInventory,
  input: unknown,
): LegacyBootstrapEntry[] {
  const bootInput = captureBrowserBootInput(input);
  if (inventory.state !== "complete" || inventory.catalogPresent
      || inventory.namespaces.length < 1
      || inventory.namespaces.some(namespace => namespace.kind !== "legacy"))
    throw invalid("legacy bootstrap requires a complete catalog-free legacy inventory");
  const selectedStorageKey = bootInput.requestedAppId
    ?? (inventory.namespaces.some(namespace => namespace.storageKey === "default")
      ? "default" : inventory.namespaces[0]!.storageKey);
  if (!inventory.namespaces.some(namespace => namespace.storageKey === selectedStorageKey))
    throw invalid("requested app does not match a legacy namespace");
  const result: LegacyBootstrapEntry[] = [];
  for (let index = 0; index < inventory.namespaces.length; index++) {
    const physical = inventory.namespaces[index]!;
    const hint = bootInput.appCache.find(candidate => candidate.id === physical.storageKey);
    let namespaceId = mintProductionAuthorityId("ns");
    while (namespaceId === physical.storageKey) namespaceId = mintProductionAuthorityId("ns");
    result.push({
      ...physical,
      appInstanceId: mintProductionAuthorityId("app"),
      generationId: mintProductionAuthorityId("gen"),
      namespaceId,
      operationId: mintProductionAuthorityId("op"),
      displayName: hint?.name ?? "My app",
      shellId: hint?.shellId ?? "blank",
      selected: physical.storageKey === selectedStorageKey,
    });
  }
  return result;
}

async function resumeBrowserLegacyBootstrap(
  inventory: DurableFileInventory,
  releaseId: string,
  nowMs: number,
  leaseTtlMs: number,
): Promise<ProductionStoreAuthority> {
  if (inventory.state !== "complete" || !inventory.catalogPresent)
    throw invalid("legacy bootstrap recovery requires a complete catalog inventory");
  const probe = await openBrowserCatalogProbe();
  let manifest: LegacyBootstrapEntry[];
  try {
    const catalog = DeviceCatalog.openExisting(probe);
    manifest = catalog.legacyBootstrapManifest();
    if (manifest.length < 1) throw invalid("legacy bootstrap manifest is empty");
    const declared = [
      ...catalog.activeTargetStorageInventory().map(item =>
        physicalNamespaceEntry(item.storageKey, item.namespaceId)),
      ...manifest.map(item => ({ storageKey: item.storageKey, userFile: item.userFile,
        systemFile: item.systemFile, kind: item.kind })),
    ].sort((left, right) => left.storageKey.localeCompare(right.storageKey));
    const observed = [...inventory.namespaces]
      .sort((left, right) => left.storageKey.localeCompare(right.storageKey));
    if (JSON.stringify(declared) !== JSON.stringify(observed)
        || manifest.filter(item => item.selected).length !== 1)
      throw invalid("legacy bootstrap manifest does not match durable inventory");
  } finally {
    probe.close();
  }
  const ordered = [
    ...manifest.filter(item => !item.selected),
    ...manifest.filter(item => item.selected),
  ];
  const catalogInventory = { ...inventory, catalogPresent: true } as DurableFileInventory;
  let selectedAuthority: ProductionStoreAuthority | null = null;
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]!;
    const driver = await openBrowserProductionTarget({
      storageKey: entry.storageKey, userFile: entry.userFile,
      systemFile: entry.systemFile, kind: entry.kind,
    });
    const authority = ProductionStoreAuthority.adoptManifestTarget(driver, {
      inventory: catalogInventory,
      entry,
      releaseId,
      nowMs,
      leaseTtlMs,
      select: true,
    });
    if (index === ordered.length - 1) selectedAuthority = authority;
    else authority.close();
  }
  if (!selectedAuthority) throw invalid("legacy bootstrap did not select an app");
  return selectedAuthority;
}

export function resolveCatalogInventory(
  snapshot: ReturnType<DeviceCatalog["snapshot"]>,
  activeStorage: ReturnType<DeviceCatalog["activeTargetStorageInventory"]>,
  selectedStorageKey: string,
  inventory: DurableFileInventory,
): string {
  if (inventory.state !== "complete" || !inventory.catalogPresent)
    throw invalid("catalog inventory is incomplete");
  const required = new Map(activeStorage.map(target => [
    target.storageKey,
    physicalNamespaceEntry(target.storageKey, target.namespaceId),
  ] as const));
  if (!required.has(selectedStorageKey)
      || required.size !== snapshot.entries.length
      || activeStorage.length !== snapshot.entries.length)
    throw invalid("catalog generation inventory is internally ambiguous");
  const observed = new Map(inventory.namespaces.map(namespace => [namespace.storageKey, namespace]));
  if (observed.size !== inventory.namespaces.length || observed.size !== required.size)
    throw invalid("catalog inventory does not exactly match retained durable generations");
  for (const [storageKey, expected] of required) {
    const actual = observed.get(storageKey);
    if (!actual || actual.userFile !== expected.userFile
        || actual.systemFile !== expected.systemFile || actual.kind !== expected.kind)
      throw invalid("catalog inventory physical namespace does not exactly match");
  }
  return selectedStorageKey;
}

const TEST_COORDINATORS = new WeakMap<
  ProductionStoreAuthority, ProductionMutationCoordinator
>();

function bootInfoFromCatalog(
  store: ClayStore,
  catalog: ReturnType<DeviceCatalog["snapshot"]>,
  adopted: boolean,
): ProductionBootInfo {
  if (!catalog.selectedAppInstanceId)
    throw invalid("catalog has no selected app");
  return {
    persistent: true,
    seeded: store.headVersion() > 0,
    shellId: store.getSetting<string>("shell_id") ?? null,
    adopted,
    selectedAppInstanceId: catalog.selectedAppInstanceId,
    catalogGeneration: catalog.catalogGeneration,
    apps: catalog.entries.map(entry => ({
      id: entry.appInstanceId,
      name: entry.displayName,
      shellId: entry.shellId,
    })),
  };
}

function pendingNamespaceFileNames(namespaceId: string): Set<string> {
  const files = physicalNamespaceEntry(namespaceId, namespaceId);
  return new Set(
    [files.userFile, files.systemFile].flatMap(file =>
      ["", "-journal", "-wal", "-shm"].map(suffix => `${file}${suffix}`)),
  );
}

/** Source-private pure planner exercised at every restore creation kill point. */
export function planPendingRestoreReconciliation(input: Readonly<{
  names: readonly string[];
  active: readonly Readonly<{ storageKey: string; namespaceId: string }>[];
  pendingNamespaceId: string;
}>): Readonly<{ survivors: readonly string[] }> {
  const names = [...input.names].sort((left, right) => left.localeCompare(right));
  if (new Set(names).size !== names.length || !names.includes("/clay-device-catalog-v1.db"))
    throw invalid("pending restore inventory is malformed");
  const required = new Set<string>(["/clay-device-catalog-v1.db"]);
  for (const item of input.active) {
    const files = physicalNamespaceEntry(item.storageKey, item.namespaceId);
    required.add(files.userFile);
    required.add(files.systemFile);
  }
  const pending = pendingNamespaceFileNames(input.pendingNamespaceId);
  if ([...required].some(name => !names.includes(name))
      || names.some(name => !required.has(name) && !pending.has(name)))
    throw invalid("durable inventory contains data unrelated to the pending restore");
  return Object.freeze({
    survivors: Object.freeze(names.filter(name => !pending.has(name))),
  });
}

async function reconcilePendingBrowserRestore(): Promise<void> {
  const names = await browserDurableFileNames();
  if (!names.includes("/clay-device-catalog-v1.db")) return;
  let probe = createLiveWriteGuard(await openBrowserCatalogProbe());
  let job: ReturnType<DeviceCatalog["pendingRestoreJobs"]>[number] | null = null;
  let survivors: readonly string[] | null = null;
  try {
    const catalog = DeviceCatalog.openForRestoreRecovery(probe.driver);
    const jobs = catalog.pendingRestoreJobs();
    if (jobs.length === 0) return;
    if (jobs.length !== 1) throw invalid("multiple pending restore jobs are unsupported");
    job = jobs[0]!;
    const active = catalog.activeTargetStorageInventory();
    if (active.some(item => item.namespaceId === job!.namespaceId
        || item.target.appInstanceId === job!.appInstanceId))
      throw invalid("pending restore destination is already published");
    survivors = planPendingRestoreReconciliation({
      names,
      active,
      pendingNamespaceId: job.namespaceId,
    }).survivors;
  } finally {
    probe.driver.close();
  }
  if (!job || !survivors) return;

  await deleteBrowserGenerationNamespace(job.namespaceId);
  const afterDelete = await browserDurableFileNames();
  if (JSON.stringify(afterDelete) !== JSON.stringify(survivors))
    throw invalid("unpublished restore namespace cleanup failed read-back");

  probe = createLiveWriteGuard(await openBrowserCatalogProbe());
  try {
    const catalog = DeviceCatalog.openForRestoreRecovery(probe.driver);
    const current = catalog.pendingRestoreJobs();
    if (current.length !== 1 || JSON.stringify(current[0]) !== JSON.stringify(job))
      throw invalid("pending restore changed during boot reconciliation");
    probe.authority.run(() => catalog.clearPendingRestoreJob(job!.jobId));
    DeviceCatalog.openExisting(probe.driver);
  } finally {
    probe.driver.close();
  }
}

export class ProductionStoreAuthority {
  readonly #driver: DbDriver;
  readonly #store: ClayStore;
  readonly #reader: ProductionStoreReader;
  readonly #writeAuthority: LiveWriteSession["authority"];
  readonly #boot: ProductionBootInfo;
  readonly #coordinator: ProductionMutationCoordinator;
  readonly #leaseTtlMs: number;

  private constructor(
    session: LiveWriteSession,
    store: ClayStore,
    boot: ProductionBootInfo,
    fence: WriteFence,
    catalogGeneration: string,
    leaseTtlMs: number,
  ) {
    this.#driver = session.driver;
    this.#store = store;
    this.#reader = createStoreReader(store);
    this.#writeAuthority = session.authority;
    this.#boot = boot;
    this.#leaseTtlMs = leaseTtlMs;
    this.#coordinator = new ProductionMutationCoordinator(
      session.driver,
      session.authority,
      store,
      fence,
      catalogGeneration,
      TargetAuthorityStore.open(session.driver).evidence(),
      leaseTtlMs,
      () => Date.now(),
    );
    TEST_COORDINATORS.set(this, this.#coordinator);
  }

  static async bootBrowser(input: unknown): Promise<ProductionStoreAuthority> {
    const bootInput = captureBrowserBootInput(input);
    await reconcilePendingBrowserRestore();
    const inventory = await browserDurableInventory();
    if (inventory.state !== "complete")
      throw invalid(`durable namespace inventory is ${inventory.reason}`);
    const nowMs = Date.now();
    const releaseId = mintProductionAuthorityId("rel");
    const leaseTtlMs = 60_000;

    if (inventory.catalogPresent) {
      const probeSession = createLiveWriteGuard(await openBrowserCatalogProbe());
      let storageKey: string | null = null;
      let namespace: DurableNamespaceInventoryEntry | null = null;
      let resumeBootstrap = false;
      try {
        const catalog = DeviceCatalog.openExisting(probeSession.driver);
        const manifest = catalog.legacyBootstrapManifest();
        if (manifest.length > 0) {
          const desired = manifest.find(entry => entry.selected);
          if (!desired) throw invalid("legacy bootstrap selection is missing");
          if (bootInput.requestedAppId !== null
              && bootInput.requestedAppId !== desired.storageKey
              && bootInput.requestedAppId !== desired.appInstanceId)
            throw invalid("requested app conflicts with the durable bootstrap selection");
          resumeBootstrap = true;
        } else {
          let selected = catalog.selectedTargetStorage();
          if (bootInput.requestedAppId !== null) {
            const desired = catalog.activeTargetStorageInventory().find(item =>
              item.target.appInstanceId === bootInput.requestedAppId
              || item.storageKey === bootInput.requestedAppId);
            if (!desired) throw invalid("requested app is not in the authoritative catalog");
            if (desired.target.appInstanceId !== selected.target.appInstanceId) {
              const beforeLease = catalog.snapshot();
              const fence = probeSession.authority.run(() => catalog.acquireWriteLease({
                expectedAuthorityIncarnationId: beforeLease.authorityIncarnationId,
                expectedCatalogGeneration: beforeLease.catalogGeneration,
                expectedWriteEpoch: beforeLease.writeEpoch,
                releaseId,
                nowMs,
                ttlMs: leaseTtlMs,
              }));
              probeSession.authority.run(() => catalog.selectApp({
                expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
                appInstanceId: desired.target.appInstanceId,
                operationId: mintProductionAuthorityId("op"),
                fence,
                nowMs,
              }));
              selected = catalog.selectedTargetStorage();
            }
          }
          storageKey = resolveCatalogInventory(
            catalog.snapshot(), catalog.activeTargetStorageInventory(),
            selected.storageKey, inventory,
          );
          const observed = inventory.namespaces.find(candidate =>
            candidate.storageKey === storageKey);
          if (!observed) throw invalid("selected physical namespace is unavailable");
          namespace = observed;
        }
      } finally {
        probeSession.driver.close();
      }
      if (resumeBootstrap)
        return resumeBrowserLegacyBootstrap(inventory, releaseId, nowMs, leaseTtlMs);
      if (!namespace || storageKey === null)
        throw invalid("selected physical namespace is unavailable");
      const driver = await openBrowserProductionTarget(namespace);
      return ProductionStoreAuthority.openExisting(driver, {
        inventory, storageKey, releaseId, nowMs, leaseTtlMs,
      });
    }

    if (inventory.namespaces.length > 1
        && inventory.namespaces.every(namespace => namespace.kind === "legacy")) {
      const manifest = planLegacyBootstrap(inventory, bootInput);
      const declarationTarget = manifest[0]!;
      const driver = await openBrowserProductionTarget({
        storageKey: declarationTarget.storageKey,
        userFile: declarationTarget.userFile,
        systemFile: declarationTarget.systemFile,
        kind: declarationTarget.kind,
      });
      const session = createLiveWriteGuard(driver);
      try {
        session.authority.run(() => {
          const catalog = DeviceCatalog.initializeFresh(session.driver);
          catalog.beginLegacyBootstrap(manifest, new Date(nowMs).toISOString());
        });
      } finally {
        session.driver.close();
      }
      const catalogInventory = { ...inventory, catalogPresent: true } as DurableFileInventory;
      return resumeBrowserLegacyBootstrap(
        catalogInventory, releaseId, nowMs, leaseTtlMs,
      );
    }

    if (inventory.namespaces.length === 1 && inventory.namespaces[0]?.kind === "legacy") {
      const namespace = inventory.namespaces[0];
      const storageKey = namespace.storageKey;
      if (bootInput.requestedAppId !== null && bootInput.requestedAppId !== storageKey)
        throw invalid("requested app does not match the inventoried legacy namespace");
      const hint = bootInput.appCache.find(candidate => candidate.id === storageKey);
      const driver = await openBrowserProductionTarget(namespace);
      return ProductionStoreAuthority.adoptLegacy(driver, {
        inventory,
        storageKey,
        displayName: hint?.name ?? "My app",
        shellId: hint?.shellId,
        appInstanceId: mintProductionAuthorityId("app"),
        generationId: mintProductionAuthorityId("gen"),
        namespaceId: mintProductionAuthorityId("ns"),
        adoptionOperationId: mintProductionAuthorityId("op"),
        releaseId,
        nowMs,
        leaseTtlMs,
      });
    }
    if (inventory.namespaces.length !== 0)
      throw invalid("uncatalogued durable namespaces are ambiguous");
    if (bootInput.appCache.length > 1)
      throw invalid("empty durable inventory cannot adopt multiple cached apps");
    const hint = bootInput.requestedAppId === null
      ? bootInput.appCache[0]
      : bootInput.appCache.find(candidate => candidate.id === bootInput.requestedAppId);

    const namespaceId = mintProductionAuthorityId("ns");
    const driver = await openBrowserProductionTarget(
      physicalNamespaceEntry(namespaceId, namespaceId),
    );
    return ProductionStoreAuthority.initializeFresh(driver, {
      inventory,
      storageKey: namespaceId,
      displayName: hint?.name ?? "My app",
      shellId: hint?.shellId,
      appInstanceId: mintProductionAuthorityId("app"),
      generationId: mintProductionAuthorityId("gen"),
      namespaceId,
      adoptionOperationId: mintProductionAuthorityId("op"),
      releaseId,
      nowMs,
      leaseTtlMs,
    });
  }

  static adoptManifestTarget(
    driver: DbDriver,
    input: ManifestTargetAdoptionInput,
  ): ProductionStoreAuthority {
    const observed = input.inventory.state === "complete" && input.inventory.catalogPresent
      ? input.inventory.namespaces.find(candidate => candidate.storageKey === input.entry.storageKey)
      : undefined;
    if (!observed || observed.userFile !== input.entry.userFile
        || observed.systemFile !== input.entry.systemFile || observed.kind !== input.entry.kind
        || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
      throw invalid("manifest adoption requires its exact catalogued physical namespace");
    const session = createLiveWriteGuard(driver);
    try {
      const beforeLease = DeviceCatalog.openExisting(session.driver).snapshot();
      const fence = session.authority.run(() =>
        DeviceCatalog.openExisting(session.driver).acquireWriteLease({
          expectedAuthorityIncarnationId: beforeLease.authorityIncarnationId,
          expectedCatalogGeneration: beforeLease.catalogGeneration,
          expectedWriteEpoch: beforeLease.writeEpoch,
          releaseId: input.releaseId,
          nowMs: input.nowMs,
          ttlMs: input.leaseTtlMs,
        }));
      const openedStore = session.authority.run(() => {
        const catalog = DeviceCatalog.openExisting(session.driver);
        const manifest = catalog.legacyBootstrapManifest().find(candidate =>
          candidate.storageKey === input.entry.storageKey);
        if (!manifest || JSON.stringify(manifest) !== JSON.stringify(input.entry))
          throw invalid("manifest adoption entry changed before target initialization");
        const store = ClayStore.fromDriver(session.driver);
        if (store.getSetting<number>("current_version") === undefined)
          store.setSetting("current_version", store.headVersion());
        const registry = store.validationRegistrySnapshot();
        const census = enumerateCanonicalStateV1(session.driver, registry);
        StateMerkleIndex.createSchema(session.driver);
        StateMerkleIndex.initialize(session.driver, census.leaves.map(item => item.seed));
        TargetAuthorityStore.createSchema(session.driver);
        const target = TargetAuthorityStore.initialize(session.driver, {
          schema: 1,
          appInstanceId: manifest.appInstanceId,
          activeGenerationId: manifest.generationId,
          lineageEpoch: "0",
          lineageEpochHighWater: "0",
          protectionRevision: "0",
          protectionRevisionHighWater: "0",
          digestSchema: 1,
        }).evidence();
        const currentCatalog = catalog.snapshot();
        catalog.addAppTarget({
          expectedCatalogGeneration: currentCatalog.catalogGeneration,
          target,
          namespaceId: manifest.namespaceId,
          storageKey: manifest.storageKey,
          displayName: manifest.displayName,
          shellId: manifest.shellId,
          operationId: manifest.operationId,
          fence,
          nowMs: input.nowMs,
          select: true,
          bootstrapStorageKey: manifest.storageKey,
        });
        const audited = enumerateCanonicalStateV1(session.driver, registry);
        const merkle = StateMerkleIndex.open(session.driver).audit();
        if (audited.stateSha256 !== target.stateSha256
            || audited.stateSha256 !== merkle.stateSha256
            || audited.leaves.length !== merkle.leafCount)
          throw invalid("manifest target failed canonical read-back");
        return store;
      });
      const after = DeviceCatalog.openExisting(session.driver).snapshot();
      return new ProductionStoreAuthority(
        session,
        openedStore,
        bootInfoFromCatalog(openedStore, after, true),
        fence,
        after.catalogGeneration,
        input.leaseTtlMs,
      );
    } catch (error) {
      session.driver.close();
      throw error;
    }
  }

  static adoptLegacy(driver: DbDriver, input: LegacyAdoptionInput): ProductionStoreAuthority {
    if (input.inventory.state !== "complete" || input.inventory.catalogPresent
        || input.inventory.namespaces.length !== 1
        || input.inventory.namespaces[0]?.kind !== "legacy"
        || input.inventory.namespaces[0].storageKey !== input.storageKey)
      throw invalid("legacy adoption requires one complete catalog-free namespace inventory");
    return ProductionStoreAuthority.initializeUncatalogued(driver, input, true);
  }

  static initializeFresh(driver: DbDriver, input: LegacyAdoptionInput): ProductionStoreAuthority {
    if (input.inventory.state !== "complete" || input.inventory.catalogPresent
        || input.inventory.namespaces.length !== 0 || input.storageKey !== input.namespaceId)
      throw invalid("fresh initialization requires an exact empty durable inventory");
    return ProductionStoreAuthority.initializeUncatalogued(driver, input, false);
  }

  private static initializeUncatalogued(
    driver: DbDriver,
    input: LegacyAdoptionInput,
    adopted: boolean,
  ): ProductionStoreAuthority {
    const appInstanceId = AppInstanceId.safeParse(input.appInstanceId);
    const generationId = GenerationId.safeParse(input.generationId);
    const namespaceId = NamespaceId.safeParse(input.namespaceId);
    const operationId = OperationId.safeParse(input.adoptionOperationId);
    if (!appInstanceId.success || !generationId.success || !namespaceId.success
        || !operationId.success || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
      throw invalid("durable target initialization identity is invalid");
    let at: string;
    try { at = new Date(input.nowMs).toISOString(); }
    catch { throw invalid("durable target initialization time is invalid"); }

    const session = createLiveWriteGuard(driver);
    let store: ClayStore | null = null;
    try {
      session.authority.run(() => {
        // Catalog creation is deliberately the first durable write after the
        // caller's complete inventory decision.
        const catalog = DeviceCatalog.initializeFresh(session.driver);
        store = ClayStore.fromDriver(session.driver);
        if (store.getSetting<number>("current_version") === undefined)
          store.setSetting("current_version", store.headVersion());
        const registry = store.validationRegistrySnapshot();
        const census = enumerateCanonicalStateV1(session.driver, registry);
        StateMerkleIndex.createSchema(session.driver);
        StateMerkleIndex.initialize(session.driver, census.leaves.map(entry => entry.seed));
        TargetAuthorityStore.createSchema(session.driver);
        const target = TargetAuthorityStore.initialize(session.driver, {
          schema: 1,
          appInstanceId: appInstanceId.data,
          activeGenerationId: generationId.data,
          lineageEpoch: "0",
          lineageEpochHighWater: "0",
          protectionRevision: "0",
          protectionRevisionHighWater: "0",
          digestSchema: 1,
        }).evidence();
        catalog.seedSelectedTarget({
          target,
          namespaceId: namespaceId.data,
          storageKey: input.storageKey,
          displayName: input.displayName,
          shellId: input.shellId ?? String(store!.getSetting("shell_id") ?? "blank"),
          operationId: operationId.data,
          at,
        });
        const audited = enumerateCanonicalStateV1(session.driver, registry);
        const merkle = StateMerkleIndex.open(session.driver).audit();
        if (audited.stateSha256 !== target.stateSha256
            || audited.stateSha256 !== merkle.stateSha256
            || audited.leaves.length !== merkle.leafCount)
          throw invalid("initialized target failed canonical read-back");
      });
      if (!store) throw invalid("durable target initialization did not produce a Store");
      return ProductionStoreAuthority.finishBoot(session, store as ClayStore, input, adopted);
    } catch (error) {
      try { session.driver.close(); } catch { /* Store construction may already have closed it. */ }
      throw error;
    }
  }

  static openExisting(driver: DbDriver, input: ExistingOpenInput): ProductionStoreAuthority {
    if (input.inventory.state !== "complete" || !input.inventory.catalogPresent)
      throw invalid("existing boot requires a complete catalog inventory");

    // Validate the catalog and its selected physical namespace before claiming
    // or mutating the target connection.
    const catalogBeforeGuard = DeviceCatalog.openExisting(driver);
    const selected = catalogBeforeGuard.selectedTargetStorage();
    resolveCatalogInventory(
      catalogBeforeGuard.snapshot(), catalogBeforeGuard.activeTargetStorageInventory(),
      selected.storageKey, input.inventory,
    );
    if (selected.storageKey !== input.storageKey)
      throw invalid("durable inventory does not match the catalog-selected namespace");

    const session = createLiveWriteGuard(driver);
    try {
      const fence = acquireBootFence(session, input);
      let store: ClayStore | null = null;
      session.authority.run(() => {
        const currentCatalog = DeviceCatalog.openExisting(session.driver);
        currentCatalog.assertWriteFence(fence, input.nowMs);
        const currentSelected = currentCatalog.selectedTargetStorage();
        if (currentSelected.storageKey !== selected.storageKey
            || !sameTarget(currentSelected.target, selected.target))
          throw invalid("catalog selection changed while the target was opening");
        store = ClayStore.fromDriver(session.driver);
        const target = TargetAuthorityStore.open(session.driver).evidence();
        if (!sameTarget(target, selected.target))
          throw invalid("catalog and target authority disagree");
        const census = enumerateCanonicalStateV1(
          session.driver, store.validationRegistrySnapshot(),
        );
        const merkle = StateMerkleIndex.open(session.driver).audit();
        if (census.stateSha256 !== target.stateSha256
            || census.stateSha256 !== merkle.stateSha256
            || census.leaves.length !== merkle.leafCount)
          throw invalid("existing target failed canonical read-back");
      });
      if (!store) throw invalid("existing target did not produce a Store");
      const openedStore = store as ClayStore;
      const afterLease = DeviceCatalog.openExisting(session.driver).snapshot();
      return new ProductionStoreAuthority(
        session,
        openedStore,
        bootInfoFromCatalog(openedStore, afterLease, false),
        fence,
        afterLease.catalogGeneration,
        input.leaseTtlMs,
      );
    } catch (error) {
      try { session.driver.close(); } catch { /* Store construction may already have closed it. */ }
      throw error;
    }
  }

  private static finishBoot(
    session: LiveWriteSession,
    store: ClayStore,
    input: ExistingOpenInput,
    adopted: boolean,
  ): ProductionStoreAuthority {
    const catalog = DeviceCatalog.openExisting(session.driver);
    const fence = acquireBootFence(session, input);
    const afterLease = catalog.snapshot();
    return new ProductionStoreAuthority(
      session,
      store,
      bootInfoFromCatalog(store, afterLease, adopted),
      fence,
      afterLease.catalogGeneration,
      input.leaseTtlMs,
    );
  }

  bootInfo(): ProductionBootInfo {
    return {
      ...this.#boot,
      apps: this.#boot.apps.map(app => ({ ...app })),
    };
  }

  readStore(): ProductionStoreReader {
    return this.#reader;
  }

  query(...args: Parameters<ClayStore["query"]>): ReturnType<ClayStore["query"]> {
    return this.#reader.query(...args);
  }

  readSetting<T>(key: string): T | undefined {
    return this.#reader.getSetting<T>(key);
  }

  readRowHistoryCount(): number {
    return this.#store.rowHistoryCount();
  }

  sampleRowCount(): number {
    assertLiveSampleProvenance(
      this.#driver, this.#store, TargetAuthorityStore.open(this.#driver).evidence(),
    );
    return activeSampleRowCount(this.#store);
  }

  executeMutation(input: unknown): Promise<ProductionMutationResult> {
    return this.#coordinator.execute(input);
  }

  createRequestId(): string {
    return this.#coordinator.mintRequestId();
  }

  backupSelection(): Promise<ProductionBackupSelection> {
    return this.#coordinator.backupSelection();
  }

  backupRecords(): Promise<BackupRecord[]> {
    return this.#coordinator.backupRecords();
  }

  backupMetadata(): { fileLabel: string; shapeHead: number; shapeCurrent: number } {
    const catalog = DeviceCatalog.openExisting(this.#driver).snapshot();
    const entry = catalog.entries.find(candidate =>
      candidate.appInstanceId === catalog.selectedAppInstanceId);
    if (!entry) throw invalid("backup metadata has no selected app");
    const shapeHead = this.#reader.headVersion();
    const shapeCurrent = this.#reader.getSetting<number>("current_version") ?? shapeHead;
    if (!Number.isSafeInteger(shapeHead) || shapeHead < 0
        || !Number.isSafeInteger(shapeCurrent) || shapeCurrent < 0 || shapeCurrent > shapeHead)
      throw invalid("backup shape metadata is invalid");
    return { fileLabel: entry.displayName, shapeHead, shapeCurrent };
  }

  publishBackup(input: BackupPublicationRequest): Promise<BackupPublicationReceipt> {
    return this.#coordinator.publishBackup(input);
  }

  async validateAuthenticatedArchiveStage(
    bytesInput: Uint8Array,
    expectedInput: TargetEvidence,
    backupTrustKeyInput: Uint8Array,
  ): Promise<BackupStageValidation> {
    if (!(bytesInput instanceof Uint8Array)
        || Object.getPrototypeOf(bytesInput) !== Uint8Array.prototype
        || !(backupTrustKeyInput instanceof Uint8Array)
        || Object.getPrototypeOf(backupTrustKeyInput) !== Uint8Array.prototype
        || backupTrustKeyInput.byteLength !== 32)
      throw invalid("authenticated backup stage input is malformed");
    const bytes = bytesInput;
    const key = backupTrustKeyInput.slice();
    const expected = TargetEvidenceV1.parse(expectedInput);
    try {
      return await this.#coordinator.serializeRead(async () => {
        const selected = DeviceCatalog.openExisting(this.#driver).selectedTargetStorage().target;
        if (!sameTarget(selected, expected)) return {
          schema: 1,
          status: "invalid",
          evidence: null,
        };
        const { validateAuthenticatedAuthorityArchiveStage } =
          await import("./archive-authority");
        return validateAuthenticatedAuthorityArchiveStage(bytes, expected, () => key);
      });
    } finally {
      key.fill(0);
    }
  }

  async inspectAuthenticatedRestoreArchive(
    bytesInput: Uint8Array,
    backupTrustKeyInput: Uint8Array,
  ): Promise<ProductionAuthenticatedRestoreInspection> {
    if (!(bytesInput instanceof Uint8Array)
        || Object.getPrototypeOf(bytesInput) !== Uint8Array.prototype
        || !(backupTrustKeyInput instanceof Uint8Array)
        || Object.getPrototypeOf(backupTrustKeyInput) !== Uint8Array.prototype
        || backupTrustKeyInput.byteLength !== 32)
      throw invalid("authenticated restore inspection input is malformed");
    const bytes = bytesInput;
    const key = backupTrustKeyInput.slice();
    try {
      return await this.#coordinator.serializeRead(async () => {
        const { importAuthenticatedAuthorityArchive } = await import("./archive-authority");
        const imported = await importAuthenticatedAuthorityArchive(
          bytes, () => key, undefined, "transferred",
        );
        try {
          const header = imported.authority.authentication;
          const source = imported.authority.evidence.catalogAuthority.entry;
          return Object.freeze({
            archiveSha256: `sha256:${sha256HexSync(bytes)}`,
            target: Object.freeze({ ...imported.authority.evidence.target }),
            authentication: Object.freeze({
              schema: 1 as const,
              kind: "cose_mac0_hmac_256_256" as const,
              authenticationVersion: 1 as const,
              keyId: sealBytesToHex(header.keyId),
              seriesId: sealBytesToHex(header.seriesId),
              generation: header.generation.toString(),
            }),
            displayName: source.displayName,
            shellId: source.shellId,
          });
        } finally {
          imported.store.close();
        }
      });
    } finally {
      key.fill(0);
    }
  }

  async restoreAuthenticatedArchiveAsNew(
    envelopeInput: Uint8Array,
    backupTrustKeyInput: Uint8Array,
    identity: ArchiveRestoreIdentity,
    sourceProvenanceId: string,
  ): Promise<ProductionRestoredAuthority> {
    if (!(envelopeInput instanceof Uint8Array)
        || Object.getPrototypeOf(envelopeInput) !== Uint8Array.prototype
        || !(backupTrustKeyInput instanceof Uint8Array)
        || Object.getPrototypeOf(backupTrustKeyInput) !== Uint8Array.prototype
        || backupTrustKeyInput.byteLength !== 32
        || !/^restoreval_[a-z2-7]{26}$/.test(sourceProvenanceId))
      throw invalid("authenticated restore lifecycle input is malformed");
    const envelope = envelopeInput;
    const key = backupTrustKeyInput.slice();
    const before = await this.backupSelection();
    const sourceArchiveSha256 = `sha256:${sha256HexSync(envelope)}`;
    const restoreJobId = mintProductionAuthorityId("job");
    let restoredSession: LiveWriteSession | undefined;
    let published = false;
    let jobPrepared = false;
    try {
      const { verifyAuthenticatedArchiveV5Owned } = await import("./archive-authentication");
      const verified = verifyAuthenticatedArchiveV5Owned(envelope, () => key);
      const payload = verified.payload;
      try {
        const restored = await this.#coordinator.serializeRead(async () => {
          const catalogBefore = DeviceCatalog.openExisting(this.#driver).snapshot();
          const currentBefore = DeviceCatalog.openExisting(this.#driver).selectedTargetStorage().target;
          if (catalogBefore.catalogGeneration !== before.selected.catalogGeneration
              || catalogBefore.writeEpoch !== before.selected.writeEpoch
              || catalogBefore.selectedAppInstanceId !== before.selected.selectedAppInstanceId
              || !sameTarget(currentBefore, before.selected.target))
            throw invalid("restore-as-new source selection changed before installation");
          this.#writeAuthority.run(() => DeviceCatalog.openExisting(this.#driver).beginRestoreJob({
            jobId: restoreJobId,
            appInstanceId: identity.appInstanceId,
            generationId: identity.generationId,
            namespaceId: identity.namespaceId,
            operationId: identity.operationId,
            sourceArchiveSha256,
            sourceProvenanceId,
            expectedCatalogGeneration: before.selected.catalogGeneration,
            expectedSourceTarget: before.selected.target,
            fence: before.fence,
            nowMs: Date.parse(identity.restoredAt),
          }));
          jobPrepared = true;
          const { restoreAuthorityArchiveAsNew } = await import("./archive-authority");
          return restoreAuthorityArchiveAsNew(
            payload,
            identity,
            () => openBrowserProductionTarget(
              physicalNamespaceEntry(identity.namespaceId, identity.namespaceId),
            ),
            {
              wrapFreshDriver: physical => {
                restoredSession = createLiveWriteGuard(physical);
                return {
                  driver: restoredSession.driver,
                  runAuthorized: write => { restoredSession!.authority.run(write); },
                };
              },
              afterAuthorityReadBack: context => {
                const source = context.sourceAuthority.evidence.catalogAuthority.entry;
                const catalog = DeviceCatalog.openForRestoreRecovery(context.driver);
                const afterAdd = catalog.addAppTarget({
                  expectedCatalogGeneration: before.selected.catalogGeneration,
                  target: context.target,
                  namespaceId: identity.namespaceId,
                  storageKey: identity.namespaceId,
                  displayName: source.displayName,
                  shellId: source.shellId,
                  operationId: identity.operationId,
                  fence: before.fence,
                  nowMs: Date.parse(identity.restoredAt),
                  select: true,
                  sourceArchiveSha256,
                  sourceProvenanceId,
                }, restoreJobId);
                if (restoredSampleProvenanceCount(context.store) === 0) return context.target;
                return commitRestoredSampleReattestation({
                  driver: context.driver,
                  store: context.store,
                  fence: before.fence,
                  expectedCatalogGeneration: afterAdd.catalogGeneration,
                  expectedTarget: context.target,
                  requestId: mintProductionAuthorityId("req"),
                  nowMs: Date.parse(identity.restoredAt),
                  sourceArchiveSha256,
                  sourceAuthorityIncarnationId:
                    context.sourceAuthority.evidence.catalogAuthority.authorityIncarnationId,
                });
              },
            },
          );
        });
        if (!restoredSession)
          throw invalid("restore-as-new did not establish a guarded production target");
        const catalog = DeviceCatalog.openExisting(restoredSession.driver).snapshot();
        const storage = DeviceCatalog.openExisting(restoredSession.driver).selectedTargetStorage();
        if (storage.storageKey !== identity.namespaceId
            || !sameTarget(storage.target, restored.target)
            || catalog.selectedAppInstanceId !== restored.target.appInstanceId)
          throw invalid("restored production target failed catalog read-back");
        published = true;
        const boot = bootInfoFromCatalog(restored.store, catalog, false);
        const replacement = new ProductionStoreAuthority(
          restoredSession,
          restored.store,
          boot,
          before.fence,
          catalog.catalogGeneration,
          this.#leaseTtlMs,
        );
        return Object.freeze({ authority: replacement, target: restored.target, boot });
      } finally {
        payload.fill(0);
      }
    } catch (error) {
      if (!published && jobPrepared) {
        try {
          const catalog = DeviceCatalog.openExisting(this.#driver);
          const destination = catalog.activeTargetStorageInventory().find(item =>
            item.target.appInstanceId === identity.appInstanceId
              && item.namespaceId === identity.namespaceId);
          published = destination !== undefined;
        } catch { /* a prepared job intentionally blocks the strict catalog view */ }
      }
      if (!published) {
        try { restoredSession?.driver.close(); } catch { /* already closed */ }
        await deleteBrowserGenerationNamespace(identity.namespaceId);
        if (jobPrepared) {
          try {
            const names = await browserDurableFileNames();
            const files = physicalNamespaceEntry(identity.namespaceId, identity.namespaceId);
            const owned = [files.userFile, files.systemFile].flatMap(file =>
              ["", "-journal", "-wal", "-shm"].map(suffix => `${file}${suffix}`));
            if (!owned.some(name => names.includes(name))) {
              const recoveryCatalog = DeviceCatalog.openForRestoreRecovery(this.#driver);
              this.#writeAuthority.run(() => recoveryCatalog.clearPendingRestoreJob(restoreJobId));
            }
          } catch { /* boot reconciliation retains and completes the durable cleanup */ }
        }
      }
      throw error;
    } finally {
      envelope.fill(0);
      key.fill(0);
    }
  }

  async exportArchive(): Promise<ProductionArchiveExport> {
    return this.#coordinator.serializeRead(async () => {
      const readCurrent = () => {
        const catalog = DeviceCatalog.openExisting(this.#driver).snapshot();
        const target = TargetAuthorityStore.open(this.#driver).evidence();
        const entry = catalog.entries.find(candidate =>
          candidate.appInstanceId === catalog.selectedAppInstanceId);
        if (!entry || catalog.selectedAppInstanceId !== target.appInstanceId
            || entry.activeGenerationId !== target.activeGenerationId
            || entry.currentLineageEpoch !== target.lineageEpoch
            || entry.currentProtectionRevision !== target.protectionRevision
            || entry.digestSchema !== target.digestSchema
            || entry.stateSha256 !== target.stateSha256)
          throw invalid("production archive target is not the current catalog selection");
        return {
          target: { ...target },
          catalogGeneration: catalog.catalogGeneration,
          writeEpoch: catalog.writeEpoch,
          displayName: entry.displayName,
          shellId: entry.shellId,
        };
      };
      const before = readCurrent();
      const legacy = await exportStoreArchiveReadOnly(this.#store, before.displayName);
      const { exportAuthorityArchiveV5 } = await import("./archive-authority");
      const bytes = await exportAuthorityArchiveV5(legacy, this.#driver);
      const after = readCurrent();
      if (!sameTarget(before.target, after.target)
          || before.catalogGeneration !== after.catalogGeneration
          || before.writeEpoch !== after.writeEpoch
          || before.displayName !== after.displayName
          || before.shellId !== after.shellId)
        throw invalid("production archive target changed during the bounded read");
      const stem = after.displayName.normalize("NFKC").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "clay";
      return Object.freeze({
        format: 5 as const,
        bytes,
        filename: `${stem}.clay.zip`,
        target: Object.freeze({ ...after.target }),
        catalogGeneration: after.catalogGeneration,
      });
    });
  }

  async exportAuthenticatedArchive(
    rawMaterial: ArchiveSealMaterialV1,
  ): Promise<ProductionAuthenticatedArchiveExport> {
    const material = captureArchiveSealMaterial(rawMaterial);
    try {
      const inner = await this.exportArchive();
      const { CLAY_ARCHIVE_CONTENT_TYPE, sealAuthenticatedArchiveV5 } =
        await import("./archive-authentication");
      const bytes = sealAuthenticatedArchiveV5(inner.bytes, material.backupTrustKey, {
        authenticationVersion: 1,
        archiveFormat: 5,
        contentType: CLAY_ARCHIVE_CONTENT_TYPE,
        keyId: material.keyId,
        seriesId: material.seriesId,
        generation: material.generation,
      });
      return Object.freeze({
        format: 5 as const,
        bytes,
        filename: inner.filename.replace(/\.clay\.zip$/, ".clay"),
        target: inner.target,
        catalogGeneration: inner.catalogGeneration,
        authentication: Object.freeze({
          schema: 1 as const,
          kind: "cose_mac0_hmac_256_256" as const,
          authenticationVersion: 1 as const,
          keyId: sealBytesToHex(material.keyId),
          seriesId: sealBytesToHex(material.seriesId),
          generation: material.generation.toString(),
        }),
      });
    } finally {
      material.backupTrustKey.fill(0);
      material.keyId.fill(0);
      material.seriesId.fill(0);
    }
  }

  /** Package-private diagnostics used by worker-boundary certification tests. */
  inspectAuthority(): ProductionAuthorityInspection {
    const catalog = DeviceCatalog.openExisting(this.#driver);
    const target = TargetAuthorityStore.open(this.#driver);
    return {
      catalog: catalog.snapshot(),
      target: target.evidence(),
      targetReservations: target.reservations(),
      catalogReservations: catalog.revisionReservations(),
    };
  }

  asyncStore(onMutation?: (result: ProductionMutationResult) => void): AsyncStore {
    const requestId = (context?: StoreMutationContext): string =>
      context?.requestId ?? this.#coordinator.mintRequestId();
    const adapter: AsyncStore = {
      query: async q => this.#reader.query(q),
      insert: async (table, row, context) => {
        const committed = await this.executeMutation({
          requestId: requestId(context), route: "store.insert", payload: { table, row },
        });
        onMutation?.(committed);
        return committed.result as Awaited<ReturnType<AsyncStore["insert"]>>;
      },
      update: async (table, id, patch, context) => {
        const committed = await this.executeMutation({
          requestId: requestId(context), route: "store.update", payload: { table, id, patch },
        });
        onMutation?.(committed);
        return committed.result as Awaited<ReturnType<AsyncStore["update"]>>;
      },
      softDelete: async (table, id, context) => {
        const committed = await this.executeMutation({
          requestId: requestId(context), route: "store.softDelete", payload: { table, id },
        });
        onMutation?.(committed);
      },
      registryTables: async () => [...this.#store.registrySnapshot().values()],
    };
    return Object.freeze(adapter);
  }

  close(): void {
    this.#driver.close();
  }
}

/** Source-private deterministic failpoint for kernel tests only. */
export function armProductionAuthorityFailureForTest(
  authority: ProductionStoreAuthority,
  failure: ProductionMutationTestFailure = "live_mutation",
): void {
  const coordinator = TEST_COORDINATORS.get(authority);
  if (!coordinator) throw invalid("production authority test handle is unavailable");
  armProductionMutationFailureForTest(coordinator, failure);
}
