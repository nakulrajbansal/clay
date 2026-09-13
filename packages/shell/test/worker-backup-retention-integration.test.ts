import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { ownedBrowserStorage } from "../../kernel/test/helpers/owned-browser-storage";
import { runProductionAutomaticBackup, productionRetentionWork } from "../src/app/production-backup.browser";
import { runProductionBackupRetention } from "../src/app/backup-retention.browser";
import { BackupDirectoryIoError } from "../src/app/backup-target.browser";
import { DeterministicDirectory, id } from "../../kernel/test/external-backup-fakes";
import { MemoryBackupTrustStore } from "./helpers/memory-backup-trust";
const vaultRef = vi.hoisted(() => ({ value: null as MemoryBackupTrustStore | null }));
vi.mock("../src/app/backup-trust-store.browser", async () => {
  vaultRef.value = new (await import("./helpers/memory-backup-trust")).MemoryBackupTrustStore();
  return { IndexedDbBackupTrustRecordStore: function () { return vaultRef.value; } };
});

it("executes retention read/authorization through the real worker without granting a foreign or protected file", async () => {
  const owned = ownedBrowserStorage();
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: unknown) => queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent)) };
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: unknown) => queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data) } as MessageEvent)), terminate() {} };
  vi.stubGlobal("self", scope); const client = new WorkerClient(transport as unknown as Worker);
  try {
    await import("../src/worker/db-worker"); const boot = await client.boot({ requestedAppId: null, appCache: [] });
    const input = { appInstanceId: boot.selectedAppInstanceId, targetId: `tgt_${"a".repeat(26)}`, adapterCertificationId: `btc_${"b".repeat(26)}` };
    expect(await client.backupRetentionPlan(input)).toEqual({ schema: 1, keeper: null, entries: [], remaining: 0 });
    expect(await client.backupRetentionHistory()).toEqual({ schema: 1, revision: "0", events: [] });
    const selection = await client.backupSelection();
    await expect(client.authorizeBackupRemoval({ schema: 1, authorityIncarnationId: selection.selected.authorityIncarnationId,
      planningRevision: "0", backupId: `bkp_${"c".repeat(26)}`, keeperBackupId: `bkp_${"d".repeat(26)}` }, client.createMutationContext())).rejects.toThrow();
    expect(await client.backupRecords()).toEqual([]); expect(owned.state.unlinked).toEqual([]);
  } finally { await client.shutdown().catch(() => {}); owned.close(); }
}, 30_000);

