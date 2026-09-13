import { afterEach, expect, it, vi } from "vitest";
import { initializedSahpool, installedSahpool, OwnedSahDirectory } from "./helpers/owned-sahpool";

afterEach(() => { vi.doUnmock("@sqlite.org/sqlite-wasm"); vi.resetModules(); vi.unstubAllGlobals(); });
async function production(owned: OwnedSahDirectory) {
  const sqlite = await initializedSahpool(owned);
  vi.resetModules(); vi.doMock("@sqlite.org/sqlite-wasm", () => ({ default: async () => sqlite }));
  return { sqlite, runtime: await import("../src/db") };
}
async function saved() {
  const owned = new OwnedSahDirectory(), { pool } = await installedSahpool(owned, ".opfs-sahpool");
  for (const name of ["/user.db", "/system.db", "/clay-device-catalog-v1.db"]) {
    const db = new pool.OpfsSAHPoolDb(name);
    db.exec("CREATE TABLE preserved(value); INSERT INTO preserved VALUES (42)"); db.close();
  }
  pool.pauseVfs(); owned.events.length = 0;
  return owned;
}
const unchanged = (owned: OwnedSahDirectory, before: Uint8Array[]) =>
  before.every((bytes, index) => Buffer.from(bytes).equals(Buffer.from(owned.files[index]!.live)));

it.each(["digest", "flags", "short_header", "unassociated_payload", "duplicate_name"])(
  "production initialization preserves every owned file and fails closed on %s before SDK disassociation", async fault => {
    const owned = await saved();
    const original = owned.files.find(file => owned.path(file) === "/user.db")!;
    if (fault === "digest") original.live[516] = original.live[516]! ^ 1;
    if (fault === "flags") new DataView(original.live.buffer).setUint32(512, 8); // DELETEONCLOSE is not durable ownership.
    if (fault === "short_header") original.live = original.live.slice(0, 519);
    if (fault === "unassociated_payload") original.live.fill(0, 0, 524);
    if (fault === "duplicate_name") {
      const duplicate = owned.files.find(file => owned.path(file) === "/system.db")!;
      duplicate.live.set(original.live.subarray(0, 524));
    }
    const before = owned.files.map(file => file.live.slice());
    const { runtime } = await production(owned);
    await expect(runtime.browserDurableFileNames()).rejects.toThrow(/preserv|association|initialization/);
    expect(unchanged(owned, before)).toBe(true);
    expect(owned.events).toEqual([]);
  });

it("does not let SDK failed-acquisition cleanup delete the existing pool", async () => {
  const owned = await saved(), directory = await owned.root.getDirectoryHandle(".opfs-sahpool");
  const opaque = await directory.getDirectoryHandle(".opaque"), before = owned.files.map(file => file.live.slice());
  owned.files.find(file => owned.path(file) === "/system.db")!.locked = true; // An older worker still owns this handle.
  const { runtime } = await production(owned);
  await expect(runtime.browserDurableFileNames()).rejects.toThrow();
  expect((await directory.getDirectoryHandle(".opaque")) === opaque).toBe(true);
  expect(unchanged(owned, before)).toBe(true);
  expect(owned.events).toEqual([]);
});

it("refuses an already installed VFS instead of inferring unopened ownership from a new adapter", async () => {
  const owned = new OwnedSahDirectory(), { sqlite, pool } = await installedSahpool(owned, ".opfs-sahpool");
  const db = new pool.OpfsSAHPoolDb("/user.db"); db.exec("CREATE TABLE preserved(value)");
  vi.resetModules(); vi.doMock("@sqlite.org/sqlite-wasm", () => ({ default: async () => sqlite }));
  try { await expect((await import("../src/db")).browserDurableFileNames()).rejects.toThrow(/pre-existing|unopened/); }
  finally { db.close(); pool.pauseVfs(); }
});

it("hands off the same exclusive handles without writes or an unlocked preflight/reacquire interval", async () => {
  const owned = await saved(), before = owned.files.map(file => file.live.slice());
  owned.handles.length = 0;
  const { runtime, sqlite } = await production(owned);
  expect(await runtime.browserDurableFileNames()).toEqual(["/clay-device-catalog-v1.db", "/system.db", "/user.db"]);
  expect(unchanged(owned, before)).toBe(true); expect(owned.events).toEqual([]);
  expect(owned.files.filter(file => file.locked)).toHaveLength(before.filter(bytes => bytes.length >= 4096).length);
  for (const [index, bytes] of before.entries()) if (bytes.length >= 4096)
    expect(owned.handles.filter(event => event.file === index)).toEqual([{ kind: "acquire", file: index, epoch: owned.epoch }]);
  (await sqlite.installOpfsSAHPoolVfs()).pauseVfs();
});

