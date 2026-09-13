import { z } from "zod";
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
} from "./index";

export const TargetEvidenceV1 = z.object({
  appInstanceId: AppInstanceId,
  activeGenerationId: GenerationId,
  lineageEpoch: UInt64Decimal,
  protectionRevision: UInt64Decimal,
  digestSchema: z.literal(1),
  stateSha256: Sha256,
}).strict();
export type TargetEvidenceV1 = z.infer<typeof TargetEvidenceV1>;

export const TargetAuthorityHeaderV1 = z.object({
  schema: z.literal(1),
  appInstanceId: AppInstanceId,
  activeGenerationId: GenerationId,
  lineageEpoch: UInt64Decimal,
  lineageEpochHighWater: UInt64Decimal,
  protectionRevision: UInt64Decimal,
  protectionRevisionHighWater: UInt64Decimal,
  digestSchema: z.literal(1),
}).strict().superRefine((value, context) => {
  if (BigInt(value.lineageEpoch) > BigInt(value.lineageEpochHighWater))
    context.addIssue({ code: "custom", message: "lineage epoch exceeds its high-water mark" });
  if (BigInt(value.protectionRevision) > BigInt(value.protectionRevisionHighWater))
    context.addIssue({ code: "custom", message: "protection revision exceeds its high-water mark" });
});
export type TargetAuthorityHeaderV1 = z.infer<typeof TargetAuthorityHeaderV1>;

export const CanonicalInstant = z.string().datetime({ offset: true }).refine((value) => {
  try { return new Date(value).toISOString() === value; } catch { return false; }
}, "exact UTC millisecond instant required");

export const ProductionRequestReceiptV1 = z.object({
  schema: z.literal(1),
  requestId: RequestId,
  operationId: OperationId,
  appInstanceId: AppInstanceId,
  activeGenerationId: GenerationId,
  lineageEpoch: UInt64Decimal,
  expectedProtectionRevision: UInt64Decimal,
  expectedStateSha256: Sha256,
  requestSha256: Sha256,
  state: z.enum(["prepared", "invoked", "committed", "no_op", "failed"]),
  resultingProtectionRevision: UInt64Decimal.nullable(),
  resultingStateSha256: Sha256.nullable(),
  responseSha256: Sha256.nullable(),
  preparedAt: CanonicalInstant,
  invokedAt: CanonicalInstant.nullable(),
  completedAt: CanonicalInstant.nullable(),
}).strict().superRefine((value, context) => {
  const terminal = value.state === "committed" || value.state === "no_op"
    || value.state === "failed";
  const hasAnyResult = value.resultingProtectionRevision !== null
    || value.resultingStateSha256 !== null || value.responseSha256 !== null
    || value.completedAt !== null;
  const hasResult = value.resultingProtectionRevision !== null
    && value.resultingStateSha256 !== null && value.responseSha256 !== null
    && value.completedAt !== null;
  if (value.state === "prepared" && (value.invokedAt !== null || hasAnyResult))
    context.addIssue({ code: "custom", message: "prepared request receipt is inconsistent" });
  if (value.state === "invoked" && (value.invokedAt === null || hasAnyResult))
    context.addIssue({ code: "custom", message: "invoked request receipt is inconsistent" });
  if (terminal && !hasResult)
    context.addIssue({ code: "custom", message: "terminal request receipt is incomplete" });
  if ((value.state === "no_op" || value.state === "failed") && hasResult
      && (value.resultingProtectionRevision !== value.expectedProtectionRevision
        || value.resultingStateSha256 !== value.expectedStateSha256))
    context.addIssue({ code: "custom", message: "non-commit receipt changed target identity" });
  if (value.state === "no_op" && value.invokedAt !== null)
    context.addIssue({ code: "custom", message: "canonical no-op must not invoke live mutation" });
  if (value.state === "committed" && (value.invokedAt === null || !hasResult
      || BigInt(value.resultingProtectionRevision!) <= BigInt(value.expectedProtectionRevision)
      || value.resultingStateSha256 === value.expectedStateSha256))
    context.addIssue({ code: "custom", message: "committed request receipt is inconsistent" });
  if (value.invokedAt !== null && Date.parse(value.invokedAt) < Date.parse(value.preparedAt))
    context.addIssue({ code: "custom", message: "request invocation predates preparation" });
  if (value.completedAt !== null && Date.parse(value.completedAt) < Date.parse(value.preparedAt))
    context.addIssue({ code: "custom", message: "request completion predates preparation" });
});
export type ProductionRequestReceiptV1 = z.infer<typeof ProductionRequestReceiptV1>;

