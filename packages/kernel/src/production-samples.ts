import { targetAuthorityInvalid as invalid } from "./production-input-capture";
import type { SampleProvenanceCoordinate } from "./production-response-envelope";
import {
  captureStrictJson,
  type StrictJson,
  type StrictJsonCapturePolicy,
} from "./strict-json-capture";
import {
  ClayStore,
  type SampleRowProvenanceEntry,
  type SampleRowProvenanceState,
} from "./store";

export type SampleRowProvenance = Readonly<Record<string, readonly string[]>>;
export type SampleRemovalResult = Readonly<{
  affected: number;
  recovery: Readonly<{ kind: "soft_delete"; recoverable: number }>;
}>;
export type SampleFillResult = Readonly<{ added: number; tables: number }>;
export type SampleFillExecutionOutcome = Readonly<{
  result: SampleFillResult;
  sampleProvenance: readonly SampleProvenanceCoordinate[];
}>;
type SampleValue = null | boolean | number | string;
type CapturedSampleFillTable = Readonly<{
  table: string;
  rows: readonly Readonly<Record<string, SampleValue>>[];
}>;
export type CapturedSampleFill = Readonly<{
  tables: readonly CapturedSampleFillTable[];
}>;

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_TABLES = 64;
const MAX_ROWS = 10_000;
const MAX_ID_LENGTH = 128;
const MAX_COLUMNS_PER_ROW = 128;
const MAX_VALUE_LENGTH = 1_000_000;
const SAMPLE_CAPTURE_POLICY: StrictJsonCapturePolicy = [
  6, 500_000, MAX_VALUE_LENGTH, 2_000_000, MAX_ROWS, MAX_COLUMNS_PER_ROW, 128,
  true, true,
  reason => {
    if (reason === 10 || reason === 12)
      throw invalid("sample fields must use plain data properties");
    throw invalid(reason === 1
      ? "sample input exceeds aggregate capture limits"
      : "sample input is invalid");
  },
];

function plainRecord(input: unknown, what: string): Record<string, StrictJson> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw invalid(`sample ${what} must be a plain record`);
  return input as Record<string, StrictJson>;
}

function denseArray(input: unknown, what: string): readonly StrictJson[] {
  if (!Array.isArray(input)) throw invalid(`sample ${what} must be a plain array`);
  return input;
}

/** The worker command has no caller-controlled options. */
export function captureSampleRemoval(input: unknown): Readonly<Record<string, never>> {
  const record = plainRecord(captureStrictJson(input, SAMPLE_CAPTURE_POLICY), "removal request");
  if (Object.keys(record).length !== 0)
    throw invalid("sample removal request has unknown fields");
  return Object.freeze({});
}

/** Capture generated candidates without invoking getters or caller iteration. */
export function captureSampleFill(input: unknown): CapturedSampleFill {
  const record = plainRecord(captureStrictJson(input, SAMPLE_CAPTURE_POLICY), "fill request");
  const rootKeys = Object.keys(record);
  if (rootKeys.length !== 1 || rootKeys[0] !== "tables")
    throw invalid("sample fill request has unknown or missing fields");
  const source = denseArray(record.tables, "fill tables");
  if (source.length > MAX_TABLES) throw invalid("sample fill request exceeds its table limit");
  const tables: CapturedSampleFillTable[] = [];
  const names = new Set<string>();
  let totalRows = 0;
  for (const candidate of source) {
    const tableRecord = plainRecord(candidate, "fill table");
    const tableKeys = Object.keys(tableRecord);
    if (tableKeys.length !== 2 || !tableKeys.includes("table") || !tableKeys.includes("rows"))
      throw invalid("sample fill table has unknown or missing fields");
    const table = tableRecord.table;
    if (typeof table !== "string" || !SAFE_IDENTIFIER.test(table) || names.has(table))
      throw invalid("sample fill table name is invalid or duplicated");
    names.add(table);
    const rowSource = denseArray(tableRecord.rows, "fill rows");
    totalRows += rowSource.length;
    if (totalRows > MAX_ROWS) throw invalid("sample fill request exceeds its row limit");
    const rows = rowSource.map(rowCandidate => {
      const rowRecord = plainRecord(rowCandidate, "fill row");
      const rowKeys = Object.keys(rowRecord);
      if (rowKeys.length > MAX_COLUMNS_PER_ROW || rowKeys.some(key => !SAFE_IDENTIFIER.test(key)))
        throw invalid("sample fill row fields are invalid");
      const row: Record<string, SampleValue> = Object.create(null) as Record<string, SampleValue>;
      for (const key of rowKeys) {
        const value = rowRecord[key];
        if (value !== null && typeof value !== "boolean" && typeof value !== "string"
            && (typeof value !== "number" || !Number.isFinite(value)))
          throw invalid("sample fill row contains a non-scalar value");
        row[key] = value;
      }
      return Object.freeze(row);
    });
    tables.push(Object.freeze({ table, rows: Object.freeze(rows) }));
  }
  return Object.freeze({ tables: Object.freeze(tables) });
}

/**
 * Validate and detach the legacy row-level marker. IDs remain in this ledger
 * after soft deletion so a later restore cannot silently reclassify a sample
 * as user-created data.
 */
