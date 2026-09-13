/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedFormat5RestoreGrant } from "@clay/kernel/recovery";
import {
  RecoveryCenter,
  type RecoveryBackupSummary,
  type RecoveryFailureSummary,
} from "../src/app/RecoveryCenter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (prefix: string, character: string): string => `${prefix}_${character.repeat(26)}`;
const sha = (character: string): string => `sha256:${character.repeat(64)}`;
const currentAppInstanceId = id("app", "a");
const otherAppInstanceId = id("app", "b");

const verified: RecoveryBackupSummary = {
  backupId: id("bkp", "c"),
  fileName: `clay-field-ops-20260905T200102003Z-${id("backupgen", "d")}.clay`,
  verifiedAt: "2026-09-05T20:01:03.000Z",
  byteLength: 2_400_000,
};

const grant: AuthenticatedFormat5RestoreGrant = {
  schema: 1,
  kind: "authenticated_format5_restore_as_new",
  validationId: id("restoreval", "e"),
  archiveFormat: 5,
  cryptographicallyAuthenticated: true,
  authentication: {
    schema: 1,
    kind: "cose_mac0_hmac_256_256",
    authenticationVersion: 1,
    keyId: "10".repeat(16),
    seriesId: "20".repeat(16),
    generation: "9",
  },
  freshness: "unknown",
  archiveSha256: sha("8"),
  archiveTarget: {
    appInstanceId: currentAppInstanceId,
    activeGenerationId: id("gen", "f"),
    lineageEpoch: "4",
    protectionRevision: "11",
    digestSchema: 1,
    stateSha256: sha("9"),
  },
  preservedAppInstanceId: currentAppInstanceId,
  destinationAppInstanceId: id("app", "z"),
  installMode: "new_app_only",
  validatedAt: "2026-09-05T20:01:04.000Z",
};

function baseProps(): ComponentProps<typeof RecoveryCenter> {
  return {
    appName: "Field Ops",
    authoritativeAppInstanceId: currentAppInstanceId,
    opfsAvailable: true,
    backupTrustStatus: { status: "not_enrolled" },
    backupAdapterStatus: "available",
    backupTarget: null,
    lastVerifiedBackup: null,
    failures: [],
    history: [],
    structuralHistory: [],
    recentBatches: [],
    recordCandidates: [],
    recoveryFailures: [],
    importedVerifierSeriesId: null,
    onClose: vi.fn(),
    onChooseFolder: vi.fn(async () => undefined),
  };
}

async function mount(props: ComponentProps<typeof RecoveryCenter>): Promise<{
  root: Root;
  container: HTMLDivElement;
}> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => root.render(<RecoveryCenter {...props} />));
  return { root, container };
}

const button = (name: string): HTMLButtonElement => {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === name
      || candidate.getAttribute("aria-label") === name);
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
};

