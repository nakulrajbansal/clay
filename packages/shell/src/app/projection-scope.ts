import type {
  Query, RegColumn, RegTable, SemanticSchemaTraceV1,
} from "@clay/kernel";
import type { ProjectionRequestV1 } from "@clay/kernel/projection";

export type LocalProjectionScopeV1 = Readonly<{
  request: ProjectionRequestV1;
  fieldChoices: readonly Readonly<{
    fieldId: ProjectionRequestV1["fieldIds"][number];
    label: string;
  }>[];
}>;

type Filter = NonNullable<Query["where"]>[number];
type Sort = NonNullable<Query["orderBy"]>[number];

function fieldLabel(column: RegColumn): string {
  return column.label ?? column.name.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());
}

function stableTable(
  trace: SemanticSchemaTraceV1,
  table: RegTable,
): SemanticSchemaTraceV1["tables"][number] {
  const matches = trace.tables.filter(candidate => candidate.name === table.name
    && candidate.state === "visible");
  if (matches.length !== 1)
    throw new Error(`Stable table identity for “${table.name}” is not ready. Reopen Data and try again.`);
  return matches[0]!;
}

function stableField(
  trace: SemanticSchemaTraceV1,
  tableId: SemanticSchemaTraceV1["tables"][number]["tableId"],
  name: string,
): SemanticSchemaTraceV1["fields"][number] {
  const matches = trace.fields.filter(candidate => candidate.tableId === tableId
    && candidate.fieldName === name && candidate.state === "visible");
  if (matches.length !== 1)
    throw new Error(`Stable field identity for “${name}” is not ready. Reopen Data and try again.`);
  return matches[0]!;
}

function exportedColumns(columns: readonly RegColumn[]): RegColumn[] {
  const visible = columns.filter(column => !column.hidden && !column.inactive);
  const unsupported = visible.find(column => column.type === "json");
  if (unsupported)
    throw new Error(`Field “${fieldLabel(unsupported)}” uses an unsupported JSON type. Hide it before export.`);
  const output = visible.filter(column => column.type !== "attachment");
  if (output.length === 0)
    throw new Error("No exportable fields are visible. Attachment fields are always excluded.");
  if (output.length > 30)
    throw new Error("This export has more than 30 visible fields. Hide fields before export.");
  return output;
}

function identity(
  trace: SemanticSchemaTraceV1,
  table: RegTable,
  columns: readonly RegColumn[],
): {
  tableId: SemanticSchemaTraceV1["tables"][number]["tableId"];
  fieldIds: ProjectionRequestV1["fieldIds"];
  fieldChoices: LocalProjectionScopeV1["fieldChoices"];
} {
  const tableEntry = stableTable(trace, table);
  const output = exportedColumns(columns);
  const fields = output.map(column => ({ column, semantic: stableField(
    trace, tableEntry.tableId, column.name,
  ) }));
  return {
    tableId: tableEntry.tableId,
    fieldIds: fields.map(field => field.semantic.fieldId),
    fieldChoices: fields.map(field => ({
      fieldId: field.semantic.fieldId, label: fieldLabel(field.column),
    })),
  };
}

function filterRequest(
  trace: SemanticSchemaTraceV1,
  tableId: SemanticSchemaTraceV1["tables"][number]["tableId"],
  filter: Filter | null,
): Extract<ProjectionRequestV1, { kind: "current_view" }>["view"]["filter"] {
  if (!filter) return null;
  if (typeof filter.value === "object" && filter.value !== null && !Array.isArray(filter.value))
    throw new Error("Runtime filter placeholders cannot be exported.");
  const fieldId = stableField(trace, tableId, filter.field).fieldId;
  return {
    fieldId,
    op: filter.op,
    ...(filter.value !== undefined ? { value: filter.value } : {}),
  } as Extract<ProjectionRequestV1, { kind: "current_view" }>["view"]["filter"];
}

export function localDateAnchorV1(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export function buildCurrentViewProjectionScopeV1(input: Readonly<{
  trace: SemanticSchemaTraceV1;
  table: RegTable;
  columns: readonly RegColumn[];
  search: string;
  filter: Filter | null;
  sort: Sort | null;
  dateAnchor?: string;
}>): LocalProjectionScopeV1 {
  if (input.search.length > 512)
    throw new Error("Search text is longer than the 512-character export limit.");
  const resolved = identity(input.trace, input.table, input.columns);
  const filter = filterRequest(input.trace, resolved.tableId, input.filter);
  const sort = input.sort ? {
    fieldId: stableField(input.trace, resolved.tableId, input.sort.field).fieldId,
    dir: input.sort.dir,
  } : null;
  return {
    request: {
      schema: 1,
      kind: "current_view",
      expectedSchemaVersion: input.trace.atVersion,
      tableId: resolved.tableId,
      fieldIds: resolved.fieldIds,
      view: {
        search: input.search,
        filter,
        sort,
        dateAnchor: input.dateAnchor ?? localDateAnchorV1(),
      },
      options: { includeRecordIds: false, redactedFieldIds: [] },
    },
    fieldChoices: resolved.fieldChoices,
  };
}

export function buildRecordProjectionScopeV1(input: Readonly<{
  trace: SemanticSchemaTraceV1;
  table: RegTable;
  recordId: string;
}>): LocalProjectionScopeV1 {
  const resolved = identity(input.trace, input.table, input.table.columns);
  return {
    request: {
      schema: 1,
      kind: "record",
      expectedSchemaVersion: input.trace.atVersion,
      tableId: resolved.tableId,
      fieldIds: resolved.fieldIds,
      recordId: input.recordId,
      options: { includeRecordIds: false, redactedFieldIds: [] },
    },
    fieldChoices: resolved.fieldChoices,
  };
}
