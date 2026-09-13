import { assertLifecycleReattestation } from "./lifecycle-reattestation-evidence";
import { assertBackupRetentionHistory } from "./backup-retention";
import {
  ArchiveAuthorityEvidenceV1,
  ArchiveBootstrapEntryV1,
  ArchiveCatalogIdV1,
  ArchiveCatalogEntryV1,
  ArchiveCatalogLeaseV1,
  ArchiveCatalogSchemaObjectV1,
  ArchiveGenerationEvidenceV1,
  ArchiveLineageReservationV1,
  ArchiveManifestV5,
  ArchivePendingJobV1,
  ArchiveRestoreAsNewIdentityV1,
  ArchiveTargetRequestReceiptV1,
  MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES,
  MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES,
  type ArchiveAuthorityEvidenceV1 as ArchiveAuthorityEvidence,
  type ArchiveManifestV5 as ArchiveManifest,
  type ArchiveRestoreAsNewIdentityV1 as ArchiveRestoreIdentity,
} from "@clay/schema/archive";
import {
  type CatalogGenerationEventV1 as CatalogGenerationEvent,
  type CatalogRevisionReservationV1 as CatalogRevisionReservation,
  CatalogGenerationEventV1,
  ImmutableAppGenerationV1,
  ProductionRequestReceiptV1,
  type TargetEvidenceV1 as TargetEvidence,
  TargetEvidenceV1,
} from "@clay/schema/catalog";
import {
  BackupStageValidationV1,
  type BackupStageValidationV1 as BackupStageValidation,
} from "@clay/schema/backup";
import {
  CLAY_ARCHIVE_CONTENT_TYPE,
  sealAuthenticatedArchiveV5,
  verifyAuthenticatedArchiveV5,
  verifyAuthenticatedArchiveV5Owned,
  type AuthenticatedArchiveHeaderV1,
  type BackupTrustKeyResolver,
} from "./archive-authentication";
import { enumerateCanonicalStateV1, verifyCanonicalStateV1 } from "./canonical-state";
import type { DbDriver, SqlRow } from "./db";
import { openDriverFromBytes } from "./db";
import { DeviceCatalog, expectedCatalogSchemaObjects } from "./device-catalog";
import { ClayError } from "./errors";
import type { RegTable, Registry } from "./registry";
import {
  assertAuthenticatedSampleProvenance,
  type SampleProvenanceLedgerEntry,
} from "./sample-provenance-proof";
import { isUuidV7 } from "./rows";
import { isTableId } from "./semantic";
import { sha256HexSync } from "./state-digest";
import { StateMerkleIndex } from "./state-merkle-index";
import { ClayStore, type ClayManifest } from "./store";
import { TargetAuthorityStore } from "./target-authority";
import { zipRead, zipWrite } from "./zip";

const MAX_ARCHIVE_BYTES = 384 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_ARCHIVE_AUTHORITY_BYTES = 32 * 1024 * 1024;
const FORMAT_5_FILES = new Set(["manifest.json", "authority.json", "user.db", "system.db"]);
const textEncoder = new TextEncoder();

export interface ArchiveSealMaterialV1 {
  backupTrustKey: Uint8Array;
  keyId: Uint8Array;
  seriesId: Uint8Array;
  generation: bigint;
}

export function assertArchiveAuthorityMemberSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0
      || byteLength > MAX_ARCHIVE_AUTHORITY_BYTES)
    throw new ClayError("E_LIMIT", "archive authority evidence exceeds the 32 MiB import limit");
}

export function assertArchiveAuthorityCardinality(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  const histories: unknown[] = [];
  const target = record.targetAuthority;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const targetRecord = target as Record<string, unknown>;
    histories.push(targetRecord.revisions, targetRecord.requestReceipts);
  }
  const catalog = record.catalogAuthority;
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
    const catalogRecord = catalog as Record<string, unknown>;
    if (catalogRecord.retentionHistory && typeof catalogRecord.retentionHistory === "object")
      histories.push(Reflect.get(catalogRecord.retentionHistory, "events"));
    histories.push(
      catalogRecord.entries,
      catalogRecord.generations,
      catalogRecord.idRegistry,
      catalogRecord.leases,
      catalogRecord.requestReceipts,
      catalogRecord.revisionReservations,
      catalogRecord.bootstrapManifest,
      catalogRecord.pendingJobs,
      catalogRecord.lifecycleReceipts,
      catalogRecord.lineageReservations,
      catalogRecord.generationEvents,
      catalogRecord.backupRecords,
    );
  }
  let total = 0;
  for (const history of histories) {
    if (!Array.isArray(history)) continue;
    if (history.length > MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES)
      throw new ClayError("E_LIMIT", "archive authority history exceeds its entry limit");
    total += history.length;
  }
  if (total > MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES)
    throw new ClayError("E_LIMIT", "archive authority history exceeds its total entry limit");
}

function invalid(message: string): ClayError {
  return new ClayError("E_VALIDATION", `archive authority evidence is invalid: ${message}`);
}

const STORE_GET_SETTING: ClayStore["getSetting"] = ClayStore.prototype.getSetting;

