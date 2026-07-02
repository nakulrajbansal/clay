// Validator fixtures: pass + fail cases per rule V1–V7 (CLAUDE.md rule 5),
// forbidden identifiers probed in 3 syntactic positions (doc 08 §1).
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_IDENTIFIERS, validateMutationPlan,
  type ValidationIssue, type ValidatorContext,
} from "../src/index";
import { projectsRegistry } from "./helpers";

const ctx = (): ValidatorContext => ({
  registry: projectsRegistry(),
  livePanelIds: ["project_table", "status_counts"],
});

const LIST_CODE = `export default function (clay) {
  clay.db.watch({ from: "projects" }, (rows) => {
    clay.ui.render(h(Table, { rows, columns: [{ field: "name", label: "Project" }] }));
  });
}`;

type Plan = Record<string, unknown>;
function plan(over: Plan = {}, panelOver: Plan = {}): Plan {
  return {
    api: 1, summary: "Adds a list panel.",
    user_facing_diff: [{ kind: "add_panel", detail: "List panel" }],
    clarifying_question: null, assumptions: [], migration: null,
    panels: [{
      panel_id: "list_panel", title: "List",
      placement: { region: "main", order: 0 },
      code: LIST_CODE,
      declared_queries: [{ from: "projects" }],
      declared_writes: [],
      ...panelOver,
    }],
    remove_panels: [], confidence: 0.9,
    ...over,
  };
}

const rules = (issues: ValidationIssue[]): string[] => issues.map(i => i.rule);

describe("baseline", () => {
  it("a well-formed plan passes with zero issues", () => {
    expect(validateMutationPlan(plan(), ctx())).toEqual([]);
  });
  it("a clarify plan skips code checks entirely", () => {
    expect(validateMutationPlan({
      api: 1, summary: "", user_facing_diff: [],
      clarifying_question: "Which field?", assumptions: [],
      migration: null, panels: [], remove_panels: [], confidence: 0.3,
    }, ctx())).toEqual([]);
  });
  it("schema-invalid plans report SCHEMA issues", () => {
    expect(rules(validateMutationPlan({ api: 2 }, ctx()))).toContain("SCHEMA");
    expect(rules(validateMutationPlan(
      plan({}, { code: "x".repeat(70_000) }), ctx()))).toContain("SCHEMA");
  });
});

describe("V1 parse and shape", () => {
  it.each([
    ["syntax error", "not js ((("],
    ["no default export", "function f(clay){}"],
    ["arity 2", "export default function(a, b){}"],
    ["default export not a function", "export default 42"],
    ["import declaration", `import x from "y";\nexport default function(clay){}`],
    ["named export", `export const y = 1;\nexport default function(clay){}`],
  ])("fails: %s", (_label, code) => {
    expect(rules(validateMutationPlan(plan({}, { code }), ctx()))).toContain("V1");
  });
  it("passes: arrow default export of arity 1", () => {
    const code = `export default (clay) => { clay.ui.render(h("p", {}, "hi")); }`;
    expect(validateMutationPlan(plan({}, { code }), ctx())).toEqual([]);
  });
});

describe("V2 forbidden identifiers (generated probes, 3 positions)", () => {
  for (const id of FORBIDDEN_IDENTIFIERS) {
    it(`rejects '${id}' bare / shadowed / member`, () => {
      const probes = [
        `export default function (clay) { ${id}; }`,
        `export default function (clay) { let ${id} = 1; }`,
        `export default function (clay) { const x = {}; x.${id}; }`,
      ];
      for (const code of probes) {
        const issues = validateMutationPlan(plan({}, { code }), ctx());
        expect(issues.length, `probe not rejected: ${code}`).toBeGreaterThan(0);
      }
    });
  }
  it("benign near-misses pass", () => {
    const code = `export default function (clay) {
      const fetcher = 1; const windowing = 2; const construct = 3;
      clay.ui.render(h("p", {}, String(fetcher + windowing + construct)));
    }`;
    expect(validateMutationPlan(plan({}, { code }), ctx())).toEqual([]);
  });
});

