// G9 seed integrity: the typed copy in seed.ts must match the binding spec
// (specs/shells/starter-shells.json), every seed panel must pass the
// Validator against its seeded registry, and sample removal must be a
// reversible soft-delete.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ClayStore, expandBlueprint, openMemoryDriver, parseBlueprintDirective, validateMutationPlan,
} from "@clay/kernel";
import { ProductionStoreAuthority } from "@clay/kernel/worker-authority";
import {
  SEED_PANELS, STARTER_SHELLS, removeSampleRows, seedStarterShell,
} from "../src/index";
import { createStarterSeedBundle } from "../src/shells/seed";

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
      for (const raw of SEED_PANELS[shell.id]!) {
        // blueprint-directive seeds (ADR-030) are validated in their
        // EXPANDED form - exactly what seedStarterShell commits
        const spec = parseBlueprintDirective(raw.code);
        const panel = spec === null ? raw : (() => {
          const ex = expandBlueprint(spec, store.registrySnapshot());
          return { ...raw, code: ex.code,
            declared_queries: ex.declared_queries as typeof raw.declared_queries,
            declared_writes: ex.declared_writes };
        })();
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
  it("builds a detached plain production bundle from one trusted starter", () => {
    const bundle = createStarterSeedBundle("okrs");
    const shell = STARTER_SHELLS.find(candidate => candidate.id === "okrs")!;
    expect(bundle).toMatchObject({
      schema: 1,
      shellId: "okrs",
      shellName: shell.name,
    });
    expect(bundle.tables.map(table => table.name)).toEqual(shell.tables.map(table => table.name));
    expect(bundle.panels.map(panel => panel.panel_id))
      .toEqual(SEED_PANELS.okrs!.map(panel => panel.panel_id));
    expect(bundle.tables).not.toBe(shell.tables);
    expect(bundle.panels).not.toBe(SEED_PANELS.okrs);
    expect(Object.getPrototypeOf(bundle)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(bundle.tables)).toBe(Array.prototype);
    expect(Object.getPrototypeOf(bundle.tables[0]!)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(bundle.panels[0]!)).toBe(Object.prototype);

    bundle.tables[0]!.sampleRows[0]!.title = "detached copy";
    expect(shell.tables[0]!.sampleRows[0]!.title).not.toBe("detached copy");
    expect(() => createStarterSeedBundle("unknown"))
      .toThrow("unknown starter shell 'unknown'");
  });

  it("encodes relative sample dates deterministically and materializes them only when seeding", async () => {
    const bundle = createStarterSeedBundle("tracker");
    expect(bundle.tables[0]!.sampleRows.map(row => row.due)).toEqual([
      "@clay/starter-day:+3",
      "@clay/starter-day:+12",
      "@clay/starter-day:-5",
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-15T12:00:00.000Z"));
    const store = await ClayStore.openMemory();
    try {
      seedStarterShell(store, "tracker");
      expect(store.query({ from: "items" }).map(row => row.due)).toEqual([
        "2030-01-18",
        "2030-01-27",
        "2030-01-10",
      ]);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("runs the trusted blueprint bundle through production authority", async () => {
    const driver = await openMemoryDriver();
    driver.exec("ATTACH DATABASE ':memory:' AS catalog");
    const id = (prefix: string): string => `${prefix}_${"q".repeat(26)}`;
    const authority = ProductionStoreAuthority.initializeFresh(driver, {
      inventory: { state: "complete", catalogPresent: false, namespaces: [] },
      storageKey: id("ns"),
      displayName: "OKRs",
      shellId: "blank",
      appInstanceId: id("app"),
      generationId: id("gen"),
      namespaceId: id("ns"),
      adoptionOperationId: id("op"),
      releaseId: id("rel"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    });
    try {
      const committed = await authority.executeMutation({
        requestId: id("req"),
        route: "starter.seed",
        payload: createStarterSeedBundle("okrs"),
      });
      expect(committed).toMatchObject({
        changed: true,
        replayed: false,
        result: null,
        evidence: { protectionRevision: "1" },
      });
      expect(authority.readStore().headVersion()).toBe(2);
      expect(authority.query({ from: "objectives" })).toHaveLength(4);
      expect(authority.query({ from: "key_results" })).toHaveLength(6);
      expect(authority.readStore().livePanels()).toHaveLength(SEED_PANELS.okrs!.length);
      expect(authority.readStore().livePanels().every(panel =>
        !panel.code.includes("//#blueprint"))).toBe(true);
      expect(authority.readSetting("shell_id")).toBe("okrs");
      expect(authority.inspectAuthority().catalog.entries[0]!.shellId).toBe("okrs");
      expect(authority.inspectAuthority().targetReservations).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

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
