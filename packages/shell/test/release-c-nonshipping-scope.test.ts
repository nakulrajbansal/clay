import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_WORKER_ROUTE_CENSUS } from "../src/worker/mutation-route-census";

const shellRoot = path.resolve(import.meta.dirname, "..");
const source = (relative: string): string =>
  fs.readFileSync(path.join(shellRoot, relative), "utf8");

describe("Release C non-shipping scope gate", () => {
  it("C-NFR-022 exposes no ordinary import entrypoint or parser-worker import in production", () => {
    const app = source("src/app/App.tsx");
    const data = source("src/app/DataView.tsx");
    const palette = source("src/app/CommandPalette.tsx");
    const client = source("src/app/worker-client.ts");

    expect(app).not.toContain("parseImportFile");
    expect(app).not.toContain("importFile");
    expect(app).not.toContain("release-c/import-worker");
    expect(app).not.toMatch(/accept=["'][^"']*\.csv/);
    expect(data).not.toContain("onImport:");
    expect(data).not.toMatch(/accept=["'][^"']*\.csv/);
    expect(palette).not.toContain("release-c/import-worker");
    expect(client).not.toMatch(/\bimportTable\s*\(/);
  });

  it("exposes the parser only through an explicit test-time browser harness", () => {
    const repoRoot = path.resolve(shellRoot, "../..");
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["verify:release-c-parser"])
      .toBe("node scripts/release-c-parser-harness/run.mjs");
    expect(fs.existsSync(path.join(repoRoot, "scripts/release-c-parser-harness/index.html")))
      .toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "scripts/release-c-parser-harness/main.ts")))
      .toBe(true);
  });

  it("removes the old main-thread truncating parser and model-coupled import harness", () => {
    const repoRoot = path.resolve(shellRoot, "../..");
    expect(fs.existsSync(path.join(shellRoot, "src/app/importData.ts"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "scripts/importflow.mjs"))).toBe(false);
  });

  it("keeps the legacy canonical import command explicitly unavailable", () => {
    const worker = source("src/worker/db-worker.ts");
    expect(DB_WORKER_ROUTE_CENSUS.importTable).toEqual({
      enforcement: "unavailable", mutates: "live",
    });
    expect(worker.slice(
      worker.indexOf('case "importTable"'),
      worker.indexOf('case "seed"'),
    )).toContain("failClosedMutation(req.op)");
  });
});
