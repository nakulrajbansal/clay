import { describe, expect, it } from "vitest";
import type {
  FieldId, QueryRow, QueryValue, RegTable, SemanticSchemaTraceV1, TableId,
} from "../src/index";
import {
  decodeProjectionArtifactV1,
  projectPlaintextV1Cooperative,
  type ProjectionReadableStoreV1,
  type ProjectionRequestV1,
} from "../src/projection";

const tableId = "tbl_018f0000-0000-7000-8000-000000000001" as TableId;
const fieldId = "fld_018f0000-0000-7000-8000-000000000002" as FieldId;
const table: RegTable = {
  name: "tasks",
  columns: [{ name: "title", label: "Title", type: "text", required: true }],
};
const trace: SemanticSchemaTraceV1 = {
  v: 1,
  atVersion: 1,
  tables: [{ tableId, name: "tasks", label: "Tasks", aliases: [], state: "visible" }],
  fields: [{ tableId, fieldId, tableName: "tasks", fieldName: "title",
    label: "Title", aliases: [], state: "visible" }],
  relationships: [],
  opBindings: [],
};
const request: ProjectionRequestV1 = {
  schema: 1,
  kind: "current_view",
  expectedSchemaVersion: 1,
  tableId,
  fieldIds: [fieldId],
  view: { search: "", filter: null, sort: null, dateAnchor: "2026-09-07" },
  options: { includeRecordIds: false, redactedFieldIds: [] },
};

function rowId(index: number): string {
  return `018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

describe("cooperative projection page lifetime", () => {
  it("rejects when the authoritative snapshot changes between pages", async () => {
    let revision = "1";
    const source = {
      projectionSnapshot: () => revision,
      registrySnapshot: () => new Map([[table.name, table]]),
      semanticSchemaTrace: () => trace,
      queryBounded(query: Parameters<ProjectionReadableStoreV1["queryBounded"]>[0], budget: Parameters<ProjectionReadableStoreV1["queryBounded"]>[1]) {
        const cursor = query.where?.[0]?.field === "id"
          ? Number.parseInt(String(query.where[0].value).slice(-12), 16) + 1 : 0;
        const count = Math.min(query.limit ?? 500, 501 - cursor);
        budget.remainingBytes -= count * 32;
        return Array.from({ length: count }, (_, offset) => ({
          id: rowId(cursor + offset), title: `Task ${cursor + offset}`,
        }));
      },
    } as ProjectionReadableStoreV1 & { projectionSnapshot(): string };

    await expect(projectPlaintextV1Cooperative(source, request, {
      yieldControl: async () => { revision = "2"; },
    })).rejects.toMatchObject({ code: "E_CONFLICT" });
  });

  it("converts an unfiltered page before requesting the next page", async () => {
    let invalidatePrevious: Array<() => void> = [];
    const source: ProjectionReadableStoreV1 = {
      registrySnapshot: () => new Map([[table.name, table]]),
      semanticSchemaTrace: () => trace,
      queryBounded(query, budget) {
        invalidatePrevious.forEach(invalidate => invalidate());
        const cursor = query.where?.[0]?.field === "id"
          ? Number.parseInt(String(query.where[0].value).slice(-12), 16) + 1 : 0;
        const count = Math.min(query.limit ?? 500, 501 - cursor);
        const invalidators: Array<() => void> = [];
        const rows = Array.from({ length: count }, (_, offset): QueryRow => {
          const index = cursor + offset;
          let live = true;
          const title = {};
          Object.defineProperty(title, "value", { enumerable: true, get() {
            if (!live) throw new Error("previous query page was retained");
            return `Task ${index}`;
          } });
          invalidators.push(() => { live = false; });
          return { id: rowId(index), title: title as QueryValue };
        });
        budget.remainingBytes -= count * 64;
        invalidatePrevious = invalidators;
        return rows;
      },
    };

    const artifact = await projectPlaintextV1Cooperative(source, request);
    const decoded = decodeProjectionArtifactV1(artifact);
    expect(decoded.manifest.rowCount).toBe(501);
    expect(decoded.rows.at(-1)).toEqual(['{"value":"Task 500"}']);
  });
});
