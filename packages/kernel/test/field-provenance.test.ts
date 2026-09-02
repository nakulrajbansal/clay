import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type ForwardOpT } from "../src/index";

function commit(store: ClayStore, operations: ForwardOpT[]): void {
  store.commit({ intent: "field provenance", summary: "Shape changed.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
}

describe("field provenance", () => {
  it("keeps one identity and creation version through rename", async () => {
    const store = await ClayStore.openMemory();
    commit(store, [{ op: "create_table", table: "clients", columns: [
      { name: "name", type: "text", required: true },
    ] }]);
    const before = store.fieldProvenance()[0]!;
    commit(store, [{ op: "rename_column", table: "clients", from: "name", to: "display_name" }]);
    const after = store.fieldProvenance()[0]!;
    expect(after.fieldId).toBe(before.fieldId);
    expect(after.createdVersion).toBe(1);
    expect(after.lastChangedVersion).toBe(2);
    expect(after.aliases).toContain("name");
  });

  it("resolves computed dependencies to stable field IDs", async () => {
    const store = await ClayStore.openMemory();
    commit(store, [{ op: "create_table", table: "tasks", columns: [
      { name: "done", type: "integer", required: false },
      { name: "total", type: "integer", required: false },
    ] }]);
    commit(store, [{ op: "create_computed", table: "tasks", column: "ratio",
      expr: "done / total" }]);
    const fields = store.fieldProvenance();
    const ratio = fields.find(field => field.fieldName === "ratio")!;
    const expected = fields.filter(field => field.fieldName === "done" || field.fieldName === "total")
      .map(field => field.fieldId).sort();
    expect(ratio.derivation?.dependencyFieldIds.slice().sort()).toEqual(expected);
  });
});
