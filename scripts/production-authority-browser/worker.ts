import { ClayStore, deriveInverse } from "../../packages/kernel/src/index";
import {
  browserDurableFileNames,
  browserDurableInventory,
  openBrowserCatalogProbe,
  openBrowserDriver,
  openBrowserProductionTarget,
  wipeBrowserStorage,
} from "../../packages/kernel/src/db";
import { DeviceCatalog } from "../../packages/kernel/src/device-catalog";
import { physicalNamespaceEntry } from "../../packages/kernel/src/durable-inventory";
import { createLiveWriteGuard } from "../../packages/kernel/src/live-write-guard";
import { mintProductionAuthorityId } from "../../packages/kernel/src/production-mutation-coordinator";
import {
  ProductionStoreAuthority,
  planLegacyBootstrap,
} from "../../packages/kernel/src/production-authority";

const appCache = [
  { id: "default", name: "Projects", shellId: "tracker" },
  { id: "field", name: "Field Service", shellId: "inventory" },
];

async function reset(): Promise<unknown> {
  const opened = await openBrowserDriver("default");
  opened.driver.close();
  await wipeBrowserStorage();
  return browserDurableInventory();
}

async function seedLegacy(id: string, value: string, shellId: string): Promise<void> {
  const opened = await openBrowserDriver(id);
  if (!opened.persistent) throw new Error("persistent OPFS is required");
  const store = ClayStore.fromDriver(opened.driver);
  const operations = [{
    op: "create_table" as const,
    table: "records",
    columns: [{ name: "name", type: "text" as const, required: true }],
  }];
  store.commit({
    intent: "browser authority fixture",
    summary: "Creates records and their source-bound panel.",
    semanticOrigin: "direct",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    panels: [{
      panel_id: "records_table",
      title: "Records",
      placement: { region: "main", order: 0 },
      code: "export default function(clay){/* packaged lifecycle fixture */}",
      declared_queries: [{ from: "records" }],
      declared_writes: [],
    }],
    diff: [],
  });
  store.insert("records", { name: value });
  store.setSetting("shell_id", shellId);
  opened.driver.close();
}

async function declareAndAdoptOne(): Promise<unknown> {
  const inventory = await browserDurableInventory();
  const manifest = planLegacyBootstrap(inventory, {
    requestedAppId: "field",
    appCache,
  });
  const declaration = manifest[0]!;
  const declarationDriver = await openBrowserProductionTarget({
    storageKey: declaration.storageKey,
    userFile: declaration.userFile,
    systemFile: declaration.systemFile,
    kind: declaration.kind,
  });
  const session = createLiveWriteGuard(declarationDriver);
  try {
    session.authority.run(() => {
      const catalog = DeviceCatalog.initializeFresh(session.driver);
      catalog.beginLegacyBootstrap(manifest, new Date().toISOString());
    });
  } finally {
    session.driver.close();
  }
  const first = manifest.find(entry => !entry.selected) ?? manifest[0]!;
  const driver = await openBrowserProductionTarget({
    storageKey: first.storageKey,
    userFile: first.userFile,
    systemFile: first.systemFile,
    kind: first.kind,
  });
  const authority = ProductionStoreAuthority.adoptManifestTarget(driver, {
    inventory: { ...inventory, catalogPresent: true },
    entry: first,
    releaseId: `rel_${"r".repeat(26)}`,
    nowMs: Date.now(),
    leaseTtlMs: 60_000,
  });
  authority.close();
  const probe = await openBrowserCatalogProbe();
  try {
    const catalog = DeviceCatalog.openExisting(probe);
    return {
      remaining: catalog.legacyBootstrapManifest().length,
      entries: catalog.snapshot().entries.length,
      selectedStorageKey: catalog.selectedTargetStorage().storageKey,
    };
  } finally {
    probe.close();
  }
}

function authorityState(authority: ProductionStoreAuthority): Record<string, unknown> {
  const reader = authority.readStore();
  const registry = reader.registrySnapshot();
  return {
    boot: authority.bootInfo(),
    rows: registry.has("records") ? authority.query({ from: "records" }) : [],
    data: Object.fromEntries([...registry.values()]
      .filter(table => !table.inactive)
      .map(table => [table.name, authority.query({ from: table.name })])),
    tables: [...registry.values()],
    panels: reader.livePanels(),
    history: reader.history(),
    evidence: authority.inspectAuthority(),
  };
}

async function durableState(authority: ProductionStoreAuthority): Promise<Record<string, unknown>> {
  return {
    ...authorityState(authority),
    inventory: await browserDurableInventory(),
    fileNames: await browserDurableFileNames(),
  };
}

async function boot(requestedAppId: string | null): Promise<unknown> {
  const authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId, appCache });
  try {
    return durableState(authority);
  } finally {
    authority.close();
  }
}

