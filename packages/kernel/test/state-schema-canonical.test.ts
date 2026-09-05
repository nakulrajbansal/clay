import { describe, expect, it } from "vitest";
import { openMemoryDriver } from "../src/index";
import { canonicalTableSchemaFieldsV1 } from "../src/canonical-state";

async function table(ddl: string) {
  const driver = await openMemoryDriver();
  driver.exec(ddl);
  return driver;
}

describe("canonical SQLite table schema framing", () => {
  it("accepts only the closed generated main-table grammar", async () => {
    const quoted = await table(`CREATE TABLE "sample"(
      "id" TEXT PRIMARY KEY,
      "note" TEXT
    )`);
    const lowercase = await table("create table sample(id text primary key,note text)");
    const distinct = await table("CREATE TABLE sample(id TEXT PRIMARY KEY,note TEXT NOT NULL)");
    const defaulted = await table("CREATE TABLE sample(id TEXT PRIMARY KEY,note TEXT DEFAULT 'a  b')");
    const descending = await table("CREATE TABLE sample(id INTEGER PRIMARY KEY DESC,note TEXT)");
    const collated = await table("CREATE TABLE sample(id TEXT PRIMARY KEY,note TEXT COLLATE NOCASE)");
    const unicodeType = await table("CREATE TABLE sample(id \u0131NTEGER PRIMARY KEY,note TEXT)");
    const systemPlain = await table("CREATE TABLE sys.sample_system(id INTEGER PRIMARY KEY)");
    const systemChecked = await table("CREATE TABLE sys.sample_system(id INTEGER PRIMARY KEY CHECK(id > 0))");
    try {
      const expected = canonicalTableSchemaFieldsV1(quoted, "main", "sample");
      expect(canonicalTableSchemaFieldsV1(lowercase, "main", "sample")).toEqual(expected);
      expect(canonicalTableSchemaFieldsV1(distinct, "main", "sample")).not.toEqual(expected);
      expect(() => canonicalTableSchemaFieldsV1(defaulted, "main", "sample")).toThrow();
      expect(() => canonicalTableSchemaFieldsV1(descending, "main", "sample")).toThrow();
      expect(() => canonicalTableSchemaFieldsV1(collated, "main", "sample")).toThrow();
      expect(() => canonicalTableSchemaFieldsV1(unicodeType, "main", "sample")).toThrow();
      expect(canonicalTableSchemaFieldsV1(systemChecked, "sys", "sample_system"))
        .not.toEqual(canonicalTableSchemaFieldsV1(systemPlain, "sys", "sample_system"));
    } finally {
      quoted.close();
      lowercase.close();
      distinct.close();
      defaulted.close();
      descending.close();
      collated.close();
      unicodeType.close();
      systemPlain.close();
      systemChecked.close();
    }
  });
});