export function captureSampleRowProvenance(
  input: unknown,
  registeredTables: ReadonlySet<string>,
): SampleRowProvenance {
  if (input === undefined) return Object.freeze({});
  const record = plainRecord(captureStrictJson(input, SAMPLE_CAPTURE_POLICY), "row provenance");
  const keys = Object.keys(record);
  if (keys.length > MAX_TABLES)
    throw invalid("sample row provenance exceeds its table limit");
  const result: Record<string, readonly string[]> = Object.create(null) as Record<
    string, readonly string[]
  >;
  const seen = new Set<string>();
  let total = 0;
  for (const table of keys) {
    if (!SAFE_IDENTIFIER.test(table) || !registeredTables.has(table))
      throw invalid("sample row provenance references an unknown table");
    const source = denseArray(record[table], "row ids");
    total += source.length;
    if (total > MAX_ROWS) throw invalid("sample row provenance exceeds its row limit");
    const ids = source.map(id => {
      if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH)
        throw invalid("sample row provenance contains an invalid row identity");
      const coordinate = `${table}\u0000${id}`;
      if (seen.has(coordinate))
        throw invalid("sample row provenance contains a duplicate row identity");
      seen.add(coordinate);
      return id;
    });
    result[table] = Object.freeze(ids);
  }
  return Object.freeze(result);
}

const STORE_GET_SETTING: ClayStore["getSetting"] = ClayStore.prototype.getSetting;
const STORE_VALIDATION_REGISTRY: ClayStore["validationRegistrySnapshot"] =
  ClayStore.prototype.validationRegistrySnapshot;
const STORE_SOFT_DELETE: ClayStore["softDelete"] = ClayStore.prototype.softDelete;
const STORE_INSERT: ClayStore["insert"] = ClayStore.prototype.insert;
const STORE_PROVENANCE: ClayStore["sampleRowProvenance"] =
  ClayStore.prototype.sampleRowProvenance;
const STORE_PROVENANCE_STATE: ClayStore["sampleRowProvenanceState"] =
  ClayStore.prototype.sampleRowProvenanceState;
const STORE_RECORD_PROVENANCE: ClayStore["recordSampleRowProvenance"] =
  ClayStore.prototype.recordSampleRowProvenance;

function verifiedProvenance(store: ClayStore): SampleRowProvenanceState[] {
  if (STORE_GET_SETTING.call(store, "sample_rows") !== undefined)
    throw invalid("legacy sample provenance is unauthenticated");
  return STORE_PROVENANCE.call(store).map(entry =>
    STORE_PROVENANCE_STATE.call(store, entry));
}

export function readSampleRowProvenance(store: ClayStore): SampleRowProvenance {
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const entry of verifiedProvenance(store)) {
    const ids = result[entry.tableName] ?? [];
    ids.push(entry.rowId);
    result[entry.tableName] = ids;
  }
  for (const key of Object.keys(result)) Object.freeze(result[key]!);
  return Object.freeze(result);
}

/** Run only in a disposable stage or the guarded physical commit transaction. */
export function executeCapturedSampleRemoval(store: ClayStore): SampleRemovalResult {
  const provenance = verifiedProvenance(store);
  let affected = 0;
  let recoverable = 0;
  for (let index = 0; index < provenance.length; index++) {
    const entry = provenance[index]!;
    if (entry.tableActive && entry.rowState === "active") {
      STORE_SOFT_DELETE.call(store, entry.tableName, entry.rowId);
      affected += 1;
    }
    recoverable += 1;
  }
  return Object.freeze({
    affected,
    recovery: Object.freeze({ kind: "soft_delete", recoverable }),
  });
}

/** Run only in a disposable stage or the guarded physical commit transaction. */
export function executeCapturedSampleFill(
  store: ClayStore,
  input: CapturedSampleFill,
  operationId: string,
): SampleFillExecutionOutcome {
  verifiedProvenance(store);
  const registry = STORE_VALIDATION_REGISTRY.call(store);
  const additions: SampleRowProvenanceEntry[] = [];
  let added = 0;
  let tables = 0;
  for (let tableIndex = 0; tableIndex < input.tables.length; tableIndex++) {
    const candidate = input.tables[tableIndex]!;
    const table = registry.get(candidate.table);
    if (!table || !table.semantic)
      throw invalid("sample fill request references an unknown table");
    let tableAdded = 0;
    for (let rowIndex = 0; rowIndex < candidate.rows.length; rowIndex++) {
      const inserted = STORE_INSERT.call(
        store, candidate.table, candidate.rows[rowIndex] as Record<string, unknown>,
      );
      additions.push(Object.freeze({
        tableId: table.semantic.tableId,
        rowId: String(inserted.id),
        operationId,
      }));
      added += 1;
      tableAdded += 1;
    }
    if (tableAdded > 0) {
      tables += 1;
    }
  }
  if (additions.length > 0) STORE_RECORD_PROVENANCE.call(store, additions);
  const sampleProvenance = additions
    .map(entry => Object.freeze({ tableId: entry.tableId, rowId: entry.rowId }))
    .sort((left, right) => {
      const leftKey = `${left.tableId}\u0000${left.rowId}`;
      const rightKey = `${right.tableId}\u0000${right.rowId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return Object.freeze({
    result: Object.freeze({ added, tables }),
    sampleProvenance: Object.freeze(sampleProvenance),
  });
}

/** Count active marked samples while retaining deleted-row provenance. */
export function activeSampleRowCount(store: ClayStore): number {
  return verifiedProvenance(store).filter(entry =>
    entry.tableActive && entry.rowState === "active").length;
}