describe("V3 member-access rules", () => {
  it("fails: computed access on clay", () => {
    const code = `export default function (clay) { const k = "db"; clay[k]; }`;
    expect(rules(validateMutationPlan(plan({}, { code }), ctx()))).toContain("V3");
  });
  it("fails: computed string access to a forbidden name", () => {
    const code = `export default function (clay) { const x = {}; x["constructor"]; }`;
    expect(rules(validateMutationPlan(plan({}, { code }), ctx()))).toContain("V3");
  });
  it("passes: optional chaining", () => {
    const code = `export default function (clay) {
      const a = { b: 1 }; clay.ui.render(h("p", {}, String(a?.b)));
    }`;
    expect(validateMutationPlan(plan({}, { code }), ctx())).toEqual([]);
  });
});

describe("V4 query consistency", () => {
  it("passes: const-resolved query literal matching a declaration", () => {
    const code = `export default function (clay) {
      const q = { from: "projects", where: [{ field: "owner", op: "eq", value: "Dev" }] };
      clay.db.watch(q, (rows) => clay.ui.render(h("p", {}, String(rows.length))));
    }`;
    const p = plan({}, {
      code,
      declared_queries: [{ from: "projects",
        where: [{ field: "owner", op: "eq", value: "Dev" }] }],
    });
    expect(validateMutationPlan(p, ctx())).toEqual([]);
  });
  it("passes: dynamic value against a {$var:true} declaration", () => {
    const code = `export default function (clay) {
      clay.events.on("f", (s) => {
        clay.db.query({ from: "projects", where: [{ field: "owner", op: "eq", value: s.owner }] });
      });
    }`;
    const p = plan({}, {
      code,
      declared_queries: [{ from: "projects",
        where: [{ field: "owner", op: "eq", value: { $var: true } }] }],
    });
    expect(validateMutationPlan(p, ctx())).toEqual([]);
  });
  it("fails: undeclared query literal", () => {
    const code = `export default function (clay) {
      clay.db.query({ from: "projects", select: ["owner"] });
    }`;
    expect(rules(validateMutationPlan(plan({}, { code }), ctx()))).toContain("V4");
  });
  it("fails: dynamic value where the declaration is concrete", () => {
    const code = `export default function (clay) {
      clay.events.on("f", (s) => {
        clay.db.query({ from: "projects", where: [{ field: "owner", op: "eq", value: s.owner }] });
      });
    }`;
    const p = plan({}, {
      code,
      declared_queries: [{ from: "projects",
        where: [{ field: "owner", op: "eq", value: "Dev" }] }],
    });
    expect(rules(validateMutationPlan(p, ctx()))).toContain("V4");
  });
  it("write tables must be string literals in declared_writes (G22)", () => {
    const ok = plan({}, {
      code: `export default function (clay) { clay.db.insert("projects", { name: "X" }); }`,
      declared_writes: ["projects"],
    });
    expect(validateMutationPlan(ok, ctx())).toEqual([]);
    const undeclared = plan({}, {
      code: `export default function (clay) { clay.db.insert("projects", { name: "X" }); }`,
    });
    expect(rules(validateMutationPlan(undeclared, ctx()))).toContain("V4");
    const dynamic = plan({}, {
      code: `export default function (clay) { const t = "projects"; clay.db.insert(t, {}); }`,
      declared_writes: ["projects"],
    });
    expect(rules(validateMutationPlan(dynamic, ctx()))).toContain("V4");
  });
  it("fails: declared query referencing a missing column", () => {
    const p = plan({}, {
      declared_queries: [
        { from: "projects" },
        { from: "projects", orderBy: [{ field: "nope", dir: "asc" }] }],
    });
    expect(rules(validateMutationPlan(p, ctx()))).toContain("V4");
  });
});

