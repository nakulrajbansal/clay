import { z } from "./validation-runtime";
import {
  AppInstanceId,
  AuthorityIncarnationId,
  OperationId,
  ProtectionReasonCode,
  ReleaseId,
  RequestId,
  Sha256,
  UInt64Decimal,
} from "./index";
import {
  CanonicalInstant,
  TargetEvidenceV1,
  WriteFenceV1,
} from "./catalog";

export const MAX_BACKUP_ARCHIVE_BYTES = 384 * 1024 * 1024;
export const MAX_BACKUP_ROTATION_RECORDS = 64;
const MAX_SHAPE_VERSION = 2_147_483_647;

const lowerBase32Id = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[a-z2-7]{26}$`));

export const BackupTargetId = /*#__PURE__*/ (() => (lowerBase32Id("tgt")))();
export const BackupId = /*#__PURE__*/ (() => (lowerBase32Id("bkp")))();
export const BackupGenerationId = /*#__PURE__*/ (() => (lowerBase32Id("backupgen")))();
export const BackupTargetAdapterCertificationId = /*#__PURE__*/ (() => (lowerBase32Id("btc")))();
export type BackupTargetId = z.infer<typeof BackupTargetId>;
export type BackupId = z.infer<typeof BackupId>;
export type BackupGenerationId = z.infer<typeof BackupGenerationId>;
export type BackupTargetAdapterCertificationId = z.infer<
  typeof BackupTargetAdapterCertificationId
>;

const Hex16 = /*#__PURE__*/ (() => (z.string().regex(/^[0-9a-f]{32}$/)))();
const PositiveUInt64Decimal = /*#__PURE__*/ (() => (UInt64Decimal.refine(
  value => BigInt(value) > 0n,
  "positive uint64 required",
)))();
export const BackupAuthenticationV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  kind: z.literal("cose_mac0_hmac_256_256"),
  authenticationVersion: z.literal(1),
  keyId: Hex16,
  seriesId: Hex16,
  generation: PositiveUInt64Decimal,
}).strict().superRefine((value, context) => {
  if (value.keyId === value.seriesId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["seriesId"],
      message: "key and backup-series identifiers must differ",
    });
})))();
export type BackupAuthenticationV1 = z.infer<typeof BackupAuthenticationV1>;

const BindingIdentifier = /*#__PURE__*/ (() => (z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]{0,63}$/)))();
const RuntimeVersion = /*#__PURE__*/ (() => (z.string().min(1).max(40)
  .regex(/^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,39})$/)))();

export const BackupRuntimeBindingV1 = /*#__PURE__*/ (() => (z.object({
  distribution: z.enum(["managed_web", "browser_pwa", "installed_native"]),
  osFamily: z.enum(["windows", "macos", "linux", "chromeos", "android", "ios"]),
  osVersion: RuntimeVersion,
  runtimeFamily: z.enum(["chromium", "firefox", "webkit", "webview2", "wkwebview", "native"]),
  runtimeVersion: RuntimeVersion,
  architecture: z.enum(["x64", "arm64", "x86", "universal", "wasm32"]),
}).strict()))();
export type BackupRuntimeBindingV1 = z.infer<typeof BackupRuntimeBindingV1>;

export const BackupAdapterArtifactBindingV1 = /*#__PURE__*/ (() => (z.object({
  implementationId: BindingIdentifier,
  implementationVersion: RuntimeVersion,
  codeSha256: Sha256,
  releaseId: ReleaseId,
  buildSha256: Sha256,
  runtime: BackupRuntimeBindingV1,
  matrixId: BindingIdentifier,
  matrixSha256: Sha256,
  suiteId: BindingIdentifier,
  suiteSha256: Sha256,
}).strict()))();
export type BackupAdapterArtifactBindingV1 = z.infer<typeof BackupAdapterArtifactBindingV1>;

const BackupProbeId = /*#__PURE__*/ (() => (lowerBase32Id("probe")))();
export const BackupTargetAdapterCertificationV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  certificationId: BackupTargetAdapterCertificationId,
  binding: BackupAdapterArtifactBindingV1,
  adapter: z.enum(["browser_directory", "native_directory"]),
  issuedAt: CanonicalInstant,
  expiresAt: CanonicalInstant,
  verdict: z.literal("pass"),
  restartProbe: z.object({
    probeId: BackupProbeId,
    firstProcessWriteSha256: Sha256,
    fullProcessExitObserved: z.literal(true),
    freshProcessReacquiredWithoutPicker: z.literal(true),
    permissionRechecked: z.literal(true),
    firstFileReadBackSha256: Sha256,
    secondUniqueFileReadBackSha256: Sha256,
    enumerationObservedBoth: z.literal(true),
    ownedProbeCleanupVerified: z.literal(true),
    evidenceSha256: Sha256,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.expiresAt <= value.issuedAt)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "adapter certification must expire after issuance",
    });
})))();
export type BackupTargetAdapterCertificationV1 = z.infer<
  typeof BackupTargetAdapterCertificationV1
>;

const ShapeVersion = /*#__PURE__*/ (() => (z.number().int().nonnegative().safe().max(MAX_SHAPE_VERSION)))();
const ArchiveByteLength = /*#__PURE__*/ (() => (z.number().int().positive().safe().max(MAX_BACKUP_ARCHIVE_BYTES)))();
const BackupFileLabel = /*#__PURE__*/ (() => (z.string().min(1).max(120)
  .refine(value => value === value.trim(), "canonical backup file label required")
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), "backup file label contains control characters")))();

/** A generated, single-segment filename owned by Clay's automatic plane. */
export const AutomaticBackupFileName = /*#__PURE__*/ (() => (z.string().min(1).max(160)
  .regex(/^clay-[a-z0-9](?:[a-z0-9-]{0,47})-\d{8}T\d{9}Z-backupgen_[a-z2-7]{26}\.clay$/)
  .refine(value => !value.includes("..") && !value.includes("/") && !value.includes("\\"))))();
export type AutomaticBackupFileName = z.infer<typeof AutomaticBackupFileName>;

export const BackupSelectedTargetV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  authorityIncarnationId: AuthorityIncarnationId,
  catalogGeneration: UInt64Decimal,
  writeEpoch: UInt64Decimal,
  selectedAppInstanceId: TargetEvidenceV1.shape.appInstanceId,
  selectedActiveGenerationId: TargetEvidenceV1.shape.activeGenerationId,
  target: TargetEvidenceV1,
}).strict().superRefine((value, context) => {
  if (value.selectedAppInstanceId !== value.target.appInstanceId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedAppInstanceId"],
      message: "selected app must equal the target app",
    });
  if (value.selectedActiveGenerationId !== value.target.activeGenerationId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedActiveGenerationId"],
      message: "selected generation must equal the target generation",
    });
})))();
export type BackupSelectedTargetV1 = z.infer<typeof BackupSelectedTargetV1>;

export const BackupTargetV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  targetId: BackupTargetId,
  appInstanceId: AppInstanceId,
  adapter: z.literal("browser_directory"),
  adapterCertificationId: BackupTargetAdapterCertificationId,
  authorizedAt: CanonicalInstant,
}).strict()))();
export type BackupTargetV1 = z.infer<typeof BackupTargetV1>;

const BackupSnapshotV1 = /*#__PURE__*/ (() => (z.object({
  format: z.literal(5),
  byteLength: ArchiveByteLength,
  archiveSha256: Sha256,
  authentication: BackupAuthenticationV1,
  shapeHead: ShapeVersion,
  shapeCurrent: ShapeVersion,
}).strict().superRefine((value, context) => {
  if (value.shapeCurrent > value.shapeHead)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shapeCurrent"],
      message: "shape cursor exceeds shape head",
    });
})))();
export type BackupSnapshotV1 = z.infer<typeof BackupSnapshotV1>;

export const BackupRunV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  backupId: BackupId,
  generationId: BackupGenerationId,
  target: BackupTargetV1,
  expected: BackupSelectedTargetV1,
  fence: WriteFenceV1,
  reason: z.enum(["first_meaningful_write", "meaningful_write", "deadline", "backup_now", "retry"]),
  attempt: z.enum(["fresh", "write_reconcile", "publication_reconcile"]),
  fileLabel: BackupFileLabel,
  createdAt: CanonicalInstant,
  archive: BackupSnapshotV1,
}).strict().superRefine((value, context) => {
  if (value.target.appInstanceId !== value.expected.selectedAppInstanceId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "appInstanceId"],
      message: "backup destination app does not match the selected app",
    });
  if (value.fence.authorityIncarnationId !== value.expected.authorityIncarnationId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fence", "authorityIncarnationId"],
      message: "write fence authority does not match the selected target",
    });
  if (value.fence.writeEpoch !== value.expected.writeEpoch)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fence", "writeEpoch"],
      message: "write fence epoch does not match the selected target",
    });
  if (value.createdAt < value.target.authorizedAt)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["createdAt"],
      message: "backup run predates target authorization",
    });
})))();
export type BackupRunV1 = z.infer<typeof BackupRunV1>;

const backupArtifactShape = {
  schema: z.literal(1),
  backupId: BackupId,
  generationId: BackupGenerationId,
  targetId: BackupTargetId,
  evidence: TargetEvidenceV1,
  fileName: AutomaticBackupFileName,
  createdAt: CanonicalInstant,
  validatedAt: CanonicalInstant,
  shapeHead: ShapeVersion,
  shapeCurrent: ShapeVersion,
  archiveFormat: z.literal(5),
  byteLength: ArchiveByteLength,
  archiveSha256: Sha256,
  authentication: BackupAuthenticationV1,
  adapterCertificationId: BackupTargetAdapterCertificationId,
} as const;

export const ValidatedBackupArtifactV1 = /*#__PURE__*/ (() => (z.object(backupArtifactShape).strict()
  .superRefine((value, context) => {
    if (value.validatedAt < value.createdAt)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validatedAt"],
        message: "backup validation predates creation",
      });
    if (value.shapeCurrent > value.shapeHead)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shapeCurrent"],
        message: "shape cursor exceeds shape head",
      });
  })))();
export type ValidatedBackupArtifactV1 = z.infer<typeof ValidatedBackupArtifactV1>;

export const BackupValidationCodeV1 = /*#__PURE__*/ (() => (z.enum([
  "archive_valid",
  "archive_invalid",
  "digest_mismatch",
  "tuple_mismatch",
  "generation_not_selected",
  "permission_lost",
  "target_unreachable",
])))();
export type BackupValidationCodeV1 = z.infer<typeof BackupValidationCodeV1>;

export const BackupRecordV1 = /*#__PURE__*/ (() => (z.object({
  ...backupArtifactShape,
  publicationCatalogGeneration: UInt64Decimal,
  state: z.enum(["valid", "invalid", "quarantined", "deleted"]),
  validationCode: BackupValidationCodeV1,
}).strict().superRefine((value, context) => {
  if (value.validatedAt < value.createdAt)
    context.addIssue({ code: "custom", message: "backup validation predates creation" });
  if (value.shapeCurrent > value.shapeHead)
    context.addIssue({ code: "custom", message: "shape cursor exceeds shape head" });
  const coherent = (value.state === "valid" || value.state === "deleted")
    ? value.validationCode === "archive_valid"
    : value.state === "invalid"
      ? ["archive_invalid", "digest_mismatch", "tuple_mismatch"].includes(value.validationCode)
      : ["generation_not_selected", "permission_lost", "target_unreachable"].includes(
        value.validationCode,
      );
  if (!coherent)
    context.addIssue({ code: "custom", message: "backup state and validation code disagree" });
})))();
export type BackupRecordV1 = z.infer<typeof BackupRecordV1>;

export const BackupPublicationRequestV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  expected: BackupSelectedTargetV1,
  fence: WriteFenceV1,
  artifact: ValidatedBackupArtifactV1,
}).strict().superRefine((value, context) => {
  if (value.fence.authorityIncarnationId !== value.expected.authorityIncarnationId
      || value.fence.writeEpoch !== value.expected.writeEpoch)
    context.addIssue({ code: "custom", message: "publication fence does not match target" });
  if (value.artifact.evidence.appInstanceId !== value.expected.target.appInstanceId
      || value.artifact.evidence.activeGenerationId !== value.expected.target.activeGenerationId
      || value.artifact.evidence.lineageEpoch !== value.expected.target.lineageEpoch
      || value.artifact.evidence.protectionRevision !== value.expected.target.protectionRevision
      || value.artifact.evidence.digestSchema !== value.expected.target.digestSchema
      || value.artifact.evidence.stateSha256 !== value.expected.target.stateSha256)
    context.addIssue({ code: "custom", message: "publication artifact does not match target" });
})))();
export type BackupPublicationRequestV1 = z.infer<typeof BackupPublicationRequestV1>;

export const BackupPublicationReceiptV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  publication: z.enum(["published", "already_published"]),
  record: BackupRecordV1,
  rotate: z.array(BackupRecordV1).max(MAX_BACKUP_ROTATION_RECORDS),
}).strict()))();
export type BackupPublicationReceiptV1 = z.infer<typeof BackupPublicationReceiptV1>;

/** Catalog-owned external-file accounting. Publication records remain immutable. */
export const BackupRetentionScopeV1 = /*#__PURE__*/ (() => (z.object({ appInstanceId: AppInstanceId, targetId: BackupTargetId,
  adapterCertificationId: BackupTargetAdapterCertificationId }).strict()))();
export type BackupRetentionScopeV1 = z.infer<typeof BackupRetentionScopeV1>;
export const BackupRemovalIntentV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), authorityIncarnationId: AuthorityIncarnationId,
  planningRevision: UInt64Decimal, backupId: BackupId, keeperBackupId: BackupId }).strict()))();
export type BackupRemovalIntentV1 = z.infer<typeof BackupRemovalIntentV1>;
export const BackupRemovalAcknowledgementV1 = /*#__PURE__*/ (() => (z.object({ requestId: RequestId, intent: BackupRemovalIntentV1,
  outcome: z.enum(["absent", "failed"]) }).strict()))();
export const BackupRetentionReceiptV1 = /*#__PURE__*/ (() => (BackupRemovalAcknowledgementV1.extend({ schema: z.literal(1),
  revision: UInt64Decimal, operationId: OperationId, requestSha256: Sha256, catalogGeneration: UInt64Decimal,
  fence: WriteFenceV1, completedAt: CanonicalInstant }).strict()))();
export type BackupRetentionReceiptV1 = z.infer<typeof BackupRetentionReceiptV1>;
export const BackupRetentionHistoryV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), revision: UInt64Decimal,
  events: z.array(BackupRetentionReceiptV1).max(100_000) }).strict()))();
export type BackupRetentionHistoryV1 = z.infer<typeof BackupRetentionHistoryV1>;
export const BackupRetentionPlanV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), keeper: BackupRecordV1.nullable(),
  entries: z.array(z.object({ requestId: RequestId, intent: BackupRemovalIntentV1, record: BackupRecordV1 }).strict())
    .max(MAX_BACKUP_ROTATION_RECORDS), remaining: z.number().int().nonnegative().safe() }).strict()))();
export type BackupRetentionPlanV1 = z.infer<typeof BackupRetentionPlanV1>;
export const BackupRemovalRequestV1 = /*#__PURE__*/ (() => (z.object({ requestId: RequestId, intent: BackupRemovalIntentV1 }).strict()))();
export const BackupRemovalAuthorizationV1 = /*#__PURE__*/ (() => (z.discriminatedUnion("status", [
  z.object({ status: z.literal("recorded"), receipt: BackupRetentionReceiptV1 }).strict(),
  z.object({ status: z.literal("ready"), requestId: RequestId, intent: BackupRemovalIntentV1,
    record: BackupRecordV1, keeper: BackupRecordV1, fence: WriteFenceV1 }).strict(),
])))();
export type BackupRemovalAuthorizationV1 = z.infer<typeof BackupRemovalAuthorizationV1>;

/** Presentation retry metadata, never identity or permission to remove a file. */
export const BackupRemovalPendingV1 = /*#__PURE__*/ (() => (z.discriminatedUnion("phase", [
  z.object({ schema: z.literal(1), scope: BackupRetentionScopeV1,
    requestId: RequestId, intent: BackupRemovalIntentV1, phase: z.literal("removing") }).strict(),
  z.object({ schema: z.literal(1), scope: BackupRetentionScopeV1,
    requestId: RequestId, intent: BackupRemovalIntentV1, phase: z.literal("observed"),
    outcome: z.enum(["absent", "failed"]) }).strict(),
])))();
export type BackupRemovalPendingV1 = z.infer<typeof BackupRemovalPendingV1>;

export const BackupStageValidationV1 = /*#__PURE__*/ (() => (z.discriminatedUnion("status", [
  z.object({
    schema: z.literal(1),
    status: z.literal("valid"),
    evidence: TargetEvidenceV1,
    authentication: BackupAuthenticationV1,
  }).strict(),
  z.object({
    schema: z.literal(1),
    status: z.literal("invalid"),
    evidence: z.null(),
  }).strict(),
])))();
export type BackupStageValidationV1 = z.infer<typeof BackupStageValidationV1>;

const BackupProtectionFailureReasonCode = /*#__PURE__*/ (() => (ProtectionReasonCode.extract([
  "adapter_uncertified",
  "target_unconfigured",
  "permission_required",
  "target_unreachable",
  "backup_stale",
  "backup_invalid",
  "generation_not_selected",
  "stale_write_epoch",
])))();

export const BackupFailureReasonCodeV1 = /*#__PURE__*/ (() => (z.union([
  BackupProtectionFailureReasonCode,
  z.enum([
    "invalid_run",
    "snapshot_mismatch",
    "unsupported_api",
    "quota_exceeded",
    "destination_collision",
    "operation_interrupted",
    "short_write",
    "digest_mismatch",
    "publication_failed",
  ]),
])))();
export type BackupFailureReasonCodeV1 = z.infer<typeof BackupFailureReasonCodeV1>;

const RotationSummaryV1 = /*#__PURE__*/ (() => (z.object({
  requested: z.number().int().nonnegative().max(MAX_BACKUP_ROTATION_RECORDS),
  deleted: z.number().int().nonnegative().max(MAX_BACKUP_ROTATION_RECORDS),
  failed: z.number().int().nonnegative().max(MAX_BACKUP_ROTATION_RECORDS),
}).strict().superRefine((value, context) => {
  if (value.deleted + value.failed > value.requested)
    context.addIssue({ code: "custom", message: "rotation totals exceed requested records" });
})))();

export const BackupResultV1 = /*#__PURE__*/ (() => (z.discriminatedUnion("status", [
  z.object({
    schema: z.literal(1),
    status: z.literal("failed"),
    reasonCode: BackupFailureReasonCodeV1,
    historical: ValidatedBackupArtifactV1.nullable(),
  }).strict(),
  z.object({
    schema: z.literal(1),
    status: z.literal("published"),
    publication: z.enum(["published", "already_published"]),
    record: BackupRecordV1,
    rotation: RotationSummaryV1,
  }).strict(),
])))();
export type BackupResultV1 = z.infer<typeof BackupResultV1>;

const ManualDownloadFileName = /*#__PURE__*/ (() => (z.string().min(1).max(160)
  .refine(value => !/[\\/\u0000-\u001f\u007f]/.test(value) && !value.includes(".."))
  .refine(value => value.endsWith(".clay"))))();

/** A download-start receipt is intentionally not automatic-backup evidence. */
export const ManualBackupDownloadV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  kind: z.literal("manual_download"),
  archiveFormat: z.literal(4),
  fileName: ManualDownloadFileName,
  byteLength: ArchiveByteLength,
  startedAt: CanonicalInstant,
  verification: z.literal("unverified"),
}).strict()))();
export type ManualBackupDownloadV1 = z.infer<typeof ManualBackupDownloadV1>;

/** Authentication of bytes is distinct from verification that a user saved them. */
export const ManualBackupDownloadV2 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(2), kind: z.literal("manual_download"), archiveFormat: z.literal(5),
  fileName: ManualDownloadFileName, byteLength: ArchiveByteLength, startedAt: CanonicalInstant,
  verification: z.literal("unverified_external_save"), authentication: BackupAuthenticationV1,
  archiveSha256: Sha256, evidence: TargetEvidenceV1,
}).strict()))();
export type ManualBackupDownloadV2 = z.infer<typeof ManualBackupDownloadV2>;

/** Shell retry metadata, never evidence of a verified external save. */
export const ManualDownloadIntentV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), requestId: RequestId,
  record: ManualBackupDownloadV2, phase: z.enum(["prepared", "handed_off"]) }).strict()))();
export type ManualDownloadIntentV1 = z.infer<typeof ManualDownloadIntentV1>;
