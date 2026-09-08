import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../backend/src/app";
import { MemoryIntakeRelayStore } from "../../backend/src/intake-relay";
import { ClayStore, deriveInverse, type ForwardOpT } from "@clay/kernel";
import { fetchAndStageIntake } from "../src/intake/client";
import {
  decryptIntakeSubmission, encryptIntakeSubmission, generateIntakeOwnerKeyPair,
} from "../src/intake/crypto";

describe("F2 intake vertical", () => {
  it("encrypts publicly, relays no plaintext, stages locally, accepts atomically, and undoes", async () => {
    const store = await ClayStore.openMemory();
    try {
      const operations: ForwardOpT[] = [{
        op: "create_table",
        table: "requests",
        columns: [
          { name: "name", type: "text", required: true },
          { name: "files", type: "attachment", required: false },
        ],
      }];
      store.commit({
        intent: "create intake target", summary: "Created intake target.", semanticOrigin: "direct",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      });
      const table = store.validationRegistrySnapshot().get("requests")!;
      const field = table.columns.find(column => column.name === "name")!;
      const fileField = table.columns.find(column => column.name === "files")!;
      const keys = await generateIntakeOwnerKeyPair();
      const form = {
        schema: 1 as const,
        formId: "form_abcdefghijklmnopqrstuvwxyz",
        revision: 1,
        title: "Customer request",
        description: "Tell us what you need.",
        target: { tableId: table.semantic!.tableId, expectedSchemaVersion: store.currentVersion() },
        fields: [{
          fieldId: field.semantic!.fieldId, label: "Name", type: "text" as const,
          required: true, maxLength: 100, options: [],
        }],
        fileRequests: [{
          requestId: "document",
          fieldId: fileField.semantic!.fieldId,
          label: "Document",
          required: true,
          maxFiles: 1,
          maxBytes: 1024,
          allowedMimeTypes: ["text/plain" as const],
        }],
        encryption: {
          algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const,
          ownerPublicKey: keys.publicKey,
        },
        delivery: {
          submitToken: "s".repeat(43), expiresAt: "2026-10-01T00:00:00.000Z",
        },
      };
      const ownerToken = "o".repeat(43);
      const localForm = {
        schema: 1 as const, publicForm: form, ownerPrivateKey: keys.privateKey, ownerToken,
        relayBaseUrl: "https://relay.example.test", publishedAt: "2026-09-07T12:00:00.000Z",
        revokedAt: null,
      };
      store.saveIntakeForm(localForm);

      const relayStore = new MemoryIntakeRelayStore({ now: () => Date.parse("2026-09-07T12:00:00.000Z") });
      const app = createApp({ intakeRelay: relayStore });
      expect((await app.request("/intake/forms", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: 1, formId: form.formId, ownerToken,
          submitToken: form.delivery.submitToken, expiresAt: form.delivery.expiresAt,
          maxCiphertextBytes: 4096,
        }),
      })).status).toBe(201);

      const fileBytes = new TextEncoder().encode("passive receipt");
      const submission = {
        schema: 1 as const,
        formId: form.formId,
        formRevision: form.revision,
        submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
        submittedAt: "2026-09-07T12:01:00.000Z",
        values: [{ fieldId: field.semantic!.fieldId, value: "Ada Lovelace" }],
        files: [{
          requestId: "document",
          uploadId: "upl_abcdefghijklmnopqrstuvwxyz",
          name: "receipt.txt",
          mime: "text/plain" as const,
          size: fileBytes.byteLength,
          sha256: createHash("sha256").update(fileBytes).digest("hex"),
          bytes: Buffer.from(fileBytes).toString("base64url"),
        }],
      };
      const encrypted = await encryptIntakeSubmission(form, submission);
      const posted = await app.request(`/intake/forms/${form.formId}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${form.delivery.submitToken}` },
        body: JSON.stringify(encrypted),
      });
      expect(posted.status).toBe(201);

      const delivered = await app.request(`/intake/forms/${form.formId}/submissions`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      const wire = await delivered.text();
      expect(wire).not.toContain("Ada Lovelace");
      expect(wire).not.toContain("receipt.txt");
      const body = JSON.parse(wire) as { items: Array<{ submissionId: string; envelope: typeof encrypted.envelope }> };
      expect(body.items).toHaveLength(1);
      const plaintext = await decryptIntakeSubmission(form, keys.privateKey, {
        schema: 1, submissionId: body.items[0]!.submissionId, envelope: body.items[0]!.envelope,
      });
      expect(plaintext.values[0]?.value).toBe("Ada Lovelace");
      const stagedItems = await fetchAndStageIntake({
        stageIntakeSubmission: async input => store.stageIntakeSubmission(input),
        intakeDeliveryFailures: async () => store.intakeDeliveryFailures(),
        recordIntakeDeliveryFailure: async input => store.recordIntakeDeliveryFailure(input),
        authorizeIntakeDeliveryDiscard: async (formId, submissionId, at) =>
          store.authorizeIntakeDeliveryDiscard(formId, submissionId, at),
        resolveIntakeDeliveryFailure: async (formId, submissionId, resolution, at) =>
          store.resolveIntakeDeliveryFailure(formId, submissionId, resolution, at),
      }, localForm, async (input, init) => app.request(String(input), init));
      expect(stagedItems).toHaveLength(1);
      const staged = stagedItems[0]!;
      expect(staged.status).toBe("pending");
      expect(staged.files).toEqual([expect.objectContaining({ status: "quarantined" })]);
      expect(store.query({ from: "requests" })).toEqual([]);
      const receipt = store.acceptIntakeSubmission({
        submissionId: staged.submissionId, mode: "manual",
        approvedFileIds: [submission.files[0]!.uploadId],
      });
      expect(store.query({ from: "requests", select: ["name"] })).toEqual([{ name: "Ada Lovelace" }]);
      expect((await store.readAttachment(receipt.attachmentIds[0]!)).bytes).toEqual(fileBytes);
      store.undoIntakeReceipt(receipt.id);
      expect(store.query({ from: "requests" })).toEqual([]);
      await expect(store.readAttachment(receipt.attachmentIds[0]!)).rejects.toThrow(/not found/i);
    } finally { store.close(); }
  });
});
