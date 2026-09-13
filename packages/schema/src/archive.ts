import { z } from "zod";
import {
  AppInstanceId, AuthorityIncarnationId, GenerationId, LeaseId, NamespaceId,
  OperationId, ReleaseId, RequestId, Sha256, UInt64Decimal,
} from "./index";
import {
  AppCatalogEntryV1, AppLifecycleReceiptV1, CanonicalInstant, CatalogGenerationEventV1,
  CatalogRevisionReservationV1, ImmutableAppGenerationV1,
  ProductionRequestReceiptV1, TargetAuthorityHeaderV1, TargetEvidenceV1, WriteFenceV1,
} from "./catalog";
import { BackupRecordV1, BackupRetentionHistoryV1 } from "./backup";
import { AuthenticatedFormat5RestoreGrantV1 } from "./restore";

const ArchiveCatalogDisplayName = z.string().min(1).max(40)
  .refine(value => value === value.trim(), "canonical display name required");
const ArchiveCatalogShellId = z.string().regex(/^[a-z0-9_-]{1,64}$/);

const ArchiveFileBytes = z.number().int().nonnegative().safe().max(384 * 1024 * 1024);
const ArchiveCount = z.number().int().nonnegative().safe();
const ArchiveAttachmentsV1 = z.object({
  count: ArchiveCount,
  bytes: ArchiveCount,
}).strict();
const ArchiveFileDigestV1 = z.object({
  bytes: ArchiveFileBytes,
  sha256: Sha256,
}).strict();

export const ArchiveManifestV5 = z.object({
  format: z.literal(5),
  app: z.string().min(1).max(120),
  exported_at: CanonicalInstant,
  tables: ArchiveCount.max(1_000),
  versions: ArchiveCount.max(100_000),
  attachments: ArchiveAttachmentsV1,
  files: z.object({
    userDb: ArchiveFileDigestV1,
    systemDb: ArchiveFileDigestV1,
    authority: ArchiveFileDigestV1,
  }).strict(),
}).strict();
export type ArchiveManifestV5 = z.infer<typeof ArchiveManifestV5>;

export const MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES = 50_000;
export const MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES = 100_000;

export const ArchiveTargetRevisionV1 = z.object({
  schema: z.literal(1),
  operationId: OperationId,
  revision: UInt64Decimal,
  expectedProtectionRevision: UInt64Decimal,
  expectedStateSha256: Sha256,
  requestSha256: Sha256,
  state: z.enum(["reserved", "committed", "abandoned"]),
  reservedAt: CanonicalInstant,
  finalizedAt: CanonicalInstant.nullable(),
  stateSha256: Sha256.nullable(),
}).strict().superRefine((value, context) => {
  if (value.revision === "0"
      || BigInt(value.expectedProtectionRevision) >= BigInt(value.revision))
    context.addIssue({ code: "custom", message: "target revision must advance its predecessor" });
  if ((value.state === "reserved" && (value.finalizedAt !== null || value.stateSha256 !== null))
      || (value.state === "committed" && (value.finalizedAt === null || value.stateSha256 === null))
      || (value.state === "abandoned" && (value.finalizedAt === null || value.stateSha256 !== null)))
    context.addIssue({ code: "custom", message: "target revision finalization is invalid" });
  if (value.finalizedAt !== null && value.finalizedAt < value.reservedAt)
    context.addIssue({ code: "custom", message: "target revision finalization precedes reservation" });
});
export type ArchiveTargetRevisionV1 = z.infer<typeof ArchiveTargetRevisionV1>;

export const ArchiveCatalogLeaseV1 = z.object({
  schema: z.literal(1),
  leaseId: LeaseId,
  authorityIncarnationId: AuthorityIncarnationId,
  writeEpoch: UInt64Decimal,
  releaseId: ReleaseId,
  issuedAtMs: UInt64Decimal,
  expiresAtMs: UInt64Decimal,
  revoked: z.boolean(),
}).strict().superRefine((value, context) => {
  const issued = BigInt(value.issuedAtMs);
  const expires = BigInt(value.expiresAtMs);
  if (expires <= issued || expires - issued > 300_000n
      || expires > BigInt(Number.MAX_SAFE_INTEGER))
    context.addIssue({ code: "custom", message: "archive catalog lease interval is invalid" });
});
export type ArchiveCatalogLeaseV1 = z.infer<typeof ArchiveCatalogLeaseV1>;

