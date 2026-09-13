import { describe, expect, it } from "vitest";
import { beginAppSetup, readAppSetup, saveAppSetup } from "../src/app/app-setup-intent";
const source = `app_${"a".repeat(26)}`;
const makeStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
describe("immutable app setup retry intent", () => {
  it("retains request identities and the original starter across a timeout/reconstructed UI", () => {
    const storage = makeStorage();
    let minted = 0;
    const mint = () => ({ requestId: `req_${String.fromCharCode(98 + minted++).repeat(26)}` });
    const first = beginAppSetup(storage, { kind: "starter", sourceAppInstanceId: source,
      createsApp: true, displayName: "Tracker", shellId: "tracker", reviewed: null }, mint);
    const resumed = beginAppSetup(storage, { kind: "starter", sourceAppInstanceId: source,
      createsApp: true, displayName: "Inventory", shellId: "inventory", reviewed: null }, mint);
    expect(resumed).toEqual(first);
    expect(minted).toBe(4);
    expect(readAppSetup(storage)?.shellId).toBe("tracker");
    expect(() => saveAppSetup(storage, { ...first, shellId: "inventory" })).toThrow(/immutable/);
  });
  it("does not issue a durable operation if the retry record cannot be retained", () => {
    const storage = makeStorage();
    storage.setItem = () => { throw new Error("storage quota"); };
    expect(() => beginAppSetup(storage, { kind: "starter", sourceAppInstanceId: source,
      createsApp: true, displayName: "Tracker", shellId: "tracker", reviewed: null },
    () => ({ requestId: `req_${"b".repeat(26)}` }))).toThrow(/storage quota/);
  });
});
