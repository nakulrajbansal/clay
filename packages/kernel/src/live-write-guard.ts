import type { DbDriver, SqlRow, SqlValue } from "./db";
import { ClayError } from "./errors";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null
    && "then" in value && typeof (value as { then?: unknown }).then === "function";
}

function isReadOnlySelect(sql: string): boolean {
  const statement = sql.trim();
  return /^SELECT\b/i.test(statement) && !statement.includes(";");
}

/**
 * Denies every live SQL exec unless a trusted coordinator opens one synchronous
 * outer transaction. Read traffic remains available, and snapshot() returns an
 * independent disposable database which cannot alter live state or catalog
 * authority.
 */
export class LiveWriteGuard implements DbDriver {
  private authorized = false;

  constructor(private readonly inner: DbDriver) {}

  exec(sql: string, params?: SqlValue[]): void {
    if (!this.authorized)
      throw new ClayError("E_STALE_WRITE_EPOCH", "live write authority is not current");
    this.inner.exec(sql, params);
  }

  select(sql: string, params?: SqlValue[]): SqlRow[] {
    if (!this.authorized && !isReadOnlySelect(sql))
      throw new ClayError("E_STALE_WRITE_EPOCH", "live read channel cannot execute mutation SQL");
    return this.inner.select(sql, params);
  }

  tx<T>(fn: () => T): T {
    return this.inner.tx(fn);
  }

  runAuthorized<T>(fn: () => T): T {
    if (this.authorized)
      throw new ClayError("E_STALE_WRITE_EPOCH", "nested live write authority is not allowed");
    return this.inner.tx(() => {
      this.authorized = true;
      try {
        const result = fn();
        if (isThenable(result))
          throw new ClayError("E_STALE_WRITE_EPOCH", "live write authority must be synchronous");
        return result;
      } finally {
        this.authorized = false;
      }
    });
  }

  close(): void {
    this.inner.close();
  }

  snapshot(): Promise<DbDriver> {
    return this.inner.snapshot();
  }

  exportDatabases(): Promise<{ user: Uint8Array; system: Uint8Array }> {
    return this.inner.exportDatabases();
  }
}