const ProvenanceId = z.string().min(1).max(256)
  .refine(value => value === value.trim(), "canonical provenance identity required");
export const ImmutableAppGenerationV1 = z.object({
  schema: z.literal(1),
  generationId: GenerationId,
  target: TargetEvidenceV1,
  namespaceId: NamespaceId,
  sourceArchiveSha256: Sha256.nullable(),
  sourceProvenanceId: ProvenanceId.nullable(),
  sealedAt: CanonicalInstant,
  readBackAt: CanonicalInstant,
}).strict().superRefine((value, context) => {
  if (value.generationId !== value.target.activeGenerationId)
    context.addIssue({ code: "custom", message: "generation descriptor does not match target" });
});
export type ImmutableAppGenerationV1 = z.infer<typeof ImmutableAppGenerationV1>;

export const WriteFenceV1 = z.object({
  authorityIncarnationId: AuthorityIncarnationId,
  writeEpoch: UInt64Decimal,
  leaseId: LeaseId,
  releaseId: ReleaseId,
}).strict();
export type WriteFenceV1 = z.infer<typeof WriteFenceV1>;

const CatalogDisplayName = z.string().min(1).max(40)
  .refine(value => value === value.trim(), "canonical display name required");
const CatalogShellId = z.string().regex(/^[a-z0-9_-]{1,64}$/);
export const AppCatalogEntryV1 = z.object({
  appInstanceId: AppInstanceId,
  displayName: CatalogDisplayName,
  shellId: CatalogShellId,
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
  tombstoned: z.literal(false),
}).strict().superRefine((value, context) => {
  if (BigInt(value.currentLineageEpoch) > BigInt(value.lineageEpochHighWater))
    context.addIssue({ code: "custom", message: "lineage epoch exceeds high-water mark" });
  if (BigInt(value.currentProtectionRevision) > BigInt(value.revisionHighWater))
    context.addIssue({ code: "custom", message: "protection revision exceeds high-water mark" });
  if (BigInt(value.journalGenesisLineageEpoch) > BigInt(value.currentLineageEpoch)
      || BigInt(value.journalGenesisProtectionRevision) > BigInt(value.currentProtectionRevision))
    context.addIssue({ code: "custom", message: "journal genesis exceeds current target" });
});
export type AppCatalogEntryV1 = z.infer<typeof AppCatalogEntryV1>;

export const AppCatalogSnapshotV1 = z.object({
  schema: z.literal(1),
  authorityIncarnationId: AuthorityIncarnationId,
  catalogGeneration: UInt64Decimal,
  selectedAppInstanceId: AppInstanceId.nullable(),
  entries: z.array(AppCatalogEntryV1),
  writeEpoch: UInt64Decimal,
}).strict().superRefine((value, context) => {
  const appIds = new Set<string>();
  const generationIds = new Set<string>();
  for (const entry of value.entries) {
    if (appIds.has(entry.appInstanceId))
      context.addIssue({ code: "custom", message: "duplicate app instance identity" });
    if (generationIds.has(entry.activeGenerationId))
      context.addIssue({ code: "custom", message: "duplicate active generation identity" });
    appIds.add(entry.appInstanceId);
    generationIds.add(entry.activeGenerationId);
  }
  if (value.selectedAppInstanceId !== null && !appIds.has(value.selectedAppInstanceId))
    context.addIssue({ code: "custom", message: "selected app is not a live catalog entry" });
});
export type AppCatalogSnapshotV1 = z.infer<typeof AppCatalogSnapshotV1>;

