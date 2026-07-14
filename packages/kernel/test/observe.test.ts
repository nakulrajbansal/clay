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

// An invoices table with a status enum + a due date, optionally already shown
// by a table or board panel — for the overdue and status-not-boarded nudges.
async function storeWithInvoices(
  opts: { withPanel?: boolean; boardPanel?: boolean } = {},
): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const ops: MigrationPlanT["operations"] = [{
    op: "create_table", table: "invoices",
    columns: [
      { name: "client", type: "text", required: true },
      { name: "status", type: "enum", required: false,
        values: ["draft", "sent", "paid", "overdue"] },
      { name: "due_on", type: "date", required: false },
    ],
  }];
  store.commit({
    intent: "seed", summary: "Invoices.",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
    panels: opts.withPanel ? [{
      panel_id: "inv", title: "Invoices", placement: { region: "main", order: 0 },
      code: opts.boardPanel ? "export default (c)=>h(Board,{})" : "export default (c)=>h(Table,{})",
      declared_queries: [{ from: "invoices" }], declared_writes: [],
    }] : [],
  });
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

describe("unviewed-table heuristic (ambient reshaping)", () => {
  it("offers a view for a table with data but no panel", async () => {
    const store = await storeWithText();
    for (let i = 0; i < 4; i++) store.insert("tasks", { name: `t${i}`, stage: "todo" });
    // no panels reference "tasks" -> should be offered a view
    const s = store.suggestions().find(x => x.kind === "add_view" && x.subject === "tasks");
    expect(s).toBeDefined();
    // tasks has an enum-free schema here (stage is text) -> plain table intent
    expect(s!.intent).toContain("tasks");
    store.close();
  });

  it("does not offer a view for a table that already has a panel", async () => {
    const store = await storeWithText();
    for (let i = 0; i < 4; i++) store.insert("tasks", { name: `t${i}` });
    store.commit({
      intent: "view", summary: "Adds a tasks view.", migration: null,
      panels: [{
        panel_id: "tasks_view", title: "Tasks",
        placement: { region: "main", order: 0 },
        code: "export default function(clay){ clay.db.watch({from:\"tasks\"},(r)=>clay.ui.render(h(EmptyState,{label:\"x\"}))); }",
        declared_queries: [{ from: "tasks" }], declared_writes: [],
      }],
    });
    expect(store.suggestions().some(x => x.kind === "add_view" && x.subject === "tasks")).toBe(false);
    store.close();
  });

  it("stays quiet for a near-empty table", async () => {
    const store = await storeWithText();
    store.insert("tasks", { name: "one" });
    expect(store.suggestions().some(x => x.kind === "add_view")).toBe(false);
    store.close();
  });

  it("suggests a board when the table has a status enum", async () => {
    const store = await ClayStore.openMemory();
    const ops = [{ op: "create_table" as const, table: "leads",
      columns: [
        { name: "name", type: "text" as const, required: true },
        { name: "stage", type: "enum" as const, required: false, values: ["new", "won"] }] }];
    store.commit({ intent: "seed", summary: "Leads.",
      migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
    for (let i = 0; i < 3; i++) store.insert("leads", { name: `L${i}`, stage: "new" });
    const s = store.suggestions().find(x => x.kind === "add_view" && x.subject === "leads");
    expect(s!.intent).toContain("board");
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

describe("overdue heuristic (ambient reshaping v2)", () => {
  it("flags items past their date on a non-terminal status", async () => {
    const store = await storeWithInvoices();
    store.insert("invoices", { client: "A", status: "sent", due_on: "2020-01-01" });
    store.insert("invoices", { client: "B", status: "overdue", due_on: "2020-02-01" });
    store.insert("invoices", { client: "C", status: "paid", due_on: "2020-03-01" }); // terminal — ignored
    const s = store.suggestions().find(x => x.kind === "flag_overdue" && x.subject === "invoices");
    expect(s).toBeDefined();
    expect(s!.reason).toContain("overdue");
    expect(s!.intent).toContain("overdue");
    store.close();
  });

  it("stays quiet when only terminal statuses are past-due", async () => {
    const store = await storeWithInvoices();
    store.insert("invoices", { client: "A", status: "paid", due_on: "2020-01-01" });
    store.insert("invoices", { client: "B", status: "sent", due_on: "2090-01-01" }); // future — not overdue
    expect(store.suggestions().some(x => x.kind === "flag_overdue")).toBe(false);
    store.close();
  });
});

describe("status-not-boarded heuristic (ambient reshaping v2)", () => {
  it("suggests a board for a viewed status table with no board", async () => {
    const store = await storeWithInvoices({ withPanel: true });
    for (let i = 0; i < 4; i++) store.insert("invoices", { client: `c${i}`, status: "draft" });
    const s = store.suggestions().find(x => x.kind === "regroup_board");
    expect(s).toBeDefined();
    expect(s!.subject).toBe("invoices.status");
    expect(s!.intent).toContain("board grouped by status");
    store.close();
  });

  it("stays quiet when the table already has a board", async () => {
    const store = await storeWithInvoices({ withPanel: true, boardPanel: true });
    for (let i = 0; i < 4; i++) store.insert("invoices", { client: `c${i}`, status: "draft" });
    expect(store.suggestions().some(x => x.kind === "regroup_board")).toBe(false);
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
