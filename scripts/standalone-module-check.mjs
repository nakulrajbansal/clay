import { readFile } from "node:fs/promises";
import { assertStandaloneModules } from "../packages/shell/config/standalone-validators.mjs";
const report = JSON.parse(await readFile(new URL("../test-results/fix-batch/bundle-modules.json", import.meta.url), "utf8"));
if (report.kind !== "build_module_diagnostic_not_certification") throw new Error("Expected actual production module report");
assertStandaloneModules(report.chunks);
console.log("PASS standalone modules: no Zod/authoring factories; one shared generated-validator engine");
