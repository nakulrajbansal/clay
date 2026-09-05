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

const REQUEST_SHA = `sha256:${"a".repeat(64)}`;

function reserve(target: TargetAuthorityStore, operationId: string, reservedAt: string) {
  return target.reserveProtectionRevision(
    operationId, reservedAt, target.evidence(), REQUEST_SHA,
  );
}

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
      const expectedTarget = target.evidence();
      const operation = id("op", "c");
      expect(reserve(target, operation, "2026-09-05T00:00:00.000Z"))
        .toEqual({ revision: "1", state: "reserved" });
      expect(reserve(target, operation, "2026-09-05T00:01:00.000Z"))
        .toEqual({ revision: "1", state: "reserved" });
      expect(reserve(target, id("op", "d"), "2026-09-05T00:02:00.000Z"))
        .toEqual({ revision: "2", state: "reserved" });
      expect(target.header()).toMatchObject({
        protectionRevision: "0", protectionRevisionHighWater: "2",
      });
      expect(target.reservations()).toEqual([
        { operationId: operation, revision: "1", state: "reserved",
          expectedProtectionRevision: "0", expectedStateSha256: expectedTarget.stateSha256,
          requestSha256: REQUEST_SHA, reservedAt: "2026-09-05T00:00:00.000Z",
          finalizedAt: null, stateSha256: null },
        { operationId: id("op", "d"), revision: "2", state: "reserved",
          expectedProtectionRevision: "0", expectedStateSha256: expectedTarget.stateSha256,
          requestSha256: REQUEST_SHA, reservedAt: "2026-09-05T00:02:00.000Z",
          finalizedAt: null, stateSha256: null },
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
      reserve(target, operation, "2026-09-05T00:00:00.000Z");
      expect(target.abandonProtectionRevision(operation, "2026-09-05T00:01:00.000Z"))
        .toEqual({ revision: "1", state: "abandoned" });
      expect(reserve(target, id("op", "f"), "2026-09-05T00:02:00.000Z"))
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
      reserve(target, id("op", "g"), "2026-09-05T00:00:00.000Z");
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
      reserve(target, id("op", "h"), "2026-09-05T00:00:00.000Z");
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
      reserve(target, id("op", "j"), "2026-09-05T00:00:00.000Z");
      reserve(target, id("op", "k"), "2026-09-05T00:01:00.000Z");
      driver.exec("DELETE FROM sys.target_revision_reservations WHERE revision = '1'");
      expect(() => target.evidence()).toThrow();
    } finally {
      clay.close();
    }
  });

  it("rejects unauditable historical committed replay after current advances", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const census = enumerateCanonicalStateV1(driver, clay.validationRegistrySnapshot());
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const target = TargetAuthorityStore.initialize(driver, header);
      const operation1 = id("op", "m");
      const operation2 = id("op", "n");
      const request1 = `sha256:${"b".repeat(64)}`;
      const request2 = `sha256:${"c".repeat(64)}`;
      const expected0 = target.evidence();
      target.reserveProtectionRevision(
        operation1, "2026-09-05T00:00:00.000Z", expected0, request1,
      );
      driver.tx(() => {
        driver.exec("UPDATE sys.target_authority_header SET protection_revision = '1'");
        driver.exec(
          `UPDATE sys.target_revision_reservations
           SET state = 'committed', state_sha256 = ?, finalized_at = ? WHERE revision = '1'`,
          [expected0.stateSha256, "2026-09-05T00:01:00.000Z"],
        );
      });
      const expected1 = target.evidence();
      target.reserveProtectionRevision(
        operation2, "2026-09-05T00:02:00.000Z", expected1, request2,
      );
      driver.tx(() => {
        driver.exec("UPDATE sys.target_authority_header SET protection_revision = '2'");
        driver.exec(
          `UPDATE sys.target_revision_reservations
           SET state = 'committed', state_sha256 = ?, finalized_at = ? WHERE revision = '2'`,
          [expected1.stateSha256, "2026-09-05T00:03:00.000Z"],
        );
      });
      expect(target.evidence().protectionRevision).toBe("2");
      driver.exec(
        "UPDATE sys.target_revision_reservations SET state_sha256 = ? WHERE revision = '1'",
        [`sha256:${"f".repeat(64)}`],
      );
      expect(() => target.committedEvidence(operation1, expected0, request1)).toThrow();
    } finally {
      clay.close();
    }
  });
});
