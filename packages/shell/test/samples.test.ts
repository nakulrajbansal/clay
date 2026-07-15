// The dummy-data contract: fill inserts plausible typed rows tracked in the
// sample_rows marker; clear removes EXACTLY the tracked rows (soft-delete),
// never rows the user added themselves — that asymmetry is the whole point.
import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type MigrationPlanT } from "@clay/kernel";
import { removeSampleRows } from "../src/shells/seed";
import { fillSampleRows, sampleRowCount } from "../src/worker/samples";

async function storeWithProjects(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const operations: MigrationPlanT["operations"] = [{
    op: "create_table", table: "projects",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "enum", required: false, values: ["on_track", "at_risk", "off_track"] },
      { name: "budget", type: "number", required: false },
      { name: "due_date", type: "date", required: false },
    ],
  }];
  store.commit({
    intent: "build", summary: "Creates projects.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    panels: [],
  });
  return store;
}

describe("sample data fill/clear", () => {
  it("fills typed rows and tracks them in the marker", async () => {
    const store = await storeWithProjects();
    const res = fillSampleRows(store);
    expect(res.added).toBeGreaterThanOrEqual(8);
    expect(sampleRowCount(store)).toBe(res.added);
    const rows = store.query({ from: "projects" });
    expect(rows.length).toBe(res.added);
    for (const r of rows) {
      expect(typeof r.name).toBe("string");
      expect(["on_track", "at_risk", "off_track"]).toContain(r.status);
      expect(typeof r.budget).toBe("number");
      expect(String(r.due_date)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
    store.close();
  });

  it("clear removes only generated rows — user rows survive, samples restorable", async () => {
    const store = await storeWithProjects();
    // the user's own row, inserted BEFORE and AFTER the samples
    const mine1 = store.insert("projects", { name: "My real project" });
    fillSampleRows(store);
    const mine2 = store.insert("projects", { name: "Another real one" });

    removeSampleRows(store);
    const left = store.query({ from: "projects" });
    expect(left.map(r => r.id).sort()).toEqual([mine1.id, mine2.id].sort());
    expect(sampleRowCount(store)).toBe(0);

    // soft-deleted, not gone: the cleared rows are still there for restore
    const deleted = store.query({
      from: "projects", includeDeleted: true,
      where: [{ field: "deleted_at", op: "not_null" }],
    });
    expect(deleted.length).toBeGreaterThanOrEqual(8);
    store.close();
  });

  it("filling twice accumulates and both fills clear together", async () => {
    const store = await storeWithProjects();
    const a = fillSampleRows(store);
    const b = fillSampleRows(store);
    expect(sampleRowCount(store)).toBe(a.added + b.added);
    removeSampleRows(store);
    expect(store.query({ from: "projects" })).toHaveLength(0);
    store.close();
  });
});
