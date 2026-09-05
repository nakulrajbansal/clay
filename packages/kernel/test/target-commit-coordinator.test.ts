import { describe, expect, it } from "vitest";
import type { TargetAuthorityHeaderV1 } from "@clay/schema";
import type { DbDriver } from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { LiveWriteGuard } from "../src/live-write-guard";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";
import { TargetCommitCoordinator } from "../src/target-commit-coordinator";
import { seededStore } from "./helpers";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const header: TargetAuthorityHeaderV1 = {
  schema: 1,
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "0",
  lineageEpochHighWater: "0",
  protectionRevision: "0",
  protectionRevisionHighWater: "0",
  digestSchema: 1,
};

describe("guarded target commit coordinator", () => {
  it("returns a canonical no-op without mutation or revision reservation", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      const expectedTarget = target.evidence();
      const unchanged = census.leaves[0]!.seed;
      const guard = new LiveWriteGuard(driver);
      const coordinator = new TargetCommitCoordinator(guard);
      let invoked = false;
      expect(coordinator.commit({
        expectedTarget,
        operationId: id("op", "c"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: unchanged.key, fields: unchanged.fields }],
        mutate: () => { invoked = true; },
      })).toEqual({ changed: false, evidence: expectedTarget });
      expect(invoked).toBe(false);
      expect(TargetAuthorityStore.open(driver).reservations()).toEqual([]);
      expect(TargetAuthorityStore.open(driver).header()).toEqual(header);
    } finally {
      clay.close();
    }
  });

  it("rejects a meaningful change before guarded publication is implemented", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const changed = census.leaves[0]!.seed;
      const fields = changed.fields.map(field => field.kind === "text"
        ? { ...field, value: `${field.value} changed` } : field);
      const coordinator = new TargetCommitCoordinator(new LiveWriteGuard(driver));
      let invoked = false;
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "d"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: changed.key, fields }],
        mutate: () => { invoked = true; },
      })).toThrow();
      expect(invoked).toBe(false);
      expect(TargetAuthorityStore.open(driver).reservations()).toEqual([]);
    } finally {
      clay.close();
    }
  });
});
