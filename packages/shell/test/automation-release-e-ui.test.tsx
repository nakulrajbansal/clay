/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it } from "vitest";
import { automationUiFixture } from "./helpers/automation-ui-fixture";
import { expectControlCensus } from "./helpers/control-census";
beforeEach(() => sessionStorage.clear());
import type {
  AutomationDefinitionAny, AutomationDefinitionV2, AutomationDraftInputV2,
  AutomationRecipeDraftRequestV1, AutomationRun, AutomationRuntimeOverviewV1,
  AutomationRuntimeStatusV1, AutomationSimulationProofV1,
  FieldId, RegTable, SemanticSchemaTraceV1, TableId,
} from "@clay/kernel";
import { AutomationCenter } from "../src/app/AutomationCenter";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tableId = "tbl_018f0000-0000-7000-8000-000000000001" as TableId;
const titleId = "fld_018f0000-0000-7000-8000-000000000002" as FieldId;
const table = { name: "tasks", columns: [
  { name: "title", type: "text", required: true },
] } as RegTable;
const trace = {
  v: 1,
  currentVersion: 1,
  tables: [{ v: 1, tableId, name: "tasks", aliases: [], origin: "user", state: "visible",
    createdVersion: 1, lastChangedVersion: 1, events: [] }],
  fields: [{ v: 1, tableId, fieldId: titleId, fieldName: "title", aliases: [], origin: "user",
    state: "visible", createdVersion: 1, lastChangedVersion: 1, events: [] }],
  relationships: [],
  opBindings: [],
} as unknown as SemanticSchemaTraceV1;
const runtime: AutomationRuntimeStatusV1 = {
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
};

