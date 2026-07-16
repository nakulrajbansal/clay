// ADR-029: blueprint expansion. Every kind must expand into code that the
// REAL Validator accepts against the same registry — that is the whole
// contract (the model writes one line; the kernel writes the module).
import { describe, expect, it } from "vitest";
import {
  BLUEPRINT_KINDS, ClayStore, MutationPipeline, deriveInverse,
  expandBlueprint, parseBlueprintDirective, validateMutationPlan,
  type MigrationPlanT, type PlannerResult,
} from "../src/index";

async function richStore(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const ops: MigrationPlanT["operations"] = [
    { op: "create_table", table: "requests", columns: [
      { name: "title", type: "text", required: true },
      { name: "requester", type: "text", required: false },
      { name: "amount", type: "number", required: false },
      { name: "stage", type: "enum", required: false,
        values: ["submitted", "review", "paid"] },
      { name: "due", type: "date", required: false },
    ] },
    { op: "create_table", table: "request_log", columns: [
      { name: "request", type: "text", required: true },
      { name: "from_stage", type: "text", required: false },
      { name: "to_stage", type: "text", required: false },
    ] },
  ];
  store.commit({ intent: "seed", summary: "v1",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
    panels: [] });
  return store;
}

const SPECS: Record<string, object> = {
  table: { kind: "table", table: "requests", sort: { field: "due", dir: "asc" } },
  form: { kind: "form", table: "requests", defaults: { stage: "submitted" } },
  metrics: { kind: "metrics", table: "requests", metrics: [
    { label: "Open", agg: "count", field: "title" },
    { label: "Total", agg: "sum", field: "amount", format: "currency" }] },
  chart: { kind: "chart", table: "requests", chart: "bar", x: "stage", y: "amount", agg: "sum" },
  board: { kind: "board", table: "requests", groupBy: "stage",
    item: { title: "title", subtitle: "requester" } },
  flow: { kind: "flow", table: "requests", stage: "stage", activity: "request_log",
    item: { title: "title", subtitle: "requester", badge: "amount" } },
  cards: { kind: "cards", table: "requests", card: { title: "title", badge: "stage" } },
  timeline: { kind: "timeline", table: "requests", label: "title", at: "due" },
  calendar: { kind: "calendar", table: "requests", date: "due", label: "title" },
  feed: { kind: "feed", table: "request_log", title: "request", meta: ["to_stage"] },
  progress: { kind: "progress", table: "requests", label: "title", value: "amount", max: 5000 },
};

describe("blueprint expansion (ADR-029)", () => {
  it("every kind expands into Validator-clean code with derived declarations", async () => {
    const store = await richStore();
    for (const kind of BLUEPRINT_KINDS) {
      const spec = SPECS[kind];
      expect(spec, `spec fixture missing for '${kind}'`).toBeDefined();
      const ex = expandBlueprint(spec, store.registrySnapshot());
      const issues = validateMutationPlan({
        api: 1, summary: "Blueprint panel.",
        user_facing_diff: [{ kind: "add_panel", detail: kind }],
        clarifying_question: null, assumptions: [], migration: null,
        panels: [{ panel_id: `bp_${kind}_panel`, title: kind,
          placement: { region: "main", order: 0 },
          code: ex.code, declared_queries: ex.declared_queries,
          declared_writes: ex.declared_writes }],
        remove_panels: [], confidence: 0.9,
      }, { registry: store.registrySnapshot(), livePanelIds: [] });
      expect(issues, `${kind}: ${JSON.stringify(issues)}`).toEqual([]);
    }
    store.close();
  });

  it("expansion errors are specific and human-fixable", async () => {
    const store = await richStore();
    const reg = store.registrySnapshot();
    expect(() => expandBlueprint({ kind: "table", table: "ghost" }, reg))
      .toThrow(/unknown table 'ghost'/);
    expect(() => expandBlueprint({ kind: "flow", table: "requests", stage: "title" }, reg))
      .toThrow(/must be an enum/);
    expect(() => expandBlueprint({ kind: "nope" }, reg)).toThrow(/unknown kind/);
    store.close();
  });

  it("parseBlueprintDirective matches only whole-module directives", () => {
    expect(parseBlueprintDirective('//#blueprint {"kind":"table","table":"t"}'))
      .toEqual({ kind: "table", table: "t" });
    expect(parseBlueprintDirective("export default function(clay){}")).toBeNull();
  });
});

