import { RequestId } from "@clay/schema/standalone/index";
import { parseAuthenticatedFormat5RestoreGrant, type AuthenticatedFormat5RestoreGrant } from "@clay/kernel/recovery";
import type { WorkerMutationContext } from "./worker-client";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type RestoreIntent = Readonly<{ schema: 1; grant: AuthenticatedFormat5RestoreGrant; requestId: string }>;
const key = "clay_pending_restore_v1";
export function readRestoreIntent(storage: Storage): RestoreIntent | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > 8_000) throw new Error("Restore retry record is oversized");
  const value = JSON.parse(raw) as RestoreIntent;
  const grant = parseAuthenticatedFormat5RestoreGrant(value?.grant);
  if (!value || Object.keys(value).sort().join(",") !== "grant,requestId,schema" || value.schema !== 1
      || !grant || !RequestId.safeParse(value.requestId).success) throw new Error("Restore retry record is invalid");
  Object.freeze(grant.archiveTarget); Object.freeze(grant.authentication); Object.freeze(grant);
  return Object.freeze({ schema: 1, grant, requestId: value.requestId });
}
export function beginRestoreIntent(storage: Storage, grant: AuthenticatedFormat5RestoreGrant, mint: () => WorkerMutationContext): RestoreIntent {
  const previous = readRestoreIntent(storage);
  if (previous) {
    if (JSON.stringify(previous.grant) !== JSON.stringify(grant)) throw new Error("Pending restore intent is immutable; reconcile it first");
    return previous;
  }
  const value: RestoreIntent = { schema: 1, grant, requestId: mint().requestId };
  storage.setItem(key, JSON.stringify(value));
  const persisted = readRestoreIntent(storage);
  if (JSON.stringify(persisted) !== JSON.stringify(value)) throw new Error("Restore retry record failed read-back");
  return persisted!;
}
export function finishRestoreIntent(storage: Storage, requestId: string): void {
  if (readRestoreIntent(storage)?.requestId !== requestId) throw new Error("Restore retry identity changed");
  storage.removeItem(key);
}
