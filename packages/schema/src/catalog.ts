import { z } from "zod";
import { DailySourceLibraryV1, SnapshotBasisV1, DailyHomeSnapshotV1, InboxItemV1, InboxDispositionV1, CanonicalLocalDateV1 } from "./daily-home";
import {
  AppInstanceId,
  AuthorityIncarnationId,
  GenerationId,
  JsonValue,
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

const presentationName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const relationCount = z.number().int().nonnegative().max(5_000);
export const RelationPreviewPayloadV1 = z.object({ sourceTable: presentationName, sourceField: presentationName,
  targetTable: presentationName, displayField: presentationName }).strict();
export const RelationKeepPayloadV1 = RelationPreviewPayloadV1.extend({
  atVersion: z.number().int().nonnegative().safe(), fingerprint: Sha256,
  matchedRows: relationCount, unmatchedRows: relationCount, ambiguousRows: relationCount, duplicateSourceRows: relationCount,
  unmatchedSamples: z.array(z.string().max(64_000)).max(5), ambiguousSamples: z.array(z.string().max(64_000)).max(5),
  cardinality: z.literal("one"), authorityTarget: TargetEvidenceV1,
}).strict();
export const RelationUndoPayloadV1 = z.object({ conversionRequestId: RequestId,
  beforeVersion: z.number().int().nonnegative().safe(), authorityTarget: TargetEvidenceV1.optional() }).strict();
export const DailyCapturePayloadV1 = z.object({ appInstanceId: AppInstanceId, table: presentationName,
  tableId: z.string().regex(/^tbl_[0-9a-f-]{36}$/), row: z.record(JsonValue) }).strict();
export const DailyCaptureUndoPayloadV1 = z.object({ batchId: z.string().uuid(), captureRequestId: RequestId,
  capturePayload: DailyCapturePayloadV1, authorityTarget: TargetEvidenceV1 }).strict().superRefine((value, context) => {
  if (value.capturePayload.appInstanceId !== value.authorityTarget.appInstanceId)
    context.addIssue({ code: "custom", message: "Capture Undo belongs to another app" });
});
export type DailyCaptureUndoPayloadV1 = z.infer<typeof DailyCaptureUndoPayloadV1>;

export const DailyCasReviewV1 = z.object({ authorityTarget: TargetEvidenceV1, basis: SnapshotBasisV1, snapshotDigest: Sha256 }).strict()
  .superRefine((value, context) => {
    if (value.basis.appInstanceId !== value.authorityTarget.appInstanceId || value.basis.activeGenerationId !== value.authorityTarget.activeGenerationId)
      context.addIssue({ code: "custom", message: "Daily review belongs to another source" });
  });
export type DailyCasReviewV1 = z.infer<typeof DailyCasReviewV1>;
const navigationRef = z.object({ tableId: z.string().regex(/^tbl_[0-9a-f-]{36}$/), rowId: z.string().uuid() });
const navigationInstant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
export const DailyNavigationStateV1 = z.object({ schema: z.literal(1), revision: z.number().int().nonnegative().safe(),
  favorites: z.array(navigationRef.extend({ pinnedAt: navigationInstant }).strict()).max(50),
  recents: z.array(navigationRef.extend({ openedAt: navigationInstant }).strict()).max(20),
}).strict().superRefine((value, context) => {
  for (const refs of [value.favorites, value.recents]) if (new Set(refs.map(ref => `${ref.tableId}/${ref.rowId}`)).size !== refs.length)
    context.addIssue({ code: "custom", message: "Duplicate navigation identity" });
});
export const DailySourceCasPayloadV1 = z.object({ review: DailyCasReviewV1,
  expectedRevision: z.number().int().nonnegative().safe(), value: DailySourceLibraryV1 }).strict();
export const DailyNavigationCasPayloadV1 = z.object({ review: DailyCasReviewV1,
  expectedRevision: z.number().int().nonnegative().safe(), value: DailyNavigationStateV1 }).strict();
export const DailyPresentationV1 = z.object({ authorityTarget: TargetEvidenceV1, snapshot: DailyHomeSnapshotV1,
  sourceLibrary: JsonValue, navigation: JsonValue }).strict();
export type DailyPresentationV1 = z.infer<typeof DailyPresentationV1>;
export const DailyInboxActionPayloadV1 = z.object({ review: DailyCasReviewV1, item: InboxItemV1,
  action: z.enum(["complete", "snooze", "dismiss"]), untilLocalDate: CanonicalLocalDateV1.optional() }).strict().superRefine((value, context) => {
  if ((value.action === "snooze") !== (value.untilLocalDate !== undefined))
    context.addIssue({ code: "custom", message: "Only Snooze takes a reviewed local date" });
});
export type DailyInboxActionPayloadV1 = z.infer<typeof DailyInboxActionPayloadV1>;
export const DailyInboxReceiptV1 = z.object({ disposition: InboxDispositionV1, previous: InboxDispositionV1.nullable(), batchId: z.string().uuid().nullable() }).strict();
export type DailyInboxReceiptV1 = z.infer<typeof DailyInboxReceiptV1>;
export const DailyInboxUndoPayloadV1 = z.object({ actionRequestId: RequestId,
  actionPayload: DailyInboxActionPayloadV1, authorityTarget: TargetEvidenceV1 }).strict().superRefine((value, context) => {
  if (value.actionPayload.review.authorityTarget.appInstanceId !== value.authorityTarget.appInstanceId)
    context.addIssue({ code: "custom", message: "Inbox Undo belongs to another app" });
});
export type DailyInboxUndoPayloadV1 = z.infer<typeof DailyInboxUndoPayloadV1>;

export const AutomationCommandRouteV1 = z.enum(["saveAutomationDraft", "saveAutomationRecipeDraft", "enableAutomation",
  "pauseAutomation", "deleteAutomation", "runAutomationNow", "runDueAutomations", "undoAutomationRun", "markNotificationRead"]);
/** Each inner payload is separately closed by its existing kernel route. */
export const AutomationCommandPayloadV1 = z.object({ authorityTarget: TargetEvidenceV1,
  command: z.object({ route: AutomationCommandRouteV1, payload: z.record(JsonValue) }).strict() }).strict();
export type AutomationCommandPayloadV1 = z.infer<typeof AutomationCommandPayloadV1>;
export const AutomationWorkspaceV1 = z.object({ schema: z.literal(1), draftId: RequestId, authorityTarget: TargetEvidenceV1,
  kind: z.enum(["custom", "edit", "recipe", "legacy"]), fields: z.record(z.string().max(64_000)),
  definition: z.record(JsonValue).nullable(), expectedRevision: z.number().int().nonnegative().safe().nullable(),
  recipeId: z.enum(["overdue_invoice_reminder", "weekly_checklist", "new_customer_follow_up"]).nullable(),
}).strict();
export type AutomationWorkspaceV1 = z.infer<typeof AutomationWorkspaceV1>;

export const IntakeCommandRouteV1 = z.enum(["intake.saveForm", "intake.closePublication", "intake.markPublished", "intake.revokeForm", "intake.markExpired",
  "intake.stageSubmission", "intake.recordDeliveryFailure", "intake.authorizeDeliveryDiscard", "intake.resolveDeliveryFailure",
  "intake.rejectSubmission", "intake.simulateAutoAccept", "intake.enableAutoAccept", "intake.disableAutoAccept",
  "intake.processAutoAccept", "intake.acceptSubmission", "intake.undoReceipt"]);
export const IntakeCommandPayloadV1 = z.object({ authorityTarget: TargetEvidenceV1,
  command: z.object({ route: IntakeCommandRouteV1, payload: z.record(JsonValue) }).strict() }).strict();
export type IntakeCommandPayloadV1 = z.infer<typeof IntakeCommandPayloadV1>;

/** Presentation retry metadata is not authority. The worker independently
 * captures the full payload and binds its hash to the mirrored request journal. */
export const RecoverablePresentationRouteV1 = z.enum([
  "schema.convertTextToRelation", "schema.undoRelationConversion", "daily.capture", "daily.undoCapture", "batch.apply", "batch.undo",
  "daily.source", "daily.navigation",
  "daily.inbox", "daily.undoInbox",
  "automation.command", "intake.command",
]);
export const PresentationIntentV1 = z.object({
  schema: z.literal(1), appInstanceId: AppInstanceId, slot: z.enum(["relation", "capture", "conversionUndo", "captureUndo", "dailySource", "dailyNavigation", "dailyInbox", "dailyInboxUndo", "automation", "intake"]),
  requestId: RequestId, route: RecoverablePresentationRouteV1, payload: z.record(JsonValue),
}).strict().superRefine((value, context) => {
  const contract = {
    relation: { route: "schema.convertTextToRelation", payload: RelationKeepPayloadV1 },
    conversionUndo: { route: "schema.undoRelationConversion", payload: RelationUndoPayloadV1 },
    capture: { route: "daily.capture", payload: DailyCapturePayloadV1 },
    captureUndo: { route: "daily.undoCapture", payload: DailyCaptureUndoPayloadV1 },
    dailySource: { route: "daily.source", payload: DailySourceCasPayloadV1 },
    dailyNavigation: { route: "daily.navigation", payload: DailyNavigationCasPayloadV1 },
    dailyInbox: { route: "daily.inbox", payload: DailyInboxActionPayloadV1 },
    dailyInboxUndo: { route: "daily.undoInbox", payload: DailyInboxUndoPayloadV1 },
    automation: { route: "automation.command", payload: AutomationCommandPayloadV1 },
    intake: { route: "intake.command", payload: IntakeCommandPayloadV1 },
  }[value.slot];
  if (value.route !== contract.route || !contract.payload.safeParse(value.payload).success) {
    context.addIssue({ code: "custom", message: "Stored retry payload or route is invalid for its slot" });
    return;
  }
  const source = value.payload.review ? (value.payload.review as DailyCasReviewV1).authorityTarget.appInstanceId
    : value.slot === "capture" ? value.payload.appInstanceId : value.payload.authorityTarget
    ? (value.payload.authorityTarget as TargetEvidenceV1).appInstanceId : value.appInstanceId;
  if (source !== value.appInstanceId)
    context.addIssue({ code: "custom", message: "Stored retry payload is bound to another app" });
});
export type PresentationIntentV1 = z.infer<typeof PresentationIntentV1>;
export const PresentationMutationOutcomeV1 = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_invoked") }).strict(),
  z.object({ status: z.literal("uncertain") }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("failed") }).strict(),
  z.object({ status: z.literal("recorded"), current: z.boolean(), result: JsonValue, target: TargetEvidenceV1 }).strict(),
]);
export type PresentationMutationOutcomeV1 = z.infer<typeof PresentationMutationOutcomeV1>;

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
    kind: z.enum(["create", "fork", "switch", "rename", "delete", "restore", "restore_aborted"]),
    resultTarget: TargetEvidenceV1,
    resultDisplayName: CatalogDisplayName,
    resultShellId: CatalogShellId,
    initialPublication: z.object({
      catalogGeneration: UInt64Decimal,
      target: TargetEvidenceV1,
      reattestationRequestId: RequestId,
    }).strict().optional(),
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
  if (value.schema === 2 && value.initialPublication && value.kind !== "restore" && value.kind !== "fork")
    context.addIssue({ code: "custom", message: "only a fresh copied target may re-attest sample provenance" });
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
