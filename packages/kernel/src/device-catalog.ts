import {
  AppInstanceId,
  AuthorityIncarnationId,
  GenerationId,
  LeaseId,
  NamespaceId,
  OperationId,
  RequestId,
  ReleaseId,
  Sha256,
  UInt64Decimal,
} from "@clay/schema/standalone/index";
import {
  AppLifecycleReceiptV1,
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
} from "@clay/schema/standalone/catalog";
import {
  BackupPublicationReceiptV1,
  BackupPublicationRequestV1,
  BackupRecordV1,
  BackupRemovalAcknowledgementV1,
  BackupRetentionReceiptV1,
  BackupRemovalRequestV1,
  BackupRemovalAuthorizationV1,
  type BackupPublicationReceiptV1 as BackupPublicationReceipt,
  type BackupPublicationRequestV1 as BackupPublicationRequest,
  type BackupRecordV1 as BackupRecord,
} from "@clay/schema/standalone/backup";
import {
  ArchivePendingJobV1,
  CatalogRestoreJobV2,
  type CatalogRestoreJob as ArchivePendingJob,
} from "@clay/schema/standalone/archive";
import type {
  AppLifecycleReceiptV1 as AppLifecycleReceipt,
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
import { assertLifecycleReattestation } from "./lifecycle-reattestation-evidence";
import { readCatalogPendingRows, LIFECYCLE_PROVENANCE, LIFECYCLE_RECEIPT_PROVENANCE } from "./catalog-pending";
import { BACKUP_RETENTION_DDL, assertBackupRetentionHistory, backupRemovalHash, backupRemovalRequestId,
  planBackupRetention, readBackupRetentionHistory, retentionEligible } from "./backup-retention";
import { productionOperationIdV2 } from "./production-operation-id";
import { parseProductionRequestReceiptRow } from "./production-request-journal";

const LEGACY_CATALOG_DDL = [
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
      'revision_abandoned','recovery_takeover','app_selected','app_metadata','backup_published'
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
  `CREATE TABLE catalog.backup_records(
    backup_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    publication_catalog_generation TEXT NOT NULL UNIQUE,
    record_json TEXT NOT NULL UNIQUE
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
    generation_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    source_archive_sha256 TEXT NOT NULL,
    source_provenance_id TEXT NOT NULL,
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

const CATALOG_DDL = [...LEGACY_CATALOG_DDL, ...BACKUP_RETENTION_DDL];
function normalizeDdl(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function ddlIdentity(ddl: string): readonly [string, string] {
  const match = /^CREATE TABLE catalog\.([a-z_]+)\(/.exec(ddl);
  if (!match) throw new Error("invalid trusted catalog DDL");
  return [match[1]!, normalizeDdl(ddl.replace("CREATE TABLE catalog.", "CREATE TABLE "))];
}

function columnSignature(ddl: string): string {
  const columns: { name: string; type: string; required: number; pk: number }[] = [];
  let compositePrimaryKey: string[] = [];
  for (const source of ddl.slice(ddl.indexOf("(") + 1, ddl.lastIndexOf(")")).split("\n")) {
    const line = source.trim().replace(/,$/, "");
    const column = /^([a-z0-9_]+)\s+(TEXT|INTEGER|REAL|BLOB)\b/.exec(line);
    if (column) {
      columns.push({
        name: column[1]!,
        type: column[2]!,
        required: /\bNOT NULL\b/.test(line) ? 1 : 0,
        pk: /\bPRIMARY KEY\b/.test(line) ? 1 : 0,
      });
      continue;
    }
    const primaryKey = /^PRIMARY KEY\(([^)]+)\)/.exec(line);
    if (primaryKey) compositePrimaryKey = primaryKey[1]!.split(",").map(name => name.trim());
  }
  if (columns.length === 0) throw new Error("invalid trusted catalog DDL");
  return columns.map(column => {
    const compositeIndex = compositePrimaryKey.indexOf(column.name);
    return `${column.name}:${column.type}:${column.required}:${
      compositeIndex < 0 ? column.pk : compositeIndex + 1}`;
  }).join("|");
}

const EXPECTED_DDL = new Map(CATALOG_DDL.map(ddlIdentity));
const LEGACY_DDL = new Map(LEGACY_CATALOG_DDL.map(ddlIdentity));
const EXPECTED_TABLES = Object.freeze([...EXPECTED_DDL.keys()].sort());
const LEGACY_TABLES = Object.freeze([...LEGACY_DDL.keys()].sort());
const EXPECTED_COLUMN_SIGNATURES = Object.fromEntries(
  CATALOG_DDL.map(ddl => [ddlIdentity(ddl)[0], columnSignature(ddl)]),
) as Readonly<Record<string, string>>;

export type CatalogSchemaObject = Readonly<{
  schema: 1;
  type: "table";
  name: string;
  tableName: string;
  sql: string;
}>;

/** Exact normalized catalog DDL allowlist for authenticated archive evidence. */
export function expectedCatalogSchemaObjects(retention = true): CatalogSchemaObject[] {
  return [...(retention ? EXPECTED_DDL : LEGACY_DDL).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, sql]) => ({ schema: 1, type: "table", name, tableName: name, sql }));
}

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
  sourceArchiveSha256?: string | null;
  sourceProvenanceId?: string | null;
};

export type DeclareAppGenerationInput = {
  kind: "create" | "fork";
  requestId: string;
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
  fence: WriteFence;
  nowMs: number;
};

export type DeleteSelectedAppInput = {
  requestId: string;
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
  recordNoop?: boolean;
  expectedCatalogGeneration: string;
  displayName: string;
  shellId: string;
  operationId: string;
  fence: WriteFence;
  nowMs: number;
};

export type SelectAppInput = {
  recordNoop?: boolean;
  expectedCatalogGeneration: string;
  appInstanceId: string;
  operationId: string;
  fence: WriteFence;
  nowMs: number;
};

export type RecordAppLifecycleReceiptInput = {
  kind: "switch" | "rename";
  requestId: string;
  requestSha256: string;
  jobId: string;
  operationId: string;
  requestedAppInstanceId: string;
  expectedCatalogGeneration: string;
  completedAt: string;
};

export type PublishBackupInput = {
  request: BackupPublicationRequest;
  operationId: string;
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

type StoredBackupRecord = Readonly<{ record: BackupRecord; operationId: string }>;

function readBackupRecords(driver: DbDriver): StoredBackupRecord[] {
  return driver.select("SELECT * FROM catalog.backup_records ORDER BY backup_id")
    .map(row => {
      if (typeof row.record_json !== "string") throw new Error("backup record is not text");
      let decoded: unknown;
      try { decoded = JSON.parse(row.record_json); }
      catch { throw new Error("backup record is malformed"); }
      const record = BackupRecordV1.parse(decoded);
      const operationId = OperationId.parse(row.operation_id);
      if (record.backupId !== row.backup_id
          || record.publicationCatalogGeneration !== row.publication_catalog_generation
          || JSON.stringify(record) !== row.record_json)
        throw new Error("backup record is noncanonical");
      return Object.freeze({ record, operationId });
    });
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

function hasExactSchema(tables: string[], legacy = false): boolean {
  const expected = legacy ? LEGACY_TABLES : EXPECTED_TABLES;
  return tables.length === expected.length && tables.every((table, index) => table === expected[index]);
}

function hasOnlyExpectedObjects(driver: DbDriver, legacy = false): boolean {
  try {
    const objects = driver.select(
      "SELECT type, name FROM catalog.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const expected = legacy ? LEGACY_TABLES : EXPECTED_TABLES;
    return objects.length === expected.length && objects.every((object, index) =>
      String(object.type) === "table" && String(object.name) === expected[index]);
  } catch {
    return false;
  }
}

function hasExactTableShapes(driver: DbDriver, legacy = false): boolean {
  try {
    return (legacy ? LEGACY_TABLES : EXPECTED_TABLES).every(table => {
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

function hasExactTableDdl(driver: DbDriver, legacy = false): boolean {
  try {
    const rows = driver.select(
      "SELECT name, sql FROM catalog.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const expected = legacy ? LEGACY_DDL : EXPECTED_DDL;
    return rows.length === expected.size && rows.every(row =>
      expected.get(String(row.name)) === normalizeDdl(String(row.sql)));
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

function readPendingRestoreJobs(driver: DbDriver): ArchivePendingJob[] {
  return readCatalogPendingRows(driver).flatMap(row => row.kind === "restore" ? [row.value] : []);
}

function lifecycleStorageKind(kind: PendingTargetLifecycleJob["kind"]): string {
  return `app_lifecycle_${kind}`;
}

function readPendingLifecycleJobs(driver: DbDriver): PendingTargetLifecycleJob[] {
  return readCatalogPendingRows(driver).flatMap(row => row.kind === "lifecycle" ? [row.value] : []);
}

function insertPendingLifecycleJob(driver: DbDriver, job: PendingTargetLifecycleJob): void {
  driver.exec(
    `INSERT INTO catalog.pending_jobs(
       job_id,authority_incarnation_id,app_instance_id,generation_id,namespace_id,
       kind,state,operation_id,source_archive_sha256,source_provenance_id,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [job.jobId, job.authorityIncarnationId, job.target.appInstanceId,
      job.target.generationId, job.target.namespaceId, lifecycleStorageKind(job.kind),
      JSON.stringify(job), job.operationId, job.requestSha256, LIFECYCLE_PROVENANCE,
      job.createdAt, job.createdAt],
  );
}

function readAppLifecycleReceipts(driver: DbDriver): AppLifecycleReceipt[] {
  return readCatalogPendingRows(driver).flatMap(row => row.kind === "receipt" ? [row.value] : []);
}

function storeAppLifecycleReceipt(
  driver: DbDriver,
  receipt: AppLifecycleReceipt,
  selected: SelectedTargetStorage,
  retainedRestoreJob = false,
): void {
  const existing = driver.select(
    "SELECT job_id FROM catalog.pending_jobs WHERE job_id = ?", [receipt.jobId],
  );
  if (existing.length > 1)
    throw new ClayError("E_CATALOG_CONFLICT", "lifecycle receipt identity is ambiguous");
  if (existing.length === 0) {
    if (!retainedRestoreJob && driver.select(
      "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [receipt.jobId],
    ).length !== 0)
      throw new ClayError("E_CATALOG_CONFLICT", "lifecycle request identity was reused");
    if (!retainedRestoreJob) driver.exec(
      "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'job',?)",
      [receipt.jobId, receipt.completedAt],
    );
    driver.exec(
      `INSERT INTO catalog.pending_jobs(
         job_id,authority_incarnation_id,app_instance_id,generation_id,namespace_id,
         kind,state,operation_id,source_archive_sha256,source_provenance_id,created_at,updated_at
       ) VALUES (?,?,?,?,?,'app_lifecycle_receipt',?,?,?,?,?,?)`,
      [receipt.jobId, receipt.authorityIncarnationId,
        receipt.requestedAppInstanceId ?? receipt.resultingSelectedAppInstanceId,
        selected.target.activeGenerationId, selected.namespaceId, JSON.stringify(receipt),
        receipt.operationId, receipt.requestSha256, LIFECYCLE_RECEIPT_PROVENANCE,
        receipt.completedAt, receipt.completedAt],
    );
    return;
  }
  driver.exec(
    `UPDATE catalog.pending_jobs SET
       authority_incarnation_id = ?, app_instance_id = ?, generation_id = ?, namespace_id = ?,
       kind = 'app_lifecycle_receipt', state = ?, operation_id = ?,
       source_archive_sha256 = ?, source_provenance_id = ?, created_at = ?, updated_at = ?
     WHERE job_id = ?`,
    [receipt.authorityIncarnationId,
      receipt.requestedAppInstanceId ?? receipt.resultingSelectedAppInstanceId,
      selected.target.activeGenerationId, selected.namespaceId, JSON.stringify(receipt),
      receipt.operationId, receipt.requestSha256, LIFECYCLE_RECEIPT_PROVENANCE,
      receipt.completedAt, receipt.completedAt, receipt.jobId],
  );
}

function readValidatedCatalog(
  driver: DbDriver,
  options: Readonly<{ allowPendingRestore?: boolean; legacyRetentionMigration?: boolean }> = {},
): AppCatalogSnapshot {
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
      const declaredGeneration = BigInt(job.declaredCatalogGeneration);
      const currentGeneration = BigInt(snapshot.catalogGeneration);
      const interveningEvents = readCatalogGenerationEvents(driver).filter(event =>
        BigInt(event.catalogGeneration) > declaredGeneration);
      if (job.authorityIncarnationId !== snapshot.authorityIncarnationId
          || declaredGeneration > currentGeneration
          || interveningEvents.some(event => event.eventKind !== "lease_issued"
            || event.appInstanceId !== job.expectedTarget.appInstanceId))
        throw new Error("pending lifecycle authority is stale");
      const expectedApp = apps.get(job.expectedTarget.appInstanceId);
      if (!expectedApp || tombstonedApps.has(expectedApp.appInstanceId)
          || snapshot.selectedAppInstanceId !== expectedApp.appInstanceId
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
        if (apps.has(job.target.appInstanceId) || generations.has(job.target.generationId))
          throw new Error("pending lifecycle target is not fresh");
      }
    }
    const lifecycleReceipts = readAppLifecycleReceipts(driver);
    const lifecycleRequestIds = new Set<string>();
    for (const receipt of lifecycleReceipts) {
      if (receipt.authorityIncarnationId !== snapshot.authorityIncarnationId
          || lifecycleRequestIds.has(receipt.requestId))
        throw new Error("lifecycle receipt authority or request identity is invalid");
      lifecycleRequestIds.add(receipt.requestId);
      requireRetained(receipt.jobId, "job");
      requireRetained(receipt.operationId, "operation");
    }
    if (lifecycleJobs.some(job => lifecycleRequestIds.has(job.requestId)))
      throw new Error("lifecycle request is both pending and complete");
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

    const storedBackups = readBackupRecords(driver);
    const backupByOperation = new Map<string, StoredBackupRecord>();
    const backupSeriesGenerations = new Set<string>();
    const backupGenerationIds = new Set<string>();
    const backupFileNames = new Set<string>();
    for (const stored of storedBackups) {
      const { record, operationId } = stored;
      requireRetained(operationId, "operation");
      const app = apps.get(record.evidence.appInstanceId);
      const generation = generations.get(record.evidence.activeGenerationId);
      const matchesGeneration = generation !== undefined
        && sameTarget(record.evidence, generation.target);
      const matchesRevision = reservations.some(reservation =>
        reservation.state === "committed"
        && reservation.appInstanceId === record.evidence.appInstanceId
        && reservation.publishedActiveGenerationId === record.evidence.activeGenerationId
        && reservation.publishedLineageEpoch === record.evidence.lineageEpoch
        && reservation.revision === record.evidence.protectionRevision
        && reservation.stateSha256 === record.evidence.stateSha256);
      const seriesGeneration = `${record.authentication.seriesId}:${record.authentication.generation}`;
      if (!app || !generation || generation.target.appInstanceId !== app.appInstanceId
          || (!matchesGeneration && !matchesRevision)
          || BigInt(record.publicationCatalogGeneration) > BigInt(snapshot.catalogGeneration)
          || backupByOperation.has(operationId)
          || backupSeriesGenerations.has(seriesGeneration)
          || backupGenerationIds.has(record.generationId)
          || backupFileNames.has(record.fileName)
          || catalogEvents.has(record.publicationCatalogGeneration))
        throw new Error("backup record relationship is invalid");
      backupByOperation.set(operationId, stored);
      backupSeriesGenerations.add(seriesGeneration);
      backupGenerationIds.add(record.generationId);
      backupFileNames.add(record.fileName);
      catalogEvents.add(record.publicationCatalogGeneration);
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
      } else if (event.eventKind === "backup_published") {
        const stored = backupByOperation.get(event.operationId!);
        if (!stored || stored.record.evidence.appInstanceId !== event.appInstanceId
            || stored.record.publicationCatalogGeneration !== event.catalogGeneration
            || stored.record.validatedAt !== event.at)
          throw new Error("catalog backup publication event is invalid");
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
    for (const stored of storedBackups) {
      const event = eventByGeneration.get(stored.record.publicationCatalogGeneration);
      if (!event || event.eventKind !== "backup_published"
          || event.operationId !== stored.operationId)
        throw new Error("catalog backup publication event is missing");
    }
    for (const receipt of lifecycleReceipts) {
      const initial = receipt.schema === 2 ? receipt.initialPublication : undefined;
      const event = eventByGeneration.get(initial?.catalogGeneration ?? receipt.completedCatalogGeneration);
      const expectedKind = receipt.kind === "rename" || receipt.kind === "restore_aborted" ? "app_metadata"
        : receipt.kind === "create" || receipt.kind === "fork" || receipt.kind === "restore" ? "app_seed"
          : "app_selected";
      const resultApp = apps.get(receipt.resultingSelectedAppInstanceId);
      if (!event || event.eventKind !== expectedKind
          || event.operationId !== receipt.operationId
          || event.appInstanceId !== receipt.resultingSelectedAppInstanceId
          || (!initial && event.at !== receipt.completedAt) || !resultApp)
        throw new Error("lifecycle receipt does not match its catalog event");
      assertLifecycleReattestation(receipt, readCatalogGenerationEvents(driver), readRevisionReservations(driver));
      if ((receipt.kind === "switch" || receipt.kind === "rename")
          && receipt.requestedAppInstanceId !== receipt.resultingSelectedAppInstanceId)
        throw new Error("lifecycle receipt selected the wrong requested app");
      if (receipt.kind === "delete"
          && (!receipt.requestedAppInstanceId
            || !tombstonedApps.has(receipt.requestedAppInstanceId)))
        throw new Error("lifecycle deletion receipt does not retain its victim");
      if (receipt.kind === "create" || receipt.kind === "fork") {
        const generation = generations.get(resultApp.activeGenerationId);
        if (!generation
            || (receipt.kind === "create" && generation.sourceProvenanceId !== null)
            || (receipt.kind === "fork" && generation.sourceProvenanceId === null))
          throw new Error("lifecycle creation receipt has invalid provenance");
      }
      const receiptRows = driver.select(
        "SELECT generation_id,namespace_id FROM catalog.pending_jobs WHERE job_id = ?",
        [receipt.jobId],
      );
      const storedGeneration = receiptRows[0]
        ? generations.get(String(receiptRows[0].generation_id)) : undefined;
      if (receiptRows.length !== 1 || !storedGeneration
          || storedGeneration.namespaceId !== String(receiptRows[0]!.namespace_id)
          || storedGeneration.target.appInstanceId !== receipt.resultingSelectedAppInstanceId)
        throw new Error("lifecycle receipt storage relationship is invalid");
    }
    if (!options.legacyRetentionMigration) {
      const history = readBackupRetentionHistory(driver);
      assertBackupRetentionHistory(history, storedBackups.map(item => item.record), snapshot.authorityIncarnationId,
        snapshot.catalogGeneration, [...leases].map(([leaseId, lease]) => ({ leaseId, ...lease })), generationEvents);
      const requestIds = new Set(driver.select("SELECT request_id FROM catalog.production_request_receipts").map(row => String(row.request_id)));
      for (const event of history.events) {
        if (requestIds.has(event.requestId) || lifecycleRequestIds.has(event.requestId)
            || lifecycleJobs.some(job => job.requestId === event.requestId)) throw new Error("retention request identity was reused");
        requireRetained(event.operationId, "operation");
      }
    }
    for (const row of driver.select("SELECT * FROM catalog.production_request_receipts")) {
      const receipt = parseProductionRequestReceiptRow(row);
      // Older catalogs did not retain no-op operation IDs. Preserve their read
      // path; the guarded additive migration repairs only these exact rows.
      if (receipt.state === "no_op" && retained.has(receipt.operationId)) requireRetained(receipt.operationId, "operation");
    }
    for (const [value, kind] of retained) {
      if (kind !== "job" && !referenced.has(value))
        throw new Error(`unreferenced retained ${kind} identity`);
    }
    const pendingRestores = readPendingRestoreJobs(driver);
    if (pendingRestores.length > (options.allowPendingRestore ? 1 : 0)
        || (pendingRestores.length > 0 && lifecycleJobs.length > 0))
      throw new Error("unsupported catalog work is present");
    for (const job of pendingRestores) {
      if (job.authorityIncarnationId !== snapshot.authorityIncarnationId
          || snapshot.entries.some(entry => entry.appInstanceId === job.appInstanceId)
          || [job.appInstanceId!, job.generationId, job.namespaceId, job.operationId]
            .some(value => retained.has(value))
          || retained.get(job.jobId) !== "job")
        throw new Error("pending restore job relationship is invalid");
      if (job.schema === 2 && job.intent) {
        const source = snapshot.entries.find(entry => entry.appInstanceId === job.intent!.sourceTarget.appInstanceId);
        if (!source || snapshot.selectedAppInstanceId !== source.appInstanceId
            || source.activeGenerationId !== job.intent.sourceTarget.activeGenerationId
            || source.currentLineageEpoch !== job.intent.sourceTarget.lineageEpoch
            || source.currentProtectionRevision !== job.intent.sourceTarget.protectionRevision
            || source.stateSha256 !== job.intent.sourceTarget.stateSha256)
          throw new Error("pending restore source binding is stale");
      }
      referenced.add(job.jobId);
    }
    const unfinishedLineages = driver.select(
      "SELECT count(*) AS count FROM catalog.lineage_reservations",
    );
    if (unfinishedLineages.length !== 1 || Number(unfinishedLineages[0]!.count) !== 0)
      throw new Error("unsupported catalog work is present");
    return snapshot;
  } catch {
    throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog relationships failed validation");
  }
}

