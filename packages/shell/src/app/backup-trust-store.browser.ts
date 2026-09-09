import type { BackupTrustRecordStore } from "@clay/kernel/backup";

const DATABASE_NAME = "clay-backup-trust-v1";
const STORE_NAME = "series";
const ACTIVE_SERIES_KEY = "@active-series-v1";
const AUTOMATIC_CANDIDATE_PREFIX = "@automatic-backup-candidate-v1:";
const SERIES_ID = /^[0-9a-f]{32}$/;
const UINT64 = /^(?:0|[1-9][0-9]{0,19})$/;
const factoryWrites = new WeakMap<IDBFactory, Promise<void>>();

function validSeriesId(value: string): string {
  if (!SERIES_ID.test(value)) throw new Error("Backup Trust series id is malformed");
  return value;
}

function validExpectedRevision(value: string | null): string | null {
  if (value !== null && !UINT64.test(value))
    throw new Error("Backup Trust expected revision is malformed");
  return value;
}

function persistedRevision(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("persisted Backup Trust record is malformed");
  const descriptor = Object.getOwnPropertyDescriptor(value, "revision");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
      || !UINT64.test(descriptor.value))
    throw new Error("persisted Backup Trust revision is malformed");
  return descriptor.value;
}

function requestedRevision(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("next Backup Trust record is malformed");
  const descriptor = Object.getOwnPropertyDescriptor(value, "revision");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
      || !UINT64.test(descriptor.value))
    throw new Error("next Backup Trust revision is malformed");
  return descriptor.value;
}

function parseActiveSeries(value: unknown): { revision: string; seriesId: string } | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 3)
    throw new Error("persisted active Backup Trust series is malformed");
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || typeof record.revision !== "string"
      || !UINT64.test(record.revision) || typeof record.seriesId !== "string"
      || !SERIES_ID.test(record.seriesId))
    throw new Error("persisted active Backup Trust series is malformed");
  return { revision: record.revision, seriesId: record.seriesId };
}

function cloneForStorage(value: unknown): unknown {
  requestedRevision(value);
  try {
    return structuredClone(value);
  } catch {
    throw new Error("next Backup Trust record cannot be stored");
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Backup Trust database request failed"),
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Backup Trust database transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Backup Trust database transaction aborted"),
    );
  });
}

async function serializeFactoryWrite<T>(factory: IDBFactory, task: () => Promise<T>): Promise<T> {
  const prior = factoryWrites.get(factory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => current);
  factoryWrites.set(factory, tail);
  await prior.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (factoryWrites.get(factory) === tail) factoryWrites.delete(factory);
  }
}

export class IndexedDbBackupTrustRecordStore implements BackupTrustRecordStore {
  constructor(private readonly factory: IDBFactory) {
    if (!factory || typeof factory.open !== "function")
      throw new Error("IndexedDB is unavailable for Backup Trust storage");
  }

