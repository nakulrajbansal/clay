import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { assertStandaloneModules } from "../../shell/config/standalone-validators.mjs";
const runtime = "packages/schema/src/standalone/runtime.mjs";
const chunk = (id, file = "validation-runtime.js", rendered = 1) => ({ file, modules: [{ id, rendered }] });

it("rejects old, duplicate, missing and cross-realm authoring runtimes", () => {
  for (const id of ["node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js", "packages/schema/src/catalog.ts", "packages/schema/src/validation-runtime.ts"])
    expect(() => assertStandaloneModules([chunk(runtime), chunk(id)])).toThrow(/Authoring/);
  expect(() => assertStandaloneModules([chunk(runtime), chunk(runtime, "duplicate.js")])).toThrow(/Duplicated/);
  expect(() => assertStandaloneModules([])).toThrow(/Missing/);
  expect(() => assertStandaloneModules([chunk(runtime), chunk(runtime)])).not.toThrow();
  expect(() => assertStandaloneModules([chunk(runtime), chunk("packages/schema/src/catalog.ts", "empty.js", 0)])).not.toThrow();
});
it("keeps the actual production module graph free of authoring schemas and Zod", async () => {
  const report = JSON.parse(await readFile(new URL("../../../test-results/fix-batch/bundle-modules.json", import.meta.url), "utf8"));
  expect(report.kind).toBe("build_module_diagnostic_not_certification");
  assertStandaloneModules(report.chunks);
});
