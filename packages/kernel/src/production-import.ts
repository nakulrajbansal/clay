import {
  TABLE_IMPORT_PREFIX,
  targetAuthorityInvalid as invalid,
} from "./production-input-capture";
import {
  captureStrictJson,
  type StrictJson,
  type StrictJsonCapturePolicy,
} from "./strict-json-capture";
import { deriveInverse, type MigrationPlanT } from "./migrate";
import { ClayStore, type PanelBlobInput } from "./store";

type ImportValue = null | boolean | number | string;
type ImportRow = Readonly<Record<string, ImportValue>>;

type ImportColumn = Readonly<{
  name: string;
  type: "text" | "number" | "date" | "enum";
  values?: readonly string[];
}>;

export type CapturedTableImport = Readonly<{
  table: string;
  columns: readonly ImportColumn[];
  rows: readonly ImportRow[];
}>;

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_COLUMNS = 20;
const MAX_ROWS = 5_000;
const MAX_ENUM_VALUES = 100;
const MAX_VALUE_LENGTH = 1_000_000;
const IMPORT_CAPTURE_POLICY: StrictJsonCapturePolicy = [
  8, 500_000, MAX_VALUE_LENGTH, 2_000_000, MAX_ROWS, 128, 128, true, true,
  reason => {
    if (reason === 10 || reason === 12)
      throw invalid(TABLE_IMPORT_PREFIX + "fields must use plain data properties");
    throw invalid(reason === 1
      ? TABLE_IMPORT_PREFIX + "exceeds aggregate capture limits"
      : TABLE_IMPORT_PREFIX + "payload is invalid");
  },
];

function dataValue(input: object, key: PropertyKey): unknown {
  return (input as Record<PropertyKey, unknown>)[key];
}

function plainRecord(input: unknown, what: string): Record<string, StrictJson> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw invalid(`${TABLE_IMPORT_PREFIX}${what} must be a plain record`);
  return input as Record<string, StrictJson>;
}

function denseArray(input: unknown, what: string, maximum: number): readonly StrictJson[] {
  if (!Array.isArray(input) || input.length > maximum)
    throw invalid(`${TABLE_IMPORT_PREFIX}${what} is malformed or exceeds its limit`);
  return input;
}

function exactKeys(record: object, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Reflect.ownKeys(record);
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  if (keys.length < required.length || keys.length > required.length + optional.length
      || keys.some(key => !allowed.has(key)))
    throw invalid(TABLE_IMPORT_PREFIX + "record has unknown or missing fields");
  for (let index = 0; index < required.length; index++) {
    if (!keys.includes(required[index]!))
      throw invalid(TABLE_IMPORT_PREFIX + "record has unknown or missing fields");
  }
}

function identifier(input: unknown, what: string): string {
  if (typeof input !== "string" || !SAFE_IDENTIFIER.test(input))
    throw invalid(`${TABLE_IMPORT_PREFIX}${what} is invalid`);
  return input;
}

function boundedString(input: unknown, what: string): string {
  if (typeof input !== "string" || input.length > MAX_VALUE_LENGTH)
    throw invalid(`${TABLE_IMPORT_PREFIX}${what} is invalid`);
  return input;
}

function captureColumn(input: unknown): ImportColumn {
  const record = plainRecord(input, "column");
  exactKeys(record, ["name", "type"], ["values"]);
  const name = identifier(dataValue(record, "name"), "column name");
  const type = dataValue(record, "type");
  if (type !== "text" && type !== "number" && type !== "date" && type !== "enum")
    throw invalid(TABLE_IMPORT_PREFIX + "column type is invalid");
  const rawValues = dataValue(record, "values");
  let values: readonly string[] | undefined;
  if (rawValues !== undefined) {
    const source = denseArray(rawValues, "enum values", MAX_ENUM_VALUES);
    if (source.length < 1) throw invalid(TABLE_IMPORT_PREFIX + "enum values are invalid");
    const copy = source.map(value => boundedString(value, "enum value"));
    if (new Set(copy).size !== copy.length)
      throw invalid(TABLE_IMPORT_PREFIX + "enum values must be unique");
    values = Object.freeze(copy);
  }
  if ((type === "enum") !== (values !== undefined))
    throw invalid(TABLE_IMPORT_PREFIX + "enum values are invalid");
  return Object.freeze({ name, type, ...(values === undefined ? {} : { values }) });
}

function captureCell(input: unknown, column: ImportColumn): ImportValue {
  if (input === null) return null;
  if (column.type === "number") {
    if (typeof input !== "number" || !Number.isFinite(input))
      throw invalid(`table import value for '${column.name}' is invalid`);
    return input;
  }
  if (typeof input !== "string" && !(column.type === "text" && typeof input === "boolean"))
    throw invalid(`table import value for '${column.name}' is invalid`);
  if (typeof input === "boolean") return input;
  const value = boundedString(input, `value for '${column.name}'`);
  if (column.type === "enum" && !column.values?.includes(value))
    throw invalid(`table import value for '${column.name}' is outside its enum`);
  return value;
}