  private async database(): Promise<IDBDatabase> {
    const request = this.factory.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME);
    };
    return requestResult(request);
  }

  async load(seriesIdInput: string): Promise<unknown | null> {
    const seriesId = validSeriesId(seriesIdInput);
    const database = await this.database();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(seriesId);
      const [result] = await Promise.all([
        requestResult(request) as Promise<unknown>,
        transactionComplete(transaction),
      ]);
      if (result === undefined) return null;
      try {
        return structuredClone(result);
      } catch {
        throw new Error("persisted Backup Trust record cannot be cloned");
      }
    } finally {
      database.close();
    }
  }

  async compareAndSet(
    seriesIdInput: string,
    expectedRevisionInput: string | null,
    nextInput: unknown,
  ): Promise<boolean> {
    const seriesId = validSeriesId(seriesIdInput);
    const expectedRevision = validExpectedRevision(expectedRevisionInput);
    const next = cloneForStorage(nextInput);
    return serializeFactoryWrite(this.factory, async () => {
      const database = await this.database();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        let changed = false;
        let failure: unknown = null;
        const request = store.get(seriesId);
        request.onsuccess = () => {
          try {
            if (persistedRevision(request.result) !== expectedRevision) return;
            const put = store.put(next, seriesId);
            put.onsuccess = () => { changed = true; };
          } catch (error) {
            failure = error;
          }
        };
        request.onerror = () => { failure = request.error ?? new Error("Backup Trust read failed"); };
        await transactionComplete(transaction);
        if (failure) throw failure;
        return changed;
      } finally {
        database.close();
      }
    });
  }

  async loadActiveSeries(): Promise<{ revision: string; seriesId: string } | null> {
    const database = await this.database();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(ACTIVE_SERIES_KEY);
      const [result] = await Promise.all([
        requestResult(request) as Promise<unknown>,
        transactionComplete(transaction),
      ]);
      return parseActiveSeries(result);
    } finally {
      database.close();
    }
  }

  async compareAndSetActiveSeries(
    expectedRevisionInput: string | null,
    seriesIdInput: string,
  ): Promise<boolean> {
    const expectedRevision = validExpectedRevision(expectedRevisionInput);
    const seriesId = validSeriesId(seriesIdInput);
    const nextRevision = expectedRevision === null ? "0" : (() => {
      const current = BigInt(expectedRevision);
      if (current >= (1n << 64n) - 1n)
        throw new Error("active Backup Trust series revision is exhausted");
      return String(current + 1n);
    })();
    return serializeFactoryWrite(this.factory, async () => {
      const database = await this.database();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        let changed = false;
        let failure: unknown = null;
        const request = store.get(ACTIVE_SERIES_KEY);
        request.onsuccess = () => {
          try {
            const current = parseActiveSeries(request.result);
            if ((current?.revision ?? null) !== expectedRevision) return;
            const put = store.put({ schema: 1, revision: nextRevision, seriesId }, ACTIVE_SERIES_KEY);
            put.onsuccess = () => { changed = true; };
          } catch (error) {
            failure = error;
          }
        };
        request.onerror = () => { failure = request.error ?? new Error("Backup Trust read failed"); };
        await transactionComplete(transaction);
        if (failure) throw failure;
        return changed;
      } finally {
        database.close();
      }
    });
  }

  async loadAutomaticBackupCandidate(seriesIdInput: string): Promise<unknown | null> {
    const key = `${AUTOMATIC_CANDIDATE_PREFIX}${validSeriesId(seriesIdInput)}`;
    const database = await this.database();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key);
      const [result] = await Promise.all([
        requestResult(request) as Promise<unknown>,
        transactionComplete(transaction),
      ]);
      return result === undefined ? null : structuredClone(result);
    } finally {
      database.close();
    }
  }

  async compareAndSetAutomaticBackupCandidate(
    seriesIdInput: string,
    expectedRevisionInput: string | null,
    nextInput: unknown,
  ): Promise<boolean> {
    const key = `${AUTOMATIC_CANDIDATE_PREFIX}${validSeriesId(seriesIdInput)}`;
    const expectedRevision = validExpectedRevision(expectedRevisionInput);
    const next = cloneForStorage(nextInput);
    return serializeFactoryWrite(this.factory, async () => {
      const database = await this.database();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        let changed = false;
        let failure: unknown = null;
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            if (persistedRevision(request.result) !== expectedRevision) return;
            const put = store.put(next, key);
            put.onsuccess = () => { changed = true; };
          } catch (error) {
            failure = error;
          }
        };
        request.onerror = () => { failure = request.error ?? new Error("Backup candidate read failed"); };
        await transactionComplete(transaction);
        if (failure) throw failure;
        return changed;
      } finally {
        database.close();
      }
    });
  }

  async removeAutomaticBackupCandidate(
    seriesIdInput: string,
    expectedRevisionInput: string,
  ): Promise<boolean> {
    const key = `${AUTOMATIC_CANDIDATE_PREFIX}${validSeriesId(seriesIdInput)}`;
    const expectedRevision = validExpectedRevision(expectedRevisionInput);
    if (expectedRevision === null) throw new Error("Backup candidate revision is required");
    return serializeFactoryWrite(this.factory, async () => {
      const database = await this.database();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        let changed = false;
        let failure: unknown = null;
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            if (persistedRevision(request.result) !== expectedRevision) return;
            const removal = store.delete(key);
            removal.onsuccess = () => { changed = true; };
          } catch (error) {
            failure = error;
          }
        };
        request.onerror = () => { failure = request.error ?? new Error("Backup candidate read failed"); };
        await transactionComplete(transaction);
        if (failure) throw failure;
        return changed;
      } finally {
        database.close();
      }
    });
  }
}
