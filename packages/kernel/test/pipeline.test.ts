// MutationPipeline S0–S6 (doc 05 §1) with a scripted planner, including the
// WEEK 2 EXIT TEST: "add a priority field to tasks and show it as a colored
// badge" commits end-to-end on all three starter shells (doc 09).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ClayError, ClayStore, MutationPipeline, deriveInverse,
  type MigrationPlanT, type Planner, type PlannerResult, type Query,
} from "../src/index";

// ---------- starter shells (G9) ----------
type ShellColumn = { name: string; type: string; required?: boolean; values?: string[] };
type Shell = {
  shell_id: string;
  registry: { table: string; columns: ShellColumn[] }[];
  seed_panels: string[];
};
const { shells } = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../specs/shells/starter-shells.json", import.meta.url)),
  "utf8")) as { shells: Shell[] };

function tablePanelCode(table: string, columns: string[]): string {
  const cols = columns.map(c => `{ field: ${JSON.stringify(c)}, label: ${JSON.stringify(c)} }`);
  return `export default function (clay) {
  clay.db.watch({ from: ${JSON.stringify(table)} }, (rows) => {
    clay.ui.render(h(Table, { sortable: true, rows, columns: [${cols.join(", ")}] }));
  });
}`;
}

function sampleValue(col: ShellColumn, i: number): unknown {
  switch (col.type) {
    case "text": return `Sample ${col.name} ${i}`;
    case "enum": return col.values![i % col.values!.length];
    case "date": return `2026-07-0${(i % 8) + 1}`;
    case "number": return i * 10;
    case "integer": return i;
    default: return null;
  }
}

async function seedShellStore(shell: Shell): Promise<{ store: ClayStore; table: string; panelId: string }> {
  const store = await ClayStore.openMemory();
  const spec = shell.registry[0]!;
  const operations: MigrationPlanT["operations"] = [{
    op: "create_table", table: spec.table,
    columns: spec.columns.map(c => ({
      name: c.name, type: c.type as "text", required: c.required ?? false,
      ...(c.values ? { values: c.values } : {}),
    })),
  }];
  const panelId = shell.seed_panels[0]!.split(":")[0]!;
  store.commit({
    intent: "first run", summary: `Creates the ${shell.shell_id} shell.`,
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    panels: [{
      panel_id: panelId, title: spec.table,
      placement: { region: "main", order: 0 },
      code: tablePanelCode(spec.table, spec.columns.map(c => c.name)),
      declared_queries: [{ from: spec.table }],
      declared_writes: [],
    }],
  });
  for (let i = 0; i < 3; i++) {
    const row: Record<string, unknown> = {};
    for (const c of spec.columns) row[c.name] = sampleValue(c, i);
    store.insert(spec.table, row);
  }
  return { store, table: spec.table, panelId };
}

// ---------- the exemplar-2-shaped plan, adapted per shell ----------
function priorityPlan(table: string, panelId: string, columns: string[]): Record<string, unknown> {
  return {
    api: 1,
    summary: `Adds a priority (low/medium/high) to ${table}; high shows as a red badge.`,
    user_facing_diff: [
      { kind: "add_status", detail: `Priority: low / medium / high on ${table}` },
      { kind: "change_panel", detail: "Table gains a Priority badge column" },
    ],
    clarifying_question: null,
    assumptions: [`New ${table} default to medium`],
    migration: {
      operations: [
        { op: "add_column", table, column: {
          name: "priority", type: "enum", required: false,
          values: ["low", "medium", "high"] } },
        { op: "backfill", table, column: "priority", value: "medium" },
      ],
      inverse: [{ op: "drop_column_if_added_by_this", table, column: "priority" }],
    },
    panels: [{
      panel_id: panelId, title: table,
      placement: { region: "main", order: 0 },
      declared_queries: [{ from: table }],
      declared_writes: [],
      code: `export default function (clay) {
  clay.db.watch({ from: ${JSON.stringify(table)} }, (rows) => {
    clay.ui.render(h(Table, { sortable: true, rows, columns: [
      ${columns.map(c => `{ field: ${JSON.stringify(c)}, label: ${JSON.stringify(c)} }`).join(",\n      ")},
      { field: "priority", label: "Priority",
        badge: { field: "priority", map: { high: "red", medium: "amber", low: "gray" } } }] }));
  });
}`,
    }],
    remove_panels: [],
    confidence: 0.93,
  };
}

