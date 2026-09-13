import { expect, it, vi } from "vitest";
import { runRetainedAutomationTick } from "../src/app/automation-tick";
import type { WorkerClient } from "../src/app/worker-client";
import { beginPresentationIntent, readPresentationIntent } from "../src/app/presentation-intent";

it("reconciles durable intake workflow presence before minting a scheduled ID after cache loss", async () => {
  const app = `app_${"a".repeat(26)}`; const mint = vi.fn();
  const worker = { createMutationContext: mint, automationPresentation: async () => ({ authorityTarget: { appInstanceId: app },
    availability: { available: true }, rules: [{ enabled: true }], notifications: [] }) } as unknown as WorkerClient;
  const cache = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  const recover = vi.fn(async () => true);
  expect(await runRetainedAutomationTick(cache, worker, app, recover)).toMatchObject({ reason: "pending_intake_delivery", runs: [] });
  expect(recover).toHaveBeenCalledOnce(); expect(mint).not.toHaveBeenCalled();
});

it("does not invoke uncertified storage, switch a scheduled intent to another app, or discard unknown work", async () => {
  const app = `app_${"a".repeat(26)}`; const command = vi.fn();
  const cache = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  const worker = { automationPresentation: async () => ({ authorityTarget: { appInstanceId: app }, availability: { available: false }, notifications: [] }),
    automationCommand: command } as unknown as WorkerClient;
  expect(await runRetainedAutomationTick(cache, worker, app)).toMatchObject({ available: false, runs: [] });
  await expect(runRetainedAutomationTick(cache, worker, `app_${"z".repeat(26)}`)).rejects.toThrow(/source/);
  expect(command).not.toHaveBeenCalled(); expect(cache.removeItem).not.toHaveBeenCalled();
});

it.each(["failed", "cancelled", "not_invoked", "uncertain"])("reconciles a retained %s scheduled command before any replacement ID", async status => {
  const app = `app_${"a".repeat(26)}`; const rows = new Map<string, string>();
  const cache = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const source = { appInstanceId: app, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const intent = beginPresentationIntent(cache, app, "automation", "automation.command", { authorityTarget: source, command: { route: "runDueAutomations", payload: {} } }, () => ({ requestId: `req_${"d".repeat(26)}` }));
  const mint = vi.fn(); const command = vi.fn(); const cancel = vi.fn(async () => ({ status: "cancelled" }));
  const worker = { createMutationContext: mint, automationCommand: command, cancelPresentation: cancel, mutationOutcome: async () => ({ status }),
    automationPresentation: async () => ({ authorityTarget: { ...source, protectionRevision: "2" }, availability: { available: true }, notifications: [], rules: [{ enabled: true }] }) } as unknown as WorkerClient;
  if (status === "uncertain") {
    await expect(runRetainedAutomationTick(cache, worker, app)).rejects.toThrow(/uncertain/);
    expect(cancel).not.toHaveBeenCalled(); expect(readPresentationIntent(cache, app, "automation")?.requestId).toBe(intent.requestId);
  } else {
    expect(await runRetainedAutomationTick(cache, worker, app)).toMatchObject({ reason: "scheduled_request_terminalized", runs: [] });
    expect(cancel).toHaveBeenCalledWith(intent.route, intent.payload, { requestId: intent.requestId });
    expect(readPresentationIntent(cache, app, "automation")).toBeNull();
  }
  expect(command).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled();
});
