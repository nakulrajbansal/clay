import { describe, expect, it } from "vitest";
import { ClayError, openMemoryDriver, type DbDriver } from "../src/index";
import { StateMerkleIndex } from "../src/state-merkle-index";
import type { StateLeafFieldV1 } from "../src/state-merkle";

const rowFields = (title: string): StateLeafFieldV1[] => [
  { name: "done", kind: "integer", value: "0" },
  { name: "title", kind: "text", value: title },
];

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ClayError);
  expect((thrown as ClayError).code).toBe(code);
}

describe("target-owned state Merkle index", () => {
  it("initializes fixed buckets and incrementally updates only affected roots", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      const index = StateMerkleIndex.initialize(driver, [
        { key: "row/tbl_abc/rec_123", fields: rowFields("First") },
        { key: "schema/table/tbl_abc", fields: [{ name: "name", kind: "text", value: "Projects" }] },
      ]);
      const initial = index.audit();
      expect(initial.schema).toBe(1);
      expect(initial.bucketRoots).toHaveLength(1024);
      expect(initial.leafCount).toBe(2);
      expect(driver.select("SELECT count(*) AS n FROM sys.state_digest_buckets"))
        .toEqual([{ n: 1024 }]);

      const untouchedBefore = initial.bucketRoots[882];
      const result = index.apply([{ key: "row/tbl_abc/rec_123", fields: rowFields("Changed") }]);
      expect(result).toMatchObject({ changed: true, touchedBuckets: [743], upserted: 1, deleted: 0 });
      const changed = index.audit();
      expect(changed.stateSha256).toBe(result.stateSha256);
      expect(changed.stateSha256).not.toBe(initial.stateSha256);
      expect(changed.bucketRoots[882]).toBe(untouchedBefore);
    } finally {
      driver.close();
    }
  });

  it("performs no SQL write for an identical upsert or missing delete", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      const fields = rowFields("Unchanged");
      const index = StateMerkleIndex.initialize(driver, [{ key: "row/tbl_abc/rec_123", fields }]);
      const before = index.audit();
      const changesBefore = Number(driver.select("SELECT total_changes() AS n")[0]!.n);
      expect(index.apply([
        { key: "row/tbl_abc/rec_123", fields },
        { key: "row/tbl_abc/missing", fields: null },
      ])).toEqual({
        changed: false,
        stateSha256: before.stateSha256,
        touchedBuckets: [],
        upserted: 0,
        deleted: 0,
      });
      expect(Number(driver.select("SELECT total_changes() AS n")[0]!.n)).toBe(changesBefore);
    } finally {
      driver.close();
    }
  });

  it("rejects duplicate change keys before writing", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      const index = StateMerkleIndex.initialize(driver, [
        { key: "row/tbl_abc/rec_123", fields: rowFields("First") },
      ]);
      expectCode(() => index.apply([
        { key: "row/tbl_abc/rec_123", fields: rowFields("A") },
        { key: "row/tbl_abc/rec_123", fields: rowFields("B") },
      ]), "E_STATE_DIGEST_INVALID");
    } finally {
      driver.close();
    }
  });

  it("rejects a well-formed bucket root that disagrees with its leaves", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, [
        { key: "row/tbl_abc/rec_123", fields: rowFields("First") },
      ]);
      driver.exec("UPDATE sys.state_digest_buckets SET root_sha256=? WHERE bucket=743",
        [`sha256:${"f".repeat(64)}`]);
      expectCode(() => StateMerkleIndex.open(driver), "E_STATE_DIGEST_INVALID");
    } finally {
      driver.close();
    }
  });

  it("rejects a missing root table in an otherwise fresh schema", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, []);
      driver.exec("DROP TABLE sys.state_digest_root");
      expectCode(() => StateMerkleIndex.open(driver), "E_STATE_DIGEST_INVALID");
    } finally {
      driver.close();
    }
  });

  it("declares persisted leaf identity as NOT NULL", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      const columns = driver.select(
        "SELECT name, `notnull` AS required FROM pragma_table_info('state_digest_leaves','sys')",
      );
      expect(columns.find(column => column.name === "leaf_key")?.required).toBe(1);
    } finally {
      driver.close();
    }
  });

  it("rejects a non-text leaf identity before string coercion", async () => {
    const raw = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(raw);
      StateMerkleIndex.initialize(raw, [{ key: "null", fields: rowFields("Literal key") }]);
      const corrupt = new Proxy(raw, {
        get(target, property) {
          if (property === "select") return (sql: string, params?: Parameters<DbDriver["select"]>[1]) => {
            const rows = target.select(sql, params);
            return sql.includes("FROM sys.state_digest_leaves ORDER BY leaf_key")
              ? rows.map(row => ({ ...row, leaf_key: null }))
              : rows;
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DbDriver;
      expectCode(() => StateMerkleIndex.open(corrupt), "E_STATE_DIGEST_INVALID");
    } finally {
      raw.close();
    }
  });

  it("rejects a no-op when an untouched bucket disagrees with the stored state root", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      const index = StateMerkleIndex.initialize(driver, [
        { key: "row/tbl_abc/rec_123", fields: rowFields("First") },
        { key: "row/tbl_abc/rec_999", fields: rowFields("Other") },
      ]);
      driver.exec("UPDATE sys.state_digest_buckets SET root_sha256=? WHERE bucket=882",
        [`sha256:${"f".repeat(64)}`]);
      expectCode(() => index.apply([{
        key: "row/tbl_abc/rec_123", fields: rowFields("First"),
      }]), "E_STATE_DIGEST_INVALID");
    } finally {
      driver.close();
    }
  });

  it("rejects executable objects outside the closed Merkle schema", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, []);
      driver.exec(`CREATE TRIGGER sys.state_digest_side_effect
        AFTER UPDATE ON state_digest_root BEGIN DELETE FROM state_digest_leaves; END`);
      expectCode(() => StateMerkleIndex.open(driver), "E_STATE_DIGEST_INVALID");
    } finally {
      driver.close();
    }
  });

  it("rolls back every index row when initialization read-back fails", async () => {
    const raw = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(raw);
      let swallowed = false;
      const failing = new Proxy(raw, {
        get(target, property) {
          if (property === "exec") return (sql: string, params?: Parameters<DbDriver["exec"]>[1]) => {
            if (!swallowed && sql.startsWith("INSERT INTO sys.state_digest_root")) {
              swallowed = true;
              return;
            }
            target.exec(sql, params);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DbDriver;
      expectCode(() => StateMerkleIndex.initialize(failing, [
        { key: "row/tbl_abc/rec_123", fields: rowFields("Before") },
      ]), "E_STATE_DIGEST_INVALID");
      expect(swallowed).toBe(true);
      expect(raw.select(
        `SELECT (SELECT count(*) FROM sys.state_digest_leaves)
              + (SELECT count(*) FROM sys.state_digest_buckets)
              + (SELECT count(*) FROM sys.state_digest_root) AS n`,
      )).toEqual([{ n: 0 }]);
    } finally {
      raw.close();
    }
  });

  it.each([
    ["insert", "INSERT INTO sys.state_digest_leaves"],
    ["update", "INSERT INTO sys.state_digest_leaves"],
    ["delete", "DELETE FROM sys.state_digest_leaves"],
  ] as const)("rolls back when a leaf %s is silently omitted", async (kind, sqlPrefix) => {
    const raw = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(raw);
      const seed = { key: "row/tbl_abc/rec_123", fields: rowFields("Before") };
      const initialized = StateMerkleIndex.initialize(raw, [seed]);
      const before = initialized.audit();
      const change = kind === "insert"
        ? { key: "row/tbl_abc/rec_999", fields: rowFields("Inserted") }
        : kind === "update"
          ? { key: seed.key, fields: rowFields("After") }
          : { key: seed.key, fields: null };
      let swallowed = false;
      const failing = new Proxy(raw, {
        get(target, property) {
          if (property === "exec") return (sql: string, params?: Parameters<DbDriver["exec"]>[1]) => {
            if (!swallowed && sql.startsWith(sqlPrefix)) {
              swallowed = true;
              return;
            }
            target.exec(sql, params);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DbDriver;
      const index = StateMerkleIndex.open(failing);
      expectCode(() => index.apply([change]), "E_STATE_DIGEST_INVALID");
      expect(swallowed).toBe(true);
      expect(StateMerkleIndex.open(raw).audit()).toEqual(before);
    } finally {
      raw.close();
    }
  });

  it("rolls back a changed leaf when an affected bucket publication is lost", async () => {
    const raw = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(raw);
      const original = StateMerkleIndex.initialize(raw, [
        { key: "row/tbl_abc/rec_123", fields: rowFields("Before") },
      ]).audit();
      let swallowed = false;
      const failing = new Proxy(raw, {
        get(target, property) {
          if (property === "exec") return (sql: string, params?: Parameters<DbDriver["exec"]>[1]) => {
            if (!swallowed && sql.startsWith("UPDATE sys.state_digest_buckets")) {
              swallowed = true;
              return;
            }
            target.exec(sql, params);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DbDriver;
      const index = StateMerkleIndex.open(failing);
      expectCode(() => index.apply([
        { key: "row/tbl_abc/rec_123", fields: rowFields("After") },
      ]), "E_STATE_DIGEST_INVALID");
      expect(swallowed).toBe(true);
      expect(StateMerkleIndex.open(raw).audit()).toEqual(original);
    } finally {
      raw.close();
    }
  });

  it("maps malformed changes to the closed state-digest error", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      const index = StateMerkleIndex.initialize(driver, []);
      expectCode(() => index.apply([{
        key: "bad key with spaces",
        fields: rowFields("Invalid"),
      }]), "E_STATE_DIGEST_INVALID");
    } finally {
      driver.close();
    }
  });

  it("updates one leaf in a 5,000-leaf target within the kernel scale budget", async () => {
    const driver = await openMemoryDriver();
    try {
      StateMerkleIndex.createSchema(driver);
      const seeds = Array.from({ length: 5_000 }, (_, index) => ({
        key: `row/tbl_scale/rec_${String(index).padStart(5, "0")}`,
        fields: rowFields(`Record ${index}`),
      }));
      const index = StateMerkleIndex.initialize(driver, seeds);
      const started = performance.now();
      const result = index.apply([{
        key: "row/tbl_scale/rec_02500",
        fields: rowFields("Changed once"),
      }]);
      const elapsed = performance.now() - started;
      expect(result.changed).toBe(true);
      expect(result.touchedBuckets).toHaveLength(1);
      expect(elapsed, "one Merkle leaf update at 5k leaves").toBeLessThan(300);
    } finally {
      driver.close();
    }
  }, 15_000);
});