it("denies SDK recursive failure cleanup after handoff read failure and keeps every pre-existing handle's bytes", async () => {
  const owned = await saved(), before = owned.files.map(file => file.live.slice());
  const directory = await owned.root.getDirectoryHandle(".opfs-sahpool"), opaque = await directory.getDirectoryHandle(".opaque");
  // The preflight reads 524 bytes. The pinned SDK subsequently reads the same
  // held association corpus in a 516-byte request; fail precisely at handoff.
  owned.readFault = event => event.path === "/system.db" && event.at === 0 && event.size === 516;
  const { runtime } = await production(owned);
  await expect(runtime.browserDurableFileNames()).rejects.toThrow(/preservation/);
  expect((await directory.getDirectoryHandle(".opaque")) === opaque).toBe(true);
  expect(unchanged(owned, before)).toBe(true); expect(owned.events).toEqual([]);
  expect(owned.files.some(file => file.locked)).toBe(false);
});

it.each(["catalog_probe", "target_open", "authority_boot"])("blocks %s before reading an unproven hot catalog or changing preserved pages", async action => {
  const owned = await saved(); owned.writeThrough = true;
  const previous = await installedSahpool(owned, ".opfs-sahpool"), db = new previous.pool.OpfsSAHPoolDb("/user.db");
  db.exec("ATTACH 'file:/system.db?vfs=opfs-sahpool' AS sys; ATTACH 'file:/clay-device-catalog-v1.db?vfs=opfs-sahpool' AS catalog");
  owned.fault = event => event.op === "flush" && event.path === "/clay-device-catalog-v1.db";
  expect(() => db.exec("BEGIN; UPDATE preserved SET value=43; UPDATE sys.preserved SET value=43; UPDATE catalog.preserved SET value=43; COMMIT")).toThrow();
  expect(owned.dead).toBe(true); owned.reopen();
  const before = owned.files.map(file => file.live.slice()); owned.events.length = 0; owned.reads.length = 0;
  const { runtime } = await production(owned);
  const invoke = async () => {
    if (action === "authority_boot") return (await import("../src/production-authority")).ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
    const handle = action === "catalog_probe" ? await runtime.openBrowserCatalogProbe() : await runtime.openBrowserProductionTarget({
      storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" });
    handle.close();
  };
  await expect(invoke()).rejects.toThrow(/journal.*owner|owner.*journal/);
  expect(owned.reads.filter(read => read.at >= 4096)).toEqual([]);
  expect(owned.events).toEqual([]); expect(unchanged(owned, before)).toBe(true);
});

it("boots and reopens actual production authority through preserving initialization without granting automation", async () => {
  const owned = new OwnedSahDirectory(); const first = await production(owned);
  const { ProductionStoreAuthority } = await import("../src/production-authority");
  const authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  const original = authority.inspectAuthority().target;
  await authority.executeMutation({ requestId: authority.createRequestId(), route: "setting.set", payload: { key: "owned_restart", value: "preserved" } });
  expect((await authority.automationPresentation()).availability.available).toBe(false);
  authority.close(); (await first.sqlite.installOpfsSAHPoolVfs()).pauseVfs();
  await production(owned); const Reopened = (await import("../src/production-authority")).ProductionStoreAuthority;
  const reopened = await Reopened.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    expect(reopened.inspectAuthority().target.appInstanceId).toBe(original.appInstanceId);
    expect(reopened.readStore().getSetting("owned_restart")).toBe("preserved");
    expect((await reopened.automationPresentation()).availability.available).toBe(false);
  } finally { reopened.close(); }
});

it.each(["user", "system", "catalog"])("preserves the real authority's interrupted %s commit on worker loss without advertising recovery", async role => {
  const owned = new OwnedSahDirectory(); owned.writeThrough = true; await production(owned);
  const { ProductionStoreAuthority } = await import("../src/production-authority");
  const authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  const request = { requestId: authority.createRequestId(), route: "starter.seed", payload: {
    schema: 1, shellId: "tracker", shellName: "Owned tracker", panels: [],
    tables: [{ name: "owned_notes", columns: [{ name: "title", type: "text", required: true }], sampleRows: [{ title: "Preserved fixture" }] }],
  } };
  owned.fault = event => event.op === "flush" && (role === "catalog" ? event.path === "/clay-device-catalog-v1.db"
    : event.path === `/${role}.db` || event.path.endsWith(`-${role}.db`));
  await expect(authority.executeMutation(request)).rejects.toThrow(); expect(owned.dead).toBe(true);
  owned.reopen(); const before = owned.files.map(file => file.live.slice()); owned.events.length = 0; owned.reads.length = 0;
  await production(owned); const Reopened = (await import("../src/production-authority")).ProductionStoreAuthority;
  await expect(Reopened.bootBrowser({ requestedAppId: null, appCache: [] })).rejects.toThrow(/journal.*owner|preservation/);
  expect(owned.reads.filter(read => read.at >= 4096)).toEqual([]);
  expect(owned.events).toEqual([]); expect(unchanged(owned, before)).toBe(true);
}, 30_000);
