import { DailyNavigationCasPayloadV1, DailyNavigationStateV1, DailySourceCasPayloadV1, type DailyCasReviewV1,
  type DailyPresentationV1, DailyInboxActionPayloadV1, DailyInboxUndoPayloadV1, DailyInboxReceiptV1 } from "@clay/schema/standalone/catalog";
import { DAILY_SOURCE_LIBRARY_SETTING, type DailySourceProfileStorage } from "@clay/kernel/daily-source-profile";
import { beginPresentationIntent, readPresentationIntent, reconcilePresentation, type PresentationIntent } from "./presentation-intent";
import type { WorkerClient } from "./worker-client";

type Cache = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function dailyCasReview(read: DailyPresentationV1): DailyCasReviewV1 {
  return { authorityTarget: read.authorityTarget, basis: read.snapshot.basis, snapshotDigest: read.snapshot.snapshotDigest };
}
export function beginDailyCas(cache: Cache, worker: WorkerClient, reviewed: DailyPresentationV1,
  slot: "dailySource" | "dailyNavigation", expectedRevision: number, value: unknown): PresentationIntent {
  return beginPresentationIntent(cache, reviewed.authorityTarget.appInstanceId, slot, slot === "dailySource" ? "daily.source" : "daily.navigation",
    { expectedRevision, value, review: dailyCasReview(reviewed) }, () => worker.createMutationContext());
}
export async function executeDailyCas(worker: WorkerClient, intent: PresentationIntent): Promise<{ ok: boolean; current: unknown }> {
  if (intent.slot === "dailySource") {
    const payload = DailySourceCasPayloadV1.parse(intent.payload);
    return reconcilePresentation(worker, intent, () => worker.compareAndSetDailySource(payload.expectedRevision, payload.value,
      { requestId: intent.requestId }, payload.review));
  }
  if (intent.slot !== "dailyNavigation") throw new Error("Original Daily CAS intent required");
  const payload = DailyNavigationCasPayloadV1.parse(intent.payload);
  return reconcilePresentation(worker, intent, () => worker.compareAndSetDailyNavigation(payload.expectedRevision, payload.value,
    { requestId: intent.requestId }, payload.review));
}
export function reviewedSourceStorage(cache: Cache, worker: WorkerClient, reviewed: DailyPresentationV1,
  onIntent: (intent: PresentationIntent) => void): DailySourceProfileStorage {
  return {
    getSetting: async <T>(key: string) => {
      if (key !== DAILY_SOURCE_LIBRARY_SETTING) throw new Error("Source review cannot read another setting");
      return structuredClone(reviewed.sourceLibrary) as T;
    },
    compareAndSetDailySource: async (expectedRevision, value) => {
      const intent = beginDailyCas(cache, worker, reviewed, "dailySource", expectedRevision, value); onIntent(intent);
      const result = await executeDailyCas(worker, intent);
      // Do not let the compatibility helper compute another value/revision/ID.
      if (!result.ok) throw new Error("Reviewed source CAS did not win. Reconcile its request before reviewing again.");
      return result;
    },
  };
}
function navigation(read: DailyPresentationV1) {
  return DailyNavigationStateV1.parse(read.navigation ?? { schema: 1, revision: 0, favorites: [], recents: [] });
}
export function favoriteValue(read: DailyPresentationV1, tableId: string, rowId: string, favorite: boolean,
  pinnedAt = new Date().toISOString()) {
  const current = navigation(read);
  const others = current.favorites.filter(ref => ref.tableId !== tableId || ref.rowId !== rowId);
  const existing = current.favorites.find(ref => ref.tableId === tableId && ref.rowId === rowId);
  return DailyNavigationStateV1.parse({ ...current, revision: current.revision + 1,
    favorites: favorite ? [existing ?? { tableId, rowId, pinnedAt }, ...others].slice(0, 50) : others });
}
export function recentValue(read: DailyPresentationV1, tableId: string, rowId: string, openedAt = new Date().toISOString()) {
  const current = navigation(read);
  return DailyNavigationStateV1.parse({ ...current, revision: current.revision + 1,
    recents: [{ tableId, rowId, openedAt }, ...current.recents.filter(ref => ref.tableId !== tableId || ref.rowId !== rowId)].slice(0, 20) });
}

export async function executeInboxIntent(cache: Cache, worker: WorkerClient, intent: PresentationIntent) {
  if (intent.slot === "dailyInboxUndo") {
    return reconcilePresentation(worker, intent, () => worker.dailyInboxUndo(DailyInboxUndoPayloadV1.parse(intent.payload), { requestId: intent.requestId }));
  }
  if (intent.slot !== "dailyInbox") throw new Error("Original Inbox intent required");
  const result = DailyInboxReceiptV1.parse(await reconcilePresentation(worker, intent,
    () => worker.dailyInboxAction(DailyInboxActionPayloadV1.parse(intent.payload), { requestId: intent.requestId })));
  const previous = readPresentationIntent(cache, intent.appInstanceId, "dailyInboxUndo");
  if (previous) {
    if (previous.payload.actionRequestId !== intent.requestId || JSON.stringify(previous.payload.actionPayload) !== JSON.stringify(intent.payload))
      throw new Error("Previous Inbox Undo needs reconciliation first");
  } else {
    const outcome = await worker.mutationOutcome(intent.route, intent.payload, { requestId: intent.requestId });
    if (outcome.status !== "recorded") throw new Error("Inbox receipt needs recovery before presenting Undo");
    beginPresentationIntent(cache, intent.appInstanceId, "dailyInboxUndo", "daily.undoInbox",
      { actionRequestId: intent.requestId, actionPayload: intent.payload, authorityTarget: outcome.target }, () => worker.createMutationContext());
  }
  return result;
}
