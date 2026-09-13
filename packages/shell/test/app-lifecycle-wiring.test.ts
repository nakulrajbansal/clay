import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_WORKER_ROUTE_CENSUS } from "../src/worker/mutation-route-census";

const shellRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(shellRoot, "../..");
const source = (relative: string): string =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8");

function caseBody(text: string, route: string): string {
  const marker = `case "${route}"`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const nextCase = text.indexOf("case \"", start + marker.length);
  const nextDefault = text.indexOf("default:", start + marker.length);
  const candidates = [nextCase, nextDefault].filter(index => index >= 0);
  return text.slice(start, candidates.length > 0 ? Math.min(...candidates) : text.length);
}

describe("production app lifecycle wiring", () => {
  it("classifies every app lifecycle mutation as worker-owned authority", () => {
    for (const route of ["createApp", "switchApp", "renameApp", "forkApp", "deleteApp"] as const)
      expect(DB_WORKER_ROUTE_CENSUS[route]).toEqual({
        enforcement: "lifecycle-authority",
        mutates: "lifecycle",
      });
  });

  it("binds import-as-new and its bounded Undo to lifecycle authority", () => {
    expect(DB_WORKER_ROUTE_CENSUS.importNewApp).toEqual({
      enforcement: "lifecycle-authority", mutates: "live",
    });
    expect(DB_WORKER_ROUTE_CENSUS.undoNewAppImport).toEqual({
      enforcement: "lifecycle-authority", mutates: "live",
    });
  });

  it("routes lifecycle requests through ProductionStoreAuthority and republishes boot state", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    for (const route of ["createApp", "switchApp", "renameApp", "forkApp", "deleteApp"])
      expect(caseBody(worker, route), `${route} must execute worker-owned lifecycle`)
        .toContain("runAppLifecycle(");
    expect(worker).toContain("target.executeAppLifecycle(captured)");
    expect(worker).not.toContain("deleteAppStorage(");
  });

  it("keeps durable identity minting out of the presentation cache", () => {
    const apps = source("packages/shell/src/app/apps.ts");
    const shell = source("packages/shell/src/app/App.tsx");
    expect(apps).not.toContain("function uuid(");
    expect(apps).not.toContain("export function createApp(");
    expect(apps).not.toContain("export function addForkEntry(");
    expect(shell).toContain("client().createApp(");
    expect(shell).toContain("client().switchApp(");
    expect(shell).toContain("client().renameApp(");
  });
});
