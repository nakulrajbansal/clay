import { expect, it } from "vitest";
import { DeviceCatalog } from "../src/device-catalog";
import { BackupPublicationRequestV1, buildAutomaticBackupFileName } from "../src/backup";
import { openMemoryDriver, type DbDriver } from "../src/db";
import { encodeAuthorityIdBytes } from "../src/production-operation-id";

const id = (prefix: string, n: number) => encodeAuthorityIdBytes(prefix, new Uint8Array(17).fill(n));
async function fixture(count = 35) {
  const driver = await openMemoryDriver(); driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const catalog = DeviceCatalog.initializeFresh(driver);
  const target = { appInstanceId: id("app", 1), activeGenerationId: id("gen", 2), lineageEpoch: "0",
    protectionRevision: "0", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  catalog.seedSelectedTarget({ target, namespaceId: id("ns", 3), storageKey: "default", displayName: "Retention",
    shellId: "blank", operationId: id("op", 4), at: new Date(0).toISOString() });
  const lease = (nowMs = 1000) => { const before = catalog.snapshot(); return catalog.acquireWriteLease({
    expectedAuthorityIncarnationId: before.authorityIncarnationId, expectedCatalogGeneration: before.catalogGeneration,
    expectedWriteEpoch: before.writeEpoch, releaseId: id("rel", 5), nowMs, ttlMs: 60_000 }); };
  const fence = lease();
  const scope = { appInstanceId: target.appInstanceId, targetId: id("tgt", 6), adapterCertificationId: id("btc", 7) };
  for (let n = 10; n < 10 + count; n++) {
    const before = catalog.snapshot(); const at = new Date(2000 + n).toISOString();
    catalog.publishBackup({ request: BackupPublicationRequestV1.parse({ schema: 1, fence,
      expected: { schema: 1, authorityIncarnationId: before.authorityIncarnationId, catalogGeneration: before.catalogGeneration,
        writeEpoch: before.writeEpoch, selectedAppInstanceId: target.appInstanceId, selectedActiveGenerationId: target.activeGenerationId, target },
      artifact: { schema: 1, backupId: id("bkp", n), generationId: id("backupgen", n), targetId: scope.targetId,
        adapterCertificationId: scope.adapterCertificationId,
        evidence: target, fileName: buildAutomaticBackupFileName("Retention", id("backupgen", n), at), createdAt: at, validatedAt: at,
        shapeHead: 0, shapeCurrent: 0, archiveFormat: 5, byteLength: 10, archiveSha256: `sha256:${"a".repeat(64)}`,
        authentication: { schema: 1, kind: "cose_mac0_hmac_256_256", authenticationVersion: 1,
          keyId: "b".repeat(32), seriesId: "c".repeat(32), generation: String(n) } } }),
      operationId: id("op", n), nowMs: 2000 + n });
  }
  return { driver, catalog, target, scope, fence, lease };
}

it("recovers interrupted remove/acknowledge and reload without rewriting publication history", async () => {
  const f = await fixture();
  try {
    const plan = f.catalog.backupRetentionPlan(f.scope); const entry = plan.entries[0]!;
    const files = new Set(f.catalog.backupRecords().map(record => record.fileName));
    files.delete(entry.record.fileName); // owned external remove succeeded, response/process lost before acknowledgement
    const reopened = DeviceCatalog.openExisting(f.driver);
    expect(reopened.backupRetentionPlan(f.scope).entries[0]).toEqual(entry);
    const input = { requestId: entry.requestId, intent: entry.intent, outcome: "absent" as const, fence: f.fence, nowMs: 4000 };
    const receipt = reopened.acknowledgeBackupRemoval(input);
    expect(reopened.acknowledgeBackupRemoval(input)).toEqual(receipt);
    expect(DeviceCatalog.openExisting(f.driver).backupRetentionPlan(f.scope).entries.some(item => item.record.backupId === entry.record.backupId)).toBe(false);
    expect(reopened.backupRecords().find(record => record.backupId === entry.record.backupId)?.state).toBe("deleted");
    expect(reopened.backupPublicationRecords().find(record => record.backupId === entry.record.backupId)?.state).toBe("valid");
    expect(reopened.backupRetentionHistory().events).toEqual([receipt]);
    expect(() => reopened.acknowledgeBackupRemoval({ ...input, outcome: "failed" })).toThrow(/identity|request/);
    expect(files.has(plan.keeper!.fileName)).toBe(true);
  } finally { f.driver.close(); }
});

it("rolls back an interrupted acknowledgement, rejects stale fences and refuses protected/other-folder records", async () => {
  const f = await fixture();
  try {
    const entry = f.catalog.backupRetentionPlan(f.scope).entries[0]!;
    const faulty = new Proxy(f.driver, { get(target, property) {
      if (property === "exec") return (sql: string, params?: unknown[]) => {
        if (sql.startsWith("UPDATE catalog.backup_retention_root")) throw new Error("owned acknowledgement crash");
        return target.exec(sql, params as never);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as DbDriver;
    const input = { requestId: entry.requestId, intent: entry.intent, outcome: "absent" as const, fence: f.fence, nowMs: 4000 };
    expect(() => DeviceCatalog.openExisting(faulty).acknowledgeBackupRemoval(input)).toThrow();
    expect(f.catalog.backupRetentionHistory().events).toEqual([]);
    f.lease(5000);
    expect(() => f.catalog.acknowledgeBackupRemoval(input)).toThrow();
    const fence = f.lease(6000);
    expect(() => f.catalog.acknowledgeBackupRemoval({ ...input, fence, nowMs: 6001,
      intent: { ...input.intent, backupId: f.catalog.backupRetentionPlan(f.scope).keeper!.backupId } })).toThrow();
    expect(f.catalog.backupRetentionHistory().events).toEqual([]);
    expect(f.catalog.backupRetentionPlan({ ...f.scope, targetId: id("tgt", 99) }).entries).toEqual([]);
    f.catalog.acknowledgeBackupRemoval({ ...input, fence, nowMs: 6002 });
    expect(f.catalog.backupRetentionHistory().events).toHaveLength(1);
  } finally { f.driver.close(); }
});

it("rotates attempted failures behind untouched work and never lets acknowledged files consume the 64-entry page", async () => {
  const f = await fixture(100);
  try {
    const first = f.catalog.backupRetentionPlan(f.scope); expect(first.entries).toHaveLength(64); expect(first.remaining).toBe(68);
    for (const entry of first.entries) f.catalog.acknowledgeBackupRemoval({ requestId: entry.requestId, intent: entry.intent,
      outcome: "failed", fence: f.fence, nowMs: 4000 });
    const second = f.catalog.backupRetentionPlan(f.scope);
    expect(second.entries.slice(0, 4).every(entry => !first.entries.some(old => old.record.backupId === entry.record.backupId))).toBe(true);
    for (const entry of second.entries) f.catalog.acknowledgeBackupRemoval({ requestId: entry.requestId, intent: entry.intent,
      outcome: "absent", fence: f.fence, nowMs: 4001 });
    expect(f.catalog.backupRetentionPlan(f.scope).remaining).toBe(4);
  } finally { f.driver.close(); }
}, 30_000);

it("migrates only the exact legacy catalog atomically and preserves every app and publication", async () => {
  const f = await fixture();
  try {
    const before = f.catalog.snapshot(); const records = f.catalog.backupRecords();
    // This fixture owns its in-memory catalog. These are the only additive tables.
    f.driver.exec("DROP TABLE IF EXISTS catalog.backup_retention_events");
    f.driver.exec("DROP TABLE IF EXISTS catalog.backup_retention_root");
    expect(() => DeviceCatalog.openExisting(f.driver)).toThrow();
    const faulty = new Proxy(f.driver, { get(target, property) {
      if (property === "exec") return (sql: string, params?: unknown[]) => {
        if (sql.includes("CREATE TABLE catalog.backup_retention_events")) throw new Error("owned migration crash");
        return target.exec(sql, params as never);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as DbDriver;
    expect(() => DeviceCatalog.migrateBackupRetention(faulty)).toThrow(/crash/);
    expect(f.driver.select("SELECT name FROM catalog.sqlite_schema WHERE name LIKE 'backup_retention_%'")).toEqual([]);
    expect(DeviceCatalog.needsBackupRetentionMigration(f.driver)).toBe(true);
    DeviceCatalog.migrateBackupRetention(f.driver);
    const reopened = DeviceCatalog.openExisting(f.driver);
    expect(reopened.snapshot()).toEqual(before); expect(reopened.backupRecords()).toEqual(records);
    expect(reopened.backupRetentionHistory()).toEqual({ schema: 1, revision: "0", events: [] });
    DeviceCatalog.migrateBackupRetention(f.driver);
    expect(reopened.backupRetentionHistory()).toEqual({ schema: 1, revision: "0", events: [] });
    f.driver.exec("CREATE TABLE catalog.unknown_retention_state(value TEXT)");
    expect(() => DeviceCatalog.migrateBackupRetention(f.driver)).toThrow();
  } finally { f.driver.close(); }
});

it("rejects a retention event rebound to an older known lease at a newer catalog generation", async () => {
  const f = await fixture();
  try {
    const entry = f.catalog.backupRetentionPlan(f.scope).entries[0]!;
    const fence = f.lease(5000);
    const receipt = f.catalog.acknowledgeBackupRemoval({ intent: entry.intent, requestId: entry.requestId,
      outcome: "absent", fence, nowMs: 5100 });
    f.driver.exec("UPDATE catalog.backup_retention_events SET event_json=? WHERE revision='1'",
      [JSON.stringify({ ...receipt, fence: f.fence })]);
    expect(() => DeviceCatalog.openExisting(f.driver)).toThrow(/retention|catalog/);
  } finally { f.driver.close(); }
});

it("repairs exact legacy no-op operation accounting without changing its receipt or canonical app", async () => {
  const f = await fixture(0);
  try {
    const before = f.catalog.snapshot();
    f.driver.exec(`INSERT INTO catalog.production_request_receipts(request_id,operation_id,request_sha256,
      app_instance_id,active_generation_id,lineage_epoch,expected_protection_revision,expected_state_sha256,
      state,resulting_protection_revision,resulting_state_sha256,response_sha256,prepared_at,invoked_at,completed_at)
      VALUES (?,?,?,?,?,'0','0',?,'no_op','0',?,?,?,NULL,?)`, [id("req", 50), id("op", 51), `sha256:${"a".repeat(64)}`,
      f.target.appInstanceId, f.target.activeGenerationId, f.target.stateSha256, f.target.stateSha256,
      `sha256:${"b".repeat(64)}`, new Date(2000).toISOString(), new Date(2000).toISOString()]);
    const receipt = f.driver.select("SELECT * FROM catalog.production_request_receipts");
    expect(DeviceCatalog.needsBackupRetentionMigration(f.driver)).toBe(true);
    DeviceCatalog.migrateBackupRetention(f.driver);
    expect(DeviceCatalog.needsBackupRetentionMigration(f.driver)).toBe(false);
    expect(f.catalog.snapshot()).toEqual(before);
    expect(f.driver.select("SELECT * FROM catalog.production_request_receipts")).toEqual(receipt);
    expect(f.driver.select("SELECT id_kind FROM catalog.id_registry WHERE id_value=?", [id("op", 51)])).toEqual([{ id_kind: "operation" }]);
  } finally { f.driver.close(); }
});
