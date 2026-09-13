import { expect, it, vi } from "vitest";
import { historicalRecord, digestBytes, id } from "../../kernel/test/external-backup-fakes";
import { BackupDirectoryIoError } from "../src/app/backup-target.browser";
import { runProductionBackupRetention } from "../src/app/backup-retention.browser";
import type { WorkerClient } from "../src/app/worker-client";
import type { ExternalBackupDirectory } from "@clay/kernel/backup";

function fixture() {
  const bytes = new Uint8Array([1, 2, 3]);
  const record = { ...historicalRecord("g", `clay-test-20260905T200000000Z-${id("backupgen", "g")}.clay`, "2026-09-05T20:00:00.000Z"), byteLength: bytes.length, archiveSha256: digestBytes(bytes) };
  const keeper = { ...historicalRecord("h", `clay-test-20260905T200100000Z-${id("backupgen", "h")}.clay`, "2026-09-05T20:01:00.000Z"), byteLength: bytes.length, archiveSha256: record.archiveSha256 };
  const intent = { schema: 1 as const, authorityIncarnationId: id("auth", "a"), planningRevision: "0", backupId: record.backupId, keeperBackupId: keeper.backupId };
  const requestId = id("req", "b");
  const fence = { authorityIncarnationId: intent.authorityIncarnationId, writeEpoch: "1", leaseId: id("lease", "c"), releaseId: id("rel", "d") };
  let receipt: unknown = null;
  const cache = new Map<string, string>();
  const storage = { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => { cache.set(key, value); }, removeItem: (key: string) => { cache.delete(key); } };
  const files = new Map([[record.fileName, bytes.slice()], [keeper.fileName, bytes.slice()]]);
  const directory: ExternalBackupDirectory = { targetId: record.targetId, createNew: vi.fn(),
    readExact: vi.fn(async name => { const value = files.get(name); if (!value) throw new BackupDirectoryIoError("file_missing"); return value.slice(); }),
    removeExact: vi.fn(async name => { files.delete(name); }) };
  const worker = { backupRetentionPlan: vi.fn(async () => ({ schema: 1, keeper,
    entries: receipt ? [] : [{ record, intent, requestId }], remaining: receipt ? 0 : 1 })),
    authorizeBackupRemoval: vi.fn(async () => receipt ? { status: "recorded", receipt }
      : { status: "ready", intent, requestId, record, keeper, fence }),
    acknowledgeBackupRemoval: vi.fn(async (sent: unknown, outcome: string, _fence: unknown, context: { requestId: string }) => {
      receipt = { schema: 1, revision: "1", requestId: context.requestId, intent: sent, outcome, fence, operationId: id("op", "e"),
        catalogGeneration: "33", completedAt: new Date().toISOString(), requestSha256: `sha256:${"a".repeat(64)}` }; return receipt;
    }) };
  const scope = { targetId: record.targetId, appInstanceId: record.evidence.appInstanceId, adapterCertificationId: record.adapterCertificationId };
  const run = () => runProductionBackupRetention(worker as unknown as WorkerClient, directory, scope, storage);
  return { files, cache, record, keeper, worker, directory, run, storage, scope };
}

it("keeps an immutable pending acknowledgement after a lost response and reconciles before any new removal", async () => {
  const f = fixture(); const commit = f.worker.acknowledgeBackupRemoval.getMockImplementation()!;
  f.worker.acknowledgeBackupRemoval.mockImplementationOnce(async (...args) => { await commit(...args); throw new Error("lost acknowledgement response"); });
  await expect(f.run()).rejects.toThrow(/lost|acknowledg/);
  expect(f.files.has(f.record.fileName)).toBe(false); expect(f.files.has(f.keeper.fileName)).toBe(true); expect(f.cache.size).toBe(1);
  await f.run(); expect(f.cache.size).toBe(0);
  expect(f.directory.removeExact).toHaveBeenCalledTimes(1); expect(f.worker.acknowledgeBackupRemoval).toHaveBeenCalledTimes(1);
});

it("acknowledges exact pre-existing absence without unlink, but never treats permission failure as absence", async () => {
  const missing = fixture(); missing.files.delete(missing.record.fileName);
  expect(await missing.run()).toMatchObject({ requested: 1, deleted: 1, failed: 0 });
  expect(missing.directory.removeExact).not.toHaveBeenCalled();
  const denied = fixture(); const read = denied.directory.readExact;
  denied.directory.readExact = async name => { if (name === denied.record.fileName) throw new BackupDirectoryIoError("permission_required"); return read(name); };
  expect(await denied.run()).toMatchObject({ deleted: 0, failed: 1 });
  expect(denied.files.has(denied.record.fileName)).toBe(true);
  expect(denied.worker.acknowledgeBackupRemoval.mock.calls[0]?.[1]).toBe("failed");
});

it("preserves replacements and every file when the retained keeper or authority cannot be revalidated", async () => {
  const replaced = fixture(); replaced.files.set(replaced.record.fileName, new Uint8Array([9, 8, 7]));
  expect(await replaced.run()).toMatchObject({ deleted: 0, failed: 1 }); expect(replaced.directory.removeExact).not.toHaveBeenCalled();
  const noKeeper = fixture(); noKeeper.files.delete(noKeeper.keeper.fileName);
  await expect(noKeeper.run()).rejects.toThrow(); expect(noKeeper.directory.removeExact).not.toHaveBeenCalled();
  const stale = fixture(); stale.worker.authorizeBackupRemoval.mockRejectedValue(new Error("stale fence"));
  await expect(stale.run()).rejects.toThrow(/stale/); expect(stale.directory.removeExact).not.toHaveBeenCalled();
});

it("does not unlink if persistent retry metadata is unavailable", async () => {
  const f = fixture(); f.storage.setItem = () => { throw new Error("storage unavailable"); };
  await expect(f.run()).rejects.toThrow(/storage/);
  expect(f.directory.removeExact).not.toHaveBeenCalled();
});

it("recovers an interrupted unlink before outcome metadata was saved without removing twice", async () => {
  const f = fixture(); const save = f.storage.setItem;
  f.storage.setItem = (key, value) => {
    if (JSON.parse(value).phase === "observed") throw new Error("interrupted after unlink");
    save(key, value);
  };
  await expect(f.run()).rejects.toThrow(/interrupted/);
  expect(f.files.has(f.record.fileName)).toBe(false);
  expect(f.worker.acknowledgeBackupRemoval).not.toHaveBeenCalled();
  expect(JSON.parse([...f.cache.values()][0]!).phase).toBe("removing");
  f.storage.setItem = save;
  expect(await f.run()).toMatchObject({ deleted: 1, remaining: 0 });
  expect(f.directory.removeExact).toHaveBeenCalledTimes(1); expect(f.cache.size).toBe(0);
});
