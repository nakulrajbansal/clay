import { expect, it, vi } from "vitest";
import { ownedBrowserStorage } from "./helpers/owned-browser-storage";
import { ProductionStoreAuthority } from "../src/production-authority";
import { DeviceCatalog } from "../src/device-catalog";
import { TargetAuthorityStore } from "../src/target-authority";
import { createStarterSeedBundle } from "../../shell/src/shells/seed";
import { openBrowserCatalogProbe } from "../src/db";
import { createLiveWriteGuard } from "../src/live-write-guard";
import { CatalogRestoreJobV2 } from "@clay/schema/archive";
import { deriveLifecycleId } from "../src/app-lifecycle-request";
import { physicalNamespaceEntry } from "../src/durable-inventory";
import { stageProductionRestore, executeProductionRestore } from "../src/production-restore";

const boot = () => ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
// Non-secret verifier output fixture. Cryptographic authentication is separately
// exercised through the actual trusted-shell port / db-worker integration.
const verification = { archiveSha256: `sha256:${"a".repeat(64)}`,
  authentication: { schema: 1 as const, kind: "cose_mac0_hmac_256_256" as const,
    authenticationVersion: 1 as const, keyId: "a".repeat(32), seriesId: "b".repeat(32), generation: "1" },
  freshness: "unknown" as const };

async function snapshot(authority: ProductionStoreAuthority) {
  const archive = await authority.collectArchiveSnapshot();
  return stageProductionRestore(authority, { ...verification, payload: archive.bytes });
}

it("does not claim, open or clean up a pre-existing destination footprint", async () => {
  const files = ownedBrowserStorage(); const authority = await boot();
  try {
    const source = authority.inspectAuthority(); const grant = await snapshot(authority);
    const requestId = authority.createRequestId();
    const ns = deriveLifecycleId("ns", source.catalog.authorityIncarnationId, requestId, "restore-namespace");
    const physical = physicalNamespaceEntry(ns, ns);
    // Represents an unregistered user file, not a job-owned partial installation.
    files.names.add(physical.userFile);
    const before = [...files.names].sort();
    await expect(executeProductionRestore(authority, { grant, requestId })).rejects.toThrow(/destination.*fresh|already exists/);
    expect([...files.names].sort()).toEqual(before);
    expect(files.targets.has(ns)).toBe(false);
    expect(files.state.unlinked).toEqual([]);
    const probe = await openBrowserCatalogProbe();
    try { expect(DeviceCatalog.openExisting(probe).pendingRestoreJobs()).toEqual([]); }
    finally { probe.close(); }
    expect(authority.inspectAuthority().target).toEqual(source.target);
  } finally { authority.close(); files.close(); }
});

it.each(["create", "install", "publish"] as const)("recovers interrupted restore %s without publishing or touching the source", async fault => {
  const files = ownedBrowserStorage();
  let authority = await boot();
  try {
    const source = authority.inspectAuthority().target;
    const originalNames = [...files.names].sort();
    const grant = await snapshot(authority);
    const requestId = authority.createRequestId();
    if (fault === "publish") vi.spyOn(DeviceCatalog.prototype, "addAppTarget")
      .mockImplementationOnce(() => { throw new Error("injected interrupted restore publish"); });
    else if (fault === "install") {
      const initialize = TargetAuthorityStore.initialize;
      vi.spyOn(TargetAuthorityStore, "initialize").mockImplementation((driver, input) => {
        const result = initialize(driver, input);
        if (input.appInstanceId === grant.destinationAppInstanceId) throw new Error("injected interrupted restore install");
        return result;
      });
    } else files.state.fault = fault;
    await expect(executeProductionRestore(authority, { grant, requestId })).rejects.toThrow();
    // A second power loss between sequential unlinks must remain recoverable.
    files.state.fault = "unlink";
    await expect(boot()).rejects.toThrow(/unlink/);
    authority = await boot();
    expect(authority.inspectAuthority().target).toEqual(source);
    expect(authority.bootInfo().apps).toHaveLength(1);
    expect([...files.names].sort()).toEqual(originalNames);
    expect(files.state.unlinked.every(name => !originalNames.includes(name))).toBe(true);
    await expect(executeProductionRestore(authority, { grant, requestId })).rejects.toThrow(/not published|interrupted/);
    // Recovery has a durable terminal receipt; export cannot silently omit it.
    expect((await authority.collectArchiveSnapshot()).format).toBe(5);
    const fresh = await snapshot(authority);
    authority = await executeProductionRestore(authority, { grant: fresh, requestId: authority.createRequestId() });
    expect(authority.bootInfo().apps).toHaveLength(2);
  } finally { authority.close(); files.close(); }
});

