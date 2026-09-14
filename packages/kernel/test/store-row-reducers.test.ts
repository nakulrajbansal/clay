import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { at, source, pair, outcome, physical, type Fixture } from "./store-reducer-fixture";
import { prepareExistingTableImport, type CommitExistingImportInput } from "../src/import-journey";
import { executeCapturedAttachmentAdd } from "../src/store";
import { executeCapturedAttachmentAdd as originalAttachmentAdd } from "./oracles/store";
import { sha256HexSync } from "../src/state-digest";
import type { LocalIntakeFormV2, IntakeSubmissionPlaintextV1 } from "@clay/schema/intake";

let base: Awaited<ReturnType<typeof source>>;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at); base = await source(); });
afterAll(() => { base?.store.close(); vi.useRealTimers(); });
const receiptId = "018f0000-0000-7000-8000-000000000011";
function prepare(f: Fixture, kind: "append" | "upsert" | "no_change"): CommitExistingImportInput {
  const prepared = prepareExistingTableImport({
    appInstanceId: `app_${"a".repeat(26)}`, sessionId: `import_${"b".repeat(26)}`,
    sourceKind: "csv", sourceDigest: `sha256:${"c".repeat(64)}`, baseVersion: f.store.headVersion(),
    target: f.store.registrySnapshot().get("items")!, existingRows: f.store.query({ from: "items" }),
    sourceRows: kind === "no_change" ? [["Name", "Score"], ["Original", "3"]]
      : [["Name", "Score"], ["Original", "12"], ["New", "7"], ["", ""]],
    header: { mode: "header", sourceRow: 1 }, mode: kind === "append" ? { kind } : { kind: "upsert", matchField: "name" },
    mappings: [{ sourceColumn: 1, targetField: "name" }, { sourceColumn: 2, targetField: "score" }],
  });
  expect(prepared.preview.commitAllowed).toBe(true);
  return { ...prepared.envelope, receiptId, summary: "  Reviewed import  " };
}
function stage(f: Fixture, withFiles = true) {
  const table = f.store.validationRegistrySnapshot().get("items")!;
  const name = table.columns.find(c => c.name === "name")!.semantic!.fieldId;
  const files = table.columns.find(c => c.name === "files")!.semantic!.fieldId;
  const form: LocalIntakeFormV2 = {
    schema: 2, publicForm: { schema: 1, formId: `form_${"a".repeat(26)}`, revision: 1, title: "Reviewed request", description: "Owned fixture",
      target: { tableId: table.semantic!.tableId, expectedSchemaVersion: f.store.currentVersion() },
      fields: [{ fieldId: name, label: "Name", type: "text", required: true, maxLength: 100, options: [] }],
      fileRequests: withFiles ? [{ requestId: "supporting_document", fieldId: files, label: "Document", required: true,
        maxFiles: 2, maxBytes: 1000000, allowedMimeTypes: ["text/plain"] }] : [],
      encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: "A".repeat(87) },
      delivery: { expiresAt: "2026-10-01T00:00:00.000Z" } },
    ownerSource: { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0" },
    terminalReason: null, relayBaseUrl: "https://relay.example.test", publishedAt: new Date(at).toISOString(), revokedAt: null,
  };
  const bytes = new TextEncoder().encode("Owned passive fixture text");
  const submission: IntakeSubmissionPlaintextV1 = { schema: 1, formId: form.publicForm.formId,
    formRevision: 1, submissionId: `sub_${"c".repeat(26)}`, submittedAt: new Date(at).toISOString(),
    values: [{ fieldId: name, value: "Reviewed intake" }], files: withFiles ? ["d", "e"].map(letter => ({
      requestId: "supporting_document", uploadId: `upl_${letter.repeat(26)}`, name: `document-${letter}.txt`, mime: "text/plain",
      size: bytes.length, sha256: sha256HexSync(bytes), bytes: Buffer.from(bytes).toString("base64url"),
    })) : [] };
  f.store.saveIntakeForm(form); f.store.stageIntakeSubmission(submission);
  return { form, submission, name };
}

