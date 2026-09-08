import { ClayError } from "./errors";
import type { SampleProvenanceCoordinate } from "./production-response-envelope";
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
const MAX_CAPTURE_UNITS = 2_000_000;
const UTF8 = new TextEncoder();

type CaptureBudget = { units: number };

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

function spend(budget: CaptureBudget, units: number, what: string): void {
  budget.units += units;
  if (!Number.isSafeInteger(budget.units) || budget.units > MAX_CAPTURE_UNITS)
    throw invalid(`sample ${what} exceeds aggregate capture limits`);
}

function utf8Length(value: string): number {
  return UTF8.encode(value).byteLength;
}

function chargeRecord(record: object, budget: CaptureBudget, what: string): void {
  const keys = Reflect.ownKeys(record);
  spend(budget, 2, what);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (typeof key !== "string") throw invalid(`sample ${what} keys are invalid`);
    spend(budget, utf8Length(key) + 4, what);
  }
}

function chargeArray(source: readonly unknown[], budget: CaptureBudget, what: string): void {
  spend(budget, source.length + 2, what);
}

function dataValue(input: object, key: PropertyKey, what: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || (key !== "length" && !descriptor.enumerable))
    throw invalid(`sample ${what} must use plain data properties`);
  return descriptor.value;
}

function plainRecord(input: unknown, what: string): object {
  if (typeof input !== "object" || input === null || Array.isArray(input)
      || (Reflect.getPrototypeOf(input) !== Object.prototype
        && Reflect.getPrototypeOf(input) !== null))
    throw invalid(`sample ${what} must be a plain record`);
  return input;
}

function denseArray(input: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(input) || Reflect.getPrototypeOf(input) !== Array.prototype)
    throw invalid(`sample ${what} must be a plain array`);
  const keys = Reflect.ownKeys(input);
  const lengthValue = dataValue(input, "length", what);
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0
      || (lengthValue as number) > MAX_ROWS || keys.length !== (lengthValue as number) + 1)
    throw invalid(`sample ${what} is malformed or exceeds its limit`);
  const length = lengthValue as number;
  const keySet = new Set<PropertyKey>(keys);
  for (let index = 0; index < length; index++) {
    if (!keySet.has(String(index))) throw invalid(`sample ${what} must be dense`);
  }
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)))
      throw invalid(`sample ${what} has extra properties`);
  }
  return input;
}

/** The worker command has no caller-controlled options. */
export function captureSampleRemoval(input: unknown): Readonly<Record<string, never>> {
  const record = plainRecord(input, "removal request");
  if (Reflect.ownKeys(record).length !== 0)
    throw invalid("sample removal request has unknown fields");
  return Object.freeze({});
}