function missingNoOpIdentities(driver: DbDriver) {
  const retained = new Set(driver.select("SELECT id_value FROM catalog.id_registry").map(row => row.id_value));
  return driver.select("SELECT * FROM catalog.production_request_receipts").map(parseProductionRequestReceiptRow)
    .filter(receipt => receipt.state === "no_op" && !retained.has(receipt.operationId));
}
function migrateNoOpIdentities(driver: DbDriver): void {
  for (const receipt of missingNoOpIdentities(driver)) driver.exec(
    "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'operation',?)",
    [receipt.operationId, receipt.preparedAt],
  );
}

export class DeviceCatalog {
  private constructor(
    private readonly driver: DbDriver,
    private readonly allowPendingRestore = false,
    private readonly legacyRetentionMigration = false,
  ) {}

  static isAbsent(driver: DbDriver): boolean {
    return catalogTables(driver).length === 0;
  }
  static needsBackupRetentionMigration(driver: DbDriver): boolean {
    const legacy = hasExactSchema(catalogTables(driver), true);
    if (!hasExactSchema(catalogTables(driver), legacy) || !hasOnlyExpectedObjects(driver, legacy)
        || !hasExactTableShapes(driver, legacy) || !hasExactTableDdl(driver, legacy))
      throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog is not a known retention schema");
    return legacy || missingNoOpIdentities(driver).length > 0;
  }

