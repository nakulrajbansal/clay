import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import * as db from "../../kernel/src/db";
import { StateMerkleIndex } from "../../kernel/src/state-merkle-index";
import { TargetAuthorityStore } from "../../kernel/src/target-authority";
import { classifyDurableFileInventory } from "../../kernel/src/durable-inventory";
import { StoreRpcClient, portFromMessagePort } from "../../kernel/src/asyncstore";

/** Real SQLite + real WorkerClient + real db-worker + real ProductionStoreAuthority.
 * Only browser file acquisition and the message transport are substituted. This
 * is not OPFS/browser certification; the owned packaged gate covers that seam. */
it("executes isolated lifecycle and receipt-bound first-run import through the real worker protocol", async () => {
  const catalogFile = `/p0-worker-catalog-${crypto.randomUUID()}.db`;
  const targets = new Map<string, db.DbDriver>();
  const names = new Set<string>();
  const closers: Array<() => void> = [];
  const ports: MessagePort[] = [];
  let fault: "partial-create" | "partial-unlink" | "retain-cleanup" | null = null;
  let unreadableApp: string | null = null;
  const sysAuthority = ["state_digest_leaves", "state_digest_buckets", "state_digest_root",
    "target_authority_header", "target_revision_reservations", "production_request_receipts"];
  const open = async (key?: string) => {
    const source = key ? targets.get(key) : undefined;
    const driver = source ? await source.snapshot() : await db.openMemoryDriver();
    if (source) {
      StateMerkleIndex.createSchema(driver);
      TargetAuthorityStore.createSchema(driver);
      for (const table of sysAuthority) {
        driver.exec(`DELETE FROM sys.${table}`);
        for (const row of source.select(`SELECT * FROM sys.${table}`)) {
          const columns = Object.keys(row);
          driver.exec(`INSERT INTO sys.${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            columns.map(column => row[column]!));
        }
      }
    }
    driver.exec(`ATTACH DATABASE '${catalogFile}' AS catalog`);
    closers.push(driver.close.bind(driver));
    vi.spyOn(driver, "close").mockImplementation(() => {});
    if (key) targets.set(key, driver);
    return driver;
  };
  vi.spyOn(db, "browserDurableInventory").mockImplementation(async () => classifyDurableFileInventory([...names]));
  vi.spyOn(db, "browserDurableFileNames").mockImplementation(async () => [...names].sort());
  vi.spyOn(db, "openBrowserCatalogProbe").mockImplementation(async () => {
    names.add("/clay-device-catalog-v1.db"); return open();
  });
  vi.spyOn(db, "openBrowserProductionTarget").mockImplementation(async physical => {
    const existing = targets.get(physical.storageKey);
    if (unreadableApp && existing
        && existing.select("SELECT app_instance_id FROM sys.target_authority_header")[0]?.app_instance_id === unreadableApp)
      throw new Error("injected unreadable deletion fallback");
    if (fault === "partial-create" && !targets.has(physical.storageKey)) {
      names.add(physical.userFile); fault = null;
      throw new Error("injected power loss between target file creation");
    }
    names.add(physical.userFile); names.add(physical.systemFile);
    names.add("/clay-device-catalog-v1.db"); return open(physical.storageKey);
  });
  vi.spyOn(db, "deleteBrowserNamespaceStorage").mockImplementation(async (physical, assertClaim) => {
    if (fault === "retain-cleanup") { fault = null; throw new Error("injected power loss before unlink"); }
    assertClaim(); names.delete(physical.userFile);
    if (fault === "partial-unlink") { fault = null; throw new Error("injected power loss between unlink calls"); }
    assertClaim(); names.delete(physical.systemFile);
    targets.delete(physical.storageKey);
  });
  let lockTail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, work: () => Promise<unknown>) => {
    const result = lockTail.then(work);
    lockTail = result.then(() => undefined, () => undefined);
    return result;
  } }, storage: { persist: async () => true, persisted: async () => true } });
  let dropResponseFor: string | null = null;
  let dropped = false;
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: { id: number; ok?: boolean }) => {
      if (dropResponseFor && data.ok && requests.slice().reverse().find(request => request.id === data.id)?.op === dropResponseFor) {
        dropped = true; dropResponseFor = null; return;
      }
      queueMicrotask(() => transport.onmessage?.({ data } as MessageEvent));
    } };
  const requests: Array<{ id: number; op: string; requestId: string; payload: unknown }> = [];
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: { id: number; op: string; requestId: string; payload: unknown }, transfer: Transferable[] = []) => {
      requests.push(structuredClone(data));
      const sentPorts = transfer.filter(item => item instanceof MessagePort) as MessagePort[];
      ports.push(...sentPorts);
      queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data), ports: sentPorts } as unknown as MessageEvent));
    }, terminate: () => {} };
  vi.stubGlobal("self", scope);
  let client = new WorkerClient(transport as unknown as Worker);
  const records = () => {
    const port = client.openStorePort("live"); ports.push(port);
    return new StoreRpcClient(portFromMessagePort(port));
  };
  try {
    await import("../src/worker/db-worker");
    const first = await client.boot({ requestedAppId: null, appCache: [] });
    expect(first.apps).toHaveLength(1);
    const protection = (await client.deviceProtection()).target!;
    const initialTarget = {
      appInstanceId: protection.appInstanceId, activeGenerationId: protection.activeGenerationId,
      lineageEpoch: protection.lineageEpoch, protectionRevision: protection.stateRevision,
      digestSchema: 1 as const, stateSha256: protection.stateDigest,
    };
    const importRequest = client.createMutationContext();
    const payload = { table: "expenses", columns: [{ name: "item", type: "text" as const }], rows: [{ item: "First-only row" }] };
    const imported = await client.importNewApp(initialTarget, payload, importRequest);
    expect(imported.appInstanceId).toBe(first.selectedAppInstanceId);
    expect((await client.boot({ requestedAppId: null, appCache: [] })).apps).toHaveLength(1);
    expect(await client.importNewApp(initialTarget, payload, importRequest)).toEqual(imported);
    const firstHistory = await client.history();
    const firstPanels = await client.panels();
    await client.shutdown();
    client = new WorkerClient(transport as unknown as Worker);
    const workerModule = "../src/worker/db-worker.ts";
    await import(`${workerModule}?p0-first-import-reload`);
    const importedReload = await client.boot({ requestedAppId: null, appCache: [] });
    expect(importedReload.apps).toHaveLength(1);
    expect(importedReload.selectedAppInstanceId).toBe(first.selectedAppInstanceId);
    expect(await client.history()).toEqual(firstHistory);
    const createContext = client.createMutationContext();
    dropResponseFor = "createApp";
    const lostResponse = client.createApp("Second", "blank", createContext).catch(error => error);
    await vi.waitFor(() => expect(dropped).toBe(true));
    expect(await Promise.race([lostResponse, new Promise(resolve => setTimeout(() => resolve("timeout-without-cancellation"), 1))]))
      .toBe("timeout-without-cancellation");
    client = new WorkerClient(transport as unknown as Worker);
    expect(await lostResponse).toMatchObject({ code: "E_INTERNAL", message: expect.stringContaining("outcome is unknown") });
    const second = await client.createApp("Second", "blank", createContext);
    expect(second.apps).toHaveLength(2);
    expect(await client.history()).toEqual([]);
    expect(await client.panels()).toEqual([]);
    expect((await client.createApp("Second", "blank", createContext)).selectedAppInstanceId).toBe(second.selectedAppInstanceId);
    await client.seed("tracker", client.createMutationContext());
    await expect(client.renameApp(second.selectedAppInstanceId, "Inventory", client.createMutationContext(), "inventory"))
      .rejects.toThrow(/committed starter/);
    expect((await client.boot({ requestedAppId: null, appCache: [] })).shellId).toBe("tracker");
    const switched = await client.switchApp(first.selectedAppInstanceId, client.createMutationContext());
    expect(switched.selectedAppInstanceId).toBe(first.selectedAppInstanceId);
    expect(await client.history()).toEqual(firstHistory);
    expect(await client.panels()).toEqual(firstPanels);
    expect(await records().query({ from: "expenses" })).toEqual([expect.objectContaining({ item: "First-only row" })]);
    const renameContext = client.createMutationContext();
    await client.renameApp(first.selectedAppInstanceId, "Renamed", renameContext);
    // Lost client/response reconstruction retains the request identity, never mints a new app.
    client = new WorkerClient(transport as unknown as Worker);
    expect((await client.renameApp(first.selectedAppInstanceId, "Renamed", renameContext)).apps[0]?.name).toBeDefined();
    const fork = await client.forkApp(client.createMutationContext());
    expect(fork.selectedAppInstanceId).not.toBe(first.selectedAppInstanceId);
    expect(await client.history()).toEqual(firstHistory);
    expect(await client.panels()).toEqual(firstPanels);
    await records().insert("expenses", { item: "Fork-only row" }, client.createMutationContext());
    expect(await records().query({ from: "expenses" })).toHaveLength(2);
    expect(targets.size).toBe(3);
    await expect(client.createApp("Second", "blank", createContext)).rejects.toThrow(/stale/);
    // Replay failure closes the route authority; boot must recover from durable catalog.
    await client.boot({ requestedAppId: null, appCache: [] });
    await client.switchApp(first.selectedAppInstanceId, client.createMutationContext());
    expect(await records().query({ from: "expenses" })).toEqual([expect.objectContaining({ item: "First-only row" })]);
    await client.switchApp(fork.selectedAppInstanceId, client.createMutationContext());
    const deleteContext = client.createMutationContext();
    unreadableApp = [first.selectedAppInstanceId, second.selectedAppInstanceId].sort()[0]!;
    await expect(client.deleteApp(fork.selectedAppInstanceId, deleteContext)).rejects.toThrow(/unreadable deletion fallback/);
    expect(targets.size).toBe(3);
    unreadableApp = null;
    const deniedDeleteBoot = await client.boot({ requestedAppId: null, appCache: [] });
    expect(deniedDeleteBoot.apps).toHaveLength(3);
    expect(deniedDeleteBoot.selectedAppInstanceId).toBe(fork.selectedAppInstanceId);
    const deleted = await client.deleteApp(fork.selectedAppInstanceId, deleteContext);
    expect(deleted.apps).toHaveLength(2);
    expect(deleted.apps.some(app => app.id === fork.selectedAppInstanceId)).toBe(false);
    expect(targets.size).toBe(2);
    await client.switchApp(first.selectedAppInstanceId, client.createMutationContext());
    await client.undoNewAppImport(initialTarget, importRequest.requestId, client.createMutationContext());
    const undoneBoot = await client.boot({ requestedAppId: null, appCache: [] });
    expect(undoneBoot.shellId).toBe("blank");
    expect(await client.history()).toEqual([]);
    await client.shutdown();
    client = new WorkerClient(transport as unknown as Worker);
    await import(`${workerModule}?p0-reload`);
    const reopened = await client.boot({ requestedAppId: null, appCache: [] });
    expect(reopened.selectedAppInstanceId).toBe(first.selectedAppInstanceId);
    expect(reopened.apps.find(app => app.id === first.selectedAppInstanceId)?.name).toBe("Renamed");
    expect(await client.history()).toEqual([]);
    fault = "partial-create";
    const recoveryContext = client.createMutationContext();
    await expect(client.createApp("Interrupted", "blank", recoveryContext)).rejects.toThrow(/power loss/);
    expect(classifyDurableFileInventory([...names])).toMatchObject({ state: "ambiguous", reason: "orphan_namespace" });
    const recovered = await client.boot({ requestedAppId: null, appCache: [] });
    expect(recovered.apps).toHaveLength(3);
    expect((await client.createApp("Interrupted", "blank", recoveryContext)).selectedAppInstanceId).toBe(recovered.selectedAppInstanceId);
    fault = "retain-cleanup";
    const cleanupContext = client.createMutationContext();
    await expect(client.deleteApp(recovered.selectedAppInstanceId, cleanupContext)).rejects.toThrow(/power loss/);
    const unlinkCalls = vi.mocked(db.deleteBrowserNamespaceStorage).mock.calls.length;
    unreadableApp = [first.selectedAppInstanceId, second.selectedAppInstanceId].sort()[0]!;
    await expect(client.boot({ requestedAppId: null, appCache: [] })).rejects.toThrow(/unreadable deletion fallback/);
    expect(vi.mocked(db.deleteBrowserNamespaceStorage).mock.calls).toHaveLength(unlinkCalls);
    expect(targets.size).toBe(3);
    unreadableApp = null;
    fault = "partial-unlink";
    await expect(client.boot({ requestedAppId: null, appCache: [] })).rejects.toThrow(/power loss/);
    expect(classifyDurableFileInventory([...names])).toMatchObject({ state: "ambiguous", reason: "orphan_namespace" });
    expect((await client.boot({ requestedAppId: null, appCache: [] })).apps).toHaveLength(2);
    expect((await client.deleteApp(recovered.selectedAppInstanceId, cleanupContext)).apps).toHaveLength(2);
    await client.switchApp(second.selectedAppInstanceId, client.createMutationContext());
    expect((await client.deleteApp(second.selectedAppInstanceId, client.createMutationContext())).apps).toHaveLength(1);
    await expect(client.deleteApp(first.selectedAppInstanceId, client.createMutationContext())).rejects.toThrow(/last live app/);
    expect((await client.boot({ requestedAppId: null, appCache: [] })).apps).toHaveLength(1);
    expect(requests.filter(request => request.op === "importNewApp").map(request => request.requestId))
      .toEqual([importRequest.requestId, importRequest.requestId]);
  } finally {
    try { await client.shutdown(); } catch { /* tests still release their own fixtures */ }
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const port of ports) port.close();
    for (const close of closers) try { close(); } catch { /* already closed */ }
  }
}, 60_000);
