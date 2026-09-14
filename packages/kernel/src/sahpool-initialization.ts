import { ClayError } from "./errors";
import { NATIVE_AUTOMATION_IO_BYTES, NATIVE_SHADOW_BYTES } from "./native-recovery-bounds";

// These offsets/algorithms are pinned to sqlite-wasm 3.53.0-build1. This is
// association preservation and exclusive-handle provenance, NOT catalog owner
// proof or permission to roll back a database. No user pages are read here.
const DIRECTORY = ".opfs-sahpool", OPAQUE = ".opaque", HEADER = 524, SECTOR = 4096, MAX_FILES = 4096;
const installing = new WeakSet<object>();
const proof = new WeakMap<object, { sqlite: object; assertHeld(): void; held: Map<string, Held>; bounded: { active: boolean } }>();
const denied = () => new ClayError("E_CATALOG_UNAVAILABLE", "SAHPool initialization cannot prove preservation; original files were kept");
type Sah = { read(out: Uint8Array, options: { at: number }): number; write(input: ArrayBufferView, options: { at: number }): number;
  getSize(): number; truncate(size: number): void; flush(): void; close(): void };
type File = { kind: string; createSyncAccessHandle(): Promise<Sah>; isSameEntry?(other: File): Promise<boolean> };
type Directory = { kind: string; name?: string; getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<File>; removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<[string, File | Directory]> };
type Held = { file: File; sah: Sah; path: string; existing: boolean; handed: boolean; closed: boolean; opaqueName: string; quarantined?: boolean };
class AssociationUnproven extends Error {}

function assertBoundedCorpus(held: Map<string, Held>, changed?: Held, size?: number): void {
  let total = 0;
  for (const row of held.values()) {
    if (row.quarantined) continue; // Not reused, read by native rollback, or included in this grant.
    const bytes = row === changed ? size! : row.sah.getSize();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw denied();
    total += Math.max(0, bytes - SECTOR);
    if (total > NATIVE_AUTOMATION_IO_BYTES)
      throw new ClayError("E_CATALOG_UNAVAILABLE", "Automation exceeds the bounded native recovery I/O capacity; original data was kept");
  }
}

function association(sah: Sah, capi: any): string {
  const size = sah.getSize(), bytes = new Uint8Array(HEADER);
  if (!Number.isSafeInteger(size) || size < HEADER || sah.read(bytes, { at: 0 }) !== HEADER) throw new AssociationUnproven();
  const view = new DataView(bytes.buffer), flags = view.getUint32(512), end = bytes.subarray(0, 512).indexOf(0);
  if (end < 0 || end >= 511) throw new AssociationUnproven();
  let path: string;
  try { path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch { throw new AssociationUnproven(); }
  if (path && (!path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)
      || new URL(path, "file://localhost/").pathname !== path || flags & capi.SQLITE_OPEN_DELETEONCLOSE
      || !(flags & (capi.SQLITE_OPEN_MAIN_DB | capi.SQLITE_OPEN_MAIN_JOURNAL | capi.SQLITE_OPEN_SUPER_JOURNAL | capi.SQLITE_OPEN_WAL)))) throw new AssociationUnproven();
  if (!path && flags !== 0) throw new AssociationUnproven();
  let h1 = 0, h2 = 0;
  if (flags & capi.SQLITE_OPEN_MEMORY) {
    h1 = 3735928559; h2 = 1103547991;
    for (const byte of bytes.subarray(0, 516)) { h1 = Math.imul(h1 ^ byte, 2654435761); h2 = Math.imul(h2 ^ byte, 104729); }
  }
  // The installed WASM/typed-array metadata encoding is little-endian, including
  // legacy V1 zero digests. Neither digest version establishes catalog ownership.
  if (view.getUint32(516, true) !== h1 >>> 0 || view.getUint32(520, true) !== h2 >>> 0) throw new AssociationUnproven();
  return path;
}

