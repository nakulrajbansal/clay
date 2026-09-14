/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://clay.example"} */
import { createHash } from "node:crypto";
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeProjectionPlaintextV1, encodeProjectionCsvV1, encodeProjectionPlaintextV1,
  type ProjectionArtifactV1, type ProjectionPlaintextV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
import type { AttachmentFile, AttachmentMetadata } from "@clay/kernel";
import { decryptShareSnapshotV1, parseRecipientShareLocationV1 } from "../src/share/crypto";
import { assertShareOwnerTransition, validateShareOwnerRecord, type ShareOwnerRecord, type ShareOwnerVault } from "../src/share/owner-custody";
import { ShareDialog, type ShareAttachmentChoiceV1 } from "../src/share/ShareDialog";
import type { ShareRelayClient } from "../src/share/relay-client";
import { relayRequestSha256 } from "../src/app/relay-request-identity";
import { expectControlCensus } from "./helpers/control-census";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fieldA = "fld_018f0000-0000-7000-8000-000000000002";
const source = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
const presentationSource = async () => structuredClone(source);
const ownerRows = new Map<string, ShareOwnerRecord>();
const vault: ShareOwnerVault = { list: async () => [...ownerRows.values()].map(row => structuredClone(row)), compareAndSet: async (before, after) => {
  assertShareOwnerTransition(before, after); const existing = ownerRows.get(after.request.shareId) ?? null;
  if (JSON.stringify(existing) === JSON.stringify(after)) return;
  if (JSON.stringify(existing) !== JSON.stringify(before)) throw new Error("Owned custody conflict");
  ownerRows.set(after.request.shareId, validateShareOwnerRecord(after));
} };
const fieldB = "fld_018f0000-0000-7000-8000-000000000003";
const approvedId = "file_018f0000000070008000000000000004";
const privateId = "file_018f0000000070008000000000000005";
const request: ProjectionRequestV1 = {
  schema: 1,
  kind: "record",
  expectedSchemaVersion: 7,
  tableId: "tbl_018f0000-0000-7000-8000-000000000001",
  fieldIds: [fieldA, fieldB],
  recordId: "018f0000-0000-7000-8000-000000000006",
  options: { includeRecordIds: false, redactedFieldIds: [] },
};
const attachmentSource = {
  tableId: request.tableId,
  fieldId: "fld_018f0000-0000-7000-8000-000000000007",
  recordId: request.recordId,
} as const;
const choices = [
  { fieldId: fieldA, label: "Title" },
  { fieldId: fieldB, label: "Status" },
];
const approvedBytes = new TextEncoder().encode("APPROVED_FILE_BYTES");
const privateBytes = new TextEncoder().encode("UNAPPROVED_FILE_SECRET");
const metadata = (id: string, name: string, bytes: Uint8Array): AttachmentMetadata => ({
  id, name, mime: "text/plain", size: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  createdAt: "2026-09-07T10:00:00.000Z",
});
const approvedMeta = metadata(approvedId, "approved.txt", approvedBytes);
const privateMeta = metadata(privateId, "private.txt", privateBytes);
const attachmentChoice = (file: AttachmentMetadata): ShareAttachmentChoiceV1 => ({
  ...file,
  tableName: "tasks",
  fieldName: "files",
  source: attachmentSource,
});
const approvedChoice = attachmentChoice(approvedMeta);
const privateChoice = attachmentChoice(privateMeta);

