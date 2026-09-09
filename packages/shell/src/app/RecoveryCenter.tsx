import { useState } from "react";
import type { BatchReceipt, HistoryEntry } from "@clay/kernel";
import {
  parseAuthenticatedFormat5RestoreGrant,
  type AuthenticatedFormat5RestoreGrant,
  type BackupFailureReasonCode,
} from "@clay/kernel/recovery";
import type { BackupTrustRuntimeStatus } from "../worker/backup-trust-runtime";
import type { RecoveryRecordCandidate } from "./worker-client";
import { ModalDialog } from "./ModalDialog";

export type RecoveryBackupSummary = {
  backupId: string;
  fileName: string;
  verifiedAt: string;
  byteLength: number;
};

export type RecoveryFailureSummary = {
  id: string;
  at: string;
  reasonCode: BackupFailureReasonCode;
};

export type RecoveryBackupTarget = {
  targetId: string;
  folderName: string;
};

export type RecoveryActionFailure = {
  id: string;
  at: string;
  action: "record" | "batch" | "structure";
  code: string;
};

export type RecoveryCenterProps = {
  appName: string;
  /** Exact worker-owned identity. Null keeps restore fail-closed. */
  authoritativeAppInstanceId: string | null;
  opfsAvailable: boolean;
  backupTrustStatus: BackupTrustRuntimeStatus | null;
  backupAdapterStatus: "loading" | "available" | "unavailable" | "error";
  backupTarget: RecoveryBackupTarget | null;
  lastVerifiedBackup: RecoveryBackupSummary | null;
  failures: RecoveryFailureSummary[];
  history: RecoveryBackupSummary[];
  structuralHistory: HistoryEntry[];
  recentBatches: BatchReceipt[];
  recordCandidates: RecoveryRecordCandidate[];
  recoveryFailures: RecoveryActionFailure[];
  importedVerifierSeriesId: string | null;
  onClose: () => void;
  onRetry?: () => Promise<void>;
  onRetryBackupAdapter?: () => Promise<void>;
  onChooseFolder?: () => Promise<void>;
  onExportRecoveryKit?: () => Promise<void>;
  onConfirmRecoveryKit?: (file: File) => Promise<void>;
  onImportRecoveryKit?: (file: File) => Promise<void>;
  onActivateImportedSeries?: (seriesId: string) => Promise<void>;
  onRestoreRecord?: (candidate: RecoveryRecordCandidate) => Promise<boolean>;
  onUndoBatch?: (batch: BatchReceipt) => Promise<boolean>;
  onRewindStructure?: (version: number) => Promise<boolean>;
  /** Must call the authenticated format-5 worker boundary, never shape-check bytes here. */
  onValidateRestore?: (file: File) => Promise<unknown>;
  /** This callback receives only a new-app grant. No replace-current callback exists. */
  onRestoreAsNew?: (grant: AuthenticatedFormat5RestoreGrant) => Promise<void>;
};

type RestoreStatus = "idle" | "checking" | "invalid" | "ready";

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US");
}

export function recoveryFailureMessage(reason: BackupFailureReasonCode): string {
  switch (reason) {
    case "permission_required":
      return "Clay needs permission to use the backup folder again.";
    case "operation_interrupted":
      return "The backup stopped before it finished.";
    case "quota_exceeded":
      return "There wasn’t enough space to finish the backup.";
    default:
      return "Backup not verified; earlier copy kept.";
  }
}

function freezeGrant(value: AuthenticatedFormat5RestoreGrant): AuthenticatedFormat5RestoreGrant {
  Object.freeze(value.archiveTarget);
  Object.freeze(value.authentication);
  return Object.freeze(value);
}

function exactGrant(
  value: unknown,
  appInstanceId: string | null,
): AuthenticatedFormat5RestoreGrant | null {
  if (appInstanceId === null) return null;
  const parsed = parseAuthenticatedFormat5RestoreGrant(value);
  if (!parsed || parsed.preservedAppInstanceId !== appInstanceId) return null;
  return freezeGrant(parsed);
}

