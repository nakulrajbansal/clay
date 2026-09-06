import { expandBlueprint, parseBlueprintDirective } from "./blueprints";
import { ClayError } from "./errors";
import { deriveInverse, type MigrationPlanT } from "./migrate";
import type { SampleProvenanceCoordinate } from "./production-response-envelope";
import {
  ClayStore,
  type PanelBlobInput,
  type SampleRowProvenanceEntry,
} from "./store";

type SeedJsonValue = null | boolean | number | string | SeedJsonValue[] | SeedJsonRecord;
type SeedJsonRecord = { [key: string]: SeedJsonValue };

type StarterSeedColumn = Readonly<{
  name: string;
  type: "text" | "number" | "integer" | "date" | "enum";
  required: boolean;
  values?: readonly string[];
}>;

type StarterSeedTable = Readonly<{
  name: string;
  columns: readonly StarterSeedColumn[];
  sampleRows: readonly Readonly<SeedJsonRecord>[];
}>;

type StarterSeedPanel = Readonly<{
  panelId: string;
  title: string;
  placement: Readonly<{
    region: "top" | "main" | "side";
    order: number;
    w?: number;
    h?: number;
    col?: number;
  }>;
  code: string;
  declaredQueries: readonly Readonly<SeedJsonRecord>[];
  declaredWrites: readonly string[];
}>;

export type CapturedStarterSeedBundle = Readonly<{
  schema: 1;
  shellId: string;
  shellName: string;
  tables: readonly StarterSeedTable[];
  panels: readonly StarterSeedPanel[];
}>;

export type StarterSeedCatalogMetadata = Readonly<{ shellId: string }>;
export type StarterSeedExecutionOutcome = Readonly<{
  result: null;
  sampleProvenance: readonly SampleProvenanceCoordinate[];
}>;

/** Metadata which must ride the authority's revision publication atomically. */
export function starterSeedCatalogMetadata(
  bundle: CapturedStarterSeedBundle,
): StarterSeedCatalogMetadata {
  return Object.freeze({ shellId: bundle.shellId });
}

const MAX_CAPTURE_DEPTH = 32;
const MAX_CAPTURE_NODES = 100_000;
const MAX_CAPTURE_UNITS = 2_000_000;
const MAX_CAPTURE_STRING = 1_000_000;
const MAX_CAPTURE_ARRAY = 10_000;
const MAX_CAPTURE_KEYS = 256;
const MAX_CAPTURE_KEY_LENGTH = 128;
const MAX_TABLES = 64;
const MAX_COLUMNS_PER_TABLE = 128;
const MAX_SAMPLE_ROWS = 10_000;
const MAX_SAMPLE_ROWS_PER_TABLE = 1_000;
const MAX_PANELS = 256;
const MAX_QUERIES_PER_PANEL = 64;
const MAX_WRITES_PER_PANEL = 64;
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const SAFE_SHELL_ID = /^[a-z0-9_]{1,64}$/;
const RELATIVE_STARTER_DAY = /^@clay\/starter-day:([+-]?\d{1,5})$/;

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

type CaptureBudget = { nodes: number; units: number };

function spend(budget: CaptureBudget, units: number): void {
  budget.units += units;
  if (!Number.isSafeInteger(budget.units) || budget.units > MAX_CAPTURE_UNITS)
    throw invalid("starter seed exceeds aggregate capture limits");
}

function dataDescriptor(input: object, key: PropertyKey): PropertyDescriptor {
  const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || (key !== "length" && !descriptor.enumerable))
    throw invalid("starter seed fields must be plain data properties");
  return descriptor;
}

/**
 * Captures caller-controlled JSON without invoking accessors, iterators, or
 * caller-owned array methods. The resulting graph is recursively detached and
 * frozen before the coordinator queues preflight work.
 */
