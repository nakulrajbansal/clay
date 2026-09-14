import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { at, source, pair, commit, outcome, physical, type Fixture } from "./store-reducer-fixture";
import { deriveInverse, type ForwardOpT } from "../src/migrate";
import type { SemanticOrigin } from "../src/semantic";
import type { AutomationDraftInputV2, AutomationTargetIdentityV1 } from "../src/automation-v2";

let base: Awaited<ReturnType<typeof source>>;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at); base = await source(); });
afterAll(() => { base?.store.close(); vi.useRealTimers(); });
const operations: ForwardOpT[] = [
  { op: "create_table", table: "notes", columns: [{ name: "title", type: "text", required: true },
    { name: "person", type: "relation", required: false, relation: { target_table: "people", cardinality: "one", unique_targets: false } }] },
  { op: "add_column", table: "items", column: { name: "owner", type: "relation", required: false,
    relation: { target_table: "people", cardinality: "many", unique_targets: true } } },
  { op: "create_computed", table: "items", column: "weighted", expr: "score * count" },
  { op: "rename_column", table: "items", from: "name", to: "title" },
  { op: "update_computed", table: "items", column: "weighted", expr: "score" },
  { op: "add_enum_value", table: "items", column: "state", value: "paused" },
  { op: "hide_column", table: "items", column: "count" },
  { op: "set_required", table: "items", column: "score", required: true, default_for_existing: 0 },
  { op: "add_index", table: "items", column: "title" },
  { op: "add_column", table: "items", column: { name: "adjusted", type: "number", required: false } },
  { op: "backfill", table: "items", column: "adjusted", expr: "score + 1" },
];
const automationTarget: AutomationTargetIdentityV1 = { v: 1, appInstanceId: `app_${"a".repeat(26)}`,
  activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", stateRevision: "1", stateDigest: `sha256:${"c".repeat(64)}` };
function enableRule(f: Fixture, kind: "record_created" | "record_updated" | "record_matches" | "date_due" | "schedule") {
  const reg = f.store.validationRegistrySnapshot(), items = reg.get("items")!, people = reg.get("people")!;
  const table = { tableId: items.semantic!.tableId, lastKnownName: "items" };
  const field = (name: string) => ({ tableId: table.tableId, fieldId: items.columns.find(c => c.name === name)!.semantic!.fieldId, lastKnownName: name });
  const trigger: AutomationDraftInputV2["trigger"] = kind === "schedule" ? { kind, cadence: "daily", localTime: "08:00" }
    : { kind, table, conditions: [{ field: field("state"), op: "eq", value: "open" }],
      ...(kind === "date_due" ? { dateField: field("due"), daysBefore: 0 } : {}) } as AutomationDraftInputV2["trigger"];
  const draft = f.store.saveAutomationDraft({ v: 2, name: `Owned ${kind}`, trigger,
    actions: [{ kind: "create_record", table: { tableId: people.semantic!.tableId, lastKnownName: "people" }, values: [{
      field: { tableId: people.semantic!.tableId, fieldId: people.columns[0]!.semantic!.fieldId, lastKnownName: "name" },
      value: { source: "literal", value: "Scheduled follow-up" } }] }],
    runtime: { mode: "local", timeZone: "America/New_York", missedPolicy: "run_once_when_available" } }, undefined, new Date(at));
  const simulation = f.store.simulateAutomation({ id: draft.id, target: automationTarget, expectedRevision: draft.definitionRevision, purpose: "enable" }, new Date(at));
  return f.store.enableAutomation({ id: draft.id, target: automationTarget, expectedRevision: draft.definitionRevision, simulation }, new Date(at));
}

describe("independent frozen Store reducer parity", () => {
  it("pins the whole original Store before any reducer changes", () => {
    const bytes = readFileSync(new URL("./oracles/store.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("80ab194f69db122898dc2d6853e8f47f285a775ac9490aff622f62e09efb4fd7");
    expect(bytes).not.toContain("store-semantic-reducer");
  });
  for (const origin of ["direct", "seed", "model", "import", "system", "legacy_backfill"] as SemanticOrigin[])
    it(`semantic ${origin}: exact assignments, identities, references and prepare is read-only`, async () => {
      const result = await pair(base.driver, f => {
        const before = physical(f.driver);
        const plan = { operations, inverse: deriveInverse(operations, f.store.registrySnapshot()) };
        const prepared = f.store.prepareSemanticAssignments(plan, origin);
        expect(physical(f.driver)).toEqual(before);
        return prepared;
      }) as any;
      expect(result.origin).toBe(origin); expect(result.tables.has("notes")).toBe(true);
      expect(result.fields.has("items\u0000weighted")).toBe(true);
      expect([...result.tableSemantics.values()].flatMap((table: any) => table.relationships)
        .some((r: any) => r.kind === "references")).toBe(true);
    });
  it("semantic commit, rollback, roll-forward and replacement preserve exact physical/semantic history", async () => {
    const result = await pair(base.driver, f => {
      const observed = f.write(() => {
      const version = commit(f.store, operations);
      const after = f.store.semanticSchemaTrace();
      f.store.rollbackTo(1); const rollback = f.store.semanticSchemaTrace();
      f.store.rollForwardTo(version);
        return { version, after, rollback, forward: f.store.semanticSchemaTrace() };
      });
      return { ...observed, reloaded: f.reopen().semanticSchemaTrace() };
    }) as any;
    expect(result.version).toBe(2); expect(result.reloaded).toEqual(result.forward);
    expect(result.forward.fields.map((field: any) => field.fieldId)).toEqual(result.after.fields.map((field: any) => field.fieldId));
    expect(result.forward.fields.find((field: any) => field.fieldName === "title" && field.tableName === "items").aliases).toEqual(["name", "title"]);
    expect(result.rollback.fields.find((field: any) => field.fieldName === "weighted").state).toBe("inactive");
  });
  for (const kind of ["column", "computed", "table"] as const)
    it(`semantic ${kind} reactivation keeps original IDs and bounded event coordinates`, async () => {
      const result = await pair(base.driver, f => f.write(() => {
        const ops: ForwardOpT[] = kind === "column" ? [{ op: "add_column", table: "items", column: {
          name: "owner", type: "relation", required: false, relation: { target_table: "people", cardinality: "one", unique_targets: true } } }]
          : kind === "computed" ? [{ op: "create_computed", table: "items", column: "weighted", expr: "score + count" }]
          : [{ op: "create_table", table: "notes", columns: [{ name: "title", type: "text", required: true }] }];
        commit(f.store, ops); const before = f.store.semanticSchemaTrace();
        f.store.rollbackTo(1, { truncate: true });
        const tombstones = f.store.validationRegistrySnapshot();
        commit(f.store, ops); return { before, tombstones, after: f.store.semanticSchemaTrace() };
      })) as any;
      const oldIds = result.before.fields.map((field: any) => field.fieldId);
      expect(result.after.fields.map((field: any) => field.fieldId)).toEqual(oldIds);
    });
  it("semantic aliases and dependency retire/reactivate order stay bounded", async () => {
    await pair(base.driver, f => f.write(() => {
      commit(f.store, [{ op: "create_computed", table: "items", column: "weighted", expr: "score + count" }]);
      for (const expr of ["count", "score", "score + count"]) commit(f.store, [{ op: "update_computed", table: "items", column: "weighted", expr }]);
      const changes: ForwardOpT[] = Array.from({ length: 70 }, (_, i) => ({ op: "rename_column", table: "items", from: i ? `label_${i}` : "name", to: `label_${i + 1}` }));
      for (let i = 0; i < changes.length; i += 7) commit(f.store, changes.slice(i, i + 7));
      const prepared = f.store.prepareSemanticAssignments(null, "direct");
      expect(prepared.fieldSemantics.get("items\u0000label_70")!.aliases).toHaveLength(64);
      return prepared;
    }));
  });
  it("semantic invalid operations retain first-error ordering without writes", async () => {
    const result = await pair(base.driver, f => [
      [{ op: "rename_column", table: "missing", from: "a", to: "b" }],
      [{ op: "create_computed", table: "items", column: "bad", expr: "missing + 1" }],
      [{ op: "add_column", table: "items", column: { name: "bad", type: "relation", relation: { target_table: "missing", cardinality: "one" } } }],
    ].map(operations => outcome(() => f.store.prepareSemanticAssignments({ operations, inverse: [] } as any, "direct")))) as any[];
    expect(result.every(row => !row.ok)).toBe(true);
  });
  for (const marker of ["CREATE TABLE", "INSERT INTO sys.tables_registry", "INSERT INTO sys.version_log"])
    it(`semantic failure at ${marker} rolls back data/DDL/registry/history and retries`, async () => {
      const result = await pair(base.driver, f => {
        f.fault.match = sql => sql.includes(marker);
        const failed = outcome(() => f.write(() => commit(f.store, operations)));
        const afterFailure = physical(f.driver);
        return { failed, afterFailure, hit: f.fault.hit, retry: f.write(() => commit(f.store, operations)) };
      }) as any;
      expect(result.failed.ok).toBe(false); expect(result.hit).toBe(1); expect(result.retry).toBe(2);
    });
  it("uses one bounded semantic introduction reducer instead of three copied field paths", () => {
    const text = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
    const method = text.slice(text.indexOf("  prepareSemanticAssignments("), text.indexOf("  private pruneSemanticAfter("));
    expect(method.includes("introduceField")).toBe(true);
    expect(method.match(/column\.semantic = newFieldSemantic/g)).toHaveLength(1);
  });
  for (const kind of ["record_created", "record_updated", "record_matches", "date_due", "schedule"] as const)
    it(`due ${kind}: bound cursor/match/calendar, receipts, duplicate run, Undo and reload`, async () => {
      const result = await pair(base.driver, f => {
        const run = f.write(() => {
          const saved = enableRule(f, kind);
          const row = f.store.insert("items", { name: "Later", state: "open", due: "2026-09-14" });
          f.store.update("items", String(row.id), { score: 12 });
          const first = f.store.runDueAutomations(automationTarget, new Date(at));
          const repeat = f.store.runDueAutomations(automationTarget, new Date(at));
          const undone = first[0] ? f.store.undoAutomationRun({ id: first[0].id, target: automationTarget }) : null;
          return { first, repeat, undone, saved };
        });
        return { ...run, reloaded: f.reopen().automationRuns(automationTarget), people: f.store.query({ from: "people" }) };
      }) as any;
      expect(result.first.length).toBeGreaterThan(0); expect(result.first.every((r: any) => r.status === "success")).toBe(true);
      expect(result.repeat).toEqual([]); expect(result.undone.undone).toBe(true);
      expect(result.reloaded.some((r: any) => r.undone)).toBe(true);
    });
  for (const marker of ['INSERT INTO "people"', "INSERT INTO sys.automation_runs", "INSERT INTO sys.operation_batches"])
    it(`due write fault ${marker}: bounded failure/retry history is byte-equivalent`, async () => {
      const result = await pair(base.driver, f => {
        f.write(() => enableRule(f, "schedule"));
        f.fault.match = sql => sql.includes(marker);
        const first = outcome(() => f.write(() => f.store.runDueAutomations(automationTarget, new Date(at))));
        const afterFailure = physical(f.driver);
        const retry = outcome(() => f.write(() => f.store.runDueAutomations(automationTarget, new Date(at))));
        return { first, afterFailure, retry, hit: f.fault.hit };
      }) as any;
      expect(result.hit).toBe(1);
      expect(result.first.ok === false || result.first.value.some((r: any) => r.status === "failed")).toBe(true);
    });
  it("due execution shares only bounded match consumption/execution, never trigger eligibility", () => {
    const text = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
    const method = text.slice(text.indexOf("  runDueAutomations("), text.indexOf("  automationRuns("));
    expect(method.match(/this\.executeAutomation\(/g)).toHaveLength(1);
    expect(method.includes("this.automationTriggerSucceeded")).toBe(true);
  });
});
