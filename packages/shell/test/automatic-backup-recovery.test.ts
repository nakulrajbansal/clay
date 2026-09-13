import { expect, it, vi } from "vitest";
import { BackupPublicationRequestV1, BackupRecordV1, buildAutomaticBackupFileName, type BackupRecord, type BackupRun } from "@clay/kernel/backup";
import { sealAuthenticatedArchiveV5, verifyAuthenticatedArchiveV5, CLAY_ARCHIVE_CONTENT_TYPE } from "@clay/kernel/archive-authentication";
import { AutomaticBackupWorkerCoordinator, type AutomaticBackupWorkerAuthority } from "../src/worker/automatic-backup";
import { BackupTrustRuntime } from "../src/worker/backup-trust-runtime";
import { MemoryBackupTrustStore } from "./helpers/memory-backup-trust";

const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
async function fixture() {
  const vault = new MemoryBackupTrustStore();
  const trust = new BackupTrustRuntime(vault);
  const kit = trust.beginEnrollment(); await trust.confirmEnrollment(kit.enrollmentId, kit.bytes.slice()); kit.bytes.fill(0);
  const target = { appInstanceId: id("app", "a"), activeGenerationId: id("gen", "b"), lineageEpoch: "0",
    protectionRevision: "1", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const selection = { selected: { schema: 1 as const, authorityIncarnationId: id("auth", "d"), catalogGeneration: "10",
    writeEpoch: "2", selectedAppInstanceId: target.appInstanceId, selectedActiveGenerationId: target.activeGenerationId, target },
  fence: { authorityIncarnationId: id("auth", "d"), writeEpoch: "2", leaseId: id("lease", "e"), releaseId: id("rel", "f") } };
  const records: BackupRecord[] = [];
  const authority: AutomaticBackupWorkerAuthority = {
    backupSelection: async () => structuredClone(selection),
    backupMetadata: () => ({ fileLabel: "Test", shapeHead: 1, shapeCurrent: 1 }),
    backupRecords: async () => structuredClone(records),
    exportAuthenticatedArchive: async material => {
      const bytes = sealAuthenticatedArchiveV5(new Uint8Array([1, 2, 3]), material.backupTrustKey,
        { authenticationVersion: 1, archiveFormat: 5, contentType: CLAY_ARCHIVE_CONTENT_TYPE,
          keyId: material.keyId, seriesId: material.seriesId, generation: material.generation });
      return { format: 5, bytes, filename: "test.clay", target: structuredClone(selection.selected.target),
        catalogGeneration: selection.selected.catalogGeneration, authentication: { schema: 1, kind: "cose_mac0_hmac_256_256",
          authenticationVersion: 1, keyId: hex(material.keyId), seriesId: hex(material.seriesId), generation: String(material.generation) } };
    },
    validateAuthenticatedArchiveStage: async (bytes, expected, key) => {
      const verified = verifyAuthenticatedArchiveV5(bytes, () => key);
      return { schema: 1, status: "valid", evidence: expected, authentication: { schema: 1, kind: "cose_mac0_hmac_256_256",
        authenticationVersion: 1, keyId: hex(verified.header.keyId), seriesId: hex(verified.header.seriesId), generation: String(verified.header.generation) } };
    },
    publishBackup: async request => {
      const existing = records.find(record => record.backupId === request.artifact.backupId);
      if (existing) return { schema: 1, publication: "already_published", record: existing, rotate: [] };
      selection.selected.catalogGeneration = String(BigInt(selection.selected.catalogGeneration) + 1n);
      const record = BackupRecordV1.parse({ ...request.artifact, publicationCatalogGeneration: selection.selected.catalogGeneration,
        state: "valid", validationCode: "archive_valid" });
      records.push(record); return { schema: 1, publication: "published", record, rotate: [] };
    },
  };
  const folder = { schema: 1 as const, targetId: id("tgt", "g"), appInstanceId: target.appInstanceId,
    adapter: "browser_directory" as const, adapterCertificationId: id("btc", "h"), authorizedAt: new Date().toISOString() };
  return { trust, vault, selection, records, authority, folder, coordinator: new AutomaticBackupWorkerCoordinator(authority, trust) };
}
function publication(run: BackupRun) {
  return BackupPublicationRequestV1.parse({ schema: 1, expected: run.expected, fence: run.fence, artifact: {
    schema: 1, backupId: run.backupId, generationId: run.generationId, targetId: run.target.targetId, evidence: run.expected.target,
    fileName: buildAutomaticBackupFileName(run.fileLabel, run.generationId, run.createdAt), createdAt: run.createdAt,
    validatedAt: new Date().toISOString(), shapeHead: run.archive.shapeHead, shapeCurrent: run.archive.shapeCurrent,
    archiveFormat: 5, byteLength: run.archive.byteLength, archiveSha256: run.archive.archiveSha256,
    authentication: run.archive.authentication, adapterCertificationId: run.target.adapterCertificationId,
  } });
}

it("refreshes a lease-only pending candidate without changing its bytes, backup identity or generation", async () => {
  const f = await fixture(); const first = await f.coordinator.prepare(f.folder, "backup_now");
  f.selection.selected.catalogGeneration = "11"; f.selection.selected.writeEpoch = "3";
  f.selection.fence = { ...f.selection.fence, writeEpoch: "3", leaseId: id("lease", "j"), releaseId: id("rel", "k") };
  const retry = await new AutomaticBackupWorkerCoordinator(f.authority, f.trust).prepare(f.folder, "retry");
  expect(retry.bytes).toEqual(first.bytes); expect(retry.run.backupId).toBe(first.run.backupId);
  expect(retry.run.generationId).toBe(first.run.generationId);
  expect(retry.run.expected).toEqual(f.selection.selected); expect(retry.run.fence).toEqual(f.selection.fence);
});

it("does not silently return a candidate for the old folder after explicit folder replacement", async () => {
  const f = await fixture(); const first = await f.coordinator.prepare(f.folder, "backup_now");
  const folder = { ...f.folder, targetId: id("tgt", "m") };
  await expect(f.coordinator.prepare(folder, "retry")).rejects.toThrow(/stale|folder|retry/);
  expect(await f.trust.status()).toMatchObject({ status: "ready", pending: null });
  const fresh = await f.coordinator.prepare(folder, "retry");
  expect(fresh.run.target).toEqual(folder); expect(fresh.run.backupId).not.toBe(first.run.backupId);
  expect(fresh.run.archive.authentication.generation).not.toBe(first.run.archive.authentication.generation);
  expect(f.records).toEqual([]);
});

it("recovers a retired reservation whose candidate cleanup failed, without reusing its generation", async () => {
  const f = await fixture(); const first = await f.coordinator.prepare(f.folder, "backup_now");
  const folder = { ...f.folder, targetId: id("tgt", "m") };
  vi.spyOn(f.trust, "removeAutomaticBackupCandidate").mockResolvedValueOnce(false);
  await expect(f.coordinator.prepare(folder, "retry")).rejects.toThrow(/changed|retry/);
  expect(await f.trust.status()).toMatchObject({ status: "ready", pending: null });
  const restarted = new AutomaticBackupWorkerCoordinator(f.authority, f.trust);
  await expect(restarted.prepare(folder, "retry")).rejects.toThrow(/retired|retry/);
  const fresh = await restarted.prepare(folder, "retry");
  expect(fresh.run.backupId).not.toBe(first.run.backupId);
  expect(BigInt(fresh.run.archive.authentication.generation)).toBeGreaterThan(BigInt(first.run.archive.authentication.generation));
});

it("reconciles a published candidate before changing apps even when trust commit previously failed", async () => {
  const f = await fixture(); const first = await f.coordinator.prepare(f.folder, "backup_now");
  await f.coordinator.validateStage(first.bytes.slice(), first.run.expected.target);
  const commit = vi.spyOn(f.trust, "commit").mockRejectedValueOnce(new Error("injected trust commit failure"));
  await expect(f.coordinator.publish(publication(first.run))).rejects.toThrow(/trust commit/);
  expect(f.records).toHaveLength(1);
  f.selection.selected.target = { ...f.selection.selected.target, appInstanceId: id("app", "n"), activeGenerationId: id("gen", "o") };
  f.selection.selected.selectedAppInstanceId = id("app", "n"); f.selection.selected.selectedActiveGenerationId = id("gen", "o");
  const folder = { ...f.folder, appInstanceId: id("app", "n"), targetId: id("tgt", "p") };
  await expect(f.coordinator.prepare(folder, "retry")).rejects.toThrow(/reconciled|retry/);
  expect(await f.trust.status()).toMatchObject({ status: "ready", pending: null, committed: { backupId: first.run.backupId } });
  expect((await f.coordinator.prepare(folder, "retry")).run.target).toEqual(folder);
  expect(f.records).toHaveLength(1); commit.mockRestore();
});

it("reopens the same staged file with a current selection after publication succeeded but trust commit failed", async () => {
  const f = await fixture(); const first = await f.coordinator.prepare(f.folder, "backup_now");
  await f.coordinator.validateStage(first.bytes.slice(), first.run.expected.target);
  const commit = vi.spyOn(f.trust, "commit").mockRejectedValueOnce(new Error("injected trust commit failure"));
  await expect(f.coordinator.publish(publication(first.run))).rejects.toThrow(/trust commit/);
  const retry = await new AutomaticBackupWorkerCoordinator(f.authority, f.trust).prepare(f.folder, "retry");
  expect(retry.run).toMatchObject({ attempt: "publication_reconcile", expected: f.selection.selected,
    fence: f.selection.fence, backupId: first.run.backupId, generationId: first.run.generationId });
  expect(retry.bytes).toEqual(first.bytes);
  await f.coordinator.validateStage(retry.bytes.slice(), retry.run.expected.target);
  expect(await f.coordinator.publish(publication(retry.run))).toMatchObject({ publication: "already_published" });
  expect(f.records).toHaveLength(1); commit.mockRestore();
});

it("retains publication through interrupted retention and acknowledges only the exact completed result", async () => {
  const f = await fixture(); const first = await f.coordinator.prepare(f.folder, "backup_now");
  await f.coordinator.validateStage(first.bytes.slice(), first.run.expected.target);
  const receipt = await f.coordinator.publish(publication(first.run));
  const restarted = new AutomaticBackupWorkerCoordinator(f.authority, f.trust);
  const retry = await restarted.prepare(f.folder, "retry");
  expect(retry.run.backupId).toBe(first.run.backupId);
  expect(retry.run.attempt).toBe("publication_reconcile");
  await restarted.validateStage(retry.bytes.slice(), retry.run.expected.target);
  expect(await restarted.publish(publication(retry.run))).toMatchObject({ publication: "already_published" });
  const result = { schema: 1 as const, status: "published" as const, publication: receipt.publication,
    record: receipt.record, rotation: { requested: 1, deleted: 0, failed: 1 } };
  await restarted.complete(result);
  expect(await f.trust.loadAutomaticBackupCandidate(first.run.archive.authentication.seriesId)).not.toBeNull();
  await expect(restarted.complete({ ...result, record: { ...receipt.record, fileName: "different.clay" },
    rotation: { requested: 0, deleted: 0, failed: 0 } })).rejects.toThrow();
  await restarted.complete({ ...result, rotation: { requested: 0, deleted: 0, failed: 0 } });
  expect(await f.trust.loadAutomaticBackupCandidate(first.run.archive.authentication.seriesId)).toBeNull();
  expect((await restarted.prepare(f.folder, "backup_now")).run.backupId).not.toBe(first.run.backupId);
});

it("does not rotate the active trust series while publication owns the shared exclusion", async () => {
  const f = await fixture();
  const alternate = new BackupTrustRuntime(new MemoryBackupTrustStore()); const kit = alternate.beginEnrollment();
  const imported = await f.trust.importRecoveryKit(kit.bytes); kit.bytes.fill(0);
  const first = await f.coordinator.prepare(f.folder, "backup_now");
  await f.coordinator.validateStage(first.bytes.slice(), first.run.expected.target);
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.authority.publishBackup;
  vi.spyOn(f.authority, "publishBackup").mockImplementationOnce(async request => { enter(); await gate; return original(request); });
  const publishing = f.coordinator.publish(publication(first.run)); await entered;
  const activation = f.trust.activateImportedSeries({ seriesId: imported.seriesId,
    expectedActiveSeriesId: first.run.archive.authentication.seriesId, confirmation: "use_imported_recovery_kit_for_future_backups" });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const during = await f.trust.status(); release();
  await publishing;
  await expect(activation).rejects.toThrow(/pending|retention|finish/i);
  expect(during).toMatchObject({ seriesId: first.run.archive.authentication.seriesId });
});

it("retires only the explicitly confirmed unpublished attempt, never a committed or different candidate", async () => {
  const f = await fixture(); const first = await f.coordinator.prepare(f.folder, "backup_now");
  const confirmation = "keep_existing_files_and_retire_unpublished_attempt";
  await expect(f.coordinator.retire(first.run.archive.authentication.seriesId, id("bkp", "z"), confirmation)).rejects.toThrow(/changed/);
  await f.coordinator.retire(first.run.archive.authentication.seriesId, first.run.backupId, confirmation);
  const fresh = await f.coordinator.prepare(f.folder, "retry");
  expect(fresh.run.backupId).not.toBe(first.run.backupId);
  await f.coordinator.validateStage(fresh.bytes.slice(), fresh.run.expected.target);
  vi.spyOn(f.trust, "commit").mockRejectedValueOnce(new Error("trust write failed"));
  await expect(f.coordinator.publish(publication(fresh.run))).rejects.toThrow(/trust write/);
  await expect(f.coordinator.retire(fresh.run.archive.authentication.seriesId, fresh.run.backupId, confirmation)).rejects.toThrow(/already published/);
  expect(f.records).toHaveLength(1);
});
