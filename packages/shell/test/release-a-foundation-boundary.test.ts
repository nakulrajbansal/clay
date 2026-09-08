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
    expect(workerSource).toContain('"sample_provenance_v1"');
    expect(workerSource).toContain('"sample_rows"');
    expect(workerSource).toContain("reserved worker setting");
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

  it("routes production batch edits through atomic sample-to-real handoff", () => {
    const applyBatch = workerSource.match(/case "applyBatch":[\s\S]*?case "operationBatches":/)?.[0] ?? "";
    expect(applyBatch).toMatch(/executeMutation|applyUserBatchWithSampleHandoff/);
    expect(applyBatch).not.toContain("mustStore().applyBatch");
  });

  it("publishes exact-current device protection for first-success gating", () => {
    expect(workerSource).toContain('case "deviceProtection"');
    expect(appSource).toContain("firstSuccessJourneyComplete");
    expect(appSource).toMatch(/activation_completed[\s\S]{0,400}protected_on_device|protected_on_device[\s\S]{0,400}activation_completed/);
  });
});
