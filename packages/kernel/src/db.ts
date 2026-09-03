// DbDriver: the kernel's only door to SQLite (doc 02 §3). In the browser
// this lives in the DB worker over OPFS; tests use in-memory databases.
// system.db is ATTACHed as `sys` so one transaction spans DDL + registry +
// version_log (doc 04 §4).
import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { ClayError } from "./errors";

export type SqlValue = string | number | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;

export interface DbDriver {
  exec(sql: string, params?: SqlValue[]): void;
  select(sql: string, params?: SqlValue[]): SqlRow[];
  tx<T>(fn: () => T): T;
  close(): void;
  /** Full copy for the shadow dry-run (S4, doc 05 §1): user.db serialized,
   * system tables row-copied. The copy is independent and disposable. */
  snapshot(): Promise<DbDriver>;
  /** Serialized bytes of both databases (doc 04 §7 export). */
  exportDatabases(): Promise<{ user: Uint8Array; system: Uint8Array }>;
}

export const SYSTEM_TABLES = [
  "tables_registry", "version_log", "panel_blobs", "panel_tombstones",
  "usage_events", "suggestions", "settings", "checkpoints", "attempts", "inactive_cells",
  "operation_batches",
  "automations", "automation_runs", "automation_matches", "record_events", "notifications",
] as const;

let sqlite3Promise: Promise<Sqlite3Static> | null = null;
function sqlite3(): Promise<Sqlite3Static> {
  sqlite3Promise ??= sqlite3InitModule();
  return sqlite3Promise;
}

class SqliteWasmDriver implements DbDriver {
  private depth = 0;
  constructor(private readonly db: Database) {}

  exec(sql: string, params?: SqlValue[]): void {
    try {
      if (params && params.length > 0) this.db.exec({ sql, bind: params });
      else this.db.exec(sql);
    } catch (e) {
      throw new ClayError("E_INTERNAL", `sql failed: ${String(e)}`, { sql });
    }
  }

  select(sql: string, params?: SqlValue[]): SqlRow[] {
    try {
      const rows = params && params.length > 0
        ? this.db.selectObjects(sql, params)
        : this.db.selectObjects(sql);
      return rows as unknown as SqlRow[];
    } catch (e) {
      throw new ClayError("E_INTERNAL", `sql failed: ${String(e)}`, { sql });
    }
  }

  tx<T>(fn: () => T): T {
    const name = `clay_sp_${this.depth++}`;
    this.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      this.exec(`ROLLBACK TO ${name}`);
      this.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }

  async snapshot(): Promise<DbDriver> {
    const s = await sqlite3();
    // user.db: byte-exact serialization of the main schema
    const bytes = exportMain(s, this.db);
    const copy = new s.oo1.DB(":memory:");
    deserializeInto(s, copy, bytes);
    copy.exec("PRAGMA foreign_keys = ON");
    copy.exec("ATTACH ':memory:' AS sys");

    // system.db: fixed table set, row-copied
    const target = new SqliteWasmDriver(copy);
    target.exec(SYSTEM_SCHEMA_SQL);
    for (const table of SYSTEM_TABLES) {
      copyRows(this, `sys.${table}`, target, `sys.${table}`);
    }
    return target;
  }

  async exportDatabases(): Promise<{ user: Uint8Array; system: Uint8Array }> {
    const s = await sqlite3();
    const user = exportMain(s, this.db);
    // system.db: standalone file with UNPREFIXED tables (doc 04 §7 layout)
    const temp = new s.oo1.DB(":memory:");
    const tempDriver = new SqliteWasmDriver(temp);
    tempDriver.exec(systemSchemaSql(""));
    for (const table of SYSTEM_TABLES)
      copyRows(this, `sys.${table}`, tempDriver, `"${table}"`);
    const system = exportMain(s, temp);
    temp.close();
    return { user, system };
  }
}

type Capi = {
  sqlite3_js_db_export(db: unknown, schema?: string): Uint8Array;
  sqlite3_deserialize(db: unknown, schema: string, ptr: number,
    size: number, sizeMax: number, flags: number): number;
  SQLITE_DESERIALIZE_FREEONCLOSE: number;
  SQLITE_DESERIALIZE_RESIZEABLE: number;
};
type Wasm = { allocFromTypedArray(bytes: Uint8Array): number };

function exportMain(s: Sqlite3Static, db: Database): Uint8Array {
  return (s.capi as unknown as Capi).sqlite3_js_db_export(db.pointer);
}

