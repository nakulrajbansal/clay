import { z } from "zod";
import { RequestId } from "@clay/schema";
import { ManualBackupDownloadV2 } from "@clay/schema/backup";
import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import { PRODUCTION_STORE_PRIMITIVES as ops, type ClayStore } from "./store";
import { ClayError } from "./errors";
import type { DbDriver } from "./db";
import { readProductionRequestReceipt } from "./production-request-journal";
import { decodeProductionResponse } from "./production-response-envelope";
import { productionOperationIdV2 } from "./production-operation-id";
import { enumerateCanonicalStateV1 } from "./canonical-state";
import { DeviceCatalog } from "./device-catalog";
import { TargetAuthorityStore } from "./target-authority";
import { assertCommittedReceiptReservationBinding } from "./sample-provenance-proof";

export const MANUAL_BACKUP_LEDGER = "manual_backup_downloads_v2";
const ledger = z.object({ schema: z.literal(1), entries: z.array(z.object({
  requestId: RequestId, record: ManualBackupDownloadV2,
}).strict()).max(100) }).strict().refine(value => new Set(value.entries.map(entry => entry.requestId)).size === value.entries.length,
  "duplicate manual-download identities");

export function manualBackupDownloadOutcome(store: ClayStore, driver: DbDriver, authorityId: string,
  target: TargetEvidenceV1, input: unknown, requestId: string): { status: "recorded" | "not_recorded" | "uncertain" } {
  const record = ManualBackupDownloadV2.parse(input); RequestId.parse(requestId);
  if (enumerateCanonicalStateV1(driver, ops.validationRegistrySnapshot.call(store)).stateSha256 !== target.stateSha256
      || JSON.stringify(DeviceCatalog.openExisting(driver).selectedTargetStorage().target) !== JSON.stringify(target))
    throw new ClayError("E_CONFLICT", "Download readback is not the selected canonical app");
  if (record.evidence.appInstanceId !== target.appInstanceId || record.evidence.activeGenerationId !== target.activeGenerationId
      || record.evidence.lineageEpoch !== target.lineageEpoch)
    throw new ClayError("E_CONFLICT", "Download record belongs to another app or lineage");
  const entry = ledger.parse(ops.getSetting.call(store, MANUAL_BACKUP_LEDGER) ?? { schema: 1, entries: [] })
    .entries.find(value => value.requestId === requestId);
  if (entry && JSON.stringify(entry.record) !== JSON.stringify(record))
    throw new ClayError("E_CONFLICT", "Download request identity is bound to a different record");
  const receipt = readProductionRequestReceipt(driver, requestId);
  if (!receipt) return { status: entry ? "uncertain" : "not_recorded" };
  if (receipt.operationId !== productionOperationIdV2(authorityId, requestId, "backup.manualDownload")
      || receipt.appInstanceId !== target.appInstanceId || receipt.activeGenerationId !== target.activeGenerationId
      || receipt.lineageEpoch !== target.lineageEpoch)
    throw new ClayError("E_CONFLICT", "Download request identity belongs to another operation");
  if (receipt.state === "failed" && !entry) return { status: "not_recorded" };
  if (receipt.state !== "committed" || !entry || !receipt.responseJson) return { status: "uncertain" };
  const response = decodeProductionResponse(receipt.responseJson);
  if (response.kind !== "envelope" || response.route !== "backup.manualDownload"
      || JSON.stringify(ManualBackupDownloadV2.parse(response.result)) !== JSON.stringify(record))
    throw new ClayError("E_CONFLICT", "Download receipt does not bind the exact record");
  assertCommittedReceiptReservationBinding(receipt, TargetAuthorityStore.open(driver).reservations(), DeviceCatalog.openExisting(driver).revisionReservations());
  // The current canonical bounded ledger proves this historical result remains
  // present. This is readback, not permission to replay arbitrary old mutations.
  return { status: "recorded" };
}
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
