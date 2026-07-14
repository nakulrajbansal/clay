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
]);

// JSON without `any` (G26). Scalars for values the migration ops carry.
export type Json =
  | string | number | boolean | null | Json[] | { [key: string]: Json };
export const JsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(),
           z.array(JsonValue), z.record(JsonValue)]));
export const JsonScalar = z.union([z.string(), z.number(), z.boolean()]);

export const ColumnSpec = z.object({
  name: Ident,
  type: ColumnType,
  required: z.boolean().default(false),
  values: z.array(z.string().max(40)).max(24).optional(),   // enum only
  expr: z.string().max(500).optional(),                     // computed only
  pk: z.boolean().optional(),
}).refine(c => c.type !== "enum" || (c.values?.length ?? 0) > 0,
  { message: "enum needs values" })
 .refine(c => c.type !== "computed" || !!c.expr,
  { message: "computed needs expr" });

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
  "add_status","add_computed","add_chart",
]);
export const PanelArtifact = z.object({
  panel_id: PanelId,
  title: z.string().min(1).max(60),
  placement: z.object({ region: z.enum(["top","main","side"]),
                        order: z.number().int().min(0).max(50),
                        w: z.number().int().min(1).max(4).optional(),   // cols out of 4 (ADR-018)
                        h: z.number().int().min(80).max(2000).optional() }),   // pixel height (ADR-018)
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
    "db.softDelete","ui.toast","ui.confirm","events.emit","events.on",
    "events.off"]),
  args: z.array(JsonValue).max(4),         // per-call schemas applied next
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
                                     h: z.number().int().min(80).max(2000).optional() }),
             }),
             tokens: z.record(z.string()) }),       // design tokens (G21)
]);