describe("frozen Store row/receipt reducer parity", () => {
  for (const kind of ["append", "upsert", "no_change"] as const) it(`import ${kind}: exact preparation, Keep, receipt/replay, Undo and reload`, async () => {
    const result = await pair(base.driver, f => {
      const input = prepare(f, kind), before = physical(f.driver);
      const first = f.write(() => f.store.commitImport(input));
      const repeat = f.write(() => f.store.commitImport(input));
      const after = physical(f.driver);
      const undo = first.kind === "receipt" ? f.write(() => f.store.undoImport(first.id)) : null;
      const reopened = f.reopen();
      return { input, before, first, repeat, after, undo, readback: reopened.importReceipt(receiptId), batches: reopened.operationBatches() };
    }) as any;
    expect(result.repeat).toEqual(result.first);
    if (kind === "no_change") { expect(result.after).toEqual(result.before); expect(result.readback).toBeNull(); }
    else { expect(result.first.kind).toBe("receipt"); expect(result.undo.undone).toBe(true); expect(result.readback).toEqual(result.undo); }
  });
  it("import conflicting identity, stale target, invalid envelope and dispositions preserve error order", async () => {
    const result = await pair(base.driver, f => {
      const input = prepare(f, "upsert");
      const row = f.store.query({ from: "items" })[0]!;
      f.write(() => f.store.update("items", String(row.id), { score: 90 }));
      const stale = outcome(() => f.write(() => f.store.commitImport(input)));
      const refreshed = prepare(f, "upsert"); f.write(() => f.store.commitImport(refreshed));
      return { stale, collision: outcome(() => f.write(() => f.store.commitImport({ ...refreshed, previewDigest: `sha256:${"f".repeat(64)}` }))),
        invalid: outcome(() => f.write(() => f.store.commitImport({ ...input, receiptId: "018f0000-0000-7000-8000-000000000012", summary: "", sessionId: "bad" }))) };
    }) as any;
    expect(result.stale.code).toBe("E_CONFLICT"); expect(result.collision.code).toBe("E_CONFLICT"); expect(result.invalid.code).toBe("E_VALIDATION");
  });
  for (const marker of ['INSERT INTO "items"', "INSERT INTO sys.operation_batches", "INSERT INTO sys.settings"])
    it(`import failure at ${marker} rolls back exact rows/history/receipt and retries`, async () => {
      const result = await pair(base.driver, f => {
        const input = prepare(f, "append"), before = physical(f.driver);
        f.fault.match = sql => sql.includes(marker);
        const failed = outcome(() => f.write(() => f.store.commitImport(input))), after = physical(f.driver);
        const retry = f.write(() => f.store.commitImport(input));
        return { before, failed, after, retry, hit: f.fault.hit };
      }) as any;
      expect(result.hit).toBe(1); expect(result.failed.ok).toBe(false); expect(result.after).toEqual(result.before); expect(result.retry.kind).toBe("receipt");
    });
  for (const batchSource of ["user", "automation", "import"] as const)
    it(`batch ${batchSource} keeps independent empty/no-op and terminal receipt policies`, async () => {
      const result = await pair(base.driver, f => f.write(() => {
        const empty = outcome(() => f.store.applyBatch({ source: batchSource, summary: "Empty", mutations: [] }));
        const noChange = f.store.applyBatch({ source: batchSource, summary: "Unchanged", mutations: [{ kind: "update", table: "items",
          id: String(f.store.query({ from: "items" })[0]!.id), patch: { name: "Original" } }] });
        const batch = f.store.applyBatch({ source: batchSource, summary: "Add", mutations: [{ kind: "insert", table: "people", row: { name: "Batch record" } }] });
        const undo = f.store.undoBatch(batch.id);
        return { empty, noChange, batch, undo, batches: f.store.operationBatches() };
      })) as any;
      expect(result.empty.code).toBe("E_LIMIT"); expect(result.noChange.undone).toBe(true); expect(result.batch.undone).toBe(false); expect(result.undo.undone).toBe(true);
      expect(result.batches).toHaveLength(1);
    });
  for (const action of ["keep", "undo"] as const) it(`import ${action} failed durable readback restores prior history and receipt`, async () => {
    const result = await pair(base.driver, f => {
      const input = prepare(f, "upsert");
      if (action === "undo") f.write(() => f.store.commitImport(input));
      const before = physical(f.driver); let reads = 0;
      f.fault.readMatch = (sql, params) => sql.includes("sys.settings")
        && params?.[0] === `operation_receipt_import_v1:${receiptId}` && ++reads === 2;
      const invoke = () => action === "keep" ? f.store.commitImport(input) : f.store.undoImport(receiptId);
      const failed = outcome(() => f.write(invoke)), after = physical(f.driver);
      return { before, failed, after, retry: f.write(invoke), hit: f.fault.hit };
    }) as any;
    expect(result.hit).toBe(1); expect(result.failed.ok).toBe(false); expect(result.after).toEqual(result.before);
    expect(result.retry.kind).toBe("receipt"); expect(result.retry.undone).toBe(action === "undo");
  });
  for (const approvedCount of [1, 2]) it(`intake accepts ${approvedCount} reviewed attachments, retains rejected evidence, Undo and reload`, async () => {
    const result = await pair(base.driver, async f => {
      const receipts = f.write(() => {
        const { submission } = stage(f);
        const receipt = f.store.acceptIntakeSubmission({ submissionId: submission.submissionId, mode: "manual",
          approvedFileIds: submission.files.slice(0, approvedCount).map(file => file.uploadId) });
        return { receipt, inbox: f.store.intakeInbox() };
      });
      const files = await Promise.all(receipts.receipt.attachmentIds.map(id => f.store.readAttachment(id)));
      const undone = f.write(() => f.store.undoIntakeReceipt(receipts.receipt.id));
      return { ...receipts, files, undone, reloaded: f.reopen().intakeInbox() };
    }) as any;
    expect(result.files).toHaveLength(approvedCount); expect(result.undone.undone).toBe(true);
    expect(result.reloaded[0].status).toBe("pending");
  });
  for (const marker of ['INSERT INTO "__clay_attachments"', "INSERT INTO sys.operation_batches", "INSERT INTO sys.settings"])
    it(`intake failure at ${marker} rolls back canonical row, files, history and receipt`, async () => {
      const result = await pair(base.driver, f => {
        const { submission } = f.write(() => stage(f)), before = physical(f.driver);
        const input = { submissionId: submission.submissionId, mode: "manual" as const, approvedFileIds: submission.files.map(file => file.uploadId) };
        f.fault.match = sql => sql.includes(marker);
        const failed = outcome(() => f.write(() => f.store.acceptIntakeSubmission(input))), after = physical(f.driver);
        return { before, failed, after, retry: f.write(() => f.store.acceptIntakeSubmission(input)), hit: f.fault.hit };
      }) as any;
      expect(result.hit).toBe(1); expect(result.failed.ok).toBe(false); expect(result.after).toEqual(result.before); expect(result.retry.undone).toBe(false);
    });
  it("intake automatic simulation/control shares only the fixed row/receipt writer", async () => {
    const result = await pair(base.driver, f => f.write(() => {
      const { form, name } = stage(f, false);
      const draft = { schema: 1 as const, formId: form.publicForm.formId, formRevision: 1,
        expectedSchemaVersion: f.store.currentVersion(), conditions: [{ fieldId: name, op: "equals" as const, value: "Reviewed intake" }] };
      const simulation = f.store.simulateIntakeAutoAccept(draft);
      f.store.enableIntakeAutoAccept({ draft, simulationFingerprint: simulation.fingerprint });
      const receipts = f.store.processIntakeAutoAccept(form.publicForm.formId);
      return { receipts, repeat: f.store.processIntakeAutoAccept(form.publicForm.formId) };
    })) as any;
    expect(result.receipts).toHaveLength(1); expect(result.repeat).toEqual([]);
  });
  it("direct captured attachment add preserves byte digest, history/event and exact readback", async () => {
    await pair(base.driver, async f => {
      const bytes = new TextEncoder().encode("Owned attachment fixture");
      const input = { table: "items", rowId: String(f.store.query({ from: "items" })[0]!.id), field: "files", name: "../document.txt", mime: "text/plain", bytes };
      const digest = sha256HexSync(bytes);
      const added = f.write(() => f.old ? originalAttachmentAdd(f.store as Parameters<typeof originalAttachmentAdd>[0], input, digest)
        : executeCapturedAttachmentAdd(f.store as Parameters<typeof executeCapturedAttachmentAdd>[0], input, digest));
      return { added, file: await f.store.readAttachment(added.id) };
    });
  });
  it("has single fixed-table attachment and operation receipt inserts, not repeated SQL or raw commands", () => {
    const text = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
    expect(text.match(/INSERT INTO sys\.operation_batches\(/g)).toHaveLength(1);
    expect(text.match(/INSERT INTO "__clay_attachments"\(/g)).toHaveLength(1);
  });
});
