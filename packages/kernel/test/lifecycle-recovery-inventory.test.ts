import { describe, expect, it } from "vitest";
import { assertLifecycleRecoveryInventory } from "../src/lifecycle-recovery-inventory";
const target = { userFile: "/ns_aaaaaaaaaaaaaaaaaaaaaaaaaa-user.db", systemFile: "/ns_aaaaaaaaaaaaaaaaaaaaaaaaaa-system.db" };
const live = ["/clay-device-catalog-v1.db", "/user.db", "/system.db"];
describe("job-explained physical recovery inventory", () => {
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
