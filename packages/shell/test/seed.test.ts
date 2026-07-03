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
      const table = specShell.registry[0]!;
      expect(shell.table).toBe(table.table);
      expect(shell.columns).toEqual(table.columns.map(c => ({
        name: c.name, type: c.type, required: c.required ?? false,
        ...(c.values ? { values: c.values } : {}),
      })));
      // seed panel ids + placements are binding: "id:region:order"
      const panels = SEED_PANELS[shell.id]!;
      expect(panels.map(p => `${p.panel_id}:${p.placement.region}:${p.placement.order}`))
        .toEqual(specShell.seed_panels);
      expect(shell.sampleRows).toHaveLength(specShell.sample_rows[table.table]!);
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
  it("seeds tables, panels, and sample rows in one first-run commit", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "tracker");
    expect(store.headVersion()).toBe(1);
    expect(store.livePanels().map(p => p.panel_id).sort())
      .toEqual(["add_item_form", "items_table", "status_counts"]);
    expect(store.query({ from: "items" })).toHaveLength(3);
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
