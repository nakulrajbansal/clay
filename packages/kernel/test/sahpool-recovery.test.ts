import { afterEach, expect, it, vi } from "vitest";
import { installedSahpool, OwnedSahDirectory } from "./helpers/owned-sahpool";
import { classifyDurableFileInventory } from "../src/durable-inventory";
import { automationPhysicalTransactionCapability } from "../src/db";
import { installSahpoolJournalRecovery } from "../src/sahpool-journal-recovery";

afterEach(() => vi.unstubAllGlobals());
const files = ["/user.db", "/system.db", "/clay-device-catalog-v1.db"];
function open(pool: any) {
  const db = new pool.OpfsSAHPoolDb(files[0]);
  db.exec(`ATTACH 'file:${files[1]}?vfs=opfs-sahpool' AS sys`);
  db.exec(`ATTACH 'file:${files[2]}?vfs=opfs-sahpool' AS catalog`);
  return db;
}
function values(db: any): number[] { return ["main", "sys", "catalog"].map(name => db.selectValue(`SELECT value FROM ${name}.owned_value`)); }
it("runs the installed browser SAHPool and wasm against exclusive owned handles with real journal/super-journal callbacks", async () => {
  const owned = new OwnedSahDirectory(), { sqlite, pool } = await installedSahpool(owned), db = open(pool);
  try {
    for (const name of ["main", "sys", "catalog"]) db.exec(`CREATE TABLE ${name}.owned_value(value INTEGER); INSERT INTO ${name}.owned_value VALUES (1)`);
    owned.events.length = 0;
    db.exec("BEGIN; UPDATE owned_value SET value=2; UPDATE sys.owned_value SET value=2; UPDATE catalog.owned_value SET value=2; COMMIT");
    expect(values(db)).toEqual([2, 2, 2]);
    expect(owned.events.some(event => event.path.endsWith("-journal") && event.op === "flush")).toBe(true);
    expect(owned.events.some(event => /-mj/.test(event.path) && event.op === "flush")).toBe(true);
    expect(files.every(path => owned.events.some(event => event.path === path && event.op === "flush"))).toBe(true);
    expect(classifyDurableFileInventory(pool.getFileNames()).state).toBe("complete");
    expect(sqlite.capi.sqlite3_libversion()).toBe("3.53.0");
    expect(automationPhysicalTransactionCapability(db).kind).toBe("unavailable");
  } finally { db.close(); pool.pauseVfs(); }
});

const cuts = ["journal_create", "journal_write", "journal_flush", "master_create", "master_flush", "master_delete", "journal_delete", "user_write", "system_write", "catalog_write"] as const;
it.each(cuts.flatMap(cut => [false, true].map(writeThrough => ({ cut, writeThrough }))))(
  "recovers atomic rows and owned-only inventory after $cut (writeThrough=$writeThrough)", async ({ cut, writeThrough }) => {
    const owned = new OwnedSahDirectory(); owned.writeThrough = writeThrough;
    const { pool } = await installedSahpool(owned);
    const legacyFiles = ["/app-unrelated-user.db", "/app-unrelated-system.db"];
    for (const file of legacyFiles) { const legacy = new pool.OpfsSAHPoolDb(file); legacy.exec("CREATE TABLE preserved(value); INSERT INTO preserved VALUES ('owned unrelated fixture')"); legacy.close(); }
    const priorLegacy = legacyFiles.map(file => pool.exportFile(file));
    const db = open(pool);
    for (const name of ["main", "sys", "catalog"]) db.exec(`CREATE TABLE ${name}.owned_value(value INTEGER); INSERT INTO ${name}.owned_value VALUES (1)`);
    owned.events.length = 0;
    owned.fault = e => {
      if (cut === "journal_create") return e.op === "write" && e.at === 0 && e.path.endsWith("-journal");
      if (cut === "journal_write") return e.op === "write" && e.at >= 4096 && e.path.endsWith("-journal");
      if (cut === "journal_flush") return e.op === "flush" && e.path.endsWith("-journal") && owned.events.some(row => row.path === e.path && row.at >= 4096);
      if (cut === "master_create") return e.op === "write" && e.at === 0 && /-mj/.test(e.path);
      if (cut === "master_flush") return e.op === "flush" && /-mj/.test(e.path);
      if (cut === "master_delete") return e.op === "write" && e.at === 0 && e.path === "" && /-mj/.test(e.previousPath);
      if (cut === "journal_delete") return e.op === "write" && e.at === 0 && e.path === "" && e.previousPath.endsWith("-journal");
      return e.op === "write" && e.at >= 4096 && e.path === files[{ user_write: 0, system_write: 1, catalog_write: 2 }[cut]];
    };
    // SQLite may return success if power loss hits post-commit journal cleanup.
    // A dead worker cannot deliver that result; reopen must reconcile it.
    try { db.exec("BEGIN; UPDATE owned_value SET value=2; UPDATE sys.owned_value SET value=2; UPDATE catalog.owned_value SET value=2; COMMIT"); } catch { /* Owned power loss. */ }
    expect(owned.dead).toBe(true);
    owned.reopen(); const reopened = await installedSahpool(owned), recovery = installSahpoolJournalRecovery(reopened.sqlite, reopened.pool);
    recovery.run(files, () => { const recovered = open(reopened.pool);
      try { expect([[1, 1, 1], [2, 2, 2]]).toContainEqual(values(recovered)); recovery.finish(recovered); }
      finally { recovered.close(); }
    });
    expect(reopened.pool.getFileNames().sort()).toEqual([...files, ...legacyFiles].sort());
    expect(legacyFiles.every((file, index) => Buffer.from(reopened.pool.exportFile(file)).equals(Buffer.from(priorLegacy[index])))).toBe(true);
    recovery.dispose(); reopened.pool.pauseVfs();
  });