class ScriptedPlanner implements Planner {
  planCalls = 0;
  repairCalls: string[][] = [];
  constructor(private readonly plans: Record<string, unknown>[]) {}
  private next(): PlannerResult {
    const plan = this.plans.shift();
    if (!plan) return { ok: false, error: { code: "E_MODEL", message: "script exhausted" } };
    return { ok: true, plan, raw: JSON.stringify(plan) };
  }
  async requestPlan(): Promise<PlannerResult> {
    this.planCalls++;
    return this.next();
  }
  async requestRepair(_ctx: unknown, _prior: string, failures: string[]): Promise<PlannerResult> {
    this.repairCalls.push(failures);
    return this.next();
  }
}

const INTENT = "add a priority field to tasks and show it as a colored badge";

describe("W2 EXIT: the priority sentence commits on all three shells", () => {
  for (const shell of shells) {
    it(shell.shell_id, async () => {
      const { store, table, panelId } = await seedShellStore(shell);
      const columns = shell.registry[0]!.columns.map(c => c.name);
      const planner = new ScriptedPlanner([priorityPlan(table, panelId, columns)]);
      const pipeline = new MutationPipeline(store, planner);

      const result = await pipeline.run(INTENT);
      if (result.status !== "preview") throw new Error(JSON.stringify(result));

      // S5: preview before commit — the shadow has priority, the live db does not
      const shadowRows = result.preview.shadow.query({ from: table });
      expect(shadowRows.map(r => r.priority)).toEqual(["medium", "medium", "medium"]);
      expect(() => store.query({ from: table, select: ["priority"] }))
        .toThrowError(ClayError);

      // S6 keep: atomic commit + panel swap on the live store
      const version = result.preview.keep();
      expect(version).toBe(2);
      expect(store.query({ from: table }).map(r => r.priority))
        .toEqual(["medium", "medium", "medium"]);
      const live = store.livePanels();
      expect(live).toHaveLength(1);
      expect(live[0]!.version).toBe(2);
      expect(live[0]!.code).toContain(`badge: { field: "priority"`);
      expect(planner.repairCalls).toHaveLength(0);
      store.close();
    });
  }
});

