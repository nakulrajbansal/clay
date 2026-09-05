import {
  AppCatalogSnapshotV1,
  AppCatalogEntryV1,
  AppInstanceId,
  AuthorityIncarnationId,
  ImmutableAppGenerationV1,
  GenerationId,
  LeaseId,
  NamespaceId,
  OperationId,
  ReleaseId,
  UInt64Decimal,
  WriteFenceV1,
} from "@clay/schema";
import type {
  AppCatalogSnapshotV1 as AppCatalogSnapshot,
  WriteFenceV1 as WriteFence,
} from "@clay/schema";
import type { DbDriver, SqlRow } from "./db";
import { ClayError } from "./errors";

const EXPECTED_TABLES = [
  "app_entries",
  "catalog_root",
  "generations",
  "id_registry",
  "leases",
  "lineage_reservations",
  "pending_jobs",
  "revision_reservations",
] as const;

const CATALOG_DDL = [
  `CREATE TABLE catalog.catalog_root(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    authority_incarnation_id TEXT NOT NULL UNIQUE,
    catalog_generation TEXT NOT NULL,
    selected_app_instance_id TEXT,
    write_epoch TEXT NOT NULL
  )`,
  `CREATE TABLE catalog.app_entries(
    app_instance_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    active_generation_id TEXT NOT NULL UNIQUE,
    current_lineage_epoch TEXT NOT NULL,
    lineage_epoch_high_water TEXT NOT NULL,
    current_protection_revision TEXT NOT NULL,
    revision_high_water TEXT NOT NULL,
    digest_schema INTEGER NOT NULL CHECK(digest_schema = 1),
    state_sha256 TEXT NOT NULL,
    tombstoned INTEGER NOT NULL CHECK(tombstoned IN (0,1))
  )`,
  `CREATE TABLE catalog.generations(
    generation_id TEXT PRIMARY KEY,
    app_instance_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL UNIQUE,
    storage_key TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL UNIQUE,
    lineage_epoch TEXT NOT NULL,
    first_revision TEXT NOT NULL,
    digest_schema INTEGER NOT NULL CHECK(digest_schema = 1),
    state_sha256 TEXT NOT NULL,
    source_archive_sha256 TEXT,
    source_provenance_id TEXT,
    sealed_at TEXT NOT NULL,
    read_back_at TEXT NOT NULL
  )`,
  `CREATE TABLE catalog.id_registry(
    id_value TEXT PRIMARY KEY,
    id_kind TEXT NOT NULL CHECK(id_kind IN ('authority','app','generation','namespace','lease','operation','job')),
    retained_at TEXT NOT NULL
  )`,
  `CREATE TABLE catalog.leases(
    lease_id TEXT PRIMARY KEY,
    authority_incarnation_id TEXT NOT NULL,
    write_epoch TEXT NOT NULL,
    release_id TEXT NOT NULL,
    issued_at_ms TEXT NOT NULL,
    expires_at_ms TEXT NOT NULL,
    revoked INTEGER NOT NULL CHECK(revoked IN (0,1))
  )`,
  `CREATE TABLE catalog.pending_jobs(
    job_id TEXT PRIMARY KEY,
    authority_incarnation_id TEXT NOT NULL,
    app_instance_id TEXT,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE catalog.revision_reservations(
    app_instance_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    PRIMARY KEY(app_instance_id, revision)
  )`,
  `CREATE TABLE catalog.lineage_reservations(
    app_instance_id TEXT NOT NULL,
    lineage_epoch TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    PRIMARY KEY(app_instance_id, lineage_epoch)
  )`,
] as const;

