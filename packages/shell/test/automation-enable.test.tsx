/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it } from "vitest";
import { automationUiFixture } from "./helpers/automation-ui-fixture";
beforeEach(() => sessionStorage.clear());
import type {
  AutomationDefinitionV2, AutomationSimulationProofV1, FieldId, RegTable,
  SemanticSchemaTraceV1, TableId,
} from "@clay/kernel";
import { AutomationCenter } from "../src/app/AutomationCenter";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tableId = "tbl_018f0000-0000-7000-8000-000000000001" as TableId;
const fieldId = "fld_018f0000-0000-7000-8000-000000000002" as FieldId;
const target = {
  v: 1 as const,
  appInstanceId: `app_${"a".repeat(26)}`,
  activeGenerationId: `gen_${"b".repeat(26)}`,
  lineageEpoch: "1",
  stateRevision: "3",
  stateDigest: `sha256:${"c".repeat(64)}`,
};

it("shows an exact simulation before re-enabling an existing V2 rule", async () => {
  const table = { name: "tasks", columns: [{ name: "title", type: "text", required: true }] } as RegTable;
  let rule = {
    v: 2,
    id: "auto_018f0000000070008000000000000001",
    name: "Remind me",
    trigger: { kind: "record_matches", table: { tableId, lastKnownName: "tasks" }, conditions: [] },
    actions: [{ kind: "notify", title: "Reminder", body: "Check this" }],
    runtime: { mode: "local" },
    definitionRevision: 1,
    state: "paused",
    enabled: false,
    needsRepair: false,
    enableProof: null,
    authorityTarget: null,
    authorityDefinitionRevision: null,
    authorityDefinitionDigest: null,
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
  } as AutomationDefinitionV2;
  const simulation = {
    v: 1,
    id: `asim_${"d".repeat(64)}`,
    target,
    purpose: "enable",
    automationId: rule.id,
    definitionRevision: 1,
    definitionDigest: `sha256:${"e".repeat(64)}`,
    schemaRevision: 1,
    referenceFingerprint: `sha256:${"f".repeat(64)}`,
    dataRevision: 1,
    evaluatedAt: "2026-09-06T12:00:00.000Z",
    expiresAt: "2026-09-06T12:05:00.000Z",
    snapshotDigest: `sha256:${"1".repeat(64)}`,
    matchedRecords: 2,
    matchedScope: { kind: "records", recordIds: ["one", "two"] },
    plannedMutations: 0,
    plannedNotifications: 2,
    plannedEffects: [{ kind: "notify", count: 2 }],
    sampleLabels: ["One", "Two"],
    runtime: { mode: "local", requiresAppOpen: true, timeZone: null },
    undo: "no_data_changes",
  } as AutomationSimulationProofV1;
  let writes = 0;
  const trace = {
    v: 1, currentVersion: 1,
    tables: [{ v: 1, tableId, name: "tasks", aliases: [], origin: "user", state: "visible",
      createdVersion: 1, lastChangedVersion: 1, events: [] }],
    fields: [{ v: 1, tableId, fieldId, fieldName: "title", aliases: [], origin: "user",
      state: "visible", createdVersion: 1, lastChangedVersion: 1, events: [] }],
    relationships: [], opBindings: [],
  } as unknown as SemanticSchemaTraceV1;
  const worker = automationUiFixture({
    listAutomations: async () => [rule],
    automationRuns: async () => [],
    notifications: async () => [],
    automationRecipes: async () => [],
    automationRuntimeStatus: async () => ({
      v: 1, engine: "local_worker_session", sessionActive: true,
      backgroundExecution: false, offDeviceExecution: false, modelAccess: false, networkAccess: false,
      headline: "Automations run on this device while Clay is open.",
      detail: "If Clay is closed or this device sleeps, scheduled work waits until a Clay session is available.",
      enabledDefinitions: 0, disabledDefinitions: 1, needsRepairDefinitions: 0,
    }),
    automationRuntimeOverview: async () => ({ v: 1 as const, rules: [], runs: [] }),
    semanticTrace: async () => trace,
    simulateAutomation: async () => simulation,
    enableAutomation: async () => {
      writes++;
      rule = { ...rule, state: "enabled", enabled: true } as AutomationDefinitionV2;
      return rule;
    },
  });
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<AutomationCenter worker={worker} tables={[table]} notifications={[]}
    onNotifications={() => undefined} onClose={() => undefined} onOpenRecord={() => undefined}
    onWrite={() => undefined} onError={message => { throw new Error(message); }} onInfo={() => undefined} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const toggle = document.body.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => { toggle.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(writes).toBe(0);
  expect(document.body.textContent).toContain("2 match");
  expect(document.body.textContent).toContain("target revision 3");
  const enable = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Enable rule")!;
  await act(async () => { enable.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(writes).toBe(1); expect(rule.enabled).toBe(true);
  await act(async () => root.unmount());
});