it("replays an exact published restore after reload, never unlinks it, and rejects a stale historical replay", async () => {
  const files = ownedBrowserStorage();
  let authority = await boot();
  try {
    const source = authority.bootInfo().selectedAppInstanceId;
    const grant = await snapshot(authority);
    const requestId = authority.createRequestId();
    authority = await executeProductionRestore(authority, { grant, requestId });
    const restored = authority.inspectAuthority().target;
    authority.close(); authority = await boot();
    authority = await executeProductionRestore(authority, { grant, requestId });
    expect(authority.inspectAuthority().target).toEqual(restored);
    expect(authority.bootInfo().apps.map(app => app.id)).toContain(source);
    expect(authority.bootInfo().apps).toHaveLength(2);
    expect(files.state.unlinked).toEqual([]);
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "setting.set", payload: { key: "test", value: 1 } });
    await expect(executeProductionRestore(authority, { grant, requestId })).rejects.toThrow(/stale/);
  } finally { authority.close(); files.close(); }
});

it("rejects forged or source-stale grants before reserving or creating a destination", async () => {
  const files = ownedBrowserStorage();
  const authority = await boot();
  try {
    const grant = await snapshot(authority);
    const names = [...files.names];
    await expect(executeProductionRestore(authority, { grant: { ...grant, archiveSha256: `sha256:${"c".repeat(64)}` },
      requestId: authority.createRequestId() })).rejects.toThrow();
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "setting.set", payload: { key: "test", value: 2 } });
    await expect(executeProductionRestore(authority, { grant, requestId: authority.createRequestId() })).rejects.toThrow(/changed|stale/);
    expect([...files.names]).toEqual(names);
    expect(authority.bootInfo().apps).toHaveLength(1);
  } finally { authority.close(); files.close(); }
});

it("restores starter data, panels, history and sample provenance with a replayable final target", async () => {
  const files = ownedBrowserStorage();
  let authority = await boot();
  try {
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "starter.seed", payload: createStarterSeedBundle("tracker") });
    const history = authority.readStore().history();
    const panels = authority.readStore().livePanels();
    const samples = authority.sampleRowCount();
    const grant = await snapshot(authority);
    const requestId = authority.createRequestId();
    authority = await executeProductionRestore(authority, { grant, requestId });
    expect(authority.readStore().history()).toEqual(history);
    expect(authority.readStore().livePanels()).toEqual(panels);
    expect(authority.sampleRowCount()).toBe(samples);
    authority = await executeProductionRestore(authority, { grant, requestId });
    expect((await authority.collectArchiveSnapshot()).format).toBe(5);
  } finally { authority.close(); files.close(); }
});

