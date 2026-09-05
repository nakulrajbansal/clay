import { describe, expect, it } from "vitest";
import { ClayError, createSystemTables, openMemoryDriver } from "../src/index";
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