function deserializeInto(s: Sqlite3Static, db: Database, bytes: Uint8Array): void {
  const capi = s.capi as unknown as Capi;
  const wasm = s.wasm as unknown as Wasm;
  const ptr = wasm.allocFromTypedArray(bytes);
  const rc = capi.sqlite3_deserialize(db.pointer, "main", ptr,
    bytes.byteLength, bytes.byteLength,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
  db.checkRc(rc);
}

const SAFE_DB_IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
function dbIdentifier(name: string): string {
  if (!SAFE_DB_IDENTIFIER.test(name))
    throw new Error(`unsafe database identifier '${name}'`);
  return `"${name}"`;
}

function copyRows(from: DbDriver, fromTable: string, to: DbDriver, toTable: string): void {
  for (const row of from.select(`SELECT * FROM ${fromTable}`)) {
    const cols = Object.keys(row);
    if (cols.length === 0) continue;
    to.exec(
      `INSERT INTO ${toTable} (${cols.map(dbIdentifier).join(", ")})
       VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map(c => row[c] ?? null));
  }
}

/** Open an in-memory driver from archive bytes (import staging). */
export async function openDriverFromBytes(
  user: Uint8Array, system: Uint8Array,
): Promise<DbDriver> {
  const s = await sqlite3();
  const db = new s.oo1.DB(":memory:");
  deserializeInto(s, db, user);
  db.exec("PRAGMA trusted_schema = OFF");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("ATTACH ':memory:' AS sys");
  const driver = new SqliteWasmDriver(db);
  driver.exec(SYSTEM_SCHEMA_SQL);

  const temp = new s.oo1.DB(":memory:");
  deserializeInto(s, temp, system);
  temp.exec("PRAGMA trusted_schema = OFF");
  const tempDriver = new SqliteWasmDriver(temp);
  for (const table of SYSTEM_TABLES) {
    const exists = tempDriver.select(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
    if (exists.length > 0) copyRows(tempDriver, `"${table}"`, driver, `sys.${table}`);
  }
  temp.close();
  return driver;
}

/** Canonical, already validated main-database shape used for archive installation. */
export type DatabaseCopyShape = {
  tables: Array<{ name: string; sql: string }>;
  indexes: Array<{ name: string; table: string; column: string }>;
};

function createCanonicalMainInfrastructure(driver: DbDriver): void {
  driver.exec(`CREATE TABLE "row_history"(
    "id" TEXT PRIMARY KEY, "table" TEXT NOT NULL, "row_id" TEXT NOT NULL,
    "at" TEXT NOT NULL, "before_json" TEXT NOT NULL,
    "after_json" TEXT, "batch_id" TEXT, "change_kind" TEXT, "sequence" INTEGER)`);
  driver.exec(`CREATE INDEX "idx_row_history_batch" ON "row_history"("batch_id")`);
  driver.exec(`CREATE UNIQUE INDEX "idx_row_history_sequence" ON "row_history"("sequence")`);
  driver.exec(`CREATE TABLE "__clay_attachments"(
    "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL, "sha256" TEXT NOT NULL, "bytes" BLOB NOT NULL,
    "created_at" TEXT NOT NULL, "deleted_at" TEXT)`);
}

/** Atomically replace a target with validated rows and trusted canonical DDL. */
export function copyDatabase(
  from: DbDriver, to: DbDriver, shape: DatabaseCopyShape, verify?: () => void,
): void {
  to.tx(() => {
    const existing = to.select(
      `SELECT type, name FROM main.sqlite_master
       WHERE type IN ('trigger', 'view', 'table') AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END`,
    );
    for (const object of existing) {
      const type = String(object.type).toUpperCase();
      if (type !== "TRIGGER" && type !== "VIEW" && type !== "TABLE")
        throw new Error(`unsafe target object type '${type}'`);
      to.exec(`DROP ${type} ${dbIdentifier(String(object.name))}`);
    }

    for (const table of shape.tables) {
      dbIdentifier(table.name);
      if (!/^CREATE\s+TABLE\b/i.test(table.sql)
          || /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql))
        throw new Error(`unsafe canonical table definition '${table.name}'`);
      to.exec(table.sql);
    }
    createCanonicalMainInfrastructure(to);
    for (const table of shape.tables) {
      const name = dbIdentifier(table.name);
      copyRows(from, `main.${name}`, to, `main.${name}`);
    }
    copyRows(from, `main."row_history"`, to, `main."row_history"`);
    copyRows(from, `main."__clay_attachments"`, to, `main."__clay_attachments"`);
    for (const index of shape.indexes) {
      to.exec(`CREATE INDEX ${dbIdentifier(index.name)} ON ${dbIdentifier(index.table)}(${dbIdentifier(index.column)})`);
    }

    to.exec(SYSTEM_SCHEMA_SQL);
    for (const table of SYSTEM_TABLES) {
      to.exec(`DELETE FROM sys.${dbIdentifier(table)}`);
      copyRows(from, `sys.${dbIdentifier(table)}`, to, `sys.${dbIdentifier(table)}`);
    }
    verify?.();
  });
}

/** In-memory user.db with an in-memory system.db attached as `sys`. */
export async function openMemoryDriver(): Promise<DbDriver> {
  const s = await sqlite3();
  const db = new s.oo1.DB(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("ATTACH ':memory:' AS sys");
  return new SqliteWasmDriver(db);
}

/**
 * Browser (worker) driver: user.db + system.db in OPFS via the sahpool VFS
 * (no COOP/COEP requirement). Falls back to in-memory when OPFS is
 * unavailable — supported but hostile on purpose (doc 04 §8): the shell
 * shows the "your data will not persist" banner when persistent=false.
 */
type PoolUtil = {
  OpfsSAHPoolDb: new (filename: string) => Database;
  wipeFiles(): Promise<number>;
  unlink?(name: string): boolean;
  getCapacity?(): number;
  getFileCount?(): number;
  addCapacity?(n: number): Promise<number>;
};
let activePool: PoolUtil | null = null;

// Every open app consumes 2 pool slots (user.db + system.db), and SQLite
// briefly needs additional slots for journal files during writes. Without
// free headroom, opening one more app — or even the first write in an
// existing one — fails with SQLITE_CANTOPEN. Keep this many slots free.
const POOL_HEADROOM = 6;

async function ensureHeadroom(pool: PoolUtil): Promise<void> {
  if (!pool.getCapacity || !pool.getFileCount || !pool.addCapacity) return;
  try {
    const free = pool.getCapacity() - pool.getFileCount();
    if (free < POOL_HEADROOM) await pool.addCapacity(POOL_HEADROOM - free);
  } catch { /* best effort; the open below will surface a real failure */ }
}

async function openOnPool(pool: PoolUtil, appId?: string): Promise<DbDriver> {
  await ensureHeadroom(pool);
  const files = appFiles(appId);
  const db = new pool.OpfsSAHPoolDb(files.user);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`ATTACH 'file:${files.system}?vfs=opfs-sahpool' AS sys`);
  } catch (e) {
    // Close, or the half-open user.db handle pins a pool slot and blocks
    // every retry that follows.
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
  return new SqliteWasmDriver(db);
}

/** Per-app OPFS filenames (G4 multi-app). The legacy single-app files
 * (/user.db, /system.db) are kept as the "default" app so existing data
 * is never orphaned; additional apps get namespaced files. */
function appFiles(appId?: string): { user: string; system: string } {
  if (!appId || appId === "default") return { user: "/user.db", system: "/system.db" };
  const safe = appId.replace(/[^a-zA-Z0-9_-]/g, "");
  return { user: `/app-${safe}-user.db`, system: `/app-${safe}-system.db` };
}

/** Does this environment actually have the OPFS SyncAccessHandle API? If not,
 * retrying is pointless — the browser genuinely can't persist. (Typed via
 * globalThis so the kernel package needn't pull in DOM lib.) */
function opfsSupported(): boolean {
  try {
    const g = globalThis as unknown as {
      navigator?: { storage?: { getDirectory?: unknown } };
      FileSystemFileHandle?: { prototype?: { createSyncAccessHandle?: unknown } };
    };
    return !!g.navigator?.storage && typeof g.navigator.storage.getDirectory === "function"
      && !!g.FileSystemFileHandle
      && typeof g.FileSystemFileHandle.prototype?.createSyncAccessHandle === "function";
  } catch { return false; }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function openBrowserDriver(
  appId?: string,
): Promise<{ driver: DbDriver; persistent: boolean }> {
  const s = await sqlite3();
  // Reuse an already-installed pool (a second openBrowserDriver in the same
  // worker must not re-install the singleton VFS).
  if (activePool) {
    try {
      return { driver: await openOnPool(activePool, appId), persistent: true };
    } catch { /* fall through to (re)install */ }
  }
  if (!opfsSupported()) {
    return { driver: await openMemoryDriver(), persistent: false };
  }
  const withPool = s as unknown as {
    installOpfsSAHPoolVfs(opts?: { name?: string; initialCapacity?: number }): Promise<PoolUtil>;
  };
  // The sahpool VFS holds an exclusive lock; on a reload-based app switch a new
  // worker can briefly race the old one releasing it. Retry with backoff
  // before giving up on persistence (the common cause of a spurious banner).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const pool = await withPool.installOpfsSAHPoolVfs({ initialCapacity: 24 });
      activePool = pool;
      return { driver: await openOnPool(pool, appId), persistent: true };
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await sleep(250 * (attempt + 1));   // 250,500,750,1000ms
    }
  }
  console.warn("[clay] OPFS persistence unavailable after retries:", lastErr);
  return { driver: await openMemoryDriver(), persistent: false };
}

/** Erase ALL OPFS databases (full "start over"; caller closes stores and
 * reboots). Returns false when nothing was persistent. */
export async function wipeBrowserStorage(): Promise<boolean> {
  if (!activePool) return false;
  await activePool.wipeFiles();
  return true;
}

/** Delete one app's OPFS files (G4). The app must not be the currently
 * open one (caller closes its store first). Best-effort. */
export async function deleteAppStorage(appId: string): Promise<void> {
  if (!activePool?.unlink) return;
  const files = appFiles(appId);
  try { activePool.unlink(files.user); } catch { /* already gone */ }
  try { activePool.unlink(files.system); } catch { /* already gone */ }
}

export function systemSchemaSql(prefix: string): string {
  return SYSTEM_SCHEMA_SQL.replaceAll("sys.", prefix);
}

export const SYSTEM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sys.tables_registry(
  table_name TEXT PRIMARY KEY, version INTEGER NOT NULL,
  spec_json TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sys.version_log(
  version INTEGER PRIMARY KEY, parent INTEGER NOT NULL,
  created_at TEXT NOT NULL, intent_text TEXT NOT NULL, summary TEXT NOT NULL,
  diff_json TEXT NOT NULL, migration_json TEXT, inverse_json TEXT);
CREATE TABLE IF NOT EXISTS sys.panel_blobs(
  version INTEGER NOT NULL, panel_id TEXT NOT NULL, code TEXT NOT NULL,
  placement_json TEXT NOT NULL, declared_q_json TEXT NOT NULL,
  PRIMARY KEY(version, panel_id));
CREATE TABLE IF NOT EXISTS sys.panel_tombstones(
  version INTEGER NOT NULL, panel_id TEXT NOT NULL,
  PRIMARY KEY(version, panel_id));
CREATE TABLE IF NOT EXISTS sys.usage_events(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL,
  subject TEXT, detail_json TEXT);
CREATE TABLE IF NOT EXISTS sys.suggestions(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT,
  state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sys.settings(
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sys.checkpoints(
  version INTEGER PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sys.attempts(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, intent_text TEXT NOT NULL,
  outcome TEXT NOT NULL, error_code TEXT);
CREATE TABLE IF NOT EXISTS sys.inactive_cells(
  table_name TEXT NOT NULL, column_name TEXT NOT NULL, row_id TEXT NOT NULL,
  PRIMARY KEY(table_name, column_name, row_id));
CREATE TABLE IF NOT EXISTS sys.operation_batches(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL,
  summary TEXT NOT NULL, changed_count INTEGER NOT NULL,
  created_json TEXT NOT NULL, undone_at TEXT);
CREATE TABLE IF NOT EXISTS sys.automations(
  id TEXT PRIMARY KEY, definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sys.automation_runs(
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, at TEXT NOT NULL,
  trigger_key TEXT NOT NULL, status TEXT NOT NULL,
  matched_count INTEGER NOT NULL, changed_count INTEGER NOT NULL,
  batch_id TEXT, error_code TEXT, undone_at TEXT,
  UNIQUE(automation_id, trigger_key));
CREATE TABLE IF NOT EXISTS sys.automation_matches(
  automation_id TEXT NOT NULL, row_id TEXT NOT NULL,
  PRIMARY KEY(automation_id, row_id));
CREATE TABLE IF NOT EXISTS sys.record_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
  table_name TEXT NOT NULL, row_id TEXT NOT NULL, kind TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL, origin TEXT NOT NULL, row_json TEXT);
CREATE TABLE IF NOT EXISTS sys.notifications(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, automation_id TEXT NOT NULL,
  run_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  table_name TEXT, row_id TEXT, read_at TEXT, dismissed_at TEXT);
CREATE INDEX IF NOT EXISTS sys.idx_record_events_table_seq
  ON record_events(table_name, seq);
CREATE INDEX IF NOT EXISTS sys.idx_automation_runs_rule
  ON automation_runs(automation_id, at);
CREATE TABLE IF NOT EXISTS sys.private_metric_state(
  id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL,
  collection_enabled INTEGER NOT NULL, first_ready_day INTEGER,
  first_keep_day INTEGER, first_keep_elapsed_bucket INTEGER,
  ever_activated INTEGER NOT NULL, ever_proof_loop INTEGER NOT NULL,
  proof_loop_elapsed_bucket INTEGER, d14_strict INTEGER, d14_window INTEGER);
CREATE TABLE IF NOT EXISTS sys.private_metric_daily(
  day_utc INTEGER NOT NULL, metric_code INTEGER NOT NULL,
  variant_code INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY(day_utc, metric_code, variant_code));
`;

export function createSystemTables(driver: DbDriver): void {
  driver.exec(SYSTEM_SCHEMA_SQL);
}