describe("V5 migration checks", () => {
  const goodMigration = {
    operations: [{ op: "add_column", table: "projects",
      column: { name: "notes", type: "text", required: false } }],
    inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "notes" }],
  };
  it("passes: valid migration with honest diff", () => {
    const p = plan({
      migration: goodMigration,
      user_facing_diff: [
        { kind: "add_field", detail: "Notes on projects" },
        { kind: "add_panel", detail: "List panel" }],
    });
    expect(validateMutationPlan(p, ctx())).toEqual([]);
  });
  it("fails: wrong inverse (I2)", () => {
    const p = plan({
      migration: { ...goodMigration,
        inverse: [{ op: "unhide_column", table: "projects", column: "notes" }] },
      user_facing_diff: [
        { kind: "add_field", detail: "Notes" },
        { kind: "add_panel", detail: "List panel" }],
    });
    expect(rules(validateMutationPlan(p, ctx()))).toContain("V5");
  });
});

describe("V6 budgets", () => {
  it("fails: string literal over 4KB", () => {
    const code = `export default function (clay) { const s = "${"x".repeat(5000)}"; }`;
    expect(rules(validateMutationPlan(plan({}, { code }), ctx()))).toContain("V6");
  });
  it("fails: AST depth over 40", () => {
    const deep = "[".repeat(45) + "1" + "]".repeat(45);
    const code = `export default function (clay) { const a = ${deep}; }`;
    expect(rules(validateMutationPlan(plan({}, { code }), ctx()))).toContain("V6");
  });
});

describe("V7 diff honesty (G24 mapping)", () => {
  it("fails: migration op with no matching diff line", () => {
    const p = plan({
      migration: {
        operations: [{ op: "create_computed", table: "projects",
          column: "health_score", expr: "100 - slipped_milestones" }],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects",
          column: "health_score" }],
      },
      // only the panel line; the computed column is unreported
    });
    expect(rules(validateMutationPlan(p, ctx()))).toContain("V7");
  });
  it("fails: new panel with no add_panel/add_chart line", () => {
    const p = plan({ user_facing_diff: [] });
    expect(rules(validateMutationPlan(p, ctx()))).toContain("V7");
  });
  it("passes: add_chart covers a new chart panel (exemplar 4 shape)", () => {
    const p = plan({ user_facing_diff: [{ kind: "add_chart", detail: "A chart" }] });
    expect(validateMutationPlan(p, ctx())).toEqual([]);
  });
  it("backfill and add_index are exempt (G24)", () => {
    const p = plan({
      migration: {
        operations: [
          { op: "add_column", table: "projects",
            column: { name: "priority", type: "enum", required: false,
              values: ["low", "medium", "high"] } },
          { op: "backfill", table: "projects", column: "priority", value: "medium" },
          { op: "add_index", table: "projects", column: "priority" },
        ],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "priority" }],
      },
      user_facing_diff: [
        { kind: "add_status", detail: "Priority on projects" },
        { kind: "add_panel", detail: "List panel" }],
    });
    expect(validateMutationPlan(p, ctx())).toEqual([]);
  });
  it("fails: remove_panels without a remove_panel line; unknown id is G11", () => {
    const p = plan({
      panels: [], remove_panels: ["status_counts"],
      user_facing_diff: [],
    });
    expect(rules(validateMutationPlan(p, ctx()))).toContain("V7");
    const q = plan({
      panels: [], remove_panels: ["never_existed"],
      user_facing_diff: [{ kind: "remove_panel", detail: "gone" }],
    });
    expect(rules(validateMutationPlan(q, ctx()))).toContain("G11");
  });
});

describe("G11 panel identity", () => {
  it("fails: duplicate panel_id within one plan", () => {
    const p = plan();
    (p.panels as unknown[]).push((p.panels as unknown[])[0]);
    (p.user_facing_diff as unknown[]).push({ kind: "add_panel", detail: "again" });
    expect(rules(validateMutationPlan(p, ctx()))).toContain("G11");
  });
});
