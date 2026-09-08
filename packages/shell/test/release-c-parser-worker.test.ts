import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPORT_ACQUISITION_LIMITS,
  ImportParserResponseSchema,
} from "@clay/kernel/import-contracts";
import { handleImportParserWorkerRequest } from "../src/worker/release-c/import-worker-runtime";
import { ImportParserSessionStore } from "../src/worker/release-c/parser-session";
import { worksheetXml, xlsxFixture } from "./fixtures/xlsx-fixture";

const APP = `app_${"a".repeat(26)}`;
const SESSION = `import_${"j".repeat(26)}`;
const encoder = new TextEncoder();
const utf8 = (value: string): ArrayBuffer => encoder.encode(value).buffer;

function measuredResultBytes(rows: string[][], sessionId: string): number {
  const result = {
    sessionId,
    cursor: 0,
    startRow: 1,
    rows,
    nextCursor: null as number | null,
    serializedBytes: 0,
  };
  for (let pass = 0; pass < 6; pass++)
    result.serializedBytes = encoder.encode(JSON.stringify(result)).byteLength;
  return encoder.encode(JSON.stringify(result)).byteLength;
}

describe("Release C parser worker protocol", () => {
  it("C-T-INT-001 validates open/read/close boundaries and leaves formulas/HTML inert", async () => {
    const store = new ImportParserSessionStore({ sessionId: () => SESSION });
    const open = await handleImportParserWorkerRequest({
      version: 1,
      id: 1,
      op: "openImportSource",
      payload: {
        appInstanceId: APP,
        kind: "paste",
        bytes: utf8("Name\tPayload\nformula\t=1+1\nhtml\t<script>self.pwned=true</script>"),
      },
    }, store);
    expect(ImportParserResponseSchema.safeParse(open).success).toBe(true);
    expect(open).toMatchObject({ ok: true, result: { sessionId: SESSION } });

    const read = await handleImportParserWorkerRequest({
      version: 1,
      id: 2,
      op: "readImportChunk",
      payload: { appInstanceId: APP, sessionId: SESSION, cursor: 0 },
    }, store);
    expect(ImportParserResponseSchema.safeParse(read).success).toBe(true);
    expect(read).toMatchObject({
      ok: true,
      result: {
        rows: [
          ["Name", "Payload"],
          ["formula", "=1+1"],
          ["html", "<script>self.pwned=true</script>"],
        ],
      },
    });
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();

    const close = await handleImportParserWorkerRequest({
      version: 1,
      id: 3,
      op: "closeImportSource",
      payload: { appInstanceId: APP, sessionId: SESSION, reason: "cancel" },
    }, store);
    expect(close).toEqual({ version: 1, id: 3, ok: true, result: { disposed: true } });
  });

  it("C-FR-024 bounds the complete worker response, not only its result object", async () => {
    const fixedRows = Array.from({ length: 63 }, () => ["x".repeat(16 * 1024)]);
    let low = 0;
    let high = 16 * 1024;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const rows = [...fixedRows, ["x".repeat(middle)]];
      if (measuredResultBytes(rows, SESSION) <= IMPORT_ACQUISITION_LIMITS.maxChunkBytes)
        low = middle;
      else
        high = middle - 1;
    }
    const csv = [...fixedRows.map(row => row[0]!), "x".repeat(low)].join("\n");
    const store = new ImportParserSessionStore({ sessionId: () => SESSION });
    await handleImportParserWorkerRequest({
      version: 1,
      id: 30,
      op: "openImportSource",
      payload: { appInstanceId: APP, kind: "csv", bytes: utf8(csv) },
    }, store);
    const response = await handleImportParserWorkerRequest({
      version: 1,
      id: 31,
      op: "readImportChunk",
      payload: { appInstanceId: APP, sessionId: SESSION, cursor: 0 },
    }, store);

    expect(encoder.encode(JSON.stringify(response)).byteLength)
      .toBeLessThanOrEqual(IMPORT_ACQUISITION_LIMITS.maxChunkBytes);
  });

  it("C-FR-006 validates worksheet selection across the worker protocol", async () => {
    const store = new ImportParserSessionStore({ sessionId: () => SESSION });
    const source = xlsxFixture({ sheets: [
      { name: "Primary", xml: worksheetXml(
        `<row r="1"><c r="A1" t="inlineStr"><is><t>one</t></is></c></row>`,
      ) },
      { name: "Secondary", state: "hidden", xml: worksheetXml(
        `<row r="1"><c r="A1" t="inlineStr"><is><t>two</t></is></c></row>`,
      ) },
    ] });
    const open = await handleImportParserWorkerRequest({
      version: 1, id: 40, op: "openImportSource",
      payload: { appInstanceId: APP, kind: "xlsx", bytes: source },
    }, store);
    expect(open).toMatchObject({ ok: true, result: { sheets: [
      { sheetId: "sheet_1", visibility: "visible" },
      { sheetId: "sheet_2", visibility: "hidden" },
    ] } });

    const read = await handleImportParserWorkerRequest({
      version: 1, id: 41, op: "readImportChunk",
      payload: { appInstanceId: APP, sessionId: SESSION, sheetId: "sheet_2", cursor: 0 },
    }, store);
    expect(read).toMatchObject({ ok: true, result: { rows: [["two"]] } });
  });

  it("C-NFR-003 fails a forged worker message closed with no attacker value in the error", async () => {
    const response = await handleImportParserWorkerRequest({
      version: 1,
      id: 9,
      op: "readImportChunk",
      payload: {
        appInstanceId: APP,
        sessionId: SESSION,
        cursor: 0,
        privateValue: "PRIVATE_PROTOCOL_SENTINEL",
      },
    }, new ImportParserSessionStore());

    expect(response).toEqual({
      version: 1,
      id: 9,
      ok: false,
      error: {
        code: "E_IMPORT_PROTOCOL",
        stage: "protocol",
        message: "The import source could not be read safely.",
      },
    });
    expect(JSON.stringify(response)).not.toContain("PRIVATE_PROTOCOL_SENTINEL");
    expect(ImportParserResponseSchema.safeParse(response).success).toBe(true);
  });

  it("C-NFR-001/C-NFR-003 keeps the dedicated worker entry free of DB, model, and network authority", () => {
    const workerPath = path.resolve(import.meta.dirname,
      "../src/worker/release-c/import-worker.ts");
    const worker = fs.readFileSync(workerPath, "utf8");
    expect(worker).toContain('from "./import-worker-runtime"');
    expect(worker).not.toMatch(/fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|indexedDB|caches\s*\.|ClayStore|@sqlite|model|MutationPlan/i);
    expect(worker).not.toContain("../db-worker");
    expect(worker).not.toContain("../../app");
  });
});
