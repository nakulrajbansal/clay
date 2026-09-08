import { describe, expect, it } from "vitest";
import {
  IMPORT_ACQUISITION_LIMITS,
  ImportAcquisitionLimitsSchema,
  ImportHeaderChoiceSchema,
  ImportParserRequestSchema,
  ImportParserResponseSchema,
  ImportPreparedLedgerSchema,
  ImportRangeChoiceSchema,
  ImportSheetChoiceSchema,
  ImportSourceDescriptorSchema,
  ImportSourceDispositionLedgerSchema,
  MutationTotalsSchema,
  SourceDispositionTotalsSchema,
} from "../src/import-contracts";

describe("Release C import contracts", () => {
  it("C-FR-004/C-FR-024 pins acquisition, decoded, time, and chunk limits in a closed contract", () => {
    expect(ImportAcquisitionLimitsSchema.parse(IMPORT_ACQUISITION_LIMITS)).toEqual({
      maxDataRows: 5_000,
      maxMappedColumns: 20,
      maxDecodedCellBytes: 16 * 1024,
      maxDecodedCellsBytes: 32 * 1024 * 1024,
      maxDelimitedSourceBytes: 16 * 1024 * 1024,
      maxPasteSourceBytes: 8 * 1024 * 1024,
      maxCompressedXlsxBytes: 25 * 1024 * 1024,
      maxExpandedXlsxBytes: 100 * 1024 * 1024,
      maxXlsxEntries: 2_000,
      maxParseMilliseconds: 8_000,
      maxChunkRows: 250,
      maxChunkBytes: 1024 * 1024,
    });
    expect(ImportAcquisitionLimitsSchema.safeParse({
      ...IMPORT_ACQUISITION_LIMITS,
      silentlyTruncate: true,
    }).success).toBe(false);
    expect(ImportAcquisitionLimitsSchema.safeParse({
      ...IMPORT_ACQUISITION_LIMITS,
      maxDataRows: 4_999,
    }).success).toBe(false);
  });

  it("C-FR-005/C-FR-006/C-FR-007 validates closed app-bound source and structure choices", () => {
    const source = {
      version: 1,
      sessionId: `import_${"a".repeat(26)}`,
      appInstanceId: `app_${"b".repeat(26)}`,
      kind: "csv",
      sourceDigest: `sha256:${"c".repeat(64)}`,
      sheets: [{
        sheetId: "source",
        label: "Delimited text",
        visibility: "visible",
        range: { rows: 3, columns: 2 },
      }],
      limits: IMPORT_ACQUISITION_LIMITS,
    } as const;
    expect(ImportSourceDescriptorSchema.parse(source)).toEqual(source);
    expect(ImportSheetChoiceSchema.parse({ sheetId: "source" }))
      .toEqual({ sheetId: "source" });
    expect(ImportRangeChoiceSchema.parse({
      sheetId: "source", startRow: 1, endRow: 3, startColumn: 1, endColumn: 2,
    })).toEqual({
      sheetId: "source", startRow: 1, endRow: 3, startColumn: 1, endColumn: 2,
    });
    expect(ImportHeaderChoiceSchema.parse({ mode: "header", sourceRow: 1 }))
      .toEqual({ mode: "header", sourceRow: 1 });
    expect(ImportHeaderChoiceSchema.parse({ mode: "no_header" }))
      .toEqual({ mode: "no_header" });

    expect(ImportSourceDescriptorSchema.safeParse({ ...source, bytes: "private" }).success)
      .toBe(false);
    expect(ImportRangeChoiceSchema.safeParse({
      sheetId: "source", startRow: 3, endRow: 2, startColumn: 1, endColumn: 2,
    }).success).toBe(false);
    expect(ImportRangeChoiceSchema.safeParse({
      sheetId: "source", startRow: 1, endRow: 3, startColumn: 1, endColumn: 21,
    }).success).toBe(false);
    expect(ImportHeaderChoiceSchema.safeParse({
      mode: "no_header", sourceRow: 1,
    }).success).toBe(false);
  });

  it("C-FR-019/C-FR-048/C-FR-049 keeps source dispositions separate from unique canonical mutations", () => {
    const dispositions = [
      { sourceRow: 2, kind: "create" },
      { sourceRow: 3, kind: "create" },
      { sourceRow: 4, kind: "skip", reasonCode: "blank_row" },
      { sourceRow: 5, kind: "blocked", issueIds: ["issue_1"] },
    ] as const;
    expect(ImportSourceDispositionLedgerSchema.parse(dispositions)).toEqual(dispositions);

    const sourceTotals = {
      sourceRows: 4,
      createRows: 2,
      updateRows: 0,
      skipRows: 1,
      blockedRows: 1,
      skipReasons: {
        above_header: 0,
        blank_row: 1,
        user_skipped: 0,
        duplicate_combined: 0,
        duplicate_skipped: 0,
        no_change: 0,
        unmapped_row: 0,
      },
    } as const;
    const mutationTotals = {
      primaryTargetCreates: 1,
      primaryTargetUpdates: 0,
      auxiliaryRelatedCreates: 1,
      changedCount: 2,
    } as const;
    expect(SourceDispositionTotalsSchema.parse(sourceTotals)).toEqual(sourceTotals);
    expect(MutationTotalsSchema.parse(mutationTotals)).toEqual(mutationTotals);
    expect(SourceDispositionTotalsSchema.safeParse({
      ...sourceTotals, auxiliaryRelatedCreates: 1,
    }).success).toBe(false);
    expect(MutationTotalsSchema.safeParse({
      ...mutationTotals, createRows: 2,
    }).success).toBe(false);
    expect(MutationTotalsSchema.safeParse({
      ...mutationTotals, changedCount: 3,
    }).success).toBe(false);
    expect(SourceDispositionTotalsSchema.safeParse({
      ...sourceTotals, sourceRows: 5,
    }).success).toBe(false);
    expect(ImportSourceDispositionLedgerSchema.safeParse([
      dispositions[0], { sourceRow: 2, kind: "update" },
    ]).success).toBe(false);
  });

  it("C-NFR-003 closes and bounds every parser-worker request and response", () => {
    const appInstanceId = `app_${"d".repeat(26)}`;
    const sessionId = `import_${"e".repeat(26)}`;
    const requests = [
      {
        version: 1, id: 1, op: "openImportSource",
        payload: { appInstanceId, kind: "csv", bytes: new ArrayBuffer(8) },
      },
      {
        version: 1, id: 2, op: "readImportChunk",
        payload: { appInstanceId, sessionId, cursor: 0 },
      },
      {
        version: 1, id: 3, op: "closeImportSource",
        payload: { appInstanceId, sessionId, reason: "cancel" },
      },
    ];
    for (const request of requests)
      expect(ImportParserRequestSchema.safeParse(request).success).toBe(true);
    expect(ImportParserRequestSchema.safeParse({
      ...requests[0], payload: { ...requests[0]!.payload, canonicalCommit: true },
    }).success).toBe(false);

    const response = {
      version: 1,
      id: 2,
      ok: true,
      result: {
        sessionId,
        cursor: 0,
        startRow: 1,
        rows: [["formula =1+1", "<b>inert</b>"]],
        nextCursor: null,
        serializedBytes: 180,
      },
    } as const;
    expect(ImportParserResponseSchema.safeParse(response).success).toBe(true);
    expect(ImportParserResponseSchema.safeParse({
      ...response,
      result: { ...response.result, serializedBytes: 1024 * 1024 + 1 },
    }).success).toBe(false);
    expect(ImportParserResponseSchema.safeParse({
      version: 1,
      id: 9,
      ok: false,
      error: {
        code: "E_IMPORT_CSV_SYNTAX",
        stage: "parse",
        message: "The import source could not be read safely.",
        row: 2,
        column: 1,
      },
    }).success).toBe(true);
  });

  it("C-FR-048 validates explicit many-to-one row mapping against one deduplicated mutation ledger", () => {
    const primaryMutationId = `mutation_${"a".repeat(26)}`;
    const auxiliaryMutationId = `mutation_${"b".repeat(26)}`;
    const ledger = {
      dispositions: [
        { sourceRow: 2, kind: "create" },
        { sourceRow: 3, kind: "create" },
        { sourceRow: 4, kind: "skip", reasonCode: "blank_row" },
      ],
      rowMutationMap: [
        { sourceRow: 2, primaryMutationId, auxiliaryRelatedMutationIds: [auxiliaryMutationId] },
        { sourceRow: 3, primaryMutationId, auxiliaryRelatedMutationIds: [auxiliaryMutationId] },
        { sourceRow: 4, primaryMutationId: null, auxiliaryRelatedMutationIds: [] },
      ],
      mutations: [
        {
          mutationId: primaryMutationId,
          role: "primary_target",
          kind: "create",
          tableId: `tbl_${"c".repeat(26)}`,
          rowId: "018f0000-0000-7000-8000-000000000001",
          originSourceRows: [2, 3],
          payloadDigest: `sha256:${"d".repeat(64)}`,
        },
        {
          mutationId: auxiliaryMutationId,
          role: "auxiliary_related",
          kind: "create",
          tableId: `tbl_${"e".repeat(26)}`,
          rowId: "018f0000-0000-7000-8000-000000000002",
          originSourceRows: [2, 3],
          payloadDigest: `sha256:${"f".repeat(64)}`,
        },
      ],
      mutationTotals: {
        primaryTargetCreates: 1,
        primaryTargetUpdates: 0,
        auxiliaryRelatedCreates: 1,
        changedCount: 2,
      },
    } as const;
    expect(ImportPreparedLedgerSchema.parse(ledger)).toEqual(ledger);
    expect(ImportPreparedLedgerSchema.safeParse({
      ...ledger,
      rowMutationMap: ledger.rowMutationMap.map((entry, index) =>
        index === 2 ? { ...entry, primaryMutationId } : entry),
    }).success).toBe(false);
    expect(ImportPreparedLedgerSchema.safeParse({
      ...ledger,
      mutationTotals: { ...ledger.mutationTotals, changedCount: 3 },
    }).success).toBe(false);
    expect(ImportPreparedLedgerSchema.safeParse({
      ...ledger,
      mutations: ledger.mutations.slice(0, 1),
    }).success).toBe(false);
  });
});