it.each(["recovery", "publication"] as const)("atomically fences restore when %s wins the pending-job race", async winner => {
  const files = ownedBrowserStorage();
  const authority = await boot();
  let probe: Awaited<ReturnType<typeof openBrowserCatalogProbe>> | undefined;
  try {
    const grant = await snapshot(authority);
    files.state.fault = "create";
    await expect(executeProductionRestore(authority, { grant, requestId: authority.createRequestId() })).rejects.toThrow();
    probe = await openBrowserCatalogProbe();
    const session = createLiveWriteGuard(probe);
    const catalog = DeviceCatalog.openForRestoreRecovery(session.driver);
    const pending = CatalogRestoreJobV2.parse(catalog.pendingRestoreJobs()[0]);
    const publication = () => session.authority.run(() => catalog.addAppTarget({
      expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
      target: { ...grant.archiveTarget, appInstanceId: grant.destinationAppInstanceId, activeGenerationId: pending.generationId,
        lineageEpoch: "0", protectionRevision: "0" }, namespaceId: pending.namespaceId, storageKey: pending.namespaceId,
      displayName: "Restored", shellId: "blank", operationId: pending.operationId, fence: pending.fence,
      nowMs: Date.now(), select: true, sourceArchiveSha256: grant.archiveSha256, sourceProvenanceId: grant.validationId,
    }, pending.jobId));
    if (winner === "publication") {
      publication();
      expect(() => session.authority.run(() => catalog.claimRestoreRecovery(pending, pending.fence, Date.now())))
        .toThrow(/publication|recovery/);
    } else {
      const before = catalog.snapshot();
      const fence = session.authority.run(() => catalog.acquireWriteLease({ expectedAuthorityIncarnationId: before.authorityIncarnationId,
        expectedCatalogGeneration: before.catalogGeneration, expectedWriteEpoch: before.writeEpoch,
        releaseId: `rel_${"z".repeat(26)}`, nowMs: Date.now(), ttlMs: 60_000 }));
      const claimed = session.authority.run(() => catalog.claimRestoreRecovery(pending, fence, Date.now()));
      expect(() => publication()).toThrow(/stale/);
      expect(() => catalog.assertRestoreClaim(claimed, fence, Date.now() + 60_000, "cleanup")).toThrow(/expired/);
      expect(() => catalog.assertRestoreClaim(pending, fence, Date.now(), "cleanup")).toThrow(/stale/);
    }
    expect(files.state.unlinked).toEqual([]);
  } finally { probe?.close(); authority.close(); files.close(); }
});

it("roundtrips create, starter fork and deletion receipts without losing physical isolation or history", async () => {
  const files = ownedBrowserStorage();
  let authority = await boot();
  try {
    const first = authority.bootInfo().selectedAppInstanceId;
    authority = await authority.executeAppLifecycle({ kind: "create", requestId: authority.createRequestId(), displayName: "Tracker", shellId: "tracker" });
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "starter.seed", payload: createStarterSeedBundle("tracker") });
    expect((await authority.collectArchiveSnapshot()).format).toBe(5);
    const original = authority.inspectAuthority().target;
    const history = authority.readStore().history();
    const samples = authority.sampleRowCount();
    const forkId = authority.createRequestId();
    authority = await authority.executeAppLifecycle({ kind: "fork", requestId: forkId });
    expect(authority.readStore().history()).toEqual(history);
    expect(authority.sampleRowCount()).toBe(samples);
    const fork = authority.inspectAuthority().target;
    expect(fork.appInstanceId).not.toBe(original.appInstanceId);
    expect(fork.activeGenerationId).not.toBe(original.activeGenerationId);
    authority = await authority.executeAppLifecycle({ kind: "fork", requestId: forkId });
    const forkGrant = await snapshot(authority);
    authority = await executeProductionRestore(authority, { grant: forkGrant, requestId: authority.createRequestId() });
    expect(authority.sampleRowCount()).toBe(samples);
    authority = await authority.executeAppLifecycle({ kind: "delete", requestId: authority.createRequestId(), appInstanceId: authority.bootInfo().selectedAppInstanceId });
    expect((await authority.collectArchiveSnapshot()).format).toBe(5);
    authority = await authority.executeAppLifecycle({ kind: "switch", requestId: authority.createRequestId(), appInstanceId: first });
    expect(authority.readStore().history()).toEqual([]);
    expect((await authority.collectArchiveSnapshot()).format).toBe(5);
  } finally { authority.close(); files.close(); }
});
