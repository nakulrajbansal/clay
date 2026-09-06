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
  PendingTargetLifecycleJobV1,
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
  PendingTargetLifecycleJobV1 as PendingTargetLifecycleJob,
  TargetEvidenceV1 as TargetEvidence,
  WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import type { DbDriver, SqlRow } from "./db";
import {
  physicalNamespaceEntry,
  type DurableNamespaceInventoryEntry,
} from "./durable-inventory";
import { ClayError } from "./errors";

const EXPECTED_TABLES = [
  "app_entries",
  "catalog_generation_events",
  "catalog_root",
  "generations",
  "id_registry",
  "leases",
  "legacy_bootstrap_manifest",
  "lineage_reservations",
  "pending_jobs",
  "production_request_receipts",
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
      'revision_abandoned','recovery_takeover','app_selected','app_metadata',
      'app_create_declared','app_fork_declared','app_reset_declared',
      'app_deleted','lifecycle_cleaned'
    )),
    app_instance_id TEXT,
    operation_id TEXT,
    write_epoch TEXT NOT NULL,
    at TEXT NOT NULL,
    display_name TEXT,
    shell_id TEXT,
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
      (event_kind IN ('app_seed','app_selected') AND target_generation_id IS NOT NULL
        AND target_lineage_epoch IS NOT NULL AND target_protection_revision IS NOT NULL
        AND target_digest_schema = 1 AND target_state_sha256 IS NOT NULL)
      OR (event_kind NOT IN ('app_seed','app_selected') AND target_generation_id IS NULL
        AND target_lineage_epoch IS NULL AND target_protection_revision IS NULL
        AND target_digest_schema IS NULL AND target_state_sha256 IS NULL)
    ),
    CHECK(
      (event_kind IN ('app_seed','app_metadata','revision_committed')
        AND display_name IS NOT NULL AND shell_id IS NOT NULL)
      OR (event_kind NOT IN ('app_seed','app_metadata') AND display_name IS NULL AND shell_id IS NULL)
    )
  )`,
  `CREATE TABLE catalog.app_entries(
    app_instance_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    shell_id TEXT NOT NULL,
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
  `CREATE TABLE catalog.legacy_bootstrap_manifest(
    storage_key TEXT PRIMARY KEY,
    user_file TEXT NOT NULL,
    system_file TEXT NOT NULL,
    storage_kind TEXT NOT NULL CHECK(storage_kind IN ('legacy','generation')),
    app_instance_id TEXT NOT NULL UNIQUE,
    generation_id TEXT NOT NULL UNIQUE,
    namespace_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    shell_id TEXT NOT NULL,
    selected INTEGER NOT NULL CHECK(selected IN (0,1)),
    declared_at TEXT NOT NULL
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
  `CREATE TABLE catalog.production_request_receipts(
    request_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    app_instance_id TEXT NOT NULL,
    active_generation_id TEXT NOT NULL,
    lineage_epoch TEXT NOT NULL,
    expected_protection_revision TEXT NOT NULL,
    expected_state_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','invoked','committed','no_op','failed')),
    resulting_protection_revision TEXT,
    resulting_state_sha256 TEXT,
    response_sha256 TEXT,
    prepared_at TEXT NOT NULL,
    invoked_at TEXT,
    completed_at TEXT,
    CHECK(
      (state = 'prepared' AND invoked_at IS NULL AND completed_at IS NULL
        AND resulting_protection_revision IS NULL AND resulting_state_sha256 IS NULL
        AND response_sha256 IS NULL)
      OR (state = 'invoked' AND invoked_at IS NOT NULL AND completed_at IS NULL
        AND resulting_protection_revision IS NULL AND resulting_state_sha256 IS NULL
        AND response_sha256 IS NULL)
      OR (state = 'no_op' AND invoked_at IS NULL AND completed_at IS NOT NULL
        AND resulting_protection_revision = expected_protection_revision
        AND resulting_state_sha256 = expected_state_sha256 AND response_sha256 IS NOT NULL)
      OR (state = 'committed' AND invoked_at IS NOT NULL AND completed_at IS NOT NULL
        AND resulting_protection_revision IS NOT NULL
        AND resulting_state_sha256 <> expected_state_sha256 AND response_sha256 IS NOT NULL)
      OR (state = 'failed' AND completed_at IS NOT NULL
        AND resulting_protection_revision = expected_protection_revision
        AND resulting_state_sha256 = expected_state_sha256 AND response_sha256 IS NOT NULL)
    )
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
  app_entries: "app_instance_id:TEXT:0:1|display_name:TEXT:1:0|shell_id:TEXT:1:0|active_generation_id:TEXT:1:0|journal_genesis_generation_id:TEXT:1:0|journal_genesis_lineage_epoch:TEXT:1:0|journal_genesis_protection_revision:TEXT:1:0|journal_genesis_state_sha256:TEXT:1:0|current_lineage_epoch:TEXT:1:0|lineage_epoch_high_water:TEXT:1:0|current_protection_revision:TEXT:1:0|revision_high_water:TEXT:1:0|digest_schema:INTEGER:1:0|state_sha256:TEXT:1:0|tombstoned:INTEGER:1:0",
  catalog_generation_events: "catalog_generation:TEXT:0:1|event_kind:TEXT:1:0|app_instance_id:TEXT:0:0|operation_id:TEXT:0:0|write_epoch:TEXT:1:0|at:TEXT:1:0|display_name:TEXT:0:0|shell_id:TEXT:0:0|target_generation_id:TEXT:0:0|target_lineage_epoch:TEXT:0:0|target_protection_revision:TEXT:0:0|target_digest_schema:INTEGER:0:0|target_state_sha256:TEXT:0:0",
  catalog_root: "singleton:INTEGER:0:1|schema_version:INTEGER:1:0|authority_incarnation_id:TEXT:1:0|catalog_generation:TEXT:1:0|selected_app_instance_id:TEXT:0:0|write_epoch:TEXT:1:0",
  generations: "generation_id:TEXT:0:1|app_instance_id:TEXT:1:0|namespace_id:TEXT:1:0|storage_key:TEXT:1:0|operation_id:TEXT:1:0|lineage_epoch:TEXT:1:0|first_revision:TEXT:1:0|digest_schema:INTEGER:1:0|state_sha256:TEXT:1:0|source_archive_sha256:TEXT:0:0|source_provenance_id:TEXT:0:0|sealed_at:TEXT:1:0|read_back_at:TEXT:1:0",
  id_registry: "id_value:TEXT:0:1|id_kind:TEXT:1:0|retained_at:TEXT:1:0",
  leases: "lease_id:TEXT:0:1|authority_incarnation_id:TEXT:1:0|write_epoch:TEXT:1:0|release_id:TEXT:1:0|issued_at_ms:TEXT:1:0|expires_at_ms:TEXT:1:0|revoked:INTEGER:1:0",
  legacy_bootstrap_manifest: "storage_key:TEXT:0:1|user_file:TEXT:1:0|system_file:TEXT:1:0|storage_kind:TEXT:1:0|app_instance_id:TEXT:1:0|generation_id:TEXT:1:0|namespace_id:TEXT:1:0|operation_id:TEXT:1:0|display_name:TEXT:1:0|shell_id:TEXT:1:0|selected:INTEGER:1:0|declared_at:TEXT:1:0",
  lineage_reservations: "app_instance_id:TEXT:1:1|lineage_epoch:TEXT:1:2|operation_id:TEXT:1:0|state:TEXT:1:0",
  pending_jobs: "job_id:TEXT:0:1|authority_incarnation_id:TEXT:1:0|app_instance_id:TEXT:0:0|kind:TEXT:1:0|state:TEXT:1:0|operation_id:TEXT:1:0|created_at:TEXT:1:0|updated_at:TEXT:1:0",
  production_request_receipts: "request_id:TEXT:0:1|operation_id:TEXT:1:0|request_sha256:TEXT:1:0|app_instance_id:TEXT:1:0|active_generation_id:TEXT:1:0|lineage_epoch:TEXT:1:0|expected_protection_revision:TEXT:1:0|expected_state_sha256:TEXT:1:0|state:TEXT:1:0|resulting_protection_revision:TEXT:0:0|resulting_state_sha256:TEXT:0:0|response_sha256:TEXT:0:0|prepared_at:TEXT:1:0|invoked_at:TEXT:0:0|completed_at:TEXT:0:0",
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
  metadata?: { displayName: string; shellId: string };
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
  shellId: string;
  operationId: string;
  at: string;
};

export type LegacyBootstrapEntry = DurableNamespaceInventoryEntry & {
  appInstanceId: string;
  generationId: string;
  namespaceId: string;
  operationId: string;
  displayName: string;
  shellId: string;
  selected: boolean;
};

export type AddAppTargetInput = {
  expectedCatalogGeneration: string;
  target: TargetEvidence;
  namespaceId: string;
  storageKey: string;
  displayName: string;
  shellId: string;
  operationId: string;
  fence: WriteFence;
  nowMs: number;
  select: boolean;
  bootstrapStorageKey?: string;
};

export type DeclareAppGenerationInput = {
  kind: "create" | "fork" | "reset";
  expectedCatalogGeneration: string;
  expectedTarget: TargetEvidence;
  target: PendingTargetLifecycleJob["target"];
  jobId: string;
  operationId: string;
  requestSha256: string;
  fence: WriteFence;
  nowMs: number;
};

export type PublishDeclaredAppGenerationInput = {
  expectedCatalogGeneration: string;
  jobId: string;
  publishedTarget: TargetEvidence;
  replacementCleanup?: {
    jobId: string;
    operationId: string;
    requestSha256: string;
  };
  fence: WriteFence;
  nowMs: number;
};

export type DeleteSelectedAppInput = {
  expectedCatalogGeneration: string;
  expectedTarget: TargetEvidence;
  jobId: string;
  operationId: string;
  requestSha256: string;
  fence: WriteFence;
  nowMs: number;
};

export type CompleteLifecycleCleanupInput = {
  expectedCatalogGeneration: string;
  jobId: string;
  cleanupConfirmed: true;
  fence: WriteFence;
  nowMs: number;
};

export type UpdateSelectedAppMetadataInput = {
  expectedCatalogGeneration: string;
  displayName: string;
  shellId: string;
  operationId: string;
  fence: WriteFence;
  nowMs: number;
};

export type SelectAppInput = {
  expectedCatalogGeneration: string;
  appInstanceId: string;
  operationId: string;
  fence: WriteFence;
  nowMs: number;
};

type CatalogGenerationEventInput = Omit<CatalogGenerationEvent, "displayName" | "shellId"> & {
  displayName?: string | null;
  shellId?: string | null;
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
    displayName: row.display_name,
    shellId: row.shell_id,
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

function insertCatalogGenerationEvent(driver: DbDriver, event: CatalogGenerationEventInput): void {
  const parsed = CatalogGenerationEventV1.parse({ displayName: null, shellId: null, ...event });
  driver.exec(
    `INSERT INTO catalog.catalog_generation_events(
      catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,display_name,shell_id,
      target_generation_id,target_lineage_epoch,target_protection_revision,
      target_digest_schema,target_state_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [parsed.catalogGeneration, parsed.eventKind, parsed.appInstanceId,
      parsed.operationId, parsed.writeEpoch, parsed.at, parsed.displayName, parsed.shellId,
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

function readPendingLifecycleJobs(driver: DbDriver): PendingTargetLifecycleJob[] {
  try {
    return driver.select("SELECT * FROM catalog.pending_jobs ORDER BY job_id").map(row => {
      if (typeof row.state !== "string") throw new Error("lifecycle job payload is missing");
      const raw = JSON.parse(row.state) as unknown;
      const job = PendingTargetLifecycleJobV1.parse(raw);
      if (JSON.stringify(job) !== row.state
          || row.job_id !== job.jobId
          || row.authority_incarnation_id !== job.authorityIncarnationId
          || row.app_instance_id !== job.target.appInstanceId
          || row.kind !== job.kind
          || row.operation_id !== job.operationId
          || row.created_at !== job.createdAt
          || row.updated_at !== job.createdAt)
        throw new Error("lifecycle job columns do not match their payload");
      return job;
    });
  } catch {
    throw new ClayError("E_CATALOG_UNAVAILABLE", "pending lifecycle jobs failed validation");
  }
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
    shellId: String(row.shell_id),
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
    const tombstonedApps = new Set<string>();
    for (const row of appRows) {
      const tombstoned = Number(row.tombstoned);
      if (tombstoned !== 0 && tombstoned !== 1) throw new Error("invalid app tombstone");
      const app = AppCatalogEntryV1.parse({ ...mapLiveEntry({ ...row, tombstoned: 0 }) });
      requireRetained(app.appInstanceId, "app");
      apps.set(app.appInstanceId, app);
      if (tombstoned === 1) tombstonedApps.add(app.appInstanceId);
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

    const lifecycleJobs = readPendingLifecycleJobs(driver);
    if (lifecycleJobs.length > 1)
      throw new Error("multiple pending lifecycle targets are unsupported");
    for (const job of lifecycleJobs) {
      if (job.authorityIncarnationId !== snapshot.authorityIncarnationId
          || BigInt(job.declaredCatalogGeneration) > BigInt(snapshot.catalogGeneration))
        throw new Error("pending lifecycle authority is stale");
      const expectedApp = apps.get(job.expectedTarget.appInstanceId);
      if (!expectedApp || snapshot.selectedAppInstanceId !== expectedApp.appInstanceId
          || !sameTarget(job.expectedTarget, {
            appInstanceId: expectedApp.appInstanceId,
            activeGenerationId: expectedApp.activeGenerationId,
            lineageEpoch: expectedApp.currentLineageEpoch,
            protectionRevision: expectedApp.currentProtectionRevision,
            digestSchema: expectedApp.digestSchema,
            stateSha256: expectedApp.stateSha256,
          }))
        throw new Error("pending lifecycle source target is no longer current");
      requireRetained(job.jobId, "job");
      requireRetained(job.operationId, "operation");
      requireRetained(job.target.appInstanceId, "app");
      requireRetained(job.target.generationId, "generation");
      requireRetained(job.target.namespaceId, "namespace");
      const manifests = driver.select(
        "SELECT * FROM catalog.legacy_bootstrap_manifest WHERE operation_id = ?",
        [job.operationId],
      );
      if (job.kind === "cleanup") {
        const retired = generations.get(job.target.generationId);
        if (manifests.length !== 0 || !retired
            || retired.target.appInstanceId !== job.target.appInstanceId
            || retired.namespaceId !== job.target.namespaceId
            || driver.select(
              "SELECT storage_key FROM catalog.generations WHERE generation_id = ? AND storage_key = ?",
              [job.target.generationId, job.target.storageKey],
            ).length !== 1
            || !tombstonedApps.has(job.target.appInstanceId))
          throw new Error("pending lifecycle cleanup does not name a retired target");
      } else {
        const manifest = manifests[0];
        if (manifests.length !== 1 || !manifest
            || manifest.storage_key !== job.target.storageKey
            || manifest.user_file !== job.target.userFile
            || manifest.system_file !== job.target.systemFile
            || manifest.storage_kind !== job.target.storageKind
            || manifest.app_instance_id !== job.target.appInstanceId
            || manifest.generation_id !== job.target.generationId
            || manifest.namespace_id !== job.target.namespaceId
            || manifest.display_name !== job.target.displayName
            || manifest.shell_id !== job.target.shellId
            || Number(manifest.selected) !== 1
            || manifest.declared_at !== job.createdAt)
          throw new Error("pending lifecycle physical declaration is incomplete");
      }
    }
    const pendingTargetCount = lifecycleJobs.filter(job => job.kind !== "cleanup").length;
    const generationManifestCount = driver.select(
      "SELECT count(*) AS count FROM catalog.legacy_bootstrap_manifest WHERE storage_kind = 'generation'",
    );
    if (generationManifestCount.length !== 1
        || Number(generationManifestCount[0]!.count) !== pendingTargetCount)
      throw new Error("pending lifecycle manifest is orphaned");

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
      } else if (event.eventKind === "app_selected") {
        const selectedTarget = event.target;
        const generation = selectedTarget
          ? generations.get(selectedTarget.activeGenerationId) : undefined;
        const matchesGenesis = generation !== undefined && selectedTarget !== null
          && sameTarget(selectedTarget, generation.target);
        const matchesCommit = selectedTarget !== null && reservations.some(item =>
          item.state === "committed"
          && item.appInstanceId === selectedTarget.appInstanceId
          && item.publishedActiveGenerationId === selectedTarget.activeGenerationId
          && item.publishedLineageEpoch === selectedTarget.lineageEpoch
          && item.revision === selectedTarget.protectionRevision
          && item.stateSha256 === selectedTarget.stateSha256);
        if (!matchesGenesis && !matchesCommit)
          throw new Error("catalog app selection event is invalid");
      } else if (event.eventKind === "app_metadata") {
        if (!apps.has(event.appInstanceId!))
          throw new Error("catalog metadata event references an unknown app");
      } else if (event.eventKind === "app_create_declared"
          || event.eventKind === "app_fork_declared"
          || event.eventKind === "app_reset_declared") {
        const pending = lifecycleJobs.find(job => job.operationId === event.operationId);
        const publishedGeneration = [...generations.values()].find(generation =>
          generation.target.appInstanceId === event.appInstanceId
          && generationOperations.get(generation.generationId) === event.operationId,
        );
        const publishedEventKind = !publishedGeneration ? null
          : publishedGeneration.sourceProvenanceId === null ? "app_create_declared"
            : generationEvents.some(candidate => candidate.eventKind === "app_deleted"
              && candidate.operationId === event.operationId)
              ? "app_reset_declared" : "app_fork_declared";
        const pendingEventKind = pending ? `app_${pending.kind}_declared` : null;
        if ((!pending || pending.target.appInstanceId !== event.appInstanceId
              || pending.declaredCatalogGeneration !== event.catalogGeneration
              || pendingEventKind !== event.eventKind)
            && (!publishedGeneration || publishedEventKind !== event.eventKind))
          throw new Error("catalog app creation declaration is orphaned");
      } else if (event.eventKind === "app_deleted"
          || event.eventKind === "lifecycle_cleaned") {
        if (!tombstonedApps.has(event.appInstanceId!))
          throw new Error("catalog deletion event does not reference a tombstone");
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
      const deletionEvents = generationEvents.filter(event =>
        event.eventKind === "app_deleted" && event.appInstanceId === app.appInstanceId);
      const cleanupEvents = generationEvents.filter(event =>
        event.eventKind === "lifecycle_cleaned" && event.appInstanceId === app.appInstanceId);
      const pendingCleanup = lifecycleJobs.filter(job =>
        job.kind === "cleanup" && job.target.appInstanceId === app.appInstanceId);
      if (!tombstonedApps.has(app.appInstanceId)) {
        if (deletionEvents.length !== 0 || cleanupEvents.length !== 0
            || pendingCleanup.length !== 0)
          throw new Error("live app has retirement evidence");
        continue;
      }
      if (deletionEvents.length !== 1
          || pendingCleanup.length + cleanupEvents.length !== 1)
        throw new Error("tombstoned app retirement evidence is incomplete");
      const deletedAtGeneration = BigInt(deletionEvents[0]!.catalogGeneration);
      if (pendingCleanup.length === 1) {
        if (cleanupEvents.length !== 0
            || BigInt(pendingCleanup[0]!.declaredCatalogGeneration)
              !== deletedAtGeneration + 1n)
          throw new Error("pending cleanup is not contiguous with app deletion");
      } else if (BigInt(cleanupEvents[0]!.catalogGeneration) <= deletedAtGeneration) {
        throw new Error("lifecycle cleanup does not follow app deletion");
      }
    }
    const latestSelection = generationEvents.filter(event =>
      event.eventKind === "app_seed" || event.eventKind === "app_selected").at(-1);
    if ((latestSelection?.appInstanceId ?? null) !== snapshot.selectedAppInstanceId)
      throw new Error("catalog selected app does not match its latest event");

    for (const app of apps.values()) {
      const latestMetadata = [...generationEvents].reverse().find(event =>
        event.appInstanceId === app.appInstanceId && event.displayName !== null);
      if (!latestMetadata || latestMetadata.displayName !== app.displayName
          || latestMetadata.shellId !== app.shellId)
        throw new Error("catalog app metadata does not match its latest event");
    }
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
      "SELECT count(*) AS count FROM catalog.lineage_reservations",
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

  static isAbsent(driver: DbDriver): boolean {
    return catalogTables(driver).length === 0;
  }

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

  activeTargetStorageInventory(): SelectedTargetStorage[] {
    return this.driver.tx(() => {
      const snapshot = readValidatedCatalog(this.driver);
      const entries = new Map(snapshot.entries
        .map(entry => [entry.appInstanceId, entry] as const));
      const rows = this.driver.select(
        `SELECT a.app_instance_id, a.active_generation_id, g.namespace_id, g.storage_key
         FROM catalog.app_entries AS a
         JOIN catalog.generations AS g
           ON g.app_instance_id = a.app_instance_id
          AND g.generation_id = a.active_generation_id
         WHERE a.tombstoned = 0
         ORDER BY a.app_instance_id`,
      );
      if (rows.length !== snapshot.entries.length)
        throw new ClayError("E_CATALOG_UNAVAILABLE", "active catalog storage inventory is incomplete");
      const storageKeys = new Set<string>();
      return rows.map(row => {
        const appInstanceId = AppInstanceId.safeParse(row.app_instance_id);
        const generationId = GenerationId.safeParse(row.active_generation_id);
        const namespaceId = NamespaceId.safeParse(row.namespace_id);
        const storageKey = typeof row.storage_key === "string" ? row.storage_key : "";
        const entry = appInstanceId.success ? entries.get(appInstanceId.data) : undefined;
        if (!appInstanceId.success || !generationId.success || !namespaceId.success
            || !entry || entry.activeGenerationId !== generationId.data
            || !validStorageKey(storageKey) || storageKeys.has(storageKey))
          throw new ClayError("E_CATALOG_UNAVAILABLE", "active catalog storage inventory is invalid");
        storageKeys.add(storageKey);
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
          storageKey,
        };
      });
    });
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

  generationDescriptors(): ImmutableAppGeneration[] {
    readValidatedCatalog(this.driver);
    return this.driver.select("SELECT * FROM catalog.generations ORDER BY generation_id")
      .map(row => ImmutableAppGenerationV1.parse({
        schema: 1,
        generationId: row.generation_id,
        namespaceId: row.namespace_id,
        target: {
          appInstanceId: row.app_instance_id,
          activeGenerationId: row.generation_id,
          lineageEpoch: row.lineage_epoch,
          protectionRevision: row.first_revision,
          digestSchema: row.digest_schema,
          stateSha256: row.state_sha256,
        },
        sourceArchiveSha256: row.source_archive_sha256,
        sourceProvenanceId: row.source_provenance_id,
        sealedAt: row.sealed_at,
        readBackAt: row.read_back_at,
      }));
  }

  pendingLifecycleJobs(): PendingTargetLifecycleJob[] {
    readValidatedCatalog(this.driver);
    return readPendingLifecycleJobs(this.driver).map(job => ({
      ...job,
      expectedTarget: { ...job.expectedTarget },
      target: { ...job.target },
    }));
  }

  declareAppGeneration(input: DeclareAppGenerationInput): PendingTargetLifecycleJob {
    const expectedCatalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const expectedTarget = TargetEvidenceV1.safeParse(input.expectedTarget);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!expectedCatalogGeneration.success || !expectedTarget.success || !fence.success
        || !["create", "fork", "reset"].includes(input.kind) || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration is invalid");
    let createdAt: string;
    try { createdAt = new Date(input.nowMs).toISOString(); }
    catch { throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration time is invalid"); }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        const replay = readPendingLifecycleJobs(this.driver)
          .find(job => job.operationId === input.operationId);
        if (replay) {
          const requested = PendingTargetLifecycleJobV1.safeParse({
            schema: 1,
            kind: input.kind,
            jobId: input.jobId,
            authorityIncarnationId: before.authorityIncarnationId,
            operationId: input.operationId,
            requestSha256: input.requestSha256,
            declaredCatalogGeneration: replay.declaredCatalogGeneration,
            expectedTarget: expectedTarget.data,
            target: input.target,
            createdAt: replay.createdAt,
          });
          if (!requested.success || JSON.stringify(requested.data) !== JSON.stringify(replay))
            throw new ClayError("E_CATALOG_CONFLICT", "lifecycle operation identity was reused");
          return replay;
        }
        this.assertWriteFence(fence.data, input.nowMs);
        const selected = this.selectedTargetStorage().target;
        if (before.catalogGeneration !== expectedCatalogGeneration.data
            || before.authorityIncarnationId !== fence.data.authorityIncarnationId
            || before.writeEpoch !== fence.data.writeEpoch
            || !sameTarget(selected, expectedTarget.data)
            || this.legacyBootstrapManifest().length !== 0
            || readPendingLifecycleJobs(this.driver).length !== 0
            || readRevisionReservations(this.driver).some(item => item.state === "reserved"))
          throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration CAS is stale");
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        const job = PendingTargetLifecycleJobV1.safeParse({
          schema: 1,
          kind: input.kind,
          jobId: input.jobId,
          authorityIncarnationId: before.authorityIncarnationId,
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          declaredCatalogGeneration: nextCatalogGeneration,
          expectedTarget: expectedTarget.data,
          target: input.target,
          createdAt,
        });
        if (!job.success)
          throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration is invalid");
        const retained = [
          [job.data.jobId, "job"],
          [job.data.operationId, "operation"],
          [job.data.target.appInstanceId, "app"],
          [job.data.target.generationId, "generation"],
          [job.data.target.namespaceId, "namespace"],
        ] as const;
        for (const [value] of retained) {
          if (this.driver.select(
            "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [value],
          ).length !== 0)
            throw new ClayError("E_CATALOG_CONFLICT", "lifecycle identity was already retained");
        }
        for (const [value, kind] of retained) this.driver.exec(
          "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
          [value, kind, createdAt],
        );
        this.driver.exec(
          `INSERT INTO catalog.legacy_bootstrap_manifest(
             storage_key,user_file,system_file,storage_kind,app_instance_id,generation_id,
             namespace_id,operation_id,display_name,shell_id,selected,declared_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
          [job.data.target.storageKey, job.data.target.userFile, job.data.target.systemFile,
            job.data.target.storageKind, job.data.target.appInstanceId,
            job.data.target.generationId, job.data.target.namespaceId, job.data.operationId,
            job.data.target.displayName, job.data.target.shellId, createdAt],
        );
        this.driver.exec(
          `INSERT INTO catalog.pending_jobs(
             job_id,authority_incarnation_id,app_instance_id,kind,state,
             operation_id,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
          [job.data.jobId, job.data.authorityIncarnationId, job.data.target.appInstanceId,
            job.data.kind, JSON.stringify(job.data), job.data.operationId, createdAt, createdAt],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: nextCatalogGeneration,
          eventKind: job.data.kind === "fork" ? "app_fork_declared"
            : job.data.kind === "reset" ? "app_reset_declared" : "app_create_declared",
          appInstanceId: job.data.target.appInstanceId,
          operationId: job.data.operationId,
          writeEpoch: fence.data.writeEpoch,
          at: createdAt,
          target: null,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root SET catalog_generation = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ? AND write_epoch = ?`,
          [nextCatalogGeneration, before.authorityIncarnationId, before.catalogGeneration,
            before.selectedAppInstanceId, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const persisted = readPendingLifecycleJobs(this.driver)
          .find(candidate => candidate.operationId === job.data.operationId);
        if (!persisted || after.catalogGeneration !== nextCatalogGeneration
            || after.selectedAppInstanceId !== before.selectedAppInstanceId
            || JSON.stringify(persisted) !== JSON.stringify(job.data))
          throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration failed read-back");
        return persisted;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "app generation declaration failed");
    }
  }

  publishDeclaredAppGeneration(
    input: PublishDeclaredAppGenerationInput,
  ): ReturnType<DeviceCatalog["snapshot"]> {
    const expectedCatalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const publishedTarget = TargetEvidenceV1.safeParse(input.publishedTarget);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!expectedCatalogGeneration.success || !publishedTarget.success || !fence.success
        || typeof input.jobId !== "string" || !/^job_[a-z2-7]{26}$/.test(input.jobId)
        || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "app generation publication is invalid");
    let publishedAt: string;
    try { publishedAt = new Date(input.nowMs).toISOString(); }
    catch { throw new ClayError("E_CATALOG_CONFLICT", "app generation publication time is invalid"); }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        this.assertWriteFence(fence.data, input.nowMs);
        const job = readPendingLifecycleJobs(this.driver)
          .find(candidate => candidate.jobId === input.jobId);
        if (!job || job.kind === "cleanup"
            || before.catalogGeneration !== expectedCatalogGeneration.data
            || BigInt(before.catalogGeneration) < BigInt(job.declaredCatalogGeneration)
            || before.authorityIncarnationId !== fence.data.authorityIncarnationId
            || before.writeEpoch !== fence.data.writeEpoch
            || !sameTarget(this.selectedTargetStorage().target, job.expectedTarget)
            || (job.kind === "reset") !== (input.replacementCleanup !== undefined))
          throw new ClayError("E_CATALOG_CONFLICT", "app generation publication CAS is stale");
        if (publishedTarget.data.appInstanceId !== job.target.appInstanceId
            || publishedTarget.data.activeGenerationId !== job.target.generationId
            || publishedTarget.data.lineageEpoch !== "0"
            || publishedTarget.data.protectionRevision !== "0")
          throw new ClayError("E_CATALOG_CONFLICT", "published target does not match its declaration");
        if (this.driver.select(
          "SELECT generation_id FROM catalog.generations WHERE storage_key = ?",
          [job.target.storageKey],
        ).length !== 0 || before.entries.some(entry =>
          entry.appInstanceId === job.target.appInstanceId
          || entry.activeGenerationId === job.target.generationId))
          throw new ClayError("E_CATALOG_CONFLICT", "declared target identity is already active");
        const sourceRows = this.driver.select(
          "SELECT operation_id FROM catalog.generations WHERE generation_id = ?",
          [job.expectedTarget.activeGenerationId],
        );
        const sourceProvenanceId = job.kind === "fork" || job.kind === "reset"
          ? (sourceRows.length === 1 && typeof sourceRows[0]!.operation_id === "string"
            ? sourceRows[0]!.operation_id : null)
          : null;
        if ((job.kind === "fork" || job.kind === "reset") && sourceProvenanceId === null)
          throw new ClayError("E_CATALOG_CONFLICT", "fork source provenance is unavailable");
        this.driver.exec(
          `INSERT INTO catalog.generations(
             generation_id,app_instance_id,namespace_id,storage_key,operation_id,
             lineage_epoch,first_revision,digest_schema,state_sha256,
             source_archive_sha256,source_provenance_id,sealed_at,read_back_at
           ) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
          [job.target.generationId, job.target.appInstanceId, job.target.namespaceId,
            job.target.storageKey, job.operationId, publishedTarget.data.lineageEpoch,
            publishedTarget.data.protectionRevision, publishedTarget.data.digestSchema,
            publishedTarget.data.stateSha256, sourceProvenanceId, publishedAt, publishedAt],
        );
        this.driver.exec(
          `INSERT INTO catalog.app_entries(
             app_instance_id,display_name,shell_id,active_generation_id,
             journal_genesis_generation_id,journal_genesis_lineage_epoch,
             journal_genesis_protection_revision,journal_genesis_state_sha256,
             current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
             revision_high_water,digest_schema,state_sha256,tombstoned
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          [job.target.appInstanceId, job.target.displayName, job.target.shellId,
            job.target.generationId, job.target.generationId,
            publishedTarget.data.lineageEpoch, publishedTarget.data.protectionRevision,
            publishedTarget.data.stateSha256, publishedTarget.data.lineageEpoch,
            publishedTarget.data.lineageEpoch, publishedTarget.data.protectionRevision,
            publishedTarget.data.protectionRevision, publishedTarget.data.digestSchema,
            publishedTarget.data.stateSha256],
        );
        this.driver.exec(
          "DELETE FROM catalog.legacy_bootstrap_manifest WHERE operation_id = ?",
          [job.operationId],
        );
        this.driver.exec(
          "DELETE FROM catalog.pending_jobs WHERE job_id = ? AND operation_id = ?",
          [job.jobId, job.operationId],
        );
        const firstCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        let finalCatalogGeneration = firstCatalogGeneration;
        let replacementCleanup: PendingTargetLifecycleJob | null = null;
        if (job.kind === "reset") {
          const victim = before.entries.find(entry =>
            entry.appInstanceId === job.expectedTarget.appInstanceId);
          const victimRows = this.driver.select(
            `SELECT namespace_id,storage_key FROM catalog.generations
             WHERE generation_id = ? AND app_instance_id = ?`,
            [job.expectedTarget.activeGenerationId, job.expectedTarget.appInstanceId],
          );
          const cleanup = input.replacementCleanup;
          if (!victim || victimRows.length !== 1 || !cleanup
              || typeof victimRows[0]!.namespace_id !== "string"
              || typeof victimRows[0]!.storage_key !== "string")
            throw new ClayError("E_CATALOG_CONFLICT", "reset source storage is unavailable");
          const victimRow = victimRows[0]!;
          const victimNamespaceId = String(victimRow.namespace_id);
          const victimStorageKey = String(victimRow.storage_key);
          const victimPhysical = physicalNamespaceEntry(
            victimStorageKey, victimNamespaceId,
          );
          finalCatalogGeneration = incrementCounter(
            firstCatalogGeneration, "E_CATALOG_CONFLICT",
          );
          const parsedCleanup = PendingTargetLifecycleJobV1.safeParse({
            schema: 1,
            kind: "cleanup",
            jobId: cleanup.jobId,
            authorityIncarnationId: before.authorityIncarnationId,
            operationId: cleanup.operationId,
            requestSha256: cleanup.requestSha256,
            declaredCatalogGeneration: finalCatalogGeneration,
            expectedTarget: publishedTarget.data,
            target: {
              appInstanceId: victim.appInstanceId,
              generationId: job.expectedTarget.activeGenerationId,
              namespaceId: victimNamespaceId,
              storageKey: victimStorageKey,
              userFile: victimPhysical.userFile,
              systemFile: victimPhysical.systemFile,
              storageKind: victimPhysical.kind,
              displayName: victim.displayName,
              shellId: victim.shellId,
            },
            createdAt: publishedAt,
          });
          if (!parsedCleanup.success)
            throw new ClayError("E_CATALOG_CONFLICT", "reset cleanup declaration is invalid");
          replacementCleanup = parsedCleanup.data;
          for (const [value, kind] of [
            [replacementCleanup.jobId, "job"],
            [replacementCleanup.operationId, "operation"],
          ] as const) {
            if (this.driver.select(
              "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [value],
            ).length !== 0)
              throw new ClayError("E_CATALOG_CONFLICT", "reset cleanup identity was already retained");
            this.driver.exec(
              "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
              [value, kind, publishedAt],
            );
          }
          this.driver.exec(
            "UPDATE catalog.app_entries SET tombstoned = 1 WHERE app_instance_id = ? AND tombstoned = 0",
            [victim.appInstanceId],
          );
          this.driver.exec(
            `INSERT INTO catalog.pending_jobs(
               job_id,authority_incarnation_id,app_instance_id,kind,state,
               operation_id,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?,?)`,
            [replacementCleanup.jobId, replacementCleanup.authorityIncarnationId,
              replacementCleanup.target.appInstanceId, replacementCleanup.kind,
              JSON.stringify(replacementCleanup), replacementCleanup.operationId,
              publishedAt, publishedAt],
          );
          insertCatalogGenerationEvent(this.driver, {
            schema: 1,
            catalogGeneration: firstCatalogGeneration,
            eventKind: "app_deleted",
            appInstanceId: victim.appInstanceId,
            operationId: job.operationId,
            writeEpoch: fence.data.writeEpoch,
            at: publishedAt,
            target: null,
          });
        }
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: finalCatalogGeneration,
          eventKind: "app_seed",
          appInstanceId: job.target.appInstanceId,
          operationId: job.operationId,
          writeEpoch: fence.data.writeEpoch,
          at: publishedAt,
          target: publishedTarget.data,
          displayName: job.target.displayName,
          shellId: job.target.shellId,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root
           SET catalog_generation = ?, selected_app_instance_id = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ? AND write_epoch = ?`,
          [finalCatalogGeneration, job.target.appInstanceId, before.authorityIncarnationId,
            before.catalogGeneration, before.selectedAppInstanceId, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const entry = after.entries.find(candidate =>
          candidate.appInstanceId === job.target.appInstanceId);
        if (!entry || after.catalogGeneration !== finalCatalogGeneration
            || after.selectedAppInstanceId !== job.target.appInstanceId
            || entry.activeGenerationId !== job.target.generationId
            || entry.stateSha256 !== publishedTarget.data.stateSha256
            || readPendingLifecycleJobs(this.driver).some(candidate => candidate.jobId === job.jobId)
            || this.legacyBootstrapManifest().some(candidate =>
              candidate.operationId === job.operationId))
          throw new ClayError("E_CATALOG_CONFLICT", "app generation publication failed read-back");
        return after;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "app generation publication failed");
    }
  }

  deleteSelectedApp(input: DeleteSelectedAppInput): {
    snapshot: ReturnType<DeviceCatalog["snapshot"]>;
    cleanupJob: PendingTargetLifecycleJob;
  } {
    const expectedCatalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const expectedTarget = TargetEvidenceV1.safeParse(input.expectedTarget);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!expectedCatalogGeneration.success || !expectedTarget.success || !fence.success
        || typeof input.jobId !== "string" || typeof input.operationId !== "string"
        || typeof input.requestSha256 !== "string" || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "app deletion is invalid");
    let deletedAt: string;
    try { deletedAt = new Date(input.nowMs).toISOString(); }
    catch { throw new ClayError("E_CATALOG_CONFLICT", "app deletion time is invalid"); }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        this.assertWriteFence(fence.data, input.nowMs);
        if (before.catalogGeneration !== expectedCatalogGeneration.data
            || before.authorityIncarnationId !== fence.data.authorityIncarnationId
            || before.writeEpoch !== fence.data.writeEpoch
            || !sameTarget(this.selectedTargetStorage().target, expectedTarget.data)
            || before.entries.length < 2
            || this.legacyBootstrapManifest().length !== 0
            || readPendingLifecycleJobs(this.driver).length !== 0
            || readRevisionReservations(this.driver).some(item => item.state === "reserved"))
          throw new ClayError("E_CATALOG_CONFLICT", "app deletion CAS is stale");
        const victim = before.entries.find(entry =>
          entry.appInstanceId === expectedTarget.data.appInstanceId);
        const fallback = [...before.entries]
          .filter(entry => entry.appInstanceId !== expectedTarget.data.appInstanceId)
          .sort((left, right) => left.appInstanceId.localeCompare(right.appInstanceId))[0];
        if (!victim || !fallback)
          throw new ClayError("E_CATALOG_CONFLICT", "the last live app cannot be deleted");
        const victimStorage = this.selectedTargetStorage();
        const fallbackRows = this.driver.select(
          `SELECT g.namespace_id,g.storage_key
           FROM catalog.generations g
           WHERE g.generation_id = ? AND g.app_instance_id = ?`,
          [fallback.activeGenerationId, fallback.appInstanceId],
        );
        if (fallbackRows.length !== 1)
          throw new ClayError("E_CATALOG_CONFLICT", "fallback generation storage is invalid");
        const fallbackTarget: TargetEvidence = {
          appInstanceId: fallback.appInstanceId,
          activeGenerationId: fallback.activeGenerationId,
          lineageEpoch: fallback.currentLineageEpoch,
          protectionRevision: fallback.currentProtectionRevision,
          digestSchema: fallback.digestSchema,
          stateSha256: fallback.stateSha256,
        };
        const deletedGeneration = this.generationDescriptors().find(generation =>
          generation.generationId === victimStorage.target.activeGenerationId);
        if (!deletedGeneration)
          throw new ClayError("E_CATALOG_CONFLICT", "deleted generation descriptor is unavailable");
        const deletedPhysical = physicalNamespaceEntry(
          victimStorage.storageKey, victimStorage.namespaceId,
        );
        const firstGeneration = incrementCounter(before.catalogGeneration, "E_CATALOG_CONFLICT");
        const finalGeneration = incrementCounter(firstGeneration, "E_CATALOG_CONFLICT");
        const cleanupJob = PendingTargetLifecycleJobV1.safeParse({
          schema: 1,
          kind: "cleanup",
          jobId: input.jobId,
          authorityIncarnationId: before.authorityIncarnationId,
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          declaredCatalogGeneration: finalGeneration,
          expectedTarget: fallbackTarget,
          target: {
            appInstanceId: victim.appInstanceId,
            generationId: victimStorage.target.activeGenerationId,
            namespaceId: victimStorage.namespaceId,
            storageKey: victimStorage.storageKey,
            userFile: deletedPhysical.userFile,
            systemFile: deletedPhysical.systemFile,
            storageKind: deletedPhysical.kind,
            displayName: victim.displayName,
            shellId: victim.shellId,
          },
          createdAt: deletedAt,
        });
        if (!cleanupJob.success)
          throw new ClayError("E_CATALOG_CONFLICT", "app cleanup declaration is invalid");
        for (const [value, kind] of [
          [cleanupJob.data.jobId, "job"], [cleanupJob.data.operationId, "operation"],
        ] as const) {
          if (this.driver.select(
            "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [value],
          ).length !== 0)
            throw new ClayError("E_CATALOG_CONFLICT", "app deletion identity was already retained");
          this.driver.exec(
            "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
            [value, kind, deletedAt],
          );
        }
        this.driver.exec(
          "UPDATE catalog.app_entries SET tombstoned = 1 WHERE app_instance_id = ? AND tombstoned = 0",
          [victim.appInstanceId],
        );
        this.driver.exec(
          `INSERT INTO catalog.pending_jobs(
             job_id,authority_incarnation_id,app_instance_id,kind,state,
             operation_id,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
          [cleanupJob.data.jobId, cleanupJob.data.authorityIncarnationId,
            cleanupJob.data.target.appInstanceId, cleanupJob.data.kind,
            JSON.stringify(cleanupJob.data), cleanupJob.data.operationId,
            deletedAt, deletedAt],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: firstGeneration,
          eventKind: "app_deleted",
          appInstanceId: victim.appInstanceId,
          operationId: cleanupJob.data.operationId,
          writeEpoch: fence.data.writeEpoch,
          at: deletedAt,
          target: null,
        });
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: finalGeneration,
          eventKind: "app_selected",
          appInstanceId: fallback.appInstanceId,
          operationId: cleanupJob.data.operationId,
          writeEpoch: fence.data.writeEpoch,
          at: deletedAt,
          target: fallbackTarget,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root
           SET catalog_generation = ?, selected_app_instance_id = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ? AND write_epoch = ?`,
          [finalGeneration, fallback.appInstanceId, before.authorityIncarnationId,
            before.catalogGeneration, before.selectedAppInstanceId, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const persisted = readPendingLifecycleJobs(this.driver)
          .find(job => job.jobId === cleanupJob.data.jobId);
        if (!persisted || after.catalogGeneration !== finalGeneration
            || after.selectedAppInstanceId !== fallback.appInstanceId
            || after.entries.some(entry => entry.appInstanceId === victim.appInstanceId)
            || JSON.stringify(persisted) !== JSON.stringify(cleanupJob.data))
          throw new ClayError("E_CATALOG_CONFLICT", "app deletion failed read-back");
        return { snapshot: after, cleanupJob: persisted };
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "app deletion failed");
    }
  }

  completeLifecycleCleanup(
    input: CompleteLifecycleCleanupInput,
  ): ReturnType<DeviceCatalog["snapshot"]> {
    const expectedCatalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!expectedCatalogGeneration.success || !fence.success
        || typeof input.jobId !== "string" || !/^job_[a-z2-7]{26}$/.test(input.jobId)
        || input.cleanupConfirmed !== true || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "lifecycle cleanup completion is invalid");
    let completedAt: string;
    try { completedAt = new Date(input.nowMs).toISOString(); }
    catch { throw new ClayError("E_CATALOG_CONFLICT", "lifecycle cleanup time is invalid"); }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        this.assertWriteFence(fence.data, input.nowMs);
        const job = readPendingLifecycleJobs(this.driver)
          .find(candidate => candidate.jobId === input.jobId && candidate.kind === "cleanup");
        if (!job || before.catalogGeneration !== expectedCatalogGeneration.data
            || before.authorityIncarnationId !== fence.data.authorityIncarnationId
            || before.writeEpoch !== fence.data.writeEpoch
            || !sameTarget(this.selectedTargetStorage().target, job.expectedTarget)
            || before.entries.some(entry =>
              entry.activeGenerationId === job.target.generationId
              || entry.appInstanceId === job.target.appInstanceId))
          throw new ClayError("E_CATALOG_CONFLICT", "lifecycle cleanup CAS is stale");
        this.driver.exec(
          "DELETE FROM catalog.pending_jobs WHERE job_id = ? AND operation_id = ?",
          [job.jobId, job.operationId],
        );
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: nextCatalogGeneration,
          eventKind: "lifecycle_cleaned",
          appInstanceId: job.target.appInstanceId,
          operationId: job.operationId,
          writeEpoch: fence.data.writeEpoch,
          at: completedAt,
          target: null,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root SET catalog_generation = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ? AND write_epoch = ?`,
          [nextCatalogGeneration, before.authorityIncarnationId, before.catalogGeneration,
            before.selectedAppInstanceId, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        if (after.catalogGeneration !== nextCatalogGeneration
            || after.selectedAppInstanceId !== before.selectedAppInstanceId
            || readPendingLifecycleJobs(this.driver).some(candidate => candidate.jobId === job.jobId))
          throw new ClayError("E_CATALOG_CONFLICT", "lifecycle cleanup failed read-back");
        return after;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "lifecycle cleanup completion failed");
    }
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
        || typeof input.shellId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(input.shellId)
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
             app_instance_id,display_name,shell_id,active_generation_id,
             journal_genesis_generation_id,journal_genesis_lineage_epoch,
             journal_genesis_protection_revision,journal_genesis_state_sha256,
             current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
             revision_high_water,digest_schema,state_sha256,tombstoned
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          [target.data.appInstanceId, input.displayName, input.shellId,
            target.data.activeGenerationId,
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
          displayName: input.displayName,
          shellId: input.shellId,
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
            || entry.shellId !== input.shellId
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

  beginLegacyBootstrap(entries: readonly LegacyBootstrapEntry[], at: string): void {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 1_000
        || typeof at !== "string" || Number.isNaN(Date.parse(at))
        || new Date(at).toISOString() !== at)
      throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap declaration is invalid");
    if (Object.getPrototypeOf(entries) !== Array.prototype
        || Reflect.ownKeys(entries).some(key => key !== "length"
          && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key))))
      throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap list is not plain");
    const captured: LegacyBootstrapEntry[] = [];
    const entryKeys = ["storageKey", "userFile", "systemFile", "kind", "appInstanceId",
      "generationId", "namespaceId", "operationId", "displayName", "shellId", "selected"];
    for (let index = 0; index < entries.length; index++) {
      const arrayDescriptor = Object.getOwnPropertyDescriptor(entries, String(index));
      const candidate = arrayDescriptor && "value" in arrayDescriptor
        ? arrayDescriptor.value : undefined;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)
          || (Object.getPrototypeOf(candidate) !== Object.prototype
            && Object.getPrototypeOf(candidate) !== null)
          || Reflect.ownKeys(candidate).length !== entryKeys.length)
        throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap entry is not plain data");
      const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of entryKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !("value" in descriptor))
          throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap entry is not plain data");
        values[key] = descriptor.value;
      }
      if (Reflect.ownKeys(candidate).some(key => typeof key !== "string"
          || !entryKeys.includes(key)))
        throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap entry has unknown fields");
      const app = AppInstanceId.safeParse(values.appInstanceId);
      const generation = GenerationId.safeParse(values.generationId);
      const namespace = NamespaceId.safeParse(values.namespaceId);
      const operation = OperationId.safeParse(values.operationId);
      if (!app.success || !generation.success || !namespace.success || !operation.success
          || typeof values.storageKey !== "string" || !validStorageKey(values.storageKey)
          || typeof values.displayName !== "string" || values.displayName !== values.displayName.trim()
          || values.displayName.length < 1 || values.displayName.length > 40
          || typeof values.shellId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(values.shellId)
          || typeof values.selected !== "boolean")
        throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap entry is invalid");
      const physical = physicalNamespaceEntry(values.storageKey, namespace.data);
      if (values.userFile !== physical.userFile || values.systemFile !== physical.systemFile
          || values.kind !== physical.kind)
        throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap physical entry is invalid");
      captured.push({ ...physical, appInstanceId: app.data, generationId: generation.data,
        namespaceId: namespace.data, operationId: operation.data,
        displayName: values.displayName, shellId: values.shellId, selected: values.selected });
    }
    const unique = (values: string[]): boolean => new Set(values).size === values.length;
    if (captured.filter(entry => entry.selected).length !== 1
        || !unique(captured.map(entry => entry.storageKey))
        || !unique(captured.map(entry => entry.appInstanceId))
        || !unique(captured.map(entry => entry.generationId))
        || !unique(captured.map(entry => entry.namespaceId))
        || !unique(captured.map(entry => entry.operationId)))
      throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap identities are not unique");
    this.driver.tx(() => {
      const before = readValidatedCatalog(this.driver);
      if (before.catalogGeneration !== "0" || before.selectedAppInstanceId !== null
          || before.entries.length !== 0 || this.legacyBootstrapManifest().length !== 0)
        throw new ClayError("E_CATALOG_CONFLICT", "catalog is not empty for legacy bootstrap");
      for (const entry of captured) this.driver.exec(
        `INSERT INTO catalog.legacy_bootstrap_manifest(
           storage_key,user_file,system_file,storage_kind,app_instance_id,generation_id,
           namespace_id,operation_id,display_name,shell_id,selected,declared_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [entry.storageKey, entry.userFile, entry.systemFile, entry.kind,
          entry.appInstanceId, entry.generationId, entry.namespaceId, entry.operationId,
          entry.displayName, entry.shellId, entry.selected ? 1 : 0, at],
      );
      if (JSON.stringify(this.legacyBootstrapManifest()) !== JSON.stringify(
        [...captured].sort((left, right) => left.storageKey.localeCompare(right.storageKey)),
      )) throw new ClayError("E_CATALOG_CONFLICT", "legacy bootstrap failed read-back");
    });
  }

  legacyBootstrapManifest(): LegacyBootstrapEntry[] {
    return this.driver.select(
      `SELECT storage_key,user_file,system_file,storage_kind,app_instance_id,
              generation_id,namespace_id,operation_id,display_name,shell_id,selected,declared_at
       FROM catalog.legacy_bootstrap_manifest ORDER BY storage_key`,
    ).map(row => {
      const storageKey = String(row.storage_key);
      const namespaceId = NamespaceId.parse(String(row.namespace_id));
      const expected = physicalNamespaceEntry(storageKey, namespaceId);
      const entry: LegacyBootstrapEntry = {
        storageKey,
        userFile: String(row.user_file),
        systemFile: String(row.system_file),
        kind: String(row.storage_kind) as "legacy" | "generation",
        appInstanceId: AppInstanceId.parse(String(row.app_instance_id)),
        generationId: GenerationId.parse(String(row.generation_id)),
        namespaceId,
        operationId: OperationId.parse(String(row.operation_id)),
        displayName: String(row.display_name),
        shellId: String(row.shell_id),
        selected: Number(row.selected) === 1,
      };
      if (entry.userFile !== expected.userFile || entry.systemFile !== expected.systemFile
          || entry.kind !== expected.kind || entry.displayName !== entry.displayName.trim()
          || entry.displayName.length < 1 || entry.displayName.length > 40
          || !/^[a-z0-9_-]{1,64}$/.test(entry.shellId)
          || ![0, 1].includes(Number(row.selected))
          || typeof row.declared_at !== "string"
          || new Date(row.declared_at).toISOString() !== row.declared_at)
        throw new ClayError("E_CATALOG_UNAVAILABLE", "legacy bootstrap manifest is invalid");
      return entry;
    });
  }

  addAppTarget(input: AddAppTargetInput): ReturnType<DeviceCatalog["snapshot"]> {
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const target = TargetEvidenceV1.safeParse(input.target);
    const namespaceId = NamespaceId.safeParse(input.namespaceId);
    const operationId = OperationId.safeParse(input.operationId);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!catalogGeneration.success || !target.success || !namespaceId.success
        || !operationId.success || !fence.success || !validStorageKey(input.storageKey)
        || typeof input.displayName !== "string" || input.displayName !== input.displayName.trim()
        || input.displayName.length < 1 || input.displayName.length > 40
        || typeof input.shellId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(input.shellId)
        || !validClockValue(input.nowMs) || input.select !== true
        || target.data.lineageEpoch !== "0" || target.data.protectionRevision !== "0")
      throw new ClayError("E_CATALOG_CONFLICT", "catalog app add input is invalid");
    const at = new Date(input.nowMs).toISOString();
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        this.assertWriteFence(fence.data, input.nowMs);
        const bootstrap = input.bootstrapStorageKey === undefined ? undefined
          : this.legacyBootstrapManifest().find(entry =>
            entry.storageKey === input.bootstrapStorageKey);
        if (input.bootstrapStorageKey !== undefined && (!bootstrap
            || bootstrap.appInstanceId !== target.data.appInstanceId
            || bootstrap.generationId !== target.data.activeGenerationId
            || bootstrap.namespaceId !== namespaceId.data
            || bootstrap.operationId !== operationId.data
            || bootstrap.displayName !== input.displayName
            || bootstrap.shellId !== input.shellId
            || bootstrap.storageKey !== input.storageKey))
          throw new ClayError("E_CATALOG_CONFLICT", "catalog bootstrap manifest does not match");
        const firstBootstrap = before.selectedAppInstanceId === null
          && before.entries.length === 0 && input.select && bootstrap !== undefined;
        if (before.catalogGeneration !== catalogGeneration.data
            || before.authorityIncarnationId !== fence.data.authorityIncarnationId
            || before.writeEpoch !== fence.data.writeEpoch
            || (before.selectedAppInstanceId === null && !firstBootstrap))
          throw new ClayError("E_CATALOG_CONFLICT", "catalog app add CAS is stale");
        if (this.driver.select(
          "SELECT generation_id FROM catalog.generations WHERE storage_key = ?", [input.storageKey],
        ).length !== 0)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog storage key is already retained");
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
            throw new ClayError("E_CATALOG_CONFLICT", "catalog app add identity was already retained");
        }
        for (const [value, kind] of retained) this.driver.exec(
          "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
          [value, kind, at],
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
            at, at],
        );
        this.driver.exec(
          `INSERT INTO catalog.app_entries(
             app_instance_id,display_name,shell_id,active_generation_id,
             journal_genesis_generation_id,journal_genesis_lineage_epoch,
             journal_genesis_protection_revision,journal_genesis_state_sha256,
             current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
             revision_high_water,digest_schema,state_sha256,tombstoned
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          [target.data.appInstanceId, input.displayName, input.shellId,
            target.data.activeGenerationId, target.data.activeGenerationId,
            target.data.lineageEpoch, target.data.protectionRevision, target.data.stateSha256,
            target.data.lineageEpoch, target.data.lineageEpoch,
            target.data.protectionRevision, target.data.protectionRevision,
            target.data.digestSchema, target.data.stateSha256],
        );
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: nextCatalogGeneration,
          eventKind: "app_seed",
          appInstanceId: target.data.appInstanceId,
          operationId: operationId.data,
          writeEpoch: fence.data.writeEpoch,
          at,
          target: target.data,
          displayName: input.displayName,
          shellId: input.shellId,
        });
        const selectedAppInstanceId = target.data.appInstanceId;
        this.driver.exec(
          `UPDATE catalog.catalog_root
           SET catalog_generation = ?, selected_app_instance_id = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND write_epoch = ?`,
          [nextCatalogGeneration, selectedAppInstanceId, before.authorityIncarnationId,
            before.catalogGeneration, before.writeEpoch],
        );
        if (bootstrap) this.driver.exec(
          "DELETE FROM catalog.legacy_bootstrap_manifest WHERE storage_key = ?",
          [bootstrap.storageKey],
        );
        const after = readValidatedCatalog(this.driver);
        const entry = after.entries.find(candidate =>
          candidate.appInstanceId === target.data.appInstanceId);
        if (after.catalogGeneration !== nextCatalogGeneration
            || after.selectedAppInstanceId !== selectedAppInstanceId || !entry
            || entry.activeGenerationId !== target.data.activeGenerationId
            || entry.shellId !== input.shellId || entry.stateSha256 !== target.data.stateSha256
            || (bootstrap !== undefined
              && this.legacyBootstrapManifest().some(item => item.storageKey === bootstrap.storageKey)))
          throw new ClayError("E_CATALOG_CONFLICT", "catalog app add failed read-back");
        return after;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog app add failed");
    }
  }

  updateSelectedAppMetadata(
    input: UpdateSelectedAppMetadataInput,
  ): ReturnType<DeviceCatalog["snapshot"]> {
    const generation = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const operation = OperationId.safeParse(input.operationId);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!generation.success || !operation.success || !fence.success
        || typeof input.displayName !== "string" || input.displayName !== input.displayName.trim()
        || input.displayName.length < 1 || input.displayName.length > 40
        || typeof input.shellId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(input.shellId)
        || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "app metadata update is invalid");
    return this.driver.tx(() => {
      const before = readValidatedCatalog(this.driver);
      this.assertWriteFence(fence.data, input.nowMs);
      if (before.catalogGeneration !== generation.data
          || before.authorityIncarnationId !== fence.data.authorityIncarnationId
          || before.writeEpoch !== fence.data.writeEpoch
          || before.selectedAppInstanceId === null
          || this.legacyBootstrapManifest().length !== 0)
        throw new ClayError("E_CATALOG_CONFLICT", "app metadata compare-and-swap failed");
      const app = before.entries.find(item =>
        item.appInstanceId === before.selectedAppInstanceId && !item.tombstoned);
      if (!app) throw new ClayError("E_CATALOG_CONFLICT", "selected app is unavailable");
      if (app.displayName === input.displayName && app.shellId === input.shellId) return before;
      if (this.driver.select(
        "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [operation.data],
      ).length !== 0)
        throw new ClayError("E_CATALOG_CONFLICT", "app metadata operation identity was reused");
      const at = new Date(input.nowMs).toISOString();
      const nextGeneration = incrementCounter(before.catalogGeneration, "E_CATALOG_CONFLICT");
      this.driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES(?,?,?)",
        [operation.data, "operation", at],
      );
      this.driver.exec(
        `UPDATE catalog.app_entries SET display_name = ?, shell_id = ?
         WHERE app_instance_id = ? AND tombstoned = 0`,
        [input.displayName, input.shellId, app.appInstanceId],
      );
      insertCatalogGenerationEvent(this.driver, {
        schema: 1,
        catalogGeneration: nextGeneration,
        eventKind: "app_metadata",
        appInstanceId: app.appInstanceId,
        operationId: operation.data,
        writeEpoch: fence.data.writeEpoch,
        at,
        target: null,
        displayName: input.displayName,
        shellId: input.shellId,
      });
      this.driver.exec(
        `UPDATE catalog.catalog_root SET catalog_generation = ?
         WHERE singleton = 1 AND authority_incarnation_id = ?
           AND catalog_generation = ? AND write_epoch = ?`,
        [nextGeneration, before.authorityIncarnationId,
          before.catalogGeneration, before.writeEpoch],
      );
      const after = readValidatedCatalog(this.driver);
      if (after.catalogGeneration !== nextGeneration
          || after.selectedAppInstanceId !== app.appInstanceId)
        throw new ClayError("E_CATALOG_CONFLICT", "app metadata publication failed read-back");
      const updated = after.entries.find(item => item.appInstanceId === app.appInstanceId);
      if (!updated || updated.displayName !== input.displayName || updated.shellId !== input.shellId)
        throw new ClayError("E_CATALOG_CONFLICT", "app metadata failed read-back");
      return after;
    });
  }

  selectApp(input: SelectAppInput): ReturnType<DeviceCatalog["snapshot"]> {
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const appInstanceId = AppInstanceId.safeParse(input.appInstanceId);
    const operationId = OperationId.safeParse(input.operationId);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!catalogGeneration.success || !appInstanceId.success || !operationId.success
        || !fence.success || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "catalog app selection input is invalid");
    const at = new Date(input.nowMs).toISOString();
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        this.assertWriteFence(fence.data, input.nowMs);
        const app = before.entries.find(entry =>
          entry.appInstanceId === appInstanceId.data && !entry.tombstoned);
        if (before.catalogGeneration !== catalogGeneration.data
            || before.writeEpoch !== fence.data.writeEpoch || !app
            || this.legacyBootstrapManifest().length !== 0)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog app selection CAS is stale");
        if (before.selectedAppInstanceId === appInstanceId.data) return before;
        if (this.driver.select(
          "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [operationId.data],
        ).length !== 0)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog app selection operation was reused");
        this.driver.exec(
          "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?, 'operation', ?)",
          [operationId.data, at],
        );
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: nextCatalogGeneration,
          eventKind: "app_selected",
          appInstanceId: app.appInstanceId,
          operationId: operationId.data,
          writeEpoch: fence.data.writeEpoch,
          at,
          target: {
            appInstanceId: app.appInstanceId,
            activeGenerationId: app.activeGenerationId,
            lineageEpoch: app.currentLineageEpoch,
            protectionRevision: app.currentProtectionRevision,
            digestSchema: app.digestSchema,
            stateSha256: app.stateSha256,
          },
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root SET catalog_generation=?,selected_app_instance_id=?
           WHERE singleton=1 AND catalog_generation=? AND write_epoch=?`,
          [nextCatalogGeneration, app.appInstanceId,
            before.catalogGeneration, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        if (after.catalogGeneration !== nextCatalogGeneration
            || after.selectedAppInstanceId !== app.appInstanceId)
          throw new ClayError("E_CATALOG_CONFLICT", "catalog app selection failed read-back");
        return after;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog app selection failed");
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
    const metadata = input.metadata ?? null;
    const metadataValid = metadata === null || (
      typeof metadata === "object" && !Array.isArray(metadata)
      && Reflect.ownKeys(metadata).length === 2
      && typeof metadata.displayName === "string"
      && metadata.displayName === metadata.displayName.trim()
      && metadata.displayName.length >= 1 && metadata.displayName.length <= 40
      && typeof metadata.shellId === "string" && /^[a-z0-9_-]{1,64}$/.test(metadata.shellId)
    );
    if (!catalogGeneration.success || !expected.success || !published.success
        || !operation.success || !requestSha256.success || !requestedFence.success
        || !metadataValid || !validClockValue(input.nowMs))
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
              || !sameTarget(current, published.data)
              || (metadata !== null && (entry.displayName !== metadata.displayName
                || entry.shellId !== metadata.shellId)))
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
           SET current_protection_revision = ?, state_sha256 = ?, display_name = ?, shell_id = ?
           WHERE app_instance_id = ? AND active_generation_id = ?
             AND current_lineage_epoch = ? AND current_protection_revision = ?
             AND revision_high_water = ? AND digest_schema = ? AND state_sha256 = ?
             AND tombstoned = 0`,
          [published.data.protectionRevision, published.data.stateSha256,
            metadata?.displayName ?? entry.displayName, metadata?.shellId ?? entry.shellId,
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
          displayName: metadata?.displayName ?? null,
          shellId: metadata?.shellId ?? null,
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
            || afterEntry.stateSha256 !== published.data.stateSha256
            || (metadata !== null && (afterEntry.displayName !== metadata.displayName
              || afterEntry.shellId !== metadata.shellId)))
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
