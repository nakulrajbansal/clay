import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openDriverFromBytes, openMemoryDriver, zipRead, zipWrite,
  type ForwardOpT,
} from "../src/index";

async function fileStore(): Promise<{ store: ClayStore; rowId: string }> {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "projects", columns: [
    { name: "name", type: "text", required: true },
    { name: "notes", type: "rich_text", required: false },
    { name: "files", type: "attachment", required: false },
  ] }];
  store.commit({ intent: "file fields", summary: "Adds notes and files.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  const row = store.insert("projects", { name: "Apollo", notes: "**Important**\n- verify" });
  return { store, rowId: String(row.id) };
}

describe("local attachments and rich records", () => {
  it("bounds retained bytes as well as active bytes", async () => {
    const driver = await openMemoryDriver();
    const store = await ClayStore.fromDriver(driver);
    try {
      const operations: ForwardOpT[] = [{ op: "create_table", table: "projects", columns: [
        { name: "name", type: "text", required: true },
        { name: "files", type: "attachment", required: false },
      ] }];
      store.commit({ intent: "files", summary: "Files.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
      const row = store.insert("projects", { name: "Apollo" });
      driver.exec(`INSERT INTO __clay_attachments(
        id, name, mime, size, sha256, bytes, created_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        "file_018f0000000070008000000000000001", "old.pdf", "application/pdf",
        250 * 1024 * 1024, "0".repeat(64), new Uint8Array([1]),
        "2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z",
      ]);
      await expect(store.addAttachment({ table: "projects", rowId: String(row.id),
        field: "files", name: "new.pdf", mime: "application/pdf",
        bytes: new Uint8Array([37, 80, 68, 70]),
      })).rejects.toThrow(/retained/i);
    } finally { store.close(); }
  });

  it("stores metadata separately, verifies bytes, and preserves portable rich notes", async () => {
    const { store, rowId } = await fileStore();
    try {
      expect(store.query({ from: "projects" })[0]).toMatchObject({
        notes: "**Important**\n- verify", files: null,
      });
      expect(() => store.update("projects", rowId, { files: ["forged"] }))
        .toThrow(/file API/i);
      const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
      const meta = await store.addAttachment({
        table: "projects", rowId, field: "files",
        name: "../contract.pdf", mime: "application/pdf", bytes,
      });
      expect(meta).toMatchObject({ name: "contract.pdf", mime: "application/pdf", size: 8 });
      expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(store.query({ from: "projects", select: ["files"] }))
        .toEqual([{ files: [meta.id] }]);
      expect(store.attachmentsForRecord("projects", rowId, "files")).toEqual([meta]);
      const downloaded = await store.readAttachment(meta.id);
      expect(downloaded.bytes).toEqual(bytes);
      expect(store.attachmentStorage()).toMatchObject({ activeFiles: 1, activeBytes: 8 });
    } finally { store.close(); }
  });

  it("rejects executable or oversized input and bounds each record field", async () => {
    const { store, rowId } = await fileStore();
    try {
      await expect(store.addAttachment({
        table: "projects", rowId, field: "files", name: "payload.exe",
        mime: "application/octet-stream", bytes: new Uint8Array([1, 2, 3]),
      })).rejects.toThrow(/file type/i);
      await expect(store.addAttachment({
        table: "projects", rowId, field: "files", name: "fake.png",
        mime: "image/png", bytes: new TextEncoder().encode("not a png"),
      })).rejects.toThrow(/signature/i);
      await expect(store.addAttachment({
        table: "projects", rowId, field: "files", name: "large.pdf",
        mime: "application/pdf", bytes: new Uint8Array(10 * 1024 * 1024 + 1),
      })).rejects.toThrow(/10 MB/i);
    } finally { store.close(); }
  });

  it("soft-removes files and purges only old, unreferenced bytes", async () => {
    const { store, rowId } = await fileStore();
    try {
      const meta = await store.addAttachment({
        table: "projects", rowId, field: "files", name: "photo.jpg",
        mime: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 217]),
      });
      store.removeAttachment("projects", rowId, "files", meta.id);
      expect(store.attachmentsForRecord("projects", rowId, "files")).toEqual([]);
      expect(store.attachmentStorage()).toMatchObject({ activeFiles: 0, deletedFiles: 1 });
      expect(store.purgeDeletedAttachments(new Date(), 30)).toMatchObject({ files: 0, bytes: 0 });
      const future = new Date(Date.now() + 31 * 86_400_000);
      expect(store.purgeDeletedAttachments(future, 30)).toMatchObject({ files: 1, bytes: 4 });
      await expect(store.readAttachment(meta.id)).rejects.toThrow(/not found/i);
    } finally { store.close(); }
  });

  it("reactivates retained bytes when row history restores a removed file", async () => {
    const { store, rowId } = await fileStore();
    try {
      const meta = await store.addAttachment({
        table: "projects", rowId, field: "files", name: "plan.pdf",
        mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]),
      });
      store.removeAttachment("projects", rowId, "files", meta.id);
      store.restoreRow("projects", rowId);
      expect(store.attachmentsForRecord("projects", rowId, "files")).toEqual([meta]);
      store.restoreRow("projects", rowId);
      expect(store.attachmentsForRecord("projects", rowId, "files")).toEqual([meta]);
      expect((await store.readAttachment(meta.id)).bytes).toEqual(new Uint8Array([37, 80, 68, 70]));
    } finally { store.close(); }
  });

  it("preserves files through schema rewind, archive import, and roll-forward", async () => {
    const { store, rowId } = await fileStore();
    try {
      const meta = await store.addAttachment({
        table: "projects", rowId, field: "files", name: "plan.pdf",
        mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]),
      });
      store.rollbackTo(0);
      const archive = await store.exportArchive("rewound-files");
      const imported = await ClayStore.importArchive(archive);
      try {
        imported.store.rollForwardTo(1);
        expect((await imported.store.readAttachment(meta.id)).bytes.byteLength).toBe(4);
        expect(imported.store.attachmentsForRecord("projects", rowId, "files"))
          .toHaveLength(1);
      } finally { imported.store.close(); }
    } finally { store.close(); }
  });

  it("rejects invalid imported names, types, and per-file limits", async () => {
    const { store, rowId } = await fileStore();
    try {
      const meta = await store.addAttachment({ table: "projects", rowId, field: "files",
        name: "plan.pdf", mime: "application/pdf",
        bytes: new Uint8Array([37, 80, 68, 70]),
      });
      const parts = zipRead(await store.exportArchive("bad-file"));
      const driver = await openDriverFromBytes(
        parts.find(part => part.name === "user.db")!.data,
        parts.find(part => part.name === "system.db")!.data,
      );
      driver.exec(`UPDATE "__clay_attachments" SET name = ?, mime = ? WHERE id = ?`,
        ["payload.svg", "image/svg+xml", meta.id]);
      const changed = await driver.exportDatabases();
      driver.close();
      const tampered = zipWrite(parts.map(part => part.name === "user.db"
        ? { ...part, data: changed.user }
        : part.name === "system.db" ? { ...part, data: changed.system } : part));
      await expect(ClayStore.importArchive(tampered)).rejects.toThrow(/file type|attachment/i);
    } finally { store.close(); }
  });

  it("serializes concurrent uploads at the quota and reference boundary", async () => {
    const { store, rowId } = await fileStore();
    try {
      const attempts = await Promise.allSettled(Array.from({ length: 21 }, (_, index) =>
        store.addAttachment({ table: "projects", rowId, field: "files",
          name: `file-${index}.txt`, mime: "text/plain",
          bytes: new Uint8Array([index + 1]) })));
      expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(20);
      expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(store.attachmentsForRecord("projects", rowId, "files")).toHaveLength(20);
      const archive = await store.exportArchive("concurrent-files");
      await expect(ClayStore.importArchive(archive)).resolves.toMatchObject({ invalidPanels: [] });
    } finally { store.close(); }
  });

  it("round-trips bytes in format 4 archives and rejects tampering", async () => {
    const { store, rowId } = await fileStore();
    try {
      const meta = await store.addAttachment({
        table: "projects", rowId, field: "files", name: "receipt.png",
        mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      });
      const archive = await store.exportArchive("files");
      const parts = zipRead(archive);
      const manifest = JSON.parse(new TextDecoder().decode(
        parts.find(part => part.name === "manifest.json")!.data));
      expect(manifest).toMatchObject({ format: 4, attachments: { count: 1, bytes: 8 } });
      const missingCounts = zipWrite(parts.map(part => part.name === "manifest.json"
        ? { ...part, data: new TextEncoder().encode(JSON.stringify({ ...manifest, attachments: undefined })) }
        : part));
      await expect(ClayStore.importArchive(missingCounts)).rejects.toThrow(/attachment manifest/i);
      const imported = await ClayStore.importArchive(archive);
      try {
        expect((await imported.store.readAttachment(meta.id)).bytes)
          .toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      } finally { imported.store.close(); }

      const user = parts.find(part => part.name === "user.db")!.data;
      const system = parts.find(part => part.name === "system.db")!.data;
      const driver = await openDriverFromBytes(user, system);
      driver.exec(`UPDATE "__clay_attachments" SET "bytes" = ? WHERE "id" = ?`,
        [new Uint8Array([0, 1, 2]), meta.id]);
      const changed = await driver.exportDatabases();
      driver.close();
      const tampered = zipWrite(parts.map(part => part.name === "user.db"
        ? { ...part, data: changed.user } : part.name === "system.db"
          ? { ...part, data: changed.system } : part));
      await expect(ClayStore.importArchive(tampered)).rejects.toThrow(/attachment integrity/i);
    } finally { store.close(); }
  });
});
