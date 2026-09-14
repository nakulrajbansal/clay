// Additional graph assertion, not a substitute for the unchanged size collector.
import { readFile } from "node:fs/promises";
import { assertRendererModules, assertPlannerTransportModules } from "../packages/shell/config/renderer-runtime.mjs";
const report = JSON.parse(await readFile(new URL("../test-results/fix-batch/bundle-modules.json", import.meta.url), "utf8"));
if (report.kind !== "build_module_diagnostic_not_certification") throw new Error("Expected actual production module report");
assertRendererModules(report.chunks);
assertPlannerTransportModules(report.chunks, true);
console.log("PASS renderer modules: one Preact core/hooks/compat/JSX closure; no React, ReactDOM, scheduler or worker renderer");
console.log("PASS planner modules: raw trusted-shell transport; closed worker decoder; no duplicate shell plan parser");
