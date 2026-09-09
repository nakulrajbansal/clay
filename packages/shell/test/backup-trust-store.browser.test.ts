/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { IndexedDbBackupTrustRecordStore } from "../src/app/backup-trust-store.browser";

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  #pending = 0;
  #completed = false;

  constructor(private readonly rows: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    return {
      get: (key: IDBValidKey) => this.#request(() => {
        const value = this.rows.get(String(key));
        return value === undefined ? undefined : structuredClone(value);
      }),
      put: (value: unknown, key: IDBValidKey) => this.#request(() => {
        this.rows.set(String(key), structuredClone(value));
        return key;
      }),
    } as unknown as IDBObjectStore;
  }

  #request<T>(operation: () => T): IDBRequest<T> {
    const request = new FakeRequest<T>();
    this.#pending++;
    queueMicrotask(() => {
      try {
        request.result = operation();
        request.onsuccess?.(new Event("success"));
      } catch (error) {
        request.error = new DOMException(String(error), "UnknownError");
        request.onerror?.(new Event("error"));
        this.onerror?.(new Event("error"));
      } finally {
        this.#pending--;
        queueMicrotask(() => {
          if (!this.#completed && this.#pending === 0) {
            this.#completed = true;
            this.oncomplete?.(new Event("complete"));
          }
        });
      }
    });
    return request as unknown as IDBRequest<T>;
  }
}

class FakeDatabase {
  readonly rows = new Map<string, unknown>();
  created = false;
  readonly objectStoreNames = {
    contains: () => this.created,
  } as unknown as DOMStringList;

  createObjectStore(): IDBObjectStore {
    this.created = true;
    return {} as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    return new FakeTransaction(this.rows) as unknown as IDBTransaction;
  }

  close(): void {}
}

class FakeFactory {
  readonly database = new FakeDatabase();

  open(): IDBOpenDBRequest {
    const request = new FakeRequest<IDBDatabase>();
    request.result = this.database as unknown as IDBDatabase;
    queueMicrotask(() => {
      if (!this.database.created)
        request.onupgradeneeded?.({} as IDBVersionChangeEvent);
      request.onsuccess?.(new Event("success"));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const series = "31".repeat(16);
const row = (revision: string, marker: string) => ({
  schema: 1,
  revision,
  marker,
  backupTrustKey: new Uint8Array([1, 2, 3]),
});

describe("IndexedDB Backup Trust record store", () => {
  it("copies records and performs exact atomic compare-and-set", async () => {
    const factory = new FakeFactory();
    const store = new IndexedDbBackupTrustRecordStore(factory as unknown as IDBFactory);
    await expect(store.compareAndSet(series, null, row("0", "first"))).resolves.toBe(true);
    const loaded = await store.load(series) as ReturnType<typeof row>;
    expect(loaded).toMatchObject({ schema: 1, revision: "0", marker: "first" });
    expect([...loaded.backupTrustKey]).toEqual([1, 2, 3]);
    loaded.marker = "mutated";
    loaded.backupTrustKey.fill(0xff);
    const unchanged = await store.load(series) as ReturnType<typeof row>;
    expect(unchanged).toMatchObject({ schema: 1, revision: "0", marker: "first" });
    expect([...unchanged.backupTrustKey]).toEqual([1, 2, 3]);
    await expect(store.compareAndSet(series, "9", row("1", "wrong"))).resolves.toBe(false);
    await expect(store.compareAndSet(series, "0", row("1", "next"))).resolves.toBe(true);
    const next = await store.load(series) as ReturnType<typeof row>;
    expect(next).toMatchObject({ schema: 1, revision: "1", marker: "next" });
    expect([...next.backupTrustKey]).toEqual([1, 2, 3]);
  });

  it("allows exactly one winner for competing updates at the same revision", async () => {
    const factory = new FakeFactory();
    const first = new IndexedDbBackupTrustRecordStore(factory as unknown as IDBFactory);
    const second = new IndexedDbBackupTrustRecordStore(factory as unknown as IDBFactory);
    expect(await first.compareAndSet(series, null, row("0", "seed"))).toBe(true);
    const results = await Promise.all([
      first.compareAndSet(series, "0", row("1", "a")),
      second.compareAndSet(series, "0", row("1", "b")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("persists one CAS-protected active series pointer", async () => {
    const factory = new FakeFactory();
    const store = new IndexedDbBackupTrustRecordStore(factory as unknown as IDBFactory);
    await expect(store.loadActiveSeries()).resolves.toBeNull();
    await expect(store.compareAndSetActiveSeries(null, series)).resolves.toBe(true);
    await expect(store.loadActiveSeries()).resolves.toEqual({ revision: "0", seriesId: series });
    await expect(store.compareAndSetActiveSeries(null, "32".repeat(16))).resolves.toBe(false);
    await expect(store.compareAndSetActiveSeries("0", "32".repeat(16))).resolves.toBe(true);
    await expect(store.loadActiveSeries()).resolves.toEqual({
      revision: "1",
      seriesId: "32".repeat(16),
    });
  });

  it("rejects malformed keys and revisions before opening IndexedDB", async () => {
    const factory = new FakeFactory();
    const store = new IndexedDbBackupTrustRecordStore(factory as unknown as IDBFactory);
    await expect(store.load("../series")).rejects.toThrow(/series/i);
    await expect(store.compareAndSet(series, "01", row("1", "bad")))
      .rejects.toThrow(/revision/i);
    expect(factory.database.rows.size).toBe(0);
  });
});
