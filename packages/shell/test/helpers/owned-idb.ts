/** Owned, transaction-serialized IndexedDB protocol fixture, not a browser or
 * durability certificate. No factory here can open a user's browser storage. */
export class OwnedFactory {
  readonly rows = new Map<string, unknown>();
  keyPath = "key";
  opens = 0; closes = 0; created = false; failCommit = false; blockNext = false;
  lateSuccess: (() => void) | null = null;
  #tail: Promise<void> = Promise.resolve();
  open(): IDBOpenDBRequest {
    this.opens++;
    const request = {} as IDBOpenDBRequest;
    const db = { close: () => { this.closes++; }, createObjectStore: (_name: string, options: { keyPath: string }) => { this.created = true; this.keyPath = options.keyPath; },
      transaction: (_store: string, mode: IDBTransactionMode) => this.transaction(mode) } as unknown as IDBDatabase;
    Object.defineProperty(request, "result", { value: db });
    const success = () => {
      if (!this.created) request.onupgradeneeded?.call(request, {} as IDBVersionChangeEvent);
      request.onsuccess?.call(request, new Event("success"));
    };
    queueMicrotask(() => {
      if (this.blockNext) { this.blockNext = false; this.lateSuccess = success; request.onblocked?.call(request, {} as IDBVersionChangeEvent); }
      else success();
    });
    return request;
  }
  transaction(mode: IDBTransactionMode): IDBTransaction {
    let done = false; let pending = 0; let release!: () => void;
    const ready = this.#tail; this.#tail = new Promise(resolve => { release = resolve; });
    let staged = new Map<string, unknown>();
    const tx = {} as IDBTransaction;
    const abort = () => { if (!done) { done = true; tx.onabort?.call(tx, new Event("abort")); release(); } };
    const active = ready.then(() => { staged = new Map(this.rows); });
    const request = (run: () => unknown): IDBRequest => {
      const result = {} as IDBRequest; pending++;
      void active.then(() => {
        if (done) return;
        try { Object.defineProperty(result, "result", { value: run() }); result.onsuccess?.call(result, new Event("success")); }
        catch { abort(); }
        finally {
          pending--;
          queueMicrotask(() => {
            if (done || pending !== 0) return;
            if (mode === "readwrite" && this.failCommit) { this.failCommit = false; abort(); return; }
            done = true;
            if (mode === "readwrite") { this.rows.clear(); for (const [key, value] of staged) this.rows.set(key, value); }
            tx.oncomplete?.call(tx, new Event("complete")); release();
          });
        }
      });
      return result;
    };
    Object.assign(tx, { abort, objectStore: () => ({
      get: (key: string) => request(() => structuredClone(staged.get(key))),
      add: (value: unknown) => request(() => {
        const key = this.keyPath.split(".").reduce((row: any, field) => row[field], value) as string;
        if (staged.has(key)) throw new Error("Owned duplicate"); staged.set(key, structuredClone(value)); return key;
      }),
      put: (value: unknown) => request(() => { const key = this.keyPath.split(".").reduce((row: any, field) => row[field], value) as string; staged.set(key, structuredClone(value)); return key; }),
      count: () => request(() => staged.size),
      getAll: (_query: unknown, count: number) => request(() => [...staged.values()].slice(0, count).map(row => structuredClone(row))),
      getAllKeys: (_query: unknown, count: number) => request(() => [...staged.keys()].sort().slice(0, count)),
    }) });
    return tx;
  }
}
