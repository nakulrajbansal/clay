import { describe, expect, it, vi } from "vitest";
import {
  Bridge, ClayStore, StoreRpcClient, deriveInverse, openMemoryDriver, serveStore,
  type DbDriver, type ForwardOpT, type MessagePortLike,
} from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { DeviceCatalog } from "../src/device-catalog";
import {
  LEGACY_CREDENTIAL_SETTING_KEYS, removeLegacyCredentialSettingsForAuthorityBoot,
} from "../src/credential-policy";
import {
  ProductionStoreAuthority,
  armProductionAuthorityFailureForTest,
  planLegacyBootstrap,
  resolveCatalogInventory,
} from "../src/production-authority";
import { productionOperationIdV1 } from "../src/production-operation-id";
import { sha256HexSync } from "../src/state-digest";
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
    shellId: "tracker",
    operationId: opaque("op", "d"),
    at: new Date(1_000).toISOString(),
  });
  return driver;
}

const CATALOG_TABLE_COPY_ORDER = [
  "id_registry", "catalog_root", "generations", "app_entries", "leases",
  "lineage_reservations", "pending_jobs", "revision_reservations",
  "catalog_generation_events", "production_request_receipts",
] as const;

const AUTHORITY_SYSTEM_TABLES = [
  "state_digest_leaves", "state_digest_buckets", "state_digest_root",
  "target_authority_header", "target_revision_reservations", "production_request_receipts",
] as const;

function copyRows(source: DbDriver, copy: DbDriver, schema: "sys" | "catalog", table: string): void {
  const rows = source.select(`SELECT * FROM ${schema}.${table}`);
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => "?").join(",");
    copy.exec(
      `INSERT INTO ${schema}.${table}(${columns.join(",")}) VALUES (${placeholders})`,
      columns.map(column => row[column]) as Parameters<DbDriver["exec"]>[1],
    );
  }
}

async function snapshotAuthorityDriver(source: DbDriver): Promise<DbDriver> {
  const copy = await source.snapshot();
  StateMerkleIndex.createSchema(copy);
  TargetAuthorityStore.createSchema(copy);
  for (const table of AUTHORITY_SYSTEM_TABLES) copyRows(source, copy, "sys", table);
  copy.exec("ATTACH DATABASE ':memory:' AS catalog");
  DeviceCatalog.initializeFresh(copy);
  copy.tx(() => {
    for (let index = CATALOG_TABLE_COPY_ORDER.length - 1; index >= 0; index--)
      copy.exec(`DELETE FROM catalog.${CATALOG_TABLE_COPY_ORDER[index]!}`);
    for (const table of CATALOG_TABLE_COPY_ORDER) copyRows(source, copy, "catalog", table);
  });
  DeviceCatalog.openExisting(copy);
  return copy;
}

