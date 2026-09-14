import { afterEach, expect, it, vi } from "vitest";
import { initializedSahpool, OwnedSahDirectory } from "./helpers/owned-sahpool";
import { ownedLifecycleLocks } from "./helpers/owned-lifecycle-locks";

afterEach(() => { vi.useRealTimers(); vi.doUnmock("@sqlite.org/sqlite-wasm"); vi.resetModules(); vi.unstubAllGlobals(); });
async function runtime(owned: OwnedSahDirectory) {
  const sqlite = await initializedSahpool(owned);
  // Disposable exclusion fixture. Actual SAHPool holds the same original SAHs.
  Object.assign(navigator, { locks: ownedLifecycleLocks() });
  vi.resetModules(); vi.doMock("@sqlite.org/sqlite-wasm", () => ({ default: async () => sqlite }));
  return { sqlite, db: await import("../src/db"), Authority: (await import("../src/production-authority")).ProductionStoreAuthority };
}

it.each(["user", "system", "catalog"].flatMap(role => [false, true].map(writeThrough => ({ role, writeThrough }))))(
  "recovers the original catalog-proven production tuple after $role flush (writeThrough=$writeThrough)", async ({ role, writeThrough }) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    const owned = new OwnedSahDirectory(); owned.writeThrough = writeThrough;
    const first = await runtime(owned), original = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
    const before = original.inspectAuthority().target;
    const request = { requestId: original.createRequestId(), route: "starter.seed", payload: {
      schema: 1, shellId: "tracker", shellName: "Owned tracker", panels: [],
      tables: [{ name: "owned_notes", columns: [{ name: "title", type: "text", required: true }], sampleRows: [{ title: "Owned row" }] }],
    } };
    owned.fault = event => event.op === "flush" && (role === "catalog" ? event.path === "/clay-device-catalog-v1.db"
      : event.path === `/${role}.db` || event.path.endsWith(`-${role}.db`));
    await expect(original.executeMutation(request)).rejects.toThrow(); expect(owned.dead).toBe(true);
    owned.reopen(); owned.events.length = 0; vi.setSystemTime(new Date("2026-09-13T12:01:01.000Z"));
    const second = await runtime(owned), recovered = await second.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
    try {
      expect(recovered.inspectAuthority().target.appInstanceId).toBe(before.appInstanceId);
      expect(recovered.inspectAuthority().target.activeGenerationId).toBe(before.activeGenerationId);
      expect((await second.db.browserDurableInventory()).state).toBe("complete");
      expect([0, 2]).toContain(recovered.readStore().headVersion());
      // Do not mint another request while the interrupted identity is unresolved.
      try { await recovered.executeMutation(request); } catch { /* A durably abandoned original stays failed. */ }
      const version = recovered.readStore().headVersion();
      try { await recovered.executeMutation(request); } catch { /* The same exact outcome remains terminal. */ }
      expect(recovered.readStore().headVersion()).toBe(version);
      expect(version).toBeLessThanOrEqual(2);
    } finally { recovered.close(); (await second.sqlite.installOpfsSAHPoolVfs()).pauseVfs(); }
  }, 30_000);

