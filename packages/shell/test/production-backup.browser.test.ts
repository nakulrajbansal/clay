import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackupPublicationReceiptV1,
  BackupStageValidationV1,
  type BackupPublicationReceipt,
  type BackupPublicationRequest,
  type BackupRun,
  type BackupStageValidation,
} from "@clay/kernel/backup";
import type { ProductionBackupSelection } from "@clay/kernel/worker-authority";
import {
  DeterministicBackupAuthority,
  DeterministicDirectory,
  DeterministicStageValidator,
  SELECTED,
  TARGET,
  backupRun,
} from "../../kernel/test/external-backup-fakes";
import {
  createProductionBackupAdapter,
  loadProductionBackupTarget,
  runProductionAutomaticBackup,
  saveProductionBackupTarget,
} from "../src/app/production-backup.browser";
import type { ChromiumBackupEnvironment } from "../src/app/backup-target.browser";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
afterEach(() => vi.unstubAllGlobals());

function productionRuntime(
  userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149.0.7827.55 Safari/537.36",
  chromiumVersion = "149",
) {
  return {
    userAgent,
    userAgentData: {
      platform: "Windows",
      mobile: false,
      brands: [
        { brand: "Chromium", version: chromiumVersion },
        { brand: "Google Chrome", version: chromiumVersion },
        { brand: "Not)A;Brand", version: "24" },
      ],
    },
  };
}

