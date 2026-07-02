// MigrationEngine: per-op forward/inverse pairs against fixture DBs
// (doc 08 §1) plus invariant enforcement (I2, G23).
import { describe, expect, it } from "vitest";
import { ClayError, deriveInverse, type MigrationPlanT } from "../src/index";
import { HEALTH_COMPUTED, seededStore } from "./helpers";

const expectCode = (fn: () => unknown, code: string): void => {
  try { fn(); expect.fail(`expected ${code}`); }
  catch (e) { expect((e as ClayError).code).toBe(code); }
};

describe("per-op forward/inverse pairs", () => {
  it("add_column round-trips bit-equal", async () => {
    const store = await seededStore();
    const dump0 = JSON.stringify(store.dumpTable("projects"));
    store.commit({
      intent: "add notes", summary: "Adds notes.",
      migration: {
        operations: [{ op: "add_column", table: "projects",
          column: { name: "notes", type: "text", required: false } }],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "notes" }],
      },
    });
    expect(store.query({ from: "projects" })[0]).toHaveProperty("notes", null);
    store.rollbackTo(1);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
    store.rollForwardTo(2);
    expect(store.query({ from: "projects" })[0]).toHaveProperty("notes", null);
    store.close();
  });

  it("rename_column keeps data and reverses exactly", async () => {
    const store = await seededStore();
    const dump0 = JSON.stringify(store.dumpTable("projects"));
    store.commit({
      intent: "rename", summary: "Owner is now Lead.",
      migration: {
        operations: [{ op: "rename_column", table: "projects", from: "owner", to: "lead" }],
        inverse: [{ op: "rename_column", table: "projects", from: "lead", to: "owner" }],
      },
    });
    const rows = store.query({ from: "projects", select: ["lead"], orderBy: [{ field: "lead", dir: "asc" }] });
    expect(rows.map(r => r.lead)).toEqual(["Dev", "Dev", "Kim"]);
    expectCode(() => store.query({ from: "projects", select: ["owner"] }), "E_COLUMN_UNKNOWN");
    store.rollbackTo(1);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
    store.close();
  });

  it("hide_column keeps the data invisible-but-present (I3)", async () => {
    const store = await seededStore();
    const dump0 = JSON.stringify(store.dumpTable("projects"));
    store.commit({
      intent: "hide owner", summary: "Hides owner (data kept).",
      migration: {
        operations: [{ op: "hide_column", table: "projects", column: "owner" }],
        inverse: [{ op: "unhide_column", table: "projects", column: "owner" }],
      },
    });
    expectCode(() => store.query({ from: "projects", select: ["owner"] }), "E_COLUMN_UNKNOWN");
    expect(store.query({ from: "projects" })[0]).not.toHaveProperty("owner");
    expect(store.dumpTable("projects")[0]).toHaveProperty("owner");   // data kept
    store.rollbackTo(1);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
    expect(store.query({ from: "projects" })[0]).toHaveProperty("owner");
    store.close();
  });

  it("add_enum_value reverses only when unused", async () => {
    const migration: MigrationPlanT = {
      operations: [{ op: "add_enum_value", table: "projects", column: "status", value: "blue" }],
      inverse: [{ op: "remove_enum_value_if_unused", table: "projects", column: "status", value: "blue" }],
    };
    const unused = await seededStore();
    unused.commit({ intent: "blue", summary: "Adds blue.", migration });
    unused.rollbackTo(1);
    const statusCol = (reg: ReturnType<typeof unused.registrySnapshot>): string[] =>
      reg.get("projects")!.columns.find(c => c.name === "status")!.values ?? [];
    expect(statusCol(unused.registrySnapshot())).toEqual(["green", "amber", "red"]);
    unused.close();

    const used = await seededStore();
    used.commit({ intent: "blue", summary: "Adds blue.", migration });
    used.insert("projects", { name: "Denali", status: "blue" });
    used.rollbackTo(1);
    expect(statusCol(used.registrySnapshot())).toEqual(["green", "amber", "red", "blue"]);
    used.close();
  });

  it("backfill fills a same-plan column; rollback drops it", async () => {
    const store = await seededStore();
    const dump0 = JSON.stringify(store.dumpTable("projects"));
    store.commit({
      intent: "priority", summary: "Adds priority defaulting to medium.",
      migration: {
        operations: [
          { op: "add_column", table: "projects",
            column: { name: "priority", type: "enum", required: false, values: ["low", "medium", "high"] } },
          { op: "backfill", table: "projects", column: "priority", value: "medium" },
        ],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "priority" }],
      },
    });
    expect(store.query({ from: "projects" }).map(r => r.priority)).toEqual(["medium", "medium", "medium"]);
    store.rollbackTo(1);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
    store.close();
  });

  it("backfill by expression evaluates per row", async () => {
    const store = await seededStore();
    store.commit({
      intent: "risk load", summary: "Adds a risk load number.",
      migration: {
        operations: [
          { op: "add_column", table: "projects",
            column: { name: "risk_load", type: "number", required: false } },
          { op: "backfill", table: "projects", column: "risk_load",
            expr: "slipped_milestones * 10 + open_risks" },
        ],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "risk_load" }],
      },
    });
    const rows = store.query({ from: "projects", select: ["name", "risk_load"], orderBy: [{ field: "name", dir: "asc" }] });
    expect(rows.map(r => r.risk_load)).toEqual([1, 23, 45]);
    store.close();
  });

  it("update_computed mirrors restore_expr with the prior expression", async () => {
    const store = await seededStore();
    store.commit({ intent: "health", summary: "Adds health score.", migration: HEALTH_COMPUTED });
    store.commit({
      intent: "simpler", summary: "Simplifies the score.",
      migration: {
        operations: [{ op: "update_computed", table: "projects", column: "health_score",
          expr: "100 - slipped_milestones" }],
        inverse: [{ op: "restore_expr", table: "projects", column: "health_score",
          expr: "100 - 10 * slipped_milestones - 5 * open_risks" }],
      },
    });
    const score = (): unknown[] =>
      store.query({ from: "projects", select: ["health_score"], orderBy: [{ field: "name", dir: "asc" }] })
        .map(r => r.health_score);
    expect(score()).toEqual([100, 98, 96]);
    store.rollbackTo(2);
    expect(score()).toEqual([95, 65, 35]);
    store.close();
  });

  it("set_required fills nulls via default_for_existing (G23 partial invertibility)", async () => {
    const store = await seededStore();
    store.insert("projects", { name: "Denali" });   // owner null
    store.commit({
      intent: "require owner", summary: "Owner becomes required.",
      migration: {
        operations: [{ op: "set_required", table: "projects", column: "owner",
          required: true, default_for_existing: "unassigned" }],
        inverse: [{ op: "unset_required", table: "projects", column: "owner" }],
      },
    });
    const denali = store.query({ from: "projects", where: [{ field: "name", op: "eq", value: "Denali" }] })[0];
    expect(denali?.owner).toBe("unassigned");
    expectCode(() => store.insert("projects", { name: "Everest" }), "E_VALIDATION");
    store.rollbackTo(1);
    store.insert("projects", { name: "Everest" });   // allowed again
    store.close();
  });
});

