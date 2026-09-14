import { validateLegacyOwnerRecord, type LegacyOwnerRecord, type LegacyOwnerVault } from "./owner-recovery";
import { legacyOwnerFailure } from "./owner-protocol";

function same(a: LegacyOwnerRecord, b: LegacyOwnerRecord, actions = true): boolean {
  return a.key === b.key && a.schema === b.schema && a.shellOrigin === b.shellOrigin && JSON.stringify(a.proof) === JSON.stringify(b.proof)
    && (!actions || (a.custodyCommitted === b.custodyCommitted && JSON.stringify(a.actions) === JSON.stringify(b.actions))) && a.bytes.byteLength === b.bytes.byteLength && a.bytes.every((v, i) => v === b.bytes[i]);
}
/** Exact historical bytes stay shell-origin private; no export/erase/replace API. */
export class IndexedDbLegacyOwnerVault implements LegacyOwnerVault {
  constructor(readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) { reject(legacyOwnerFailure()); return; }
      const request = this.factory.open("clay-legacy-owner-custody-v1", 1); let settled = false;
      request.onupgradeneeded = () => { if (settled) request.transaction?.abort(); else request.result.createObjectStore("records", { keyPath: "key" }); };
      request.onerror = request.onblocked = () => { if (!settled) { settled = true; reject(legacyOwnerFailure()); } };
      request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }
  async read(key: string): Promise<LegacyOwnerRecord | null> {
    const db = await this.open();
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction("records", "readonly"), req = tx.objectStore("records").get(key); let result: unknown;
        req.onsuccess = () => { result = req.result; }; tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(legacyOwnerFailure());
      });
      if (raw === undefined) return null;
      const result = await validateLegacyOwnerRecord(raw); if (result.key !== key) throw legacyOwnerFailure(); return result;
    } finally { db.close(); }
  }
  async list(): Promise<LegacyOwnerRecord[]> {
    const db = await this.open();
    try {
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction("records", "readonly"), store = tx.objectStore("records"), count = store.count(); let result: unknown[] = [], physical = 0;
        count.onsuccess = () => {
          physical = count.result;
          if (!Number.isInteger(physical) || physical < 0 || physical > 32) { tx.abort(); return; }
          const req = store.getAll(undefined, 33); req.onsuccess = () => { result = req.result; };
        };
        tx.oncomplete = () => physical === result.length ? resolve(result) : reject(legacyOwnerFailure()); tx.onerror = tx.onabort = () => reject(legacyOwnerFailure());
      });
      const parsed = []; for (const row of rows) parsed.push(await validateLegacyOwnerRecord(row));
      if (new Set(parsed.map(row => row.key)).size !== parsed.length) throw legacyOwnerFailure(); return parsed;
    } finally { db.close(); }
  }
  async insert(input: LegacyOwnerRecord): Promise<void> { await this.write(null, await validateLegacyOwnerRecord(input)); }
  async compareAndSet(before: LegacyOwnerRecord, after: LegacyOwnerRecord): Promise<void> {
    const a = await validateLegacyOwnerRecord(before), b = await validateLegacyOwnerRecord(after);
    if (!same(a, b, false) || b.actions.length < a.actions.length || b.actions.length > a.actions.length + 1) throw legacyOwnerFailure();
    if (a.custodyCommitted && !b.custodyCommitted) throw legacyOwnerFailure();
    if (!a.custodyCommitted && b.custodyCommitted) {
      if (a.actions.length || b.actions.length) throw legacyOwnerFailure(); await this.write(a, b); return;
    }
    if (b.actions.length === a.actions.length + 1) {
      if (JSON.stringify(a.actions) !== JSON.stringify(b.actions.slice(0, -1)) || b.actions.at(-1)?.outcome !== "pending") throw legacyOwnerFailure();
    } else {
      if (JSON.stringify(a.actions.slice(0, -1)) !== JSON.stringify(b.actions.slice(0, -1)) || JSON.stringify(a.actions.at(-1)?.intent) !== JSON.stringify(b.actions.at(-1)?.intent)
          || (a.actions.at(-1)?.outcome !== "pending" && !same(a, b))) throw legacyOwnerFailure();
    }
    await this.write(a, b);
  }
  private async write(before: LegacyOwnerRecord | null, after: LegacyOwnerRecord) {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite"), store = tx.objectStore("records"), count = store.count();
        count.onsuccess = () => {
          if (count.result > 32) { tx.abort(); return; }
          const req = store.get(after.key);
          req.onsuccess = () => {
            try {
              if (before) { if (!req.result || !same(req.result, before)) throw legacyOwnerFailure(); store.put(after); }
              else if (req.result) { if (!same(req.result, after, false)) throw legacyOwnerFailure(); }
              else { if (count.result >= 32 || after.actions.length) throw legacyOwnerFailure(); store.add(after); }
            } catch { tx.abort(); }
          };
        };
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(legacyOwnerFailure());
      });
      const result = await this.read(after.key); if (!result || !same(result, after, before !== null)) throw legacyOwnerFailure();
    } finally { db.close(); }
  }
}
