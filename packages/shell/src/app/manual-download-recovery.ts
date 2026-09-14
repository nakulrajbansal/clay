import { AppInstanceId } from "@clay/schema/standalone/index";
import { ManualBackupDownloadV2, ManualDownloadIntentV1 as intent } from "@clay/schema/standalone/backup";
import type { WorkerClient } from "./worker-client";

export type ManualDownloadIntent = import("@clay/schema/backup").ManualDownloadIntentV1;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Worker = Pick<WorkerClient, "createMutationContext" | "manualBackupDownloadOutcome" | "recordManualBackupDownload" | "validateManualBackupDownload">;
const key = (app: string) => `clay_manual_download_intent_v1:${AppInstanceId.parse(app)}`;
function freeze<T>(input: T): T {
  if (input && typeof input === "object") { Object.values(input).forEach(freeze); Object.freeze(input); } return input;
}
/** Presentation intent only. It cannot create an app or attest an external save. */
export class ManualDownloadRecovery {
  constructor(private readonly storage: Storage, private readonly worker: Worker) {}
  pending(app: string): ManualDownloadIntent | null {
    const raw = this.storage.getItem(key(app)); if (raw === null) return null;
    if (new TextEncoder().encode(raw).byteLength > 8_000) throw new Error("Download intent is oversized");
    const value = intent.parse(JSON.parse(raw));
    if (value.record.evidence.appInstanceId !== app) throw new Error("Download intent belongs to another app");
    return freeze(value);
  }
  prepare(app: string, record: ManualBackupDownloadV2): ManualDownloadIntent {
    if (record.evidence.appInstanceId !== app) throw new Error("Download belongs to another app");
    const previous = this.pending(app);
    if (previous) {
      if (JSON.stringify(previous.record) !== JSON.stringify(ManualBackupDownloadV2.parse(record))) throw new Error("Download intent is immutable");
      return previous;
    }
    const value = intent.parse({ schema: 1, requestId: this.worker.createMutationContext().requestId, record, phase: "prepared" });
    this.storage.setItem(key(app), JSON.stringify(value));
    const persisted = this.pending(app);
    if (JSON.stringify(persisted) !== JSON.stringify(value)) throw new Error("Download intent failed read-back");
    return persisted!;
  }
  handedOff(app: string, requestId: string): void {
    const value = this.pending(app);
    if (!value || value.requestId !== requestId) throw new Error("Download request identity changed");
    this.storage.setItem(key(app), JSON.stringify({ ...value, phase: "handed_off" }));
    if (this.pending(app)?.phase !== "handed_off") throw new Error("Download handoff failed read-back");
  }
  private finish(app: string, requestId: string): void {
    if (this.pending(app)?.requestId !== requestId) throw new Error("Download request identity changed");
    this.storage.removeItem(key(app));
    if (this.pending(app)) throw new Error("Download intent cleanup needs retry");
  }
  async resume(app: string, bytes?: ArrayBuffer): Promise<boolean> {
    const value = this.pending(app); if (!value) return false;
    const context = { requestId: value.requestId };
    const outcome = await this.worker.manualBackupDownloadOutcome(value.record, context);
    if (outcome.status === "uncertain") throw new Error("Download outcome is uncertain; reopen this app for recovery");
    if (outcome.status === "recorded") { this.finish(app, value.requestId); return true; }
    if (outcome.status !== "not_recorded") throw new Error("Invalid download outcome");
    if (bytes) await this.worker.validateManualBackupDownload(bytes, value.record);
    else if (value.phase !== "handed_off") throw new Error("File handoff was interrupted; choose the exact file or discard this unfinished request");
    const recorded = await this.worker.recordManualBackupDownload(value.record, context);
    if (JSON.stringify(ManualBackupDownloadV2.parse(recorded)) !== JSON.stringify(value.record)) throw new Error("Download record read-back changed");
    this.finish(app, value.requestId); return true;
  }
  async discard(app: string): Promise<void> {
    const value = this.pending(app); if (!value) return;
    const outcome = await this.worker.manualBackupDownloadOutcome(value.record, { requestId: value.requestId });
    if (outcome.status !== "recorded" && outcome.status !== "not_recorded") throw new Error("Reconcile the uncertain download outcome first");
    this.finish(app, value.requestId); // Never removes a file or a durable download record.
  }
}
