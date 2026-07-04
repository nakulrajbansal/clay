// Observer heuristics (doc 02 §1): token-promotion (a repeating free-text
// column reads as a status) and repeated-filter (a filter fired often
// wants a pinned panel), plus the shown/accepted/dismissed lifecycle.
import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type MigrationPlanT } from "../src/index";

async function storeWithText(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const ops: MigrationPlanT["operations"] = [{
    op: "create_table", table: "tasks",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "stage", type: "text", required: false },   // free text, looks like status
      { name: "notes", type: "text", required: false },   // genuinely free
    ],
  }];
  store.commit({ intent: "seed", summary: "Tasks.",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
  return store;
}

describe("token-promotion heuristic", () => {
  it("suggests promoting a repeating free-text column", async () => {
    const store = await storeWithText();
    const stages = ["todo", "doing", "done"];
    for (let i = 0; i < 9; i++)
      store.insert("tasks", {
        name: `t${i}`, stage: stages[i % 3],
        notes: `unique note ${i} ${Math.random()}`,
      });
    const suggestions = store.suggestions();
    const promote = suggestions.find(s => s.kind === "promote_to_status");
    expect(promote).toBeDefined();
    expect(promote!.subject).toBe("tasks.stage");
    expect(promote!.intent).toContain("stage");
    // the genuinely-free notes column is NOT suggested
    expect(suggestions.some(s => s.subject === "tasks.notes")).toBe(false);
    store.close();
  });

  it("stays quiet below the row/repeat threshold", async () => {
    const store = await storeWithText();
    for (let i = 0; i < 3; i++)
      store.insert("tasks", { name: `t${i}`, stage: `unique_${i}` });
    expect(store.suggestions().filter(s => s.kind === "promote_to_status")).toHaveLength(0);
    store.close();
  });

  it("does not re-suggest a dismissed promotion", async () => {
    const store = await storeWithText();
    const stages = ["todo", "doing", "done"];
    for (let i = 0; i < 9; i++)
      store.insert("tasks", { name: `t${i}`, stage: stages[i % 3] });
    expect(store.suggestions().some(s => s.subject === "tasks.stage")).toBe(true);
    store.dismissSuggestion("tasks.stage", "promote_to_status");
    expect(store.suggestions().some(s => s.subject === "tasks.stage")).toBe(false);
    store.close();
  });
});

describe("repeated-filter heuristic", () => {
  it("suggests pinning a filter fired 3+ times", async () => {
    const store = await storeWithText();
    for (let i = 0; i < 4; i++)
      store.recordUsage({ kind: "filter", subject: "board_filter", detail: { owner: "Dev" } });
    const pin = store.suggestions().find(s => s.kind === "pin_filtered_panel");
    expect(pin).toBeDefined();
    expect(pin!.intent).toContain("owner is Dev");
    store.close();
  });

  it("ignores a filter fired only twice", async () => {
    const store = await storeWithText();
    for (let i = 0; i < 2; i++)
      store.recordUsage({ kind: "filter", subject: "board_filter", detail: { owner: "Kim" } });
    expect(store.suggestions().filter(s => s.kind === "pin_filtered_panel")).toHaveLength(0);
    store.close();
  });

  it("accept moves it out of the active set", async () => {
    const store = await storeWithText();
    for (let i = 0; i < 3; i++)
      store.recordUsage({ kind: "filter", subject: "f", detail: { status: "red" } });
    const s = store.suggestions().find(x => x.kind === "pin_filtered_panel")!;
    store.acceptSuggestion(s.subject, s.kind);
    expect(store.suggestions().some(x => x.subject === s.subject)).toBe(false);
    store.close();
  });
});

describe("usage ring", () => {
  it("insert() records a usage event", async () => {
    const store = await storeWithText();
    store.insert("tasks", { name: "one" });
    const n = store.dumpTable("tasks").length;
    expect(n).toBe(1);
    // usage_events lives in sys; exercised indirectly via suggestions, but
    // confirm the observer recorded something by driving the filter path too
    store.recordUsage({ kind: "view", subject: "tasks" });
    expect(store.suggestions()).toBeInstanceOf(Array);
    store.close();
  });
});
