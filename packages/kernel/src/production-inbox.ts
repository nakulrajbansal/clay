import { DailyInboxReceiptV1, type DailyInboxActionPayloadV1, type DailyInboxUndoPayloadV1, type TargetEvidenceV1 } from "@clay/schema/catalog";
import { InboxDispositionV1 } from "@clay/schema/daily-home";
import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import { PRODUCTION_STORE_PRIMITIVES as ops, type ClayStore } from "./store";
import { assertReviewedDailyProjection } from "./production-daily-projection";
import { assertExactPresentationTarget, originalPresentationResult } from "./production-presentation-proof";
import { stableJson } from "./stable-json";
import { loadDailySourceLibrary, resolveDailySourceProfiles } from "./daily-source-profile";
import { localCalendarContext, resolveLocalDateTime } from "./daily-calendar";

function conflict(message: string): never { throw new ClayError("E_CONFLICT", message); }
function nextRevision(store: ClayStore) { return Math.max(0, ...ops.inboxDispositions.call(store).map(row => row.revision)) + 1; }

export function executeInboxAction(store: ClayStore, requestId: string, payload: DailyInboxActionPayloadV1, target: TargetEvidenceV1, now: string) {
  const snapshot = assertReviewedDailyProjection(store, target, payload.review, now);
  const projected = snapshot.sources.flatMap(source => source.page.items).find(item => stableJson(item) === stableJson(payload.item));
  if (!projected || (projected.kind !== "due_record" && projected.kind !== "automation_notification") || !projected.actions.includes(payload.action))
    conflict("Reviewed Inbox item, generation or action no longer matches the source projection");
  let until: string | null = null;
  if (payload.action === "snooze") {
    const calendar = localCalendarContext(now, payload.review.basis.timeZone);
    const days = (Date.parse(`${payload.untilLocalDate}T00:00:00.000Z`) - Date.parse(`${calendar.localDate}T00:00:00.000Z`)) / 86_400_000;
    if (!Number.isInteger(days) || days < 1 || days > 30) conflict("Choose a Snooze local date within the next 30 days");
    until = resolveLocalDateTime(`${payload.untilLocalDate}T00:00`, payload.review.basis.timeZone).instant;
  }
  const disposition = InboxDispositionV1.parse({ schema: 1, sourceKey: projected.sourceKey, sourceGeneration: projected.sourceGeneration,
    revision: nextRevision(store), requestId, state: payload.action === "complete" ? "active" : payload.action === "dismiss" ? "dismissed" : "snoozed",
    until, localDate: payload.untilLocalDate ?? null, timeZone: until ? payload.review.basis.timeZone : null });
  let batchId: string | null = null;
  if (payload.action === "complete") {
    if (projected.kind !== "due_record" || projected.route.kind !== "record") conflict("This source cannot Complete a record");
    const tableId = projected.route.tableId;
    const library = loadDailySourceLibrary(ops.getSetting.call(store, "daily_source_library_v1"));
    const profile = resolveDailySourceProfiles(ops.validationRegistrySnapshot.call(store), library).ready.find(profile => profile.tableId === tableId);
    if (!profile || profile.completion.kind === "none") conflict("Review the source completion field first");
    const receipt = ops.applyBatch.call(store, { source: "user", summary: "Complete from Daily Inbox", mutations: [{ kind: "update",
      table: profile.tableName, id: projected.route.rowId,
      patch: { [profile.completion.columnName]: profile.completion.kind === "boolean" ? true : profile.completion.completeValue } }] });
    if (receipt.changed !== 1) conflict("Complete did not change exactly its reviewed record");
    batchId = receipt.id;
  }
  return DailyInboxReceiptV1.parse({ ...ops.writeInboxDisposition.call(store, { expectedRevision: projected.dispositionRevision, value: disposition }), batchId });
}

export function undoInboxAction(store: ClayStore, driver: DbDriver, requestId: string, payload: DailyInboxUndoPayloadV1, target: TargetEvidenceV1) {
  assertExactPresentationTarget(payload.authorityTarget, target);
  const proof = originalPresentationResult(driver, target, payload.actionRequestId, "daily.inbox", payload.actionPayload);
  assertExactPresentationTarget(proof.target, target);
  const receipt = DailyInboxReceiptV1.parse(proof.result);
  const current = ops.inboxDispositions.call(store).find(row => row.sourceKey === payload.actionPayload.item.sourceKey);
  if (stableJson(current) !== stableJson(receipt.disposition) || receipt.disposition.requestId !== payload.actionRequestId
      || receipt.disposition.sourceGeneration !== payload.actionPayload.item.sourceGeneration) conflict("Original Inbox receipt no longer matches its disposition");
  if (receipt.batchId) ops.undoBatch.call(store, receipt.batchId);
  const previous = receipt.previous;
  const value = InboxDispositionV1.parse({ ...(previous ?? { schema: 1, sourceKey: receipt.disposition.sourceKey,
    sourceGeneration: receipt.disposition.sourceGeneration, state: "active", until: null, localDate: null, timeZone: null }),
    revision: nextRevision(store), requestId });
  const result = ops.writeInboxDisposition.call(store, { expectedRevision: receipt.disposition.revision, value });
  return { undone: true, disposition: result.disposition };
}
