import {
  ArchiveAuthorityEvidenceV1,
  ArchiveCatalogLeaseV1,
  ArchiveGenerationEvidenceV1,
  ArchiveManifestV5,
  CatalogGenerationEventV1,
  ImmutableAppGenerationV1,
  MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES,
  MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES,
  type ArchiveAuthorityEvidenceV1 as ArchiveAuthorityEvidence,
  type ArchiveManifestV5 as ArchiveManifest,
  type CatalogGenerationEventV1 as CatalogGenerationEvent,
  type CatalogRevisionReservationV1 as CatalogRevisionReservation,
  type TargetEvidenceV1 as TargetEvidence,
} from "@clay/schema/catalog";
import { enumerateCanonicalStateV1, verifyCanonicalStateV1 } from "./canonical-state";
import type { DbDriver, SqlRow } from "./db";
import { openDriverFromBytes } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { ClayError } from "./errors";
import type { RegTable, Registry } from "./registry";
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
  if (target && typeof target === "object" && !Array.isArray(target))
    histories.push((target as Record<string, unknown>).revisions);
  const catalog = record.catalogAuthority;
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
    const catalogRecord = catalog as Record<string, unknown>;
    histories.push(
      catalogRecord.generations,
      catalogRecord.leases,
      catalogRecord.revisionReservations,
      catalogRecord.generationEvents,
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

function digest(bytes: Uint8Array): string {
  return `sha256:${sha256HexSync(bytes)}`;
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

function mapGeneration(row: SqlRow) {
  return ArchiveGenerationEvidenceV1.parse({
    schema: 1,
    operationId: row.operation_id,
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
  });
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

  const revisionReservations = catalog.revisionReservations()
    .filter(reservation => reservation.appInstanceId === target.appInstanceId);
  const generationIds = new Set<string>([
    entry.journalGenesisGenerationId,
    entry.activeGenerationId,
  ]);
  for (const reservation of revisionReservations) {
    generationIds.add(reservation.activeGenerationId);
    if (reservation.publishedActiveGenerationId !== null)
      generationIds.add(reservation.publishedActiveGenerationId);
  }
  const generations = driver.select(
    "SELECT * FROM catalog.generations WHERE app_instance_id = ? ORDER BY generation_id",
    [target.appInstanceId],
  ).map(mapGeneration).filter(generation => generationIds.has(generation.descriptor.generationId));
  if (generations.length !== generationIds.size)
    throw invalid("catalog generation evidence is incomplete");

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

  return {
    schema: 1,
    authorityIncarnationId: snapshot.authorityIncarnationId,
    catalogGeneration: snapshot.catalogGeneration,
    writeEpoch: snapshot.writeEpoch,
    selectedAppInstanceId: target.appInstanceId,
    entry,
    generations,
    leases,
    revisionReservations,
    generationEvents,
  };
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

  const sourceCanonical = verifyCanonicalStateV1(
    authorityDriver, registryFromDriver(authorityDriver),
  );
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
    merkle: { schema: 1, stateSha256: merkle.stateSha256, leafCount: merkle.leafCount },
    targetAuthority,
    catalogAuthority: collectCatalogAuthority(authorityDriver, target),
  });
  const authorityBytes = canonicalBytes(authority);
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
  return archive;
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

function validateAuthorityHistory(evidence: ArchiveAuthorityEvidence): void {
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

  const catalog = evidence.catalogAuthority;
  const generations = catalog.generations;
  for (let index = 1; index < generations.length; index++) {
    if (generations[index - 1]!.descriptor.generationId
        >= generations[index]!.descriptor.generationId)
      throw invalid("catalog generation descriptors are reordered or duplicated");
  }
  const generationById = new Map(generations.map(generation => [
    generation.descriptor.generationId, generation,
  ]));
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
  const genesisRevision = BigInt(catalog.entry.journalGenesisProtectionRevision);
  const catalogHighWater = BigInt(catalog.entry.revisionHighWater);
  if (catalogHighWater < genesisRevision
      || BigInt(reservations.length) !== catalogHighWater - genesisRevision)
    throw invalid("catalog revision history is incomplete");
  let chained: TargetEvidence = genesis.descriptor.target;
  let previousCatalogGeneration = -1n;
  for (let index = 0; index < reservations.length; index++) {
    const reservation = reservations[index]!;
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
        || (reservation.state === "reserved" && index !== reservations.length - 1))
      throw invalid("catalog revision history is mismatched or reordered");
    previousCatalogGeneration = finalizedGeneration ?? reservedGeneration;
    if (reservation.state === "committed") {
      const published = reservation.publishedActiveGenerationId === null
        ? undefined : generationById.get(reservation.publishedActiveGenerationId);
      if (!published || reservation.publishedLineageEpoch === null
          || reservation.stateSha256 === null)
        throw invalid("committed catalog revision has no generation evidence");
      chained = {
        appInstanceId: reservation.appInstanceId,
        activeGenerationId: reservation.publishedActiveGenerationId!,
        lineageEpoch: reservation.publishedLineageEpoch,
        protectionRevision: reservation.revision,
        digestSchema: catalog.entry.digestSchema,
        stateSha256: reservation.stateSha256,
      };
    }
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
  if (!sameTarget(chained, evidence.target))
    throw invalid("catalog revision history does not reach the selected target");

  const events = catalog.generationEvents;
  for (let index = 0; index < events.length; index++) {
    if (BigInt(events[index]!.catalogGeneration) !== BigInt(index + 1)
        || BigInt(events[index]!.catalogGeneration) > BigInt(catalog.catalogGeneration))
      throw invalid("catalog event history is reordered, duplicated, or incomplete");
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
  const leaseById = new Map(leases.map(lease => [lease.leaseId, lease]));
  const issuanceEvents = events.filter(event =>
    event.eventKind === "lease_issued" || event.eventKind === "recovery_takeover");
  if (new Set(leases.map(lease => lease.leaseId)).size !== leases.length
      || issuanceEvents.length !== leases.length)
    throw invalid("catalog lease history is incomplete");
  for (const reservation of reservations) {
    const reservingLease = leaseById.get(reservation.leaseId);
    if (!reservingLease
        || reservingLease.writeEpoch !== reservation.writeEpoch
        || reservingLease.releaseId !== reservation.releaseId
        || BigInt(Date.parse(reservation.reservedAt)) < BigInt(reservingLease.issuedAtMs)
        || BigInt(Date.parse(reservation.reservedAt)) >= BigInt(reservingLease.expiresAtMs))
      throw invalid("catalog reservation lease evidence is missing or mismatched");
    if (reservation.finalizedAt !== null) {
      const finalizingLease = reservation.finalizedLeaseId === null
        ? undefined : leaseById.get(reservation.finalizedLeaseId);
      if (!finalizingLease
          || finalizingLease.writeEpoch !== reservation.finalizedWriteEpoch
          || finalizingLease.releaseId !== reservation.finalizedReleaseId
          || BigInt(Date.parse(reservation.finalizedAt)) < BigInt(finalizingLease.issuedAtMs)
          || BigInt(Date.parse(reservation.finalizedAt)) >= BigInt(finalizingLease.expiresAtMs))
        throw invalid("catalog finalization lease evidence is missing or mismatched");
    }
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
      checksumAuthenticated: false;
      evidence: null;
    }
  | {
      kind: "format5_authority_evidence";
      format: 5;
      checksumAuthenticated: true;
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
        checksumAuthenticated: false,
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
    const canonical = enumerateCanonicalStateV1(
      stagingDriver, registryFromDriver(stagingDriver),
    );
    if (canonical.stateSha256 !== evidence.target.stateSha256
        || canonical.stateSha256 !== evidence.merkle.stateSha256
        || canonical.leaves.length !== evidence.merkle.leafCount)
      throw invalid("authority evidence does not match canonical archive state");
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
      kind: "format5_authority_evidence",
      format: 5,
      checksumAuthenticated: true,
      evidence,
    },
  };
}
