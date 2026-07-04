// G6: row-level undo. Snapshots on update/softDelete, ring-capped;
// restoreRow re-applies the latest snapshot (skipping vanished columns)
// and undeletes; row_history is a reserved table name.
import { describe, expect, it } from "vitest";
import { ClayError, validateMutationPlan } from "../src/index";
import { seededStore } from "./helpers";

describe("row_history (G6)", () => {
  it("update -> restore round-trips the previous values", async () => {
    const store = await seededStore();
    const id = String(store.query({
      from: "projects", where: [{ field: "name", op: "eq", value: "Apollo" }],
    })[0]!.id);
    store.update("projects", id, { owner: "Kim", open_risks: 9 });
    store.restoreRow("projects", id);
    const row = store.query({
      from: "projects", where: [{ field: "id", op: "eq", value: id }] })[0]!;
    expect(row.owner).toBe("Dev");
    expect(row.open_risks).toBe(1);
    expect(store.restorableRows("projects")).toContain(id);
    store.close();
  });

  it("softDelete -> restore undeletes with prior values intact", async () => {
    const store = await seededStore();
    const id = String(store.query({
      from: "projects", where: [{ field: "name", op: "eq", value: "Cygnus" }],
    })[0]!.id);
    store.softDelete("projects", id);
    expect(store.query({ from: "projects" })).toHaveLength(2);
    store.restoreRow("projects", id);
    expect(store.query({ from: "projects" })).toHaveLength(3);
    store.close();
  });

  it("restore skips columns that no longer exist (rollback of add_column)", async () => {
    const store = await seededStore();
    store.commit({
      intent: "notes", summary: "Adds notes.",
      migration: {
        operations: [{ op: "add_column", table: "projects",
          column: { name: "notes", type: "text", required: false } }],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "notes" }],
      },
    });
    const id = String(store.query({ from: "projects" })[0]!.id);
    store.update("projects", id, { notes: "hello", owner: "Kim" });   // snapshot has notes:null
    store.rollbackTo(1, { truncate: true });                          // notes column dropped
    store.restoreRow("projects", id);                                 // must not crash
    const row = store.query({
      from: "projects", where: [{ field: "id", op: "eq", value: id }] })[0]!;
    expect(row.owner).toBe("Dev");
    store.close();
  });

  it("the ring cap trims oldest entries", async () => {
    const store = await seededStore();
    store.rowHistoryCap = 5;
    const id = String(store.query({ from: "projects" })[0]!.id);
    for (let i = 0; i < 9; i++) store.update("projects", id, { open_risks: i });
    expect(store.restorableRows("projects").length).toBeGreaterThan(0);
    expect(store.rowHistoryCount()).toBeLessThanOrEqual(5);
    store.close();
  });

  it("no history -> E_VALIDATION; reserved table name rejected by V5", async () => {
    const store = await seededStore();
    const id = String(store.query({ from: "projects" })[0]!.id);
    expect(() => store.restoreRow("projects", id)).toThrowError(ClayError);

    const issues = validateMutationPlan({
      api: 1, summary: "Steals the history table.",
      user_facing_diff: [{ kind: "add_field", detail: "row_history" }],
      clarifying_question: null, assumptions: [],
      migration: {
        operations: [{ op: "create_table", table: "row_history",
          columns: [{ name: "x", type: "text", required: false }] }],
        inverse: [{ op: "drop_table_if_created_by_this", table: "row_history" }],
      },
      panels: [], remove_panels: [], confidence: 0.9,
    }, { registry: store.registrySnapshot(), livePanelIds: [] });
    expect(issues.map(i => i.rule)).toContain("V5");
    store.close();
  });
});
