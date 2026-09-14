// Architecture assertion only. Frozen bundle collectors and measurement are unchanged.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function assertProductionTransitionModules(report) {
  if (report?.kind !== "build_module_diagnostic_not_certification" || !Array.isArray(report.chunks))
    throw new Error("Expected actual production module report");
  const modules = [];
  for (const chunk of report.chunks) for (const entry of chunk.modules) {
    if (entry.rendered <= 0) continue;
    const id = entry.id.replaceAll("\\", "/");
    if (/(?:^|\/)packages\/kernel\/test\//.test(id)) throw new Error("Transition test/oracle reached production");
    if (id === "packages/kernel/src/production-core-routes.ts") {
      if (chunk.runtime !== "worker") throw new Error("Production transitions escaped the worker");
      modules.push(chunk.file);
    }
  }
  if (modules.length !== 1) throw new Error("Expected exactly one worker transition engine");
}
export function assertProductionTransitionArtifact(code) {
  if (typeof code !== "string" || ["injected after reservation", "injected failure after live mutation",
    "injected fixed operational mutation failure"].some(marker => code.includes(marker)))
    throw new Error("Unreachable test fault branch reached production");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = JSON.parse(await readFile(new URL("../test-results/fix-batch/bundle-modules.json", import.meta.url), "utf8"));
  assertProductionTransitionModules(report);
  const coordinators = report.chunks.filter(chunk => chunk.modules.some(entry => entry.rendered > 0
    && entry.id === "packages/kernel/src/production-mutation-coordinator.ts"));
  if (coordinators.length !== 1 || !/^assets\/[A-Za-z0-9_-]+\.js$/.test(coordinators[0].file))
    throw new Error("Expected exactly one emitted coordinator artifact");
  assertProductionTransitionArtifact(await readFile(new URL(`../packages/shell/dist/${coordinators[0].file}`, import.meta.url), "utf8"));
  console.log("PASS production transitions: one worker engine; no shell engine, test oracle or unreachable test fault branch");
}