function capturePlainJson(
  input: unknown,
  budget: CaptureBudget,
  depth = 0,
): SeedJsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_CAPTURE_NODES || depth > MAX_CAPTURE_DEPTH)
    throw invalid("starter seed exceeds aggregate capture limits");
  if (input === null || typeof input === "boolean") {
    spend(budget, 1);
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw invalid("starter seed contains a non-finite number");
    spend(budget, 1);
    return input;
  }
  if (typeof input === "string") {
    if (input.length > MAX_CAPTURE_STRING)
      throw invalid("starter seed string exceeds its capture limit");
    spend(budget, input.length);
    return input;
  }
  if (typeof input !== "object") throw invalid("starter seed contains a non-JSON value");

  if (Array.isArray(input)) {
    if (Reflect.getPrototypeOf(input) !== Array.prototype)
      throw invalid("starter seed arrays must use the plain Array prototype");
    const keys = Reflect.ownKeys(input);
    const lengthValue = dataDescriptor(input, "length").value;
    if (!Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > MAX_CAPTURE_ARRAY)
      throw invalid("starter seed array exceeds its capture limit");
    const length = lengthValue as number;
    if (keys.length !== length + 1)
      throw invalid("starter seed arrays must be dense and have no extra properties");
    const keySet = new Set<PropertyKey>(keys);
    if (!keySet.has("length"))
      throw invalid("starter seed arrays must be dense and have no extra properties");
    for (let index = 0; index < length; index++) {
      if (!keySet.has(String(index)))
        throw invalid("starter seed arrays must be dense and have no extra properties");
    }
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)))
        throw invalid("starter seed arrays must be dense and have no extra properties");
    }
    spend(budget, length);
    const output = new Array<SeedJsonValue>(length);
    for (let index = 0; index < length; index++) {
      const descriptor = dataDescriptor(input, String(index));
      output[index] = capturePlainJson(descriptor.value, budget, depth + 1);
    }
    return Object.freeze(output) as SeedJsonValue[];
  }

  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw invalid("starter seed records must use a plain object prototype");
  const keys = Reflect.ownKeys(input);
  if (keys.length > MAX_CAPTURE_KEYS)
    throw invalid("starter seed exceeds aggregate capture limits");
  const output: SeedJsonRecord = Object.create(null) as SeedJsonRecord;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (typeof key !== "string" || key.length > MAX_CAPTURE_KEY_LENGTH)
      throw invalid("starter seed record keys are invalid");
    spend(budget, key.length);
    const descriptor = dataDescriptor(input, key);
    output[key] = capturePlainJson(descriptor.value, budget, depth + 1);
  }
  return Object.freeze(output);
}

function asRecord(value: SeedJsonValue, what: string): SeedJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid(`starter seed ${what} must be a plain record`);
  return value;
}

function asArray(value: SeedJsonValue, what: string): SeedJsonValue[] {
  if (!Array.isArray(value)) throw invalid(`starter seed ${what} must be an array`);
  return value;
}

function exactKeys(
  record: SeedJsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(record);
  const allowed = new Set<string>();
  for (let index = 0; index < required.length; index++) allowed.add(required[index]!);
  for (let index = 0; index < optional.length; index++) allowed.add(optional[index]!);
  if (keys.length < required.length || keys.length > required.length + optional.length)
    throw invalid("starter seed record has unknown or missing fields");
  for (let index = 0; index < required.length; index++) {
    if (!Object.hasOwn(record, required[index]!))
      throw invalid("starter seed record has unknown or missing fields");
  }
  for (let index = 0; index < keys.length; index++) {
    if (!allowed.has(keys[index]!))
      throw invalid("starter seed record has unknown or missing fields");
  }
}

function boundedString(value: SeedJsonValue, what: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw invalid(`starter seed ${what} is invalid`);
  return value;
}

function identifier(value: SeedJsonValue, what: string): string {
  const result = boundedString(value, what, 64);
  if (!SAFE_IDENTIFIER.test(result)) throw invalid(`starter seed ${what} is invalid`);
  return result;
}

function nonNegativeInteger(value: SeedJsonValue, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalid(`starter seed ${what} is invalid`);
  return value;
}

function parseColumn(value: SeedJsonValue): StarterSeedColumn {
  const record = asRecord(value, "column");
  exactKeys(record, ["name", "type", "required"], ["values"]);
  const name = identifier(record.name!, "column name");
  const type = record.type;
  if (type !== "text" && type !== "number" && type !== "integer"
      && type !== "date" && type !== "enum")
    throw invalid("starter seed column type is invalid");
  if (typeof record.required !== "boolean")
    throw invalid("starter seed column required flag is invalid");
  let values: readonly string[] | undefined;
  if (record.values !== undefined) {
    const source = asArray(record.values, "enum values");
    if (source.length < 1 || source.length > 100)
      throw invalid("starter seed enum values are invalid");
    const copy: string[] = [];
    for (let index = 0; index < source.length; index++)
      copy.push(boundedString(source[index]!, "enum value", 80));
    if (new Set(copy).size !== copy.length)
      throw invalid("starter seed enum values must be unique");
    values = Object.freeze(copy);
  }
  if ((type === "enum") !== (values !== undefined))
    throw invalid("starter seed enum values are invalid");
  return Object.freeze({ name, type, required: record.required, ...(values ? { values } : {}) });
}

