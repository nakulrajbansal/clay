import { ownedRelayApp } from "../../backend/test/helpers/owned-relay-app";
import { describe, expect, it, vi } from "vitest";
import {
  ClayStore, deriveInverse, type ForwardOpT,
} from "@clay/kernel";
import { projectPlaintextV1, type ProjectionRequestV1 } from "@clay/kernel/projection";
import { createApp } from "../../backend/src/app";
import { MemoryShareRelayStore } from "../../backend/src/share-store";
import {
  approveShareScopeV1, buildRecipientShareUrlV1, decryptShareSnapshotV1,
  encryptApprovedShareV1, parseRecipientShareLocationV1,
} from "../src/share/crypto";
import { BrowserShareRelayClient, ShareRelayClientError } from "../src/share/relay-client";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const fakeClient = { rawPlan: async () => "{}", rawRepair: async () => "{}" };

describe("F1 encrypted share security vertical", () => {
  it("cannot leak a hidden field or an unapproved file through projection, wire, relay, or recipient", async () => {
    const store = await ClayStore.openMemory();
    try {
      const create: ForwardOpT[] = [{ op: "create_table", table: "reports", columns: [
        { name: "title", label: "Customer result", type: "text", required: true },
        { name: "secret", label: "Internal secret", type: "text", required: false },
        { name: "files", label: "Files", type: "attachment", required: false },
      ] }];
      store.commit({ intent: "security fixture", summary: "Create report.", migration: {
        operations: create, inverse: deriveInverse(create, store.registrySnapshot()),
      } });
      const row = store.insert("reports", {
        title: "Approved result", secret: "HIDDEN_FIELD_SECRET",
      });
      const approvedMeta = await store.addAttachment({
        table: "reports", rowId: String(row.id), field: "files",
        name: "approved.txt", mime: "text/plain",
        bytes: new TextEncoder().encode("APPROVED_FILE_BYTES"),
      });
      const privateMeta = await store.addAttachment({
        table: "reports", rowId: String(row.id), field: "files",
        name: "private.txt", mime: "text/plain",
        bytes: new TextEncoder().encode("UNAPPROVED_FILE_SECRET"),
      });
      const hide: ForwardOpT[] = [{ op: "hide_column", table: "reports", column: "secret" }];
      store.commit({ intent: "hide internal data", summary: "Hide secret.", migration: {
        operations: hide, inverse: deriveInverse(hide, store.registrySnapshot()),
      } });

      const trace = store.semanticSchemaTrace();
      const table = trace.tables.find(item => item.name === "reports")!;
      const title = trace.fields.find(item => item.tableId === table.tableId
        && item.fieldName === "title")!;
      const secret = trace.fields.find(item => item.tableId === table.tableId
        && item.fieldName === "secret")!;
      const files = trace.fields.find(item => item.tableId === table.tableId
        && item.fieldName === "files")!;
      const request: ProjectionRequestV1 = {
        schema: 1,
        kind: "record",
        expectedSchemaVersion: trace.atVersion,
        tableId: table.tableId,
        fieldIds: [title.fieldId],
        recordId: String(row.id),
        options: { includeRecordIds: false, redactedFieldIds: [] },
      };
      expect(() => projectPlaintextV1(store, {
        ...request, fieldIds: [title.fieldId, secret.fieldId],
      })).toThrow(/hidden|stale|available/i);

      const artifact = await projectPlaintextV1(store, request);
      expect(new TextDecoder().decode(artifact.plaintext)).not.toContain("HIDDEN_FIELD_SECRET");
      const source = {
        tableId: table.tableId,
        fieldId: files.fieldId,
        recordId: String(row.id),
      };
      const approved = { ...await store.readAttachment(approvedMeta.id), source };
      const unapproved = { ...await store.readAttachment(privateMeta.id), source };
      const approval = await approveShareScopeV1(
        request, [approved], artifact, new Date(NOW));
      await expect(encryptApprovedShareV1({
        approval,
        request,
        artifact,
        attachments: [approved, unapproved],
        expiresAt: "2026-09-08T12:00:00.000Z",
      })).rejects.toThrow(/attachment.*allowlist|approved/i);

      const encrypted = await encryptApprovedShareV1({
        approval,
        request,
        artifact,
        attachments: [approved],
        expiresAt: "2026-09-08T12:00:00.000Z",
      });
      const relayStore = new MemoryShareRelayStore();
      const app = ownedRelayApp({
        apiKey: "sk-test", makeClient: () => fakeClient,
        shares: relayStore, now: () => NOW,
      });
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        await app.request(String(input), init));
      const relay = new BrowserShareRelayClient("https://relay.example", null, fetcher);
      await relay.create(encrypted.request);

      const persisted = JSON.stringify(relayStore.inspectForTests(encrypted.request.shareId));
      expect(persisted).not.toContain("Approved result");
      expect(persisted).not.toContain("HIDDEN_FIELD_SECRET");
      expect(persisted).not.toContain("APPROVED_FILE_BYTES");
      expect(persisted).not.toContain("UNAPPROVED_FILE_SECRET");
      expect(persisted).not.toContain(encrypted.key);
      expect(persisted).not.toContain("plaintext");

      const href = buildRecipientShareUrlV1({
        viewerOrigin: "https://clay.example",
        relayBaseUrl: relay.baseUrl,
        shareId: encrypted.request.shareId,
        key: encrypted.key,
      });
      const capability = parseRecipientShareLocationV1(href);
      const snapshot = await relay.read(capability.shareId);
      const decrypted = await decryptShareSnapshotV1(snapshot, capability.key);
      expect(decrypted.projection.rows).toEqual([["Approved result"]]);
      expect(decrypted.projection.manifest.fields.map(field => field.name)).toEqual(["title"]);
      expect(decrypted.attachments.map(file => file.id)).toEqual([approvedMeta.id]);
      expect(JSON.stringify(decrypted)).not.toContain("HIDDEN_FIELD_SECRET");
      expect(JSON.stringify(decrypted)).not.toContain("UNAPPROVED_FILE_SECRET");

      const readCall = fetcher.mock.calls.find(([, init]) => init?.method === "GET")!;
      expect(String(readCall[0])).toBe(
        `https://relay.example/shares/${encrypted.request.shareId}`,
      );
      expect(JSON.stringify(readCall)).not.toContain(encrypted.key);

      await relay.revoke(encrypted.request.shareId, encrypted.revokeToken);
      await expect(relay.read(encrypted.request.shareId)).rejects
        .toMatchObject({ code: "revoked", status: 410 });
    } finally { store.close(); }
  });
});
