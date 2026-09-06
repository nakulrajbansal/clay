import { ClayError } from "./errors";
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
const MAX_CAPTURE_UNITS = 2_000_000;
const UTF8 = new TextEncoder();

type CaptureBudget = { units: number };

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

function spend(budget: CaptureBudget, units: number): void {
  budget.units += units;
  if (!Number.isSafeInteger(budget.units) || budget.units > MAX_CAPTURE_UNITS)
    throw invalid("table import exceeds aggregate capture limits");
}

function utf8Length(value: string): number {
  return UTF8.encode(value).byteLength;
}

function chargeRecord(record: object, budget: CaptureBudget): void {
  const keys = Reflect.ownKeys(record);
  spend(budget, 2);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (typeof key !== "string") throw invalid("table import record keys are invalid");
    spend(budget, utf8Length(key) + 4);
  }
}

function chargeArray(source: readonly unknown[], budget: CaptureBudget): void {
  spend(budget, source.length + 2);
}

function dataValue(input: object, key: PropertyKey, what: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || (key !== "length" && !descriptor.enumerable))
    throw invalid(`table import ${what} must use plain data properties`);
  return descriptor.value;
}

function plainRecord(input: unknown, what: string): object {
  if (typeof input !== "object" || input === null || Array.isArray(input)
      || (Reflect.getPrototypeOf(input) !== Object.prototype
        && Reflect.getPrototypeOf(input) !== null))
    throw invalid(`table import ${what} must be a plain record`);
  return input;
}

function denseArray(input: unknown, what: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || Reflect.getPrototypeOf(input) !== Array.prototype)
    throw invalid(`table import ${what} must be a plain array`);
  const keys = Reflect.ownKeys(input);
  const lengthValue = dataValue(input, "length", what);
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0
      || (lengthValue as number) > maximum || keys.length !== (lengthValue as number) + 1)
    throw invalid(`table import ${what} is malformed or exceeds its limit`);
  const length = lengthValue as number;
  const keySet = new Set<PropertyKey>(keys);
  for (let index = 0; index < length; index++) {
    if (!keySet.has(String(index)))
      throw invalid(`table import ${what} must be dense`);
  }
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)))
      throw invalid(`table import ${what} has extra properties`);
  }
  return input;
}

function exactKeys(record: object, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Reflect.ownKeys(record);
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  if (keys.length < required.length || keys.length > required.length + optional.length
      || keys.some(key => !allowed.has(key)))
    throw invalid("table import record has unknown or missing fields");
  for (let index = 0; index < required.length; index++) {
    if (!keys.includes(required[index]!))
      throw invalid("table import record has unknown or missing fields");
  }
}

function identifier(input: unknown, what: string, budget: CaptureBudget): string {
  if (typeof input !== "string" || !SAFE_IDENTIFIER.test(input))
    throw invalid(`table import ${what} is invalid`);
  spend(budget, utf8Length(input) + 2);
  return input;
}

function boundedString(input: unknown, what: string, budget: CaptureBudget): string {
  if (typeof input !== "string" || input.length > MAX_VALUE_LENGTH)
    throw invalid(`table import ${what} is invalid`);
  spend(budget, utf8Length(input) + 2);
  return input;
}

function captureColumn(input: unknown, budget: CaptureBudget): ImportColumn {
  const record = plainRecord(input, "column");
  exactKeys(record, ["name", "type"], ["values"]);
  chargeRecord(record, budget);
  const name = identifier(dataValue(record, "name", "column"), "column name", budget);
  const type = dataValue(record, "type", "column");
  if (type !== "text" && type !== "number" && type !== "date" && type !== "enum")
    throw invalid("table import column type is invalid");
  spend(budget, utf8Length(type) + 2);
  const valuesDescriptor = Reflect.getOwnPropertyDescriptor(record, "values");
  const rawValues = valuesDescriptor === undefined
    ? undefined : dataValue(record, "values", "column");
  let values: readonly string[] | undefined;
  if (rawValues !== undefined) {
    const source = denseArray(rawValues, "enum values", MAX_ENUM_VALUES);
    chargeArray(source, budget);
    if (source.length < 1) throw invalid("table import enum values are invalid");
    const copy: string[] = [];
    for (let index = 0; index < source.length; index++) {
      copy.push(boundedString(
        dataValue(source as object, String(index), "enum values"), "enum value", budget,
      ));
    }
    if (new Set(copy).size !== copy.length)
      throw invalid("table import enum values must be unique");
    values = Object.freeze(copy);
  }
  if ((type === "enum") !== (values !== undefined))
    throw invalid("table import enum values are invalid");
  return Object.freeze({ name, type, ...(values === undefined ? {} : { values }) });
}