describe("pipeline stages", () => {
  const tracker = (): Shell => shells.find(s => s.shell_id === "tracker")!;

  it("discard leaves the live store untouched (preview-before-commit)", async () => {
    const { store, table, panelId } = await seedShellStore(tracker());
    const planner = new ScriptedPlanner([
      priorityPlan(table, panelId, tracker().registry[0]!.columns.map(c => c.name))]);
    const result = await new MutationPipeline(store, planner).run(INTENT);
    if (result.status !== "preview") throw new Error("expected preview");
    result.preview.discard();
    expect(store.headVersion()).toBe(1);
    expect(() => store.query({ from: table, select: ["priority"] })).toThrowError(ClayError);
    // and the store still accepts future commits
    store.commit({ intent: "noop", summary: "Adds nothing.", migration: null,
      panels: [], removePanels: [] });
    store.close();
  });

  it("S3 failure triggers ONE repair with machine-readable reasons", async () => {
    const { store, table, panelId } = await seedShellStore(tracker());
    const cols = tracker().registry[0]!.columns.map(c => c.name);
    const good = priorityPlan(table, panelId, cols);
    const bad = JSON.parse(JSON.stringify(good)) as { panels: { code: string }[] };
    bad.panels[0]!.code = `export default function (clay) {
  clay.db.query({ from: "items", select: ["owner"] });
}`;   // undeclared query shape -> V4
    const planner = new ScriptedPlanner([bad as Record<string, unknown>, good]);
    const result = await new MutationPipeline(store, planner).run(INTENT);
    expect(result.status).toBe("preview");
    if (result.status === "preview") {
      expect(result.repaired).toBe(true);
      result.preview.discard();
    }
    expect(planner.repairCalls).toHaveLength(1);
    expect(planner.repairCalls[0]!.join(" ")).toContain("V4");
    store.close();
  });

  it("a second failure is a visible failure, not another round", async () => {
    const { store, table, panelId } = await seedShellStore(tracker());
    const cols = tracker().registry[0]!.columns.map(c => c.name);
    const bad = priorityPlan(table, panelId, cols);
    (bad.user_facing_diff as unknown[]).length = 0;   // V7 on every attempt
    const planner = new ScriptedPlanner([bad, JSON.parse(JSON.stringify(bad)) as Record<string, unknown>]);
    const result = await new MutationPipeline(store, planner).run(INTENT);
    expect(result).toMatchObject({ status: "failed", stage: "validate" });
    if (result.status === "failed") expect(result.reasons.join(" ")).toContain("V7");
    expect(planner.repairCalls).toHaveLength(1);
    store.close();
  });

  it("clarifying questions stop the pipeline (R1)", async () => {
    const { store } = await seedShellStore(tracker());
    const planner = new ScriptedPlanner([{
      api: 1, summary: "", user_facing_diff: [],
      clarifying_question: "Priority on which table?", assumptions: [],
      migration: null, panels: [], remove_panels: [], confidence: 0.3,
    }]);
    const result = await new MutationPipeline(store, planner).run(INTENT);
    expect(result).toMatchObject({ status: "clarify", question: "Priority on which table?" });
    expect(store.headVersion()).toBe(1);
    store.close();
  });

  it("S4 smoke failure triggers the same single repair budget", async () => {
    const { store, table, panelId } = await seedShellStore(tracker());
    const cols = tracker().registry[0]!.columns.map(c => c.name);
    const plan = priorityPlan(table, panelId, cols);
    const planner = new ScriptedPlanner([plan, JSON.parse(JSON.stringify(plan)) as Record<string, unknown>]);
    let smokes = 0;
    const pipeline = new MutationPipeline(store, planner, {
      smokeTest: async () => {
        smokes++;
        if (smokes === 1) throw new ClayError("E_INTERNAL", "render timeout");
      },
    });
    const result = await pipeline.run(INTENT);
    expect(result.status).toBe("preview");
    if (result.status === "preview") {
      expect(result.repaired).toBe(true);
      result.preview.discard();
    }
    expect(planner.repairCalls[0]!.join(" ")).toContain("render timeout");

    // and when the smoke keeps failing, the attempt fails visibly
    const { store: store2 } = await seedShellStore(tracker());
    const planner2 = new ScriptedPlanner([plan, plan]);
    const pipeline2 = new MutationPipeline(store2, planner2, {
      smokeTest: async () => { throw new ClayError("E_INTERNAL", "still broken"); },
    });
    expect(await pipeline2.run(INTENT)).toMatchObject({ status: "failed", stage: "dry_run" });
    store.close();
    store2.close();
  });

  it("attemptStats aggregates outcomes for Settings (doc 05 §5)", async () => {
    const { store, table, panelId } = await seedShellStore(tracker());
    const cols = tracker().registry[0]!.columns.map(c => c.name);
    // a kept mutation
    const good = new ScriptedPlanner([priorityPlan(table, panelId, cols)]);
    const r1 = await new MutationPipeline(store, good).run(INTENT);
    if (r1.status === "preview") r1.preview.keep();
    // a discarded one
    const good2 = new ScriptedPlanner([{
      ...priorityPlan(table, panelId, cols),
      migration: null,
      panels: [{ panel_id: "extra", title: "Extra",
        placement: { region: "side", order: 0 },
        declared_queries: [{ from: table }], declared_writes: [],
        code: "export default function(clay){ clay.ui.render(h(EmptyState,{label:\"x\"})); }" }],
      user_facing_diff: [{ kind: "add_panel", detail: "extra" }],
    }]);
    const r2 = await new MutationPipeline(store, good2).run("add an extra panel");
    if (r2.status === "preview") r2.preview.discard();
    // a clarify
    const clar = new ScriptedPlanner([{
      api: 1, summary: "", user_facing_diff: [], clarifying_question: "Which?",
      assumptions: [], migration: null, panels: [], remove_panels: [], confidence: 0.3,
    }]);
    await new MutationPipeline(store, clar).run("do something");

    const stats = store.attemptStats();
    expect(stats.kept).toBe(1);
    expect(stats.discarded).toBe(1);
    expect(stats.clarify).toBe(1);
    store.close();
  });

  it("S1 context carries shapes + intent, never rows (ADR-009)", async () => {
    const { store } = await seedShellStore(tracker());
    const ctx = new MutationPipeline(store, new ScriptedPlanner([])).buildContext(INTENT);
    expect(ctx.registry).toHaveLength(1);
    expect(ctx.panels).toHaveLength(1);
    expect(ctx.recentSummaries[0]).toContain("Creates the tracker shell.");
    expect(JSON.stringify(ctx)).not.toContain("Sample name");   // no row data
    store.close();
  });
});

