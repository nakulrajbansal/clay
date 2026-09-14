import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { OwnedComputeWorker } from "./helpers/owned-compute-worker";
import { ownedBrowserStorage } from "../../kernel/test/helpers/owned-browser-storage";

vi.mock("../src/app/backup-trust-store.browser", async () => {
  const vault = new (await import("./helpers/memory-backup-trust")).MemoryBackupTrustStore();
  return { IndexedDbBackupTrustRecordStore: function () { return vault; } };
});

it("authenticates before creating targets and restores through real WorkerClient/db-worker with response-loss replay", async () => {
  const files = ownedBrowserStorage();
  const requests: Array<{ id: number; op: string; requestId?: string; payload?: Record<string, unknown> }> = [];
  const ports: MessagePort[] = [];
  let drop = false, dropped = false;
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: { id: number; ok: boolean }) => {
      if (drop && data.ok && requests.slice().reverse().find(request => request.id === data.id)?.op === "restoreAsNew") {
        drop = false; dropped = true; return;
      }
      queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent));
    } };
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: typeof requests[number], transfer: Transferable[] = []) => {
      requests.push(structuredClone(data));
      const sentPorts = transfer.filter(item => item instanceof MessagePort) as MessagePort[];
      ports.push(...sentPorts);
      queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data), ports: sentPorts } as unknown as MessageEvent));
    }, terminate: () => {} };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("Worker", OwnedComputeWorker); OwnedComputeWorker.reset();
  let client = new WorkerClient(transport as unknown as Worker);
  try {
    await import("../src/worker/db-worker");
    const source = await client.boot({ requestedAppId: null, appCache: [] });
    await client.seed("tracker", client.createMutationContext());
    const history = await client.history();
    const panels = await client.panels();
    const kit = await client.beginBackupTrustEnrollment();
    await client.confirmBackupTrustEnrollment(kit.enrollmentId, kit.bytes.slice().buffer);
    const archive = await client.exportArchive();
    const download = { ...archive.download, startedAt: new Date().toISOString() };
    const downloadContext = client.createMutationContext();
    const recorded = await client.recordManualBackupDownload(download, downloadContext);
    expect(recorded).toMatchObject({ archiveFormat: 5, verification: "unverified_external_save" });
    expect(await client.recordManualBackupDownload(download, downloadContext)).toEqual(recorded);
    expect(await client.manualBackupDownloads()).toEqual([recorded]);
    expect(await client.backupRecords()).toEqual([]); // download never claims verified external persistence
    const names = [...files.names];
    const bad = new Uint8Array(archive.bytes.slice(0)); bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    await expect(client.validateRestoreArchive(bad.buffer)).rejects.toThrow();
    expect([...files.names]).toEqual(names);
    const grant = await client.validateRestoreArchive(archive.bytes.slice(0));
    expect(grant).toMatchObject({ kind: "authenticated_format5_restore_as_new", preservedAppInstanceId: source.selectedAppInstanceId });
    expect([...files.names]).toEqual(names); // validation has no physical target side effect
    const context = client.createMutationContext();
    drop = true;
    void client.restoreAsNew(grant, context).catch(() => {});
    await vi.waitFor(() => expect(dropped).toBe(true), { timeout: 20_000 });
    client = new WorkerClient(transport as unknown as Worker);
    const restored = await client.restoreAsNew(grant, context);
    expect(restored.apps).toHaveLength(2);
    expect(restored.selectedAppInstanceId).toBe(grant.destinationAppInstanceId);
    expect(await client.history()).toEqual(history);
    expect(await client.panels()).toEqual(panels);
    await client.shutdown();
    const module = "../src/worker/db-worker.ts";
    await import(`${module}?restore-reload`);
    client = new WorkerClient(transport as unknown as Worker);
    await client.boot({ requestedAppId: null, appCache: [] });
    expect((await client.restoreAsNew(grant, context)).apps).toHaveLength(2);
    await client.switchApp(source.selectedAppInstanceId, client.createMutationContext());
    expect(await client.history()).toEqual(history);
    expect(files.state.unlinked).toEqual([]);
    expect(requests.filter(request => request.op === "restoreAsNew").map(request => request.requestId))
      .toEqual([context.requestId, context.requestId, context.requestId]);
    expect(requests.some(request => ["importRecoveryKit", "confirmBackupTrustEnrollment"].includes(request.op))).toBe(false);
  } finally { await client.shutdown().catch(() => {}); for (const port of ports) port.close(); files.close(); }
}, 60_000);
