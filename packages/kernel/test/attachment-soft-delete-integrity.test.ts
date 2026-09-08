import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openDriverFromBytes, zipRead, zipWrite,
  type ForwardOpT,
} from "../src/index";

async function removeRecoverableAttachment(
  archive: Uint8Array, rowId: string, attachmentId: string,
): Promise<Uint8Array> {
  const parts = zipRead(archive);
  const driver = await openDriverFromBytes(
    parts.find(part => part.name === "user.db")!.data,
    parts.find(part => part.name === "system.db")!.data,
  );
  const deletedAt = "2026-09-08T12:00:00.000Z";
  driver.exec(`UPDATE "docs" SET "deleted_at" = ?, "updated_at" = ? WHERE "id" = ?`,
    [deletedAt, deletedAt, rowId]);
  driver.exec(`DELETE FROM "__clay_attachments" WHERE "id" = ?`, [attachmentId]);
  const changed = await driver.exportDatabases();
  driver.close();
  return zipWrite(parts.map(part => {
    if (part.name === "user.db") return { ...part, data: changed.user };
    if (part.name === "system.db") return { ...part, data: changed.system };
    if (part.name === "manifest.json") {
      const manifest = JSON.parse(new TextDecoder().decode(part.data)) as Record<string, unknown>;
      manifest.attachments = { count: 0, bytes: 0 };
      return { ...part, data: new TextEncoder().encode(JSON.stringify(manifest)) };
    }
    return part;
  }));
}

describe("recoverable attachment integrity", () => {
  it("rejects an archive missing the retained file of a soft-deleted restorable row", async () => {
    const store = await ClayStore.openMemory();
    try {
      const operations: ForwardOpT[] = [{
        op: "create_table",
        table: "docs",
        columns: [
          { name: "name", type: "text", required: true },
          { name: "files", type: "attachment", required: false },
        ],
      }];
      store.commit({
        intent: "create docs", summary: "Created docs.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      });
      const row = store.insert("docs", { name: "recoverable" });
      const attachment = await store.addAttachment({
        table: "docs", rowId: String(row.id), field: "files",
        name: "evidence.txt", mime: "text/plain",
        bytes: new TextEncoder().encode("retained evidence"),
      });
      const tampered = await removeRecoverableAttachment(
        await store.exportArchive("soft-deleted attachment"), String(row.id), attachment.id,
      );
      await expect(ClayStore.importArchive(tampered)).rejects.toThrow(/attachment|integrity|missing/i);
    } finally { store.close(); }
  });
});
