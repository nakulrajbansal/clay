import { describe, expect, it } from "vitest";
import {
  Bridge, ClayStore, StoreRpcClient, deriveInverse, openMemoryDriver, serveStore,
  type DbDriver, type ForwardOpT, type MessagePortLike,
} from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { DeviceCatalog } from "../src/device-catalog";
import { ProductionStoreAuthority } from "../src/production-authority";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

function portPair(): [MessagePortLike, MessagePortLike] {
  let receiveA: ((message: unknown) => void) | null = null;
  let receiveB: ((message: unknown) => void) | null = null;
  return [{
    send: message => queueMicrotask(() => receiveB?.(message)),
    onMessage: callback => { receiveA = callback; },
  }, {
    send: message => queueMicrotask(() => receiveA?.(message)),
    onMessage: callback => { receiveB = callback; },
  }];
}

function panelClient(port: MessagePortLike): {
  call(name: string, args: unknown[]): Promise<unknown>;
  send(message: unknown): void;
} {
  let sequence = 0;
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
  }>();
  port.onMessage(raw => {
    const message = raw as {
      seq?: number;
      ok?: boolean;
      result?: unknown;
      error?: unknown;
    };
    if (typeof message.seq !== "number" || typeof message.ok !== "boolean") return;
    const request = pending.get(message.seq);
    if (!request) return;
    pending.delete(message.seq);
    if (message.ok) request.resolve(message.result);
    else request.reject(message.error);
  });
  return {
    send: message => port.send(message),
    call: (name, args) => new Promise((resolve, reject) => {
      const seq = sequence++;
      pending.set(seq, { resolve, reject });
      port.send({ v: 1, panel: "authority_panel", seq, call: name, args });
    }),
  };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const legacyInventory = {
  state: "complete" as const,
  catalogPresent: false,
  namespaces: [{
    storageKey: "default",
    userFile: "/user.db",
    systemFile: "/system.db",
    kind: "legacy" as const,
  }],
};

async function legacyStore(): Promise<{ driver: DbDriver; store: ClayStore }> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{
    op: "create_table",
    table: "projects",
    columns: [{ name: "name", type: "text", required: true }],
  }];
  store.commit({
    intent: "create projects",
    summary: "Created projects.",
    migration: {
      operations,
      inverse: deriveInverse(operations, store.registrySnapshot()),
    },
  });
  store.insert("projects", { name: "Preserved" });
  return { driver, store };
}

async function cataloguedStore(): Promise<DbDriver> {
  const { driver, store } = await legacyStore();
  store.setSetting("shell_id", "tracker");
  const census = enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot());
  StateMerkleIndex.createSchema(driver);
  StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
  TargetAuthorityStore.createSchema(driver);
  const target = TargetAuthorityStore.initialize(driver, {
    schema: 1,
    appInstanceId: opaque("app", "a"),
    activeGenerationId: opaque("gen", "b"),
    lineageEpoch: "0",
    lineageEpochHighWater: "0",
    protectionRevision: "0",
    protectionRevisionHighWater: "0",
    digestSchema: 1,
  }).evidence();
  const catalog = DeviceCatalog.initializeFresh(driver);
  catalog.seedSelectedTarget({
    target,
    namespaceId: opaque("ns", "c"),
    storageKey: "default",
    displayName: "My app",
    operationId: opaque("op", "d"),
    at: new Date(1_000).toISOString(),
  });
  return driver;
}

