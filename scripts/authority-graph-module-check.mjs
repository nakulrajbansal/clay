// Additional source-bound architecture assertion, not a budget collector or certificate.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function assertAuthorityGraphModules(report) {
  if (report?.kind !== "build_module_diagnostic_not_certification" || !Array.isArray(report.chunks))
    throw new Error("Expected actual production module report");
  const graph = [];
  for (const chunk of report.chunks) for (const entry of chunk.modules) {
    const id = entry.id.replaceAll("\\", "/");
    if (entry.rendered > 0 && /(?:^|\/)packages\/kernel\/test\//.test(id))
      throw new Error("Test/oracle module reached production");
    if (id === "packages/kernel/src/authority-graph.ts" && entry.rendered > 0) {
      if (chunk.runtime !== "worker") throw new Error("Authority graph escaped the DB worker");
      graph.push(chunk.file);
    }
  }
  if (graph.length !== 1) throw new Error("Expected exactly one worker AuthorityGraph module");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = JSON.parse(await readFile(new URL("../test-results/fix-batch/bundle-modules.json", import.meta.url), "utf8"));
  assertAuthorityGraphModules(report);
  console.log("PASS AuthorityGraph modules: one worker graph; no shell graph or test oracle");
}
