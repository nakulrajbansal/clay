import { expect, it } from "vitest";
import { BackupPublicationRequestV1, buildAutomaticBackupFileName } from "../src/backup";
import { DeviceCatalog } from "../src/device-catalog";
import { openMemoryDriver } from "../src/db";
import { encodeAuthorityIdBytes } from "../src/production-operation-id";

const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
async function fixture() {
  const driver = await openMemoryDriver(); driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const catalog = DeviceCatalog.initializeFresh(driver);
  const target = { appInstanceId: id("app", "a"), activeGenerationId: id("gen", "b"), lineageEpoch: "0",
    protectionRevision: "0", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  catalog.seedSelectedTarget({ target, namespaceId: id("ns", "d"), storageKey: "default", displayName: "Test",
    shellId: "blank", operationId: id("op", "e"), at: new Date(0).toISOString() });
  const lease = () => {
    const before = catalog.snapshot();
    return catalog.acquireWriteLease({ expectedAuthorityIncarnationId: before.authorityIncarnationId,
      expectedCatalogGeneration: before.catalogGeneration, expectedWriteEpoch: before.writeEpoch,
      releaseId: id("rel", "f"), nowMs: 1000, ttlMs: 60_000 });
  };
  const fence = lease();
  return { driver, catalog, target, fence, lease };
}

it("only refreshes a backup lease from an existing generation and exact selected app", async () => {
  const f = await fixture();
  try {
    const generation = f.catalog.snapshot().catalogGeneration;
    expect(f.catalog.hasOnlyLeaseSuffix("9999", f.target.appInstanceId)).toBe(false);
    expect(f.catalog.hasOnlyLeaseSuffix(generation, id("app", "z"))).toBe(false);
    f.lease();
    expect(f.catalog.hasOnlyLeaseSuffix(generation, f.target.appInstanceId)).toBe(true);
    const fence = f.lease();
    f.catalog.updateSelectedAppMetadata({ expectedCatalogGeneration: f.catalog.snapshot().catalogGeneration,
      displayName: "Changed", shellId: "blank", operationId: id("op", "h"), fence, nowMs: 1001 });
    expect(f.catalog.hasOnlyLeaseSuffix(generation, f.target.appInstanceId)).toBe(false);
  } finally { f.driver.close(); }
});

it("replays bounded retention after a lost publication response without rotating another folder or the new copy", async () => {
  const f = await fixture();
  const publish = (index: number, folder: string) => {
    const unique = (prefix: "bkp" | "backupgen" | "op") => encodeAuthorityIdBytes(prefix, new Uint8Array(17).fill(index));
    const snapshot = f.catalog.snapshot(); const at = new Date(2000 + index).toISOString();
    const request = BackupPublicationRequestV1.parse({ schema: 1, fence: f.fence,
      expected: { schema: 1, authorityIncarnationId: snapshot.authorityIncarnationId, catalogGeneration: snapshot.catalogGeneration,
        writeEpoch: snapshot.writeEpoch, selectedAppInstanceId: f.target.appInstanceId,
        selectedActiveGenerationId: f.target.activeGenerationId, target: f.target },
      artifact: { schema: 1, backupId: unique("bkp"), generationId: unique("backupgen"), targetId: folder,
        evidence: f.target, fileName: buildAutomaticBackupFileName("Test", unique("backupgen"), at), createdAt: at, validatedAt: at,
        shapeHead: 0, shapeCurrent: 0, archiveFormat: 5, byteLength: 100, archiveSha256: `sha256:${"a".repeat(64)}`,
        authentication: { schema: 1, kind: "cose_mac0_hmac_256_256", authenticationVersion: 1,
          keyId: "b".repeat(32), seriesId: "c".repeat(32), generation: String(index) }, adapterCertificationId: id("btc", "i") } });
    const input = { request, operationId: unique("op"), nowMs: 2000 + index };
    return { input, receipt: f.catalog.publishBackup(input) };
  };
  try {
    const other = publish(1, id("tgt", "k"));
    for (let i = 2; i < 35; i++) publish(i, id("tgt", "j"));
    const last = publish(35, id("tgt", "j"));
    expect(last.receipt.rotate).toHaveLength(2);
    const replay = f.catalog.publishBackup(last.input);
    expect(replay.publication).toBe("already_published");
    expect(replay.rotate).toEqual(last.receipt.rotate);
    expect(replay.rotate.every(record => record.backupId !== last.receipt.record.backupId
      && record.backupId !== other.receipt.record.backupId)).toBe(true);
  } finally { f.driver.close(); }
});
