// Named checkpoints: label a moment on the timeline. Labels live in sys,
// join into history(), and are dropped when their version is truncated away.
import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type MigrationPlanT } from "../src/index";

async function twoVersions(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const ops: MigrationPlanT["operations"] = [{
    op: "create_table", table: "t",
    columns: [{ name: "a", type: "text", required: false }],
  }];
  store.commit({ intent: "one", summary: "v1",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
  store.commit({ intent: "two", summary: "v2", migration: null,
    panels: [{ panel_id: "p", title: "P", placement: { region: "main", order: 0 },
      code: "export default function(){}", declared_queries: [], declared_writes: [] }] });
  return store;
}

describe("named checkpoints", () => {
  it("labels a version and surfaces it in history()", async () => {
    const store = await twoVersions();
    store.setCheckpoint(1, "before the big change");
    const h = store.history();
    expect(h.find(e => e.version === 1)?.label).toBe("before the big change");
    expect(h.find(e => e.version === 2)?.label).toBeUndefined();
    store.close();
  });

  it("rename overwrites; an empty label clears it", async () => {
    const store = await twoVersions();
    store.setCheckpoint(1, "first");
    store.setCheckpoint(1, "renamed");
    expect(store.history().find(e => e.version === 1)?.label).toBe("renamed");
    store.setCheckpoint(1, "   ");
    expect(store.history().find(e => e.version === 1)?.label).toBeUndefined();
    store.close();
  });

  it("truncation drops checkpoints on removed versions (no stale reattach)", async () => {
    const store = await twoVersions();
    store.setCheckpoint(2, "gone soon");
    store.rollbackTo(1, { truncate: true });
    expect(store.history().some(e => e.label === "gone soon")).toBe(false);
    // a fresh v2 must not inherit the dropped label
    store.commit({ intent: "again", summary: "new v2", migration: null,
      panels: [{ panel_id: "q", title: "Q", placement: { region: "main", order: 0 },
        code: "export default function(){}", declared_queries: [], declared_writes: [] }] });
    expect(store.history().find(e => e.version === 2)?.label).toBeUndefined();
    store.close();
  });
});
