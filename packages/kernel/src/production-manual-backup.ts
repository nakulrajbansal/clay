import { z } from "zod";
import { RequestId } from "@clay/schema";
import { ManualBackupDownloadV2 } from "@clay/schema/backup";
import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import { PRODUCTION_STORE_PRIMITIVES as ops, type ClayStore } from "./store";
import { ClayError } from "./errors";

export const MANUAL_BACKUP_LEDGER = "manual_backup_downloads_v2";
const ledger = z.object({ schema: z.literal(1), entries: z.array(z.object({
  requestId: RequestId, record: ManualBackupDownloadV2,
}).strict()).max(100) }).strict();
export function readManualBackupDownloads(store: ClayStore): ManualBackupDownloadV2[] {
  return ledger.parse(ops.getSetting.call(store, MANUAL_BACKUP_LEDGER) ?? { schema: 1, entries: [] }).entries.map(entry => entry.record);
}
export function recordManualBackupDownload(store: ClayStore, requestId: string, record: ManualBackupDownloadV2, target: TargetEvidenceV1) {
  if (record.evidence.appInstanceId !== target.appInstanceId || record.evidence.activeGenerationId !== target.activeGenerationId
      || record.evidence.lineageEpoch !== target.lineageEpoch || BigInt(record.evidence.protectionRevision) > BigInt(target.protectionRevision))
    throw new ClayError("E_CONFLICT", "Download record belongs to another app or lineage");
  const current = ledger.parse(ops.getSetting.call(store, MANUAL_BACKUP_LEDGER) ?? { schema: 1, entries: [] });
  if (current.entries.some(entry => entry.requestId === requestId)) throw new ClayError("E_CONFLICT", "Download request needs journal replay");
  ops.setSetting.call(store, MANUAL_BACKUP_LEDGER, { schema: 1,
    entries: [{ requestId, record }, ...current.entries].slice(0, 100) });
  return record;
}