const LifecycleJobId = z.string().regex(/^job_[a-z2-7]{26}$/);
const LifecycleStorageKey = z.string()
  .regex(/^(?:ns_[a-z2-7]{26}|[a-zA-Z0-9_][a-zA-Z0-9_-]{0,79})$/);
export const LifecyclePhysicalTargetV1 = z.object({
  appInstanceId: AppInstanceId,
  generationId: GenerationId,
  namespaceId: NamespaceId,
  storageKey: LifecycleStorageKey,
  userFile: z.string().min(1).max(128),
  systemFile: z.string().min(1).max(128),
  storageKind: z.enum(["legacy", "generation"]),
  displayName: CatalogDisplayName,
  shellId: CatalogShellId,
}).strict().superRefine((value, context) => {
  const generation = value.storageKey === value.namespaceId
    && value.userFile === `/${value.namespaceId}-user.db`
    && value.systemFile === `/${value.namespaceId}-system.db`;
  const legacy = value.storageKey === "default"
    ? value.userFile === "/user.db" && value.systemFile === "/system.db"
    : value.userFile === `/app-${value.storageKey}-user.db`
      && value.systemFile === `/app-${value.storageKey}-system.db`;
  if ((value.storageKind === "generation" && !generation)
      || (value.storageKind === "legacy" && !legacy))
    context.addIssue({ code: "custom", message: "lifecycle physical target is not canonical" });
});
export type LifecyclePhysicalTargetV1 = z.infer<typeof LifecyclePhysicalTargetV1>;

export const PendingTargetLifecycleJobV1 = z.object({
  schema: z.literal(1),
  kind: z.enum(["create", "fork", "cleanup"]),
  jobId: LifecycleJobId,
  authorityIncarnationId: AuthorityIncarnationId,
  requestId: RequestId,
  operationId: OperationId,
  requestSha256: Sha256,
  declaredCatalogGeneration: UInt64Decimal,
  expectedTarget: TargetEvidenceV1,
  target: LifecyclePhysicalTargetV1,
  createdAt: CanonicalInstant,
  recoveryFence: WriteFenceV1.optional(),
}).strict().superRefine((value, context) => {
  if (value.declaredCatalogGeneration === "0")
    context.addIssue({ code: "custom", message: "lifecycle declaration generation cannot be zero" });
  if (value.kind !== "cleanup" && value.target.storageKind !== "generation")
    context.addIssue({ code: "custom", message: "new lifecycle targets must use generation storage" });
  if (value.target.appInstanceId === value.expectedTarget.appInstanceId
      || value.target.generationId === value.expectedTarget.activeGenerationId)
    context.addIssue({ code: "custom", message: "created app target must have fresh identity" });
});
export type PendingTargetLifecycleJobV1 = z.infer<typeof PendingTargetLifecycleJobV1>;

