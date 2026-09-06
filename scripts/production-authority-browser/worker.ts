import { ClayStore, deriveInverse } from "../../packages/kernel/src/index";
import {
  browserDurableInventory,
  openBrowserCatalogProbe,
  openBrowserDriver,
  openBrowserProductionTarget,
  wipeBrowserStorage,
} from "../../packages/kernel/src/db";
import { DeviceCatalog } from "../../packages/kernel/src/device-catalog";
import { createLiveWriteGuard } from "../../packages/kernel/src/live-write-guard";
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
    summary: "Creates records.",
    semanticOrigin: "direct",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    panels: [],
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

async function boot(requestedAppId: string): Promise<unknown> {
  const authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId, appCache });
  try {
    return {
      boot: authority.bootInfo(),
      rows: authority.query({ from: "records" }),
      evidence: authority.inspectAuthority(),
    };
  } finally {
    authority.close();
  }
}

async function inspect(): Promise<unknown> {
  const inventory = await browserDurableInventory();
  const probe = await openBrowserCatalogProbe();
  try {
    const catalog = DeviceCatalog.openExisting(probe);
    return {
      inventory,
      catalog: catalog.snapshot(),
      manifest: catalog.legacyBootstrapManifest(),
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
    return browserDurableInventory();
  }
  if (payload.op === "partial") return declareAndAdoptOne();
  if (payload.op === "leaveEmptyCatalog") return leaveEmptyCatalog();
  if (payload.op === "boot") return boot(String(payload.requestedAppId));
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
