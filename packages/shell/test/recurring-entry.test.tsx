/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { RegTable } from "@clay/kernel";
import { AutomationCenter } from "../src/app/AutomationCenter";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

describe("recurring-record entry", () => {
  it("keeps unavailable mutations gated while opening the exact automation read-only", async () => {
    const tables = [{
      name: "tasks",
      columns: [
        { name: "title", type: "text", required: true },
        { name: "due_on", type: "date", required: false },
      ],
    }] as RegTable[];
    const automationId = "auto_018f4c2a7b3170018000000000000041";
    const rule = {
      id: automationId,
      name: "Create recurring Tasks",
      enabled: false,
      trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
      actions: [{ kind: "create_record", table: "tasks", values: {
        title: { source: "literal", value: "Follow up" },
      } }],
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
    } as unknown as WorkerClient;
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<AutomationCenter
      worker={worker} tables={tables} notifications={notifications}
      initialAutomationId={automationId} mutationsAvailable={false}
      onNotifications={() => undefined} onClose={() => undefined} onOpenRecord={() => undefined}
      onWrite={() => undefined} onError={message => { throw new Error(message); }}
      onInfo={() => undefined}
    />));
    await settle();

    expect(document.body.textContent).toContain("Automation changes are unavailable");
    const selected = document.querySelector<HTMLElement>(`.automation-rule[data-automation-id="${automationId}"]`);
    expect(selected?.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Enable Create recurring Tasks"]')?.disabled)
      .toBe(true);
    expect([...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Run now")?.disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "＋ New rule")?.disabled).toBe(true);

    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".automation-tabs button")]
      .find(button => button.textContent?.startsWith("Inbox"))!.click());
    expect([...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Mark read")?.disabled).toBe(true);

    await act(async () => root.unmount());
  });
});
