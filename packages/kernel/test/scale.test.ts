// Launch gate: Clay must stay responsive at real-life scale — thousands of
// rows, dozens of versions — not just template-sized samples. Thresholds
// are generous CI-safe ceilings; the point is catching order-of-magnitude
// regressions, not micro-benchmarks.
import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type MigrationPlanT } from "../src/index";

describe("scale (launch gate)", () => {
  it("5,000 rows: insert, query, aggregate, and edit stay fast", async () => {
    const store = await ClayStore.openMemory();
    const ops: MigrationPlanT["operations"] = [{
      op: "create_table", table: "records", columns: [
        { name: "name", type: "text", required: true },
        { name: "category", type: "enum", required: false, values: ["a", "b", "c", "d"] },
        { name: "value", type: "number", required: false },
        { name: "on", type: "date", required: false },
      ] }];
    store.commit({ intent: "seed", summary: "v1",
      migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
      panels: [] });

    let t = Date.now();
    for (let i = 0; i < 5000; i++)
      store.insert("records", { name: `Row ${i}`, category: "abcd"[i % 4],
        value: i % 997, on: "2026-07-01" });
    const insertMs = Date.now() - t;
    expect(insertMs, `5k inserts took ${insertMs}ms`).toBeLessThan(30_000);

    t = Date.now();
    const page = store.query({ from: "records", orderBy: [{ field: "value", dir: "desc" }], limit: 500 });
    const queryMs = Date.now() - t;
    expect(page).toHaveLength(500);
    expect(queryMs, `paged query took ${queryMs}ms`).toBeLessThan(500);

    t = Date.now();
    const agg = store.query({ from: "records", groupBy: ["category"],
      aggregate: [{ fn: "sum", field: "value", as: "v" }] });
    const aggMs = Date.now() - t;
    expect(agg).toHaveLength(4);
    expect(aggMs, `aggregate took ${aggMs}ms`).toBeLessThan(500);

    const id = String(page[0]!.id);
    t = Date.now();
    store.update("records", id, { value: 123456 });
    expect(Date.now() - t, "single update at 5k rows").toBeLessThan(300);
    store.close();
  }, 60_000);

  it("50 versions: commits, livePanels, and a deep rewind stay fast", async () => {
    const store = await ClayStore.openMemory();
    const ops: MigrationPlanT["operations"] = [{
      op: "create_table", table: "items", columns: [
        { name: "name", type: "text", required: true }] }];
    store.commit({ intent: "seed", summary: "v1",
      migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
      panels: [] });

    let t = Date.now();
    for (let i = 0; i < 50; i++) {
      store.commit({ intent: `edit ${i}`, summary: `Panel v${i}.`, migration: null,
        panels: [{ panel_id: "list_panel", title: `List ${i}`,
          placement: { region: "main", order: 0 },
          code: `export default function(clay){ clay.db.watch({from:"items"},(r)=>clay.ui.render(h(Table,{rows:r,columns:[{field:"name",label:"N${i}"}]}))); }`,
          declared_queries: [{ from: "items" }], declared_writes: [] }] });
    }
    const commitMs = Date.now() - t;
    expect(commitMs, `50 commits took ${commitMs}ms`).toBeLessThan(20_000);

    t = Date.now();
    const live = store.livePanels();
    expect(live).toHaveLength(1);
    expect(Date.now() - t, "livePanels at 51 versions").toBeLessThan(300);

    t = Date.now();
    store.rollbackTo(10, { truncate: true });
    expect(Date.now() - t, "deep rewind (51 -> 10)").toBeLessThan(3000);
    expect(store.livePanels()[0]!.title).toBe("List 8");
    store.close();
  }, 60_000);
});