const LegacyAppLifecycleReceiptV1 = z.object({
  schema: z.literal(1),
  kind: z.enum(["create", "fork", "switch", "rename", "delete"]),
  jobId: LifecycleJobId,
  authorityIncarnationId: AuthorityIncarnationId,
  requestId: RequestId,
  requestSha256: Sha256,
  operationId: OperationId,
  requestedAppInstanceId: AppInstanceId.nullable(),
  resultingSelectedAppInstanceId: AppInstanceId,
  completedCatalogGeneration: UInt64Decimal,
  completedAt: CanonicalInstant,
}).strict();
/** v1 is retained for historical readback only. All new/replayable outcomes are v2. */
export const AppLifecycleReceiptV1 = z.discriminatedUnion("schema", [
  LegacyAppLifecycleReceiptV1,
  LegacyAppLifecycleReceiptV1.extend({
    schema: z.literal(2),
    resultTarget: TargetEvidenceV1,
    resultDisplayName: CatalogDisplayName,
    resultShellId: CatalogShellId,
  }).strict(),
]).superRefine((value, context) => {
  const explicitTarget = value.kind === "switch" || value.kind === "rename"
    || value.kind === "delete";
  if (explicitTarget !== (value.requestedAppInstanceId !== null))
    context.addIssue({ code: "custom", message: "lifecycle receipt request target is inconsistent" });
  if ((value.kind === "switch" || value.kind === "rename")
      && value.requestedAppInstanceId !== value.resultingSelectedAppInstanceId)
    context.addIssue({ code: "custom", message: "lifecycle receipt selected target is inconsistent" });
  if (value.schema === 2 && value.resultTarget.appInstanceId !== value.resultingSelectedAppInstanceId)
    context.addIssue({ code: "custom", message: "lifecycle receipt result target is inconsistent" });
});
export type AppLifecycleReceiptV1 = z.infer<typeof AppLifecycleReceiptV1>;

export const CatalogCasPublicationV1 = z.object({
  schema: z.literal(1),
  authorityIncarnationId: AuthorityIncarnationId,
  catalogGeneration: UInt64Decimal,
  selectedAppInstanceId: AppInstanceId.nullable(),
  publishedTarget: TargetEvidenceV1,
}).strict().superRefine((value, context) => {
  if (value.selectedAppInstanceId !== value.publishedTarget.appInstanceId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedAppInstanceId"],
      message: "selected app must match the published target",
    });
});
export type CatalogCasPublicationV1 = z.infer<typeof CatalogCasPublicationV1>;

export const CatalogGenerationEventV1 = z.object({
  schema: z.literal(1),
  catalogGeneration: UInt64Decimal,
  eventKind: z.enum([
    "app_seed", "lease_issued", "revision_reserved", "revision_committed",
    "revision_abandoned", "recovery_takeover", "app_selected", "app_metadata",
    "backup_published",
  ]),
  appInstanceId: AppInstanceId.nullable(),
  operationId: OperationId.nullable(),
  writeEpoch: UInt64Decimal,
  at: CanonicalInstant,
  target: TargetEvidenceV1.nullable(),
  displayName: CatalogDisplayName.nullable(),
  shellId: CatalogShellId.nullable(),
}).strict().superRefine((value, context) => {
  if (value.catalogGeneration === "0")
    context.addIssue({ code: "custom", message: "catalog generation event cannot be zero" });
  const requiresOperation = value.eventKind !== "lease_issued";
  if (requiresOperation && (value.appInstanceId === null || value.operationId === null))
    context.addIssue({ code: "custom", message: "catalog event requires app and operation identity" });
  if (!requiresOperation && value.operationId !== null)
    context.addIssue({ code: "custom", message: "lease event cannot claim an operation identity" });
  if (value.eventKind === "app_seed" || value.eventKind === "app_selected") {
    if (value.target === null || value.target.appInstanceId !== value.appInstanceId)
      context.addIssue({ code: "custom", message: "app seed event requires its complete target" });
  } else if (value.target !== null) {
    context.addIssue({ code: "custom", message: "only app target events carry a target" });
  }
  const requiredMetadata = value.eventKind === "app_seed" || value.eventKind === "app_metadata";
  const hasMetadata = value.displayName !== null && value.shellId !== null;
  const partialMetadata = (value.displayName === null) !== (value.shellId === null);
  if (partialMetadata || (requiredMetadata && !hasMetadata)
      || (!requiredMetadata && value.eventKind !== "revision_committed" && hasMetadata))
    context.addIssue({ code: "custom", message: "catalog metadata event fields are invalid" });
});
export type CatalogGenerationEventV1 = z.infer<typeof CatalogGenerationEventV1>;

