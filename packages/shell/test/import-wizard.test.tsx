// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ImportReceipt } from "@clay/kernel";
import { IMPORT_ACQUISITION_LIMITS } from "@clay/kernel/import-contracts";
import { ImportWizard, type ImportParserClientLike } from "../src/app/ImportWizard";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const APP_ID = opaque("app", "a");
const SESSION_ID = opaque("import", "b");
const DIGEST = `sha256:${"c".repeat(64)}`;

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 2_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

function inputValue(element: HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("value setter unavailable");
  setter.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function structure() {
  return {
    complete: true, receivedRows: 4, totalRows: 4,
    sample: [["Email", "Name"], ["a@example.com", "Alice"]],
    headerCandidate: { recommendedRow: 1, confidence: "low" as const,
      reasons: ["first_non_blank_row" as const] },
    inferredColumns: [
      { sourceColumn: 1, label: "Email", inferredType: "text" as const,
        confidence: "low" as const, reasons: ["mixed_or_text_values"], samples: ["a@example.com"] },
      { sourceColumn: 2, label: "Name", inferredType: "text" as const,
        confidence: "low" as const, reasons: ["mixed_or_text_values"], samples: ["Alice"] },
    ],
    targetColumns: [
      { name: "email", label: "Email", type: "text" as const, required: true },
      { name: "name", label: "Name", type: "text" as const, required: true },
    ],
  };
}

const receipt: ImportReceipt = {
  kind: "receipt", durable: true,
  id: "018f0000-0000-7000-8000-000000000001",
  at: "2026-09-07T12:00:00.000Z", source: "import", summary: "Import Contacts",
  changed: 2, created: [{ table: "contacts", id: "018f0000-0000-7000-8000-000000000002",
    role: "primary_target" }], undone: false, previewDigest: DIGEST,
  sourceKind: "paste", target: { table: "contacts", label: "Contacts" }, baseVersion: 1,
  sourceTotals: { sourceRows: 3, createRows: 1, updateRows: 1, skipRows: 1, blockedRows: 0,
    skipReasons: { blank_row: 0, above_header: 0, user_skipped: 0,
      duplicate_combined: 0, duplicate_skipped: 0, no_change: 1, unmapped_row: 0 } },
  mutationTotals: { primaryTargetCreates: 1, primaryTargetUpdates: 1,
    auxiliaryRelatedCreates: 0, changedCount: 2 },
  warningTotals: { warnings: 2, warningReasons: { trimmed_whitespace: 2,
    leading_zero_identifier: 0, enum_case_normalized: 0 } },
  undo: { state: "available" },
};

describe("Release C ImportWizard", () => {
  it("C1 lets a user paste cells, map typed headers, review exact totals/warnings, confirm once, and undo", async () => {
    const parser: ImportParserClientLike = {
      openImportSource: vi.fn(async input => ({
        version: 1 as const, sessionId: SESSION_ID, appInstanceId: input.appInstanceId,
        kind: input.kind, sourceDigest: DIGEST,
        sheets: [{ sheetId: "source", label: "Pasted cells", visibility: "visible" as const,
          range: { rows: 4, columns: 2 } }],
        limits: IMPORT_ACQUISITION_LIMITS,
      })),
      readImportChunk: vi.fn(async () => ({
        sessionId: SESSION_ID, cursor: 0, startRow: 1,
        rows: [["Email", "Name"], ["a@example.com", "Alice"],
          ["new@example.com", "New"], ["same@example.com", "Same"]],
        nextCursor: null, serializedBytes: 128,
      })),
      closeImportSource: vi.fn(async () => ({ disposed: true as const })),
      dispose: vi.fn(),
    };
    const configureImport = vi.fn(async () => null);
    const commitImport = vi.fn(async () => receipt);
    const undoImport = vi.fn(async () => ({ ...receipt, undone: true,
      undo: { state: "undone" as const } }));
    const worker = {
      beginImport: vi.fn(async () => ({ ...structure(), complete: false, receivedRows: 0 })),
      stageImportChunk: vi.fn(async () => structure()),
      importStructure: vi.fn(async (_sessionId: string, selected?: { mode: "header" | "no_header" }) => {
        const next = structure();
        return selected?.mode === "no_header" ? {
          ...next,
          inferredColumns: next.inferredColumns.map((column, index) => ({
            ...column, label: `Column ${index + 1}`,
          })),
        } : next;
      }),
      configureImport,
      previewImport: vi.fn(async () => ({
        previewId: opaque("preview", "d"), previewDigest: DIGEST,
        sourceKind: "paste" as const, target: { table: "contacts", label: "Contacts" },
        header: { mode: "header" as const, sourceRow: 1 },
        mappings: [{ sourceColumn: 1, sourceLabel: "Email", targetField: "email", targetLabel: "Email", targetType: "text" as const },
          { sourceColumn: 2, sourceLabel: "Name", targetField: "name", targetLabel: "Name", targetType: "text" as const }],
        mode: { kind: "upsert" as const, matchField: "email" }, baseVersion: 1,
        sourceTotals: receipt.sourceTotals, mutationTotals: receipt.mutationTotals,
        warningTotals: receipt.warningTotals, issues: [], commitAllowed: true,
        completion: "changes" as const, idempotencyKey: opaque("req", "e"),
      })),
      commitImport,
      cancelImport: vi.fn(async () => ({ disposed: true as const })),
      undoImport,
    } as unknown as WorkerClient;
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await act(async () => root.render(<ImportWizard
      appInstanceId={APP_ID} targetTable="contacts" worker={worker}
      parserFactory={() => parser} onClose={() => undefined}
      onCommitted={() => undefined} onError={message => { throw new Error(message); }}
    />));

    expect(document.body.textContent).toContain("CSV file");
    expect(document.body.textContent).toContain("Paste cells");
    expect(document.body.textContent).toContain(".xlsx; parsed locally with hard size limits");
    const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => inputValue(textarea,
      "Email\tName\na@example.com\tAlice\nnew@example.com\tNew\nsame@example.com\tSame"));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Use pasted cells")!.click());
    await waitFor(() => document.body.textContent?.includes("Map columns") ?? false);

    const headerChoice = document.body.querySelector<HTMLSelectElement>('[aria-label="Header row"]')!;
    await act(async () => inputValue(headerChoice, "none"));
    await waitFor(() => document.body.textContent?.includes("Column 1 · text") ?? false);
    await act(async () => inputValue(headerChoice, "1"));
    await waitFor(() => document.body.textContent?.includes("Email · text") ?? false);
    expect(document.body.textContent).toContain("Name · text");
    const behavior = document.body.querySelector<HTMLSelectElement>('[aria-label="Import behavior"]')!;
    await act(async () => inputValue(behavior, "upsert"));
    const match = document.body.querySelector<HTMLSelectElement>('[aria-label="Update match field"]')!;
    await act(async () => inputValue(match, "email"));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Review import")!.click());
    await waitFor(() => document.body.textContent?.includes("Exact preview") ?? false);

    expect(document.body.textContent).toContain("1 create");
    expect(document.body.textContent).toContain("1 update");
    expect(document.body.textContent).toContain("1 skip");
    expect(document.body.textContent).toContain("Review warnings (2)");
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Confirm import")!.click());
    await waitFor(() => document.body.textContent?.includes("Import complete") ?? false);
    expect(commitImport).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("2 changes saved in one receipt");

    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Undo import")!.click());
    await waitFor(() => document.body.textContent?.includes("Import undone") ?? false);
    expect(undoImport).toHaveBeenCalledWith(receipt.id);
    expect(configureImport).toHaveBeenCalledWith(expect.objectContaining({
      mode: { kind: "upsert", matchField: "email" },
      mappings: expect.arrayContaining([
        expect.objectContaining({ targetField: "email", blankMode: "leave" }),
        expect.objectContaining({ targetField: "name", blankMode: "leave" }),
      ]),
    }));
    expect(parser.openImportSource).toHaveBeenCalledWith(expect.objectContaining({ kind: "paste" }));

    await act(async () => root.unmount());
  });

  it("C-FR-006 offers XLSX locally, marks hidden worksheets, and stages the explicit choice", async () => {
    const descriptor = {
      version: 1 as const,
      sessionId: SESSION_ID,
      appInstanceId: APP_ID,
      kind: "xlsx" as const,
      sourceDigest: DIGEST,
      sheets: [
        { sheetId: "sheet_1", label: "Current", visibility: "visible" as const,
          range: { rows: 2, columns: 2 } },
        { sheetId: "sheet_2", label: "Archive", visibility: "hidden" as const,
          range: { rows: 2, columns: 2 } },
      ],
      limits: IMPORT_ACQUISITION_LIMITS,
    };
    const parser: ImportParserClientLike = {
      openImportSource: vi.fn(async () => descriptor),
      readImportChunk: vi.fn(async () => ({
        sessionId: SESSION_ID, cursor: 0, startRow: 1,
        rows: [["Email", "Name"], ["xlsx@example.com", "Workbook"]],
        nextCursor: null, serializedBytes: 128,
      })),
      closeImportSource: vi.fn(async () => ({ disposed: true as const })),
      dispose: vi.fn(),
    };
    const worker = {
      beginImport: vi.fn(async () => ({ ...structure(), complete: false, receivedRows: 0 })),
      stageImportChunk: vi.fn(async () => ({ ...structure(), receivedRows: 2, totalRows: 2 })),
      cancelImport: vi.fn(async () => ({ disposed: true as const })),
    } as unknown as WorkerClient;
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await act(async () => root.render(<ImportWizard
      appInstanceId={APP_ID} targetTable="contacts" worker={worker}
      parserFactory={() => parser} onClose={() => undefined}
      onCommitted={() => undefined} onError={onError}
    />));

    const file = new File([new Uint8Array([0x50, 0x4b])], "contacts.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([0x50, 0x4b]).buffer,
    });
    const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await waitFor(() => document.body.textContent?.includes("Choose a worksheet") ?? false);

    expect(document.body.textContent).toContain("Archive · hidden");
    const worksheet = document.body.querySelector<HTMLSelectElement>('[aria-label="Worksheet"]')!;
    expect(worksheet.value).toBe("sheet_1");
    await act(async () => inputValue(worksheet, "sheet_2"));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Use worksheet")!.click());
    await waitFor(() => document.body.textContent?.includes("Map columns") ?? false);

    expect(worker.beginImport).toHaveBeenCalledWith(descriptor, "contacts", "sheet_2");
    expect(parser.readImportChunk).toHaveBeenCalledWith(expect.objectContaining({
      sheetId: "sheet_2",
    }));
    expect(onError).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
