import { BackupRemovalAcknowledgementV1, BackupRemovalIntentV1, BackupRetentionHistoryV1,
  BackupRetentionPlanV1, BackupRetentionReceiptV1, BackupRetentionScopeV1, type BackupRecordV1 } from "@clay/schema/backup";
import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import { encodeAuthorityIdBytes, productionOperationIdV2 } from "./production-operation-id";
import { sha256HexSync } from "./state-digest";

export const BACKUP_RETENTION_DDL = [
  `CREATE TABLE catalog.backup_retention_root(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    revision TEXT NOT NULL
  )`,
  `CREATE TABLE catalog.backup_retention_events(
    revision TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL UNIQUE,
    event_json TEXT NOT NULL UNIQUE
  )`,
] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (): never => { throw new ClayError("E_CATALOG_UNAVAILABLE", "backup retention history failed closed validation"); };
const digest = (value: unknown) => sha256HexSync(new TextEncoder().encode(JSON.stringify(value)));
export function backupRemovalRequestId(input: unknown): string {
  const hash = digest({ kind: "clay-backup-removal-v1", intent: BackupRemovalIntentV1.parse(input) });
  return encodeAuthorityIdBytes("req", Uint8Array.from(hash.match(/../g)!, byte => Number.parseInt(byte, 16)));
}
export function backupRemovalHash(input: unknown): string {
  return `sha256:${digest(BackupRemovalAcknowledgementV1.parse(input))}`;
}
export function readBackupRetentionHistory(driver: DbDriver): BackupRetentionHistoryV1 {
  const roots = driver.select("SELECT * FROM catalog.backup_retention_root");
  if (roots.length !== 1 || roots[0]!.singleton !== 1 || roots[0]!.schema_version !== 1) fail();
  const rows = driver.select("SELECT * FROM catalog.backup_retention_events ORDER BY length(revision), revision");
  const events = rows.map(row => {
    if (typeof row.event_json !== "string") fail();
    const event = BackupRetentionReceiptV1.parse(JSON.parse(String(row.event_json)));
    if (event.revision !== row.revision || event.requestId !== row.request_id || event.operationId !== row.operation_id
        || JSON.stringify(event) !== row.event_json) fail();
    return event;
  });
  const history = BackupRetentionHistoryV1.parse({ schema: 1, revision: roots[0]!.revision, events });
  if (BigInt(history.revision) !== BigInt(rows.length)) fail();
  return history;
}
export const sameBackupScope = (a: BackupRecordV1, b: BackupRecordV1) => a.targetId === b.targetId
  && a.evidence.appInstanceId === b.evidence.appInstanceId && a.adapterCertificationId === b.adapterCertificationId;
export const newestBackupFirst = (a: BackupRecordV1, b: BackupRecordV1) => b.validatedAt.localeCompare(a.validatedAt)
  || b.backupId.localeCompare(a.backupId);
export function retentionEligible(records: BackupRecordV1[], record: BackupRecordV1, keeper: BackupRecordV1): boolean {
  const group = records.filter(item => item.state === "valid" && sameBackupScope(item, record)).sort(newestBackupFirst);
  return keeper.state === "valid" && record.state === "valid" && sameBackupScope(record, keeper)
    && group.slice(0, 32).some(item => item.backupId === keeper.backupId)
    && group.slice(32).some(item => item.backupId === record.backupId);
}
export function planBackupRetention(records: BackupRecordV1[], history: BackupRetentionHistoryV1,
  authorityId: string, input: unknown): BackupRetentionPlanV1 {
  const scope = BackupRetentionScopeV1.parse(input);
  const group = records.filter(record => record.state === "valid" && record.targetId === scope.targetId
    && record.evidence.appInstanceId === scope.appInstanceId && record.adapterCertificationId === scope.adapterCertificationId).sort(newestBackupFirst);
  const latest = new Map(history.events.map(event => [event.intent.backupId, event]));
  const keeper = group[0] ?? null;
  const work = group.slice(32).filter(record => latest.get(record.backupId)?.outcome !== "absent")
    .sort((a, b) => {
      const left = BigInt(latest.get(a.backupId)?.revision ?? "0"), right = BigInt(latest.get(b.backupId)?.revision ?? "0");
      return left === right ? -newestBackupFirst(a, b) : left < right ? -1 : 1;
    });
  return BackupRetentionPlanV1.parse({ schema: 1, keeper, remaining: work.length,
    entries: work.slice(0, 64).map(record => {
      const intent = BackupRemovalIntentV1.parse({ schema: 1, authorityIncarnationId: authorityId, planningRevision: history.revision,
        backupId: record.backupId, keeperBackupId: keeper!.backupId });
      return { requestId: backupRemovalRequestId(intent), intent, record };
    }) });
}

type Lease = { leaseId: string; authorityIncarnationId: string; writeEpoch: string; releaseId: string; issuedAtMs: string; expiresAtMs: string };
/** Same closed validator is used on physical catalog rows and authenticated archive evidence. */
export function assertBackupRetentionHistory(history: BackupRetentionHistoryV1, records: BackupRecordV1[],
  authorityId: string, catalogGeneration: string, leases: Lease[],
  generationEvents: { catalogGeneration: string; writeEpoch: string; at: string }[]): void {
  if (BigInt(history.revision) !== BigInt(history.events.length)) fail();
  const requests = new Set<string>(), operations = new Set<string>(), absent = new Set<string>();
  const generations = new Map(generationEvents.map(event => [event.catalogGeneration, event]));
  let previousGeneration = 0n;
  for (const [index, event] of history.events.entries()) {
    const record = records.find(item => item.backupId === event.intent.backupId);
    const keeper = records.find(item => item.backupId === event.intent.keeperBackupId);
    const atPublication = records.filter(item => BigInt(item.publicationCatalogGeneration) <= BigInt(event.catalogGeneration));
    const lease = leases.find(item => item.leaseId === event.fence.leaseId);
    const at = Date.parse(event.completedAt);
    const generation = generations.get(event.catalogGeneration);
    if (BigInt(event.revision) !== BigInt(index + 1) || BigInt(event.intent.planningRevision) >= BigInt(event.revision)
        || event.intent.authorityIncarnationId !== authorityId || event.fence.authorityIncarnationId !== authorityId
        || BigInt(event.catalogGeneration) > BigInt(catalogGeneration) || !record || !keeper
        || BigInt(event.catalogGeneration) < previousGeneration || !generation
        || generation.writeEpoch !== event.fence.writeEpoch || at < Date.parse(generation.at)
        || !atPublication.includes(record) || !atPublication.includes(keeper) || !retentionEligible(atPublication, record, keeper)
        || absent.has(record.backupId) || requests.has(event.requestId) || operations.has(event.operationId)
        || event.requestId !== backupRemovalRequestId(event.intent)
        || event.operationId !== productionOperationIdV2(authorityId, event.requestId, "backup.retention")
        || event.requestSha256 !== backupRemovalHash({ requestId: event.requestId, intent: event.intent, outcome: event.outcome })
        || !lease || !same(event.fence, { authorityIncarnationId: lease.authorityIncarnationId, writeEpoch: lease.writeEpoch,
          leaseId: lease.leaseId, releaseId: lease.releaseId }) || at < Number(lease.issuedAtMs) || at >= Number(lease.expiresAtMs)) fail();
    requests.add(event.requestId); operations.add(event.operationId);
    previousGeneration = BigInt(event.catalogGeneration);
    if (event.outcome === "absent") absent.add(record!.backupId);
  }
}