function parseTable(value: SeedJsonValue): StarterSeedTable {
  const record = asRecord(value, "table");
  exactKeys(record, ["name", "columns", "sampleRows"]);
  const name = identifier(record.name!, "table name");
  const columnSource = asArray(record.columns!, "columns");
  if (columnSource.length < 1 || columnSource.length > MAX_COLUMNS_PER_TABLE)
    throw invalid("starter seed column array exceeds its limit");
  const columns: StarterSeedColumn[] = [];
  for (let index = 0; index < columnSource.length; index++)
    columns.push(parseColumn(columnSource[index]!));
  if (new Set(columns.map(column => column.name)).size !== columns.length)
    throw invalid("starter seed column names must be unique");
  const columnNames = new Set(columns.map(column => column.name));

  const rowSource = asArray(record.sampleRows!, "sample rows");
  if (rowSource.length > MAX_SAMPLE_ROWS_PER_TABLE)
    throw invalid("starter seed sample row array exceeds its limit");
  const sampleRows: Readonly<SeedJsonRecord>[] = [];
  for (let index = 0; index < rowSource.length; index++) {
    const row = asRecord(rowSource[index]!, "sample row");
    const keys = Object.keys(row);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      if (!columnNames.has(keys[keyIndex]!))
        throw invalid("starter seed sample row references an unknown column");
    }
    sampleRows.push(row);
  }
  return Object.freeze({
    name,
    columns: Object.freeze(columns),
    sampleRows: Object.freeze(sampleRows),
  });
}

function optionalPlacementInteger(
  record: SeedJsonRecord,
  key: "w" | "h" | "col",
): number | undefined {
  return record[key] === undefined
    ? undefined : nonNegativeInteger(record[key]!, `panel placement ${key}`);
}

function parsePanel(value: SeedJsonValue): StarterSeedPanel {
  const record = asRecord(value, "panel");
  exactKeys(record, [
    "panel_id", "title", "placement", "code", "declared_queries", "declared_writes",
  ]);
  const panelId = identifier(record.panel_id!, "panel id");
  const title = boundedString(record.title!, "panel title", 80);
  const code = boundedString(record.code!, "panel code", MAX_CAPTURE_STRING);
  const placementRecord = asRecord(record.placement!, "panel placement");
  exactKeys(placementRecord, ["region", "order"], ["w", "h", "col"]);
  const region = placementRecord.region;
  if (region !== "top" && region !== "main" && region !== "side")
    throw invalid("starter seed panel placement region is invalid");
  const order = nonNegativeInteger(placementRecord.order!, "panel placement order");
  const w = optionalPlacementInteger(placementRecord, "w");
  const h = optionalPlacementInteger(placementRecord, "h");
  const col = optionalPlacementInteger(placementRecord, "col");
  const placement = Object.freeze({
    region,
    order,
    ...(w === undefined ? {} : { w }),
    ...(h === undefined ? {} : { h }),
    ...(col === undefined ? {} : { col }),
  });

  const querySource = asArray(record.declared_queries!, "declared queries");
  if (querySource.length > MAX_QUERIES_PER_PANEL)
    throw invalid("starter seed declared query array exceeds its limit");
  const declaredQueries: Readonly<SeedJsonRecord>[] = [];
  for (let index = 0; index < querySource.length; index++)
    declaredQueries.push(asRecord(querySource[index]!, "declared query"));

  const writeSource = asArray(record.declared_writes!, "declared writes");
  if (writeSource.length > MAX_WRITES_PER_PANEL)
    throw invalid("starter seed declared write array exceeds its limit");
  const declaredWrites: string[] = [];
  for (let index = 0; index < writeSource.length; index++)
    declaredWrites.push(identifier(writeSource[index]!, "declared write"));
  if (new Set(declaredWrites).size !== declaredWrites.length)
    throw invalid("starter seed declared writes must be unique");

  return Object.freeze({
    panelId,
    title,
    placement,
    code,
    declaredQueries: Object.freeze(declaredQueries),
    declaredWrites: Object.freeze(declaredWrites),
  });
}

