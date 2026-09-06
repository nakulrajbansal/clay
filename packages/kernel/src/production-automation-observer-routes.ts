import { ClayError } from "./errors";
import { ClayStore } from "./store";

export type AutomationObserverAuthorityRoute =
  | "upsertAutomation"
  | "deleteAutomation"
  | "runDueAutomations"
  | "runAutomationNow"
  | "undoAutomationRun"
  | "markNotificationRead"
  | "recordUsage"
  | "acceptSuggestion"
  | "dismissSuggestion";

const STORE_UPSERT_AUTOMATION: ClayStore["upsertAutomation"] =
  ClayStore.prototype.upsertAutomation;
const STORE_DELETE_AUTOMATION: ClayStore["deleteAutomation"] =
  ClayStore.prototype.deleteAutomation;
const STORE_RUN_AUTOMATION_NOW: ClayStore["runAutomationNow"] =
  ClayStore.prototype.runAutomationNow;
const STORE_RUN_DUE_AUTOMATIONS: ClayStore["runDueAutomations"] =
  ClayStore.prototype.runDueAutomations;
const STORE_UNDO_AUTOMATION_RUN: ClayStore["undoAutomationRun"] =
  ClayStore.prototype.undoAutomationRun;
const STORE_MARK_NOTIFICATION_READ: ClayStore["markNotificationRead"] =
  ClayStore.prototype.markNotificationRead;
const STORE_RECORD_USAGE: ClayStore["recordUsage"] = ClayStore.prototype.recordUsage;
const STORE_ACCEPT_SUGGESTION: ClayStore["acceptSuggestion"] =
  ClayStore.prototype.acceptSuggestion;
const STORE_DISMISS_SUGGESTION: ClayStore["dismissSuggestion"] =
  ClayStore.prototype.dismissSuggestion;

function automationInstant(instant: string | null): Date {
  if (instant === null)
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "trusted automation instant is unavailable");
  return new Date(instant);
}

/** Executes only already-captured automation/observer payloads synchronously. */
export function executeAutomationObserverAuthorityRoute(
  store: ClayStore,
  route: AutomationObserverAuthorityRoute,
  payload: Readonly<Record<string, unknown>>,
  executionInstant: string | null,
): unknown {
  switch (route) {
    case "upsertAutomation":
      return STORE_UPSERT_AUTOMATION.call(
        store, payload.input as Parameters<ClayStore["upsertAutomation"]>[0],
      );
    case "deleteAutomation":
      STORE_DELETE_AUTOMATION.call(store, payload.id as string);
      return null;
    case "runAutomationNow":
      return STORE_RUN_AUTOMATION_NOW.call(
        store, payload.id as string, automationInstant(executionInstant),
      );
    case "runDueAutomations":
      return STORE_RUN_DUE_AUTOMATIONS.call(store, automationInstant(executionInstant));
    case "undoAutomationRun":
      return STORE_UNDO_AUTOMATION_RUN.call(store, payload.id as string);
    case "markNotificationRead":
      STORE_MARK_NOTIFICATION_READ.call(store, payload.id as string);
      return null;
    case "recordUsage":
      STORE_RECORD_USAGE.call(
        store, payload.event as Parameters<ClayStore["recordUsage"]>[0],
      );
      return null;
    case "acceptSuggestion":
      STORE_ACCEPT_SUGGESTION.call(store, payload.subject as string, payload.kind as string);
      return null;
    case "dismissSuggestion":
      STORE_DISMISS_SUGGESTION.call(store, payload.subject as string, payload.kind as string);
      return null;
  }
}
