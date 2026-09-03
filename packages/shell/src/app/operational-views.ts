import type { Query, RegTable, SemanticSchemaTraceV1 } from "@clay/kernel";

export const OPERATIONAL_VIEWS_KEY = "operational_views_v1";
const VIEW_ID = /^view_[0-9a-f]{32}$/;
const FIELD = /^[a-z][a-z0-9_]{0,40}$/;
const TABLE_ID = /^tbl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELD_ID = /^fld_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null",
  "not_null", "within_days", "older_than_days",
]);

type Condition = NonNullable<Query["where"]>[number];
type Order = NonNullable<Query["orderBy"]>[number];

export type OperationalView = {
  id: string;
  name: string;
  table: string;
  search: string;
  filters: Condition[];
  orderBy: Order[];
  visibleFields: string[];
  identity?: {
    tableId: string;
    filterFieldIds: string[];
    orderFieldIds: string[];
    visibleFieldIds: string[];
  };
  createdAt: string;
  updatedAt: string;
};

export type OperationalViewLibrary = {
  format: 1;
  revision: number;
  views: OperationalView[];
};

const empty = (): OperationalViewLibrary => ({ format: 1, revision: 0, views: [] });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));

function validCondition(value: unknown): value is Condition {
  if (!object(value) || typeof value.field !== "string" || !FIELD.test(value.field)
      || typeof value.op !== "string" || !OPS.has(value.op)
      || !onlyKeys(value, ["field", "op", "value"])) return false;
  const hasValue = "value" in value;
  if (value.op === "is_null" || value.op === "not_null") return !hasValue;
  if (!hasValue) return false;
  if (value.op === "in") return Array.isArray(value.value) && value.value.length <= 50
    && value.value.every(item => typeof item === "string" || typeof item === "number");
  if (value.op === "within_days" || value.op === "older_than_days")
    return typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0;
  if (value.op === "contains") return typeof value.value === "string";
  return typeof value.value === "string" || typeof value.value === "number"
    || typeof value.value === "boolean";
}

