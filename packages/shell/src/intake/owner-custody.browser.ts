import { validateIntakeOwnerCustody, type IntakeOwnerCustody, type IntakeOwnerVault } from "./owner-custody";

/** Device-origin trusted-shell custody. This is not the application database
 * and is never included in worker snapshots, application archives or panels. */
export class IndexedDbIntakeOwnerVault implements IntakeOwnerVault {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}
  #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error("Intake custody database is unavailable")); return; }
      const request = this.factory.open("clay-intake-owner-custody-v1", 1);
      let settled = false;
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        request.result.createObjectStore("owners", { keyPath: "key" });
      };
      request.onerror = request.onblocked = () => {
        if (!settled) { settled = true; reject(new Error("Intake custody database is unavailable")); }
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result);
      };
    });
  }
  async read(key: string): Promise<IntakeOwnerCustody | null> {
    const db = await this.#open();
    try { return await new Promise<IntakeOwnerCustody | null>((resolve, reject) => {
      const tx = db.transaction("owners", "readonly"); const request = tx.objectStore("owners").get(key); let result: unknown;
      request.onsuccess = () => { result = request.result; };
      tx.onerror = tx.onabort = () => reject(new Error("Intake custody read failed"));
      tx.oncomplete = () => {
        try { const parsed = result === undefined ? null : validateIntakeOwnerCustody(result);
          if (parsed && parsed.key !== key) throw new Error("Custody identity differs"); resolve(parsed);
        } catch { reject(new Error("Intake custody readback is invalid")); }
      };
    }); } finally { db.close(); }
  }
  async insert(input: IntakeOwnerCustody): Promise<void> {
    const record = validateIntakeOwnerCustody(input); const db = await this.#open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("owners", "readwrite"); const store = tx.objectStore("owners"); const request = store.get(record.key);
      request.onsuccess = () => {
        try {
          if (request.result === undefined) store.add(record);
          else if (JSON.stringify(validateIntakeOwnerCustody(request.result)) !== JSON.stringify(record)) tx.abort();
        } catch { tx.abort(); }
      };
      tx.onerror = tx.onabort = () => reject(new Error("Intake custody commit failed; original material was kept"));
      tx.oncomplete = () => resolve();
    }); } finally { db.close(); }
  }
}
