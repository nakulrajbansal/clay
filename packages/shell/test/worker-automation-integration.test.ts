import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { ownedBrowserStorage } from "../../kernel/test/helpers/owned-browser-storage";
import { beginPresentationIntent, finishPresentationIntent, readPresentationIntent } from "../src/app/presentation-intent";
import { executeAutomationIntent, editableAutomation } from "../src/app/automation-presentation";
import { runRetainedAutomationTick } from "../src/app/automation-tick";
import type { AutomationCommandPayloadV1 } from "@clay/schema/catalog";
import type { AutomationDefinitionV2, AutomationExecutionResultV1 } from "@clay/kernel";

it("executes source-bound automation drafts, preview, enable, pause, edit, run, notification and Undo through the real worker", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  const files = ownedBrowserStorage(); let drop = false; let dropped = false;
  const sent: Array<{ id: number; op: string; requestId?: string }> = [];
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (data: { id: number; ok: boolean }) => {
    if (drop && data.ok && sent.slice().reverse().find(row => row.id === data.id)?.op === "automationCommand") { drop = false; dropped = true; return; }
    queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent));
  } };
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: { id: number; op: string }) => { sent.push(structuredClone(data)); queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data) } as MessageEvent)); }, terminate: () => {} };
  vi.stubGlobal("self", scope); let client = new WorkerClient(transport as unknown as Worker);
  const values = new Map<string, string>(); const cache = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const command = async <T>(route: AutomationCommandPayloadV1["command"]["route"], payload: unknown): Promise<T> => {
    const read = await client.automationPresentation();
    const intent = beginPresentationIntent(cache, read.authorityTarget.appInstanceId, "automation", "automation.command",
      { authorityTarget: read.authorityTarget, command: { route, payload } }, () => client.createMutationContext());
    const result = await executeAutomationIntent<T>(client, intent);
    finishPresentationIntent(cache, intent.appInstanceId, "automation", intent.requestId); return result;
  };
  try {
    await import("../src/worker/db-worker"); const boot = await client.boot({ requestedAppId: null, appCache: [] });
    await client.seed("tracker", client.createMutationContext());
    const table = (await client.registryTables()).find(row => row.name === "items")!;
    await client.quickCapture("items", { name: "Owned automation row", status: "todo" }, table.semantic!.tableId, client.createMutationContext(), boot.selectedAppInstanceId);
    const read = await client.automationPresentation(); expect(read.availability.available).toBe(true); // owned in-memory driver, NOT an OPFS certificate
    const field = (name: string) => ({ tableId: table.semantic!.tableId, fieldId: table.columns.find(row => row.name === name)!.semantic!.fieldId, lastKnownName: name });
    drop = true;
    const lost = command<AutomationDefinitionV2>("saveAutomationDraft", { expectedRevision: null, input: { v: 2, name: "Two actions",
      trigger: { kind: "manual", table: { tableId: table.semantic!.tableId, lastKnownName: "items" },
        conditions: [{ field: field("name"), op: "eq", value: "Owned automation row" }] },
      actions: [{ kind: "set_fields", values: [{ field: field("status"), value: { source: "literal", value: "done" } }] },
        { kind: "notify", title: "Finished", body: "Owned local notice" }], runtime: { mode: "local", timeZone: "Pacific/Auckland", missedPolicy: "skip" } } }).catch(error => error);
    await vi.waitFor(() => expect(dropped).toBe(true));
    client = new WorkerClient(transport as unknown as Worker); expect(await lost).toMatchObject({ message: expect.stringContaining("outcome is unknown") });
    await client.boot({ requestedAppId: null, appCache: [] });
    const original = readPresentationIntent(cache, boot.selectedAppInstanceId, "automation")!;
    let rule = await executeAutomationIntent<AutomationDefinitionV2>(client, original);
    finishPresentationIntent(cache, original.appInstanceId, original.slot, original.requestId);
    expect((await client.listAutomations())).toHaveLength(1); expect(rule.actions).toHaveLength(2);
    const simulation = await client.simulateAutomation(rule.id, rule.definitionRevision, "enable");
    rule = await command("enableAutomation", { id: rule.id, expectedRevision: rule.definitionRevision, simulation });
    expect(rule.enabled).toBe(true);
    rule = await command("pauseAutomation", { id: rule.id, expectedRevision: rule.definitionRevision });
    expect(rule.enabled).toBe(false);
    rule = await command("saveAutomationDraft", { expectedRevision: rule.definitionRevision, input: { ...editableAutomation(rule), name: "Edited two actions" } });
    expect(rule.actions).toHaveLength(2); expect(rule.runtime.timeZone).toBe("Pacific/Auckland");
    const preview = await client.simulateAutomation(rule.id, rule.definitionRevision, "run_now");
    const run = await command<AutomationExecutionResultV1>("runAutomationNow", { id: rule.id, expectedRevision: rule.definitionRevision, simulation: preview });
    expect(run.kind).toBe("committed"); if (run.kind !== "committed") throw new Error("Owned run did not commit");
    const history = await client.automationRuns(rule.id); expect(history).toHaveLength(1);
    await command("undoAutomationRun", { id: history[0]!.id });
    expect((await client.automationRuns(rule.id))[0]?.undone).toBe(true);
    expect(await client.notifications()).toEqual([]);
    const secondPreview = await client.simulateAutomation(rule.id, rule.definitionRevision, "run_now");
    await command("runAutomationNow", { id: rule.id, expectedRevision: rule.definitionRevision, simulation: secondPreview });
    const notice = (await client.notifications())[0]; expect(notice).toBeDefined();
    if (notice) { await command("markNotificationRead", { id: notice.id }); expect((await client.notifications())[0]?.read).toBe(true); }
    let recipe = await command<AutomationDefinitionV2>("saveAutomationRecipeDraft", { request: { v: 1, recipeId: "weekly_checklist", recipeVersion: 1,
      mapping: { targetTableId: table.semantic!.tableId, titleFieldId: field("name").fieldId, title: "Scheduled owned row", weekday: 0, localTime: "12:01", timeZone: "UTC" } } });
    recipe = await command("enableAutomation", { id: recipe.id, expectedRevision: recipe.definitionRevision,
      simulation: await client.simulateAutomation(recipe.id, recipe.definitionRevision, "enable") });
    vi.setSystemTime(new Date("2026-09-13T12:01:00.000Z")); drop = true; dropped = false;
    const lostTick = runRetainedAutomationTick(cache, client, boot.selectedAppInstanceId).catch(error => error);
    await vi.waitFor(() => expect(dropped).toBe(true));
    client = new WorkerClient(transport as unknown as Worker); expect(await lostTick).toMatchObject({ message: expect.stringContaining("outcome is unknown") });
    await client.boot({ requestedAppId: null, appCache: [] });
    const recoveredTick = await runRetainedAutomationTick(cache, client, boot.selectedAppInstanceId);
    expect(recoveredTick.runs).toMatchObject([{ automationId: recipe.id, changed: 1 }]);
    expect((await runRetainedAutomationTick(cache, client, boot.selectedAppInstanceId)).runs).toEqual([]);
    expect(await client.automationRuns(recipe.id)).toHaveLength(1);
    const stale = await client.automationPresentation();
    await command("deleteAutomation", { id: rule.id });
    await expect(client.automationCommand({ authorityTarget: stale.authorityTarget, command: { route: "deleteAutomation", payload: { id: rule.id } } }, client.createMutationContext())).rejects.toThrow(/source/);
    expect((await client.listAutomations()).map(row => row.id)).toEqual([recipe.id]); expect(await client.automationRuns(rule.id)).toHaveLength(2);
    await client.shutdown(); const module = "../src/worker/db-worker.ts"; await import(`${module}?automation-reload`);
    client = new WorkerClient(transport as unknown as Worker); await client.boot({ requestedAppId: null, appCache: [] });
    expect(await client.automationRuns(rule.id)).toHaveLength(2);
    expect(sent.filter(row => row.op === "automationCommand" && row.requestId === original.requestId)).toHaveLength(1);
  } finally { await client.shutdown().catch(() => {}); files.close(); vi.unstubAllGlobals(); vi.useRealTimers(); }
}, 60_000);