describe("production Store authority", () => {
  it("adopts one inventoried legacy store atomically and leaves its raw Store read-only", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: 1_000,
      leaseTtlMs: 5_000,
    });
    try {
      expect(authority.bootInfo()).toEqual({
        persistent: true,
        seeded: true,
        shellId: null,
        adopted: true,
      });
      expect(authority.bootInfo()).not.toHaveProperty("protection");
      expect(authority.store.query({ from: "projects" })).toMatchObject([
        { name: "Preserved" },
      ]);
      expect(() => rawStore.insert("projects", { name: "Bypass" }))
        .toThrowError(expect.objectContaining({ code: "E_STALE_WRITE_EPOCH" }));
      expect(() => authority.store.insert("projects", { name: "Bypass" }))
        .toThrowError(expect.objectContaining({ code: "E_STALE_WRITE_EPOCH" }));

      const catalog = DeviceCatalog.openExisting(driver).snapshot();
      expect(catalog).toMatchObject({
        catalogGeneration: "2",
        selectedAppInstanceId: opaque("app", "a"),
        entries: [{
          appInstanceId: opaque("app", "a"),
          activeGenerationId: opaque("gen", "b"),
          currentProtectionRevision: "0",
        }],
      });
      expect(driver.select(
        "SELECT app_instance_id, active_generation_id, protection_revision FROM sys.target_authority_header",
      )).toEqual([{
        app_instance_id: opaque("app", "a"),
        active_generation_id: opaque("gen", "b"),
        protection_revision: "0",
      }]);
    } finally {
      authority.close();
    }
  });

  it("boots an existing catalog-selected store and refuses an inventory mismatch before adoption", async () => {
    const driver = await cataloguedStore();
    const cataloguedInventory = {
      ...legacyInventory,
      catalogPresent: true,
    };
    const authority = ProductionStoreAuthority.openExisting(driver, {
      inventory: cataloguedInventory,
      storageKey: "default",
      releaseId: opaque("rel", "e"),
      nowMs: 2_000,
      leaseTtlMs: 5_000,
    });
    try {
      expect(authority.bootInfo()).toEqual({
        persistent: true,
        seeded: true,
        shellId: "tracker",
        adopted: false,
      });
      expect(authority.store.query({ from: "projects" })).toHaveLength(1);
      expect(DeviceCatalog.openExisting(driver).snapshot().catalogGeneration).toBe("2");
    } finally {
      authority.close();
    }

    const mismatched = await cataloguedStore();
    expect(() => ProductionStoreAuthority.openExisting(mismatched, {
      inventory: {
        state: "complete",
        catalogPresent: true,
        namespaces: [{
          storageKey: "other",
          userFile: "/app-other-user.db",
          systemFile: "/app-other-system.db",
          kind: "legacy",
        }],
      },
      storageKey: "other",
      releaseId: opaque("rel", "e"),
      nowMs: 2_000,
      leaseTtlMs: 5_000,
    })).toThrowError(expect.objectContaining({ code: "E_CATALOG_UNAVAILABLE" }));
    expect(DeviceCatalog.openExisting(mismatched).snapshot().catalogGeneration).toBe("1");
    mismatched.close();
  });

  it("initializes a fresh durable target without publishing a protection status", async () => {
    const driver = await openMemoryDriver();
    driver.exec("ATTACH DATABASE ':memory:' AS catalog");
    const authority = ProductionStoreAuthority.initializeFresh(driver, {
      inventory: { state: "complete", catalogPresent: false, namespaces: [] },
      storageKey: opaque("ns", "c"),
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: 1_000,
      leaseTtlMs: 5_000,
    });
    try {
      expect(authority.bootInfo()).toEqual({
        persistent: true,
        seeded: false,
        shellId: null,
        adopted: false,
      });
      expect(authority.bootInfo()).not.toHaveProperty("protection");
      expect(DeviceCatalog.openExisting(driver).snapshot()).toMatchObject({
        catalogGeneration: "2",
        selectedAppInstanceId: opaque("app", "a"),
      });
    } finally {
      authority.close();
    }
  });

  it("fences a declared Bridge write even through the worker store-port route", async () => {
    const { driver } = await legacyStore();
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: 1_000,
      leaseTtlMs: 5_000,
    });
    try {
      const [storeServerPort, storeClientPort] = portPair();
      serveStore(authority.store, storeServerPort);
      const rpc = new StoreRpcClient(storeClientPort);
      const bridge = new Bridge(rpc);
      const [bridgePort, panelPort] = portPair();
      const panel = panelClient(panelPort);
      await bridge.attachPanel({
        panelId: "authority_panel",
        title: "Authority",
        placement: { region: "main", order: 0 },
        code: "export default function(clay){}",
        declaredQueries: [],
        declaredWrites: ["projects"],
      }, bridgePort);
      await tick();
      panel.send({ v: 1, kind: "user_gesture" });
      await tick();
      await expect(panel.call("db.insert", [
        "projects", { name: "Bridge bypass" },
      ])).rejects.toMatchObject({ code: "E_STALE_WRITE_EPOCH" });
      expect(authority.store.query({ from: "projects" })).toHaveLength(1);
    } finally {
      authority.close();
    }
  });
});