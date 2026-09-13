import { expect, it, vi } from "vitest";
import type { DailyPresentationV1 } from "@clay/schema/catalog";
import { DAILY_HOME_SOURCE_IDS_V1 } from "@clay/schema/daily-home";
import { createWorkerMutationContext, type WorkerClient } from "../src/app/worker-client";
import { beginDailyCas, executeDailyCas, favoriteValue } from "../src/app/daily-intent";
import { cancelPresentationIntent, readPresentationIntent } from "../src/app/presentation-intent";

export function dailyReviewFixture(): DailyPresentationV1 {
  const appInstanceId = `app_${"a".repeat(26)}`; const activeGenerationId = `gen_${"b".repeat(26)}`;
  return { authorityTarget: { appInstanceId, activeGenerationId, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1,
    stateSha256: `sha256:${"c".repeat(64)}` }, sourceLibrary: null, navigation: null, snapshot: {
    snapshotDigest: `sha256:${"d".repeat(64)}`, basis: { appInstanceId, activeGenerationId, schemaHead: "version:1", profileRevision: 0,
      profileDigest: `sha256:${"e".repeat(64)}`, profileResolution: { readyProfileIds: [], issueProfileIds: [] }, libraryRevision: 0,
      dispositionWatermark: "0", sourceWatermarks: DAILY_HOME_SOURCE_IDS_V1.map(sourceId => ({ sourceId,
        watermark: sourceId === "recovery_notice" ? null : "0", status: sourceId === "recovery_notice" ? "unavailable" : "ready", statusEpoch: "1" })),
      localDate: "2026-09-13", timeZone: "UTC", rankingVersion: "daily-rank-v1", projectionValidUntil: "2026-09-14T00:00:00.000Z" },
  } } as unknown as DailyPresentationV1;
}
it("keeps the reviewed app, projection, desired pin and immutable request across response loss and reload", async () => {
  const rows = new Map<string, string>(); const cache = { getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const reviewed = dailyReviewFixture();
  const value = favoriteValue(reviewed, "tbl_018f4c2a-7b31-7001-8000-000000000001", "018f4c2a-7b31-7001-8000-000000000011", true, "2026-09-13T01:00:00.000Z");
  let recorded = false;
  const worker = { createMutationContext: createWorkerMutationContext, mutationOutcome: vi.fn(async () => recorded
    ? { status: "recorded", current: false, result: { ok: true, current: value }, target: reviewed.authorityTarget } : { status: "not_invoked" }),
    compareAndSetDailyNavigation: vi.fn(async () => { recorded = true; throw new Error("Lost response after pin"); }),
    cancelPresentation: vi.fn(async () => ({ status: "uncertain" })),
  } as unknown as WorkerClient;
  const intent = beginDailyCas(cache, worker, reviewed, "dailyNavigation", 0, value);
  await expect(executeDailyCas(worker, intent)).rejects.toThrow(/Lost response/);
  reviewed.authorityTarget.appInstanceId = `app_${"z".repeat(26)}`;
  const retained = readPresentationIntent(cache, intent.appInstanceId, "dailyNavigation")!;
  expect(retained).toEqual(intent);
  expect(await executeDailyCas(worker, retained)).toMatchObject({ ok: true, current: value });
  expect(worker.compareAndSetDailyNavigation).toHaveBeenCalledTimes(1);
  expect(worker.compareAndSetDailyNavigation).toHaveBeenCalledWith(0, value, { requestId: intent.requestId }, intent.payload.review);
  await expect(cancelPresentationIntent(cache, worker, retained)).rejects.toThrow(/uncertain/);
  expect(readPresentationIntent(cache, intent.appInstanceId, "dailyNavigation")).toEqual(intent);
  expect(() => beginDailyCas(cache, worker, { ...dailyReviewFixture(), navigation: value }, "dailyNavigation", 1,
    favoriteValue({ ...dailyReviewFixture(), navigation: value }, value.favorites[0]!.tableId, value.favorites[0]!.rowId, false))).toThrow(/immutable/);
});
