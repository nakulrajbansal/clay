import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Use the installed production toolchain; no dependency or build artifact download.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const resolveDir = fileURLToPath(new URL("../", import.meta.url));
async function compile(contents) {
  const result = await build({ stdin: { contents, resolveDir }, bundle: true,
    write: false, platform: "node", format: "cjs", minify: true });
  const code = result.outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, TextEncoder, TextDecoder });
  return { code, exports: module.exports };
}

describe("schema construction boundaries", () => {
  it("a primitive import does not retain intake, migration or bridge schema construction", async () => {
    const { code, exports } = await compile(`
      import { AppInstanceId } from '@clay/schema';
      export const parse = value => AppInstanceId.safeParse(value);
    `);
    expect(code.includes("only text fields require maxLength")).toBe(false);
    expect(code.includes("create_computed")).toBe(false);
    expect(code.includes("user_gesture")).toBe(false);
    const valid = "app_" + "a".repeat(26);
    expect(exports.parse(valid)).toEqual({ success: true, data: valid });
    for (const value of [null, undefined, {}, 1, valid + "a", valid.toUpperCase(), "app_" + "0".repeat(26)])
      expect(exports.parse(value).success).toBe(false);
  });

  it("staging validation retains closed bounds but not unrelated ledger or intake validators", async () => {
    const { code, exports } = await compile(`
      import { ImportParserChunkSchema } from '../kernel/src/import-staging-contracts.ts';
      export const parse = value => ImportParserChunkSchema.safeParse(value);
    `);
    expect(code.includes("only text fields require maxLength")).toBe(false);
    expect(code.includes("warning reason totals do not balance")).toBe(false);
    expect(code.includes("sheet identifiers must be unique")).toBe(false);
    const value = { sessionId: "import_" + "a".repeat(26), cursor: 0, startRow: 1,
      rows: [["first", "second"]], nextCursor: null, serializedBytes: 20 };
    expect(exports.parse(value)).toEqual({ success: true, data: value });
    for (const invalid of [{ ...value, extra: true }, { ...value, rows: [] },
      { ...value, rows: [["x".repeat(16 * 1024 + 1)]] },
      { ...value, rows: [Array(21).fill("")] }, { ...value, cursor: -1 },
      { ...value, serializedBytes: 1024 * 1024 + 1 }])
      expect(exports.parse(invalid).success).toBe(false);
  });

  it("a backup identifier does not construct catalog, Daily Home or publication contracts", async () => {
    const { code, exports } = await compile(`
      import { BackupId } from '@clay/schema/backup';
      export const parse = value => BackupId.safeParse(value);
    `);
    for (const unused of ["snapshot must contain every source", "publicationCatalogGeneration",
      "schema.convertTextToRelation", "only text fields require maxLength"])
      expect(code.includes(unused), unused).toBe(false);
    expect(exports.parse("bkp_" + "a".repeat(26)).success).toBe(true);
    expect(exports.parse("bkp_" + "0".repeat(26)).success).toBe(false);
  });
});