function artifactFor(scope: ProjectionRequestV1): ProjectionArtifactV1 {
  const selected = scope.fieldIds.map(id => id === fieldA
    ? { label: "Title", name: "title", value: "Approved customer result" }
    : { label: "Status", name: "status", value: "Ready" });
  const manifest = {
    schema: "ProjectionManifestV1" as const,
    kind: scope.kind,
    title: "Tasks — record",
    table: "tasks",
    schemaVersion: scope.expectedSchemaVersion,
    fieldCount: selected.length,
    rowCount: 1,
    fields: selected.map(field => ({
      label: field.label, name: field.name, redacted: false as const,
      source: "field" as const, type: "text" as const,
    })),
    view: null,
    policies: {
      relations: "friendly_labels" as const, recordIds: "excluded" as const,
      attachments: "excluded" as const, hiddenFields: "excluded" as const,
      inactiveFields: "excluded" as const, unselectedFields: "excluded" as const,
      blankValues: "empty_string" as const,
      dates: "stored_value_no_timezone_conversion" as const,
      csvFormula: "prefix_apostrophe" as const,
    },
    redactions: [],
    renderer: { id: "clay-semantic-table" as const, version: 1 as const },
    limits: { rows: 5000 as const, fields: 30 as const,
      plaintextBytes: 8388608 as const, sourceRows: 20000 as const },
    completeness: { truncated: false as const, reason: null },
    csv: { byteCount: 0, formulaNeutralizedCells: 0 },
    dependencies: [],
  };
  const draft = {
    schema: "ProjectionPlaintextV1" as const,
    manifest,
    rows: [selected.map(field => field.value)],
  } satisfies ProjectionPlaintextV1;
  const csv = encodeProjectionCsvV1(draft);
  const final = { ...draft, manifest: { ...manifest, csv: {
    byteCount: csv.byteLength, formulaNeutralizedCells: 0,
  } } } satisfies ProjectionPlaintextV1;
  const plaintext = encodeProjectionPlaintextV1(final);
  return { projection: decodeProjectionPlaintextV1(plaintext), plaintext, csv };
}

const file = (meta: AttachmentMetadata, bytes: Uint8Array): AttachmentFile => ({ ...meta, bytes });

