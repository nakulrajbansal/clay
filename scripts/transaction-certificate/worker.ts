import sqlite3InitModule from "../../packages/kernel/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs";

const VFS = "clay-cert-sahpool";
const MAIN = "/cert-main.db";
const SYSTEM = "/cert-system.db";
const CATALOG = "/cert-catalog.db";

let pool;

function openDatabases() {
  const db = new pool.OpfsSAHPoolDb(MAIN);
  db.exec(`ATTACH 'file:${SYSTEM}?vfs=${VFS}' AS sys`);
  db.exec(`ATTACH 'file:${CATALOG}?vfs=${VFS}' AS cat`);
  return db;
}

function close(db) {
  try { db.close(); } catch { /* worker termination may already own cleanup */ }
}

function put(db, schema, value) {
  db.exec(`UPDATE ${schema}.cert_state SET value = ? WHERE id = 1`, { bind: [value] });
}

function replace(db, schema, value) {
  db.exec(`DELETE FROM ${schema}.cert_state`);
  db.exec(`INSERT INTO ${schema}.cert_state VALUES(1, ?)`, { bind: [value] });
}

async function pauseAt(selected, point) {
  if (selected !== point) return;
  postMessage({ type: "reached", point });
  await new Promise(() => {});
}

async function handle(payload) {
  const db = openDatabases();
  try {
    if (payload.op === "reset") {
      db.exec(`
        CREATE TABLE IF NOT EXISTS main.cert_state(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sys.cert_state(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cat.cert_state(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      `);
      db.exec("BEGIN IMMEDIATE");
      db.exec("DROP TABLE IF EXISTS main.cert_shape");
      replace(db, "main", payload.value);
      replace(db, "sys", payload.value);
      replace(db, "cat", payload.value);
      db.exec("COMMIT");
      close(db);
      postMessage({ type: "result", value: true });
      return;
    }
    if (payload.op === "mutate") {
      db.exec("BEGIN IMMEDIATE");
      await pauseAt(payload.failpoint, "after_begin");
      db.exec("CREATE TABLE main.cert_shape(value TEXT NOT NULL)");
      await pauseAt(payload.failpoint, "after_schema_create");
      db.exec("INSERT INTO main.cert_shape VALUES(?)", { bind: [payload.value] });
      await pauseAt(payload.failpoint, "after_schema_insert");
      put(db, "main", payload.value);
      await pauseAt(payload.failpoint, "after_main");
      put(db, "sys", payload.value);
      await pauseAt(payload.failpoint, "after_system");
      put(db, "cat", payload.value);
      await pauseAt(payload.failpoint, "after_catalog");
      await pauseAt(payload.failpoint, "before_commit");
      db.exec("COMMIT");
      await pauseAt(payload.failpoint, "after_commit");
      close(db);
      postMessage({ type: "result", value: true });
      return;
    }
    if (payload.op === "read") {
      const shapeExists = Number(db.selectValue(
        "SELECT count(*) FROM main.sqlite_master WHERE type = 'table' AND name = 'cert_shape'",
      ));
      const shapeValue = shapeExists
        ? String(db.selectValue("SELECT value FROM main.cert_shape LIMIT 1")) : null;
      const value = {
        main: String(db.selectValue("SELECT value FROM main.cert_state WHERE id = 1")),
        system: String(db.selectValue("SELECT value FROM sys.cert_state WHERE id = 1")),
        catalog: String(db.selectValue("SELECT value FROM cat.cert_state WHERE id = 1")),
        shapeExists, shapeValue,
        integrity: ["main", "sys", "cat"].map(schema =>
          String(db.selectValue(`PRAGMA ${schema}.integrity_check`))),
        journalMode: ["main", "sys", "cat"].map(schema =>
          String(db.selectValue(`PRAGMA ${schema}.journal_mode`))),
        sqliteSourceId: String(db.selectValue("SELECT sqlite_source_id()")),
      };
      close(db);
      postMessage({ type: "result", value });
      return;
    }
    throw new Error(`unknown operation ${payload.op}`);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not be open */ }
    close(db);
    postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

try {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  pool = await sqlite3.installOpfsSAHPoolVfs({
    name: VFS, directory: "/clay-transaction-certificate", initialCapacity: 24,
  });
  self.onmessage = event => void handle(event.data);
  postMessage({ type: "ready" });
} catch (error) {
  postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
}
