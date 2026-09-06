import { describe, expect, it, vi } from "vitest";
import { ArchiveAuthorityEvidenceV1, ArchiveManifestV5 } from "@clay/schema/archive";
import {
  Bridge, ClayStore, StoreRpcClient, deriveInverse, openMemoryDriver, serveStore, zipRead,
  type DbDriver, type ForwardOpT, type MessagePortLike,
} from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import {
  importAuthorityArchive,
  restoreAuthorityArchiveAsNew,
} from "../src/archive-authority";
import { DeviceCatalog } from "../src/device-catalog";
import {
  ProductionStoreAuthority,
  armProductionAuthorityFailureForTest,
  planLegacyBootstrap,
  resolveCatalogInventory,
} from "../src/production-authority";
import {
  productionOperationIdV1,
  productionOperationIdV2,
} from "../src/production-operation-id";
import { sha256HexSync } from "../src/state-digest";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

function operationIdForFixture(driver: DbDriver, requestId: string, route: string): string {
  const authorityRows = driver.select(
    "SELECT authority_incarnation_id FROM catalog.catalog_root WHERE singleton = 1",
  );
  if (authorityRows.length !== 1 || typeof authorityRows[0]!.authority_incarnation_id !== "string")
    throw new Error("fixture catalog authority is unavailable");
  const authorityIncarnationId = authorityRows[0]!.authority_incarnation_id;
  return productionOperationIdV2(authorityIncarnationId, requestId, route);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * This isolated archive branch predates the migration lane's canonical sample
 * producer. The trigger lets the real starter route write that incoming
 * contract in both its shadow and live transactions; once the lanes are
 * combined it is a no-op because the producer no longer writes sample_rows.
 */
function installStarterProvenanceFixture(driver: DbDriver, operationId: string): void {
  driver.exec(`CREATE TEMP TRIGGER archive_starter_provenance_fixture
    BEFORE INSERT ON sys.settings
    WHEN NEW.key = 'sample_rows'
      AND NOT EXISTS (SELECT 1 FROM sys.settings WHERE key = 'sample_provenance_v1')
    BEGIN
      INSERT INTO settings(key,value_json)
      SELECT 'sample_provenance_v1',
        '{"schema":1,"entries":[' || COALESCE(group_concat(
          '{"tableId":' || json_quote(json_extract(registry.spec_json, '$.semantic.tableId'))
          || ',"rowId":' || json_quote(CAST(ids.value AS TEXT))
          || ',"operationId":' || json_quote(${sqlLiteral(operationId)}) || '}', ','
        ), '') || ']}'
      FROM json_each(NEW.value_json) AS marker
      JOIN tables_registry AS registry ON registry.table_name = marker.key
      JOIN json_each(marker.value) AS ids;
      SELECT RAISE(IGNORE);
    END`);
}

type ProvenanceTamper = "table" | "operation" | "unrelated" | "omission" | "shape" | "legacy";

function installProvenanceTamperFixture(
  driver: DbDriver,
  tamper: ProvenanceTamper,
  operationId: string,
): void {
  const canonicalTableId = `json_quote(json_extract(
        (SELECT spec_json FROM tables_registry WHERE table_name = 'samples'),
        '$.semantic.tableId'))`;
  const rowId = `json_quote(json_extract(
        (SELECT value_json FROM settings WHERE key = 'sample_provenance_v1'),
        '$.entries[0].rowId'))`;
  const canonicalEntry = `'{"schema":1,"entries":[{"tableId":' || ${canonicalTableId}
      || ',"rowId":' || ${rowId}
      || ',"operationId":' || json_quote(${sqlLiteral(operationId)}) || '}]}'`;
  let body: string;
  switch (tamper) {
    case "table":
      body = `UPDATE settings SET value_json =
        '{"schema":1,"entries":[{"tableId":"tbl_018f0000-0000-7000-8000-000000000099"'
        || ',"rowId":' || ${rowId}
        || ',"operationId":' || json_quote(${sqlLiteral(operationId)}) || '}]}'
        WHERE key = 'sample_provenance_v1';`;
      break;
    case "operation":
      body = `UPDATE settings SET value_json =
        '{"schema":1,"entries":[{"tableId":' || ${canonicalTableId}
        || ',"rowId":' || ${rowId}
        || ',"operationId":"${opaque("op", "z")}"}]}'
        WHERE key = 'sample_provenance_v1';`;
      break;
    case "unrelated":
      body = `UPDATE settings SET value_json = ${canonicalEntry}
        WHERE key = 'sample_provenance_v1';`;
      break;
    case "omission":
      body = `UPDATE settings SET value_json = '{"schema":1,"entries":[]}'
        WHERE key = 'sample_provenance_v1';`;
      break;
    case "shape":
      body = `UPDATE settings SET value_json = substr(${canonicalEntry}, 1, length(${canonicalEntry}) - 1)
        || ',"unexpected":true}' WHERE key = 'sample_provenance_v1';`;
      break;
    case "legacy":
      body = `INSERT INTO settings(key,value_json)
        SELECT 'sample_rows', '{"samples":[' || ${rowId} || ']}'
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;`;
      break;
  }
  driver.exec(`CREATE TEMP TRIGGER archive_provenance_tamper_fixture
    AFTER UPDATE ON main.projects
    BEGIN
      ${body}
    END`);
}

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

type SampleProvenanceFixture = Readonly<{
  authority: ProductionStoreAuthority;
  ledger: Readonly<{
    schema: 1;
    entries: readonly Readonly<{ tableId: string; rowId: string; operationId: string }>[];
  }>;
}>;

async function openSampleProvenanceFixture(
  tamper?: ProvenanceTamper,
): Promise<SampleProvenanceFixture> {
  const driver = await cataloguedStore();
  const seedRequestId = opaque("req", "r");
  const tamperRequestId = opaque("req", "t");
  const expectedOperationId = operationIdForFixture(driver, seedRequestId, "starter.seed");
  const unrelatedOperationId = operationIdForFixture(driver, tamperRequestId, "store.update");
  const installTemporaryFixtures = (target: DbDriver): void => {
    installStarterProvenanceFixture(target, expectedOperationId);
    if (tamper !== undefined)
      installProvenanceTamperFixture(
        target, tamper,
        tamper === "unrelated" ? unrelatedOperationId : expectedOperationId,
      );
  };
  installTemporaryFixtures(driver);
  const mutableDriver = driver as DbDriver & { snapshot: DbDriver["snapshot"] };
  const realSnapshot = mutableDriver.snapshot.bind(driver);
  mutableDriver.snapshot = async () => {
    const shadow = await realSnapshot();
    installTemporaryFixtures(shadow);
    return shadow;
  };
  const authority = ProductionStoreAuthority.openExisting(driver, {
    inventory: { ...legacyInventory, catalogPresent: true },
    storageKey: "default",
    releaseId: opaque("rel", "f"),
    nowMs: 2_000,
    leaseTtlMs: 5_000,
  });
  try {
    const sourceMutation = await authority.executeMutation({
      requestId: seedRequestId,
      route: "starter.seed",
      payload: {
        schema: 1,
        shellId: "tracker",
        shellName: "Tracker",
        tables: [{
          name: "samples",
          columns: [{ name: "name", type: "text", required: true }],
          sampleRows: [{ name: "Provenance" }],
        }],
        panels: [],
      },
    });
    if (sourceMutation.operationId !== expectedOperationId)
      throw new Error("starter fixture operation identity changed");
    const row = authority.query({ from: "samples" })[0];
    const sampleSpecRow = driver.select(
      "SELECT spec_json FROM sys.tables_registry WHERE table_name = 'samples'",
    )[0];
    if (!row || !sampleSpecRow)
      throw new Error("trusted starter fixture did not produce one sample row");
    const sampleSpec = JSON.parse(String(sampleSpecRow.spec_json)) as {
      semantic: { tableId: string };
    };
    const ledger = Object.freeze({
      schema: 1 as const,
      entries: Object.freeze([Object.freeze({
        tableId: sampleSpec.semantic.tableId,
        rowId: String(row.id),
        operationId: sourceMutation.operationId,
      })]),
    });
    if (tamper !== undefined) {
      const project = authority.query({ from: "projects" })[0];
      if (!project) throw new Error("tamper fixture project is unavailable");
      const tamperMutation = await authority.executeMutation({
        requestId: tamperRequestId,
        route: "store.update",
        payload: {
          table: "projects",
          id: String(project.id),
          patch: { name: `Provenance ${tamper}` },
        },
      });
      if (tamper === "unrelated" && tamperMutation.operationId !== unrelatedOperationId)
        throw new Error("unrelated fixture operation identity changed");
    }
    return Object.freeze({ authority, ledger });
  } catch (error) {
    authority.close();
    throw error;
  }
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
        "privateMetricsSummary", "query", "readAttachment", "registrySnapshot",
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

  it("exports real authenticated format-5 bytes only through the production authority", async () => {
    const driver = await cataloguedStore();
    const authority = ProductionStoreAuthority.openExisting(driver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: 2_000,
      leaseTtlMs: 5_000,
    });
    try {
      expect((authority.readStore() as unknown as Record<string, unknown>).exportArchive)
        .toBeUndefined();
      const exported = await authority.exportArchive();
      expect(exported).toMatchObject({ format: 5, filename: expect.stringMatching(/\.clay\.zip$/) });
      expect(exported.bytes).toBeInstanceOf(Uint8Array);
      expect(exported.bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
      const parts = zipRead(exported.bytes);
      const manifest = ArchiveManifestV5.parse(JSON.parse(new TextDecoder().decode(
        parts.find(part => part.name === "manifest.json")!.data,
      )));
      const evidence = ArchiveAuthorityEvidenceV1.parse(JSON.parse(new TextDecoder().decode(
        parts.find(part => part.name === "authority.json")!.data,
      )));
      expect(manifest).toMatchObject({ format: 5, app: "My app" });
      expect(evidence.target).toEqual(exported.target);
      expect(evidence.catalogAuthority.catalogGeneration).toBe(exported.catalogGeneration);
      const staged = await importAuthorityArchive(exported.bytes);
      try {
        expect(staged.authority).toMatchObject({
          kind: "format5_authority_evidence",
          checksumAuthenticated: true,
        });
        expect(staged.store.query({ from: "projects" }))
          .toEqual([expect.objectContaining({ name: "Preserved" })]);
      } finally {
        staged.store.close();
      }
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

  it("preserves strict sample provenance and rejects forged ledger bindings", async () => {
    const valid = await openSampleProvenanceFixture();
    try {
      expect(valid.authority.readStore().getSetting("sample_provenance_v1"))
        .toEqual(valid.ledger);
      expect(valid.authority.readStore().getSetting("sample_rows")).toBeUndefined();
      const exported = await valid.authority.exportArchive();
      const imported = await importAuthorityArchive(exported.bytes);
      try {
        expect(imported.store.getSetting("sample_provenance_v1")).toEqual(valid.ledger);
      } finally {
        imported.store.close();
      }
    } finally {
      valid.authority.close();
    }

    const invalidCases: readonly (readonly [ProvenanceTamper, RegExp])[] = [
      ["table", /stable table binding/i],
      ["operation", /operation binding/i],
      ["unrelated", /route|producer|authenticated/i],
      ["omission", /diverge|authenticated|producer/i],
      ["shape", /malformed|noncanonical/i],
      ["legacy", /legacy sample_rows.*unauthenticated/i],
    ];
    for (const [tamper, expected] of invalidCases) {
      const fixture = await openSampleProvenanceFixture(tamper);
      try {
        await expect(fixture.authority.exportArchive()).rejects.toThrow(expected);
      } finally {
        fixture.authority.close();
      }
    }
  });

  it("rejects sample-bearing restore before opening a fresh target without rebind", async () => {
    const source = await openSampleProvenanceFixture();
    try {
      const archive = await source.authority.exportArchive();
      let openCalls = 0;
      await expect(restoreAuthorityArchiveAsNew(archive.bytes, {
        schema: 1,
        appInstanceId: opaque("app", "j"),
        generationId: opaque("gen", "k"),
        namespaceId: opaque("ns", "m"),
        operationId: opaque("op", "n"),
        restoredAt: "2026-09-06T12:00:00.000Z",
      }, async () => {
        openCalls++;
        return openMemoryDriver();
      })).rejects.toThrow(/sample provenance.*rebind|rebind.*sample provenance/i);
      expect(openCalls).toBe(0);
    } finally {
      source.authority.close();
    }
  });

  it("serializes archive export behind an earlier in-flight mutation", async () => {
    const driver = await cataloguedStore();
    const authority = ProductionStoreAuthority.openExisting(driver, {
      inventory: { ...legacyInventory, catalogPresent: true },
      storageKey: "default",
      releaseId: opaque("rel", "f"),
      nowMs: 2_000,
      leaseTtlMs: 5_000,
    });
    const rowId = String(authority.query({ from: "projects" })[0]!.id);
    const mutableDriver = driver as DbDriver & {
      snapshot: DbDriver["snapshot"];
      exportDatabases: DbDriver["exportDatabases"];
    };
    const realSnapshot = mutableDriver.snapshot.bind(driver);
    const realExport = mutableDriver.exportDatabases.bind(driver);
    let releaseShadow!: () => void;
    const shadowGate = new Promise<void>(resolve => { releaseShadow = resolve; });
    let shadowStarted!: () => void;
    const shadowStart = new Promise<void>(resolve => { shadowStarted = resolve; });
    let delayFirstShadow = true;
    let archiveReadStarted = false;
    mutableDriver.snapshot = async () => {
      if (delayFirstShadow) {
        delayFirstShadow = false;
        shadowStarted();
        await shadowGate;
      }
      return realSnapshot();
    };
    mutableDriver.exportDatabases = async () => {
      archiveReadStarted = true;
      return realExport();
    };
    let mutation: ReturnType<ProductionStoreAuthority["executeMutation"]> | undefined;
    let archive: ReturnType<ProductionStoreAuthority["exportArchive"]> | undefined;
    try {
      mutation = authority.executeMutation({
        requestId: opaque("req", "q"),
        route: "store.update",
        payload: { table: "projects", id: rowId, patch: { name: "After queue" } },
      });
      await shadowStart;
      archive = authority.exportArchive();
      await tick();
      const startedBeforeEarlierMutationWasReleased = archiveReadStarted;
      releaseShadow();
      const [committed, exported] = await Promise.all([mutation, archive]);

      expect(startedBeforeEarlierMutationWasReleased).toBe(false);
      expect(exported.target.protectionRevision).toBe(committed.evidence.protectionRevision);
      expect(exported.target.stateSha256).toBe(committed.evidence.stateSha256);
    } finally {
      releaseShadow();
      await Promise.allSettled([mutation, archive]);
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

  it("captures mutable accessor payloads once before asynchronous preparation", async () => {
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
      let backing = "Captured exactly once";
      let reads = 0;
      const patch: Record<string, unknown> = {};
      Object.defineProperty(patch, "name", {
        enumerable: true,
        get: () => { reads += 1; return backing; },
      });
      const payload: Record<string, unknown> = { table: "projects", id: rowId, patch };
      const pendingMutation = authority.executeMutation({
        requestId: opaque("req", "m"), route: "store.update", payload,
      });
      backing = "Tampered after capture";
      payload.patch = { name: "Replaced after capture" };
      const committed = await pendingMutation;
      expect(reads).toBe(1);
      expect(committed).toMatchObject({
        changed: true, result: { id: rowId, name: "Captured exactly once" },
      });
      expect(authority.query({ from: "projects" })[0])
        .toMatchObject({ name: "Captured exactly once" });
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