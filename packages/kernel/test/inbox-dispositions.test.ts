import { expect, it, vi } from "vitest";
import { ClayStore, openMemoryDriver } from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { createInboxDispositionTable, readInboxDispositions, writeInboxDisposition } from "../src/inbox-dispositions";

const row = { schema: 1 as const, sourceKey: `inb_${"a".repeat(26)}`, sourceGeneration: `gen_${"b".repeat(26)}`,
  requestId: `req_${"c".repeat(26)}`, revision: 1, state: "dismissed" as const, until: null, localDate: null, timeZone: null };

it("keeps the absent legacy schema unchanged and binds first physical disposition plus snapshot readback", async () => {
  const driver = await openMemoryDriver(); const store = ClayStore.fromDriver(driver);
  store.setSetting("current_version", 0);
  try {
    const before = enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot());
    expect(readInboxDispositions(driver)).toEqual([]);
    expect(enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot()).stateSha256).toBe(before.stateSha256);
    writeInboxDisposition(driver, { expectedRevision: 0, value: row });
    expect(enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot()).stateSha256).not.toBe(before.stateSha256);
    const snapshot = await driver.snapshot();
    try { expect(readInboxDispositions(snapshot)).toEqual([row]); } finally { snapshot.close(); }
    expect(() => writeInboxDisposition(driver, { expectedRevision: 0, value: { ...row, revision: 2 } })).toThrow(/CAS/);
  } finally { store.close(); }
});

it.each(["unknown_state", "mismatched_column", "duplicate_revision", "unaccounted_row", "extra_index"])("rejects %s without filtering physical rows", async fault => {
  const driver = await openMemoryDriver(); const store = ClayStore.fromDriver(driver);
  store.setSetting("current_version", 0);
  try {
    createInboxDispositionTable(driver); writeInboxDisposition(driver, { expectedRevision: 0, value: row });
    expect(() => enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot())).not.toThrow();
    if (fault === "extra_index") driver.exec("CREATE INDEX sys.unreviewed_inbox_index ON inbox_dispositions(source_generation)");
    else if (fault === "unaccounted_row") {
      const select = driver.select.bind(driver);
      vi.spyOn(driver, "select").mockImplementation((sql, params) => sql.includes("count(*) AS n FROM sys.inbox_dispositions") ? [{ n: 2 }] : select(sql, params));
    } else if (fault === "duplicate_revision") {
      const duplicate = { ...row, sourceKey: `inb_${"d".repeat(26)}` };
      driver.exec("INSERT INTO sys.inbox_dispositions VALUES(?,?,?,?)", [duplicate.sourceKey, duplicate.sourceGeneration, duplicate.revision, JSON.stringify(duplicate)]);
    } else driver.exec("UPDATE sys.inbox_dispositions SET disposition_json=?", [JSON.stringify({ ...row, ...(fault === "unknown_state" ? { state: "unknown" } : { revision: 2 }) })]);
    expect(() => readInboxDispositions(driver)).toThrow(/closed/);
    expect(() => enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot())).toThrow();
  } finally { vi.restoreAllMocks(); store.close(); }
});