it("retries a crash during native rollback without touching unrelated files or granting production automation", async () => {
  const owned = new OwnedSahDirectory(), { pool } = await installedSahpool(owned), db = open(pool);
  for (const name of ["main", "sys", "catalog"]) db.exec(`CREATE TABLE ${name}.owned_value(value INTEGER); INSERT INTO ${name}.owned_value VALUES (1)`);
  owned.fault = e => e.op === "flush" && e.path === files[1];
  expect(() => db.exec("BEGIN; UPDATE owned_value SET value=2; UPDATE sys.owned_value SET value=2; UPDATE catalog.owned_value SET value=2; COMMIT")).toThrow();
  owned.reopen(); const second = await installedSahpool(owned), interrupted = installSahpoolJournalRecovery(second.sqlite, second.pool);
  owned.fault = e => e.op === "flush" && e.path === files[0];
  expect(() => interrupted.run(files, () => open(second.pool))).toThrow(); expect(owned.dead).toBe(true);
  owned.reopen(); const third = await installedSahpool(owned), recovery = installSahpoolJournalRecovery(third.sqlite, third.pool);
  recovery.run(files, () => { const recovered = open(third.pool);
    try { expect(values(recovered)).toEqual([1, 1, 1]); recovery.finish(recovered); }
    finally { recovered.close(); }
  });
  expect(classifyDurableFileInventory(third.pool.getFileNames()).state).toBe("complete");
  recovery.dispose(); third.pool.pauseVfs();
});

it("refuses missing tuples, duplicate recovery installs, concurrent opens and foreign super-journal membership", async () => {
  const owned = new OwnedSahDirectory(), first = await installedSahpool(owned), db = open(first.pool);
  for (const name of ["main", "sys", "catalog"]) db.exec(`CREATE TABLE ${name}.owned_value(value INTEGER); INSERT INTO ${name}.owned_value VALUES (1)`);
  owned.fault = event => event.op === "flush" && event.path === files[0];
  expect(() => db.exec("BEGIN; UPDATE owned_value SET value=2; UPDATE sys.owned_value SET value=2; UPDATE catalog.owned_value SET value=2; COMMIT")).toThrow();
  owned.reopen();
  const master = owned.files.find(file => /-mj/.test(owned.path(file)))!;
  const foreign = new TextEncoder().encode("/app-unrelated-user.db-journal\0");
  const altered = new Uint8Array(master.durable.length + foreign.length); altered.set(master.durable); altered.set(foreign, master.durable.length);
  master.durable = altered; master.live = altered.slice();
  const second = await installedSahpool(owned), recovery = installSahpoolJournalRecovery(second.sqlite, second.pool);
  expect(() => installSahpoolJournalRecovery(second.sqlite, second.pool)).toThrow(/already/);
  expect(() => recovery.run(["/user.db"], () => {})).toThrow(/exact/);
  expect(() => recovery.run(files, () => open(second.pool))).toThrow(/unowned/);
  expect(() => recovery.run(files, () => {})).toThrow(/unopened/); // Poisoned adapter must not retry an uncertain in-memory VFS map.
  expect(Buffer.from(master.durable).equals(Buffer.from(altered))).toBe(true);
  recovery.dispose(); second.pool.pauseVfs();
});