const flush = async (): Promise<void> => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
};

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")]
    .find(candidate => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

afterEach(() => {
  ownerRows.clear();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("F1 owner share preview and creation", () => {
  it("recovers the original encrypted delivery after UI teardown without reprojecting or minting another link", async () => {
    let lose = true; let original: string | null = null;
    const create = vi.fn(async (request: Parameters<ShareRelayClient["create"]>[0]) => {
      const bytes = JSON.stringify(request);
      if (original !== null) expect(bytes === original).toBe(true); else original = bytes;
      if (lose) { lose = false; throw new Error("Owned lost delivery"); }
      return { schema: 1 as const, shareId: request.shareId, expiresAt: request.expiresAt };
    });
    const relay: ShareRelayClient = { baseUrl: "https://relay.example", create, read: vi.fn(), terminalize: vi.fn(), revoke: vi.fn() };
    const projectExport = vi.fn(async (scope: ProjectionRequestV1) => artifactFor(scope));
    const props = { ownerVault: vault, worker: { presentationSource, projectExport, attachmentsForRecord: vi.fn(), readAttachment: vi.fn() },
      request, fieldChoices: choices, attachmentChoices: [], relay, viewerOrigin: "https://clay.example", now: () => new Date("2026-09-07T12:00:00.000Z"), onClose: () => {} };
    let host = document.createElement("div"); document.body.append(host); let root = createRoot(host);
    await act(async () => root.render(<ShareDialog {...props} />)); await flush();
    expectControlCensus("F.share");
    await act(async () => button("Approve this exact scope").click()); await flush();
    await act(async () => button("Create encrypted link").click()); await flush();
    expect((await vault.list())[0]?.state).toBe("invoked"); expect(button("Create encrypted link").disabled).toBe(true);
    await act(async () => root.unmount()); host.remove(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<ShareDialog {...props} />)); await flush();
    const before = projectExport.mock.calls.length;
    await act(async () => button("Retry original share").click()); await flush();
    expect(projectExport).toHaveBeenCalledTimes(before); expect(create).toHaveBeenCalledTimes(2); expect(await vault.list()).toHaveLength(1);
    expect((await vault.list())[0]?.state).toBe("published"); expect(document.body.textContent).toContain("Encrypted link ready");
    await act(async () => root.unmount());
  });
  it("requires exact reapproval and reads/packages only separately checked files", async () => {
    const projectExport = vi.fn(async (scope: ProjectionRequestV1) => artifactFor(scope));
    const readAttachment = vi.fn(async (id: string) => id === approvedId
      ? file(approvedMeta, approvedBytes) : file(privateMeta, privateBytes));
    const attachmentsForRecord = vi.fn(async () => [approvedMeta, privateMeta]);
    let sent: Parameters<ShareRelayClient["create"]>[0] | null = null;
    const relay: ShareRelayClient = {
      baseUrl: "https://relay.example/api",
      create: vi.fn(async (encrypted: Parameters<ShareRelayClient["create"]>[0]) => {
        sent = encrypted;
        return { schema: 1 as const, shareId: encrypted.shareId, expiresAt: encrypted.expiresAt };
      }),
      read: vi.fn(),
      revoke: vi.fn(async (shareId: string, _token: string) => ({
        schema: 1 as const, shareId, revoked: true as const,
      })),
      terminalize: vi.fn(async (request, _token) => ({ schema: 1 as const, shareId: request.shareId, expiresAt: request.expiresAt,
        requestSha256: await relayRequestSha256(request), terminal: true as const })),
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareDialog ownerVault={vault}
      worker={{ presentationSource, projectExport, attachmentsForRecord, readAttachment }}
      request={request}
      fieldChoices={choices}
      attachmentChoices={[approvedChoice, privateChoice]}
      relay={relay}
      viewerOrigin="https://clay.example/app"
      now={() => new Date("2026-09-07T12:00:00.000Z")}
      onClose={() => root.unmount()}
    />));
    await flush();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Approved customer result");
    expect(dialog.textContent).toContain("Hidden and unselected fields are excluded");
    expect(dialog.textContent).toContain("Files are excluded unless checked separately");
    expect(button("Create encrypted link").disabled).toBe(true);

    const approvedCheck = dialog.querySelector<HTMLInputElement>(
      `input[data-attachment-id="${approvedId}"]`,
    )!;
    const privateCheck = dialog.querySelector<HTMLInputElement>(
      `input[data-attachment-id="${privateId}"]`,
    )!;
    await act(async () => approvedCheck.click());
    await act(async () => button("Approve this exact scope").click());
    await flush();
    expect(button("Create encrypted link").disabled).toBe(false);

    // Expanding file scope invalidates approval before any bytes are read.
    await act(async () => privateCheck.click());
    expect(button("Create encrypted link").disabled).toBe(true);
    expect(dialog.textContent).toContain("Preview and approve again");
    await act(async () => privateCheck.click());
    expect(button("Create encrypted link").disabled).toBe(true);
    await act(async () => button("Approve this exact scope").click());
    await flush();
    await act(async () => button("Create encrypted link").click());
    await flush();

    expect(readAttachment).toHaveBeenCalledTimes(1);
    expect(readAttachment).toHaveBeenCalledWith(approvedId);
    expect(readAttachment).not.toHaveBeenCalledWith(privateId);
    expect(attachmentsForRecord).toHaveBeenCalledWith(
      "tasks", request.recordId, "files",
    );
    expect(sent).not.toBeNull();
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("Approved customer result");
    expect(wire).not.toContain("APPROVED_FILE_BYTES");
    expect(wire).not.toContain("UNAPPROVED_FILE_SECRET");
    expect(wire).not.toContain("plaintext");

    const linkInput = dialog.querySelector<HTMLInputElement>("[data-share-link]")!;
    expect(linkInput.value).toContain(`/share/${sent!.shareId}`);
    const capability = parseRecipientShareLocationV1(linkInput.value);
    expect(JSON.stringify(sent)).not.toContain(capability.key);
    const decrypted = await decryptShareSnapshotV1({
      schema: 1,
      shareId: sent!.shareId,
      expiresAt: sent!.expiresAt,
      envelope: sent!.envelope,
    }, capability.key);
    expect(decrypted.projection.rows).toEqual([["Approved customer result", "Ready"]]);
    expect(decrypted.attachments.map(item => item.id)).toEqual([approvedId]);
    expect(decrypted.attachments[0]?.source).toEqual(attachmentSource);
    expect(decrypted.scope.attachmentBindings[0]).toMatchObject({
      id: approvedId,
      size: approvedBytes.byteLength,
      sha256: approvedMeta.sha256,
      source: attachmentSource,
    });
    expect(JSON.stringify(decrypted)).not.toContain("UNAPPROVED_FILE_SECRET");

    const receipts = (await vault.list()).map(row => ({ shareId: row.receipt.shareId, revokedAt: row.receipt.revokedAt }));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ shareId: sent!.shareId, revokedAt: null });

    await act(async () => button("Revoke link").click());
    await flush();
    expect(vi.mocked(relay.terminalize).mock.calls.length).toBe(1);
    expect(vi.mocked(relay.terminalize).mock.calls[0]?.[0].shareId).toBe(sent!.shareId);
    expect((await vault.list())[0]?.receipt.revokedAt).toBe(
      "2026-09-07T12:00:00.000Z",
    );
    await act(async () => root.unmount());
  });

  it("blocks a stale approved file before reading bytes when record-field authority is gone", async () => {
    let attached = true;
    const projectExport = vi.fn(async (scope: ProjectionRequestV1) => artifactFor(scope));
    const attachmentsForRecord = vi.fn(async () => attached ? [approvedMeta] : []);
    const readAttachment = vi.fn(async () => file(approvedMeta, approvedBytes));
    const create = vi.fn(async (encrypted: Parameters<ShareRelayClient["create"]>[0]) => ({
      schema: 1 as const,
      shareId: encrypted.shareId,
      expiresAt: encrypted.expiresAt,
    }));
    const relay: ShareRelayClient = {
      baseUrl: "https://relay.example",
      create,
      read: vi.fn(),
      terminalize: vi.fn(), revoke: vi.fn(),
    };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareDialog ownerVault={vault}
      worker={{ presentationSource, projectExport, attachmentsForRecord, readAttachment }}
      request={request}
      fieldChoices={choices}
      attachmentChoices={[approvedChoice]}
      relay={relay}
      viewerOrigin="https://clay.example"
      onClose={() => root.unmount()}
    />));
    await flush();

    const approvedCheck = document.body.querySelector<HTMLInputElement>(
      `input[data-attachment-id="${approvedId}"]`,
    )!;
    await act(async () => approvedCheck.click());
    await act(async () => button("Approve this exact scope").click());
    await flush();
    expect(button("Create encrypted link").disabled).toBe(false);

    attached = false;
    await act(async () => button("Create encrypted link").click());
    await flush();

    expect(attachmentsForRecord).toHaveBeenCalledWith(
      "tasks", request.recordId, "files",
    );
    expect(readAttachment).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toMatch(/no longer attached|reopen/i);
    await act(async () => root.unmount());
  });

  it("reprojects the stable field allowlist and forces reapproval after expansion", async () => {
    const projectExport = vi.fn(async (scope: ProjectionRequestV1) => artifactFor(scope));
    const relay: ShareRelayClient = {
      baseUrl: "https://relay.example",
      create: vi.fn(), read: vi.fn(), terminalize: vi.fn(), revoke: vi.fn(),
    };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareDialog ownerVault={vault}
      worker={{ presentationSource, projectExport, attachmentsForRecord: vi.fn(), readAttachment: vi.fn() }} request={request}
      fieldChoices={choices} attachmentChoices={[]} relay={relay}
      viewerOrigin="https://clay.example" onClose={() => root.unmount()}
    />));
    await flush();
    const statusField = document.body.querySelector<HTMLInputElement>(
      `input[data-field-id="${fieldB}"]`,
    )!;
    await act(async () => statusField.click());
    await flush();
    expect(projectExport.mock.calls.at(-1)?.[0].fieldIds).toEqual([fieldA]);
    await act(async () => button("Approve this exact scope").click());
    await flush();
    expect(button("Create encrypted link").disabled).toBe(false);
    await act(async () => statusField.click());
    await flush();
    expect(projectExport.mock.calls.at(-1)?.[0].fieldIds).toEqual([fieldA, fieldB]);
    expect(button("Create encrypted link").disabled).toBe(true);
    const priorPreviews = projectExport.mock.calls.length;
    await act(async () => button("Review a fresh snapshot").click()); await flush();
    expect(projectExport).toHaveBeenCalledTimes(priorPreviews + 1);
    expect(button("Create encrypted link").disabled).toBe(true); // Fresh preview is not approval.
    expect(document.body.textContent).not.toContain("MUST_NOT_LEAK");
    await act(async () => root.unmount());
  });
});