export const ArchiveGenerationEvidenceV1 = z.object({
  schema: z.literal(1),
  operationId: OperationId,
  storageKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  descriptor: ImmutableAppGenerationV1,
}).strict();
export type ArchiveGenerationEvidenceV1 = z.infer<typeof ArchiveGenerationEvidenceV1>;

export const ArchiveCatalogEntryV1 = z.object({
  appInstanceId: AppInstanceId,
  displayName: ArchiveCatalogDisplayName,
  shellId: ArchiveCatalogShellId,
  activeGenerationId: GenerationId,
  journalGenesisGenerationId: GenerationId,
  journalGenesisLineageEpoch: UInt64Decimal,
  journalGenesisProtectionRevision: UInt64Decimal,
  journalGenesisStateSha256: Sha256,
  currentLineageEpoch: UInt64Decimal,
  lineageEpochHighWater: UInt64Decimal,
  currentProtectionRevision: UInt64Decimal,
  revisionHighWater: UInt64Decimal,
  digestSchema: z.literal(1),
  stateSha256: Sha256,
  tombstoned: z.boolean(),
}).strict().superRefine((value, context) => {
  if (BigInt(value.currentLineageEpoch) > BigInt(value.lineageEpochHighWater))
    context.addIssue({ code: "custom", message: "lineage epoch exceeds high-water mark" });
  if (BigInt(value.currentProtectionRevision) > BigInt(value.revisionHighWater))
    context.addIssue({ code: "custom", message: "protection revision exceeds high-water mark" });
  if (BigInt(value.journalGenesisLineageEpoch) > BigInt(value.currentLineageEpoch)
      || BigInt(value.journalGenesisProtectionRevision) > BigInt(value.currentProtectionRevision))
    context.addIssue({ code: "custom", message: "journal genesis exceeds current target" });
});
export type ArchiveCatalogEntryV1 = z.infer<typeof ArchiveCatalogEntryV1>;

export const ArchiveCatalogSchemaObjectV1 = z.object({
  schema: z.literal(1),
  type: z.literal("table"),
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  tableName: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  sql: z.string().min(1).max(16 * 1024),
}).strict().superRefine((value, context) => {
  if (value.name !== value.tableName)
    context.addIssue({ code: "custom", message: "catalog table object must name itself" });
});
export type ArchiveCatalogSchemaObjectV1 = z.infer<typeof ArchiveCatalogSchemaObjectV1>;

export const ArchiveCatalogIdV1 = z.object({
  schema: z.literal(1),
  idValue: z.string().min(1).max(256),
  idKind: z.enum([
    "authority", "app", "generation", "namespace", "lease", "operation", "job",
  ]),
  retainedAt: CanonicalInstant,
}).strict();
export type ArchiveCatalogIdV1 = z.infer<typeof ArchiveCatalogIdV1>;

export const ArchiveTargetRequestReceiptV1 = z.object({
  schema: z.literal(1),
  receipt: ProductionRequestReceiptV1,
  responseJson: z.string().max(2_000_000).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.receipt.responseSha256 === null) !== (value.responseJson === null))
    context.addIssue({ code: "custom", message: "target request response mirror is incomplete" });
});
export type ArchiveTargetRequestReceiptV1 = z.infer<typeof ArchiveTargetRequestReceiptV1>;

export const ArchiveBootstrapEntryV1 = z.object({
  schema: z.literal(1),
  storageKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  userFile: z.string().min(1).max(256),
  systemFile: z.string().min(1).max(256),
  storageKind: z.enum(["legacy", "generation"]),
  appInstanceId: AppInstanceId,
  generationId: GenerationId,
  namespaceId: NamespaceId,
  operationId: OperationId,
  displayName: ArchiveCatalogDisplayName,
  shellId: ArchiveCatalogShellId,
  selected: z.boolean(),
  declaredAt: CanonicalInstant,
}).strict();
export type ArchiveBootstrapEntryV1 = z.infer<typeof ArchiveBootstrapEntryV1>;

export const ArchivePendingJobV1 = z.object({
  schema: z.literal(1),
  jobId: z.string().regex(/^job_[a-z2-7]{26}$/),
  authorityIncarnationId: AuthorityIncarnationId,
  appInstanceId: AppInstanceId.nullable(),
  generationId: GenerationId,
  namespaceId: NamespaceId,
  kind: z.string().min(1).max(64),
  state: z.string().min(1).max(64),
  operationId: OperationId,
  sourceArchiveSha256: Sha256,
  sourceProvenanceId: z.string().regex(/^restoreval_[a-z2-7]{26}$/),
  createdAt: CanonicalInstant,
  updatedAt: CanonicalInstant,
}).strict();
export type ArchivePendingJobV1 = z.infer<typeof ArchivePendingJobV1>;

