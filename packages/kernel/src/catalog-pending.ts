import { GenerationId, NamespaceId } from "@clay/schema";
import { AppLifecycleReceiptV1, PendingTargetLifecycleJobV1 } from "@clay/schema/catalog";
import { ArchivePendingJobV1 } from "@clay/schema/archive";
import type { DbDriver } from "./db";
import { ClayError } from "./errors";

export const LIFECYCLE_PROVENANCE = "app-lifecycle-v1";
export const LIFECYCLE_RECEIPT_PROVENANCE = "app-lifecycle-receipt-v1";
type PendingRow =
  | { kind: "restore"; value: ArchivePendingJobV1 }
  | { kind: "lifecycle"; value: PendingTargetLifecycleJobV1 }
  | { kind: "receipt"; value: AppLifecycleReceiptV1 };

/** No SQL kind filters: every physical row must have exactly one closed interpretation. */
export function readCatalogPendingRows(driver: DbDriver): PendingRow[] {
  try {
    const rows = driver.select("SELECT * FROM catalog.pending_jobs ORDER BY job_id");
    const jobs = new Set<string>(), operations = new Set<string>(), requests = new Set<string>();
    const parsed = rows.map((row): PendingRow => {
      let result: PendingRow;
      if (row.kind === "restore_as_new") {
        const value = ArchivePendingJobV1.parse({
          schema: 1, jobId: row.job_id, authorityIncarnationId: row.authority_incarnation_id,
          appInstanceId: row.app_instance_id, generationId: row.generation_id,
          namespaceId: row.namespace_id, kind: row.kind, state: row.state,
          operationId: row.operation_id, sourceArchiveSha256: row.source_archive_sha256,
          sourceProvenanceId: row.source_provenance_id, createdAt: row.created_at, updatedAt: row.updated_at,
        });
        if (value.state !== "prepared" || value.appInstanceId === null || value.updatedAt < value.createdAt)
          throw new Error("invalid restore state");
        result = { kind: "restore", value };
      } else if (row.kind === "app_lifecycle_create" || row.kind === "app_lifecycle_fork"
          || row.kind === "app_lifecycle_cleanup") {
        if (typeof row.state !== "string") throw new Error("missing lifecycle payload");
        const value = PendingTargetLifecycleJobV1.parse(JSON.parse(row.state));
        if (JSON.stringify(value) !== row.state || row.kind !== `app_lifecycle_${value.kind}`
            || row.app_instance_id !== value.target.appInstanceId
            || row.generation_id !== value.target.generationId || row.namespace_id !== value.target.namespaceId
            || row.source_archive_sha256 !== value.requestSha256
            || row.source_provenance_id !== LIFECYCLE_PROVENANCE
            || row.created_at !== value.createdAt || row.updated_at !== value.createdAt)
          throw new Error("lifecycle columns disagree");
        result = { kind: "lifecycle", value };
      } else if (row.kind === "app_lifecycle_receipt") {
        if (typeof row.state !== "string") throw new Error("missing receipt payload");
        const value = AppLifecycleReceiptV1.parse(JSON.parse(row.state));
        if (JSON.stringify(value) !== row.state
            || row.app_instance_id !== (value.requestedAppInstanceId ?? value.resultingSelectedAppInstanceId)
            || row.source_archive_sha256 !== value.requestSha256
            || row.source_provenance_id !== LIFECYCLE_RECEIPT_PROVENANCE
            || row.created_at !== value.completedAt || row.updated_at !== value.completedAt)
          throw new Error("receipt columns disagree");
        GenerationId.parse(row.generation_id);
        NamespaceId.parse(row.namespace_id);
        result = { kind: "receipt", value };
      } else throw new Error("unknown physical pending kind");
      const value = result.value;
      if (row.job_id !== value.jobId || row.authority_incarnation_id !== value.authorityIncarnationId
          || row.operation_id !== value.operationId || jobs.has(value.jobId) || operations.has(value.operationId))
        throw new Error("duplicate or mismatched pending identity");
      jobs.add(value.jobId); operations.add(value.operationId);
      if (result.kind !== "restore") {
        if (requests.has(result.value.requestId)) throw new Error("duplicate pending request");
        requests.add(result.value.requestId);
      }
      return result;
    });
    const physicalCount = Number(driver.select("SELECT COUNT(*) AS count FROM catalog.pending_jobs")[0]?.count);
    if (parsed.length !== rows.length || jobs.size !== physicalCount)
      throw new Error("pending physical cardinality mismatch");
    return parsed;
  } catch {
    throw new ClayError("E_CATALOG_UNAVAILABLE", "catalog pending rows failed validation");
  }
}

/** Format 5 cannot silently omit lifecycle history. Release B needs an explicit format reconciliation. */
export function pendingRowsForArchive(driver: DbDriver): ArchivePendingJobV1[] {
  const rows = readCatalogPendingRows(driver);
  if (rows.some(row => row.kind === "lifecycle"))
    throw new ClayError("E_CATALOG_UNAVAILABLE", "archive blocked by unfinished lifecycle work");
  if (rows.some(row => row.kind === "receipt"))
    throw new ClayError("E_CATALOG_UNAVAILABLE", "archive format 5 cannot omit lifecycle receipts");
  return rows.flatMap(row => row.kind === "restore" ? [row.value] : []);
}
