/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { RegTable } from "@clay/kernel";
import { AutomationCenter } from "../src/app/AutomationCenter";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("recurring-record entry", () => {
  it.each([true, false])("opens the exact recurring rule and uses paired authority availability (%s)", async available => {
    const tables = [{
      name: "tasks",
      columns: [
        { name: "title", type: "text", required: true },
        { name: "due_on", type: "date", required: false },
      ],
    }] as RegTable[];
    const automationId = "auto_018f4c2a7b3170018000000000000041";
    const rule = {
      v: 2,
      id: automationId,
      name: "Create recurring Tasks",
      enabled: false,
      definitionRevision: 1,
      state: "draft",
      needsRepair: false,
      enableProof: null,
      authorityTarget: null,
      authorityDefinitionRevision: null,
      authorityDefinitionDigest: null,
      trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
      actions: [{ kind: "create_record", table: {
        tableId: `tbl_${"a".repeat(26)}`, lastKnownName: "tasks",
      }, values: [{
        field: { tableId: `tbl_${"a".repeat(26)}`, fieldId: `fld_${"b".repeat(26)}`,
          lastKnownName: "title" },
        value: { source: "literal", value: "Follow up" },
      }] }],
      runtime: { mode: "local", timeZone: "UTC", missedPolicy: "skip" },
      createdAt: "2026-09-06T10:00:00.000Z",
      updatedAt: "2026-09-06T10:00:00.000Z",
    };
    const notifications = [{
      id: "018f4c2a-7b31-7001-8000-000000000042",
      at: "2026-09-06T10:00:00.000Z",
      automationId,
      runId: "018f4c2a-7b31-7001-8000-000000000043",
      title: "Recurring work",
      body: "Review this rule.",
      table: null,
      recordId: null,
      read: false,
    }];
    const worker = {
      listAutomations: async () => [rule], automationRuns: async () => [],
      notifications: async () => notifications,
      automationRecipes: async () => [],
      automationRuntimeStatus: async () => ({
        v: 1, engine: "local_worker_session", sessionActive: true,
        backgroundExecution: false, offDeviceExecution: false,
        modelAccess: false, networkAccess: false,
        headline: "Automations run on this device while Clay is open.",
        detail: "If Clay is closed or this device sleeps, scheduled work waits until a Clay session is available.",
        enabledDefinitions: 0, disabledDefinitions: 1, needsRepairDefinitions: 0,
      }),
      automationRuntimeOverview: async () => ({ v: 1 as const, rules: [], runs: [] }),
      semanticTrace: async () => ({
        v: 1, tables: [], fields: [], relationships: [], opBindings: [],
      }),
    } as unknown as WorkerClient;
    const errors: string[] = [];
    const paired = { ...worker, automationPresentation: async () => ({
      authorityTarget: { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`,
        lineageEpoch: "0", protectionRevision: "1", digestSchema: 1, stateSha256: `sha256:${"c".repeat(64)}` },
      availability: { available, reason: available ? null : "physical_recovery_unavailable" }, rules: [rule], runs: [], notifications, recipes: [],
      runtime: await worker.automationRuntimeStatus(), overview: await worker.automationRuntimeOverview(), trace: await worker.semanticTrace(),
    }) } as unknown as WorkerClient;
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<AutomationCenter
      worker={paired} tables={tables} notifications={notifications}
      initialAutomationId={automationId}
      onNotifications={() => undefined} onClose={() => undefined} onOpenRecord={() => undefined}
      onWrite={() => undefined} onError={message => errors.push(message)}
      onInfo={() => undefined}
    />));
    await vi.waitFor(() => expect(document
      .querySelector<HTMLElement>(`.automation-rule[data-automation-id="${automationId}"]`)
      ?.getAttribute("aria-current")).toBe("true"));

    expect(document.body.textContent?.includes("Automation changes are unavailable")).toBe(!available);
    const selected = document.querySelector<HTMLElement>(`.automation-rule[data-automation-id="${automationId}"]`);
    expect(selected?.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Enable Create recurring Tasks"]')?.disabled)
      .toBe(!available);
    expect([...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Preview run")?.disabled).toBe(!available);
    expect([...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "Build a custom rule")?.disabled).toBe(false); // Local draft preparation is safe even if execution is gated.

    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".automation-tabs button")]
      .find(button => button.textContent?.startsWith("Inbox"))!.click());
    expect([...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Mark read")?.disabled).toBe(!available);
    expect(errors).toEqual([]);

    await act(async () => root.unmount());
  });
});
