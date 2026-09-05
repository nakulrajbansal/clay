import { describe, expect, it } from "vitest";
import { ClayError, openMemoryDriver } from "../src/index";
import {
  canonicalContentFieldV1,
  canonicalSqlFieldV1,
} from "../src/state-sql-canonical";

function expectStateError(run: () => unknown): void {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ClayError);
  expect((thrown as ClayError).code).toBe("E_STATE_DIGEST_INVALID");
}

describe("SQLite values in canonical state leaves", () => {
  it("keeps integer, real, text, and null encodings distinct", () => {
    expect(canonicalSqlFieldV1("count", "INTEGER", 42)).toEqual({
      name: "count", kind: "integer", value: "42",
    });
    expect(canonicalSqlFieldV1("ratio", "REAL", 42)).toEqual({
      name: "ratio", kind: "real", value: 42,
    });
    expect(canonicalSqlFieldV1("label", "TEXT", "42")).toEqual({
      name: "label", kind: "text", value: "42",
    });
    expect(canonicalSqlFieldV1("deleted_at", "TEXT", null)).toEqual({
      name: "deleted_at", kind: "null",
    });
  });

  it("normalizes numeric negative zero before integer or real encoding", () => {
    expect(canonicalSqlFieldV1("count", "INTEGER", -0)).toEqual({
      name: "count", kind: "integer", value: "0",
    });
    expect(canonicalSqlFieldV1("ratio", "REAL", -0)).toEqual({
      name: "ratio", kind: "real", value: 0,
    });
  });

  it("encodes the full signed-int64 range returned by SQLite-WASM", async () => {
    const driver = await openMemoryDriver();
    try {
      const row = driver.select(
        `SELECT CAST('-9223372036854775808' AS INTEGER) AS minimum,
                CAST('9223372036854775807' AS INTEGER) AS maximum,
                CAST('9007199254740991' AS INTEGER) AS safe,
                CAST('9007199254740992' AS INTEGER) AS beyond_safe`,
      )[0]!;
      expect(typeof row.minimum).toBe("bigint");
      expect(typeof row.maximum).toBe("bigint");
      expect(canonicalSqlFieldV1("minimum", "INTEGER", row.minimum!)).toEqual({
        name: "minimum", kind: "integer", value: "-9223372036854775808",
      });
      expect(canonicalSqlFieldV1("maximum", "INTEGER", row.maximum!)).toEqual({
        name: "maximum", kind: "integer", value: "9223372036854775807",
      });
      expect(canonicalSqlFieldV1("safe", "INTEGER", row.safe!)).toEqual({
        name: "safe", kind: "integer", value: "9007199254740991",
      });
      expect(canonicalSqlFieldV1("beyond_safe", "INTEGER", row.beyond_safe!)).toEqual({
        name: "beyond_safe", kind: "integer", value: "9007199254740992",
      });
    } finally {
      driver.close();
    }
  });

  it.each([
    ["unsafe integer", "INTEGER", Number.MAX_SAFE_INTEGER + 1],
    ["fractional integer", "INTEGER", 1.5],
    ["text in integer", "INTEGER", "1"],
    ["non-finite real", "REAL", Number.POSITIVE_INFINITY],
    ["number in text", "TEXT", 1],
    ["raw blob", "BLOB", new Uint8Array([1, 2, 3])],
    ["unknown declaration", "NUMERIC", 1],
  ] as const)("fails closed for %s", (_name, declaredType, value) => {
    expectStateError(() => canonicalSqlFieldV1(
      "value", declaredType, value as string | number | Uint8Array,
    ));
  });

  it("uses a bounded content reference instead of attachment bytes", () => {
    expect(canonicalContentFieldV1(
      "content", `sha256:${"a".repeat(64)}`, "10485760",
    )).toEqual({
      name: "content", kind: "content",
      sha256: `sha256:${"a".repeat(64)}`,
      bytes: "10485760",
    });
    expectStateError(() => canonicalContentFieldV1("content", "sha256:no", "1"));
    expectStateError(() => canonicalContentFieldV1(
      "content", `sha256:${"a".repeat(64)}`, "01",
    ));
  });
});
