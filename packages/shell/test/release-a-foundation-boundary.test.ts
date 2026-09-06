import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WorkerClient } from "../src/app/worker-client";

const appSource = await readFile(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/worker/db-worker.ts", import.meta.url), "utf8");

describe("Release A foundation boundary", () => {
  it("fails closed instead of exposing unreserved cross-app import publication", () => {
    expect("createImportedApp" in WorkerClient.prototype).toBe(false);
    expect(appSource).not.toContain("createImportedApp");
    expect(workerSource).not.toContain('case "createImportedApp"');
    expect(appSource).toContain("Safe creation of another imported app is not available yet");
  });

  it("routes file selection through explicit review and never deletes a possibly published retry", () => {
    expect(appSource).toContain("<ImportReview");
    expect(appSource).toContain("onImport={file => void reviewNewAppImport(file)}");
    expect(appSource).not.toContain("onImport={file => void importNewApp(file)}");
    expect(appSource).not.toMatch(/published[\s\S]{0,500}deleteApp\("default"\)/);
    expect(appSource).toContain("Undo import removes only the imported rows");
  });

  it("keeps publication and conflict-safe Undo inside the worker boundary", () => {
    expect(workerSource).toContain('case "activateStarter"');
    expect(workerSource).toContain('case "activateImportedApp"');
    expect(workerSource).toContain('case "firstRunPublication"');
    expect(workerSource).toContain('case "undoFirstRunImport"');
  });

  it("reserves strict sample provenance and rejects the unauthenticated legacy marker", () => {
    expect(workerSource).toContain('"sample_provenance_v1"');
    expect(workerSource).toContain('"sample_rows"');
    expect(workerSource).toContain("reserved worker setting");
  });
});
