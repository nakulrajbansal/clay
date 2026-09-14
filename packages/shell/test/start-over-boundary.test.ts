import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { productionWorkerRouteAvailable } from "../src/worker/mutation-route-census";

it("start over cannot erase OPFS or bypass lifecycle authority after worker failure", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  expect(source.includes("wipeOpfsWithoutWorker")).toBe(false);
  expect(source.includes("root.removeEntry")).toBe(false);
  const reset = source.slice(source.indexOf("const resetApp ="), source.indexOf("const removeSamples ="));
  expect(reset).toContain("newApp()");
  expect(reset).toContain("Your existing apps and their data will be kept");
  expect(reset).not.toContain(".reset(");
  expect(reset).not.toContain("removeItem");
});

it("offers authenticated restore-as-new while replacement reset/import routes remain retired", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  expect(productionWorkerRouteAvailable("restoreAsNew")).toBe(true);
  expect(productionWorkerRouteAvailable("reset")).toBe(false);
  expect(productionWorkerRouteAvailable("importArchive")).toBe(false);
  expect(source.includes('productionWorkerRouteAvailable("restoreAsNew") ? restoreAsNew : undefined')).toBe(true);
});