/** Durable, non-secret install/cleanup claim. Never included in an export:
 * collection is blocked until this job becomes a terminal lifecycle receipt. */
export const CatalogRestoreJobV2 = ArchivePendingJobV1.extend({
  schema: z.literal(2),
  kind: z.literal("restore_as_new"),
  state: z.literal("prepared"),
  phase: z.enum(["install", "cleanup"]),
  fence: WriteFenceV1,
  intent: z.object({
    requestId: RequestId,
    requestSha256: Sha256,
    sourceTarget: TargetEvidenceV1,
    sourceCatalogGeneration: UInt64Decimal,
    grant: AuthenticatedFormat5RestoreGrantV1,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const intent = value.intent;
  if (value.appInstanceId === null || (value.phase === "install" && !intent)
      || value.authorityIncarnationId !== value.fence.authorityIncarnationId
      || (intent && (intent.grant.destinationAppInstanceId !== value.appInstanceId
        || intent.grant.preservedAppInstanceId !== intent.sourceTarget.appInstanceId
        || intent.grant.archiveSha256 !== value.sourceArchiveSha256
        || intent.grant.validationId !== value.sourceProvenanceId)))
    context.addIssue({ code: "custom", message: "restore intent binding is invalid" });
});
export type CatalogRestoreJobV2 = z.infer<typeof CatalogRestoreJobV2>;
export type CatalogRestoreJob = ArchivePendingJobV1 | CatalogRestoreJobV2;

export const ArchiveLineageReservationV1 = z.object({
  schema: z.literal(1),
  appInstanceId: AppInstanceId,
  lineageEpoch: UInt64Decimal,
  operationId: OperationId,
  state: z.string().min(1).max(64),
}).strict();
export type ArchiveLineageReservationV1 = z.infer<typeof ArchiveLineageReservationV1>;

export const ArchiveRestoreAsNewIdentityV1 = z.object({
  schema: z.literal(1),
  appInstanceId: AppInstanceId,
  generationId: GenerationId,
  namespaceId: NamespaceId,
  operationId: OperationId,
  restoredAt: CanonicalInstant,
}).strict();
export type ArchiveRestoreAsNewIdentityV1 = z.infer<typeof ArchiveRestoreAsNewIdentityV1>;

const ArchiveAuthorityBindingV1 = z.object({
  format: z.literal(5),
  app: z.string().min(1).max(120),
  exportedAt: CanonicalInstant,
  tables: ArchiveCount.max(1_000),
  versions: ArchiveCount.max(100_000),
  attachments: ArchiveAttachmentsV1,
  userDb: ArchiveFileDigestV1,
  systemDb: ArchiveFileDigestV1,
}).strict();

export const ArchiveLifecycleReceiptV1 = z.object({
  receipt: AppLifecycleReceiptV1,
  generationId: GenerationId,
  namespaceId: NamespaceId,
}).strict();
export type ArchiveLifecycleReceiptV1 = z.infer<typeof ArchiveLifecycleReceiptV1>;

const ArchiveCatalogAuthorityV1 = z.object({
    schema: z.literal(1),
    schemaObjects: z.array(ArchiveCatalogSchemaObjectV1).max(64),
    authorityIncarnationId: AuthorityIncarnationId,
    catalogGeneration: UInt64Decimal,
    writeEpoch: UInt64Decimal,
    selectedAppInstanceId: AppInstanceId,
    entry: AppCatalogEntryV1,
    entries: z.array(ArchiveCatalogEntryV1).max(1_000),
    generations: z.array(ArchiveGenerationEvidenceV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    idRegistry: z.array(ArchiveCatalogIdV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    leases: z.array(ArchiveCatalogLeaseV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    requestReceipts: z.array(ProductionRequestReceiptV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    revisionReservations: z.array(CatalogRevisionReservationV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    bootstrapManifest: z.array(ArchiveBootstrapEntryV1).max(1_000),
    pendingJobs: z.array(ArchivePendingJobV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    lineageReservations: z.array(ArchiveLineageReservationV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    generationEvents: z.array(CatalogGenerationEventV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    backupRecords: z.array(BackupRecordV1)
      .max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
}).strict();

// Version only the catalog evidence member. The format-5 authenticated envelope,
// its authentication-before-parsing order, and all existing bindings are unchanged.
const ArchiveCatalogAuthorityV2 = ArchiveCatalogAuthorityV1.extend({
  schema: z.literal(2),
  lifecycleReceipts: z.array(ArchiveLifecycleReceiptV1).max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
}).strict();
const ArchiveCatalogAuthorityV3 = ArchiveCatalogAuthorityV2.extend({
  schema: z.literal(3), retentionHistory: BackupRetentionHistoryV1,
}).strict();

export const ArchiveAuthorityEvidenceV1 = z.object({
  schema: z.literal(1),
  binding: ArchiveAuthorityBindingV1,
  target: TargetEvidenceV1,
  merkle: z.object({
    schema: z.literal(1),
    stateSha256: Sha256,
    leafCount: ArchiveCount,
    bucketRoots: z.array(Sha256).length(1024),
  }).strict(),
  targetAuthority: z.object({
    schema: z.literal(1),
    header: TargetAuthorityHeaderV1,
    revisions: z.array(ArchiveTargetRevisionV1).max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
    requestReceipts: z.array(ArchiveTargetRequestReceiptV1).max(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
  }).strict(),
  catalogAuthority: z.discriminatedUnion("schema", [ArchiveCatalogAuthorityV1, ArchiveCatalogAuthorityV2, ArchiveCatalogAuthorityV3]),
}).strict().superRefine((value, context) => {
  const authorityEntries = value.targetAuthority.revisions.length
    + value.targetAuthority.requestReceipts.length
    + value.catalogAuthority.entries.length
    + value.catalogAuthority.generations.length
    + value.catalogAuthority.idRegistry.length
    + value.catalogAuthority.leases.length
    + value.catalogAuthority.requestReceipts.length
    + value.catalogAuthority.revisionReservations.length
    + value.catalogAuthority.bootstrapManifest.length
    + value.catalogAuthority.pendingJobs.length
    + value.catalogAuthority.lineageReservations.length
    + value.catalogAuthority.generationEvents.length
    + value.catalogAuthority.backupRecords.length
    + (value.catalogAuthority.schema !== 1 ? value.catalogAuthority.lifecycleReceipts.length : 0)
    + (value.catalogAuthority.schema === 3 ? value.catalogAuthority.retentionHistory.events.length : 0);
  if (authorityEntries > MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "archive authority history exceeds the total entry limit",
    });
  const target = value.target;
  const header = value.targetAuthority.header;
  const catalog = value.catalogAuthority;
  const entry = catalog.entry;
  if (value.merkle.stateSha256 !== target.stateSha256)
    context.addIssue({ code: "custom", message: "Merkle root does not match the canonical target" });
  if (header.appInstanceId !== target.appInstanceId
      || header.activeGenerationId !== target.activeGenerationId
      || header.lineageEpoch !== target.lineageEpoch
      || header.protectionRevision !== target.protectionRevision
      || header.digestSchema !== target.digestSchema)
    context.addIssue({ code: "custom", message: "target authority header does not match the canonical target" });
  if (catalog.selectedAppInstanceId !== target.appInstanceId
      || entry.appInstanceId !== target.appInstanceId
      || entry.activeGenerationId !== target.activeGenerationId
      || entry.currentLineageEpoch !== target.lineageEpoch
      || entry.currentProtectionRevision !== target.protectionRevision
      || entry.digestSchema !== target.digestSchema
      || entry.stateSha256 !== target.stateSha256)
    context.addIssue({ code: "custom", message: "catalog selection does not match the canonical target" });
  const selectedEntries = catalog.entries.filter(candidate =>
    candidate.appInstanceId === catalog.selectedAppInstanceId);
  if (selectedEntries.length !== 1
      || JSON.stringify(selectedEntries[0]) !== JSON.stringify(entry)
      || new Set(catalog.entries.map(candidate => candidate.appInstanceId)).size
        !== catalog.entries.length
      || new Set(catalog.generations.map(candidate => candidate.descriptor.generationId)).size
        !== catalog.generations.length
      || new Set(catalog.generations.map(candidate => candidate.descriptor.namespaceId)).size
        !== catalog.generations.length
      || new Set(catalog.generations.map(candidate => candidate.operationId)).size
        !== catalog.generations.length
      || new Set(catalog.generations.map(candidate => candidate.storageKey)).size
        !== catalog.generations.length)
    context.addIssue({ code: "custom", message: "catalog archive inventory is ambiguous" });
  if (entry.lineageEpochHighWater !== header.lineageEpochHighWater
      || entry.revisionHighWater !== header.protectionRevisionHighWater)
    context.addIssue({ code: "custom", message: "catalog and target high-water marks disagree" });
});
export type ArchiveAuthorityEvidenceV1 = z.infer<typeof ArchiveAuthorityEvidenceV1>;
