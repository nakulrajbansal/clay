import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver, validateAutomationDefinition,
  type AutomationDefinitionAny, type AutomationDefinitionInput, type AutomationDraftInputV2,
  type ForwardOpT, type StableFieldRef, type StableTableRef,
} from "../src/index";

function commit(store: ClayStore, operations: ForwardOpT[]): void {
  store.commit({ intent: "automation schema", summary: "Creates automation fixtures.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
}

const TEST_TARGET = Object.freeze({
  v: 1 as const,
  appInstanceId: `app_${"a".repeat(26)}`,
  activeGenerationId: `gen_${"b".repeat(26)}`,
  lineageEpoch: "1",
  stateRevision: "1",
  stateDigest: `sha256:${"c".repeat(64)}`,
});

function legacyAutomationDraft(
  store: ClayStore,
  input: AutomationDefinitionInput,
): AutomationDraftInputV2 {
  const normalized = validateAutomationDefinition(store.registrySnapshot(), input);
  const trace = store.semanticSchemaTrace();
  const tableRef = (name: string): StableTableRef => {
    const table = trace.tables.find(candidate => candidate.name === name && candidate.state === "visible");
    if (!table) throw new Error(`missing test table '${name}'`);
    return { tableId: table.tableId, lastKnownName: table.name };
  };
  const fieldRef = (tableName: string, fieldName: string): StableFieldRef => {
    const table = tableRef(tableName);
    const field = trace.fields.find(candidate => candidate.tableId === table.tableId
      && candidate.fieldName === fieldName && candidate.state === "visible");
    if (!field) throw new Error(`missing test field '${tableName}.${fieldName}'`);
    return { tableId: table.tableId, fieldId: field.fieldId, lastKnownName: field.fieldName };
  };
  const sourceTable = normalized.trigger.kind === "schedule" ? null : normalized.trigger.table;
  const conditions = normalized.trigger.kind === "schedule" ? []
    : normalized.trigger.conditions
      .filter(item => item.field !== "id" && item.field !== "created_at"
        && item.field !== "updated_at" && item.field !== "deleted_at")
      .map(item => ({ ...item, field: fieldRef(normalized.trigger.kind === "schedule"
        ? "" : normalized.trigger.table, item.field) }));
  let trigger: AutomationDraftInputV2["trigger"];
  switch (normalized.trigger.kind) {
    case "record_created":
    case "record_updated":
    case "record_matches":
    case "manual":
      trigger = { kind: normalized.trigger.kind, table: tableRef(normalized.trigger.table), conditions };
      break;
    case "date_due":
      trigger = { kind: "date_due", table: tableRef(normalized.trigger.table),
        dateField: fieldRef(normalized.trigger.table, normalized.trigger.dateField),
        daysBefore: normalized.trigger.daysBefore, conditions };
      break;
    case "schedule":
      trigger = { kind: "schedule", cadence: normalized.trigger.cadence,
        localTime: normalized.trigger.localTime, weekday: normalized.trigger.weekday };
  }
  const values = (
    targetTable: string,
    source: string | null,
    entries: Record<string, { source: "literal"; value: string | number | boolean | null }
      | { source: "field"; field: string }>,
  ) => Object.entries(entries).map(([fieldName, value]) => ({
    field: fieldRef(targetTable, fieldName),
    value: value.source === "literal" ? value
      : { source: "field" as const, field: fieldRef(source ?? "", value.field).fieldId },
  }));
  const actions: AutomationDraftInputV2["actions"] = normalized.actions.map(action => {
    switch (action.kind) {
      case "set_fields":
        if (!sourceTable) throw new Error("test schedule cannot set source fields");
        return { kind: "set_fields", values: values(sourceTable, sourceTable, action.values) };
      case "create_record":
        return { kind: "create_record", table: tableRef(action.table),
          values: values(action.table, sourceTable, action.values) };
      case "create_related":
        return { kind: "create_related", table: tableRef(action.table),
          relationField: fieldRef(action.table, action.relationField),
          values: values(action.table, sourceTable, action.values) };
      case "notify": return action;
    }
  });
  return {
    v: 2,
    ...(normalized.id ? { id: normalized.id } : {}),
    name: normalized.name,
    trigger,
    actions,
    runtime: { mode: "local", ...(trigger.kind === "schedule" ? { timeZone: "UTC" } : {}) },
  };
}

function testUpsertAutomation(
  store: ClayStore,
  input: AutomationDefinitionInput,
): AutomationDefinitionAny {
  const prior = input.id ? store.listAutomations().find(item => item.id === input.id) : undefined;
  const draft = store.saveAutomationDraft(
    legacyAutomationDraft(store, input),
    prior?.v === 2 ? prior.definitionRevision : undefined,
    new Date("2026-09-02T08:00:00.000Z"),
  );
  if (!input.enabled) return draft;
  const simulation = store.simulateAutomation({
    id: draft.id,
    target: TEST_TARGET,
    expectedRevision: draft.definitionRevision,
    purpose: "enable",
  }, new Date("2026-09-02T08:01:00.000Z"));
  return store.enableAutomation({
    id: draft.id,
    target: TEST_TARGET,
    expectedRevision: draft.definitionRevision,
    simulation,
  }, new Date("2026-09-02T08:02:00.000Z"));
}

function runAutomationNowWithProof(store: ClayStore, id: string, now: Date) {
  const definition = store.listAutomations(TEST_TARGET).find(item => item.id === id);
  if (!definition || definition.v !== 2) throw new Error("expected a V2 automation fixture");
  const simulation = store.simulateAutomation({
    id,
    target: TEST_TARGET,
    expectedRevision: definition.definitionRevision,
    purpose: "run_now",
  }, now);
  return store.runAutomationNow({
    id,
    target: TEST_TARGET,
    expectedRevision: definition.definitionRevision,
    simulation,
  }, now);
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
      const saved = testUpsertAutomation(store, input);
      const simulation = store.simulateAutomation(saved.id, new Date("2026-09-02T12:00:00Z"));
      expect(simulation).toMatchObject({ matchedRecords: 1, plannedMutations: 1 });
      expect(store.query({ from: "deals" })[0]).toMatchObject({ onboarded: null });
      expect(store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T12:00:00Z"))).toEqual([]);

      expect(() => testUpsertAutomation(store, {
        ...input, name: "Unsafe", actions: [{ kind: "webhook", url: "https://example.com" }] as never,
      })).toThrow(/action/i);
    } finally { store.close(); }
  });

  it("runs a created-record workflow once, creates related work, notifies, and undoes", async () => {
    const store = await automationStore();
    try {
      store.insert("deals", { name: "Existing", status: "open" });
      const rule = testUpsertAutomation(store, {
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
      const runs = store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T12:00:00Z"));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ automationId: rule.id, status: "success", changed: 1 });
      const tasks = store.query({ from: "tasks" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ name: "Prepare kickoff",
        deal: { id: deal.id, label: "Northwind", table: "deals" } });
      expect(store.listNotifications()).toMatchObject([{
        title: "New deal", body: "A kickoff task is ready.", read: false,
      }]);
      expect(store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T12:01:00Z"))).toEqual([]);

      store.undoAutomationRun({ id: runs[0]!.id, target: TEST_TARGET });
      expect(store.query({ from: "tasks" })).toEqual([]);
      expect(store.listNotifications()).toEqual([]);
      expect(store.automationRuns(TEST_TARGET, rule.id)[0]).toMatchObject({ undone: true });
    } finally { store.close(); }
  });

  it("fires record-match edges and due-date rules idempotently", async () => {
    const store = await automationStore();
    try {
      const match = testUpsertAutomation(store, {
        name: "Mark won deals onboarded", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      const deal = store.insert("deals", {
        name: "Acme", status: "won", onboarded: false, due: "2026-09-03",
      });
      const due = testUpsertAutomation(store, {
        name: "Due tomorrow reminder", enabled: true,
        trigger: { kind: "date_due", table: "deals", dateField: "due", daysBefore: 1,
          conditions: [{ field: "status", op: "neq", value: "lost" }] },
        actions: [{ kind: "notify", title: "Deal due", body: "A deal is due tomorrow." }],
      });
      const first = store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T12:00:00"));
      expect(first.map(run => run.automationId).sort()).toEqual([due.id, match.id].sort());
      expect(store.query({ from: "deals" })[0]).toMatchObject({ onboarded: true });
      expect(store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T13:00:00"))).toEqual([]);

      store.update("deals", String(deal.id), { status: "open" });
      store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T14:00:00"));
      store.update("deals", String(deal.id), { status: "won", onboarded: false });
      const edged = store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T15:00:00"));
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
      const scheduled = testUpsertAutomation(store, { name: "Daily inspection", enabled: true,
        trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
        actions: [{ kind: "create_record", table: "tasks", values: {
          title: { source: "literal", value: "Inspect" },
        } }],
      });
      const firstDay = new Date(2026, 8, 2, 10, 0, 0);
      expect(store.runDueAutomations(TEST_TARGET, firstDay)).toHaveLength(1);
      expect(store.runDueAutomations(TEST_TARGET, firstDay)).toEqual([]);
      expect(store.runDueAutomations(TEST_TARGET, new Date(2026, 8, 3, 10, 0, 0))).toHaveLength(1);

      const updated = testUpsertAutomation(store, { name: "Complete edited task", enabled: true,
        trigger: { kind: "record_updated", table: "tasks", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          state: { source: "literal", value: "done" },
        } }],
      });
      const task = store.insert("tasks", { title: "Manual", state: "open" });
      expect(store.runDueAutomations(TEST_TARGET, firstDay)
        .some(run => run.automationId === updated.id)).toBe(false);
      store.update("tasks", String(task.id), { title: "Manual revised" });
      expect(store.runDueAutomations(TEST_TARGET, firstDay)
        .filter(run => run.automationId === updated.id)).toHaveLength(1);
      expect(store.query({ from: "tasks", where: [
        { field: "id", op: "eq", value: String(task.id) },
      ] })[0]?.state).toBe("done");
      expect(store.runDueAutomations(TEST_TARGET, firstDay)
        .filter(run => run.automationId === scheduled.id)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("rejects oversized definitions and planned output bytes", async () => {
    const store = await automationStore();
    try {
      expect(() => testUpsertAutomation(store, {
        name: "Oversized literal", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          name: { source: "literal", value: "x".repeat(4_097) },
        } }],
      })).toThrow(/4,?096|size|large/i);
      expect(() => testUpsertAutomation(store, {
        name: "Oversized condition", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [
          { field: "name", op: "contains", value: "x".repeat(4_097) },
        ] },
        actions: [{ kind: "notify", title: "Review", body: "Review" }],
      })).toThrow(/4,?096|size|large/i);

      const deal = store.insert("deals", { name: "x".repeat(20_000), status: "open" });
      expect(() => testUpsertAutomation(store, {
        name: "Copy large source", enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [
          { field: "id", op: "eq", value: String(deal.id) },
        ] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "field", field: "name" },
        } }],
      })).toThrow(/16 KiB|output|size|large/i);
      expect(store.listAutomations()).toMatchObject([{ state: "draft", enabled: false }]);
      expect(store.automationRuns(TEST_TARGET)).toEqual([]);
      expect(store.query({ from: "tasks" })).toEqual([]);
    } finally { store.close(); }
  });

  it("keeps an invalid match draft disabled until it is repaired and re-simulated", async () => {
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
      const brokenInput: AutomationDefinitionInput = { name: "Create won task", enabled: false,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          title: { source: "field", field: "task_name" },
        } }],
      };
      const broken = testUpsertAutomation(store, brokenInput);
      expect(() => store.simulateAutomation({ id: broken.id, target: TEST_TARGET,
        expectedRevision: broken.v === 2 ? broken.definitionRevision : 0, purpose: "enable" },
      new Date("2026-09-02T08:01:00.000Z"))).toThrow(/required|null|title/i);
      expect(store.runDueAutomations(TEST_TARGET)).toEqual([]);
      expect(store.query({ from: "tasks" })).toEqual([]);

      const repaired = testUpsertAutomation(store, {
        id: broken.id,
        name: broken.name,
        enabled: true,
        trigger: brokenInput.trigger,
        actions: [{ kind: "create_record", table: "tasks", values: {
          title: { source: "literal", value: "Kickoff" },
        } }],
      });
      expect(repaired).toMatchObject({ state: "enabled", enabled: true });
      store.insert("deals", { name: "Northwind", status: "won" });
      expect(store.runDueAutomations(TEST_TARGET)[0]).toMatchObject({ status: "success", changed: 1 });
      expect(store.query({ from: "tasks" })).toHaveLength(1);
      expect(store.runDueAutomations(TEST_TARGET)).toEqual([]);
    } finally { store.close(); }
  });

  it("fails closed when simulation or execution exceeds 100 records", async () => {
    const store = await automationStore();
    try {
      const rule = testUpsertAutomation(store, {
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
      expect(() => store.runDueAutomations(TEST_TARGET,
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
      testUpsertAutomation(store, {
        name: "Onboard updates", enabled: true,
        trigger: { kind: "record_updated", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      for (const deal of deals) store.update("deals", String(deal.id), { status: "won" });
      expect(() => store.runDueAutomations(TEST_TARGET)).toThrow(/100|limit/i);
      expect(store.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toHaveLength(0);
    } finally { store.close(); }
  });

  it("evaluates queued update conditions and copied values from the event-time row", async () => {
    const store = await automationStore();
    try {
      const deal = store.insert("deals", { name: "Acme", status: "open", onboarded: false });
      const rule = testUpsertAutomation(store, {
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
      const runs = store.runDueAutomations(TEST_TARGET, new Date("2026-09-02T12:00:00Z"));
      expect(runs.filter(run => run.automationId === rule.id)).toHaveLength(1);
      expect(store.query({ from: "tasks", select: ["name"] })).toEqual([{ name: "Won snapshot" }]);
    } finally { store.close(); }
  });

  it("retries a failed event after its definition is repaired", async () => {
    const store = await automationStore();
    try {
      store.insert("deals", {
        name: "Enable probe", status: "open", due: "2026-09-02",
      });
      const broken = testUpsertAutomation(store, {
        name: "Create update task", enabled: true,
        trigger: { kind: "record_updated", table: "deals", conditions: [] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "field", field: "due" },
        } }],
      } as AutomationDefinitionInput);
      const deal = store.insert("deals", { name: "Acme", status: "open" });
      store.update("deals", String(deal.id), { status: "won" });
      expect(store.runDueAutomations(TEST_TARGET)[0]?.status).toBe("failed");
      testUpsertAutomation(store, {
        id: broken.id, name: broken.name, enabled: true,
        trigger: { kind: "record_updated", table: "deals", conditions: [] },
        actions: [{ kind: "create_record", table: "tasks",
          values: { name: { source: "literal", value: "Retry" } } }],
      });
      expect(store.runDueAutomations(TEST_TARGET)[0]).toMatchObject({ status: "success", changed: 1 });
      expect(store.query({ from: "tasks", select: ["name"] })).toEqual([{ name: "Retry" }]);
    } finally { store.close(); }
  });

  it("rejects self-spawning match rules and validates simulation mutations", async () => {
    const store = await automationStore();
    try {
      expect(() => testUpsertAutomation(store, {
        name: "Spawn forever", enabled: false,
        trigger: { kind: "record_matches", table: "tasks",
          conditions: [{ field: "status", op: "eq", value: "todo" }] },
        actions: [{ kind: "create_record", table: "tasks", values: {
          name: { source: "literal", value: "Again" },
          status: { source: "literal", value: "todo" },
        } }],
      })).toThrow(/self|same table|recursive/i);
      const deal = store.insert("deals", { name: "Acme", status: "won" });
      const invalid = testUpsertAutomation(store, {
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

  it("preserves semantic automation references across a column rename", async () => {
    const store = await automationStore();
    try {
      const rule = testUpsertAutomation(store, {
        name: "Onboard won deals", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      if (rule.v !== 2) throw new Error("expected a V2 automation");
      if (rule.trigger.kind === "schedule") throw new Error("expected a record-match trigger");
      const fieldBefore = rule.trigger.conditions[0]!.field;
      commit(store, [
        { op: "rename_column", table: "deals", from: "status", to: "stage" },
      ]);
      expect(store.registrySnapshot().get("deals")!.columns.some(column => column.name === "status"))
        .toBe(false);
      expect(store.registrySnapshot().get("deals")!.columns.some(column => column.name === "stage"))
        .toBe(true);
      const after = store.listAutomations().find(candidate => candidate.id === rule.id);
      if (!after || after.v !== 2) throw new Error("expected a V2 automation");
      if (after.trigger.kind === "schedule") throw new Error("expected a record-match trigger");
      expect(after.enabled).toBe(true);
      expect(after.trigger.conditions[0]!.field).toEqual({
        ...fieldBefore, lastKnownName: "stage",
      });
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
      const rule = testUpsertAutomation(store, {
        name: "Onboard won deals", enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      const deal = store.insert("deals", { name: "Acme", status: "won", onboarded: false });
      blockMatchLedger = true;
      expect(store.runDueAutomations(TEST_TARGET)[0]).toMatchObject({ status: "failed", changed: 0 });
      expect(store.query({ from: "deals", where: [
        { field: "id", op: "eq", value: String(deal.id) },
      ] })[0]!.onboarded).toBe(false);
      expect(store.automationRuns(TEST_TARGET, rule.id).filter(run => run.status === "success")).toHaveLength(0);

      blockMatchLedger = false;
      expect(store.runDueAutomations(TEST_TARGET)[0]).toMatchObject({ status: "success", changed: 1 });
      expect(store.query({ from: "deals", where: [
        { field: "id", op: "eq", value: String(deal.id) },
      ] })[0]!.onboarded).toBe(true);
      expect(store.runDueAutomations(TEST_TARGET)).toEqual([]);
      expect(store.automationRuns(TEST_TARGET, rule.id).filter(run => run.status === "success")).toHaveLength(1);
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
      const rule = testUpsertAutomation(store, {
        name: "Win and notify", enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [
          { kind: "set_fields", values: { status: { source: "literal", value: "won" } } },
          { kind: "notify", title: "Won", body: "Deal won." },
        ],
      });
      blockNotifications = true;
      const execution = runAutomationNowWithProof(
        store, rule.id, new Date("2026-09-02T12:00:00Z"));
      if (execution.kind !== "committed") throw new Error("expected a committed run fixture");
      const run = execution.receipt;
      expect(run).toMatchObject({ status: "failed", changed: 0, batchId: null });
      expect(store.query({ from: "deals", where: [
        { field: "id", op: "eq", value: String(deal.id) },
      ] })[0]!.status).toBe("open");
      expect(store.operationBatches()).toEqual([]);
      expect(store.automationRuns(TEST_TARGET)[0]).toMatchObject({ status: "failed", changed: 0 });
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
      const rule = testUpsertAutomation(store, {
        name: "Complete manually", enabled: true,
        trigger: { kind: "manual", table: "tasks", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          status: { source: "literal", value: "done" },
        } }],
      });
      const execution = runAutomationNowWithProof(
        store, rule.id, new Date("2026-09-02T12:00:00"));
      if (execution.kind !== "committed") throw new Error("expected a committed run fixture");
      const run = execution.receipt;
      expect(store.query({ from: "tasks", select: ["status"] })[0]!.status).toBe("done");
      blockBookkeeping = true;
      expect(() => store.undoAutomationRun({ id: run.id, target: TEST_TARGET })).toThrow(/blocked/);
      expect(store.query({ from: "tasks", select: ["status"],
        where: [{ field: "id", op: "eq", value: String(task.id) }] })[0]!.status).toBe("done");
    } finally { store.close(); }
  });

  it("round-trips definitions, receipts, and notifications in archives", async () => {
    const source = await automationStore();
    try {
      const rule = testUpsertAutomation(source, {
        name: "Manual reminder", enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "notify", title: "Review", body: "Review the active deals." }],
      });
      source.insert("deals", { name: "Acme", status: "open" });
      runAutomationNowWithProof(source, rule.id, new Date("2026-09-02T12:00:00Z"));
      const imported = await ClayStore.importArchive(await source.exportArchive("automated"));
      try {
        expect(imported.store.listAutomations()).toEqual(source.listAutomations());
        expect(imported.store.automationRuns(TEST_TARGET))
          .toEqual(source.automationRuns(TEST_TARGET));
        expect(imported.store.listNotifications()).toEqual(source.listNotifications());
      } finally { imported.store.close(); }
    } finally { source.close(); }
  });
});