describe("invariant enforcement", () => {
  it("I2: wrong inverse op is rejected", async () => {
    const store = await seededStore();
    expectCode(() => store.commit({
      intent: "bad", summary: "Bad inverse.",
      migration: {
        operations: [{ op: "hide_column", table: "projects", column: "owner" }],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "owner" }],
      },
    }), "E_VALIDATION");
    store.close();
  });

  it("I2: inverse order must reverse the forward order", async () => {
    const store = await seededStore();
    expectCode(() => store.commit({
      intent: "bad order", summary: "Bad order.",
      migration: {
        operations: [
          { op: "hide_column", table: "projects", column: "owner" },
          { op: "hide_column", table: "projects", column: "status" },
        ],
        inverse: [
          { op: "unhide_column", table: "projects", column: "owner" },
          { op: "unhide_column", table: "projects", column: "status" },
        ],
      },
    }), "E_VALIDATION");
    store.close();
  });

  it("G23: backfill may not target a pre-existing column", async () => {
    const store = await seededStore();
    expectCode(() => store.commit({
      intent: "bad backfill", summary: "Backfills owner.",
      migration: {
        operations: [{ op: "backfill", table: "projects", column: "owner", value: "Dev" }],
        inverse: [{ op: "unhide_column", table: "projects", column: "owner" }],
      },
    }), "E_VALIDATION");
    store.close();
  });

  it("failed commits leave no trace (single transaction)", async () => {
    const store = await seededStore();
    const dump0 = JSON.stringify(store.dumpTable("projects"));
    expectCode(() => store.commit({
      intent: "half good", summary: "Second op is invalid.",
      migration: {
        operations: [
          { op: "add_column", table: "projects", column: { name: "ok_col", type: "text", required: false } },
          { op: "backfill", table: "projects", column: "owner", value: "x" },
        ],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "ok_col" }],
      },
    }), "E_VALIDATION");
    expect(store.headVersion()).toBe(1);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
    expectCode(() => store.query({ from: "projects", select: ["ok_col"] }), "E_COLUMN_UNKNOWN");
    store.close();
  });

  it("deriveInverse produces the canonical mirror", async () => {
    const store = await seededStore();
    const inverse = deriveInverse([
      { op: "add_column", table: "projects", column: { name: "budget", type: "number", required: false } },
      { op: "backfill", table: "projects", column: "budget", value: 0 },
      { op: "hide_column", table: "projects", column: "owner" },
    ], store.registrySnapshot());
    expect(inverse).toEqual([
      { op: "unhide_column", table: "projects", column: "owner" },
      { op: "drop_column_if_added_by_this", table: "projects", column: "budget" },
    ]);
    store.close();
  });
});