describe("store: panels, tombstones, and the G16 rename rewrite", () => {
  it("remove_panels tombstones; a later blob revives the id", async () => {
    const { store, panelId, table } = await seedShellStore(shells[0]!);
    store.commit({ intent: "remove", summary: "Removes the table panel.",
      migration: null, panels: [], removePanels: [panelId] });
    expect(store.livePanels()).toHaveLength(0);
    store.commit({ intent: "re-add", summary: "Brings the table back.",
      migration: null,
      panels: [{ panel_id: panelId, title: table,
        placement: { region: "main", order: 0 },
        code: "export default function(clay){}",
        declared_queries: [{ from: table }], declared_writes: [] }] });
    expect(store.livePanels().map(p => p.panel_id)).toEqual([panelId]);
    store.close();
  });

  it("renames rewrite untouched panels' declared queries (G16)", async () => {
    const store = await ClayStore.openMemory();
    const operations: MigrationPlanT["operations"] = [{
      op: "create_table", table: "items",
      columns: [{ name: "name", type: "text", required: true }],
    }];
    const sorted: Query = { from: "items", orderBy: [{ field: "name", dir: "asc" }] };
    store.commit({
      intent: "seed", summary: "Creates items.",
      migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      panels: [{ panel_id: "sorted_list", title: "Sorted",
        placement: { region: "main", order: 0 },
        code: "export default function(clay){}",
        declared_queries: [sorted], declared_writes: [] }],
    });
    const rename: MigrationPlanT = {
      operations: [{ op: "rename_column", table: "items", from: "name", to: "label" }],
      inverse: [{ op: "rename_column", table: "items", from: "label", to: "name" }],
    };
    store.commit({ intent: "rename", summary: "Name is now Label.",
      migration: rename, panels: [], removePanels: [] });
    const live = store.livePanels()[0]!;
    expect(live.version).toBe(2);   // rewritten blob at the rename commit
    expect(live.declared_queries[0]).toEqual(
      { from: "items", orderBy: [{ field: "label", dir: "asc" }] });
    store.close();
  });

  it("shadow copies are fully isolated from the live store", async () => {
    const { store, table } = await seedShellStore(shells[0]!);
    const shadow = await store.shadowCopy();
    shadow.insert(table, { name: "shadow only" });
    store.insert(table, { name: "live only" });
    const names = (s: ClayStore): unknown[] =>
      s.query({ from: table, select: ["name"] }).map(r => r.name);
    expect(names(shadow)).toContain("shadow only");
    expect(names(shadow)).not.toContain("live only");
    expect(names(store)).toContain("live only");
    expect(names(store)).not.toContain("shadow only");
    shadow.close();
    store.close();
  });
});
