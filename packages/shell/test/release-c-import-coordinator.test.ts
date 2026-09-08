import { describe, expect, it, vi } from "vitest";
import { openMemoryDriver } from "@clay/kernel";
import { ProductionStoreAuthority } from "@clay/kernel/worker-authority";
import { ImportParserSessionStore } from "../src/worker/release-c/parser-session";
import { ImportSessionCoordinator } from "../src/worker/release-c/import-session-coordinator";
import { worksheetXml, xlsxFixture } from "./fixtures/xlsx-fixture";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const APP_ID = opaque("app", "r");
const utf8 = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

async function authorityWithContacts(): Promise<ProductionStoreAuthority> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const namespaceId = opaque("ns", "r");
  const authority = ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: namespaceId,
    displayName: "Import coordinator test",
    shellId: "blank",
    appInstanceId: APP_ID,
    generationId: opaque("gen", "r"),
    namespaceId,
    adoptionOperationId: opaque("op", "r"),
    releaseId: opaque("rel", "r"),
    nowMs: Date.now(),
    leaseTtlMs: 60_000,
  });
  await authority.executeMutation({
    requestId: opaque("req", "r"), route: "starter.seed", payload: {
      schema: 1, shellId: "contacts", shellName: "Contacts",
      tables: [{
        name: "contacts",
        columns: [
          { name: "email", type: "text", required: true },
          { name: "name", type: "text", required: true },
        ],
        sampleRows: [
          { email: "a@example.com", name: "Old" },
          { email: "same@example.com", name: "Same" },
        ],
      }],
      panels: [],
    },
  });
  return authority;
}

async function stageContactsImport(authority: ProductionStoreAuthority): Promise<{
  coordinator: ImportSessionCoordinator;
  sessionId: string;
}> {
  const parser = new ImportParserSessionStore({
    sessionId: () => opaque("import", "x"),
  });
  const descriptor = await parser.openImportSource({
    appInstanceId: APP_ID,
    kind: "paste",
    bytes: utf8("Email\tName\nnew@example.com\tNew"),
  });
  const coordinator = new ImportSessionCoordinator(authority);
  coordinator.beginImport({ descriptor, targetTable: "contacts" });
  coordinator.stageImportChunk({
    appInstanceId: APP_ID,
    chunk: await parser.readImportChunk({
      appInstanceId: APP_ID, sessionId: descriptor.sessionId, cursor: 0,
    }),
  });
  parser.closeImportSource({
    appInstanceId: APP_ID, sessionId: descriptor.sessionId, reason: "commit",
  });
  return { coordinator, sessionId: descriptor.sessionId };
}