describe("production browser backup wiring", () => {
  it("enables only the release-certified production runtime and exclusive-create bridge", () => {
    const environment: ChromiumBackupEnvironment = {
      secureContext: true,
      topLevelContext: true,
      hasTransientUserActivation: () => true,
      showDirectoryPicker: async () => { throw new Error("not opened by availability"); },
      createExclusiveFile: async () => { throw new Error("not opened by availability"); },
    };
    const factory = {} as IDBFactory;
    const certified = createProductionBackupAdapter(
      factory,
      environment,
      productionRuntime(),
      () => "2026-09-08T12:30:00.000Z",
    );
    expect(certified?.availability()).toEqual({ status: "available" });
    const spoofedUserAgent = createProductionBackupAdapter(
      factory,
      environment,
      productionRuntime(undefined, "150"),
      () => "2026-09-08T12:30:00.000Z",
    );
    expect(spoofedUserAgent?.availability()).toEqual({
      status: "unavailable",
      reasonCode: "adapter_uncertified",
    });
    const wrongPatchRuntime = createProductionBackupAdapter(
      factory,
      environment,
      productionRuntime(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149.0.7827.56 Safari/537.36",
      ),
      () => "2026-09-08T12:30:00.000Z",
    );
    expect(wrongPatchRuntime?.availability()).toEqual({
      status: "unavailable",
      reasonCode: "adapter_uncertified",
    });
    const wrongRuntime = createProductionBackupAdapter(
      factory,
      environment,
      productionRuntime(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36",
        "150",
      ),
      () => "2026-09-08T12:30:00.000Z",
    );
    expect(wrongRuntime?.availability()).toEqual({
      status: "unavailable",
      reasonCode: "adapter_uncertified",
    });
  });

  it("connects worker snapshot, exact directory read-back, worker validation, and publication", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const bytes = new Uint8Array([11, 22, 33, 44]);
    const run: BackupRun = {
      ...backupRun(bytes),
      target: TARGET,
      reason: "backup_now",
    };
    const events: string[] = [];
    const directory = new DeterministicDirectory(TARGET.targetId, events);
    const authority = new DeterministicBackupAuthority(SELECTED, events);
    const stage = new DeterministicStageValidator(events);
    const preparedBytes = asArrayBuffer(bytes);
    let sourceDetachedBeforeRead = false;
    const readExact = directory.readExact.bind(directory);
    directory.readExact = async fileName => {
      sourceDetachedBeforeRead = preparedBytes.byteLength === 0;
      return readExact(fileName);
    };
    const worker = {
      backupRetentionPlan: vi.fn(async () => ({ schema: 1 as const, keeper: null, entries: [], remaining: 0 })),
      authorizeBackupRemoval: vi.fn(), acknowledgeBackupRemoval: vi.fn(),
      completeAutomaticBackup: vi.fn(async () => {}),
      prepareAutomaticBackup: vi.fn(async () => {
        events.push("worker:prepare");
        return { run: structuredClone(run), bytes: preparedBytes };
      }),
      backupSelection: vi.fn(async (): Promise<ProductionBackupSelection> => {
        events.push("worker:selection");
        return {
          selected: structuredClone(authority.selected),
          fence: structuredClone(run.fence),
        };
      }),
      validateBackupStage: vi.fn(async (
        input: ArrayBuffer,
        expected: typeof SELECTED.target,
      ): Promise<BackupStageValidation> => {
        events.push("worker:validate");
        return BackupStageValidationV1.parse(
          await stage.validate(new Uint8Array(input), expected),
        );
      }),
      publishBackup: vi.fn(async (
        request: BackupPublicationRequest,
      ): Promise<BackupPublicationReceipt> => {
        events.push("worker:publish");
        return BackupPublicationReceiptV1.parse(await authority.publish(request));
      }),
    };
    const adapter = {
      availability: vi.fn(() => ({ status: "available" as const })),
      directory: vi.fn(() => directory),
    };

    const result = await runProductionAutomaticBackup(
      worker,
      adapter,
      TARGET,
      "backup_now",
      () => "2026-09-05T20:01:03.000Z",
    );

    expect(result).toMatchObject({
      status: "published",
      record: { backupId: run.backupId, targetId: TARGET.targetId },
    });
    expect(adapter.directory).toHaveBeenCalledWith(TARGET);
    expect(worker.prepareAutomaticBackup).toHaveBeenCalledWith(TARGET, "backup_now");
    expect(worker.validateBackupStage).toHaveBeenCalledTimes(1);
    expect(worker.validateBackupStage.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);
    expect(worker.publishBackup).toHaveBeenCalledTimes(1);
    expect(worker.completeAutomaticBackup).toHaveBeenCalledWith(result);
    expect(events).toEqual([
      "worker:prepare",
      "worker:selection",
      expect.stringMatching(/^directory:create:/),
      "directory:write:4",
      "directory:close",
      expect.stringMatching(/^directory:read:/),
      "worker:validate",
      "stage:validate",
      "worker:selection",
      "worker:publish",
      "authority:publish",
    ]);
    expect(sourceDetachedBeforeRead).toBe(true);
    expect(preparedBytes.byteLength).toBe(0);
  });

  it("persists only a parsed app-bound target hint for handle reacquisition", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); },
      removeItem: (key: string): void => { values.delete(key); },
    };
    saveProductionBackupTarget(storage, {
      target: TARGET,
      folderName: "Clay backups",
    });
    expect(loadProductionBackupTarget(storage, TARGET.appInstanceId)).toEqual({
      target: TARGET,
      folderName: "Clay backups",
    });
    expect(loadProductionBackupTarget(storage, `app_${"z".repeat(26)}`)).toBeNull();

    const nextTarget = { ...TARGET, targetId: `tgt_${"s".repeat(26)}` };
    saveProductionBackupTarget(storage, { target: nextTarget, folderName: "New folder" });
    expect(loadProductionBackupTarget(storage, TARGET.appInstanceId, TARGET.targetId)?.target).toEqual(TARGET);
    expect(loadProductionBackupTarget(storage, TARGET.appInstanceId)?.target).toEqual(nextTarget);
    expect(loadProductionBackupTarget(storage, TARGET.appInstanceId, `tgt_${"z".repeat(26)}`)).toBeNull();

    const key = `clay_backup_target_v1:${TARGET.appInstanceId}`;
    values.set(key!, JSON.stringify({ target: { ...TARGET, targetId: "forged" }, folderName: "x" }));
    expect(loadProductionBackupTarget(storage, TARGET.appInstanceId)).toBeNull();
  });

  it("connects every Recovery Center action without claiming an unavailable folder target", () => {
    const app = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/app/App.tsx"),
      "utf8",
    );
    expect(app).toContain("createProductionBackupAdapter(");
    expect(app).toContain("runProductionAutomaticBackup(");
    expect(app).toContain("beginBackupTrustEnrollment()");
    expect(app).toContain("confirmBackupTrustEnrollment(");
    expect(app).toContain("importRecoveryKit(");
    expect(app).toContain("activateImportedBackupSeries(");
    expect(app).toContain("validateRestoreArchive(");
    expect(app).toContain("restoreAsNew(");
    expect(app).toContain("replaceAppCache(boot.apps, boot.selectedAppInstanceId)");
    expect(app).toContain("authoritativeAppInstanceId={currentId}");
    expect(app).toContain("backupTrustStatus={backupTrustStatus}");
    expect(app).toContain("onExportRecoveryKit={exportRecoveryKit}");
    expect(app).toContain("onConfirmRecoveryKit={confirmRecoveryKit}");
    expect(app).toContain("onImportRecoveryKit={importRecoveryKit}");
    expect(app).toContain("onActivateImportedSeries={activateImportedBackupSeries}");
    expect(app.includes('onValidateRestore={productionWorkerRouteAvailable("validateRestoreArchive") ? validateRestore : undefined}')).toBe(true);
    expect(app.includes('onRestoreAsNew={productionWorkerRouteAvailable("restoreAsNew") ? restoreAsNew : undefined}')).toBe(true);
    expect(app).toContain("onChooseFolder={backupAdapterAvailable ? chooseBackupFolder : undefined}");
    const confirmStart = app.indexOf("const confirmRecoveryKit");
    const importStart = app.indexOf("const importRecoveryKit", confirmStart);
    const activationStart = app.indexOf("const activateImportedBackupSeries", importStart);
    expect(app.slice(confirmStart, importStart)).toContain(
      'if (backupTarget) await runAutomaticBackup(backupTarget, "backup_now")',
    );
    expect(app.slice(importStart, activationStart)).toContain(
      "if (imported.activeForBackup && backupTarget)",
    );
    expect(app.slice(importStart, activationStart)).not.toContain(
      'if (backupTarget) await runAutomaticBackup(backupTarget, "backup_now")',
    );
    expect(app).not.toContain("authoritativeAppInstanceId={null}");
    expect(app).not.toContain("backupTarget={null}");
  });
});