async function child(directory: Directory, name: string): Promise<Directory | null> {
  try { return await directory.getDirectoryHandle(name); }
  catch (error) { if ((error as { name?: string })?.name === "NotFoundError") return null; throw denied(); }
}
async function entries(directory: Directory): Promise<Map<string, File>> {
  const result = new Map<string, File>();
  for await (const [name, file] of directory) {
    if (result.size >= MAX_FILES || result.has(name) || file.kind !== "file") throw denied();
    result.set(name, file as File);
  }
  return result;
}
async function sameEntries(directory: Directory, held: Map<string, Held>): Promise<void> {
  const current = await entries(directory);
  if (current.size !== held.size) throw denied();
  for (const [name, row] of held) {
    const file = current.get(name);
    if (!file || (file !== row.file && (!file.isSameEntry || !await file.isSameEntry(row.file)))) throw denied();
  }
}

/** Initialize the pinned VFS with the very handles which were inspected. No
 * unlock/reacquire gap, SDK repair of malformed headers, or SDK recursive cleanup
 * is allowed. The scoped storage facade is installed only in the DB worker's
 * serialized initialization; it is restored before any SQL is opened. */
export async function initializePreservingSahpool(sqlite: any, initialCapacity: number): Promise<any> {
  if (sqlite.capi.sqlite3_libversion() !== "3.53.0") throw denied();
  if (sqlite.capi.sqlite3_vfs_find("opfs-sahpool"))
    throw new ClayError("E_CATALOG_UNAVAILABLE", "SAHPool pre-existing handles have no unopened initialization proof");
  const storage = (globalThis as any).navigator?.storage;
  if (!storage || installing.has(storage) || typeof storage.getDirectory !== "function") throw denied();
  installing.add(storage);
  const originalDescriptor = Object.getOwnPropertyDescriptor(storage, "getDirectory"), getDirectory = storage.getDirectory;
  const held = new Map<string, Held>(), bounded = { active: false }; let ready = false, facadeInstalled = false, pool: any;
  let getFacade: (() => Promise<Directory>) | undefined;
  const close = (row: Held) => { if (!row.closed) { row.closed = true; row.sah.close(); } };
  try {
    const root: Directory = await getDirectory.call(storage);
    let directory = await child(root, DIRECTORY), opaque = directory && await child(directory, OPAQUE);
    if (opaque) {
      const names = await entries(opaque), paths = new Set<string>();
      for (const [name, file] of names) {
        const sah = await file.createSyncAccessHandle();
        const row: Held = { sah, file, path: "", existing: true, handed: false, closed: false, opaqueName: name };
        held.set(name, row);
        try { row.path = association(sah, sqlite.capi); }
        catch (error) {
          if (!(error instanceof AssociationUnproven)) throw error; // Handle/read I/O failure cannot be skipped.
          row.quarantined = true;
        }
        // The SDK flushes association removal BEFORE truncating the old payload.
        // A valid empty header with remaining bytes is not a reusable empty slot.
        // Keep its original SAH and bytes, but never enumerate it to the SDK.
        row.quarantined ||= row.path === "" && sah.getSize() > SECTOR;
        if (row.path && paths.has(row.path)) throw denied(); if (row.path) paths.add(row.path);
      }
      await sameEntries(opaque, held);
    }
    const wrapFile = (row: Held): File => ({ kind: "file", async createSyncAccessHandle() {
      if (row.handed || row.closed) throw denied(); row.handed = true;
      return {
        // A fully validated association may have flushed before expansion of its
        // reserved header sector. Its SQLite payload is exactly empty, not a
        // negative file size. Do not write/repair that sector during SDK startup.
        getSize: () => { if (row.closed) throw denied(); return Math.max(SECTOR, row.sah.getSize()); },
        read: (out, options) => { if (row.closed) throw denied(); return row.sah.read(out, options); },
        write: (input, options) => {
          if (row.closed || (!ready && row.existing)) throw denied();
          if (bounded.active) assertBoundedCorpus(held, row, Math.max(row.sah.getSize(), options.at + input.byteLength));
          return row.sah.write(input, options);
        },
        flush: () => { if (row.closed || (!ready && row.existing)) throw denied(); return row.sah.flush(); },
        truncate: size => {
          if (row.closed) throw denied();
          if (!ready && row.existing) {
            if (row.path || size !== SECTOR || row.sah.getSize() > SECTOR) throw denied();
            return; // Upstream's idempotent truncate of a proven empty slot: no I/O.
          }
          if (bounded.active) assertBoundedCorpus(held, row, size);
          row.sah.truncate(size);
        },
        close: () => close(row),
      };
    } });
    const opaqueFacade: Directory = {
      kind: "directory", name: OPAQUE,
      getDirectoryHandle: async () => { throw denied(); },
      getFileHandle: async (name, options) => {
        // addCapacity may create only a genuinely new slot. A name collision must
        // not disassociate a pre-existing database. Existing slots enter via the
        // frozen, physically revalidated enumeration below.
        if (!opaque || !options?.create || held.has(name) || held.size >= MAX_FILES || !/^[a-z0-9]{1,80}$/.test(name)) throw denied();
        try { await opaque.getFileHandle(name); throw denied(); }
        catch (error) { if ((error as { name?: string })?.name !== "NotFoundError") throw denied(); }
        const file = await opaque.getFileHandle(name, { create: true });
        const row: Held = { file, sah: await file.createSyncAccessHandle(), path: "", existing: false, handed: false, closed: false, opaqueName: name };
        held.set(name, row); return wrapFile(row);
      },
      removeEntry: async () => { throw denied(); },
      async *[Symbol.asyncIterator]() { for (const [name, row] of held) if (!row.quarantined) yield [name, wrapFile(row)] as [string, File]; },
    };
    const directoryFacade: Directory = {
      kind: "directory", name: DIRECTORY,
      getDirectoryHandle: async (name, options) => {
        if (name !== OPAQUE || !directory) throw denied();
        if (!opaque) opaque = await directory.getDirectoryHandle(OPAQUE, options);
        return opaqueFacade;
      },
      getFileHandle: async () => { throw denied(); }, removeEntry: async () => { throw denied(); },
      async *[Symbol.asyncIterator]() { throw denied(); },
    };
    const probes = new Set<string>();
    const rootFacade: Directory = {
      kind: "directory",
      getDirectoryHandle: async (name, options) => {
        if (name !== DIRECTORY) throw denied();
        if (!directory) directory = await root.getDirectoryHandle(DIRECTORY, options);
        return directoryFacade;
      },
      getFileHandle: async (name, options) => {
        if (!/^\.opfs-sahpool-sync-check-[a-z0-9]{1,80}$/.test(name) || !options?.create || probes.size) throw denied();
        try { await root.getFileHandle(name); throw denied(); }
        catch (error) { if ((error as { name?: string })?.name !== "NotFoundError") throw denied(); }
        probes.add(name); return root.getFileHandle(name, options);
      },
      removeEntry: async (name, options) => {
        if (!probes.has(name) || options?.recursive) throw denied();
        await root.removeEntry(name); probes.delete(name);
      },
      async *[Symbol.asyncIterator]() { throw denied(); },
    };
    getFacade = async () => rootFacade;
    Object.defineProperty(storage, "getDirectory", { configurable: true, writable: true, value: getFacade }); facadeInstalled = true;
    pool = await sqlite.installOpfsSAHPoolVfs({ name: "opfs-sahpool", directory: DIRECTORY, initialCapacity, verbosity: 0 });
    if (!opaque) throw denied(); await sameEntries(opaque, held);
    if ([...held.values()].some(row => (!row.handed && !row.quarantined) || row.closed)) throw denied();
    const expected = [...held.values()].filter(row => row.path).map(row => row.path).sort();
    if (JSON.stringify(pool.getFileNames().sort()) !== JSON.stringify(expected)) throw denied();
    ready = true;
    proof.set(pool, { sqlite, held, bounded, assertHeld() {
      if ([...held.values()].some(row => row.closed || (!row.handed && !row.quarantined))) throw denied();
    } });
    return pool;
  } catch (error) {
    try { pool?.pauseVfs(); } catch { /* Remains poisoned; no SQL may open. */ }
    for (const row of held.values()) { try { close(row); } catch { /* Keep all bytes and require reopen. */ } }
    if (error instanceof ClayError) throw error;
    throw denied(); // Never surface SDK header bytes, paths, or native diagnostics.
  } finally {
    try {
      if (facadeInstalled) {
        if (storage.getDirectory !== getFacade) throw denied();
        if (originalDescriptor) Object.defineProperty(storage, "getDirectory", originalDescriptor);
        else delete storage.getDirectory;
      }
    } finally { installing.delete(storage); }
  }
}

