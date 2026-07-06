// Prompt assembly per doc 05 §3: section presence, exemplar coverage, and
// the privacy property — user turns carry shapes and intent, never rows.
import { describe, expect, it } from "vitest";
import {
  MutationRequestError, buildRepairTurn, buildSystemPrompt, buildUserTurn,
  type S1Context,
} from "../src/index";

const system = buildSystemPrompt();

describe("system prompt", () => {
  it("carries every doc 05 §3 section in order", () => {
    const markers = [
      "You write MutationPlans for Clay",           // §1 role
      "## ClayAPI reference",                       // §2 (doc 03 verbatim)
      "### query(q: Query): Promise<Row[]>",
      "## Migration vocabulary and invariants",     // §3 (doc 04 §4)
      "I1 every forward plan carries an inverse",
      "## Output contract",                         // §4
      "R1 clarifying_question XOR plan",
      "## Component contracts (G25)",
      "## Composable UI primitives",                // ADR-016 primitives
      "Box{direction",
      "Board{groups",                               // view components
      "MANY VIEWS OVER ONE DATASET",
      "## Hard rules",                              // §5
      "NEVER emit destructive operations",
      "## Get it right the first time",             // preemptive constraints
      "panel_id is snake_case",
      "## Output encoding",                         // wire note (JSON strings)
      "transmitted as JSON STRINGS",
      "## Exemplars",                               // §6
    ];
    let pos = -1;
    for (const m of markers) {
      const next = system.indexOf(m);
      expect(next, `missing or out of order: ${m}`).toBeGreaterThan(pos);
      pos = next;
    }
  });

  it("includes all exemplar intents", () => {
    for (const intent of [
      "I want to record each dog's weight",
      "add a priority to each project",
      "give each project a health score",
      "show a chart of how many books I finish per month",
      "give me a quick way to book an appointment",
      "let me filter the whole board by owner",
      "track my progress better",
      "rename owner to lead everywhere",
      "show the projects as a board grouped by status",
      "show my clients as cards instead of a table",
      "get rid of the breed field",
      "text clients a reminder",
    ]) {
      expect(system).toContain(intent);
    }
  });

  it("is deterministic (byte-stable for caching, G1/doc 07 §4)", () => {
    expect(buildSystemPrompt()).toBe(system);
  });
});

function ctx(over: Partial<S1Context> = {}): S1Context {
  return {
    registry: [{ name: "projects", columns: [{ name: "name", type: "text" }] }],
    panels: [{
      id: "project_table", title: "Projects",
      placement: { region: "main", order: 0 },
      declared_queries: [{ from: "projects" }], declared_writes: [],
      description: "Table over projects",
    }],
    recentSummaries: ["Added a priority field."],
    intent: "add a notes field",
    ...over,
  };
}

describe("user turn", () => {
  it("renders the four S1 sections", () => {
    const turn = buildUserTurn(ctx());
    expect(turn).toContain(`<registry>[{"name":"projects"`);
    expect(turn).toContain(`<panels>[{"id":"project_table"`);
    expect(turn).toContain("<recent>- Added a priority field.</recent>");
    expect(turn).toContain("<intent>add a notes field</intent>");
  });

  it("rejects empty and over-long intents (S0)", () => {
    expect(() => buildUserTurn(ctx({ intent: "" }))).toThrow(MutationRequestError);
    expect(() => buildUserTurn(ctx({ intent: "x".repeat(501) }))).toThrow(MutationRequestError);
  });

  it("drops panel code before descriptions under budget pressure, never the registry", () => {
    const bigPanels = Array.from({ length: 4 }, (_, i) => ({
      id: `panel_${i}`, title: `P${i}`,
      placement: { region: "main", order: i },
      declared_queries: [], declared_writes: [],
      description: `desc ${i}`,
      code: "x".repeat(20_000),
    }));
    const turn = buildUserTurn(ctx({ panels: bigPanels }));
    expect(turn.length).toBeLessThan(50_000);       // under the ~12k-token budget
    expect(turn).toContain("<registry>");           // never dropped
    expect(turn).toContain('"description":"desc 0"');
    // trimming works from the least-relevant end: later panels lost their
    // code, earlier ones kept it
    const codeBlobs = turn.split("x".repeat(20_000)).length - 1;
    expect(codeBlobs).toBeLessThan(4);
    expect(codeBlobs).toBeGreaterThan(0);
  });
});

describe("repair turn", () => {
  it("carries machine reasons and the offending artifact", () => {
    const turn = buildRepairTurn(
      ["V4: db.query query does not match any declared_queries entry"],
      `{"api":1}`);
    expect(turn).toContain("<failure>");
    expect(turn).toContain("V4: db.query");
    expect(turn).toContain(`{"api":1}`);
    expect(turn).toContain("Return a corrected COMPLETE MutationPlan.");
  });
});
