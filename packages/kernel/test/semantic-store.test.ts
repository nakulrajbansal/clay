import { describe, expect, it } from "vitest";
import {
  ClayStore, bindingForSemanticOp, deriveInverse, isFieldId, isTableId,
  type ForwardOpT,
} from "../src/index";
import { createSystemTables, openMemoryDriver, type DbDriver } from "../src/db";

function commitOps(store: ClayStore, operations: ForwardOpT[]): number {
  return store.commit({
    intent: "semantic test",
    summary: "Changes shape.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
}

describe("semantic store integration", () => {
  it("rolls back the complete legacy backfill when registry persistence fails", async () => {
    const base = await openMemoryDriver();
    createSystemTables(base);
    for (const name of ["alpha", "beta"]) {
      base.exec(`INSERT INTO sys.tables_registry(
        table_name, version, spec_json, created_by, updated_at
      ) VALUES (?, 0, ?, 'legacy', '2026-01-01T00:00:00.000Z')`, [
        name,
        JSON.stringify({ name, columns: [{ name: "title", type: "text", required: true }] }),
      ]);
    }
    let registryInserts = 0;
    const failing: DbDriver = {
      exec(sql, params) {
        if (/INSERT INTO sys\.tables_registry/.test(sql) && ++registryInserts === 2)
          throw new Error("injected registry write failure");
        base.exec(sql, params);
      },
      select: (sql, params) => base.select(sql, params),
      tx: fn => base.tx(fn),
      close: () => undefined,
      snapshot: () => base.snapshot(),
      exportDatabases: () => base.exportDatabases(),
    };

    expect(() => ClayStore.fromDriver(failing)).toThrow(/injected registry write failure/);
    expect(base.select("SELECT table_name FROM sys.tables_registry ORDER BY table_name")
      .map(row => row.table_name)).toEqual(["alpha", "beta"]);
    expect(base.select(
      "SELECT value_json FROM sys.settings WHERE key = 'semantic_registry_v1'",
    )).toEqual([]);
    base.close();
  });

  it("assigns stable private IDs while keeping public registry projections unchanged", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "clients", columns: [
        { name: "name", type: "text", required: true },
      ] }]);
      const trace = store.semanticSchemaTrace();
      expect(trace.tables).toHaveLength(1);
      expect(trace.fields).toHaveLength(1);
      expect(isTableId(trace.tables[0]!.tableId)).toBe(true);
      expect(isFieldId(trace.fields[0]!.fieldId)).toBe(true);
      expect(trace.relationships[0]?.kind).toBe("contains");
      expect(JSON.stringify([...store.registrySnapshot().values()])).not.toContain("semantic");
      expect(store.validationRegistrySnapshot().get("clients")!.semantic).toBeDefined();
    } finally { store.close(); }
  });

  it("keeps a field ID across rename and archive round-trip", async () => {
    const store = await ClayStore.openMemory();
    commitOps(store, [{ op: "create_table", table: "clients", columns: [
      { name: "name", type: "text", required: true },
    ] }]);
    const before = store.semanticSchemaTrace().fields[0]!.fieldId;
    commitOps(store, [{ op: "rename_column", table: "clients", from: "name", to: "display_name" }]);
    const renamed = store.semanticSchemaTrace().fields[0]!;
    expect(renamed.fieldId).toBe(before);
    expect(renamed.aliases).toContain("name");

    const imported = await ClayStore.importArchive(await store.exportArchive("semantic"));
    expect(imported.store.semanticSchemaTrace().fields[0]!.fieldId).toBe(before);
    imported.store.close(); store.close();
  });

  it("binds every operation in a compound change to the exact stable field", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "clients", columns: [
        { name: "name", type: "text", required: true },
      ] }]);
      commitOps(store, [
        { op: "add_column", table: "clients",
          column: { name: "owner", type: "text", required: false } },
        { op: "rename_column", table: "clients", from: "owner", to: "lead" },
        { op: "rename_column", table: "clients", from: "lead", to: "manager" },
        { op: "set_required", table: "clients", column: "manager", required: true,
          default_for_existing: "Unassigned" },
      ]);
      const trace = store.semanticSchemaTrace();
      const field = trace.fields.find(item => item.fieldName === "manager")!;
      for (const operationIndex of [0, 1, 2, 3]) {
        expect(bindingForSemanticOp(trace, { version: 2, operationIndex })?.fieldId)
          .toBe(field.fieldId);
      }
      expect(field.aliases).toEqual(expect.arrayContaining(["owner", "lead"]));
    } finally { store.close(); }
  });

  it("tracks computed dependencies as lifecycle-aware stable relationships", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "done", type: "integer", required: false },
        { name: "total", type: "integer", required: false },
      ] }]);
      commitOps(store, [{ op: "create_computed", table: "tasks",
        column: "ratio", expr: "done / total" }]);
      const before = store.semanticSchemaTrace();
      const field = (name: string) => before.fields.find(item => item.fieldName === name)!.fieldId;
      const dependencies = before.relationships.filter(relationship =>
        relationship.kind === "derived_from" && relationship.from === field("ratio"));
      expect(new Set(dependencies.map(relationship => relationship.to)))
        .toEqual(new Set([field("done"), field("total")]));
      const doneRelationship = dependencies.find(relationship => relationship.to === field("done"))!;

      commitOps(store, [{ op: "update_computed", table: "tasks",
        column: "ratio", expr: "done" }]);
      const after = store.semanticSchemaTrace();
      expect(after.relationships.find(relationship =>
        relationship.relationshipId === doneRelationship.relationshipId)?.state).toBe("active");
      expect(after.relationships.find(relationship =>
        relationship.kind === "derived_from" && relationship.to === field("total"))?.state)
        .toBe("retired");
    } finally { store.close(); }
  });

  it("prunes abandoned semantic events but reactivates preserved IDs after truncation", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "title", type: "text", required: true },
      ] }]);
      commitOps(store, [{ op: "add_column", table: "tasks",
        column: { name: "score", type: "number", required: false } }]);
      const before = store.semanticSchemaTrace();
      const score = before.fields.find(field => field.fieldName === "score")!;
      const contains = before.relationships.find(relationship =>
        relationship.kind === "contains" && relationship.to === score.fieldId)!;

      store.rollbackTo(1, { truncate: true });
      expect(store.semanticSchemaTrace().opBindings.every(binding => binding.ref.version <= 1))
        .toBe(true);
      const tombstone = store.validationRegistrySnapshot().get("tasks")!.columns
        .find(column => column.name === "score")!;
      expect(tombstone.semantic!.fieldId).toBe(score.fieldId);
      expect(tombstone.semantic!.events).toEqual([]);

      commitOps(store, [{ op: "add_column", table: "tasks",
        column: { name: "score", type: "number", required: false } }]);
      const after = store.semanticSchemaTrace();
      expect(after.fields.find(field => field.fieldName === "score")!.fieldId).toBe(score.fieldId);
      expect(after.relationships.find(relationship => relationship.to === score.fieldId)!
        .relationshipId).toBe(contains.relationshipId);
      expect(bindingForSemanticOp(after, { version: 2, operationIndex: 0 })?.disposition)
        .toBe("reactivate");
    } finally { store.close(); }
  });

  it("preserves IDs and version-correct labels through rollback and roll-forward", async () => {
    const store = await ClayStore.openMemory();
    try {
      commitOps(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "title", type: "text", required: true },
      ] }]);
      const id = store.semanticSchemaTrace().fields[0]!.fieldId;
      commitOps(store, [{ op: "rename_column", table: "tasks",
        from: "title", to: "name" }]);
      const eventCount = store.validationRegistrySnapshot().get("tasks")!
        .columns[0]!.semantic!.events.length;

      store.rollbackTo(1);
      const rolledBack = store.semanticSchemaTrace().fields[0]!;
      expect(rolledBack).toMatchObject({ fieldId: id, fieldName: "title", label: "title" });
      expect(store.semanticSchemaTrace().opBindings.every(binding => binding.ref.version <= 1))
        .toBe(true);

      store.rollForwardTo(2);
      const rolledForward = store.semanticSchemaTrace().fields[0]!;
      expect(rolledForward).toMatchObject({ fieldId: id, fieldName: "name", label: "name" });
      expect(store.validationRegistrySnapshot().get("tasks")!
        .columns[0]!.semantic!.events).toHaveLength(eventCount);
    } finally { store.close(); }
  });
});
