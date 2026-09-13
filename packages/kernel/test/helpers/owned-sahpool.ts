import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";

type Io = { op: "write" | "flush" | "truncate"; path: string; previousPath: string; at: number; size: number };
type OwnedFile = { live: Uint8Array; durable: Uint8Array; locked: boolean };

/** No host filesystem/browser directory is opened. The installed, unmodified
 * browser sqlite-wasm binary runs against these disposable protocol handles.
 * flush-only and write-through model permitted persistence orderings, not a
 * browser durability certificate. Faults stop ALL subsequent I/O for that epoch. */
export class OwnedSahDirectory {
  readonly files: OwnedFile[] = [];
  readonly events: Io[] = [];
  readonly reads: Array<{ path: string; at: number; size: number }> = [];
  readonly handles: Array<{ kind: "acquire" | "close"; file: number; epoch: number }> = [];
  readonly root: OwnedDirectoryHandle;
  epoch = 1;
  dead = false;
  writeThrough = false;
  fault: ((event: Io) => boolean) | null = null;
  readFault: ((event: { path: string; at: number; size: number }) => boolean) | null = null;
  constructor() { this.root = new OwnedDirectoryHandle(this); }
  path(file: OwnedFile): string {
    const end = file.live.subarray(0, 512).indexOf(0);
    return new TextDecoder().decode(file.live.subarray(0, end < 0 ? 0 : end));
  }
  event(file: OwnedFile, op: Io["op"], at = 0, size = 0, previousPath = this.path(file)): void {
    const event = { op, path: this.path(file), previousPath, at, size }; this.events.push(event);
    if (this.fault?.(event)) { this.dead = true; throw new Error("Owned power interruption"); }
  }
  reopen(): void {
    this.epoch++; this.dead = false; this.fault = null; this.readFault = null;
    for (const file of this.files) { file.live = file.durable.slice(); file.locked = false; }
  }
  installGlobals(): void {
    vi.stubGlobal("WorkerGlobalScope", class {});
    vi.stubGlobal("location", { href: "https://owned.invalid/worker.js" });
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => this.root } });
    vi.stubGlobal("FileSystemHandle", OwnedHandle);
    vi.stubGlobal("FileSystemDirectoryHandle", OwnedDirectoryHandle);
    vi.stubGlobal("FileSystemFileHandle", OwnedFileHandle);
    // Only SAHPool is in scope. No proxy Worker, XHR, or network may be opened.
    vi.stubGlobal("sqlite3ApiConfig", { disable: { vfs: { opfs: true, "opfs-vfs": true, "opfs-wl": true } },
      log: () => {}, warn: () => {}, error: () => {} });
  }
}
class OwnedHandle { constructor(readonly kind: "file" | "directory") {} }
class OwnedFileHandle extends OwnedHandle {
  constructor(readonly owned: OwnedSahDirectory, readonly file: OwnedFile) { super("file"); }
  async createSyncAccessHandle() {
    if (this.file.locked) throw new Error("Owned exclusive handle already held");
    this.file.locked = true; const epoch = this.owned.epoch; let closed = false;
    this.owned.handles.push({ kind: "acquire", file: this.owned.files.indexOf(this.file), epoch });
    const check = () => { if (closed || this.owned.dead || epoch !== this.owned.epoch) throw new Error("Owned handle is unavailable"); };
    const resize = (size: number) => { const next = new Uint8Array(size); next.set(this.file.live.subarray(0, size)); this.file.live = next; };
    const bytes = (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return {
      close: () => { check(); closed = true; this.file.locked = false; this.owned.handles.push({ kind: "close", file: this.owned.files.indexOf(this.file), epoch }); },
      getSize: () => { check(); return this.file.live.length; },
      read: (out: ArrayBufferView, options: { at: number }) => {
        check(); const event = { path: this.owned.path(this.file), at: options.at, size: out.byteLength }; this.owned.reads.push(event);
        if (this.owned.readFault?.(event)) throw new Error("Owned read fault");
        const input = this.file.live.subarray(options.at, options.at + out.byteLength); bytes(out).set(input); return input.length;
      },
      write: (input: ArrayBufferView, options: { at: number }) => {
        check(); const previousPath = this.owned.path(this.file);
        if (options.at + input.byteLength > this.file.live.length) resize(options.at + input.byteLength);
        this.file.live.set(bytes(input), options.at);
        if (this.owned.writeThrough) this.file.durable = this.file.live.slice();
        this.owned.event(this.file, "write", options.at, input.byteLength, previousPath); return input.byteLength;
      },
      flush: () => { check(); this.file.durable = this.file.live.slice(); this.owned.event(this.file, "flush"); },
      truncate: (size: number) => { check(); resize(size); if (this.owned.writeThrough) this.file.durable = this.file.live.slice(); this.owned.event(this.file, "truncate", 0, size); },
    };
  }
}
class OwnedDirectoryHandle extends OwnedHandle {
  readonly children = new Map<string, OwnedHandle>();
  constructor(readonly owned: OwnedSahDirectory) { super("directory"); }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let result = this.children.get(name);
    if (!result && options?.create) { result = new OwnedDirectoryHandle(this.owned); this.children.set(name, result); }
    if (!(result instanceof OwnedDirectoryHandle)) throw Object.assign(new Error("Owned directory is unavailable"), { name: "NotFoundError" }); return result;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let result = this.children.get(name);
    if (!result && options?.create) {
      const file = { live: new Uint8Array(), durable: new Uint8Array(), locked: false }; this.owned.files.push(file);
      result = new OwnedFileHandle(this.owned, file); this.children.set(name, result);
    }
    if (!(result instanceof OwnedFileHandle)) throw Object.assign(new Error("Owned file is unavailable"), { name: "NotFoundError" }); return result;
  }
  async removeEntry(name: string) { this.children.delete(name); }
  async *[Symbol.asyncIterator]() { yield* this.children.entries(); }
}

export async function initializedSahpool(owned: OwnedSahDirectory): Promise<any> {
  owned.installGlobals();
  const require = createRequire(import.meta.url), directory = dirname(require.resolve("@sqlite.org/sqlite-wasm"));
  const moduleUrl = pathToFileURL(join(directory, "index.mjs")).href;
  const init = (await import(/* @vite-ignore */ moduleUrl)).default;
  return init({ wasmBinary: readFileSync(join(directory, "sqlite3.wasm")), print: () => {}, printErr: () => {} });
}

export async function installedSahpool(owned: OwnedSahDirectory, directory = "owned-clay-faults"): Promise<{ sqlite: any; pool: any }> {
  const sqlite = await initializedSahpool(owned);
  const pool = await sqlite.installOpfsSAHPoolVfs({ name: "opfs-sahpool", directory, initialCapacity: 16, verbosity: 0 });
  return { sqlite, pool };
}