it("grants automation only to a proved production tuple, executes paired effects and Undo, and keeps certification separate", async () => {
  const owned = new OwnedSahDirectory(), first = await runtime(owned);
  const authority = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "starter.seed", payload: {
      schema: 1, shellId: "tracker", shellName: "Owned automation", panels: [], tables: [{ name: "notes", columns: [
        { name: "title", type: "text", required: true }, { name: "status", type: "text", required: true }], sampleRows: [{ title: "Owned", status: "todo" }] }],
    } });
    expect((await authority.automationPresentation()).availability.available).toBe(true);
    const { productionLifecycleContext } = await import("../src/production-authority");
    const capability = first.db.automationPhysicalTransactionCapability(productionLifecycleContext(authority).driver);
    expect(capability).toMatchObject({ kind: "opfs_native_recovery", releaseCertificate: false });
    expect(first.db.automationPhysicalTransactionAvailable({ ...capability })).toBe(false);
    expect(first.db.automationPhysicalTransactionAvailable(capability)).toBe(true);
    const table = authority.activeSemanticRegistry().get("notes")!;
    const field = (name: string) => ({ tableId: table.semantic!.tableId, fieldId: table.columns.find(row => row.name === name)!.semantic!.fieldId, lastKnownName: name });
    const command = (route: string, payload: unknown) => ({ requestId: authority.createRequestId(), route: "automation.command",
      payload: { authorityTarget: authority.inspectAuthority().target, command: { route, payload } } });
    const draft = await authority.executeMutation(command("saveAutomationDraft", { expectedRevision: null, input: { v: 2, name: "Owned physical run",
      trigger: { kind: "manual", table: { tableId: table.semantic!.tableId, lastKnownName: "notes" }, conditions: [{ field: field("title"), op: "eq", value: "Owned" }] },
      actions: [{ kind: "set_fields", values: [{ field: field("status"), value: { source: "literal", value: "done" } }] }, { kind: "notify", title: "Owned notice", body: "On this device" }],
      runtime: { mode: "local", timeZone: "Pacific/Auckland", missedPolicy: "skip" } } }));
    const rule = draft.result as any;
    const simulation = await authority.simulateAutomation({ id: rule.id, expectedRevision: rule.definitionRevision, purpose: "run_now" });
    const request = command("runAutomationNow", { id: rule.id, expectedRevision: rule.definitionRevision, simulation });
    const result = await authority.executeMutation(request); expect(result.result).toMatchObject({ kind: "committed" });
    expect((await authority.executeMutation(request)).replayed).toBe(true);
    expect(authority.query({ from: "notes" })[0]?.status).toBe("done");
    const history = (await authority.automationPresentation()).runs; expect(history).toHaveLength(1);
    await authority.executeMutation(command("undoAutomationRun", { id: history[0]!.id }));
    expect(authority.query({ from: "notes" })[0]?.status).toBe("todo");
    expect((await authority.automationPresentation()).runs[0]?.undone).toBe(true);
    const original = authority.inspectAuthority().target; authority.close(); (await first.sqlite.installOpfsSAHPoolVfs()).pauseVfs();
    expect(first.db.automationPhysicalTransactionAvailable(capability)).toBe(false);
    const second = await runtime(owned), reopened = await second.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
    try { expect(reopened.inspectAuthority().target).toEqual(original); expect((await reopened.automationPresentation()).availability.available).toBe(true); }
    finally { reopened.close(); (await second.sqlite.installOpfsSAHPoolVfs()).pauseVfs(); }
  } finally { try { authority.close(); } catch { /* already closed before owned reopen */ } }
}, 30_000);

it.each(["write", "flush"])("recovers a legacy catalog interrupted at %s before retention migration without changing its app identity", async cut => {
  const owned = new OwnedSahDirectory(); owned.writeThrough = true;
  const first = await runtime(owned), authority = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  const target = authority.inspectAuthority().target;
  const { productionLifecycleContext } = await import("../src/production-authority"), context = productionLifecycleContext(authority);
  context.writeAuthority.run(() => { context.driver.exec("DROP TABLE catalog.backup_retention_events"); context.driver.exec("DROP TABLE catalog.backup_retention_root"); });
  authority.close(); (await first.sqlite.installOpfsSAHPoolVfs()).pauseVfs();
  const second = await runtime(owned);
  owned.fault = event => event.op === cut && event.path === "/clay-device-catalog-v1.db" && (cut === "flush" || event.at >= 4096);
  await expect(second.Authority.bootBrowser({ requestedAppId: null, appCache: [] })).rejects.toThrow(); expect(owned.dead).toBe(true);
  owned.reopen(); const third = await runtime(owned), recovered = await third.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  try { expect(recovered.inspectAuthority().target).toEqual(target); expect((await recovered.automationPresentation()).availability.available).toBe(true); }
  finally { recovered.close(); (await third.sqlite.installOpfsSAHPoolVfs()).pauseVfs(); }
}, 30_000);

it("bounds the actual automation I/O corpus before growth, rolls back overflow, and does not grant oversized tuples", async () => {
  const owned = new OwnedSahDirectory(), first = await runtime(owned);
  const authority = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    const { productionLifecycleContext } = await import("../src/production-authority"), context = productionLifecycleContext(authority);
    const target = authority.inspectAuthority().target;
    expect((await authority.automationPresentation()).availability.available).toBe(true);
    expect(typeof first.db.withAutomationPhysicalTransaction).toBe("function");
    expect(() => first.db.withAutomationPhysicalTransaction(context.driver, () => context.writeAuthority.run(() => {
      context.driver.exec("CREATE TABLE owned_overflow(value BLOB)");
      context.driver.exec("INSERT INTO owned_overflow VALUES (zeroblob(33000000))");
    }))).toThrow();
    expect(context.driver.select("SELECT name FROM sqlite_master WHERE name='owned_overflow'")).toEqual([]);
    expect(authority.inspectAuthority().target).toEqual(target);
    expect((await authority.automationPresentation()).availability.available).toBe(true);
    // Source data is not truncated to fit a capability. A larger, valid physical
    // corpus is simply ineligible; no write or reset is offered by this check.
    const user = owned.files.find(file => owned.path(file).endsWith("-user.db"))!;
    const before = user.live; const larger = new Uint8Array(32_004_097); larger.set(before); user.live = larger;
    expect((await authority.automationPresentation()).availability.available).toBe(false);
    expect(user.live).toBe(larger); expect(authority.inspectAuthority().target).toEqual(target);
    user.live = before; // Disposable fixture only, not a production recovery.
  } finally { authority.close(); (await first.sqlite.installOpfsSAHPoolVfs()).pauseVfs(); }
}, 30_000);