/** Capture imported typed rows without invoking accessors or caller-owned iteration. */
export function captureTableImport(input: unknown): CapturedTableImport {
  const record = plainRecord(captureStrictJson(input, IMPORT_CAPTURE_POLICY), "payload");
  exactKeys(record, ["table", "columns", "rows"]);
  const table = identifier(dataValue(record, "table"), "table name");
  const columnSource = denseArray(dataValue(record, "columns"), "columns", MAX_COLUMNS);
  if (columnSource.length < 1) throw invalid(TABLE_IMPORT_PREFIX + "needs at least one column");
  const columns = columnSource.map(captureColumn);
  if (new Set(columns.map(column => column.name)).size !== columns.length)
    throw invalid(TABLE_IMPORT_PREFIX + "column names must be unique");
  const byName = new Map(columns.map(column => [column.name, column] as const));

  const rowSource = denseArray(dataValue(record, "rows"), "rows", MAX_ROWS);
  if (rowSource.length < 1) throw invalid(TABLE_IMPORT_PREFIX + "needs at least one row");
  const rows = rowSource.map(candidate => {
    const source = plainRecord(candidate, "row");
    const keys = Object.keys(source);
    if (keys.length > columns.length || keys.some(key => !byName.has(key)))
      throw invalid(TABLE_IMPORT_PREFIX + "row references an unknown column");
    const row: Record<string, ImportValue> = Object.create(null) as Record<string, ImportValue>;
    for (const key of keys) row[key] = captureCell(source[key], byName.get(key)!);
    return Object.freeze(row);
  });
  return Object.freeze({
    table,
    columns: Object.freeze(columns),
    rows: Object.freeze(rows),
  });
}

function allocateTableName(store: ClayStore, requested: string): string {
  const registry = STORE_VALIDATION_REGISTRY.call(store);
  if (!registry.has(requested)) return requested;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const tail = `_${suffix}`;
    const candidate = `${requested.slice(0, 40 - tail.length)}${tail}`;
    if (!registry.has(candidate)) return candidate;
  }
  throw invalid(TABLE_IMPORT_PREFIX + "cannot allocate a unique table name");
}

function allocatePanelId(store: ClayStore, requested: string): string {
  const used = new Set<string>();
  const panels = STORE_LIVE_PANELS.call(store);
  for (let index = 0; index < panels.length; index++) used.add(panels[index]!.panel_id);
  if (!used.has(requested)) return requested;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const tail = `_${suffix}`;
    const candidate = `${requested.slice(0, 41 - tail.length)}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
  throw invalid(TABLE_IMPORT_PREFIX + "cannot allocate a unique panel identity");
}

function panelCode(table: string, columns: readonly ImportColumn[]): string {
  const definitions: string[] = [];
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index]!;
    const format = column.type === "number" ? ', format: "number"'
      : column.type === "date" ? ', format: "date"' : "";
    definitions.push(
      `{ field: ${JSON.stringify(column.name)}, label: ${JSON.stringify(column.name)}${format} }`,
    );
  }
  return `export default function (clay) {
  clay.db.watch({ from: ${JSON.stringify(table)}, limit: 500 }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No rows yet" })
      : h(Table, { sortable: true, rows, columns: [${definitions.join(", ")}] }));
  });
}`;
}

const STORE_COMMIT: ClayStore["commit"] = ClayStore.prototype.commit;
const STORE_INSERT: ClayStore["insert"] = ClayStore.prototype.insert;
const STORE_REGISTRY: ClayStore["registrySnapshot"] = ClayStore.prototype.registrySnapshot;
const STORE_VALIDATION_REGISTRY: ClayStore["validationRegistrySnapshot"] =
  ClayStore.prototype.validationRegistrySnapshot;
const STORE_LIVE_PANELS: ClayStore["livePanels"] = ClayStore.prototype.livePanels;
const STORE_GET_SETTING: ClayStore["getSetting"] = ClayStore.prototype.getSetting;
const STORE_SET_SETTING: ClayStore["setSetting"] = ClayStore.prototype.setSetting;
const DERIVE_INVERSE: typeof deriveInverse = deriveInverse;

/** Execute only on a disposable stage or inside the coordinator's physical transaction. */
export function executeCapturedTableImport(
  store: ClayStore,
  input: CapturedTableImport,
): Readonly<{ table: string; imported: number; columns: number }> {
  const table = allocateTableName(store, input.table);
  const operations: MigrationPlanT["operations"] = [{
    op: "create_table",
    table,
    columns: input.columns.map(column => ({
      name: column.name,
      type: column.type,
      required: false,
      ...(column.values === undefined ? {} : { values: [...column.values] }),
    })),
  }];
  const panelId = allocatePanelId(
    store, `${table}_view`.slice(0, 41).replace(/^[^a-z]/, "t"),
  );
  const panel: PanelBlobInput = {
    panel_id: panelId,
    title: table,
    placement: { region: "main", order: 0, w: 4 },
    code: panelCode(table, input.columns),
    declared_queries: [{ from: table, limit: 500 }],
    declared_writes: [],
  };
  STORE_COMMIT.call(store, {
    intent: `Import data (${table})`,
    summary: `Imported ${input.rows.length} row${input.rows.length === 1 ? "" : "s"} into ${table}.`,
    semanticOrigin: "direct",
    migration: {
      operations,
      inverse: DERIVE_INVERSE(operations, STORE_REGISTRY.call(store)),
    },
    panels: [panel],
    diff: [
      { kind: "add_table", detail: `${table} (${input.columns.length} columns)` },
      { kind: "add_panel", detail: panelId },
    ],
  });
  for (let index = 0; index < input.rows.length; index++)
    STORE_INSERT.call(store, table, input.rows[index] as Record<string, unknown>);
  // Activation survives bounded table Undo; this is part of the same physical
  // import transaction and never changes an existing committed starter identity.
  if (STORE_GET_SETTING.call(store, "shell_id") === undefined)
    STORE_SET_SETTING.call(store, "shell_id", "blank");
  return Object.freeze({ table, imported: input.rows.length, columns: input.columns.length });
}