describe("Release C staged import coordinator", () => {
  it("C-T-INT-001/C-T-INT-004 carries CSV chunks through exact preview, receipt, and undo", async () => {
    const authority = await authorityWithContacts();
    const parser = new ImportParserSessionStore({
      sessionId: () => opaque("import", "r"),
    });
    const coordinator = new ImportSessionCoordinator(authority);
    try {
      const descriptor = await parser.openImportSource({
        appInstanceId: APP_ID,
        kind: "csv",
        bytes: utf8([
          "Email,Name",
          "a@example.com,Alice",
          "new@example.com,New",
          "same@example.com,Same",
          ",",
        ].join("\n")),
      });
      coordinator.beginImport({ descriptor, targetTable: "contacts" });
      let cursor: number | null = 0;
      while (cursor !== null) {
        const chunk = await parser.readImportChunk({
          appInstanceId: APP_ID, sessionId: descriptor.sessionId, cursor,
        });
        coordinator.stageImportChunk({ appInstanceId: APP_ID, chunk });
        cursor = chunk.nextCursor;
      }
      parser.closeImportSource({
        appInstanceId: APP_ID, sessionId: descriptor.sessionId, reason: "commit",
      });

      expect(coordinator.importStructure(descriptor.sessionId)).toMatchObject({
        complete: true,
        headerCandidate: { recommendedRow: 1, confidence: "low" },
        inferredColumns: [
          { label: "Email", inferredType: "text" },
          { label: "Name", inferredType: "text" },
        ],
      });
      expect(coordinator.importStructure(descriptor.sessionId, { mode: "no_header" })
        .inferredColumns.map(column => column.label)).toEqual(["Column 1", "Column 2"]);
      coordinator.configureImport({
        sessionId: descriptor.sessionId,
        header: { mode: "header", sourceRow: 1 },
        mode: { kind: "upsert", matchField: "email" },
        mappings: [
          { sourceColumn: 1, targetField: "email" },
          { sourceColumn: 2, targetField: "name" },
        ],
      });
      const preview = coordinator.previewImport(descriptor.sessionId);
      expect(preview).toMatchObject({
        sourceTotals: { sourceRows: 4, createRows: 1, updateRows: 1,
          skipRows: 2, blockedRows: 0 },
        mutationTotals: { primaryTargetCreates: 1, primaryTargetUpdates: 1,
          changedCount: 2 },
        commitAllowed: true,
      });

      const result = await coordinator.commitImport({
        sessionId: descriptor.sessionId,
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
        idempotencyKey: preview.idempotencyKey,
      });
      expect(result).toMatchObject({ kind: "receipt", durable: true, changed: 2 });
      expect(() => coordinator.previewImport(descriptor.sessionId)).toThrow(/unknown import session/i);
      expect(authority.readStore().query({ from: "contacts" })).toHaveLength(3);

      if (result.kind !== "receipt") throw new Error("expected durable receipt");
      const undone = await coordinator.undoImport(result.id, opaque("req", "u"));
      expect(undone).toMatchObject({ undone: true, undo: { state: "undone" } });
      expect(authority.readStore().query({ from: "contacts" })).toMatchObject([
        { email: "a@example.com", name: "Old" },
        { email: "same@example.com", name: "Same" },
      ]);
    } finally {
      authority.close();
    }
  });

  it("C-T-INT-002 carries a selected XLSX sheet through preview, commit receipt, and undo", async () => {
    const authority = await authorityWithContacts();
    const parser = new ImportParserSessionStore({
      sessionId: () => opaque("import", "y"),
    });
    const coordinator = new ImportSessionCoordinator(authority);
    try {
      const source = xlsxFixture({ sheets: [
        { name: "Ignore", xml: worksheetXml(
          `<row r="1"><c r="A1" t="inlineStr"><is><t>decoy</t></is></c></row>`,
        ) },
        { name: "Contacts", state: "hidden", xml: worksheetXml(
          `<row r="1"><c r="A1" t="inlineStr"><is><t>Email</t></is></c>`
          + `<c r="B1" t="inlineStr"><is><t>Name</t></is></c></row>`
          + `<row r="2"><c r="A2" t="inlineStr"><is><t>xlsx@example.com</t></is></c>`
          + `<c r="B2" t="inlineStr"><is><t>Workbook</t></is></c></row>`,
          "A1:B2",
        ) },
      ] });
      const descriptor = await parser.openImportSource({
        appInstanceId: APP_ID, kind: "xlsx", bytes: source,
      });
      coordinator.beginImport({ descriptor, targetTable: "contacts", sheetId: "sheet_2" });
      const chunk = await parser.readImportChunk({
        appInstanceId: APP_ID, sessionId: descriptor.sessionId,
        sheetId: "sheet_2", cursor: 0,
      });
      coordinator.stageImportChunk({ appInstanceId: APP_ID, chunk });
      await parser.closeImportSource({
        appInstanceId: APP_ID, sessionId: descriptor.sessionId, reason: "commit",
      });
      coordinator.configureImport({
        sessionId: descriptor.sessionId,
        header: { mode: "header", sourceRow: 1 },
        mode: { kind: "append" },
        mappings: [
          { sourceColumn: 1, targetField: "email" },
          { sourceColumn: 2, targetField: "name" },
        ],
      });
      const preview = coordinator.previewImport(descriptor.sessionId);
      expect(preview).toMatchObject({ sourceKind: "xlsx", sourceTotals: {
        sourceRows: 1, createRows: 1, updateRows: 0, skipRows: 0, blockedRows: 0,
      } });
      const result = await coordinator.commitImport({
        sessionId: descriptor.sessionId,
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
        idempotencyKey: preview.idempotencyKey,
      });
      expect(result).toMatchObject({ kind: "receipt", sourceKind: "xlsx", changed: 1 });
      expect(authority.readStore().query({ from: "contacts" }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ email: "xlsx@example.com", name: "Workbook" }),
        ]));
      if (result.kind !== "receipt") throw new Error("expected durable receipt");
      await coordinator.undoImport(result.id, opaque("req", "v"));
      expect(authority.readStore().query({ from: "contacts" })
        .some(row => row.email === "xlsx@example.com")).toBe(false);
    } finally {
      authority.close();
    }
  });

  it("fails closed on malformed header and mode discriminants at the DB-worker boundary", async () => {
    const authority = await authorityWithContacts();
    try {
      const { coordinator, sessionId } = await stageContactsImport(authority);
      expect(() => coordinator.importStructure(sessionId,
        { mode: "guessed" } as unknown as Parameters<ImportSessionCoordinator["importStructure"]>[1]))
        .toThrow(expect.objectContaining({ code: "E_VALIDATION" }));
      expect(() => coordinator.configureImport({
        sessionId,
        header: { mode: "header", sourceRow: 1 },
        mode: { kind: "replace" } as never,
        mappings: [{ sourceColumn: 1, targetField: "email" }],
      })).toThrow(expect.objectContaining({ code: "E_VALIDATION" }));
    } finally {
      authority.close();
    }
  });

  it("disposes staged cells when the active authority app no longer matches", async () => {
    const authority = await authorityWithContacts();
    try {
      const { coordinator, sessionId } = await stageContactsImport(authority);
      vi.spyOn(authority, "bootInfo").mockReturnValue({
        ...authority.bootInfo(), selectedAppInstanceId: opaque("app", "z"),
      });
      expect(() => coordinator.importStructure(sessionId))
        .toThrow(expect.objectContaining({ code: "E_CONFLICT" }));
      expect(() => coordinator.importStructure(sessionId)).toThrow(/unknown import session/i);
    } finally {
      vi.restoreAllMocks();
      authority.close();
    }
  });
});
