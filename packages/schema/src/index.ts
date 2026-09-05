// Clay shared schemas — THE CONSTITUTION for all shapes.
// Full semantic validation lives here (client-side). The API-level
// structured-output schema is the simplified projection in
// mutation-plan-api.json (gap G1 / ADR-013).
// Frozen per P0.3 on 2026-07-02 with gap resolutions G18–G26 applied;
// changes from here on require an ADR in the same commit (CLAUDE.md §3).
import { z } from "zod";

// ---------- primitives ----------
export const Ident = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
export const PanelId = z.string().regex(/^[a-z][a-z0-9_]{2,40}$/);
export const ColumnType = z.enum([
  "text","number","integer","boolean","date","enum","json","computed",
  "relation","lookup","rollup","rich_text","attachment",
]);

export const RelationSpec = z.object({
  target_table: Ident,
  cardinality: z.enum(["one", "many"]),
  unique_targets: z.boolean().default(false),
  display_field: Ident.optional(),
}).strict();
export const LookupSpec = z.object({
  relation_field: Ident,
  target_field: Ident,
}).strict();
export const RollupSpec = z.object({
  relation_field: Ident,
  target_field: Ident.optional(),
  operation: z.enum(["count", "sum", "avg", "min", "max"]),
}).strict();

// JSON without `any` (G26). Scalars for values the migration ops carry.
export type Json =
  | string | number | boolean | null | Json[] | { [key: string]: Json };
export const JsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(),
           z.array(JsonValue), z.record(JsonValue)]));
export const JsonScalar = z.union([z.string(), z.number(), z.boolean()]);

// ---------- A/B target identity and Temporary eligibility (ADR-048) ----------
const UINT64_MAX = 18_446_744_073_709_551_615n;
function isUInt64Decimal(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return false;
  try { return BigInt(value) <= UINT64_MAX; } catch { return false; }
}

