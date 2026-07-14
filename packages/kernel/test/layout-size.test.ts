// ADR-018: 4-col widths + resizable height. The one-time width migration
// (old 2-col w:1/2 -> 4-col w:2/4) and height preservation across reshapes.
import { describe, expect, it } from "vitest";
import {
  ClayStore, createSystemTables, deriveInverse, openMemoryDriver,
  type MigrationPlanT,
} from "../src/index";

describe("layout-scheme migration (ADR-018)", () => {
  it("remaps old widths once (half w:1->2, full w:2->4) and is idempotent", async () => {
    const driver = await openMemoryDriver();
    createSystemTables(driver);
    const ins = (pid: string, w?: number): void => driver.exec(
      `INSERT INTO sys.panel_blobs(version, panel_id, code, placement_json, declared_q_json)
       VALUES (?, ?, ?, ?, ?)`,
      [1, pid, "x", JSON.stringify({ region: "main", order: 0, ...(w ? { w } : {}) }), "[]"]);
    ins("half", 1); ins("full", 2); ins("none");

    ClayStore.fromDriver(driver);                       // runs the migration
    const wOf = (pid: string): unknown => {
      const r = driver.select(
        "SELECT placement_json FROM sys.panel_blobs WHERE panel_id = ?", [pid])[0];
      return (JSON.parse(String(r!.placement_json)) as { w?: number }).w;
    };
    expect(wOf("half")).toBe(2);
    expect(wOf("full")).toBe(4);
    expect(wOf("none")).toBeUndefined();

    // second open must NOT double-remap (flag guards it)
    ClayStore.fromDriver(driver);
    expect(wOf("full")).toBe(4);
  });
});

describe("panel height (ADR-018)", () => {
  async function storeWithPanel(): Promise<ClayStore> {
    const store = await ClayStore.openMemory();
    const ops: MigrationPlanT["operations"] = [{
      op: "create_table", table: "t", columns: [{ name: "a", type: "text", required: false }],
    }];
    store.commit({
      intent: "seed", summary: "v1",
      migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
      panels: [{ panel_id: "p", title: "P", placement: { region: "main", order: 0 },
        code: "export default function(){}", declared_queries: [], declared_writes: [] }],
    });
    return store;
  }

  it("commitLayout stores a height; a later reshape preserves it", async () => {
    const store = await storeWithPanel();
    store.commitLayout([{ panel_id: "p", region: "main", order: 0, h: 420 }]);
    expect(store.livePanels()[0]!.placement.h).toBe(420);

    // a model reshape re-emits the panel WITHOUT h — height must survive
    store.commit({ intent: "edit", summary: "v3", migration: null,
      panels: [{ panel_id: "p", title: "P", placement: { region: "main", order: 0 },
        code: "export default function(){/*v2*/}", declared_queries: [], declared_writes: [] }] });
    expect(store.livePanels()[0]!.placement.h).toBe(420);
    store.close();
  });

  it("commitLayout preserves a set width when only height changes", async () => {
    const store = await storeWithPanel();
    store.commitLayout([{ panel_id: "p", region: "main", order: 0, w: 4 }]);
    store.commitLayout([{ panel_id: "p", region: "main", order: 0, h: 300 }]);
    const pl = store.livePanels()[0]!.placement;
    expect(pl.w).toBe(4);
    expect(pl.h).toBe(300);
    store.close();
  });
});