it.each(["user", "system", "catalog", "journal_delete", "master_delete"])("retries native rollback interruption at %s with the same original catalog target", async cut => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  const owned = new OwnedSahDirectory(); owned.writeThrough = true;
  const first = await runtime(owned), authority = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  const target = authority.inspectAuthority().target;
  owned.fault = event => event.op === "flush" && event.path.endsWith("-user.db");
  await expect(authority.executeMutation({ requestId: authority.createRequestId(), route: "starter.seed", payload: {
    schema: 1, shellId: "tracker", shellName: "Interrupted native", panels: [], tables: [{ name: "notes", columns: [{ name: "title", type: "text", required: true }], sampleRows: [] }],
  } })).rejects.toThrow(); expect(owned.dead).toBe(true);
  owned.reopen(); vi.setSystemTime(new Date("2026-09-13T12:01:01.000Z"));
  owned.fault = event => cut === "journal_delete" || cut === "master_delete"
    ? event.op === "write" && event.at === 0 && !event.path && (cut === "journal_delete" ? event.previousPath.endsWith("-journal") : /-mj/.test(event.previousPath))
    : event.op === "flush" && (cut === "catalog" ? event.path === "/clay-device-catalog-v1.db" : event.path.endsWith(`-${cut}.db`));
  const second = await runtime(owned);
  await expect(second.Authority.bootBrowser({ requestedAppId: null, appCache: [] })).rejects.toThrow(); expect(owned.dead).toBe(true);
  owned.reopen(); vi.setSystemTime(new Date("2026-09-13T12:02:02.000Z"));
  const third = await runtime(owned), recovered = await third.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  try { expect(recovered.inspectAuthority().target.appInstanceId).toBe(target.appInstanceId); expect(recovered.readStore().headVersion()).toBe(0); }
  finally { recovered.close(); (await third.sqlite.installOpfsSAHPoolVfs()).pauseVfs(); }
}, 30_000);

it("rejects a corrupted shadow catalog before any real rollback, retaining every original byte", async () => {
  const owned = new OwnedSahDirectory(); owned.writeThrough = true;
  const first = await runtime(owned), authority = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  owned.fault = event => event.op === "flush" && event.path === "/clay-device-catalog-v1.db";
  await expect(authority.executeMutation({ requestId: authority.createRequestId(), route: "setting.set", payload: { key: "owned_fault", value: true } })).rejects.toThrow();
  owned.reopen();
  // Corrupt BOTH the synthetic current catalog and its rollback header corpus.
  // A journal cannot be used to reconstruct an independently valid owner here.
  const catalog = owned.files.find(file => owned.path(file) === "/clay-device-catalog-v1.db")!;
  catalog.live[4096] = 0; catalog.durable = catalog.live.slice();
  const journal = owned.files.find(file => owned.path(file) === "/clay-device-catalog-v1.db-journal");
  if (journal) { journal.live.fill(0, 4096); journal.durable = journal.live.slice(); }
  const before = owned.files.map(file => file.live.slice()); owned.events.length = 0;
  const second = await runtime(owned);
  await expect(second.Authority.bootBrowser({ requestedAppId: null, appCache: [] })).rejects.toThrow(/owner.*preflight/);
  expect(owned.events).toEqual([]);
  expect(before.every((bytes, index) => Buffer.from(bytes).equals(Buffer.from(owned.files[index]!.live)))).toBe(true);
}, 30_000);

