import { expect, it, vi } from "vitest";
import { runRetainedAutomationTick } from "../src/app/automation-tick";
import type { WorkerClient } from "../src/app/worker-client";

it("does not invoke uncertified storage, switch a scheduled intent to another app, or discard unknown work", async () => {
  const app = `app_${"a".repeat(26)}`; const command = vi.fn();
  const cache = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  const worker = { automationPresentation: async () => ({ authorityTarget: { appInstanceId: app }, availability: { available: false }, notifications: [] }),
    automationCommand: command } as unknown as WorkerClient;
  expect(await runRetainedAutomationTick(cache, worker, app)).toMatchObject({ available: false, runs: [] });
  await expect(runRetainedAutomationTick(cache, worker, `app_${"z".repeat(26)}`)).rejects.toThrow(/source/);
  expect(command).not.toHaveBeenCalled(); expect(cache.removeItem).not.toHaveBeenCalled();
});
