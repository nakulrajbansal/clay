import { expect, it, vi } from "vitest";
import { beginPresentationIntent, cancelPresentationIntent, finishPresentationIntent, readPresentationIntent } from "../src/app/presentation-intent";
const app = `app_${"a".repeat(26)}`; const requestId = `req_${"b".repeat(26)}`;
const capture = () => ({ appInstanceId: app, table: "tasks", tableId: "tbl_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", row: { title: "Original" } });
function storage() {
  const rows = new Map<string, string>(); return { getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
}
it("retains cancellation identity across lost responses and never clears a winning or uncertain invocation", async () => {
  const cache = storage(); const intent = beginPresentationIntent(cache, app, "capture", "daily.capture", capture(), () => ({ requestId }));
  const worker = { cancelPresentation: vi.fn().mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce({ status: "recorded" }).mockResolvedValueOnce({ status: "uncertain" }).mockResolvedValue({ status: "cancelled" }) };
  await expect(cancelPresentationIntent(cache, worker, intent)).rejects.toThrow(/lost/);
  expect(await cancelPresentationIntent(cache, worker, intent)).toBe(false);
  await expect(cancelPresentationIntent(cache, worker, intent)).rejects.toThrow(/uncertain/);
  expect(readPresentationIntent(cache, app, "capture")).toEqual(intent);
  expect(await cancelPresentationIntent(cache, worker, intent)).toBe(true);
  expect(readPresentationIntent(cache, app, "capture")).toBeNull();
  expect(worker.cancelPresentation.mock.calls.every(args => JSON.stringify(args) === JSON.stringify([intent.route, intent.payload, { requestId }]))).toBe(true);
});
it("persists only immutable source-bound presentation requests and resumes after teardown/reload", () => {
  const cache = storage(); const payload = capture();
  const first = beginPresentationIntent(cache, app, "capture", "daily.capture", payload, () => ({ requestId }));
  payload.row.title = "Changed";
  expect(readPresentationIntent(cache, app, "capture")).toEqual(first);
  expect(Object.isFrozen(first.payload)).toBe(true);
  expect(() => beginPresentationIntent(cache, app, "capture", "daily.capture", payload, () => ({ requestId }))).toThrow(/immutable/);
  expect(readPresentationIntent(cache, `app_${"c".repeat(26)}`, "capture")).toBeNull();
  expect(() => finishPresentationIntent(cache, app, "capture", `req_${"d".repeat(26)}`)).toThrow(/identity/);
  finishPresentationIntent(cache, app, "capture", requestId);
  expect(readPresentationIntent(cache, app, "capture")).toBeNull();
});
it("fails closed before execution when storage or full UTF-8 payload bounds fail", () => {
  const cache = storage(); cache.setItem = () => {};
  expect(() => beginPresentationIntent(cache, app, "capture", "daily.capture", capture(), () => ({ requestId }))).toThrow(/read-back/);
  expect(() => beginPresentationIntent(storage(), app, "capture", "daily.capture", { title: "€".repeat(700_000) }, () => ({ requestId }))).toThrow(/bound|large/);
});
it("rejects malformed, cross-slot and rebound cached payloads before modal rendering", () => {
  const cache = storage();
  const value = beginPresentationIntent(cache, app, "capture", "daily.capture", capture(), () => ({ requestId }));
  for (const invalid of [
    { ...value, payload: {} },
    { ...value, payload: { ...capture(), row: null } },
    { ...value, payload: { ...capture(), appInstanceId: `app_${"c".repeat(26)}` } },
    { ...value, payload: { ...capture(), extra: "unrecognized" } },
    { ...value, route: "schema.undoRelationConversion", payload: { conversionRequestId: requestId, beforeVersion: 1 } },
  ]) {
    cache.setItem(`clay_presentation_intent_v1:${app}:capture`, JSON.stringify(invalid));
    expect(() => readPresentationIntent(cache, app, "capture")).toThrow();
    expect(cache.getItem(`clay_presentation_intent_v1:${app}:capture`)).toBe(JSON.stringify(invalid));
  }
});
