import { ClayError } from "@clay/kernel/errors";
import {
  projectPlaintextV1Cooperative,
  projectionTransportV1,
  type ProjectionReadableStoreV1,
  type ProjectionRequestV1,
} from "@clay/kernel/projection";
import type {
  FieldId, Query, QueryByteBudget, QueryRow, RegTable, SemanticSchemaTraceV1, TableId,
} from "@clay/kernel";

const TABLE_ID = "tbl_018f0000-0000-7000-8000-000000000001" as TableId;
const FIELD_COUNT = 30;
const FIELD_IDS = Array.from({ length: FIELD_COUNT }, (_, index) =>
  `fld_018f0000-0000-7000-8000-${(index + 2).toString(16).padStart(12, "0")}` as FieldId);
const COLUMNS: RegTable["columns"] = FIELD_IDS.map((_fieldId, index) => ({
  name: index === 0 ? "title" : `field_${index.toString().padStart(2, "0")}`,
  label: index === 0 ? "Title" : `Field ${index.toString().padStart(2, "0")}`,
  type: "text" as const,
  required: true,
}));
const TABLE: RegTable = { name: "benchmark_rows", columns: COLUMNS };
const TRACE: SemanticSchemaTraceV1 = {
  v: 1,
  atVersion: 1,
  tables: [{ tableId: TABLE_ID, name: TABLE.name, label: "Benchmark rows",
    aliases: [], state: "visible" }],
  fields: COLUMNS.map((column, index) => ({
    tableId: TABLE_ID, fieldId: FIELD_IDS[index]!, tableName: TABLE.name,
    fieldName: column.name, label: column.label ?? column.name,
    aliases: [], state: "visible" as const,
  })),
  relationships: [],
  opBindings: [],
};
const encoder = new TextEncoder();
let rowCount: 1000 | 5000 | null = null;
const cancelled = new Set<number>();
type ProjectionOutcome = "cancelled" | "completed" | "failed";
type ProjectionLifecycle = {
  terminal: Promise<ProjectionOutcome>;
  resolve: (outcome: ProjectionOutcome) => void;
};
const projectionLifecycles = new Map<number, ProjectionLifecycle>();

function beginProjectionLifecycle(id: number): void {
  let resolve!: (outcome: ProjectionOutcome) => void;
  const terminal = new Promise<ProjectionOutcome>(done => { resolve = done; });
  projectionLifecycles.set(id, { terminal, resolve });
}

function finishProjectionLifecycle(id: number, outcome: ProjectionOutcome): void {
  const lifecycle = projectionLifecycles.get(id);
  projectionLifecycles.delete(id);
  lifecycle?.resolve(outcome);
}

