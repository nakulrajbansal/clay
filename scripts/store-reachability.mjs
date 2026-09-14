// Inventory only. No Store rewriting/plugin or auto-approval of exclusions.
import ts from "../packages/shell/node_modules/typescript/lib/typescript.js";
import { analyzeStoreProgram } from "../packages/shell/config/store-reachability.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssetJavaScriptClosure } from "./bundle-budget-lib.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const report = JSON.parse(await readFile(resolve(root, "test-results/fix-batch/bundle-modules.json"), "utf8"));
if (report.kind !== "build_module_diagnostic_not_certification") throw new Error("Expected production module report");
const entries = report.chunks.filter(c => /^assets\/db-worker-[^.]+\.js$/.test(c.file));
if (entries.length !== 1) throw new Error("Expected exactly one DB entry");
const closure = new Set(await collectAssetJavaScriptClosure(resolve(root, "packages/shell/dist"), entries[0].file));
const modules = new Set(report.chunks.filter(c => closure.has(c.file))
  .flatMap(c => c.modules.filter(m => m.rendered > 0 && m.id.startsWith("packages/") && /\.(?:ts|mjs)$/.test(m.id)).map(m => m.id)));
const configFile = resolve(root, "packages/shell/tsconfig.json");
const config = ts.readConfigFile(configFile, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "packages/shell"));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const store = program.getSourceFiles().find(f => f.fileName.replaceAll("\\", "/").endsWith("/kernel/src/store.ts"));
const graph = analyzeStoreProgram(program, store, modules);
const inputs = {};
for (const path of [...modules, "packages/shell/tsconfig.json", "packages/shell/config/store-reachability.mjs",
  "scripts/store-reachability.mjs", "tsconfig.base.json", "pnpm-lock.yaml",
  "packages/shell/src/worker/mutation-route-census.ts"].sort())
  inputs[path] = createHash("sha256").update((await readFile(resolve(root, path), "utf8")).replaceAll("\r\n", "\n")).digest("hex");
const parser = { version: ts.version, sha256: createHash("sha256").update(
  await readFile(resolve(root, "packages/shell/node_modules/typescript/lib/typescript.js"))).digest("hex") };
const result = { ...graph, parser, inputs, productionOmissions: [],
  // A no-escape result is a necessary condition, not an optimizer permission.
  verdict: graph.escapes.length ? "OMISSION_BLOCKED" : "REQUIRES_INDEPENDENT_CLOSED_CALLER_PROOF" };
if (process.argv.length !== 3 || !["--candidate", "--check"].includes(process.argv[2])) throw new Error("Expected --candidate or --check");
if (process.argv[2] === "--candidate") console.log(JSON.stringify(result, null, 2));
else {
  const expected = JSON.parse(await readFile(resolve(root, "packages/shell/config/store-reachability.json"), "utf8"));
  if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error("Store call graph source drift; no omission authorized");
  console.log(JSON.stringify({ match: true, verdict: result.verdict, nodes: graph.nodes.length,
    referenced: graph.nodes.filter(n => n.reachable).length, escapes: graph.escapes.length, productionOmissions: [] }));
}
