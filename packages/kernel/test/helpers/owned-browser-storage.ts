import { vi } from "vitest";
import * as db from "../../src/db";
import { StateMerkleIndex } from "../../src/state-merkle-index";
import { TargetAuthorityStore } from "../../src/target-authority";
import { classifyDurableFileInventory } from "../../src/durable-inventory";

/** Owned in-memory SQLite files only. No host browser or user OPFS is opened. */
export function ownedBrowserStorage() {
  const catalogFile = `/restore-test-${crypto.randomUUID()}.db`;
  const targets = new Map<string, db.DbDriver>();
  const names = new Set<string>();
  const closers: Array<() => void> = [];
  const state = { fault: null as "create" | "install" | "unlink" | null, unlinked: [] as string[] };
  const authorityTables = ["state_digest_leaves", "state_digest_buckets", "state_digest_root",
    "target_authority_header", "target_revision_reservations", "production_request_receipts"];
  const open = async (key?: string) => {
    const source = key ? targets.get(key) : undefined;
    const driver = source ? await source.snapshot() : await db.openMemoryDriver();
    if (source) {
      StateMerkleIndex.createSchema(driver); TargetAuthorityStore.createSchema(driver);
      for (const table of authorityTables) {
        driver.exec(`DELETE FROM sys.${table}`);
        for (const row of source.select(`SELECT * FROM sys.${table}`)) {
          const columns = Object.keys(row);
          driver.exec(`INSERT INTO sys.${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            columns.map(column => row[column]!));
        }
      }
    }
    driver.exec(`ATTACH DATABASE '${catalogFile}' AS catalog`);
    closers.push(driver.close.bind(driver));
    vi.spyOn(driver, "close").mockImplementation(() => {});
    if (key) targets.set(key, driver);
    if (state.fault === "install" && key && !source) {
      const exec = driver.exec.bind(driver);
      vi.spyOn(driver, "exec").mockImplementation((sql, bindings) => {
        if (state.fault === "install" && /CREATE TABLE/i.test(sql)) {
          state.fault = null; throw new Error("injected interrupted restore install");
        }
        return exec(sql, bindings);
      });
    }
    return driver;
  };
  vi.spyOn(db, "browserDurableInventory").mockImplementation(async () => classifyDurableFileInventory([...names]));
  vi.spyOn(db, "browserDurableFileNames").mockImplementation(async () => [...names].sort());
  vi.spyOn(db, "openBrowserCatalogProbe").mockImplementation(async () => {
    names.add("/clay-device-catalog-v1.db"); return open();
  });
  vi.spyOn(db, "openBrowserProductionTarget").mockImplementation(async physical => {
    if (state.fault === "create" && !targets.has(physical.storageKey)) {
      names.add(physical.userFile); state.fault = null;
      throw new Error("injected interrupted restore create");
    }
    names.add(physical.userFile); names.add(physical.systemFile);
    names.add("/clay-device-catalog-v1.db"); return open(physical.storageKey);
  });
  vi.spyOn(db, "deleteBrowserNamespaceStorage").mockImplementation(async (physical, assertClaim) => {
    assertClaim(); names.delete(physical.userFile); state.unlinked.push(physical.userFile);
    if (state.fault === "unlink") { state.fault = null; throw new Error("injected interrupted restore unlink"); }
    assertClaim(); names.delete(physical.systemFile); state.unlinked.push(physical.systemFile);
    targets.delete(physical.storageKey);
  });
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, work: () => Promise<unknown>) => {
    const result = tail.then(work); tail = result.then(() => undefined, () => undefined); return result;
  } }, storage: { persist: async () => true, persisted: async () => true } });
  return { state, names, targets, close() {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const close of closers) { try { close(); } catch { /* owned duplicate handles */ } }
  } };
}