const EXPECTED_COLUMN_SIGNATURES: Record<typeof EXPECTED_TABLES[number], string> = {
  app_entries: "app_instance_id:TEXT:0:1|display_name:TEXT:1:0|active_generation_id:TEXT:1:0|current_lineage_epoch:TEXT:1:0|lineage_epoch_high_water:TEXT:1:0|current_protection_revision:TEXT:1:0|revision_high_water:TEXT:1:0|digest_schema:INTEGER:1:0|state_sha256:TEXT:1:0|tombstoned:INTEGER:1:0",
  catalog_root: "singleton:INTEGER:0:1|schema_version:INTEGER:1:0|authority_incarnation_id:TEXT:1:0|catalog_generation:TEXT:1:0|selected_app_instance_id:TEXT:0:0|write_epoch:TEXT:1:0",
  generations: "generation_id:TEXT:0:1|app_instance_id:TEXT:1:0|namespace_id:TEXT:1:0|storage_key:TEXT:1:0|operation_id:TEXT:1:0|lineage_epoch:TEXT:1:0|first_revision:TEXT:1:0|digest_schema:INTEGER:1:0|state_sha256:TEXT:1:0|source_archive_sha256:TEXT:0:0|source_provenance_id:TEXT:0:0|sealed_at:TEXT:1:0|read_back_at:TEXT:1:0",
  id_registry: "id_value:TEXT:0:1|id_kind:TEXT:1:0|retained_at:TEXT:1:0",
  leases: "lease_id:TEXT:0:1|authority_incarnation_id:TEXT:1:0|write_epoch:TEXT:1:0|release_id:TEXT:1:0|issued_at_ms:TEXT:1:0|expires_at_ms:TEXT:1:0|revoked:INTEGER:1:0",
  lineage_reservations: "app_instance_id:TEXT:1:1|lineage_epoch:TEXT:1:2|operation_id:TEXT:1:0|state:TEXT:1:0",
  pending_jobs: "job_id:TEXT:0:1|authority_incarnation_id:TEXT:1:0|app_instance_id:TEXT:0:0|kind:TEXT:1:0|state:TEXT:1:0|operation_id:TEXT:1:0|created_at:TEXT:1:0|updated_at:TEXT:1:0",
  revision_reservations: "app_instance_id:TEXT:1:1|revision:TEXT:1:2|operation_id:TEXT:1:0|state:TEXT:1:0",
};