function rowId(index: number): string {
  return `018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function indexFromId(id: string): number {
  return Number.parseInt(id.slice(-12), 16);
}

const VALUE_FILL = "x".repeat(44);
function fieldValue(rowIndex: number, fieldIndex: number): string {
  if (fieldIndex === 0) return `Benchmark row ${rowIndex.toString().padStart(4, "0")}`;
  return `${rowIndex.toString().padStart(4, "0")}:${fieldIndex
    .toString().padStart(2, "0")}:${VALUE_FILL}`;
}

const FIELD_INDEX = new Map(COLUMNS.map((column, index) => [column.name, index]));

function queryRows(query: Query, budget: QueryByteBudget): QueryRow[] {
  if (rowCount === null) throw new ClayError("E_INTERNAL", "benchmark source is not initialized");
  if (query.from !== TABLE.name) throw new ClayError("E_TABLE_UNKNOWN", "unknown benchmark table");
  const where = query.where?.[0];
  let first = 0;
  let lastExclusive: number = rowCount;
  if (where?.field === "id" && where.op === "gt") first = indexFromId(String(where.value)) + 1;
  else if (where?.field === "id" && where.op === "eq") {
    first = indexFromId(String(where.value));
    lastExclusive = Math.min(rowCount, first + 1);
  } else if (where) throw new ClayError("E_VALIDATION", "unsupported benchmark query");
  const limit = query.limit ?? 500;
  lastExclusive = Math.min(lastExclusive, first + limit);
  const rows: QueryRow[] = [];
  let bytes = 0;
  const selectedFields = query.select ?? ["id", ...COLUMNS.map(column => column.name)];
  for (let index = first; index < lastExclusive; index++) {
    const row: QueryRow = {};
    let rowBytes = 0;
    for (const field of selectedFields) {
      const value = field === "id" ? rowId(index)
        : FIELD_INDEX.has(field) ? fieldValue(index, FIELD_INDEX.get(field)!) : null;
      row[field] = value;
      if (typeof value === "string") rowBytes += encoder.encode(value).byteLength;
    }
    if (rowBytes > budget.maxRowBytes || bytes + rowBytes > budget.remainingBytes)
      throw new ClayError("E_LIMIT", budget.limitLabel);
    bytes += rowBytes;
    rows.push(row);
  }
  budget.remainingBytes -= bytes;
  return rows;
}

function fixtureInputBytes(rows: number): number {
  let bytes = 0;
  for (let row = 0; row < rows; row++) {
    bytes += encoder.encode(rowId(row)).byteLength;
    for (let field = 0; field < FIELD_COUNT; field++)
      bytes += encoder.encode(fieldValue(row, field)).byteLength;
  }
  return bytes;
}

const source: ProjectionReadableStoreV1 = Object.freeze({
  queryBounded: queryRows,
  registrySnapshot: () => new Map([[TABLE.name, TABLE]]),
  semanticSchemaTrace: () => TRACE,
});

function post(id: number, ok: boolean, result?: unknown, error?: unknown): void {
  const transfer: Transferable[] = [];
  if (result && typeof result === "object") {
    const artifact = result as { plaintext?: Uint8Array; csv?: Uint8Array };
    if (artifact.plaintext?.buffer instanceof ArrayBuffer) transfer.push(artifact.plaintext.buffer);
    if (artifact.csv?.buffer instanceof ArrayBuffer) transfer.push(artifact.csv.buffer);
  }
  self.postMessage({ id, ok, ...(ok ? { result } : { error }) }, { transfer });
}

self.onmessage = (event: MessageEvent): void => {
  const request = event.data as { id: number; op: string; payload?: unknown };
  const projectionRequest = request.op === "projectPlaintextV1";
  if (projectionRequest) beginProjectionLifecycle(request.id);
  void (async () => {
    let projectionOutcome: ProjectionOutcome = "failed";
    try {
      if (request.op === "benchmarkInit") {
        const rows = Number((request.payload as { rows?: unknown } | null)?.rows);
        if (rows !== 1000 && rows !== 5000)
          throw new ClayError("E_VALIDATION", "benchmark rows must be exactly 1000 or 5000");
        rowCount = rows as 1000 | 5000;
        post(request.id, true, {
          request: {
            schema: 1,
            kind: "current_view",
            expectedSchemaVersion: 1,
            tableId: TABLE_ID,
            fieldIds: FIELD_IDS,
            view: { search: "", filter: null, sort: null, dateAnchor: "2026-09-06" },
            options: { includeRecordIds: false, redactedFieldIds: [] },
          } satisfies ProjectionRequestV1,
          inputBytes: fixtureInputBytes(rows),
        });
        return;
      }
      if (request.op === "cancelProjectionV1") {
        const targetId = Number((request.payload as { targetId?: unknown } | null)?.targetId);
        const lifecycle = projectionLifecycles.get(targetId);
        if (!lifecycle) {
          post(request.id, true, { targetId, quiescent: true, outcome: "not_found" });
          return;
        }
        cancelled.add(targetId);
        const outcome = await lifecycle.terminal;
        post(request.id, true, { targetId, quiescent: true, outcome });
        return;
      }
      if (request.op !== "projectPlaintextV1")
        throw new ClayError("E_VALIDATION", "unsupported benchmark worker operation");
      try {
        const artifact = await projectPlaintextV1Cooperative(
          source,
          request.payload as ProjectionRequestV1,
          { isCancelled: () => cancelled.has(request.id) },
        );
        post(request.id, true, projectionTransportV1(artifact));
        projectionOutcome = "completed";
      } finally {
        cancelled.delete(request.id);
      }
    } catch (error) {
      post(request.id, false, undefined, {
        code: error instanceof ClayError ? error.code : "E_INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      });
      if (projectionRequest && error instanceof ClayError && error.code === "E_CANCELLED")
        projectionOutcome = "cancelled";
    } finally {
      if (projectionRequest) finishProjectionLifecycle(request.id, projectionOutcome);
    }
  })();
};