  /** Boot-only additive migration under the worker's write capability and
   * physical lifecycle exclusion. No selected app, lease or publication changes. */
  static migrateBackupRetention(driver: DbDriver): void {
    const exact = (legacy: boolean) => hasExactSchema(catalogTables(driver), legacy)
      && hasOnlyExpectedObjects(driver, legacy) && hasExactTableShapes(driver, legacy) && hasExactTableDdl(driver, legacy);
    if (exact(false)) {
      driver.tx(() => {
        const before = readValidatedCatalog(driver, { allowPendingRestore: true });
        migrateNoOpIdentities(driver);
        if (JSON.stringify(readValidatedCatalog(driver, { allowPendingRestore: true })) !== JSON.stringify(before))
          throw new ClayError("E_CATALOG_CONFLICT", "no-op identity migration changed source data");
      });
      return;
    }
    if (!exact(true)) throw new ClayError("E_CATALOG_UNAVAILABLE", "legacy catalog is not the exact migration source");
    driver.tx(() => {
      if (!exact(true)) throw new ClayError("E_CATALOG_CONFLICT", "catalog changed before retention migration");
      const before = readValidatedCatalog(driver, { allowPendingRestore: true, legacyRetentionMigration: true });
      for (const ddl of BACKUP_RETENTION_DDL) driver.exec(ddl);
      driver.exec("INSERT INTO catalog.backup_retention_root(singleton,schema_version,revision) VALUES (1,1,'0')");
      migrateNoOpIdentities(driver);
      if (JSON.stringify(readValidatedCatalog(driver, { allowPendingRestore: true })) !== JSON.stringify(before))
        throw new ClayError("E_CATALOG_CONFLICT", "retention migration changed the source catalog");
    });
  }

  static openExisting(driver: DbDriver): DeviceCatalog {
    if (!hasExactSchema(catalogTables(driver)) || !hasOnlyExpectedObjects(driver)
        || !hasExactTableShapes(driver) || !hasExactTableDdl(driver))
      throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog schema is unavailable");
    readValidatedCatalog(driver);
    return new DeviceCatalog(driver);
  }

  /** Recovery-only view used before deleting an unpublished restore namespace. */
  static openForRestoreRecovery(driver: DbDriver): DeviceCatalog {
    if (!hasExactSchema(catalogTables(driver)) || !hasOnlyExpectedObjects(driver)
        || !hasExactTableShapes(driver) || !hasExactTableDdl(driver))
      throw new ClayError("E_CATALOG_UNAVAILABLE", "authoritative catalog schema is unavailable");
    readValidatedCatalog(driver, { allowPendingRestore: true });
    return new DeviceCatalog(driver, true);
  }

  /** Closed READ-ONLY owner view before boot migration. A hot legacy catalog
   * must be validated in its original shape; adding tables on the shadow first
   * would manufacture the proof for the real rollback. No writer escapes here. */
  static originalNativePreflight(driver: DbDriver) {
    const legacy = hasExactSchema(catalogTables(driver), true);
    if (!hasExactSchema(catalogTables(driver), legacy) || !hasOnlyExpectedObjects(driver, legacy)
        || !hasExactTableShapes(driver, legacy) || !hasExactTableDdl(driver, legacy))
      throw new ClayError("E_CATALOG_UNAVAILABLE", "original native catalog schema is unavailable");
    readValidatedCatalog(driver, { allowPendingRestore: true, legacyRetentionMigration: legacy });
    const view = new DeviceCatalog(driver, true, legacy);
    return Object.freeze({ snapshot: () => view.snapshot(), activeTargetStorageInventory: () => view.activeTargetStorageInventory(),
      pendingRestoreJobs: () => view.pendingRestoreJobs(), pendingLifecycleJobs: () => view.pendingLifecycleJobs() });
  }

