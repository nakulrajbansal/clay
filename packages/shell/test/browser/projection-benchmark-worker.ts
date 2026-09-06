import { ClayError } from "@clay/kernel/errors";
import {
  projectPlaintextV1Cooperative,
  type ProjectionReadableStoreV1,
  type ProjectionRequestV1,
} from "@clay/kernel/projection";
import type {
  FieldId, Query, QueryByteBudget, QueryRow, RegTable, SemanticSchemaTraceV1, TableId,
} from "@clay/kernel";

const TABLE_ID = "tbl_018f0000-0000-7000-8000-000000000001" as TableId;
const FIELD_ID = "fld_018f0000-0000-7000-8000-000000000002" as FieldId;
const TABLE: RegTable = {
  name: "benchmark_rows",
  columns: [{ name: "title", label: "Title", type: "text", required: true }],
};
const TRACE: SemanticSchemaTraceV1 = {
  v: 1,
  atVersion: 1,
  tables: [{ tableId: TABLE_ID, name: TABLE.name, label: "Benchmark rows",
    aliases: [], state: "visible" }],
  fields: [{ tableId: TABLE_ID, fieldId: FIELD_ID, tableName: TABLE.name,
    fieldName: "title", label: "Title", aliases: [], state: "visible" }],
  relationships: [],
  opBindings: [],
};
const encoder = new TextEncoder();
let rowCount: 1000 | 5000 | null = null;
const active = new Set<number>();
const cancelled = new Set<number>();

function rowId(index: number): string {
  return `018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function indexFromId(id: string): number {
  return Number.parseInt(id.slice(-12), 16);
}

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
  for (let index = first; index < lastExclusive; index++) {
    const id = rowId(index);
    const title = `Benchmark row ${index.toString().padStart(4, "0")}`;
    const rowBytes = encoder.encode(id).byteLength + encoder.encode(title).byteLength;
    if (rowBytes > budget.maxRowBytes || bytes + rowBytes > budget.remainingBytes)
      throw new ClayError("E_LIMIT", budget.limitLabel);
    bytes += rowBytes;
    const row: QueryRow = {};
    for (const field of query.select ?? ["id", "title"])
      row[field] = field === "id" ? id : field === "title" ? title : null;
    rows.push(row);
  }
  budget.remainingBytes -= bytes;
  return rows;
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
  void (async () => {
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
            fieldIds: [FIELD_ID],
            view: { search: "", filter: null, sort: null, dateAnchor: "2026-09-06" },
            options: { includeRecordIds: false, redactedFieldIds: [] },
          } satisfies ProjectionRequestV1,
          inputBytes: rows * 56,
        });
        return;
      }
      if (request.op === "cancelProjectionV1") {
        const targetId = Number((request.payload as { targetId?: unknown } | null)?.targetId);
        if (active.has(targetId)) cancelled.add(targetId);
        post(request.id, true, null);
        return;
      }
      if (request.op !== "projectPlaintextV1")
        throw new ClayError("E_VALIDATION", "unsupported benchmark worker operation");
      active.add(request.id);
      try {
        const artifact = await projectPlaintextV1Cooperative(
          source,
          request.payload as ProjectionRequestV1,
          { isCancelled: () => cancelled.has(request.id) },
        );
        post(request.id, true, artifact);
      } finally {
        active.delete(request.id);
        cancelled.delete(request.id);
      }
    } catch (error) {
      post(request.id, false, undefined, {
        code: error instanceof ClayError ? error.code : "E_INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
