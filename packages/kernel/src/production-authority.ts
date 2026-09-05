import { AppInstanceId, GenerationId, NamespaceId, OperationId } from "@clay/schema";
import type {
  TargetEvidenceV1 as TargetEvidence,
  WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import { enumerateCanonicalStateV1 } from "./canonical-state";
import type { DbDriver } from "./db";
import { DeviceCatalog } from "./device-catalog";
import type { DurableFileInventory } from "./durable-inventory";
import { ClayError } from "./errors";
import { LiveWriteGuard } from "./live-write-guard";
import { StateMerkleIndex } from "./state-merkle-index";
import { ClayStore } from "./store";
import { TargetAuthorityStore } from "./target-authority";

export type ProductionBootInfo = {
  persistent: true;
  seeded: boolean;
  shellId: string | null;
  adopted: boolean;
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
  appInstanceId: string;
  generationId: string;
  namespaceId: string;
  adoptionOperationId: string;
};

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

export class ProductionStoreAuthority {
  readonly store: ClayStore;
  readonly #driver: LiveWriteGuard;
  readonly #boot: ProductionBootInfo;
  readonly #fence: WriteFence;
  readonly #catalogGeneration: string;

  private constructor(
    driver: LiveWriteGuard,
    store: ClayStore,
    boot: ProductionBootInfo,
    fence: WriteFence,
    catalogGeneration: string,
  ) {
    this.#driver = driver;
    this.store = store;
    this.#boot = boot;
    this.#fence = fence;
    this.#catalogGeneration = catalogGeneration;
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

    const guarded = new LiveWriteGuard(driver);
    let store: ClayStore | null = null;
    try {
      guarded.runAuthorized(() => {
        // Catalog creation is deliberately the first durable write after the
        // caller's complete inventory decision.
        const catalog = DeviceCatalog.initializeFresh(guarded);
        store = ClayStore.fromDriver(guarded);
        if (store.getSetting<number>("current_version") === undefined)
          store.setSetting("current_version", store.headVersion());
        const registry = store.validationRegistrySnapshot();
        const census = enumerateCanonicalStateV1(guarded, registry);
        StateMerkleIndex.createSchema(guarded);
        StateMerkleIndex.initialize(guarded, census.leaves.map(entry => entry.seed));
        TargetAuthorityStore.createSchema(guarded);
        const target = TargetAuthorityStore.initialize(guarded, {
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
          operationId: operationId.data,
          at,
        });
        const audited = enumerateCanonicalStateV1(guarded, registry);
        const merkle = StateMerkleIndex.open(guarded).audit();
        if (audited.stateSha256 !== target.stateSha256
            || audited.stateSha256 !== merkle.stateSha256
            || audited.leaves.length !== merkle.leafCount)
          throw invalid("initialized target failed canonical read-back");
      });
      if (!store) throw invalid("durable target initialization did not produce a Store");
      return ProductionStoreAuthority.finishBoot(guarded, store as ClayStore, input, adopted);
    } catch (error) {
      try { guarded.close(); } catch { /* Store construction may already have closed it. */ }
      throw error;
    }
  }

  static openExisting(driver: DbDriver, input: ExistingOpenInput): ProductionStoreAuthority {
    if (input.inventory.state !== "complete" || !input.inventory.catalogPresent
        || input.inventory.namespaces.length !== 1
        || input.inventory.namespaces[0]?.storageKey !== input.storageKey)
      throw invalid("existing boot requires one complete catalog-selected namespace inventory");

    // Validate the catalog and its selected physical namespace before claiming
    // or mutating the target connection.
    const catalogBeforeGuard = DeviceCatalog.openExisting(driver);
    const selected = catalogBeforeGuard.selectedTargetStorage();
    if (selected.storageKey !== input.storageKey)
      throw invalid("durable inventory does not match the catalog-selected namespace");

    const guarded = new LiveWriteGuard(driver);
    try {
      const catalog = DeviceCatalog.openExisting(guarded);
      const snapshot = catalog.snapshot();
      const fence = guarded.runAuthorized(() => catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
        expectedCatalogGeneration: snapshot.catalogGeneration,
        expectedWriteEpoch: snapshot.writeEpoch,
        releaseId: input.releaseId,
        nowMs: input.nowMs,
        ttlMs: input.leaseTtlMs,
      }));
      let store: ClayStore | null = null;
      guarded.runAuthorized(() => {
        const currentCatalog = DeviceCatalog.openExisting(guarded);
        currentCatalog.assertWriteFence(fence, input.nowMs);
        const currentSelected = currentCatalog.selectedTargetStorage();
        if (currentSelected.storageKey !== selected.storageKey
            || !sameTarget(currentSelected.target, selected.target))
          throw invalid("catalog selection changed while the target was opening");
        store = ClayStore.fromDriver(guarded);
        const target = TargetAuthorityStore.open(guarded).evidence();
        if (!sameTarget(target, selected.target))
          throw invalid("catalog and target authority disagree");
        const census = enumerateCanonicalStateV1(guarded, store.validationRegistrySnapshot());
        const merkle = StateMerkleIndex.open(guarded).audit();
        if (census.stateSha256 !== target.stateSha256
            || census.stateSha256 !== merkle.stateSha256
            || census.leaves.length !== merkle.leafCount)
          throw invalid("existing target failed canonical read-back");
      });
      if (!store) throw invalid("existing target did not produce a Store");
      const openedStore = store as ClayStore;
      return new ProductionStoreAuthority(
        guarded,
        openedStore,
        {
          persistent: true,
          seeded: openedStore.headVersion() > 0,
          shellId: openedStore.getSetting<string>("shell_id") ?? null,
          adopted: false,
        },
        fence,
        DeviceCatalog.openExisting(guarded).snapshot().catalogGeneration,
      );
    } catch (error) {
      try { guarded.close(); } catch { /* Store construction may already have closed it. */ }
      throw error;
    }
  }

  private static finishBoot(
    guarded: LiveWriteGuard,
    store: ClayStore,
    input: ExistingOpenInput,
    adopted: boolean,
  ): ProductionStoreAuthority {
    const catalog = DeviceCatalog.openExisting(guarded);
    const snapshot = catalog.snapshot();
    const fence = guarded.runAuthorized(() => catalog.acquireWriteLease({
      expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
      expectedCatalogGeneration: snapshot.catalogGeneration,
      expectedWriteEpoch: snapshot.writeEpoch,
      releaseId: input.releaseId,
      nowMs: input.nowMs,
      ttlMs: input.leaseTtlMs,
    }));
    const afterLease = catalog.snapshot();
    return new ProductionStoreAuthority(
      guarded,
      store,
      {
        persistent: true,
        seeded: store.headVersion() > 0,
        shellId: store.getSetting<string>("shell_id") ?? null,
        adopted,
      },
      fence,
      afterLease.catalogGeneration,
    );
  }

  bootInfo(): ProductionBootInfo {
    return { ...this.#boot };
  }

  close(): void {
    this.#driver.close();
  }
}
