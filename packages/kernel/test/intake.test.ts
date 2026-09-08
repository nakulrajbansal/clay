import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type {
  IntakeSubmissionPlaintextV1,
  LocalIntakeFormV1,
  PublicIntakeFormV1,
} from "@clay/schema/intake";
import { ClayStore, deriveInverse, type ForwardOpT } from "../src/index";

async function intakeStore(): Promise<{
  store: ClayStore;
  form: LocalIntakeFormV1;
  nameFieldId: string;
  fileFieldId: string;
}> {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{
    op: "create_table",
    table: "requests",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "priority", type: "enum", required: false, values: ["normal", "urgent"] },
      { name: "files", type: "attachment", required: false },
    ],
  }];
  store.commit({
    intent: "intake target",
    summary: "Adds requests.",
    semanticOrigin: "direct",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
  const table = store.validationRegistrySnapshot().get("requests")!;
  const name = table.columns.find(column => column.name === "name")!;
  const files = table.columns.find(column => column.name === "files")!;
  const publicForm: PublicIntakeFormV1 = {
    schema: 1,
    formId: "form_abcdefghijklmnopqrstuvwxyz",
    revision: 1,
    title: "Customer request",
    description: "Send a request securely.",
    target: {
      tableId: table.semantic!.tableId,
      expectedSchemaVersion: store.currentVersion(),
    },
    fields: [{
      fieldId: name.semantic!.fieldId,
      label: "Name",
      type: "text",
      required: true,
      maxLength: 100,
      options: [],
    }],
    fileRequests: [{
      requestId: "supporting_document",
      fieldId: files.semantic!.fieldId,
      label: "Supporting document",
      required: true,
      maxFiles: 1,
      maxBytes: 1_000_000,
      allowedMimeTypes: ["text/plain", "application/pdf"],
    }],
    encryption: {
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
      ownerPublicKey: "A".repeat(87),
    },
    delivery: {
      submitToken: "s".repeat(43),
      expiresAt: "2026-10-01T00:00:00.000Z",
    },
  };
  const form: LocalIntakeFormV1 = {
    schema: 1,
    publicForm,
    ownerPrivateKey: "A".repeat(184),
    ownerToken: "o".repeat(43),
    relayBaseUrl: "https://relay.example.test",
    publishedAt: "2026-09-07T11:00:00.000Z",
    revokedAt: null,
  };
  return {
    store,
    form,
    nameFieldId: name.semantic!.fieldId,
    fileFieldId: files.semantic!.fieldId,
  };
}

function safeSubmission(nameFieldId: string): IntakeSubmissionPlaintextV1 {
  const bytes = new TextEncoder().encode("A passive plain-text document");
  return {
    schema: 1,
    formId: "form_abcdefghijklmnopqrstuvwxyz",
    formRevision: 1,
    submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
    submittedAt: "2026-09-07T12:00:00.000Z",
    values: [{ fieldId: nameFieldId, value: "Ada Lovelace" }],
    files: [{
      requestId: "supporting_document",
      uploadId: "upl_abcdefghijklmnopqrstuvwxyz",
      name: "request.txt",
      mime: "text/plain",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: Buffer.from(bytes).toString("base64url"),
    }],
  };
}

describe("trusted local intake review and acceptance", () => {
  it("stages without canonical writes, manually activates reviewed files atomically, and undoes the receipt", async () => {
    const { store, form, nameFieldId } = await intakeStore();
    try {
      store.saveIntakeForm(form);
      const staged = store.stageIntakeSubmission(safeSubmission(nameFieldId));
      expect(staged).toMatchObject({
        status: "pending",
        submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
        files: [{ status: "quarantined", uploadId: "upl_abcdefghijklmnopqrstuvwxyz" }],
      });
      expect(store.query({ from: "requests" })).toEqual([]);

      const receipt = store.acceptIntakeSubmission({
        submissionId: staged.submissionId,
        mode: "manual",
        approvedFileIds: ["upl_abcdefghijklmnopqrstuvwxyz"],
      });
      expect(receipt).toMatchObject({ mode: "manual", undone: false });
      const row = store.query({ from: "requests" })[0]!;
      expect(row.name).toBe("Ada Lovelace");
      expect(row.files).toHaveLength(1);
      await expect(store.readAttachment((row.files as string[])[0]!)).resolves.toMatchObject({
        name: "request.txt",
        mime: "text/plain",
      });
      expect(store.intakeInbox()[0]).toMatchObject({ status: "accepted", receiptId: receipt.id });

      const undone = store.undoIntakeReceipt(receipt.id);
      expect(undone.undone).toBe(true);
      expect(store.query({ from: "requests" })).toEqual([]);
      await expect(store.readAttachment((row.files as string[])[0]!)).rejects.toThrow(/not found/i);
      expect(store.intakeInbox()[0]).toMatchObject({
        status: "pending",
        files: [{ status: "quarantined" }],
      });
      await expect(store.exportArchive("after intake undo")).resolves.toBeInstanceOf(Uint8Array);
    } finally { store.close(); }
  });

  it("quarantines and blocks PDF active content even when its name is hex-escaped", async () => {
    const { store, form, nameFieldId } = await intakeStore();
    try {
      store.saveIntakeForm(form);
      const submission = safeSubmission(nameFieldId);
      const bytes = new TextEncoder().encode(
        "%PDF-1.7\n1 0 obj << /J#61vaScript (app.alert('owned')) >>\n%%EOF",
      );
      submission.files[0] = {
        ...submission.files[0]!,
        name: "request.pdf",
        mime: "application/pdf",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: Buffer.from(bytes).toString("base64url"),
      };
      const staged = store.stageIntakeSubmission(submission);
      expect(staged.status).toBe("blocked");
      expect(staged.files[0]).toMatchObject({ status: "rejected" });
      expect(staged.validationErrors.join(" ")).toMatch(/pdf.*not accepted/i);
      expect(() => store.acceptIntakeSubmission({
        submissionId: staged.submissionId,
        mode: "manual",
        approvedFileIds: [submission.files[0]!.uploadId],
      })).toThrow(/pending validated/i);
      expect(store.query({ from: "requests" })).toEqual([]);
      expect(store.intakeReceipts()).toEqual([]);
    } finally { store.close(); }
  });

  it("rejects compressed PDF action streams instead of treating a partial scan as passive", async () => {
    const { store, form, nameFieldId } = await intakeStore();
    try {
      store.saveIntakeForm(form);
      const submission = safeSubmission(nameFieldId);
      const bytes = Buffer.concat([
        Buffer.from("%PDF-1.7\n1 0 obj << /Filter /FlateDecode >>\nstream\n", "ascii"),
        deflateSync(Buffer.from("/JavaScript (app.alert('owned'))", "ascii")),
        Buffer.from("\nendstream\nendobj\n%%EOF", "ascii"),
      ]);
      submission.files[0] = {
        ...submission.files[0]!,
        name: "request.pdf",
        mime: "application/pdf",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.toString("base64url"),
      };
      const staged = store.stageIntakeSubmission(submission);
      expect(staged.status).toBe("blocked");
      expect(staged.files[0]).toMatchObject({ status: "rejected" });
      expect(staged.validationErrors.join(" ")).toMatch(/pdf.*not accepted|unsupported.*pdf/i);
    } finally { store.close(); }
  });

  it("releases quarantined bytes on terminal rejection while retaining bounded audit metadata", async () => {
    const { store, form, nameFieldId } = await intakeStore();
    try {
      store.saveIntakeForm(form);
      const submission = safeSubmission(nameFieldId);
      const encodedBytes = submission.files[0]!.bytes;
      const staged = store.stageIntakeSubmission(submission);
      expect(JSON.stringify(store.getSetting("intake_v1"))).toContain(encodedBytes);
      const rejected = store.rejectIntakeSubmission(staged.submissionId);
      expect(rejected.status).toBe("rejected");
      const persisted = JSON.stringify(store.getSetting("intake_v1"));
      expect(persisted).not.toContain(encodedBytes);
      expect(persisted).toContain(submission.files[0]!.sha256);
    } finally { store.close(); }
  });

  it("persists only opaque failed-delivery evidence before owner-authorized discard", async () => {
    const { store, form } = await intakeStore();
    try {
      store.saveIntakeForm(form);
      const recordFailure = Reflect.get(store, "recordIntakeDeliveryFailure") as
        ((input: Record<string, unknown>) => unknown) | undefined;
      const authorizeDiscard = Reflect.get(store, "authorizeIntakeDeliveryDiscard") as
        ((formId: string, submissionId: string, at: string) => unknown) | undefined;
      expect(typeof recordFailure).toBe("function");
      expect(typeof authorizeDiscard).toBe("function");
      const failure = recordFailure!.call(store, {
        formId: form.publicForm.formId,
        submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
        envelopeSha256: "a".repeat(64),
      }) as { status: string };
      expect(failure.status).toBe("failed");
      expect(JSON.stringify(store.getSetting("intake_v1"))).not.toContain("ciphertext");
      expect((authorizeDiscard!.call(
        store, form.publicForm.formId, "sub_abcdefghijklmnopqrstuvwxyz",
        "2026-09-07T12:00:00.000Z",
      ) as { status: string }).status).toBe("discard_authorized");
    } finally { store.close(); }
  });

  it("requires a persisted deterministic simulation before separately enabling auto-accept", async () => {
    const { store, form, nameFieldId } = await intakeStore();
    try {
      const noFiles: LocalIntakeFormV1 = {
        ...form,
        publicForm: { ...form.publicForm, fileRequests: [] },
      };
      store.saveIntakeForm(noFiles);
      const ada = { ...safeSubmission(nameFieldId), files: [] };
      const grace: IntakeSubmissionPlaintextV1 = {
        ...ada,
        submissionId: "sub_bcdefghijklmnopqrstuvwxyza",
        values: [{ fieldId: nameFieldId, value: "Grace Hopper" }],
      };
      store.stageIntakeSubmission(ada);
      store.stageIntakeSubmission(grace);
      expect(store.query({ from: "requests" })).toEqual([]);

      const draft = {
        schema: 1 as const,
        formId: noFiles.publicForm.formId,
        formRevision: noFiles.publicForm.revision,
        expectedSchemaVersion: noFiles.publicForm.target.expectedSchemaVersion,
        conditions: [{ fieldId: nameFieldId, op: "equals" as const, value: "Ada Lovelace" }],
      };
      const simulation = store.simulateIntakeAutoAccept(draft);
      expect(simulation).toMatchObject({
        pendingCount: 2,
        matchedSubmissionIds: [ada.submissionId],
      });
      expect(() => store.enableIntakeAutoAccept({
        draft,
        simulationFingerprint: "0".repeat(64),
      })).toThrow(/simulation/i);
      const rule = store.enableIntakeAutoAccept({
        draft,
        simulationFingerprint: simulation.fingerprint,
      });
      expect(rule.enabled).toBe(true);
      expect(store.query({ from: "requests" })).toEqual([]);

      const receipts = store.processIntakeAutoAccept(noFiles.publicForm.formId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ mode: "auto", submissionId: ada.submissionId });
      expect(store.query({ from: "requests", select: ["name"] })).toEqual([
        { name: "Ada Lovelace" },
      ]);
      expect(store.intakeInbox().find(item => item.submissionId === grace.submissionId)?.status)
        .toBe("pending");
    } finally { store.close(); }
  });

  it("rolls back row, file, and receipt together if the final trusted-state write fails", async () => {
    const { store, form, nameFieldId } = await intakeStore();
    try {
      store.saveIntakeForm(form);
      const submission = safeSubmission(nameFieldId);
      store.stageIntakeSubmission(submission);
      const original = store.setSetting.bind(store);
      const mutable = store as unknown as { setSetting(key: string, value: unknown): void };
      mutable.setSetting = (key, value): void => {
        if (key === "intake_v1") throw new Error("injected receipt write failure");
        original(key, value);
      };
      expect(() => store.acceptIntakeSubmission({
        submissionId: submission.submissionId,
        mode: "manual",
        approvedFileIds: [submission.files[0]!.uploadId],
      })).toThrow(/injected receipt write failure/);
      mutable.setSetting = original;
      expect(store.query({ from: "requests" })).toEqual([]);
      expect(store.attachmentStorage()).toMatchObject({ activeFiles: 0, activeBytes: 0 });
      expect(store.intakeReceipts()).toEqual([]);
      expect(store.intakeInbox()[0]?.status).toBe("pending");
    } finally { store.close(); }
  });

  it("refuses undo after a conflicting canonical edit and leaves the activation intact", async () => {
    const { store, form, nameFieldId } = await intakeStore();
    try {
      store.saveIntakeForm(form);
      const submission = safeSubmission(nameFieldId);
      store.stageIntakeSubmission(submission);
      const receipt = store.acceptIntakeSubmission({
        submissionId: submission.submissionId,
        mode: "manual",
        approvedFileIds: [submission.files[0]!.uploadId],
      });
      store.update("requests", receipt.rowId, { name: "Changed locally" });
      expect(() => store.undoIntakeReceipt(receipt.id)).toThrow(/changed after/i);
      expect((await store.readAttachment(receipt.attachmentIds[0]!)).bytes.byteLength).toBeGreaterThan(0);
      expect(store.intakeReceipts()[0]?.undoneAt).toBeNull();
      expect(store.query({ from: "requests", select: ["name"] })).toEqual([
        { name: "Changed locally" },
      ]);
    } finally { store.close(); }
  });
});
