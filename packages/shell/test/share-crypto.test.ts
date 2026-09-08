import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeProjectionPlaintextV1, encodeProjectionCsvV1, encodeProjectionPlaintextV1,
  type ProjectionArtifactV1, type ProjectionPlaintextV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
import {
  approveShareScopeV1, base64UrlEncodeV1, buildRecipientShareUrlV1,
  decryptShareSnapshotV1, encryptApprovedShareV1, parseRecipientShareLocationV1,
  shareScopeRequiresReapprovalV1,
} from "../src/share/crypto";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(
  process.cwd(), "../kernel/test/fixtures", name,
)));
const sourceProjection = decodeProjectionPlaintextV1(
  fixture("projection-current-view-v1.plaintext.json"),
);
const recordDraft: ProjectionPlaintextV1 = {
  ...sourceProjection,
  manifest: {
    ...sourceProjection.manifest,
    kind: "record",
    title: "Jobs — record",
    rowCount: 1,
    view: null,
  },
  rows: [sourceProjection.rows[1]!],
};
const recordCsv = encodeProjectionCsvV1(recordDraft);
const recordProjection: ProjectionPlaintextV1 = {
  ...recordDraft,
  manifest: {
    ...recordDraft.manifest,
    csv: {
      ...recordDraft.manifest.csv,
      byteCount: recordCsv.byteLength,
    },
  },
};
const projectionBytes = encodeProjectionPlaintextV1(recordProjection);
const artifact: ProjectionArtifactV1 = {
  projection: decodeProjectionPlaintextV1(projectionBytes),
  plaintext: projectionBytes,
  csv: recordCsv,
};
const fieldIds = Array.from({ length: 6 }, (_, index) =>
  `fld_018f0000-0000-7000-8000-${String(index + 2).padStart(12, "0")}`);
const recordId = "018f0000-0000-7000-8000-000000000098";
const request: ProjectionRequestV1 = {
  schema: 1,
  kind: "record",
  expectedSchemaVersion: 2,
  tableId: "tbl_018f0000-0000-7000-8000-000000000001",
  fieldIds,
  recordId,
  options: { includeRecordIds: false, redactedFieldIds: [] },
};
const approvedId = "file_018f0000000070008000000000000003";
const unapprovedId = "file_018f0000000070008000000000000004";
const attachmentSource = {
  tableId: request.tableId,
  fieldId: "fld_018f0000-0000-7000-8000-000000000099",
  recordId,
} as const;
const approvedBytes = new TextEncoder().encode("APPROVED_FILE");
const attachment = {
  id: approvedId,
  name: "approved.txt",
  mime: "text/plain",
  size: approvedBytes.byteLength,
  sha256: createHash("sha256").update(approvedBytes).digest("hex"),
  createdAt: "2026-09-07T11:00:00.000Z",
  source: attachmentSource,
  bytes: approvedBytes,
} as const;
const unapprovedAttachment = { ...attachment, id: unapprovedId } as const;
const shareId = "shr_abcdefghijklmnopqrstuvwxyz";
const key = base64UrlEncodeV1(Uint8Array.from({ length: 32 }, (_, index) => index));
const revokeToken = base64UrlEncodeV1(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 40);
const expiresAt = "2026-09-08T12:00:00.000Z";

