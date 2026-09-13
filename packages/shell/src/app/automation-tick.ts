import type { AutomationRun } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { beginPresentationIntent, finishPresentationIntent, readPresentationIntent } from "./presentation-intent";
import { executeAutomationIntent, readAutomationWorkspace } from "./automation-presentation";

type Cache = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Local-session polling never mints a replacement for an ambiguous invocation.
 * Presentation caches may suppress a tick, never authorize its durable effects. */
export async function runRetainedAutomationTick(cache: Cache, worker: WorkerClient, app: string) {
  const read = await worker.automationPresentation();
  if (read.authorityTarget.appInstanceId !== app) throw new Error("Scheduled source changed; nothing was invoked");
  const idle = (reason: string | null) => ({ available: read.availability.available, reason, runs: [] as AutomationRun[], notifications: read.notifications });
  if (!read.availability.available) return idle("physical_transaction_uncertified");
  let intent = readPresentationIntent(cache, app, "automation");
  if (intent && (intent.payload.command as { route: string }).route !== "runDueAutomations") return idle("pending_automation_request");
  if (!intent) {
    for (const slot of ["capture", "captureUndo", "relation", "conversionUndo", "dailySource", "dailyNavigation", "dailyInbox", "dailyInboxUndo"] as const)
      if (readPresentationIntent(cache, app, slot)) return idle("pending_review_or_undo");
    if (readAutomationWorkspace(cache, app)) return idle("retained_automation_draft");
    if (!read.rules.some(rule => rule.enabled)) return idle(null);
    intent = beginPresentationIntent(cache, app, "automation", "automation.command", {
      authorityTarget: read.authorityTarget, command: { route: "runDueAutomations", payload: {} },
    }, () => worker.createMutationContext());
  }
  const runs = await executeAutomationIntent<AutomationRun[]>(worker, intent);
  const after = await worker.automationPresentation();
  if (after.authorityTarget.appInstanceId !== app) throw new Error("Scheduled outcome needs original-source readback");
  finishPresentationIntent(cache, app, "automation", intent.requestId);
  return { available: true, reason: null, runs, notifications: after.notifications };
}
