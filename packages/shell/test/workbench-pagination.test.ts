import { describe, expect, it } from "vitest";
import {
  ClayStore, InProcessAsyncStore, deriveInverse,
  type AsyncStore, type ForwardOpT, type QueryRow,
} from "@clay/kernel";
import { loadAllTableRows } from "../src/app/DataView";

describe("workbench pagination", () => {
  const mockStore = (count: number): AsyncStore => {
    const rows: QueryRow[] = Array.from({ length: count }, (_, index) => ({
      id: `id-${String(index).padStart(4, "0")}`, title: `Task ${index}`,
    }));
    return { query: async query => {
      const after = query.where?.find(condition => condition.field === "id" && condition.op === "gt")?.value;
      const filtered = typeof after === "string"
        ? rows.filter(row => String(row.id) > after) : rows;
      return filtered.slice(0, query.limit ?? 500);
    } } as AsyncStore;
  };

  it("treats the custom row limit as inclusive and never returns more", async () => {
    await expect(loadAllTableRows(mockStore(1), "tasks", { maxRows: 1 })).resolves.toHaveLength(1);
    await expect(loadAllTableRows(mockStore(2), "tasks", { maxRows: 1 })).rejects.toThrow(/limited to 1/);
    await expect(loadAllTableRows(mockStore(500), "tasks", { maxRows: 500 })).resolves.toHaveLength(500);
    await expect(loadAllTableRows(mockStore(501), "tasks", { maxRows: 500 })).rejects.toThrow(/limited to 500/);
  });

  it("loads the 501st active record instead of silently cutting off", async () => {
    const store = await ClayStore.openMemory();
    try {
      const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
        { name: "title", type: "text", required: true },
      ] }];
      store.commit({ intent: "tasks", summary: "Tasks.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
      for (let index = 0; index < 501; index++)
        store.insert("tasks", { title: `Task ${index}` });
      const rows = await loadAllTableRows(new InProcessAsyncStore(store), "tasks");
      expect(rows).toHaveLength(501);
      expect(rows.some(row => row.title === "Task 500")).toBe(true);
    } finally { store.close(); }
  });
});