export const UInt64Decimal = z.string().refine(isUInt64Decimal, "canonical uint64 decimal required");
const lowerBase32Id = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[a-z2-7]{26}$`));
export const AppInstanceId = lowerBase32Id("app");
export const GenerationId = lowerBase32Id("gen");
export const AuthorityIncarnationId = lowerBase32Id("auth");
export const NamespaceId = lowerBase32Id("ns");
export const LeaseId = lowerBase32Id("lease");
export const OperationId = lowerBase32Id("op");
export const ReleaseId = lowerBase32Id("rel");
export const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const TargetIdentityV1 = z.object({
  appInstanceId: AppInstanceId,
  activeGenerationId: GenerationId,
  lineageEpoch: UInt64Decimal,
  stateRevision: UInt64Decimal,
  stateDigest: Sha256,
}).strict();
export type TargetIdentityV1 = z.infer<typeof TargetIdentityV1>;

export const TargetEvidenceV1 = z.object({
  appInstanceId: AppInstanceId,
  activeGenerationId: GenerationId,
  lineageEpoch: UInt64Decimal,
  protectionRevision: UInt64Decimal,
  digestSchema: z.literal(1),
  stateSha256: Sha256,
}).strict();
export type TargetEvidenceV1 = z.infer<typeof TargetEvidenceV1>;

const CanonicalInstant = z.string().datetime({ offset: true });
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
}).strict().superRefine((value, ctx) => {
  if (value.generationId !== value.target.activeGenerationId)
    ctx.addIssue({ code: "custom", message: "generation descriptor does not match target" });
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
export const AppCatalogEntryV1 = z.object({
  appInstanceId: AppInstanceId,
  displayName: CatalogDisplayName,
  activeGenerationId: GenerationId,
  currentLineageEpoch: UInt64Decimal,
  lineageEpochHighWater: UInt64Decimal,
  currentProtectionRevision: UInt64Decimal,
  revisionHighWater: UInt64Decimal,
  digestSchema: z.literal(1),
  stateSha256: Sha256,
  tombstoned: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (BigInt(value.currentLineageEpoch) > BigInt(value.lineageEpochHighWater))
    ctx.addIssue({ code: "custom", message: "lineage epoch exceeds high-water mark" });
  if (BigInt(value.currentProtectionRevision) > BigInt(value.revisionHighWater))
    ctx.addIssue({ code: "custom", message: "protection revision exceeds high-water mark" });
});
export type AppCatalogEntryV1 = z.infer<typeof AppCatalogEntryV1>;

export const AppCatalogSnapshotV1 = z.object({
  schema: z.literal(1),
  authorityIncarnationId: AuthorityIncarnationId,
  catalogGeneration: UInt64Decimal,
  selectedAppInstanceId: AppInstanceId.nullable(),
  entries: z.array(AppCatalogEntryV1),
  writeEpoch: UInt64Decimal,
}).strict().superRefine((value, ctx) => {
  const appIds = new Set<string>();
  const generationIds = new Set<string>();
  for (const entry of value.entries) {
    if (appIds.has(entry.appInstanceId))
      ctx.addIssue({ code: "custom", message: "duplicate app instance identity" });
    if (generationIds.has(entry.activeGenerationId))
      ctx.addIssue({ code: "custom", message: "duplicate active generation identity" });
    appIds.add(entry.appInstanceId);
    generationIds.add(entry.activeGenerationId);
  }
  if (value.selectedAppInstanceId !== null && !appIds.has(value.selectedAppInstanceId))
    ctx.addIssue({ code: "custom", message: "selected app is not a live catalog entry" });
});
export type AppCatalogSnapshotV1 = z.infer<typeof AppCatalogSnapshotV1>;

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

export const TemporaryUserChoice = z.literal("accepted_temporary_after_loss_boundary").nullable();
export const TemporaryEligibilityV1 = z.object({
  schema: z.literal(1),
  catalogReadable: z.literal(true),
  catalogAppCount: z.literal(0),
  namespaceInventoryReadable: z.literal(true),
  durableNamespaceCount: z.literal(0),
  jobInventoryReadable: z.literal(true),
  pendingOperationCount: z.literal(0),
  capability: z.enum(["unsupported", "non_persistent"]),
  userChoice: TemporaryUserChoice,
}).strict();
export type TemporaryEligibilityV1 = z.infer<typeof TemporaryEligibilityV1>;

export const DeviceState = z.enum([
  "checking", "temporary_choice_required", "temporary", "needs_protection",
  "checkpointing", "protected_on_device", "locked_or_unknown",
]);
export type DeviceState = z.infer<typeof DeviceState>;
export const DurableStoreCapability = z.enum([
  "supported", "unsupported", "non_persistent", "unknown",
]);
export type DurableStoreCapability = z.infer<typeof DurableStoreCapability>;
export const ExpectedStoreFailure = z.enum([
  "restricted", "denied", "thrown", "locked", "corrupt", "quota", "attach", "unclassified",
]);
export type ExpectedStoreFailure = z.infer<typeof ExpectedStoreFailure>;
export type TemporaryUserChoice = z.infer<typeof TemporaryUserChoice>;
export const ProtectionReasonCode = z.enum([
  "catalog_unavailable", "inventory_unavailable", "transaction_uncertified",
  "store_unavailable", "expected_store_failure", "temporary_ineligible",
  "temporary_choice_required", "persistence_unconfirmed", "checkpoint_missing",
  "checkpoint_stale", "checkpoint_invalid", "generation_not_selected",
]);
export type ProtectionReasonCode = z.infer<typeof ProtectionReasonCode>;
const NeedsProtectionReason = z.enum([
  "persistence_unconfirmed", "checkpoint_missing",
  "checkpoint_stale", "checkpoint_invalid", "generation_not_selected",
]);
const LockedOrUnknownReason = z.enum([
  "catalog_unavailable", "inventory_unavailable", "store_unavailable",
  "expected_store_failure", "temporary_ineligible", "transaction_uncertified",
]);
export const DeviceStateResultV1 = z.discriminatedUnion("state", [
  z.object({ state: z.literal("checking"), reasonCode: z.null() }).strict(),
  z.object({
    state: z.literal("temporary_choice_required"),
    reasonCode: z.literal("temporary_choice_required"),
  }).strict(),
  z.object({ state: z.literal("temporary"), reasonCode: z.null() }).strict(),
  z.object({ state: z.literal("needs_protection"), reasonCode: NeedsProtectionReason }).strict(),
  z.object({ state: z.literal("checkpointing"), reasonCode: z.null() }).strict(),
  z.object({ state: z.literal("protected_on_device"), reasonCode: z.null() }).strict(),
  z.object({ state: z.literal("locked_or_unknown"), reasonCode: LockedOrUnknownReason }).strict(),
]);
export type DeviceStateResultV1 = z.infer<typeof DeviceStateResultV1>;

const InventoryCount = z.number().int().nonnegative().safe().nullable();
export const CheckpointObservationV1 = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none"), target: z.null() }).strict(),
  z.object({ state: z.literal("in_progress"), target: TargetIdentityV1 }).strict(),
  z.object({ state: z.literal("valid"), target: TargetIdentityV1 }).strict(),
  z.object({ state: z.literal("stale"), target: TargetIdentityV1.nullable() }).strict(),
  z.object({ state: z.literal("invalid"), target: TargetIdentityV1.nullable() }).strict(),
  z.object({ state: z.literal("generation_not_selected"), target: TargetIdentityV1.nullable() }).strict(),
]);
export type CheckpointObservationV1 = z.infer<typeof CheckpointObservationV1>;

export const DeviceProtectionInputV1 = z.object({
  checksComplete: z.boolean(),
  expectedStoreFailure: ExpectedStoreFailure.nullable(),
  catalogReadable: z.boolean(),
  catalogAppCount: InventoryCount,
  namespaceInventoryReadable: z.boolean(),
  durableNamespaceCount: InventoryCount,
  jobInventoryReadable: z.boolean(),
  pendingOperationCount: InventoryCount,
  capability: DurableStoreCapability,
  userChoice: TemporaryUserChoice,
  storeOpen: z.enum(["yes", "no", "unknown"]),
  transactionCertified: z.boolean(),
  persisted: z.enum(["yes", "no", "unknown"]),
  target: TargetIdentityV1.nullable(),
  checkpoint: CheckpointObservationV1,
}).strict().superRefine((value, ctx) => {
  const inventories = [
    ["catalog", value.catalogReadable, value.catalogAppCount],
    ["namespace", value.namespaceInventoryReadable, value.durableNamespaceCount],
    ["job", value.jobInventoryReadable, value.pendingOperationCount],
  ] as const;
  for (const [name, readable, count] of inventories) {
    if (readable !== (count !== null))
      ctx.addIssue({ code: "custom", message: `${name} readability/count mismatch` });
  }
  if (value.target !== null && value.catalogReadable && value.namespaceInventoryReadable
      && ((value.catalogAppCount ?? 0) < 1 || (value.durableNamespaceCount ?? 0) < 1))
    ctx.addIssue({ code: "custom", message: "selected target requires catalog app and namespace" });
  if (value.target === null && value.checkpoint.target !== null)
    ctx.addIssue({ code: "custom", message: "checkpoint target requires selected target" });
});
export type DeviceProtectionInputV1 = z.infer<typeof DeviceProtectionInputV1>;


export const ColumnSpec = z.object({
  name: Ident,
  label: z.string().min(1).max(60).optional(),
  type: ColumnType,
  required: z.boolean().default(false),
  values: z.array(z.string().max(40)).max(24).optional(),   // enum only
  expr: z.string().max(500).optional(),                     // computed only
  relation: RelationSpec.optional(),
  lookup: LookupSpec.optional(),
  rollup: RollupSpec.optional(),
  pk: z.boolean().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.type === "enum" && (c.values?.length ?? 0) === 0)
    ctx.addIssue({ code: "custom", message: "enum needs values" });
  if (c.type !== "enum" && c.values !== undefined)
    ctx.addIssue({ code: "custom", message: "values belong only to enum fields" });
  if (c.type === "computed" && !c.expr)
    ctx.addIssue({ code: "custom", message: "computed needs expr" });
  if (c.type !== "computed" && c.expr !== undefined)
    ctx.addIssue({ code: "custom", message: "expr belongs only to computed fields" });
  if ((c.type === "relation") !== (c.relation !== undefined))
    ctx.addIssue({ code: "custom", message: "relation metadata must match relation type" });
  if ((c.type === "lookup") !== (c.lookup !== undefined))
    ctx.addIssue({ code: "custom", message: "lookup metadata must match lookup type" });
  if ((c.type === "rollup") !== (c.rollup !== undefined))
    ctx.addIssue({ code: "custom", message: "rollup metadata must match rollup type" });
  if (c.rollup && c.rollup.operation !== "count" && !c.rollup.target_field)
    ctx.addIssue({ code: "custom", message: "non-count rollup needs target_field" });
  if ((c.type === "lookup" || c.type === "rollup" || c.type === "attachment") && c.required)
    ctx.addIssue({ code: "custom", message: `${c.type} fields cannot be required` });
});

// ---------- Query ----------
export const CondOp = z.enum([
  "eq","neq","gt","gte","lt","lte","contains","in",
  "is_null","not_null","within_days","older_than_days",
]);
export const Condition = z.object({
  field: Ident,
  op: CondOp,
  value: z.union([
    z.string(), z.number(), z.boolean(),
    z.array(z.union([z.string(), z.number()])).max(50),
    z.object({ $var: z.literal(true) }),   // runtime placeholder (V4)
  ]).optional(),
});
export const Query = z.object({
  from: Ident,
  select: z.array(Ident).max(30).optional(),
  where: z.array(Condition).max(10).optional(),
  orWhere: z.array(z.array(Condition).max(6)).max(4).optional(),
  orderBy: z.array(z.object({ field: Ident,
    dir: z.enum(["asc","desc"]) })).max(3).optional(),
  groupBy: z.array(Ident).max(2).optional(),
  aggregate: z.array(z.object({
    fn: z.enum(["count","sum","avg","min","max"]),
    field: Ident, as: Ident })).max(5).optional(),
  limit: z.number().int().positive().max(5000).optional(),
  includeDeleted: z.boolean().optional(),
});
export type Query = z.infer<typeof Query>;

// ---------- Migration ----------
export const ForwardOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create_table"), table: Ident,
             columns: z.array(ColumnSpec).min(1).max(20) }),
  z.object({ op: z.literal("add_column"), table: Ident, column: ColumnSpec }),
  z.object({ op: z.literal("rename_column"), table: Ident,
             from: Ident, to: Ident }),
  z.object({ op: z.literal("add_enum_value"), table: Ident,
             column: Ident, value: z.string().max(40) }),
  z.object({ op: z.literal("add_index"), table: Ident, column: Ident }),
  z.object({ op: z.literal("backfill"), table: Ident, column: Ident,
             value: JsonScalar.optional(),
             expr: z.string().max(500).optional() }),
  z.object({ op: z.literal("create_computed"), table: Ident,
             column: Ident, expr: z.string().max(500) }),
  z.object({ op: z.literal("update_computed"), table: Ident,
             column: Ident, expr: z.string().max(500) }),
  z.object({ op: z.literal("hide_column"), table: Ident, column: Ident }),
  z.object({ op: z.literal("set_required"), table: Ident, column: Ident,
             required: z.boolean(),
             default_for_existing: JsonScalar.optional() }),
]);
export const InverseOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("drop_table_if_created_by_this"), table: Ident }),
  z.object({ op: z.literal("drop_column_if_added_by_this"),
             table: Ident, column: Ident }),
  z.object({ op: z.literal("remove_enum_value_if_unused"),
             table: Ident, column: Ident, value: z.string() }),
  z.object({ op: z.literal("unhide_column"), table: Ident, column: Ident }),
  z.object({ op: z.literal("drop_index"), table: Ident, column: Ident }),
  z.object({ op: z.literal("restore_expr"), table: Ident, column: Ident,
             expr: z.string() }),
  z.object({ op: z.literal("unset_required"), table: Ident, column: Ident }),
  z.object({ op: z.literal("rename_column"), table: Ident,
             from: Ident, to: Ident }),
]);
export const MigrationPlan = z.object({
  operations: z.array(ForwardOp).min(1).max(12),
  inverse: z.array(InverseOp).min(1).max(12),
}).superRefine((m, ctx) => {
  if (new Set(m.operations.map(o => o.table)).size > 3)
    ctx.addIssue({ code: "custom", message: "I5: <=3 tables per plan" });
  for (const op of m.operations)
    if (op.op === "backfill" && (op.value === undefined) === (op.expr === undefined))
      ctx.addIssue({ code: "custom",
        message: "G23: backfill takes exactly one of value|expr" });
});

// ---------- MutationPlan ----------
export const DiffKind = z.enum([
  "add_field","change_field","add_panel","change_panel","remove_panel",
  "add_status","add_computed","add_chart","add_relation","add_automation",
  "add_attachment",
]);
export const PanelArtifact = z.object({
  panel_id: PanelId,
  title: z.string().min(1).max(60),
  placement: z.object({ region: z.enum(["top","main","side"]),
                        order: z.number().int().min(0).max(50),
                        w: z.number().int().min(1).max(4).optional(),   // cols out of 4 (ADR-018)
                        h: z.number().int().min(80).max(2000).optional(),   // pixel height (ADR-018)
                        col: z.number().int().min(0).max(3).optional() }),   // start column (ADR-019)
  code: z.string().max(65_536),
  declared_queries: z.array(Query).max(8),
  declared_writes: z.array(Ident).max(4).default([]),   // G22 / ADR-014
});
export const MutationPlan = z.object({
  api: z.literal(1),
  summary: z.string().max(200),      // non-empty unless clarifying (G18)
  user_facing_diff: z.array(z.object({ kind: DiffKind,
    detail: z.string().max(120) })).max(12),
  clarifying_question: z.string().max(200).nullable(),
  assumptions: z.array(z.string().max(150)).max(5),
  migration: MigrationPlan.nullable(),
  panels: z.array(PanelArtifact).max(8),
  remove_panels: z.array(PanelId).max(8),
  confidence: z.number().min(0).max(1),
}).superRefine((p, ctx) => {
  const hasPlan = !!p.migration || p.panels.length > 0 || p.remove_panels.length > 0;
  if (p.clarifying_question && hasPlan)
    ctx.addIssue({ code: "custom", message: "R1: question XOR plan" });
  if (!p.clarifying_question && !hasPlan)
    ctx.addIssue({ code: "custom", message: "empty plan" });
  if (!p.clarifying_question && p.confidence < 0.5)
    ctx.addIssue({ code: "custom", message: "R5: low confidence must clarify" });
  if (!p.clarifying_question && p.summary.trim().length === 0)
    ctx.addIssue({ code: "custom", message: "G18: summary required unless clarifying" });
});
export type MutationPlan = z.infer<typeof MutationPlan>;

// ---------- Bridge protocol ----------
export const BridgeCall = z.object({
  v: z.literal(1),
  panel: PanelId,
  seq: z.number().int().nonnegative(),
  // compute.* is in-iframe and sync (G20); events.off added per G26.
  call: z.enum(["db.query","db.watch","db.unwatch","db.insert","db.update",
    "db.softDelete","ui.toast","ui.confirm","ui.openRecord","events.emit","events.on",
    "events.off"]),
  args: z.array(JsonValue).max(4),         // per-call schemas applied next
});
/** Trusted panel-runtime signal emitted immediately before it invokes a
 * panel-authored callback from a rendered control. Generated modules never
 * receive the MessagePort and cannot mint this signal directly. */
export const BridgeUserGesture = z.object({
  v: z.literal(1),
  kind: z.literal("user_gesture"),
});
export const BridgeOpenRecord = z.object({
  v: z.literal(1),
  kind: z.literal("open_record"),
  table: Ident,
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
});

export const BridgeReply = z.object({
  v: z.literal(1), seq: z.number().int(),
  ok: z.boolean(),
  result: JsonValue.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
/** Panel -> Kernel upstream error signal (ADR-015): fire-and-forget, no
 * seq/reply. Feeds the error boundary (doc 05 §7); never trusted beyond
 * display + repair-prompt input. */
export const BridgePanelError = z.object({
  v: z.literal(1),
  kind: z.literal("panel_error"),
  code: z.string().max(40),
  message: z.string().max(500),
});

export const BridgePush = z.discriminatedUnion("kind", [
  z.object({ v: z.literal(1), kind: z.literal("watch"),
             watchId: z.string(), rows: z.array(z.record(JsonValue)) }),
  z.object({ v: z.literal(1), kind: z.literal("event"),
             name: Ident, payload: JsonValue }),
  z.object({ v: z.literal(1), kind: z.literal("boot"),
             code: z.string(), panelId: PanelId, apiVersion: z.literal(1),
             meta: z.object({                       // backs clay.meta (G21)
               schema: JsonValue,                   // registry snapshot
               appVersion: z.number().int().nonnegative(),
               placement: z.object({ region: z.enum(["top","main","side"]),
                                     order: z.number().int(),
                                     w: z.number().int().min(1).max(4).optional(),
                                     h: z.number().int().min(80).max(2000).optional(),
                                     col: z.number().int().min(0).max(3).optional() }),
             }),
             tokens: z.record(z.string()) }),       // design tokens (G21)
]);