  static initializeFresh(driver: DbDriver): DeviceCatalog {
    if (catalogTables(driver).length !== 0)
      throw new ClayError("E_CATALOG_CONFLICT", "authoritative catalog is already initialized");
    const authorityIncarnationId = mintOpaqueId("auth");
    try {
      driver.tx(() => {
        for (const ddl of CATALOG_DDL) driver.exec(ddl);
        driver.exec("INSERT INTO catalog.backup_retention_root(singleton,schema_version,revision) VALUES (1,1,'0')");
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
    return readValidatedCatalog(
      this.driver, { allowPendingRestore: this.allowPendingRestore, legacyRetentionMigration: this.legacyRetentionMigration },
    );
  }

  hasOnlyLeaseSuffix(generation: string, appInstanceId: string): boolean {
    if (!UInt64Decimal.safeParse(generation).success) return false;
    const current = this.snapshot();
    if (current.selectedAppInstanceId !== appInstanceId || BigInt(generation) > BigInt(current.catalogGeneration)) return false;
    const events = readCatalogGenerationEvents(this.driver);
    if (!events.some(event => event.catalogGeneration === generation)) return false;
    return events.every(event =>
      BigInt(event.catalogGeneration) <= BigInt(generation)
      || (event.eventKind === "lease_issued" && event.appInstanceId === appInstanceId));
  }

  pendingRestoreJobs(): ArchivePendingJob[] {
    this.snapshot();
    return readPendingRestoreJobs(this.driver).map(job => Object.freeze({ ...job }));
  }

  beginRestoreJob(input: Readonly<{
    jobId: string;
    appInstanceId: string;
    generationId: string;
    namespaceId: string;
    operationId: string;
    sourceArchiveSha256: string;
    sourceProvenanceId: string;
    expectedCatalogGeneration: string;
    expectedSourceTarget: TargetEvidence;
    fence: WriteFence;
    nowMs: number;
    intent?: CatalogRestoreJobV2["intent"];
  }>): ArchivePendingJob {
    const at = validClockValue(input.nowMs) ? new Date(input.nowMs).toISOString() : "";
    const jobResult = ArchivePendingJobV1.safeParse({
      schema: 1,
      jobId: input.jobId,
      authorityIncarnationId: input.fence.authorityIncarnationId,
      appInstanceId: input.appInstanceId,
      generationId: input.generationId,
      namespaceId: input.namespaceId,
      kind: "restore_as_new",
      state: "prepared",
      operationId: input.operationId,
      sourceArchiveSha256: input.sourceArchiveSha256,
      sourceProvenanceId: input.sourceProvenanceId,
      createdAt: at,
      updatedAt: at,
    });
    const expected = TargetEvidenceV1.safeParse(input.expectedSourceTarget);
    if (!jobResult.success || !expected.success
        || !UInt64Decimal.safeParse(input.expectedCatalogGeneration).success)
      throw new ClayError("E_CATALOG_CONFLICT", "pending restore input is invalid");
    const job = input.intent ? CatalogRestoreJobV2.parse({ ...jobResult.data, schema: 2,
      phase: "install", fence: input.fence, intent: input.intent }) : jobResult.data;
    return this.driver.tx(() => {
      const before = readValidatedCatalog(this.driver);
      this.assertWriteFence(input.fence, input.nowMs);
      if (before.catalogGeneration !== input.expectedCatalogGeneration
          || before.selectedAppInstanceId !== expected.data.appInstanceId
          || !sameTarget(this.selectedTargetStorage().target, expected.data))
        throw new ClayError("E_GENERATION_NOT_SELECTED", "pending restore source is stale");
      const destinationIds = [
        jobResult.data.jobId,
        jobResult.data.appInstanceId!,
        jobResult.data.generationId,
        jobResult.data.namespaceId,
        jobResult.data.operationId,
      ];
      if (this.driver.select(
        `SELECT id_value FROM catalog.id_registry
         WHERE id_value IN (${destinationIds.map(() => "?").join(",")})`,
        destinationIds,
      ).length !== 0)
        throw new ClayError("E_CATALOG_CONFLICT", "pending restore identity was already retained");
      this.driver.exec(
        "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?, 'job', ?)",
        [jobResult.data.jobId, at],
      );
      this.driver.exec(
        `INSERT INTO catalog.pending_jobs(
           job_id,authority_incarnation_id,app_instance_id,generation_id,namespace_id,
           kind,state,operation_id,source_archive_sha256,source_provenance_id,created_at,updated_at
         ) VALUES (?,?,?,?,?,'restore_as_new',?,?,?,?,?,?)`,
        [jobResult.data.jobId, jobResult.data.authorityIncarnationId,
          jobResult.data.appInstanceId, jobResult.data.generationId, jobResult.data.namespaceId,
          job.schema === 2 ? JSON.stringify(job) : "prepared", jobResult.data.operationId, jobResult.data.sourceArchiveSha256,
          jobResult.data.sourceProvenanceId, at, at],
      );
      readValidatedCatalog(this.driver, { allowPendingRestore: true });
      const stored = readPendingRestoreJobs(this.driver);
      if (stored.length !== 1 || JSON.stringify(stored[0]) !== JSON.stringify(job))
        throw new ClayError("E_CATALOG_CONFLICT", "pending restore failed durable read-back");
      return Object.freeze({ ...stored[0]! });
    });
  }

  clearPendingRestoreJob(jobId: string): void {
    if (!this.allowPendingRestore || !/^job_[a-z2-7]{26}$/.test(jobId))
      throw new ClayError("E_CATALOG_CONFLICT", "pending restore cleanup is invalid");
    this.driver.tx(() => {
      readValidatedCatalog(this.driver, { allowPendingRestore: true });
      const jobs = readPendingRestoreJobs(this.driver);
      if (jobs.length !== 1 || jobs[0]!.jobId !== jobId)
        throw new ClayError("E_CATALOG_CONFLICT", "pending restore cleanup target changed");
      this.driver.exec("DELETE FROM catalog.pending_jobs WHERE job_id = ?", [jobId]);
      readValidatedCatalog(this.driver);
    });
  }

  claimRestoreRecovery(expectedJob: ArchivePendingJob, fence: WriteFence, nowMs: number): CatalogRestoreJobV2 {
    return this.driver.tx(() => {
      this.assertWriteFence(fence, nowMs);
      const job = this.pendingRestoreJobs().find(item => item.jobId === expectedJob.jobId);
      if (!job || JSON.stringify(job) !== JSON.stringify(expectedJob))
        throw new ClayError("E_CATALOG_CONFLICT", "restore recovery claim lost to publication or another recovery");
      const claimed = CatalogRestoreJobV2.parse({ ...job, schema: 2, phase: "cleanup", fence });
      this.driver.exec("UPDATE catalog.pending_jobs SET state = ? WHERE job_id = ?",
        [JSON.stringify(claimed), job.jobId]);
      this.assertRestoreClaim(claimed, fence, nowMs, "cleanup");
      return claimed;
    });
  }

  assertRestoreClaim(job: CatalogRestoreJobV2, fence: WriteFence, nowMs: number, phase: "install" | "cleanup"): void {
    this.assertWriteFence(fence, nowMs);
    const pending = this.pendingRestoreJobs().find(item => item.jobId === job.jobId);
    if (!pending || JSON.stringify(pending) !== JSON.stringify(job) || job.phase !== phase
        || JSON.stringify(job.fence) !== JSON.stringify(fence))
      throw new ClayError("E_CATALOG_CONFLICT", "restore claim is stale; publication or recovery won");
  }

  finishRestoreCleanup(job: CatalogRestoreJobV2, fence: WriteFence, nowMs: number): void {
    this.driver.tx(() => {
      this.assertRestoreClaim(job, fence, nowMs, "cleanup");
      const selected = this.selectedTargetStorage();
      const before = this.snapshot();
      const app = before.entries.find(entry => entry.appInstanceId === selected.target.appInstanceId)!;
      this.clearPendingRestoreJob(job.jobId);
      if (!job.intent) return; // Legacy job has no replayable user request.
      const after = DeviceCatalog.openExisting(this.driver).updateSelectedAppMetadata({
        recordNoop: true, expectedCatalogGeneration: before.catalogGeneration,
        displayName: app.displayName, shellId: app.shellId, operationId: job.operationId, fence, nowMs,
      });
      storeAppLifecycleReceipt(this.driver, AppLifecycleReceiptV1.parse({
        schema: 2, kind: "restore_aborted", jobId: job.jobId, authorityIncarnationId: before.authorityIncarnationId,
        requestId: job.intent.requestId, requestSha256: job.intent.requestSha256, operationId: job.operationId,
        requestedAppInstanceId: null, resultingSelectedAppInstanceId: selected.target.appInstanceId,
        resultTarget: selected.target, resultDisplayName: app.displayName, resultShellId: app.shellId,
        completedCatalogGeneration: after.catalogGeneration, completedAt: new Date(nowMs).toISOString(),
      }), selected, true);
      readValidatedCatalog(this.driver);
    });
  }

  activeTargetStorageInventory(): SelectedTargetStorage[] {
    return this.driver.tx(() => {
      const snapshot = readValidatedCatalog(
        this.driver, { allowPendingRestore: this.allowPendingRestore, legacyRetentionMigration: this.legacyRetentionMigration },
      );
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
      const snapshot = readValidatedCatalog(
        this.driver, { allowPendingRestore: this.allowPendingRestore },
      );
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
    this.snapshot();
    return readPendingLifecycleJobs(this.driver).map(job => ({
      ...job,
      expectedTarget: { ...job.expectedTarget },
      target: { ...job.target },
    }));
  }

  appLifecycleReceipt(requestId: string): AppLifecycleReceipt | null {
    const parsed = RequestId.safeParse(requestId);
    if (!parsed.success)
      throw new ClayError("E_CATALOG_CONFLICT", "lifecycle request identity is invalid");
    readValidatedCatalog(this.driver);
    const receipt = readAppLifecycleReceipts(this.driver)
      .find(candidate => candidate.requestId === parsed.data);
    return receipt ? { ...receipt } : null;
  }

  /** Original-owner history only. Absence, an unfinished unlink, an old active
   * generation, or another app's delete receipt never means terminal exclusion. */
  completedOwnerRetirement(appInstanceId: string, generationId: string): AppLifecycleReceipt | null {
    AppInstanceId.parse(appInstanceId); GenerationId.parse(generationId);
    readValidatedCatalog(this.driver);
    const rows = this.driver.select(`SELECT a.tombstoned,a.active_generation_id,g.app_instance_id FROM catalog.app_entries a
      JOIN catalog.generations g ON g.generation_id=a.active_generation_id WHERE a.app_instance_id=? AND g.generation_id=?`, [appInstanceId, generationId]);
    if (rows.length !== 1 || rows[0]!.tombstoned !== 1 || rows[0]!.app_instance_id !== appInstanceId) return null;
    const receipts = readAppLifecycleReceipts(this.driver).filter(receipt => receipt.schema === 2 && receipt.kind === "delete" && receipt.requestedAppInstanceId === appInstanceId);
    return receipts.length === 1 ? receipts[0]! : null;
  }

  assertAppLifecycleReplay(receipt: AppLifecycleReceipt): AppLifecycleReceipt {
    if (receipt.schema !== 2)
      throw new ClayError("E_CATALOG_CONFLICT", "historical lifecycle receipt lacks canonical replay evidence; the app was kept");
    const snapshot = this.snapshot();
    const stored = this.appLifecycleReceipt(receipt.requestId);
    const selected = this.selectedTargetStorage().target;
    const entry = snapshot.entries.find(app => app.appInstanceId === selected.appInstanceId);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(receipt)
        || !sameTarget(selected, receipt.resultTarget)
        || !entry || entry.displayName !== receipt.resultDisplayName || entry.shellId !== receipt.resultShellId
        || readCatalogGenerationEvents(this.driver).some(event =>
          BigInt(event.catalogGeneration) > BigInt(receipt.completedCatalogGeneration)
          && (event.eventKind !== "lease_issued" || event.appInstanceId !== selected.appInstanceId)))
      throw new ClayError("E_CATALOG_CONFLICT", "lifecycle replay result is stale; reconcile the current catalog");
    return AppLifecycleReceiptV1.parse(stored);
  }

  finalizeLifecycleReattestation(requestId: string, reattestationRequestId: string, nowMs: number): void {
    this.driver.tx(() => {
      const receipt = this.appLifecycleReceipt(requestId);
      if (!receipt || receipt.schema !== 2 || (receipt.kind !== "restore" && receipt.kind !== "fork") || receipt.initialPublication)
        throw new ClayError("E_CATALOG_CONFLICT", "fresh lifecycle receipt is unavailable");
      const target = this.selectedTargetStorage();
      const final = AppLifecycleReceiptV1.parse({ ...receipt,
        initialPublication: { catalogGeneration: receipt.completedCatalogGeneration, target: receipt.resultTarget, reattestationRequestId },
        resultTarget: target.target, completedCatalogGeneration: this.snapshot().catalogGeneration,
        completedAt: new Date(nowMs).toISOString(),
      });
      assertLifecycleReattestation(final, readCatalogGenerationEvents(this.driver), readRevisionReservations(this.driver));
      storeAppLifecycleReceipt(this.driver, final, target);
      readValidatedCatalog(this.driver);
    });
  }

  recordAppLifecycleReceipt(
    input: RecordAppLifecycleReceiptInput,
  ): AppLifecycleReceipt {
    const requestId = RequestId.safeParse(input.requestId);
    const requestSha256 = Sha256.safeParse(input.requestSha256);
    const operationId = OperationId.safeParse(input.operationId);
    const expectedGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const requestedApp = AppInstanceId.safeParse(input.requestedAppInstanceId);
    if (!requestId.success || !requestSha256.success || !operationId.success
        || !expectedGeneration.success || !requestedApp.success
        || !/^job_[a-z2-7]{26}$/.test(input.jobId)
        || (input.kind !== "switch" && input.kind !== "rename"))
      throw new ClayError("E_CATALOG_CONFLICT", "lifecycle receipt is invalid");
    return this.driver.tx(() => {
      const before = readValidatedCatalog(this.driver);
      const existing = readAppLifecycleReceipts(this.driver)
        .find(candidate => candidate.requestId === requestId.data);
      if (existing) {
        if (existing.requestSha256 !== requestSha256.data
            || existing.operationId !== operationId.data || existing.kind !== input.kind
            || existing.jobId !== input.jobId
            || existing.requestedAppInstanceId !== requestedApp.data
            || existing.resultingSelectedAppInstanceId !== requestedApp.data
            || existing.completedCatalogGeneration !== expectedGeneration.data
            || existing.completedAt !== input.completedAt)
          throw new ClayError("E_CATALOG_CONFLICT", "lifecycle request identity was reused");
        return this.assertAppLifecycleReplay(existing);
      }
      if (readPendingLifecycleJobs(this.driver)
        .some(job => job.requestId === requestId.data))
        throw new ClayError("E_CATALOG_CONFLICT", "lifecycle request is still pending");
      const selected = this.selectedTargetStorage();
      const metadata = before.entries.find(app => app.appInstanceId === selected.target.appInstanceId)!;
      const receipt = AppLifecycleReceiptV1.safeParse({
        schema: 2,
        kind: input.kind,
        jobId: input.jobId,
        authorityIncarnationId: before.authorityIncarnationId,
        requestId: requestId.data,
        requestSha256: requestSha256.data,
        operationId: operationId.data,
        requestedAppInstanceId: requestedApp.data,
        resultingSelectedAppInstanceId: selected.target.appInstanceId,
        resultTarget: selected.target,
        resultDisplayName: metadata.displayName,
        resultShellId: metadata.shellId,
        completedCatalogGeneration: before.catalogGeneration,
        completedAt: input.completedAt,
      });
      const event = readCatalogGenerationEvents(this.driver).at(-1);
      const expectedEvent = input.kind === "switch" ? "app_selected" : "app_metadata";
      if (!receipt.success || before.catalogGeneration !== expectedGeneration.data
          || selected.target.appInstanceId !== requestedApp.data
          || !event || event.eventKind !== expectedEvent
          || event.operationId !== operationId.data || event.at !== input.completedAt)
        throw new ClayError("E_CATALOG_CONFLICT", "lifecycle receipt event is stale");
      storeAppLifecycleReceipt(this.driver, receipt.data, selected);
      readValidatedCatalog(this.driver);
      const persisted = readAppLifecycleReceipts(this.driver)
        .find(candidate => candidate.requestId === requestId.data);
      if (!persisted || JSON.stringify(persisted) !== JSON.stringify(receipt.data))
        throw new ClayError("E_CATALOG_CONFLICT", "lifecycle receipt failed read-back");
      return { ...persisted };
    });
  }

  declareAppGeneration(input: DeclareAppGenerationInput): PendingTargetLifecycleJob {
    const expectedCatalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const expectedTarget = TargetEvidenceV1.safeParse(input.expectedTarget);
    const fence = WriteFenceV1.safeParse(input.fence);
    if (!expectedCatalogGeneration.success || !expectedTarget.success || !fence.success
        || !["create", "fork"].includes(input.kind) || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration is invalid");
    let createdAt: string;
    try { createdAt = new Date(input.nowMs).toISOString(); }
    catch {
      throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration time is invalid");
    }
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
            requestId: input.requestId,
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
            || readPendingRestoreJobs(this.driver).length !== 0
            || readRevisionReservations(this.driver).some(item => item.state === "reserved"))
          throw new ClayError("E_CATALOG_CONFLICT", "app generation declaration CAS is stale");
        const job = PendingTargetLifecycleJobV1.safeParse({
          schema: 1,
          kind: input.kind,
          jobId: input.jobId,
          authorityIncarnationId: before.authorityIncarnationId,
          requestId: input.requestId,
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          declaredCatalogGeneration: before.catalogGeneration,
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
            job.data.target.generationId, job.data.target.namespaceId,
            job.data.operationId, job.data.target.displayName, job.data.target.shellId, createdAt],
        );
        insertPendingLifecycleJob(this.driver, job.data);
        readValidatedCatalog(this.driver);
        const persisted = readPendingLifecycleJobs(this.driver);
        if (persisted.length !== 1 || JSON.stringify(persisted[0]) !== JSON.stringify(job.data))
          throw new ClayError("E_CATALOG_CONFLICT", "lifecycle declaration failed read-back");
        return persisted[0]!;
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "app generation declaration failed");
    }
  }

  /** Transactionally takes over one exact pending job before any physical unlink. */
  claimPendingLifecycleRecovery(input: {
    expectedJob: PendingTargetLifecycleJob; fence: WriteFence; nowMs: number;
  }): PendingTargetLifecycleJob {
    return this.driver.tx(() => {
      readValidatedCatalog(this.driver);
      this.assertWriteFence(input.fence, input.nowMs);
      const persisted = readPendingLifecycleJobs(this.driver).find(job => job.jobId === input.expectedJob.jobId);
      if (!persisted || JSON.stringify(persisted) !== JSON.stringify(input.expectedJob)
          || !sameTarget(this.selectedTargetStorage().target, persisted.expectedTarget)
          || this.snapshot().entries.some(app => app.appInstanceId === persisted.target.appInstanceId
            || app.activeGenerationId === persisted.target.generationId))
        throw new ClayError("E_CATALOG_CONFLICT", "pending lifecycle recovery claim is stale");
      const claimed = PendingTargetLifecycleJobV1.parse({ ...persisted, recoveryFence: input.fence });
      this.driver.exec("UPDATE catalog.pending_jobs SET state = ? WHERE job_id = ? AND state = ?",
        [JSON.stringify(claimed), claimed.jobId, JSON.stringify(persisted)]);
      this.assertLifecycleRecoveryClaim(claimed, input.fence, input.nowMs);
      return claimed;
    });
  }

  assertLifecycleRecoveryClaim(job: PendingTargetLifecycleJob, fence: WriteFence, nowMs: number): void {
    this.assertWriteFence(fence, nowMs);
    const persisted = this.pendingLifecycleJobs().find(item => item.jobId === job.jobId);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(job)
        || JSON.stringify(job.recoveryFence) !== JSON.stringify(fence))
      throw new ClayError("E_CATALOG_CONFLICT", "pending lifecycle recovery claim is stale");
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
    catch {
      throw new ClayError("E_CATALOG_CONFLICT", "app generation publication time is invalid");
    }
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        this.assertWriteFence(fence.data, input.nowMs);
        const job = readPendingLifecycleJobs(this.driver)
          .find(candidate => candidate.jobId === input.jobId);
        if (!job || job.kind === "cleanup"
            || (job.recoveryFence && JSON.stringify(job.recoveryFence) !== JSON.stringify(fence.data))
            || before.catalogGeneration !== expectedCatalogGeneration.data
            || before.authorityIncarnationId !== fence.data.authorityIncarnationId
            || before.writeEpoch !== fence.data.writeEpoch
            || !sameTarget(this.selectedTargetStorage().target, job.expectedTarget)
            || publishedTarget.data.appInstanceId !== job.target.appInstanceId
            || publishedTarget.data.activeGenerationId !== job.target.generationId
            || publishedTarget.data.lineageEpoch !== "0"
            || publishedTarget.data.protectionRevision !== "0"
            || publishedTarget.data.digestSchema !== 1)
          throw new ClayError("E_CATALOG_CONFLICT", "app generation publication CAS is stale");
        const sourceRows = this.driver.select(
          "SELECT operation_id FROM catalog.generations WHERE generation_id = ?",
          [job.expectedTarget.activeGenerationId],
        );
        if (sourceRows.length !== 1 || typeof sourceRows[0]!.operation_id !== "string")
          throw new ClayError("E_CATALOG_CONFLICT", "lifecycle source generation is unavailable");
        const sourceProvenanceId = job.kind === "fork"
          ? String(sourceRows[0]!.operation_id) : null;
        this.driver.exec(
          `INSERT INTO catalog.generations(
             generation_id,app_instance_id,namespace_id,storage_key,operation_id,
             lineage_epoch,first_revision,digest_schema,state_sha256,
             source_archive_sha256,source_provenance_id,sealed_at,read_back_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [job.target.generationId, job.target.appInstanceId, job.target.namespaceId,
            job.target.storageKey, job.operationId, publishedTarget.data.lineageEpoch,
            publishedTarget.data.protectionRevision, publishedTarget.data.digestSchema,
            publishedTarget.data.stateSha256, null, sourceProvenanceId, publishedAt, publishedAt],
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
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: nextCatalogGeneration,
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
          [nextCatalogGeneration, job.target.appInstanceId, before.authorityIncarnationId,
            before.catalogGeneration, before.selectedAppInstanceId, before.writeEpoch],
        );
        const receipt = AppLifecycleReceiptV1.parse({
          schema: 2,
          kind: job.kind,
          jobId: job.jobId,
          authorityIncarnationId: before.authorityIncarnationId,
          requestId: job.requestId,
          requestSha256: job.requestSha256,
          operationId: job.operationId,
          requestedAppInstanceId: null,
          resultingSelectedAppInstanceId: job.target.appInstanceId,
          resultTarget: publishedTarget.data,
          resultDisplayName: job.target.displayName,
          resultShellId: job.target.shellId,
          completedCatalogGeneration: nextCatalogGeneration,
          completedAt: publishedAt,
        });
        storeAppLifecycleReceipt(this.driver, receipt, {
          target: publishedTarget.data,
          namespaceId: job.target.namespaceId,
          storageKey: job.target.storageKey,
        });
        const after = readValidatedCatalog(this.driver);
        const entry = after.entries.find(candidate =>
          candidate.appInstanceId === job.target.appInstanceId);
        if (!entry || after.catalogGeneration !== nextCatalogGeneration
            || after.selectedAppInstanceId !== job.target.appInstanceId
            || entry.activeGenerationId !== job.target.generationId
            || entry.stateSha256 !== publishedTarget.data.stateSha256
            || readPendingLifecycleJobs(this.driver).some(candidate => candidate.jobId === job.jobId)
            || readAppLifecycleReceipts(this.driver)
              .filter(candidate => candidate.requestId === job.requestId).length !== 1
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
            || this.legacyBootstrapManifest().length !== 0
            || readPendingLifecycleJobs(this.driver).length !== 0
            || readPendingRestoreJobs(this.driver).length !== 0
            || readRevisionReservations(this.driver).some(item => item.state === "reserved"))
          throw new ClayError("E_CATALOG_CONFLICT", "app deletion CAS is stale");
        if (before.entries.length < 2)
          throw new ClayError("E_CATALOG_CONFLICT", "the last live app cannot be deleted");
        const victim = before.entries.find(entry =>
          entry.appInstanceId === expectedTarget.data.appInstanceId);
        const fallback = [...before.entries]
          .filter(entry => entry.appInstanceId !== expectedTarget.data.appInstanceId)
          .sort((left, right) => left.appInstanceId.localeCompare(right.appInstanceId))[0];
        if (!victim || !fallback)
          throw new ClayError("E_CATALOG_CONFLICT", "the last live app cannot be deleted");
        const victimStorage = this.selectedTargetStorage();
        const victimPhysical = physicalNamespaceEntry(
          victimStorage.storageKey, victimStorage.namespaceId,
        );
        const fallbackTarget: TargetEvidence = {
          appInstanceId: fallback.appInstanceId,
          activeGenerationId: fallback.activeGenerationId,
          lineageEpoch: fallback.currentLineageEpoch,
          protectionRevision: fallback.currentProtectionRevision,
          digestSchema: fallback.digestSchema,
          stateSha256: fallback.stateSha256,
        };
        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        const cleanupJob = PendingTargetLifecycleJobV1.safeParse({
          schema: 1,
          kind: "cleanup",
          jobId: input.jobId,
          authorityIncarnationId: before.authorityIncarnationId,
          requestId: input.requestId,
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          declaredCatalogGeneration: nextCatalogGeneration,
          expectedTarget: fallbackTarget,
          target: {
            appInstanceId: victim.appInstanceId,
            generationId: victimStorage.target.activeGenerationId,
            namespaceId: victimStorage.namespaceId,
            storageKey: victimStorage.storageKey,
            userFile: victimPhysical.userFile,
            systemFile: victimPhysical.systemFile,
            storageKind: victimPhysical.kind,
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
        insertPendingLifecycleJob(this.driver, cleanupJob.data);
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: nextCatalogGeneration,
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
          [nextCatalogGeneration, fallback.appInstanceId, before.authorityIncarnationId,
            before.catalogGeneration, before.selectedAppInstanceId, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const persisted = readPendingLifecycleJobs(this.driver)
          .find(job => job.jobId === cleanupJob.data.jobId);
        if (!persisted || after.catalogGeneration !== nextCatalogGeneration
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
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        this.assertWriteFence(fence.data, input.nowMs);
        const job = readPendingLifecycleJobs(this.driver)
          .find(candidate => candidate.jobId === input.jobId && candidate.kind === "cleanup");
        if (!job || (job.recoveryFence && JSON.stringify(job.recoveryFence) !== JSON.stringify(fence.data))
            || before.catalogGeneration !== expectedCatalogGeneration.data
            || before.authorityIncarnationId !== fence.data.authorityIncarnationId
            || before.writeEpoch !== fence.data.writeEpoch
            || !sameTarget(this.selectedTargetStorage().target, job.expectedTarget)
            || before.entries.some(entry =>
              entry.activeGenerationId === job.target.generationId
              || entry.appInstanceId === job.target.appInstanceId))
          throw new ClayError("E_CATALOG_CONFLICT", "lifecycle cleanup CAS is stale");
        const selected = this.selectedTargetStorage();
        const metadata = before.entries.find(app => app.appInstanceId === selected.target.appInstanceId)!;
        const receipt = AppLifecycleReceiptV1.parse({
          schema: 2,
          kind: "delete",
          jobId: job.jobId,
          authorityIncarnationId: job.authorityIncarnationId,
          requestId: job.requestId,
          requestSha256: job.requestSha256,
          operationId: job.operationId,
          requestedAppInstanceId: job.target.appInstanceId,
          resultingSelectedAppInstanceId: job.expectedTarget.appInstanceId,
          resultTarget: selected.target,
          resultDisplayName: metadata.displayName,
          resultShellId: metadata.shellId,
          completedCatalogGeneration: job.declaredCatalogGeneration,
          completedAt: job.createdAt,
        });
        storeAppLifecycleReceipt(this.driver, receipt, selected);
        const after = readValidatedCatalog(this.driver);
        if (after.catalogGeneration !== before.catalogGeneration
            || after.selectedAppInstanceId !== before.selectedAppInstanceId
            || readPendingLifecycleJobs(this.driver).some(candidate => candidate.jobId === job.jobId)
            || readAppLifecycleReceipts(this.driver)
              .filter(candidate => candidate.requestId === job.requestId).length !== 1)
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

  backupRecords(appInstanceId?: string): BackupRecord[] {
    const absent = new Set(this.backupRetentionHistory().events.filter(event => event.outcome === "absent").map(event => event.intent.backupId));
    return this.backupPublicationRecords(appInstanceId).map(record => absent.has(record.backupId)
      ? BackupRecordV1.parse({ ...record, state: "deleted" }) : record);
  }

  backupPublicationRecords(appInstanceId?: string): BackupRecord[] {
    readValidatedCatalog(this.driver);
    return readBackupRecords(this.driver)
      .map(entry => entry.record)
      .filter(record => appInstanceId === undefined
        || record.evidence.appInstanceId === appInstanceId)
      .map(record => BackupRecordV1.parse(record));
  }

  backupRetentionHistory() {
    readValidatedCatalog(this.driver);
    return readBackupRetentionHistory(this.driver);
  }

  backupRetentionPlan(input: unknown) {
    const snapshot = readValidatedCatalog(this.driver);
    return planBackupRetention(readBackupRecords(this.driver).map(item => item.record), readBackupRetentionHistory(this.driver),
      snapshot.authorityIncarnationId, input);
  }

  authorizeBackupRemoval(input: unknown, fence: WriteFence, nowMs: number): BackupRemovalAuthorizationV1 {
    const command = BackupRemovalRequestV1.parse(input);
    const snapshot = readValidatedCatalog(this.driver); this.assertWriteFence(fence, nowMs);
    const history = readBackupRetentionHistory(this.driver);
    const existing = history.events.find(event => event.requestId === command.requestId);
    if (existing) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(command.intent))
        throw new ClayError("E_CATALOG_CONFLICT", "retention request identity changed");
      return { status: "recorded", receipt: existing };
    }
    const records = readBackupRecords(this.driver).map(item => item.record);
    const record = records.find(item => item.backupId === command.intent.backupId);
    const keeper = records.find(item => item.backupId === command.intent.keeperBackupId);
    if (command.intent.authorityIncarnationId !== snapshot.authorityIncarnationId || command.requestId !== backupRemovalRequestId(command.intent)
        || BigInt(command.intent.planningRevision) > BigInt(history.revision) || !record || !keeper || !retentionEligible(records, record, keeper)
        || history.events.some(event => event.intent.backupId === record.backupId && event.outcome === "absent"))
      throw new ClayError("E_CATALOG_CONFLICT", "retention file is not eligible; refresh its outcome");
    return BackupRemovalAuthorizationV1.parse({ status: "ready", ...command, record, keeper, fence });
  }

  acknowledgeBackupRemoval(input: { requestId: string; intent: unknown; outcome: "absent" | "failed"; fence: WriteFence; nowMs: number }): BackupRetentionReceiptV1 {
    const command = BackupRemovalAcknowledgementV1.parse({ requestId: input.requestId, intent: input.intent, outcome: input.outcome });
    if (!validClockValue(input.nowMs)) throw new ClayError("E_CATALOG_CONFLICT", "retention clock is invalid");
    return this.driver.tx(() => {
      const before = readValidatedCatalog(this.driver); const history = readBackupRetentionHistory(this.driver);
      const requestSha256 = backupRemovalHash(command);
      const replay = history.events.find(event => event.requestId === command.requestId);
      if (replay) {
        if (replay.requestSha256 !== requestSha256) throw new ClayError("E_CATALOG_CONFLICT", "retention request identity is immutable");
        return replay;
      }
      const fence = this.assertWriteFence(input.fence, input.nowMs);
      const records = readBackupRecords(this.driver).map(item => item.record);
      const record = records.find(item => item.backupId === command.intent.backupId);
      const keeper = records.find(item => item.backupId === command.intent.keeperBackupId);
      if (command.intent.authorityIncarnationId !== before.authorityIncarnationId
          || command.requestId !== backupRemovalRequestId(command.intent)
          || BigInt(command.intent.planningRevision) > BigInt(history.revision)
          || !record || !keeper || !retentionEligible(records, record, keeper)
          || history.events.some(event => event.intent.backupId === record.backupId && event.outcome === "absent"))
        throw new ClayError("E_CATALOG_CONFLICT", "retention target or request is no longer eligible; read its outcome");
      if (history.events.length >= 100_000) throw new ClayError("E_LIMIT", "retention receipt history is full");
      const receipt = BackupRetentionReceiptV1.parse({ schema: 1, ...command,
        revision: incrementCounter(history.revision, "E_CATALOG_CONFLICT"), requestSha256,
        operationId: productionOperationIdV2(before.authorityIncarnationId, command.requestId, "backup.retention"),
        catalogGeneration: before.catalogGeneration, fence, completedAt: new Date(input.nowMs).toISOString() });
      this.driver.exec("INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'operation',?)", [receipt.operationId, receipt.completedAt]);
      this.driver.exec("INSERT INTO catalog.backup_retention_events(revision,request_id,operation_id,event_json) VALUES (?,?,?,?)",
        [receipt.revision, receipt.requestId, receipt.operationId, JSON.stringify(receipt)]);
      this.driver.exec("UPDATE catalog.backup_retention_root SET revision = ? WHERE singleton = 1 AND revision = ?", [receipt.revision, history.revision]);
      readValidatedCatalog(this.driver);
      const after = readBackupRetentionHistory(this.driver);
      if (after.revision !== receipt.revision || JSON.stringify(after.events.at(-1)) !== JSON.stringify(receipt))
        throw new ClayError("E_CATALOG_CONFLICT", "retention acknowledgement failed read-back");
      return receipt;
    });
  }

  private backupRotation(record: BackupRecord): BackupRecord[] {
    // Recompute from the live catalog on replay as well. A lost response must
    // not suppress unfinished retention, and an old replay must never rotate
    // its own artifact, another app/folder, or one of the newest 32 records.
    return this.backupRetentionPlan({ targetId: record.targetId, appInstanceId: record.evidence.appInstanceId,
      adapterCertificationId: record.adapterCertificationId }).entries.map(item => item.record)
      .filter(candidate => candidate.backupId !== record.backupId);
  }

  publishBackup(input: PublishBackupInput): BackupPublicationReceipt {
    const request = BackupPublicationRequestV1.safeParse(input.request);
    const operation = OperationId.safeParse(input.operationId);
    if (!request.success || !operation.success || !validClockValue(input.nowMs))
      throw new ClayError("E_CATALOG_CONFLICT", "backup publication input is invalid");
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver);
        const existing = readBackupRecords(this.driver)
          .find(entry => entry.record.backupId === request.data.artifact.backupId);
        if (existing) {
          if (readBackupRetentionHistory(this.driver).events.some(event => event.intent.backupId === existing.record.backupId && event.outcome === "absent"))
            throw new ClayError("E_CATALOG_CONFLICT", "a removed backup cannot be republished");
          const expected = BackupRecordV1.parse({
            ...request.data.artifact,
            validatedAt: existing.record.validatedAt,
            publicationCatalogGeneration: existing.record.publicationCatalogGeneration,
            state: "valid",
            validationCode: "archive_valid",
          });
          if (JSON.stringify(expected) !== JSON.stringify(existing.record))
            throw new ClayError("E_CATALOG_CONFLICT", "backup identity is bound to another artifact");
          return BackupPublicationReceiptV1.parse({
            schema: 1,
            publication: "already_published",
            record: existing.record,
            rotate: this.backupRotation(existing.record),
          });
        }

        const fence = this.assertWriteFence(request.data.fence, input.nowMs);
        const selected = this.selectedTargetStorage().target;
        const expected = request.data.expected;
        if (before.authorityIncarnationId !== expected.authorityIncarnationId
            || before.catalogGeneration !== expected.catalogGeneration
            || before.selectedAppInstanceId !== expected.selectedAppInstanceId
            || before.writeEpoch !== expected.writeEpoch
            || !sameTarget(selected, expected.target)
            || fence.authorityIncarnationId !== expected.authorityIncarnationId
            || fence.writeEpoch !== expected.writeEpoch)
          throw new ClayError("E_GENERATION_NOT_SELECTED", "backup publication target is stale");
        if (this.driver.select(
          "SELECT id_value FROM catalog.id_registry WHERE id_value = ?", [operation.data],
        ).length !== 0)
          throw new ClayError("E_CATALOG_CONFLICT", "backup publication operation was reused");

        const nextCatalogGeneration = incrementCounter(
          before.catalogGeneration, "E_CATALOG_CONFLICT",
        );
        const record = BackupRecordV1.parse({
          ...request.data.artifact,
          publicationCatalogGeneration: nextCatalogGeneration,
          state: "valid",
          validationCode: "archive_valid",
        });
        this.driver.exec(
          "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'operation',?)",
          [operation.data, record.validatedAt],
        );
        this.driver.exec(
          `INSERT INTO catalog.backup_records(
             backup_id,operation_id,publication_catalog_generation,record_json
           ) VALUES (?,?,?,?)`,
          [record.backupId, operation.data, nextCatalogGeneration, JSON.stringify(record)],
        );
        insertCatalogGenerationEvent(this.driver, {
          schema: 1,
          catalogGeneration: nextCatalogGeneration,
          eventKind: "backup_published",
          appInstanceId: record.evidence.appInstanceId,
          operationId: operation.data,
          writeEpoch: fence.writeEpoch,
          at: record.validatedAt,
          target: null,
        });
        this.driver.exec(
          `UPDATE catalog.catalog_root SET catalog_generation = ?
           WHERE singleton = 1 AND authority_incarnation_id = ?
             AND catalog_generation = ? AND selected_app_instance_id = ?
             AND write_epoch = ?`,
          [nextCatalogGeneration, before.authorityIncarnationId,
            before.catalogGeneration, before.selectedAppInstanceId, before.writeEpoch],
        );
        const after = readValidatedCatalog(this.driver);
        const persisted = readBackupRecords(this.driver)
          .find(entry => entry.record.backupId === record.backupId)?.record;
        if (after.catalogGeneration !== nextCatalogGeneration || !persisted
            || JSON.stringify(persisted) !== JSON.stringify(record))
          throw new ClayError("E_CATALOG_CONFLICT", "backup publication failed read-back");

        return BackupPublicationReceiptV1.parse({
          schema: 1,
          publication: "published",
          record,
          rotate: this.backupRotation(record),
        });
      });
    } catch (error) {
      if (error instanceof ClayError && [
        "E_CATALOG_CONFLICT", "E_CATALOG_UNAVAILABLE", "E_STALE_WRITE_EPOCH",
        "E_GENERATION_NOT_SELECTED",
      ].includes(error.code)) throw error;
      throw new ClayError("E_CATALOG_UNAVAILABLE", "backup publication failed");
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

  addAppTarget(
    input: AddAppTargetInput,
    pendingRestoreJobId?: string,
  ): ReturnType<DeviceCatalog["snapshot"]> {
    const catalogGeneration = UInt64Decimal.safeParse(input.expectedCatalogGeneration);
    const target = TargetEvidenceV1.safeParse(input.target);
    const namespaceId = NamespaceId.safeParse(input.namespaceId);
    const operationId = OperationId.safeParse(input.operationId);
    const fence = WriteFenceV1.safeParse(input.fence);
    const sourceArchive = input.sourceArchiveSha256 === undefined
      || input.sourceArchiveSha256 === null
      ? null : Sha256.safeParse(input.sourceArchiveSha256);
    const sourceProvenanceId = input.sourceProvenanceId ?? null;
    if (!catalogGeneration.success || !target.success || !namespaceId.success
        || !operationId.success || !fence.success || !validStorageKey(input.storageKey)
        || typeof input.displayName !== "string" || input.displayName !== input.displayName.trim()
        || input.displayName.length < 1 || input.displayName.length > 40
        || typeof input.shellId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(input.shellId)
        || !validClockValue(input.nowMs) || input.select !== true
        || (sourceArchive !== null && !sourceArchive.success)
        || (sourceProvenanceId !== null
          && (typeof sourceProvenanceId !== "string"
            || sourceProvenanceId !== sourceProvenanceId.trim()
            || sourceProvenanceId.length < 1 || sourceProvenanceId.length > 256))
        || target.data.lineageEpoch !== "0" || target.data.protectionRevision !== "0"
        || (pendingRestoreJobId !== undefined
          && (!this.allowPendingRestore || !/^job_[a-z2-7]{26}$/.test(pendingRestoreJobId))))
      throw new ClayError("E_CATALOG_CONFLICT", "catalog app add input is invalid");
    const at = new Date(input.nowMs).toISOString();
    try {
      return this.driver.tx(() => {
        const before = readValidatedCatalog(this.driver,
          pendingRestoreJobId === undefined ? {} : { allowPendingRestore: true });
        this.assertWriteFence(fence.data, input.nowMs);
        const pendingRestore = pendingRestoreJobId === undefined ? undefined
          : readPendingRestoreJobs(this.driver).find(job => job.jobId === pendingRestoreJobId);
        if (pendingRestoreJobId !== undefined && (!pendingRestore
            || pendingRestore.appInstanceId !== target.data.appInstanceId
            || pendingRestore.generationId !== target.data.activeGenerationId
            || pendingRestore.namespaceId !== namespaceId.data
            || pendingRestore.operationId !== operationId.data
            || pendingRestore.sourceArchiveSha256 !== sourceArchive?.data
            || pendingRestore.sourceProvenanceId !== sourceProvenanceId))
          throw new ClayError("E_CATALOG_CONFLICT", "pending restore publication binding changed");
        if (pendingRestore?.schema === 2)
          this.assertRestoreClaim(pendingRestore, fence.data, input.nowMs, "install");
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
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [target.data.activeGenerationId, target.data.appInstanceId, namespaceId.data,
            input.storageKey, operationId.data, target.data.lineageEpoch,
            target.data.protectionRevision, target.data.digestSchema, target.data.stateSha256,
            sourceArchive?.data ?? null, sourceProvenanceId, at, at],
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
        if (pendingRestore?.schema === 2 && pendingRestore.intent) {
          storeAppLifecycleReceipt(this.driver, AppLifecycleReceiptV1.parse({
            schema: 2, kind: "restore", jobId: pendingRestore.jobId,
            authorityIncarnationId: before.authorityIncarnationId, requestId: pendingRestore.intent.requestId,
            requestSha256: pendingRestore.intent.requestSha256, operationId: pendingRestore.operationId,
            requestedAppInstanceId: null, resultingSelectedAppInstanceId: target.data.appInstanceId,
            resultTarget: target.data, resultDisplayName: input.displayName, resultShellId: input.shellId,
            completedCatalogGeneration: nextCatalogGeneration, completedAt: at,
          }), { target: target.data, namespaceId: namespaceId.data, storageKey: input.storageKey });
        } else if (pendingRestore) this.driver.exec(
          "DELETE FROM catalog.pending_jobs WHERE job_id = ?", [pendingRestore.jobId]);
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
      if (!input.recordNoop && app.displayName === input.displayName && app.shellId === input.shellId) return before;
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
        if (!input.recordNoop && before.selectedAppInstanceId === appInstanceId.data) return before;
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
        const before = readValidatedCatalog(this.driver, { allowPendingRestore: this.allowPendingRestore });
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
        const after = readValidatedCatalog(this.driver, { allowPendingRestore: this.allowPendingRestore });
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
        const snapshot = readValidatedCatalog(
          this.driver, { allowPendingRestore: this.allowPendingRestore },
        );
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
