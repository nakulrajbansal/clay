import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver,
  type AutomationDefinitionInput, type ForwardOpT,
} from "../src/index";

function commit(store: ClayStore, operations: ForwardOpT[]): void {
  store.commit({ intent: "automation schema", summary: "Creates automation fixtures.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
}

async function automationStore(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  commit(store, [{ op: "create_table", table: "deals", columns: [
    { name: "name", type: "text", required: true },
    { name: "status", type: "enum", required: false, values: ["open", "won", "lost"] },
    { name: "onboarded", type: "boolean", required: false },
    { name: "due", type: "date", required: false },
  ] }]);
  commit(store, [{ op: "create_table", table: "tasks", columns: [
    { name: "name", type: "text", required: true },
    { name: "status", type: "enum", required: false, values: ["todo", "done"] },
    { name: "deal", type: "relation", required: false,
      relation: { target_table: "deals", cardinality: "one",
        unique_targets: false, display_field: "name" } },
  ] }]);
  return store;
}

describe("local automations", () => {
  it("simulates without writes and rejects an unbounded action vocabulary", async () => {
    const store = await automationStore();
    try {
      store.insert("deals", { name: "Acme", status: "won" });
      const input: AutomationDefinitionInput = {
        name: "Won deal follow-up", enabled: false,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      };
      const saved = store.upsertAutomation(input);
      const simulation = store.simulateAutomation(saved.id, new Date("2026-09-02T12:00:00Z"));
      expect(simulation).toMatchObject({ matchedRecords: 1, plannedMutations: 1 });
      expect(store.query({ from: "deals" })[0]).toMatchObject({ onboarded: null });
      expect(store.runDueAutomations(new Date("2026-09-02T12:00:00Z"))).toEqual([]);

      expect(() => store.upsertAutomation({
        ...input, name: "Unsafe", actions: [{ kind: "webhook", url: "https://example.com" }] as never,
      })).toThrow(/action/i);
    } finally { store.close(); }
  });

  it("runs a created-record workflow once, creates related work, notifies, and undoes", async () => {
    const store = await automationStore();
    try {
      store.insert("deals", { name: "Existing", status: "open" });
      const rule = store.upsertAutomation({
        name: "Prepare every new deal", enabled: true,
        trigger: { kind: "record_created", table: "deals", conditions: [] },
        actions: [
          { kind: "create_related", table: "tasks", relationField: "deal", values: {
            name: { source: "literal", value: "Prepare kickoff" },
            status: { source: "literal", value: "todo" },
          } },
          { kind: "notify", title: "New deal", body: "A kickoff task is ready." },
        ],
      });
      const deal = store.insert("deals", { name: "Northwind", status: "open" });
      const runs = store.runDueAutomations(new Date("2026-09-02T12:00:00Z"));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ automationId: rule.id, status: "success", changed: 1 });
      const tasks = store.query({ from: "tasks" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ name: "Prepare kickoff",
        deal: { id: deal.id, label: "Northwind", table: "deals" } });
      expect(store.listNotifications()).toMatchObject([{
        title: "New deal", body: "A kickoff task is ready.", read: false,
      }]);
      expect(store.runDueAutomations(new Date("2026-09-02T12:01:00Z"))).toEqual([]);

      store.undoAutomationRun(runs[0]!.id);
      expect(store.query({ from: "tasks" })).toEqual([]);
      expect(store.listNotifications()).toEqual([]);
      expect(store.automationRuns(rule.id)[0]).toMatchObject({ undone: true });
    } finally { store.close(); }
  });

  it("fires record-match edges and due-date rules idempotently", async () => {
    const store = await automationStore();
    try {
      const deal = store.insert("deals", {
        name: "Acme", status: "won", onboarded: false, due: "2026-09-03",
      });
      const match = store.upsertAutomation({
        name: "Mark won deals onboarded", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      const due = store.upsertAutomation({
        name: "Due tomorrow reminder", enabled: true,
        trigger: { kind: "date_due", table: "deals", dateField: "due", daysBefore: 1,
          conditions: [{ field: "status", op: "neq", value: "lost" }] },
        actions: [{ kind: "notify", title: "Deal due", body: "A deal is due tomorrow." }],
      });
      const first = store.runDueAutomations(new Date("2026-09-02T12:00:00"));
      expect(first.map(run => run.automationId).sort()).toEqual([due.id, match.id].sort());
      expect(store.query({ from: "deals" })[0]).toMatchObject({ onboarded: true });
      expect(store.runDueAutomations(new Date("2026-09-02T13:00:00"))).toEqual([]);

      store.update("deals", String(deal.id), { status: "open" });
      store.runDueAutomations(new Date("2026-09-02T14:00:00"));
      store.update("deals", String(deal.id), { status: "won", onboarded: false });
      const edged = store.runDueAutomations(new Date("2026-09-02T15:00:00"));
      expect(edged).toHaveLength(1);
      expect(edged[0]?.automationId).toBe(match.id);
      expect(store.query({ from: "deals" })[0]).toMatchObject({ onboarded: true });
    } finally { store.close(); }
  });

  it("runs scheduled work once per period and isolates update events", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "title", type: "text", required: true },
        { name: "state", type: "enum", required: false, values: ["open", "done"] },
      ] }]);
      const scheduled = store.upsertAutomation({ name: "Daily inspection", enabled: true,
        trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
        actions: [{ kind: "create_record", table: "tasks", values: {
          title: { source: "literal", value: "Inspect" },
        } }],
      });
      const firstDay = new Date(2026, 8, 2, 10, 0, 0);
      expect(store.runDueAutomations(firstDay)).toHaveLength(1);
      expect(store.runDueAutomations(firstDay)).toEqual([]);
      expect(store.runDueAutomations(new Date(2026, 8, 3, 10, 0, 0))).toHaveLength(1);

      const updated = store.upsertAutomation({ name: "Complete edited task", enabled: true,
        trigger: { kind: "record_updated", table: "tasks", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          state: { source: "literal", value: "done" },
        } }],
      });
      const task = store.insert("tasks", { title: "Manual", state: "open" });
      expect(store.runDueAutomations(firstDay)
        .some(run => run.automationId === updated.id)).toBe(false);
      store.update("tasks", String(task.id), { title: "Manual revised" });
      expect(store.runDueAutomations(firstDay)
        .filter(run => run.automationId === updated.id)).toHaveLength(1);
      expect(store.query({ from: "tasks", where: [
        { field: "id", op: "eq", value: String(task.id) },
      ] })[0]?.state).toBe("done");
      expect(store.runDueAutomations(firstDay)
        .filter(run => run.automationId === scheduled.id)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("rejects oversized definitions and planned output bytes", async () => {
    const store = await automationStore();
    try {
      expect(() => store.upsertAutomation({
        name: "Oversized literal", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          name: { source: "literal", value: "x".repeat(4_097) },
        } }],
      })).toThrow(/4,?096|size|large/i);
      expect(() => store.upsertAutomation({
        name: "Oversized condition", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [
          { field: "name", op: "contains", value: "x".repeat(4_097) },
        ] },
        actions: [{ kind: "notify", title: "Review", body: "Review" }],
      })).toThrow(/4,?096|size|large/i);

      const deal = store.insert("deals", { name: "x".repeat(20_000), status: "open" });
      const rule = store.upsertAutomation({
        name: "Copy large source", enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [
          { field: "id", op: "eq", value: String(deal.id) },
        ] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "field", field: "name" },
        } }],
      });
      expect(store.runAutomationNow(rule.id)).toMatchObject({ status: "failed", changed: 0 });
      expect(store.query({ from: "tasks" })).toEqual([]);
    } finally { store.close(); }
  });

  it("retries a failed match after its definition is repaired", async () => {
    const store = await ClayStore.openMemory();
    try {
      commit(store, [
        { op: "create_table", table: "deals", columns: [
          { name: "name", type: "text", required: true },
          { name: "status", type: "enum", required: true, values: ["open", "won"] },
          { name: "task_name", type: "text", required: false },
        ] },
        { op: "create_table", table: "tasks", columns: [
          { name: "title", type: "text", required: true },
        ] },
      ]);
      store.insert("deals", { name: "Acme", status: "won" });
      const broken = store.upsertAutomation({ name: "Create won task", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          title: { source: "field", field: "task_name" },
        } }],
      });
      expect(store.runDueAutomations()[0]?.status).toBe("failed");
      expect(store.query({ from: "tasks" })).toEqual([]);
      store.upsertAutomation({ ...broken, actions: [{ kind: "create_record", table: "tasks", values: {
        title: { source: "literal", value: "Kickoff" },
      } }] });
      expect(store.runDueAutomations()[0]).toMatchObject({ status: "success", changed: 1 });
      expect(store.query({ from: "tasks" })).toHaveLength(1);
      expect(store.runDueAutomations()).toEqual([]);
    } finally { store.close(); }
  });

  it("fails closed when simulation or execution exceeds 100 records", async () => {
    const store = await automationStore();
    try {
      const rule = store.upsertAutomation({
        name: "Onboard every won deal", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      for (let index = 0; index < 101; index++)
        store.insert("deals", { name: `Deal ${index}`, status: "won", onboarded: false });
      expect(() => store.simulateAutomation(rule.id,
        new Date("2026-09-02T12:00:00Z"))).toThrow(/100|limit/i);
      expect(() => store.runDueAutomations(
        new Date("2026-09-02T12:00:00Z"))).toThrow(/100|limit/i);
      expect(store.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toHaveLength(0);
    } finally { store.close(); }
  });

  it("fails closed before processing more than 100 queued event snapshots", async () => {
    const store = await automationStore();
    try {
      const deals = Array.from({ length: 101 }, (_, index) =>
        store.insert("deals", { name: `Deal ${index}`, status: "open", onboarded: false }));
      store.upsertAutomation({
        name: "Onboard updates", enabled: true,
        trigger: { kind: "record_updated", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      for (const deal of deals) store.update("deals", String(deal.id), { status: "won" });
      expect(() => store.runDueAutomations()).toThrow(/100|limit/i);
      expect(store.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toHaveLength(0);
    } finally { store.close(); }
  });

  it("evaluates queued update conditions and copied values from the event-time row", async () => {
    const store = await automationStore();
    try {
      const deal = store.insert("deals", { name: "Acme", status: "open", onboarded: false });
      const rule = store.upsertAutomation({
        name: "Remember won transition", enabled: true,
        trigger: { kind: "record_updated", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "field", field: "name" },
          status: { source: "literal", value: "todo" },
        } }],
      });
      store.update("deals", String(deal.id), { name: "Won snapshot", status: "won" });
      store.update("deals", String(deal.id), { name: "Lost later", status: "lost" });
      const runs = store.runDueAutomations(new Date("2026-09-02T12:00:00Z"));
      expect(runs.filter(run => run.automationId === rule.id)).toHaveLength(1);
      expect(store.query({ from: "tasks", select: ["name"] })).toEqual([{ name: "Won snapshot" }]);
    } finally { store.close(); }
  });

  it("retries a failed event after its definition is repaired", async () => {
    const store = await automationStore();
    try {
      const deal = store.insert("deals", { name: "Acme", status: "open" });
      const broken = store.upsertAutomation({
        name: "Create update task", enabled: true,
        trigger: { kind: "record_updated", table: "deals", conditions: [] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "field", field: "due" },
        } }],
      } as AutomationDefinitionInput);
      store.update("deals", String(deal.id), { status: "won" });
      expect(store.runDueAutomations()[0]?.status).toBe("failed");
      const repaired = { ...broken, actions: [{ kind: "create_record" as const,
        table: "tasks", values: { name: { source: "literal" as const, value: "Retry" } } }] };
      store.upsertAutomation(repaired);
      expect(store.runDueAutomations()[0]).toMatchObject({ status: "success", changed: 1 });
      expect(store.query({ from: "tasks", select: ["name"] })).toEqual([{ name: "Retry" }]);
    } finally { store.close(); }
  });

  it("rejects self-spawning match rules and validates simulation mutations", async () => {
    const store = await automationStore();
    try {
      expect(() => store.upsertAutomation({
        name: "Spawn forever", enabled: false,
        trigger: { kind: "record_matches", table: "tasks",
          conditions: [{ field: "status", op: "eq", value: "todo" }] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "literal", value: "Again" },
          status: { source: "literal", value: "todo" },
        } }],
      })).toThrow(/self|same table|recursive/i);
      const deal = store.insert("deals", { name: "Acme", status: "won" });
      const invalid = store.upsertAutomation({
        name: "Missing required value", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "field", field: "due" },
        } }],
      });
      expect(deal).toBeDefined();
      expect(() => store.simulateAutomation(invalid.id)).toThrow(/required|null|name/i);
    } finally { store.close(); }
  });

  it("rejects schema changes that would invalidate stored automations", async () => {
    const store = await automationStore();
    try {
      const rule = store.upsertAutomation({
        name: "Onboard won deals", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      expect(() => commit(store, [
        { op: "rename_column", table: "deals", from: "status", to: "stage" },
      ])).toThrow(/automation|rule/i);
      expect(store.registrySnapshot().get("deals")!.columns.some(column => column.name === "status"))
        .toBe(true);
      expect(store.listAutomations().find(candidate => candidate.id === rule.id))
        .toMatchObject({ enabled: true, trigger: { conditions: [{ field: "status" }] } });
      store.deleteAutomation(rule.id);
      commit(store, [{ op: "rename_column", table: "deals", from: "status", to: "stage" }]);
    } finally { store.close(); }
  });

  it("rolls back record-match effects when match bookkeeping fails", async () => {
    const driver = await openMemoryDriver();
    let blockMatchLedger = false;
    const faultDriver = new Proxy(driver, {
      get(target, property) {
        if (property === "exec") return (sql: string, params?: Parameters<typeof driver.exec>[1]) => {
          if (blockMatchLedger && sql.includes("INSERT OR IGNORE INTO sys.automation_matches"))
            throw new Error("blocked match bookkeeping");
          return target.exec(sql, params);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof driver;
    const store = await ClayStore.fromDriver(faultDriver);
    try {
      commit(store, [{ op: "create_table", table: "deals", columns: [
        { name: "name", type: "text", required: true },
        { name: "status", type: "enum", required: true, values: ["open", "won"] },
        { name: "onboarded", type: "boolean", required: false },
      ] }]);
      const deal = store.insert("deals", { name: "Acme", status: "won", onboarded: false });
      const rule = store.upsertAutomation({
        name: "Onboard won deals", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      blockMatchLedger = true;
      expect(store.runDueAutomations()[0]).toMatchObject({ status: "failed", changed: 0 });
      expect(store.query({ from: "deals", where: [
        { field: "id", op: "eq", value: String(deal.id) },
      ] })[0]!.onboarded).toBe(false);
      expect(store.automationRuns(rule.id).filter(run => run.status === "success")).toHaveLength(0);

      blockMatchLedger = false;
      expect(store.runDueAutomations()[0]).toMatchObject({ status: "success", changed: 1 });
      expect(store.query({ from: "deals", where: [
        { field: "id", op: "eq", value: String(deal.id) },
      ] })[0]!.onboarded).toBe(true);
      expect(store.runDueAutomations()).toEqual([]);
      expect(store.automationRuns(rule.id).filter(run => run.status === "success")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("rolls back automation data when notification bookkeeping fails", async () => {
    const driver = await openMemoryDriver();
    let blockNotifications = false;
    const faultDriver = new Proxy(driver, {
      get(target, property) {
        if (property === "exec") return (sql: string, params?: Parameters<typeof driver.exec>[1]) => {
          if (blockNotifications && sql.includes("INSERT INTO sys.notifications"))
            throw new Error("blocked notification bookkeeping");
          return target.exec(sql, params);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof driver;
    const store = await ClayStore.fromDriver(faultDriver);
    try {
      commit(store, [{ op: "create_table", table: "deals", columns: [
        { name: "name", type: "text", required: true },
        { name: "status", type: "enum", required: false, values: ["open", "won"] },
      ] }]);
      const deal = store.insert("deals", { name: "Acme", status: "open" });
      const rule = store.upsertAutomation({
        name: "Win and notify", enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [
          { kind: "set_fields", values: { status: { source: "literal", value: "won" } } },
          { kind: "notify", title: "Won", body: "Deal won." },
        ],
      });
      blockNotifications = true;
      const run = store.runAutomationNow(rule.id, new Date("2026-09-02T12:00:00Z"));
      expect(run).toMatchObject({ status: "failed", changed: 0, batchId: null });
      expect(store.query({ from: "deals", where: [
        { field: "id", op: "eq", value: String(deal.id) },
      ] })[0]!.status).toBe("open");
      expect(store.operationBatches()).toEqual([]);
      expect(store.automationRuns()[0]).toMatchObject({ status: "failed", changed: 0 });
    } finally { store.close(); }
  });

  it("rolls back data undo when run bookkeeping fails", async () => {
    const driver = await openMemoryDriver();
    let blockBookkeeping = false;
    const faultDriver = new Proxy(driver, {
      get(target, property) {
        if (property === "exec") return (sql: string, params?: Parameters<typeof driver.exec>[1]) => {
          if (blockBookkeeping && sql.includes("UPDATE sys.automation_runs SET undone_at"))
            throw new Error("blocked bookkeeping");
          return target.exec(sql, params);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof driver;
    const store = await ClayStore.fromDriver(faultDriver);
    try {
      commit(store, [{ op: "create_table", table: "tasks", columns: [
        { name: "title", type: "text", required: true },
        { name: "status", type: "enum", required: false, values: ["open", "done"] },
      ] }]);
      const task = store.insert("tasks", { title: "Inspect", status: "open" });
      const rule = store.upsertAutomation({
        name: "Complete manually", enabled: true,
        trigger: { kind: "manual", table: "tasks", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          status: { source: "literal", value: "done" },
        } }],
      });
      const run = store.runAutomationNow(rule.id, new Date("2026-09-02T12:00:00"));
      expect(store.query({ from: "tasks", select: ["status"] })[0]!.status).toBe("done");
      blockBookkeeping = true;
      expect(() => store.undoAutomationRun(run.id)).toThrow(/blocked/);
      expect(store.query({ from: "tasks", select: ["status"],
        where: [{ field: "id", op: "eq", value: String(task.id) }] })[0]!.status).toBe("done");
    } finally { store.close(); }
  });

  it("round-trips definitions, receipts, and notifications in archives", async () => {
    const source = await automationStore();
    try {
      const rule = source.upsertAutomation({
        name: "Manual reminder", enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "notify", title: "Review", body: "Review the active deals." }],
      });
      source.insert("deals", { name: "Acme", status: "open" });
      source.runAutomationNow(rule.id, new Date("2026-09-02T12:00:00Z"));
      const imported = await ClayStore.importArchive(await source.exportArchive("automated"));
      try {
        expect(imported.store.listAutomations()).toEqual(source.listAutomations());
        expect(imported.store.automationRuns()).toEqual(source.automationRuns());
        expect(imported.store.listNotifications()).toEqual(source.listNotifications());
      } finally { imported.store.close(); }
    } finally { source.close(); }
  });
});