export function assertPreservedSahpoolHandles(sqlite: object, pool: object): void {
  const current = proof.get(pool);
  if (!current || current.sqlite !== sqlite) throw denied(); current.assertHeld();
}

/** Counts only; no opaque names, suspected logical names or private bytes. */
export function preservedSahpoolQuarantine(pool: object): { slots: number } {
  const current = proof.get(pool); if (!current) throw denied(); current.assertHeld();
  return { slots: [...current.held.values()].filter(row => row.quarantined).length };
}

export function assertSahpoolAutomationCapacity(sqlite: object, pool: object): void {
  assertPreservedSahpoolHandles(sqlite, pool); assertBoundedCorpus(proof.get(pool)!.held);
}

/** Source-private synchronous scope, spanning reserve/invoke/commit/rollback.
 * Check each original SAH write/truncate BEFORE I/O, including journal growth
 * and cache spills. A late size check alone cannot protect an interrupted run.
 * No limit is installed on unrelated user actions and no original file is cut. */
export function withBoundedSahpoolAutomation<T>(sqlite: object, pool: object, work: () => T): T {
  assertSahpoolAutomationCapacity(sqlite, pool);
  const current = proof.get(pool)!;
  if (current.bounded.active) throw denied();
  current.bounded.active = true;
  try {
    const result = work();
    if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) throw denied();
    assertBoundedCorpus(current.held); return result;
  }
  finally { current.bounded.active = false; }
}