/** Capture generated candidates without invoking getters or caller iteration. */
export function captureSampleFill(input: unknown): CapturedSampleFill {
  const budget: CaptureBudget = { units: 0 };
  const record = plainRecord(input, "fill request");
  const rootKeys = Reflect.ownKeys(record);
  if (rootKeys.length !== 1 || rootKeys[0] !== "tables")
    throw invalid("sample fill request has unknown or missing fields");
  chargeRecord(record, budget, "fill request");
  const source = denseArray(dataValue(record, "tables", "fill request"), "fill tables");
  chargeArray(source, budget, "fill request");
  if (source.length > MAX_TABLES) throw invalid("sample fill request exceeds its table limit");
  const tables: CapturedSampleFillTable[] = [];
  const names = new Set<string>();
  let totalRows = 0;
  for (let tableIndex = 0; tableIndex < source.length; tableIndex++) {
    const tableRecord = plainRecord(
      dataValue(source as object, String(tableIndex), "fill tables"), "fill table",
    );
    const tableKeys = Reflect.ownKeys(tableRecord);
    if (tableKeys.length !== 2 || !tableKeys.includes("table") || !tableKeys.includes("rows"))
      throw invalid("sample fill table has unknown or missing fields");
    chargeRecord(tableRecord, budget, "fill request");
    const tableValue = dataValue(tableRecord, "table", "fill table");
    if (typeof tableValue !== "string" || !SAFE_IDENTIFIER.test(tableValue)
        || names.has(tableValue)) throw invalid("sample fill table name is invalid or duplicated");
    names.add(tableValue);
    spend(budget, utf8Length(tableValue) + 2, "fill request");
    const rowSource = denseArray(dataValue(tableRecord, "rows", "fill table"), "fill rows");
    chargeArray(rowSource, budget, "fill request");
    totalRows += rowSource.length;
    if (totalRows > MAX_ROWS) throw invalid("sample fill request exceeds its row limit");
    const rows: Readonly<Record<string, SampleValue>>[] = [];
    for (let rowIndex = 0; rowIndex < rowSource.length; rowIndex++) {
      const rowRecord = plainRecord(
        dataValue(rowSource as object, String(rowIndex), "fill rows"), "fill row",
      );
      chargeRecord(rowRecord, budget, "fill request");
      const rowKeys = Reflect.ownKeys(rowRecord);
      if (rowKeys.length > MAX_COLUMNS_PER_ROW
          || rowKeys.some(key => typeof key !== "string" || !SAFE_IDENTIFIER.test(key)))
        throw invalid("sample fill row fields are invalid");
      const row: Record<string, SampleValue> = Object.create(null) as Record<
        string, SampleValue
      >;
      for (let keyIndex = 0; keyIndex < rowKeys.length; keyIndex++) {
        const key = rowKeys[keyIndex] as string;
        const value = dataValue(rowRecord, key, "fill row");
        if (value !== null && typeof value !== "boolean" && typeof value !== "string"
            && (typeof value !== "number" || !Number.isFinite(value)))
          throw invalid("sample fill row contains a non-scalar value");
        if (typeof value === "string" && value.length > MAX_VALUE_LENGTH)
          throw invalid("sample fill row value exceeds its limit");
        spend(budget, typeof value === "string"
          ? utf8Length(value) + 2
          : value === null ? 4 : utf8Length(String(value)), "fill request");
        row[key] = value;
      }
      rows.push(Object.freeze(row));
    }
    tables.push(Object.freeze({ table: tableValue, rows: Object.freeze(rows) }));
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
  const budget: CaptureBudget = { units: 0 };
  const record = plainRecord(input, "row provenance");
  const keys = Reflect.ownKeys(record);
  if (keys.length > MAX_TABLES || keys.some(key => typeof key !== "string"))
    throw invalid("sample row provenance exceeds its table limit");
  chargeRecord(record, budget, "row provenance");
  const result: Record<string, readonly string[]> = Object.create(null) as Record<
    string, readonly string[]
  >;
  const seen = new Set<string>();
  let total = 0;
  for (let index = 0; index < keys.length; index++) {
    const table = keys[index] as string;
    if (!SAFE_IDENTIFIER.test(table) || !registeredTables.has(table))
      throw invalid("sample row provenance references an unknown table");
    const source = denseArray(dataValue(record, table, "row provenance"), "row ids");
    chargeArray(source, budget, "row provenance");
    total += source.length;
    if (total > MAX_ROWS) throw invalid("sample row provenance exceeds its row limit");
    const ids: string[] = [];
    for (let rowIndex = 0; rowIndex < source.length; rowIndex++) {
      const id = dataValue(source as object, String(rowIndex), "row ids");
      if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH)
        throw invalid("sample row provenance contains an invalid row identity");
      spend(budget, utf8Length(id) + 2, "row provenance");
      const coordinate = `${table}\u0000${id}`;
      if (seen.has(coordinate))
        throw invalid("sample row provenance contains a duplicate row identity");
      seen.add(coordinate);
      ids.push(id);
    }
    result[table] = Object.freeze(ids);
  }
  return Object.freeze(result);
}

const STORE_GET_SETTING: ClayStore["getSetting"] = ClayStore.prototype.getSetting;
const STORE_SET_SETTING: ClayStore["setSetting"] = ClayStore.prototype.setSetting;
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

export function restoredSampleProvenanceCount(store: ClayStore): number {
  return verifiedProvenance(store).length;
}

/**
 * Replace source operation identities after authenticated restore while
 * preserving every validated table/row coordinate. The caller must surround
 * this with the target+catalog reservation protocol in one physical commit.
 */
export function executeRestoredSampleReattestation(
  store: ClayStore,
  operationId: string,
  sourceArchiveSha256: string,
  sourceAuthorityIncarnationId: string,
): Readonly<{
  result: Readonly<{
    rebound: number;
    sourceArchiveSha256: string;
    sourceAuthorityIncarnationId: string;
  }>;
  sampleProvenance: readonly SampleProvenanceCoordinate[];
}> {
  if (!/^op_[a-z2-7]{26}$/.test(operationId)
      || !/^sha256:[0-9a-f]{64}$/.test(sourceArchiveSha256)
      || !/^auth_[a-z2-7]{26}$/.test(sourceAuthorityIncarnationId))
    throw invalid("restored sample re-attestation binding is invalid");
  const source = verifiedProvenance(store);
  if (source.length === 0)
    throw invalid("restored sample re-attestation requires source provenance");
  const entries = source.map(entry => Object.freeze({
    tableId: entry.tableId,
    rowId: entry.rowId,
    operationId,
  }));
  STORE_SET_SETTING.call(store, "sample_provenance_v1", Object.freeze({
    schema: 1,
    entries,
  }));
  const persisted = verifiedProvenance(store);
  if (persisted.length !== entries.length
      || persisted.some((entry, index) => entry.tableId !== entries[index]!.tableId
        || entry.rowId !== entries[index]!.rowId || entry.operationId !== operationId))
    throw invalid("restored sample re-attestation failed canonical read-back");
  return Object.freeze({
    result: Object.freeze({
      rebound: entries.length,
      sourceArchiveSha256,
      sourceAuthorityIncarnationId,
    }),
    sampleProvenance: Object.freeze(entries.map(entry => Object.freeze({
      tableId: entry.tableId,
      rowId: entry.rowId,
    }))),
  });
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