function captureCell(
  input: unknown,
  column: ImportColumn,
  budget: CaptureBudget,
): ImportValue {
  if (input === null) {
    spend(budget, 4);
    return null;
  }
  if (column.type === "number") {
    if (typeof input !== "number" || !Number.isFinite(input))
      throw invalid(`table import value for '${column.name}' is invalid`);
    spend(budget, utf8Length(String(input)));
    return input;
  }
  if (typeof input !== "string" && !(column.type === "text" && typeof input === "boolean"))
    throw invalid(`table import value for '${column.name}' is invalid`);
  if (typeof input === "boolean") {
    spend(budget, input ? 4 : 5);
    return input;
  }
  const value = boundedString(input, `value for '${column.name}'`, budget);
  if (column.type === "enum" && !column.values?.includes(value))
    throw invalid(`table import value for '${column.name}' is outside its enum`);
  return value;
}

/** Capture imported typed rows without invoking accessors or caller-owned iteration. */
export function captureTableImport(input: unknown): CapturedTableImport {
  const budget: CaptureBudget = { units: 0 };
  const record = plainRecord(input, "payload");
  exactKeys(record, ["table", "columns", "rows"]);
  chargeRecord(record, budget);
  const table = identifier(dataValue(record, "table", "payload"), "table name", budget);
  const columnSource = denseArray(
    dataValue(record, "columns", "payload"), "columns", MAX_COLUMNS,
  );
  chargeArray(columnSource, budget);
  if (columnSource.length < 1) throw invalid("table import needs at least one column");
  const columns: ImportColumn[] = [];
  for (let index = 0; index < columnSource.length; index++) {
    columns.push(captureColumn(
      dataValue(columnSource as object, String(index), "columns"), budget,
    ));
  }
  if (new Set(columns.map(column => column.name)).size !== columns.length)
    throw invalid("table import column names must be unique");
  const byName = new Map(columns.map(column => [column.name, column] as const));

  const rowSource = denseArray(dataValue(record, "rows", "payload"), "rows", MAX_ROWS);
  chargeArray(rowSource, budget);
  if (rowSource.length < 1) throw invalid("table import needs at least one row");
  const rows: ImportRow[] = [];
  for (let index = 0; index < rowSource.length; index++) {
    const source = plainRecord(
      dataValue(rowSource as object, String(index), "rows"), "row",
    );
    chargeRecord(source, budget);
    const keys = Reflect.ownKeys(source);
    if (keys.length > columns.length || keys.some(key => typeof key !== "string" || !byName.has(key)))
      throw invalid("table import row references an unknown column");
    const row: Record<string, ImportValue> = Object.create(null) as Record<string, ImportValue>;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const key = keys[keyIndex] as string;
      row[key] = captureCell(dataValue(source, key, "row"), byName.get(key)!, budget);
    }
    rows.push(Object.freeze(row));
  }
  return Object.freeze({ table, columns: Object.freeze(columns), rows: Object.freeze(rows) });
}

function allocateTableName(store: ClayStore, requested: string): string {
  const registry = STORE_VALIDATION_REGISTRY.call(store);
  if (!registry.has(requested)) return requested;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const tail = `_${suffix}`;
    const candidate = `${requested.slice(0, 40 - tail.length)}${tail}`;
    if (!registry.has(candidate)) return candidate;
  }
  throw invalid("table import cannot allocate a unique table name");
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
  throw invalid("table import cannot allocate a unique panel identity");
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
  return Object.freeze({ table, imported: input.rows.length, columns: input.columns.length });
}
