import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver, validateAutomationDefinition,
  type AutomationDefinitionInput, type AutomationDefinitionV2, type AutomationDraftInputV2,
  type DbDriver, type ForwardOpT, type StableFieldRef, type StableTableRef,
} from "../src/index";
import {
  ProductionStoreAuthority,
  armProductionAuthorityFailureForTest,
} from "../src/production-authority";
import { executeAutomationObserverAuthorityRoute } from
  "../src/production-automation-observer-routes";

const opaque = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const legacyInventory = {
  state: "complete" as const,
  catalogPresent: false,
  namespaces: [{
    storageKey: "default",
    userFile: "/user.db",
    systemFile: "/system.db",
    kind: "legacy" as const,
  }],
};

async function automationAuthority(
  dealCount = 1,
  prepare?: (store: ClayStore) => void,
): Promise<{
  authority: ProductionStoreAuthority;
  driver: DbDriver;
  store: ClayStore;
}> {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [
    { op: "create_table", table: "deals", columns: [
      { name: "name", type: "text", required: true },
      { name: "status", type: "enum", required: false, values: ["open", "won"] },
      { name: "onboarded", type: "boolean", required: false },
    ] },
    { op: "create_table", table: "tasks", columns: [
      { name: "name", type: "text", required: true },
      { name: "status", type: "enum", required: false, values: ["todo", "done"] },
      { name: "deal", type: "relation", required: false,
        relation: { target_table: "deals", cardinality: "one",
          unique_targets: false, display_field: "name" } },
    ] },
  ];
  store.commit({
    intent: "create automation fixtures",
    summary: "Created automation fixtures.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
  for (let index = 0; index < dealCount; index++)
    store.insert("deals", { name: `Deal ${index}`, status: "open", onboarded: false });
  prepare?.(store);
  return {
    driver,
    store,
    authority: ProductionStoreAuthority.adoptLegacy(driver, {
      inventory: legacyInventory,
      storageKey: "default",
      displayName: "My app",
      appInstanceId: opaque("app", "a"),
      generationId: opaque("gen", "b"),
      namespaceId: opaque("ns", "c"),
      adoptionOperationId: opaque("op", "d"),
      releaseId: opaque("rel", "e"),
      nowMs: Date.now(),
      leaseTtlMs: 60_000,
    }),
  };
}

function authorityAutomationDraft(
  authority: ProductionStoreAuthority,
  input: AutomationDefinitionInput,
): AutomationDraftInputV2 {
  const reader = authority.readStore();
  const normalized = validateAutomationDefinition(reader.registrySnapshot(), input);
  const trace = reader.semanticSchemaTrace();
  const tableRef = (name: string): StableTableRef => {
    const table = trace.tables.find(candidate => candidate.name === name
      && candidate.state === "visible");
    if (!table) throw new Error(`missing authority-test table '${name}'`);
    return { tableId: table.tableId, lastKnownName: table.name };
  };
  const fieldRef = (tableName: string, fieldName: string): StableFieldRef => {
    const table = tableRef(tableName);
    const field = trace.fields.find(candidate => candidate.tableId === table.tableId
      && candidate.fieldName === fieldName && candidate.state === "visible");
    if (!field) throw new Error(`missing authority-test field '${tableName}.${fieldName}'`);
    return { tableId: table.tableId, fieldId: field.fieldId, lastKnownName: field.fieldName };
  };
  const sourceTable = normalized.trigger.kind === "schedule" ? null : normalized.trigger.table;
  const conditions = normalized.trigger.kind === "schedule" ? []
    : normalized.trigger.conditions
      .filter(condition => !["id", "created_at", "updated_at", "deleted_at"]
        .includes(condition.field))
      .map(condition => ({
        ...condition,
        field: fieldRef(normalized.trigger.kind === "schedule"
          ? "" : normalized.trigger.table, condition.field),
      }));
  let trigger: AutomationDraftInputV2["trigger"];
  switch (normalized.trigger.kind) {
    case "record_created":
    case "record_updated":
    case "record_matches":
    case "manual":
      trigger = {
        kind: normalized.trigger.kind,
        table: tableRef(normalized.trigger.table),
        conditions,
      };
      break;
    case "date_due":
      trigger = {
        kind: "date_due",
        table: tableRef(normalized.trigger.table),
        dateField: fieldRef(normalized.trigger.table, normalized.trigger.dateField),
        daysBefore: normalized.trigger.daysBefore,
        conditions,
      };
      break;
    case "schedule":
      trigger = {
        kind: "schedule",
        cadence: normalized.trigger.cadence,
        localTime: normalized.trigger.localTime,
        ...(normalized.trigger.cadence === "weekly"
          ? { weekday: normalized.trigger.weekday } : {}),
      };
  }
  const stableValues = (
    targetTable: string,
    source: string | null,
    entries: Extract<AutomationDefinitionInput["actions"][number],
      { kind: "set_fields" | "create_record" | "create_related" }>["values"],
  ) => Object.entries(entries).map(([fieldName, value]) => ({
    field: fieldRef(targetTable, fieldName),
    value: value.source === "literal" ? value
      : { source: "field" as const, field: fieldRef(source ?? "", value.field).fieldId },
  }));
  const actions: AutomationDraftInputV2["actions"] = normalized.actions.map(action => {
    switch (action.kind) {
      case "set_fields":
        if (!sourceTable) throw new Error("authority-test schedule cannot set source fields");
        return { kind: "set_fields", values: stableValues(sourceTable, sourceTable, action.values) };
      case "create_record":
        return {
          kind: "create_record", table: tableRef(action.table),
          values: stableValues(action.table, sourceTable, action.values),
        };
      case "create_related":
        return {
          kind: "create_related", table: tableRef(action.table),
          relationField: fieldRef(action.table, action.relationField),
          values: stableValues(action.table, sourceTable, action.values),
        };
      case "notify":
        return action;
    }
  });
  return {
    v: 2,
    ...(normalized.id === undefined ? {} : { id: normalized.id }),
    name: normalized.name,
    trigger,
    actions,
    runtime: { mode: "local", ...(trigger.kind === "schedule" ? { timeZone: "UTC" } : {}) },
  };
}

async function saveAuthorityAutomation(
  authority: ProductionStoreAuthority,
  input: AutomationDefinitionInput,
): Promise<AutomationDefinitionV2> {
  const saved = (await authority.executeMutation({
    requestId: authority.createRequestId(),
    route: "saveAutomationDraft",
    payload: { input: authorityAutomationDraft(authority, input), expectedRevision: null },
  })).result as AutomationDefinitionV2;
  if (!input.enabled) return saved;
  const simulation = await authority.simulateAutomation({
    id: saved.id,
    expectedRevision: saved.definitionRevision,
    purpose: "enable",
  });
  return (await authority.executeMutation({
    requestId: authority.createRequestId(),
    route: "enableAutomation",
    payload: { id: saved.id, expectedRevision: saved.definitionRevision, simulation },
  })).result as AutomationDefinitionV2;
}

async function authorityRunNowRequest(
  authority: ProductionStoreAuthority,
  rule: AutomationDefinitionV2,
  requestId: string = authority.createRequestId(),
): Promise<{
  requestId: string;
  route: "runAutomationNow";
  payload: {
    id: string;
    expectedRevision: number;
    simulation: Awaited<ReturnType<ProductionStoreAuthority["simulateAutomation"]>>;
  };
}> {
  const simulation = await authority.simulateAutomation({
    id: rule.id,
    expectedRevision: rule.definitionRevision,
    purpose: "run_now",
  });
  return {
    requestId,
    route: "runAutomationNow",
    payload: { id: rule.id, expectedRevision: rule.definitionRevision, simulation },
  };
}

describe("production automation and operational authority", () => {
  it("serializes stable-ID save, target-bound simulation, and exact-proof enable through durable authority handles", async () => {
    const { authority } = await automationAuthority();
    try {
      const trace = authority.readStore().semanticSchemaTrace();
      const deals = trace.tables.find(table => table.name === "deals")!;
      const status = trace.fields.find(field => field.tableId === deals.tableId
        && field.fieldName === "status")!;
      const onboarded = trace.fields.find(field => field.tableId === deals.tableId
        && field.fieldName === "onboarded")!;
      const savedMutation = await authority.executeMutation({
        requestId: opaque("req", "z"),
        route: "saveAutomationDraft",
        payload: { input: {
          v: 2,
          name: "Onboard won deals",
          trigger: {
            kind: "record_matches",
            table: { tableId: deals.tableId, lastKnownName: "presentation only" },
            conditions: [{
              field: { tableId: deals.tableId, fieldId: status.fieldId,
                lastKnownName: "presentation only" },
              op: "eq",
              value: "open",
            }],
          },
          actions: [{
            kind: "set_fields",
            values: [{
              field: { tableId: deals.tableId, fieldId: onboarded.fieldId,
                lastKnownName: "presentation only" },
              value: { source: "literal", value: true },
            }],
          }],
          runtime: { mode: "local" },
        }, expectedRevision: null },
      });
      expect(savedMutation).toMatchObject({
        requestId: opaque("req", "z"),
        changed: true,
        replayed: false,
        result: { v: 2, state: "draft", enabled: false, definitionRevision: 1 },
      });
      const saved = savedMutation.result as { id: string; definitionRevision: number };
      const beforeSimulation = authority.inspectAuthority();

      const simulation = await authority.simulateAutomation({
        id: saved.id,
        expectedRevision: saved.definitionRevision,
        purpose: "enable",
      });

      expect(authority.inspectAuthority()).toEqual(beforeSimulation);
      expect(simulation).toMatchObject({
        v: 1,
        automationId: saved.id,
        definitionRevision: 1,
        target: {
          v: 1,
          appInstanceId: beforeSimulation.target.appInstanceId,
          activeGenerationId: beforeSimulation.target.activeGenerationId,
          lineageEpoch: beforeSimulation.target.lineageEpoch,
          stateRevision: beforeSimulation.target.protectionRevision,
          stateDigest: beforeSimulation.target.stateSha256,
        },
        runtime: { mode: "local", requiresAppOpen: true },
      });
      const enableRequest = {
        requestId: opaque("req", "y"),
        route: "enableAutomation",
        payload: {
          id: saved.id,
          expectedRevision: saved.definitionRevision,
          simulation,
        },
      } as const;
      const enabled = await authority.executeMutation(enableRequest);
      expect(enabled).toMatchObject({
        changed: true,
        replayed: false,
        result: { v: 2, state: "enabled", enabled: true,
          enableProof: { simulationId: simulation.id } },
      });
      await expect(authority.executeMutation(enableRequest))
        .resolves.toEqual({ ...enabled, replayed: true });
      expect(authority.readStore().listAutomations()).toEqual([enabled.result]);
    } finally {
      authority.close();
    }
  });

  it("authority-routes an in-place legacy repair at revision zero and keeps it disabled", async () => {
    const legacyInput: AutomationDefinitionInput = {
      name: "Legacy review",
      enabled: false,
      trigger: { kind: "record_matches", table: "deals",
        conditions: [{ field: "status", op: "eq", value: "open" }] },
      actions: [{ kind: "notify", title: "Review", body: "Review this deal." }],
    };
    let legacyId = "";
    const { authority } = await automationAuthority(1, store => {
      legacyId = store.upsertAutomation(legacyInput).id;
    });
    try {
      const request = {
        requestId: authority.createRequestId(),
        route: "saveAutomationDraft",
        payload: {
          input: authorityAutomationDraft(authority, { ...legacyInput, id: legacyId }),
          expectedRevision: 0,
        },
      } as const;
      const repaired = await authority.executeMutation(request);
      expect(repaired).toMatchObject({
        changed: true,
        replayed: false,
        result: {
          v: 2, id: legacyId, definitionRevision: 1,
          state: "draft", enabled: false, needsRepair: false, enableProof: null,
        },
      });
      expect(authority.readStore().listAutomations()).toMatchObject([
        { v: 2, id: legacyId, state: "draft", enabled: false },
      ]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...repaired, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("authority-routes automation definition upsert with replayable receipts", async () => {
    const { authority } = await automationAuthority();
    const request = {
      requestId: opaque("req", "a"),
      route: "upsertAutomation",
      payload: { input: {
        name: "Onboard won deals",
        enabled: false,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "won" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      } },
    } as const;
    try {
      const first = await authority.executeMutation(request);
      expect(first).toMatchObject({
        changed: true,
        replayed: false,
        result: { id: expect.stringMatching(/^auto_[0-9a-f]{32}$/), enabled: false },
      });
      expect(authority.readStore().listAutomations()).toEqual([first.result]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...first, replayed: true });
      expect(authority.readStore().listAutomations()).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("authority-routes automation deletion atomically and replays it", async () => {
    const { authority } = await automationAuthority();
    try {
      const created = await authority.executeMutation({
        requestId: opaque("req", "b"),
        route: "upsertAutomation",
        payload: { input: {
          name: "Temporary rule",
          enabled: false,
          trigger: { kind: "manual", table: "deals", conditions: [] },
          actions: [{ kind: "notify", title: "Review", body: "Review this deal." }],
        } },
      });
      const automationId = (created.result as { id: string }).id;
      const request = {
        requestId: opaque("req", "c"),
        route: "deleteAutomation",
        payload: { id: automationId },
      } as const;

      const removed = await authority.executeMutation(request);
      expect(removed).toMatchObject({ changed: true, replayed: false, result: null });
      expect(authority.readStore().listAutomations()).toEqual([]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...removed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("runs a manual automation through authority with atomic effects, run receipt, and notification", async () => {
    const { authority } = await automationAuthority();
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Onboard and notify",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [
          { kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } },
          { kind: "notify", title: "Onboarded", body: "The deal was onboarded." },
        ],
      });
      const automationId = rule.id;
      const request = await authorityRunNowRequest(authority, rule, opaque("req", "f"));

      const executed = await authority.executeMutation(request);
      expect(executed).toMatchObject({
        changed: true,
        replayed: false,
        result: {
          kind: "committed",
          automationId,
          receipt: { status: "success", matchedRecords: 1, changed: 1 },
        },
      });
      const result = executed.result as {
        kind: "committed";
        receipt: { id: string };
      };
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: true });
      expect(authority.readStore().automationRuns(
        request.payload.simulation.target, automationId)).toEqual([result.receipt]);
      expect(authority.readStore().listNotifications()).toMatchObject([{
        automationId,
        runId: result.receipt.id,
        title: "Onboarded",
        read: false,
      }]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...executed, replayed: true });
      expect(authority.readStore().automationRuns(
        request.payload.simulation.target, automationId)).toHaveLength(1);
      expect(authority.readStore().listNotifications()).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("runs due automations through one authority request and replays the exact run list", async () => {
    const { authority } = await automationAuthority();
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Onboard open deals",
        enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "open" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      const automationId = rule.id;
      const inserted = await authority.executeMutation({
        requestId: authority.createRequestId(),
        route: "store.insert",
        payload: { table: "deals", row: {
          name: "Future match", status: "open", onboarded: false,
        } },
      });
      const insertedId = (inserted.result as { id: string }).id;
      const runTarget = authority.currentAutomationTarget();
      const request = {
        requestId: opaque("req", "h"),
        route: "runDueAutomations",
        payload: {},
      } as const;

      const executed = await authority.executeMutation(request);
      expect(executed).toMatchObject({
        changed: true,
        result: [{ automationId, status: "success", changed: 1 }],
      });
      expect(authority.query({
        from: "deals", where: [{ field: "id", op: "eq", value: insertedId }],
      })[0]).toMatchObject({ onboarded: true });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...executed, replayed: true });
      expect(authority.readStore().automationRuns(runTarget, automationId)).toHaveLength(1);
    } finally {
      authority.close();
    }
  });

  it("keeps simulation read-only and execution at the exact 100-record bound", async () => {
    const { authority } = await automationAuthority(100);
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Onboard exactly one hundred",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      const beforeSimulation = authority.inspectAuthority();
      const request = await authorityRunNowRequest(authority, rule, opaque("req", "j"));

      expect(request.payload.simulation).toMatchObject({
        matchedRecords: 100,
        plannedMutations: 100,
      });
      expect(authority.inspectAuthority()).toEqual(beforeSimulation);
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toEqual([]);

      const executed = await authority.executeMutation(request);
      expect(executed).toMatchObject({
        changed: true,
        result: {
          kind: "committed",
          receipt: { status: "success", matchedRecords: 100, changed: 100 },
        },
      });
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toHaveLength(100);
    } finally {
      authority.close();
    }
  });

  it("fails closed above 100 records before effects, runs, notifications, or receipts", async () => {
    const { authority, driver } = await automationAuthority(100);
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Reject one hundred and one",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [
          { kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } },
          { kind: "notify", title: "Onboarded", body: "The deal was onboarded." },
        ],
      });
      const automationId = rule.id;
      const requestId = opaque("req", "l");
      const request = await authorityRunNowRequest(authority, rule, requestId);
      await authority.executeMutation({
        requestId: authority.createRequestId(),
        route: "store.insert",
        payload: { table: "deals", row: {
          name: "Overflow", status: "open", onboarded: false,
        } },
      });
      const before = authority.inspectAuthority();

      await expect(authority.simulateAutomation({
        id: rule.id,
        expectedRevision: rule.definitionRevision,
        purpose: "run_now",
      })).rejects.toThrow(/100|limit/i);
      await expect(authority.executeMutation(request)).rejects.toThrow(/100|limit|stale|changed/i);

      expect(authority.inspectAuthority()).toEqual(before);
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toEqual([]);
      expect(authority.readStore().automationRuns(
        request.payload.simulation.target, automationId)).toEqual([]);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("fails closed when one run-due request cumulatively exceeds 100 records", async () => {
    const { authority, driver } = await automationAuthority(51, store => {
      for (const deal of store.query({ from: "deals", limit: 100 }))
        store.update("deals", String(deal.id), { status: "won" });
    });
    try {
      await saveAuthorityAutomation(authority, {
        name: "First bounded rule",
        enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "open" }] },
        actions: [{ kind: "set_fields", values: {
          onboarded: { source: "literal", value: true },
        } }],
      });
      await saveAuthorityAutomation(authority, {
        name: "Second bounded rule",
        enabled: true,
        trigger: { kind: "record_matches", table: "deals",
          conditions: [{ field: "status", op: "eq", value: "open" }] },
        actions: [{ kind: "notify", title: "Changed", body: "Must remain absent." }],
      });
      const transition = await saveAuthorityAutomation(authority, {
        name: "Open all deals",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "set_fields", values: {
          status: { source: "literal", value: "open" },
        } }],
      });
      const transitioned = await authority.executeMutation(
        await authorityRunNowRequest(authority, transition),
      );
      expect(transitioned.result).toMatchObject({
        kind: "committed",
        receipt: { status: "success", matchedRecords: 51, changed: 51 },
      });
      const before = authority.inspectAuthority();
      const runTarget = authority.currentAutomationTarget();
      const runsBefore = authority.readStore().automationRuns(runTarget);
      const requestId = opaque("req", "o");

      await expect(authority.executeMutation({
        requestId, route: "runDueAutomations", payload: {},
      })).rejects.toThrow(/100|limit/i);

      expect(authority.inspectAuthority()).toEqual(before);
      expect(authority.query({ from: "deals", where: [
        { field: "onboarded", op: "eq", value: true },
      ], limit: 500 })).toEqual([]);
      expect(authority.readStore().automationRuns(runTarget)).toEqual(runsBefore);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects a stale automation fence before effects, runs, notifications, or receipts", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Stale fence rule",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [
          { kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } },
          { kind: "notify", title: "Changed", body: "Must remain absent." },
        ],
      });
      const automationId = rule.id;
      const targetBeforeTakeover = authority.inspectAuthority().target;
      const reservationsBeforeTakeover = authority.inspectAuthority().targetReservations;
      const requestId = opaque("req", "l");
      const request = await authorityRunNowRequest(authority, rule, requestId);
      armProductionAuthorityFailureForTest(authority, "stale_fence");

      await expect(authority.executeMutation(request))
        .rejects.toMatchObject({ code: "E_STALE_WRITE_EPOCH" });

      expect(authority.inspectAuthority().target).toEqual(targetBeforeTakeover);
      expect(authority.inspectAuthority().targetReservations).toEqual(reservationsBeforeTakeover);
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: false });
      expect(authority.readStore().automationRuns(
        request.payload.simulation.target, automationId)).toEqual([]);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rejects nested automation accessors without invoking them", async () => {
    const { authority, driver } = await automationAuthority();
    let getterCalls = 0;
    const input = {
      enabled: false,
      trigger: { kind: "manual", table: "deals", conditions: [] },
      actions: [{ kind: "notify", title: "Review", body: "Review this deal." }],
    } as Record<string, unknown>;
    Object.defineProperty(input, "name", {
      enumerable: true,
      get() {
        getterCalls++;
        return "Getter rule";
      },
    });
    const requestId = opaque("req", "m");
    try {
      expect(() => authority.executeMutation({
        requestId,
        route: "upsertAutomation",
        payload: { input },
      })).toThrow(/invalid/i);
      expect(getterCalls).toBe(0);
      expect(authority.readStore().listAutomations()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("undoes an automation run through authority with effects and notification dismissal atomic", async () => {
    const { authority } = await automationAuthority();
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Temporary onboarding",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [
          { kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } },
          { kind: "notify", title: "Temporary", body: "Temporary notice." },
        ],
      });
      const automationId = rule.id;
      const runRequest = await authorityRunNowRequest(authority, rule, opaque("req", "o"));
      const executed = await authority.executeMutation(runRequest);
      const execution = executed.result as { kind: "committed"; receipt: { id: string } };
      expect(execution.kind).toBe("committed");
      const runId = execution.receipt.id;
      const request = {
        requestId: opaque("req", "p"),
        route: "undoAutomationRun",
        payload: { id: runId },
      } as const;

      const undone = await authority.executeMutation(request);
      expect(undone).toMatchObject({
        changed: true,
        result: { id: runId, automationId, undone: true },
      });
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: false });
      expect(authority.readStore().automationRuns(
        runRequest.payload.simulation.target, automationId)[0]).toMatchObject({ undone: true });
      expect(authority.readStore().listNotifications()).toEqual([]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...undone, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("marks a notification read through authority and mirrors a replayable canonical no-op", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Notify manually",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "notify", title: "Review", body: "Review this deal." }],
      });
      const runRequest = await authorityRunNowRequest(authority, rule, opaque("req", "r"));
      await authority.executeMutation(runRequest);
      const notificationId = authority.readStore().listNotifications()[0]!.id;
      const request = {
        requestId: opaque("req", "s"),
        route: "markNotificationRead",
        payload: { id: notificationId },
      } as const;

      const marked = await authority.executeMutation(request);
      expect(marked).toMatchObject({ changed: true, result: null });
      expect(authority.readStore().listNotifications()[0]).toMatchObject({
        id: notificationId,
        read: true,
      });
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...marked, replayed: true });

      const beforeUnknown = authority.inspectAuthority();
      const unknownRequest = {
        requestId: opaque("req", "t"),
        route: "markNotificationRead",
        payload: { id: "00000000-0000-7000-8000-000000000000" },
      } as const;
      const unknown = await authority.executeMutation(unknownRequest);
      expect(unknown).toMatchObject({ changed: false, replayed: false, result: null });
      expect(authority.inspectAuthority()).toEqual(beforeUnknown);
      expect(driver.select(
        "SELECT state, response_json FROM sys.production_request_receipts WHERE request_id = ?",
        [unknownRequest.requestId],
      )).toEqual([{
        state: "no_op",
        response_json: "clay-response-v1:markNotificationRead\n{\"result\":null,\"route\":\"markNotificationRead\",\"schema\":1}",
      }]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?",
        [unknownRequest.requestId],
      )).toEqual([{ state: "no_op" }]);
      await expect(authority.executeMutation(unknownRequest))
        .resolves.toEqual({ ...unknown, replayed: true });
      expect(authority.inspectAuthority()).toEqual(beforeUnknown);
    } finally {
      authority.close();
    }
  });

  it("records bounded usage through authority and replays without duplicating observer input", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const requests = ["u", "v", "w"].map(char => ({
        requestId: opaque("req", char),
        route: "recordUsage" as const,
        payload: { event: {
          kind: "filter",
          subject: "board_filter",
          detail: { owner: "Dev" },
        } },
      }));
      await expect(authority.executeMutation(requests[0]!)).resolves.toMatchObject({
        changed: true,
        result: null,
      });
      await expect(authority.executeMutation(requests[0]!)).resolves.toMatchObject({
        changed: true,
        replayed: true,
      });
      for (const request of requests.slice(1)) {
        await expect(authority.executeMutation(request)).resolves.toMatchObject({
          changed: true,
          result: null,
        });
      }
      expect(authority.readStore().suggestions()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "pin_filtered_panel" }),
      ]));
      expect(driver.select("SELECT COUNT(*) AS n FROM sys.usage_events"))
        .toEqual([{ n: 4 }]);
    } finally {
      authority.close();
    }
  });

  it("accepts an observer suggestion through authority and replays its state transition", async () => {
    const { authority, driver } = await automationAuthority(3);
    try {
      const suggestion = authority.readStore().suggestions()
        .find(candidate => candidate.kind === "add_view" && candidate.subject === "deals");
      expect(suggestion).toBeDefined();
      const request = {
        requestId: opaque("req", "x"),
        route: "acceptSuggestion",
        payload: { subject: suggestion!.subject, kind: suggestion!.kind },
      } as const;

      const accepted = await authority.executeMutation(request);
      expect(accepted).toMatchObject({ changed: true, result: null });
      expect(authority.readStore().suggestions()
        .some(candidate => candidate.subject === suggestion!.subject
          && candidate.kind === suggestion!.kind)).toBe(false);
      expect(driver.select(
        "SELECT subject, kind, state FROM sys.suggestions WHERE state = 'accepted'",
      )).toEqual([{ subject: suggestion!.subject, kind: suggestion!.kind, state: "accepted" }]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...accepted, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("dismisses an observer suggestion through authority and persists the dismissal", async () => {
    const { authority, driver } = await automationAuthority(3);
    try {
      const suggestion = authority.readStore().suggestions()
        .find(candidate => candidate.kind === "add_view" && candidate.subject === "deals");
      expect(suggestion).toBeDefined();
      const request = {
        requestId: opaque("req", "y"),
        route: "dismissSuggestion",
        payload: { subject: suggestion!.subject, kind: suggestion!.kind },
      } as const;

      const dismissed = await authority.executeMutation(request);
      expect(dismissed).toMatchObject({ changed: true, result: null });
      expect(authority.readStore().suggestions()
        .some(candidate => candidate.subject === suggestion!.subject
          && candidate.kind === suggestion!.kind)).toBe(false);
      expect(driver.select(
        "SELECT subject, kind, state FROM sys.suggestions WHERE state = 'dismissed'",
      )).toEqual([{ subject: suggestion!.subject, kind: suggestion!.kind, state: "dismissed" }]);
      await expect(authority.executeMutation(request))
        .resolves.toEqual({ ...dismissed, replayed: true });
    } finally {
      authority.close();
    }
  });

  it("records excluded private metrics on the fixed operational authority path", async () => {
    const { authority, driver } = await automationAuthority();
    const request = {
      requestId: opaque("req", "z"),
      route: "recordPrivateMetric",
      payload: { event: { type: "trust_surface_opened", surface: "history" } },
    } as const;
    try {
      const before = authority.inspectAuthority();
      expect(() => authority.executeMutation(request)).toThrow(/invalid/i);
      const recorded = await authority.executeOperationalMetricMutation(request);

      expect(recorded).toMatchObject({ changed: true, replayed: false, result: null });
      expect(authority.readStore().privateMetricsSummary().trust.historyOpened).toBe(1);
      expect(authority.inspectAuthority()).toEqual(before);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [request.requestId],
      )).toEqual([]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [request.requestId],
      )).toEqual([]);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
      expect(authority.inspectAuthority().catalogReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("enforces the exact shared two-megabyte recordUsage capture budget", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const exactPayload = { event: {
        kind: "filter", subject: "boundary_filter",
        detail: { first: "", second: "" },
      } };
      const overhead = new TextEncoder().encode(JSON.stringify(exactPayload)).byteLength;
      exactPayload.event.detail.first = "a".repeat(999_999);
      exactPayload.event.detail.second = "b".repeat(2_000_000 - overhead - 999_999);
      await expect(authority.executeMutation({
        requestId: opaque("req", "2"), route: "recordUsage", payload: exactPayload,
      })).resolves.toMatchObject({ changed: true });

      const rejectedId = opaque("req", "3");
      await expect(Promise.resolve().then(() => authority.executeMutation({
        requestId: rejectedId, route: "recordUsage",
        payload: { event: {
          kind: "filter", subject: "oversized_filter",
          detail: {
            first: "a".repeat(700_000),
            second: "b".repeat(700_000),
            third: "c".repeat(700_000),
          },
        } },
      }))).rejects.toThrow(/limit|exceeds/i);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [rejectedId],
      )).toEqual([]);
      expect(driver.select("SELECT subject FROM sys.usage_events WHERE subject = 'oversized_filter'"))
        .toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("changes private metric collection and classifies an unchanged setting as an operational no-op", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const before = authority.inspectAuthority();
      const disabled = await authority.executeOperationalMetricMutation({
        requestId: opaque("req", "3"),
        route: "setPrivateMetricsEnabled",
        payload: { enabled: false },
      });
      expect(disabled).toMatchObject({
        changed: true,
        replayed: false,
        result: { collectionEnabled: false },
      });
      expect(authority.inspectAuthority()).toEqual(before);

      const noOpRequestId = opaque("req", "4");
      const noOp = await authority.executeOperationalMetricMutation({
        requestId: noOpRequestId,
        route: "setPrivateMetricsEnabled",
        payload: { enabled: false },
      });
      expect(noOp).toMatchObject({
        changed: false,
        replayed: false,
        result: { collectionEnabled: false },
      });
      expect(authority.inspectAuthority()).toEqual(before);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [noOpRequestId],
      )).toEqual([]);

      const ignoredRequestId = opaque("req", "5");
      const ignored = await authority.executeOperationalMetricMutation({
        requestId: ignoredRequestId,
        route: "recordPrivateMetric",
        payload: { event: { type: "trust_surface_opened", surface: "history" } },
      });
      expect(ignored).toMatchObject({ changed: false, result: null });
      expect(authority.readStore().privateMetricsSummary().trust.historyOpened).toBe(0);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [ignoredRequestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("clears private metrics through operational authority and no-ops when empty", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      await authority.executeOperationalMetricMutation({
        requestId: opaque("req", "6"), route: "recordPrivateMetric",
        payload: { event: { type: "trust_surface_opened", surface: "history" } },
      });
      const before = authority.inspectAuthority();
      const cleared = await authority.executeOperationalMetricMutation({
        requestId: opaque("req", "7"), route: "clearPrivateMetrics", payload: {},
      });
      expect(cleared).toMatchObject({
        changed: true,
        result: { collectionEnabled: true, trust: { historyOpened: 0 } },
      });
      expect(authority.inspectAuthority()).toEqual(before);

      const noOpId = opaque("req", "a");
      const noOp = await authority.executeOperationalMetricMutation({
        requestId: noOpId, route: "clearPrivateMetrics", payload: {},
      });
      expect(noOp).toMatchObject({
        changed: false,
        result: { collectionEnabled: true, trust: { historyOpened: 0 } },
      });
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [noOpId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rolls back automation effects, notifications, and run receipts after live execution", async () => {
    const { authority, driver } = await automationAuthority();
    try {
      const rule = await saveAuthorityAutomation(authority, {
        name: "Atomic run", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [
          { kind: "set_fields", values: {
            onboarded: { source: "literal", value: true },
          } },
          { kind: "notify", title: "Changed", body: "Changed atomically." },
        ],
      });
      const automationId = rule.id;
      const requestId = opaque("req", "c");
      const request = await authorityRunNowRequest(authority, rule, requestId);
      armProductionAuthorityFailureForTest(authority, "after_live_mutation");

      await expect(authority.executeMutation(request)).rejects.toThrow(/after live/i);
      expect(authority.query({ from: "deals" })[0]).toMatchObject({ onboarded: false });
      expect(authority.readStore().automationRuns(
        request.payload.simulation.target, automationId)).toEqual([]);
      expect(authority.readStore().listNotifications()).toEqual([]);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([{ state: "failed" }]);
      expect(driver.select(
        "SELECT state FROM catalog.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([{ state: "failed" }]);
      expect(authority.inspectAuthority().targetReservations.at(-1)?.state).toBe("abandoned");
      expect(authority.inspectAuthority().catalogReservations.at(-1)?.state).toBe("abandoned");
    } finally {
      authority.close();
    }
  });

  it("never invokes accessors on any added route payload", async () => {
    const { authority } = await automationAuthority();
    const routes = [
      "upsertAutomation", "deleteAutomation", "runDueAutomations", "runAutomationNow",
      "undoAutomationRun", "markNotificationRead", "recordPrivateMetric",
      "setPrivateMetricsEnabled", "clearPrivateMetrics", "recordUsage",
      "acceptSuggestion", "dismissSuggestion",
    ] as const;
    let reads = 0;
    try {
      const privateRoutes = new Set<string>([
        "recordPrivateMetric", "setPrivateMetricsEnabled", "clearPrivateMetrics",
      ]);
      for (const route of routes) {
        const payload: Record<string, unknown> = {};
        Object.defineProperty(payload, "hostile", {
          enumerable: true,
          get: () => { reads++; return "must not be read"; },
        });
        const execute = (): Promise<unknown> => privateRoutes.has(route)
          ? authority.executeOperationalMetricMutation({
              requestId: opaque("req", "d"), route, payload,
            })
          : authority.executeMutation({ requestId: opaque("req", "d"), route, payload });
        expect(execute).toThrow(/invalid/i);
      }
      expect(reads).toBe(0);
      expect(authority.inspectAuthority().targetReservations).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("accepts only dense standard arrays and plain enumerable data records", async () => {
    const { authority } = await automationAuthority();
    try {
      const base = {
        name: "Shape check", enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
      };
      const sparseActions = new Array(1);
      const symbolic = { ...base, actions: [] as unknown[] } as Record<PropertyKey, unknown>;
      symbolic[Symbol("hidden")] = true;
      const nonEnumerable = { ...base, actions: [] as unknown[] };
      Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
      const cases: unknown[] = [
        { ...base, actions: sparseActions }, symbolic, nonEnumerable,
      ];
      for (const input of cases) expect(() => authority.executeMutation({
        requestId: opaque("req", "e"), route: "upsertAutomation", payload: { input },
      })).toThrow(/invalid|limits/i);
      expect(authority.readStore().listAutomations()).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("rolls back a fixed operational metric after its live write when physical authority fails", async () => {
    const { authority, driver } = await automationAuthority();
    const before = authority.inspectAuthority();
    const requestId = opaque("req", "f");
    try {
      armProductionAuthorityFailureForTest(authority, "after_live_mutation");
      await expect(authority.executeOperationalMetricMutation({
        requestId, route: "recordPrivateMetric",
        payload: { event: { type: "trust_surface_opened", surface: "history" } },
      })).rejects.toThrow(/after live/i);
      expect(authority.readStore().privateMetricsSummary().trust.historyOpened).toBe(0);
      expect(authority.inspectAuthority()).toEqual(before);
      expect(driver.select(
        "SELECT state FROM sys.production_request_receipts WHERE request_id = ?", [requestId],
      )).toEqual([]);
    } finally {
      authority.close();
    }
  });

  it("keeps production automation mutation routes closed without a release-bound transaction capability", async () => {
    const { authority, store } = await automationAuthority();
    try {
      const target = authority.inspectAuthority().target;
      expect(() => executeAutomationObserverAuthorityRoute(
        store,
        "runDueAutomations",
        {},
        new Date().toISOString(),
        {
          v: 1,
          appInstanceId: target.appInstanceId,
          activeGenerationId: target.activeGenerationId,
          lineageEpoch: target.lineageEpoch,
          stateRevision: target.protectionRevision,
          stateDigest: target.stateSha256,
        },
        { kind: "unavailable", releaseCertificate: false },
      )).toThrow(/transaction.*uncertified|release.*certificate|unavailable/i);
      expect(authority.readStore().automationRuns({
        v: 1,
        appInstanceId: target.appInstanceId,
        activeGenerationId: target.activeGenerationId,
        lineageEpoch: target.lineageEpoch,
        stateRevision: target.protectionRevision,
        stateDigest: target.stateSha256,
      })).toEqual([]);
    } finally {
      authority.close();
    }
  });
});
