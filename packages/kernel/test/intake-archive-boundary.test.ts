import { expect, it } from "vitest";
import { ClayStore, openMemoryDriver } from "../src/index";
import { assertNoLegacyIntakeArchive, assertIntakeResponsePublic } from "../src/production-intake-boundary";
import { emptyIntakeState } from "../src/intake";

it.each(["private_property", "malformed_v2"])("denies %s at archive collection without rewriting the physical V2 row", async fault => {
  const store = await ClayStore.openMemory();
  try {
    const state = fault === "private_property" ? { ...emptyIntakeState(), ownerToken: "owned-synthetic-marker" } : { ...emptyIntakeState(), submissions: "malformed" };
    store.setSetting("intake_v2", state); const original = JSON.stringify(store.getSetting("intake_v2"));
    const denied = await store.exportArchive("Owned fixture").then(() => false, error => /custody|intake state/.test(String(error)));
    expect(denied).toBe(true);
    expect(JSON.stringify(store.getSetting("intake_v2")) === original).toBe(true);
  } finally { store.close(); }
});

it("blocks legacy intake export at the Store boundary without changing the original row", async () => {
  const store = await ClayStore.openMemory();
  try {
    const original = { schema: 1, forms: [{ ownerPrivateKey: "owned-synthetic-marker" }] };
    store.setSetting("intake_v1", original);
    const denied = await store.exportArchive("Owned fixture").then(() => false, error => /custody/.test(String(error)));
    expect(denied).toBe(true); // Never let a failing assertion dump an archive buffer.
    expect(JSON.stringify(store.getSetting("intake_v1")) === JSON.stringify(original)).toBe(true);
  } finally { store.close(); }
});

it("detects escaped historical capability property names without selecting private values or changing receipts", async () => {
  const driver = await openMemoryDriver();
  try {
    driver.exec("CREATE TABLE IF NOT EXISTS sys.settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL)");
    driver.exec("CREATE TABLE sys.production_request_receipts(request_id TEXT PRIMARY KEY,response_json TEXT)");
    const original = '{"old":{"owner\\u0050rivateKey":"owned-synthetic-marker"}}';
    driver.exec("INSERT INTO sys.production_request_receipts VALUES (?,?)", ["owned-fixture", original]);
    expect(() => assertNoLegacyIntakeArchive(driver)).toThrow(/custody/);
    expect(() => assertIntakeResponsePublic("intake.saveForm", JSON.parse(original))).toThrow(/custody/);
    expect(driver.select("SELECT response_json = ? AS unchanged FROM sys.production_request_receipts", [original])[0]!.unchanged).toBe(1);
    driver.exec("UPDATE sys.production_request_receipts SET response_json=?", [JSON.stringify({ title: 'Ordinary text containing "ownerToken" is not a capability property' })]);
    expect(() => assertNoLegacyIntakeArchive(driver)).not.toThrow();
  } finally { driver.close(); }
});