it("does not grant the real production driver automation capability merely because the recovery adapter exists", async () => {
  const owned = new OwnedSahDirectory(), { sqlite, pool } = await installedSahpool(owned), initial = open(pool); initial.close();
  const recovery = installSahpoolJournalRecovery(sqlite, pool);
  vi.resetModules(); vi.doMock("@sqlite.org/sqlite-wasm", () => ({ default: async () => sqlite }));
  const runtime = await import("../src/db");
  const driver = await runtime.openBrowserProductionTarget({ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" });
  try {
    expect(runtime.automationPhysicalTransactionCapability(driver)).toEqual({ kind: "unavailable", releaseCertificate: false });
    expect(() => recovery.run(files, () => {})).toThrow(/unopened/);
  } finally { driver.close(); recovery.dispose(); pool.pauseVfs(); vi.doUnmock("@sqlite.org/sqlite-wasm"); vi.resetModules(); }
});

it.each(["xDelete", "xAccess"])("rejects an unowned native %s side path before touching an unrelated namespace", async operation => {
  const owned = new OwnedSahDirectory(), { sqlite, pool } = await installedSahpool(owned), db = open(pool);
  for (const name of ["main", "sys", "catalog"]) db.exec(`CREATE TABLE ${name}.owned_value(value INTEGER); INSERT INTO ${name}.owned_value VALUES (1)`);
  db.close();
  const path = "/app-unrelated-user.db", other = new pool.OpfsSAHPoolDb(path);
  other.exec("CREATE TABLE preserved(value); INSERT INTO preserved VALUES (99)"); other.close();
  const original = pool.exportFile(path), recovery = installSahpoolJournalRecovery(sqlite, pool);
  const vfs = new sqlite.capi.sqlite3_vfs(sqlite.capi.sqlite3_vfs_find("opfs-sahpool"));
  try {
    expect(() => recovery.run(files, () => {
      const scope = sqlite.wasm.scopedAllocPush();
      try {
        const name = sqlite.wasm.scopedAllocCString(path);
        if (operation === "xDelete") sqlite.wasm.functionEntry(vfs.$xDelete)(vfs.pointer, name, 1);
        else sqlite.wasm.functionEntry(vfs.$xAccess)(vfs.pointer, name, sqlite.capi.SQLITE_ACCESS_EXISTS, sqlite.wasm.scopedAlloc(4));
      } finally { sqlite.wasm.scopedAllocPop(scope); }
    })).toThrow(/unowned/);
    expect(Buffer.from(pool.exportFile(path)).equals(Buffer.from(original))).toBe(true);
    expect(() => recovery.run(files, () => {})).toThrow(/unopened/);
  } finally { recovery.dispose(); pool.pauseVfs(); }
});

it.each(files)("recovers the three-file transaction after worker loss immediately after flushing %s", async cutFile => {
  const owned = new OwnedSahDirectory(), { pool } = await installedSahpool(owned), db = open(pool);
  for (const name of ["main", "sys", "catalog"]) db.exec(`CREATE TABLE ${name}.owned_value(value INTEGER); INSERT INTO ${name}.owned_value VALUES (1)`);
  owned.events.length = 0; owned.fault = event => event.op === "flush" && event.path === cutFile;
  expect(() => db.exec("BEGIN; UPDATE owned_value SET value=2; UPDATE sys.owned_value SET value=2; UPDATE catalog.owned_value SET value=2; COMMIT")).toThrow();
  expect(owned.dead).toBe(true);
  owned.reopen(); const reopened = await installedSahpool(owned);
  const recovery = installSahpoolJournalRecovery(reopened.sqlite, reopened.pool);
  recovery.run(files, () => { const recovered = open(reopened.pool);
    try { expect(values(recovered)).toEqual([1, 1, 1]); recovery.finish(recovered); }
    finally { recovered.close(); }
  });
  expect(reopened.pool.getFileNames().sort()).toEqual([...files].sort());
  recovery.dispose(); reopened.pool.pauseVfs();
});