/** Source-private capture used only by ProductionMutationCoordinator. */
export function captureStarterSeedBundle(input: unknown): CapturedStarterSeedBundle {
  const captured = capturePlainJson(input, { nodes: 0, units: 0 });
  const record = asRecord(captured, "bundle");
  exactKeys(record, ["schema", "shellId", "shellName", "tables", "panels"]);
  if (record.schema !== 1) throw invalid("starter seed schema is invalid");
  const shellId = boundedString(record.shellId!, "shell id", 64);
  if (!SAFE_SHELL_ID.test(shellId)) throw invalid("starter seed shell id is invalid");
  const shellName = boundedString(record.shellName!, "shell name", 80);
  if (shellName !== shellName.trim()) throw invalid("starter seed shell name is invalid");

  const tableSource = asArray(record.tables!, "tables");
  if (tableSource.length > MAX_TABLES)
    throw invalid("starter seed table array exceeds its limit");
  const tables: StarterSeedTable[] = [];
  let sampleRows = 0;
  for (let index = 0; index < tableSource.length; index++) {
    const table = parseTable(tableSource[index]!);
    sampleRows += table.sampleRows.length;
    if (sampleRows > MAX_SAMPLE_ROWS)
      throw invalid("starter seed sample rows exceed their aggregate limit");
    tables.push(table);
  }
  if (new Set(tables.map(table => table.name)).size !== tables.length)
    throw invalid("starter seed table names must be unique");

  const panelSource = asArray(record.panels!, "panels");
  if (panelSource.length > MAX_PANELS)
    throw invalid("starter seed panel array exceeds its limit");
  const panels: StarterSeedPanel[] = [];
  for (let index = 0; index < panelSource.length; index++)
    panels.push(parsePanel(panelSource[index]!));
  if (new Set(panels.map(panel => panel.panelId)).size !== panels.length)
    throw invalid("starter seed panel ids must be unique");

  return Object.freeze({
    schema: 1,
    shellId,
    shellName,
    tables: Object.freeze(tables),
    panels: Object.freeze(panels),
  });
}

const STORE_COMMIT: ClayStore["commit"] = ClayStore.prototype.commit;
const STORE_INSERT: ClayStore["insert"] = ClayStore.prototype.insert;
const STORE_SET_SETTING: ClayStore["setSetting"] = ClayStore.prototype.setSetting;
const STORE_REGISTRY_SNAPSHOT: ClayStore["registrySnapshot"] = ClayStore.prototype.registrySnapshot;
const STORE_VALIDATION_REGISTRY_SNAPSHOT: ClayStore["validationRegistrySnapshot"] =
  ClayStore.prototype.validationRegistrySnapshot;
const STORE_RECORD_SAMPLE_PROVENANCE: ClayStore["recordSampleRowProvenance"] =
  ClayStore.prototype.recordSampleRowProvenance;
const DERIVE_INVERSE: typeof deriveInverse = deriveInverse;
const PARSE_BLUEPRINT: typeof parseBlueprintDirective = parseBlueprintDirective;
const EXPAND_BLUEPRINT: typeof expandBlueprint = expandBlueprint;

function materializeSampleRow(
  table: StarterSeedTable,
  row: Readonly<SeedJsonRecord>,
  seedInstant: string,
): Record<string, unknown> {
  const materialized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(row)) materialized[key] = row[key];
  for (let index = 0; index < table.columns.length; index++) {
    const column = table.columns[index]!;
    if (column.type !== "date") continue;
    const value = materialized[column.name];
    if (typeof value !== "string" || !value.startsWith("@clay/starter-day:")) continue;
    const match = RELATIVE_STARTER_DAY.exec(value);
    const offset = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > 36_500)
      throw invalid("starter seed relative date is invalid");
    const date = new Date(seedInstant);
    if (Number.isNaN(date.getTime())) throw invalid("trusted starter seed instant is invalid");
    date.setDate(date.getDate() + offset);
    materialized[column.name] = date.toISOString().slice(0, 10);
  }
  return materialized;
}

function copyPlacement(panel: StarterSeedPanel): PanelBlobInput["placement"] {
  return {
    region: panel.placement.region,
    order: panel.placement.order,
    ...(panel.placement.w === undefined ? {} : { w: panel.placement.w }),
    ...(panel.placement.h === undefined ? {} : { h: panel.placement.h }),
    ...(panel.placement.col === undefined ? {} : { col: panel.placement.col }),
  };
}