function normalizeDdl(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const EXPECTED_DDL = new Map(CATALOG_DDL.map(ddl => {
  const match = /^CREATE TABLE catalog\.([a-z_]+)\(/.exec(ddl);
  if (!match) throw new Error("invalid trusted catalog DDL");
  return [match[1]!, normalizeDdl(ddl.replace("CREATE TABLE catalog.", "CREATE TABLE "))];
}));

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
type OpaquePrefix = "auth" | "app" | "gen" | "ns" | "lease";
type RetainedIdKind = "authority" | "app" | "generation" | "namespace" | "lease";

function mintOpaqueId(prefix: OpaquePrefix): string {
  if (!globalThis.crypto?.getRandomValues)
    throw new ClayError("E_CATALOG_UNAVAILABLE", "secure catalog identity generation is unavailable");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 25; index >= 0; index--)
    encoded += BASE32[Number((value >> BigInt(index * 5)) & 31n)];
  return `${prefix}_${encoded}`;
}

const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_LEASE_DURATION_MS = 300_000n;

function incrementCounter(value: string, code: "E_CATALOG_CONFLICT" | "E_STALE_WRITE_EPOCH"): string {
  const parsed = UInt64Decimal.safeParse(value);
  if (!parsed.success || BigInt(parsed.data) === UINT64_MAX)
    throw new ClayError(code, "authoritative counter cannot advance");
  return String(BigInt(parsed.data) + 1n);
}

function validClockValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validStorageKey(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export type AcquireWriteLeaseInput = {
  expectedAuthorityIncarnationId: string;
  expectedCatalogGeneration: string;
  expectedWriteEpoch: string;
  releaseId: string;
  nowMs: number;
  ttlMs: number;
};

function catalogTables(driver: DbDriver): string[] {
  try {
    return driver.select(
      "SELECT name FROM catalog.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map(row => String(row.name));
  } catch {
    throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog inventory is unavailable");
  }
}

function hasExactSchema(tables: string[]): boolean {
  return tables.length === EXPECTED_TABLES.length
    && tables.every((table, index) => table === EXPECTED_TABLES[index]);
}

function hasOnlyExpectedObjects(driver: DbDriver): boolean {
  try {
    const objects = driver.select(
      "SELECT type, name FROM catalog.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return objects.length === EXPECTED_TABLES.length && objects.every((object, index) =>
      String(object.type) === "table" && String(object.name) === EXPECTED_TABLES[index]);
  } catch {
    return false;
  }
}

function hasExactTableShapes(driver: DbDriver): boolean {
  try {
    return EXPECTED_TABLES.every(table => {
      const signature = driver.select(
        `SELECT name, type, "notnull" AS required, pk
         FROM pragma_table_info('${table}', 'catalog') ORDER BY cid`,
      ).map(column => `${String(column.name)}:${String(column.type).toUpperCase()}`
        + `:${Number(column.required)}:${Number(column.pk)}`).join("|");
      return signature === EXPECTED_COLUMN_SIGNATURES[table];
    });
  } catch {
    return false;
  }
}

function hasExactTableDdl(driver: DbDriver): boolean {
  try {
    const rows = driver.select(
      "SELECT name, sql FROM catalog.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    return rows.length === EXPECTED_DDL.size && rows.every(row =>
      EXPECTED_DDL.get(String(row.name)) === normalizeDdl(String(row.sql)));
  } catch {
    return false;
  }
}

function mapLiveEntry(row: SqlRow): AppCatalogSnapshot["entries"][number] {
  if (Number(row.tombstoned) !== 0) throw new Error("live catalog entry is tombstoned");
  return {
    appInstanceId: String(row.app_instance_id),
    displayName: String(row.display_name),
    activeGenerationId: String(row.active_generation_id),
    currentLineageEpoch: String(row.current_lineage_epoch),
    lineageEpochHighWater: String(row.lineage_epoch_high_water),
    currentProtectionRevision: String(row.current_protection_revision),
    revisionHighWater: String(row.revision_high_water),
    digestSchema: Number(row.digest_schema) as 1,
    stateSha256: String(row.state_sha256),
    tombstoned: false,
  };
}

function readSnapshot(driver: DbDriver): AppCatalogSnapshot {
  const roots = driver.select("SELECT * FROM catalog.catalog_root ORDER BY singleton");
  if (roots.length !== 1) throw new Error("catalog root cardinality");
  const root = roots[0]!;
  const snapshot = {
    schema: Number(root.schema_version),
    authorityIncarnationId: String(root.authority_incarnation_id),
    catalogGeneration: String(root.catalog_generation),
    selectedAppInstanceId: root.selected_app_instance_id === null
      ? null
      : String(root.selected_app_instance_id),
    entries: driver.select(
      "SELECT * FROM catalog.app_entries WHERE tombstoned = 0 ORDER BY app_instance_id",
    ).map(mapLiveEntry),
    writeEpoch: String(root.write_epoch),
  };
  return AppCatalogSnapshotV1.parse(snapshot);
}

function readSnapshotClosed(driver: DbDriver): AppCatalogSnapshot {
  try {
    return readSnapshot(driver);
  } catch {
    throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog failed validation");
  }
}

function readValidatedCatalog(driver: DbDriver): AppCatalogSnapshot {
  const snapshot = readSnapshotClosed(driver);
  try {
    const retained = new Map<string, string>();
    for (const row of driver.select("SELECT id_value, id_kind FROM catalog.id_registry")) {
      const value = String(row.id_value);
      const kind = String(row.id_kind);
      if (retained.has(value)) throw new Error("duplicate retained identity");
      if (kind === "authority") AuthorityIncarnationId.parse(value);
      else if (kind === "app") AppInstanceId.parse(value);
      else if (kind === "generation") GenerationId.parse(value);
      else if (kind === "namespace") NamespaceId.parse(value);
      else if (kind === "lease") LeaseId.parse(value);
      else if (kind === "operation") OperationId.parse(value);
      else if (kind === "job") {
        if (!/^job_[a-z2-7]{26}$/.test(value)) throw new Error("invalid job identity");
      } else throw new Error("unknown retained identity kind");
      retained.set(value, kind);
    }
    const requireRetained = (value: string, kind: string): void => {
      if (retained.get(value) !== kind) throw new Error(`missing retained ${kind} identity`);
    };
    requireRetained(snapshot.authorityIncarnationId, "authority");

    const appRows = driver.select("SELECT * FROM catalog.app_entries ORDER BY app_instance_id");
    const apps = new Map<string, AppCatalogSnapshot["entries"][number]>();
    for (const row of appRows) {
      const tombstoned = Number(row.tombstoned);
      if (tombstoned !== 0 && tombstoned !== 1) throw new Error("invalid app tombstone");
      const app = AppCatalogEntryV1.parse({ ...mapLiveEntry({ ...row, tombstoned: 0 }) });
      requireRetained(app.appInstanceId, "app");
      apps.set(app.appInstanceId, app);
    }
    if (snapshot.entries.length !== appRows.filter(row => Number(row.tombstoned) === 0).length)
      throw new Error("live app projection is incomplete");

    const generations = new Map<string, ReturnType<typeof ImmutableAppGenerationV1.parse>>();
    for (const row of driver.select("SELECT * FROM catalog.generations ORDER BY generation_id")) {
      const operationId = OperationId.parse(String(row.operation_id));
      if (!validStorageKey(String(row.storage_key))) throw new Error("invalid generation storage key");
      const descriptor = ImmutableAppGenerationV1.parse({
        schema: 1,
        generationId: String(row.generation_id),
        target: {
          appInstanceId: String(row.app_instance_id),
          activeGenerationId: String(row.generation_id),
          lineageEpoch: String(row.lineage_epoch),
          protectionRevision: String(row.first_revision),
          digestSchema: Number(row.digest_schema),
          stateSha256: String(row.state_sha256),
        },
        namespaceId: String(row.namespace_id),
        sourceArchiveSha256: row.source_archive_sha256 === null
          ? null : String(row.source_archive_sha256),
        sourceProvenanceId: row.source_provenance_id === null
          ? null : String(row.source_provenance_id),
        sealedAt: String(row.sealed_at),
        readBackAt: String(row.read_back_at),
      });
      if (!apps.has(descriptor.target.appInstanceId)) throw new Error("orphan generation");
      requireRetained(descriptor.generationId, "generation");
      requireRetained(descriptor.namespaceId, "namespace");
      requireRetained(operationId, "operation");
      generations.set(descriptor.generationId, descriptor);
    }
    for (const app of apps.values()) {
      const generation = generations.get(app.activeGenerationId);
      if (!generation
          || generation.target.appInstanceId !== app.appInstanceId
          || generation.target.lineageEpoch !== app.currentLineageEpoch
          || generation.target.protectionRevision !== app.currentProtectionRevision
          || generation.target.digestSchema !== app.digestSchema
          || generation.target.stateSha256 !== app.stateSha256)
        throw new Error("active generation does not match app entry");
    }

    let activeLeaseCount = 0;
    for (const row of driver.select("SELECT * FROM catalog.leases ORDER BY lease_id")) {
      const leaseId = LeaseId.parse(String(row.lease_id));
      const authority = AuthorityIncarnationId.parse(String(row.authority_incarnation_id));
      const leaseWriteEpoch = UInt64Decimal.parse(String(row.write_epoch));
      ReleaseId.parse(String(row.release_id));
      const issued = UInt64Decimal.parse(String(row.issued_at_ms));
      const expires = UInt64Decimal.parse(String(row.expires_at_ms));
      if (BigInt(expires) <= BigInt(issued)
          || BigInt(expires) - BigInt(issued) > MAX_LEASE_DURATION_MS)
        throw new Error("invalid lease interval");
      const revoked = Number(row.revoked);
      if (revoked !== 0 && revoked !== 1) throw new Error("invalid lease revocation state");
      if (revoked === 0) {
        activeLeaseCount++;
        if (authority !== snapshot.authorityIncarnationId || leaseWriteEpoch !== snapshot.writeEpoch)
          throw new Error("active lease does not match current authority");
      }
      requireRetained(leaseId, "lease");
      requireRetained(authority, "authority");
    }
    if (activeLeaseCount > 1) throw new Error("multiple active write leases");
    const unfinished = driver.select(
      `SELECT (SELECT count(*) FROM catalog.pending_jobs)
            + (SELECT count(*) FROM catalog.revision_reservations)
            + (SELECT count(*) FROM catalog.lineage_reservations) AS count`,
    );
    if (unfinished.length !== 1 || Number(unfinished[0]!.count) !== 0)
      throw new Error("unsupported catalog work is present");
    return snapshot;
  } catch {
    throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog relationships failed validation");
  }
}

export class DeviceCatalog {
  private constructor(private readonly driver: DbDriver) {}

  static openExisting(driver: DbDriver): DeviceCatalog {
    if (!hasExactSchema(catalogTables(driver)) || !hasOnlyExpectedObjects(driver)
        || !hasExactTableShapes(driver) || !hasExactTableDdl(driver))
      throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog schema is unavailable");
    readValidatedCatalog(driver);
    return new DeviceCatalog(driver);
  }

  static initializeFresh(driver: DbDriver): DeviceCatalog {
    if (catalogTables(driver).length !== 0)
      throw new ClayError("E_CATALOG_CONFLICT", "authoritative catalog is already initialized");
    const authorityIncarnationId = mintOpaqueId("auth");
    try {
      driver.tx(() => {
        for (const ddl of CATALOG_DDL) driver.exec(ddl);
        driver.exec(
          `INSERT INTO catalog.catalog_root(
             singleton, schema_version, authority_incarnation_id,
             catalog_generation, selected_app_instance_id, write_epoch
           ) VALUES (1, 1, ?, '0', NULL, '0')`,
          [authorityIncarnationId],
        );
        driver.exec(
          "INSERT INTO catalog.id_registry(id_value, id_kind, retained_at) VALUES (?, 'authority', ?)",
          [authorityIncarnationId, new Date().toISOString()],
        );
      });
    } catch {
      throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog initialization failed");
    }
    return DeviceCatalog.openExisting(driver);
  }

  snapshot(): AppCatalogSnapshot {
    return readValidatedCatalog(this.driver);
  }

  private retainFreshId(prefix: OpaquePrefix, kind: RetainedIdKind, retainedAt: string): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const id = mintOpaqueId(prefix);
      const present = this.driver.select(
        "SELECT id_value FROM catalog.id_registry WHERE id_value = ?",
        [id],
      );
      if (present.length > 0) continue;
      this.driver.exec(
        "INSERT INTO catalog.id_registry(id_value, id_kind, retained_at) VALUES (?, ?, ?)",
        [id, kind, retainedAt],
      );
      return id;
    }
    throw new ClayError("E_CATALOG_UNAVAILABLE", `could not mint a unique ${kind} identity`);
  }

  acquireWriteLease(input: AcquireWriteLeaseInput): WriteFence {
    const authority = AuthorityIncarnationId.safeParse(input.expectedAuthorityIncarnationId);
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const writeEpoch = UInt64Decimal.safeParse(input.expectedWriteEpoch);
    const releaseId = ReleaseId.safeParse(input.releaseId);
    if (!authority.success || !catalogGeneration.success || !writeEpoch.success || !releaseId.success
        || !validClockValue(input.nowMs) || !validClockValue(input.ttlMs)
        || input.ttlMs === 0 || input.ttlMs > Number(MAX_LEASE_DURATION_MS)
        || input.nowMs > Number.MAX_SAFE_INTEGER - input.ttlMs)
      throw new ClayError("E_STALE_WRITE_EPOCH", "write lease request is invalid");

    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        if (before.authorityIncarnationId !== authority.data)
          throw new ClayError("E_STALE_WRITE_EPOCH", "authority incarnation is stale");
        if (before.catalogGeneration !== catalogGeneration.data)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog generation is stale");
        if (before.writeEpoch !== writeEpoch.data)
          throw new ClayError("E_STALE_WRITE_EPOCH", "origin write epoch is stale");

        const nextCatalogGeneration = incrementCounter(before.catalogGeneration, "E_CATALOG_CONFLICT");
        const nextWriteEpoch = incrementCounter(before.writeEpoch, "E_STALE_WRITE_EPOCH");
        const issuedAt = String(input.nowMs);
        const expiresAt = String(input.nowMs + input.ttlMs);
        const leaseId = this.retainFreshId("lease", "lease", new Date(input.nowMs).toISOString());
        this.driver.exec(
          "UPDATE catalog.leases SET revoked = 1 WHERE authority_incarnation_id = ? AND revoked = 0",
          [before.authorityIncarnationId],
        );
        this.driver.exec(
          `INSERT INTO catalog.leases(
             lease_id, authority_incarnation_id, write_epoch, release_id,
             issued_at_ms, expires_at_ms, revoked
           ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
          [leaseId, before.authorityIncarnationId, nextWriteEpoch, releaseId.data, issuedAt, expiresAt],
        );
        this.driver.exec(
          `UPDATE catalog.catalog_root
           SET catalog_generation = ?, write_epoch = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND write_epoch = ?`,
          [nextCatalogGeneration, nextWriteEpoch, before.authorityIncarnationId,
            before.catalogGeneration, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        if (after.catalogGeneration !== nextCatalogGeneration || after.writeEpoch !== nextWriteEpoch)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog lease CAS did not publish");
        return WriteFenceV1.parse({
          authorityIncarnationId: after.authorityIncarnationId,
          writeEpoch: after.writeEpoch,
          leaseId,
          releaseId: releaseId.data,
        });
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "write lease acquisition failed");
    }
  }

  assertWriteFence(input: WriteFence, nowMs: number): WriteFence {
    const fence = WriteFenceV1.safeParse(input);
    if (!fence.success || !validClockValue(nowMs))
      throw new ClayError("E_STALE_WRITE_EPOCH", "write fence is invalid");
    try {
      return this.driver.tx(() => {
        const snapshot = readValidatedCatalog(this.driver);
        if (snapshot.authorityIncarnationId !== fence.data.authorityIncarnationId
            || snapshot.writeEpoch !== fence.data.writeEpoch)
          throw new ClayError("E_STALE_WRITE_EPOCH", "write fence is stale");
        const leases = this.driver.select(
          "SELECT * FROM catalog.leases WHERE lease_id = ?",
          [fence.data.leaseId],
        );
        if (leases.length !== 1)
          throw new ClayError("E_STALE_WRITE_EPOCH", "write lease is unavailable");
        const lease = leases[0]!;
        const issued = UInt64Decimal.safeParse(String(lease.issued_at_ms));
        const expires = UInt64Decimal.safeParse(String(lease.expires_at_ms));
        if (!issued.success || !expires.success
            || String(lease.authority_incarnation_id) !== fence.data.authorityIncarnationId
            || String(lease.write_epoch) !== fence.data.writeEpoch
            || String(lease.release_id) !== fence.data.releaseId
            || Number(lease.revoked) !== 0
            || BigInt(nowMs) < BigInt(issued.data)
            || BigInt(nowMs) >= BigInt(expires.data))
          throw new ClayError("E_STALE_WRITE_EPOCH", "write lease is stale or expired");
        return fence.data;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "write lease validation failed");
    }
  }

}