function hasNonemptySampleProvenance(store: ClayStore): boolean {
  const raw = STORE_GET_SETTING.call(store, "sample_provenance_v1");
  if (raw === undefined) return false;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw invalid("sample provenance ledger is malformed");
  const descriptor = Object.getOwnPropertyDescriptor(raw, "entries");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    throw invalid("sample provenance ledger is malformed");
  return descriptor.value.length > 0;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${sha256HexSync(bytes)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function canonicalBytes(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function sameTarget(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function registryFromDriver(driver: DbDriver): Registry {
  try {
    const registry: Registry = new Map();
    for (const row of driver.select(
      "SELECT table_name, spec_json FROM sys.tables_registry ORDER BY table_name",
    )) {
      if (typeof row.table_name !== "string" || typeof row.spec_json !== "string")
        throw invalid("registry metadata is malformed");
      const table = JSON.parse(row.spec_json) as RegTable;
      if (!table || typeof table !== "object" || table.name !== row.table_name
          || !Array.isArray(table.columns) || registry.has(table.name))
        throw invalid("registry metadata is malformed");
      registry.set(table.name, table);
    }
    return registry;
  } catch (error) {
    if (error instanceof ClayError) throw error;
    throw invalid("registry metadata is unreadable");
  }
}

function mapCatalogEntry(row: SqlRow) {
  return ArchiveCatalogEntryV1.parse({
    appInstanceId: row.app_instance_id,
    displayName: row.display_name,
    shellId: row.shell_id,
    activeGenerationId: row.active_generation_id,
    journalGenesisGenerationId: row.journal_genesis_generation_id,
    journalGenesisLineageEpoch: row.journal_genesis_lineage_epoch,
    journalGenesisProtectionRevision: row.journal_genesis_protection_revision,
    journalGenesisStateSha256: row.journal_genesis_state_sha256,
    currentLineageEpoch: row.current_lineage_epoch,
    lineageEpochHighWater: row.lineage_epoch_high_water,
    currentProtectionRevision: row.current_protection_revision,
    revisionHighWater: row.revision_high_water,
    digestSchema: row.digest_schema,
    stateSha256: row.state_sha256,
    tombstoned: Number(row.tombstoned) === 1,
  });
}

function mapGeneration(row: SqlRow) {
  return ArchiveGenerationEvidenceV1.parse({
    schema: 1,
    operationId: row.operation_id,
    storageKey: row.storage_key,
    descriptor: ImmutableAppGenerationV1.parse({
      schema: 1,
      generationId: row.generation_id,
      target: {
        appInstanceId: row.app_instance_id,
        activeGenerationId: row.generation_id,
        lineageEpoch: row.lineage_epoch,
        protectionRevision: row.first_revision,
        digestSchema: row.digest_schema,
        stateSha256: row.state_sha256,
      },
      namespaceId: row.namespace_id,
      sourceArchiveSha256: row.source_archive_sha256,
      sourceProvenanceId: row.source_provenance_id,
      sealedAt: row.sealed_at,
      readBackAt: row.read_back_at,
    }),
  });
}

function mapEvent(row: SqlRow): CatalogGenerationEvent {
  const hasNoTarget = row.target_generation_id === null
    && row.target_lineage_epoch === null
    && row.target_protection_revision === null
    && row.target_digest_schema === null
    && row.target_state_sha256 === null;
  return CatalogGenerationEventV1.parse({
    schema: 1,
    catalogGeneration: row.catalog_generation,
    eventKind: row.event_kind,
    appInstanceId: row.app_instance_id,
    operationId: row.operation_id,
    writeEpoch: row.write_epoch,
    at: row.at,
    target: hasNoTarget ? null : {
      appInstanceId: row.app_instance_id,
      activeGenerationId: row.target_generation_id,
      lineageEpoch: row.target_lineage_epoch,
      protectionRevision: row.target_protection_revision,
      digestSchema: row.target_digest_schema,
      stateSha256: row.target_state_sha256,
    },
    displayName: row.display_name,
    shellId: row.shell_id,
  });
}

function mapReceipt(row: SqlRow) {
  return ProductionRequestReceiptV1.parse({
    schema: 1,
    requestId: row.request_id,
    operationId: row.operation_id,
    appInstanceId: row.app_instance_id,
    activeGenerationId: row.active_generation_id,
    lineageEpoch: row.lineage_epoch,
    expectedProtectionRevision: row.expected_protection_revision,
    expectedStateSha256: row.expected_state_sha256,
    requestSha256: row.request_sha256,
    state: row.state,
    resultingProtectionRevision: row.resulting_protection_revision,
    resultingStateSha256: row.resulting_state_sha256,
    responseSha256: row.response_sha256,
    preparedAt: row.prepared_at,
    invokedAt: row.invoked_at,
    completedAt: row.completed_at,
  });
}

function mapTargetReceipt(row: SqlRow) {
  return ArchiveTargetRequestReceiptV1.parse({
    schema: 1,
    receipt: mapReceipt(row),
    responseJson: row.response_json,
  });
}

function normalizeCatalogSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function collectCatalogSchemaObjects(driver: DbDriver) {
  return driver.select(
    `SELECT type,name,tbl_name,sql FROM catalog.sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map(row => ArchiveCatalogSchemaObjectV1.parse({
    schema: 1,
    type: row.type,
    name: row.name,
    tableName: row.tbl_name,
    sql: typeof row.sql === "string" ? normalizeCatalogSql(row.sql) : row.sql,
  }));
}

function collectCatalogIds(driver: DbDriver) {
  return driver.select(
    "SELECT id_value,id_kind,retained_at FROM catalog.id_registry ORDER BY id_value",
  ).map(row => ArchiveCatalogIdV1.parse({
    schema: 1,
    idValue: row.id_value,
    idKind: row.id_kind,
    retainedAt: row.retained_at,
  }));
}

function collectBootstrapManifest(driver: DbDriver) {
  return driver.select(
    "SELECT * FROM catalog.legacy_bootstrap_manifest ORDER BY storage_key",
  ).map(row => ArchiveBootstrapEntryV1.parse({
    schema: 1,
    storageKey: row.storage_key,
    userFile: row.user_file,
    systemFile: row.system_file,
    storageKind: row.storage_kind,
    appInstanceId: row.app_instance_id,
    generationId: row.generation_id,
    namespaceId: row.namespace_id,
    operationId: row.operation_id,
    displayName: row.display_name,
    shellId: row.shell_id,
    selected: Number(row.selected) === 1,
    declaredAt: row.declared_at,
  }));
}

import { catalogPendingEvidenceForArchive } from "./catalog-pending";

function collectLineageReservations(driver: DbDriver) {
  return driver.select(
    "SELECT * FROM catalog.lineage_reservations ORDER BY app_instance_id,lineage_epoch",
  ).map(row => ArchiveLineageReservationV1.parse({
    schema: 1,
    appInstanceId: row.app_instance_id,
    lineageEpoch: row.lineage_epoch,
    operationId: row.operation_id,
    state: row.state,
  }));
}

function compareUint64(left: string, right: string): number {
  const a = BigInt(left), b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectCatalogAuthority(
  driver: DbDriver,
  target: TargetEvidence,
): ArchiveAuthorityEvidence["catalogAuthority"] {
  const catalog = DeviceCatalog.openExisting(driver);
  const snapshot = catalog.snapshot();
  const entry = snapshot.entries.find(candidate => candidate.appInstanceId === target.appInstanceId);
  if (snapshot.selectedAppInstanceId !== target.appInstanceId || !entry
      || entry.activeGenerationId !== target.activeGenerationId
      || entry.currentLineageEpoch !== target.lineageEpoch
      || entry.currentProtectionRevision !== target.protectionRevision
      || entry.digestSchema !== target.digestSchema
      || entry.stateSha256 !== target.stateSha256)
    throw invalid("catalog-selected target does not match target read-back");

  const revisionReservations = catalog.revisionReservations().sort((left, right) =>
    left.appInstanceId.localeCompare(right.appInstanceId)
    || compareUint64(left.revision, right.revision));
  const generations = driver.select(
    "SELECT * FROM catalog.generations ORDER BY generation_id",
  ).map(mapGeneration);
  const generationEvents = driver.select(
    "SELECT * FROM catalog.catalog_generation_events ORDER BY CAST(catalog_generation AS INTEGER)",
  ).map(mapEvent);

  const allLeases = driver.select("SELECT * FROM catalog.leases ORDER BY CAST(write_epoch AS INTEGER)")
    .map(row => ArchiveCatalogLeaseV1.parse({
      schema: 1,
      leaseId: row.lease_id,
      authorityIncarnationId: row.authority_incarnation_id,
      writeEpoch: row.write_epoch,
      releaseId: row.release_id,
      issuedAtMs: row.issued_at_ms,
      expiresAtMs: row.expires_at_ms,
      revoked: Number(row.revoked) === 1,
    }));
  const leases = allLeases.sort((left, right) => compareUint64(left.writeEpoch, right.writeEpoch)
    || left.leaseId.localeCompare(right.leaseId));
  const bootstrapManifest = collectBootstrapManifest(driver);
  const { pendingJobs, lifecycleReceipts } = catalogPendingEvidenceForArchive(driver);
  const lineageReservations = collectLineageReservations(driver);
  if (bootstrapManifest.length !== 0)
    throw invalid("catalog bootstrap is incomplete");
  if (pendingJobs.length !== 0 || lineageReservations.length !== 0)
    throw invalid("catalog contains unsupported unfinished work");

  return {
    schema: 3,
    schemaObjects: collectCatalogSchemaObjects(driver),
    authorityIncarnationId: snapshot.authorityIncarnationId,
    catalogGeneration: snapshot.catalogGeneration,
    writeEpoch: snapshot.writeEpoch,
    selectedAppInstanceId: target.appInstanceId,
    entry,
    entries: driver.select(
      "SELECT * FROM catalog.app_entries ORDER BY app_instance_id",
    ).map(mapCatalogEntry),
    generations,
    idRegistry: collectCatalogIds(driver),
    leases,
    requestReceipts: driver.select(
      "SELECT * FROM catalog.production_request_receipts ORDER BY request_id",
    ).map(mapReceipt),
    revisionReservations,
    bootstrapManifest,
    pendingJobs,
    lineageReservations,
    generationEvents,
    backupRecords: catalog.backupPublicationRecords().sort((left, right) =>
      left.backupId.localeCompare(right.backupId)),
    lifecycleReceipts,
    retentionHistory: catalog.backupRetentionHistory(),
  } as ArchiveAuthorityEvidence["catalogAuthority"];
}

/**
 * Upgrade an already validated format-4 snapshot into a private format-5
 * authority archive. The caller must serialize this read with live worker
 * commands and provide the physical target driver with `catalog` attached.
 */
export async function exportAuthorityArchiveV5(
  legacyArchive: Uint8Array,
  authorityDriver: DbDriver,
): Promise<Uint8Array> {
  if (!(legacyArchive instanceof Uint8Array) || legacyArchive.byteLength > MAX_ARCHIVE_BYTES)
    throw new ClayError("E_LIMIT", "archive exceeds the 384 MB export limit");
  const parsed = ClayStore.parseArchive(legacyArchive);
  if (parsed.manifest.format !== 4)
    throw invalid("format 5 export requires one validated format 4 snapshot");

  const validatedLegacy = await ClayStore.importArchive(legacyArchive);
  validatedLegacy.store.close();

  const archiveDriver = await openDriverFromBytes(parsed.user, parsed.system);
  let archiveCanonical;
  try {
    archiveCanonical = enumerateCanonicalStateV1(archiveDriver, registryFromDriver(archiveDriver));
  } finally {
    archiveDriver.close();
  }

  const sourceRegistry = registryFromDriver(authorityDriver);
  const sourceCanonical = verifyCanonicalStateV1(authorityDriver, sourceRegistry);
  const merkle = StateMerkleIndex.open(authorityDriver).audit();
  const targetStore = TargetAuthorityStore.open(authorityDriver);
  const target = targetStore.evidence();
  if (sourceCanonical.stateSha256 !== archiveCanonical.stateSha256
      || sourceCanonical.leaves.length !== archiveCanonical.leaves.length
      || merkle.stateSha256 !== sourceCanonical.stateSha256
      || merkle.leafCount !== sourceCanonical.leaves.length
      || target.stateSha256 !== sourceCanonical.stateSha256)
    throw invalid("exported databases do not match current canonical target state");

  const targetAuthority = {
    schema: 1 as const,
    header: targetStore.header(),
    revisions: targetStore.reservations().map(revision => ({ schema: 1 as const, ...revision })),
    requestReceipts: authorityDriver.select(
      "SELECT * FROM sys.production_request_receipts ORDER BY request_id",
    ).map(mapTargetReceipt),
  };
  const userDb = { bytes: parsed.user.byteLength, sha256: digest(parsed.user) };
  const systemDb = { bytes: parsed.system.byteLength, sha256: digest(parsed.system) };
  const binding = {
    format: 5 as const,
    app: parsed.manifest.app,
    exportedAt: parsed.manifest.exported_at,
    tables: parsed.manifest.tables,
    versions: parsed.manifest.versions,
    attachments: parsed.manifest.attachments!,
    userDb,
    systemDb,
  };
  const authority = ArchiveAuthorityEvidenceV1.parse({
    schema: 1,
    binding,
    target,
    merkle: {
      schema: 1,
      stateSha256: merkle.stateSha256,
      leafCount: merkle.leafCount,
      bucketRoots: merkle.bucketRoots,
    },
    targetAuthority,
    catalogAuthority: collectCatalogAuthority(authorityDriver, target),
  });
  validateAuthorityHistory(authority);
  validateSampleProvenanceLedger(authorityDriver, sourceRegistry, authority);
  const authorityBytes = canonicalBytes(authority);
  assertArchiveAuthorityMemberSize(authorityBytes.byteLength);
  const manifest: ArchiveManifest = ArchiveManifestV5.parse({
    format: 5,
    app: binding.app,
    exported_at: binding.exportedAt,
    tables: binding.tables,
    versions: binding.versions,
    attachments: binding.attachments,
    files: {
      userDb,
      systemDb,
      authority: { bytes: authorityBytes.byteLength, sha256: digest(authorityBytes) },
    },
  });
  const manifestBytes = canonicalBytes(manifest);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES)
    throw new ClayError("E_LIMIT", "archive manifest exceeds the 64 KiB export limit");
  const archive = zipWrite([
    { name: "manifest.json", data: manifestBytes },
    { name: "authority.json", data: authorityBytes },
    { name: "user.db", data: parsed.user },
    { name: "system.db", data: parsed.system },
  ]);
  if (archive.byteLength > MAX_ARCHIVE_BYTES)
    throw new ClayError("E_LIMIT", "archive exceeds the 384 MB export limit");
  const names = zipRead(archive).map(entry => entry.name);
  if (names.length !== FORMAT_5_FILES.size || names.some(name => !FORMAT_5_FILES.has(name)))
    throw invalid("format 5 archive member set is incomplete");

  const finalCanonical = verifyCanonicalStateV1(
    authorityDriver, registryFromDriver(authorityDriver),
  );
  const finalMerkle = StateMerkleIndex.open(authorityDriver).audit();
  const finalTargetStore = TargetAuthorityStore.open(authorityDriver);
  const finalTarget = finalTargetStore.evidence();
  const finalTargetAuthority = {
    schema: 1 as const,
    header: finalTargetStore.header(),
    revisions: finalTargetStore.reservations().map(revision => ({ schema: 1 as const, ...revision })),
    requestReceipts: authorityDriver.select(
      "SELECT * FROM sys.production_request_receipts ORDER BY request_id",
    ).map(mapTargetReceipt),
  };
  const finalCatalogAuthority = collectCatalogAuthority(authorityDriver, finalTarget);
  if (finalCanonical.stateSha256 !== sourceCanonical.stateSha256
      || finalCanonical.leaves.length !== sourceCanonical.leaves.length
      || finalMerkle.stateSha256 !== merkle.stateSha256
      || finalMerkle.leafCount !== merkle.leafCount
      || !sameJson(finalMerkle.bucketRoots, merkle.bucketRoots)
      || !sameTarget(finalTarget, target)
      || !sameJson(finalTargetAuthority, targetAuthority)
      || !sameJson(finalCatalogAuthority, authority.catalogAuthority))
    throw invalid("current exact target authority changed during archive collection read-back");
  return archive;
}

export async function exportAuthenticatedAuthorityArchiveV5(
  legacyArchive: Uint8Array,
  authorityDriver: DbDriver,
  material: ArchiveSealMaterialV1,
): Promise<Uint8Array> {
  const inner = await exportAuthorityArchiveV5(legacyArchive, authorityDriver);
  return sealAuthenticatedArchiveV5(inner, material.backupTrustKey, {
    authenticationVersion: 1,
    archiveFormat: 5,
    contentType: CLAY_ARCHIVE_CONTENT_TYPE,
    keyId: material.keyId,
    seriesId: material.seriesId,
    generation: material.generation,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false;
  return true;
}

function parseJsonMember(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalid(`${label} is not canonical UTF-8 JSON`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSampleProvenanceLedger(
  driver: DbDriver,
  registry: Registry,
  evidence: ArchiveAuthorityEvidence,
): void {
  if (driver.select("SELECT key FROM sys.settings WHERE key = 'sample_rows'").length !== 0)
    throw invalid("legacy sample_rows provenance is unauthenticated");
  const rows = driver.select(
    "SELECT value_json FROM sys.settings WHERE key = 'sample_provenance_v1'",
  );
  let ledgerEntries: readonly unknown[] = [];
  if (rows.length !== 0) {
    if (rows.length !== 1 || typeof rows[0]!.value_json !== "string")
      throw invalid("sample provenance ledger is malformed");
    const raw = rows[0]!.value_json;
    if (raw.length > 32 * 1024 * 1024
        || textEncoder.encode(raw).byteLength > 32 * 1024 * 1024)
      throw new ClayError("E_LIMIT", "sample provenance ledger exceeds 32 MiB");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw invalid("sample provenance ledger is malformed"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw invalid("sample provenance ledger is malformed");
    const ledger = parsed as Record<string, unknown>;
    if (Object.keys(ledger).length !== 2 || ledger.schema !== 1
        || !Array.isArray(ledger.entries) || ledger.entries.length > 100_000
        || JSON.stringify(parsed) !== raw)
      throw invalid("sample provenance ledger is malformed or noncanonical");
    ledgerEntries = ledger.entries;
  }

  const tableByStableId = new Map<string, RegTable>();
  for (const table of registry.values()) {
    const tableId = table.semantic?.tableId;
    if (tableId === undefined) continue;
    if (tableByStableId.has(tableId))
      throw invalid("sample provenance stable table binding is ambiguous");
    tableByStableId.set(tableId, table);
  }
  const parsedEntries: SampleProvenanceLedgerEntry[] = [];
  let previousCoordinate: string | null = null;
  for (const rawEntry of ledgerEntries) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry))
      throw invalid("sample provenance ledger entry is malformed");
    const entry = rawEntry as Record<string, unknown>;
    if (Object.keys(entry).length !== 3 || !isTableId(entry.tableId)
        || !isUuidV7(entry.rowId) || typeof entry.operationId !== "string"
        || !/^op_[a-z2-7]{26}$/.test(entry.operationId))
      throw invalid("sample provenance ledger entry is malformed");
    const coordinate = `${entry.tableId}\u0000${entry.rowId}`;
    if (previousCoordinate !== null && previousCoordinate >= coordinate)
      throw invalid("sample provenance ledger is duplicated or reordered");
    previousCoordinate = coordinate;
    const table = tableByStableId.get(entry.tableId);
    if (!table || !/^[a-z_][a-z0-9_]{0,63}$/.test(table.name))
      throw invalid("sample provenance stable table binding is unavailable");
    const physical = driver.select(
      `SELECT id FROM "${table.name}" WHERE id = ?`, [entry.rowId],
    );
    if (physical.length !== 1)
      throw invalid("sample provenance stable table binding references a missing row");
    parsedEntries.push(Object.freeze({
      tableId: entry.tableId,
      rowId: entry.rowId,
      operationId: entry.operationId,
    }));
  }
  assertAuthenticatedSampleProvenance({
    authorityIncarnationId: evidence.catalogAuthority.authorityIncarnationId,
    target: evidence.target,
    ledgerEntries: parsedEntries,
    receipts: evidence.targetAuthority.requestReceipts,
    catalogReceipts: evidence.catalogAuthority.requestReceipts,
    targetReservations: evidence.targetAuthority.revisions,
    catalogReservations: evidence.catalogAuthority.revisionReservations,
  });
}

function validateRequestReceipts(evidence: ArchiveAuthorityEvidence): void {
  const catalog = evidence.catalogAuthority;
  const targetReceipts = evidence.targetAuthority.requestReceipts;
  const catalogReceipts = catalog.requestReceipts;
  for (let index = 1; index < targetReceipts.length; index++) {
    if (targetReceipts[index - 1]!.receipt.requestId >= targetReceipts[index]!.receipt.requestId)
      throw invalid("target request receipt history is reordered or duplicated");
  }
  for (let index = 1; index < catalogReceipts.length; index++) {
    if (catalogReceipts[index - 1]!.requestId >= catalogReceipts[index]!.requestId)
      throw invalid("catalog request receipt history is reordered or duplicated");
  }
  const catalogByRequest = new Map(catalogReceipts.map(receipt => [receipt.requestId, receipt]));
  if (catalogByRequest.size !== catalogReceipts.length)
    throw invalid("catalog request receipt history is duplicated");
  const targetByRequest = new Map(targetReceipts.map(receipt => [receipt.receipt.requestId, receipt]));
  if (targetByRequest.size !== targetReceipts.length)
    throw invalid("target request receipt history is duplicated");
  for (const targetReceipt of targetReceipts) {
    const receipt = targetReceipt.receipt;
    const mirror = catalogByRequest.get(receipt.requestId);
    if (!mirror || !sameJson(receipt, mirror))
      throw invalid("production request receipt mirror is incomplete or divergent");
    if (receipt.appInstanceId !== evidence.target.appInstanceId)
      throw invalid("target request receipt belongs to another app");
    if (receipt.responseSha256 === null) {
      if (targetReceipt.responseJson !== null)
        throw invalid("nonterminal production request receipt contains a response");
    } else if (targetReceipt.responseJson === null
        || digest(new TextEncoder().encode(targetReceipt.responseJson)) !== receipt.responseSha256) {
      throw invalid("production request response digest is invalid");
    }
  }
  const selectedCatalogReceipts = catalogReceipts.filter(receipt =>
    receipt.appInstanceId === evidence.target.appInstanceId);
  if (selectedCatalogReceipts.length !== targetReceipts.length
      || selectedCatalogReceipts.some(receipt => !targetByRequest.has(receipt.requestId)))
    throw invalid("production request receipt mirror is incomplete");

  const targetReceiptsByOperation = new Map<string, typeof targetReceipts>();
  for (const receipt of targetReceipts) {
    const matching = targetReceiptsByOperation.get(receipt.receipt.operationId);
    if (matching) matching.push(receipt);
    else targetReceiptsByOperation.set(receipt.receipt.operationId, [receipt]);
  }
  for (const reservation of catalog.revisionReservations.filter(candidate =>
    candidate.appInstanceId === evidence.target.appInstanceId)) {
    const matching = targetReceiptsByOperation.get(reservation.operationId) ?? [];
    if (matching.length !== 1)
      throw invalid("selected revision request receipt is missing or ambiguous");
    const receipt = matching[0]!.receipt;
    if (receipt.requestSha256 !== reservation.requestSha256
        || receipt.appInstanceId !== reservation.appInstanceId
        || receipt.activeGenerationId !== reservation.activeGenerationId
        || receipt.lineageEpoch !== reservation.lineageEpoch
        || receipt.expectedProtectionRevision !== reservation.expectedProtectionRevision
        || receipt.expectedStateSha256 !== reservation.expectedStateSha256)
      throw invalid("selected revision request receipt does not match its reservation");
    if (reservation.state === "committed") {
      if (receipt.state !== "committed"
          || receipt.resultingProtectionRevision !== reservation.revision
          || receipt.resultingStateSha256 !== reservation.stateSha256)
        throw invalid("committed revision request receipt is incomplete or divergent");
    } else if (reservation.state === "abandoned") {
      if (receipt.state !== "failed"
          || receipt.resultingProtectionRevision !== reservation.expectedProtectionRevision
          || receipt.resultingStateSha256 !== reservation.expectedStateSha256)
        throw invalid("abandoned revision request receipt is incomplete or divergent");
    } else if (receipt.state !== "prepared" && receipt.state !== "invoked") {
      throw invalid("reserved revision request receipt is not pending");
    }
  }
}

function validateCatalogIdentityRegistry(evidence: ArchiveAuthorityEvidence): void {
  const catalog = evidence.catalogAuthority;
  const retained = catalog.idRegistry;
  for (let index = 1; index < retained.length; index++) {
    if (retained[index - 1]!.idValue >= retained[index]!.idValue)
      throw invalid("catalog retained identity history is reordered or duplicated");
  }
  const byId = new Map(retained.map(entry => [entry.idValue, entry.idKind]));
  if (byId.size !== retained.length)
    throw invalid("catalog retained identity history is duplicated");
  const referenced = new Set<string>();
  const expectedPrefix: Record<(typeof retained)[number]["idKind"], string> = {
    authority: "auth", app: "app", generation: "gen", namespace: "ns",
    lease: "lease", operation: "op", job: "job",
  };
  for (const entry of retained) {
    if (!new RegExp(`^${expectedPrefix[entry.idKind]}_[a-z2-7]{26}$`).test(entry.idValue))
      throw invalid("catalog retained identity has the wrong kind");
  }
  const requireId = (value: string | null, kind: (typeof retained)[number]["idKind"]): void => {
    if (value !== null && byId.get(value) !== kind)
      throw invalid("catalog retained identity evidence is incomplete");
    if (value !== null) referenced.add(value);
  };
  requireId(catalog.authorityIncarnationId, "authority");
  for (const entry of catalog.entries) requireId(entry.appInstanceId, "app");
  for (const generation of catalog.generations) {
    requireId(generation.descriptor.generationId, "generation");
    requireId(generation.descriptor.namespaceId, "namespace");
    requireId(generation.operationId, "operation");
  }
  for (const lease of catalog.leases) requireId(lease.leaseId, "lease");
  for (const reservation of catalog.revisionReservations)
    requireId(reservation.operationId, "operation");
  for (const receipt of catalog.requestReceipts)
    requireId(receipt.operationId, "operation");
  for (const event of catalog.generationEvents)
    requireId(event.operationId, "operation");
  for (const entry of catalog.bootstrapManifest) {
    requireId(entry.appInstanceId, "app");
    requireId(entry.generationId, "generation");
    requireId(entry.namespaceId, "namespace");
    requireId(entry.operationId, "operation");
  }
  for (const job of catalog.pendingJobs) {
    requireId(job.jobId, "job");
    requireId(job.authorityIncarnationId, "authority");
    requireId(job.appInstanceId, "app");
    requireId(job.operationId, "operation");
  }
  if (catalog.schema === 3) for (const event of catalog.retentionHistory.events) {
    requireId(event.operationId, "operation");
    requireId(event.fence.leaseId, "lease");
  }
  if (catalog.schema !== 1) for (const row of catalog.lifecycleReceipts) {
    const receipt = row.receipt;
    requireId(receipt.jobId, "job");
    requireId(receipt.operationId, "operation");
    requireId(receipt.authorityIncarnationId, "authority");
    requireId(receipt.requestedAppInstanceId, "app");
    requireId(receipt.resultingSelectedAppInstanceId, "app");
    requireId(row.generationId, "generation");
    requireId(row.namespaceId, "namespace");
  }
  for (const reservation of catalog.lineageReservations) {
    requireId(reservation.appInstanceId, "app");
    requireId(reservation.operationId, "operation");
  }
  for (const [value, kind] of byId) {
    if (kind !== "job" && !referenced.has(value))
      throw invalid(`catalog contains an unreferenced retained ${kind} identity`);
  }
}

function validateLifecycleReceipts(evidence: ArchiveAuthorityEvidence): void {
  const catalog = evidence.catalogAuthority;
  if (catalog.schema === 1) return;
  const jobs = new Set<string>(), operations = new Set<string>();
  const requests = new Set([...catalog.requestReceipts.map(row => row.requestId),
    ...(catalog.schema === 3 ? catalog.retentionHistory.events.map(row => row.requestId) : [])]);
  let previousJob = "";
  for (const row of catalog.lifecycleReceipts) {
    const receipt = row.receipt;
    const initial = receipt.schema === 2 ? receipt.initialPublication : undefined;
    const event = catalog.generationEvents.find(item => item.catalogGeneration === (initial?.catalogGeneration ?? receipt.completedCatalogGeneration));
    const expectedKind = receipt.kind === "rename" || receipt.kind === "restore_aborted" ? "app_metadata"
      : receipt.kind === "create" || receipt.kind === "fork" || receipt.kind === "restore" ? "app_seed" : "app_selected";
    const generation = catalog.generations.find(item => item.descriptor.generationId === row.generationId);
    if (receipt.jobId <= previousJob || jobs.has(receipt.jobId) || operations.has(receipt.operationId)
        || requests.has(receipt.requestId) || receipt.authorityIncarnationId !== catalog.authorityIncarnationId
        || !event || event.eventKind !== expectedKind || event.operationId !== receipt.operationId
        || (!initial && event.at !== receipt.completedAt) || event.appInstanceId !== receipt.resultingSelectedAppInstanceId
        || !generation || generation.descriptor.namespaceId !== row.namespaceId
        || generation.descriptor.target.appInstanceId !== receipt.resultingSelectedAppInstanceId)
      throw invalid("lifecycle receipt identity or terminal event is inconsistent");
    assertLifecycleReattestation(receipt, catalog.generationEvents, catalog.revisionReservations);
    previousJob = receipt.jobId;
    jobs.add(receipt.jobId); operations.add(receipt.operationId); requests.add(receipt.requestId);
    if (receipt.kind === "delete") {
      const victim = catalog.entries.find(item => item.appInstanceId === receipt.requestedAppInstanceId);
      if (!victim?.tombstoned || victim.appInstanceId === receipt.resultingSelectedAppInstanceId)
        throw invalid("lifecycle deletion receipt has no distinct tombstoned target");
    } else if (receipt.kind === "rename" || receipt.kind === "switch") {
      if (receipt.requestedAppInstanceId !== receipt.resultingSelectedAppInstanceId)
        throw invalid("lifecycle metadata or selection receipt is rebound");
    }
    if (receipt.schema === 2) {
      const result = receipt.resultTarget;
      const metadata = catalog.generationEvents.filter(item => item.appInstanceId === result.appInstanceId
        && item.displayName !== null
        && BigInt(item.catalogGeneration) <= BigInt(receipt.completedCatalogGeneration)).at(-1);
      const targetKnown = sameTarget(result, generation.descriptor.target)
        || catalog.revisionReservations.some(item => item.state === "committed"
          && item.appInstanceId === result.appInstanceId && item.publishedActiveGenerationId === result.activeGenerationId
          && item.publishedLineageEpoch === result.lineageEpoch && item.revision === result.protectionRevision
          && item.stateSha256 === result.stateSha256 && item.finalizedCatalogGeneration !== null
          && BigInt(item.finalizedCatalogGeneration) <= BigInt(receipt.completedCatalogGeneration));
      if (!targetKnown || result.activeGenerationId !== row.generationId
          || (event.target !== null && !sameTarget(initial?.target ?? result, event.target))
          || metadata?.displayName !== receipt.resultDisplayName || metadata?.shellId !== receipt.resultShellId)
        throw invalid("lifecycle receipt canonical result is inconsistent");
    }
  }
}

function validateAuthorityHistory(evidence: ArchiveAuthorityEvidence): void {
  const catalog = evidence.catalogAuthority;
  if (evidence.binding.app !== catalog.entry.displayName)
    throw invalid("archive display metadata does not match the selected catalog app");
  if (!sameJson(catalog.schemaObjects, expectedCatalogSchemaObjects(catalog.schema === 3)))
    throw invalid("catalog schema evidence is not the exact versioned allowlist");
  if (catalog.bootstrapManifest.length !== 0
      || catalog.pendingJobs.length !== 0
      || catalog.lineageReservations.length !== 0)
    throw invalid("catalog bootstrap or unfinished-work invariants are not sealed");
  validateRequestReceipts(evidence);
  validateCatalogIdentityRegistry(evidence);
  validateLifecycleReceipts(evidence);
  if (catalog.schema === 3) {
    assertBackupRetentionHistory(catalog.retentionHistory, catalog.backupRecords,
      catalog.authorityIncarnationId, catalog.catalogGeneration, catalog.leases, catalog.generationEvents);
    const requests = new Set(catalog.requestReceipts.map(row => row.requestId));
    if (catalog.retentionHistory.events.some(row => requests.has(row.requestId)))
      throw invalid("retention request identity overlaps an app mutation");
  }
  const targetRevisions = evidence.targetAuthority.revisions;
  const highWater = BigInt(evidence.targetAuthority.header.protectionRevisionHighWater);
  if (BigInt(targetRevisions.length) !== highWater)
    throw invalid("target revision history is incomplete");
  for (let index = 0; index < targetRevisions.length; index++) {
    const revision = targetRevisions[index]!;
    if (BigInt(revision.revision) !== BigInt(index + 1))
      throw invalid("target revision history is reordered or incomplete");
  }
  const targetRevisionByRevision = new Map(targetRevisions.map(revision => [
    revision.revision, revision,
  ]));
  if (targetRevisionByRevision.size !== targetRevisions.length)
    throw invalid("target revision history is duplicated");
  const currentRevision = evidence.target.protectionRevision;
  if (currentRevision !== "0") {
    const current = targetRevisionByRevision.get(currentRevision);
    if (!current || current.state !== "committed" || current.stateSha256 !== evidence.target.stateSha256)
      throw invalid("target revision history does not authenticate current state");
  }

  const generations = catalog.generations;
  const entries = catalog.entries;
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1]!.appInstanceId >= entries[index]!.appInstanceId)
      throw invalid("catalog app entries are reordered or duplicated");
  }
  for (let index = 1; index < generations.length; index++) {
    if (generations[index - 1]!.descriptor.generationId
        >= generations[index]!.descriptor.generationId)
      throw invalid("catalog generation descriptors are reordered or duplicated");
  }
  const entryByApp = new Map(entries.map(entry => [entry.appInstanceId, entry]));
  const generationById = new Map(generations.map(generation => [
    generation.descriptor.generationId, generation,
  ]));
  if (entryByApp.size !== entries.length || generationById.size !== generations.length
      || new Set(generations.map(generation => generation.storageKey)).size !== generations.length)
    throw invalid("catalog app or generation inventory is duplicated");
  for (const generation of generations) {
    if (!entryByApp.has(generation.descriptor.target.appInstanceId))
      throw invalid("catalog generation refers to a missing app");
  }
  for (const candidate of entries) {
    const candidateGenesis = generationById.get(candidate.journalGenesisGenerationId);
    const candidateActive = generationById.get(candidate.activeGenerationId);
    if (!candidateGenesis || !candidateActive
        || candidateGenesis.descriptor.target.appInstanceId !== candidate.appInstanceId
        || candidateGenesis.descriptor.target.lineageEpoch !== candidate.journalGenesisLineageEpoch
        || candidateGenesis.descriptor.target.protectionRevision
          !== candidate.journalGenesisProtectionRevision
        || candidateGenesis.descriptor.target.digestSchema !== candidate.digestSchema
        || candidateGenesis.descriptor.target.stateSha256 !== candidate.journalGenesisStateSha256
        || candidateActive.descriptor.target.appInstanceId !== candidate.appInstanceId
        || candidateActive.descriptor.target.lineageEpoch !== candidate.currentLineageEpoch
        || BigInt(candidateActive.descriptor.target.protectionRevision)
          > BigInt(candidate.currentProtectionRevision))
      throw invalid("catalog generation history is incomplete or mismatched");
  }
  const genesis = generationById.get(catalog.entry.journalGenesisGenerationId);
  const active = generationById.get(catalog.entry.activeGenerationId);
  if (!genesis || !active
      || genesis.descriptor.target.appInstanceId !== catalog.entry.appInstanceId
      || genesis.descriptor.target.lineageEpoch !== catalog.entry.journalGenesisLineageEpoch
      || genesis.descriptor.target.protectionRevision
        !== catalog.entry.journalGenesisProtectionRevision
      || genesis.descriptor.target.digestSchema !== catalog.entry.digestSchema
      || genesis.descriptor.target.stateSha256 !== catalog.entry.journalGenesisStateSha256
      || active.descriptor.target.appInstanceId !== evidence.target.appInstanceId
      || active.descriptor.target.lineageEpoch !== evidence.target.lineageEpoch
      || BigInt(active.descriptor.target.protectionRevision)
        > BigInt(evidence.target.protectionRevision))
    throw invalid("catalog generation descriptors do not authenticate the selected target");

  const reservations = catalog.revisionReservations;
  for (let index = 1; index < reservations.length; index++) {
    const previous = reservations[index - 1]!;
    const current = reservations[index]!;
    if (previous.appInstanceId > current.appInstanceId
        || (previous.appInstanceId === current.appInstanceId
          && BigInt(previous.revision) >= BigInt(current.revision)))
      throw invalid("catalog revision history is reordered or duplicated");
  }
  if (new Set(reservations.map(reservation => reservation.operationId)).size
      !== reservations.length)
    throw invalid("catalog revision operation history is duplicated");
  let activeReservationCount = 0;
  for (const candidate of entries) {
    const candidateGenesis = generationById.get(candidate.journalGenesisGenerationId)!;
    const journal = reservations.filter(reservation =>
      reservation.appInstanceId === candidate.appInstanceId);
    const genesisRevision = BigInt(candidate.journalGenesisProtectionRevision);
    const catalogHighWater = BigInt(candidate.revisionHighWater);
    if (catalogHighWater < genesisRevision
        || BigInt(journal.length) !== catalogHighWater - genesisRevision)
      throw invalid("catalog revision history is incomplete");
    let chained: TargetEvidence = candidateGenesis.descriptor.target;
    let previousCatalogGeneration = -1n;
    for (let index = 0; index < journal.length; index++) {
      const reservation = journal[index]!;
      const expectedRevision = genesisRevision + BigInt(index + 1);
      const reservedGeneration = BigInt(reservation.reservedCatalogGeneration);
      const finalizedGeneration = reservation.finalizedCatalogGeneration === null
        ? null : BigInt(reservation.finalizedCatalogGeneration);
      if (BigInt(reservation.revision) !== expectedRevision
          || reservedGeneration <= previousCatalogGeneration
          || reservedGeneration > BigInt(catalog.catalogGeneration)
          || (finalizedGeneration !== null
            && (finalizedGeneration !== reservedGeneration + 1n
              || finalizedGeneration > BigInt(catalog.catalogGeneration)))
          || reservation.authorityIncarnationId !== catalog.authorityIncarnationId
          || reservation.appInstanceId !== chained.appInstanceId
          || reservation.activeGenerationId !== chained.activeGenerationId
          || reservation.lineageEpoch !== chained.lineageEpoch
          || reservation.expectedProtectionRevision !== chained.protectionRevision
          || reservation.expectedStateSha256 !== chained.stateSha256
          || (reservation.state === "reserved" && index !== journal.length - 1))
        throw invalid("catalog revision history is mismatched or reordered");
      previousCatalogGeneration = finalizedGeneration ?? reservedGeneration;
      if (reservation.state === "reserved") activeReservationCount++;
      if (reservation.state === "committed") {
        const published = reservation.publishedActiveGenerationId === null
          ? undefined : generationById.get(reservation.publishedActiveGenerationId);
        if (!published || reservation.publishedLineageEpoch === null
            || reservation.stateSha256 === null
            || reservation.publishedActiveGenerationId !== reservation.activeGenerationId
            || reservation.publishedLineageEpoch !== reservation.lineageEpoch
            || published.descriptor.target.appInstanceId !== candidate.appInstanceId
            || published.descriptor.target.lineageEpoch !== reservation.publishedLineageEpoch
            || BigInt(published.descriptor.target.protectionRevision)
              > BigInt(reservation.revision))
          throw invalid("committed catalog revision has no matching generation evidence");
        chained = {
          appInstanceId: reservation.appInstanceId,
          activeGenerationId: reservation.publishedActiveGenerationId,
          lineageEpoch: reservation.publishedLineageEpoch,
          protectionRevision: reservation.revision,
          digestSchema: candidate.digestSchema,
          stateSha256: reservation.stateSha256,
        };
      }
      if (candidate.appInstanceId === catalog.selectedAppInstanceId) {
        const targetMirror = targetRevisionByRevision.get(reservation.revision);
        if (!targetMirror
            || targetMirror.operationId !== reservation.operationId
            || targetMirror.expectedProtectionRevision !== reservation.expectedProtectionRevision
            || targetMirror.expectedStateSha256 !== reservation.expectedStateSha256
            || targetMirror.requestSha256 !== reservation.requestSha256
            || targetMirror.state !== reservation.state
            || targetMirror.stateSha256 !== reservation.stateSha256
            || targetMirror.reservedAt !== reservation.reservedAt
            || targetMirror.finalizedAt !== reservation.finalizedAt)
          throw invalid("target and catalog revision histories disagree");
      }
    }
    const current: TargetEvidence = {
      appInstanceId: candidate.appInstanceId,
      activeGenerationId: candidate.activeGenerationId,
      lineageEpoch: candidate.currentLineageEpoch,
      protectionRevision: candidate.currentProtectionRevision,
      digestSchema: candidate.digestSchema,
      stateSha256: candidate.stateSha256,
    };
    if (!sameTarget(chained, current))
      throw invalid("catalog revision history does not reach an app target");
  }
  if (activeReservationCount > 1)
    throw invalid("catalog contains multiple active revision reservations");

  const backupRecords = catalog.backupRecords;
  const backupByOperation = new Map<string, (typeof backupRecords)[number]>();
  const backupGenerationIds = new Set<string>();
  const backupSeriesGenerations = new Set<string>();
  const backupFileNames = new Set<string>();
  for (let index = 0; index < backupRecords.length; index++) {
    const backup = backupRecords[index]!;
    if (index > 0 && backupRecords[index - 1]!.backupId >= backup.backupId)
      throw invalid("catalog backup records are reordered or duplicated");
    const backupEvent = catalog.generationEvents.find(event =>
      event.eventKind === "backup_published"
      && event.catalogGeneration === backup.publicationCatalogGeneration);
    const generation = generationById.get(backup.evidence.activeGenerationId);
    const matchesGeneration = generation !== undefined
      && sameTarget(backup.evidence, generation.descriptor.target);
    const matchesRevision = reservations.some(reservation =>
      reservation.state === "committed"
      && reservation.appInstanceId === backup.evidence.appInstanceId
      && reservation.publishedActiveGenerationId === backup.evidence.activeGenerationId
      && reservation.publishedLineageEpoch === backup.evidence.lineageEpoch
      && reservation.revision === backup.evidence.protectionRevision
      && reservation.stateSha256 === backup.evidence.stateSha256);
    const seriesGeneration = `${backup.authentication.seriesId}:${backup.authentication.generation}`;
    if (!entryByApp.has(backup.evidence.appInstanceId)
        || !generation
        || generation.descriptor.target.appInstanceId !== backup.evidence.appInstanceId
        || (!matchesGeneration && !matchesRevision)
        || BigInt(backup.publicationCatalogGeneration) > BigInt(catalog.catalogGeneration)
        || !backupEvent || backupEvent.operationId === null
        || backupEvent.appInstanceId !== backup.evidence.appInstanceId
        || backupEvent.at !== backup.validatedAt
        || backupByOperation.has(backupEvent.operationId)
        || backupGenerationIds.has(backup.generationId)
        || backupSeriesGenerations.has(seriesGeneration)
        || backupFileNames.has(backup.fileName))
      throw invalid("catalog backup history is incomplete or inconsistent");
    backupByOperation.set(backupEvent.operationId, backup);
    backupGenerationIds.add(backup.generationId);
    backupSeriesGenerations.add(seriesGeneration);
    backupFileNames.add(backup.fileName);
  }

  const events = catalog.generationEvents;
  const eventByGeneration = new Map<string, CatalogGenerationEvent>();
  let previousEventEpoch = 0n;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const eventEpoch = BigInt(event.writeEpoch);
    if (BigInt(event.catalogGeneration) !== BigInt(index + 1)
        || BigInt(event.catalogGeneration) > BigInt(catalog.catalogGeneration)
        || eventEpoch < previousEventEpoch || eventEpoch > BigInt(catalog.writeEpoch))
      throw invalid("catalog event history is reordered, duplicated, or incomplete");
    previousEventEpoch = eventEpoch;
    eventByGeneration.set(event.catalogGeneration, event);
    const reservation = event.operationId === null ? undefined
      : reservations.find(candidate => candidate.operationId === event.operationId);
    if (event.eventKind === "app_selected") {
      const selectedTarget = event.target!;
      const generation = generationById.get(selectedTarget.activeGenerationId);
      const matchesGenesis = generation !== undefined
        && sameTarget(selectedTarget, generation.descriptor.target);
      const matchesCommit = reservations.some(candidate =>
        candidate.state === "committed"
        && candidate.appInstanceId === selectedTarget.appInstanceId
        && candidate.publishedActiveGenerationId === selectedTarget.activeGenerationId
        && candidate.publishedLineageEpoch === selectedTarget.lineageEpoch
        && candidate.revision === selectedTarget.protectionRevision
        && candidate.stateSha256 === selectedTarget.stateSha256);
      if (!matchesGenesis && !matchesCommit)
        throw invalid("catalog app selection event is invalid");
    } else if (event.eventKind === "app_metadata") {
      if (!entryByApp.has(event.appInstanceId!))
        throw invalid("catalog metadata event references an unknown app");
    } else if (event.eventKind === "backup_published") {
      const backup = event.operationId === null ? undefined : backupByOperation.get(event.operationId);
      if (!backup || backup.publicationCatalogGeneration !== event.catalogGeneration
          || backup.evidence.appInstanceId !== event.appInstanceId
          || backup.validatedAt !== event.at)
        throw invalid("catalog backup publication event is invalid");
    } else if (event.eventKind !== "app_seed" && event.eventKind !== "lease_issued") {
      if (!reservation || reservation.appInstanceId !== event.appInstanceId)
        throw invalid("catalog revision event is orphaned");
      if (event.eventKind === "revision_reserved") {
        if (reservation.reservedCatalogGeneration !== event.catalogGeneration
            || reservation.writeEpoch !== event.writeEpoch
            || reservation.reservedAt !== event.at)
          throw invalid("catalog reservation event is invalid");
      } else {
        const expectedState = event.eventKind === "revision_committed"
          ? "committed" : "abandoned";
        const reservedEpoch = BigInt(reservation.writeEpoch);
        const finalizedEpoch = BigInt(reservation.finalizedWriteEpoch!);
        const isTakeover = event.eventKind === "recovery_takeover";
        if (reservation.state !== expectedState
            || reservation.finalizedCatalogGeneration !== event.catalogGeneration
            || reservation.finalizedWriteEpoch !== event.writeEpoch
            || reservation.finalizedAt !== event.at
            || (isTakeover && finalizedEpoch !== reservedEpoch + 1n)
            || (!isTakeover && finalizedEpoch !== reservedEpoch))
          throw invalid("catalog finalization event is invalid");
      }
    }
  }
  for (const reservation of reservations) {
    const reservedEvent = eventByGeneration.get(reservation.reservedCatalogGeneration);
    if (!reservedEvent || reservedEvent.eventKind !== "revision_reserved"
        || reservedEvent.operationId !== reservation.operationId)
      throw invalid("catalog reservation event is missing");
    if (reservation.finalizedCatalogGeneration !== null) {
      const finalizedEvent = eventByGeneration.get(reservation.finalizedCatalogGeneration);
      if (!finalizedEvent || finalizedEvent.operationId !== reservation.operationId
          || !["revision_committed", "revision_abandoned", "recovery_takeover"]
            .includes(finalizedEvent.eventKind))
        throw invalid("catalog finalization event is missing");
    }
  }
  if (events.length === 0
      || events.at(-1)!.catalogGeneration !== catalog.catalogGeneration
      || events.at(-1)!.writeEpoch !== catalog.writeEpoch)
    throw invalid("catalog event history does not reach the authoritative root");
  const leases = catalog.leases;
  const issuanceByEpochAndTime = new Map<string, CatalogGenerationEvent[]>();
  for (const event of events) {
    if (event.eventKind !== "lease_issued" && event.eventKind !== "recovery_takeover") continue;
    const key = `${event.writeEpoch}\u0000${event.at}`;
    const matching = issuanceByEpochAndTime.get(key);
    if (matching) matching.push(event);
    else issuanceByEpochAndTime.set(key, [event]);
  }
  for (let index = 0; index < leases.length; index++) {
    const lease = leases[index]!;
    if ((index > 0 && (compareUint64(leases[index - 1]!.writeEpoch, lease.writeEpoch) > 0
          || (leases[index - 1]!.writeEpoch === lease.writeEpoch
            && leases[index - 1]!.leaseId >= lease.leaseId)))
        || lease.authorityIncarnationId !== catalog.authorityIncarnationId
        || BigInt(lease.writeEpoch) > BigInt(catalog.writeEpoch))
      throw invalid("catalog lease history is mismatched or reordered");
    const issuedAt = new Date(Number(lease.issuedAtMs)).toISOString();
    const issuance = issuanceByEpochAndTime.get(`${lease.writeEpoch}\u0000${issuedAt}`) ?? [];
    if (issuance.length !== 1)
      throw invalid("catalog lease issuance evidence is missing or ambiguous");
  }
  const activeLeases = leases.filter(lease => !lease.revoked);
  if (activeLeases.length > 1
      || (activeLeases.length === 1
        && (activeLeases[0]!.authorityIncarnationId !== catalog.authorityIncarnationId
          || activeLeases[0]!.writeEpoch !== catalog.writeEpoch)))
    throw invalid("active catalog lease history is invalid");
  const leaseById = new Map(leases.map(lease => [lease.leaseId, lease]));
  const issuanceEvents = events.filter(event =>
    event.eventKind === "lease_issued" || event.eventKind === "recovery_takeover");
  if (new Set(leases.map(lease => lease.leaseId)).size !== leases.length
      || issuanceEvents.length !== leases.length)
    throw invalid("catalog lease history is incomplete");
  const catalogReservationEvents = new Set<string>();
  for (const reservation of reservations) {
    const reservingLease = leaseById.get(reservation.leaseId);
    const app = entryByApp.get(reservation.appInstanceId);
    const generation = generationById.get(reservation.activeGenerationId);
    const reservedAtMs = BigInt(Date.parse(reservation.reservedAt));
    if (reservation.authorityIncarnationId !== catalog.authorityIncarnationId
        || !reservingLease
        || reservingLease.authorityIncarnationId !== reservation.authorityIncarnationId
        || reservingLease.writeEpoch !== reservation.writeEpoch
        || reservingLease.releaseId !== reservation.releaseId
        || !app || !generation
        || generation.descriptor.target.appInstanceId !== reservation.appInstanceId
        || generation.descriptor.target.lineageEpoch !== reservation.lineageEpoch
        || reservedAtMs < BigInt(reservingLease.issuedAtMs)
        || reservedAtMs >= BigInt(reservingLease.expiresAtMs)
        || BigInt(reservation.reservedCatalogGeneration) > BigInt(catalog.catalogGeneration)
        || (reservation.finalizedCatalogGeneration !== null
          && BigInt(reservation.finalizedCatalogGeneration) > BigInt(catalog.catalogGeneration)))
      throw invalid("catalog reservation authority relationship is invalid");
    if (reservation.finalizedAt !== null) {
      const finalizingLease = reservation.finalizedLeaseId === null
        ? undefined : leaseById.get(reservation.finalizedLeaseId);
      const finalizedAtMs = BigInt(Date.parse(reservation.finalizedAt));
      const reservedEpoch = BigInt(reservation.writeEpoch);
      const finalizedEpoch = BigInt(reservation.finalizedWriteEpoch!);
      if (!finalizingLease
          || finalizingLease.authorityIncarnationId !== reservation.authorityIncarnationId
          || finalizingLease.writeEpoch !== reservation.finalizedWriteEpoch
          || finalizingLease.releaseId !== reservation.finalizedReleaseId
          || finalizedAtMs < reservedAtMs
          || finalizedAtMs < BigInt(finalizingLease.issuedAtMs)
          || finalizedAtMs >= BigInt(finalizingLease.expiresAtMs)
          || finalizedEpoch < reservedEpoch
          || (finalizedEpoch === reservedEpoch
            && (reservation.finalizedLeaseId !== reservation.leaseId
              || reservation.finalizedReleaseId !== reservation.releaseId))
          || (finalizedEpoch > reservedEpoch
            && (reservation.state !== "abandoned"
              || finalizedEpoch !== reservedEpoch + 1n
              || !reservingLease.revoked
              || BigInt(finalizingLease.issuedAtMs) < BigInt(reservingLease.expiresAtMs)
              || finalizedAtMs !== BigInt(finalizingLease.issuedAtMs))))
        throw invalid("catalog finalization authority relationship is invalid");
    }
    for (const catalogGeneration of [
      reservation.reservedCatalogGeneration,
      reservation.finalizedCatalogGeneration,
    ]) {
      if (catalogGeneration === null) continue;
      if (catalogReservationEvents.has(catalogGeneration))
        throw invalid("catalog reservation reuses a generation event");
      catalogReservationEvents.add(catalogGeneration);
    }
    if (reservation.state === "reserved") {
      const current: TargetEvidence = {
        appInstanceId: app.appInstanceId,
        activeGenerationId: app.activeGenerationId,
        lineageEpoch: app.currentLineageEpoch,
        protectionRevision: app.currentProtectionRevision,
        digestSchema: app.digestSchema,
        stateSha256: app.stateSha256,
      };
      if (catalog.selectedAppInstanceId !== app.appInstanceId
          || !sameTarget(current, {
            appInstanceId: reservation.appInstanceId,
            activeGenerationId: reservation.activeGenerationId,
            lineageEpoch: reservation.lineageEpoch,
            protectionRevision: reservation.expectedProtectionRevision,
            digestSchema: app.digestSchema,
            stateSha256: reservation.expectedStateSha256,
          })
          || reservation.revision !== app.revisionHighWater
          || reservation.reservedCatalogGeneration !== catalog.catalogGeneration)
        throw invalid("active revision reservation is not current");
    }
  }
  const latestSelection = events.filter(event =>
    event.eventKind === "app_seed" || event.eventKind === "app_selected").at(-1);
  if (!latestSelection || latestSelection.appInstanceId !== catalog.selectedAppInstanceId)
    throw invalid("catalog current selection does not match its event history");
  for (const candidate of entries) {
    const candidateGenesis = generationById.get(candidate.journalGenesisGenerationId)!;
    const candidateSeeds = events.filter(event =>
      event.eventKind === "app_seed" && event.appInstanceId === candidate.appInstanceId);
    if (candidateSeeds.length !== 1
        || candidateSeeds[0]!.operationId !== candidateGenesis.operationId
        || candidateSeeds[0]!.at !== candidateGenesis.descriptor.sealedAt
        || candidateSeeds[0]!.target === null
        || !sameTarget(candidateSeeds[0]!.target!, candidateGenesis.descriptor.target))
      throw invalid("catalog app genesis event is missing or mismatched");
    const latestMetadata = [...events].reverse().find(event =>
      event.appInstanceId === candidate.appInstanceId && event.displayName !== null);
    if (!latestMetadata || latestMetadata.displayName !== candidate.displayName
        || latestMetadata.shellId !== candidate.shellId)
      throw invalid("catalog app metadata does not match its latest event");
  }
  const seedEvents = events.filter(event =>
    event.eventKind === "app_seed" && event.appInstanceId === evidence.target.appInstanceId);
  if (seedEvents.length !== 1 || seedEvents[0]!.operationId !== genesis.operationId
      || seedEvents[0]!.at !== genesis.descriptor.sealedAt
      || seedEvents[0]!.target === null
      || !sameTarget(seedEvents[0]!.target!, genesis.descriptor.target))
    throw invalid("catalog genesis event is missing or mismatched");
}

function validateFormat5Binding(
  manifest: ArchiveManifest,
  evidence: ArchiveAuthorityEvidence,
  user: Uint8Array,
  system: Uint8Array,
  authority: Uint8Array,
): void {
  const expectedBinding = {
    format: 5 as const,
    app: manifest.app,
    exportedAt: manifest.exported_at,
    tables: manifest.tables,
    versions: manifest.versions,
    attachments: manifest.attachments,
    userDb: manifest.files.userDb,
    systemDb: manifest.files.systemDb,
  };
  if (JSON.stringify(evidence.binding) !== JSON.stringify(expectedBinding)
      || manifest.files.userDb.bytes !== user.byteLength
      || manifest.files.userDb.sha256 !== digest(user)
      || manifest.files.systemDb.bytes !== system.byteLength
      || manifest.files.systemDb.sha256 !== digest(system)
      || manifest.files.authority.bytes !== authority.byteLength
      || manifest.files.authority.sha256 !== digest(authority))
    throw invalid("archive member checksum or authority binding does not match");
  validateAuthorityHistory(evidence);
}

export type ArchiveAuthorityClaim =
  | {
      kind: "legacy_archive";
      format: 1 | 2 | 3 | 4;
      checksumConsistent: false;
      evidence: null;
    }
  | {
      kind: "format5_internal_consistency";
      format: 5;
      checksumConsistent: true;
      evidence: ArchiveAuthorityEvidence;
    };

/**
 * Validate authority evidence before delegating to the existing isolated
 * archive staging and transactional fresh-store installer.
 */
export async function importAuthorityArchive(
  bytes: Uint8Array,
  openFresh?: () => Promise<DbDriver>,
): Promise<{
  store: ClayStore;
  manifest: ClayManifest | ArchiveManifest;
  invalidPanels: string[];
  authority: ArchiveAuthorityClaim;
}> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new ClayError("E_LIMIT", "archive exceeds the 384 MB import limit");
  const entries = zipRead(bytes);
  const names = entries.map(entry => entry.name);
  if (new Set(names).size !== names.length)
    throw invalid("archive members are duplicated");
  const manifestEntry = entries.find(entry => entry.name === "manifest.json");
  if (!manifestEntry) throw invalid("manifest.json is missing");
  if (manifestEntry.data.byteLength > MAX_MANIFEST_BYTES)
    throw new ClayError("E_LIMIT", "archive manifest exceeds the 64 KiB import limit");
  const rawManifest = parseJsonMember(manifestEntry.data, "manifest.json");
  const format = rawManifest && typeof rawManifest === "object" && "format" in rawManifest
    ? (rawManifest as { format?: unknown }).format : undefined;
  if (format === 1 || format === 2 || format === 3 || format === 4) {
    const imported = await ClayStore.importArchive(bytes, openFresh);
    return {
      ...imported,
      authority: {
        kind: "legacy_archive",
        format: imported.manifest.format,
        checksumConsistent: false,
        evidence: null,
      },
    };
  }
  if (format !== 5) throw invalid(`unsupported archive format ${String(format)}`);
  if (entries.length !== FORMAT_5_FILES.size
      || names.some(name => !FORMAT_5_FILES.has(name)))
    throw invalid("format 5 archive must contain exactly four authority-bound members");

  let manifest: ArchiveManifest;
  try { manifest = ArchiveManifestV5.parse(rawManifest); }
  catch { throw invalid("format 5 manifest is malformed"); }
  if (!bytesEqual(manifestEntry.data, canonicalBytes(manifest)))
    throw invalid("format 5 manifest is not canonically encoded");
  const authorityEntry = entries.find(entry => entry.name === "authority.json")!;
  const userEntry = entries.find(entry => entry.name === "user.db")!;
  const systemEntry = entries.find(entry => entry.name === "system.db")!;
  if (authorityEntry.data.byteLength + userEntry.data.byteLength + systemEntry.data.byteLength
      > MAX_ARCHIVE_BYTES)
    throw new ClayError("E_LIMIT", "archive payload exceeds the 384 MB import limit");
  assertArchiveAuthorityMemberSize(authorityEntry.data.byteLength);
  if (manifest.files.authority.bytes !== authorityEntry.data.byteLength
      || manifest.files.authority.sha256 !== digest(authorityEntry.data))
    throw invalid("authority.json checksum does not match the manifest");

  let evidence: ArchiveAuthorityEvidence;
  try {
    const rawAuthority = parseJsonMember(authorityEntry.data, "authority.json");
    assertArchiveAuthorityCardinality(rawAuthority);
    evidence = ArchiveAuthorityEvidenceV1.parse(rawAuthority);
  } catch (error) {
    if (error instanceof ClayError) throw error;
    throw invalid("authority.json is malformed");
  }
  if (!bytesEqual(authorityEntry.data, canonicalBytes(evidence)))
    throw invalid("authority.json is not canonically encoded");
  validateFormat5Binding(
    manifest, evidence, userEntry.data, systemEntry.data, authorityEntry.data,
  );

  const stagingDriver = await openDriverFromBytes(userEntry.data, systemEntry.data);
  try {
    const stagingRegistry = registryFromDriver(stagingDriver);
    const canonical = enumerateCanonicalStateV1(
      stagingDriver, stagingRegistry,
    );
    validateSampleProvenanceLedger(stagingDriver, stagingRegistry, evidence);
    StateMerkleIndex.createSchema(stagingDriver);
    const rebuiltMerkle = StateMerkleIndex.initialize(
      stagingDriver, canonical.leaves.map(entry => entry.seed),
    ).audit();
    if (canonical.stateSha256 !== evidence.target.stateSha256
        || canonical.stateSha256 !== evidence.merkle.stateSha256
        || canonical.leaves.length !== evidence.merkle.leafCount
        || rebuiltMerkle.stateSha256 !== evidence.merkle.stateSha256
        || rebuiltMerkle.leafCount !== evidence.merkle.leafCount
        || !sameJson(rebuiltMerkle.bucketRoots, evidence.merkle.bucketRoots))
      throw invalid("authority evidence does not match canonical archive Merkle state");
  } finally {
    stagingDriver.close();
  }
  if (openFresh)
    throw new ClayError(
      "E_CATALOG_UNAVAILABLE",
      "format 5 restore-as-new requires worker-owned target reconstruction",
    );

  const legacyManifest: ClayManifest = {
    format: 4,
    app: manifest.app,
    exported_at: manifest.exported_at,
    tables: manifest.tables,
    versions: manifest.versions,
    attachments: manifest.attachments,
  };
  const validatedPayload = zipWrite([
    { name: "manifest.json", data: canonicalBytes(legacyManifest) },
    { name: "user.db", data: userEntry.data },
    { name: "system.db", data: systemEntry.data },
  ]);
  const imported = await ClayStore.importArchive(validatedPayload);
  return {
    store: imported.store,
    manifest,
    invalidPanels: imported.invalidPanels,
    authority: {
      kind: "format5_internal_consistency",
      format: 5,
      checksumConsistent: true,
      evidence,
    },
  };
}

export async function importAuthenticatedAuthorityArchive(
  bytes: Uint8Array,
  resolveKey: BackupTrustKeyResolver,
  openFresh?: () => Promise<DbDriver>,
  ownership: "retained" | "transferred" = "retained",
): Promise<{
  store: ClayStore;
  manifest: ArchiveManifest;
  invalidPanels: string[];
  authority: {
    kind: "authenticated_format5_authority";
    format: 5;
    cryptographicallyAuthenticated: true;
    checksumConsistent: true;
    authentication: AuthenticatedArchiveHeaderV1;
    envelopeSha256: string;
    evidence: ArchiveAuthorityEvidence;
  };
}> {
  const verified = ownership === "transferred"
    ? verifyAuthenticatedArchiveV5Owned(bytes, resolveKey)
    : verifyAuthenticatedArchiveV5(bytes, resolveKey);
  const imported = await importAuthorityArchive(verified.payload, openFresh);
  if (imported.manifest.format !== 5
      || imported.authority.kind !== "format5_internal_consistency") {
    imported.store.close();
    throw invalid("authenticated envelope payload is not format 5 authority evidence");
  }
  return {
    store: imported.store,
    manifest: imported.manifest as ArchiveManifest,
    invalidPanels: imported.invalidPanels,
    authority: {
      kind: "authenticated_format5_authority",
      format: 5,
      cryptographicallyAuthenticated: true,
      checksumConsistent: true,
      authentication: verified.header,
      envelopeSha256: digest(bytes),
      evidence: imported.authority.evidence,
    },
  };
}

export async function validateAuthenticatedAuthorityArchiveStage(
  bytes: Uint8Array,
  expectedTarget: TargetEvidence,
  resolveKey: BackupTrustKeyResolver,
): Promise<BackupStageValidation> {
  let imported: Awaited<ReturnType<typeof importAuthenticatedAuthorityArchive>> | undefined;
  try {
    imported = await importAuthenticatedAuthorityArchive(
      bytes, resolveKey, undefined, "transferred",
    );
    if (!sameTarget(imported.authority.evidence.target, expectedTarget))
      return { schema: 1, status: "invalid", evidence: null };
    const authentication = imported.authority.authentication;
    return BackupStageValidationV1.parse({
      schema: 1,
      status: "valid",
      evidence: imported.authority.evidence.target,
      authentication: {
        schema: 1,
        kind: "cose_mac0_hmac_256_256",
        authenticationVersion: 1,
        keyId: bytesToHex(authentication.keyId),
        seriesId: bytesToHex(authentication.seriesId),
        generation: authentication.generation.toString(),
      },
    });
  } catch {
    return { schema: 1, status: "invalid", evidence: null };
  } finally {
    imported?.store.close();
  }
}

/**
 * Install a fully validated format-5 payload into an empty physical target,
 * then mint only the caller-provided worker-owned identity. Source authority,
 * reservations, receipts, and counters are evidence and are never installed.
 */
export type ArchiveRestoreInstallContext = Readonly<{
  driver: DbDriver;
  store: ClayStore;
  manifest: ArchiveManifest;
  sourceAuthority: Extract<ArchiveAuthorityClaim, { format: 5 }>;
  target: TargetEvidence;
  generation: ReturnType<typeof ArchiveGenerationEvidenceV1.parse>;
}>;

export type ArchiveRestoreInstallHooks = Readonly<{
  wrapFreshDriver?: (driver: DbDriver) => Readonly<{
    driver: DbDriver;
    runAuthorized: (write: () => void) => void;
  }>;
  afterAuthorityReadBack?: (context: ArchiveRestoreInstallContext) => TargetEvidence | void;
}>;

export async function restoreAuthorityArchiveAsNew(
  bytes: Uint8Array,
  rawIdentity: ArchiveRestoreIdentity,
  openFresh: () => Promise<DbDriver>,
  hooks: ArchiveRestoreInstallHooks = {},
): Promise<{
  store: ClayStore;
  manifest: ArchiveManifest;
  invalidPanels: string[];
  sourceAuthority: Extract<ArchiveAuthorityClaim, { format: 5 }>;
  target: TargetEvidence;
  generation: ReturnType<typeof ArchiveGenerationEvidenceV1.parse>;
}> {
  let identity: ArchiveRestoreIdentity;
  try { identity = ArchiveRestoreAsNewIdentityV1.parse(rawIdentity); }
  catch { throw invalid("restore-as-new identity is malformed"); }
  if (typeof openFresh !== "function")
    throw invalid("restore-as-new requires a fresh target opener");

  const validated = await importAuthorityArchive(bytes);
  if (validated.authority.kind !== "format5_internal_consistency") {
    validated.store.close();
    throw invalid("restore-as-new requires certified format 5 authority evidence");
  }
  const sourceAuthority = validated.authority;
  const sourceHasSamples = hasNonemptySampleProvenance(validated.store);
  const sourceIds = new Set(sourceAuthority.evidence.catalogAuthority.idRegistry
    .map(entry => entry.idValue));
  if ([identity.appInstanceId, identity.generationId, identity.namespaceId, identity.operationId]
    .some(value => sourceIds.has(value))) {
    validated.store.close();
    throw invalid("restore-as-new identity must be fresh and must not reuse source authority");
  }

  let legacy: Uint8Array;
  try {
    legacy = await validated.store.exportArchive(validated.manifest.app);
  } finally {
    validated.store.close();
  }

  let physicalFreshDriver: DbDriver | undefined;
  let installedDriver: DbDriver | undefined;
  let writeSession: ReturnType<NonNullable<ArchiveRestoreInstallHooks["wrapFreshDriver"]>>
    | undefined;
  let installedTarget: TargetEvidence | undefined;
  let installedGeneration: ReturnType<typeof ArchiveGenerationEvidenceV1.parse> | undefined;
  const imported = await ClayStore.importArchive(legacy, async () => {
    const candidate = await openFresh();
    try {
      const objects = candidate.select(
        `SELECT 'main' AS database_name,name FROM main.sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         UNION ALL
         SELECT 'sys' AS database_name,name FROM sys.sqlite_master
         WHERE name NOT LIKE 'sqlite_%'`,
      );
      if (objects.length !== 0)
        throw invalid("restore-as-new target is not physically empty");
      physicalFreshDriver = candidate;
      return candidate;
    } catch (error) {
      candidate.close();
      throw error;
    }
  }, {
    wrapFreshDriver: physical => {
      writeSession = hooks.wrapFreshDriver?.(physical);
      installedDriver = writeSession?.driver ?? physical;
      return installedDriver;
    },
    runFreshInstall: install => {
      const authorize = writeSession?.runAuthorized ?? ((write: () => void) => write());
      authorize(install);
    },
    afterReadBack: (installedStore, driver) => {
      const canonical = enumerateCanonicalStateV1(
        driver, installedStore.validationRegistrySnapshot(),
      );
      if (canonical.stateSha256 !== sourceAuthority.evidence.target.stateSha256)
        throw invalid("restored canonical state does not match the authenticated source");
      StateMerkleIndex.createSchema(driver);
      const merkle = StateMerkleIndex.initialize(
        driver, canonical.leaves.map(entry => entry.seed),
      ).audit();
      const target = TargetEvidenceV1.parse({
        appInstanceId: identity.appInstanceId,
        activeGenerationId: identity.generationId,
        lineageEpoch: "0",
        protectionRevision: "0",
        digestSchema: 1,
        stateSha256: merkle.stateSha256,
      });
      TargetAuthorityStore.createSchema(driver);
      const targetAuthority = TargetAuthorityStore.initialize(driver, {
        schema: 1,
        appInstanceId: target.appInstanceId,
        activeGenerationId: target.activeGenerationId,
        lineageEpoch: target.lineageEpoch,
        lineageEpochHighWater: "0",
        protectionRevision: target.protectionRevision,
        protectionRevisionHighWater: "0",
        digestSchema: target.digestSchema,
      });
      if (!sameTarget(targetAuthority.evidence(), target)
          || targetAuthority.reservations().length !== 0
          || driver.select("SELECT request_id FROM sys.production_request_receipts").length !== 0)
        throw invalid("restore-as-new target authority failed read-back");
      const generation = ArchiveGenerationEvidenceV1.parse({
        schema: 1,
        operationId: identity.operationId,
        storageKey: identity.generationId,
        descriptor: {
          schema: 1,
          generationId: identity.generationId,
          target,
          namespaceId: identity.namespaceId,
          sourceArchiveSha256: digest(bytes),
          sourceProvenanceId: null,
          sealedAt: identity.restoredAt,
          readBackAt: identity.restoredAt,
        },
      });
      const finalTarget = hooks.afterAuthorityReadBack?.({
        driver,
        store: installedStore,
        manifest: validated.manifest as ArchiveManifest,
        sourceAuthority,
        target,
        generation,
      }) ?? target;
      const parsedFinalTarget = TargetEvidenceV1.parse(finalTarget);
      if (parsedFinalTarget.appInstanceId !== target.appInstanceId
          || parsedFinalTarget.activeGenerationId !== target.activeGenerationId
          || parsedFinalTarget.lineageEpoch !== target.lineageEpoch
          || parsedFinalTarget.digestSchema !== target.digestSchema
          || !sameTarget(TargetAuthorityStore.open(driver).evidence(), parsedFinalTarget)
          || (sourceHasSamples && parsedFinalTarget.protectionRevision === "0"))
        throw invalid("restored sample provenance was not atomically re-attested");
      installedTarget = parsedFinalTarget;
      installedGeneration = generation;
    },
  });
  if (!physicalFreshDriver || !installedDriver || !installedTarget || !installedGeneration) {
    imported.store.close();
    throw invalid("restore-as-new did not receive a fresh physical target");
  }

  try {
    return {
      store: imported.store,
      manifest: validated.manifest as ArchiveManifest,
      invalidPanels: imported.invalidPanels,
      sourceAuthority,
      target: installedTarget,
      generation: installedGeneration,
    };
  } catch (error) {
    imported.store.close();
    throw error;
  }
}
