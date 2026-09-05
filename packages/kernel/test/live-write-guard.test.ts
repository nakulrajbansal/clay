import { describe, expect, it } from "vitest";
import { ClayError, createSystemTables, openMemoryDriver, type DbDriver } from "../src/index";
import { LiveWriteGuard } from "../src/live-write-guard";

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    expect.fail(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ClayError);
    expect((error as ClayError).code).toBe(code);
  }
}

describe("live SQLite write guard", () => {
  it("denies ambient writes and permits one synchronous outer transaction", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const driver = new LiveWriteGuard(raw);
    try {
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
      expectCode(
        () => driver.select("UPDATE guarded_items SET value = 'bypass' RETURNING id"),
        "E_STALE_WRITE_EPOCH",
      );
      expectCode(
        () => driver.select("PRAGMA writable_schema = ON"),
        "E_STALE_WRITE_EPOCH",
      );
      expectCode(
        () => driver.select("SELECT * FROM guarded_items; DELETE FROM guarded_items"),
        "E_STALE_WRITE_EPOCH",
      );
      expectCode(
        () => driver.exec("INSERT INTO guarded_items VALUES ('ambient', 'denied')"),
        "E_STALE_WRITE_EPOCH",
      );
      expectCode(() => driver.tx(() => {
        driver.exec("INSERT INTO guarded_items VALUES ('nested', 'denied')");
      }), "E_STALE_WRITE_EPOCH");
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);

      driver.runAuthorized(() => {
        driver.exec("INSERT INTO guarded_items VALUES ('allowed', 'committed')");
        driver.tx(() => driver.exec(
          "UPDATE guarded_items SET value = 'nested savepoint' WHERE id = 'allowed'",
        ));
      });
      expect(driver.select("SELECT value FROM guarded_items WHERE id = 'allowed'"))
        .toEqual([{ value: "nested savepoint" }]);
    } finally {
      driver.close();
    }
  });

  it("rejects forwarding wrappers without concrete driver identity", async () => {
    const raw = await openMemoryDriver();
    try {
      const forwarded: DbDriver = {
        exec: raw.exec.bind(raw), select: raw.select.bind(raw), tx: raw.tx.bind(raw),
        close: raw.close.bind(raw), snapshot: raw.snapshot.bind(raw),
        exportDatabases: raw.exportDatabases.bind(raw),
      };
      expectCode(() => new LiveWriteGuard(forwarded), "E_STALE_WRITE_EPOCH");
    } finally { raw.close(); }
  });

  it("rejects opening write authority inside an ambient transaction", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      let escaped = false;
      expectCode(() => driver.tx(() => {
        const receipt = driver.runAuthorized(() => {
          driver.exec("INSERT INTO guarded_items VALUES ('must-rollback')");
          return "SUCCESS_RECEIPT";
        });
        escaped = receipt === "SUCCESS_RECEIPT";
      }), "E_STALE_WRITE_EPOCH");
      expect(escaped).toBe(false);
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it("enforces authority ownership on the physical driver", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      expect(Reflect.ownKeys(driver)).toEqual([]);
      for (const method of ["execute", "query", "control", "internalTx", "isAutocommit"])
        expect(Reflect.get(raw, method), method).toBeUndefined();
      let escaped = false;
      expectCode(() => raw.tx(() => {
        const receipt = driver.runAuthorized(() => {
          driver.exec("INSERT INTO guarded_items VALUES ('must-rollback')");
          return "SUCCESS_RECEIPT";
        });
        escaped = receipt === "SUCCESS_RECEIPT";
      }), "E_STALE_WRITE_EPOCH");
      expect(escaped).toBe(false);
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
      expectCode(
        () => raw.exec("INSERT INTO guarded_items VALUES ('raw-bypass')"),
        "E_STALE_WRITE_EPOCH",
      );
      expectCode(() => driver.runAuthorized(() => {
        raw.exec("INSERT INTO guarded_items VALUES ('raw-during-authority')");
      }), "E_STALE_WRITE_EPOCH");
      for (const [index, statement] of [
        "COMMIT", "ROLLBACK", "ROLLBACK TO clay_sp_0",
        "RELEASE clay_sp_0", "SAVEPOINT nested",
      ].entries()) {
        expectCode(() => driver.runAuthorized(() => {
          driver.exec("INSERT INTO guarded_items VALUES (?)", [`control-${index}`]);
          driver.exec(statement);
        }), "E_STALE_WRITE_EPOCH");
      }
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
      expectCode(() => new LiveWriteGuard(raw), "E_STALE_WRITE_EPOCH");
    } finally {
      driver.close();
    }
  });

  it("keeps authority state private and rejects public transaction control", async () => {
    const raw = await openMemoryDriver();
    try {
      expect(Object.getOwnPropertySymbols(raw).map(String))
        .not.toContain("Symbol(clay.driver-authority-state)");
      expect(Object.keys(raw)).toEqual([]);
      for (const statement of ["BEGIN", "SAVEPOINT raw_outer"])
        expectCode(() => raw.exec(statement), "E_STALE_WRITE_EPOCH");
    } finally {
      raw.close();
    }
  });

  it("rejects sqlite-wasm options objects before they can replace transaction SQL", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      const smuggled = {
        sql: "ROLLBACK; SAVEPOINT clay_sp_0",
        replace: () => "SELECT 1",
      };
      let escaped = false;
      expectCode(() => {
        const receipt = driver.runAuthorized(() => {
          driver.exec("INSERT INTO guarded_items VALUES ('smuggled')");
          (driver.exec as unknown as (sql: unknown) => void)(smuggled);
          return "SUCCESS_RECEIPT";
        });
        escaped = receipt === "SUCCESS_RECEIPT";
      }, "E_STALE_WRITE_EPOCH");
      expect(escaped).toBe(false);
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it("rejects transaction control appended to trigger DDL", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      let escaped = false;
      expectCode(() => {
        const receipt = driver.runAuthorized(() => {
          driver.exec("INSERT INTO guarded_items VALUES ('trigger-smuggled')");
          driver.exec(`CREATE TRIGGER injected AFTER INSERT ON guarded_items
            BEGIN SELECT 1; END; ROLLBACK; SAVEPOINT clay_sp_0`);
          return "SUCCESS_RECEIPT";
        });
        escaped = receipt === "SUCCESS_RECEIPT";
      }, "E_STALE_WRITE_EPOCH");
      expect(escaped).toBe(false);
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
      expect(driver.select(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'injected'",
      )).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it("rejects malformed bind containers before forwarding to sqlite-wasm", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      expectCode(() => driver.runAuthorized(() => {
        (driver.exec as unknown as (sql: unknown, params: unknown) => void)(
          "INSERT INTO guarded_items VALUES (?)", { length: 0 },
        );
      }), "E_STALE_WRITE_EPOCH");
      expectCode(() => driver.runAuthorized(() => {
        (driver.exec as unknown as (sql: unknown, params: unknown) => void)(
          "INSERT INTO guarded_items VALUES (?)", [{}],
        );
      }), "E_STALE_WRITE_EPOCH");
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it("rolls back failures, drops authorization afterward, and rejects async scope", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      expect(() => driver.runAuthorized(() => {
        driver.exec("INSERT INTO guarded_items VALUES ('rolled-back')");
        throw new Error("fail the write");
      })).toThrow("fail the write");
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
      expectCode(() => driver.exec("INSERT INTO guarded_items VALUES ('after')"), "E_STALE_WRITE_EPOCH");
      expectCode(
        () => driver.runAuthorized(() => Promise.resolve("not synchronous")),
        "E_STALE_WRITE_EPOCH",
      );
      expectCode(
        () => driver.runAuthorized(() => driver.runAuthorized(() => undefined)),
        "E_STALE_WRITE_EPOCH",
      );
    } finally {
      driver.close();
    }
  });

  it("rejects callable thenables and rolls back their synchronous writes", async () => {
    const raw = await openMemoryDriver();
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      const callableThenable = Object.assign(
        () => "SUCCESS_RECEIPT",
        { then: (_resolve: unknown, reject: (reason: unknown) => void) =>
          reject(new Error("nested callback rejected")) },
      );
      expectCode(() => driver.runAuthorized(() => {
        driver.exec("INSERT INTO guarded_items VALUES ('committed-before-rejection')");
        return callableThenable;
      }), "E_STALE_WRITE_EPOCH");
      expect(driver.select("SELECT * FROM guarded_items")).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it("returns an independent writable preview snapshot without opening live authority", async () => {
    const raw = await openMemoryDriver();
    createSystemTables(raw);
    raw.exec("CREATE TABLE guarded_items(id TEXT PRIMARY KEY)");
    const driver = new LiveWriteGuard(raw);
    try {
      const preview = await driver.snapshot();
      preview.exec("INSERT INTO guarded_items VALUES ('preview')");
      expect(preview.select("SELECT id FROM guarded_items")).toEqual([{ id: "preview" }]);
      expect(driver.select("SELECT id FROM guarded_items")).toEqual([]);
      preview.close();
      expectCode(() => driver.exec("INSERT INTO guarded_items VALUES ('live')"), "E_STALE_WRITE_EPOCH");
    } finally {
      driver.close();
    }
  });
});