async function lifecycle(payload: Record<string, unknown>): Promise<unknown> {
  const authority = await ProductionStoreAuthority.bootBrowser({
    requestedAppId: null,
    appCache: [],
  });
  let next: ProductionStoreAuthority | null = null;
  try {
    const requestId = payload.requestId === undefined
      ? authority.createRequestId() : String(payload.requestId);
    const kind = String(payload.kind);
    const request: Record<string, unknown> = { kind, requestId };
    if (kind === "create") {
      request.displayName = String(payload.displayName);
      request.shellId = String(payload.shellId);
    } else if (kind === "switch" || kind === "delete") {
      request.appInstanceId = String(payload.appInstanceId);
    } else if (kind === "rename") {
      request.appInstanceId = String(payload.appInstanceId);
      request.displayName = String(payload.displayName);
      request.shellId = payload.shellId === null || payload.shellId === undefined
        ? null : String(payload.shellId);
    }
    next = await authority.executeAppLifecycle(request);
    return { requestId, ...await durableState(next) };
  } catch (error) {
    try { authority.close(); } catch { /* lifecycle may already have closed it */ }
    throw error;
  } finally {
    if (next) next.close();
  }
}

async function insertRecord(payload: Record<string, unknown>): Promise<unknown> {
  const authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    const requestId = payload.requestId === undefined
      ? authority.createRequestId() : String(payload.requestId);
    const committed = await authority.executeMutation({
      requestId,
      route: "store.insert",
      payload: { table: "records", row: { name: String(payload.name) } },
    });
    return { requestId, committed, ...await durableState(authority) };
  } finally {
    authority.close();
  }
}

async function importNewApp(payload: Record<string, unknown>): Promise<unknown> {
  const authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    const result = await authority.executeNewAppImport({
      createRequestId: String(payload.createRequestId),
      requestId: String(payload.requestId),
      payload: payload.payload,
    });
    return { result, ...await durableState(authority) };
  } finally {
    authority.close();
  }
}

async function undoNewAppImport(payload: Record<string, unknown>): Promise<unknown> {
  const authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    const result = await authority.undoNewAppImport({
      createRequestId: String(payload.createRequestId),
      importRequestId: String(payload.importRequestId),
      requestId: String(payload.requestId),
    });
    return { result, ...await durableState(authority) };
  } finally {
    authority.close();
  }
}

async function declarePendingCreate(payload: Record<string, unknown>): Promise<unknown> {
  const inventory = await browserDurableInventory();
  if (inventory.state !== "complete") throw new Error("complete inventory required");
  const probe = await openBrowserCatalogProbe();
  let selectedStorage: ReturnType<DeviceCatalog["selectedTargetStorage"]>;
  try { selectedStorage = DeviceCatalog.openExisting(probe).selectedTargetStorage(); }
  finally { probe.close(); }
  const physical = inventory.namespaces.find(item => item.storageKey === selectedStorage.storageKey);
  if (!physical) throw new Error("selected physical target is unavailable");
  const session = createLiveWriteGuard(await openBrowserProductionTarget(physical));
  try {
    const nowMs = Date.now();
    const catalog = DeviceCatalog.openExisting(session.driver);
    const before = catalog.snapshot();
    const fence = session.authority.run(() => catalog.acquireWriteLease({
      expectedAuthorityIncarnationId: before.authorityIncarnationId,
      expectedCatalogGeneration: before.catalogGeneration,
      expectedWriteEpoch: before.writeEpoch,
      releaseId: mintProductionAuthorityId("rel"),
      nowMs,
      ttlMs: 60_000,
    }));
    const namespaceId = mintProductionAuthorityId("ns");
    const targetPhysical = physicalNamespaceEntry(namespaceId, namespaceId);
    const job = session.authority.run(() => catalog.declareAppGeneration({
      kind: "create",
      requestId: String(payload.requestId),
      expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
      expectedTarget: catalog.selectedTargetStorage().target,
      target: {
        appInstanceId: mintProductionAuthorityId("app"),
        generationId: mintProductionAuthorityId("gen"),
        namespaceId,
        storageKey: targetPhysical.storageKey,
        userFile: targetPhysical.userFile,
        systemFile: targetPhysical.systemFile,
        storageKind: targetPhysical.kind,
        displayName: "Recovered Create",
        shellId: "blank",
      },
      jobId: mintProductionAuthorityId("job"),
      operationId: mintProductionAuthorityId("op"),
      requestSha256: `sha256:${"a".repeat(64)}`,
      fence,
      nowMs,
    }));
    return { job, inventory: await browserDurableInventory() };
  } finally {
    session.driver.close();
  }
}

