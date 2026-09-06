import { isTableId, type ClayStore, type RegTable } from "@clay/kernel";

export const LEGACY_SAMPLE_ROWS_SETTING = "sample_rows";
export const SAMPLE_PROVENANCE_SETTING = "sample_provenance_v1";

export type SampleProvenanceEntry = Readonly<{
  tableId: string;
  rowId: string;
  operationId: string;
}>;
export type SampleCreatedResult =
  | Readonly<{
    route: "starter.seed";
    created: readonly SampleProvenanceEntry[];
  }>
  | Readonly<{
    route: "samples.fill";
    added: number;
    tables: number;
    created: readonly SampleProvenanceEntry[];
  }>;
export type SampleProvenanceLedgerV1 = Readonly<{
  schema: 1;
  entries: readonly SampleProvenanceEntry[];
}>;
export type SampleProvenanceState = SampleProvenanceEntry & Readonly<{
  tableName: string;
  tableActive: boolean;
  rowState: "active" | "deleted";
}>;

const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID = /^op_[a-z2-7]{26}$/;
const MAX_ENTRIES = 100_000;

function plainRecord(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || (Reflect.getPrototypeOf(value) !== Object.prototype
        && Reflect.getPrototypeOf(value) !== null))
    throw new Error(`${label} is invalid`);
  return value;
}

function dataValue(value: object, key: PropertyKey, label: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || (key !== "length" && !descriptor.enumerable))
    throw new Error(`${label} is invalid`);
  return descriptor.value;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some(key => typeof key !== "string")
      || expected.some(key => !keys.includes(key)))
    throw new Error(`${label} is invalid`);
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`${label} is invalid`);
  const length = dataValue(value, "length", label);
  const keys = Reflect.ownKeys(value);
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > MAX_ENTRIES
      || keys.length !== Number(length) + 1)
    throw new Error(`${label} is invalid`);
  for (let index = 0; index < Number(length); index++)
    if (!keys.includes(String(index))) throw new Error(`${label} is invalid`);
  if (keys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key))))
    throw new Error(`${label} is invalid`);
  return value;
}

function compareEntries(left: SampleProvenanceEntry, right: SampleProvenanceEntry): number {
  return left.tableId.localeCompare(right.tableId)
    || left.rowId.localeCompare(right.rowId)
    || left.operationId.localeCompare(right.operationId);
}

export function parseSampleProvenanceLedger(value: unknown): SampleProvenanceLedgerV1 {
  if (value === undefined) return Object.freeze({ schema: 1, entries: Object.freeze([]) });
  const root = plainRecord(value, "sample provenance ledger");
  exactKeys(root, ["schema", "entries"], "sample provenance ledger");
  if (dataValue(root, "schema", "sample provenance ledger") !== 1)
    throw new Error("sample provenance ledger is invalid");
  const source = denseArray(
    dataValue(root, "entries", "sample provenance ledger"), "sample provenance entries",
  );
  const entries: SampleProvenanceEntry[] = [];
  const coordinates = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const raw = plainRecord(
      dataValue(source as object, String(index), "sample provenance entries"),
      "sample provenance entry",
    );
    exactKeys(raw, ["tableId", "rowId", "operationId"], "sample provenance entry");
    const tableId = dataValue(raw, "tableId", "sample provenance entry");
    const rowId = dataValue(raw, "rowId", "sample provenance entry");
    const operationId = dataValue(raw, "operationId", "sample provenance entry");
    if (!isTableId(tableId) || typeof rowId !== "string" || !ROW_ID.test(rowId)
        || typeof operationId !== "string" || !OPERATION_ID.test(operationId))
      throw new Error("sample provenance entry is invalid");
    const coordinate = `${tableId}\u0000${rowId}`;
    if (coordinates.has(coordinate)) throw new Error("sample provenance ledger is duplicated");
    coordinates.add(coordinate);
    entries.push(Object.freeze({ tableId, rowId, operationId }));
  }
  for (let index = 1; index < entries.length; index++)
    if (compareEntries(entries[index - 1]!, entries[index]!) > 0)
      throw new Error("sample provenance ledger is not canonical");
  return Object.freeze({ schema: 1, entries: Object.freeze(entries) });
}

