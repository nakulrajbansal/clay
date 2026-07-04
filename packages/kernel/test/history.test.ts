// History + scrub semantics (doc 02 §6, doc 04 §5): livePanels(at) resolves
// the manifest at K without running inverses; make-latest = rollback with
// truncation and the store accepts new work afterwards.
import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type MigrationPlanT } from "../src/index";
import { HEALTH_COMPUTED, seededStore } from "./helpers";

const PANEL_V1 = {
  panel_id: "project_table", title: "Projects",
  placement: { region: "main" as const, order: 0 },
  code: "export default function(clay){/* v1 */}",
  declared_queries: [{ from: "projects" }], declared_writes: [],
};
const PANEL_V2 = { ...PANEL_V1, code: "export default function(clay){/* v2 */}" };

async function storeWithTwoPanelVersions(): Promise<ClayStore> {
  const store = await seededStore();
  store.commit({ intent: "seed panel", summary: "Adds the table.",
    migration: null, panels: [PANEL_V1] });                       // v2
  store.commit({ intent: "replace panel", summary: "Restyles the table.",
    migration: HEALTH_COMPUTED, panels: [PANEL_V2] });            // v3
  return store;
}

describe("history and scrub", () => {
  it("history() lists the linear chain oldest-first", async () => {
    const store = await storeWithTwoPanelVersions();
    const h = store.history();
    expect(h.map(e => e.version)).toEqual([1, 2, 3]);
    expect(h.map(e => e.parent)).toEqual([0, 1, 2]);
    expect(h[2]!.summary).toBe("Restyles the table.");
    store.close();
  });

  it("livePanels(at) resolves the manifest at K without touching data", async () => {
    const store = await storeWithTwoPanelVersions();
    const dump = JSON.stringify(store.dumpTable("projects"));
    expect(store.livePanels(2)[0]!.code).toContain("v1");
    expect(store.livePanels(3)[0]!.code).toContain("v2");
    expect(store.livePanels(1)).toHaveLength(0);
    // scrubbing is render-only: nothing moved
    expect(store.currentVersion()).toBe(3);
    expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump);
    store.close();
  });

  it("make-latest truncates and the chain continues from K", async () => {
    const store = await storeWithTwoPanelVersions();
    store.rollbackTo(2, { truncate: true });
    expect(store.history().map(e => e.version)).toEqual([1, 2]);
    expect(store.livePanels()[0]!.code).toContain("v1");
    // the computed column from v3 is gone; data untouched (I3)
    expect(store.registrySnapshot().get("projects")!.columns
      .some(c => c.name === "health_score")).toBe(false);
    expect(store.dumpTable("projects")).toHaveLength(3);
    // and new commits continue the chain
    const ops: MigrationPlanT["operations"] = [{
      op: "add_column", table: "projects",
      column: { name: "notes", type: "text", required: false },
    }];
    const v = store.commit({ intent: "notes", summary: "Adds notes.",
      migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
    expect(v).toBe(3);
    store.close();
  });
});
