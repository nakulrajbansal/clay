import { assertShareOwnerTransition, validateShareOwnerRecord, type ShareOwnerRecord, type ShareOwnerVault } from "./owner-custody";

/** Origin-local shell custody, separate from OPFS app archives and the DB worker. */
export class IndexedDbShareOwnerVault implements ShareOwnerVault {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error("Share custody database unavailable")); return; }
      const request = this.factory.open("clay-share-owner-custody-v2", 1); let settled = false;
      request.onupgradeneeded = () => { if (settled) request.transaction?.abort(); else request.result.createObjectStore("shares", { keyPath: "request.shareId" }); };
      request.onerror = request.onblocked = () => { if (!settled) { settled = true; reject(new Error("Share custody database unavailable")); } };
      request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }
  async list(): Promise<ShareOwnerRecord[]> {
    const db = await this.open();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction("shares", "readonly"), request = tx.objectStore("shares").getAll(undefined, 101); let rows: unknown[] = [];
      request.onsuccess = () => { rows = request.result; };
      tx.onerror = tx.onabort = () => reject(new Error("Share custody read failed"));
      tx.oncomplete = () => { try { if (rows.length > 100) throw new Error(); resolve(rows.map(validateShareOwnerRecord)); }
        catch { reject(new Error("Share custody is invalid; original records kept")); } };
    }); } finally { db.close(); }
  }
  async compareAndSet(beforeInput: ShareOwnerRecord | null, afterInput: ShareOwnerRecord): Promise<void> {
    const before = beforeInput === null ? null : validateShareOwnerRecord(beforeInput), after = validateShareOwnerRecord(afterInput);
    assertShareOwnerTransition(before, after); const db = await this.open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("shares", "readwrite"), store = tx.objectStore("shares"), request = store.get(after.request.shareId);
      request.onsuccess = () => {
        try {
          const existing = request.result === undefined ? null : validateShareOwnerRecord(request.result);
          if (JSON.stringify(existing) === JSON.stringify(after)) return; // Commit response lost.
          if (JSON.stringify(existing) !== JSON.stringify(before)) { tx.abort(); return; }
          if (before === null) {
            const count = store.count(); count.onsuccess = () => { if (count.result >= 100) tx.abort(); else store.add(after); };
          } else store.put(after);
        } catch { tx.abort(); }
      };
      tx.onerror = tx.onabort = () => reject(new Error("Share custody commit conflicted or failed; original records kept"));
      tx.oncomplete = () => resolve();
    }); } finally { db.close(); }
  }
}