export function parseSampleCreatedResult(value: unknown): SampleCreatedResult {
  const root = plainRecord(value, "sample creation result");
  const route = dataValue(root, "route", "sample creation result");
  if (route !== "starter.seed" && route !== "samples.fill")
    throw new Error("sample creation result is invalid");
  exactKeys(root, route === "starter.seed"
    ? ["route", "created"] : ["route", "added", "tables", "created"],
  "sample creation result");
  const created = parseSampleProvenanceLedger({
    schema: 1,
    entries: dataValue(root, "created", "sample creation result"),
  }).entries;
  if (new Set(created.map(entry => entry.operationId)).size > 1)
    throw new Error("sample creation result operation identity is inconsistent");
  if (route === "starter.seed") return Object.freeze({ route, created });
  const added = dataValue(root, "added", "sample creation result");
  const tables = dataValue(root, "tables", "sample creation result");
  if (!Number.isSafeInteger(added) || !Number.isSafeInteger(tables)
      || Number(added) !== created.length || Number(tables) < 0
      || Number(tables) > Number(added)
      || (Number(added) === 0) !== (Number(tables) === 0))
    throw new Error("sample creation result counts are invalid");
  return Object.freeze({ route, added: Number(added), tables: Number(tables), created });
}

function mintSampleOperationId(): string {
  const source = globalThis.crypto?.getRandomValues?.(new Uint8Array(17));
  if (!source) throw new Error("trusted sample operation identity is unavailable");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (let index = 0; index < source.length && encoded.length < 26; index++) {
    value = (value << 8) | source[index]!;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (encoded.length !== 26) throw new Error("trusted sample operation identity is unavailable");
  return `op_${encoded}`;
}

export function readSampleProvenance(store: ClayStore): SampleProvenanceState[] {
  if (store.getSetting(LEGACY_SAMPLE_ROWS_SETTING) !== undefined)
    throw new Error("legacy sample provenance is unauthenticated");
  const ledger = parseSampleProvenanceLedger(store.getSetting(SAMPLE_PROVENANCE_SETTING));
  const registry = store.validationRegistrySnapshot();
  const tablesById = new Map<string, RegTable>();
  for (const table of registry.values()) {
    const tableId = table.semantic?.tableId;
    if (!tableId) continue;
    if (tablesById.has(tableId)) throw new Error("sample provenance table identity is ambiguous");
    tablesById.set(tableId, table);
  }
  return ledger.entries.map(entry => {
    const table = tablesById.get(entry.tableId);
    if (!table) throw new Error("sample provenance table identity is unavailable");
    const rows = store.query({
      from: table.name,
      where: [{ field: "id", op: "eq", value: entry.rowId }],
      includeDeleted: true,
      limit: 1,
    });
    if (rows.length !== 1)
      throw new Error("sample provenance references a missing row");
    return Object.freeze({
      ...entry,
      tableName: table.name,
      tableActive: !table.inactive,
      rowState: rows[0]!.deleted_at == null ? "active" as const : "deleted" as const,
    });
  });
}

export function recordSampleRows(
  store: ClayStore,
  additions: Readonly<Record<string, readonly string[]>>,
  operationId = mintSampleOperationId(),
): readonly SampleProvenanceEntry[] {
  if (!OPERATION_ID.test(operationId)) throw new Error("sample operation identity is invalid");
  const existing = readSampleProvenance(store);
  const coordinates = new Set(existing.map(entry => `${entry.tableId}\u0000${entry.rowId}`));
  const registry = store.validationRegistrySnapshot();
  const entries: SampleProvenanceEntry[] = existing.map(({ tableId, rowId, operationId }) =>
    ({ tableId, rowId, operationId }));
  const created: SampleProvenanceEntry[] = [];
  for (const [tableName, rowIds] of Object.entries(additions)) {
    const table = registry.get(tableName);
    if (!table || table.inactive || !table.semantic)
      throw new Error("sample provenance references an unknown table");
    if (!Array.isArray(rowIds) || entries.length + rowIds.length > MAX_ENTRIES)
      throw new Error("sample provenance ledger exceeds its limit");
    for (const rowId of rowIds) {
      if (typeof rowId !== "string" || !ROW_ID.test(rowId))
        throw new Error("sample provenance row identity is invalid");
      const coordinate = `${table.semantic.tableId}\u0000${rowId}`;
      if (coordinates.has(coordinate)) throw new Error("sample provenance entry is duplicated");
      const rows = store.query({
        from: tableName, where: [{ field: "id", op: "eq", value: rowId }],
        includeDeleted: true, limit: 1,
      });
      if (rows.length !== 1 || rows[0]!.deleted_at != null)
        throw new Error("new sample provenance must reference an active row");
      coordinates.add(coordinate);
      const entry = Object.freeze({ tableId: table.semantic.tableId, rowId, operationId });
      entries.push(entry);
      created.push(entry);
    }
  }
  entries.sort(compareEntries);
  created.sort(compareEntries);
  const ledger = Object.freeze({ schema: 1 as const, entries: Object.freeze(entries) });
  store.setSetting(SAMPLE_PROVENANCE_SETTING, ledger);
  const readBack = parseSampleProvenanceLedger(store.getSetting(SAMPLE_PROVENANCE_SETTING));
  if (JSON.stringify(readBack) !== JSON.stringify(ledger))
    throw new Error("sample provenance ledger failed read-back");
  return Object.freeze(created);
}
