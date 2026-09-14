import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

describe("source-bound transition boundary", () => {
  it("pins independent old capture, dispatch, journal and failure behavior", () => {
    for (const [name, expected] of [
      ["production-core-routes", "81a0b0caaa38995b2ef03f6938099315ca54217fb077e171db48e28f3622d92b"],
      ["production-mutation-coordinator", "cbe246a43ee4ff91c6b87ee740c6bb855c167a5146a63e3688cf078561a1ce1d"],
    ]) {
      const bytes = readFileSync(new URL(`./oracles/${name}.ts`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
      expect(bytes.includes('from "../../src/production-core-routes"')).toBe(false);
      expect(bytes.includes("prepareProductionTransition")).toBe(false);
    }
  });
  it("rejects shell/duplicate transition engines and production oracles in an actual module report", async () => {
    const { assertProductionTransitionModules } = await import("../../../scripts/production-transition-module-check.mjs");
    const module = { id: "packages/kernel/src/production-core-routes.ts", rendered: 100 };
    const chunk = { runtime: "worker", file: "assets/worker-authority.js", modules: [module], imports: [], dynamicImports: [] };
    const report = chunks => ({ kind: "build_module_diagnostic_not_certification", chunks });
    expect(() => assertProductionTransitionModules(report([chunk]))).not.toThrow();
    for (const invalid of [report([]), report([{ ...chunk, runtime: "shell" }]), report([chunk, { ...chunk, file: "assets/duplicate.js" }]),
      report([chunk, { ...chunk, modules: [{ id: "packages/kernel/test/oracles/production-mutation-coordinator.ts", rendered: 1 }] }]), {}])
      expect(() => assertProductionTransitionModules(invalid)).toThrow();
  });
  it("keeps transition programs out of WorkerClient commands, public package exports, lifecycle and retired routes", () => {
    for (const file of ["../src/index.ts", "../src/production-app-lifecycle.ts", "../src/production-restore.ts",
      "../../shell/src/app/worker-client.ts", "../../shell/src/worker/mutation-route-census.ts"])
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/ProductionRouteSpec|StoreCommand|prepareProductionTransition/);
    const core = readFileSync(new URL("../src/production-core-routes.ts", import.meta.url), "utf8");
    expect(core).not.toMatch(/\.(exec|select|tx)\s*\(|\b(fetch|eval|Function)\s*\(/);
  });
  it("requires unreachable test fault branches to be absent from production artifacts, not disabled by environment flags", async () => {
    const { assertProductionTransitionArtifact } = await import("../../../scripts/production-transition-module-check.mjs");
    expect(() => assertProductionTransitionArtifact("worker source without an armer")).not.toThrow();
    for (const marker of ["injected after reservation", "injected failure after live mutation", "injected fixed operational mutation failure"])
      expect(() => assertProductionTransitionArtifact(marker)).toThrow(/fault/);
    const source = readFileSync(new URL("../src/production-mutation-coordinator.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/NODE_ENV|import\.meta\.env/);
  });
  it("has one serialized transition queue without changing metrics into canonical mutations", () => {
    const source = readFileSync(new URL("../src/production-mutation-coordinator.ts", import.meta.url), "utf8");
    expect(source.match(/this\.#tail\.then\(/g)).toHaveLength(1);
    expect(source).toContain("#executeOperationalNoOp");
    expect(source).toContain("#executeNoOp");
  });
  it("uses a closed policy kind, not inert strings or switches that could opt out of canonical obligations", async () => {
    const { productionRouteSpec } = await import("../src/production-core-routes");
    expect(Object.keys(productionRouteSpec("panel.rename").policy).sort()).toEqual(["clock", "kind", "native"]);
    expect(Object.isFrozen(productionRouteSpec("panel.rename").policy)).toBe(true);
  });
});
