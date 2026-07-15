// ADR-022c: small changes never need the model. renamePanel/removePanel are
// instant local commits through the SAME vocabulary plans use — reversible
// on the shared timeline, data untouched.
import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type MigrationPlanT } from "../src/index";

async function storeWithPanel(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const ops: MigrationPlanT["operations"] = [{
    op: "create_table", table: "t", columns: [{ name: "a", type: "text", required: false }],
  }];
  store.commit({
    intent: "seed", summary: "v1",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
    panels: [{ panel_id: "p", title: "Old Title", placement: { region: "main", order: 0 },
      code: "export default function(){}",
      declared_queries: [{ from: "t" }], declared_writes: [] }],
  });
  return store;
}

describe("renamePanel (ADR-022c)", () => {
  it("commits a new version with the new title; code and queries untouched", async () => {
    const store = await storeWithPanel();
    const before = store.livePanels()[0]!;
    const v = store.renamePanel("p", "  New Title  ");
    const after = store.livePanels()[0]!;
    expect(after.title).toBe("New Title");           // trimmed
    expect(after.code).toBe(before.code);
    expect(after.declared_queries).toEqual(before.declared_queries);
    expect(v).toBe(before.version + 1);

    // reversible: rewind restores the old title
    store.rollbackTo(v - 1, { truncate: true });
    expect(store.livePanels()[0]!.title).toBe("Old Title");
    store.close();
  });

  it("same title is a no-op; empty and unknown panels throw", async () => {
    const store = await storeWithPanel();
    const head = store.headVersion();
    expect(store.renamePanel("p", "Old Title")).toBe(head);
    expect(store.headVersion()).toBe(head);
    expect(() => store.renamePanel("p", "   ")).toThrow(/title/);
    expect(() => store.renamePanel("ghost", "X")).toThrow(/no live panel/);
    store.close();
  });
});

describe("removePanel (ADR-022c)", () => {
  it("tombstones the panel, keeps the data, and rewinds back", async () => {
    const store = await storeWithPanel();
    store.insert("t", { a: "kept" });
    const v = store.removePanel("p");
    expect(store.livePanels()).toHaveLength(0);
    // data outlives interface: the row is still there
    expect(store.query({ from: "t" })).toHaveLength(1);

    // reversible: rewind brings the panel back, row still present
    store.rollbackTo(v - 1, { truncate: true });
    expect(store.livePanels()[0]!.panel_id).toBe("p");
    expect(store.query({ from: "t" })).toHaveLength(1);
    store.close();
  });

  it("unknown panel throws", async () => {
    const store = await storeWithPanel();
    expect(() => store.removePanel("ghost")).toThrow(/no live panel/);
    store.close();
  });
});
