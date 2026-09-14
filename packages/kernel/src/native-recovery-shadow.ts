import { NATIVE_SHADOW_BYTES } from "./native-recovery-bounds";

/** Private, bounded in-memory filesystem for SQLite's own rollback preflight.
 * It never opens OPFS, fetches, exposes pages, or changes the original files.
 * Logical paths stay exact so native super-journal references retain meaning.
 * This disposable VFS is not, and cannot grant, durable ownership. */
export function nativeRecoveryShadow(sqlite: any, input: ReadonlyMap<string, Uint8Array>) {
  const capi = sqlite.capi, wasm = sqlite.wasm, limit = NATIVE_SHADOW_BYTES;
  const files = new Map([...input].map(([path, bytes]) => [path, bytes.slice()]));
  let bytesUsed = [...files.values()].reduce((n, bytes) => n + bytes.length, 0), failed = false;
  if (files.size > 4096 || bytesUsed > limit) throw new Error("Native shadow exceeds its bounded preflight capacity");
  const name = `clay-preflight-${crypto.randomUUID()}`, handles = new Map<number, string>();
  const io = new capi.sqlite3_io_methods(), vfs = new capi.sqlite3_vfs();
  const original = new capi.sqlite3_vfs(capi.sqlite3_vfs_find(null));
  wasm.heap8u().copyWithin(vfs.pointer, original.pointer, original.pointer + capi.sqlite3_vfs.structInfo.sizeof);
  const encodedName = wasm.allocCString(name); vfs.$zName = encodedName; vfs.$pNext = 0;
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof; vfs.$mxPathname = 512; io.$iVersion = 1;
  const denied = () => { failed = true; return capi.SQLITE_IOERR; };
  const path = (value: number) => value ? wasm.cstrToJs(value) : "";
  const offset = (value: bigint | number) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0 || n > limit) throw new Error(); return n; };
  const resize = (file: string, size: number) => {
    const previous = files.get(file); if (!previous || bytesUsed + size - previous.length > limit) throw new Error();
    const next = new Uint8Array(size); next.set(previous.subarray(0, size)); bytesUsed += size - previous.length; files.set(file, next); return next;
  };
  const fileAt = (handle: number) => { const file = handles.get(handle); if (!file || !files.has(file)) throw new Error(); return file; };
  const safe = (work: () => number) => { try { return work(); } catch { return denied(); } };
  sqlite.vfs.installVfs({ io: { struct: io, methods: {
    xClose: (handle: number) => { handles.delete(handle); return 0; },
    xRead: (handle: number, out: number, size: number, at: bigint) => safe(() => {
      const bytes = files.get(fileAt(handle))!, start = offset(at), data = bytes.subarray(start, start + size);
      wasm.heap8u().fill(0, out, out + size); wasm.heap8u().set(data, out);
      return data.length === size ? 0 : capi.SQLITE_IOERR_SHORT_READ;
    }),
    xWrite: (handle: number, from: number, size: number, at: bigint) => safe(() => {
      const file = fileAt(handle), start = offset(at), end = offset(start + size);
      const bytes = files.get(file)!; (end > bytes.length ? resize(file, end) : bytes).set(wasm.heap8u().subarray(from, from + size), start); return 0;
    }),
    xTruncate: (handle: number, size: bigint) => safe(() => { resize(fileAt(handle), offset(size)); return 0; }),
    xFileSize: (handle: number, out: number) => safe(() => { wasm.poke64(out, BigInt(files.get(fileAt(handle))!.length)); return 0; }),
    xSync: () => 0, xLock: () => 0, xUnlock: () => 0,
    xCheckReservedLock: (_handle: number, out: number) => { wasm.poke32(out, 0); return 0; },
    xFileControl: () => capi.SQLITE_NOTFOUND, xSectorSize: () => 4096, xDeviceCharacteristics: () => 0,
  } }, vfs: { struct: vfs, methods: {
    xOpen: (_vfs: number, namePtr: number, handle: number, flags: number, out: number) => safe(() => {
      const file = path(namePtr);
      if (!files.has(file)) {
        // Read/rollback preflight must never create a missing main database or
        // spill to a host temporary filesystem. Only private owned sidecars.
        if (!(flags & capi.SQLITE_OPEN_CREATE) || (flags & capi.SQLITE_OPEN_MAIN_DB)
            || ![...files.keys()].some(main => main.endsWith(".db") && (file === `${main}-journal` || file.startsWith(`${main}-mj`)))) return denied();
        files.set(file, new Uint8Array());
      }
      new capi.sqlite3_file(handle).$pMethods = io.pointer; handles.set(handle, file); if (out) wasm.poke32(out, flags); return 0;
    }),
    xAccess: (_vfs: number, file: number, _flags: number, out: number) => { wasm.poke32(out, files.has(path(file)) ? 1 : 0); return 0; },
    xDelete: (_vfs: number, filePtr: number) => safe(() => {
      const file = path(filePtr); if (file.endsWith(".db")) return denied();
      const bytes = files.get(file); if (bytes) { bytesUsed -= bytes.length; files.delete(file); } return 0;
    }),
    xFullPathname: (_vfs: number, file: number, size: number, out: number) => safe(() => {
      const value = path(file), bytes = new TextEncoder().encode(value);
      if (!value.startsWith("/") || bytes.length >= size || value.includes("\\") || value.includes("/../")) return denied();
      wasm.heap8u().set(bytes, out); wasm.heap8u()[out + bytes.length] = 0; return 0;
    }),
  } } });
  return {
    open(file: string): any { if (failed || !files.has(file)) throw new Error("Native shadow source is unavailable"); return new sqlite.oo1.DB(file, "w", name); },
    attach(db: any, file: string, schema: "sys" | "catalog") {
      if (!files.has(file) || !/^\/[a-zA-Z0-9_.-]+$/.test(file)) throw new Error("Native shadow source is unavailable");
      db.exec(`ATTACH 'file:${file}?vfs=${name}' AS ${schema}`);
    },
    assertValid() { if (failed) throw new Error("Native shadow attempted an unsupported file operation"); },
    dispose() {
      if (handles.size) throw new Error("Native shadow handles remain open");
      capi.sqlite3_vfs_unregister(vfs); io.dispose(); vfs.dispose(); wasm.dealloc(encodedName);
      for (const bytes of files.values()) bytes.fill(0); files.clear();
    },
  };
}