function validView(value: unknown): value is OperationalView {
  if (!object(value) || !onlyKeys(value, ["id", "name", "table", "search", "filters",
    "orderBy", "visibleFields", "identity", "createdAt", "updatedAt"])
      || typeof value.id !== "string" || !VIEW_ID.test(value.id)
      || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 80
      || typeof value.table !== "string" || !FIELD.test(value.table)
      || typeof value.search !== "string" || value.search.length > 120
      || !Array.isArray(value.filters) || value.filters.length > 8
      || !value.filters.every(validCondition)
      || !Array.isArray(value.orderBy) || value.orderBy.length > 4
      || !value.orderBy.every(order => object(order) && typeof order.field === "string"
        && FIELD.test(order.field) && (order.dir === "asc" || order.dir === "desc"))
      || !Array.isArray(value.visibleFields) || value.visibleFields.length > 64
      || !value.visibleFields.every(field => typeof field === "string" && FIELD.test(field))
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  if (value.identity !== undefined) {
    if (!object(value.identity) || typeof value.identity.tableId !== "string"
        || !TABLE_ID.test(value.identity.tableId)
        || !Array.isArray(value.identity.filterFieldIds)
        || value.identity.filterFieldIds.length !== value.filters.length
        || !value.identity.filterFieldIds.every(id => typeof id === "string" && FIELD_ID.test(id))
        || !Array.isArray(value.identity.orderFieldIds)
        || value.identity.orderFieldIds.length !== value.orderBy.length
        || !value.identity.orderFieldIds.every(id => typeof id === "string" && FIELD_ID.test(id))
        || !Array.isArray(value.identity.visibleFieldIds)
        || value.identity.visibleFieldIds.length !== value.visibleFields.length
        || !value.identity.visibleFieldIds.every(id => typeof id === "string" && FIELD_ID.test(id)))
      return false;
  }
  return true;
}

export function loadOperationalViews(raw: unknown): OperationalViewLibrary {
  if (!object(raw) || raw.format !== 1 || !Number.isInteger(raw.revision)
      || Number(raw.revision) < 0 || !Array.isArray(raw.views) || raw.views.length > 50
      || !raw.views.every(validView)) return empty();
  return {
    format: 1, revision: Number(raw.revision),
    views: raw.views.map(view => ({
      ...view, filters: view.filters.map(condition => ({ ...condition })),
      orderBy: view.orderBy.map(order => ({ ...order })),
      visibleFields: [...view.visibleFields],
      identity: view.identity ? {
        tableId: view.identity.tableId,
        filterFieldIds: [...view.identity.filterFieldIds],
        orderFieldIds: [...view.identity.orderFieldIds],
        visibleFieldIds: [...view.identity.visibleFieldIds],
      } : undefined,
    })),
  };
}

export function createOperationalView(
  input: Pick<OperationalView, "name" | "table" | "search" | "filters" | "orderBy" | "visibleFields" | "identity">,
  now: () => string = () => new Date().toISOString(),
  id: () => string = () => crypto.randomUUID(),
): OperationalView {
  const timestamp = now();
  const candidate: OperationalView = {
    ...input,
    id: `view_${id().replaceAll("-", "").toLowerCase()}`,
    name: input.name.trim(), createdAt: timestamp, updatedAt: timestamp,
    filters: input.filters.map(condition => ({ ...condition })),
    orderBy: input.orderBy.map(order => ({ ...order })),
    visibleFields: [...new Set(input.visibleFields)],
    identity: input.identity ? {
      tableId: input.identity.tableId,
      filterFieldIds: [...input.identity.filterFieldIds],
      orderFieldIds: [...input.identity.orderFieldIds],
      visibleFieldIds: [...input.identity.visibleFieldIds],
    } : undefined,
  };
  if (!validView(candidate))
    throw new Error("View names must be 1 to 80 characters and view settings must be bounded");
  return candidate;
}

export function reconcileOperationalViews(
  library: OperationalViewLibrary,
  tables: RegTable[],
  renames: Record<string, Record<string, string>> = {},
  trace?: SemanticSchemaTraceV1,
): OperationalViewLibrary {
  const byName = new Map(tables.map(table => [table.name, table]));
  const semanticTables = new Map<string, SemanticSchemaTraceV1["tables"][number]>(
    trace?.tables.map(table => [table.tableId as string, table]) ?? []);
  const semanticFields = new Map<string, SemanticSchemaTraceV1["fields"][number]>(
    trace?.fields.map(field => [field.fieldId as string, field]) ?? []);
  const views = library.views.flatMap(view => {
    const semanticTable = view.identity ? semanticTables.get(view.identity.tableId) : undefined;
    const tableName = semanticTable?.state === "visible" ? semanticTable.name : view.table;
    const table = byName.get(tableName);
    if (!table) return [];
    const fields = new Set(table.columns.filter(column => !column.inactive && !column.hidden)
      .map(column => column.name));
    const map = (field: string, fieldId?: string): string => {
      const semantic = fieldId ? semanticFields.get(fieldId) : undefined;
      if (semantic && semantic.tableId === semanticTable?.tableId && semantic.state === "visible")
        return semantic.fieldName;
      return renames[view.table]?.[field] ?? field;
    };
    const filters = view.filters.map((condition, index) => ({ ...condition,
      field: map(condition.field, view.identity?.filterFieldIds[index]) }))
      .filter(condition => fields.has(condition.field));
    const orderBy = view.orderBy.map((order, index) => ({ ...order,
      field: map(order.field, view.identity?.orderFieldIds[index]) }))
      .filter(order => fields.has(order.field));
    const visibleFields = view.visibleFields.map((field, index) =>
      map(field, view.identity?.visibleFieldIds[index])).filter(field => fields.has(field));
    return [{ ...view, table: table.name, filters, orderBy, visibleFields }];
  });
  return { ...library, views };
}

type ViewStorage = {
  getSetting<T>(key: string): Promise<T | null>;
  compareAndSetSetting<T>(
    key: string, expectedRevision: number, value: T,
  ): Promise<{ ok: boolean; current: unknown }>;
};

export async function saveOperationalView(
  storage: ViewStorage,
  view: OperationalView,
): Promise<OperationalViewLibrary> {
  if (!validView(view)) throw new Error("Cannot save an invalid operational view");
  let current = loadOperationalViews(await storage.getSetting(OPERATIONAL_VIEWS_KEY));
  for (let attempt = 0; attempt < 2; attempt++) {
    const next: OperationalViewLibrary = {
      format: 1, revision: current.revision + 1,
      views: [...current.views.filter(candidate => candidate.id !== view.id), view].slice(-50),
    };
    const result = await storage.compareAndSetSetting(
      OPERATIONAL_VIEWS_KEY, current.revision, next);
    if (result.ok) return next;
    current = loadOperationalViews(result.current);
  }
  throw new Error("Saved views changed in another tab. Try again.");
}

export async function deleteOperationalView(
  storage: ViewStorage,
  id: string,
): Promise<OperationalViewLibrary> {
  let current = loadOperationalViews(await storage.getSetting(OPERATIONAL_VIEWS_KEY));
  for (let attempt = 0; attempt < 2; attempt++) {
    const next: OperationalViewLibrary = {
      format: 1, revision: current.revision + 1,
      views: current.views.filter(view => view.id !== id),
    };
    const result = await storage.compareAndSetSetting(
      OPERATIONAL_VIEWS_KEY, current.revision, next);
    if (result.ok) return next;
    current = loadOperationalViews(result.current);
  }
  throw new Error("Saved views changed in another tab. Try again.");
}
