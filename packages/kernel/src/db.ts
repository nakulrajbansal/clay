// DbDriver: the kernel's only door to SQLite (doc 02 §3). In the browser
// this lives in the DB worker over OPFS; tests use in-memory databases.
// system.db is ATTACHed as `sys` so one transaction spans DDL + registry +
// version_log (doc 04 §4).
import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { ClayError } from "./errors";

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface DbDriver {
  exec(sql: string, params?: SqlValue[]): void;
  select(sql: string, params?: SqlValue[]): SqlRow[];
  tx<T>(fn: () => T): T;
  close(): void;
  /** Full copy for the shadow dry-run (S4, doc 05 §1): user.db serialized,
   * system tables row-copied. The copy is independent and disposable. */
  snapshot(): Promise<DbDriver>;
}

export const SYSTEM_TABLES = [
  "tables_registry", "version_log", "panel_blobs", "panel_tombstones",
  "usage_events", "suggestions", "settings", "attempts",
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
    type Capi = {
      sqlite3_js_db_export(db: unknown, schema?: string): Uint8Array;
      sqlite3_deserialize(db: unknown, schema: string, ptr: number,
        size: number, sizeMax: number, flags: number): number;
      SQLITE_DESERIALIZE_FREEONCLOSE: number;
      SQLITE_DESERIALIZE_RESIZEABLE: number;
    };
    type Wasm = { allocFromTypedArray(bytes: Uint8Array): number };
    const capi = s.capi as unknown as Capi;
    const wasm = s.wasm as unknown as Wasm;

    // user.db: byte-exact serialization of the main schema
    const bytes = capi.sqlite3_js_db_export(this.db.pointer);
    const copy = new s.oo1.DB(":memory:");
    const ptr = wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(copy.pointer, "main", ptr,
      bytes.byteLength, bytes.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
    copy.checkRc(rc);
    copy.exec("PRAGMA foreign_keys = ON");
    copy.exec("ATTACH ':memory:' AS sys");

    // system.db: fixed table set, row-copied
    const target = new SqliteWasmDriver(copy);
    target.exec(SYSTEM_SCHEMA_SQL);
    for (const table of SYSTEM_TABLES) {
      for (const row of this.select(`SELECT * FROM sys.${table}`)) {
        const cols = Object.keys(row);
        target.exec(
          `INSERT INTO sys.${table} (${cols.map(c => `"${c}"`).join(", ")})
           VALUES (${cols.map(() => "?").join(", ")})`,
          cols.map(c => row[c] ?? null));
      }
    }
    return target;
  }
}

/** In-memory user.db with an in-memory system.db attached as `sys`. */
export async function openMemoryDriver(): Promise<DbDriver> {
  const s = await sqlite3();
  const db = new s.oo1.DB(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("ATTACH ':memory:' AS sys");
  return new SqliteWasmDriver(db);
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
CREATE TABLE IF NOT EXISTS sys.attempts(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, intent_text TEXT NOT NULL,
  outcome TEXT NOT NULL, error_code TEXT);
`;

export function createSystemTables(driver: DbDriver): void {
  driver.exec(SYSTEM_SCHEMA_SQL);
}
