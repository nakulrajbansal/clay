import {z} from "./validation-runtime";
export const VIEW_ID = /^view_[0-9a-f]{32}$/;
export const FIELD_NAME = /^[a-z][a-z0-9_]{0,40}$/;
export const TABLE_ID = /^tbl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FIELD_ID = /^fld_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FILTER_OPS = [
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null",
  "not_null", "within_days", "older_than_days",
] as const;
export const OperationalCondition = z.object({
  field: z.string().regex(FIELD_NAME),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
}).strict().superRefine((value, context) => {
  const hasValue = Object.prototype.hasOwnProperty.call(value, "value");
  if (value.op === "is_null" || value.op === "not_null") {
    if (hasValue) context.addIssue({ code: "custom", message: "null filters have no value" });
    return;
  }
  const valid = value.op === "in"
    ? Array.isArray(value.value) && value.value.length <= 50
      && value.value.every(item => typeof item === "string" || typeof item === "number")
    : value.op === "within_days" || value.op === "older_than_days"
      ? typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0
      : value.op === "contains" ? typeof value.value === "string"
        : typeof value.value === "string" || typeof value.value === "number"
          || typeof value.value === "boolean";
  if (!hasValue || !valid) context.addIssue({ code: "custom", message: "invalid filter value" });
});
export const OperationalView = z.object({
  id: z.string().regex(VIEW_ID),
  name: z.string().min(1).max(80),
  table: z.string().regex(FIELD_NAME),
  search: z.string().max(120),
  filters: z.array(OperationalCondition).max(8),
  orderBy: z.array(z.object({
    field: z.string().regex(FIELD_NAME), dir: z.enum(["asc", "desc"]),
  }).strict()).max(4),
  visibleFields: z.array(z.string().regex(FIELD_NAME)).max(64),
  identity: z.object({
    tableId: z.string().regex(TABLE_ID),
    filterFieldIds: z.array(z.string().regex(FIELD_ID)).max(8),
    orderFieldIds: z.array(z.string().regex(FIELD_ID)).max(4),
    visibleFieldIds: z.array(z.string().regex(FIELD_ID)).max(64),
  }).strict().optional(),
  createdAt: z.string().max(64).refine(value => Number.isFinite(Date.parse(value))),
  updatedAt: z.string().max(64).refine(value => Number.isFinite(Date.parse(value))),
}).strict().superRefine((value, context) => {
  if (value.identity && (value.identity.filterFieldIds.length !== value.filters.length
      || value.identity.orderFieldIds.length !== value.orderBy.length
      || value.identity.visibleFieldIds.length !== value.visibleFields.length)) {
    context.addIssue({ code: "custom", message: "saved view semantic bindings are incomplete" });
  }
});
export const OperationalViewLibrary = z.object({
  format: z.literal(1), revision: z.number().int().nonnegative().safe(),
  views: z.array(OperationalView).max(50),
}).strict().superRefine((value, context) => {
  if (new Set(value.views.map(view => view.id)).size !== value.views.length)
    context.addIssue({ code: "custom", path: ["views"], message: "saved view ids must be unique" });
});
