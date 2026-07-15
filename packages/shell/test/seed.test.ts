// G9 seed integrity: the typed copy in seed.ts must match the binding spec
// (specs/shells/starter-shells.json), every seed panel must pass the
// Validator against its seeded registry, and sample removal must be a
// reversible soft-delete.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClayStore, validateMutationPlan } from "@clay/kernel";
import {
  SEED_PANELS, STARTER_SHELLS, removeSampleRows, seedStarterShell,
} from "../src/index";

type SpecShell = {
  shell_id: string; name: string; tagline: string;
  registry: { table: string; columns: {
    name: string; type: string; required?: boolean; values?: string[] }[] }[];
  seed_panels: string[];
  sample_rows: Record<string, number>;
};
const spec = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../specs/shells/starter-shells.json", import.meta.url)),
  "utf8")) as { shells: SpecShell[] };

describe("seed definitions match specs/shells/starter-shells.json", () => {
  for (const specShell of spec.shells) {
    it(specShell.shell_id, () => {
      const shell = STARTER_SHELLS.find(s => s.id === specShell.shell_id)!;
      expect(shell.name).toBe(specShell.name);
      expect(shell.tagline).toBe(specShell.tagline);
      // every table (multi-table templates) matches the binding registry
      expect(shell.tables.map(t => t.name)).toEqual(specShell.registry.map(r => r.table));
      for (const specTable of specShell.registry) {
        const table = shell.tables.find(t => t.name === specTable.table)!;
        expect(table.columns).toEqual(specTable.columns.map(c => ({
          name: c.name, type: c.type, required: c.required ?? false,
          ...(c.values ? { values: c.values } : {}),
        })));
        expect(table.sampleRows).toHaveLength(specTable.table in specShell.sample_rows
          ? specShell.sample_rows[specTable.table]! : 0);
      }
      // seed panel ids + placements are binding: "id:region:order"
      const panels = SEED_PANELS[shell.id]!;
      expect(panels.map(p => `${p.panel_id}:${p.placement.region}:${p.placement.order}`))
        .toEqual(specShell.seed_panels);
    });
  }
});

describe("every seed panel passes the Validator (G9: validator-passing)", () => {
  for (const shell of STARTER_SHELLS) {
    it(shell.id, async () => {
      const store = await ClayStore.openMemory();
      seedStarterShell(store, shell.id);
      for (const panel of SEED_PANELS[shell.id]!) {
        const issues = validateMutationPlan({
          api: 1, summary: "Seed panel.",
          user_facing_diff: [{ kind: "add_panel", detail: panel.panel_id }],
          clarifying_question: null, assumptions: [], migration: null,
          panels: [panel], remove_panels: [], confidence: 0.9,
        }, { registry: store.registrySnapshot(), livePanelIds: [] });
        expect(issues, `${panel.panel_id}: ${JSON.stringify(issues)}`).toEqual([]);
      }
      store.close();
    });
  }
});

describe("seeding and samples", () => {
  it("seeds a single-table shell in table + panel commits", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "tracker");
    expect(store.livePanels().map(p => p.panel_id).sort())
      .toEqual(["add_item_form", "items_flow", "items_table", "status_counts"]);
    expect(store.query({ from: "items" })).toHaveLength(3);
    store.close();
  });

  it("seeds the multi-table Small Business template — one dataset, many views", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "small_business");
    // all five tables exist and carry sample rows
    for (const [table, n] of [["customers", 3], ["jobs", 5], ["invoices", 3],
      ["items", 3], ["expenses", 2]] as const)
      expect(store.query({ from: table }), table).toHaveLength(n);
    // 5 tables in commits of <=3 => 2 table commits + 1 panel commit
    expect(store.headVersion()).toBe(3);
    // the SAME jobs table is shown by multiple panels (board + table + upcoming)
    const jobsPanels = store.livePanels().filter(
      p => p.declared_queries.some(q => q.from === "jobs"));
    expect(jobsPanels.map(p => p.panel_id).sort())
      .toEqual(["sb_dashboard", "sb_jobs_board", "sb_jobs_table", "sb_upcoming"]);
    store.close();
  });

  it("remove-samples is a reversible soft delete (G9)", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "log");
    store.insert("entries", { title: "mine", on: "2026-07-02" });
    removeSampleRows(store);
    const remaining = store.query({ from: "entries" });
    expect(remaining.map(r => r.title)).toEqual(["mine"]);
    // data kept, not dropped (Principle 1)
    expect(store.query({ from: "entries", includeDeleted: true })).toHaveLength(4);
    store.close();
  });
});
