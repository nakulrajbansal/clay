import { describe, expect, it } from "vitest";
import { handleImportParserWorkerRequest } from "../src/worker/release-c/import-worker-runtime";
import { ImportParserSessionStore } from "../src/worker/release-c/parser-session";
import {
  ReleaseCParserWorkerClient,
  type ImportParserWorkerLike,
} from "../src/worker/release-c/import-worker-client";
import { worksheetXml, xlsxFixture } from "./fixtures/xlsx-fixture";

const APP = `app_${"a".repeat(26)}`;

type Posted = { message: unknown; transfer: Transferable[] };

class RuntimeWorker implements ImportParserWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Posted[] = [];
  terminated = false;

  constructor(private readonly sessions: ImportParserSessionStore) {}

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
    queueMicrotask(() => {
      void handleImportParserWorkerRequest(message, this.sessions)
        .then(response => this.onmessage?.({ data: response } as MessageEvent<unknown>));
    });
  }

  terminate(): void {
    this.terminated = true;
    this.sessions.restart();
  }
}

describe("Release C parser worker client", () => {
  it("C-T-INT-001 transfers bytes through validated open/read/close RPCs", async () => {
    const runtime = new RuntimeWorker(new ImportParserSessionStore({
      sessionId: () => `import_${"b".repeat(26)}`,
    }));
    const client = new ReleaseCParserWorkerClient(() => runtime);
    const bytes = new TextEncoder().encode("Name\n=1+1").buffer;

    const descriptor = await client.openImportSource({
      appInstanceId: APP, kind: "csv", bytes,
    });
    expect(runtime.posted[0]?.message).toMatchObject({
      version: 1, id: 1, op: "openImportSource",
      payload: { appInstanceId: APP, kind: "csv", bytes },
    });
    expect(runtime.posted[0]?.transfer).toEqual([bytes]);

    const chunk = await client.readImportChunk({
      appInstanceId: APP, sessionId: descriptor.sessionId, cursor: 0,
    });
    expect(chunk.rows).toEqual([["Name"], ["=1+1"]]);
    expect(await client.closeImportSource({
      appInstanceId: APP, sessionId: descriptor.sessionId, reason: "cancel",
    })).toEqual({ disposed: true });
    client.dispose();
    expect(runtime.terminated).toBe(true);
  });

  it("C-FR-006 carries an XLSX worksheet choice through the typed client", async () => {
    const runtime = new RuntimeWorker(new ImportParserSessionStore({
      sessionId: () => `import_${"c".repeat(26)}`,
    }));
    const client = new ReleaseCParserWorkerClient(() => runtime);
    const bytes = xlsxFixture({ sheets: [
      { name: "First", xml: worksheetXml(
        `<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>`,
      ) },
      { name: "Second", xml: worksheetXml(
        `<row r="1"><c r="A1" t="inlineStr"><is><t>second</t></is></c></row>`,
      ) },
    ] });
    const descriptor = await client.openImportSource({ appInstanceId: APP, kind: "xlsx", bytes });

    const chunk = await client.readImportChunk({
      appInstanceId: APP,
      sessionId: descriptor.sessionId,
      sheetId: "sheet_2",
      cursor: 0,
    });
    expect(chunk.rows).toEqual([["second"]]);
    expect(runtime.posted[1]?.message).toMatchObject({
      payload: { sheetId: "sheet_2" },
    });
  });
});