it("puts eligible recipes first, exposes local limits, and saves a recipe draft disabled", async () => {
  const legacy = {
    v: 1,
    id: "auto_018f0000000070008000000000000001",
    name: "Old reminder",
    enabled: false,
    persistedEnabled: true,
    trigger: { kind: "manual", table: "tasks", conditions: [] },
    actions: [{ kind: "notify", title: "Review", body: "Review" }],
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    definitionRevision: 0,
    state: "paused",
    needsRepair: true,
    repairReason: "REVIEW_REQUIRED_AFTER_UPGRADE",
  } as AutomationDefinitionAny;
  let rules: AutomationDefinitionAny[] = [legacy];
  let savedRequest: AutomationRecipeDraftRequestV1 | null = null;
  let repairInput: AutomationDraftInputV2 | null = null;
  let repairRevision: number | undefined;
  let enables = 0;
  const worker = automationUiFixture({
    listAutomations: async () => rules,
    automationRuns: async () => [],
    notifications: async () => [],
    semanticTrace: async () => trace,
    automationRuntimeStatus: async () => runtime,
    automationRuntimeOverview: async () => ({
      v: 1, rules: [{
   v: 1, automationId: legacy.id, lastRunId: null,
   lastRun: null,
   next: { kind: "manual", detail: "When you preview and confirm Run while Clay is open." },
        skip: { code: "REVIEW_REQUIRED_AFTER_UPGRADE",
          detail: "Skipped because this older rule needs review after upgrade and is disabled." },
      }], runs: [],
    }),
    automationRecipes: async () => [{
      v: 1 as const,
      id: "weekly_checklist" as const,
      version: 1 as const,
      title: "Create a weekly checklist",
      result: "Creates one checklist item on the selected weekday.",
      requiredMappings: ["Choose the checklist table and title field."],
      runtimeFact: "Runs on this device while Clay is open." as const,
      undoFact: "Created checklist records can be undone from run history.",
      options: [{
        kind: "weekly_checklist" as const,
        target: { tableId, lastKnownName: "tasks" },
        writableFields: [{ tableId, fieldId: titleId, lastKnownName: "title" }],
      }],
    }],
    saveAutomationRecipeDraft: async (request: AutomationRecipeDraftRequestV1) => {
      savedRequest = request;
      const saved = {
        v: 2,
        id: "auto_018f0000000070008000000000000002",
        name: "Create a weekly checklist",
        recipe: { id: "weekly_checklist", version: 1 },
        trigger: { kind: "schedule", cadence: "weekly", localTime: "09:00", weekday: 1 },
        actions: [{ kind: "create_record", table: { tableId, lastKnownName: "tasks" }, values: [{
          field: { tableId, fieldId: titleId, lastKnownName: "title" },
          value: { source: "literal", value: "Review the week" },
        }] }],
        runtime: { mode: "local" },
        definitionRevision: 1,
        state: "draft",
        enabled: false,
        needsRepair: false,
        enableProof: null,
        createdAt: "2026-09-06T12:00:00.000Z",
        updatedAt: "2026-09-06T12:00:00.000Z",
      } as AutomationDefinitionV2;
      rules = [legacy, saved];
      return saved;
    },
    saveAutomationDraft: async (input: AutomationDraftInputV2, expectedRevision?: number) => {
      repairInput = input;
      repairRevision = expectedRevision;
      const saved = {
        ...input,
        id: legacy.id,
        definitionRevision: 1,
        state: "draft",
        enabled: false,
        needsRepair: false,
        enableProof: null,
        createdAt: legacy.createdAt,
        updatedAt: "2026-09-06T12:01:00.000Z",
      } as AutomationDefinitionV2;
      rules = [saved, ...rules.filter(rule => rule.id !== legacy.id)];
      return saved;
    },
    simulateAutomation: async (id: string): Promise<AutomationSimulationProofV1> => ({
      v: 1, id: `asim_${"d".repeat(64)}`,
      target: {
        v: 1, appInstanceId: `app_${"a".repeat(26)}`,
        activeGenerationId: `gen_${"b".repeat(26)}`,
        lineageEpoch: "1", stateRevision: "4", stateDigest: `sha256:${"c".repeat(64)}`,
      },
      purpose: "enable", automationId: id, definitionRevision: 1,
      definitionDigest: `sha256:${"e".repeat(64)}`, schemaRevision: 1,
      referenceFingerprint: `sha256:${"f".repeat(64)}`, dataRevision: 0,
      evaluatedAt: "2026-09-06T12:01:00.000Z", expiresAt: "2026-09-06T12:06:00.000Z",
      snapshotDigest: `sha256:${"1".repeat(64)}`, matchedRecords: 0,
      matchedScope: { kind: "records", recordIds: [] },
      plannedMutations: 0, plannedNotifications: 0, plannedEffects: [], sampleLabels: [],
      runtime: { mode: "local", requiresAppOpen: true, timeZone: "UTC" },
      undo: "no_data_changes",
    }),
    enableAutomation: async () => { enables++; throw new Error("must not enable while saving"); },
  });

  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<AutomationCenter worker={worker} tables={[table]} notifications={[]}
    onNotifications={() => undefined} onClose={() => undefined} onOpenRecord={() => undefined}
    onWrite={() => undefined} onError={message => { throw new Error(message); }} onInfo={() => undefined} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  const text = document.body.textContent ?? "";
  expectControlCensus("E.automations");
  expect(text.indexOf("Start with a recipe")).toBeLessThan(text.indexOf("Build a custom rule"));
  expect(text).toContain("Automations run on this device while Clay is open.");
  expect(text).toContain("No cloud runner · no model access · no network access");
  expect(text).toContain("Needs review after upgrade · disabled");
  expect(document.body.querySelector<HTMLButtonElement>('[aria-label="Old reminder needs review"]')?.disabled)
    .toBe(true);

  const setup = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Set up recipe")!;
  await act(async () => setup.click());
  const title = document.body.querySelector<HTMLInputElement>('input[placeholder="Review this week"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Review the week");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Save disabled draft")!;
  await act(async () => { save.click(); await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(savedRequest).toMatchObject({
    v: 1,
    recipeId: "weekly_checklist",
    recipeVersion: 1,
    mapping: { targetTableId: tableId, titleFieldId: titleId, title: "Review the week" },
  });
  expect(enables).toBe(0);
  expect(rules[1]).toMatchObject({ v: 2, state: "draft", enabled: false, enableProof: null });

  const review = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Review & rebuild")!;
  await act(async () => review.click());
  expect(document.body.textContent).toContain("Repair this older rule in place");
  expect(document.body.textContent).toContain(
    "When I press Run in tasks, then show a reminder named “Review” while Clay is open.",
  );
  const repair = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Save repair and simulate")!;
  await act(async () => { repair.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(repairInput).toMatchObject({ v: 2, id: legacy.id });
  expect(repairRevision).toBe(0);
  expect(rules.filter(rule => rule.id === legacy.id)).toHaveLength(1);
  expect(rules[0]).toMatchObject({ v: 2, id: legacy.id, state: "draft", enabled: false });
  await act(async () => root.unmount());
});

it("shows trusted per-rule last, next, skip, failure, and conflict-safe undo state", async () => {
  const active = {
    v: 2,
    id: "auto_018f0000000070008000000000000003",
    name: "Watch tasks",
    trigger: { kind: "record_matches", table: { tableId, lastKnownName: "tasks" }, conditions: [] },
    actions: [{ kind: "notify", title: "Review", body: "Review this task" }],
    runtime: { mode: "local" },
    definitionRevision: 2,
    state: "enabled",
    enabled: true,
    needsRepair: false,
    enableProof: {
      v: 1, id: `aep_${"a".repeat(64)}`,
      target: {
        v: 1, appInstanceId: `app_${"a".repeat(26)}`,
        activeGenerationId: `gen_${"b".repeat(26)}`,
        lineageEpoch: "1", stateRevision: "2", stateDigest: `sha256:${"c".repeat(64)}`,
      },
      automationId: "auto_018f0000000070008000000000000003",
      simulationId: `asim_${"d".repeat(64)}`,
      definitionRevision: 2,
      definitionDigest: `sha256:${"e".repeat(64)}`,
      issuedAt: "2026-09-06T12:00:00.000Z",
    },
    authorityTarget: {
      v: 1, appInstanceId: `app_${"a".repeat(26)}`,
      activeGenerationId: `gen_${"b".repeat(26)}`,
      lineageEpoch: "1", stateRevision: "2", stateDigest: `sha256:${"c".repeat(64)}`,
    },
    authorityDefinitionRevision: 2,
    authorityDefinitionDigest: `sha256:${"e".repeat(64)}`,
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-06T12:00:00.000Z",
  } as AutomationDefinitionV2;
  const legacy = {
    v: 1,
    id: "auto_018f0000000070008000000000000004",
    name: "Old task rule",
    enabled: false,
    persistedEnabled: true,
    trigger: { kind: "manual", table: "tasks", conditions: [] },
    actions: [{ kind: "notify", title: "Review", body: "Review" }],
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    definitionRevision: 0,
    state: "paused",
    needsRepair: true,
    repairReason: "REVIEW_REQUIRED_AFTER_UPGRADE",
  } as AutomationDefinitionAny;
  const failed = {
    id: "018f0000-0000-7000-8000-0000000000f1", automationId: active.id,
    at: "2026-09-06T13:00:00.000Z", status: "failed", matchedRecords: 1,
    changed: 0, batchId: null, errorCode: "E_VALIDATION", undone: false,
  } as AutomationRun;
  const changedLater = {
    id: "018f0000-0000-7000-8000-0000000000f0", automationId: active.id,
    at: "2026-09-06T12:00:00.000Z", status: "success", matchedRecords: 1,
    changed: 1, batchId: "018f0000-0000-7000-8000-0000000000b0", errorCode: null, undone: false,
  } as AutomationRun;
  const overview: AutomationRuntimeOverviewV1 = {
    v: 1,
    rules: [
      { v: 1, automationId: active.id, lastRunId: failed.id,
        lastRun: failed,
        next: { kind: "event", detail: "When a tasks record newly matches while Clay is open." },
        skip: null },
      { v: 1, automationId: legacy.id, lastRunId: null, lastRun: null,
        next: { kind: "manual", detail: "When you preview and confirm Run while Clay is open." },
        skip: { code: "REVIEW_REQUIRED_AFTER_UPGRADE",
          detail: "Skipped because this older rule needs review after upgrade and is disabled." } },
    ],
    runs: [
      { v: 1, runId: failed.id,
        failure: { code: "E_VALIDATION", detail: "The run failed safely; no partial changes were kept." },
        undo: { available: false, reason: "RUN_FAILED",
          detail: "A failed run has no retained changes to undo." } },
      { v: 1, runId: changedLater.id, failure: null,
        undo: { available: false, reason: "RECORD_CHANGED",
          detail: "Undo is unavailable because a record changed after this run." } },
    ],
  };
  const worker = automationUiFixture({
    listAutomations: async () => [active, legacy],
    automationRuns: async () => [failed, changedLater],
    notifications: async () => [],
    semanticTrace: async () => trace,
    automationRuntimeStatus: async () => ({ ...runtime, enabledDefinitions: 1, disabledDefinitions: 1 }),
    automationRuntimeOverview: async () => overview,
    automationRecipes: async () => [],
  });

  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<AutomationCenter worker={worker} tables={[table]} notifications={[]}
    onNotifications={() => undefined} onClose={() => undefined} onOpenRecord={() => undefined}
    onWrite={() => undefined} onError={message => { throw new Error(message); }} onInfo={() => undefined} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(document.body.textContent).toContain("Last run: Failed · 2026-09-06 13:00");
  expect(document.body.textContent).toContain("Next: When a tasks record newly matches while Clay is open.");
  expect(document.body.textContent).toContain("Skipped because this older rule needs review after upgrade and is disabled.");
  expect(document.body.textContent).toContain("Failure: E_VALIDATION · The run failed safely; no partial changes were kept.");

  const history = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Run history"))!;
  await act(async () => history.click());
  expect(document.body.textContent).toContain("Undo is unavailable because a record changed after this run.");
  expect([...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .some(button => button.textContent === "Undo run")).toBe(false);
  await act(async () => root.unmount());
});
