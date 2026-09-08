// Closed schemas for the trusted finite Release F projection boundary.
import { z } from "zod";

const ProjectionIdent = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const ProjectionCondOp = z.enum([
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in",
  "is_null", "not_null", "within_days", "older_than_days",
]);

// ---------- trusted finite projection v1 (Release F / F-GATE-010) ----------
const ProjectionTableId = z.string().regex(
  /^tbl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const ProjectionFieldId = z.string().regex(
  /^fld_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const ProjectionRecordId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
const ProjectionFilterValueV1 = z.union([
  z.string(), z.number().finite(), z.boolean(),
  z.array(z.union([z.string(), z.number().finite()])).max(50),
]);
const ProjectionFilterRequestV1 = z.object({
  fieldId: ProjectionFieldId,
  op: ProjectionCondOp,
  value: ProjectionFilterValueV1.optional(),
}).strict().superRefine((filter, ctx) => {
  const valueFree = filter.op === "is_null" || filter.op === "not_null";
  if (valueFree === (filter.value !== undefined)) ctx.addIssue({
    code: "custom",
    message: valueFree ? `${filter.op} does not take a value` : `${filter.op} requires a value`,
  });
});
const ProjectionRequestBaseV1 = {
  schema: z.literal(1),
  expectedSchemaVersion: z.number().int().nonnegative(),
  tableId: ProjectionTableId,
  fieldIds: z.array(ProjectionFieldId).min(1).max(30),
  options: z.object({
    includeRecordIds: z.boolean(),
    redactedFieldIds: z.array(ProjectionFieldId).max(30),
  }).strict(),
};
const ProjectionCurrentViewRequestV1 = z.object({
  ...ProjectionRequestBaseV1,
  kind: z.literal("current_view"),
  view: z.object({
    search: z.string().max(512),
    filter: ProjectionFilterRequestV1.nullable(),
    sort: z.object({ fieldId: ProjectionFieldId, dir: z.enum(["asc", "desc"]) })
      .strict().nullable(),
    dateAnchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(),
}).strict();
const ProjectionRecordRequestV1 = z.object({
  ...ProjectionRequestBaseV1,
  kind: z.literal("record"),
  recordId: ProjectionRecordId,
}).strict();
export const ProjectionRequestV1 = z.discriminatedUnion("kind", [
  ProjectionCurrentViewRequestV1, ProjectionRecordRequestV1,
]).superRefine((request, ctx) => {
  if (new Set(request.fieldIds).size !== request.fieldIds.length)
    ctx.addIssue({ code: "custom", message: "projection field ids must be unique" });
  if (new Set(request.options.redactedFieldIds).size !== request.options.redactedFieldIds.length)
    ctx.addIssue({ code: "custom", message: "redacted field ids must be unique" });
});
export type ProjectionRequestV1 = z.infer<typeof ProjectionRequestV1>;

export const ProjectionOutputFieldV1 = z.object({
  label: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  redacted: z.boolean(),
  source: z.enum(["field", "record_id", "relation_id"]),
  type: z.enum([
    "text", "number", "integer", "boolean", "date", "enum", "computed",
    "relation", "rich_text",
  ]),
}).strict();
const ProjectionManifestFilterV1 = z.object({
  field: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  op: ProjectionCondOp,
  value: ProjectionFilterValueV1.optional(),
}).strict();
const ProjectionManifestViewV1 = z.object({
  dateAnchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  filter: ProjectionManifestFilterV1.nullable(),
  search: z.string().max(512),
  sort: z.object({
    dir: z.enum(["asc", "desc"]),
    field: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
  }).strict().nullable(),
}).strict();
const ProjectionDependencyV1 = z.object({
  fields: z.array(z.object({
    field: ProjectionIdent,
    label: z.string().min(1).max(200),
    table: ProjectionIdent,
  }).strict()).max(30),
  kind: z.enum(["computed", "relation"]),
  output: ProjectionIdent,
}).strict().superRefine((dependency, ctx) => {
  if (dependency.kind === "relation" && dependency.fields.length !== 1) ctx.addIssue({
    code: "custom", path: ["fields"], message: "relation output needs one display dependency",
  });
});
export const ProjectionManifestV1 = z.object({
  completeness: z.object({ reason: z.null(), truncated: z.literal(false) }).strict(),
  csv: z.object({
    byteCount: z.number().int().nonnegative().max(8 * 1024 * 1024),
    formulaNeutralizedCells: z.number().int().nonnegative(),
  }).strict(),
  dependencies: z.array(ProjectionDependencyV1).max(30),
  fieldCount: z.number().int().min(1).max(30),
  fields: z.array(ProjectionOutputFieldV1).min(1).max(30),
  kind: z.enum(["record", "current_view"]),
  limits: z.object({
    fields: z.literal(30), plaintextBytes: z.literal(8 * 1024 * 1024),
    rows: z.literal(5000), sourceRows: z.literal(20000),
  }).strict(),
  policies: z.object({
    attachments: z.literal("excluded"),
    blankValues: z.literal("empty_string"),
    csvFormula: z.literal("prefix_apostrophe"),
    dates: z.literal("stored_value_no_timezone_conversion"),
    hiddenFields: z.literal("excluded"),
    inactiveFields: z.literal("excluded"),
    recordIds: z.enum(["excluded", "included"]),
    relations: z.enum(["friendly_labels", "friendly_labels_with_record_ids"]),
    unselectedFields: z.literal("excluded"),
  }).strict(),
  redactions: z.array(z.string().min(1).max(200)).max(30),
  renderer: z.object({
    id: z.literal("clay-semantic-table"), version: z.literal(1),
  }).strict(),
  rowCount: z.number().int().nonnegative().max(5000),
  schema: z.literal("ProjectionManifestV1"),
  schemaVersion: z.number().int().nonnegative(),
  table: ProjectionIdent,
  title: z.string().min(1).max(200),
  view: ProjectionManifestViewV1.nullable(),
}).strict().superRefine((manifest, ctx) => {
  if ((manifest.kind === "current_view") !== (manifest.view !== null)) ctx.addIssue({
    code: "custom", path: ["view"], message: "projection kind and view must agree",
  });
  const outputs = new Map<string, typeof manifest.dependencies[number]>();
  manifest.dependencies.forEach((dependency, index) => {
    if (outputs.has(dependency.output)) ctx.addIssue({
      code: "custom", path: ["dependencies", index], message: "duplicate output dependency",
    });
    outputs.set(dependency.output, dependency);
  });
  for (const field of manifest.fields) {
    const expected = field.source === "field"
      && (field.type === "relation" || field.type === "computed") ? field.type : null;
    const dependency = outputs.get(field.name);
    if (expected !== (dependency?.kind ?? null)) ctx.addIssue({
      code: "custom", path: ["dependencies"],
      message: `dependency entry does not match output ${field.name}`,
    });
    outputs.delete(field.name);
  }
  if (outputs.size > 0) ctx.addIssue({
    code: "custom", path: ["dependencies"], message: "dependency refers to a missing output",
  });
});
export type ProjectionManifestV1 = z.infer<typeof ProjectionManifestV1>;
export const ProjectionPlaintextV1 = z.object({
  manifest: ProjectionManifestV1,
  rows: z.array(z.array(z.string()).max(30)).max(5000),
  schema: z.literal("ProjectionPlaintextV1"),
}).strict().superRefine((plaintext, ctx) => {
  if (plaintext.manifest.rowCount !== plaintext.rows.length)
    ctx.addIssue({ code: "custom", message: "projection row count does not match rows" });
  if (plaintext.manifest.fieldCount !== plaintext.manifest.fields.length)
    ctx.addIssue({ code: "custom", message: "projection field count does not match fields" });
  plaintext.rows.forEach((row, index) => {
    if (row.length !== plaintext.manifest.fieldCount) ctx.addIssue({
      code: "custom", path: ["rows", index], message: "projection row width does not match fields",
    });
  });
});
export type ProjectionPlaintextV1 = z.infer<typeof ProjectionPlaintextV1>;
