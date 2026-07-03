// AsyncStore: the typed async wrapper the main-thread Kernel exposes over
// the DB worker (doc 02 §3). In the browser the ClayStore lives inside the
// worker and StoreRpcClient proxies to it; tests (and the worker itself)
// use InProcessAsyncStore.
import { ClayError } from "./errors";
import type { ClayStore } from "./store";
import type { QueryRow } from "./query";
import type { RegTable } from "./registry";

type QueryT = import("@clay/schema").Query;

export interface AsyncStore {
  query(q: QueryT): Promise<QueryRow[]>;
  insert(table: string, row: Record<string, unknown>): Promise<QueryRow>;
  update(table: string, id: string, patch: Record<string, unknown>): Promise<QueryRow>;
  softDelete(table: string, id: string): Promise<void>;
  /** Serializable registry snapshot (array form; backs clay.meta.schema). */
  registryTables(): Promise<RegTable[]>;
}

export class InProcessAsyncStore implements AsyncStore {
  constructor(private readonly store: ClayStore) {}
  async query(q: QueryT): Promise<QueryRow[]> { return this.store.query(q); }
  async insert(table: string, row: Record<string, unknown>): Promise<QueryRow> {
    return this.store.insert(table, row);
  }
  async update(table: string, id: string, patch: Record<string, unknown>): Promise<QueryRow> {
    return this.store.update(table, id, patch);
  }
  async softDelete(table: string, id: string): Promise<void> {
    this.store.softDelete(table, id);
  }
  async registryTables(): Promise<RegTable[]> {
    return [...this.store.registrySnapshot().values()];
  }
}

// ---------- worker RPC (doc 02 §3: {id, op, payload} -> {id, ok, ...}) ----------
export type MessagePortLike = {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
};

export type StoreRequest = { id: number; op: string; payload: unknown };
export type StoreResponse = {
  id: number; ok: boolean; result?: unknown;
  error?: { code: string; message: string };
};

/** Worker-side: bind a ClayStore to a port. Returns a detach function. */
export function serveStore(store: ClayStore, port: MessagePortLike): void {
  const local = new InProcessAsyncStore(store);
  port.onMessage((raw) => {
    const req = raw as StoreRequest;
    void (async () => {
      try {
        const p = req.payload as {
          q: QueryT; table: string; id: string;
          row: Record<string, unknown>; patch: Record<string, unknown>;
        };
        let result: unknown;
        switch (req.op) {
          case "query": result = await local.query(p.q); break;
          case "insert": result = await local.insert(p.table, p.row); break;
          case "update": result = await local.update(p.table, p.id, p.patch); break;
          case "softDelete": result = await local.softDelete(p.table, p.id); break;
          case "registryTables": result = await local.registryTables(); break;
          default:
            throw new ClayError("E_VALIDATION", `unknown store op '${req.op}'`);
        }
        port.send({ id: req.id, ok: true, result } satisfies StoreResponse);
      } catch (e) {
        const err = e instanceof ClayError
          ? { code: e.code, message: e.message }
          : { code: "E_INTERNAL", message: String(e) };
        port.send({ id: req.id, ok: false, error: err } satisfies StoreResponse);
      }
    })();
  });
}

/** Main-thread side: an AsyncStore that proxies over a port. */
export class StoreRpcClient implements AsyncStore {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: unknown) => void;
  }>();

  constructor(private readonly port: MessagePortLike) {
    port.onMessage((raw) => {
      const res = raw as StoreResponse;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new ClayError(
        (res.error?.code ?? "E_INTERNAL") as ClayError["code"],
        res.error?.message ?? "store rpc failed"));
    });
  }

  private call<T>(op: string, payload: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.send({ id, op, payload } satisfies StoreRequest);
    });
  }

  query(q: QueryT): Promise<QueryRow[]> { return this.call("query", { q }); }
  insert(table: string, row: Record<string, unknown>): Promise<QueryRow> {
    return this.call("insert", { table, row });
  }
  update(table: string, id: string, patch: Record<string, unknown>): Promise<QueryRow> {
    return this.call("update", { table, id, patch });
  }
  softDelete(table: string, id: string): Promise<void> {
    return this.call("softDelete", { table, id });
  }
  registryTables(): Promise<RegTable[]> { return this.call("registryTables", {}); }
}

/** Adapt a real MessagePort / Worker to MessagePortLike. The `never`
 * parameter keeps this assignable from lib.dom's MessagePort (we only ever
 * WRITE onmessage). */
export function portFromMessagePort(p: {
  postMessage(msg: unknown): void;
  onmessage: ((ev: never) => unknown) | null;
}): MessagePortLike {
  const target = p as { onmessage: ((ev: { data: unknown }) => void) | null };
  return {
    send: (msg) => p.postMessage(msg),
    onMessage: (cb) => { target.onmessage = (ev): void => cb(ev.data); },
  };
}