export const CatalogRevisionReservationV1 = z.object({
  schema: z.literal(1),
  authorityIncarnationId: AuthorityIncarnationId,
  reservedCatalogGeneration: UInt64Decimal,
  finalizedCatalogGeneration: UInt64Decimal.nullable(),
  writeEpoch: UInt64Decimal,
  leaseId: LeaseId,
  releaseId: ReleaseId,
  finalizedWriteEpoch: UInt64Decimal.nullable(),
  finalizedLeaseId: LeaseId.nullable(),
  finalizedReleaseId: ReleaseId.nullable(),
  appInstanceId: AppInstanceId,
  activeGenerationId: GenerationId,
  lineageEpoch: UInt64Decimal,
  revision: UInt64Decimal,
  operationId: OperationId,
  expectedProtectionRevision: UInt64Decimal,
  expectedStateSha256: Sha256,
  requestSha256: Sha256,
  state: z.enum(["reserved", "committed", "abandoned"]),
  publishedActiveGenerationId: GenerationId.nullable(),
  publishedLineageEpoch: UInt64Decimal.nullable(),
  stateSha256: Sha256.nullable(),
  reservedAt: CanonicalInstant,
  finalizedAt: CanonicalInstant.nullable(),
}).strict().superRefine((value, context) => {
  if (value.revision === "0"
      || BigInt(value.expectedProtectionRevision) >= BigInt(value.revision))
    context.addIssue({ code: "custom", message: "reservation revision must advance its target" });
  if (value.state === "reserved") {
    if (value.finalizedCatalogGeneration !== null
        || value.finalizedWriteEpoch !== null
        || value.finalizedLeaseId !== null
        || value.finalizedReleaseId !== null
        || value.publishedActiveGenerationId !== null
        || value.publishedLineageEpoch !== null
        || value.stateSha256 !== null || value.finalizedAt !== null)
      context.addIssue({ code: "custom", message: "reserved catalog revision cannot be finalized" });
    return;
  }
  if (value.finalizedCatalogGeneration === null || value.finalizedAt === null
      || value.finalizedWriteEpoch === null
      || value.finalizedLeaseId === null
      || value.finalizedReleaseId === null
      || BigInt(value.finalizedCatalogGeneration) !== BigInt(value.reservedCatalogGeneration) + 1n
      || value.finalizedAt < value.reservedAt)
    context.addIssue({ code: "custom", message: "catalog reservation finalization is invalid" });
  if ((value.state === "committed"
      && (value.publishedActiveGenerationId === null
        || value.publishedLineageEpoch === null
        || value.stateSha256 === null || value.stateSha256 === value.expectedStateSha256))
      || (value.state === "abandoned"
        && (value.publishedActiveGenerationId !== null
          || value.publishedLineageEpoch !== null || value.stateSha256 !== null)))
    context.addIssue({ code: "custom", message: "catalog reservation outcome is invalid" });
});
export type CatalogRevisionReservationV1 = z.infer<typeof CatalogRevisionReservationV1>;

export const CatalogReservationRecoveryV1 = z.object({
  schema: z.literal(1),
  catalogGeneration: UInt64Decimal,
  fence: WriteFenceV1,
  abandonedReservation: CatalogRevisionReservationV1,
}).strict().superRefine((value, context) => {
  const reservation = value.abandonedReservation;
  if (reservation.state !== "abandoned"
      || reservation.authorityIncarnationId !== value.fence.authorityIncarnationId
      || reservation.finalizedCatalogGeneration !== value.catalogGeneration
      || reservation.finalizedWriteEpoch !== value.fence.writeEpoch
      || reservation.finalizedLeaseId !== value.fence.leaseId
      || reservation.finalizedReleaseId !== value.fence.releaseId)
    context.addIssue({ code: "custom", message: "catalog recovery authority is inconsistent" });
});
export type CatalogReservationRecoveryV1 = z.infer<typeof CatalogReservationRecoveryV1>;
