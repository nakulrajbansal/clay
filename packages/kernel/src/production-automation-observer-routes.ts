import { ClayError } from "./errors";
import type {
  AutomationDraftInputV2, AutomationRecipeDraftRequestV1,
  AutomationRunNowRequestV1, AutomationSimulationProofV1, AutomationTargetIdentityV1,
} from "./automation-v2";
import { ClayStore } from "./store";
import type { AutomationPhysicalTransactionCapability } from "./db";

export type AutomationObserverAuthorityRoute =
  | "upsertAutomation"
  | "saveAutomationDraft"
  | "saveAutomationRecipeDraft"
  | "enableAutomation"
  | "pauseAutomation"
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
const STORE_LIST_AUTOMATIONS: ClayStore["listAutomations"] =
  ClayStore.prototype.listAutomations;
const STORE_SAVE_AUTOMATION_DRAFT: ClayStore["saveAutomationDraft"] =
  ClayStore.prototype.saveAutomationDraft;
const STORE_SAVE_AUTOMATION_RECIPE_DRAFT: ClayStore["saveAutomationRecipeDraft"] =
  ClayStore.prototype.saveAutomationRecipeDraft;
const STORE_ENABLE_AUTOMATION: ClayStore["enableAutomation"] =
  ClayStore.prototype.enableAutomation;
const STORE_PAUSE_AUTOMATION: ClayStore["pauseAutomation"] =
  ClayStore.prototype.pauseAutomation;
const STORE_DELETE_AUTOMATION: ClayStore["deleteAutomation"] =
  ClayStore.prototype.deleteAutomation;
const STORE_RUN_AUTOMATION_NOW = ClayStore.prototype.runAutomationNow as unknown as
  ((this: ClayStore, request: AutomationRunNowRequestV1, now?: Date) => unknown);
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

const AUTOMATION_MUTATION_ROUTES = new Set<AutomationObserverAuthorityRoute>([
  "upsertAutomation", "saveAutomationDraft", "saveAutomationRecipeDraft",
  "enableAutomation", "pauseAutomation", "deleteAutomation", "runDueAutomations",
  "runAutomationNow", "undoAutomationRun", "markNotificationRead",
]);

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
  target: AutomationTargetIdentityV1,
  transactionCapability: AutomationPhysicalTransactionCapability,
): unknown {
  if (AUTOMATION_MUTATION_ROUTES.has(route)
      && (transactionCapability.kind !== "test_memory"
        || transactionCapability.releaseCertificate !== true))
    throw new ClayError("E_CATALOG_UNAVAILABLE",
      "automation mutation is unavailable: release-bound physical transaction is uncertified");
  switch (route) {
    case "upsertAutomation": {
      const saved = STORE_UPSERT_AUTOMATION.call(
        store, payload.input as Parameters<ClayStore["upsertAutomation"]>[0],
      );
      const canonical = STORE_LIST_AUTOMATIONS.call(store)
        .find(candidate => candidate.id === saved.id);
      if (!canonical) throw new ClayError("E_INTERNAL", "saved automation read-back is missing");
      return canonical;
    }
    case "saveAutomationDraft":
      return STORE_SAVE_AUTOMATION_DRAFT.call(
        store,
        payload.input as AutomationDraftInputV2,
        payload.expectedRevision === null ? undefined : payload.expectedRevision as number,
        automationInstant(executionInstant),
      );
    case "saveAutomationRecipeDraft":
      return STORE_SAVE_AUTOMATION_RECIPE_DRAFT.call(
        store,
        payload.request as AutomationRecipeDraftRequestV1,
        automationInstant(executionInstant),
      );
    case "enableAutomation":
      return STORE_ENABLE_AUTOMATION.call(store, {
        id: payload.id as string,
        target,
        expectedRevision: payload.expectedRevision as number,
        simulation: payload.simulation as AutomationSimulationProofV1,
      }, automationInstant(executionInstant));
    case "pauseAutomation":
      return STORE_PAUSE_AUTOMATION.call(store, {
        id: payload.id as string,
        expectedRevision: payload.expectedRevision as number,
      }, automationInstant(executionInstant));
    case "deleteAutomation":
      STORE_DELETE_AUTOMATION.call(store, payload.id as string);
      return null;
    case "runAutomationNow":
      return STORE_RUN_AUTOMATION_NOW.call(store, {
        id: payload.id as string,
        target,
        expectedRevision: payload.expectedRevision as number,
        simulation: payload.simulation as AutomationSimulationProofV1,
      }, automationInstant(executionInstant));
    case "runDueAutomations":
      return STORE_RUN_DUE_AUTOMATIONS.call(store, target, automationInstant(executionInstant));
    case "undoAutomationRun":
      return STORE_UNDO_AUTOMATION_RUN.call(store, { id: payload.id as string, target });
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
