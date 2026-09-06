import {
  claimPhysicalDriverAuthority,
  isReadOnlyStatement,
  isThenable,
  type DbDriver,
  type PhysicalDriverAuthority,
  type SqlRow,
  type SqlValue,
} from "./db";
import { ClayError } from "./errors";


/**
 * Denies every live SQL exec unless a trusted coordinator opens one synchronous
 * outer transaction. Read traffic remains available, and snapshot() returns an
 * independent disposable database which cannot alter live state or catalog
 * authority.
 */
class LiveWriteGuard implements DbDriver {
  #authorized = false;
  readonly #owner = Symbol("clay.live-write-guard");
  readonly #inner: DbDriver;
  readonly #authority: PhysicalDriverAuthority;

  constructor(inner: DbDriver) {
    this.#inner = inner;
    this.#authority = claimPhysicalDriverAuthority(inner, this.#owner);
  }

  exec(sql: string, params?: SqlValue[]): void {
    if (!this.#authorized)
      throw new ClayError("E_STALE_WRITE_EPOCH", "live write authority is not current");
    this.#authority.exec(sql, params);
  }

  select(sql: string, params?: SqlValue[]): SqlRow[] {
    if (!this.#authorized && !isReadOnlyStatement(sql))
      throw new ClayError("E_STALE_WRITE_EPOCH", "live read channel cannot execute mutation SQL");
    return this.#authorized
      ? this.#authority.select(sql, params)
      : this.#inner.select(sql, params);
  }

  tx<T>(fn: () => T): T {
    return this.#authorized ? this.#authority.tx(fn) : this.#authority.readTx(fn);
  }

  runAuthorized<T>(fn: () => T): T {
    if (this.#authorized)
      throw new ClayError("E_STALE_WRITE_EPOCH", "nested live write authority is not allowed");
    return this.#authority.runAuthorized(() => {
      this.#authorized = true;
      try {
        const result = fn();
        if (isThenable(result))
          throw new ClayError("E_STALE_WRITE_EPOCH", "live write authority must be synchronous");
        return result;
      } finally {
        this.#authorized = false;
      }
    });
  }

  close(): void {
    this.#inner.close();
  }

  snapshot(): Promise<DbDriver> {
    return this.#inner.snapshot();
  }

  exportDatabases(): Promise<{ user: Uint8Array; system: Uint8Array }> {
    return this.#inner.exportDatabases();
  }
}

export type LiveWriteAuthority = Readonly<{
  run<T>(fn: () => T): T;
}>;

export type LiveWriteSession = Readonly<{
  driver: DbDriver;
  authority: LiveWriteAuthority;
}>;

export function createLiveWriteGuard(inner: DbDriver): LiveWriteSession {
  const controller = new LiveWriteGuard(inner);
  const driver: DbDriver = Object.freeze({
    exec: controller.exec.bind(controller),
    select: controller.select.bind(controller),
    tx: controller.tx.bind(controller),
    close: controller.close.bind(controller),
    snapshot: controller.snapshot.bind(controller),
    exportDatabases: controller.exportDatabases.bind(controller),
  });
  const authority: LiveWriteAuthority = Object.freeze({
    run: controller.runAuthorized.bind(controller),
  });
  return Object.freeze({ driver, authority });
}
