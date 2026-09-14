import { classifyDurableFileInventory } from "./durable-inventory";

const installed = new WeakSet<object>();

/** Low-level recovery adapter, NOT a production authority/capability grant.
 * The boot coordinator must still prove catalog ownership, physical exclusion,
 * exact journal membership, and canonical/catalog readback before using it.
 * No application route currently installs this adapter. */
export function installSahpoolJournalRecovery(sqlite: any, pool: { getFileNames(): string[] }) {
  if (installed.has(sqlite)) throw new Error("Original SAHPool recovery adapter is already installed");
  const capi = sqlite.capi, wasm = sqlite.wasm;
  if (capi.sqlite3_libversion() !== "3.53.0") throw new Error("Unreviewed SAHPool runtime");
  const pointer = capi.sqlite3_vfs_find("opfs-sahpool");
  if (!pointer) throw new Error("Original SAHPool VFS is unavailable");
  const vfs = new capi.sqlite3_vfs(pointer), originalOpen = vfs.$xOpen, originalAccess = vfs.$xAccess, originalDelete = vfs.$xDelete;
  const callOpen = wasm.functionEntry(originalOpen);
  const handles = new Map<number, string>(), copies = new Map<number, any>();
  let allowed: ReadonlySet<string> | null = null, disposed = false, poisoned = false, everOpened = false;
  let masters = new Map<string, Uint8Array>();
  let unownedPath = false;
  const child = (path: string) => !!allowed && [...allowed].some(file => path === `${file}-journal`);
  const ownedMasterName = (path: string) => !!allowed && [...allowed].some(file => path.startsWith(`${file}-mj`) && /^[0-9a-f]{9}$/i.test(path.slice(file.length + 3)));
  function admits(path: string): boolean { return !!allowed && (allowed.has(path) || child(path) || masters.has(path)); }
  function rejectPath(): number { unownedPath = true; return capi.SQLITE_IOERR; }
  function readMaster(path: string): Uint8Array {
    const scope = wasm.scopedAllocPush(), file = new capi.sqlite3_file(); let opened = false;
    try {
      const name = wasm.scopedAllocCString(path), flags = wasm.scopedAlloc(4);
      if (callOpen(pointer, name, file.pointer, capi.SQLITE_OPEN_READONLY | capi.SQLITE_OPEN_SUPER_JOURNAL, flags) !== 0) throw new Error();
      opened = true; const io = new capi.sqlite3_io_methods(file.$pMethods), sizePtr = wasm.scopedAlloc(8);
      if (wasm.functionEntry(io.$xFileSize)(file.pointer, sizePtr) !== 0) throw new Error();
      const size = Number(wasm.peek64(sizePtr));
      if (!Number.isSafeInteger(size) || size < 0 || size > 1024) throw new Error();
      const dest = wasm.scopedAlloc(Math.max(size, 1));
      if (size && wasm.functionEntry(io.$xRead)(file.pointer, dest, size, 0n) !== 0) throw new Error();
      return wasm.heap8u().slice(dest, dest + size);
    } catch { throw new Error("Owned super-journal membership is invalid or unavailable"); }
    finally {
      try { if (opened) {
        const io = new capi.sqlite3_io_methods(file.$pMethods);
        if (wasm.functionEntry(io.$xClose)(file.pointer) !== 0) throw new Error("Super-journal read close failed");
      } } finally { file.dispose(); wasm.scopedAllocPop(scope); }
    }
  }
  function methods(pointer: number) {
    let copy = copies.get(pointer); if (copy) return copy;
    const original = new capi.sqlite3_io_methods(pointer);
    copy = new capi.sqlite3_io_methods();
    wasm.heap8u().copyWithin(copy.pointer, pointer, pointer + capi.sqlite3_io_methods.structInfo.sizeof);
    const close = wasm.functionEntry(original.$xClose), reserved = wasm.functionEntry(original.$xCheckReservedLock);
    sqlite.vfs.installVfs({ io: { struct: copy, methods: {
      xCheckReservedLock(pFile: number, pOut: number) {
        const path = handles.get(pFile);
        // All pool handles are already exclusively owned. The upstream constant
        // 1 suppresses SQLite's hot-journal rollback even after process loss.
        // Only the explicit, unopened recovery tuple may report no other writer.
        if (allowed && path && allowed.has(path)) { wasm.poke32(pOut, 0); return 0; }
        return reserved(pFile, pOut);
      },
      xClose(pFile: number) { const rc = close(pFile); handles.delete(pFile); return rc; },
    } } });
    copies.set(pointer, copy); return copy;
  }
  const open = wasm.installFunction((pVfs: number, zName: number, pFile: number, flags: number, pOut: number) => {
    try {
      const main = !!(flags & capi.SQLITE_OPEN_MAIN_DB), path = zName ? wasm.cstrToJs(zName) : "";
      if (allowed && (!admits(path) || (main && (!allowed.has(path) || [...handles.values()].includes(path))))) return rejectPath();
      const rc = callOpen(pVfs, zName, pFile, flags, pOut);
      if (rc === 0 && main) {
        everOpened = true;
        const file = new capi.sqlite3_file(pFile); file.$pMethods = methods(file.$pMethods).pointer; handles.set(pFile, path);
      }
      return rc;
    } catch { return capi.SQLITE_IOERR; }
  }, "i(pppip)");
  const access = wasm.installFunction((pVfs: number, zName: number, flags: number, pOut: number) => {
    try {
      const path = zName ? wasm.cstrToJs(zName) : "";
      if (allowed && !admits(path)) {
        // DELETE-mode SQLite probes an absent WAL on open. Absence is established
        // from the exact owned inventory; an actual WAL is never treated as absent.
        if (([...allowed].some(file => path === `${file}-wal`) || ownedMasterName(path)) && !pool.getFileNames().includes(path)) { wasm.poke32(pOut, 0); return 0; }
        return rejectPath();
      }
      return wasm.functionEntry(originalAccess)(pVfs, zName, flags, pOut);
    } catch { return rejectPath(); }
  }, "i(ppip)");
  const remove = wasm.installFunction((pVfs: number, zName: number, syncDir: number) => {
    try {
      const path = zName ? wasm.cstrToJs(zName) : "";
      // Recovery may reconcile an exact child journal or a validated master,
      // never delete a main database, arbitrary sidecar or another namespace.
      if (allowed && !child(path) && !masters.has(path)) return rejectPath();
      return wasm.functionEntry(originalDelete)(pVfs, zName, syncDir);
    } catch { return rejectPath(); }
  }, "i(ppi)");
  vfs.$xOpen = open;
  vfs.$xAccess = access; vfs.$xDelete = remove;
  installed.add(sqlite);
  return Object.freeze({
    assertOriginallyUnopened(): void {
      if (everOpened || disposed || poisoned || allowed || handles.size) throw new Error("Native recovery requires original unopened handle provenance");
    },
    finish(db: any): void {
      if (!allowed || !sqlite.capi.sqlite3_get_autocommit(db.pointer)) throw new Error("Native recovery requires an idle owned tuple");
      const databases = db.selectObjects("PRAGMA database_list") as Array<{ name: string; file: string }>;
      const durable = databases.filter(row => row.name !== "temp" && row.file !== "");
      if (durable.length !== allowed.size || durable.some(row => !allowed!.has(row.file) || !["main", "sys", "catalog"].includes(row.name)))
        throw new Error("Native recovery tuple changed");
      // SQLite leaves unused zero-header journals after recovering another
      // participant. Let SQLite itself reconcile those exact database journals;
      // never unlink by suffix, parse user pages, or touch an unrelated namespace.
      for (const row of durable) {
        if (db.selectValue(`PRAGMA ${row.name}.journal_mode=PERSIST`) !== "persist"
            || db.selectValue(`PRAGMA ${row.name}.journal_mode=DELETE`) !== "delete")
          throw new Error("Native journal cleanup did not finish");
      }
      const remaining = pool.getFileNames();
      if ([...allowed].some(path => remaining.includes(`${path}-journal`))) throw new Error("Native journals remain unresolved");
      for (const [path, original] of masters) {
        if (!remaining.includes(path)) continue;
        const current = readMaster(path);
        if (current.length !== original.length || current.some((value, index) => value !== original[index])) throw new Error("Super-journal changed during recovery");
        const scope = wasm.scopedAllocPush();
        try {
          if (wasm.functionEntry(vfs.$xDelete)(pointer, wasm.scopedAllocCString(path), 1) !== 0) throw new Error("Super-journal cleanup requires reopen");
        } finally { wasm.scopedAllocPop(scope); }
        if (pool.getFileNames().includes(path)) throw new Error("Super-journal cleanup readback failed");
      }
    },
    run<T>(files: readonly string[], operation: () => T): T {
      if (disposed || poisoned || allowed || handles.size) throw new Error("Recovery requires an unopened exclusive SAHPool tuple");
      const fixed = [...files], inventory = classifyDurableFileInventory(fixed), names = pool.getFileNames();
      if (inventory.state !== "complete" || !inventory.catalogPresent || inventory.namespaces.length > 1
          || fixed.some(name => !names.includes(name))) throw new Error("Recovery requires exact existing catalog/namespace files");
      allowed = new Set(fixed);
      try {
        masters = new Map(); unownedPath = false;
        for (const path of names) {
          if (!ownedMasterName(path)) continue;
          const bytes = readMaster(path);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const members = text === "" ? [] : text.endsWith("\0") ? text.slice(0, -1).split("\0") : [""];
          if (new Set(members).size !== members.length || members.some(member => !fixed.some(file => member === `${file}-journal`)))
            throw new Error("Super-journal names an unowned participant");
          masters.set(path, bytes);
        }
        const result = operation();
        if (unownedPath) throw new Error("Native recovery attempted an unowned file path; reopen required");
        if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Recovery must be synchronous");
        return result;
      } catch (error) { poisoned = true; throw error; }
      finally { allowed = null; masters = new Map(); }
    },
    dispose(): void {
      if (handles.size || allowed) throw new Error("Close recovery handles before disposing their adapter");
      if (disposed) return;
      vfs.$xOpen = originalOpen; vfs.$xAccess = originalAccess; vfs.$xDelete = originalDelete;
      wasm.uninstallFunction(open); wasm.uninstallFunction(access); wasm.uninstallFunction(remove);
      for (const copy of copies.values()) copy.dispose(); copies.clear(); disposed = true;
      installed.delete(sqlite);
    },
  });
}
