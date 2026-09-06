import { describe, expect, it } from "vitest";
import {
  ProjectionPlaintextV1, ProjectionRequestV1,
} from "../src/projection";

const tableId = "tbl_018f0000-0000-7000-8000-000000000001";
const fieldId = "fld_018f0000-0000-7000-8000-000000000002";
const recordId = "018f0000-0000-7000-8000-000000000003";

const currentRequest = {
  schema: 1,
  kind: "current_view",
  expectedSchemaVersion: 3,
  tableId,
  fieldIds: [fieldId],
  view: { search: "", filter: null, sort: null, dateAnchor: "2026-09-06" },
  options: { includeRecordIds: false, redactedFieldIds: [] },
} as const;

const recordPlaintext = {
  schema: "ProjectionPlaintextV1",
  manifest: {
    schema: "ProjectionManifestV1",
    kind: "record",
    title: "Tasks — record",
    table: "tasks",
    schemaVersion: 3,
    fieldCount: 1,
    rowCount: 1,
    fields: [{ label: "Title", name: "title", redacted: false,
      source: "field", type: "text" }],
    view: null,
    policies: {
      relations: "friendly_labels", recordIds: "excluded", attachments: "excluded",
      hiddenFields: "excluded", inactiveFields: "excluded", unselectedFields: "excluded",
      blankValues: "empty_string", dates: "stored_value_no_timezone_conversion",
      csvFormula: "prefix_apostrophe",
    },
    redactions: [],
    renderer: { id: "clay-semantic-table", version: 1 },
    limits: { rows: 5000, fields: 30, plaintextBytes: 8388608, sourceRows: 20000 },
    completeness: { truncated: false, reason: null },
    csv: { byteCount: 10, formulaNeutralizedCells: 0 },
    dependencies: [],
  },
  rows: [["Task"]],
} as const;

describe("frozen projection v1 schemas", () => {
  it("accepts only the two shipped stable-id request kinds and rejects unknown capability fields", () => {
    expect(ProjectionRequestV1.safeParse(currentRequest).success).toBe(true);
    expect(ProjectionRequestV1.safeParse({
      schema: 1, kind: "record", expectedSchemaVersion: 3, tableId,
      fieldIds: [fieldId], recordId,
      options: { includeRecordIds: false, redactedFieldIds: [] },
    }).success).toBe(true);
    expect(ProjectionRequestV1.safeParse({ ...currentRequest, live: true }).success).toBe(false);
    expect(ProjectionRequestV1.safeParse({ ...currentRequest, kind: "saved_view" }).success).toBe(false);
    expect(ProjectionRequestV1.safeParse({ ...currentRequest,
      options: { ...currentRequest.options, includeAttachments: true } }).success).toBe(false);
  });

  it("requires exactly one dependency entry for every derived or relation output", () => {
    const relationWithoutDependency = {
      ...recordPlaintext,
      manifest: {
        ...recordPlaintext.manifest,
        fields: [{ ...recordPlaintext.manifest.fields[0], type: "relation" }],
      },
    };
    expect(ProjectionPlaintextV1.safeParse(relationWithoutDependency).success).toBe(false);
    const extraDependency = {
      ...recordPlaintext,
      manifest: {
        ...recordPlaintext.manifest,
        dependencies: [{
          fields: [], kind: "computed", output: "missing_output",
        }],
      },
    };
    expect(ProjectionPlaintextV1.safeParse(extraDependency).success).toBe(false);
  });

  it("rejects a canonical manifest whose kind contradicts its view semantics", () => {
    expect(ProjectionPlaintextV1.safeParse(recordPlaintext).success).toBe(true);
    expect(ProjectionPlaintextV1.safeParse({
      ...recordPlaintext,
      manifest: {
        ...recordPlaintext.manifest,
        kind: "current_view",
        view: null,
      },
    }).success).toBe(false);
  });
});
