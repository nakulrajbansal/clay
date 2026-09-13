/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationCenter } from "../src/app/AutomationCenter";
import { readPresentationIntent } from "../src/app/presentation-intent";
import { readAutomationWorkspace } from "../src/app/automation-presentation";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { sessionStorage.clear(); document.body.replaceChildren(); });
const app = `app_${"a".repeat(26)}`;
const target = { appInstanceId: app, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "1", protectionRevision: "3", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };

it("does not claim a recipe is saving when physical authority is unavailable", async () => {
  const command = vi.fn();
  const worker = { createMutationContext: () => ({ requestId: `req_${"d".repeat(26)}` }), automationCommand: command,
    automationPresentation: async () => ({ authorityTarget: target, availability: { available: false, reason: "physical_transaction_uncertified" },
      rules: [], runs: [], notifications: [], overview: { rules: [], runs: [] }, trace: { tables: [], fields: [] },
      runtime: { headline: "Local only", detail: "While open", enabledDefinitions: 0, needsRepairDefinitions: 0 },
      recipes: [{ v: 1, id: "weekly_checklist", version: 1, title: "Owned weekly recipe", result: "Owned fixture", requiredMappings: [],
        runtimeFact: "Runs while Clay is open", undoFact: "Bounded Undo", options: [{ kind: "weekly_checklist",
          target: { tableId: "tbl_018f0000-0000-7000-8000-000000000001", lastKnownName: "tasks" }, writableFields: [
            { tableId: "tbl_018f0000-0000-7000-8000-000000000001", fieldId: "fld_018f0000-0000-7000-8000-000000000002", lastKnownName: "title" }] }] }] }),
  } as unknown as WorkerClient;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<AutomationCenter worker={worker} appInstanceId={app} tables={[]} notifications={[]}
      onNotifications={() => {}} onClose={() => {}} onOpenRecord={() => {}} onWrite={() => {}} onError={() => {}} onInfo={() => {}} />));
    const setup = Array.from(document.querySelectorAll("button")).find(node => node.textContent?.trim() === "Set up recipe")!;
    expect(setup).toBeDefined(); await act(async () => setup.click());
    expect(document.body.textContent).not.toContain("Saving…");
    const save = Array.from(document.querySelectorAll("button")).find(node => node.textContent?.trim() === "Save disabled draft")!;
    expect(save.disabled).toBe(true); expect(command).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("keeps a lossless V2 edit and its original invocation after failed presentation and remount", async () => {
  const rule = { v: 2, id: "auto_018f0000000070008000000000000001", name: "Both notices", definitionRevision: 1, enabled: false, needsRepair: false, state: "draft",
    trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
    actions: [{ kind: "notify", title: "First", body: "One" }, { kind: "notify", title: "Second", body: "Two" }],
    runtime: { mode: "local", timeZone: "Pacific/Auckland", missedPolicy: "skip" } };
  let stored = rule; let count = 0; const outcomes = new Map<string, unknown>(); let fail = false;
  const command = vi.fn(async (payload: any, context: { requestId: string }) => {
    stored = { ...stored, ...payload.command.payload.input, definitionRevision: 2 };
    outcomes.set(context.requestId, structuredClone(stored)); fail = true; return stored;
  });
  const errors: string[] = [];
  const worker = { createMutationContext: () => ({ requestId: `req_${String.fromCharCode(100 + count++).repeat(26)}` }),
    automationPresentation: async () => {
      if (fail) { fail = false; throw new Error("Injected presentation loss"); }
      return { authorityTarget: target, availability: { available: true, reason: null }, rules: [stored], runs: [], notifications: [], recipes: [],
        runtime: { headline: "Local only", detail: "While open", enabledDefinitions: 0, needsRepairDefinitions: 0 }, overview: { rules: [], runs: [] }, trace: { tables: [], fields: [] } };
    }, automationCommand: command,
    mutationOutcome: async (_route: string, _payload: unknown, context: { requestId: string }) => outcomes.has(context.requestId)
      ? { status: "recorded", current: true, target, result: outcomes.get(context.requestId) } : { status: "not_invoked" },
    simulateAutomation: async () => ({ target: { stateRevision: "3" }, matchedRecords: 0, plannedMutations: 0, plannedNotifications: 2,
      expiresAt: "2026-09-13T12:15:00.000Z", sampleLabels: [] }),
  } as unknown as WorkerClient;
  const host = document.createElement("div"); document.body.append(host); let root = createRoot(host);
  const render = () => root.render(<AutomationCenter worker={worker} appInstanceId={app} tables={[]} notifications={[]}
    onNotifications={() => {}} onClose={() => {}} onOpenRecord={() => {}} onWrite={() => {}} onError={value => errors.push(value)} onInfo={() => {}} />);
  const button = (text: string) => Array.from(document.querySelectorAll("button")).find(node => node.textContent?.trim() === text)!;
  await act(async () => render());
  expect(button("Edit rule")).toBeDefined();
  await act(async () => button("Edit rule").click());
  expect(readAutomationWorkspace(sessionStorage, app)?.definition?.actions).toEqual(rule.actions);
  await act(async () => button("Save and simulate").click());
  expect(errors).toContain("Injected presentation loss");
  const original = readPresentationIntent(sessionStorage, app, "automation")!;
  expect(original).not.toBeNull();
  expect((original.payload.command as any).payload.input.actions).toEqual(rule.actions);
  await act(async () => root.unmount()); root = createRoot(host); await act(async () => render());
  await act(async () => button("Retry original automation change").click());
  expect(command).toHaveBeenCalledTimes(1);
  expect(readPresentationIntent(sessionStorage, app, "automation")).toBeNull();
  expect(stored.actions).toEqual(rule.actions); expect(stored.runtime.timeZone).toBe("Pacific/Auckland");
  await act(async () => root.unmount());
});
