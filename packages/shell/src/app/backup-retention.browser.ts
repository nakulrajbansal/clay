import {
  BackupRemovalAuthorizationV1, BackupRemovalPendingV1, BackupRetentionPlanV1,
  BackupRetentionReceiptV1, BackupRetentionScopeV1,
  type BackupRecordV1 as Record, type BackupRemovalPendingV1 as Pending,
  type BackupRetentionScopeV1 as Scope,
} from "@clay/schema/backup";
import type { ExternalBackupDirectory } from "@clay/kernel/backup";
import { BackupDirectoryIoError } from "./backup-target.browser";
import { withBackupTrustLock } from "../worker/backup-operation-lock";
import type { WorkerClient } from "./worker-client";

export type BackupRetentionWorker = Pick<WorkerClient,
  "backupRetentionPlan" | "authorizeBackupRemoval" | "acknowledgeBackupRemoval">;
type RetryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const prefix = "clay_backup_removal_v1:";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function storageFromGlobals(): RetryStorage {
  if (typeof localStorage === "undefined") throw new Error("Backup retention retry storage is unavailable");
  return localStorage;
}

async function matches(bytes: Uint8Array, record: Record): Promise<boolean> {
  if (bytes.length !== record.byteLength) return false;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return record.archiveSha256 === `sha256:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}`;
}

async function observe(directory: ExternalBackupDirectory, record: Record): Promise<"exact" | "absent" | "changed"> {
  let bytes: Uint8Array | null = null;
  try {
    bytes = await directory.readExact(record.fileName);
    return await matches(bytes, record) ? "exact" : "changed";
  } catch (error) {
    if (error instanceof BackupDirectoryIoError && error.reasonCode === "file_missing") return "absent";
    throw error;
  } finally { bytes?.fill(0); }
}

/** Bounded, receipt-bound work only. Publication validation is NOT file availability. */
export async function runProductionBackupRetention(
  worker: BackupRetentionWorker, directory: ExternalBackupDirectory, input: Scope,
  storage: RetryStorage = storageFromGlobals(),
): Promise<{ requested: number; deleted: number; failed: number; remaining: number }> {
  const scope = BackupRetentionScopeV1.parse(input);
  if (directory.targetId !== scope.targetId) throw new Error("Backup retention folder changed");
  return withBackupTrustLock(async () => {
    const key = `${prefix}${scope.appInstanceId}:${scope.targetId}:${scope.adapterCertificationId}`;
    const read = (): Pending | null => {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      if (raw.length > 8192) throw new Error("Invalid backup removal retry metadata");
      const pending = BackupRemovalPendingV1.parse(JSON.parse(raw));
      if (!same(pending.scope, scope)) throw new Error("Backup removal retry scope changed");
      return pending;
    };
    const save = (pending: Pending): void => {
      const exact = BackupRemovalPendingV1.parse(pending);
      storage.setItem(key, JSON.stringify(exact));
      if (!same(read(), exact)) throw new Error("Backup removal retry storage readback failed");
    };
    const clear = (): void => {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error("Backup removal acknowledgement cleanup failed");
    };
    let requested = 0, deleted = 0, failed = 0;
    const apply = async (pending: Pending): Promise<void> => {
      let grant = BackupRemovalAuthorizationV1.parse(await worker.authorizeBackupRemoval(pending.intent, { requestId: pending.requestId }));
      if (grant.status === "recorded") {
        if (grant.receipt.requestId !== pending.requestId || !same(grant.receipt.intent, pending.intent)
            || (pending.phase === "observed" && grant.receipt.outcome !== pending.outcome))
          throw new Error("Backup removal receipt changed");
        requested++; grant.receipt.outcome === "absent" ? deleted++ : failed++;
        clear(); return;
      }
      const initialGrant = grant;
      const bound = (): void => {
        if (grant.status !== "ready" || grant.requestId !== pending.requestId || !same(grant.intent, pending.intent)
            || grant.record.backupId !== pending.intent.backupId || grant.keeper.backupId !== pending.intent.keeperBackupId
            || !same(grant.record, initialGrant.record) || !same(grant.keeper, initialGrant.keeper)
            || [grant.record, grant.keeper].some(record => record.targetId !== scope.targetId
              || record.evidence.appInstanceId !== scope.appInstanceId || record.adapterCertificationId !== scope.adapterCertificationId))
          throw new Error("Backup removal authority changed");
      };
      bound();
      if (pending.phase === "removing") {
        // No removal (even on reload) until the protected keeper is present and exact.
        if (await observe(directory, grant.keeper) !== "exact") throw new Error("Retained backup is unavailable or changed; retention paused");
        save(pending); // Immutable intent must survive an interrupted unlink.
        let outcome: "absent" | "failed" = "failed";
        let observed: Awaited<ReturnType<typeof observe>> | null = null;
        try { observed = await observe(directory, grant.record); } catch { /* Permission loss is not absence. */ }
        if (observed === "absent") outcome = "absent";
        else if (observed === "exact") {
          // All asynchronous reads precede a fresh lease/eligibility check. An
          // expired or superseded grant cannot authorize the subsequent unlink.
          grant = BackupRemovalAuthorizationV1.parse(await worker.authorizeBackupRemoval(pending.intent, { requestId: pending.requestId }));
          bound();
          if (grant.status !== "ready") throw new Error("Backup removal already recorded");
          try {
            await directory.removeExact(grant.record.fileName); // Adapter rechecks permission immediately here.
            if (await observe(directory, grant.record) === "absent") outcome = "absent";
          } catch { /* Failed/ambiguous file operations retain a retryable failure, never an absence claim. */ }
        }
        pending = { ...pending, phase: "observed", outcome };
        save(pending);
      }
      // Do not clear or replace an invoked acknowledgement after timeout/loss.
      // A renewed lease changes only fencing, never request identity or outcome.
      const receipt = BackupRetentionReceiptV1.parse(await worker.acknowledgeBackupRemoval(
        pending.intent, pending.outcome, grant.fence, { requestId: pending.requestId },
      ));
      if (receipt.requestId !== pending.requestId || !same(receipt.intent, pending.intent) || receipt.outcome !== pending.outcome)
        throw new Error("Backup removal acknowledgement changed");
      requested++; receipt.outcome === "absent" ? deleted++ : failed++;
      clear();
    };
    const recovered = read();
    if (recovered) await apply(recovered);
    const plan = BackupRetentionPlanV1.parse(await worker.backupRetentionPlan(scope));
    // One page per invocation; already acknowledged entries never consume it.
    for (const entry of plan.entries.slice(0, 64 - requested))
      await apply({ schema: 1, scope, requestId: entry.requestId, intent: entry.intent, phase: "removing" });
    const remaining = BackupRetentionPlanV1.parse(await worker.backupRetentionPlan(scope)).remaining;
    return { requested, deleted, failed, remaining };
  });
}
