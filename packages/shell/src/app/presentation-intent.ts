import { PresentationIntentV1 } from "@clay/schema/catalog";
import type { WorkerMutationContext } from "./worker-client";
import type { WorkerClient } from "./worker-client";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type PresentationIntent = PresentationIntentV1;
type Slot = PresentationIntent["slot"];
const key = (app: string, slot: Slot) => `clay_presentation_intent_v1:${app}:${slot}`;
function bounded(raw: string): void {
  if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error("Retry intent exceeds the UTF-8 payload bound");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function readPresentationIntent(storage: Storage, app: string, slot: Slot): PresentationIntent | null {
  const raw = storage.getItem(key(app, slot)); if (raw === null) return null;
  bounded(raw); const value = PresentationIntentV1.parse(JSON.parse(raw));
  if (value.appInstanceId !== app || value.slot !== slot) throw new Error("Retry intent belongs to another source");
  return freeze(value);
}
export function beginPresentationIntent(storage: Storage, app: string, slot: Slot, route: PresentationIntent["route"],
  payload: unknown, mint: () => WorkerMutationContext): PresentationIntent {
  const previous = readPresentationIntent(storage, app, slot);
  const raw = JSON.stringify({ schema: 1, appInstanceId: app, slot, route, payload,
    requestId: previous?.requestId ?? mint().requestId });
  bounded(raw); const value = PresentationIntentV1.parse(JSON.parse(raw));
  if (previous) {
    if (JSON.stringify(value) !== JSON.stringify(previous)) throw new Error("Pending request is immutable; reconcile it first");
    return previous;
  }
  storage.setItem(key(app, slot), JSON.stringify(value));
  const persisted = readPresentationIntent(storage, app, slot);
  if (JSON.stringify(persisted) !== JSON.stringify(value)) throw new Error("Retry intent failed durable presentation read-back");
  return persisted!;
}
export function finishPresentationIntent(storage: Storage, app: string, slot: Slot, requestId: string): void {
  if (readPresentationIntent(storage, app, slot)?.requestId !== requestId) throw new Error("Retry identity changed");
  storage.removeItem(key(app, slot));
  if (storage.getItem(key(app, slot)) !== null) throw new Error("Retry cleanup failed read-back");
}
export async function reconcilePresentation<T>(worker: Pick<WorkerClient, "mutationOutcome">,
  intent: PresentationIntent, invoke: () => Promise<T>, onRecorded?: (current: boolean) => void): Promise<T> {
  const outcome = await worker.mutationOutcome(intent.route, intent.payload, { requestId: intent.requestId });
  if (outcome.status === "uncertain") throw new Error("The durable outcome is uncertain. Reopen Clay for recovery; the original request was kept.");
  if (outcome.status === "recorded") { onRecorded?.(outcome.current); return outcome.result as T; }
  if (outcome.status !== "not_invoked") throw new Error("Unrecognized recovery outcome; request kept");
  return invoke();
}
