import { AppInstanceId, GenerationId, NamespaceId, OperationId } from "@clay/schema";
import type {
  TargetEvidenceV1 as TargetEvidence,
  WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import type { AsyncStore, StoreMutationContext } from "./asyncstore";
import { enumerateCanonicalStateV1 } from "./canonical-state";
import { removeLegacyCredentialSettingsForAuthorityBoot } from "./credential-policy";
import {
  browserDurableInventory,
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
  mintProductionAuthorityId,
  ProductionMutationCoordinator,
  type ProductionMutationTestFailure,
  type ProductionMutationResult,
} from "./production-mutation-coordinator";
import {
  createStoreBackedPlannerMutationAuthority,
  type PlannerMutationAuthority,
} from "./planner-authority";
import { assertLiveSampleProvenance } from "./sample-provenance-proof";
import { activeSampleRowCount } from "./production-samples";
import { stateLeafHashV1 } from "./state-merkle";
import { StateMerkleIndex, type StateMerkleChange } from "./state-merkle-index";
import { ClayStore } from "./store";
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
const STORE_PENDING_PLANNER_ATTEMPTS: ClayStore["pendingPlannerAttempts"] =
  ClayStore.prototype.pendingPlannerAttempts;
const STORE_FINISH_PLANNER_ATTEMPT: ClayStore["finishAttempt"] =
  ClayStore.prototype.finishAttempt;

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

type ActiveCatalogTarget = ReturnType<
  DeviceCatalog["activeTargetStorageInventory"]
>[number];

function resolveExistingTarget(
  driver: DbDriver,
  input: Pick<ExistingOpenInput, "inventory" | "storageKey">,
  expected?: ActiveCatalogTarget,
): ActiveCatalogTarget {
  const catalog = DeviceCatalog.openExisting(driver);
  const snapshot = catalog.snapshot();
  const active = catalog.activeTargetStorageInventory();
  const requested = active.find(candidate => candidate.storageKey === input.storageKey);
  if (!requested) throw invalid("requested physical namespace is not active");
  if (expected && (requested.namespaceId !== expected.namespaceId
      || !sameTarget(requested.target, expected.target)))
    throw invalid("requested catalog target changed while it was opening");
  resolveCatalogInventory(snapshot, active, requested.storageKey, input.inventory);
  return requested;
}

function authenticateExistingTarget(
  driver: DbDriver,
  input: Pick<ExistingOpenInput, "inventory" | "storageKey">,
  expected?: ActiveCatalogTarget,
): { store: ClayStore; target: TargetEvidence; requested: ActiveCatalogTarget } {
  const requested = resolveExistingTarget(driver, input, expected);
  const store = ClayStore.fromDriver(driver);
  removeLegacyCredentialSettingsForAuthorityBoot(driver);
  const target = TargetAuthorityStore.open(driver).evidence();
  if (!sameTarget(target, requested.target))
    throw invalid("catalog and target authority disagree");
  const census = enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot());
  const merkle = StateMerkleIndex.open(driver).audit();
  if (census.stateSha256 !== target.stateSha256
      || census.stateSha256 !== merkle.stateSha256
      || census.leaves.length !== merkle.leafCount)
    throw invalid("existing target failed canonical read-back");
  return { store, target, requested };
}

const PREFLIGHT_ROLLBACK = Object.freeze({ kind: "authenticated-target-preflight" });

function preflightExistingTarget(
  driver: DbDriver,
  input: Pick<ExistingOpenInput, "inventory" | "storageKey">,
  expected: ActiveCatalogTarget,
): number {
  let pendingCount: number | null = null;
  const session = createLiveWriteGuard(driver);
  try {
    session.authority.run(() => {
      const authenticated = authenticateExistingTarget(session.driver, input, expected);
      pendingCount = STORE_PENDING_PLANNER_ATTEMPTS.call(authenticated.store).length;
      // ClayStore schema repair and credential scrubbing are authenticated as
      // part of preflight but cannot become durable before every target passes.
      throw PREFLIGHT_ROLLBACK;
    });
  } catch (error) {
    if (error !== PREFLIGHT_ROLLBACK) throw error;
  }
  if (pendingCount === null)
    throw invalid("existing target preflight did not complete");
  return pendingCount;
}

