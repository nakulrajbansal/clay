import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { ownedBrowserStorage } from "../../kernel/test/helpers/owned-browser-storage";
vi.mock("../src/app/backup-trust-store.browser", async () => {
  const vault = new (await import("./helpers/memory-backup-trust")).MemoryBackupTrustStore();
  return { IndexedDbBackupTrustRecordStore: function () { return vault; } };
});

it("recovers download records after worker loss with private authentication and exact historical readback", async () => {
  const files = ownedBrowserStorage(); const ports: MessagePort[] = [];
  const scope = { onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (data: unknown) => queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent)) };
  const transport = { onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (data: unknown, transfer: Transferable[] = []) => {
      const sent = transfer.filter(item => item instanceof MessagePort) as MessagePort[]; ports.push(...sent);
      queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data), ports: sent } as unknown as MessageEvent));
    }, terminate: () => {} };
  vi.stubGlobal("self", scope); let client = new WorkerClient(transport as unknown as Worker);
  const reload = async (suffix: string) => {
    await client.shutdown(); const module = "../src/worker/db-worker.ts";
    await import(`${module}?manual-${suffix}`); client = new WorkerClient(transport as unknown as Worker);
    await client.boot({ requestedAppId: null, appCache: [] });
  };
  try {
    await import("../src/worker/db-worker"); await client.boot({ requestedAppId: null, appCache: [] });
    const kit = await client.beginBackupTrustEnrollment();
    await client.confirmBackupTrustEnrollment(kit.enrollmentId, kit.bytes.slice().buffer); kit.bytes.fill(0);
    const archive = await client.exportArchive(); const record = { ...archive.download, startedAt: new Date().toISOString() };
    const context = client.createMutationContext();
    await reload("before-record");
    expect(await client.manualBackupDownloadOutcome(record, context)).toEqual({ status: "not_recorded" });
    await expect(client.recordManualBackupDownload(record, context)).rejects.toThrow(/read-back/);
    const bad = archive.bytes.slice(0); const corrupted = new Uint8Array(bad); corrupted[10] = corrupted[10]! ^ 1;
    await expect(client.validateManualBackupDownload(bad, record)).rejects.toThrow();
    expect(await client.manualBackupDownloads()).toEqual([]);
    await client.validateManualBackupDownload(archive.bytes.slice(0), record);
    expect(await client.recordManualBackupDownload(record, context)).toEqual(record);
    await client.setSetting("manual_recovery_fixture", "later change", client.createMutationContext());
    await reload("after-record");
    expect(await client.manualBackupDownloadOutcome(record, context)).toEqual({ status: "recorded" });
    expect(await client.recordManualBackupDownload(record, context)).toEqual(record);
    expect(await client.manualBackupDownloads()).toEqual([record]);
    await expect(client.manualBackupDownloadOutcome({ ...record, fileName: "forged.clay" }, context)).rejects.toThrow(/identity|record/);
    expect(await client.backupRecords()).toEqual([]);
    expect(files.state.unlinked).toEqual([]);
    const first = await client.boot({ requestedAppId: null, appCache: [] });
    const second = await client.createApp("Roundtrip", "blank", client.createMutationContext());
    await client.seed("tracker", client.createMutationContext());
    const fork = await client.forkApp(client.createMutationContext());
    await client.switchApp(second.selectedAppInstanceId, client.createMutationContext());
    await client.deleteApp(second.selectedAppInstanceId, client.createMutationContext());
    await client.switchApp(fork.selectedAppInstanceId, client.createMutationContext());
    const panels = await client.panels(); const history = await client.history();
    const multi = await client.exportArchive();
    const grant = await client.validateRestoreArchive(multi.bytes.slice(0));
    const restored = await client.restoreAsNew(grant, client.createMutationContext());
    expect(restored.apps).toHaveLength(3); // original, independent fork, restored-as-new
    expect(restored.apps.some(app => app.id === second.selectedAppInstanceId)).toBe(false);
    expect(await client.panels()).toEqual(panels); expect(await client.history()).toEqual(history);
    await reload("multi-app-roundtrip");
    expect(await client.panels()).toEqual(panels);
    await client.switchApp(first.selectedAppInstanceId, client.createMutationContext());
    expect(await client.getSetting("manual_recovery_fixture")).toBe("later change");
  } finally { await client.shutdown().catch(() => {}); ports.forEach(port => port.close()); files.close(); }
}, 60_000);
