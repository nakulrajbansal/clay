import type { AutomationRun } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { beginPresentationIntent, cancelPresentationIntent, finishPresentationIntent, readPresentationIntent } from "./presentation-intent";
import { executeAutomationIntent, readAutomationWorkspace } from "./automation-presentation";

type Cache = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Local-session polling never mints a replacement for an ambiguous invocation.
 * Presentation caches may suppress a tick, never authorize its durable effects. */
export async function runRetainedAutomationTick(cache: Cache, worker: WorkerClient, app: string,
  recoverIntake: () => Promise<boolean> = async () => { throw new Error("Trusted-shell intake recovery is required"); }) {
  const read = await worker.automationPresentation();
  if (read.authorityTarget.appInstanceId !== app) throw new Error("Scheduled source changed; nothing was invoked");
  const idle = (reason: string | null) => ({ available: read.availability.available, reason, runs: [] as AutomationRun[], notifications: read.notifications });
  if (!read.availability.available) return idle("physical_transaction_uncertified");
  let intent = readPresentationIntent(cache, app, "automation");
  if (intent && (intent.payload.command as { route: string }).route !== "runDueAutomations") return idle("pending_automation_request");
  if (intent) {
    const outcome = await worker.mutationOutcome(intent.route, intent.payload, { requestId: intent.requestId });
    if (outcome.status === "uncertain") throw new Error("Scheduled outcome is uncertain; original request was kept");
    if (outcome.status === "failed" || outcome.status === "cancelled" || (outcome.status === "not_invoked"
        && JSON.stringify(intent.payload.authorityTarget) !== JSON.stringify(read.authorityTarget))) {
      if (await cancelPresentationIntent(cache, worker, intent)) return idle("scheduled_request_terminalized");
      // A racing invocation won. Read its original result below; never retarget.
    }
  }
  if (!intent) {
    // Loss of a presentation cache is not proof that durable owner publication
    // is idle. The shell supplies the origin-bound workflow read, never secrets.
    try { if (await recoverIntake()) return idle("pending_intake_delivery"); }
    catch { return idle("intake_recovery_unavailable"); }
    for (const slot of ["capture", "captureUndo", "relation", "conversionUndo", "dailySource", "dailyNavigation", "dailyInbox", "dailyInboxUndo", "intake"] as const)
      if (readPresentationIntent(cache, app, slot)) return idle("pending_review_or_undo");
    if (cache.getItem(`clay_intake_publication_v1:${app}`) || cache.getItem(`clay_intake_revocation_v1:${app}`)) return idle("pending_intake_delivery");
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
