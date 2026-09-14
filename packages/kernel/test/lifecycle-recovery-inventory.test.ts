import { describe, expect, it, vi } from "vitest";
import { assertLifecycleRecoveryInventory, withBrowserLifecycleLock } from "../src/lifecycle-recovery-inventory";
import { ownedLifecycleLocks } from "./helpers/owned-lifecycle-locks";
const target = { userFile: "/ns_aaaaaaaaaaaaaaaaaaaaaaaaaa-user.db", systemFile: "/ns_aaaaaaaaaaaaaaaaaaaaaaaaaa-system.db" };
const live = ["/clay-device-catalog-v1.db", "/user.db", "/system.db"];
describe("job-explained physical recovery inventory", () => {
  it.each([undefined, {}])("fails closed without crash-released browser exclusion (%j)", async browser => {
    vi.stubGlobal("navigator", browser); const work = vi.fn();
    try {
      await expect(withBrowserLifecycleLock(work)).rejects.toMatchObject({ code: "E_CATALOG_UNAVAILABLE" });
      expect(work).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("serializes owned exclusion and releases it after a failed invocation", async () => {
    vi.stubGlobal("navigator", { locks: ownedLifecycleLocks() });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const second = vi.fn(async () => "readback");
    try {
      const first = withBrowserLifecycleLock(async () => { await held; throw new Error("owned interruption"); });
      const rejected = expect(first).rejects.toThrow("owned interruption");
      const next = withBrowserLifecycleLock(second); await Promise.resolve();
      expect(second).not.toHaveBeenCalled(); release(); await rejected;
      await expect(next).resolves.toBe("readback");
    } finally { release(); vi.unstubAllGlobals(); }
  });
  it.each([[], [target.userFile], [target.systemFile], [target.userFile, target.systemFile], [target.userFile + "-journal"]])(
    "admits exact partial target files/sidecars before strict classification: %j", (...partial) => {
      expect(() => assertLifecycleRecoveryInventory([...live, ...partial], live, target)).not.toThrow();
    },
  );
  it.each(["/user.db-wal", "/unknown.db", "/ns_bbbbbbbbbbbbbbbbbbbbbbbbbb-user.db", target.userFile + "-other"])(
    "refuses a file not explained by this job: %s", extra => {
      expect(() => assertLifecycleRecoveryInventory([...live, extra], live, target)).toThrow(/inventory/);
    },
  );
  it("refuses missing live files, duplicate names, and live target overlap", () => {
    expect(() => assertLifecycleRecoveryInventory(live.slice(0, 2), live, target)).toThrow();
    expect(() => assertLifecycleRecoveryInventory([...live, live[0]!], live, target)).toThrow();
    expect(() => assertLifecycleRecoveryInventory(live, live, { userFile: "/user.db", systemFile: "/system.db" })).toThrow();
  });
});
