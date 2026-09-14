import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { DB_WORKER_ROUTE_CENSUS } from "../src/worker/mutation-route-census";

const appSource = await readFile(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/worker/db-worker.ts", import.meta.url), "utf8");

describe("Release A foundation boundary", () => {
  it("exposes cross-app import only through a lifecycle-bound blank target", () => {
    expect("createImportedApp" in WorkerClient.prototype).toBe(false);
    expect(appSource).not.toContain("createImportedApp");
    expect(workerSource).not.toContain('case "createImportedApp"');
    expect("importNewApp" in WorkerClient.prototype).toBe(true);
    expect("undoNewAppImport" in WorkerClient.prototype).toBe(true);
    expect(DB_WORKER_ROUTE_CENSUS.importNewApp).toMatchObject({
      enforcement: "lifecycle-authority", mutates: "live",
    });
    expect(workerSource).toContain('case "importNewApp"');
    expect(workerSource).toContain('case "undoNewAppImport"');
    expect(appSource).toContain("client().createApp(");
    expect(appSource).toContain("client().importNewApp(");
  });

  it("routes file selection through explicit review before authority publication", () => {
    expect(appSource).toContain("<ImportReview");
    expect(appSource).toContain("onImport={file => void reviewNewAppImport(file)}");
    expect(appSource).not.toContain("onImport={file => void importNewApp(file)}");
    expect(appSource).not.toMatch(/published[\s\S]{0,500}deleteApp\("default"\)/);
    for (const name of ["activateStarter", "activateImportedApp", "undoFirstRunImport",
      "firstRunPublication"] as const) {
      expect(name in WorkerClient.prototype).toBe(false);
      expect(name in DB_WORKER_ROUTE_CENSUS).toBe(false);
      expect(workerSource).not.toContain(`case "${name}"`);
    }
    expect(workerSource).not.toContain('route: "firstRun.undoImport"');
  });

  it("keeps MVP starter creation on the production seed authority", () => {
    expect(workerSource).toContain('case "seed":');
    expect(workerSource).toContain("const fragment = await seedCompute.seed(p.shellId, source)");
    expect(workerSource).toContain('target.executeMutation({ requestId, route: "starter.seed", payload: fragment }, source)');
    expect(workerSource).not.toContain("createStarterSeedBundle");
    expect(appSource).toContain("firstRunTargetId.current = boot.selectedAppInstanceId");
    expect(appSource).toContain("{ requestId: setup.nameRequestId }, id");
    expect(appSource).toContain("{ requestId: setup.applyRequestId }");
    expect(appSource).not.toContain("client().renameApp(firstRunId, shellName(id), mutationContext(), id)");
    expect(appSource).toContain("canonicalHistory.length === 0");
    expect(appSource).not.toContain("const first = listApps().length === 0");
  });

  it("cannot strand a cancelled first write in a split worker-ticket lifecycle", () => {
    expect("prepareFirstWrite" in WorkerClient.prototype).toBe(false);
    expect("acknowledgeFirstWriteRisk" in WorkerClient.prototype).toBe(false);
    expect("finishFirstWrite" in WorkerClient.prototype).toBe(false);
    expect(workerSource).not.toContain("FirstWriteHandshakeRegistry");
  });

  it("does not claim shell wrappers are atomic first-write protection", () => {
    expect("setFirstWriteProtection" in WorkerClient.prototype).toBe(false);
    expect(appSource).not.toContain("FirstWriteProtectedStore");
    expect(appSource).not.toContain("FirstWriteProtectionCoordinator");
    expect(workerSource).not.toContain('case "prepareFirstWrite"');
  });

  it("wires the everyday checklist to an exact worker target and canonical read-back", () => {
    expect(appSource).toContain("openEverydayActionTarget(client(), openData)");
    expect(appSource).toContain("onEverydayAction={setFirstSuccess}");
    expect(workerSource).toContain('case "firstEverydayActionTarget"');
    expect(workerSource).toContain('case "completeEverydayAction"');
  });

  it("reserves strict sample provenance and rejects the unauthenticated legacy marker", () => {
    expect(workerSource).toContain('const SAMPLE_PROVENANCE_SETTING = "sample_provenance_v1"');
    expect(workerSource).toContain('const LEGACY_SAMPLE_ROWS_SETTING = "sample_rows"');
    expect(workerSource).toContain(
      "parseSampleProvenanceLedger(reader.getSetting(SAMPLE_PROVENANCE_SETTING))",
    );
    expect(workerSource).toContain("legacy sample provenance is unauthenticated");
  });

  it("boots the live database and Store RPC through the shared production authority", () => {
    expect(workerSource).toContain('@clay/kernel/worker-authority');
    expect(workerSource).toContain("ProductionStoreAuthority");
    expect(workerSource).toContain("mustAuthority().asyncStore()");
    expect(workerSource).not.toMatch(/ClayStore\.fromDriver\(opened\.driver\)/);
    expect(workerSource).not.toMatch(/serveStore\(target,\s*portFromMessagePort\(port\)\)/);
  });

  it("requires stable logical request IDs before every worker mutation transport", () => {
    expect("createMutationContext" in WorkerClient.prototype).toBe(true);
    expect(workerSource).toContain("requestId?: string");
    expect(workerSource).toContain("executeMutation({ requestId");
  });

  it("routes production batch edits through the shared batch.apply authority", () => {
    const applyBatch = workerSource.match(/case "applyBatch":[\s\S]*?case "operationBatches":/)?.[0] ?? "";
    expect(applyBatch).toContain('runAuthorityMutation("applyBatch", p, req)');
    expect(applyBatch).not.toContain("mustStore().applyBatch");
    const authorityAdapter = workerSource.match(
      /async function runAuthorityMutation[\s\S]*?function activeSampleCoordinates/,
    )?.[0] ?? "";
    expect(authorityAdapter).toContain('if (route === "applyBatch")');
    expect(authorityAdapter).toContain('requestId, route: "batch.apply", payload');
  });

  it("publishes exact-current device protection for first-success gating", () => {
    expect(workerSource).toContain('case "deviceProtection"');
    expect(appSource).toContain("firstSuccessJourneyComplete");
    expect(appSource).toMatch(/activation_completed[\s\S]{0,400}protected_on_device|protected_on_device[\s\S]{0,400}activation_completed/);
  });
});