describe("pipeline blueprint integration (ADR-029)", () => {
  const directivePlan = (code: string) => ({
    api: 1, summary: "Adds a requests table view.",
    user_facing_diff: [{ kind: "add_panel", detail: "Requests table" }],
    clarifying_question: null, assumptions: [], migration: null,
    panels: [{ panel_id: "requests_view", title: "Requests",
      placement: { region: "main", order: 0 },
      code, declared_queries: [], declared_writes: [] }],
    remove_panels: [], confidence: 0.9,
  });

  it("a directive expands pre-validation and commits as ordinary code", async () => {
    const store = await richStore();
    const planner = {
      requestPlan: async (): Promise<PlannerResult> => ({ ok: true,
        plan: directivePlan('//#blueprint {"kind":"table","table":"requests"}'),
        raw: "raw" }),
      requestRepair: async (): Promise<PlannerResult> => { throw new Error("no repair expected"); },
    };
    const result = await new MutationPipeline(store, planner).run("show requests");
    expect(result.status).toBe("preview");
    if (result.status === "preview") {
      const panel = result.preview.plan.panels[0]!;
      expect(panel.code).toContain("clay.db.watch");
      expect(panel.code).not.toContain("#blueprint");
      expect(panel.declared_queries).toEqual([{ from: "requests" }]);
      result.preview.discard();
    }
    store.close();
  });

  it("a broken directive surfaces its message to the repair round", async () => {
    const store = await richStore();
    const repairs: string[][] = [];
    const planner = {
      requestPlan: async (): Promise<PlannerResult> => ({ ok: true,
        plan: directivePlan('//#blueprint {"kind":"table","table":"ghost"}'),
        raw: "raw" }),
      requestRepair: async (_c: unknown, _r: string, failures: string[]): Promise<PlannerResult> => {
        repairs.push(failures);
        return { ok: true,
          plan: directivePlan('//#blueprint {"kind":"table","table":"requests"}'),
          raw: "raw2" };
      },
    };
    const result = await new MutationPipeline(store, planner).run("show requests");
    expect(result.status).toBe("preview");
    expect(repairs[0]!.join(" ")).toContain("unknown table 'ghost'");
    if (result.status === "preview") result.preview.discard();
    store.close();
  });
});

describe("blueprint round-2 kinds (from the build-3 iteration)", () => {
  it("progress expands to per-row bars with column or constant max", async () => {
    const store = await richStore();
    const ex = expandBlueprint({ kind: "progress", table: "requests",
      label: "title", value: "amount", max: 5000 }, store.registrySnapshot());
    expect(ex.code).toContain("h(Bar");
    expect(ex.code).toContain("5000");
    const issues = validateMutationPlan({
      api: 1, summary: "P.", user_facing_diff: [{ kind: "add_panel", detail: "p" }],
      clarifying_question: null, assumptions: [], migration: null,
      panels: [{ panel_id: "progress_panel", title: "P",
        placement: { region: "main", order: 0 }, code: ex.code,
        declared_queries: ex.declared_queries, declared_writes: ex.declared_writes }],
      remove_panels: [], confidence: 0.9,
    }, { registry: store.registrySnapshot(), livePanelIds: [] });
    expect(issues).toEqual([]);
    expect(() => expandBlueprint({ kind: "progress", table: "requests",
      label: "title", value: "amount" }, store.registrySnapshot()))
      .toThrow(/needs max/);
    store.close();
  });

  it("table with search + filters expands to a FilterBar panel, Validator-clean", async () => {
    const store = await richStore();
    const ex = expandBlueprint({ kind: "table", table: "requests",
      search: "title", filters: ["stage"] }, store.registrySnapshot());
    expect(ex.code).toContain("FilterBar");
    expect(ex.code).toContain("onChange");
    const issues = validateMutationPlan({
      api: 1, summary: "T.", user_facing_diff: [{ kind: "add_panel", detail: "t" }],
      clarifying_question: null, assumptions: [], migration: null,
      panels: [{ panel_id: "filtered_table", title: "T",
        placement: { region: "main", order: 0 }, code: ex.code,
        declared_queries: ex.declared_queries, declared_writes: ex.declared_writes }],
      remove_panels: [], confidence: 0.9,
    }, { registry: store.registrySnapshot(), livePanelIds: [] });
    expect(issues).toEqual([]);
    store.close();
  });
});
