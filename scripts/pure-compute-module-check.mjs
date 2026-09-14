import { readFile } from "node:fs/promises";
import { collectAssetJavaScriptClosure } from "./bundle-budget-lib.mjs";
import { assertPureComputeModules } from "../packages/shell/config/pure-compute-boundary.mjs";
const root = new URL("../packages/shell/dist/", import.meta.url);
const report = JSON.parse(await readFile(new URL("../test-results/fix-batch/bundle-modules.json", import.meta.url), "utf8"));
if (report.kind !== "build_module_diagnostic_not_certification") throw new Error("Expected real module report");
const compute = report.chunks.filter(c => /^assets\/pure-compute-worker-[^.]+\.js$/.test(c.file));
const database = report.chunks.filter(c => /^assets\/db-worker-[^.]+\.js$/.test(c.file));
if (compute.length !== 1 || database.length !== 1) throw new Error("Expected exactly one DB and pure compute entry");
const { fileURLToPath } = await import("node:url");
const closure = async file => new Set(await collectAssetJavaScriptClosure(fileURLToPath(root), file));
const computeFiles = await closure(compute[0].file), dbFiles = await closure(database[0].file);
for (const chunk of report.chunks) {
  const ids = chunk.modules.filter(m => m.rendered > 0).map(m => m.id);
  if (computeFiles.has(chunk.file)) assertPureComputeModules(ids);
  if (dbFiles.has(chunk.file) && ids.some(id => /\/shells\/seed(?:-panels)?\.ts$/.test(id)))
    throw new Error("Starter implementation still reaches DB authority closure");
}
console.log("PASS pure compute module boundary: one stateless worker; no seed implementation in DB closure");
