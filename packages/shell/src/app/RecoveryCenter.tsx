import { useState } from "react";
import {
  parseAuthenticatedFormat5RestoreGrant,
  type AuthenticatedFormat5RestoreGrant,
  type BackupFailureReasonCode,
} from "@clay/kernel/recovery";
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

export type RecoveryCenterProps = {
  appName: string;
  /** Exact worker-owned identity. Null keeps restore fail-closed. */
  authoritativeAppInstanceId: string | null;
  opfsAvailable: boolean;
  backupTarget: RecoveryBackupTarget | null;
  lastVerifiedBackup: RecoveryBackupSummary | null;
  failures: RecoveryFailureSummary[];
  history: RecoveryBackupSummary[];
  onClose: () => void;
  onRetry?: () => Promise<void>;
  onChooseFolder?: () => Promise<void>;
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

  const currentGrant = exactGrant(restoreGrant, props.authoritativeAppInstanceId);
  const targetDrifted = restoreGrant !== null && currentGrant === null;
  const canRestore = currentGrant !== null && props.onRestoreAsNew !== undefined;


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

  return (
    <ModalDialog className="shape-map recovery-center" backdropClassName="shape-map-backdrop"
      ariaLabelledBy="recovery-center-title" onClose={props.onClose}>
      <header className="shape-map-header">
        <h2 id="recovery-center-title">Recovery Center</h2>
        <button className="shape-map-close" aria-label="Close Recovery Center" onClick={props.onClose}>×</button>
      </header>

      <div className="shape-column" style={{ overflowY: "auto", minHeight: 0 }}
        role="region" aria-label="Recovery Center details" tabIndex={0}>
        <section aria-labelledby="recovery-target-title">
          <h3 id="recovery-target-title">Protection target</h3>
          <dl>
            <div><dt>Current app</dt><dd>{props.opfsAvailable
              ? `${props.appName} is saved in this browser’s private storage (OPFS) only.`
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
            <button className={props.onChooseFolder ? "primary" : undefined} disabled={!props.onChooseFolder}
              onClick={() => { void props.onChooseFolder?.(); }}>
              {props.onChooseFolder ? "Choose backup folder" : "Choose backup folder (not available yet)"}
            </button>
          </div>
          {!props.onChooseFolder ? <p>Folder backup is not available yet. This app remains in OPFS only.</p> : null}
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
