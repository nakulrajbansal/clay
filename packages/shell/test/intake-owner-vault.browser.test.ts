import { expect, it } from "vitest";
import { IndexedDbIntakeOwnerVault } from "../src/intake/owner-custody.browser";
import { prepareIntakeOwnerForm, hydrateIntakeOwnerForm } from "../src/intake/owner-custody";

/** Owned, transaction-serialized IndexedDB protocol fixture, not a browser or
 * durability certificate. No factory here can open a user's browser storage. */
class OwnedFactory {
  readonly rows = new Map<string, unknown>();
  opens = 0; closes = 0; created = false; failCommit = false; blockNext = false;
  lateSuccess: (() => void) | null = null;
  #tail: Promise<void> = Promise.resolve();
  open(): IDBOpenDBRequest {
    this.opens++;
    const request = {} as IDBOpenDBRequest;
    const db = { close: () => { this.closes++; }, createObjectStore: () => { this.created = true; },
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
      add: (value: { key: string }) => request(() => {
        if (staged.has(value.key)) throw new Error("Owned duplicate"); staged.set(value.key, structuredClone(value)); return value.key;
      }),
    }) });
    return tx;
  }
}
function ownedInput(vault: IndexedDbIntakeOwnerVault): Parameters<typeof prepareIntakeOwnerForm>[0] {
  return { vault, formId: `form_${"g".repeat(26)}`, source: { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "1", protectionRevision: "4",
    digestSchema: 1, stateSha256: `sha256:${"c".repeat(64)}` }, shellOrigin: "https://clay.example.test", relayBaseUrl: "https://relay.example.test/",
    title: "Owned IDB fixture", description: "", expiresAt: "2026-10-01T00:00:00.000Z", target: { tableId: "tbl_018f0000-0000-7000-8000-000000000001", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_018f0000-0000-7000-8000-000000000002", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] };
}

it("waits for commit, preserves an existing winner, and reads the same custody after adapter reload", async () => {
  const factory = new OwnedFactory(); const vault = new IndexedDbIntakeOwnerVault(factory as unknown as IDBFactory);
  const input = ownedInput(vault); factory.failCommit = true;
  await expect(prepareIntakeOwnerForm(input)).rejects.toThrow(/custody/); expect(factory.rows.size).toBe(0);
  const form = await prepareIntakeOwnerForm(input); const reloaded = new IndexedDbIntakeOwnerVault(factory as unknown as IDBFactory);
  const owner = await hydrateIntakeOwnerForm(form, input.source, input.shellOrigin, reloaded);
  const key = [...factory.rows.keys()][0]!; const record = (await reloaded.read(key))!;
  const original = JSON.stringify(record);
  await reloaded.insert(record); // Exact replay is idempotent.
  const conflicted = { ...record, ownerToken: record.submitToken, submitToken: record.ownerToken };
  await expect(reloaded.insert(conflicted)).rejects.toThrow(/kept/);
  expect(JSON.stringify(await reloaded.read(key)) === original).toBe(true);
  expect(JSON.stringify(form).includes(owner.ownerPrivateKey)).toBe(false);
  expect(factory.rows.size).toBe(1); expect(factory.closes).toBe(factory.opens);
});

it("closes a late successful open after a blocked request has already failed", async () => {
  const factory = new OwnedFactory(); factory.blockNext = true;
  const vault = new IndexedDbIntakeOwnerVault(factory as unknown as IDBFactory);
  await expect(vault.read("owned-missing-key")).rejects.toThrow(/unavailable/);
  factory.lateSuccess!(); expect(factory.closes).toBe(1); expect(factory.rows.size).toBe(0);
});
