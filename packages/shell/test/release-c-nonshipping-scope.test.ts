import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_WORKER_ROUTE_CENSUS } from "../src/worker/mutation-route-census";

const shellRoot = path.resolve(import.meta.dirname, "..");
const source = (relative: string): string =>
  fs.readFileSync(path.join(shellRoot, relative), "utf8");

describe("Release C shipping scope gate", () => {
  it("C-NFR-022 exposes the reviewed wizard while keeping source cells out of commit RPC", () => {
    const app = source("src/app/App.tsx");
    const data = source("src/app/DataView.tsx");
    const wizard = source("src/app/ImportWizard.tsx");
    const client = source("src/app/worker-client.ts");

    expect(data).toContain("<ImportWizard");
    expect(data).toContain("Import data");
    expect(app).toContain("appInstanceId={currentId}");
    expect(wizard).toContain('new URL("../worker/release-c/import-worker.ts"');
    expect(wizard).toContain("ReleaseCParserWorkerClient");
    expect(wizard).toContain("Paste cells");
    expect(wizard).toContain("CSV file");
    expect(wizard).toContain("Review warnings");
    expect(wizard).toContain("Confirm import");
    expect(wizard).toContain("Undo import");
    const commitMethod = client.slice(client.indexOf("commitImport(input:"),
      client.indexOf("cancelImport(", client.indexOf("commitImport(input:")));
    expect(commitMethod).not.toMatch(/rows|cells|sourceBytes|file/);
  });

  it("routes staged analysis and authoritative commit/undo as closed worker operations", () => {
    expect(DB_WORKER_ROUTE_CENSUS).toMatchObject({
      beginImport: { enforcement: "ephemeral", mutates: "none" },
      stageImportChunk: { enforcement: "ephemeral", mutates: "none" },
      importStructure: { enforcement: "read", mutates: "none" },
      configureImport: { enforcement: "ephemeral", mutates: "none" },
      previewImport: { enforcement: "read", mutates: "none" },
      commitImport: { enforcement: "authority", mutates: "live" },
      cancelImport: { enforcement: "ephemeral", mutates: "none" },
      undoImport: { enforcement: "authority", mutates: "live" },
    });
    const worker = source("src/worker/db-worker.ts");
    expect(worker).toContain('import("./release-c/import-session-coordinator")');
    expect(worker).toContain("new Coordinator(mustAuthority())");
    expect(worker).toContain('case "commitImport"');
    expect(worker).toContain('case "undoImport"');
  });

  it("retains the browser parser harness and removes the old truncating parser", () => {
    const repoRoot = path.resolve(shellRoot, "../..");
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["verify:release-c-parser"])
      .toBe("node scripts/release-c-parser-harness/run.mjs");
    expect(fs.existsSync(path.join(repoRoot, "scripts/release-c-parser-harness/index.html")))
      .toBe(true);
    expect(fs.existsSync(path.join(shellRoot, "src/app/importData.ts"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "scripts/importflow.mjs"))).toBe(false);
  });

  it("keeps the legacy unpreviewed import command unavailable", () => {
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
