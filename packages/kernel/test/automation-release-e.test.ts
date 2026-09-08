import { describe, expect, it } from "vitest";
import {
  ClayStore, deriveInverse, openMemoryDriver, stableAutomationJson,
  validateAutomationSimulationProof,
  type AutomationDraftInputV2, type AutomationTargetIdentityV1, type DbDriver, type ForwardOpT,
} from "../src/index";

const TARGET: AutomationTargetIdentityV1 = {
  v: 1,
  appInstanceId: "app_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  activeGenerationId: "gen_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  lineageEpoch: "3",
  stateRevision: "7",
  stateDigest: `sha256:${"c".repeat(64)}`,
};

function commit(store: ClayStore, operations: ForwardOpT[]): void {
  store.commit({
    intent: "release E fixture",
    summary: "Create release E fixture.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
}

async function fixtureWithDriver(): Promise<{ store: ClayStore; driver: DbDriver }> {
  const driver = await openMemoryDriver();
  const store = ClayStore.fromDriver(driver);
  commit(store, [
    { op: "create_table", table: "deals", columns: [
      { name: "name", type: "text", required: true },
      { name: "stage", type: "enum", required: false, values: ["open", "won"] },
      { name: "followed_up", type: "boolean", required: false },
      { name: "due", type: "date", required: false },
    ] },
    { op: "create_table", table: "tasks", columns: [
      { name: "title", type: "text", required: true },
      { name: "deal", type: "relation", required: false,
        relation: { target_table: "deals", cardinality: "one",
          unique_targets: false, display_field: "name" } },
    ] },
  ]);
  return { store, driver };
}

async function fixture(): Promise<ClayStore> {
  return (await fixtureWithDriver()).store;
}

async function releaseECandidate(store: ClayStore, followedUpValue = false): Promise<{
  saved: ReturnType<ClayStore["saveAutomationDraft"]>;
  simulation: ReturnType<ClayStore["simulateAutomation"]>;
}> {
  store.insert("deals", { name: "Acme", stage: "won", followed_up: followedUpValue });
  const trace = store.semanticSchemaTrace();
  const table = trace.tables.find(item => item.name === "deals")!;
  const stage = trace.fields.find(item => item.tableId === table.tableId
    && item.fieldName === "stage")!;
  const followedUp = trace.fields.find(item => item.tableId === table.tableId
    && item.fieldName === "followed_up")!;
  const saved = store.saveAutomationDraft({
    v: 2,
    name: "Follow up won deals",
    trigger: {
      kind: "record_matches",
      table: { tableId: table.tableId, lastKnownName: "deals" },
      conditions: [{
        field: { tableId: table.tableId, fieldId: stage.fieldId, lastKnownName: "stage" },
        op: "eq",
        value: "won",
      }],
    },
    actions: [{
      kind: "set_fields",
      values: [{
        field: {
          tableId: table.tableId,
          fieldId: followedUp.fieldId,
          lastKnownName: "followed_up",
        },
        value: { source: "literal", value: true },
      }],
    }],
    runtime: { mode: "local" },
  }, undefined, new Date("2026-09-06T12:00:00.000Z"));
  const simulation = store.simulateAutomation({
    id: saved.id,
    target: TARGET,
    expectedRevision: saved.definitionRevision,
    purpose: "enable",
  }, new Date("2026-09-06T12:01:00.000Z"));
  return { saved, simulation };
}

describe("Release E automation contract", () => {
  it("saves a disabled stable-ID recipe draft and simulates an exact target-bound plan", async () => {
    const store = await fixture();
    try {
      store.insert("deals", {
        name: "Northwind", stage: "won", followed_up: false, due: "2026-09-08",
      });
      const trace = store.semanticSchemaTrace();
      const table = trace.tables.find(item => item.name === "deals")!;
      const stage = trace.fields.find(item =>
        item.tableId === table.tableId && item.fieldName === "stage")!;
      const followedUp = trace.fields.find(item =>
        item.tableId === table.tableId && item.fieldName === "followed_up")!;
      const draft: AutomationDraftInputV2 = {
        v: 2,
        name: "Follow up won deals",
        recipe: { id: "new_customer_follow_up", version: 1 },
        trigger: {
          kind: "record_matches",
          table: { tableId: table.tableId, lastKnownName: "not-authority" },
          conditions: [{
            field: {
              tableId: table.tableId,
              fieldId: stage.fieldId,
              lastKnownName: "also-not-authority",
            },
            op: "eq",
            value: "won",
          }],
        },
        actions: [{
          kind: "set_fields",
          values: [{
            field: {
              tableId: table.tableId,
              fieldId: followedUp.fieldId,
              lastKnownName: "ignored-label",
            },
            value: { source: "literal", value: true },
          }],
        }],
        runtime: { mode: "local" },
      };

      const saved = store.saveAutomationDraft(draft, undefined,
        new Date("2026-09-06T12:00:00.000Z"));
      expect(saved).toMatchObject({
        v: 2,
        state: "draft",
        enabled: false,
        definitionRevision: 1,
        recipe: { id: "new_customer_follow_up", version: 1 },
      });

      const proof = store.simulateAutomation({
        id: saved.id,
        target: TARGET,
        expectedRevision: 1,
        purpose: "enable",
      }, new Date("2026-09-06T12:01:00.000Z"));
      expect(proof).toMatchObject({
        v: 1,
        target: TARGET,
        automationId: saved.id,
        definitionRevision: 1,
        purpose: "enable",
        evaluatedAt: "2026-09-06T12:01:00.000Z",
        matchedRecords: 1,
        matchedScope: { kind: "records", recordIds: [expect.any(String)] },
        plannedMutations: 1,
        plannedNotifications: 0,
        plannedEffects: [{ kind: "set_fields", count: 1 }],
      });
      expect(proof.id).toMatch(/^asim_[0-9a-f]{64}$/);
      expect(proof.definitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(proof.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(store.query({ from: "deals" })[0]).toMatchObject({ followed_up: false });
    } finally {
      store.close();
    }
  });

  it("keeps execution identity stable across label renames and resolves only by semantic IDs", async () => {
    const store = await fixture();
    try {
      const prepared = await releaseECandidate(store);
      const before = store.simulateAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        purpose: "proposal_review",
      }, new Date("2026-09-06T15:00:00.000Z"));

      commit(store, [{ op: "rename_column", table: "deals", from: "stage", to: "phase" }]);
      const after = store.simulateAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        purpose: "proposal_review",
      }, new Date("2026-09-06T15:00:00.000Z"));

      expect(after.schemaRevision).toBe(before.schemaRevision + 1);
      expect(after.definitionDigest).toBe(before.definitionDigest);
      expect(after.referenceFingerprint).toBe(before.referenceFingerprint);
      expect(after.matchedRecords).toBe(1);
      expect(store.listAutomations()[0]).toMatchObject({
        v: 2,
        trigger: { conditions: [{ field: {
          fieldId: prepared.saved.trigger.kind === "record_matches"
            ? prepared.saved.trigger.conditions[0]!.field.fieldId : "",
          lastKnownName: "phase",
        } }] },
      });
    } finally {
      store.close();
    }
  });

  it("rolls back an incompatible schema change instead of orphaning a stable automation reference", async () => {
    const store = await fixture();
    try {
      const prepared = await releaseECandidate(store);
      const beforeVersion = store.currentVersion();
      const before = store.listAutomations();
      const operations: ForwardOpT[] = [
        { op: "hide_column", table: "deals", column: "followed_up" },
      ];

      expect(() => store.commit({
        intent: "hide the automated field",
        summary: "Would hide a field still used by a rule.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      })).toThrow(/automation|stable|field|schema/i);
      expect(store.currentVersion()).toBe(beforeVersion);
      expect(store.registrySnapshot().get("deals")!.columns
        .find(column => column.name === "followed_up")?.hidden).not.toBe(true);
      expect(store.listAutomations()).toEqual(before);
      expect(store.listAutomations()[0]).toMatchObject({ id: prepared.saved.id, needsRepair: false });
    } finally {
      store.close();
    }
  });

  it("offers three structurally eligible recipes and saves each provenance-bound draft disabled", async () => {
    const store = await fixture();
    try {
      const catalog = store.automationRecipes();
      expect(catalog.map(recipe => recipe.id)).toEqual([
        "overdue_invoice_reminder",
        "weekly_checklist",
        "new_customer_follow_up",
      ]);
      expect(catalog.every(recipe => recipe.version === 1 && recipe.options.length > 0)).toBe(true);

      const overdue = catalog.find(recipe => recipe.id === "overdue_invoice_reminder")!;
      const overdueOption = overdue.options[0]!;
      if (overdueOption.kind !== "overdue_invoice_reminder") throw new Error("recipe shape changed");
      const weekly = catalog.find(recipe => recipe.id === "weekly_checklist")!;
      const weeklyOption = weekly.options.find(option => option.kind === "weekly_checklist"
        && option.writableFields.some(field => field.lastKnownName === "title"))!;
      if (weeklyOption.kind !== "weekly_checklist") throw new Error("recipe shape changed");
      const followUp = catalog.find(recipe => recipe.id === "new_customer_follow_up")!;
      const followUpOption = followUp.options[0]!;
      if (followUpOption.kind !== "new_customer_follow_up") throw new Error("recipe shape changed");

      const drafts = [
        store.saveAutomationRecipeDraft({
          v: 1,
          recipeId: "overdue_invoice_reminder",
          recipeVersion: 1,
          mapping: {
            sourceTableId: overdueOption.source.tableId,
            dateFieldId: overdueOption.dateFields[0]!.fieldId,
            conditionFieldId: overdueOption.conditionFields
              .find(field => field.lastKnownName === "stage")!.fieldId,
            conditionValue: "open",
            daysBefore: 0,
          },
        }, new Date("2026-09-06T13:00:00.000Z")),
        store.saveAutomationRecipeDraft({
          v: 1,
          recipeId: "weekly_checklist",
          recipeVersion: 1,
          mapping: {
            targetTableId: weeklyOption.target.tableId,
            titleFieldId: weeklyOption.writableFields
              .find(field => field.lastKnownName === "title")!.fieldId,
            title: "Review the week",
            weekday: 1,
            localTime: "09:00",
            timeZone: "America/New_York",
          },
        }, new Date("2026-09-06T13:00:01.000Z")),
        store.saveAutomationRecipeDraft({
          v: 1,
          recipeId: "new_customer_follow_up",
          recipeVersion: 1,
          mapping: {
            sourceTableId: followUpOption.source.tableId,
            targetTableId: followUpOption.target.tableId,
            relationFieldId: followUpOption.relationField.fieldId,
            titleFieldId: followUpOption.writableFields[0]!.fieldId,
            title: "Prepare follow-up",
          },
        }, new Date("2026-09-06T13:00:02.000Z")),
      ];

      expect(drafts).toHaveLength(3);
      expect(drafts.map(draft => draft.recipe?.id)).toEqual(catalog.map(recipe => recipe.id));
      expect(drafts.every(draft => draft.v === 2 && draft.state === "draft"
        && draft.enabled === false && draft.enableProof === null)).toBe(true);
      expect(store.query({ from: "tasks" })).toEqual([]);
      expect(store.automationRuns(TARGET)).toEqual([]);
      expect(store.listNotifications()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("does not offer one-field create recipes for tables with additional required fields", async () => {
    const store = await fixture();
    try {
      commit(store, [{ op: "create_table", table: "strict_tasks", columns: [
        { name: "title", type: "text", required: true },
        { name: "owner", type: "text", required: true },
      ] }]);
      const weekly = store.automationRecipes().find(recipe => recipe.id === "weekly_checklist")!;
      expect(weekly.options.some(option => option.kind === "weekly_checklist"
        && option.target.lastKnownName === "strict_tasks")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("commits exactly 100 proof-matched records as one undoable batch", async () => {
    const store = await fixture();
    try {
      const prepared = await releaseECandidate(store);
      for (let index = 1; index < 100; index++) store.insert("deals", {
        name: `Deal ${index}`, stage: "won", followed_up: false,
      });
      const simulation = store.simulateAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        purpose: "run_now",
      }, new Date("2026-09-06T16:00:00.000Z"));
      expect(simulation).toMatchObject({ matchedRecords: 100, plannedMutations: 100 });

      const result = store.runAutomationNow({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation,
      }, new Date("2026-09-06T16:01:00.000Z"));
      if (result.kind !== "committed") throw new Error("expected a committed run");
      expect(result.receipt).toMatchObject({ status: "success", matchedRecords: 100, changed: 100 });
      expect(result.receipt.batchId).not.toBeNull();
      expect(store.query({ from: "deals", where: [
        { field: "followed_up", op: "eq", value: true },
      ], limit: 100 })).toHaveLength(100);

      store.undoAutomationRun({ id: result.receipt.id, target: TARGET });
      expect(store.query({ from: "deals", where: [
        { field: "followed_up", op: "eq", value: true },
      ], limit: 100 })).toHaveLength(0);
      expect(store.automationRuns(TARGET, prepared.saved.id)[0]).toMatchObject({ undone: true });
    } finally {
      store.close();
    }
  });

  it("rejects the 101st proof-matched record before any execution write", async () => {
    const store = await fixture();
    try {
      const prepared = await releaseECandidate(store);
      for (let index = 1; index < 100; index++) store.insert("deals", {
        name: `Deal ${index}`, stage: "won", followed_up: false,
      });
      const simulation = store.simulateAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        purpose: "run_now",
      }, new Date("2026-09-06T16:00:00.000Z"));
      store.insert("deals", { name: "Overflow", stage: "won", followed_up: false });

      expect(() => store.runAutomationNow({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation,
      }, new Date("2026-09-06T16:01:00.000Z"))).toThrow(/100|limit|stale/i);
      expect(store.automationRuns(TARGET)).toEqual([]);
      expect(store.operationBatches()).toEqual([]);
      expect(store.query({ from: "deals", where: [
        { field: "followed_up", op: "eq", value: true },
      ], limit: 100 })).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("returns the sole write-free no-op result for a proof-bound run with no retained effect", async () => {
    const store = await fixture();
    try {
      const prepared = await releaseECandidate(store, true);
      const simulation = store.simulateAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        purpose: "run_now",
      }, new Date("2026-09-06T14:00:00.000Z"));
      const eventsBefore = store.query({ from: "deals" })[0]!.updated_at;

      const result = store.runAutomationNow({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation,
      }, new Date("2026-09-06T14:01:00.000Z"));

      expect(result).toEqual({
        v: 1,
        kind: "no_op",
        target: TARGET,
        automationId: prepared.saved.id,
        reasonCode: "NO_ACTUAL_RETAINED_MUTATION",
        evaluatedAt: "2026-09-06T14:01:00.000Z",
      });
      expect("changed" in result).toBe(false);
      expect(store.automationRuns(TARGET)).toEqual([]);
      expect(store.operationBatches()).toEqual([]);
      expect(store.listNotifications()).toEqual([]);
      expect(store.query({ from: "deals" })[0]!.updated_at).toBe(eventsBefore);
    } finally {
      store.close();
    }
  });

  it("reports current local worker-session limits without implying background execution", async () => {
    const store = await fixture();
    try {
      const legacyDriverRule = store.upsertAutomation({
        name: "Disabled legacy draft",
        enabled: false,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "notify", title: "Review", body: "Review." }],
      });
      expect(legacyDriverRule.enabled).toBe(false);

      expect(store.automationRuntimeStatus(TARGET)).toEqual({
        v: 1,
        engine: "local_worker_session",
        sessionActive: true,
        backgroundExecution: false,
        offDeviceExecution: false,
        modelAccess: false,
        networkAccess: false,
        headline: "Automations run on this device while Clay is open.",
        detail: "If Clay is closed or this device sleeps, scheduled work waits until a Clay session is available.",
        enabledDefinitions: 0,
        disabledDefinitions: 1,
        needsRepairDefinitions: 1,
      });
    } finally {
      store.close();
    }
  });

  it("projects trusted last, next, skip, failure, and conflict-aware undo state", async () => {
    const { store, driver } = await fixtureWithDriver();
    try {
      const prepared = await releaseECandidate(store);
      expect(store.automationRuntimeOverview(TARGET)).toMatchObject({
        v: 1,
        rules: [{
          automationId: prepared.saved.id,
          lastRunId: null,
          next: { kind: "event", detail: expect.stringMatching(/newly matches.*Clay is open/i) },
          skip: { code: "DRAFT_DISABLED", detail: expect.stringMatching(/disabled.*simulation/i) },
        }],
        runs: [],
      });

      const simulation = store.simulateAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        purpose: "run_now",
      }, new Date("2026-09-06T12:02:00.000Z"));
      const execution = store.runAutomationNow({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation,
      }, new Date("2026-09-06T12:03:00.000Z"));
      expect(execution.kind).toBe("committed");
      if (execution.kind !== "committed") throw new Error("expected committed automation run");

      expect(store.automationRuntimeOverview(TARGET)).toMatchObject({
        rules: [{ automationId: prepared.saved.id, lastRunId: execution.receipt.id }],
        runs: [{
          runId: execution.receipt.id,
          failure: null,
          undo: { available: true, reason: "AVAILABLE" },
        }],
      });

      const source = store.query({ from: "deals", limit: 1 })[0]!;
      store.update("deals", String(source.id), { name: "Acme changed later" });
      expect(store.automationRuntimeOverview(TARGET).runs[0]).toMatchObject({
        runId: execution.receipt.id,
        undo: { available: false, reason: "RECORD_CHANGED" },
      });

      const failedRunId = "018f0000-0000-7000-8000-0000000000ff";
      driver.exec(
        `INSERT INTO sys.automation_runs(
           id, automation_id, at, trigger_key, status, matched_count, changed_count,
           batch_id, error_code, undone_at, target_json, definition_revision,
           definition_digest, trigger_kind)
         VALUES (?, ?, ?, ?, 'failed', 1, 0, NULL, 'E_VALIDATION', NULL, ?, ?, ?, ?)`,
        [failedRunId, prepared.saved.id, "2026-09-06T12:04:00.000Z", "fault:test",
         stableAutomationJson(TARGET), prepared.saved.definitionRevision,
         prepared.simulation.definitionDigest, prepared.saved.trigger.kind],
      );
      const failedOverview = store.automationRuntimeOverview(TARGET);
      expect(failedOverview.rules).toMatchObject([
        { automationId: prepared.saved.id, lastRunId: failedRunId },
      ]);
      expect(failedOverview.runs[0]).toMatchObject({
        runId: failedRunId,
        failure: { code: "E_VALIDATION", detail: expect.stringMatching(/no partial changes/i) },
        undo: { available: false, reason: "RUN_FAILED" },
      });
    } finally {
      store.close();
    }
  });

  it("runs and deduplicates a weekly local schedule in its declared IANA timezone", async () => {
    const store = await fixture();
    try {
      const trace = store.semanticSchemaTrace();
      const tasks = trace.tables.find(item => item.name === "tasks")!;
      const title = trace.fields.find(item => item.tableId === tasks.tableId
        && item.fieldName === "title")!;
      const saved = store.saveAutomationDraft({
        v: 2,
        name: "Auckland Monday checklist",
        trigger: { kind: "schedule", cadence: "weekly", weekday: 1, localTime: "09:00" },
        actions: [{
          kind: "create_record",
          table: { tableId: tasks.tableId, lastKnownName: "tasks" },
          values: [{
            field: { tableId: tasks.tableId, fieldId: title.fieldId, lastKnownName: "title" },
            value: { source: "literal", value: "Review the week" },
          }],
        }],
        runtime: { mode: "local", timeZone: "Pacific/Auckland" },
      }, undefined, new Date("2026-09-06T20:00:00.000Z"));
      const simulation = store.simulateAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision, purpose: "enable",
      }, new Date("2026-09-06T20:01:00.000Z"));
      store.enableAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision, simulation,
      }, new Date("2026-09-06T20:02:00.000Z"));

      const mondayInAuckland = new Date("2026-09-06T21:05:00.000Z");
      const runs = store.runDueAutomations(TARGET, mondayInAuckland);
      expect(runs).toMatchObject([
        { automationId: saved.id, status: "success", matchedRecords: 1, changed: 1 },
      ]);
      expect(store.runDueAutomations(TARGET, mondayInAuckland)).toEqual([]);
      expect(store.query({ from: "tasks", select: ["title"] })).toEqual([
        { title: "Review the week" },
      ]);

      const task = store.query({ from: "tasks", limit: 1 })[0]!;
      store.update("tasks", String(task.id), { title: "Edited after automation" });
      expect(store.automationRuntimeOverview(TARGET).runs
        .find(state => state.runId === runs[0]!.id)?.undo).toMatchObject({
        available: false,
        reason: "RECORD_CHANGED",
      });
      expect(() => store.undoAutomationRun({ id: runs[0]!.id, target: TARGET }))
        .toThrow(/changed|conflict/i);
      expect(store.query({ from: "tasks", select: ["title"] })).toEqual([
        { title: "Edited after automation" },
      ]);
    } finally {
      store.close();
    }
  });

  it("truthfully skips an expired skip-policy schedule window and reports why", async () => {
    const store = await fixture();
    try {
      const trace = store.semanticSchemaTrace();
      const tasks = trace.tables.find(item => item.name === "tasks")!;
      const title = trace.fields.find(item => item.tableId === tasks.tableId
        && item.fieldName === "title")!;
      const saved = store.saveAutomationDraft({
        v: 2,
        name: "Exact-window checklist",
        trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
        actions: [{ kind: "create_record", table: {
          tableId: tasks.tableId, lastKnownName: "tasks",
        }, values: [{ field: {
          tableId: tasks.tableId, fieldId: title.fieldId, lastKnownName: "title",
        }, value: { source: "literal", value: "Review" } }] }],
        runtime: { mode: "local", timeZone: "UTC", missedPolicy: "skip" },
      });
      const simulation = store.simulateAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision, purpose: "enable",
      }, new Date("2026-09-06T08:55:00.000Z"));
      store.enableAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision, simulation,
      }, new Date("2026-09-06T08:56:00.000Z"));

      const missed = new Date("2026-09-06T09:01:00.000Z");
      expect(store.runDueAutomations(TARGET, missed)).toEqual([]);
      expect(store.automationRuntimeOverview(TARGET, 100, missed).rules[0]?.skip).toMatchObject({
        code: "MISSED_SCHEDULE_WINDOW",
        detail: expect.stringMatching(/09:00.*passed.*skip/i),
      });
      expect(store.query({ from: "tasks" })).toEqual([]);

      const nextWindow = new Date("2026-09-07T09:00:30.000Z");
      expect(store.runDueAutomations(TARGET, nextWindow)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects an unknown local schedule timezone when saving the draft", async () => {
    const store = await fixture();
    try {
      const trace = store.semanticSchemaTrace();
      const tasks = trace.tables.find(item => item.name === "tasks")!;
      const title = trace.fields.find(item => item.tableId === tasks.tableId
        && item.fieldName === "title")!;
      expect(() => store.saveAutomationDraft({
        v: 2,
        name: "Unknown-zone checklist",
        trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
        actions: [{
          kind: "create_record",
          table: { tableId: tasks.tableId, lastKnownName: "tasks" },
          values: [{ field: {
            tableId: tasks.tableId, fieldId: title.fieldId, lastKnownName: "title",
          }, value: { source: "literal", value: "Review" } }],
        }],
        runtime: { mode: "local", timeZone: "Mars/Olympus_Mons" },
      })).toThrow(/timezone/i);
      expect(store.listAutomations()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("evaluates date-due rules against the rule timezone calendar day", async () => {
    const store = await fixture();
    try {
      store.insert("deals", { name: "Southern", stage: "open", due: "2026-09-07" });
      const trace = store.semanticSchemaTrace();
      const deals = trace.tables.find(item => item.name === "deals")!;
      const due = trace.fields.find(item => item.tableId === deals.tableId
        && item.fieldName === "due")!;
      const saved = store.saveAutomationDraft({
        v: 2,
        name: "Auckland due reminder",
        trigger: {
          kind: "date_due",
          table: { tableId: deals.tableId, lastKnownName: "deals" },
          dateField: { tableId: deals.tableId, fieldId: due.fieldId, lastKnownName: "due" },
          daysBefore: 0,
          conditions: [],
        },
        actions: [{ kind: "notify", title: "Due", body: "This is due today." }],
        runtime: { mode: "local", timeZone: "Pacific/Auckland" },
      });
      const mondayInAuckland = new Date("2026-09-06T12:30:00.000Z");
      expect(store.simulateAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision, purpose: "run_now",
      }, mondayInAuckland)).toMatchObject({ matchedRecords: 1, plannedNotifications: 1 });
    } finally {
      store.close();
    }
  });

  it("enables only through an exact current proof and records a kernel-issued CAS proof", async () => {
    const store = await fixture();
    try {
      store.insert("deals", { name: "Acme", stage: "won", followed_up: false });
      const trace = store.semanticSchemaTrace();
      const table = trace.tables.find(item => item.name === "deals")!;
      const stage = trace.fields.find(item => item.tableId === table.tableId
        && item.fieldName === "stage")!;
      const followedUp = trace.fields.find(item => item.tableId === table.tableId
        && item.fieldName === "followed_up")!;
      const saved = store.saveAutomationDraft({
        v: 2,
        name: "Follow up won deals",
        trigger: {
          kind: "record_matches",
          table: { tableId: table.tableId, lastKnownName: "deals" },
          conditions: [{
            field: { tableId: table.tableId, fieldId: stage.fieldId, lastKnownName: "stage" },
            op: "eq",
            value: "won",
          }],
        },
        actions: [{
          kind: "set_fields",
          values: [{
            field: {
              tableId: table.tableId,
              fieldId: followedUp.fieldId,
              lastKnownName: "followed_up",
            },
            value: { source: "literal", value: true },
          }],
        }],
        runtime: { mode: "local" },
      }, undefined, new Date("2026-09-06T12:00:00.000Z"));
      const simulation = store.simulateAutomation({
        id: saved.id,
        target: TARGET,
        expectedRevision: saved.definitionRevision,
        purpose: "enable",
      }, new Date("2026-09-06T12:01:00.000Z"));

      const enabled = store.enableAutomation({
        id: saved.id,
        target: TARGET,
        expectedRevision: saved.definitionRevision,
        simulation,
      }, new Date("2026-09-06T12:02:00.000Z"));

      expect(enabled).toMatchObject({
        v: 2,
        id: saved.id,
        state: "enabled",
        enabled: true,
        definitionRevision: 1,
        enableProof: {
          v: 1,
          target: TARGET,
          automationId: saved.id,
          simulationId: simulation.id,
          definitionRevision: 1,
          definitionDigest: simulation.definitionDigest,
          issuedAt: "2026-09-06T12:02:00.000Z",
        },
      });
      expect(enabled.enableProof?.id).toMatch(/^aep_[0-9a-f]{64}$/);
    } finally {
      store.close();
    }
  });

  it("strictly validates the complete simulation proof shape and self-digest", async () => {
    const store = await fixture();
    try {
      const prepared = await releaseECandidate(store);
      expect(validateAutomationSimulationProof(prepared.simulation)).toEqual(prepared.simulation);

      const wrongCount = structuredClone(prepared.simulation) as unknown as Record<string, unknown>;
      wrongCount.matchedRecords = "1";
      expect(() => validateAutomationSimulationProof(wrongCount)).toThrow(/simulation proof/i);

      const duplicateScope = structuredClone(prepared.simulation) as unknown as Record<string, unknown>;
      const scope = duplicateScope.matchedScope as { recordIds: string[] };
      scope.recordIds.push(scope.recordIds[0]!);
      expect(() => validateAutomationSimulationProof(duplicateScope)).toThrow(/simulation proof/i);

      const forged = structuredClone(prepared.simulation) as unknown as Record<string, unknown>;
      forged.id = `asim_${"0".repeat(64)}`;
      expect(() => validateAutomationSimulationProof(forged)).toThrow(/digest|simulation proof/i);
    } finally {
      store.close();
    }
  });

  it.each(["edit", "schema", "target", "revision", "time", "limit"] as const)(
    "fails closed with zero enable writes on %s drift",
    async drift => {
      const store = await fixture();
      try {
        const prepared = await releaseECandidate(store);
        let expectedRevision = prepared.saved.definitionRevision;
        let target = TARGET;
        let enableAt = new Date("2026-09-06T12:02:00.000Z");
        if (drift === "edit") {
          const action = prepared.saved.actions[0]!;
          if (action.kind !== "set_fields") throw new Error("fixture action changed");
          const edited = store.saveAutomationDraft({
            v: 2,
            id: prepared.saved.id,
            name: prepared.saved.name,
            trigger: prepared.saved.trigger,
            actions: [{
              ...action,
              values: action.values.map(item => ({
                ...item,
                value: { source: "literal" as const, value: false },
              })),
            }],
            runtime: prepared.saved.runtime,
          }, prepared.saved.definitionRevision, new Date("2026-09-06T12:01:30.000Z"));
          expectedRevision = edited.definitionRevision;
        } else if (drift === "schema") {
          commit(store, [{ op: "rename_column", table: "deals", from: "due", to: "deadline" }]);
        } else if (drift === "target") {
          target = { ...TARGET, stateDigest: `sha256:${"e".repeat(64)}` };
        } else if (drift === "revision") {
          expectedRevision += 1;
        } else if (drift === "time") {
          enableAt = new Date("2026-09-06T12:07:00.001Z");
        } else {
          for (let index = 0; index < 100; index++) {
            store.insert("deals", {
              name: `Overflow ${index}`,
              stage: "won",
              followed_up: false,
            });
          }
        }
        const beforeAttempt = store.listAutomations();

        expect(() => store.enableAutomation({
          id: prepared.saved.id,
          target,
          expectedRevision,
          simulation: prepared.simulation,
        }, enableAt)).toThrow(/stale|changed|expired|limit|100|revision|target/i);

        expect(store.listAutomations()).toEqual(beforeAttempt);
        expect(store.listAutomations()[0]).toMatchObject({ state: "draft", enabled: false });
      } finally {
        store.close();
      }
    },
  );

  it("rejects direct enabled=true instead of treating generic upsert as authority", async () => {
    const store = await fixture();
    try {
      expect(() => store.upsertAutomation({
        name: "Bypass simulation",
        enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "notify", title: "Unsafe", body: "Must not enable." }],
      })).toThrow(/enable|simulation|proof/i);
      expect(store.listAutomations()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("projects legacy V1 rows as disabled needs-repair definitions without rewriting them", async () => {
    const driver = await openMemoryDriver();
    const store = ClayStore.fromDriver(driver);
    try {
      commit(store, [{ op: "create_table", table: "deals", columns: [
        { name: "name", type: "text", required: true },
      ] }]);
      const id = `auto_${"d".repeat(32)}`;
      const legacy = JSON.stringify({
        id,
        name: "Legacy enabled rule",
        enabled: true,
        trigger: { kind: "manual", table: "deals", conditions: [] },
        actions: [{ kind: "notify", title: "Review", body: "Review the deal." }],
      });
      driver.exec(
        `INSERT INTO sys.automations(id, definition_json, created_at, updated_at, last_event_seq)
         VALUES (?, ?, ?, ?, 0)`,
        [id, legacy, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
      );

      expect(store.listAutomations()).toMatchObject([{
        v: 1,
        id,
        name: "Legacy enabled rule",
        enabled: false,
        persistedEnabled: true,
        definitionRevision: 0,
        state: "paused",
        needsRepair: true,
        repairReason: "REVIEW_REQUIRED_AFTER_UPGRADE",
      }]);
      expect(driver.select(
        `SELECT definition_json FROM sys.automations WHERE id = ?`, [id],
      )).toEqual([{ definition_json: legacy }]);
      expect(store.runDueAutomations(TARGET, new Date("2026-09-06T12:00:00.000Z"))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("repairs a legacy rule in place as a disabled V2 draft that still requires simulation", async () => {
    const { store, driver } = await fixtureWithDriver();
    try {
      const id = `auto_${"b".repeat(32)}`;
      const at = "2026-09-01T12:00:00.000Z";
      driver.exec(
        `INSERT INTO sys.automations(id, definition_json, created_at, updated_at, last_event_seq)
         VALUES (?, ?, ?, ?, 0)`,
        [id, JSON.stringify({
          id,
          name: "Legacy won-deal reminder",
          enabled: true,
          trigger: { kind: "record_matches", table: "deals",
            conditions: [{ field: "stage", op: "eq", value: "won" }] },
          actions: [{ kind: "notify", title: "Legacy", body: "Review this deal." }],
        }), at, at],
      );
      const trace = store.semanticSchemaTrace();
      const deals = trace.tables.find(item => item.name === "deals")!;
      const stage = trace.fields.find(item => item.tableId === deals.tableId
        && item.fieldName === "stage")!;

      const repaired = store.saveAutomationDraft({
        v: 2,
        id,
        name: "Won-deal reminder",
        trigger: {
          kind: "record_matches",
          table: { tableId: deals.tableId, lastKnownName: "deals" },
          conditions: [{
            field: { tableId: deals.tableId, fieldId: stage.fieldId, lastKnownName: "stage" },
            op: "eq",
            value: "won",
          }],
        },
        actions: [{ kind: "notify", title: "Won", body: "Review this deal." }],
        runtime: { mode: "local" },
      }, 0, new Date("2026-09-06T12:00:00.000Z"));

      expect(repaired).toMatchObject({
        v: 2,
        id,
        definitionRevision: 1,
        state: "draft",
        enabled: false,
        needsRepair: false,
        enableProof: null,
        createdAt: at,
      });
      expect(store.listAutomations()).toEqual([repaired]);
      expect(store.runDueAutomations(TARGET, new Date("2026-09-06T12:01:00.000Z"))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it.each(["missing", "mismatched"] as const)(
    "rejects a stored V2 definition whose semantic row identity is %s",
    async identity => {
      const { store, driver } = await fixtureWithDriver();
      try {
        const prepared = await releaseECandidate(store);
        const row = driver.select(
          `SELECT definition_json FROM sys.automations WHERE id = ?`, [prepared.saved.id],
        )[0]!;
        const raw = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
        if (identity === "missing") delete raw.id;
        else raw.id = `auto_${"e".repeat(32)}`;
        driver.exec(`UPDATE sys.automations SET definition_json = ? WHERE id = ?`,
          [JSON.stringify(raw), prepared.saved.id]);

        expect(() => store.listAutomations()).toThrow(/identity|id|invalid/i);
      } finally {
        store.close();
      }
    },
  );

  it.each(["missing", "forged", "extra_target"] as const)(
    "rejects an enabled V2 definition whose kernel enable proof is %s",
    async proofState => {
      const { store, driver } = await fixtureWithDriver();
      try {
        const prepared = await releaseECandidate(store);
        const simulation = store.simulateAutomation({
          id: prepared.saved.id,
          target: TARGET,
          expectedRevision: prepared.saved.definitionRevision,
          purpose: "enable",
        }, new Date("2026-09-06T12:00:00.000Z"));
        const enabled = store.enableAutomation({
          id: prepared.saved.id,
          target: TARGET,
          expectedRevision: prepared.saved.definitionRevision,
          simulation,
        }, new Date("2026-09-06T12:00:01.000Z"));
        const row = driver.select(
          `SELECT definition_json FROM sys.automations WHERE id = ?`, [enabled.id],
        )[0]!;
        const raw = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
        if (proofState === "missing") raw.enableProof = null;
        else if (proofState === "forged") {
          const proof = raw.enableProof as Record<string, unknown>;
          proof.definitionDigest = `sha256:${"0".repeat(64)}`;
        } else ((raw.enableProof as Record<string, unknown>).target as Record<string, unknown>)
          .unexpected = true;
        driver.exec(`UPDATE sys.automations SET definition_json = ? WHERE id = ?`,
          [JSON.stringify(raw), enabled.id]);

        expect(() => store.listAutomations()).toThrow(/enable proof|proof|invalid/i);
      } finally {
        store.close();
      }
    },
  );

  it("rejects a create-record action that omits a required target field before simulation", async () => {
    const store = await fixture();
    try {
      const trace = store.semanticSchemaTrace();
      const deals = trace.tables.find(item => item.name === "deals")!;
      const tasks = trace.tables.find(item => item.name === "tasks")!;
      expect(() => store.saveAutomationDraft({
        v: 2,
        name: "Incomplete task",
        trigger: {
          kind: "manual",
          table: { tableId: deals.tableId, lastKnownName: "deals" },
          conditions: [],
        },
        actions: [{
          kind: "create_record",
          table: { tableId: tasks.tableId, lastKnownName: "tasks" },
          values: [],
        }],
        runtime: { mode: "local" },
      })).toThrow(/required.*title|title.*required/i);
      expect(store.listAutomations()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("invalidates the enable proof when an enabled rule is paused", async () => {
    const store = await fixture();
    try {
      const prepared = await releaseECandidate(store);
      const enabled = store.enableAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation: prepared.simulation,
      }, new Date("2026-09-06T12:02:00.000Z"));

      const paused = store.pauseAutomation({
        id: enabled.id,
        expectedRevision: enabled.definitionRevision,
      }, new Date("2026-09-06T12:03:00.000Z"));
      expect(paused).toMatchObject({ state: "paused", enabled: false, enableProof: null });
      expect(store.listAutomations()).toEqual([paused]);
    } finally {
      store.close();
    }
  });

  it("pauses foreign-target runnable authority and exposes imported receipts as audit-only", async () => {
    const { store, driver } = await fixtureWithDriver();
    const foreignTarget: AutomationTargetIdentityV1 = {
      ...TARGET,
      activeGenerationId: "gen_dddddddddddddddddddddddddd",
    };
    try {
      const prepared = await releaseECandidate(store);
      store.enableAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation: prepared.simulation,
      }, new Date("2026-09-06T12:02:00.000Z"));
      const runPreview = store.simulateAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        purpose: "run_now",
      }, new Date("2026-09-06T12:03:00.000Z"));
      const run = store.runAutomationNow({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation: runPreview,
      }, new Date("2026-09-06T12:04:00.000Z"));
      expect(run.kind).toBe("committed");

      expect(store.runDueAutomations(foreignTarget, new Date("2026-09-06T12:05:00.000Z")))
        .toEqual([]);
      expect(store.listAutomations(foreignTarget)).toMatchObject([{
        state: "paused",
        enabled: false,
        authorityTarget: foreignTarget,
      }]);
      expect(JSON.parse(String(driver.select(
        `SELECT definition_json FROM sys.automations WHERE id = ?`, [prepared.saved.id],
      )[0]!.definition_json)).state).toBe("enabled");
      expect(store.automationRuntimeOverview(foreignTarget).runs[0]?.undo).toMatchObject({
        available: false,
        reason: "FOREIGN_TARGET",
      });
    } finally {
      store.close();
    }
  });

  it("fails closed on a missing event-time snapshot without falling back or advancing the cursor", async () => {
    const { store, driver } = await fixtureWithDriver();
    try {
      const trace = store.semanticSchemaTrace();
      const deals = trace.tables.find(item => item.name === "deals")!;
      const saved = store.saveAutomationDraft({
        v: 2,
        name: "Created deal audit",
        trigger: {
          kind: "record_created",
          table: { tableId: deals.tableId, lastKnownName: "deals" },
          conditions: [],
        },
        actions: [{ kind: "notify", title: "Created", body: "A deal was created" }],
        runtime: { mode: "local" },
      });
      const simulation = store.simulateAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision,
        purpose: "enable",
      }, new Date("2026-09-06T12:00:00.000Z"));
      store.enableAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision, simulation,
      }, new Date("2026-09-06T12:00:01.000Z"));
      const cursorBefore = Number(driver.select(
        `SELECT last_event_seq FROM sys.automations WHERE id = ?`, [saved.id],
      )[0]!.last_event_seq);
      const inserted = store.insert("deals", { name: "Transient", stage: "open" });
      const event = driver.select(
        `SELECT seq FROM sys.record_events WHERE table_name = 'deals' AND row_id = ?
         ORDER BY seq DESC LIMIT 1`, [String(inserted.id)],
      )[0]!;
      driver.exec(`UPDATE sys.record_events SET row_json = NULL, snapshot_digest = NULL WHERE seq = ?`,
        [Number(event.seq)]);
      driver.exec(`DELETE FROM "deals" WHERE id = ?`, [String(inserted.id)]);

      expect(store.runDueAutomations(TARGET, new Date("2026-09-06T12:01:00.000Z")))
        .toEqual([]);
      expect(Number(driver.select(
        `SELECT last_event_seq FROM sys.automations WHERE id = ?`, [saved.id],
      )[0]!.last_event_seq)).toBe(cursorBefore);
      expect(store.listAutomations(TARGET)).toMatchObject([{
        id: saved.id,
        state: "error",
        enabled: false,
      }]);
      expect(store.automationRuns(TARGET, saved.id)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("simulates created and updated triggers from the exact queued event scope rather than current rows", async () => {
    const store = await fixture();
    try {
      for (let index = 0; index < 101; index++)
        store.insert("deals", { name: `Historical ${index}`, stage: "open" });
      const trace = store.semanticSchemaTrace();
      const deals = trace.tables.find(item => item.name === "deals")!;
      const saved = store.saveAutomationDraft({
        v: 2,
        name: "Future creations only",
        trigger: {
          kind: "record_created",
          table: { tableId: deals.tableId, lastKnownName: "deals" },
          conditions: [],
        },
        actions: [{ kind: "notify", title: "Created", body: "A new deal arrived" }],
        runtime: { mode: "local" },
      });

      const proof = store.simulateAutomation({
        id: saved.id, target: TARGET, expectedRevision: saved.definitionRevision,
        purpose: "enable",
      }, new Date("2026-09-06T12:00:00.000Z"));
      expect(proof.matchedRecords).toBe(0);
      expect(proof.matchedScope.recordIds).toEqual([]);
      expect(proof.plannedEffects).toEqual([{ kind: "notify", count: 0 }]);
    } finally {
      store.close();
    }
  });

  it("establishes a future-only record-match baseline atomically when enabling", async () => {
    const { store, driver } = await fixtureWithDriver();
    try {
      const prepared = await releaseECandidate(store);
      store.enableAutomation({
        id: prepared.saved.id,
        target: TARGET,
        expectedRevision: prepared.saved.definitionRevision,
        simulation: prepared.simulation,
      }, new Date("2026-09-06T12:02:00.000Z"));

      expect(store.runDueAutomations(TARGET, new Date("2026-09-06T12:03:00.000Z")))
        .toEqual([]);
      expect(driver.select(
        `SELECT baseline, target_json, definition_revision, definition_digest
           FROM sys.automation_matches WHERE automation_id = ?`, [prepared.saved.id],
      )).toEqual([expect.objectContaining({
        baseline: 1,
        target_json: stableAutomationJson(TARGET),
        definition_revision: prepared.saved.definitionRevision,
        definition_digest: prepared.simulation.definitionDigest,
      })]);
      expect(store.query({ from: "deals" })[0]).toMatchObject({ followed_up: false });
    } finally {
      store.close();
    }
  });
});
