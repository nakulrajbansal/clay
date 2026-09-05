import { describe, expect, it } from "vitest";
import { TargetAuthorityHeaderV1, TargetEvidenceV1 } from "@clay/schema";
import type { DbDriver } from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";
import { seededStore } from "./helpers";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;

const header = {
  schema: 1 as const,
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "0",
  lineageEpochHighWater: "0",
  protectionRevision: "0",
  protectionRevisionHighWater: "0",
  digestSchema: 1 as const,
};

describe("target-owned authority metadata", () => {
  it("initializes one strict header and derives evidence from the persisted Merkle root", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const before = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      const index = StateMerkleIndex.initialize(driver, before.leaves.map(entry => entry.seed));

      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      expect(target.header()).toEqual(TargetAuthorityHeaderV1.parse(header));
      expect(target.evidence()).toEqual(TargetEvidenceV1.parse({
        appInstanceId: header.appInstanceId,
        activeGenerationId: header.activeGenerationId,
        lineageEpoch: "0",
        protectionRevision: "0",
        digestSchema: 1,
        stateSha256: index.audit().stateSha256,
      }));
      expect(enumerateCanonicalStateV1(driver, registry).stateSha256).toBe(before.stateSha256);
      expect(() => TargetAuthorityStore.initialize(driver, header)).toThrow();
    } finally {
      clay.close();
    }
  });

  it("reserves non-reusable protection revisions idempotently without advancing current state", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      const operation = id("op", "c");
      expect(target.reserveProtectionRevision(operation, "2026-09-05T00:00:00.000Z"))
        .toEqual({ revision: "1", state: "reserved" });
      expect(target.reserveProtectionRevision(operation, "2026-09-05T00:01:00.000Z"))
        .toEqual({ revision: "1", state: "reserved" });
      expect(target.reserveProtectionRevision(id("op", "d"), "2026-09-05T00:02:00.000Z"))
        .toEqual({ revision: "2", state: "reserved" });
      expect(target.header()).toMatchObject({
        protectionRevision: "0", protectionRevisionHighWater: "2",
      });
      expect(target.reservations()).toEqual([
        { operationId: operation, revision: "1", state: "reserved",
          reservedAt: "2026-09-05T00:00:00.000Z", finalizedAt: null },
        { operationId: id("op", "d"), revision: "2", state: "reserved",
          reservedAt: "2026-09-05T00:02:00.000Z", finalizedAt: null },
      ]);
      expect(enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot()).stateSha256)
        .toBe(census.stateSha256);
    } finally {
      clay.close();
    }
  });

  it("abandons a reserved revision without reuse or current-state advancement", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      const operation = id("op", "e");
      target.reserveProtectionRevision(operation, "2026-09-05T00:00:00.000Z");
      expect(target.abandonProtectionRevision(operation, "2026-09-05T00:01:00.000Z"))
        .toEqual({ revision: "1", state: "abandoned" });
      expect(target.reserveProtectionRevision(id("op", "f"), "2026-09-05T00:02:00.000Z"))
        .toEqual({ revision: "2", state: "reserved" });
      expect(target.header()).toMatchObject({
        protectionRevision: "0", protectionRevisionHighWater: "2",
      });
      expect(target.reservations()[0]).toMatchObject({
        operationId: operation,
        revision: "1",
        state: "abandoned",
        finalizedAt: "2026-09-05T00:01:00.000Z",
      });
    } finally {
      clay.close();
    }
  });

  it("refuses target evidence when the reservation journal is corrupted after open", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      target.reserveProtectionRevision(id("op", "g"), "2026-09-05T00:00:00.000Z");
      driver.exec(
        "UPDATE sys.target_revision_reservations SET active_generation_id = ?",
        [id("gen", "z")],
      );
      expect(() => target.evidence()).toThrow();
    } finally {
      clay.close();
    }
  });

  it("refuses evidence when a journal row claims a revision committed beyond current", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      target.reserveProtectionRevision(id("op", "h"), "2026-09-05T00:00:00.000Z");
      driver.exec(
        `UPDATE sys.target_revision_reservations
         SET state = 'committed', finalized_at = '2026-09-05T00:01:00.000Z'`,
      );
      expect(() => target.evidence()).toThrow();
    } finally {
      clay.close();
    }
  });

  it("refuses evidence when an earlier reserved revision is missing from the journal", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      target.reserveProtectionRevision(id("op", "j"), "2026-09-05T00:00:00.000Z");
      target.reserveProtectionRevision(id("op", "k"), "2026-09-05T00:01:00.000Z");
      driver.exec("DELETE FROM sys.target_revision_reservations WHERE revision = '1'");
      expect(() => target.evidence()).toThrow();
    } finally {
      clay.close();
    }
  });
});
