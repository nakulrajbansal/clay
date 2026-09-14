// Independent owned Store copies; never imported by production.
import { expect, vi } from "vitest";
import { ClayStore } from "../src/store";
import { ClayStore as OriginalStore } from "./oracles/store";
import { openMemoryDriver, inheritAutomationPhysicalTransactionCapability, type DbDriver, type SqlValue } from "../src/db";
import { createLiveWriteGuard } from "../src/live-write-guard";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { deriveInverse, type ForwardOpT } from "../src/migrate";

export type Subject = ClayStore | OriginalStore;
export const at = Date.parse("2026-09-14T12:00:00.000Z");
export function commit(store: Subject, operations: ForwardOpT[]) {
  return store.commit({ intent: "Reducer fixture", summary: "Reviewed changes", semanticOrigin: "direct",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
}
export async function source() {
  const driver = await openMemoryDriver(), store = ClayStore.fromDriver(driver);
  commit(store, [
    { op: "create_table", table: "people", columns: [{ name: "name", type: "text", required: true }] },
    { op: "create_table", table: "items", columns: [
      { name: "name", type: "text", required: true },
      { name: "state", type: "enum", required: false, values: ["open", "done"] },
      { name: "score", type: "number", required: false },
      { name: "count", type: "integer", required: false },
      { name: "due", type: "date", required: false },
      { name: "files", type: "attachment", required: false },
    ] },
  ]);
  store.insert("items", { name: "Original", state: "open", score: 3, count: 2, due: "2026-09-14" });
  store.recordSampleRowProvenance([]);
  return { driver, store };
}
export function physical(driver: DbDriver) {
  return ["main", "sys"].map(db => driver.select(`SELECT type,name,sql FROM ${db}.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).map(row => {
    const name = String(row.name);
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error("invalid owned fixture name");
    return { ...row, rows: row.type === "table" ? driver.select(`SELECT * FROM ${db}."${name}"`).map(value => JSON.stringify(value)).sort() : [] };
  }));
}
export function outcome(run: () => unknown) {
  try { return { ok: true, value: run() }; }
  catch (error) { const e = error as { code?: string; message: string; details?: unknown };
    return { ok: false, code: e.code, message: e.message, details: e.details }; }
}
async function owned(base: DbDriver, old: boolean) {
  const raw = await base.snapshot(), session = createLiveWriteGuard(raw);
  type Match = null | ((sql: string, params?: readonly SqlValue[]) => boolean);
  const fault = { match: null as Match, readMatch: null as Match, hit: 0 };
  const driver: DbDriver = { ...session.driver, close() {}, select(sql, params) {
    if (fault.readMatch?.(sql, params)) { fault.readMatch = null; fault.hit++; throw new Error("injected Store reducer readback"); }
    return session.driver.select(sql, params);
  }, exec(sql, params) {
    if (fault.match?.(sql, params)) { fault.match = null; fault.hit++; throw new Error("injected Store reducer write"); }
    session.driver.exec(sql, params);
  } };
  inheritAutomationPhysicalTransactionCapability(session.driver, driver);
  const store = session.authority.run(() => old ? OriginalStore.fromDriver(driver) : ClayStore.fromDriver(driver));
  return { driver, raw, store, old, fault, write: <T>(run: () => T) => session.authority.run(run),
    reopen: () => session.authority.run(() => old ? OriginalStore.fromDriver(driver) : ClayStore.fromDriver(driver)) };
}
export type Fixture = Awaited<ReturnType<typeof owned>>;
export async function pair(base: DbDriver, work: (fixture: Fixture) => unknown) {
  let counter = 0;
  const random = vi.spyOn(crypto, "getRandomValues").mockImplementation((bytes: any) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (counter++ * 17 + 31) % 251;
    return bytes;
  });
  const fixtures: Fixture[] = [];
  const observations = [];
  try {
    for (const old of [true, false]) {
      counter = 0;
      const f = await owned(base, old); fixtures.push(f);
      const result = await work(f);
      const canonical = enumerateCanonicalStateV1(f.driver, f.store.validationRegistrySnapshot());
      // Store reducers do not publish catalog/Merkle themselves. Compare the
      // exact canonical input and independent Merkle materialization separately.
      f.write(() => { StateMerkleIndex.createSchema(f.driver); StateMerkleIndex.initialize(f.driver, canonical.leaves.map(leaf => leaf.seed)); });
      observations.push({ result, physical: physical(f.driver), bytes: await f.driver.exportDatabases(), canonical,
        merkle: StateMerkleIndex.open(f.driver).audit(), registry: f.store.validationRegistrySnapshot(),
        trace: f.store.semanticSchemaTrace(), history: f.store.history() });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(observations[1]).toEqual(observations[0]);
    return observations[1]!.result;
  } finally { random.mockRestore(); for (const f of fixtures) f.raw.close(); }
}
