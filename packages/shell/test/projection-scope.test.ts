import { describe, expect, it } from "vitest";
import type { FieldId, RegTable, SemanticSchemaTraceV1, TableId } from "@clay/kernel";
import {
  buildCurrentViewProjectionScopeV1, buildRecordProjectionScopeV1,
} from "../src/app/projection-scope";

const tableId = "tbl_018f0000-0000-7000-8000-000000000001" as TableId;
const titleId = "fld_018f0000-0000-7000-8000-000000000002" as FieldId;
const statusId = "fld_018f0000-0000-7000-8000-000000000003" as FieldId;
const filesId = "fld_018f0000-0000-7000-8000-000000000004" as FieldId;
const recordId = "018f0000-0000-7000-8000-000000000005";
const table: RegTable = {
  name: "tasks",
  columns: [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "status", label: "Status", type: "enum", required: false, values: ["open"] },
    { name: "files", label: "Files", type: "attachment", required: false },
    { name: "secret", type: "text", required: false, hidden: true },
  ],
};
const trace = {
  v: 1,
  atVersion: 7,
  tables: [{ tableId, name: "tasks", label: "tasks", aliases: [], state: "visible" }],
  fields: [
    { tableId, fieldId: titleId, tableName: "tasks", fieldName: "title",
      label: "Title", aliases: [], state: "visible" },
    { tableId, fieldId: statusId, tableName: "tasks", fieldName: "status",
      label: "Status", aliases: [], state: "visible" },
    { tableId, fieldId: filesId, tableName: "tasks", fieldName: "files",
      label: "Files", aliases: [], state: "visible" },
  ],
  relationships: [], opBindings: [],
} satisfies SemanticSchemaTraceV1;

describe("local export scope builder", () => {
  it("binds the exact current visible/filter/sort view by stable IDs and excludes attachments", () => {
    const scope = buildCurrentViewProjectionScopeV1({
      trace, table, columns: [table.columns[0]!, table.columns[2]!],
      search: "needle", filter: { field: "status", op: "eq", value: "open" },
      sort: { field: "title", dir: "desc" }, dateAnchor: "2026-09-06",
    });
    expect(scope.request).toEqual({
      schema: 1, kind: "current_view", expectedSchemaVersion: 7, tableId,
      fieldIds: [titleId],
      view: {
        search: "needle",
        filter: { fieldId: statusId, op: "eq", value: "open" },
        sort: { fieldId: titleId, dir: "desc" },
        dateAnchor: "2026-09-06",
      },
      options: { includeRecordIds: false, redactedFieldIds: [] },
    });
    expect(scope.fieldChoices).toEqual([{ fieldId: titleId, label: "Title" }]);
  });

  it("builds only the proven single-record target and rejects identity drift", () => {
    expect(buildRecordProjectionScopeV1({ trace, table, recordId }).request).toMatchObject({
      kind: "record", recordId, tableId, expectedSchemaVersion: 7,
      fieldIds: [titleId, statusId],
    });
    expect(() => buildRecordProjectionScopeV1({
      trace: { ...trace, tables: [] }, table, recordId,
    })).toThrow(/stable table identity/i);
  });
});
