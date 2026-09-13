import { AutomationCommandPayloadV1, AutomationWorkspaceV1 } from "@clay/schema/catalog";
import type { AutomationDefinitionV2, AutomationDraftInputV2 } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { readPresentationIntent, reconcilePresentation, type PresentationIntent } from "./presentation-intent";

type Cache = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (app: string) => `clay_automation_workspace_v1:${app}`;
const bounded = (raw: string) => { if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error("Automation draft exceeds the UTF-8 bound"); };
export function readAutomationWorkspace(cache: Cache, app: string): AutomationWorkspaceV1 | null {
  const raw = cache.getItem(key(app)); if (raw === null) return null;
  bounded(raw); const value = AutomationWorkspaceV1.parse(JSON.parse(raw));
  if (value.authorityTarget.appInstanceId !== app) throw new Error("Automation draft belongs to another app");
  return value;
}
export function writeAutomationWorkspace(cache: Cache, value: AutomationWorkspaceV1): void {
  const parsed = AutomationWorkspaceV1.parse(value); const app = parsed.authorityTarget.appInstanceId;
  const previous = readAutomationWorkspace(cache, app);
  if (previous && previous.draftId !== parsed.draftId) throw new Error("Previous draft identity must be explicitly closed");
  const pending = readPresentationIntent(cache, app, "automation");
  if (pending && JSON.stringify(previous) !== JSON.stringify(parsed)) throw new Error("An immutable automation request needs reconciliation before editing");
  const raw = JSON.stringify(parsed); bounded(raw); cache.setItem(key(app), raw);
  if (JSON.stringify(readAutomationWorkspace(cache, app)) !== raw) throw new Error("Automation draft failed presentation readback");
}
export function clearAutomationWorkspace(cache: Cache, value: AutomationWorkspaceV1): void {
  const app = value.authorityTarget.appInstanceId;
  if (readPresentationIntent(cache, app, "automation")) throw new Error("Pending automation outcome must be reconciled before discarding its draft");
  if (JSON.stringify(readAutomationWorkspace(cache, app)) !== JSON.stringify(value)) throw new Error("Automation draft changed");
  cache.removeItem(key(app)); if (cache.getItem(key(app)) !== null) throw new Error("Automation draft cleanup failed");
}
/** Select only draft metadata; preserve every nested action, condition, value
 * source, runtime policy and recipe without round-tripping a one-action form. */
export function editableAutomation(rule: AutomationDefinitionV2): AutomationDraftInputV2 {
  return structuredClone({ v: 2, id: rule.id, name: rule.name, trigger: rule.trigger, actions: rule.actions,
    runtime: rule.runtime, ...(rule.recipe ? { recipe: rule.recipe } : {}) });
}
export async function executeAutomationIntent<T>(worker: WorkerClient, intent: PresentationIntent): Promise<T> {
  if (intent.slot !== "automation") throw new Error("Original automation request required");
  const payload = AutomationCommandPayloadV1.parse(intent.payload);
  return reconcilePresentation(worker, intent, () => worker.automationCommand<T>(payload, { requestId: intent.requestId }));
}