it("recovers real worker publications, expired leases, trust failures, partial files and receipt-bound removal across folder/source switches", async () => {
  const owned = ownedBrowserStorage(); const ports: MessagePort[] = [];
  const cache = new Map<string, string>();
  const storage = { getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => { cache.set(key, value); }, removeItem: (key: string) => { cache.delete(key); } };
  vi.stubGlobal("localStorage", storage);
  const scope = { onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (data: unknown) => queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent)) };
  const transport = { onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (data: unknown, transfer: Transferable[] = []) => {
      const sent = transfer.filter(item => item instanceof MessagePort) as MessagePort[]; ports.push(...sent);
      queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data), ports: sent } as unknown as MessageEvent));
    }, terminate() {} };
  vi.stubGlobal("self", scope); let client = new WorkerClient(transport as unknown as Worker);
  const reload = async (suffix: string) => {
    await client.shutdown(); const module = "../src/worker/db-worker.ts"; await import(`${module}?retention-${suffix}`);
    client = new WorkerClient(transport as unknown as Worker); return client.boot({ requestedAppId: null, appCache: [] });
  };
  const directories = new Map<string, DeterministicDirectory>();
  const directoryFor = (targetId: string) => {
    let directory = directories.get(targetId);
    if (!directory) {
      directory = new DeterministicDirectory(targetId);
      const read = directory.readExact.bind(directory);
      directory.readExact = async name => { if (!directory!.files.has(name)) throw new BackupDirectoryIoError("file_missing"); return read(name); };
      directories.set(targetId, directory);
    }
    return directory;
  };
  const adapter = { availability: () => ({ status: "available" as const }), directory: (target: { targetId: string }) => directoryFor(target.targetId) };
  try {
    const module = "../src/worker/db-worker.ts"; await import(`${module}?retention-combined`);
    const boot = await client.boot({ requestedAppId: null, appCache: [] });
    const kit = await client.beginBackupTrustEnrollment();
    await client.confirmBackupTrustEnrollment(kit.enrollmentId, kit.bytes.slice().buffer); kit.bytes.fill(0);
    const target = { schema: 1 as const, appInstanceId: boot.selectedAppInstanceId, targetId: id("tgt", "e"),
      adapter: "browser_directory" as const, adapterCertificationId: id("btc", "f"), authorizedAt: new Date().toISOString() };
    const retentionScope = { appInstanceId: target.appInstanceId, targetId: target.targetId, adapterCertificationId: target.adapterCertificationId };
    const directory = directoryFor(target.targetId);
    const run = () => runProductionAutomaticBackup(client, adapter, target, "backup_now");
    // A close failure leaves exact staged bytes. Reload/lease expiry must reuse their name and bytes.
    directory.closeFailure = "operation_interrupted";
    expect(await run()).toMatchObject({ status: "failed", reasonCode: "operation_interrupted" });
    const stagedName = [...directory.files.keys()][0]!;
    const stagedBytes = directory.files.get(stagedName)!.slice();
    directory.closeFailure = null;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 120_000);
    await reload("lease-expired");
    expect(await run()).toMatchObject({ status: "published", record: { fileName: stagedName } });
    expect(directory.files.get(stagedName)).toEqual(stagedBytes);
    // Trust commit failure occurs after durable catalog publication, never authorizing a replacement.
    const commit = vaultRef.value!.compareAndSet.bind(vaultRef.value);
    let rejectCommit = true;
    vi.spyOn(vaultRef.value!, "compareAndSet").mockImplementation(async (series, revision, next) => {
      if (rejectCommit && next && typeof next === "object" && Reflect.get(next, "committed")
          && Reflect.get(next, "pending") === null) { rejectCommit = false; throw new Error("owned trust commit failure"); }
      return commit(series, revision, next);
    });
    vi.setSystemTime(Date.now() + 1);
    expect(await run()).toMatchObject({ status: "failed", reasonCode: "publication_failed" });
    expect(await client.backupRecords()).toHaveLength(2);
    await reload("trust-failure");
    expect(await run()).toMatchObject({ status: "published", publication: "already_published" });
    expect(await client.backupRecords()).toHaveLength(2);
    for (let n = 2; n < 32; n++) { vi.setSystemTime(Date.now() + 1); expect(await run()).toMatchObject({ status: "published" }); }
    directory.removeFailures.add(stagedName); vi.setSystemTime(Date.now() + 1);
    expect(await run()).toMatchObject({ status: "published", rotation: { requested: 1, deleted: 0, failed: 1 } });
    expect((await client.backupRetentionHistory()).events).toHaveLength(1);
    // Switching folder retires only the published candidate cache. Its catalog work survives.
    const folder2 = { ...target, targetId: id("tgt", "g") };
    await expect(runProductionAutomaticBackup(client, adapter, folder2, "backup_now")).rejects.toThrow(/previous|reconciled/i);
    expect((await client.backupRetentionPlan(retentionScope)).remaining).toBe(1);
    expect(directory.files.has(stagedName)).toBe(true);
    expect(await runProductionAutomaticBackup(client, adapter, folder2, "backup_now")).toMatchObject({ status: "published" });
    const other = await client.createApp("Other source", "blank", client.createMutationContext());
    const otherTarget = { ...folder2, appInstanceId: other.selectedAppInstanceId, targetId: id("tgt", "h") };
    expect(await runProductionAutomaticBackup(client, adapter, otherTarget, "backup_now")).toMatchObject({ status: "published" });
    expect((await client.backupRetentionPlan(retentionScope)).remaining).toBe(1);
    const protectedFiles = [...directoryFor(folder2.targetId).files.keys(), ...directoryFor(otherTarget.targetId).files.keys()];
    expect(productionRetentionWork(await client.backupRecords(true), storage)).toEqual([
      { scope: retentionScope, remaining: 1, folderName: "Earlier folder", canResume: false },
    ]); // Lost presentation hints quarantine old work instead of hiding it from the new app.
    directory.removeFailures.clear();
    const acknowledge = client.acknowledgeBackupRemoval.bind(client);
    vi.spyOn(client, "acknowledgeBackupRemoval").mockImplementationOnce(async (...args) => { await acknowledge(...args); throw new Error("owned lost acknowledgement response"); });
    await expect(runProductionBackupRetention(client, directory, retentionScope, storage)).rejects.toThrow(/lost acknowledgement/);
    expect(directory.files.has(stagedName)).toBe(false); expect(cache.size).toBe(1);
    await reload("after-unlink-ack");
    expect(await runProductionBackupRetention(client, directory, retentionScope, storage)).toMatchObject({ deleted: 1, remaining: 0 });
    expect(cache.size).toBe(0);
    expect((await client.backupRetentionHistory()).events.map(event => event.outcome)).toEqual(["failed", "absent"]);
    expect([...directoryFor(folder2.targetId).files.keys(), ...directoryFor(otherTarget.targetId).files.keys()]).toEqual(protectedFiles);
    // A partial candidate is never overwritten or deleted when explicitly retired.
    const partial = directoryFor(otherTarget.targetId); partial.shortWrite = true;
    expect(await runProductionAutomaticBackup(client, adapter, otherTarget, "backup_now")).toMatchObject({ status: "failed", reasonCode: "short_write" });
    const partialFiles = [...partial.files].map(([name, bytes]) => [name, bytes.slice()]);
    partial.shortWrite = false; await reload("partial-write");
    expect(await runProductionAutomaticBackup(client, adapter, otherTarget, "backup_now")).toMatchObject({ status: "failed", reasonCode: "short_write" });
    const trust = await client.backupTrustStatus(); if (trust.status !== "ready" || !trust.pending) throw new Error("expected owned pending candidate");
    await client.retireAutomaticBackup(trust.seriesId, trust.pending.backupId, "keep_existing_files_and_retire_unpublished_attempt");
    expect([...partial.files]).toEqual(partialFiles); expect(owned.state.unlinked).toEqual([]);
    const archive = await client.exportArchive();
    expect((await client.validateRestoreArchive(archive.bytes.slice(0))).archiveTarget.appInstanceId).toBe(other.selectedAppInstanceId);
  } finally { await client.shutdown().catch(() => {}); ports.forEach(port => port.close()); vi.useRealTimers(); owned.close(); }
}, 120_000);
