import { z } from "./validation-runtime";

const safeCount = /*#__PURE__*/ (() => (z.number().int().nonnegative().safe()))();
const UINT64_MAX = 18_446_744_073_709_551_615n;
const boundedText = (max: number): z.ZodString => z.string().min(1).max(max);
const lowerBase32Id = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[a-z2-7]{26}$`));
const semanticId = (prefix: "tbl" | "fld"): z.ZodString => z.string().regex(
  new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
);

function isUInt64Decimal(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return false;
  try { return BigInt(value) <= UINT64_MAX; } catch { return false; }
}

function isCanonicalUtcInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isSupportedTimeZone(value: string): boolean {
  if (value.startsWith("+") || value.startsWith("-")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicallySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0
    || compareCanonicalStrings(values[index - 1]!, value) < 0);
}

export const DAILY_HOME_SOURCE_IDS_V1 = [
  "automation_notification",
  "due_record",
  "favorite_record",
  "recently_changed_record",
  "recently_opened_record",
  "recovery_notice",
  "saved_view",
] as const;
export const DailyHomeSourceIdV1 = /*#__PURE__*/ (() => (z.enum(DAILY_HOME_SOURCE_IDS_V1)))();
export type DailyHomeSourceIdV1 = z.infer<typeof DailyHomeSourceIdV1>;

export const DAILY_HOME_SECTION_IDS_V1 = [
  "needs_attention",
  "due_today",
  "continue",
  "pinned",
  "recently_opened",
] as const;
export const DailyHomeSectionIdV1 = /*#__PURE__*/ (() => (z.enum(DAILY_HOME_SECTION_IDS_V1)))();
export type DailyHomeSectionIdV1 = z.infer<typeof DailyHomeSectionIdV1>;

export const CompletenessGapV1 = /*#__PURE__*/ (() => (z.object({
  sourceId: DailyHomeSourceIdV1,
  reason: z.enum(["unavailable", "timeout", "invalid_source", "limit"]),
  retryable: z.boolean(),
}).strict()))();
export type CompletenessGapV1 = z.infer<typeof CompletenessGapV1>;

const ExactCompletenessV1 = /*#__PURE__*/ (() => (z.object({
  kind: z.literal("exact"),
  total: safeCount,
}).strict()))();

const PartialCompletenessV1 = /*#__PURE__*/ (() => (z.object({
  kind: z.literal("partial"),
  knownMinimum: safeCount,
  gaps: z.array(CompletenessGapV1).min(1).max(7),
}).strict().superRefine((value, ctx) => {
  const ids = value.gaps.map(gap => gap.sourceId);
  if (!hasUniqueStrings(ids)) {
    ctx.addIssue({ code: "custom", path: ["gaps"], message: "completeness gaps must name unique sources" });
  }
})))();

export const CompletenessV1 = /*#__PURE__*/ (() => (z.union([
  ExactCompletenessV1,
  PartialCompletenessV1,
])))();
export type CompletenessV1 = z.infer<typeof CompletenessV1>;

export const DailyHomeCursorStringV1 = /*#__PURE__*/ (() => (z.string()
  .max(4_096)
  .regex(/^dcur_[A-Za-z0-9_-]{16,4026}\.[0-9a-f]{64}$/)))();
export const ContinuationV1 = /*#__PURE__*/ (() => (z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("end") }).strict(),
  z.object({
    kind: z.literal("cursor"),
    cursor: DailyHomeCursorStringV1,
  }).strict(),
])))();
export type ContinuationV1 = z.infer<typeof ContinuationV1>;

export const CountSetV1 = /*#__PURE__*/ (() => (z.object({
  sourceOccurrences: CompletenessV1,
  renderedUnique: CompletenessV1,
}).strict().superRefine((value, ctx) => {
  const sourceMinimum = value.sourceOccurrences.kind === "exact"
    ? value.sourceOccurrences.total : value.sourceOccurrences.knownMinimum;
  const renderedMinimum = value.renderedUnique.kind === "exact"
    ? value.renderedUnique.total : value.renderedUnique.knownMinimum;
  if (renderedMinimum > sourceMinimum) {
    ctx.addIssue({
      code: "custom",
      path: ["renderedUnique"],
      message: "rendered unique count cannot exceed source occurrence count",
    });
  }
})))();
export type CountSetV1 = z.infer<typeof CountSetV1>;

export function dailyPageV1<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item).max(20),
    returned: z.number().int().min(0).max(20).safe(),
    counts: CountSetV1,
    continuation: ContinuationV1,
  }).strict().superRefine((value, ctx) => {
    if (value.returned !== value.items.length) {
      ctx.addIssue({ code: "custom", path: ["returned"], message: "returned must equal items length" });
    }
    const sourceMinimum = value.counts.sourceOccurrences.kind === "exact"
      ? value.counts.sourceOccurrences.total : value.counts.sourceOccurrences.knownMinimum;
    if (value.returned > sourceMinimum) {
      ctx.addIssue({ code: "custom", path: ["returned"], message: "returned exceeds declared counts" });
    }
  });
}

export const TableSemanticIdV1 = /*#__PURE__*/ (() => (semanticId("tbl")))();
export const FieldSemanticIdV1 = /*#__PURE__*/ (() => (semanticId("fld")))();
export const RowIdV1 = /*#__PURE__*/ (() => (z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
)))();
export const AutomationIdV1 = /*#__PURE__*/ (() => (z.string().regex(/^auto_[0-9a-f]{32}$/)))();
export const SavedViewIdV1 = /*#__PURE__*/ (() => (z.string().regex(/^view_[0-9a-f]{32}$/)))();
export const DailySourceProfileIdV1 = /*#__PURE__*/ (() => (lowerBase32Id("dsp")))();
export const InboxSourceKeyV1 = /*#__PURE__*/ (() => (lowerBase32Id("inb")))();
export const SourceGenerationV1 = /*#__PURE__*/ (() => (lowerBase32Id("gen")))();
export const AppInstanceIdV1 = /*#__PURE__*/ (() => (lowerBase32Id("app")))();
export const Sha256V1 = /*#__PURE__*/ (() => (z.string().regex(/^sha256:[0-9a-f]{64}$/)))();
export const CanonicalUtcInstantV1 = /*#__PURE__*/ (() => (z.string().refine(
  isCanonicalUtcInstant,
  "canonical UTC millisecond instant required",
)))();
export const CanonicalLocalDateV1 = /*#__PURE__*/ (() => (z.string().refine(isCanonicalDate, "canonical local date required")))();
export const CanonicalTimeZoneV1 = /*#__PURE__*/ (() => (z.string().min(1).max(128).refine(
  isSupportedTimeZone,
  "recognized IANA timezone required",
)))();

const CompletionRuleV1 = /*#__PURE__*/ (() => (z.union([
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("boolean"),
    fieldId: FieldSemanticIdV1,
    completeValue: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("enum"),
    fieldId: FieldSemanticIdV1,
    completeValue: boundedText(40),
    terminalValues: z.array(boundedText(40)).min(1).max(24),
  }).strict().superRefine((value, ctx) => {
    if (!hasUniqueStrings(value.terminalValues)) {
      ctx.addIssue({ code: "custom", path: ["terminalValues"], message: "terminal values must be unique" });
    }
    if (!value.terminalValues.includes(value.completeValue)) {
      ctx.addIssue({
        code: "custom",
        path: ["completeValue"],
        message: "complete value must be one declared terminal value",
      });
    }
  }),
])))();
export type CompletionRuleV1 = z.infer<typeof CompletionRuleV1>;

export const DailySourceProfileV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  profileId: DailySourceProfileIdV1,
  tableId: TableSemanticIdV1,
  labelFieldId: FieldSemanticIdV1,
  dueFieldId: FieldSemanticIdV1,
  completion: CompletionRuleV1,
  enabled: z.boolean(),
  labelSnapshot: boundedText(80).optional(),
  dueLabelSnapshot: boundedText(80).optional(),
}).strict()))();
export type DailySourceProfileV1 = z.infer<typeof DailySourceProfileV1>;

export const DailySourceLibraryV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  revision: safeCount,
  profiles: z.array(DailySourceProfileV1).max(32),
}).strict().superRefine((value, ctx) => {
  const profileIds = value.profiles.map(profile => profile.profileId);
  if (!hasUniqueStrings(profileIds)) {
    ctx.addIssue({ code: "custom", path: ["profiles"], message: "profile IDs must be unique" });
  }
  const enabledTables = value.profiles.filter(profile => profile.enabled).map(profile => profile.tableId);
  if (!hasUniqueStrings(enabledTables)) {
    ctx.addIssue({
      code: "custom",
      path: ["profiles"],
      message: "only one enabled primary profile is allowed per table",
    });
  }
})))();
export type DailySourceLibraryV1 = z.infer<typeof DailySourceLibraryV1>;

export const SourceStatusV1 = /*#__PURE__*/ (() => (z.enum(["ready", "partial", "unavailable"])))();
export type SourceStatusV1 = z.infer<typeof SourceStatusV1>;

export const DailyHomeProfileResolutionV1 = /*#__PURE__*/ (() => (z.object({
  readyProfileIds: z.array(DailySourceProfileIdV1).max(32),
  issueProfileIds: z.array(DailySourceProfileIdV1).max(32),
}).strict().superRefine((value, ctx) => {
  const ready = value.readyProfileIds;
  const issues = value.issueProfileIds;
  if (!isCanonicallySorted(ready) || !isCanonicallySorted(issues)
      || ready.some(id => issues.includes(id))) {
    ctx.addIssue({
      code: "custom",
      message: "profile resolution must be a disjoint canonical partition",
    });
  }
})))();
export type DailyHomeProfileResolutionV1 = z.infer<typeof DailyHomeProfileResolutionV1>;

export const SourceWatermarkV1 = /*#__PURE__*/ (() => (z.object({
  sourceId: DailyHomeSourceIdV1,
  watermark: z.string().min(1).max(256).nullable(),
  status: SourceStatusV1,
  statusEpoch: boundedText(256),
}).strict().superRefine((value, ctx) => {
  if (value.status === "unavailable" && value.watermark !== null) {
    ctx.addIssue({ code: "custom", path: ["watermark"], message: "unavailable source has no watermark" });
  }
  if (value.status === "ready" && value.watermark === null) {
    ctx.addIssue({ code: "custom", path: ["watermark"], message: "ready source requires a watermark" });
  }
  if (value.sourceId === "recovery_notice" && value.status !== "unavailable") {
    ctx.addIssue({
      code: "custom", path: ["status"],
      message: "D0 recovery source remains unavailable until the Recovery contract is integrated",
    });
  }
})))();
export type SourceWatermarkV1 = z.infer<typeof SourceWatermarkV1>;

export const SnapshotBasisV1 = /*#__PURE__*/ (() => (z.object({
  appInstanceId: AppInstanceIdV1,
  activeGenerationId: SourceGenerationV1,
  schemaHead: boundedText(256),
  profileRevision: safeCount,
  profileDigest: Sha256V1,
  profileResolution: DailyHomeProfileResolutionV1,
  libraryRevision: safeCount,
  dispositionWatermark: boundedText(128),
  sourceWatermarks: z.array(SourceWatermarkV1).length(DAILY_HOME_SOURCE_IDS_V1.length),
  localDate: CanonicalLocalDateV1,
  timeZone: CanonicalTimeZoneV1,
  rankingVersion: z.literal("daily-rank-v1"),
  projectionValidUntil: CanonicalUtcInstantV1,
}).strict().superRefine((value, ctx) => {
  const ids = value.sourceWatermarks.map(source => source.sourceId);
  if (!hasUniqueStrings(ids)) {
    ctx.addIssue({ code: "custom", path: ["sourceWatermarks"], message: "source basis must be unique" });
  }
  const sorted = [...ids].sort(compareCanonicalStrings);
  if (ids.some((id, index) => id !== sorted[index])) {
    ctx.addIssue({ code: "custom", path: ["sourceWatermarks"], message: "source basis must be sorted" });
  }
  if (ids.some((id, index) => id !== DAILY_HOME_SOURCE_IDS_V1[index])) {
    ctx.addIssue({ code: "custom", path: ["sourceWatermarks"], message: "source basis must contain every source" });
  }
})))();
export type SnapshotBasisV1 = z.infer<typeof SnapshotBasisV1>;

export const DailyHomeAdapterContinuationsV1 = /*#__PURE__*/ (() => (z.array(z.object({
  sourceId: DailyHomeSourceIdV1,
  continuation: z.string().min(1).max(256).nullable(),
}).strict()).length(DAILY_HOME_SOURCE_IDS_V1.length).superRefine((value, ctx) => {
  if (value.some((entry, index) => entry.sourceId !== DAILY_HOME_SOURCE_IDS_V1[index])) {
    ctx.addIssue({
      code: "custom",
      message: "cursor must bind every adapter continuation in canonical source order",
    });
  }
})))();
export type DailyHomeAdapterContinuationsV1 = z.infer<typeof DailyHomeAdapterContinuationsV1>;

export const DailyHomePageScopeV1 = /*#__PURE__*/ (() => (z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("source"),
    sourceId: DailyHomeSourceIdV1,
    pageSize: z.number().int().min(1).max(20).safe(),
  }).strict(),
  z.object({
    kind: z.literal("section"),
    sectionId: DailyHomeSectionIdV1,
    pageSize: z.number().int().min(1).max(20).safe(),
  }).strict(),
])))();
export type DailyHomePageScopeV1 = z.infer<typeof DailyHomePageScopeV1>;

export const DailyHomeCursorStateV1 = /*#__PURE__*/ (() => (z.object({
  adapterContinuations: DailyHomeAdapterContinuationsV1,
  pageScope: DailyHomePageScopeV1,
}).strict()))();
export type DailyHomeCursorStateV1 = z.infer<typeof DailyHomeCursorStateV1>;

export const DailyHomeCursorPayloadV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  appInstanceId: AppInstanceIdV1,
  activeGenerationId: SourceGenerationV1,
  basisDigest: Sha256V1,
  adapterContinuations: DailyHomeAdapterContinuationsV1,
  pageScope: DailyHomePageScopeV1,
  rankingVersion: z.literal("daily-rank-v1"),
  localDate: CanonicalLocalDateV1,
  timeZone: CanonicalTimeZoneV1,
  projectionValidUntil: CanonicalUtcInstantV1,
}).strict()))();
export type DailyHomeCursorPayloadV1 = z.infer<typeof DailyHomeCursorPayloadV1>;

export const DailyHomeProjectionAuthorityV1 = /*#__PURE__*/ (() => (z.object({
  schema: z.literal(1),
  appInstanceId: AppInstanceIdV1,
  activeGenerationId: SourceGenerationV1,
  schemaHead: boundedText(256),
  sourceLibrary: DailySourceLibraryV1,
  profileResolution: DailyHomeProfileResolutionV1,
  dispositionWatermark: boundedText(128),
  sourceWatermarks: z.array(SourceWatermarkV1).length(DAILY_HOME_SOURCE_IDS_V1.length),
  localDate: CanonicalLocalDateV1,
  timeZone: CanonicalTimeZoneV1,
  projectionValidUntil: CanonicalUtcInstantV1,
}).strict().superRefine((value, ctx) => {
  const ready = value.profileResolution.readyProfileIds;
  const issues = value.profileResolution.issueProfileIds;
  const enabled = value.sourceLibrary.profiles
    .filter(profile => profile.enabled).map(profile => profile.profileId).sort(compareCanonicalStrings);
  const resolved = [...ready, ...issues].sort(compareCanonicalStrings);
  if (enabled.length !== resolved.length || enabled.some((id, index) => id !== resolved[index])) {
    ctx.addIssue({ code: "custom", path: ["profileResolution"], message: "profile resolution must cover every enabled profile" });
  }
  const sourceIds = value.sourceWatermarks.map(source => source.sourceId);
  if (sourceIds.some((id, index) => id !== DAILY_HOME_SOURCE_IDS_V1[index])) {
    ctx.addIssue({ code: "custom", path: ["sourceWatermarks"], message: "authority must contain every source in canonical order" });
  }
  const due = value.sourceWatermarks.find(source => source.sourceId === "due_record");
  if ((ready.length === 0 || issues.length > 0) && due?.status === "ready") {
    ctx.addIssue({ code: "custom", path: ["sourceWatermarks"], message: "due source readiness contradicts profile resolution" });
  }
})))();
export type DailyHomeProjectionAuthorityV1 = z.infer<typeof DailyHomeProjectionAuthorityV1>;

export const TrustedRouteV1 = /*#__PURE__*/ (() => (z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("record"),
    tableId: TableSemanticIdV1,
    rowId: RowIdV1,
  }).strict(),
  z.object({
    kind: z.literal("automation"),
    automationId: AutomationIdV1,
  }).strict(),
  z.object({
    kind: z.literal("saved_view"),
    savedViewId: SavedViewIdV1,
  }).strict(),
  z.object({
    kind: z.literal("setup"),
    area: z.enum(["daily_sources", "automations"]),
  }).strict(),
  z.object({ kind: z.literal("inbox") }).strict(),
])))();
export type TrustedRouteV1 = z.infer<typeof TrustedRouteV1>;

const InboxActionV1 = /*#__PURE__*/ (() => (z.enum(["open", "setup", "fix", "complete", "snooze", "dismiss"])))();
export const InboxItemV1 = /*#__PURE__*/ (() => (z.object({
  sourceKey: InboxSourceKeyV1,
  sourceGeneration: SourceGenerationV1,
  kind: z.enum(["due_record", "automation_notification"]),
  title: boundedText(240),
  summary: boundedText(500).optional(),
  severity: z.enum(["critical", "high", "normal", "low"]),
  attentionAt: CanonicalUtcInstantV1,
  dueAt: CanonicalUtcInstantV1.optional(),
  expectedCanonicalRevision: z.string()
    .refine(isUInt64Decimal, "canonical uint64 revision required").optional(),
  dispositionRevision: safeCount,
  route: TrustedRouteV1,
  actions: z.array(InboxActionV1).min(1).max(4),
}).strict().superRefine((value, ctx) => {
  if (!hasUniqueStrings(value.actions)) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "Inbox actions must be unique" });
  }
  const setupRoute = value.route.kind === "setup";
  if (setupRoute !== value.actions.every(action => action === "setup" || action === "fix")) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "actions must match setup navigation" });
  }
  if (setupRoute) {
    const expectedArea = value.kind === "due_record" ? "daily_sources" : "automations";
    if (value.route.kind === "setup" && value.route.area !== expectedArea) {
      ctx.addIssue({ code: "custom", path: ["route"], message: "setup route must match source kind" });
    }
  }
  if (!setupRoute && (value.actions[0] !== "open" || value.actions.includes("setup") || value.actions.includes("fix")
      || (value.kind !== "due_record" && value.actions.includes("complete")))) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "actions must match the canonical source capability" });
  }
  const expectedRoute = value.kind === "due_record" ? "record" : "automation";
  if (!setupRoute && value.route.kind !== expectedRoute) {
    ctx.addIssue({ code: "custom", path: ["route"], message: "route must match source kind" });
  }
})))();
export type InboxItemV1 = z.infer<typeof InboxItemV1>;

/** App-owned local presentation, not a second work queue or remote runtime. */
export const InboxDispositionV1 = /*#__PURE__*/ (() => (z.object({ schema: z.literal(1), sourceKey: InboxSourceKeyV1,
  sourceGeneration: SourceGenerationV1, revision: safeCount.positive(), requestId: lowerBase32Id("req"),
  state: z.enum(["active", "snoozed", "dismissed"]), until: CanonicalUtcInstantV1.nullable(),
  localDate: CanonicalLocalDateV1.nullable(), timeZone: CanonicalTimeZoneV1.nullable(),
}).strict().superRefine((value, context) => {
  const snoozed = value.state === "snoozed";
  if (snoozed !== (value.until !== null) || snoozed !== (value.localDate !== null) || snoozed !== (value.timeZone !== null))
    context.addIssue({ code: "custom", message: "Snooze requires an exact local-calendar boundary; other dispositions have none" });
})))();
export type InboxDispositionV1 = z.infer<typeof InboxDispositionV1>;

export const DailyHomeRecordProjectionV1 = /*#__PURE__*/ (() => (z.object({
  kind: z.literal("record_projection"),
  sourceId: z.enum(["favorite_record", "recently_changed_record", "recently_opened_record"]),
  sourceKey: InboxSourceKeyV1,
  sourceGeneration: SourceGenerationV1,
  tableId: TableSemanticIdV1,
  rowId: RowIdV1,
  title: boundedText(240),
  updatedAt: CanonicalUtcInstantV1,
  openedAt: CanonicalUtcInstantV1.optional(),
  favoriteOrder: safeCount.optional(),
  route: z.object({
    kind: z.literal("record"),
    tableId: TableSemanticIdV1,
    rowId: RowIdV1,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.route.tableId !== value.tableId || value.route.rowId !== value.rowId) {
    ctx.addIssue({ code: "custom", path: ["route"], message: "record route must bind the projected record" });
  }
  if ((value.sourceId === "recently_opened_record") !== (value.openedAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["openedAt"], message: "opened time must match recent-open source" });
  }
  if ((value.sourceId === "favorite_record") !== (value.favoriteOrder !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["favoriteOrder"], message: "favorite order must match favorite source" });
  }
})))();
export type DailyHomeRecordProjectionV1 = z.infer<typeof DailyHomeRecordProjectionV1>;

export const DailyHomeSavedViewProjectionV1 = /*#__PURE__*/ (() => (z.object({
  kind: z.literal("saved_view_projection"),
  sourceId: z.literal("saved_view"),
  sourceKey: InboxSourceKeyV1,
  sourceGeneration: SourceGenerationV1,
  savedViewId: SavedViewIdV1,
  title: boundedText(240),
  route: z.object({
    kind: z.literal("saved_view"),
    savedViewId: SavedViewIdV1,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.route.savedViewId !== value.savedViewId) {
    ctx.addIssue({ code: "custom", path: ["route"], message: "view route must bind the projected view" });
  }
})))();
export type DailyHomeSavedViewProjectionV1 = z.infer<typeof DailyHomeSavedViewProjectionV1>;

export const DailyHomeItemV1 = /*#__PURE__*/ (() => (z.union([
  InboxItemV1,
  DailyHomeRecordProjectionV1,
  DailyHomeSavedViewProjectionV1,
])))();
export type DailyHomeItemV1 = z.infer<typeof DailyHomeItemV1>;

function renderedIdentity(item: DailyHomeItemV1): string {
  if (item.kind === "record_projection") return `record:${item.tableId}:${item.rowId}`;
  if (item.kind === "saved_view_projection") return `view:${item.savedViewId}`;
  if (item.route.kind === "record") return `record:${item.route.tableId}:${item.route.rowId}`;
  if (item.route.kind === "automation") return `automation:${item.route.automationId}`;
  return `occurrence:${item.sourceKey}\u0000${item.sourceGeneration}`;
}

const DailyItemPageV1 = /*#__PURE__*/ (() => (dailyPageV1(DailyHomeItemV1)))();
export const DailyHomeSourceSnapshotV1 = /*#__PURE__*/ (() => (z.object({
  sourceId: DailyHomeSourceIdV1,
  watermark: z.string().min(1).max(256).nullable(),
  status: SourceStatusV1,
  statusEpoch: boundedText(256),
  page: DailyItemPageV1,
}).strict().superRefine((value, ctx) => {
  const sourceCounts = value.page.counts.sourceOccurrences;
  const renderedCounts = value.page.counts.renderedUnique;
  const bothExact = sourceCounts.kind === "exact" && renderedCounts.kind === "exact";
  const bothPartial = sourceCounts.kind === "partial" && renderedCounts.kind === "partial";
  const gapsMatchSource = bothPartial
    && sourceCounts.gaps.every(gap => gap.sourceId === value.sourceId)
    && renderedCounts.gaps.every(gap => gap.sourceId === value.sourceId);
  const gapsMatchEachOther = bothPartial
    && sourceCounts.gaps.length === renderedCounts.gaps.length
    && sourceCounts.gaps.every((gap, index) => {
      const other = renderedCounts.gaps[index];
      return other !== undefined && other.sourceId === gap.sourceId
        && other.reason === gap.reason && other.retryable === gap.retryable;
    });
  const gapPolicyValid = bothPartial && sourceCounts.gaps.every(gap =>
    gap.reason === "invalid_source" ? !gap.retryable : gap.retryable);
  const unavailableReasonValid = bothPartial && sourceCounts.gaps.length === 1
    && (sourceCounts.gaps[0]!.reason === "unavailable"
      || sourceCounts.gaps[0]!.reason === "invalid_source");
  if (value.status === "ready" && (!bothExact || value.watermark === null)) {
    ctx.addIssue({
      code: "custom", path: ["status"],
      message: "ready source requires exact counts and a watermark",
    });
  }
  if (value.status === "partial"
      && (!bothPartial || !gapsMatchSource || !gapsMatchEachOther || !gapPolicyValid)) {
    ctx.addIssue({
      code: "custom", path: ["status"],
      message: "partial source requires source-local partial completeness",
    });
  }
  if (value.status === "unavailable" && (!bothPartial || !gapsMatchSource || !gapsMatchEachOther
      || !gapPolicyValid || !unavailableReasonValid
      || sourceCounts.kind !== "partial" || sourceCounts.knownMinimum !== 0
      || renderedCounts.kind !== "partial" || renderedCounts.knownMinimum !== 0
      || value.watermark !== null || value.page.returned !== 0
      || value.page.items.length !== 0 || value.page.continuation.kind !== "end")) {
    ctx.addIssue({
      code: "custom", path: ["status"],
      message: "unavailable source requires an empty source-local partial page",
    });
  }
  const occurrenceKeys = value.page.items.map(item =>
    `${item.sourceKey}\u0000${item.sourceGeneration}`);
  const renderedKeys = new Set(value.page.items.map(renderedIdentity));
  if (!hasUniqueStrings(occurrenceKeys)) {
    ctx.addIssue({
      code: "custom", path: ["page", "items"],
      message: "source page occurrence identities must be unique",
    });
  }
  if (value.page.continuation.kind === "end" && bothExact
      && (sourceCounts.total !== value.page.items.length
        || renderedCounts.total !== renderedKeys.size)) {
    ctx.addIssue({
      code: "custom", path: ["page", "counts"],
      message: "complete source-page counts must match returned identities",
    });
  }
  for (let index = 0; index < value.page.items.length; index++) {
    const item = value.page.items[index]!;
    const itemSource = item.kind === "record_projection" || item.kind === "saved_view_projection"
      ? item.sourceId
      : item.kind;
    if (itemSource !== value.sourceId) {
      ctx.addIssue({
        code: "custom",
        path: ["page", "items", index],
        message: "source page item must match source ID",
      });
    }
  }
})))();
export type DailyHomeSourceSnapshotV1 = z.infer<typeof DailyHomeSourceSnapshotV1>;

const SECTION_ORDER = DAILY_HOME_SECTION_IDS_V1;
const DailyHomeSectionV1 = /*#__PURE__*/ (() => (z.object({
  sectionId: DailyHomeSectionIdV1,
  page: DailyItemPageV1,
}).strict()))();

export const DailyHomeSnapshotV1 = /*#__PURE__*/ (() => (z.object({
  generatedAt: CanonicalUtcInstantV1,
  basis: SnapshotBasisV1,
  snapshotDigest: Sha256V1,
  configurationStatus: z.enum(["ready", "needs_setup", "partial"]),
  sources: z.array(DailyHomeSourceSnapshotV1).length(DAILY_HOME_SOURCE_IDS_V1.length),
  sections: z.array(DailyHomeSectionV1).length(SECTION_ORDER.length),
  aggregateCounts: CountSetV1,
}).strict().superRefine((value, ctx) => {
  const sourceIds = value.sources.map(source => source.sourceId);
  if (!hasUniqueStrings(sourceIds)) {
    ctx.addIssue({ code: "custom", path: ["sources"], message: "snapshot sources must be unique" });
  }
  if (sourceIds.some((id, index) => id !== DAILY_HOME_SOURCE_IDS_V1[index])) {
    ctx.addIssue({ code: "custom", path: ["sources"], message: "snapshot must contain every source in canonical order" });
  }
  const basisBySource = new Map(value.basis.sourceWatermarks.map(source => [source.sourceId, source]));
  if (basisBySource.size !== value.sources.length || value.sources.some(source => {
    const basis = basisBySource.get(source.sourceId);
    return !basis || basis.watermark !== source.watermark
      || basis.status !== source.status || basis.statusEpoch !== source.statusEpoch;
  })) {
    ctx.addIssue({
      code: "custom", path: ["sources"],
      message: "snapshot sources must match the complete basis vector",
    });
  }
  if (value.configurationStatus === "ready"
      && value.sources.some(source => source.status !== "ready")) {
    ctx.addIssue({
      code: "custom", path: ["configurationStatus"],
      message: "ready configuration cannot contain partial sources",
    });
  }
  const sectionIds = value.sections.map(section => section.sectionId);
  if (!hasUniqueStrings(sectionIds)) {
    ctx.addIssue({ code: "custom", path: ["sections"], message: "snapshot sections must be unique" });
  }
  if (sectionIds.some((id, index) => id !== SECTION_ORDER[index])) {
    ctx.addIssue({ code: "custom", path: ["sections"], message: "snapshot must contain every section" });
  }
  const order = sectionIds.map(id => SECTION_ORDER.indexOf(id));
  if (order.some((position, index) => index > 0 && position <= order[index - 1]!)) {
    ctx.addIssue({ code: "custom", path: ["sections"], message: "snapshot sections must use canonical order" });
  }
  if (new Date(value.generatedAt).getTime() >= new Date(value.basis.projectionValidUntil).getTime()) {
    ctx.addIssue({
      code: "custom",
      path: ["basis", "projectionValidUntil"],
      message: "projection validity must be after generation",
    });
  }
})))();
export type DailyHomeSnapshotV1 = z.infer<typeof DailyHomeSnapshotV1>;
