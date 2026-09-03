import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, type BatchMutation, type ForwardOpT,
} from "../src/index";

function commit(store: ClayStore, operations: ForwardOpT[]): void {
  store.commit({
    intent: "seed workbench", summary: "Seeds workbench data.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
}

describe("daily workbench", () => {
  it("searches across tables and linked labels with bounded results", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [{ op: "create_table", table: "customers", columns: [
        { name: "name", type: "text", required: true },
        { name: "notes", type: "rich_text", required: false },
      ] }]);
      commit(store, [{ op: "create_table", table: "jobs", columns: [
        { name: "title", type: "text", required: true },
        { name: "customer", type: "relation", required: false,
          relation: { target_table: "customers", cardinality: "one",
            unique_targets: false, display_field: "name" } },
      ] }]);
      const acme = store.insert("customers", { name: "Acme Studio", notes: "Priority design account" });
      const job = store.insert("jobs", { title: "Lobby installation", customer: acme.id });
      store.insert("jobs", { title: "Unrelated job" });

      const byName = store.globalSearch("acme");
      expect(byName.map(result => [result.table, result.id])).toEqual([
        ["customers", acme.id], ["jobs", job.id],
      ]);
      expect(byName[0]).toMatchObject({ label: "Acme Studio", matchedFields: ["name"] });
      expect(store.globalSearch("", 1)).toHaveLength(1);
      expect(() => store.globalSearch("x".repeat(121))).toThrow(/120/);
      expect(() => store.softDelete("customers", String(acme.id))).toThrow(/linked record/i);
      store.softDelete("jobs", String(job.id));
      store.softDelete("customers", String(acme.id));
      expect(store.globalSearch("acme")).toEqual([]);
    } finally { store.close(); }
  });

  it("finds a match after the first 5,000 records", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "name", type: "text", required: true },
      ] }]);
      for (let index = 0; index < 5_001; index++)
        store.insert("tasks", { name: index === 5_000 ? "Boundary needle" : `Task ${index}` });
      expect(store.globalSearch("Boundary needle")).toMatchObject([
        { table: "tasks", label: "Boundary needle" },
      ]);
    } finally { store.close(); }
  });

  it("applies mixed bulk work atomically and undoes it from a durable receipt", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "name", type: "text", required: true },
        { name: "status", type: "enum", required: false, values: ["todo", "done"] },
      ] }]);
      const first = store.insert("tasks", { name: "One", status: "todo" });
      const second = store.insert("tasks", { name: "Two", status: "todo" });
      const receipt = store.applyBatch({
        source: "user", summary: "Complete selected tasks",
        mutations: [
          { kind: "update", table: "tasks", id: String(first.id), patch: { status: "done" } },
          { kind: "update", table: "tasks", id: String(second.id), patch: { status: "done" } },
          { kind: "insert", table: "tasks", row: { name: "Follow up", status: "todo" } },
        ],
      });
      expect(receipt).toMatchObject({ changed: 3, source: "user", undone: false });
      expect(receipt.created).toHaveLength(1);
      expect(store.query({ from: "tasks", where: [{ field: "status", op: "eq", value: "done" }] }))
        .toHaveLength(2);

      const undone = store.undoBatch(receipt.id);
      expect(undone.undone).toBe(true);
      expect(store.query({ from: "tasks", where: [{ field: "status", op: "eq", value: "done" }] }))
        .toHaveLength(0);
      expect(store.query({ from: "tasks" })).toHaveLength(2);
      expect(store.operationBatches()[0]).toMatchObject({ id: receipt.id, undone: true });
    } finally { store.close(); }
  });

  it("counts only changed records when a batch mixes updates with no-ops", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "name", type: "text", required: true },
        { name: "status", type: "enum", required: false, values: ["todo", "done"] },
      ] }]);
      const changed = store.insert("tasks", { name: "Change me", status: "todo" });
      const unchanged = store.insert("tasks", { name: "Already done", status: "done" });
      const receipt = store.applyBatch({ source: "user", summary: "Complete selected", mutations: [
        { kind: "update", table: "tasks", id: String(changed.id), patch: { status: "done" } },
        { kind: "update", table: "tasks", id: String(unchanged.id), patch: { status: "done" } },
      ] });

      expect(receipt.changed).toBe(1);
      expect(store.undoBatch(receipt.id).undone).toBe(true);
      expect(store.query({ from: "tasks" })).toMatchObject([
        { name: "Change me", status: "todo" },
        { name: "Already done", status: "done" },
      ]);
    } finally { store.close(); }
  });

  it("refuses restore and batch undo that would create dangling links", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [{ op: "create_table", table: "customers", columns: [
        { name: "name", type: "text", required: true },
      ] }]);
      commit(store, [{ op: "create_table", table: "jobs", columns: [
        { name: "title", type: "text", required: true },
        { name: "customer", type: "relation", required: false,
          relation: { target_table: "customers", cardinality: "one",
            unique_targets: false, display_field: "name" } },
      ] }]);
      const first = store.insert("customers", { name: "First" });
      const second = store.insert("customers", { name: "Second" });
      const job = store.insert("jobs", { title: "Install", customer: first.id });
      const receipt = store.applyBatch({ source: "user", summary: "Relink", mutations: [{
        kind: "update", table: "jobs", id: String(job.id), patch: { customer: second.id },
      }] });
      store.softDelete("customers", String(first.id));
      expect(() => store.undoBatch(receipt.id)).toThrow(/linked record|relation/i);
      expect(store.query({ from: "jobs", select: ["customer"] })[0]!.customer)
        .toMatchObject({ id: second.id });

      expect(() => store.restoreRow("jobs", String(job.id))).toThrow(/linked record|relation/i);
    } finally { store.close(); }
  });

  it("rolls back every mutation on failure and refuses stale undo", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "name", type: "text", required: true },
        { name: "status", type: "enum", required: false, values: ["todo", "done"] },
      ] }]);
      const first = store.insert("tasks", { name: "One", status: "todo" });
      const second = store.insert("tasks", { name: "Two", status: "todo" });
      const invalid: BatchMutation[] = [
        { kind: "update", table: "tasks", id: String(first.id), patch: { status: "done" } },
        { kind: "update", table: "tasks", id: String(second.id), patch: { status: "invalid" } },
      ];
      expect(() => store.applyBatch({ source: "user", summary: "Invalid", mutations: invalid }))
        .toThrow(/expects one of/i);
      expect(store.query({ from: "tasks", where: [{ field: "status", op: "eq", value: "done" }] }))
        .toHaveLength(0);
      expect(store.operationBatches()).toHaveLength(0);

      const receipt = store.applyBatch({ source: "user", summary: "Complete one", mutations: [{
        kind: "update", table: "tasks", id: String(first.id), patch: { status: "done" },
      }] });
      store.update("tasks", String(first.id), { name: "Changed later" });
      expect(() => store.undoBatch(receipt.id)).toThrow(/changed after/i);
      expect(store.query({ from: "tasks", where: [{ field: "id", op: "eq", value: String(first.id) }] })[0])
        .toMatchObject({ name: "Changed later", status: "done" });
    } finally { store.close(); }
  });
});
