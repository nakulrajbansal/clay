// Realistic end-to-end evaluation: plausible user intents paired with the
// kind of IMPERFECT model output the live API actually returns (camelCase
// ids, over-length text, made-up ops, unsupported-viz approximations),
// driven through the full pipeline (hydrate -> Zod -> Validator -> shadow
// dry-run). This is how we find issues without burning live calls: a
// scripted planner replays canned first + repair responses, and we assert
// the pipeline reaches a sane outcome (preview / clarify / honest fail)
// and — critically — that a fixable first attempt gets ONE repair and
// commits, instead of dying at the plan stage.
import { describe, expect, it } from "vitest";
import { MutationPlan } from "@clay/schema";
import {
  MutationPipeline, type DebugEvent, type Planner, type PlannerResult,
} from "@clay/kernel";
import { trackStore, groomStore, logStore } from "../src/regression/contexts";
import { hydrateApiPlan } from "../src/client";

// A planner that returns pre-scripted WIRE-form responses (migration +
// declared_queries as JSON strings, exactly like the grammar forces) and
// replicates the REAL client: hydrate -> Zod. A Zod failure returns the
// same E_SCHEMA shape the MutationClient does, so the test exercises the
// actual client-side schema-repair path.
class ScriptedWire implements Planner {
  repairs = 0;
  constructor(private readonly responses: unknown[]) {}
  private take(): PlannerResult {
    const r = this.responses.shift();
    if (r === undefined) return { ok: false, error: { code: "E_MODEL", message: "script empty" } };
    const raw = JSON.stringify(r);
    const parsed = MutationPlan.safeParse(hydrateApiPlan(r));
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        i => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
      return { ok: false, error: { code: "E_SCHEMA",
        message: `plan fails validation: ${issues.slice(0, 3).join("; ")}`, issues, raw } };
    }
    return { ok: true, plan: parsed.data, raw };
  }
  async requestPlan(): Promise<PlannerResult> { return this.take(); }
  async requestRepair(): Promise<PlannerResult> { this.repairs++; return this.take(); }
}

// wire-form helpers: the model emits these as strings
const mig = (o: unknown): string => JSON.stringify(o);
const q = (o: unknown): string => JSON.stringify(o);

function trace(): { onDebug: (e: DebugEvent) => void; events: DebugEvent[] } {
  const events: DebugEvent[] = [];
  return { onDebug: e => events.push(e), events };
}