/**
 * Source-private, module-pinned seed executor. The coordinator invokes this
 * exact function for both disposable shadow preflight and the guarded live
 * transaction; no caller callback or Store reference crosses the boundary.
 */
export function executeCapturedStarterSeed(
  store: ClayStore,
  bundle: CapturedStarterSeedBundle,
  seedInstant: string,
  operationId: string,
): StarterSeedExecutionOutcome {
  for (let start = 0; start < bundle.tables.length; start += 3) {
    const operations: MigrationPlanT["operations"] = [];
    const names: string[] = [];
    const end = Math.min(start + 3, bundle.tables.length);
    for (let index = start; index < end; index++) {
      const table = bundle.tables[index]!;
      names.push(table.name);
      const columns: Extract<
        MigrationPlanT["operations"][number], { op: "create_table" }
      >["columns"] = [];
      for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex++) {
        const column = table.columns[columnIndex]!;
        columns.push({
          name: column.name,
          type: column.type,
          required: column.required,
          ...(column.values === undefined ? {} : { values: [...column.values] }),
        });
      }
      operations.push({ op: "create_table", table: table.name, columns });
    }
    const registry = STORE_REGISTRY_SNAPSHOT.call(store);
    STORE_COMMIT.call(store, {
      intent: "first run",
      summary: `Sets up ${names.join(", ")}.`,
      semanticOrigin: "seed",
      migration: {
        operations,
        inverse: DERIVE_INVERSE(operations, registry),
      },
    });
  }

  // The registry is intentionally sampled only after every schema group has
  // landed, so directive expansion sees the complete post-schema registry.
  const registry = STORE_REGISTRY_SNAPSHOT.call(store);
  const authorityRegistry = STORE_VALIDATION_REGISTRY_SNAPSHOT.call(store);
  const panels: PanelBlobInput[] = [];
  for (let index = 0; index < bundle.panels.length; index++) {
    const panel = bundle.panels[index]!;
    const directive = PARSE_BLUEPRINT(panel.code);
    if (directive === null) {
      panels.push({
        panel_id: panel.panelId,
        title: panel.title,
        placement: copyPlacement(panel),
        code: panel.code,
        declared_queries: panel.declaredQueries as PanelBlobInput["declared_queries"],
        declared_writes: [...panel.declaredWrites],
      });
      continue;
    }
    const expanded = EXPAND_BLUEPRINT(directive, registry);
    panels.push({
      panel_id: panel.panelId,
      title: panel.title,
      placement: copyPlacement(panel),
      code: expanded.code,
      declared_queries: expanded.declared_queries as PanelBlobInput["declared_queries"],
      declared_writes: [...expanded.declared_writes],
    });
  }
  const blank = bundle.tables.length === 0;
  STORE_COMMIT.call(store, {
    intent: "first run",
    summary: blank ? "Starts a blank canvas." : `Creates your ${bundle.shellName} views.`,
    semanticOrigin: "seed",
    migration: null,
    panels,
    diff: blank ? [] : [{ kind: "add_panel", detail: `${bundle.shellName} starter panels` }],
  });

  const sampleEntries: SampleRowProvenanceEntry[] = [];
  for (let tableIndex = 0; tableIndex < bundle.tables.length; tableIndex++) {
    const table = bundle.tables[tableIndex]!;
    const tableId = authorityRegistry.get(table.name)?.semantic?.tableId;
    if (!tableId) throw invalid("starter sample table identity is unavailable");
    for (let rowIndex = 0; rowIndex < table.sampleRows.length; rowIndex++) {
      const inserted = STORE_INSERT.call(
        store,
        table.name,
        materializeSampleRow(table, table.sampleRows[rowIndex]!, seedInstant),
      );
      sampleEntries.push(Object.freeze({
        tableId,
        rowId: String(inserted.id),
        operationId,
      }));
    }
  }
  if (sampleEntries.length > 0)
    STORE_RECORD_SAMPLE_PROVENANCE.call(store, sampleEntries);
  STORE_SET_SETTING.call(store, "shell_id", bundle.shellId);
  const sampleProvenance = sampleEntries
    .map(entry => Object.freeze({ tableId: entry.tableId, rowId: entry.rowId }))
    .sort((left, right) => {
      const leftKey = `${left.tableId}\u0000${left.rowId}`;
      const rightKey = `${right.tableId}\u0000${right.rowId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return Object.freeze({
    result: null,
    sampleProvenance: Object.freeze(sampleProvenance),
  });
}
