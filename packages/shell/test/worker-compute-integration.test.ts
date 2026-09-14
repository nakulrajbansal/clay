import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { openMemoryDriver } from "../../kernel/src/db";
import { ProductionStoreAuthority } from "../../kernel/src/production-authority";
import { OwnedComputeWorker } from "./helpers/owned-compute-worker";

it("real WorkerClient/DB authority rejects forged, lost and stale CPU work; reload/replay preserves one starter", async () => {
  const driver = await openMemoryDriver(); driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const id = (prefix: string) => `${prefix}_${"q".repeat(26)}`;
  const authority = ProductionStoreAuthority.initializeFresh(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [] },
    storageKey: id("ns"), displayName: "Blank", shellId: "blank", appInstanceId: id("app"),
    generationId: id("gen"), namespaceId: id("ns"), adoptionOperationId: id("op"), releaseId: id("rel"),
    nowMs: Date.now(), leaseTtlMs: 60_000,
  });
  vi.spyOn(ProductionStoreAuthority, "bootBrowser").mockResolvedValue(authority);
  // Reload leaves the fixture's owned memory handle open; production reopens OPFS.
  vi.spyOn(authority, "close").mockImplementation(() => {});
  let drop = false;
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: unknown) => { if (!drop) queueMicrotask(() => transport.onmessage?.({ data } as MessageEvent)); } };
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: unknown) => queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data), ports: [] } as unknown as MessageEvent)), terminate() {} };
  vi.stubGlobal("self", scope); vi.stubGlobal("Worker", OwnedComputeWorker); OwnedComputeWorker.reset();
  let client = new WorkerClient(transport as unknown as Worker);
  try {
    await import("../src/worker/db-worker");
    await client.boot({ requestedAppId: null, appCache: [] });
    const before = authority.inspectAuthority(), physical = await driver.exportDatabases();
    const request = client.createMutationContext();
    OwnedComputeWorker.transform = value => ({ ...(value as object), fragment: "{}" });
    await expect(client.seed("tracker", request)).rejects.toThrow(/computation/);
    OwnedComputeWorker.transform = null; OwnedComputeWorker.fail = true;
    await expect(client.seed("tracker", request)).rejects.toThrow(/computation/);
    OwnedComputeWorker.fail = false;
    expect(authority.inspectAuthority()).toEqual(before); expect(await driver.exportDatabases()).toEqual(physical);
    OwnedComputeWorker.hold = true;
    const stale = client.seed("tracker", request).catch(error => error);
    await vi.waitFor(() => expect(OwnedComputeWorker.pending).toHaveLength(1));
    await client.setSetting("test_compute_race", "intervening", client.createMutationContext());
    OwnedComputeWorker.pending.shift()!();
    expect(await stale).toMatchObject({ message: expect.stringContaining("computed source") });
    expect(await client.history()).toEqual([]);
    const count = OwnedComputeWorker.starts;
    drop = true;
    const lost = client.seed("tracker", request).catch(error => error);
    await vi.waitFor(() => expect(authority.readSetting("shell_id")).toBe("tracker"));
    drop = false;
    client = new WorkerClient(transport as unknown as Worker);
    expect(await lost).toMatchObject({ message: expect.stringContaining("outcome is unknown") });
    const committed = authority.inspectAuthority(), committedBytes = await driver.exportDatabases();
    expect(await client.seed("tracker", request)).toBeNull();
    expect(OwnedComputeWorker.starts).toBe(count + 2);
    expect(authority.inspectAuthority()).toEqual(committed); expect(await driver.exportDatabases()).toEqual(committedBytes);
    await client.shutdown();
    const path = "../src/worker/db-worker.ts"; await import(`${path}?compute-reload`);
    client = new WorkerClient(transport as unknown as Worker);
    await client.boot({ requestedAppId: null, appCache: [] });
    expect(await client.seed("tracker", request)).toBeNull();
    expect(authority.inspectAuthority()).toEqual(committed);
    expect(authority.query({ from: "items" })).toHaveLength(3);
  } finally {
    drop = false; OwnedComputeWorker.hold = false;
    try { await client.shutdown(); } catch { /* owned test handles only */ }
    OwnedComputeWorker.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); driver.close();
  }
}, 30_000);
