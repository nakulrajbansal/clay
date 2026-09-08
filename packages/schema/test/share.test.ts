import { describe, expect, it } from "vitest";
import {
  ShareApprovedScopeV1, ShareCreateRequestV1, SharePayloadV1, ShareRevokeRequestV1,
} from "../src/share";

const tableId = "tbl_018f0000-0000-7000-8000-000000000001";
const fieldId = "fld_018f0000-0000-7000-8000-000000000002";
const fileId = "file_018f0000000070008000000000000003";
const recordId = "018f0000-0000-7000-8000-000000000003";
const attachmentFieldId = "fld_018f0000-0000-7000-8000-000000000004";
const attachmentSource = { tableId, fieldId: attachmentFieldId, recordId } as const;
const shareId = "shr_abcdefghijklmnopqrstuvwxyz";
const expiresAt = "2026-09-08T12:00:00.000Z";

const projectionRequest = {
  schema: 1,
  kind: "record",
  expectedSchemaVersion: 3,
  tableId,
  fieldIds: [fieldId],
  recordId,
  options: { includeRecordIds: false, redactedFieldIds: [] },
} as const;

const projection = {
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
  rows: [["Approved value"]],
} as const;

const payload = {
  schema: "SharePayloadV1",
  scope: {
    schema: "ShareApprovedScopeV1",
    projectionRequest,
    fieldBindings: [{ fieldId, outputName: "title" }],
    attachmentIds: [fileId],
    attachmentBindings: [{
      id: fileId, size: 3, sha256: "a".repeat(64), source: attachmentSource,
    }],
    approvedAt: "2026-09-07T12:00:00.000Z",
    projectionDigest: "P".repeat(43),
    fingerprint: "F".repeat(43),
  },
  projection,
  attachments: [{
    id: fileId,
    name: "approved.pdf",
    mime: "application/pdf",
    size: 3,
    sha256: "a".repeat(64),
    source: attachmentSource,
    bytes: "AQID",
  }],
} as const;

const createRequest = {
  schema: 1,
  shareId,
  expiresAt,
  revokeTokenHash: "B".repeat(43),
  envelope: {
    schema: 1,
    algorithm: "A256GCM",
    iv: "A".repeat(16),
    ciphertext: "A".repeat(24),
  },
} as const;

describe("F1 share schemas", () => {
  it("accepts the finite encrypted snapshot wire shapes and rejects plaintext or keys", () => {
    expect(ShareCreateRequestV1.safeParse(createRequest).success).toBe(true);
    expect(ShareCreateRequestV1.safeParse({ ...createRequest, plaintext: projection }).success)
      .toBe(false);
    expect(ShareCreateRequestV1.safeParse({ ...createRequest, decryptionKey: "secret" }).success)
      .toBe(false);
    expect(ShareCreateRequestV1.safeParse({
      ...createRequest, envelope: { ...createRequest.envelope, records: [] },
    }).success).toBe(false);
    expect(ShareRevokeRequestV1.safeParse({ schema: 1, revokeToken: "C".repeat(43) }).success)
      .toBe(true);
    expect(ShareRevokeRequestV1.safeParse({
      schema: 1, revokeToken: "C".repeat(43), key: "not-allowed",
    }).success).toBe(false);
  });

  it("binds payload fields and files to exact stable-ID allowlists", () => {
    expect(SharePayloadV1.safeParse(payload).success).toBe(true);
    expect(SharePayloadV1.safeParse({
      ...payload,
      attachments: [{ ...payload.attachments[0], id: "file_018f0000000070008000000000000004" }],
    }).success).toBe(false);
    expect(SharePayloadV1.safeParse({
      ...payload,
      scope: { ...payload.scope, attachmentIds: [] },
    }).success).toBe(false);
    expect(SharePayloadV1.safeParse({
      ...payload,
      attachments: [{ ...payload.attachments[0], source: {
        ...attachmentSource, recordId: "018f0000-0000-7000-8000-000000000099",
      } }],
    }).success).toBe(false);
    expect(SharePayloadV1.safeParse({
      ...payload,
      scope: { ...payload.scope, attachmentBindings: [{
        ...payload.scope.attachmentBindings[0], sha256: "b".repeat(64),
      }] },
    }).success).toBe(false);
    const otherRecordSource = {
      ...attachmentSource,
      recordId: "018f0000-0000-7000-8000-000000000099",
    } as const;
    expect(SharePayloadV1.safeParse({
      ...payload,
      scope: { ...payload.scope, attachmentBindings: [{
        ...payload.scope.attachmentBindings[0], source: otherRecordSource,
      }] },
      attachments: [{ ...payload.attachments[0], source: otherRecordSource }],
    }).success).toBe(false);

    const extraFieldProjection = {
      ...projection,
      manifest: {
        ...projection.manifest,
        fieldCount: 2,
        fields: [
          ...projection.manifest.fields,
          { label: "Hidden", name: "secret", redacted: false,
            source: "field", type: "text" },
        ],
      },
      rows: [["Approved value", "MUST_NOT_LEAK"]],
    };
    expect(SharePayloadV1.safeParse({ ...payload, projection: extraFieldProjection }).success)
      .toBe(false);

    const sameCountWrongField = {
      ...projection,
      manifest: {
        ...projection.manifest,
        fields: [{ label: "Hidden", name: "secret", redacted: false,
          source: "field", type: "text" }],
      },
      rows: [["MUST_NOT_LEAK"]],
    };
    expect(SharePayloadV1.safeParse({ ...payload, projection: sameCountWrongField }).success)
      .toBe(false);
  });

  it("rejects duplicate, malformed, active-content, or unapproved attachment scope", () => {
    expect(ShareApprovedScopeV1.safeParse({
      ...payload.scope,
      projectionRequest: {
        schema: 1,
        kind: "current_view",
        expectedSchemaVersion: 3,
        tableId,
        fieldIds: [fieldId],
        view: { search: "", filter: null, sort: null, dateAnchor: "2026-09-07" },
        options: { includeRecordIds: false, redactedFieldIds: [] },
      },
    }).success).toBe(false);
    expect(SharePayloadV1.safeParse({
      ...payload,
      scope: { ...payload.scope, attachmentIds: [fileId, fileId] },
      attachments: [payload.attachments[0], payload.attachments[0]],
    }).success).toBe(false);
    expect(SharePayloadV1.safeParse({
      ...payload,
      attachments: [{ ...payload.attachments[0], mime: "text/html" }],
    }).success).toBe(false);
    expect(SharePayloadV1.safeParse({
      ...payload,
      attachments: [{ ...payload.attachments[0], bytes: "standard/base64==" }],
    }).success).toBe(false);
  });
});