async function materializePendingTarget(payload: Record<string, unknown>): Promise<unknown> {
  const target = payload.target;
  if (typeof target !== "object" || target === null)
    throw new Error("pending target declaration is required");
  const record = target as Record<string, unknown>;
  const storageKind = record.storageKind;
  if (storageKind !== "legacy" && storageKind !== "generation")
    throw new Error("pending target storage kind is invalid");
  const driver = await openBrowserProductionTarget({
    storageKey: String(record.storageKey),
    userFile: String(record.userFile),
    systemFile: String(record.systemFile),
    kind: storageKind,
  });
  try {
    driver.exec("CREATE TABLE partial_crash_marker(value TEXT NOT NULL)");
    driver.exec("CREATE TABLE sys.partial_crash_marker(value TEXT NOT NULL)");
  } finally {
    driver.close();
  }
  return { inventory: await browserDurableInventory(), fileNames: await browserDurableFileNames() };
}

async function declarePendingDelete(payload: Record<string, unknown>): Promise<unknown> {
  const inventory = await browserDurableInventory();
  if (inventory.state !== "complete") throw new Error("complete inventory required");
  const probe = await openBrowserCatalogProbe();
  let selectedStorage: ReturnType<DeviceCatalog["selectedTargetStorage"]>;
  try { selectedStorage = DeviceCatalog.openExisting(probe).selectedTargetStorage(); }
  finally { probe.close(); }
  const physical = inventory.namespaces.find(item => item.storageKey === selectedStorage.storageKey);
  if (!physical) throw new Error("selected physical target is unavailable");
  const session = createLiveWriteGuard(await openBrowserProductionTarget(physical));
  try {
    const nowMs = Date.now();
    const catalog = DeviceCatalog.openExisting(session.driver);
    const before = catalog.snapshot();
    const fence = session.authority.run(() => catalog.acquireWriteLease({
      expectedAuthorityIncarnationId: before.authorityIncarnationId,
      expectedCatalogGeneration: before.catalogGeneration,
      expectedWriteEpoch: before.writeEpoch,
      releaseId: mintProductionAuthorityId("rel"),
      nowMs,
      ttlMs: 60_000,
    }));
    const deleted = session.authority.run(() => catalog.deleteSelectedApp({
      requestId: String(payload.requestId),
      expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
      expectedTarget: catalog.selectedTargetStorage().target,
      jobId: mintProductionAuthorityId("job"),
      operationId: mintProductionAuthorityId("op"),
      requestSha256: `sha256:${"b".repeat(64)}`,
      fence,
      nowMs,
    }));
    return { deleted, inventory: await browserDurableInventory() };
  } finally {
    session.driver.close();
  }
}

async function inspect(): Promise<unknown> {
  const inventory = await browserDurableInventory();
  const fileNames = await browserDurableFileNames();
  const probe = await openBrowserCatalogProbe();
  try {
    const catalog = DeviceCatalog.openExisting(probe);
    return {
      inventory,
      fileNames,
      catalog: catalog.snapshot(),
      manifest: catalog.legacyBootstrapManifest(),
      lifecycleJobs: catalog.pendingLifecycleJobs(),
      activeStorage: catalog.activeTargetStorageInventory(),
    };
  } finally {
    probe.close();
  }
}

async function leaveEmptyCatalog(): Promise<unknown> {
  const inventory = await browserDurableInventory();
  if (inventory.state !== "complete" || inventory.catalogPresent || inventory.namespaces.length !== 2)
    throw new Error("empty-catalog fixture inventory is invalid");
  const driver = await openBrowserProductionTarget(inventory.namespaces[0]!);
  driver.close();
  return browserDurableInventory();
}

async function handle(payload: Record<string, unknown>): Promise<unknown> {
  if (payload.op === "reset") return reset();
  if (payload.op === "seed") {
    await seedLegacy("default", "Projects row", "tracker");
    await seedLegacy("field", "Field row", "inventory");
    return {
      inventory: await browserDurableInventory(),
      fileNames: await browserDurableFileNames(),
    };
  }
  if (payload.op === "partial") return declareAndAdoptOne();
  if (payload.op === "leaveEmptyCatalog") return leaveEmptyCatalog();
  if (payload.op === "boot")
    return boot(payload.requestedAppId === null ? null : String(payload.requestedAppId));
  if (payload.op === "lifecycle") return lifecycle(payload);
  if (payload.op === "insertRecord") return insertRecord(payload);
  if (payload.op === "importNewApp") return importNewApp(payload);
  if (payload.op === "undoNewAppImport") return undoNewAppImport(payload);
  if (payload.op === "declarePendingCreate") return declarePendingCreate(payload);
  if (payload.op === "materializePendingTarget") return materializePendingTarget(payload);
  if (payload.op === "declarePendingDelete") return declarePendingDelete(payload);
  if (payload.op === "inspect") return inspect();
  throw new Error(`unknown authority evidence operation ${String(payload.op)}`);
}

self.onmessage = event => {
  void handle(event.data).then(
    value => postMessage({ type: "result", value }),
    error => postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) }),
  );
};
postMessage({ type: "ready" });