describe("realistic evaluation — imperfect first output, one repair, commit", () => {
  it("camelCase panel_id (fails PanelId regex) is repaired to snake_case", async () => {
    const store = await trackStore();
    const bad = {
      api: 1, summary: "Adds a priority field shown as a colored badge.",
      user_facing_diff: [
        { kind: "add_status", detail: "Priority on projects" },
        { kind: "change_panel", detail: "Project table gains a Priority column" }],
      clarifying_question: null, assumptions: [],
      migration: mig({
        operations: [{ op: "add_column", table: "projects",
          column: { name: "priority", type: "enum", required: false, values: ["low", "medium", "high"] } },
          { op: "backfill", table: "projects", column: "priority", value: "medium" }],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "priority" }],
      }),
      panels: [{
        panel_id: "projectTable",   // camelCase -> Zod PanelId regex fails
        title: "Projects", placement: { region: "main", order: 0 },
        code: "export default function(clay){ clay.db.watch({from:\"projects\"},(r)=>clay.ui.render(h(Table,{rows:r,columns:[{field:\"name\",label:\"Name\"}]}))); }",
        declared_queries: [q({ from: "projects" })], declared_writes: [],
      }],
      remove_panels: [], confidence: 0.9,
    };
    const good = { ...bad, panels: [{ ...bad.panels[0], panel_id: "project_table" }] };

    const t = trace();
    const planner = new ScriptedWire([bad, good]);
    const result = await new MutationPipeline(store, planner, t).run(
      "add a priority field and show it as a colored badge");

    expect(result.status).toBe("preview");
    expect(planner.repairs).toBe(1);
    // the trace shows a schema-triggered repair with the actual reason
    const repair = t.events.find(e => e.stage === "repair");
    expect(repair).toMatchObject({ trigger: "schema" });
    if (repair && repair.stage === "repair")
      expect(repair.reasons.join(" ")).toMatch(/panel_id|panels\.0\.panel_id/i);
    if (result.status === "preview") result.preview.discard();
    store.close();
  });

  it("over-length summary (>200 chars) is a schema failure that repairs", async () => {
    const store = await logStore();
    const longSummary = "This adds ".concat("a very detailed explanation ".repeat(12));
    expect(longSummary.length).toBeGreaterThan(200);
    const base = {
      api: 1, user_facing_diff: [{ kind: "add_chart", detail: "Books per month" }],
      clarifying_question: null, assumptions: [], migration: null,
      panels: [{
        panel_id: "per_month", title: "Per month",
        placement: { region: "main", order: 1 },
        code: "export default function(clay){ clay.ui.render(h(EmptyState,{label:\"x\"})); }",
        declared_queries: [q({ from: "books", select: ["finished"] })], declared_writes: [],
      }],
      remove_panels: [], confidence: 0.9,
    };
    const planner = new ScriptedWire([
      { ...base, summary: longSummary },
      { ...base, summary: "Adds a bar chart of books finished per month." },
    ]);
    const result = await new MutationPipeline(store, planner).run(
      "show a chart of books finished per month");
    expect(result.status).toBe("preview");
    expect(planner.repairs).toBe(1);
    if (result.status === "preview") result.preview.discard();
    store.close();
  });

  it("made-up migration op (drop_table) fails validation and repairs to hide", async () => {
    const store = await groomStore();
    const bad = {
      api: 1, summary: "Removes the breed field.",
      user_facing_diff: [{ kind: "change_field", detail: "Breed removed" }],
      clarifying_question: null, assumptions: [],
      migration: mig({
        operations: [{ op: "drop_column", table: "clients", column: "breed" }],  // not in vocab
        inverse: [{ op: "add_column", table: "clients", column: { name: "breed", type: "text" } }],
      }),
      panels: [], remove_panels: [], confidence: 0.9,
    };
    const good = {
      ...bad,
      summary: "Hides the breed field. Your data is kept and can be restored by rewinding.",
      migration: mig({
        operations: [{ op: "hide_column", table: "clients", column: "breed" }],
        inverse: [{ op: "unhide_column", table: "clients", column: "breed" }],
      }),
    };
    const planner = new ScriptedWire([bad, good]);
    const result = await new MutationPipeline(store, planner).run("get rid of the breed field");
    // Either the schema layer (unknown op fails the discriminated union) or
    // the validator catches it; both trigger the single repair -> preview.
    expect(result.status).toBe("preview");
    expect(planner.repairs).toBe(1);
    if (result.status === "preview") result.preview.discard();
    store.close();
  });

  it("two bad attempts in a row -> honest failure with the real reasons, no crash", async () => {
    const store = await trackStore();
    const broken = {
      api: 1, summary: "x", user_facing_diff: [],
      clarifying_question: null, assumptions: [], migration: null,
      panels: [{
        panel_id: "gantt_view",
        title: "Gantt", placement: { region: "main", order: 0 },
        // V4: queries a table that is neither declared nor in the registry —
        // a failure the pipeline can NOT heal (ADR-020/021 fix formalities,
        // never capability violations), so two attempts -> honest failure.
        code: "export default function(clay){ clay.db.query({from:\"ghost\"}); }",
        declared_queries: [], declared_writes: [],
      }],
      remove_panels: [], confidence: 0.9,
    };
    const planner = new ScriptedWire([broken, broken]);
    const result = await new MutationPipeline(store, planner).run(
      "show my projects as a gantt chart");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons.join(" ")).not.toContain("[object Object]");   // readable
    }
    expect(planner.repairs).toBe(1);   // exactly one round, then honest fail
    store.close();
  });

  it("clarify on a vague intent stops cleanly (no repair, no dry-run)", async () => {
    const store = await logStore();
    const planner = new ScriptedWire([{
      api: 1, summary: "", user_facing_diff: [],
      clarifying_question: "Progress on what — pages per week, books toward a goal, or time spent?",
      assumptions: [], migration: null, panels: [], remove_panels: [], confidence: 0.3,
    }]);
    const result = await new MutationPipeline(store, planner).run("track my progress better");
    expect(result.status).toBe("clarify");
    expect(planner.repairs).toBe(0);
    store.close();
  });
});