/** Source-private boot preflight copy. The caller additionally proves that no
 * main handle has ever opened and holds lifecycle exclusion. Size is bounded
 * BEFORE allocation. Unassociated payload is never interpreted or reused. */
export function snapshotPreservedSahpool(sqlite: any, pool: object) {
  assertPreservedSahpoolHandles(sqlite, pool);
  const current = proof.get(pool)!, images = new Map<string, Uint8Array>(), sizes = new Map<string, number>();
  const rows = [...current.held.values()].filter(row => !row.quarantined && row.path);
  let total = 0;
  for (const row of rows) {
    if (association(row.sah, sqlite.capi) !== row.path) throw denied();
    sizes.set(row.path, row.sah.getSize()); total += Math.max(0, row.sah.getSize() - SECTOR);
    if (total > NATIVE_SHADOW_BYTES) throw new ClayError("E_CATALOG_UNAVAILABLE", "Native recovery exceeds its bounded shadow capacity; original files were kept");
  }
  for (const row of rows) {
    const bytes = new Uint8Array(Math.max(0, row.sah.getSize() - SECTOR));
    if (row.sah.read(bytes, { at: SECTOR }) !== bytes.length) throw denied(); images.set(row.path, bytes);
  }
  return { images, assertUnchanged() {
    current.assertHeld();
    if (JSON.stringify((pool as { getFileNames(): string[] }).getFileNames().sort()) !== JSON.stringify([...images.keys()].sort())) throw denied();
    const scratch = new Uint8Array(65_536);
    for (const row of rows) {
      const image = images.get(row.path)!;
      if (association(row.sah, sqlite.capi) !== row.path || row.sah.getSize() !== sizes.get(row.path)) throw denied();
      for (let at = 0; at < image.length; at += scratch.length) {
        const chunk = scratch.subarray(0, Math.min(scratch.length, image.length - at));
        if (row.sah.read(chunk, { at: at + SECTOR }) !== chunk.length || chunk.some((byte, index) => byte !== image[at + index])) throw denied();
      }
    }
  }, dispose() { for (const bytes of images.values()) bytes.fill(0); images.clear(); } };
}