function acquireBootFenceInTransaction(
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
    return catalog.acquireWriteLease({
      expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
      expectedCatalogGeneration: snapshot.catalogGeneration,
      expectedWriteEpoch: snapshot.writeEpoch,
      releaseId: input.releaseId,
      nowMs: input.nowMs,
      ttlMs: input.leaseTtlMs,
    });
  if (targetReserved.length !== 1 || catalogReserved.length !== 1
      || targetReserved[0]!.operationId !== catalogReserved[0]!.operationId)
    throw invalid("boot found incomplete mirrored reservation recovery evidence");
  return new TargetCommitCoordinator(
    session, undefined, () => input.nowMs,
  ).recoverExpiredReservationInBootTransaction({
    expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
    expectedCatalogGeneration: snapshot.catalogGeneration,
    expectedWriteEpoch: snapshot.writeEpoch,
    operationId: targetReserved[0]!.operationId,
    releaseId: input.releaseId,
    ttlMs: input.leaseTtlMs,
  }).fence;
}

function acquireBootFence(
  session: LiveWriteSession,
  input: Pick<ExistingOpenInput, "releaseId" | "nowMs" | "leaseTtlMs">,
): WriteFence {
  return session.authority.run(() => acquireBootFenceInTransaction(session, input));
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
  const selectedAppInstanceId = selectedAuthority.bootInfo().selectedAppInstanceId;
  selectedAuthority.close();
  // Manifest adoption is only the catalog migration phase. Re-enter ordinary
  // catalog boot so its complete active inventory is authenticated and every
  // durable pending planner attempt (including already-adopted targets from a
  // prior partial run) is reconciled before an authority can be published.
  return ProductionStoreAuthority.bootBrowser({
    requestedAppId: selectedAppInstanceId,
    appCache: [],
  });
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

export class ProductionStoreAuthority {
  readonly #driver: DbDriver;
  readonly #store: ClayStore;
  readonly #reader: ProductionStoreReader;
  readonly #boot: ProductionBootInfo;
  readonly #connectionAuthority: LiveWriteSession["authority"];
  readonly #coordinator: ProductionMutationCoordinator;
  readonly #plannerMutations: PlannerMutationAuthority;

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
    this.#boot = boot;
    this.#connectionAuthority = session.authority;
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
    this.#plannerMutations = createStoreBackedPlannerMutationAuthority(store, {
      beginAttempt: async intent => {
        const committed = await this.#coordinator.execute({
          requestId: this.#coordinator.mintRequestId(),
          route: "planner.begin",
          payload: { intent },
        });
        if (typeof committed.result !== "string")
          throw new ClayError("E_INTERNAL", "planner attempt start returned an invalid result");
        return committed.result;
      },
      finalizeAttempt: async (attemptId, outcome, errorCode) => {
        await this.#coordinator.execute({
          requestId: this.#coordinator.mintRequestId(),
          route: "planner.finalize",
          payload: { attemptId, outcome, errorCode: errorCode ?? null },
        });
      },
      keep: async (requestId, command) => {
        const committed = await this.#coordinator.execute({
          requestId,
          route: "planner.keep",
          payload: command,
        });
        if (typeof committed.result !== "number" || !Number.isSafeInteger(committed.result))
          throw new ClayError("E_INTERNAL", "planner Keep returned an invalid result");
        return committed.result;
      },
      discard: async (requestId, command) => {
        await this.#coordinator.execute({
          requestId,
          route: "planner.discard",
          payload: command,
        });
      },
    });
    TEST_COORDINATORS.set(this, this.#coordinator);
  }

  static async bootBrowser(input: unknown): Promise<ProductionStoreAuthority> {
    const bootInput = captureBrowserBootInput(input);
    let inventory = await browserDurableInventory();
    if (inventory.state !== "complete")
      throw invalid(`durable namespace inventory is ${inventory.reason}`);
    if (inventory.catalogPresent) {
      const emptyProbe = await openBrowserCatalogProbe();
      try {
        if (DeviceCatalog.isAbsent(emptyProbe)) {
          // ATTACH may create an empty catalog file before the first schema
          // transaction. Exact zero-object proof resumes catalog-free boot;
          // a partial schema continues into strict open and fails closed.
          inventory = { ...inventory, catalogPresent: false };
        }
      } finally {
        emptyProbe.close();
      }
    }
    const nowMs = Date.now();
    const releaseId = mintProductionAuthorityId("rel");
    const leaseTtlMs = 60_000;

    if (inventory.catalogPresent) {
      const probe = await openBrowserCatalogProbe();
      let storageKey: string | null = null;
      let initialStorageKey: string | null = null;
      let candidates: Array<{
        catalog: ActiveCatalogTarget;
        namespace: DurableNamespaceInventoryEntry;
      }> = [];
      let resumeBootstrap = false;
      try {
        const catalog = DeviceCatalog.openExisting(probe);
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
          const active = catalog.activeTargetStorageInventory();
          let selected = catalog.selectedTargetStorage();
          initialStorageKey = selected.storageKey;
          if (bootInput.requestedAppId !== null) {
            const desired = active.find(item =>
              item.target.appInstanceId === bootInput.requestedAppId
              || item.storageKey === bootInput.requestedAppId);
            if (!desired) throw invalid("requested app is not in the authoritative catalog");
            selected = desired;
          }
          storageKey = resolveCatalogInventory(
            catalog.snapshot(), active,
            selected.storageKey, inventory,
          );
          candidates = active.map(item => {
            const observed = inventory.namespaces.find(candidate =>
              candidate.storageKey === item.storageKey);
            if (!observed) throw invalid("active physical namespace is unavailable");
            return { catalog: item, namespace: observed };
          });
        }
      } finally {
        probe.close();
      }
      if (resumeBootstrap)
        return resumeBrowserLegacyBootstrap(inventory, releaseId, nowMs, leaseTtlMs);
      if (storageKey === null || initialStorageKey === null || candidates.length === 0)
        throw invalid("selected physical namespace is unavailable");

      // Authenticate every active physical namespace before any lease or
      // selection write. The deliberate rollback makes preflight read-only
      // even when opening ClayStore has an idempotent schema upgrade to stage.
      const inspected: Array<typeof candidates[number] & { pendingCount: number }> = [];
      for (const candidate of candidates) {
        const driver = await openBrowserProductionTarget(candidate.namespace);
        try {
          inspected.push({
            ...candidate,
            pendingCount: preflightExistingTarget(driver, {
              inventory, storageKey: candidate.namespace.storageKey,
            }, candidate.catalog),
          });
        } finally {
          driver.close();
        }
      }

      const desired = inspected.find(candidate =>
        candidate.namespace.storageKey === storageKey);
      const initiallySelected = inspected.find(candidate =>
        candidate.namespace.storageKey === initialStorageKey);
      if (!desired || !initiallySelected)
        throw invalid("selected physical namespace is unavailable");
      // Only targets with durable recovery work need a write-capable open.
      // Keep the requested target exactly once and last so ordinary all-target
      // authentication cannot durably select an intermediate namespace or
      // supersede a live fence before the publishable target opens.
      const ordered = [
        ...inspected.filter(candidate => candidate.pendingCount > 0
          && candidate.namespace.storageKey !== storageKey),
        desired,
      ];
      let selectedAuthority: ProductionStoreAuthority | null = null;
      for (let index = 0; index < ordered.length; index++) {
        const candidate = ordered[index]!;
        const publish = index === ordered.length - 1;
        const driver = await openBrowserProductionTarget(candidate.namespace);
        let opened: ProductionStoreAuthority | null = null;
        try {
          opened = ProductionStoreAuthority.openExisting(driver, {
            inventory,
            storageKey: candidate.namespace.storageKey,
            releaseId,
            nowMs,
            leaseTtlMs,
          });
          if (candidate.pendingCount > 0)
            await opened.reconcileInterruptedPlannerAttempts();
          if (publish) selectedAuthority = opened;
          else opened.close();
        } catch (error) {
          if (opened) {
            try { opened.close(); } catch { /* failed candidate is never published */ }
          } else {
            try { driver.close(); } catch { /* opening may already have closed it */ }
          }
          throw error;
        }
      }
      if (!selectedAuthority)
        throw invalid("selected target reconciliation did not publish an authority");
      return selectedAuthority;
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
        removeLegacyCredentialSettingsForAuthorityBoot(session.driver);
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
        removeLegacyCredentialSettingsForAuthorityBoot(session.driver);
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

    // Capture the requested catalog target before claiming the connection.
    const requested = resolveExistingTarget(driver, input);

    const session = createLiveWriteGuard(driver);
    try {
      let store: ClayStore | null = null;
      let fence: WriteFence | null = null;
      let finalCatalog: ReturnType<DeviceCatalog["snapshot"]> | null = null;
      session.authority.run(() => {
        const authenticated = authenticateExistingTarget(session.driver, input, requested);
        store = authenticated.store;
        const target = authenticated.target;
        const currentRequested = authenticated.requested;

        // Authentication above precedes every durable lease/selection write.
        // The outer write-authority transaction makes the fence, selection CAS,
        // target verification, and final read-back one rollback unit.
        fence = acquireBootFenceInTransaction(session, input);
        const afterLease = DeviceCatalog.openExisting(session.driver);
        const selected = afterLease.selectedTargetStorage();
        if (selected.target.appInstanceId !== currentRequested.target.appInstanceId) {
          afterLease.selectApp({
            expectedCatalogGeneration: afterLease.snapshot().catalogGeneration,
            appInstanceId: currentRequested.target.appInstanceId,
            operationId: mintProductionAuthorityId("op"),
            fence,
            nowMs: input.nowMs,
          });
        }
        const final = DeviceCatalog.openExisting(session.driver);
        final.assertWriteFence(fence, input.nowMs);
        const finalSelected = final.selectedTargetStorage();
        if (finalSelected.storageKey !== currentRequested.storageKey
            || !sameTarget(finalSelected.target, target))
          throw invalid("catalog selection failed authenticated target read-back");
        finalCatalog = final.snapshot();
      });
      if (!store || !fence || !finalCatalog)
        throw invalid("existing target did not produce a complete authority");
      const openedStore = store as ClayStore;
      const openedFence = fence as WriteFence;
      const openedCatalog = finalCatalog as ReturnType<DeviceCatalog["snapshot"]>;
      return new ProductionStoreAuthority(
        session,
        openedStore,
        bootInfoFromCatalog(openedStore, openedCatalog, false),
        openedFence,
        openedCatalog.catalogGeneration,
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
    const current = this.#connectionAuthority.run(() => {
      const catalog = DeviceCatalog.openExisting(this.#driver).snapshot();
      const selected = catalog.entries.find(entry =>
        entry.appInstanceId === catalog.selectedAppInstanceId);
      if (!selected) throw invalid("catalog-selected app is unavailable");
      const selectedTarget: TargetEvidence = {
        appInstanceId: selected.appInstanceId,
        activeGenerationId: selected.activeGenerationId,
        lineageEpoch: selected.currentLineageEpoch,
        protectionRevision: selected.currentProtectionRevision,
        digestSchema: selected.digestSchema,
        stateSha256: selected.stateSha256,
      };
      const openedTarget = TargetAuthorityStore.open(this.#driver).evidence();
      if (!sameTarget(selectedTarget, openedTarget))
        throw invalid("catalog selection no longer matches the opened target");
      return bootInfoFromCatalog(this.#store, catalog, this.#boot.adopted);
    });
    return {
      ...current,
      apps: current.apps.map(app => ({ ...app })),
    };
  }

  readStore(): ProductionStoreReader {
    return this.#reader;
  }

  plannerMutations(): PlannerMutationAuthority {
    return this.#plannerMutations;
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

  async replayPlannerDecision(
    requestId: unknown,
    decision: unknown,
  ): Promise<number | null> {
    const replayed = await this.#coordinator.replayPlannerDecision(requestId, decision);
    if (decision === "keep") {
      if (typeof replayed.result !== "number" || !Number.isSafeInteger(replayed.result))
        throw invalid("durable planner Keep result is invalid");
      return replayed.result;
    }
    if (replayed.result !== null)
      throw invalid("durable planner Discard result is invalid");
    return null;
  }

  async reconcileInterruptedPlannerAttempts(): Promise<number> {
    const attempts = STORE_PENDING_PLANNER_ATTEMPTS.call(this.#store);
    for (const attempt of attempts) await this.#coordinator.execute({
      requestId: this.#coordinator.mintRequestId(),
      route: "planner.finalize",
      payload: { attemptId: attempt.id, outcome: "failed", errorCode: "E_VALIDATION" },
    });
    if (STORE_PENDING_PLANNER_ATTEMPTS.call(this.#store).length !== 0)
      throw invalid("interrupted planner attempt reconciliation is incomplete");
    return attempts.length;
  }

  /** Fixed device-local telemetry path; never a canonical production request. */
  executeOperationalMetricMutation(input: unknown): Promise<ProductionMutationResult> {
    return this.#coordinator.executeOperationalMetric(input);
  }

  createRequestId(): string {
    return this.#coordinator.mintRequestId();
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

  asyncStore(): AsyncStore {
    const requestId = (context?: StoreMutationContext): string => {
      const value = context?.requestId ?? this.createRequestId();
      if (!/^req_[a-z2-7]{26}$/.test(value))
        throw invalid("Store mutation request identity is invalid");
      return value;
    };
    const adapter: AsyncStore = {
      query: async q => this.#reader.query(q),
      insert: async (table, row, context) => {
        const committed = await this.executeMutation({
          requestId: requestId(context), route: "store.insert", payload: { table, row },
        });
        return committed.result as Awaited<ReturnType<AsyncStore["insert"]>>;
      },
      update: async (table, id, patch, context) => {
        const committed = await this.executeMutation({
          requestId: requestId(context), route: "store.update", payload: { table, id, patch },
        });
        return committed.result as Awaited<ReturnType<AsyncStore["update"]>>;
      },
      softDelete: async (table, id, context) => {
        await this.executeMutation({
          requestId: requestId(context), route: "store.softDelete", payload: { table, id },
        });
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
