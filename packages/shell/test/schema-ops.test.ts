// ADR-027: local schema edits + row history — trusted-shell surfaces that
// reuse the existing migration vocabulary and G6 snapshots.
import { describe, expect, it } from "vitest";
import { ClayStore } from "@clay/kernel";
import { seedStarterShell } from "../src/index";
import { addColumnCommit, renameColumnCommit, toIdent } from "../src/worker/schema-ops";

describe("local schema edits (ADR-027)", () => {
  it("addColumn commits through the migration vocabulary, reversibly", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "tracker");
    const v = addColumnCommit(store, "items", { name: "Effort (points)", type: "number" });
    const cols = store.registrySnapshot().get("items")!.columns.map(c => c.name);
    expect(cols).toContain("effort_points");            // label normalized to ident
    store.rollbackTo(v - 1, { truncate: true });        // rewind hides it again
    const after = store.registrySnapshot().get("items")!.columns
      .filter(c => !c.hidden).map(c => c.name);
    expect(after).not.toContain("effort_points");
    store.close();
  });

  it("renameColumn keeps data and rewrites panel queries (G16)", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "tracker");
    renameColumnCommit(store, "items", "owner", "assignee");
    const row = store.query({ from: "items" })[0]!;
    expect(row).toHaveProperty("assignee");
    // the seeded table panel referenced owner; its declared query follows
    const panel = store.livePanels().find(p => p.panel_id === "items_table")!;
    expect(JSON.stringify(panel.declared_queries)).not.toContain("\"owner\"");
    store.close();
  });

  it("toIdent normalizes labels and rejects garbage", () => {
    expect(toIdent("Due date!")).toBe("due_date");
    expect(() => addColumnCommit(null as never, "t", { name: "!!!", type: "text" }))
      .toThrow(/not a usable/);
  });
});

describe("rowHistory (ADR-027)", () => {
  it("returns snapshots newest-first, projected onto live columns", async () => {
    const store = await ClayStore.openMemory();
    seedStarterShell(store, "tracker");
    const id = String(store.query({ from: "items" })[0]!.id);
    store.update("items", id, { status: "doing" });
    store.update("items", id, { status: "done" });
    const hist = store.rowHistory("items", id);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist[0]!.values.status).toBe("doing");   // newest snapshot = pre-"done"
    expect(Object.keys(hist[0]!.values)).not.toContain("nonexistent");
    store.close();
  });
});
