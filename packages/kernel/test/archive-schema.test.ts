import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openDriverFromBytes, zipRead, zipWrite,
  type DbDriver, type ForwardOpT,
} from "../src/index";

async function baseStore(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "things", columns: [
    { name: "value", type: "text", required: false },
  ] }];
  store.commit({ intent: "things", summary: "Things.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  store.insert("things", { value: "ok" });
  return store;
}

async function mutateArchive(
  bytes: Uint8Array, mutate: (driver: DbDriver) => void,
): Promise<Uint8Array> {
  const parts = zipRead(bytes);
  const driver = await openDriverFromBytes(
    parts.find(part => part.name === "user.db")!.data,
    parts.find(part => part.name === "system.db")!.data,
  );
  mutate(driver);
  const databases = await driver.exportDatabases();
  driver.close();
  return zipWrite(parts.map(part => part.name === "user.db"
    ? { ...part, data: databases.user }
    : part.name === "system.db" ? { ...part, data: databases.system } : part));
}

describe("canonical archive schema and history", () => {
  it("rejects noncanonical registered table definitions", async () => {
    const store = await baseStore();
    const archive = await mutateArchive(await store.exportArchive("x"), driver => {
      driver.exec('ALTER TABLE "things" RENAME TO "old_things"');
      driver.exec('CREATE TABLE "things"("id" TEXT PRIMARY KEY,"created_at" TEXT NOT NULL,"updated_at" TEXT NOT NULL,"deleted_at" TEXT,"value" TEXT CHECK(length("value")<3))');
      driver.exec('INSERT INTO "things" SELECT * FROM "old_things"');
      driver.exec('DROP TABLE "old_things"');
    });
    store.close();
    await expect(ClayStore.importArchive(archive)).rejects.toThrow(/canonical|constraint|definition/i);
  });

  it("rejects poisoned kernel-owned attachment and history tables", async () => {
    const store = await baseStore();
    const archive = await mutateArchive(await store.exportArchive("internal-schema"), driver => {
      driver.exec('ALTER TABLE "__clay_attachments" RENAME TO "old_attachments"');
      driver.exec('CREATE TABLE "__clay_attachments"("id" TEXT PRIMARY KEY,"name" TEXT NOT NULL CHECK(length("name")<2),"mime" TEXT NOT NULL,"size" INTEGER NOT NULL,"sha256" TEXT NOT NULL,"bytes" BLOB NOT NULL,"created_at" TEXT NOT NULL,"deleted_at" TEXT)');
      driver.exec('DROP TABLE "old_attachments"');
    });
    store.close();
    await expect(ClayStore.importArchive(archive)).rejects.toThrow(/attachment|canonical|constraint/i);
  });

  it("rejects malformed migration plans retained in timeline history", async () => {
    const store = await baseStore();
    store.commit({ intent: "panel-only", summary: "No schema change.", migration: null });
    const archive = await mutateArchive(await store.exportArchive("bad-history"), driver => {
      driver.exec("UPDATE sys.version_log SET migration_json = ?, inverse_json = ? WHERE version = 2", [
        JSON.stringify([{ op: "delete_everything", table: "things" }]), JSON.stringify([]),
      ]);
    });
    store.close();
    await expect(ClayStore.importArchive(archive)).rejects.toThrow(/migration|timeline|history/i);
  });

  it("rejects invalid panel code dormant at an older reachable version", async () => {
    const store = await baseStore();
    store.commit({ intent: "panel", summary: "Adds panel.", migration: null, panels: [{
      panel_id: "things_panel", title: "Things", placement: { region: "main", order: 0 },
      code: 'export default function (clay) { clay.ui.render(h(EmptyState, { label: "ok" })); }',
      declared_queries: [{ from: "things" }], declared_writes: [],
    }] });
    store.commit({ intent: "remove panel", summary: "Removes panel.", migration: null,
      removePanels: ["things_panel"] });
    const archive = await mutateArchive(await store.exportArchive("old-panel"), driver => {
      driver.exec("UPDATE sys.panel_blobs SET code = ? WHERE panel_id = 'things_panel'", [
        'export default function () { fetch("https://example.invalid"); }',
      ]);
    });
    store.close();
    await expect(ClayStore.importArchive(archive)).rejects.toThrow(/panel|history|timeline/i);
  });

  it("rejects an out-of-range current version and a partial retained index", async () => {
    const versionStore = await baseStore();
    const badVersion = await mutateArchive(await versionStore.exportArchive("bad-version"),
      (_user) => _user.exec(
        `UPDATE sys.settings SET value_json = '999' WHERE key = 'current_version'`));
    await expect(ClayStore.importArchive(badVersion)).rejects.toThrow(/current_version|version cursor/i);
    const mismatchedCursor = await mutateArchive(await versionStore.exportArchive("bad-cursor"),
      user => user.exec(`UPDATE sys.settings SET value_json = '0' WHERE key = 'current_version'`));
    await expect(ClayStore.importArchive(mismatchedCursor)).rejects.toThrow(/current_version|cursor|registry/i);
    const missingCursor = await mutateArchive(await versionStore.exportArchive("missing-cursor"),
      user => user.exec(`DELETE FROM sys.settings WHERE key = 'current_version'`));
    await expect(ClayStore.importArchive(missingCursor)).rejects.toThrow(/current_version|required/i);
    versionStore.close();

    const indexStore = await baseStore();
    const operations: ForwardOpT[] = [{ op: "add_index", table: "things", column: "value" }];
    indexStore.commit({ intent: "Index values", summary: "Indexes values.",
      migration: { operations, inverse: deriveInverse(operations, indexStore.registrySnapshot()) } });
    const partial = await mutateArchive(await indexStore.exportArchive("partial-index"), user => {
      user.exec(`DROP INDEX "idx_things_value"`);
      user.exec(`CREATE INDEX "idx_things_value" ON "things"("value") WHERE "value" IS NOT NULL`);
    });
    await expect(ClayStore.importArchive(partial)).rejects.toThrow(/index|partial|canonical/i);
    indexStore.close();
  });
});
