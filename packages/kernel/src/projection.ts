import {
  ProjectionPlaintextV1 as ProjectionPlaintextSchema,
  ProjectionRequestV1 as ProjectionRequestSchema,
  type ProjectionManifestV1,
  type ProjectionPlaintextV1,
  type ProjectionRequestV1,
} from "@clay/schema/projection";
import type { Query } from "@clay/schema";
import { ClayError } from "./errors";
import type { QueryByteBudget, QueryRow, QueryValue, RecordLink } from "./query";
import type { RegColumn, RegTable, Registry } from "./registry";
import type { SemanticSchemaTraceV1 } from "./semantic";

export type { ProjectionManifestV1, ProjectionPlaintextV1, ProjectionRequestV1 };

export const PROJECTION_LIMITS_V1 = Object.freeze({
  rows: 5_000,
  fields: 30,
  plaintextBytes: 8 * 1024 * 1024,
  sourceRows: 20_000,
} as const);

const PROJECTION_SOURCE_BYTES_V1 = 32 * 1024 * 1024;
const PROJECTION_SOURCE_ROW_BYTES_V1 = 8 * 1024 * 1024;

export const PROJECTION_RENDERER_V1 = Object.freeze({
  id: "clay-semantic-table",
  version: 1,
} as const);

export type ProjectionArtifactV1 = Readonly<{
  projection: ProjectionPlaintextV1;
  plaintext: Uint8Array;
  csv: Uint8Array;
}>;

/** The narrow read-only Store surface accepted by the one projection API. */
export type ProjectionReadableStoreV1 = Readonly<{
  queryBounded(query: Query, budget: QueryByteBudget): QueryRow[];
  registrySnapshot(): Registry;
  semanticSchemaTrace(): SemanticSchemaTraceV1;
}>;

export type ProjectionCooperativeOptionsV1 = Readonly<{
  isCancelled?: () => boolean;
  yieldControl?: () => Promise<void>;
}>;

export type ProjectionNamedViewV1 = Readonly<{
  search: string;
  filter: Readonly<{
    field: string;
    op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in"
      | "is_null" | "not_null" | "within_days" | "older_than_days";
    value?: string | number | boolean | (string | number)[];
  }> | null;
  sort: Readonly<{ field: string; dir: "asc" | "desc" }> | null;
  dateAnchor: string;
}>;

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const CSV_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function invalid(message: string, detail?: unknown): ClayError {
  return new ClayError("E_VALIDATION", message, detail);
}