describe("browser-only F1 share cryptography", () => {
  it("encrypts an approved canonical snapshot and decrypts it with only the fragment key", async () => {
    const approval = await approveShareScopeV1(
      request, [attachment], artifact, new Date("2026-09-07T12:00:00.000Z"));
    const encrypted = await encryptApprovedShareV1({
      approval,
      request,
      artifact,
      attachments: [attachment],
      expiresAt,
      entropy: { shareId, key, revokeToken, iv },
    });

    expect(encrypted.request).toMatchObject({
      schema: 1, shareId, expiresAt,
      envelope: { schema: 1, algorithm: "A256GCM" },
    });
    expect(JSON.stringify(encrypted.request)).not.toContain(key);
    expect(JSON.stringify(encrypted.request)).not.toContain("Alpha");
    expect(JSON.stringify(encrypted.request)).not.toContain("APPROVED_FILE");
    expect(encrypted.revokeToken).toBe(revokeToken);

    const decrypted = await decryptShareSnapshotV1({
      schema: 1,
      shareId,
      expiresAt,
      envelope: encrypted.request.envelope,
    }, key);
    expect(decrypted.projection).toEqual(artifact.projection);
    expect(decrypted.scope).toEqual(approval);
    expect(decrypted.attachments).toHaveLength(1);
    expect(decrypted.attachments[0]?.id).toBe(approvedId);
    expect(decrypted.attachments[0]?.bytes).toEqual(approvedBytes);

    await expect(decryptShareSnapshotV1({
      schema: 1, shareId, expiresAt: "2026-09-09T12:00:00.000Z",
      envelope: encrypted.request.envelope,
    }, key)).rejects.toThrow(/decrypt|authentic/i);
  });

  it("requires a fresh approval for every field, record, or attachment scope change", async () => {
    const approval = await approveShareScopeV1(
      request, [attachment], artifact, new Date("2026-09-07T12:00:00.000Z"));
    const otherRecordRequest = {
      ...request,
      recordId: "018f0000-0000-7000-8000-000000000097",
    };
    expect(await shareScopeRequiresReapprovalV1(
      approval, request, [attachment], artifact)).toBe(false);
    expect(await shareScopeRequiresReapprovalV1(approval, {
      ...request,
      fieldIds: [...request.fieldIds,
        "fld_018f0000-0000-7000-8000-000000000100"],
    }, [attachment], artifact)).toBe(true);
    expect(await shareScopeRequiresReapprovalV1(
      approval, otherRecordRequest, [attachment], artifact)).toBe(true);
    expect(await shareScopeRequiresReapprovalV1(
      approval, request, [attachment, unapprovedAttachment], artifact)).toBe(true);

    await expect(encryptApprovedShareV1({
      approval,
      request: otherRecordRequest,
      artifact,
      attachments: [attachment],
      expiresAt,
      entropy: { shareId, key, revokeToken, iv },
    })).rejects.toThrow(/approve|scope/i);
  });

  it("cannot package an unapproved file or a projection outside the field allowlist", async () => {
    const approval = await approveShareScopeV1(
      request, [attachment], artifact, new Date("2026-09-07T12:00:00.000Z"));
    const forbiddenBytes = new TextEncoder().encode("UNAPPROVED_FILE_SECRET");
    const forbidden = {
      ...attachment,
      id: unapprovedId,
      name: "private.txt",
      size: forbiddenBytes.byteLength,
      sha256: createHash("sha256").update(forbiddenBytes).digest("hex"),
      bytes: forbiddenBytes,
    };
    await expect(encryptApprovedShareV1({
      approval,
      request,
      artifact,
      attachments: [attachment, forbidden],
      expiresAt,
      entropy: { shareId, key, revokeToken, iv },
    })).rejects.toThrow(/attachment.*allowlist|approved.*attachment/i);

    const narrowedRequest = { ...request, fieldIds: request.fieldIds.slice(0, 5) };
    await expect(approveShareScopeV1(
      narrowedRequest, [], artifact, new Date("2026-09-07T12:00:00.000Z"),
    )).rejects.toThrow(/field|allowlist|projection/i);

    const wrongProjection = {
      ...artifact.projection,
      manifest: {
        ...artifact.projection.manifest,
        fields: artifact.projection.manifest.fields.map((field, index) =>
          index === 0 ? { ...field, name: "secret" } : field),
      },
    } as ProjectionPlaintextV1;
    const wrongBytes = encodeProjectionPlaintextV1(wrongProjection);
    const wrongArtifact: ProjectionArtifactV1 = {
      projection: decodeProjectionPlaintextV1(wrongBytes),
      plaintext: wrongBytes,
      csv: encodeProjectionCsvV1(wrongBytes),
    };
    await expect(encryptApprovedShareV1({
      approval,
      request,
      artifact: wrongArtifact,
      attachments: [attachment],
      expiresAt,
      entropy: { shareId, key, revokeToken, iv },
    })).rejects.toThrow(/approve|scope|preview|projection/i);
  });

  it("puts the key only in a URL fragment and parses a bounded relay location", () => {
    const href = buildRecipientShareUrlV1({
      viewerOrigin: "https://clay.example/app",
      relayBaseUrl: "https://relay.example/api/",
      shareId,
      key,
    });
    const url = new URL(href);
    expect(url.pathname).toBe(`/share/${shareId}`);
    expect(url.searchParams.get("relay")).toBe("https://relay.example/api");
    expect(url.hash).toBe(`#k=${key}`);
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(key);
    expect(parseRecipientShareLocationV1(href)).toEqual({
      shareId, key, relayBaseUrl: "https://relay.example/api",
    });
    expect(() => parseRecipientShareLocationV1(
      `https://clay.example/share/${shareId}?relay=file%3A%2F%2Fprivate#k=${key}`,
    )).toThrow(/relay/i);
  });
});
