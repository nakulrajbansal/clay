// AsyncStore: the typed async wrapper the main-thread Kernel exposes over
// the DB worker (doc 02 §3). In the browser the ClayStore lives inside the
// worker and StoreRpcClient proxies to it; tests (and the worker itself)
// use InProcessAsyncStore.
import { ClayError } from "./errors";
import type { ClayStore } from "./store";
import type { QueryRow } from "./query";
import type { RegTable } from "./registry";

type QueryT = import("@clay/schema").Query;

export type StoreMutationContext = { requestId: string };

export interface AsyncStore {
  query(q: QueryT): Promise<QueryRow[]>;
  insert(
    table: string, row: Record<string, unknown>, context?: StoreMutationContext,
  ): Promise<QueryRow>;
  update(
    table: string, id: string, patch: Record<string, unknown>, context?: StoreMutationContext,
  ): Promise<QueryRow>;
  softDelete(table: string, id: string, context?: StoreMutationContext): Promise<void>;
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

export type StoreRequest = { id: number; requestId: string; op: string; payload: unknown };
export type StoreResponse = {
  id: number; ok: boolean; result?: unknown;
  error?: { code: string; message: string };
};

type StoreQuiesce = { v: 1; kind: "store.quiesce"; nonce: string };
type StoreQuiesced = { v: 1; kind: "store.quiesced"; nonce: string };
export type StoreServerControl = Readonly<{ quiesce(): Promise<void> }>;

function controlFrame(raw: unknown, kind: StoreQuiesce["kind"] | StoreQuiesced["kind"]): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Reflect.ownKeys(record).some(key => typeof key !== "string")
      || Object.keys(record).sort().join(",") !== "kind,nonce,v"
      || record.v !== 1 || record.kind !== kind
      || typeof record.nonce !== "string" || !/^stq_[a-z2-7]{26}$/.test(record.nonce)) return null;
  return record.nonce;
}

/** Worker-side: bind an authority-backed async Store to a port. */
export function serveStore(
  store: AsyncStore,
  port: MessagePortLike,
  beginOperation: (() => () => void) | null = null,
): StoreServerControl {
  let pendingQuiescence: { nonce: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  port.onMessage((raw) => {
    const quiesced = controlFrame(raw, "store.quiesced");
    if (quiesced !== null) {
      if (pendingQuiescence?.nonce === quiesced) {
        const pending = pendingQuiescence;
        pendingQuiescence = null;
        pending.resolve();
      }
      return;
    }
    const req = raw as StoreRequest;
    void (async () => {
      let finishOperation = (): void => {};
      try {
        finishOperation = beginOperation?.() ?? finishOperation;
        const p = req.payload as {
          q: QueryT; table: string; id: string;
          row: Record<string, unknown>; patch: Record<string, unknown>;
        };
        let result: unknown;
        switch (req.op) {
          case "query": result = await store.query(p.q); break;
          case "insert": result = await store.insert(
            p.table, p.row, { requestId: req.requestId }); break;
          case "update": result = await store.update(
            p.table, p.id, p.patch, { requestId: req.requestId }); break;
          case "softDelete": result = await store.softDelete(
            p.table, p.id, { requestId: req.requestId }); break;
          case "registryTables": result = await store.registryTables(); break;
          default:
            throw new ClayError("E_VALIDATION", `unknown store op '${req.op}'`);
        }
        port.send({ id: req.id, ok: true, result } satisfies StoreResponse);
      } catch (e) {
        const err = e instanceof ClayError
          ? { code: e.code, message: e.message }
          : { code: "E_INTERNAL", message: String(e) };
        port.send({ id: req.id, ok: false, error: err } satisfies StoreResponse);
      } finally {
        finishOperation();
      }
    })();
  });
  return Object.freeze({
    quiesce(): Promise<void> {
      if (pendingQuiescence) return Promise.reject(new ClayError(
        "E_CONFLICT", "Store RPC quiescence is already pending",
      ));
      const nonce = mintStoreRequestId().replace(/^req_/, "stq_");
      return new Promise<void>((resolve, reject) => {
        pendingQuiescence = { nonce, resolve, reject };
        try { port.send({ v: 1, kind: "store.quiesce", nonce } satisfies StoreQuiesce); }
        catch (error) {
          pendingQuiescence = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  });
}

function mintStoreRequestId(): string {
  const source = (globalThis as unknown as {
    crypto?: { getRandomValues<T extends Uint8Array>(value: T): T };
  }).crypto;
  if (!source?.getRandomValues)
    throw new ClayError("E_INTERNAL", "trusted StoreRpc request identity is unavailable");
  const bytes = source.getRandomValues(new Uint8Array(17));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (let index = 0; index < bytes.length && encoded.length < 26; index++) {
    value = (value << 8) | bytes[index]!;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  return `req_${encoded}`;
}

/** Main-thread side: an AsyncStore that proxies over a port. */
export class StoreRpcClient implements AsyncStore {
  #accepting = true;
  #pendingQuiescenceNonce: string | null = null;
  #quiescenceAcknowledged = false;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: unknown) => void;
  }>();

  constructor(private readonly port: MessagePortLike) {
    port.onMessage((raw) => {
      const nonce = controlFrame(raw, "store.quiesce");
      if (nonce !== null) {
        this.#accepting = false;
        if (!this.#quiescenceAcknowledged && this.#pendingQuiescenceNonce === null)
          this.#pendingQuiescenceNonce = nonce;
        this.#acknowledgeQuiescenceIfDrained();
        return;
      }
      const res = raw as StoreResponse;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new ClayError(
        (res.error?.code ?? "E_INTERNAL") as ClayError["code"],
        res.error?.message ?? "store rpc failed"));
      this.#acknowledgeQuiescenceIfDrained();
    });
  }

  #acknowledgeQuiescenceIfDrained(): void {
    if (this.pending.size !== 0 || this.#pendingQuiescenceNonce === null) return;
    const nonce = this.#pendingQuiescenceNonce;
    this.#pendingQuiescenceNonce = null;
    this.#quiescenceAcknowledged = true;
    this.port.send({ v: 1, kind: "store.quiesced", nonce } satisfies StoreQuiesced);
  }

  private call<T>(
    op: string,
    payload: unknown,
    context?: StoreMutationContext,
  ): Promise<T> {
    if (!this.#accepting)
      return Promise.reject(new ClayError("E_CONFLICT", "Store RPC is quiescing"));
    const requestId = context?.requestId ?? mintStoreRequestId();
    if (!/^req_[a-z2-7]{26}$/.test(requestId))
      return Promise.reject(new ClayError("E_VALIDATION", "StoreRpc request identity is invalid"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.send({ id, requestId, op, payload } satisfies StoreRequest);
    });
  }

  query(q: QueryT): Promise<QueryRow[]> { return this.call("query", { q }); }
  insert(
    table: string,
    row: Record<string, unknown>,
    context?: StoreMutationContext,
  ): Promise<QueryRow> {
    return this.call("insert", { table, row }, context);
  }
  update(
    table: string,
    id: string,
    patch: Record<string, unknown>,
    context?: StoreMutationContext,
  ): Promise<QueryRow> {
    return this.call("update", { table, id, patch }, context);
  }
  softDelete(table: string, id: string, context?: StoreMutationContext): Promise<void> {
    return this.call("softDelete", { table, id }, context);
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