describe("production Store authority", () => {
  it("plans every inventoried legacy namespace with one requested selection", () => {
    const inventory = {
      state: "complete" as const,
      catalogPresent: false,
      namespaces: [legacyInventory.namespaces[0]!, {
        storageKey: "field", userFile: "/app-field-user.db",
        systemFile: "/app-field-system.db", kind: "legacy" as const,
      }],
    };
    const planned = planLegacyBootstrap(inventory, {
      requestedAppId: "field",
      appCache: [
        { id: "default", name: "Projects", shellId: "tracker" },
        { id: "field", name: "Field Service", shellId: "inventory" },
      ],
    });
    expect(planned).toHaveLength(2);
    expect(planned.filter(entry => entry.selected).map(entry => entry.storageKey))
      .toEqual(["field"]);
    expect(planned.map(entry => [entry.storageKey, entry.displayName, entry.shellId]))
      .toEqual([
        ["default", "Projects", "tracker"],
        ["field", "Field Service", "inventory"],
      ]);
  });
  it("does not expose a ClayStore physical driver through reflection", async () => {
    const { store: rawStore } = await legacyStore();
    try {
      expect(Reflect.ownKeys(rawStore)).not.toContain("driver");
      expect(Reflect.ownKeys(rawStore)).not.toContain("observer");
      expect(Reflect.ownKeys(rawStore)).not.toContain("privateMetrics");
      expect((rawStore as unknown as { driver?: unknown }).driver).toBeUndefined();
      expect((rawStore as unknown as { observer?: unknown }).observer).toBeUndefined();
      expect((rawStore as unknown as { privateMetrics?: unknown }).privateMetrics).toBeUndefined();
    } finally {
      rawStore.close();
    }
  });

  it("removes legacy credential rows before uncatalogued authority census", async () => {
    const { driver, store } = await legacyStore();
    for (const key of LEGACY_CREDENTIAL_SETTING_KEYS)
      store.setSetting(key, `legacy-secret-${key}`);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default", displayName: "My app",
      appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    try {
      for (const key of LEGACY_CREDENTIAL_SETTING_KEYS)
        expect(authority.readSetting(key)).toBeUndefined();
    } finally {
      authority.close();
    }
  });

  it("rolls back and idempotently retries the credential-row upgrade", async () => {
    const { driver, store } = await legacyStore();
    store.setSetting("byo_api_key", "legacy-secret");
    expect(() => driver.tx(() => {
      removeLegacyCredentialSettingsForAuthorityBoot(driver);
      throw new Error("injected boot failure");
    })).toThrow("injected boot failure");
    expect(store.getSetting("byo_api_key")).toBe("legacy-secret");
    driver.tx(() => removeLegacyCredentialSettingsForAuthorityBoot(driver));
    driver.tx(() => removeLegacyCredentialSettingsForAuthorityBoot(driver));
    expect(store.getSetting("byo_api_key")).toBeUndefined();
    store.close();
  });

  it("removes a legacy credential row before existing-target census", async () => {
    const { driver } = await legacyStore();
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default", displayName: "My app",
      appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    let reopenedDriver: DbDriver;
    try { reopenedDriver = await snapshotAuthorityDriver(driver); }
    finally { authority.close(); }
    reopenedDriver.exec(
      "INSERT OR REPLACE INTO sys.settings(key,value_json) VALUES (?,?)",
      ["clay_session", '"legacy-secret"'],
    );
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default", releaseId: opaque("rel", "f"),
      nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    try { expect(reopened.readSetting("clay_session")).toBeUndefined(); }
    finally { reopened.close(); }
  });

  it("does not expose the authority-owned live Store", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      expect(Reflect.ownKeys(authority)).not.toContain("store");
      expect((authority as unknown as { store?: unknown }).store).toBeUndefined();
    } finally {
      authority.close();
    }
  });

  it("exposes one frozen Store reader with only audited read methods", async () => {
    const { driver, store: rawStore } = await legacyStore();
    rawStore.setSetting("reader_probe", { ok: true });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const reader = authority.readStore();
      expect(Object.isFrozen(reader)).toBe(true);
      expect(Reflect.ownKeys(reader).sort()).toEqual([
        "attachmentStorage", "attachmentsForRecord", "attemptStats", "automationRuns",
        "fieldProvenance", "getSetting", "globalSearch", "headVersion", "history",
        "listAutomations", "listNotifications", "livePanels", "operationBatches",
        "panelProvenance", "previewRelationConversion",
        "privateMetricsSummary", "query", "queryBounded", "readAttachment", "registrySnapshot",
        "restorableRows", "rowHistory", "semanticSchemaTrace", "simulateAutomation",
        "suggestions",
      ].sort());
      for (const forbidden of [
        "insert", "update", "softDelete", "setSetting", "deleteSetting", "commit",
        "driver", "close", "snapshot", "shadowCopy", "observer", "privateMetrics",
      ]) expect((reader as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
      expect(reader.query({ from: "projects" })).toHaveLength(1);
      expect(reader.getSetting("reader_probe")).toEqual({ ok: true });
      expect(reader.registrySnapshot().has("projects")).toBe(true);
    } finally {
      authority.close();
    }
  });

  it("returns detached canonical boot projections", async () => {
    const driver = await cataloguedStore();
    const authority = ProductionStoreAuthority.openExisting(driver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: 2_000,
      leaseTtlMs: 5_000,
    });
    try {
      const first = authority.bootInfo();
      first.apps[0]!.name = "Tampered";
      first.apps.push({ id: opaque("app", "z"), name: "Injected", shellId: "blank" });
      expect(authority.bootInfo().apps).toEqual([
        { id: opaque("app", "a"), name: "My app", shellId: "tracker" },
      ]);
    } finally {
      authority.close();
    }
  });

  it("rejects boot projection when catalog selection no longer matches the opened target", async () => {
    const driver = await cataloguedStore();
    const authority = ProductionStoreAuthority.openExisting(driver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: 2_000,
      leaseTtlMs: 5_000,
    });
    const original = DeviceCatalog.openExisting(driver).snapshot();
    const selectedElsewhere = {
      ...original.entries[0]!,
      appInstanceId: opaque("app", "z"),
      activeGenerationId: opaque("gen", "y"),
    };
    const snapshot = vi.spyOn(DeviceCatalog.prototype, "snapshot").mockReturnValue({
      ...original,
      selectedAppInstanceId: selectedElsewhere.appInstanceId,
      catalogGeneration: "999",
      entries: [original.entries[0]!, selectedElsewhere],
    });
    try {
      expect(() => authority.bootInfo()).toThrowError(expect.objectContaining({
        code: "E_CATALOG_UNAVAILABLE",
      }));
    } finally {
      snapshot.mockRestore();
      authority.close();
    }
  });

  it("uses pinned mutation primitives when a public Store prototype is replaced", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const rowId = String(rawStore.query({ from: "projects" })[0]!.id);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const original = ClayStore.prototype.update;
    try {
      ClayStore.prototype.update = function (...args: Parameters<ClayStore["update"]>) {
        this.setSetting("prototype_injection", true);
        return original.apply(this, args);
      };
      await authority.executeMutation({
        requestId: opaque("req", "p"),
        route: "store.update",
        payload: { table: "projects", id: rowId, patch: { name: "Pinned" } },
      });
      expect(driver.select(
        "SELECT value_json FROM sys.settings WHERE key = 'prototype_injection'",
      )).toEqual([]);
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId]))
        .toEqual([{ name: "Pinned" }]);
    } finally {
      ClayStore.prototype.update = original;
      authority.close();
    }
  });

  it("keeps panel.rename off a replaced nested Store commit", async () => {
    const { driver, store: rawStore } = await legacyStore();
    rawStore.commit({
      intent: "seed panel", summary: "Added project table.", migration: null,
      panels: [{
        panel_id: "project_table", title: "Projects",
        placement: { region: "main", order: 0 },
        code: "export default function(clay){}",
        declared_queries: [{ from: "projects" }], declared_writes: [],
      }],
    });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const originalCommit = ClayStore.prototype.commit;
    try {
      ClayStore.prototype.commit = function () {
        this.setSetting("redirected_by_prototype", true);
        return this.headVersion();
      };
      await expect(authority.executeMutation({
        requestId: opaque("req", "r"),
        route: "panel.rename",
        payload: { panelId: "project_table", title: "Pinned title" },
      })).resolves.toMatchObject({ changed: true });
      expect(authority.readStore().livePanels()[0]?.title).toBe("Pinned title");
      expect(driver.select(
        "SELECT value_json FROM sys.settings WHERE key = 'redirected_by_prototype'",
      )).toEqual([]);
    } finally {
      ClayStore.prototype.commit = originalCommit;
      authority.close();
    }
  });

  it("never invokes a caller-supplied production clock", async () => {
    const { driver } = await legacyStore();
    let clockCalls = 0;
    const hostileExtra = {
      trustedClock: () => {
        clockCalls++;
        throw new Error("caller clock executed");
      },
    };
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
      ...hostileExtra,
    });
    try {
      await expect(authority.executeMutation({
        requestId: opaque("req", "q"),
        route: "setting.set",
        payload: { key: "clock_test", value: true },
      })).resolves.toMatchObject({ changed: true });
      expect(clockCalls).toBe(0);
    } finally {
      authority.close();
    }
  });

  it("authority-routes a checkpoint label and replays its stable history result", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "c"),
      route: "timeline.setCheckpoint",
      payload: { version: 1, label: "  Before launch  " },
    } as const;
    try {
      const committed = await authority.executeMutation(request);
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: [expect.objectContaining({ version: 1, label: "Before launch" })],
      });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...committed, replayed: true });
      const historyBeforeNoOp = authority.readStore().history();
      const eventsBeforeNoOp = driver.select("SELECT COUNT(*) AS n FROM sys.record_events");
      const authorityBeforeNoOp = authority.inspectAuthority();
      const noOp = await authority.executeMutation({
        requestId: opaque("req", "h"),
        route: "timeline.setCheckpoint",
        payload: { version: 1, label: "Before launch" },
      });
      expect(noOp).toMatchObject({ changed: false, replayed: false });
      expect(authority.readStore().history()).toEqual(historyBeforeNoOp);
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.record_events")).toEqual(eventsBeforeNoOp);
      expect(authority.inspectAuthority()).toEqual(authorityBeforeNoOp);
    } finally {
      authority.close();
    }
  });

  it.each([
    ["timeline.setCheckpoint", { label: "Unsafe" }, "version", 1, "w"],
    ["timeline.makeLatest", {}, "version", 1, "x"],
    ["panel.revert", {}, "panelId", "project_table", "y"],
    ["panel.rename", { title: "Unsafe" }, "panelId", "project_table", "z"],
    ["panel.remove", {}, "panelId", "project_table", "o"],
    ["schema.addColumn", { table: "projects" }, "column", { name: "unsafe", type: "text" }, "j"],
    ["schema.renameColumn", { table: "projects", to: "title" }, "from", "name", "k"],
    ["schema.addRelationColumn", { table: "projects" }, "column", {
      name: "owner", type: "relation",
      relation: { target_table: "people", cardinality: "one", unique_targets: false },
    }, "s"],
  ] as const)("rejects %s accessors without invoking caller code", async (
    route, initialPayload, accessorField, accessorValue, requestChar,
  ) => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    let reads = 0;
    const payload: Record<string, unknown> = { ...initialPayload };
    Object.defineProperty(payload, accessorField, {
      enumerable: true,
      get: () => { reads += 1; return accessorValue; },
    });
    try {
      expect(() => authority.executeMutation({
        requestId: opaque("req", requestChar), route, payload,
      })).toThrow(/invalid/i);
      expect(reads).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects an over-budget UTF-8 core-route payload before reservation", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      expect(() => authority.executeMutation({
        requestId: opaque("req", "b"),
        route: "timeline.setCheckpoint",
        payload: { version: 1, label: "€".repeat(700_000) },
      })).toThrow(/payload.*limits/i);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("authority-routes make-latest as one replayable timeline truncation", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const operations: ForwardOpT[] = [{
      op: "add_column", table: "projects",
      column: { name: "status", type: "text", required: false },
    }];
    rawStore.commit({
      intent: "add status",
      summary: "Added status.",
      migration: { operations, inverse: deriveInverse(operations, rawStore.registrySnapshot()) },
    });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "l"),
      route: "timeline.makeLatest",
      payload: { version: 1 },
    } as const;
    try {
      const committed = await authority.executeMutation(request);
      expect(committed).toMatchObject({ changed: true, replayed: false, result: [] });
      expect(authority.readStore().history().map(entry => entry.version)).toEqual([1]);
      expect(authority.readStore().registrySnapshot().get("projects")?.columns
        .some(column => column.name === "status" && !column.inactive)).toBe(false);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...committed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("authority-routes panel revert as a new replayable timeline commit", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const first = {
      panel_id: "project_table",
      title: "Projects",
      placement: { region: "main" as const, order: 0 },
      code: "export default function(clay){/* v1 */}",
      declared_queries: [{ from: "projects" }],
      declared_writes: [] as string[],
    };
    rawStore.commit({
      intent: "seed panel", summary: "Added project table.", migration: null, panels: [first],
    });
    rawStore.commit({
      intent: "restyle panel", summary: "Restyled project table.", migration: null,
      panels: [{ ...first, code: "export default function(clay){/* v2 */}" }],
    });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "v"),
      route: "panel.revert",
      payload: { panelId: "project_table" },
    } as const;
    try {
      const committed = await authority.executeMutation(request);
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: [expect.objectContaining({ panel_id: "project_table", code: first.code })],
      });
      expect(authority.readStore().history().map(entry => entry.version)).toEqual([1, 2, 3, 4]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...committed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("does not invoke the live Store for a canonical panel-rename no-op", async () => {
    const { driver, store: rawStore } = await legacyStore();
    rawStore.commit({
      intent: "seed panel", summary: "Added project table.", migration: null,
      panels: [{
        panel_id: "project_table", title: "Projects",
        placement: { region: "main", order: 0 },
        code: "export default function(clay){}",
        declared_queries: [{ from: "projects" }], declared_writes: [],
      }],
    });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "n"),
      route: "panel.rename",
      payload: { panelId: "project_table", title: "  Projects  " },
    } as const;
    try {
      const historyBefore = authority.readStore().history();
      const eventsBefore = driver.select("SELECT COUNT(*) AS n FROM sys.record_events");
      const authorityBefore = authority.inspectAuthority();
      const noOp = await authority.executeMutation(request);
      expect(noOp).toMatchObject({
        changed: false,
        replayed: false,
        result: [expect.objectContaining({ panel_id: "project_table", title: "Projects" })],
      });
      expect(authority.readStore().history()).toEqual(historyBefore);
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.record_events")).toEqual(eventsBefore);
      expect(authority.inspectAuthority()).toEqual(authorityBefore);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...noOp, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("authority-routes panel removal as one replayable tombstone commit", async () => {
    const { driver, store: rawStore } = await legacyStore();
    rawStore.commit({
      intent: "seed panel", summary: "Added project table.", migration: null,
      panels: [{
        panel_id: "project_table", title: "Projects",
        placement: { region: "main", order: 0 },
        code: "export default function(clay){}",
        declared_queries: [{ from: "projects" }], declared_writes: [],
      }],
    });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "o"),
      route: "panel.remove",
      payload: { panelId: "project_table" },
    } as const;
    try {
      const committed = await authority.executeMutation(request);
      expect(committed).toMatchObject({ changed: true, replayed: false, result: [] });
      expect(authority.readStore().history().map(entry => entry.version)).toEqual([1, 2, 3]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...committed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("captures and module-pins one replayable add-column workflow", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    let reads = 0;
    const hostileColumn: Record<string, unknown> = { type: "enum", values: ["low", "high"] };
    Object.defineProperty(hostileColumn, "name", {
      enumerable: true,
      get: () => { reads += 1; return "Priority"; },
    });
    const originalCommit = ClayStore.prototype.commit;
    try {
      expect(() => authority.executeMutation({
        requestId: opaque("req", "u"),
        route: "schema.addColumn",
        payload: { table: "projects", column: hostileColumn },
      })).toThrow(/invalid/i);
      expect(reads).toBe(0);

      let arrayReads = 0;
      const hostileValues: string[] = [];
      Object.defineProperty(hostileValues, "0", {
        enumerable: true,
        get: () => { arrayReads += 1; return "low"; },
      });
      hostileValues.length = 1;
      expect(() => authority.executeMutation({
        requestId: opaque("req", "v"),
        route: "schema.addColumn",
        payload: {
          table: "projects",
          column: { name: "Priority", type: "enum", values: hostileValues },
        },
      })).toThrow(/invalid/i);
      expect(arrayReads).toBe(0);

      ClayStore.prototype.commit = function () {
        throw new Error("replaced Store commit executed");
      };
      const values = ["low", "high"];
      const column = { name: "Priority level", type: "enum", values };
      const request = {
        requestId: opaque("req", "a"),
        route: "schema.addColumn" as const,
        payload: { table: "projects", column },
      };
      const pending = authority.executeMutation(request);
      column.name = "Tampered after capture";
      values[0] = "tampered";
      const committed = await pending;
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: expect.arrayContaining([expect.objectContaining({
          name: "projects",
          columns: expect.arrayContaining([expect.objectContaining({
            name: "priority_level", type: "enum", values: ["low", "high"],
          })]),
        })]),
      });
      await expect(authority.executeMutation({
        ...request,
        payload: {
          table: "projects",
          column: { name: "Priority level", type: "enum", values: ["low", "high"] },
        },
      })).resolves.toEqual({ ...committed, replayed: true });

      const historyBeforeDuplicate = authority.readStore().history();
      const eventsBeforeDuplicate = driver.select("SELECT COUNT(*) AS n FROM sys.record_events");
      const authorityBeforeDuplicate = authority.inspectAuthority();
      await expect(authority.executeMutation({
        requestId: opaque("req", "g"),
        route: "schema.addColumn",
        payload: {
          table: "projects",
          column: { name: "Priority level", type: "enum", values: ["low", "high"] },
        },
      })).rejects.toThrow(/already exists/i);
      expect(authority.readStore().history()).toEqual(historyBeforeDuplicate);
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.record_events"))
        .toEqual(eventsBeforeDuplicate);
      expect(authority.inspectAuthority()).toEqual(authorityBeforeDuplicate);
    } finally {
      ClayStore.prototype.commit = originalCommit;
      authority.close();
    }
  });

  it("authority-routes rename-column while keeping canonical no-ops out of Store history", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const historyBefore = authority.readStore().history();
      const eventsBefore = driver.select("SELECT COUNT(*) AS n FROM sys.record_events");
      const noOpRequest = {
        requestId: opaque("req", "c"),
        route: "schema.renameColumn",
        payload: { table: "projects", from: "name", to: "Name" },
      } as const;
      const noOp = await authority.executeMutation(noOpRequest);
      expect(noOp).toMatchObject({ changed: false, replayed: false });
      expect(authority.readStore().history()).toEqual(historyBefore);
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.record_events")).toEqual(eventsBefore);
      await expect(authority.executeMutation(noOpRequest))
        .resolves.toEqual({ ...noOp, replayed: true });

      const request = {
        requestId: opaque("req", "d"),
        route: "schema.renameColumn",
        payload: { table: "projects", from: "name", to: "Project title" },
      } as const;
      const committed = await authority.executeMutation(request);
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: expect.arrayContaining([expect.objectContaining({
          name: "projects",
          columns: expect.arrayContaining([expect.objectContaining({ name: "project_title" })]),
        })]),
      });
      expect(authority.query({ from: "projects" })[0]).toMatchObject({
        project_title: "Preserved",
      });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...committed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("validates the active rename source before accepting a canonical no-op", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const addArchived: ForwardOpT[] = [{
      op: "add_column", table: "projects",
      column: { name: "archived", type: "text", required: false },
    }];
    rawStore.commit({
      intent: "add archived",
      summary: "Added archived.",
      migration: {
        operations: addArchived,
        inverse: deriveInverse(addArchived, rawStore.registrySnapshot()),
      },
    });
    rawStore.rollbackTo(1, { truncate: true });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const historyBefore = authority.readStore().history();
    const eventsBefore = driver.select("SELECT COUNT(*) AS n FROM sys.record_events");
    try {
      for (const [requestChar, table, from, to] of [
        ["x", "ghost", "name", "Name"],
        ["y", "projects", "ghost", "Ghost"],
        ["z", "projects", "archived", "Archived"],
      ] as const) {
        await expect(authority.executeMutation({
          requestId: opaque("req", requestChar),
          route: "schema.renameColumn",
          payload: { table, from, to },
        })).rejects.toMatchObject({ code: "E_VALIDATION" });
      }
      expect(authority.readStore().history()).toEqual(historyBefore);
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.record_events")).toEqual(eventsBefore);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("captures and authority-routes one replayable relation-column workflow", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const setup: ForwardOpT[] = [{
      op: "create_table",
      table: "people",
      columns: [{ name: "name", type: "text", required: true }],
    }];
    rawStore.commit({
      intent: "create people", summary: "Created people.",
      migration: { operations: setup, inverse: deriveInverse(setup, rawStore.registrySnapshot()) },
    });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    let reads = 0;
    const hostileRelation: Record<string, unknown> = {
      cardinality: "one", unique_targets: false,
    };
    Object.defineProperty(hostileRelation, "target_table", {
      enumerable: true,
      get: () => { reads += 1; return "people"; },
    });
    try {
      expect(() => authority.executeMutation({
        requestId: opaque("req", "e"),
        route: "schema.addRelationColumn",
        payload: {
          table: "projects",
          column: { name: "Owner", type: "relation", relation: hostileRelation },
        },
      })).toThrow(/invalid/i);
      expect(reads).toBe(0);

      const request = {
        requestId: opaque("req", "f"),
        route: "schema.addRelationColumn",
        payload: {
          table: "projects",
          column: {
            name: "Owner", type: "relation",
            relation: {
              target_table: "people", cardinality: "one", unique_targets: false,
              display_field: "name",
            },
          },
        },
      } as const;
      const committed = await authority.executeMutation(request);
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: expect.arrayContaining([expect.objectContaining({
          name: "projects",
          columns: expect.arrayContaining([expect.objectContaining({
            name: "owner", type: "relation",
            relation: {
              target_table: "people", cardinality: "one", unique_targets: false,
              display_field: "name",
            },
          })]),
        })]),
      });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...committed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("routes one validated structural commit through production authority", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const operations: ForwardOpT[] = [{
      op: "add_column", table: "projects",
      column: { name: "status", type: "text", required: false },
    }];
    const request = {
      requestId: opaque("req", "m"),
      route: "store.commit" as const,
      payload: {
        plan: {
          intent: "add project status",
          summary: "Adds project status.",
          semanticOrigin: "direct" as const,
          migration: {
            operations,
            inverse: deriveInverse(operations, rawStore.registrySnapshot()),
          },
          panels: [],
          diff: [{ kind: "add_field" as const, detail: "status on projects" }],
        },
      },
    };
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory, storageKey: "default", displayName: "My app",
      appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"), nowMs: 1_000, leaseTtlMs: 5_000,
    });
    try {
      const committed = await authority.executeMutation(request);
      expect(committed.changed).toBe(true);
      expect(authority.readStore().registrySnapshot().get("projects")?.columns)
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "status" })]));
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...committed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("rolls back an observed no-op and mirrors one meaningful StoreRpc-style update", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const rowId = String(rawStore.query({ from: "projects" })[0]!.id);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const beforeHistory = authority.readRowHistoryCount();
      const beforeEvents = driver.select("SELECT COUNT(*) AS n FROM sys.record_events")[0]!.n;
      const beforeCatalog = authority.inspectAuthority();

      const noOp = await authority.executeMutation({
        requestId: opaque("req", "f"),
        route: "store.update",
        payload: { table: "projects", id: rowId, patch: { name: "Preserved" } },
      });
      expect(noOp).toMatchObject({
        changed: false, replayed: false, result: { name: "Preserved" },
      });
      expect(noOp.operationId).toMatch(/^op_[a-z2-7]{26}$/);
      expect(authority.readRowHistoryCount()).toBe(beforeHistory);
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.record_events")[0]!.n).toBe(beforeEvents);
      expect(authority.inspectAuthority()).toEqual(beforeCatalog);

      const request = {
        requestId: opaque("req", "g"),
        route: "store.update",
        payload: { table: "projects", id: rowId, patch: { name: "Changed" } },
      } as const;
      const committed = await authority.executeMutation(request);
      expect(committed).toMatchObject({
        changed: true,
        requestId: request.requestId,
        operationId: expect.stringMatching(/^op_[a-z2-7]{26}$/),
        replayed: false,
        evidence: { protectionRevision: "1" },
        result: { id: rowId, name: "Changed" },
      });
      const replay = await authority.executeMutation(request);
      expect(replay).toEqual({ ...committed, replayed: true });
      const inspected = authority.inspectAuthority();
      expect(inspected.targetReservations).toHaveLength(1);
      expect(inspected.catalogReservations).toHaveLength(1);
      expect(inspected.targetReservations[0]).toMatchObject({
        state: "committed", revision: "1", operationId: committed.operationId,
      });
      expect(inspected.catalogReservations[0]).toMatchObject({
        state: "committed", revision: "1", operationId: committed.operationId,
        requestSha256: inspected.targetReservations[0]!.requestSha256,
      });
      expect(inspected.catalog).toMatchObject({
        catalogGeneration: "4",
        entries: [{ currentProtectionRevision: "1", stateSha256: committed.evidence.stateSha256 }],
      });
    } finally {
      authority.close();
    }
  });

  it("routes setting set/delete/CAS and rejects cross-route request reuse", async () => {
    const { driver, store: rawStore } = await legacyStore();
    rawStore.setSetting("sync", { revision: 1, value: "old" });
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const initialProjectionSnapshot = authority.readStore().projectionSnapshot();
      const staleCas = await authority.executeMutation({
        requestId: opaque("req", "h"),
        route: "setting.compareAndSet",
        payload: { key: "sync", expectedRevision: 0, value: { revision: 2, value: "new" } },
      });
      expect(staleCas).toMatchObject({
        changed: false,
        result: { ok: false, current: { revision: 1, value: "old" } },
      });
      expect(staleCas.operationId).toMatch(/^op_[a-z2-7]{26}$/);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.readStore().projectionSnapshot()).toBe(initialProjectionSnapshot);

      const setRequest = {
        requestId: opaque("req", "i"),
        route: "setting.compareAndSet",
        payload: { key: "sync", expectedRevision: 1, value: { revision: 2, value: "new" } },
      } as const;
      const set = await authority.executeMutation(setRequest);
      expect(set).toMatchObject({
        changed: true, replayed: false,
        result: { ok: true, current: { revision: 2, value: "new" } },
      });
      const committedProjectionSnapshot = authority.readStore().projectionSnapshot();
      expect(committedProjectionSnapshot).not.toBe(initialProjectionSnapshot);
      expect(await authority.executeMutation(setRequest)).toEqual({ ...set, replayed: true });
      await expect(authority.executeMutation({
        requestId: setRequest.requestId,
        route: "setting.delete",
        payload: { key: "sync" },
      })).rejects.toMatchObject({ code: "E_TARGET_AUTHORITY_INVALID" });

      const sameRequest = {
        requestId: opaque("req", "j"),
        route: "setting.set",
        payload: { key: "sync", value: { revision: 2, value: "new" } },
      } as const;
      const sameSet = await authority.executeMutation(sameRequest);
      expect(sameSet).toMatchObject({ changed: false, replayed: false });
      expect(authority.readStore().projectionSnapshot()).toBe(committedProjectionSnapshot);
      expect(sameSet.operationId).toMatch(/^op_[a-z2-7]{26}$/);
      await expect(authority.executeMutation(sameRequest))
        .resolves.toEqual({ ...sameSet, replayed: true });
      const removed = await authority.executeMutation({
        requestId: opaque("req", "k"),
        route: "setting.delete",
        payload: { key: "sync" },
      });
      expect(removed).toMatchObject({ changed: true, result: null });
      expect(authority.readSetting("sync")).toBeUndefined();
      await expect(authority.executeMutation(sameRequest))
        .rejects.toThrow(/historical.*auditable/i);
      await expect(authority.executeMutation(setRequest))
        .rejects.toThrow(/historical.*auditable/i);
      expect(authority.inspectAuthority().targetReservations.map(row => row.state))
        .toEqual(["committed", "committed"]);
    } finally {
      authority.close();
    }
  });

  it("replays own __proto__ setting data without changing the result", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const value = Object.create(null) as Record<string, unknown>;
      value.__proto__ = { retained: true };
      value.revision = 1;
      value.safe = 1;
      const request = {
        requestId: opaque("req", "l"),
        route: "setting.compareAndSet",
        payload: { key: "prototype_data", expectedRevision: 0, value },
      } as const;
      const live = await authority.executeMutation(request);
      const replay = await authority.executeMutation(request);
      expect(replay).toEqual({ ...live, replayed: true });
      const current = (replay.result as { current: Record<string, unknown> }).current;
      expect(Object.getPrototypeOf(current)).toBeNull();
      expect(Object.hasOwn(current, "__proto__")).toBe(true);
      expect(current.__proto__).toEqual({ retained: true });
    } finally {
      authority.close();
    }
  });

  it("does not expose mutable target evidence to a caller", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const first = await authority.executeMutation({
        requestId: opaque("req", "p"), route: "setting.set",
        payload: { key: "one", value: 1 },
      });
      expect(() => {
        (first.evidence as { stateSha256: string }).stateSha256 = `sha256:${"f".repeat(64)}`;
      }).toThrow(TypeError);
      await expect(authority.executeMutation({
        requestId: opaque("req", "q"), route: "setting.set",
        payload: { key: "two", value: 2 },
      })).resolves.toMatchObject({ changed: true });
      expect(authority.readSetting("two")).toBe(2);
    } finally {
      authority.close();
    }
  });

  it("reconciles the same committed request after reopening", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "r"), route: "setting.set",
      payload: { key: "durable", value: { revision: 1, value: "kept" } },
    } as const;
    let first;
    let reopenedDriver;
    try {
      first = await authority.executeMutation(request);
      reopenedDriver = await snapshotAuthorityDriver(driver);
    } finally {
      authority.close();
    }
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.executeMutation(request)).resolves.toMatchObject({
        requestId: request.requestId,
        operationId: first.operationId,
        changed: true,
        replayed: true,
        evidence: first.evidence,
        result: null,
      });
    } finally {
      reopened.close();
    }
  });

  it("reconciles interrupted planner attempts through production authority after reopening", async () => {
    const { driver } = await legacyStore();
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default", displayName: "My app",
      appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    await authority.plannerMutations().beginAttempt("interrupted reshape");
    const reopenedDriver = await snapshotAuthorityDriver(driver);
    authority.close();
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default", releaseId: opaque("rel", "f"),
      nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.reconcileInterruptedPlannerAttempts()).resolves.toBe(1);
      expect(reopened.readStore().attemptStats().failed).toBe(1);
      await expect(reopened.reconcileInterruptedPlannerAttempts()).resolves.toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("pins interrupted-attempt enumeration against Store prototype replacement", async () => {
    const { driver } = await legacyStore();
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default", displayName: "My app",
      appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      ClayStore.prototype, "pendingPlannerAttempts",
    )!;
    try {
      await authority.plannerMutations().beginAttempt("interrupted reshape");
      Object.defineProperty(ClayStore.prototype, "pendingPlannerAttempts", {
        ...descriptor, value: () => [],
      });
      await expect(authority.reconcileInterruptedPlannerAttempts()).resolves.toBe(1);
      expect(authority.readStore().attemptStats().failed).toBe(1);
    } finally {
      Object.defineProperty(ClayStore.prototype, "pendingPlannerAttempts", descriptor);
      authority.close();
    }
  });

  it("replays an exact-current legacy v1 raw receipt", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "s"),
      route: "setting.set",
      payload: { key: "legacy_raw", value: 1 },
    } as const;
    const committed = await authority.executeMutation(request);
    const reopenedDriver = await snapshotAuthorityDriver(driver);
    authority.close();
    const root = reopenedDriver.select(
      "SELECT authority_incarnation_id FROM catalog.catalog_root WHERE singleton=1",
    )[0]!;
    const legacyOperationId = productionOperationIdV1(
      String(root.authority_incarnation_id), request.requestId,
    );
    const responseJson = "null";
    const responseSha256 = `sha256:${sha256HexSync(new TextEncoder().encode(responseJson))}`;
    reopenedDriver.exec(
      "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES(?,?,?)",
      [legacyOperationId, "operation", "2026-09-06T00:00:00.000Z"],
    );
    reopenedDriver.exec(
      `UPDATE sys.production_request_receipts
       SET operation_id=?,response_sha256=?,response_json=? WHERE request_id=?`,
      [legacyOperationId, responseSha256, responseJson, request.requestId],
    );
    reopenedDriver.exec(
      `UPDATE catalog.production_request_receipts
       SET operation_id=?,response_sha256=? WHERE request_id=?`,
      [legacyOperationId, responseSha256, request.requestId],
    );
    reopenedDriver.exec(
      "UPDATE sys.target_revision_reservations SET operation_id=? WHERE operation_id=?",
      [legacyOperationId, committed.operationId],
    );
    reopenedDriver.exec(
      "UPDATE catalog.revision_reservations SET operation_id=? WHERE operation_id=?",
      [legacyOperationId, committed.operationId],
    );
    reopenedDriver.exec(
      "UPDATE catalog.catalog_generation_events SET operation_id=? WHERE operation_id=?",
      [legacyOperationId, committed.operationId],
    );
    reopenedDriver.exec(
      "DELETE FROM catalog.id_registry WHERE id_value=?",
      [committed.operationId],
    );
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.executeMutation(request)).resolves.toEqual({
        ...committed,
        operationId: legacyOperationId,
        replayed: true,
      });
    } finally {
      reopened.close();
    }
  });

  it("replays the exact normal insert result after reopen without a duplicate row", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "u"), route: "store.insert",
      payload: { table: "projects", row: { name: "Retryable insert" } },
    } as const;
    let first;
    let reopenedDriver;
    try {
      first = await authority.executeMutation(request);
      reopenedDriver = await snapshotAuthorityDriver(driver);
    } finally {
      authority.close();
    }
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.executeMutation(request)).resolves.toEqual({
        ...first, replayed: true,
      });
      expect(reopened.query({ from: "projects" })
        .filter(row => row.name === "Retryable insert")).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("rejects a committed request when its catalog receipt mirror is missing", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "x"),
      route: "setting.set",
      payload: { key: "mirrored", value: 1 },
    } as const;
    await expect(authority.executeMutation(request)).resolves.toMatchObject({ changed: true });
    const reopenedDriver = await snapshotAuthorityDriver(driver);
    authority.close();
    reopenedDriver.exec(
      "DELETE FROM catalog.production_request_receipts WHERE request_id=?",
      [request.requestId],
    );
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "y"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.executeMutation(request))
        .rejects.toThrow(/receipt mirror is incomplete/i);
      expect(reopened.readSetting("mirrored")).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("rejects current receipt replay when its target reservation diverges", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "v"),
      route: "setting.set",
      payload: { key: "reservation_join", value: 1 },
    } as const;
    const committed = await authority.executeMutation(request);
    const reopenedDriver = await snapshotAuthorityDriver(driver);
    authority.close();
    reopenedDriver.exec(
      `UPDATE sys.target_revision_reservations
       SET operation_id=?, request_sha256=? WHERE operation_id=?`,
      [opaque("op", "z"), `sha256:${"f".repeat(64)}`, committed.operationId],
    );
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "y"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.executeMutation(request))
        .rejects.toThrow(/reservation evidence.*incomplete|reservation.*diverge/i);
      expect(reopened.readSetting("reservation_join")).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("rejects historical request replay after a later commit without mutating current state", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const firstRequest = {
      requestId: opaque("req", "s"), route: "setting.set",
      payload: { key: "ordered", value: 1 },
    } as const;
    let reopenedDriver;
    try {
      await authority.executeMutation(firstRequest);
      await authority.executeMutation({
        requestId: opaque("req", "t"), route: "setting.set",
        payload: { key: "ordered", value: 2 },
      });
      reopenedDriver = await snapshotAuthorityDriver(driver);
    } finally {
      authority.close();
    }
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.executeMutation(firstRequest)).rejects.toThrow(/historical.*auditable/i);
      expect(reopened.readSetting("ordered")).toBe(2);
      expect(reopened.inspectAuthority().targetReservations).toHaveLength(2);
    } finally {
      reopened.close();
    }
  });

  it("rolls back an injected post-reservation failure and leaves only mirrored abandonment", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const rowId = String(rawStore.query({ from: "projects" })[0]!.id);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const request = {
        requestId: opaque("req", "l"),
        route: "store.update",
        payload: { table: "projects", id: rowId, patch: { name: "Never committed" } },
      } as const;
      armProductionAuthorityFailureForTest(authority);
      await expect(authority.executeMutation(request)).rejects.toThrow("injected after reservation");
      expect(authority.query({ from: "projects" })[0]).toMatchObject({ name: "Preserved" });
      const inspected = authority.inspectAuthority();
      expect(inspected.targetReservations).toEqual([expect.objectContaining({
        revision: "1", operationId: expect.stringMatching(/^op_[a-z2-7]{26}$/), state: "abandoned",
      })]);
      expect(inspected.catalogReservations).toEqual([expect.objectContaining({
        revision: "1", operationId: inspected.targetReservations[0]!.operationId,
        state: "abandoned",
      })]);
      expect(inspected.target).toMatchObject({ protectionRevision: "0" });
      expect(inspected.catalog).toMatchObject({
        catalogGeneration: "4", entries: [{ currentProtectionRevision: "0" }],
      });
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id=?",
        [request.requestId],
      )).toEqual([{ state: "failed" }]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id=?",
        [request.requestId],
      )).toEqual([{ state: "failed" }]);
      await expect(authority.executeMutation(request))
        .rejects.toThrow(/failed previously/i);
      expect(authority.query({ from: "projects" })[0]).toMatchObject({ name: "Preserved" });
    } finally {
      authority.close();
    }
  });

  it("poisons the authority when failed-operation abandonment cannot be verified", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const rowId = String(rawStore.query({ from: "projects" })[0]!.id);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      armProductionAuthorityFailureForTest(authority, "abandonment_unavailable");
      await expect(authority.executeMutation({
        requestId: opaque("req", "m"),
        route: "store.update",
        payload: { table: "projects", id: rowId, patch: { name: "Never committed" } },
      })).rejects.toThrow(/reservation recovery is required/i);
      await expect(authority.executeMutation({
        requestId: opaque("req", "n"),
        route: "setting.set",
        payload: { key: "must_not_write", value: true },
      })).rejects.toThrow(/reopen.*recovery|authority.*poisoned/i);
      expect(authority.readSetting("must_not_write")).toBeUndefined();
    } finally {
      authority.close();
    }
  });

  it("rejects a mutation queued before an earlier request poisons authority", async () => {
    const { driver } = await legacyStore();
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default", displayName: "My app",
      appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    const firstId = opaque("req", "p");
    const queuedId = opaque("req", "q");
    const metricId = opaque("req", "r");
    try {
      armProductionAuthorityFailureForTest(authority, "crash_after_invocation");
      const first = authority.executeMutation({
        requestId: firstId, route: "setting.set",
        payload: { key: "first_poisoned", value: true },
      });
      const queued = authority.executeMutation({
        requestId: queuedId, route: "setting.set",
        payload: { key: "queued_must_not_write", value: true },
      });
      const metric = authority.executeOperationalMetricMutation({
        requestId: metricId, route: "recordPrivateMetric",
        payload: { event: { type: "trust_surface_opened", surface: "history" } },
      });
      await expect(first).rejects.toThrow(/simulated.*crash/i);
      await expect(queued).rejects.toThrow(/poisoned.*reopen|reopen.*poisoned/i);
      await expect(metric).rejects.toThrow(/poisoned.*reopen|reopen.*poisoned/i);
      expect(authority.readSetting("queued_must_not_write")).toBeUndefined();
      expect(authority.readStore().privateMetricsSummary().trust.historyOpened).toBe(0);
      expect(driver.select(
        "SELECT request_id FROM sys.production_request_receipts WHERE request_id=?", [queuedId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT request_id FROM catalog.production_request_receipts WHERE request_id=?", [queuedId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT request_id FROM sys.production_request_receipts WHERE request_id=?", [metricId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("never re-invokes a request after a persisted invocation marker", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    const request = {
      requestId: opaque("req", "v"),
      route: "setting.set",
      payload: { key: "ambiguous_once", value: { committed: false } },
    } as const;
    armProductionAuthorityFailureForTest(
      authority,
      "crash_after_invocation",
    );
    await expect(authority.executeMutation(request)).rejects.toThrow(/simulated.*crash/i);
    const reopenedDriver = await snapshotAuthorityDriver(driver);
    authority.close();
    expect(reopenedDriver.select(
      "SELECT state FROM sys.production_request_receipts WHERE request_id=?",
      [request.requestId],
    )).toEqual([{ state: "invoked" }]);
    expect(reopenedDriver.select(
      "SELECT state FROM catalog.production_request_receipts WHERE request_id=?",
      [request.requestId],
    )).toEqual([{ state: "invoked" }]);
    const reopened = ProductionStoreAuthority.openExisting(reopenedDriver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "w"),
      nowMs: Date.now() + 120_000,
      leaseTtlMs: 60_000,
    });
    try {
      await expect(reopened.executeMutation(request))
        .rejects.toThrow(/already invoked|ambiguous/i);
      expect(reopened.readSetting("ambiguous_once")).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("rejects nested accessor payloads without invoking them", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const rowId = String(rawStore.query({ from: "projects" })[0]!.id);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      let reads = 0;
      const patch: Record<string, unknown> = {};
      Object.defineProperty(patch, "name", {
        enumerable: true,
        get: () => { reads += 1; return "must not execute"; },
      });
      expect(() => authority.executeMutation({
        requestId: opaque("req", "m"), route: "store.update",
        payload: { table: "projects", id: rowId, patch },
      })).toThrow(/request is invalid|plain data/i);
      expect(reads).toBe(0);
      expect(authority.query({ from: "projects" })[0]).toMatchObject({ name: "Preserved" });
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rejects aggregate payload bytes before authority reservation", async () => {
    const { driver } = await legacyStore();
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory, storageKey: "default", displayName: "My app",
      appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"), adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    try {
      const value = { a: "a".repeat(800_000), b: "b".repeat(800_000), c: "c".repeat(800_000) };
      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: opaque("req", "v"), route: "setting.set",
        payload: { key: "aggregate", value },
      }))).rejects.toThrow(/payload.*limits/i);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
      expect(authority.inspectAuthority().catalogReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rejects over-deep payloads before authority reservation", async () => {
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
      nowMs: Date.now(), leaseTtlMs: 60_000,
    });
    try {
      let value: Record<string, unknown> = {};
      for (let depth = 0; depth < 70; depth++) value = { nested: value };
      expect(() => authority.executeMutation({
        requestId: opaque("req", "u"), route: "setting.set",
        payload: { key: "deep", value },
      })).toThrow(/payload.*limits/i);
      expect(authority.inspectAuthority().targetReservations).toHaveLength(0);
    } finally {
      authority.close();
    }
  });

  it("rejects caller thenables before authority reservation", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const rowId = String(rawStore.query({ from: "projects" })[0]!.id);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      let rejected: unknown;
      try {
        void authority.executeMutation({
          requestId: opaque("req", "n"),
          route: "store.update",
          payload: {
            table: "projects", id: rowId,
            patch: { name: { then: () => undefined } },
          },
        });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toMatchObject({ code: "E_TARGET_AUTHORITY_INVALID" });
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.query({ from: "projects" })[0]).toMatchObject({ name: "Preserved" });
    } finally {
      authority.close();
    }
  });

  it("adopts one manifest target and catalog entry in one physical transaction", async () => {
    const { driver } = await legacyStore();
    DeviceCatalog.initializeFresh(driver);
    const entry = {
      storageKey: "default", userFile: "/user.db", systemFile: "/system.db",
      kind: "legacy" as const,
      appInstanceId: opaque("app", "m"), generationId: opaque("gen", "n"),
      namespaceId: opaque("ns", "o"), operationId: opaque("op", "p"),
      displayName: "Field Service", shellId: "tracker", selected: true,
    };
    DeviceCatalog.openExisting(driver).beginLegacyBootstrap(
      [entry], "2026-09-05T00:00:00.000Z",
    );
    const authority = ProductionStoreAuthority.adoptManifestTarget(driver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      entry,
      releaseId: opaque("rel", "q"),
      nowMs: 2_000,
      leaseTtlMs: 5_000,
    });
    try {
      expect(authority.bootInfo()).toMatchObject({
        selectedAppInstanceId: entry.appInstanceId,
        apps: [{ id: entry.appInstanceId, name: entry.displayName, shellId: entry.shellId }],
      });
      expect(DeviceCatalog.openExisting(driver).legacyBootstrapManifest()).toEqual([]);
      expect(authority.inspectAuthority().target.appInstanceId).toBe(entry.appInstanceId);
    } finally {
      authority.close();
    }
  });

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
        selectedAppInstanceId: opaque("app", "a"),
        catalogGeneration: "2",
        apps: [{
          id: opaque("app", "a"),
          name: "My app",
          shellId: "blank",
        }],
      });
      expect(authority.bootInfo()).not.toHaveProperty("protection");
      expect(authority.query({ from: "projects" })).toMatchObject([
        { name: "Preserved" },
      ]);
      expect(() => rawStore.insert("projects", { name: "Bypass" }))
        .toThrowError(expect.objectContaining({ code: "E_STALE_WRITE_EPOCH" }));
      expect(() => driver.exec("UPDATE projects SET name = 'Bypass'"))
        .toThrowError(expect.objectContaining({ code: "E_STALE_WRITE_EPOCH" }));
      expect(() => driver.tx(() => undefined))
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

  it("reacquires an expired worker lease before the next meaningful mutation", async () => {
    const { driver, store: rawStore } = await legacyStore();
    const rowId = String(rawStore.query({ from: "projects" })[0]!.id);
    let now = 1_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const authority = ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: now,
      leaseTtlMs: 5_000,
    });
    try {
      expect(authority.inspectAuthority().catalog)
        .toMatchObject({ catalogGeneration: "2", writeEpoch: "1" });
      now = 7_000;
      vi.setSystemTime(now);
      await expect(authority.executeMutation({
        requestId: opaque("req", "o"),
        route: "store.update",
        payload: { table: "projects", id: rowId, patch: { name: "Renewed" } },
      })).resolves.toMatchObject({ changed: true, replayed: false });
      expect(authority.inspectAuthority().targetReservations.map(row => row.state))
        .toEqual(["committed"]);
      expect(authority.inspectAuthority().catalog)
        .toMatchObject({ catalogGeneration: "5", writeEpoch: "2" });
      expect(authority.query({ from: "projects" })[0]).toMatchObject({ name: "Renewed" });
    } finally {
      authority.close();
      vi.useRealTimers();
    }
  });

  it("recovers one expired mirrored reservation before reopening for writes", async () => {
    const driver = await cataloguedStore();
    const catalog = DeviceCatalog.openExisting(driver);
    const target = TargetAuthorityStore.open(driver);
    const releaseId = opaque("rel", "r");
    const fence = catalog.acquireWriteLease({
      expectedAuthorityIncarnationId: catalog.snapshot().authorityIncarnationId,
      expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
      expectedWriteEpoch: catalog.snapshot().writeEpoch,
      releaseId,
      nowMs: 1_000,
      ttlMs: 1_000,
    });
    const expected = target.evidence();
    const operationId = opaque("op", "r");
    const requestSha256 = `sha256:${"a".repeat(64)}`;
    driver.tx(() => {
      target.reserveProtectionRevision(
        operationId, new Date(1_000).toISOString(), expected, requestSha256,
      );
      catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
        expectedTarget: expected,
        operationId,
        requestSha256,
        fence,
        nowMs: 1_000,
      });
    });

    const reopened = ProductionStoreAuthority.openExisting(driver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "s"),
      nowMs: 3_000,
      leaseTtlMs: 5_000,
    });
    try {
      const inspected = reopened.inspectAuthority();
      expect(inspected.targetReservations).toEqual([
        expect.objectContaining({ operationId, state: "abandoned" }),
      ]);
      expect(inspected.catalogReservations).toEqual([
        expect.objectContaining({ operationId, state: "abandoned" }),
      ]);
      await expect(reopened.executeMutation({
        requestId: opaque("req", "r"), route: "setting.set",
        payload: { key: "after_recovery", value: true },
      })).resolves.toMatchObject({ changed: true });
    } finally {
      reopened.close();
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
        selectedAppInstanceId: opaque("app", "a"),
        catalogGeneration: "2",
        apps: [{ id: opaque("app", "a"), name: "My app", shellId: "tracker" }],
      });
      expect(authority.query({ from: "projects" })).toHaveLength(1);
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

  it("reconciles every live app namespace without rejecting a valid multi-app catalog", async () => {
    const driver = await cataloguedStore();
    try {
      const catalog = DeviceCatalog.openExisting(driver);
      const snapshot = catalog.snapshot();
      const activeStorage = catalog.activeTargetStorageInventory();
      const firstEntry = snapshot.entries[0]!;
      const firstTarget = activeStorage[0]!.target;
      const secondApp = opaque("app", "y");
      const secondGenerationId = opaque("gen", "z");
      const secondNamespaceId = opaque("ns", "x");
      const secondStorage = {
        target: {
          ...firstTarget,
          appInstanceId: secondApp,
          activeGenerationId: secondGenerationId,
        },
        namespaceId: secondNamespaceId,
        storageKey: secondNamespaceId,
      };
      const twoAppSnapshot = {
        ...snapshot,
        entries: [firstEntry, {
          ...firstEntry,
          appInstanceId: secondApp,
          displayName: "Second app",
          activeGenerationId: secondGenerationId,
          journalGenesisGenerationId: secondGenerationId,
        }],
      };
      const inventory = {
        state: "complete" as const,
        catalogPresent: true,
        namespaces: [
          legacyInventory.namespaces[0]!,
          { storageKey: secondNamespaceId, userFile: `/${secondNamespaceId}-user.db`,
            systemFile: `/${secondNamespaceId}-system.db`, kind: "generation" as const },
        ],
      };
      expect(resolveCatalogInventory(
        twoAppSnapshot, [...activeStorage, secondStorage], "default", inventory,
      )).toBe("default");
      expect(() => resolveCatalogInventory(
        twoAppSnapshot, [...activeStorage, secondStorage], "default",
        { ...inventory, namespaces: inventory.namespaces.slice(0, 1) },
      )).toThrow(/exactly match/i);
      expect(() => resolveCatalogInventory(
        twoAppSnapshot, [...activeStorage, secondStorage], "default",
        { ...inventory, namespaces: [...inventory.namespaces, {
          storageKey: "unknown", userFile: "/unknown.user.db",
          systemFile: "/unknown.system.db", kind: "generation" as const,
        }] },
      )).toThrow(/exactly match/i);

      const reservedAlias = opaque("ns", "v");
      const legacyAliasTarget = {
        ...secondStorage,
        namespaceId: opaque("ns", "w"),
        storageKey: reservedAlias,
      };
      expect(() => resolveCatalogInventory(
        twoAppSnapshot, [...activeStorage, legacyAliasTarget], "default", {
          ...inventory,
          namespaces: [legacyInventory.namespaces[0]!, {
            storageKey: reservedAlias,
            userFile: `/${reservedAlias}-user.db`,
            systemFile: `/${reservedAlias}-system.db`,
            kind: "generation" as const,
          }],
        },
      )).toThrow(/physical|exactly match/i);
    } finally {
      driver.close();
    }
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
        selectedAppInstanceId: opaque("app", "a"),
        catalogGeneration: "2",
        apps: [{ id: opaque("app", "a"), name: "My app", shellId: "blank" }],
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

  it("routes declared Bridge insert/update/delete through the authority store port", async () => {
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
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const [storeServerPort, storeClientPort] = portPair();
      serveStore(authority.asyncStore(), storeServerPort);
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
      panel.send({ v: 1, kind: "user_gesture" }); await tick();
      const inserted = await panel.call("db.insert", [
        "projects", { name: "Authority row" },
      ]) as { id: string; name: string };
      panel.send({ v: 1, kind: "user_gesture" }); await tick();
      await expect(panel.call("db.update", [
        "projects", inserted.id, { name: "Updated through Bridge" },
      ])).resolves.toMatchObject({ id: inserted.id, name: "Updated through Bridge" });
      panel.send({ v: 1, kind: "user_gesture" }); await tick();
      await expect(panel.call("db.softDelete", ["projects", inserted.id])).resolves.toBeNull();
      expect(authority.query({ from: "projects" })).toHaveLength(1);
      expect(authority.inspectAuthority().targetReservations.map(row => row.state))
        .toEqual(["committed", "committed", "committed"]);
    } finally {
      authority.close();
    }
  });
});