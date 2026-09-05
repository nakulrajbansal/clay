import {
  AppInstanceId,
  AuthorityIncarnationId,
  GenerationId,
  LeaseId,
  NamespaceId,
  OperationId,
  ReleaseId,
  Sha256,
  UInt64Decimal,
} from "@clay/schema";
import {
  AppCatalogEntryV1,
  AppCatalogSnapshotV1,
  CatalogCasPublicationV1,
  CatalogGenerationEventV1,
  CatalogReservationRecoveryV1,
  CatalogRevisionReservationV1,
  ImmutableAppGenerationV1,
  TargetEvidenceV1,
  WriteFenceV1,
} from "@clay/schema/catalog";
import type {
  AppCatalogSnapshotV1 as AppCatalogSnapshot,
  CatalogCasPublicationV1 as CatalogCasPublication,
  CatalogGenerationEventV1 as CatalogGenerationEvent,
  CatalogReservationRecoveryV1 as CatalogReservationRecovery,
  CatalogRevisionReservationV1 as CatalogRevisionReservation,
  ImmutableAppGenerationV1 as ImmutableAppGeneration,
  TargetEvidenceV1 as TargetEvidence,
  WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import type { DbDriver, SqlRow } from "./db";
import { ClayError } from "./errors";

const EXPECTED_TABLES = [
  "app_entries",
  "catalog_generation_events",
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
  `CREATE TABLE catalog.catalog_generation_events(
    catalog_generation TEXT PRIMARY KEY,
    event_kind TEXT NOT NULL CHECK(event_kind IN (
      'app_seed','lease_issued','revision_reserved','revision_committed',
      'revision_abandoned','recovery_takeover'
    )),
    app_instance_id TEXT,
    operation_id TEXT,
    write_epoch TEXT NOT NULL,
    at TEXT NOT NULL,
    target_generation_id TEXT,
    target_lineage_epoch TEXT,
    target_protection_revision TEXT,
    target_digest_schema INTEGER,
    target_state_sha256 TEXT,
    CHECK(
      (event_kind = 'lease_issued' AND operation_id IS NULL)
      OR (event_kind <> 'lease_issued' AND app_instance_id IS NOT NULL AND operation_id IS NOT NULL)
    ),
    CHECK(
      (event_kind = 'app_seed' AND target_generation_id IS NOT NULL
        AND target_lineage_epoch IS NOT NULL AND target_protection_revision IS NOT NULL
        AND target_digest_schema = 1 AND target_state_sha256 IS NOT NULL)
      OR (event_kind <> 'app_seed' AND target_generation_id IS NULL
        AND target_lineage_epoch IS NULL AND target_protection_revision IS NULL
        AND target_digest_schema IS NULL AND target_state_sha256 IS NULL)
    )
  )`,
  `CREATE TABLE catalog.app_entries(
    app_instance_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    active_generation_id TEXT NOT NULL UNIQUE,
    journal_genesis_generation_id TEXT NOT NULL,
    journal_genesis_lineage_epoch TEXT NOT NULL,
    journal_genesis_protection_revision TEXT NOT NULL,
    journal_genesis_state_sha256 TEXT NOT NULL,
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
    authority_incarnation_id TEXT NOT NULL,
    reserved_catalog_generation TEXT NOT NULL,
    finalized_catalog_generation TEXT,
    write_epoch TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    finalized_write_epoch TEXT,
    finalized_lease_id TEXT,
    finalized_release_id TEXT,
    active_generation_id TEXT NOT NULL,
    lineage_epoch TEXT NOT NULL,
    expected_protection_revision TEXT NOT NULL,
    expected_state_sha256 TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','committed','abandoned')),
    published_active_generation_id TEXT,
    published_lineage_epoch TEXT,
    state_sha256 TEXT,
    reserved_at TEXT NOT NULL,
    finalized_at TEXT,
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
  app_entries: "app_instance_id:TEXT:0:1|display_name:TEXT:1:0|active_generation_id:TEXT:1:0|journal_genesis_generation_id:TEXT:1:0|journal_genesis_lineage_epoch:TEXT:1:0|journal_genesis_protection_revision:TEXT:1:0|journal_genesis_state_sha256:TEXT:1:0|current_lineage_epoch:TEXT:1:0|lineage_epoch_high_water:TEXT:1:0|current_protection_revision:TEXT:1:0|revision_high_water:TEXT:1:0|digest_schema:INTEGER:1:0|state_sha256:TEXT:1:0|tombstoned:INTEGER:1:0",
  catalog_generation_events: "catalog_generation:TEXT:0:1|event_kind:TEXT:1:0|app_instance_id:TEXT:0:0|operation_id:TEXT:0:0|write_epoch:TEXT:1:0|at:TEXT:1:0|target_generation_id:TEXT:0:0|target_lineage_epoch:TEXT:0:0|target_protection_revision:TEXT:0:0|target_digest_schema:INTEGER:0:0|target_state_sha256:TEXT:0:0",
  catalog_root: "singleton:INTEGER:0:1|schema_version:INTEGER:1:0|authority_incarnation_id:TEXT:1:0|catalog_generation:TEXT:1:0|selected_app_instance_id:TEXT:0:0|write_epoch:TEXT:1:0",
  generations: "generation_id:TEXT:0:1|app_instance_id:TEXT:1:0|namespace_id:TEXT:1:0|storage_key:TEXT:1:0|operation_id:TEXT:1:0|lineage_epoch:TEXT:1:0|first_revision:TEXT:1:0|digest_schema:INTEGER:1:0|state_sha256:TEXT:1:0|source_archive_sha256:TEXT:0:0|source_provenance_id:TEXT:0:0|sealed_at:TEXT:1:0|read_back_at:TEXT:1:0",
  id_registry: "id_value:TEXT:0:1|id_kind:TEXT:1:0|retained_at:TEXT:1:0",
  leases: "lease_id:TEXT:0:1|authority_incarnation_id:TEXT:1:0|write_epoch:TEXT:1:0|release_id:TEXT:1:0|issued_at_ms:TEXT:1:0|expires_at_ms:TEXT:1:0|revoked:INTEGER:1:0",
  lineage_reservations: "app_instance_id:TEXT:1:1|lineage_epoch:TEXT:1:2|operation_id:TEXT:1:0|state:TEXT:1:0",
  pending_jobs: "job_id:TEXT:0:1|authority_incarnation_id:TEXT:1:0|app_instance_id:TEXT:0:0|kind:TEXT:1:0|state:TEXT:1:0|operation_id:TEXT:1:0|created_at:TEXT:1:0|updated_at:TEXT:1:0",
  revision_reservations: "app_instance_id:TEXT:1:1|revision:TEXT:1:2|operation_id:TEXT:1:0|authority_incarnation_id:TEXT:1:0|reserved_catalog_generation:TEXT:1:0|finalized_catalog_generation:TEXT:0:0|write_epoch:TEXT:1:0|lease_id:TEXT:1:0|release_id:TEXT:1:0|finalized_write_epoch:TEXT:0:0|finalized_lease_id:TEXT:0:0|finalized_release_id:TEXT:0:0|active_generation_id:TEXT:1:0|lineage_epoch:TEXT:1:0|expected_protection_revision:TEXT:1:0|expected_state_sha256:TEXT:1:0|request_sha256:TEXT:1:0|state:TEXT:1:0|published_active_generation_id:TEXT:0:0|published_lineage_epoch:TEXT:0:0|state_sha256:TEXT:0:0|reserved_at:TEXT:1:0|finalized_at:TEXT:0:0",
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

export type PublishSelectedTargetInput = {
  expectedCatalogGeneration: string;
  expectedTarget: TargetEvidence;
  publishedTarget: TargetEvidence;
  operationId: string;
  requestSha256: string;
  fence: WriteFence;
  nowMs: number;
};

export type ReserveSelectedProtectionRevisionInput = {
  expectedCatalogGeneration: string;
  expectedTarget: TargetEvidence;
  operationId: string;
  requestSha256: string;
  fence: WriteFence;
  nowMs: number;
};

export type AbandonSelectedProtectionRevisionInput = {
  expectedCatalogGeneration: string;
  expectedTarget: TargetEvidence;
  operationId: string;
  requestSha256: string;
  fence: WriteFence;
  nowMs: number;
};

export type RecoverExpiredSelectedReservationInput = {
  expectedAuthorityIncarnationId: string;
  expectedCatalogGeneration: string;
  expectedWriteEpoch: string;
  operationId: string;
  releaseId: string;
  nowMs: number;
  ttlMs: number;
};

export type SelectedTargetStorage = {
  target: TargetEvidence;
  namespaceId: string;
  storageKey: string;
};

export type SeedSelectedTargetInput = {
  target: TargetEvidence;
  namespaceId: string;
  storageKey: string;
  displayName: string;
  operationId: string;
  at: string;
};

function mapCatalogGenerationEvent(row: SqlRow): CatalogGenerationEvent {
  const target = row.target_generation_id === null
      && row.target_lineage_epoch === null && row.target_protection_revision === null
      && row.target_digest_schema === null && row.target_state_sha256 === null
    ? null
    : {
        appInstanceId: row.app_instance_id,
        activeGenerationId: row.target_generation_id,
        lineageEpoch: row.target_lineage_epoch,
        protectionRevision: row.target_protection_revision,
        digestSchema: row.target_digest_schema,
        stateSha256: row.target_state_sha256,
      };
  return CatalogGenerationEventV1.parse({
    schema: 1,
    catalogGeneration: row.catalog_generation,
    eventKind: row.event_kind,
    appInstanceId: row.app_instance_id,
    operationId: row.operation_id,
    writeEpoch: row.write_epoch,
    at: row.at,
    target,
  });
}

function readCatalogGenerationEvents(driver: DbDriver): CatalogGenerationEvent[] {
  return driver.select("SELECT * FROM catalog.catalog_generation_events")
    .map(mapCatalogGenerationEvent)
    .sort((left, right) => {
      const a = BigInt(left.catalogGeneration), b = BigInt(right.catalogGeneration);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

function insertCatalogGenerationEvent(driver: DbDriver, event: CatalogGenerationEvent): void {
  const parsed = CatalogGenerationEventV1.parse(event);
  driver.exec(
    `INSERT INTO catalog.catalog_generation_events(
      catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,
      target_generation_id,target_lineage_epoch,target_protection_revision,
      target_digest_schema,target_state_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [parsed.catalogGeneration, parsed.eventKind, parsed.appInstanceId,
      parsed.operationId, parsed.writeEpoch, parsed.at,
      parsed.target?.activeGenerationId ?? null, parsed.target?.lineageEpoch ?? null,
      parsed.target?.protectionRevision ?? null, parsed.target?.digestSchema ?? null,
      parsed.target?.stateSha256 ?? null],
  );
}

function mapRevisionReservation(row: SqlRow): CatalogRevisionReservation {
  return CatalogRevisionReservationV1.parse({
    schema: 1,
    authorityIncarnationId: row.authority_incarnation_id,
    reservedCatalogGeneration: row.reserved_catalog_generation,
    finalizedCatalogGeneration: row.finalized_catalog_generation,
    writeEpoch: row.write_epoch,
    leaseId: row.lease_id,
    releaseId: row.release_id,
    finalizedWriteEpoch: row.finalized_write_epoch,
    finalizedLeaseId: row.finalized_lease_id,
    finalizedReleaseId: row.finalized_release_id,
    appInstanceId: row.app_instance_id,
    activeGenerationId: row.active_generation_id,
    lineageEpoch: row.lineage_epoch,
    revision: row.revision,
    operationId: row.operation_id,
    expectedProtectionRevision: row.expected_protection_revision,
    expectedStateSha256: row.expected_state_sha256,
    requestSha256: row.request_sha256,
    state: row.state,
    publishedActiveGenerationId: row.published_active_generation_id,
    publishedLineageEpoch: row.published_lineage_epoch,
    stateSha256: row.state_sha256,
    reservedAt: row.reserved_at,
    finalizedAt: row.finalized_at,
  });
}

function readRevisionReservations(driver: DbDriver): CatalogRevisionReservation[] {
  return driver.select("SELECT * FROM catalog.revision_reservations")
    .map(mapRevisionReservation)
    .sort((left, right) => BigInt(left.revision) < BigInt(right.revision) ? -1 : 1);
}

function sameTarget(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

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
    journalGenesisGenerationId: String(row.journal_genesis_generation_id),
    journalGenesisLineageEpoch: String(row.journal_genesis_lineage_epoch),
    journalGenesisProtectionRevision: String(row.journal_genesis_protection_revision),
    journalGenesisStateSha256: String(row.journal_genesis_state_sha256),
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
    const referenced = new Set<string>();
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
      referenced.add(value);
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

    const generations = new Map<string, ImmutableAppGeneration>();
    const generationOperations = new Map<string, string>();
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
      generationOperations.set(descriptor.generationId, operationId);
    }
    for (const app of apps.values()) {
      const generation = generations.get(app.activeGenerationId);
      if (!generation
          || generation.target.appInstanceId !== app.appInstanceId
          || generation.target.lineageEpoch !== app.currentLineageEpoch
          || BigInt(generation.target.protectionRevision) > BigInt(app.currentProtectionRevision)
          || generation.target.digestSchema !== app.digestSchema
          || (generation.target.protectionRevision === app.currentProtectionRevision
            && generation.target.stateSha256 !== app.stateSha256))
        throw new Error("active generation does not match app entry");
    }

    const leases = new Map<string, {
      authorityIncarnationId: string;
      writeEpoch: string;
      releaseId: string;
      issuedAtMs: string;
      expiresAtMs: string;
      revoked: boolean;
    }>();
    let activeLeaseCount = 0;
    for (const row of driver.select("SELECT * FROM catalog.leases ORDER BY lease_id")) {
      const leaseId = LeaseId.parse(String(row.lease_id));
      const authority = AuthorityIncarnationId.parse(String(row.authority_incarnation_id));
      const leaseWriteEpoch = UInt64Decimal.parse(String(row.write_epoch));
      const releaseId = ReleaseId.parse(String(row.release_id));
      const issued = UInt64Decimal.parse(String(row.issued_at_ms));
      const expires = UInt64Decimal.parse(String(row.expires_at_ms));
      if (BigInt(expires) <= BigInt(issued)
          || BigInt(expires) > BigInt(Number.MAX_SAFE_INTEGER)
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
      leases.set(leaseId, {
        authorityIncarnationId: authority,
        writeEpoch: leaseWriteEpoch,
        releaseId,
        issuedAtMs: issued,
        expiresAtMs: expires,
        revoked: revoked === 1,
      });
    }
    if (activeLeaseCount > 1) throw new Error("multiple active write leases");

    const reservations = readRevisionReservations(driver);
    const catalogEvents = new Set<string>();
    let activeReservationCount = 0;
    for (const reservation of reservations) {
      requireRetained(reservation.operationId, "operation");
      requireRetained(reservation.leaseId, "lease");
      const lease = leases.get(reservation.leaseId);
      const app = apps.get(reservation.appInstanceId);
      const generation = generations.get(reservation.activeGenerationId);
      if (reservation.authorityIncarnationId !== snapshot.authorityIncarnationId
          || !lease
          || lease.authorityIncarnationId !== reservation.authorityIncarnationId
          || lease.writeEpoch !== reservation.writeEpoch
          || lease.releaseId !== reservation.releaseId
          || !app || !generation
          || generation.target.appInstanceId !== reservation.appInstanceId
          || generation.target.lineageEpoch !== reservation.lineageEpoch
          || BigInt(Date.parse(reservation.reservedAt)) < BigInt(lease.issuedAtMs)
          || BigInt(Date.parse(reservation.reservedAt)) >= BigInt(lease.expiresAtMs)
          || BigInt(reservation.reservedCatalogGeneration) > BigInt(snapshot.catalogGeneration)
          || (reservation.finalizedCatalogGeneration !== null
            && BigInt(reservation.finalizedCatalogGeneration) > BigInt(snapshot.catalogGeneration)))
        throw new Error("revision reservation relationship is invalid");
      if (reservation.finalizedAt !== null) {
        requireRetained(reservation.finalizedLeaseId!, "lease");
        const finalizedLease = leases.get(reservation.finalizedLeaseId!);
        const reservedAtMs = BigInt(Date.parse(reservation.reservedAt));
        const finalizedAtMs = BigInt(Date.parse(reservation.finalizedAt));
        const reservedEpoch = BigInt(reservation.writeEpoch);
        const finalizedEpoch = BigInt(reservation.finalizedWriteEpoch!);
        if (!finalizedLease
            || finalizedLease.authorityIncarnationId !== reservation.authorityIncarnationId
            || finalizedLease.writeEpoch !== reservation.finalizedWriteEpoch
            || finalizedLease.releaseId !== reservation.finalizedReleaseId
            || finalizedAtMs < reservedAtMs
            || finalizedAtMs < BigInt(finalizedLease.issuedAtMs)
            || finalizedAtMs >= BigInt(finalizedLease.expiresAtMs)
            || finalizedEpoch < reservedEpoch
            || (finalizedEpoch === reservedEpoch
              && (reservation.finalizedLeaseId !== reservation.leaseId
                || reservation.finalizedReleaseId !== reservation.releaseId))
            || (finalizedEpoch > reservedEpoch
              && (reservation.state !== "abandoned"
                || finalizedEpoch !== reservedEpoch + 1n
                || !lease.revoked
                || BigInt(finalizedLease.issuedAtMs) < BigInt(lease.expiresAtMs)
                || finalizedAtMs !== BigInt(finalizedLease.issuedAtMs))))
          throw new Error("revision finalization authority is invalid");
      }
      for (const generation of [
        reservation.reservedCatalogGeneration,
        reservation.finalizedCatalogGeneration,
      ]) {
        if (generation === null) continue;
        if (catalogEvents.has(generation)) throw new Error("catalog generation event is reused");
        catalogEvents.add(generation);
      }
      if (reservation.state === "reserved") {
        activeReservationCount++;
        const expected: TargetEvidence = {
          appInstanceId: app.appInstanceId,
          activeGenerationId: app.activeGenerationId,
          lineageEpoch: app.currentLineageEpoch,
          protectionRevision: app.currentProtectionRevision,
          digestSchema: app.digestSchema,
          stateSha256: app.stateSha256,
        };
        if (snapshot.selectedAppInstanceId !== app.appInstanceId
            || !sameTarget(expected, {
              appInstanceId: reservation.appInstanceId,
              activeGenerationId: reservation.activeGenerationId,
              lineageEpoch: reservation.lineageEpoch,
              protectionRevision: reservation.expectedProtectionRevision,
              digestSchema: app.digestSchema,
              stateSha256: reservation.expectedStateSha256,
            })
            || reservation.revision !== app.revisionHighWater
            || reservation.reservedCatalogGeneration !== snapshot.catalogGeneration)
          throw new Error("active revision reservation is not current");
      }
    }
    if (activeReservationCount > 1) throw new Error("multiple active revision reservations");
    for (const app of apps.values()) {
      const genesis = generations.get(app.journalGenesisGenerationId);
      if (!genesis
          || genesis.target.appInstanceId !== app.appInstanceId
          || genesis.target.lineageEpoch !== app.journalGenesisLineageEpoch
          || genesis.target.protectionRevision !== app.journalGenesisProtectionRevision
          || genesis.target.digestSchema !== app.digestSchema
          || genesis.target.stateSha256 !== app.journalGenesisStateSha256)
        throw new Error("app journal genesis is invalid");
      const anchor = genesis.target;
      const journal = reservations.filter(reservation => reservation.appInstanceId === app.appInstanceId);
      const expectedCount = BigInt(app.revisionHighWater) - BigInt(anchor.protectionRevision);
      if (expectedCount < 0n || BigInt(journal.length) !== expectedCount)
        throw new Error("revision reservation high-water is inconsistent");
      let chained = anchor;
      let previousCatalogEvent = -1n;
      for (let index = 0; index < journal.length; index++) {
        const reservation = journal[index]!;
        const reservedGeneration = BigInt(reservation.reservedCatalogGeneration);
        const finalizedGeneration = reservation.finalizedCatalogGeneration === null
          ? null : BigInt(reservation.finalizedCatalogGeneration);
        if (BigInt(reservation.revision) !== BigInt(anchor.protectionRevision) + BigInt(index + 1)
            || reservedGeneration <= previousCatalogEvent
            || (finalizedGeneration !== null && finalizedGeneration !== reservedGeneration + 1n)
            || reservation.activeGenerationId !== chained.activeGenerationId
            || reservation.lineageEpoch !== chained.lineageEpoch
            || reservation.expectedProtectionRevision !== chained.protectionRevision
            || reservation.expectedStateSha256 !== chained.stateSha256
            || (reservation.state === "reserved" && index !== journal.length - 1))
          throw new Error("revision reservation chain is invalid");
        previousCatalogEvent = finalizedGeneration ?? reservedGeneration;
        if (reservation.state === "committed") {
          const publishedGeneration = generations.get(reservation.publishedActiveGenerationId!);
          if (!publishedGeneration
              || reservation.publishedActiveGenerationId !== reservation.activeGenerationId
              || reservation.publishedLineageEpoch !== reservation.lineageEpoch
              || publishedGeneration.target.appInstanceId !== app.appInstanceId
              || publishedGeneration.target.lineageEpoch !== reservation.publishedLineageEpoch!
              || BigInt(publishedGeneration.target.protectionRevision) > BigInt(reservation.revision))
            throw new Error("committed revision generation is invalid");
          chained = {
            appInstanceId: app.appInstanceId,
            activeGenerationId: reservation.publishedActiveGenerationId!,
            lineageEpoch: reservation.publishedLineageEpoch!,
            protectionRevision: reservation.revision,
            digestSchema: app.digestSchema,
            stateSha256: reservation.stateSha256!,
          };
        }
      }
      const current: TargetEvidence = {
        appInstanceId: app.appInstanceId,
        activeGenerationId: app.activeGenerationId,
        lineageEpoch: app.currentLineageEpoch,
        protectionRevision: app.currentProtectionRevision,
        digestSchema: app.digestSchema,
        stateSha256: app.stateSha256,
      };
      if (!sameTarget(chained, current)) throw new Error("catalog head does not match reservation chain");
    }
    const generationEvents = readCatalogGenerationEvents(driver);
    if (BigInt(generationEvents.length) !== BigInt(snapshot.catalogGeneration))
      throw new Error("catalog generation event high-water is inconsistent");
    const eventByGeneration = new Map<string, CatalogGenerationEvent>();
    let previousEventEpoch = 0n;
    for (let index = 0; index < generationEvents.length; index++) {
      const event = generationEvents[index]!;
      if (BigInt(event.catalogGeneration) !== BigInt(index + 1)
          || BigInt(event.writeEpoch) < previousEventEpoch
          || BigInt(event.writeEpoch) > BigInt(snapshot.writeEpoch))
        throw new Error("catalog generation event chain is invalid");
      previousEventEpoch = BigInt(event.writeEpoch);
      eventByGeneration.set(event.catalogGeneration, event);
      if (event.appInstanceId !== null) requireRetained(event.appInstanceId, "app");
      if (event.operationId !== null) requireRetained(event.operationId, "operation");
      const reservation = event.operationId === null ? undefined
        : reservations.find(candidate => candidate.operationId === event.operationId);
      if (event.eventKind === "app_seed") {
        const app = apps.get(event.appInstanceId!);
        const genesis = app && generations.get(app.journalGenesisGenerationId);
        if (!app || !genesis
            || event.operationId !== generationOperations.get(genesis.generationId)
            || event.at !== genesis.sealedAt || event.target === null
            || !sameTarget(event.target, genesis.target))
          throw new Error("catalog app seed event is invalid");
      } else if (event.eventKind === "lease_issued") {
        const matches = [...leases.values()].filter(lease =>
          lease.writeEpoch === event.writeEpoch
          && new Date(Number(lease.issuedAtMs)).toISOString() === event.at);
        if (matches.length !== 1) throw new Error("catalog lease event is invalid");
      } else if (!reservation || reservation.appInstanceId !== event.appInstanceId) {
        throw new Error("catalog revision event is orphaned");
      } else if (event.eventKind === "revision_reserved") {
        if (reservation.reservedCatalogGeneration !== event.catalogGeneration
            || reservation.writeEpoch !== event.writeEpoch
            || reservation.reservedAt !== event.at)
          throw new Error("catalog reservation event is invalid");
      } else {
        const expectedState = event.eventKind === "revision_committed" ? "committed" : "abandoned";
        const reservedEpoch = BigInt(reservation.writeEpoch);
        const finalizedEpoch = BigInt(reservation.finalizedWriteEpoch!);
        const isTakeover = event.eventKind === "recovery_takeover";
        if (reservation.state !== expectedState
            || reservation.finalizedCatalogGeneration !== event.catalogGeneration
            || reservation.finalizedWriteEpoch !== event.writeEpoch
            || reservation.finalizedAt !== event.at
            || (isTakeover && finalizedEpoch !== reservedEpoch + 1n)
            || (!isTakeover && finalizedEpoch !== reservedEpoch))
          throw new Error("catalog finalization event is invalid");
      }
    }
    if ((generationEvents.at(-1)?.writeEpoch ?? "0") !== snapshot.writeEpoch)
      throw new Error("catalog event write epoch does not match root");
    for (const app of apps.values()) {
      const seeds = generationEvents.filter(event => event.eventKind === "app_seed"
        && event.appInstanceId === app.appInstanceId);
      if (seeds.length !== 1) throw new Error("catalog app seed event is missing");
    }
    for (const lease of leases.values()) {
      const issuedAt = new Date(Number(lease.issuedAtMs)).toISOString();
      const events = generationEvents.filter(event =>
        (event.eventKind === "lease_issued" || event.eventKind === "recovery_takeover")
        && event.writeEpoch === lease.writeEpoch && event.at === issuedAt);
      if (events.length !== 1) throw new Error("catalog lease issuance event is missing");
    }
    for (const reservation of reservations) {
      const reservedEvent = eventByGeneration.get(reservation.reservedCatalogGeneration);
      if (!reservedEvent || reservedEvent.eventKind !== "revision_reserved"
          || reservedEvent.operationId !== reservation.operationId)
        throw new Error("catalog reservation event is missing");
      if (reservation.finalizedCatalogGeneration !== null) {
        const finalizedEvent = eventByGeneration.get(reservation.finalizedCatalogGeneration);
        if (!finalizedEvent || finalizedEvent.operationId !== reservation.operationId
            || !["revision_committed", "revision_abandoned", "recovery_takeover"]
              .includes(finalizedEvent.eventKind))
          throw new Error("catalog finalization event is missing");
      }
    }
    for (const [value, kind] of retained) {
      if (kind !== "job" && !referenced.has(value))
        throw new Error(`unreferenced retained ${kind} identity`);
    }
    const unfinished = driver.select(
      `SELECT (SELECT count(*) FROM catalog.pending_jobs)
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

  selectedTargetStorage(): SelectedTargetStorage {
    return this.driver.tx(() => {
      const snapshot = readValidatedCatalog(this.driver);
      if (snapshot.selectedAppInstanceId === null)
        throw new ClayError("E_GENERATION_NOT_SELECTED", "catalog has no selected app generation");
      const entry = snapshot.entries.find(
        candidate => candidate.appInstanceId === snapshot.selectedAppInstanceId,
      );
      if (!entry || entry.tombstoned)
        throw new ClayError("E_GENERATION_NOT_SELECTED", "selected catalog app is unavailable");
      const rows = this.driver.select(
        `SELECT namespace_id, storage_key FROM catalog.generations
         WHERE generation_id = ? AND app_instance_id = ?`,
        [entry.activeGenerationId, entry.appInstanceId],
      );
      if (rows.length !== 1 || typeof rows[0]?.namespace_id !== "string"
          || typeof rows[0].storage_key !== "string")
        throw new ClayError("E_CATALOG_UNAVAILABLE", "selected catalog storage is unavailable");
      const namespaceId = NamespaceId.safeParse(rows[0].namespace_id);
      if (!namespaceId.success || !validStorageKey(rows[0].storage_key))
        throw new ClayError("E_CATALOG_UNAVAILABLE", "selected catalog storage is invalid");
      return {
        target: {
          appInstanceId: entry.appInstanceId,
          activeGenerationId: entry.activeGenerationId,
          lineageEpoch: entry.currentLineageEpoch,
          protectionRevision: entry.currentProtectionRevision,
          digestSchema: entry.digestSchema,
          stateSha256: entry.stateSha256,
        },
        namespaceId: namespaceId.data,
        storageKey: rows[0].storage_key,
      };
    });
  }

  revisionReservations(): CatalogRevisionReservation[] {
    readValidatedCatalog(this.driver);
    return readRevisionReservations(this.driver);
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

  seedSelectedTarget(input: SeedSelectedTargetInput): TargetEvidence {
    const target = TargetEvidenceV1.safeParse(input.target);
    const namespaceId = NamespaceId.safeParse(input.namespaceId);
    const operationId = OperationId.safeParse(input.operationId);
    if (!target.success || !namespaceId.success || !operationId.success
        || !validStorageKey(input.storageKey)
        || typeof input.displayName !== "string" || input.displayName.trim() !== input.displayName
        || input.displayName.length < 1 || input.displayName.length > 40
        || typeof input.at !== "string" || Number.isNaN(Date.parse(input.at))
        || new Date(input.at).toISOString() !== input.at
        || target.data.protectionRevision !== "0" || target.data.lineageEpoch !== "0")
      throw new ClayError("E_CATALOG_CONFLICT", "catalog app seed input is invalid");
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        if (before.catalogGeneration !== "0" || before.selectedAppInstanceId !== null
            || before.entries.length !== 0 || before.writeEpoch !== "0"
            || readRevisionReservations(this.driver).length !== 0)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog is not an empty authority");
        const retained = [
          [target.data.appInstanceId, "app"],
          [target.data.activeGenerationId, "generation"],
          [namespaceId.data, "namespace"],
          [operationId.data, "operation"],
        ] as const;
        for (const [value] of retained) {
          if (this.driver.select(
            "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [value],
          ).length !== 0)
            throw new ClayError("E_CATALOG_CONFLICT", "catalog seed identity was already retained");
        }
        for (const [value, kind] of retained) this.driver.exec(
          "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
          [value, kind, input.at],
        );
        this.driver.exec(
          `INSERT INTO catalog.generations(
             generation_id,app_instance_id,namespace_id,storage_key,operation_id,
             lineage_epoch,first_revision,digest_schema,state_sha256,
             source_archive_sha256,source_provenance_id,sealed_at,read_back_at
           ) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)`,
          [target.data.activeGenerationId, target.data.appInstanceId, namespaceId.data,
            input.storageKey, operationId.data, target.data.lineageEpoch,
            target.data.protectionRevision, target.data.digestSchema, target.data.stateSha256,
            input.at, input.at],
        );
        this.driver.exec(
          `INSERT INTO catalog.app_entries(
             app_instance_id,display_name,active_generation_id,
             journal_genesis_generation_id,journal_genesis_lineage_epoch,
             journal_genesis_protection_revision,journal_genesis_state_sha256,
             current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
             revision_high_water,digest_schema,state_sha256,tombstoned
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          [target.data.appInstanceId, input.displayName, target.data.activeGenerationId,
            target.data.activeGenerationId, target.data.lineageEpoch,
            target.data.protectionRevision, target.data.stateSha256,
            target.data.lineageEpoch, target.data.lineageEpoch,
            target.data.protectionRevision, target.data.protectionRevision,
            target.data.digestSchema, target.data.stateSha256],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: "1",
          eventKind: "app_seed",
          appInstanceId: target.data.appInstanceId,
          operationId: operationId.data,
          writeEpoch: "0",
          at: input.at,
          target: target.data,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root
           SET catalog_generation = '1', selected_app_instance_id = ?
           WHERE singleton = 1 AND catalog_generation = '0'
             AND selected_app_instance_id IS NULL AND write_epoch = '0'`,
          [target.data.appInstanceId],
        );
        const after = readValidatedCatalog(this.driver);
        const entry = after.entries[0];
        if (after.catalogGeneration !== "1"
            || after.selectedAppInstanceId !== target.data.appInstanceId
            || after.entries.length !== 1 || !entry
            || entry.activeGenerationId !== target.data.activeGenerationId
            || entry.stateSha256 !== target.data.stateSha256)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog app seed failed read-back");
        return target.data;
      });
    } catch (error) {
      if (error instanceof ClayError && ["E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE"]
        .includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog app seed failed");
    }
  }

  recoverExpiredSelectedReservation(
    input: RecoverExpiredSelectedReservationInput,
  ): CatalogReservationRecovery {
    const authority = AuthorityIncarnationId.safeParse(input.expectedAuthorityIncarnationId);
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const writeEpoch = UInt64Decimal.safeParse(input.expectedWriteEpoch);
    const operation = OperationId.safeParse(input.operationId);
    const releaseId = ReleaseId.safeParse(input.releaseId);
    if (!authority.success || !catalogGeneration.success || !writeEpoch.success
        || !operation.success || !releaseId.success
        || !validClockValue(input.nowMs) || !validClockValue(input.ttlMs)
        || input.ttlMs === 0 || input.ttlMs > Number(MAX_LEASE_DURATION_MS)
        || input.nowMs > Number.MAX_SAFE_INTEGER - input.ttlMs)
      throw new ClayError("E_STALE_WRITE_EPOCH", "reservation recovery request is invalid");
    let finalizedAt: string;
    try {
      finalizedAt = new Date(input.nowMs).toISOString();
    } catch {
      throw new ClayError("E_STALE_WRITE_EPOCH", "reservation recovery time is invalid");
    }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        if (before.authorityIncarnationId !== authority.data
            || before.writeEpoch !== writeEpoch.data)
          throw new ClayError("E_STALE_WRITE_EPOCH", "reservation recovery authority is stale");
        if (before.catalogGeneration !== catalogGeneration.data)
          throw new ClayError("E_CATALOG_CONFLICT", "reservation recovery catalog is stale");
        const reservation = readRevisionReservations(this.driver)
          .find(candidate => candidate.operationId === operation.data);
        if (!reservation || reservation.state !== "reserved"
            || reservation.authorityIncarnationId !== before.authorityIncarnationId
            || reservation.reservedCatalogGeneration !== before.catalogGeneration
            || reservation.writeEpoch !== before.writeEpoch)
          throw new ClayError("E_CATALOG_CONFLICT", "expired reservation is not current");
        const leaseRows = this.driver.select(
          "SELECT * FROM catalog.leases WHERE lease_id = ?", [reservation.leaseId],
        );
        if (leaseRows.length !== 1)
          throw new ClayError("E_STALE_WRITE_EPOCH", "expired reservation lease is unavailable");
        const oldLease = leaseRows[0]!;
        const oldExpiresAt = UInt64Decimal.safeParse(String(oldLease.expires_at_ms));
        if (!oldExpiresAt.success
            || String(oldLease.authority_incarnation_id) !== before.authorityIncarnationId
            || String(oldLease.write_epoch) !== before.writeEpoch
            || String(oldLease.release_id) !== reservation.releaseId
            || Number(oldLease.revoked) !== 0
            || BigInt(input.nowMs) < BigInt(oldExpiresAt.data))
          throw new ClayError("E_STALE_WRITE_EPOCH", "reservation owner has not expired");
        const entry = before.entries.find(candidate =>
          candidate.appInstanceId === before.selectedAppInstanceId);
        if (!entry || entry.appInstanceId !== reservation.appInstanceId
            || entry.activeGenerationId !== reservation.activeGenerationId
            || entry.currentLineageEpoch !== reservation.lineageEpoch
            || entry.currentProtectionRevision !== reservation.expectedProtectionRevision
            || entry.stateSha256 !== reservation.expectedStateSha256)
          throw new ClayError("E_GENERATION_NOT_SELECTED", "reserved target is not current");
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        const nextWriteEpoch = incrementCounter(before.writeEpoch, "E_STALE_WRITE_EPOCH");
        const leaseId = this.retainFreshId("lease", "lease", finalizedAt);
        const issuedAt = String(input.nowMs);
        const expiresAt = String(input.nowMs + input.ttlMs);
        this.driver.exec(
          "UPDATE catalog.leases SET revoked = 1 WHERE authority_incarnation_id = ? AND revoked = 0",
          [before.authorityIncarnationId],
        );
        this.driver.exec(
          `INSERT INTO catalog.leases(
             lease_id, authority_incarnation_id, write_epoch, release_id,
             issued_at_ms, expires_at_ms, revoked
           ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
          [leaseId, before.authorityIncarnationId, nextWriteEpoch,
            releaseId.data, issuedAt, expiresAt],
        );
        this.driver.exec(
          `UPDATE catalog.revision_reservations
           SET state = 'abandoned', finalized_catalog_generation = ?,
               finalized_write_epoch = ?, finalized_lease_id = ?, finalized_release_id = ?,
               finalized_at = ?
           WHERE app_instance_id = ? AND revision = ? AND operation_id = ?
             AND state = 'reserved' AND write_epoch = ? AND lease_id = ?`,
          [nextCatalogGeneration, nextWriteEpoch, leaseId, releaseId.data, finalizedAt,
            reservation.appInstanceId, reservation.revision, operation.data,
            reservation.writeEpoch, reservation.leaseId],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1, catalogGeneration: nextCatalogGeneration,
          eventKind: "recovery_takeover", appInstanceId: reservation.appInstanceId,
          operationId: operation.data, writeEpoch: nextWriteEpoch, at: finalizedAt,
          target: null,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root
           SET catalog_generation = ?, write_epoch = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND write_epoch = ?`,
          [nextCatalogGeneration, nextWriteEpoch, before.authorityIncarnationId,
            before.catalogGeneration, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const fence = WriteFenceV1.parse({
          authorityIncarnationId: after.authorityIncarnationId,
          writeEpoch: after.writeEpoch,
          leaseId,
          releaseId: releaseId.data,
        });
        const abandoned = readRevisionReservations(this.driver)
          .find(candidate => candidate.operationId === operation.data);
        if (!abandoned || abandoned.state !== "abandoned"
            || abandoned.finalizedCatalogGeneration !== nextCatalogGeneration
            || abandoned.finalizedWriteEpoch !== nextWriteEpoch
            || abandoned.finalizedLeaseId !== leaseId
            || after.catalogGeneration !== nextCatalogGeneration
            || after.writeEpoch !== nextWriteEpoch)
          throw new ClayError("E_CATALOG_CONFLICT", "reservation recovery failed read-back");
        return CatalogReservationRecoveryV1.parse({
          schema: 1,
          catalogGeneration: after.catalogGeneration,
          fence,
          abandonedReservation: abandoned,
        });
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "expired reservation recovery failed");
    }
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
        const issuedAtInstant = new Date(input.nowMs).toISOString();
        const leaseId = this.retainFreshId("lease", "lease", issuedAtInstant);
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
        insertCatalogGenerationEvent(this.driver, {
          schema: 1, catalogGeneration: nextCatalogGeneration,
          eventKind: "lease_issued", appInstanceId: before.selectedAppInstanceId,
          operationId: null, writeEpoch: nextWriteEpoch, at: issuedAtInstant,
          target: null,
        });
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

  reserveSelectedProtectionRevision(
    input: ReserveSelectedProtectionRevisionInput,
  ): CatalogRevisionReservation {
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const expected = TargetEvidenceV1.safeParse(input.expectedTarget);
    const operation = OperationId.safeParse(input.operationId);
    const requestSha256 = Sha256.safeParse(input.requestSha256);
    const requestedFence = WriteFenceV1.safeParse(input.fence);
    if (!catalogGeneration.success || !expected.success || !operation.success
        || !requestSha256.success || !requestedFence.success || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "catalog revision reservation input is invalid");
    let reservedAt: string;
    try {
      reservedAt = new Date(input.nowMs).toISOString();
    } catch {
      throw new ClayError("E_CATALOG_CONFLICT", "catalog revision reservation time is invalid");
    }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        const existing = readRevisionReservations(this.driver)
          .find(reservation => reservation.operationId === operation.data);
        if (existing) {
          let nextExpectedGeneration: string;
          try {
            nextExpectedGeneration = incrementCounter(catalogGeneration.data, "E_CATALOG_CONFLICT");
          } catch {
            throw new ClayError("E_CATALOG_CONFLICT", "reserved catalog generation is invalid");
          }
          if (existing.authorityIncarnationId !== requestedFence.data.authorityIncarnationId
              || existing.writeEpoch !== requestedFence.data.writeEpoch
              || existing.leaseId !== requestedFence.data.leaseId
              || existing.releaseId !== requestedFence.data.releaseId
              || existing.reservedCatalogGeneration !== nextExpectedGeneration
              || existing.appInstanceId !== expected.data.appInstanceId
              || existing.activeGenerationId !== expected.data.activeGenerationId
              || existing.lineageEpoch !== expected.data.lineageEpoch
              || existing.expectedProtectionRevision !== expected.data.protectionRevision
              || existing.expectedStateSha256 !== expected.data.stateSha256
              || existing.requestSha256 !== requestSha256.data)
            throw new ClayError("E_CATALOG_CONFLICT", "operation id is bound to another catalog request");
          return existing;
        }
        const fence = this.assertWriteFence(requestedFence.data, input.nowMs);
        if (before.catalogGeneration !== catalogGeneration.data)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog generation is stale");
        const entry = before.entries.find(candidate =>
          candidate.appInstanceId === before.selectedAppInstanceId);
        if (!entry) throw new ClayError("E_GENERATION_NOT_SELECTED", "selected app is unavailable");
        const current: TargetEvidence = {
          appInstanceId: entry.appInstanceId,
          activeGenerationId: entry.activeGenerationId,
          lineageEpoch: entry.currentLineageEpoch,
          protectionRevision: entry.currentProtectionRevision,
          digestSchema: entry.digestSchema,
          stateSha256: entry.stateSha256,
        };
        if (!sameTarget(current, expected.data))
          throw new ClayError("E_GENERATION_NOT_SELECTED", "reservation target is not current");
        if (readRevisionReservations(this.driver).some(reservation => reservation.state === "reserved"))
          throw new ClayError("E_CATALOG_CONFLICT", "another catalog revision is reserved");
        if (entry.revisionHighWater === String(UINT64_MAX))
          throw new ClayError("E_CATALOG_CONFLICT", "protection revision is exhausted");
        const revision = String(BigInt(entry.revisionHighWater) + 1n);
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        const retained = this.driver.select(
          "SELECT id_kind FROM catalog.id_registry WHERE id_value = ?",
          [operation.data],
        );
        if (retained.length !== 0)
          throw new ClayError("E_CATALOG_CONFLICT", "operation identity was already retained");
        this.driver.exec(
          "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'operation',?)",
          [operation.data, reservedAt],
        );
        this.driver.exec(
          `UPDATE catalog.app_entries SET revision_high_water = ?
           WHERE app_instance_id = ? AND active_generation_id = ?
             AND current_lineage_epoch = ? AND current_protection_revision = ?
             AND revision_high_water = ? AND digest_schema = ? AND state_sha256 = ?
             AND tombstoned = 0`,
          [revision, current.appInstanceId, current.activeGenerationId, current.lineageEpoch,
            current.protectionRevision, entry.revisionHighWater,
            current.digestSchema, current.stateSha256],
        );
        this.driver.exec(
          `INSERT INTO catalog.revision_reservations(
             app_instance_id,revision,operation_id,authority_incarnation_id,
             reserved_catalog_generation,finalized_catalog_generation,
             write_epoch,lease_id,release_id,active_generation_id,lineage_epoch,
             expected_protection_revision,expected_state_sha256,request_sha256,state,
             published_active_generation_id,published_lineage_epoch,state_sha256,
             reserved_at,finalized_at
           ) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,'reserved',NULL,NULL,NULL,?,NULL)`,
          [current.appInstanceId, revision, operation.data, before.authorityIncarnationId,
            nextCatalogGeneration, fence.writeEpoch, fence.leaseId, fence.releaseId,
            current.activeGenerationId, current.lineageEpoch, current.protectionRevision,
            current.stateSha256, requestSha256.data, reservedAt],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1, catalogGeneration: nextCatalogGeneration,
          eventKind: "revision_reserved", appInstanceId: current.appInstanceId,
          operationId: operation.data, writeEpoch: fence.writeEpoch, at: reservedAt,
          target: null,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root SET catalog_generation = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ?
             AND write_epoch = ?`,
          [nextCatalogGeneration, before.authorityIncarnationId,
            before.catalogGeneration, current.appInstanceId, fence.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const reservation = readRevisionReservations(this.driver)
          .find(candidate => candidate.operationId === operation.data);
        const afterEntry = after.entries.find(candidate => candidate.appInstanceId === current.appInstanceId);
        if (!reservation || reservation.state !== "reserved"
            || reservation.revision !== revision
            || after.catalogGeneration !== nextCatalogGeneration
            || !afterEntry || afterEntry.currentProtectionRevision !== current.protectionRevision
            || afterEntry.revisionHighWater !== revision)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog revision reservation failed read-back");
        return reservation;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog revision reservation failed");
    }
  }

  abandonSelectedProtectionRevision(
    input: AbandonSelectedProtectionRevisionInput,
  ): CatalogRevisionReservation {
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const expected = TargetEvidenceV1.safeParse(input.expectedTarget);
    const operation = OperationId.safeParse(input.operationId);
    const requestSha256 = Sha256.safeParse(input.requestSha256);
    if (!catalogGeneration.success || !expected.success || !operation.success
        || !requestSha256.success || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "catalog revision abandonment input is invalid");
    let finalizedAt: string;
    try {
      finalizedAt = new Date(input.nowMs).toISOString();
    } catch {
      throw new ClayError("E_CATALOG_CONFLICT", "catalog revision abandonment time is invalid");
    }
    try {
      return this.driver.tx(() => {
        const fence = this.assertWriteFence(input.fence, input.nowMs);
        const before = readValidatedCatalog(this.driver);
        const reservation = readRevisionReservations(this.driver)
          .find(candidate => candidate.operationId === operation.data);
        if (!reservation
            || reservation.authorityIncarnationId !== fence.authorityIncarnationId
            || reservation.writeEpoch !== fence.writeEpoch
            || reservation.leaseId !== fence.leaseId
            || reservation.releaseId !== fence.releaseId
            || reservation.reservedCatalogGeneration !== catalogGeneration.data
            || reservation.appInstanceId !== expected.data.appInstanceId
            || reservation.activeGenerationId !== expected.data.activeGenerationId
            || reservation.lineageEpoch !== expected.data.lineageEpoch
            || reservation.expectedProtectionRevision !== expected.data.protectionRevision
            || reservation.expectedStateSha256 !== expected.data.stateSha256
            || reservation.requestSha256 !== requestSha256.data)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog reservation does not match abandonment");
        const entry = before.entries.find(candidate =>
          candidate.appInstanceId === before.selectedAppInstanceId);
        if (!entry) throw new ClayError("E_GENERATION_NOT_SELECTED", "selected app is unavailable");
        const current: TargetEvidence = {
          appInstanceId: entry.appInstanceId,
          activeGenerationId: entry.activeGenerationId,
          lineageEpoch: entry.currentLineageEpoch,
          protectionRevision: entry.currentProtectionRevision,
          digestSchema: entry.digestSchema,
          stateSha256: entry.stateSha256,
        };
        if (reservation.state === "abandoned") {
          if (reservation.finalizedCatalogGeneration === null
              || before.catalogGeneration !== reservation.finalizedCatalogGeneration
              || !sameTarget(current, expected.data))
            throw new ClayError("E_CATALOG_CONFLICT", "abandoned catalog reservation is not current");
          return reservation;
        }
        if (reservation.state !== "reserved"
            || before.catalogGeneration !== catalogGeneration.data
            || !sameTarget(current, expected.data))
          throw new ClayError("E_CATALOG_CONFLICT", "catalog reservation cannot be abandoned");
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        this.driver.exec(
          `UPDATE catalog.revision_reservations
           SET state = 'abandoned', finalized_catalog_generation = ?,
               finalized_write_epoch = ?, finalized_lease_id = ?, finalized_release_id = ?,
               finalized_at = ?
           WHERE app_instance_id = ? AND revision = ? AND operation_id = ?
             AND request_sha256 = ? AND state = 'reserved'`,
          [nextCatalogGeneration, fence.writeEpoch, fence.leaseId, fence.releaseId,
            finalizedAt, reservation.appInstanceId,
            reservation.revision, operation.data, requestSha256.data],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1, catalogGeneration: nextCatalogGeneration,
          eventKind: "revision_abandoned", appInstanceId: reservation.appInstanceId,
          operationId: operation.data, writeEpoch: fence.writeEpoch, at: finalizedAt,
          target: null,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root SET catalog_generation = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ?
             AND write_epoch = ?`,
          [nextCatalogGeneration, before.authorityIncarnationId,
            before.catalogGeneration, current.appInstanceId, fence.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const abandoned = readRevisionReservations(this.driver)
          .find(candidate => candidate.operationId === operation.data);
        const afterEntry = after.entries.find(candidate => candidate.appInstanceId === current.appInstanceId);
        if (!abandoned || abandoned.state !== "abandoned"
            || abandoned.finalizedCatalogGeneration !== nextCatalogGeneration
            || abandoned.finalizedAt !== finalizedAt
            || after.catalogGeneration !== nextCatalogGeneration || !afterEntry
            || afterEntry.currentProtectionRevision !== current.protectionRevision
            || afterEntry.stateSha256 !== current.stateSha256
            || afterEntry.revisionHighWater !== reservation.revision)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog revision abandonment failed read-back");
        return abandoned;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog revision abandonment failed");
    }
  }

  publishSelectedTarget(input: PublishSelectedTargetInput): CatalogCasPublication {
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const expected = TargetEvidenceV1.safeParse(input.expectedTarget);
    const published = TargetEvidenceV1.safeParse(input.publishedTarget);
    const operation = OperationId.safeParse(input.operationId);
    const requestSha256 = Sha256.safeParse(input.requestSha256);
    const requestedFence = WriteFenceV1.safeParse(input.fence);
    if (!catalogGeneration.success || !expected.success || !published.success
        || !operation.success || !requestSha256.success || !requestedFence.success
        || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "catalog target publication input is invalid");
    let finalizedAt: string;
    try {
      finalizedAt = new Date(input.nowMs).toISOString();
    } catch {
      throw new ClayError("E_CATALOG_CONFLICT", "catalog target publication time is invalid");
    }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        const reservation = readRevisionReservations(this.driver)
          .find(candidate => candidate.operationId === operation.data);
        if (!reservation
            || reservation.authorityIncarnationId !== requestedFence.data.authorityIncarnationId
            || reservation.writeEpoch !== requestedFence.data.writeEpoch
            || reservation.leaseId !== requestedFence.data.leaseId
            || reservation.releaseId !== requestedFence.data.releaseId
            || reservation.reservedCatalogGeneration !== catalogGeneration.data
            || reservation.appInstanceId !== expected.data.appInstanceId
            || reservation.activeGenerationId !== expected.data.activeGenerationId
            || reservation.lineageEpoch !== expected.data.lineageEpoch
            || reservation.expectedProtectionRevision !== expected.data.protectionRevision
            || reservation.expectedStateSha256 !== expected.data.stateSha256
            || reservation.requestSha256 !== requestSha256.data
            || reservation.revision !== published.data.protectionRevision)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog reservation does not match publication");
        const entry = before.entries.find(candidate =>
          candidate.appInstanceId === before.selectedAppInstanceId);
        if (!entry) throw new ClayError("E_GENERATION_NOT_SELECTED", "selected app is unavailable");
        const current: TargetEvidence = {
          appInstanceId: entry.appInstanceId,
          activeGenerationId: entry.activeGenerationId,
          lineageEpoch: entry.currentLineageEpoch,
          protectionRevision: entry.currentProtectionRevision,
          digestSchema: entry.digestSchema,
          stateSha256: entry.stateSha256,
        };
        const publication = (generation: string): CatalogCasPublication =>
          CatalogCasPublicationV1.parse({
            schema: 1,
            authorityIncarnationId: before.authorityIncarnationId,
            catalogGeneration: generation,
            selectedAppInstanceId: before.selectedAppInstanceId,
            publishedTarget: published.data,
          });
        if (reservation.state === "committed") {
          if (reservation.finalizedCatalogGeneration === null
              || reservation.publishedActiveGenerationId !== published.data.activeGenerationId
              || reservation.publishedLineageEpoch !== published.data.lineageEpoch
              || reservation.stateSha256 !== published.data.stateSha256
              || !sameTarget(current, published.data))
            throw new ClayError("E_CATALOG_CONFLICT", "committed catalog publication is not current");
          return publication(reservation.finalizedCatalogGeneration);
        }
        const fence = this.assertWriteFence(requestedFence.data, input.nowMs);
        if (reservation.state !== "reserved"
            || before.catalogGeneration !== catalogGeneration.data
            || !sameTarget(current, expected.data))
          throw new ClayError("E_GENERATION_NOT_SELECTED", "expected catalog target is not current");
        if (published.data.appInstanceId !== current.appInstanceId
            || published.data.activeGenerationId !== current.activeGenerationId
            || published.data.lineageEpoch !== current.lineageEpoch
            || published.data.digestSchema !== current.digestSchema
            || published.data.protectionRevision !== reservation.revision
            || published.data.stateSha256 === current.stateSha256
            || entry.revisionHighWater !== reservation.revision)
          throw new ClayError("E_CATALOG_CONFLICT", "published target does not match reserved state");
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        this.driver.exec(
          `UPDATE catalog.app_entries
           SET current_protection_revision = ?, state_sha256 = ?
           WHERE app_instance_id = ? AND active_generation_id = ?
             AND current_lineage_epoch = ? AND current_protection_revision = ?
             AND revision_high_water = ? AND digest_schema = ? AND state_sha256 = ?
             AND tombstoned = 0`,
          [published.data.protectionRevision, published.data.stateSha256,
            current.appInstanceId, current.activeGenerationId, current.lineageEpoch,
            current.protectionRevision, reservation.revision,
            current.digestSchema, current.stateSha256],
        );
        this.driver.exec(
          `UPDATE catalog.revision_reservations
           SET state = 'committed', finalized_catalog_generation = ?,
               finalized_write_epoch = ?, finalized_lease_id = ?, finalized_release_id = ?,
               published_active_generation_id = ?, published_lineage_epoch = ?,
             state_sha256 = ?, finalized_at = ?
           WHERE app_instance_id = ? AND revision = ? AND operation_id = ?
             AND request_sha256 = ? AND state = 'reserved'`,
          [nextCatalogGeneration, fence.writeEpoch, fence.leaseId, fence.releaseId,
            published.data.activeGenerationId,
            published.data.lineageEpoch, published.data.stateSha256, finalizedAt,
            current.appInstanceId, reservation.revision, operation.data, requestSha256.data],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1, catalogGeneration: nextCatalogGeneration,
          eventKind: "revision_committed", appInstanceId: current.appInstanceId,
          operationId: operation.data, writeEpoch: fence.writeEpoch, at: finalizedAt,
          target: null,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root SET catalog_generation = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ?
             AND write_epoch = ?`,
          [nextCatalogGeneration, before.authorityIncarnationId,
            before.catalogGeneration, current.appInstanceId, fence.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const afterEntry = after.entries.find(candidate => candidate.appInstanceId === current.appInstanceId);
        const committed = readRevisionReservations(this.driver)
          .find(candidate => candidate.operationId === operation.data);
        if (after.catalogGeneration !== nextCatalogGeneration || !afterEntry || !committed
            || committed.state !== "committed"
            || committed.finalizedCatalogGeneration !== nextCatalogGeneration
            || committed.stateSha256 !== published.data.stateSha256
            || afterEntry.currentProtectionRevision !== published.data.protectionRevision
            || afterEntry.stateSha256 !== published.data.stateSha256)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog target CAS failed read-back");
        return CatalogCasPublicationV1.parse({
          schema: 1,
          authorityIncarnationId: after.authorityIncarnationId,
          catalogGeneration: after.catalogGeneration,
          selectedAppInstanceId: after.selectedAppInstanceId,
          publishedTarget: published.data,
        });
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog target publication failed");
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
