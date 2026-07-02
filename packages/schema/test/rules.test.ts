// Unit fixtures for the schema-level rules: R1/R5 (doc 05 §2), G18, G22,
// G23 and invariant I5 (doc 04 §4).
import { describe, expect, it } from "vitest";
import { MigrationPlan, MutationPlan } from "../src/index";

const base = {
  api: 1,
  summary: "Does a thing.",
  user_facing_diff: [],
  clarifying_question: null,
  assumptions: [],
  migration: null,
  panels: [],
  remove_panels: [],
  confidence: 0.9,
};
const panel = {
  panel_id: "some_panel",
  title: "T",
  placement: { region: "main", order: 0 },
  code: "export default function(clay){}",
  declared_queries: [],
};

describe("MutationPlan rules", () => {
  it("a plan with panels passes", () => {
    expect(MutationPlan.safeParse({ ...base, panels: [panel] }).success)
      .toBe(true);
  });
  it("R1: clarifying question alongside a plan fails", () => {
    expect(MutationPlan.safeParse({
      ...base, clarifying_question: "Which?", panels: [panel],
    }).success).toBe(false);
  });
  it("empty plan without a question fails", () => {
    expect(MutationPlan.safeParse(base).success).toBe(false);
  });
  it("R5: confidence < 0.5 without a question fails", () => {
    expect(MutationPlan.safeParse({
      ...base, panels: [panel], confidence: 0.4,
    }).success).toBe(false);
  });
  it("G18: empty summary allowed only when clarifying", () => {
    expect(MutationPlan.safeParse({
      ...base, panels: [panel], summary: "",
    }).success).toBe(false);
    expect(MutationPlan.safeParse({
      ...base, summary: "", clarifying_question: "Which?", confidence: 0.3,
    }).success).toBe(true);
  });
  it("G22: declared_writes defaults to empty", () => {
    const p = MutationPlan.parse({ ...base, panels: [panel] });
    expect(p.panels[0]?.declared_writes).toEqual([]);
  });
});

const inverse = [
  { op: "drop_column_if_added_by_this", table: "t_one", column: "c_one" },
];

describe("MigrationPlan invariants", () => {
  it("G23: backfill takes exactly one of value|expr", () => {
    const mk = (extra: object) => MigrationPlan.safeParse({
      operations: [{ op: "backfill", table: "t_one", column: "c_one", ...extra }],
      inverse,
    }).success;
    expect(mk({ value: "x" })).toBe(true);
    expect(mk({ expr: "1 + 1" })).toBe(true);
    expect(mk({ value: "x", expr: "1 + 1" })).toBe(false);
    expect(mk({})).toBe(false);
  });
  it("I5: a plan touching more than 3 tables fails", () => {
    const operations = ["ta", "tb", "tc", "td"].map(
      t => ({ op: "add_index", table: t, column: "c_one" }));
    expect(MigrationPlan.safeParse({ operations, inverse }).success)
      .toBe(false);
  });
});