function limit(message: string): ClayError {
  return new ClayError("E_LIMIT", message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** RFC 8785-style canonical JSON for the closed, I-JSON projection schema. */
export function canonicalProjectionJsonV1(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("non-finite projection number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map(item => canonicalProjectionJsonV1(item)).join(",")}]`;
  if (!isPlainRecord(value)) throw invalid("non-canonical projection value");
  return `{${Object.keys(value).sort().map(key => {
    const child = value[key];
    if (child === undefined) throw invalid("undefined projection value");
    return `${JSON.stringify(key)}:${canonicalProjectionJsonV1(child)}`;
  }).join(",")}}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false;
  return true;
}

function freezeJson<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  return Object.freeze(value);
}

export function encodeProjectionPlaintextV1(value: ProjectionPlaintextV1): Uint8Array {
  const parsed = ProjectionPlaintextSchema.safeParse(value);
  if (!parsed.success) throw invalid("invalid projection", parsed.error.issues);
  const bytes = textEncoder.encode(canonicalProjectionJsonV1(parsed.data));
  if (bytes.byteLength > PROJECTION_LIMITS_V1.plaintextBytes)
    throw limit("8 MiB plaintext limit exceeded; narrow the view.");
  return bytes;
}

export function decodeProjectionPlaintextV1(bytes: Uint8Array): ProjectionPlaintextV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > PROJECTION_LIMITS_V1.plaintextBytes)
    throw invalid("Projection bytes are missing or over 8 MiB");
  let unknown: unknown;
  try { unknown = JSON.parse(utf8Decoder.decode(bytes)); }
  catch (error) { throw invalid("Projection is not valid UTF-8 JSON", error); }
  const parsed = ProjectionPlaintextSchema.safeParse(unknown);
  if (!parsed.success) throw invalid("invalid projection", parsed.error.issues);
  const canonical = textEncoder.encode(canonicalProjectionJsonV1(parsed.data));
  if (!equalBytes(bytes, canonical))
    throw invalid("Projection bytes are not canonical");
  return freezeJson(parsed.data);
}

export function projectionCsvTextV1(text: string): string {
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function csvCell(text: string): string {
  const safe = projectionCsvTextV1(text);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function encodeCsv(fields: ProjectionManifestV1["fields"], rows: readonly (readonly string[])[]): {
  bytes: Uint8Array; formulaNeutralizedCells: number;
} {
  let formulaNeutralizedCells = 0;
  const encodeCell = (text: string): string => {
    if (projectionCsvTextV1(text) !== text) formulaNeutralizedCells++;
    return csvCell(text);
  };
  const lines = [
    fields.map(field => encodeCell(field.label)).join(","),
    ...rows.map(row => row.map(encodeCell).join(",")),
  ];
  const body = textEncoder.encode(`${lines.join("\r\n")}\r\n`);
  const bytes = new Uint8Array(CSV_BOM.byteLength + body.byteLength);
  bytes.set(CSV_BOM); bytes.set(body, CSV_BOM.byteLength);
  if (bytes.byteLength > PROJECTION_LIMITS_V1.plaintextBytes)
    throw limit("8 MiB local export limit exceeded; narrow the view.");
  return { bytes, formulaNeutralizedCells };
}

export function encodeProjectionCsvV1(
  input: Uint8Array | ProjectionPlaintextV1,
): Uint8Array {
  const plaintext = input instanceof Uint8Array ? decodeProjectionPlaintextV1(input)
    : ProjectionPlaintextSchema.parse(input);
  return encodeCsv(plaintext.manifest.fields, plaintext.rows).bytes;
}

function uint8View(value: unknown): Uint8Array | null {
  if (Object.prototype.toString.call(value) !== "[object Uint8Array]") return null;
  const view = value as { buffer?: unknown; byteOffset?: unknown; byteLength?: unknown };
  if (Object.prototype.toString.call(view.buffer) !== "[object ArrayBuffer]"
      || typeof view.byteOffset !== "number" || typeof view.byteLength !== "number") return null;
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}

/** Parse a transported artifact and prove that its CSV is exactly the
 * deterministic encoding declared by its canonical plaintext manifest. */
export function decodeProjectionArtifactV1(
  artifact: ProjectionArtifactV1,
): ProjectionPlaintextV1 {
  const plaintextBytes = artifact && typeof artifact === "object"
    ? uint8View(artifact.plaintext) : null;
  const csvBytes = artifact && typeof artifact === "object"
    ? uint8View(artifact.csv) : null;
  if (!plaintextBytes || !csvBytes)
    throw invalid("Projection bytes are missing");
  const plaintext = decodeProjectionPlaintextV1(plaintextBytes);
  if (!artifact.projection
      || !equalBytes(encodeProjectionPlaintextV1(artifact.projection), plaintextBytes))
    throw invalid("Projection preview does not match canonical bytes");
  const csv = encodeCsv(plaintext.manifest.fields, plaintext.rows);
  if (!equalBytes(csv.bytes, csvBytes))
    throw invalid("CSV bytes do not match canonical projection");
  if (plaintext.manifest.csv.byteCount !== csvBytes.byteLength
      || plaintext.manifest.csv.formulaNeutralizedCells !== csv.formulaNeutralizedCells)
    throw invalid("CSV manifest does not match bytes");
  return plaintext;
}

function isRecordLink(value: unknown): value is RecordLink {
  return isPlainRecord(value) && typeof value.id === "string"
    && typeof value.label === "string" && typeof value.table === "string";
}

/** Exact display text shared by Data view membership and projection rendering. */
export function projectionDisplayTextV1(value: QueryValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (isRecordLink(value)) return value.label;
  if (Array.isArray(value)) return value.map(item => projectionDisplayTextV1(item)).join(", ");
  if (typeof value === "object") return canonicalProjectionJsonV1(value);
  if (typeof value === "number" && !Number.isFinite(value))
    throw invalid("non-finite projection number");
  return String(value);
}

function naturalParts(value: string): string[] {
  return value.match(/\d+|\D+/g) ?? [""];
}

/** Locale-independent natural ordering; equal values retain canonical row-id order. */
export function compareProjectionTextV1(left: string, right: string): number {
  if (left === right) return 0;
  const a = naturalParts(left);
  const b = naturalParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const av = a[index]; const bv = b[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    if (/^\d+$/.test(av) && /^\d+$/.test(bv)) {
      const at = av.replace(/^0+(?=\d)/, "");
      const bt = bv.replace(/^0+(?=\d)/, "");
      if (at.length !== bt.length) return at.length < bt.length ? -1 : 1;
      if (at !== bt) return at < bt ? -1 : 1;
      if (av.length !== bv.length) return av.length < bv.length ? -1 : 1;
    } else return av < bv ? -1 : 1;
  }
  return left < right ? -1 : 1;
}

function matchesViewFilter(row: QueryRow, filter: NonNullable<ProjectionNamedViewV1["filter"]>,
  dateAnchor: string): boolean {
  const value = row[filter.field];
  const text = projectionDisplayTextV1(value);
  const target = filter.value;
  switch (filter.op) {
    case "is_null": return value === null || value === undefined;
    case "not_null": return value !== null && value !== undefined;
    case "contains": return text.toLowerCase().includes(String(target ?? "").toLowerCase());
    case "eq": return text === String(target ?? "");
    case "neq": return text !== String(target ?? "");
    case "in": return Array.isArray(target) && target.some(item => text === String(item));
    case "gt": return compareProjectionTextV1(text, String(target ?? "")) > 0;
    case "gte": return compareProjectionTextV1(text, String(target ?? "")) >= 0;
    case "lt": return compareProjectionTextV1(text, String(target ?? "")) < 0;
    case "lte": return compareProjectionTextV1(text, String(target ?? "")) <= 0;
    case "within_days": return text.slice(0, 10) === dateAnchor;
    case "older_than_days": return text !== "" && text.slice(0, 10) < dateAnchor;
  }
}

export function applyProjectionViewV1(
  rows: readonly QueryRow[], searchableFields: readonly string[], view: ProjectionNamedViewV1,
): QueryRow[] {
  const needle = view.search.trim().toLowerCase();
  let result = needle === "" ? [...rows] : rows.filter(row => searchableFields.some(field =>
    projectionDisplayTextV1(row[field]).toLowerCase().includes(needle)));
  if (view.filter)
    result = result.filter(row => matchesViewFilter(row, view.filter!, view.dateAnchor));
  if (view.sort) {
    const order = view.sort;
    result.sort((left, right) => compareProjectionTextV1(
      projectionDisplayTextV1(left[order.field]), projectionDisplayTextV1(right[order.field]),
    ) * (order.dir === "asc" ? 1 : -1));
  }
  return result;
}

function fieldLabel(column: RegColumn): string {
  return column.label ?? column.name.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());
}

function tableLabel(table: RegTable): string {
  return table.name.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());
}

function resolveTable(
  registry: Registry, trace: SemanticSchemaTraceV1, tableId: string,
): RegTable {
  const identity = trace.tables.find(candidate => candidate.tableId === tableId
    && candidate.state === "visible");
  const table = identity ? registry.get(identity.name) : null;
  if (!table || table.inactive)
    throw invalid("The export table identity is stale or no longer available.");
  return table;
}

function resolveField(
  trace: SemanticSchemaTraceV1, tableId: string, table: RegTable,
  fieldId: string, purpose: string,
): RegColumn {
  const identity = trace.fields.find(candidate => candidate.tableId === tableId
    && candidate.fieldId === fieldId && candidate.state === "visible");
  const column = identity
    ? table.columns.find(candidate => candidate.name === identity.fieldName) : null;
  if (!column || column.inactive || column.hidden)
    throw invalid(`The ${purpose} field identity is stale, hidden, or no longer available.`);
  return column;
}

function dependencyField(
  registry: Registry,
  trace: SemanticSchemaTraceV1,
  fieldId: string,
): { field: string; label: string; table: string } {
  const identity = trace.fields.find(candidate => candidate.fieldId === fieldId);
  const table = identity ? registry.get(identity.tableName) : null;
  const column = table && identity
    ? table.columns.find(candidate => candidate.name === identity.fieldName) : null;
  if (!identity || identity.state !== "visible" || !table || table.inactive
      || !column || column.hidden || column.inactive || column.type === "attachment")
    throw invalid("A projected output has a hidden, inactive, or missing dependency.");
  return { field: column.name, label: fieldLabel(column), table: table.name };
}

function computedDependency(
  registry: Registry,
  trace: SemanticSchemaTraceV1,
  outputFieldId: string,
  output: RegColumn,
): ProjectionManifestV1["dependencies"][number] {
  const fields = trace.relationships
    .filter(relationship => relationship.kind === "derived_from"
      && relationship.state === "active" && relationship.from === outputFieldId)
    .map(relationship => dependencyField(registry, trace, String(relationship.to)))
    .sort((left, right) => left.table < right.table ? -1 : left.table > right.table ? 1
      : left.field < right.field ? -1 : left.field > right.field ? 1 : 0);
  return { fields, kind: "computed", output: output.name };
}

function relationDependency(
  registry: Registry,
  trace: SemanticSchemaTraceV1,
  tableId: string,
  outputFieldId: string,
  output: RegColumn,
): ProjectionManifestV1["dependencies"][number] {
  const references = trace.relationships.filter(relationship =>
    relationship.kind === "references" && relationship.state === "active"
    && relationship.from === tableId && relationship.via === outputFieldId);
  if (references.length !== 1)
    throw invalid(`Relation “${fieldLabel(output)}” does not have one active trusted dependency.`);
  const targetIdentity = trace.tables.find(candidate =>
    candidate.tableId === references[0]!.to && candidate.state === "visible");
  const target = targetIdentity ? registry.get(targetIdentity.name) : null;
  if (!output.relation || !target || target.inactive
      || target.name !== output.relation.target_table)
    throw invalid(`Relation “${fieldLabel(output)}” has a stale target dependency.`);
  const display = output.relation.display_field
    ? target.columns.find(candidate => candidate.name === output.relation!.display_field)
    : target.columns.find(candidate => !candidate.hidden && !candidate.inactive
      && (candidate.type === "text" || candidate.type === "rich_text"
        || candidate.type === "enum"));
  if (!display || display.hidden || display.inactive
      || !["text", "rich_text", "enum"].includes(display.type))
    throw invalid(`Relation “${fieldLabel(output)}” has no visible friendly-label dependency.`);
  const displayIdentity = trace.fields.find(candidate => candidate.tableId === targetIdentity!.tableId
    && candidate.fieldName === display.name && candidate.state === "visible");
  if (!displayIdentity)
    throw invalid(`Relation “${fieldLabel(output)}” has a stale friendly-label dependency.`);
  return {
    fields: [dependencyField(registry, trace, displayIdentity.fieldId)],
    kind: "relation",
    output: output.name,
  };
}

function outputDependencies(
  registry: Registry,
  trace: SemanticSchemaTraceV1,
  tableId: string,
  columns: readonly RegColumn[],
  fieldIds: readonly string[],
): ProjectionManifestV1["dependencies"] {
  return columns.flatMap((column, index) => {
    if (column.type === "lookup" || column.type === "rollup")
      throw invalid(`Field “${fieldLabel(column)}” has dependency semantics that local export v1 cannot prove.`);
    if (column.type === "computed")
      return [computedDependency(registry, trace, fieldIds[index]!, column)];
    if (column.type === "relation")
      return [relationDependency(registry, trace, tableId, fieldIds[index]!, column)];
    return [];
  });
}

function uniqueNames(columns: readonly RegColumn[]): string[] {
  const names: string[] = [];
  for (const column of columns) if (!names.includes(column.name)) names.push(column.name);
  return names;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function pageRows(
  source: ProjectionReadableStoreV1, table: RegTable, names: readonly string[],
  where: { field: "id"; op: "gt" | "eq"; value: string } | null, limitValue: number,
  budget: QueryByteBudget,
): QueryRow[] {
  const groups = chunks(names, 29);
  const projectedGroups = groups.length > 0 ? groups : [[]];
  let merged: QueryRow[] | null = null;
  for (const group of projectedGroups) {
    const page = source.queryBounded({
      from: table.name,
      select: ["id", ...group],
      ...(where ? { where: [where] } : {}),
      orderBy: [{ field: "id", dir: "asc" }],
      limit: limitValue,
    }, budget);
    if (!merged) { merged = page.map(row => ({ ...row })); continue; }
    if (page.length !== merged.length
        || page.some((row, index) => row.id !== merged![index]!.id))
      throw new ClayError("E_INTERNAL", "projection query pages did not align");
    page.forEach((row, index) => Object.assign(merged![index]!, row));
  }
  return merged ?? [];
}

function sourceBudget(): QueryByteBudget {
  return {
    remainingBytes: PROJECTION_SOURCE_BYTES_V1,
    maxRowBytes: PROJECTION_SOURCE_ROW_BYTES_V1,
    limitLabel: "This export exceeds the 32 MiB source-input limit; narrow the Data view.",
  };
}

function addMatchingPage(
  matches: QueryRow[], page: readonly QueryRow[], searchableFields: readonly string[],
  view: ProjectionNamedViewV1,
): void {
  matches.push(...applyProjectionViewV1(page, searchableFields, { ...view, sort: null }));
  if (matches.length > PROJECTION_LIMITS_V1.rows)
    throw limit("This export has more than 5,000 matching rows; narrow the Data view.");
}

function sortMatchingRows(rows: QueryRow[], view: ProjectionNamedViewV1): QueryRow[] {
  if (!view.sort) return rows;
  return applyProjectionViewV1(rows, [], {
    search: "", filter: null, sort: view.sort, dateAnchor: view.dateAnchor,
  });
}

function loadCurrentRows(
  source: ProjectionReadableStoreV1, table: RegTable, names: readonly string[],
  searchableFields: readonly string[], view: ProjectionNamedViewV1, budget: QueryByteBudget,
): QueryRow[] {
  const matches: QueryRow[] = [];
  let sourceRows = 0;
  let cursor: string | null = null;
  for (;;) {
    const remainingWithSentinel = PROJECTION_LIMITS_V1.sourceRows + 1 - sourceRows;
    const requestLimit = Math.min(500, remainingWithSentinel);
    const page = pageRows(source, table, names,
      cursor ? { field: "id", op: "gt", value: cursor } : null, requestLimit, budget);
    sourceRows += page.length;
    if (sourceRows > PROJECTION_LIMITS_V1.sourceRows)
      throw limit("This Data view has more than 20,000 source rows; Clay cannot prove completeness. Narrow Data before export.");
    addMatchingPage(matches, page, searchableFields, view);
    if (page.length < requestLimit) return sortMatchingRows(matches, view);
    cursor = String(page.at(-1)!.id);
  }
}

function cancelled(options: ProjectionCooperativeOptionsV1): void {
  if (options.isCancelled?.())
    throw new ClayError("E_CANCELLED", "The local export projection was cancelled.");
}

async function loadCurrentRowsCooperative(
  source: ProjectionReadableStoreV1, table: RegTable, names: readonly string[],
  searchableFields: readonly string[], view: ProjectionNamedViewV1, budget: QueryByteBudget,
  options: ProjectionCooperativeOptionsV1,
): Promise<QueryRow[]> {
  const matches: QueryRow[] = [];
  let sourceRows = 0;
  let cursor: string | null = null;
  const yieldControl = options.yieldControl
    ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  for (;;) {
    cancelled(options);
    const remainingWithSentinel = PROJECTION_LIMITS_V1.sourceRows + 1 - sourceRows;
    const requestLimit = Math.min(500, remainingWithSentinel);
    const page = pageRows(source, table, names,
      cursor ? { field: "id", op: "gt", value: cursor } : null, requestLimit, budget);
    sourceRows += page.length;
    if (sourceRows > PROJECTION_LIMITS_V1.sourceRows)
      throw limit("This Data view has more than 20,000 source rows; Clay cannot prove completeness. Narrow Data before export.");
    addMatchingPage(matches, page, searchableFields, view);
    if (page.length < requestLimit) return sortMatchingRows(matches, view);
    cursor = String(page.at(-1)!.id);
    await yieldControl();
    cancelled(options);
  }
}

function relationIds(value: QueryValue | undefined): string[] {
  if (isRecordLink(value)) return [value.id];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordLink).map(link => link.id);
}

function makeOutputFields(columns: readonly RegColumn[], includeRecordIds: boolean,
  redactedNames: ReadonlySet<string>): ProjectionManifestV1["fields"] {
  const fields: ProjectionManifestV1["fields"] = [];
  if (includeRecordIds) fields.push({
    label: "_clay_record_id", name: "_clay_record_id", redacted: false,
    source: "record_id", type: "text",
  });
  for (const column of columns) {
    fields.push({
      label: fieldLabel(column), name: column.name, redacted: redactedNames.has(column.name),
      source: "field", type: column.type as ProjectionManifestV1["fields"][number]["type"],
    });
    if (includeRecordIds && column.type === "relation") fields.push({
      label: `${fieldLabel(column)} Clay record IDs`,
      name: `${column.name}_clay_record_id`, redacted: false,
      source: "relation_id", type: "text",
    });
  }
  if (fields.length > PROJECTION_LIMITS_V1.fields)
    throw limit("The export has more than 30 output fields; hide fields or turn off Clay record IDs.");
  if (new Set(fields.map(field => field.name)).size !== fields.length)
    throw invalid("Clay record ID columns conflict with an existing field name.");
  return fields;
}

function outputRows(rows: readonly QueryRow[], columns: readonly RegColumn[],
  includeRecordIds: boolean, redactedNames: ReadonlySet<string>): string[][] {
  return rows.map(row => {
    const values: string[] = [];
    if (includeRecordIds) values.push(String(row.id));
    for (const column of columns) {
      values.push(redactedNames.has(column.name)
        ? "[redacted]" : projectionDisplayTextV1(row[column.name]));
      if (includeRecordIds && column.type === "relation")
        values.push(relationIds(row[column.name]).join(", "));
    }
    return values;
  });
}

type PreparedProjectionV1 = Readonly<{
  request: ProjectionRequestV1;
  schemaVersion: number;
  table: RegTable;
  columns: RegColumn[];
  dependencies: ProjectionManifestV1["dependencies"];
  redactedNames: Set<string>;
  materializedNames: string[];
  filterColumn: RegColumn | null;
  sortColumn: RegColumn | null;
  namedView: ProjectionNamedViewV1 | null;
  view: ProjectionManifestV1["view"];
}>;

function prepareProjection(
  source: ProjectionReadableStoreV1, input: ProjectionRequestV1,
): PreparedProjectionV1 {
  const parsed = ProjectionRequestSchema.safeParse(input);
  if (!parsed.success) throw invalid("The export request is malformed.", parsed.error.issues);
  const request = parsed.data;
  const trace = source.semanticSchemaTrace();
  const schemaVersion = trace.atVersion;
  if (request.expectedSchemaVersion !== schemaVersion)
    throw invalid("The Data schema changed after this export scope was opened. Reopen the preview.");
  const registry = source.registrySnapshot();
  const table = resolveTable(registry, trace, request.tableId);
  const columns = request.fieldIds.map(fieldId =>
    resolveField(trace, request.tableId, table, fieldId, "output"));
  for (const column of columns) {
    if (column.type === "attachment")
      throw invalid(`Attachment field “${fieldLabel(column)}” is excluded from local exports.`);
    if (column.type === "json")
      throw invalid(`Field “${fieldLabel(column)}” uses an unsupported JSON type.`);
  }
  const dependencies = outputDependencies(
    registry, trace, request.tableId, columns, request.fieldIds,
  );
  const selectedIds = new Set<string>(request.fieldIds);
  const redactedIds = new Set(request.options.redactedFieldIds);
  for (const fieldId of redactedIds)
    if (!selectedIds.has(fieldId)) throw invalid("A redaction refers to a field outside this export.");

  let filterColumn: RegColumn | null = null;
  let sortColumn: RegColumn | null = null;
  if (request.kind === "current_view") {
    filterColumn = request.view.filter
      ? resolveField(trace, request.tableId, table, request.view.filter.fieldId, "filter") : null;
    sortColumn = request.view.sort
      ? resolveField(trace, request.tableId, table, request.view.sort.fieldId, "sort") : null;
  }
  for (const [column, purpose] of [
    [filterColumn, "filter"], [sortColumn, "sort"],
  ] as const) {
    if (column?.type === "attachment")
      throw invalid(`Attachment ${purpose} field “${fieldLabel(column)}” is excluded from local exports.`);
    if (column?.type === "json")
      throw invalid(`The ${purpose} field “${fieldLabel(column)}” uses an unsupported JSON type.`);
  }
  const redactedNames = new Set(request.options.redactedFieldIds.map(fieldId =>
    resolveField(trace, request.tableId, table, fieldId, "redaction").name));
  const materializedNames = uniqueNames([
    ...columns, ...(filterColumn ? [filterColumn] : []), ...(sortColumn ? [sortColumn] : []),
  ]);
  let namedView: ProjectionNamedViewV1 | null = null;
  let view: ProjectionManifestV1["view"] = null;
  if (request.kind === "current_view") {
    namedView = {
      search: request.view.search,
      filter: request.view.filter && filterColumn ? {
        field: filterColumn.name, op: request.view.filter.op,
        ...(request.view.filter.value !== undefined ? { value: request.view.filter.value } : {}),
      } : null,
      sort: request.view.sort && sortColumn
        ? { field: sortColumn.name, dir: request.view.sort.dir } : null,
      dateAnchor: request.view.dateAnchor,
    };
    view = {
      dateAnchor: namedView.dateAnchor,
      filter: namedView.filter && filterColumn ? {
        field: filterColumn.name, label: fieldLabel(filterColumn), op: namedView.filter.op,
        ...(namedView.filter.value !== undefined ? { value: namedView.filter.value } : {}),
      } : null,
      search: namedView.search,
      sort: namedView.sort && sortColumn ? {
        dir: namedView.sort.dir, field: sortColumn.name, label: fieldLabel(sortColumn),
      } : null,
    };
  }
  return {
    request, schemaVersion, table, columns, dependencies, redactedNames, materializedNames,
    filterColumn, sortColumn, namedView, view,
  };
}

function finishProjection(
  prepared: PreparedProjectionV1, canonicalRows: QueryRow[],
): ProjectionArtifactV1 {
  const {
    request, schemaVersion, table, columns, dependencies, redactedNames, view,
  } = prepared;
  if (canonicalRows.length > PROJECTION_LIMITS_V1.rows)
    throw limit("This export has more than 5,000 matching rows; narrow the Data view.");

  const fields = makeOutputFields(columns, request.options.includeRecordIds, redactedNames);
  const rows = outputRows(canonicalRows, columns, request.options.includeRecordIds, redactedNames);
  const csv = encodeCsv(fields, rows);
  const plaintext: ProjectionPlaintextV1 = {
    manifest: {
      completeness: { reason: null, truncated: false },
      csv: { byteCount: csv.bytes.byteLength,
        formulaNeutralizedCells: csv.formulaNeutralizedCells },
      dependencies,
      fieldCount: fields.length,
      fields,
      kind: request.kind,
      limits: PROJECTION_LIMITS_V1,
      policies: {
        attachments: "excluded", blankValues: "empty_string",
        csvFormula: "prefix_apostrophe", dates: "stored_value_no_timezone_conversion",
        hiddenFields: "excluded", inactiveFields: "excluded",
        recordIds: request.options.includeRecordIds ? "included" : "excluded",
        relations: request.options.includeRecordIds
          ? "friendly_labels_with_record_ids" : "friendly_labels",
        unselectedFields: "excluded",
      },
      redactions: columns.filter(column => redactedNames.has(column.name))
        .map(fieldLabel),
      renderer: PROJECTION_RENDERER_V1,
      rowCount: rows.length,
      schema: "ProjectionManifestV1",
      schemaVersion,
      table: table.name,
      title: `${tableLabel(table)} — ${request.kind === "record" ? "record" : "current Data view"}`,
      view,
    },
    rows,
    schema: "ProjectionPlaintextV1",
  };
  const projection = freezeJson(ProjectionPlaintextSchema.parse(plaintext));
  const plaintextBytes = encodeProjectionPlaintextV1(projection);
  return Object.freeze({ projection, plaintext: plaintextBytes, csv: csv.bytes });
}

function recordRows(
  source: ProjectionReadableStoreV1, prepared: PreparedProjectionV1,
  budget: QueryByteBudget,
): QueryRow[] {
  if (prepared.request.kind !== "record")
    throw new ClayError("E_INTERNAL", "record projection helper received a current view");
  const rows = pageRows(source, prepared.table, prepared.materializedNames,
    { field: "id", op: "eq", value: prepared.request.recordId }, 2, budget);
  if (rows.length !== 1)
    throw invalid("The record is missing, deleted, or no longer available for export.");
  return rows;
}

export function projectPlaintextV1(
  source: ProjectionReadableStoreV1, input: ProjectionRequestV1,
): ProjectionArtifactV1 {
  const prepared = prepareProjection(source, input);
  const budget = sourceBudget();
  const rows = prepared.request.kind === "record"
    ? recordRows(source, prepared, budget)
    : loadCurrentRows(
      source, prepared.table, prepared.materializedNames,
      prepared.columns.map(column => column.name), prepared.namedView!, budget,
    );
  return finishProjection(prepared, rows);
}

/** Worker path: identical bytes with bounded page yields for real cancellation. */
export async function projectPlaintextV1Cooperative(
  source: ProjectionReadableStoreV1,
  input: ProjectionRequestV1,
  options: ProjectionCooperativeOptionsV1 = {},
): Promise<ProjectionArtifactV1> {
  cancelled(options);
  const prepared = prepareProjection(source, input);
  const budget = sourceBudget();
  const rows = prepared.request.kind === "record"
    ? recordRows(source, prepared, budget)
    : await loadCurrentRowsCooperative(
      source, prepared.table, prepared.materializedNames,
      prepared.columns.map(column => column.name), prepared.namedView!, budget, options,
    );
  cancelled(options);
  return finishProjection(prepared, rows);
}
