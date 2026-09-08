import { describe, expect, it } from "vitest";
import { openMemoryDriver } from "../src/index";
import { prepareExistingTableImport } from "../src/import-journey";
import { ProductionStoreAuthority } from "../src/production-authority";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

async function authorityWithContacts(): Promise<{
  authority: ProductionStoreAuthority;
  driver: Awaited<ReturnType<typeof openMemoryDriver>>;
}> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const namespaceId = opaque("ns", "i");
  const authority = ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: namespaceId,
    displayName: "Import authority test",
    shellId: "blank",
    appInstanceId: opaque("app", "i"),
    generationId: opaque("gen", "i"),
    namespaceId,
    adoptionOperationId: opaque("op", "i"),
    releaseId: opaque("rel", "i"),
    nowMs: Date.now(),
    leaseTtlMs: 60_000,
  });
  await authority.executeMutation({
    requestId: opaque("req", "s"),
    route: "starter.seed",
    payload: {
      schema: 1,
      shellId: "contacts",
      shellName: "Contacts",
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
  return { authority, driver };
}

describe("Release C production import authority", () => {
  it("C-FR-023/C-FR-025 routes an opaque prepared import and undo through authoritative replay", async () => {
    const { authority, driver } = await authorityWithContacts();
    try {
      const reader = authority.readStore();
      const prepared = prepareExistingTableImport({
        appInstanceId: opaque("app", "i"),
        sessionId: opaque("import", "j"),
        sourceKind: "csv",
        sourceDigest: `sha256:${"a".repeat(64)}`,
        baseVersion: reader.headVersion(),
        sourceRows: [
          ["Email", "Name"],
          ["a@example.com", "Alice"],
          ["new@example.com", "New"],
          ["same@example.com", "Same"],
        ],
        header: { mode: "header", sourceRow: 1 },
        target: reader.registrySnapshot().get("contacts")!,
        existingRows: reader.query({ from: "contacts" }),
        mode: { kind: "upsert", matchField: "email" },
        mappings: [
          { sourceColumn: 1, targetField: "email" },
          { sourceColumn: 2, targetField: "name" },
        ],
      });
      const commitRequest = {
        requestId: opaque("req", "c"),
        route: "import.commit",
        payload: {
          ...prepared.envelope,
          receiptId: "018f0000-0000-7000-8000-000000000020",
          summary: "Import contacts",
        },
      };

      const malformedWarningTotals = structuredClone(commitRequest);
      malformedWarningTotals.requestId = opaque("req", "w");
      malformedWarningTotals.payload.receiptId = "018f0000-0000-7000-8000-000000000021";
      malformedWarningTotals.payload.warningTotals = {
        ...prepared.envelope.warningTotals,
        warnings: prepared.envelope.warningTotals.warnings + 1,
      };
      await expect(authority.executeMutation(malformedWarningTotals)).rejects.toMatchObject({
        code: "E_VALIDATION",
      });
      expect(reader.query({ from: "contacts" })).toHaveLength(2);

      const committed = await authority.executeMutation(commitRequest);
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: {
          kind: "receipt", source: "import", changed: 2,
          sourceTotals: { createRows: 1, updateRows: 1, skipRows: 1, blockedRows: 0 },
          mutationTotals: { changedCount: 2 },
        },
      });
      await expect(authority.executeMutation(structuredClone(commitRequest)))
        .resolves.toMatchObject({ replayed: true, result: committed.result });
      expect(reader.query({ from: "contacts" })).toHaveLength(3);
      expect(driver.select(
        "SELECT origin FROM sys.record_events ORDER BY seq DESC LIMIT 2",
      ).map(event => event.origin)).toEqual(["import", "import"]);

      const undone = await authority.executeMutation({
        requestId: opaque("req", "u"),
        route: "import.undo",
        payload: { receiptId: "018f0000-0000-7000-8000-000000000020" },
      });
      expect(undone).toMatchObject({
        changed: true,
        result: { kind: "receipt", undone: true, undo: { state: "undone" } },
      });
      expect(reader.query({ from: "contacts" })).toMatchObject([
        { email: "a@example.com", name: "Old" },
        { email: "same@example.com", name: "Same" },
      ]);
    } finally {
      authority.close();
    }
  });
});