export function RecoveryCenter(props: RecoveryCenterProps): React.JSX.Element {
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>("idle");
  const [restoreGrant, setRestoreGrant] = useState<AuthenticatedFormat5RestoreGrant | null>(null);
  const [kitBusy, setKitBusy] = useState(false);
  const [kitMessage, setKitMessage] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);

  const currentGrant = exactGrant(restoreGrant, props.authoritativeAppInstanceId);
  const targetDrifted = restoreGrant !== null && currentGrant === null;
  const canRestore = currentGrant !== null && props.onRestoreAsNew !== undefined;

  const runKitAction = async (
    action: (() => Promise<void>) | undefined,
    success: string,
  ): Promise<void> => {
    if (!action || kitBusy) return;
    setKitBusy(true);
    setKitMessage(null);
    try {
      await action();
      setKitMessage(success);
    } catch {
      setKitMessage("Recovery Kit check failed. Nothing changed.");
    } finally {
      setKitBusy(false);
    }
  };

  const runRecoveryAction = async (
    action: (() => Promise<boolean>) | undefined,
    success: string,
  ): Promise<void> => {
    if (!action || recoveryBusy) return;
    setRecoveryBusy(true);
    setRecoveryMessage(null);
    try {
      setRecoveryMessage(await action() ? success : "Recovery cancelled. Nothing changed.");
    } catch {
      setRecoveryMessage("Recovery could not be applied. No unverified change was published.");
    } finally {
      setRecoveryBusy(false);
    }
  };


  const checkRestore = async (file: File): Promise<void> => {
    setRestoreGrant(null);

    if (!props.onValidateRestore) {
      setRestoreStatus("invalid");
      return;
    }
    setRestoreStatus("checking");
    try {
      const supplied = await props.onValidateRestore(file);
      const validated = exactGrant(supplied, props.authoritativeAppInstanceId);
      if (!validated) {
        setRestoreStatus("invalid");
        return;
      }
      setRestoreGrant(validated);
      setRestoreStatus("ready");
    } catch {
      setRestoreStatus("invalid");
    }
  };

  const restoreAsNew = async (): Promise<void> => {
    // Reparse and compare the exact open app immediately before the external
    // action. A stale, malformed, legacy, or same-destination grant is inert.
    const revalidated = exactGrant(currentGrant, props.authoritativeAppInstanceId);
    if (!revalidated || !props.onRestoreAsNew) {
      setRestoreStatus("invalid");
      return;
    }
    setRestoreGrant(null);
    setRestoreStatus("checking");
    try {
      await props.onRestoreAsNew(revalidated);
      setRestoreStatus("idle");
    } catch {
      setRestoreStatus("invalid");
    }
  };

  const restoreMessage = targetDrifted
    ? "The open app changed. Check the backup again."
    : restoreStatus === "checking"
      ? "Checking locally…"
      : restoreStatus === "ready"
        ? "Authenticated format-5 backup ready."
        : restoreStatus === "invalid"
          ? "This file was not authenticated as a format-5 backup. Nothing was restored."
          : props.onValidateRestore
            ? "Choose a .clay file."
            : "Restore needs authenticated format-5 validation.";

  const trustMessage = props.backupTrustStatus === null
    ? "Checking Recovery Kit status…"
    : props.backupTrustStatus.status === "not_enrolled"
      ? "Download a Recovery Kit, keep it somewhere separate, then check the exact downloaded file."
      : props.backupTrustStatus.status === "needs_test_import"
        ? "Download started; choose the exact file you downloaded before automatic backup can start."
        : props.backupTrustStatus.freshness === "current"
          ? "Recovery Kit checked. The newest authenticated backup is current."
          : "Recovery Kit checked. Archive authenticity can be verified; newest status is not yet known.";

  return (
    <ModalDialog className="shape-map recovery-center" backdropClassName="shape-map-backdrop"
      ariaLabelledBy="recovery-center-title" onClose={props.onClose}>
      <header className="shape-map-header">
        <h2 id="recovery-center-title">Recovery Center</h2>
        <button className="shape-map-close" aria-label="Close Recovery Center" onClick={props.onClose}>×</button>
      </header>

      <div className="shape-column" style={{ overflowY: "auto", minHeight: 0 }}
        role="region" aria-label="Recovery Center details" tabIndex={0}>
        <section aria-labelledby="recovery-kit-title">
          <h3 id="recovery-kit-title">Recovery Kit</h3>
          <p>{trustMessage}</p>
          <p>A Recovery Kit authenticates backups but does not encrypt your records. Anyone with file access can read them.</p>
          <div className="rail-actions">
            <button
              className={props.backupTrustStatus?.status === "not_enrolled"
                && props.onExportRecoveryKit ? "primary" : undefined}
              disabled={kitBusy || props.backupTrustStatus?.status !== "not_enrolled"
                || !props.onExportRecoveryKit}
              onClick={() => void runKitAction(
                props.onExportRecoveryKit,
                "Recovery Kit downloaded. Check that exact file next.",
              )}
            >Download Recovery Kit</button>
            <label className="shape-history-open file-label">
              Check downloaded Recovery Kit
              <input type="file" accept=".txt,text/plain"
                disabled={kitBusy || props.backupTrustStatus?.status !== "needs_test_import"
                  || !props.onConfirmRecoveryKit}
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void runKitAction(
                    () => props.onConfirmRecoveryKit!(file),
                    "Recovery Kit checked on this device.",
                  );
                  event.target.value = "";
                }} />
            </label>
            <label className="shape-history-open file-label">
              Import an existing Recovery Kit
              <input type="file" accept=".txt,text/plain"
                disabled={kitBusy || !props.onImportRecoveryKit}
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void runKitAction(
                    () => props.onImportRecoveryKit!(file),
                    "Recovery Kit imported on this device.",
                  );
                  event.target.value = "";
                }} />
            </label>
            <button disabled={kitBusy || props.importedVerifierSeriesId === null
                || !props.onActivateImportedSeries}
              onClick={() => void runKitAction(
                props.importedVerifierSeriesId && props.onActivateImportedSeries
                  ? () => props.onActivateImportedSeries!(props.importedVerifierSeriesId!)
                  : undefined,
                "Imported series activated for future backups.",
              )}>
              Use imported series for future backups
            </button>
          </div>
          {kitMessage ? <p role={kitMessage.includes("failed") ? "alert" : "status"}>
            {kitMessage}
          </p> : null}
        </section>

        <section aria-labelledby="recovery-target-title">
          <h3 id="recovery-target-title">Protection target</h3>
          <dl>
            <div><dt>Current app</dt><dd>{props.opfsAvailable
              ? props.lastVerifiedBackup && props.backupTarget
                ? `${props.appName} is saved in this browser and has a verified backup in ${props.backupTarget.folderName}.`
                : `${props.appName} is saved in this browser’s private storage (OPFS) only.`
              : `${props.appName} is in a temporary session and is not saved.`}</dd></div>
            <div><dt>Backup folder</dt><dd>{props.backupTarget?.folderName ?? "Not chosen"}</dd></div>
            <div><dt>Last verified backup</dt><dd>{props.lastVerifiedBackup
              ? formatDate(props.lastVerifiedBackup.verifiedAt)
              : "No verified backup yet"}</dd></div>
          </dl>
          <div className="rail-actions">
            <button className={props.onRetry && props.failures.length > 0 ? "primary" : undefined}
              disabled={!props.onRetry || props.failures.length === 0}
              onClick={() => { void props.onRetry?.(); }}>
              Retry backup
            </button>
            <button className={props.onChooseFolder ? "primary" : undefined}
              disabled={!props.onChooseFolder}
              onClick={() => { void props.onChooseFolder?.(); }}>
              {props.backupAdapterStatus === "loading" ? "Checking folder backup…"
                : props.onChooseFolder ? "Choose backup folder"
                  : props.backupAdapterStatus === "error" ? "Folder backup needs retry"
                    : "Choose backup folder (not available)"}
            </button>
            {props.backupAdapterStatus === "error" ? <button
              className="primary" disabled={!props.onRetryBackupAdapter}
              onClick={() => { void props.onRetryBackupAdapter?.(); }}>
              Retry folder support
            </button> : null}
          </div>
          {props.backupAdapterStatus === "loading"
            ? <p role="status">Checking whether this browser can use a backup folder…</p>
            : props.backupAdapterStatus === "error"
              ? <p role="alert">Folder backup could not load. Your app data was not changed.</p>
              : props.backupAdapterStatus === "unavailable"
                ? <p>Folder backup is not supported here. This app remains in OPFS only.</p>
                : null}
        </section>

        <section aria-labelledby="recovery-failures-title">
          <h3 id="recovery-failures-title">Recent backup problems</h3>
          {props.failures.length === 0 ? <p className="shape-evolution-empty">No backup failures recorded.</p> : (
            <ul>
              {props.failures.slice(0, 20).map(failure => (
                <li key={failure.id}>{recoveryFailureMessage(failure.reasonCode)}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="recovery-history-title">
          <h3 id="recovery-history-title">Backup history</h3>
          {props.history.length === 0 ? <p className="shape-evolution-empty">No verified backups yet.</p> : (
            <ol>
              {props.history.slice(0, 64).map(item => (
                <li className="recovery-history-item" key={item.backupId}>
                  {formatDate(item.verifiedAt)}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby="recovery-local-title">
          <h3 id="recovery-local-title">Recover recent changes</h3>
          <p>
            Review the exact item before applying it. Recovery is published through the same
            authority as ordinary writes. If newer relationships or values conflict, Clay stops
            and keeps the current state.
          </p>

          <h4>Records and attachments</h4>
          {props.recordCandidates.length === 0
            ? <p className="shape-evolution-empty">No recent record snapshots are recoverable.</p>
            : <ul>
              {props.recordCandidates.slice(0, 20).map(candidate => (
                <li key={`${candidate.table}\u0000${candidate.id}`}>
                  <strong>{candidate.deleted ? "Deleted" : "Earlier"} {candidate.table} record</strong>
                  {` · ${formatDate(candidate.historyAt)}`}
                  {candidate.attachmentCount > 0
                    ? ` · restores ${candidate.attachmentCount} attached file${candidate.attachmentCount === 1 ? "" : "s"}`
                    : ""}
                  <button className="link" disabled={recoveryBusy || !props.onRestoreRecord}
                    onClick={() => void runRecoveryAction(
                      props.onRestoreRecord ? () => props.onRestoreRecord!(candidate) : undefined,
                      "Record snapshot restored. The prior current state remains undoable.",
                    )}>
                    {candidate.deleted ? "Restore deleted record" : "Undo latest record change"}
                  </button>
                </li>
              ))}
            </ul>}

          <h4>Operation batches</h4>
          {props.recentBatches.filter(batch => !batch.undone).length === 0
            ? <p className="shape-evolution-empty">No recent batch is available to undo.</p>
            : <ul>
              {props.recentBatches.filter(batch => !batch.undone).slice(0, 20).map(batch => (
                <li key={batch.id}>
                  <strong>{batch.summary}</strong>{` · ${batch.changed} record${batch.changed === 1 ? "" : "s"}`}
                  <button className="link" disabled={recoveryBusy || !props.onUndoBatch}
                    onClick={() => void runRecoveryAction(
                      props.onUndoBatch ? () => props.onUndoBatch!(batch) : undefined,
                      `Undid “${batch.summary}”.`,
                    )}>Undo this batch</button>
                </li>
              ))}
            </ul>}

          <h4>Structural history</h4>
          {props.structuralHistory.length < 2
            ? <p className="shape-evolution-empty">No earlier structure is available.</p>
            : <ol>
              {[...props.structuralHistory].reverse().slice(1, 20).map(entry => (
                <li key={entry.version}>
                  <strong>Version {entry.version}</strong>{` · ${entry.summary}`}
                  <button className="link" disabled={recoveryBusy || !props.onRewindStructure}
                    onClick={() => void runRecoveryAction(
                      props.onRewindStructure
                        ? () => props.onRewindStructure!(entry.version) : undefined,
                      `Rewound structure to version ${entry.version}.`,
                    )}>Rewind here</button>
                </li>
              ))}
            </ol>}
          {recoveryMessage ? <p role={recoveryMessage.includes("could not") ? "alert" : "status"}>
            {recoveryMessage}
          </p> : null}
          {props.recoveryFailures.length > 0 ? <details>
            <summary>Earlier recovery conflicts</summary>
            <ul>{props.recoveryFailures.slice(0, 20).map(failure => (
              <li key={failure.id}>{formatDate(failure.at)} · {failure.action} · {failure.code}</li>
            ))}</ul>
          </details> : null}
        </section>

        <section aria-labelledby="recovery-restore-title">
          <h3 id="recovery-restore-title">Restore as a new app</h3>
          <p>Format 5 creates a separate app. Your original app is never replaced.</p>
          <div className="rail-actions">
            <label className="shape-history-open file-label">
              Choose a .clay backup
              <input type="file" accept=".clay" disabled={!props.onValidateRestore}
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void checkRestore(file);
                  event.target.value = "";
                }} />
            </label>
            <button className={canRestore ? "primary" : undefined} disabled={!canRestore}
              onClick={() => void restoreAsNew()}>{props.onValidateRestore && props.onRestoreAsNew
                ? "Restore as new app" : "Restore as new app (not available yet)"}</button>
          </div>
          <p role={restoreStatus === "invalid" || targetDrifted ? "alert" : "status"}>
            {restoreMessage}
          </p>
        </section>
      </div>
    </ModalDialog>
  );
}
