/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { AutomationDefinition, AutomationDefinitionInput, RegTable } from "@clay/kernel";
import { AutomationCenter } from "../src/app/AutomationCenter";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows a simulation before re-enabling an existing rule", async () => {
  const table = { name: "tasks", columns: [{ name: "title", type: "text", required: true }] } as RegTable;
  let rule = { id: "auto_018f0000000070008000000000000001", name: "Remind me", enabled: false,
    trigger: { kind: "record_matches", table: "tasks", conditions: [] },
    actions: [{ kind: "notify", title: "Reminder", body: "Check this" }],
    createdAt: "2026-09-02T12:00:00.000Z", updatedAt: "2026-09-02T12:00:00.000Z" } as AutomationDefinition;
  let writes = 0;
  const worker = {
    listAutomations: async () => [rule], automationRuns: async () => [], notifications: async () => [],
    simulateAutomation: async () => ({ automationId: rule.id, matchedRecords: 2,
      plannedMutations: 0, plannedNotifications: 2, sampleLabels: ["One", "Two"] }),
    upsertAutomation: async (input: AutomationDefinitionInput) => {
      writes++; rule = { ...rule, ...input } as AutomationDefinition; return rule;
    },
  } as unknown as WorkerClient;
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
  const enable = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Enable rule")!;
  await act(async () => { enable.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(writes).toBe(1); expect(rule.enabled).toBe(true);
  await act(async () => root.unmount());
});
