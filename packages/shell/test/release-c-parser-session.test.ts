import { describe, expect, it } from "vitest";
import { IMPORT_ACQUISITION_LIMITS } from "@clay/kernel/import-contracts";
import { ImportParserSessionStore } from "../src/worker/release-c/parser-session";
import { worksheetXml, xlsxFixture } from "./fixtures/xlsx-fixture";

const utf8 = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;
const APP_A = `app_${"a".repeat(26)}`;
const APP_B = `app_${"b".repeat(26)}`;

describe("Release C parser sessions", () => {
  it("C-FR-024 reads every row in <=250-row, <=1 MiB chunks", async () => {
    const csv = ["Name,Value", ...Array.from({ length: 600 }, (_, index) => `row-${index},${index}`)]
      .join("\n");
    const store = new ImportParserSessionStore({
      sessionId: () => `import_${"b".repeat(26)}`,
    });
    const descriptor = await store.openImportSource({
      appInstanceId: APP_A,
      kind: "csv",
      bytes: utf8(csv),
    });

    const chunks = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const chunk = await store.readImportChunk({
        appInstanceId: APP_A,
        sessionId: descriptor.sessionId,
        cursor,
      });
      chunks.push(chunk);
      cursor = chunk.nextCursor;
    }

    expect(descriptor.sheets[0]?.range).toEqual({ rows: 601, columns: 2 });
    expect(chunks.every(chunk => chunk.rows.length <= IMPORT_ACQUISITION_LIMITS.maxChunkRows))
      .toBe(true);
    expect(chunks.every(chunk => chunk.serializedBytes <= IMPORT_ACQUISITION_LIMITS.maxChunkBytes))
      .toBe(true);
    expect(chunks.every(chunk => new TextEncoder().encode(JSON.stringify(chunk)).byteLength
      === chunk.serializedBytes)).toBe(true);
    expect(chunks.flatMap(chunk => chunk.rows)).toHaveLength(601);
    expect(chunks.at(-1)?.rows.at(-1)).toEqual(["row-599", "599"]);
  });

  it("C-FR-005 disposes source bytes and cells on cancel", async () => {
    const store = new ImportParserSessionStore({
      sessionId: () => `import_${"c".repeat(26)}`,
    });
    const descriptor = await store.openImportSource({
      appInstanceId: APP_A,
      kind: "paste",
      bytes: utf8("private\tvalue"),
    });

    expect(store.closeImportSource({
      appInstanceId: APP_A,
      sessionId: descriptor.sessionId,
      reason: "cancel",
    })).toEqual({ disposed: true });
    await expect(store.readImportChunk({
      appInstanceId: APP_A,
      sessionId: descriptor.sessionId,
      cursor: 0,
    })).rejects.toEqual(expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }));
  });

  it("C-FR-005 disposes the prior app session before accepting a switched app", async () => {
    const ids = [`import_${"d".repeat(26)}`, `import_${"e".repeat(26)}`];
    const store = new ImportParserSessionStore({ sessionId: () => ids.shift()! });
    const first = await store.openImportSource({
      appInstanceId: APP_A, kind: "csv", bytes: utf8("private-a"),
    });
    const second = await store.openImportSource({
      appInstanceId: APP_B, kind: "csv", bytes: utf8("private-b"),
    });

    await expect(store.readImportChunk({
      appInstanceId: APP_A, sessionId: first.sessionId, cursor: 0,
    })).rejects.toEqual(expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }));
    expect((await store.readImportChunk({
      appInstanceId: APP_B, sessionId: second.sessionId, cursor: 0,
    })).rows).toEqual([["private-b"]]);
  });

  it("C-FR-005 rejects a superseded concurrent app open", async () => {
    const ids = [`import_${"g".repeat(26)}`, `import_${"h".repeat(26)}`];
    const store = new ImportParserSessionStore({ sessionId: () => ids.shift()! });
    const firstBytes = utf8("private-a");
    const secondBytes = utf8("private-b");
    const [first, second] = await Promise.allSettled([
      store.openImportSource({
        appInstanceId: APP_A, kind: "csv", bytes: firstBytes,
      }),
      store.openImportSource({
        appInstanceId: APP_B, kind: "csv", bytes: secondBytes,
      }),
    ]);

    expect(first.status).toBe("rejected");
    if (first.status === "rejected")
      expect(first.reason).toEqual(expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }));
    expect([...new Uint8Array(firstBytes)]).toEqual(Array(firstBytes.byteLength).fill(0));
    expect(second.status).toBe("fulfilled");
    if (second.status === "fulfilled") {
      expect((await store.readImportChunk({
        appInstanceId: APP_B, sessionId: second.value.sessionId, cursor: 0,
      })).rows).toEqual([["private-b"]]);
    }
  });

  it("C-FR-005 rejects and zeroes an open superseded by worker restart", async () => {
    const store = new ImportParserSessionStore({
      sessionId: () => `import_${"i".repeat(26)}`,
    });
    const source = utf8("private-before-restart");
    const pending = store.openImportSource({
      appInstanceId: APP_A, kind: "csv", bytes: source,
    });
    store.restart();

    await expect(pending).rejects.toEqual(
      expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }),
    );
    expect([...new Uint8Array(source)]).toEqual(Array(source.byteLength).fill(0));
  });

  it("C-FR-005 clears all ephemeral material on parser worker restart", async () => {
    const store = new ImportParserSessionStore({
      sessionId: () => `import_${"f".repeat(26)}`,
    });
    const descriptor = await store.openImportSource({
      appInstanceId: APP_A, kind: "csv", bytes: utf8("restart-private"),
    });

    store.restart();

    await expect(store.readImportChunk({
      appInstanceId: APP_A, sessionId: descriptor.sessionId, cursor: 0,
    })).rejects.toEqual(expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }));
  });

  it("C-NFR-006 keeps only one staged parser session per app", async () => {
    const ids = [`import_${"g".repeat(26)}`, `import_${"h".repeat(26)}`];
    const store = new ImportParserSessionStore({ sessionId: () => ids.shift()! });
    const first = await store.openImportSource({
      appInstanceId: APP_A, kind: "csv", bytes: utf8("first-private"),
    });
    const second = await store.openImportSource({
      appInstanceId: APP_A, kind: "paste", bytes: utf8("second-private"),
    });

    await expect(store.readImportChunk({
      appInstanceId: APP_A, sessionId: first.sessionId, cursor: 0,
    })).rejects.toEqual(expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }));
    expect((await store.readImportChunk({
      appInstanceId: APP_A, sessionId: second.sessionId, cursor: 0,
    })).rows).toEqual([["second-private"]]);
  });

  it("C-FR-005 expires an idle session at the explicit five-minute timeout", async () => {
    let now = 10;
    const store = new ImportParserSessionStore({
      sessionId: () => `import_${"i".repeat(26)}`,
      now: () => now,
    });
    const descriptor = await store.openImportSource({
      appInstanceId: APP_A, kind: "csv", bytes: utf8("timeout-private"),
    });
    now += 5 * 60 * 1_000 + 1;

    await expect(store.readImportChunk({
      appInstanceId: APP_A, sessionId: descriptor.sessionId, cursor: 0,
    })).rejects.toEqual(expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }));
  });

  it("C-FR-005 proactively zeroes idle sessions when the worker timeout sweep runs", async () => {
    let now = 0;
    const store = new ImportParserSessionStore({
      sessionId: () => `import_${"j".repeat(26)}`,
      now: () => now,
    });
    const descriptor = await store.openImportSource({
      appInstanceId: APP_A, kind: "csv", bytes: utf8("sweep-private"),
    });
    now = 5 * 60 * 1_000 + 1;

    expect(store.expireIdleSessions()).toBe(1);
    await expect(store.readImportChunk({
      appInstanceId: APP_A, sessionId: descriptor.sessionId, cursor: 0,
    })).rejects.toEqual(expect.objectContaining({ code: "E_IMPORT_SESSION_UNKNOWN" }));
  });

  it("C-FR-002 parses XLSX lazily and reads an explicitly selected hidden sheet", async () => {
    const source = xlsxFixture({
      sheets: [
        { name: "Visible", xml: worksheetXml(
          `<row r="1"><c r="A1" t="inlineStr"><is><t>Visible value</t></is></c></row>`,
        ) },
        { name: "Hidden", state: "hidden", xml: worksheetXml(
          `<row r="1"><c r="A1" t="inlineStr"><is><t>Hidden value</t></is></c></row>`,
        ) },
      ],
    });
    const store = new ImportParserSessionStore({
      sessionId: () => `import_${"x".repeat(26)}`,
    });

    const descriptor = await store.openImportSource({
      appInstanceId: APP_A, kind: "xlsx", bytes: source,
    });
    expect(descriptor.sheets.map(sheet => [sheet.label, sheet.visibility])).toEqual([
      ["Visible", "visible"], ["Hidden", "hidden"],
    ]);
    await expect(store.readImportChunk({
      appInstanceId: APP_A,
      sessionId: descriptor.sessionId,
      sheetId: "sheet_2",
      cursor: 0,
    })).resolves.toMatchObject({ rows: [["Hidden value"]], nextCursor: null });
  });

  it("C-FR-002 fails malformed XLSX closed after enforcing the compressed acquisition cap", async () => {
    const store = new ImportParserSessionStore();
    await expect(store.openImportSource({
      appInstanceId: APP_A,
      kind: "xlsx",
      bytes: new ArrayBuffer(25 * 1024 * 1024 + 1),
    })).rejects.toMatchObject({
      code: "E_IMPORT_SOURCE_LIMIT",
      stage: "acquire",
      limit: 25 * 1024 * 1024,
      actual: 25 * 1024 * 1024 + 1,
    });
    await expect(store.openImportSource({
      appInstanceId: APP_A,
      kind: "xlsx",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
    })).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID",
      stage: "acquire",
    });
  });
});
