import type { DailyCasReviewV1, TargetEvidenceV1 } from "@clay/schema/catalog";
import { ClayStore, PRODUCTION_STORE_PRIMITIVES as ops } from "./store";
import { projectDailyHome } from "./daily-home-projection";
import { readSampleRowProvenance } from "./production-samples";
import { ClayError } from "./errors";
import { assertExactPresentationTarget } from "./production-presentation-proof";
import { stableJson } from "./stable-json";

const reads = Object.freeze({ listNotifications: ClayStore.prototype.listNotifications,
  dailyHomeUnreadNotifications: ClayStore.prototype.dailyHomeUnreadNotifications,
  dailyHomeRecordRevisions: ClayStore.prototype.dailyHomeRecordRevisions,
  dailyHomeNotificationWatermark: ClayStore.prototype.dailyHomeNotificationWatermark });

/** Shared by the paired worker read and shadow/live CAS validation. Only pinned
 * read primitives participate; samples come from the validated provenance ledger. */
export function productionDailyPresentation(store: ClayStore, target: TargetEvidenceV1, now: string) {
  const timeZone = ops.getSetting.call(store, "daily_time_zone_v1");
  if (typeof timeZone !== "string") throw new ClayError("E_CONFLICT", "Daily Home calendar is not initialized");
  const registry = new Map([...ops.validationRegistrySnapshot.call(store)].filter(([, table]) => !table.inactive)
    .map(([name, table]) => [name, { ...table, columns: table.columns.filter(column => !column.inactive) }]));
  let samples: { format: 1; tables: Record<string, readonly string[]> } | undefined;
  try { samples = { format: 1, tables: Object.fromEntries(Object.entries(readSampleRowProvenance(store)).filter(([table]) => registry.has(table))) }; }
  catch { /* Preserve partial-source reporting; never guess provenance. */ }
  const snapshot = projectDailyHome({ registrySnapshot: () => registry, query: query => ops.query.call(store, query),
    inboxDispositions: () => ops.inboxDispositions.call(store),
    headVersion: () => ops.headVersion.call(store),
    listNotifications: reads.listNotifications.bind(store), dailyHomeUnreadNotifications: reads.dailyHomeUnreadNotifications.bind(store),
    dailyHomeRecordRevisions: reads.dailyHomeRecordRevisions.bind(store), dailyHomeNotificationWatermark: reads.dailyHomeNotificationWatermark.bind(store),
    getSetting: <T>(key: string): T | undefined => (key === "sample_rows" ? samples : ops.getSetting.call(store, key)) as T | undefined,
  }, { appInstanceId: target.appInstanceId, activeGenerationId: target.activeGenerationId, now, timeZone });
  return { authorityTarget: target, snapshot, sourceLibrary: ops.getSetting.call(store, "daily_source_library_v1") ?? null,
    navigation: ops.getSetting.call(store, "daily_navigation_v1") ?? null };
}

export function assertReviewedDailyProjection(store: ClayStore, target: TargetEvidenceV1, review: DailyCasReviewV1, now: string) {
  assertExactPresentationTarget(review.authorityTarget, target);
  const snapshot = productionDailyPresentation(store, target, now).snapshot;
  if (stableJson(snapshot.basis) !== stableJson(review.basis) || snapshot.snapshotDigest !== review.snapshotDigest)
    throw new ClayError("E_CONFLICT", "Reviewed Daily projection changed; cancel the original request before reviewing again");
  return snapshot;
}