const labelledFileInput = (labelText: string): HTMLInputElement => {
  const label = [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find(candidate => candidate.textContent?.includes(labelText));
  const input = label?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error(`file input not found: ${labelText}`);
  return input;
};

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function selectRestoreFile(fileName = "field-ops.clay"): Promise<void> {
  const input = labelledFileInput("Choose a .clay backup");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([new Uint8Array([1, 2, 3])], fileName, { type: "application/zip" })],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("Release B Recovery Center", () => {
  it("offers retirement only with an exact pending Backup Trust identity", async () => {
    const retire = vi.fn(async () => {});
    const props = { ...baseProps(), onRetireBackup: retire, backupTrustStatus: { status: "ready" as const,
      freshness: "current" as const, keyId: "10".repeat(16), seriesId: "20".repeat(16), nextGeneration: "2",
      pending: { backupId: id("bkp", "q"), generation: "1" }, committed: null } };
    const { root } = await mount(props);
    try {
      await act(async () => button("Retire unfinished backup attempt").click());
      expect(retire).toHaveBeenCalledWith(props.backupTrustStatus.seriesId, id("bkp", "q"));
      await act(async () => root.render(<RecoveryCenter {...props} backupTrustStatus={{ ...props.backupTrustStatus, pending: null }} />));
      expect(document.body.textContent).not.toContain("Retire unfinished backup attempt");
    } finally { await act(async () => root.unmount()); }
  });
  it("offers exact download-record retry, file revalidation and explicit discard only for its source app", async () => {
    const resume = vi.fn(async (_file?: File) => true);
    const discard = vi.fn(async () => true);
    const props = { ...baseProps(), pendingManualDownload: { schema: 1 as const, requestId: id("req", "q"), phase: "prepared" as const,
      record: { schema: 2 as const, kind: "manual_download" as const, archiveFormat: 5 as const, fileName: "download.clay", byteLength: 3,
        startedAt: grant.validatedAt, verification: "unverified_external_save" as const, authentication: grant.authentication,
        archiveSha256: grant.archiveSha256, evidence: grant.archiveTarget } }, onResumeManualDownload: resume, onDiscardManualDownload: discard };
    const { root } = await mount(props);
    try {
      await act(async () => button("Retry download record").click());
      expect(resume).toHaveBeenCalledWith();
      const file = new File([new Uint8Array([1, 2, 3])], "download.clay");
      await selectFile(labelledFileInput("Check the downloaded file"), file);
      expect(resume).toHaveBeenLastCalledWith(file);
      await act(async () => button("Discard unfinished download request").click());
      expect(discard).toHaveBeenCalledOnce();
      await act(async () => root.render(<RecoveryCenter {...props} authoritativeAppInstanceId={otherAppInstanceId} />));
      expect(document.body.textContent).not.toContain("Retry download record");
    } finally { await act(async () => root.unmount()); }
  });
  it("plainly shows OPFS-only custody, no verified backup, every recovery entry, and no false protection claim", async () => {
    const props = baseProps();
    const { root } = await mount(props);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Recovery Center");
    expect(text).toContain("Protection target");
    expect(text).toContain("Field Ops is saved in this browser’s private storage (OPFS) only.");
    expect(text).toContain("Backup folderNot chosen");
    expect(text).toContain("Last verified backupNo verified backup yet");
    expect(text).toContain("No backup failures recorded.");
    expect(text).toContain("Backup history");
    expect(text).toContain("No verified backups yet.");
    expect(text).toContain("Restore as a new app");
    expect(text).toContain("Your original app is never replaced.");
    expect(text).not.toMatch(/protected on this device|backed up/i);

    expect(button("Choose backup folder").disabled).toBe(false);
    expect(button("Retry backup").disabled).toBe(true);
    expect(button("Restore as new app (not available yet)").disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    const body = document.querySelector<HTMLElement>(".recovery-center > .shape-column");
    expect(body?.style.overflowY).toBe("auto");
    expect(body?.style.minHeight).toBe("0");
    expect(body?.tabIndex).toBe(0);
    expect(body?.getAttribute("role")).toBe("region");
    expect(body?.getAttribute("aria-label")).toBe("Recovery Center details");

    await act(async () => button("Choose backup folder").click());
    expect(props.onChooseFolder).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("distinguishes adapter loading from a retryable load failure", async () => {
    const loading = { ...baseProps(), backupAdapterStatus: "loading" as const,
      onChooseFolder: undefined };
    const { root } = await mount(loading);
    expect(button("Checking folder backup…").disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent)
      .toContain("Checking whether this browser can use a backup folder");

    const retry = vi.fn(async () => undefined);
    await act(async () => root.render(<RecoveryCenter {...loading}
      backupAdapterStatus="error" onRetryBackupAdapter={retry} />));
    expect(button("Folder backup needs retry").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain("Your app data was not changed");
    await act(async () => button("Retry folder support").click());
    expect(retry).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("shows the last verified copy, bounded history, and plain-language failure recovery", async () => {
    const failures: RecoveryFailureSummary[] = [
      { id: "f1", at: "2026-09-05T20:05:00.000Z", reasonCode: "permission_required" },
      { id: "f2", at: "2026-09-05T20:06:00.000Z", reasonCode: "operation_interrupted" },
      { id: "f3", at: "2026-09-05T20:07:00.000Z", reasonCode: "quota_exceeded" },
    ];
    const retry = vi.fn(async () => undefined);
    const choose = vi.fn(async () => undefined);
    const { root } = await mount({
      ...baseProps(),
      backupTarget: { targetId: id("tgt", "g"), folderName: "Clay backups" },
      lastVerifiedBackup: verified,
      history: [verified, { ...verified, backupId: id("bkp", "h"),
        verifiedAt: "2026-09-04T20:01:03.000Z" }],
      failures,
      onRetry: retry,
      onChooseFolder: choose,
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("Backup folderClay backups");
    expect(text).toContain(
      "Field Ops is saved in this browser and has a verified backup in Clay backups.",
    );
    expect(text).not.toContain("private storage (OPFS) only");
    expect(text).toContain("Last verified backup9/5/2026");
    expect(text).toContain("Clay needs permission to use the backup folder again.");
    expect(text).toContain("The backup stopped before it finished.");
    expect(text).toContain("There wasn’t enough space to finish the backup.");
    expect(document.querySelectorAll(".recovery-history-item")).toHaveLength(2);

    await act(async () => button("Retry backup").click());
    await act(async () => button("Choose backup folder").click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("guides Recovery Kit download, exact test-import, and clean-device import", async () => {
    const exportKit = vi.fn(async () => undefined);
    const confirmKit = vi.fn(async (_file: File) => undefined);
    const importKit = vi.fn(async (_file: File) => undefined);
    const activateSeries = vi.fn(async (_seriesId: string) => undefined);
    const props = {
      ...baseProps(),
      onExportRecoveryKit: exportKit,
      onConfirmRecoveryKit: confirmKit,
      onImportRecoveryKit: importKit,
      onActivateImportedSeries: activateSeries,
    };
    const { root } = await mount(props);

    expect(document.body.textContent).toContain("Recovery Kit");
    expect(document.body.textContent).toContain("does not encrypt your records");
    expect(button("Download Recovery Kit").disabled).toBe(false);
    await act(async () => button("Download Recovery Kit").click());
    expect(exportKit).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<RecoveryCenter {...props}
      backupTrustStatus={{
        status: "needs_test_import",
        enrollmentId: id("enroll", "k"),
      }} />));
    expect(document.body.textContent).toContain("choose the exact file you downloaded");
    const checked = new File(["kit"], "clay-recovery-kit.txt", { type: "text/plain" });
    await selectFile(labelledFileInput("Check downloaded Recovery Kit"), checked);
    expect(confirmKit).toHaveBeenCalledWith(checked);

    const imported = new File(["existing"], "existing-recovery-kit.txt", {
      type: "text/plain",
    });
    await selectFile(labelledFileInput("Import an existing Recovery Kit"), imported);
    expect(importKit).toHaveBeenCalledWith(imported);
    expect(button("Use imported series for future backups").disabled).toBe(true);
    const importedSeriesId = "20".repeat(16);
    await act(async () => root.render(<RecoveryCenter {...props}
      importedVerifierSeriesId={importedSeriesId} />));
    expect(button("Use imported series for future backups").disabled).toBe(false);
    await act(async () => button("Use imported series for future backups").click());
    expect(activateSeries).toHaveBeenCalledWith(importedSeriesId);
    await act(async () => root.unmount());
  });

  it("surfaces record, attachment, batch, and structural recovery previews", async () => {
    const restoreRecord = vi.fn(async () => true);
    const undoBatch = vi.fn(async () => true);
    const rewind = vi.fn(async () => true);
    const candidate = {
      table: "tasks",
      id: "018f0f4d-7b4a-7abc-8def-0123456789ab",
      deleted: true,
      historyAt: "2026-09-07T12:00:00.000Z",
      attachmentCount: 2,
    };
    const batch = {
      id: "018f0f4d-7b4a-7abc-8def-0123456789ac",
      at: "2026-09-07T12:01:00.000Z",
      source: "user" as const,
      summary: "Archive old tasks",
      changed: 3,
      created: [],
      undone: false,
    };
    const { root } = await mount({
      ...baseProps(),
      recordCandidates: [candidate],
      recentBatches: [batch],
      structuralHistory: [
        { version: 1, parent: 0, created_at: "2026-09-06T12:00:00.000Z", intent_text: "one", summary: "First" },
        { version: 2, parent: 1, created_at: "2026-09-07T12:00:00.000Z", intent_text: "two", summary: "Second" },
      ],
      recoveryFailures: [{
        id: "failure-1",
        at: "2026-09-08T12:00:00.000Z",
        action: "record",
        code: "E_CONFLICT",
      }],
      onRestoreRecord: restoreRecord,
      onUndoBatch: undoBatch,
      onRewindStructure: rewind,
    });

    expect(document.body.textContent).toContain("Deleted tasks record");
    expect(document.body.textContent).toContain("restores 2 attached files");
    expect(document.body.textContent).toContain("Archive old tasks · 3 records");
    expect(document.body.textContent).toContain("Version 1 · First");
    expect(document.body.textContent).toContain("E_CONFLICT");
    await act(async () => button("Restore deleted record").click());
    await act(async () => button("Undo this batch").click());
    await act(async () => button("Rewind here").click());
    expect(restoreRecord).toHaveBeenCalledWith(candidate);
    expect(undoBatch).toHaveBeenCalledWith(batch);
    expect(rewind).toHaveBeenCalledWith(1);
    await act(async () => root.unmount());
  });

  it("fails closed for malformed or legacy validation and never offers replacement", async () => {
    const restore = vi.fn(async () => undefined);
    const validate = vi.fn(async () => ({
      ...grant,
      archiveFormat: 4,
      cryptographicallyAuthenticated: false,
    }));
    const { root } = await mount({
      ...baseProps(),
      onValidateRestore: validate,
      onRestoreAsNew: restore,
    });

    await selectRestoreFile("legacy.clay");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "This file was not authenticated as a format-5 backup. Nothing was restored.",
    );
    expect(button("Restore as new app").disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(/replace current|overwrite original/i);
    expect(restore).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("enables only an exact authenticated format-5 new-app grant and passes that immutable grant", async () => {
    const restore = vi.fn(async (_value: typeof grant) => undefined);
    const validate = vi.fn(async () => structuredClone(grant));
    const props = {
      ...baseProps(),
      onValidateRestore: validate,
      onRestoreAsNew: restore,
    };
    const { root } = await mount(props);

    await selectRestoreFile();
    expect(document.body.textContent).toContain("Authenticated format-5 backup ready.");
    expect(button("Restore as new app").disabled).toBe(false);
    await act(async () => button("Restore as new app").click());
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(grant, { requestId: expect.stringMatching(/^req_[a-z2-7]{26}$/) });
    const delivered = restore.mock.calls[0]![0]!;
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(Object.isFrozen(delivered.archiveTarget)).toBe(true);
    expect(Object.isFrozen(delivered.authentication)).toBe(true);
    expect(grant.installMode).toBe("new_app_only");
    expect(grant.destinationAppInstanceId).not.toBe(grant.preservedAppInstanceId);
    await act(async () => root.unmount());
  });

  it("retains the exact restore request across ambiguous failure and modal teardown", async () => {
    sessionStorage.clear(); // jsdom-owned disposable storage only
    const restore = vi.fn(async (_grant: typeof grant, _context: { requestId: string }) => {
      throw new Error("lost response after durable publication");
    });
    const props = { ...baseProps(), onValidateRestore: vi.fn(async () => structuredClone(grant)), onRestoreAsNew: restore };
    const first = await mount(props);
    await selectRestoreFile();
    await act(async () => button("Restore as new app").click());
    expect(document.body.textContent).toContain("outcome needs reconciliation");
    expect(labelledFileInput("Choose a .clay backup").disabled).toBe(true);
    const invoked = restore.mock.calls[0]!;
    await act(async () => first.root.unmount());
    const second = await mount({ ...props, authoritativeAppInstanceId: grant.destinationAppInstanceId });
    await act(async () => button("Retry restore outcome").click());
    expect(restore.mock.calls[1]).toEqual(invoked);
    await act(async () => second.root.unmount());
    sessionStorage.clear();
  });

  it("revalidates the exact open app before restore and disables a stale grant", async () => {
    const restore = vi.fn(async () => undefined);
    const props = {
      ...baseProps(),
      onValidateRestore: vi.fn(async () => structuredClone(grant)),
      onRestoreAsNew: restore,
    };
    const { root } = await mount(props);
    await selectRestoreFile();
    expect(button("Restore as new app").disabled).toBe(false);

    await act(async () => root.render(<RecoveryCenter {...props}
      authoritativeAppInstanceId={otherAppInstanceId} />));
    expect(button("Restore as new app").disabled).toBe(true);
    expect(document.body.textContent).toContain("The open app changed. Check the backup again.");
    await act(async () => button("Restore as new app").click());
    expect(restore).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
