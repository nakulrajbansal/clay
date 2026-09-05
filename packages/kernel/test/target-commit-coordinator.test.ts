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

  it("commits one meaningful row change with Merkle, header, and journal atomically", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Changed" } : field);
      const guard = new LiveWriteGuard(driver);
      const coordinator = new TargetCommitCoordinator(guard, registry);
      const result = coordinator.commit({
        expectedTarget,
        operationId: id("op", "e"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: row.key, fields }],
        mutate: () => guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Changed", rowId]),
      });
      expect(result).toMatchObject({ changed: true, evidence: {
        protectionRevision: "1", stateSha256: expect.stringMatching(/^sha256:/),
      } });
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Changed");
      expect(TargetAuthorityStore.open(driver).header()).toMatchObject({
        protectionRevision: "1", protectionRevisionHighWater: "1",
      });
      expect(TargetAuthorityStore.open(driver).reservations()).toMatchObject([
        { revision: "1", state: "committed",
          finalizedAt: "2026-09-05T00:01:00.000Z" },
      ]);
      let retriedMutation = false;
      const retry = coordinator.commit({
        expectedTarget,
        operationId: id("op", "e"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      });
      expect(retry).toEqual(result);
      expect(retriedMutation).toBe(false);
      expect(TargetAuthorityStore.open(driver).reservations()).toHaveLength(1);
      const alteredFields = fields.map(field => field.kind === "text"
        ? { ...field, value: `${field.value} altered` } : field);
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "e"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: row.key, fields: alteredFields }],
        mutate: () => { retriedMutation = true; },
      })).toThrow();
      expect(() => coordinator.commit({
        expectedTarget: { ...expectedTarget, stateSha256: `sha256:${"f".repeat(64)}` },
        operationId: id("op", "e"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      })).toThrow();
      expect(retriedMutation).toBe(false);
      driver.exec(
        "UPDATE sys.target_revision_reservations SET state_sha256 = ? WHERE operation_id = ?",
        [`sha256:${"e".repeat(64)}`, id("op", "e")],
      );
      expect(() => TargetAuthorityStore.open(driver).evidence()).toThrow();
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "e"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: row.key, fields }],
        mutate: () => { retriedMutation = true; },
      })).toThrow();
    } finally {
      clay.close();
    }
  });

  it("rolls back a failed mutation and leaves one abandoned reservation gap", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Broken" } : field);
      const guard = new LiveWriteGuard(driver);
      const coordinator = new TargetCommitCoordinator(guard, registry);
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "f"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: row.key, fields }],
        mutate: () => {
          guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Broken", rowId]);
          throw new Error("injected mutation failure");
        },
      })).toThrow();
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Apollo");
      expect(TargetAuthorityStore.open(driver).header()).toMatchObject({
        protectionRevision: "0", protectionRevisionHighWater: "1",
      });
      expect(TargetAuthorityStore.open(driver).reservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
      expect(TargetAuthorityStore.open(driver).evidence()).toEqual(expectedTarget);
    } finally {
      clay.close();
    }
  });

  it("rejects mutation of the caller-owned change set after request fingerprinting", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Changed" } : field);
      const changes = [{ key: row.key, fields }];
      const guard = new LiveWriteGuard(driver);
      const coordinator = new TargetCommitCoordinator(guard, registry);
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "g"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes,
        mutate: () => {
          const mutable = changes[0]!.fields.find(field =>
            field.name === `field/${name.semantic!.fieldId}`)! as { value: string };
          mutable.value = "Tampered";
          guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Tampered", rowId]);
        },
      })).toThrow();
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Apollo");
      expect(TargetAuthorityStore.open(driver).reservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
    } finally {
      clay.close();
    }
  });

  it("rejects a thenable mutation result before Merkle publication", async () => {
    const clay = await seededStore();
    const driver = (clay as unknown as { driver: DbDriver }).driver;
    try {
      const registry = clay.validationRegistrySnapshot();
      const census = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
      TargetAuthorityStore.createSchema(driver);
      const expectedTarget = TargetAuthorityStore.initialize(driver, header).evidence();
      const table = registry.get("projects")!;
      const name = table.columns.find(column => column.name === "name")!;
      const apollo = clay.query({ from: "projects" }).find(record => record.name === "Apollo")!;
      const rowId = String(apollo.id);
      const row = census.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
      const fields = row.fields.map(field =>
        field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
          ? { ...field, value: "Async" } : field);
      const guard = new LiveWriteGuard(driver);
      const coordinator = new TargetCommitCoordinator(guard, registry);
      expect(() => coordinator.commit({
        expectedTarget,
        operationId: id("op", "h"),
        reservedAt: "2026-09-05T00:00:00.000Z",
        finalizedAt: "2026-09-05T00:01:00.000Z",
        changes: [{ key: row.key, fields }],
        mutate: (() => {
          guard.exec("UPDATE projects SET name = ? WHERE id = ?", ["Async", rowId]);
          return Promise.resolve();
        }) as unknown as () => void,
      })).toThrow();
      expect(driver.select("SELECT name FROM projects WHERE id = ?", [rowId])[0]!.name)
        .toBe("Apollo");
      expect(TargetAuthorityStore.open(driver).reservations()).toMatchObject([
        { revision: "1", state: "abandoned" },
      ]);
    } finally {
      clay.close();
    }
  });
});