it.each(["create", "fork", "restore"].flatMap(kind => ["user_create", "system_create", "install", "publish"].map(cut => ({ kind, cut }))))(
  "recovers exact $kind work after $cut without replacing the source", async ({ kind, cut }) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    const owned = new OwnedSahDirectory(); owned.writeThrough = true;
    const first = await runtime(owned); let authority = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "setting.set", payload: { key: "owned_source", value: "kept" } });
    const source = authority.inspectAuthority().target, authorityId = authority.inspectAuthority().catalog.authorityIncarnationId;
    const originalNames = new Set(await first.db.browserDurableFileNames()), requestId = authority.createRequestId();
    const catalogModule = await import("../src/device-catalog"), method = kind === "restore" ? "addAppTarget" : "publishDeclaredAppGeneration";
    let publication = false;
    const original = catalogModule.DeviceCatalog.prototype[method];
    vi.spyOn(catalogModule.DeviceCatalog.prototype, method).mockImplementation(function (this: any, ...args: any[]) {
      publication = true; return (original as any).apply(this, args);
    });
    let invoke: () => Promise<unknown>;
    if (kind === "restore") {
      const restore = await import("../src/production-restore");
      const archive = await authority.collectArchiveSnapshot();
      // Trusted-verifier OUTPUT only. No keys enter the physical recovery test.
      const grant = await restore.stageProductionRestore(authority, { payload: archive.bytes, archiveSha256: `sha256:${"a".repeat(64)}`,
        authentication: { schema: 1, kind: "cose_mac0_hmac_256_256", authenticationVersion: 1, keyId: "a".repeat(32), seriesId: "b".repeat(32), generation: "1" }, freshness: "unknown" });
      invoke = () => restore.executeProductionRestore(authority, { grant, requestId });
    } else {
      const request = kind === "create" ? { kind, requestId, displayName: "Owned second", shellId: "blank" } : { kind, requestId };
      invoke = () => authority.executeAppLifecycle(request);
    }
    owned.fault = event => {
      if (cut === "publish") return publication && event.op === "flush" && event.path === "/clay-device-catalog-v1.db";
      if (originalNames.has(event.path)) return false;
      if (cut === "install") return event.op === "flush" && event.path.endsWith("-system.db");
      return event.op === "write" && event.at === 0 && event.path.endsWith(cut === "user_create" ? "-user.db" : "-system.db");
    };
    await expect(invoke()).rejects.toThrow(); expect(owned.dead).toBe(true);
    vi.restoreAllMocks(); owned.reopen(); vi.setSystemTime(new Date("2026-09-13T12:01:01.000Z"));
    const second = await runtime(owned); authority = await second.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
    try {
      if (kind !== "restore") {
        const { deriveLifecycleId } = await import("../src/app-lifecycle-request");
        expect(authority.inspectAuthority().target.appInstanceId).toBe(deriveLifecycleId("app", authorityId, requestId, `${kind}-app`));
        expect(authority.bootInfo().apps).toHaveLength(2);
        // These retained lifecycle jobs resume creation with the ORIGINAL ID;
        // restore jobs instead terminally abort. Neither may replace the source.
        const same = kind === "create" ? { kind, requestId, displayName: "Owned second", shellId: "blank" } : { kind, requestId };
        authority = await authority.executeAppLifecycle(same); expect(authority.bootInfo().apps).toHaveLength(2);
        authority = await authority.executeAppLifecycle({ kind: "switch", requestId: authority.createRequestId(), appInstanceId: source.appInstanceId });
      }
      expect(authority.inspectAuthority().target).toEqual(source);
      expect(authority.readStore().getSetting("owned_source")).toBe("kept");
      if (kind === "restore") {
        expect(authority.bootInfo().apps).toHaveLength(1);
        expect(new Set(await second.db.browserDurableFileNames())).toEqual(originalNames);
      } else {
        const afterNames = await second.db.browserDurableFileNames();
        expect([...originalNames].every(file => afterNames.includes(file))).toBe(true);
      }
    } finally { authority.close(); (await second.sqlite.installOpfsSAHPoolVfs()).pauseVfs(); }
  }, 30_000);

it.each(["user", "system"])("recovers a deletion interrupted at %s disassociation without touching the proven fallback or reusing uncertain payload", async role => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  const owned = new OwnedSahDirectory(); owned.writeThrough = true;
  const first = await runtime(owned); let authority = await first.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  const fallback = authority.inspectAuthority().target;
  authority = await authority.executeAppLifecycle({ kind: "create", requestId: authority.createRequestId(), displayName: "Delete exactly this", shellId: "blank" });
  const source = authority.inspectAuthority().target;
  const request = { kind: "delete", requestId: authority.createRequestId(), appInstanceId: source.appInstanceId };
  owned.fault = event => event.op === "write" && event.at === 0 && !event.path && event.previousPath.endsWith(`-${role}.db`);
  await expect(authority.executeAppLifecycle(request)).rejects.toThrow(); expect(owned.dead).toBe(true);
  owned.reopen(); const remaining = owned.files.filter(file => !owned.path(file) && file.live.length > 4096).map(file => file.live.slice());
  expect(remaining.length).toBeGreaterThan(0); vi.setSystemTime(new Date("2026-09-13T12:01:01.000Z"));
  const second = await runtime(owned); authority = await second.Authority.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    expect(authority.inspectAuthority().target).toEqual(fallback); expect(authority.bootInfo().apps).toHaveLength(1);
    expect((await second.db.browserDurableInventory()).state).toBe("complete");
    expect(second.db.browserStorageQuarantine().slots).toBeGreaterThan(0);
    authority = await authority.executeAppLifecycle(request);
    expect(authority.inspectAuthority().target).toEqual(fallback);
    expect(remaining.every(bytes => owned.files.some(file => Buffer.from(bytes).equals(Buffer.from(file.live))))).toBe(true);
  } finally { authority.close(); (await second.sqlite.installOpfsSAHPoolVfs()).pauseVfs(); }
}, 30_000);
