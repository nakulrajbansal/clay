import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type ForwardOpT, type QueryRow, type RegTable } from "../src/index";
import {
  importValueFingerprint,
  inferImportColumns,
  prepareExistingTableImport,
} from "../src/import-journey";

const APP_ID = `app_${"a".repeat(26)}`;
const SESSION_ID = `import_${"b".repeat(26)}`;
const SOURCE_DIGEST = `sha256:${"c".repeat(64)}`;
const FIRST_ID = "018f0000-0000-7000-8000-000000000001";
const SAME_ID = "018f0000-0000-7000-8000-000000000002";

const contacts: RegTable = {
  name: "contacts",
  columns: [
    { name: "email", label: "Email", type: "text", required: true },
    { name: "name", label: "Name", type: "text", required: true },
    { name: "score", label: "Score", type: "number", required: false },
  ],
};

const existingRows: QueryRow[] = [
  { id: FIRST_ID, email: "a@example.com", name: "Old name", score: 5 },
  { id: SAME_ID, email: "same@example.com", name: "Same", score: 3 },
];

async function contactStore(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "contacts", columns: [
    { name: "email", label: "Email", type: "text", required: true },
    { name: "name", label: "Name", type: "text", required: true },
    { name: "score", label: "Score", type: "number", required: false },
  ] }];
  store.commit({
    intent: "contacts", summary: "Contacts.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
  store.insert("contacts", { email: "a@example.com", name: "Old name", score: 5 });
  store.insert("contacts", { email: "same@example.com", name: "Same", score: 3 });
  return store;
}

describe("Release C existing-table import preparation", () => {
  it("rejects non-canonical values before fingerprinting a prepared mutation", () => {
    expect(() => importValueFingerprint({ score: Number.NaN })).toThrow(/finite/i);
    expect(() => importValueFingerprint({ name: undefined })).toThrow(/canonical JSON/i);
  });

  it("C-FR-004 keeps a no-header import within the 5,000-data-row ceiling", () => {
    expect(() => prepareExistingTableImport({
      appInstanceId: APP_ID,
      sessionId: SESSION_ID,
      sourceKind: "paste",
      sourceDigest: SOURCE_DIGEST,
      baseVersion: 7,
      sourceRows: Array.from({ length: 5_001 }, () => [""]),
      header: { mode: "no_header" },
      target: contacts,
      existingRows,
      mode: { kind: "append" },
      mappings: [{ sourceColumn: 1, targetField: "email" }],
    })).toThrow(expect.objectContaining({ code: "E_LIMIT" }));
  });

  it("C-FR-019/C-FR-020 derives exact create/update/skip totals and overlapping warnings from the complete range", () => {
    const prepared = prepareExistingTableImport({
      appInstanceId: APP_ID,
      sessionId: SESSION_ID,
      sourceKind: "csv",
      sourceDigest: SOURCE_DIGEST,
      baseVersion: 7,
      sourceRows: [
        ["Email", "Name", "Score"],
        ["a@example.com", " Alice ", "10"],
        ["new@example.com", "New", "2.5"],
        ["same@example.com", "Same", "3"],
        ["", "", ""],
      ],
      header: { mode: "header", sourceRow: 1 },
      target: contacts,
      existingRows,
      mode: { kind: "upsert", matchField: "email" },
      mappings: [
        { sourceColumn: 1, targetField: "email" },
        { sourceColumn: 2, targetField: "name" },
        { sourceColumn: 3, targetField: "score" },
      ],
    });

    expect(prepared.preview.sourceTotals).toEqual({
      sourceRows: 4,
      createRows: 1,
      updateRows: 1,
      skipRows: 2,
      blockedRows: 0,
      skipReasons: {
        above_header: 0,
        blank_row: 1,
        user_skipped: 0,
        duplicate_combined: 0,
        duplicate_skipped: 0,
        no_change: 1,
        unmapped_row: 0,
      },
    });
    expect(prepared.preview.mutationTotals).toEqual({
      primaryTargetCreates: 1,
      primaryTargetUpdates: 1,
      auxiliaryRelatedCreates: 0,
      changedCount: 2,
    });
    expect(prepared.preview.warningTotals).toEqual({
      warnings: 1,
      warningReasons: { trimmed_whitespace: 1, leading_zero_identifier: 0,
        enum_case_normalized: 0 },
    });
    expect(prepared.preview.commitAllowed).toBe(true);
    expect(prepared.preview.completion).toBe("commit");
    expect(prepared.envelope.mutations).toHaveLength(2);
    expect(prepared.envelope.mutations.find(mutation => mutation.kind === "update"))
      .toMatchObject({ rowId: FIRST_ID, patch: { name: "Alice", score: 10 } });
    expect(prepared.envelope.mutations.find(mutation => mutation.kind === "create"))
      .toMatchObject({ row: { email: "new@example.com", name: "New", score: 2.5 } });
  });

  it("C-FR-007/C-FR-010 exposes confirmed labels and deterministic complete-range type recommendations", () => {
    const inferred = inferImportColumns([
      ["Done", "Count", "Amount", "Due", "Status", "Reference"],
      ["yes", "1", "1.5", "2026-01-01", "open", "00123"],
      ["no", "2", "2.25", "2026-01-02", "done", "00456"],
      ["yes", "3", "3.75", "2026-01-03", "open", "00789"],
      ["no", "4", "4.5", "2026-01-04", "done", "00001"],
      ["yes", "5", "5.25", "2026-01-05", "open", "00002"],
      ["no", "6", "6.75", "2026-01-06", "done", "00003"],
    ], { mode: "header", sourceRow: 1 });

    expect(inferred.map(column => ({ label: column.label, type: column.inferredType })))
      .toEqual([
        { label: "Done", type: "boolean" },
        { label: "Count", type: "integer" },
        { label: "Amount", type: "number" },
        { label: "Due", type: "date" },
        { label: "Status", type: "enum" },
        { label: "Reference", type: "text" },
      ]);
    expect(inferred[4]).toMatchObject({
      confidence: "high", reasons: ["bounded_values", "low_distinct_ratio"],
      enumValues: ["open", "done"],
    });
    expect(inferImportColumns([["yes", "7"]], { mode: "no_header" }))
      .toMatchObject([
        { sourceColumn: 1, label: "Column 1", inferredType: "text" },
        { sourceColumn: 2, label: "Column 2", inferredType: "integer" },
      ]);
  });

  it("C-FR-017/C-FR-018 blocks invalid values and duplicate update keys before commit", () => {
    const prepared = prepareExistingTableImport({
      appInstanceId: APP_ID,
      sessionId: SESSION_ID,
      sourceKind: "paste",
      sourceDigest: SOURCE_DIGEST,
      baseVersion: 7,
      sourceRows: [
        ["Email", "Name", "Score"],
        ["same@example.com", "First", "not-a-number"],
        ["same@example.com", "Second", "4"],
      ],
      header: { mode: "header", sourceRow: 1 },
      target: contacts,
      existingRows,
      mode: { kind: "upsert", matchField: "email" },
      mappings: [
        { sourceColumn: 1, targetField: "email" },
        { sourceColumn: 2, targetField: "name" },
        { sourceColumn: 3, targetField: "score" },
      ],
    });

    expect(prepared.preview.sourceTotals).toMatchObject({
      sourceRows: 2, createRows: 0, updateRows: 0, skipRows: 0, blockedRows: 2,
    });
    expect(prepared.preview.commitAllowed).toBe(false);
    expect(prepared.envelope.mutations).toEqual([]);
    expect(prepared.preview.issues.map(issue => issue.code).sort())
      .toEqual(["duplicate_source_key", "invalid_value"]);
  });

  it("C-FR-014 treats blank update cells as leave-unchanged unless the mapping explicitly clears", () => {
    const base = {
      appInstanceId: APP_ID,
      sourceKind: "paste" as const,
      sourceDigest: `sha256:${"1".repeat(64)}`,
      baseVersion: 1,
      sourceRows: [["Email", "Score"], ["a@example.com", ""]],
      header: { mode: "header" as const, sourceRow: 1 },
      target: contacts,
      existingRows,
      mode: { kind: "upsert" as const, matchField: "email" },
    };
    const leave = prepareExistingTableImport({
      ...base,
      sessionId: `import_${"l".repeat(26)}`,
      mappings: [
        { sourceColumn: 1, targetField: "email" },
        { sourceColumn: 2, targetField: "score", blankMode: "leave" },
      ],
    });
    expect(leave.preview.sourceTotals).toMatchObject({ updateRows: 0, skipRows: 1 });
    expect(leave.envelope.mutations).toEqual([]);

    const clear = prepareExistingTableImport({
      ...base,
      sessionId: `import_${"c".repeat(26)}`,
      mappings: [
        { sourceColumn: 1, targetField: "email" },
        { sourceColumn: 2, targetField: "score", blankMode: "clear" },
      ],
    });
    expect(clear.envelope.mutations).toMatchObject([{ kind: "update", patch: { score: null } }]);
  });

  it("C-FR-012 blocks creates when a required destination field is not mapped", () => {
    const prepared = prepareExistingTableImport({
      appInstanceId: APP_ID,
      sessionId: `import_${"m".repeat(26)}`,
      sourceKind: "paste",
      sourceDigest: `sha256:${"f".repeat(64)}`,
      baseVersion: 1,
      sourceRows: [["Email"], ["new@example.com"]],
      header: { mode: "header", sourceRow: 1 },
      target: contacts,
      existingRows: [],
      mode: { kind: "append" },
      mappings: [{ sourceColumn: 1, targetField: "email" }],
    });

    expect(prepared.preview).toMatchObject({
      commitAllowed: false,
      sourceTotals: { sourceRows: 1, createRows: 0, blockedRows: 1 },
    });
    expect(prepared.preview.issues).toMatchObject([{
      code: "unmapped_required_field", sourceRows: [2],
    }]);
    expect(prepared.envelope.mutations).toEqual([]);
  });

  it("C-FR-050 returns all-skip import as non-durable no-change without a receipt", async () => {
    const store = await contactStore();
    try {
      const existing = store.query({ from: "contacts" });
      const prepared = prepareExistingTableImport({
        appInstanceId: APP_ID,
        sessionId: `import_${"n".repeat(26)}`,
        sourceKind: "paste",
        sourceDigest: `sha256:${"d".repeat(64)}`,
        baseVersion: store.headVersion(),
        sourceRows: [
          ["Email", "Name", "Score"],
          ["same@example.com", "Same", "3"],
          ["", "", ""],
        ],
        header: { mode: "header", sourceRow: 1 },
        target: store.registrySnapshot().get("contacts")!,
        existingRows: existing,
        mode: { kind: "upsert", matchField: "email" },
        mappings: [
          { sourceColumn: 1, targetField: "email" },
          { sourceColumn: 2, targetField: "name" },
          { sourceColumn: 3, targetField: "score" },
        ],
      });
      const receiptId = "018f0000-0000-7000-8000-000000000011";

      const result = store.commitImport({
        ...prepared.envelope, receiptId, summary: "Import contacts",
      });

      expect(result).toEqual({
        kind: "no_change",
        durable: false,
        previewDigest: prepared.preview.previewDigest,
        sourceTotals: prepared.preview.sourceTotals,
        mutationTotals: prepared.preview.mutationTotals,
        warningTotals: prepared.preview.warningTotals,
      });
      expect(store.operationBatches()).toEqual([]);
      expect(store.importReceipt(receiptId)).toBeNull();
      expect(store.rowHistoryCount()).toBe(0);
      expect(store.query({ from: "contacts" })).toEqual(existing);
    } finally {
      store.close();
    }
  });

  it("C-FR-023/C-FR-027 rejects stale commit and stale undo before changing any import row", async () => {
    const store = await contactStore();
    try {
      const firstPreviewRows = store.query({ from: "contacts" });
      const stalePrepared = prepareExistingTableImport({
        appInstanceId: APP_ID,
        sessionId: `import_${"s".repeat(26)}`,
        sourceKind: "csv",
        sourceDigest: `sha256:${"e".repeat(64)}`,
        baseVersion: store.headVersion(),
        sourceRows: [
          ["Email", "Name", "Score"],
          ["a@example.com", "First import", "5"],
          ["same@example.com", "Second import", "3"],
        ],
        header: { mode: "header", sourceRow: 1 },
        target: store.registrySnapshot().get("contacts")!,
        existingRows: firstPreviewRows,
        mode: { kind: "upsert", matchField: "email" },
        mappings: [
          { sourceColumn: 1, targetField: "email" },
          { sourceColumn: 2, targetField: "name" },
          { sourceColumn: 3, targetField: "score" },
        ],
      });
      const second = firstPreviewRows.find(row => row.email === "same@example.com")!;
      store.update("contacts", String(second.id), { name: "Intervening edit" });

      expect(() => store.commitImport({ ...stalePrepared.envelope,
        receiptId: "018f0000-0000-7000-8000-000000000012", summary: "Stale import" }))
        .toThrow(/changed after preview/i);
      expect(store.query({ from: "contacts" })).toMatchObject([
        { email: "a@example.com", name: "Old name" },
        { email: "same@example.com", name: "Intervening edit" },
      ]);
      expect(store.operationBatches()).toEqual([]);
      expect(store.importReceipt("018f0000-0000-7000-8000-000000000012")).toBeNull();

      const refreshed = store.query({ from: "contacts" });
      const prepared = prepareExistingTableImport({
        ...stalePrepared.envelope,
        sessionId: `import_${"t".repeat(26)}`,
        sourceRows: [
          ["Email", "Name", "Score"],
          ["a@example.com", "First import", "5"],
          ["same@example.com", "Second import", "3"],
        ],
        header: { mode: "header", sourceRow: 1 },
        target: store.registrySnapshot().get("contacts")!,
        existingRows: refreshed,
        mode: { kind: "upsert", matchField: "email" },
        mappings: [
          { sourceColumn: 1, targetField: "email" },
          { sourceColumn: 2, targetField: "name" },
          { sourceColumn: 3, targetField: "score" },
        ],
      });
      const receipt = store.commitImport({ ...prepared.envelope,
        receiptId: "018f0000-0000-7000-8000-000000000013", summary: "Current import" });
      if (receipt.kind !== "receipt") throw new Error("expected durable receipt");
      const first = store.query({ from: "contacts" })
        .find(row => row.email === "a@example.com")!;
      store.update("contacts", String(first.id), { name: "Later edit" });

      expect(() => store.undoImport(receipt.id)).toThrow(/changed after/i);
      expect(store.query({ from: "contacts" })).toMatchObject([
        { email: "a@example.com", name: "Later edit" },
        { email: "same@example.com", name: "Second import" },
      ]);
      expect(store.importReceipt(receipt.id)).toMatchObject({ undone: false });
    } finally {
      store.close();
    }
  });

  it("C-FR-025/C-FR-026/C-FR-027 commits one exact durable import receipt and undoes it atomically", async () => {
    const store = await contactStore();
    try {
      const before = store.query({ from: "contacts", orderBy: [{ field: "email", dir: "asc" }] });
      const prepared = prepareExistingTableImport({
        appInstanceId: APP_ID,
        sessionId: SESSION_ID,
        sourceKind: "csv",
        sourceDigest: SOURCE_DIGEST,
        baseVersion: store.headVersion(),
        sourceRows: [
          ["Email", "Name", "Score"],
          ["a@example.com", "Alice", "10"],
          ["new@example.com", "New", "2.5"],
          ["same@example.com", "Same", "3"],
          ["", "", ""],
        ],
        header: { mode: "header", sourceRow: 1 },
        target: store.registrySnapshot().get("contacts")!,
        existingRows: before,
        mode: { kind: "upsert", matchField: "email" },
        mappings: [
          { sourceColumn: 1, targetField: "email" },
          { sourceColumn: 2, targetField: "name" },
          { sourceColumn: 3, targetField: "score" },
        ],
      });

      const receipt = store.commitImport({
        ...prepared.envelope,
        receiptId: "018f0000-0000-7000-8000-000000000010",
        summary: "Import contacts",
      });

      expect(receipt).toMatchObject({
        kind: "receipt", durable: true, source: "import", changed: 2, undone: false,
        previewDigest: prepared.preview.previewDigest,
        sourceTotals: prepared.preview.sourceTotals,
        mutationTotals: prepared.preview.mutationTotals,
        warningTotals: prepared.preview.warningTotals,
        undo: { state: "available" },
      });
      if (receipt.kind !== "receipt") throw new Error("expected durable import receipt");
      expect(store.operationBatches()).toHaveLength(1);
      expect(store.importReceipt(receipt.id)).toEqual(receipt);
      expect(store.query({ from: "contacts" })).toMatchObject([
        { email: "a@example.com", name: "Alice", score: 10 },
        { email: "same@example.com", name: "Same", score: 3 },
        { email: "new@example.com", name: "New", score: 2.5 },
      ]);

      const undone = store.undoImport(receipt.id);
      expect(undone).toMatchObject({ undone: true, undo: { state: "undone" } });
      expect(store.query({ from: "contacts", orderBy: [{ field: "email", dir: "asc" }] }))
        .toEqual(before);
      expect(store.importReceipt(receipt.id)).toEqual(undone);
    } finally {
      store.close();
    }
  });
});
