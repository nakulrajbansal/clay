import {
  useEffect, useMemo, useState, type RefObject,
} from "react";
import type { AttachmentFile, AttachmentMetadata } from "@clay/kernel";
import type { ProjectionArtifactV1, ProjectionRequestV1 } from "@clay/kernel/projection";
import type { ShareApprovedScopeV1 } from "@clay/schema/share";
import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import { ModalDialog } from "../app/ModalDialog";
import type { LocalAttachmentAuthorityV1 } from "../app/projection-scope";
import {
  approveShareScopeV1, encryptApprovedShareV1,
  shareScopeRequiresReapprovalV1,
  type ShareAttachmentApprovalV1,
} from "./crypto";
import type { OwnerShareReceiptV1 } from "./owner-receipts";
import { ShareOwnerSession, type ShareOwnerRecord, type ShareOwnerVault } from "./owner-custody";
import { IndexedDbShareOwnerVault } from "./owner-custody.browser";
import type { ShareRelayClient } from "./relay-client";
import "./ShareDialog.css";

export type ShareFieldChoiceV1 = Readonly<{ fieldId: string; label: string }>;
export type ShareAttachmentChoiceV1 = ShareAttachmentApprovalV1
  & Readonly<Pick<LocalAttachmentAuthorityV1, "tableName" | "fieldName">>;
type ShareWorkerV1 = Readonly<{
  presentationSource(): Promise<TargetEvidenceV1>;
  projectExport(request: ProjectionRequestV1, signal?: AbortSignal): Promise<ProjectionArtifactV1>;
  attachmentsForRecord(
    table: string, rowId: string, field: string,
  ): Promise<AttachmentMetadata[]>;
  readAttachment(id: string): Promise<AttachmentFile>;
}>;

type ApprovalState = Readonly<{
  source: TargetEvidenceV1;
  scope: ShareApprovedScopeV1;
  expiresAt: string;
}>;

const DURATIONS = [
  { value: "1", label: "1 day", milliseconds: 24 * 60 * 60 * 1000 },
  { value: "7", label: "7 days", milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { value: "30", label: "30 days", milliseconds: 30 * 24 * 60 * 60 * 1000 },
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function expiration(now: Date, days: string): string {
  const duration = DURATIONS.find(option => option.value === days) ?? DURATIONS[1];
  return new Date(now.getTime() + duration.milliseconds).toISOString();
}

function selectedAttachmentChoices(
  choices: readonly ShareAttachmentChoiceV1[],
  ids: readonly string[],
): ShareAttachmentChoiceV1[] {
  return ids.map(id => {
    const matches = choices.filter(choice => choice.id === id);
    if (matches.length !== 1)
      throw new Error("The selected file authority changed. Reopen the share preview.");
    return matches[0]!;
  });
}

function sameAttachmentMetadata(
  expected: Pick<AttachmentMetadata, "id" | "name" | "mime" | "size" | "sha256">,
  current: Pick<AttachmentMetadata, "id" | "name" | "mime" | "size" | "sha256">,
): boolean {
  return expected.id === current.id && expected.name === current.name
    && expected.mime === current.mime && expected.size === current.size
    && expected.sha256 === current.sha256;
}

export function ShareDialog(props: Readonly<{
  worker: ShareWorkerV1;
  request: ProjectionRequestV1;
  fieldChoices: readonly ShareFieldChoiceV1[];
  attachmentChoices: readonly ShareAttachmentChoiceV1[];
  relay: ShareRelayClient | null;
  viewerOrigin: string;
  now?: () => Date;
  storage?: Storage;
  ownerVault?: ShareOwnerVault;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}>): React.JSX.Element {
  const clock = props.now ?? (() => new Date());
  const storage = props.storage ?? window.localStorage;
  const vault = useMemo(() => props.ownerVault ?? new IndexedDbShareOwnerVault(), [props.ownerVault]);
  const owner = useMemo(() => {
    try { return props.relay ? new ShareOwnerSession(vault, props.relay, location.origin, props.viewerOrigin,
      () => props.worker.presentationSource(), props.now) : null; } catch { return null; }
  }, [vault, props.relay, props.viewerOrigin, props.worker, props.now]);
  const initialFields = props.request.fieldIds.filter(id =>
    props.fieldChoices.some(choice => choice.fieldId === id));
  const [fieldIds, setFieldIds] = useState<readonly string[]>(initialFields);
  const [attachmentIds, setAttachmentIds] = useState<readonly string[]>([]);
  const [duration, setDuration] = useState("7");
  const [previewResult, setPreviewResult] = useState<Readonly<{
    requestKey: string; artifact: ProjectionArtifactV1; source: TargetEvidenceV1;
  }> | null>(null);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [needsReapproval, setNeedsReapproval] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<OwnerShareReceiptV1 | null>(null);
  const [records, setRecords] = useState<ShareOwnerRecord[]>([]);
  const [custodyReady, setCustodyReady] = useState(false);
  const receipts = records.map(row => row.receipt);
  const historicalReceipts = records.filter(row => row.state === "published" || row.state === "revoked").map(row => row.receipt);
  const createdState = records.find(row => row.request.shareId === created?.shareId)?.state;
  const pending = records.filter(row => row.state === "prepared" || row.state === "invoked" || row.state === "revoke_pending");
  const refreshCustody = async (): Promise<void> => {
    if (!owner) { setCustodyReady(false); return; }
    try { setRecords(await owner.list()); setCustodyReady(true); }
    catch { setCustodyReady(false); throw new Error("Owner custody needs recovery; existing encrypted links were kept"); }
  };
  useEffect(() => { void refreshCustody().catch(reason => setError(reason.message)); }, [owner]);

  const currentRequest = useMemo(() => ({
    ...props.request,
    fieldIds: props.request.fieldIds.filter(id => fieldIds.includes(id)),
    options: {
      ...props.request.options,
      redactedFieldIds: props.request.options.redactedFieldIds.filter(id => fieldIds.includes(id)),
    },
  } as ProjectionRequestV1), [props.request, fieldIds]);
  const requestKey = JSON.stringify(currentRequest);
  const artifact = previewResult?.requestKey === requestKey ? previewResult.artifact : null;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setPreviewResult(null);
    setError(null);
    if (currentRequest.fieldIds.length === 0) {
      setError("Choose at least one field to share.");
      return () => controller.abort();
    }
    void (async () => {
      const source = await props.worker.presentationSource();
      const next = await props.worker.projectExport(currentRequest, controller.signal);
      if (JSON.stringify(await props.worker.presentationSource()) !== JSON.stringify(source)) throw new Error("Sharing source changed during preview");
      return { next, source };
    })().then(({ next, source }) => {
      if (active) setPreviewResult({ requestKey, artifact: next, source });
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "Share preview failed.");
    });
    return () => { active = false; controller.abort(); };
    // requestKey is the canonical UI selection snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.worker, requestKey, previewRevision]);

  const invalidateApproval = (): void => {
    if (approval) setNeedsReapproval(true);
    setApproval(null);
    setCreated(null);
  };

  const toggleField = (fieldId: string): void => {
    invalidateApproval();
    setFieldIds(current => current.includes(fieldId)
      ? current.length === 1 ? current : current.filter(id => id !== fieldId)
      : props.request.fieldIds.filter(id => current.includes(id) || id === fieldId));
  };

  const toggleAttachment = (fileId: string): void => {
    invalidateApproval();
    setAttachmentIds(current => current.includes(fileId)
      ? current.filter(id => id !== fileId) : [...current, fileId]);
  };

  const approve = async (): Promise<void> => {
    if (!artifact) return;
    setError(null);
    try {
      const at = clock();
      const selectedAttachments = selectedAttachmentChoices(
        props.attachmentChoices, attachmentIds,
      );
      setApproval({
        source: previewResult!.source,
        scope: await approveShareScopeV1(currentRequest, selectedAttachments, artifact, at),
        expiresAt: expiration(at, duration),
      });
      setNeedsReapproval(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not approve this scope.");
    }
  };

  const create = async (): Promise<void> => {
    if (!approval || !artifact || busy || !owner || !custodyReady || pending.length) return;
    setBusy(true);
    setError(null);
    try {
      if (JSON.stringify(await props.worker.presentationSource()) !== JSON.stringify(approval.source)) {
        invalidateApproval(); throw new Error("Original sharing source changed; preview and approve again");
      }
      const selectedAttachments = selectedAttachmentChoices(
        props.attachmentChoices, attachmentIds,
      );
      let currentArtifact: ProjectionArtifactV1;
      try { currentArtifact = await props.worker.projectExport(currentRequest); }
      catch (reason) {
        invalidateApproval();
        throw reason;
      }
      if (await shareScopeRequiresReapprovalV1(
        approval.scope, currentRequest, selectedAttachments, currentArtifact,
      )) {
        invalidateApproval();
        throw new Error("The scope changed. Preview and approve again.");
      }
      const selectedFiles = await Promise.all(selectedAttachments.map(async choice => {
        let currentFiles: AttachmentMetadata[];
        try {
          currentFiles = await props.worker.attachmentsForRecord(
            choice.tableName, choice.source.recordId, choice.fieldName,
          );
        } catch {
          invalidateApproval();
          throw new Error(
            "An approved file source is no longer a current visible record field. Reopen the share preview.",
          );
        }
        const current = currentFiles.find(file => file.id === choice.id);
        if (!current || !sameAttachmentMetadata(choice, current)) {
          invalidateApproval();
          throw new Error(
            "An approved file is no longer attached to that record field. Reopen the share preview.",
          );
        }
        const loaded = await props.worker.readAttachment(choice.id);
        if (!sameAttachmentMetadata(choice, loaded)) {
          invalidateApproval();
          throw new Error("The approved file identity changed. Reopen the share preview.");
        }
        return { ...loaded, source: { ...choice.source } };
      }));
      const encrypted = await encryptApprovedShareV1({
        approval: approval.scope,
        request: currentRequest,
        artifact: currentArtifact,
        attachments: selectedFiles,
        expiresAt: approval.expiresAt,
      });
      const retained = await owner.prepare({ encrypted, source: approval.source, approval: approval.scope, title: artifact.projection.manifest.title });
      const published = await owner.publish(retained.request.shareId);
      setCreated(published.receipt); setApproval(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the encrypted link.");
    } finally { setBusy(false); await refreshCustody().catch(reason => setError(reason.message)); }
  };

  const revoke = async (receipt: OwnerShareReceiptV1): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (!owner) throw new Error("Original sharing configuration is required");
      const next = await owner.revoke(receipt.shareId);
      if (created?.shareId === receipt.shareId) setCreated(next.receipt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not revoke the link.");
    } finally { setBusy(false); await refreshCustody().catch(reason => setError(reason.message)); }
  };
  const resume = async (row: ShareOwnerRecord): Promise<void> => {
    if (!owner || busy) return;
    setBusy(true); setError(null);
    try { setCreated((row.state === "revoke_pending" ? await owner.revoke(row.request.shareId) : await owner.publish(row.request.shareId)).receipt); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Original share needs recovery"); }
    finally { setBusy(false); await refreshCustody().catch(reason => setError(reason.message)); }
  };

  const copy = async (): Promise<void> => {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); }
    catch { setError("Copy failed. Select the link and copy it manually."); }
  };

  const preview = artifact?.projection ?? null;
  return <ModalDialog
    className="ui ui-background-panel ui-color-text ui-base-border-f41cca ui-base-border-radius-c431a0 ui-overflow-auto ui-box-shadow-shadow-lg ui-padding-0 share-dialog"
    backdropClassName="ui ui-display-flex ui-align-items-center ui-position-fixed ui-inset-0 ui-overflow-auto ui-justify-content-center modal-backdrop share-dialog-backdrop"
    ariaLabelledBy="share-dialog-title"
    ariaDescribedBy="share-dialog-description"
    onClose={props.onClose}
    returnFocusRef={props.returnFocusRef}
  >
    <header className="ui ui-display-flex ui-justify-content-space-between ui-border-bottom-line ui-p-margin-9d8b39 share-dialog-header">
      <div>
        <span className="ui ui-color-accent-text ui-text-transform-uppercase record-detail-kicker">Encrypted snapshot</span>
        <h2 id="share-dialog-title">Create read-only share link</h2>
        <p id="share-dialog-description">
          Confirm the exact fields and files. Encryption happens here before the relay receives anything.
        </p>
      </div>
      <button type="button" aria-label="Close share dialog" onClick={props.onClose}>×</button>
    </header>
    {!owner ? <p role="status">Encrypted sharing requires explicit relay configuration bound to this origin. Local Print and CSV remain available.</p> : null}
    {storage.getItem("clay_owner_share_receipts_v1") !== null ? <p>Legacy share receipts remain untouched on this device. They are not rebound to this app.</p> : null}
    {pending.map(row => <section key={row.request.shareId} role="status"><p>{row.receipt.title}: {row.state === "revoke_pending" ? "revocation acknowledgement pending" : "original encrypted snapshot retained"}.</p>
      {row.receipt.relayBaseUrl !== props.relay?.baseUrl ? <p>Restore the original relay configuration to recover this snapshot. Its custody has not been moved.</p> : null}
      <button disabled={busy || row.receipt.relayBaseUrl !== props.relay?.baseUrl || (row.state !== "revoke_pending" && Date.parse(row.request.expiresAt) <= clock().getTime())}
        onClick={() => void resume(row)}>Retry original {row.state === "revoke_pending" ? "revocation" : "share"}</button>
      {row.state !== "revoke_pending" ? <button disabled={busy || row.receipt.relayBaseUrl !== props.relay?.baseUrl} onClick={() => void revoke(row.receipt)}>Revoke retained snapshot</button> : null}
    </section>)}

    <section className="ui ui-display-grid ui-gap-14px share-scope" aria-label="Share scope">
      <fieldset disabled={busy || pending.length > 0}>
        <legend>Fields included (stable-ID allowlist)</legend>
        {props.fieldChoices.map(field => <label key={field.fieldId}>
          <input type="checkbox" data-field-id={field.fieldId}
            checked={fieldIds.includes(field.fieldId)}
            onChange={() => toggleField(field.fieldId)} />
          {field.label}
        </label>)}
        <small>Hidden and unselected fields are excluded structurally.</small>
      </fieldset>
      <fieldset disabled={busy || pending.length > 0}>
        <legend>Files included (separate approval)</legend>
        {props.attachmentChoices.length === 0
          ? <p>No attached files are available for this snapshot.</p>
          : props.attachmentChoices.map(file => <label key={file.id}>
              <input type="checkbox" data-attachment-id={file.id}
                checked={attachmentIds.includes(file.id)}
                onChange={() => toggleAttachment(file.id)} />
              {file.name} · {formatBytes(file.size)}
            </label>)}
        <small>Files are excluded unless checked separately.</small>
      </fieldset>
      <label className="ui ui-justify-content-space-between share-expiry">Link expires
        <select disabled={busy || pending.length > 0} value={duration} onChange={event => {
          invalidateApproval();
          setDuration(event.currentTarget.value);
        }}>
          {DURATIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </section>

    {!preview && !error ? <div role="status" aria-live="polite">Building exact snapshot preview…</div> : null}
    {error ? <div className="share-error" role="alert">{error}</div> : null}
    {needsReapproval ? <p className="share-reapproval" role="status">
      Scope changed. Preview and approve again before creating a link.
    </p> : null}

    {preview ? <section className="ui ui-base-border-f41cca ui-base-border-radius-25b77c share-preview" aria-label="Exact share preview">
      <h3>{preview.manifest.title}</h3>
      <p>{preview.manifest.rowCount} rows × {preview.manifest.fieldCount} fields · frozen snapshot</p>
      <div className="ui ui-overflow-auto share-preview-scroll" tabIndex={0}>
        <table>
          <thead><tr>{preview.manifest.fields.map((field, index) =>
            <th scope="col" key={`${field.name}-${index}`}>{field.label}</th>)}</tr></thead>
          <tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>
            {row.map((value, index) => <td key={index}>{value || "—"}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </section> : null}

    {created ? <section className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-9px ui-base-border-radius-25b77c ui-base-border-c04950 ui-input-min-width-39910f share-created" aria-live="polite">
      <h3>{createdState === "revoke_pending" ? "Revocation acknowledgement pending" : created.revokedAt ? "Link revoked" : Date.parse(created.expiresAt) <= clock().getTime() ? "Link expired" : "Encrypted link ready"}</h3>
      <input data-share-link readOnly value={created.url} aria-label="Encrypted share link" />
      {createdState === "published" && !created.revokedAt && Date.parse(created.expiresAt) > clock().getTime() ? <>
        <button type="button" onClick={() => void copy()}>Copy link</button>
        <button type="button" disabled={busy} onClick={() => void revoke(created)}>Revoke link</button>
      </> : <p>Revocation or expiry stops future relay retrieval. Copies already downloaded cannot be recalled.</p>}
    </section> : null}

    {historicalReceipts.some(receipt => receipt.shareId !== created?.shareId) ?
      <details className="ui ui-article-align-items-c91e3c share-history"><summary>Earlier links</summary>
        {historicalReceipts.filter(receipt => receipt.shareId !== created?.shareId).map(receipt =>
          <article key={receipt.shareId}>
            <span>{receipt.title} · expires {new Date(receipt.expiresAt).toLocaleDateString()}</span>
            {receipt.revokedAt ? <strong>Revoked</strong>
              : <><button disabled={busy || pending.length > 0} onClick={() => setCreated(receipt)}>Show retained link</button><button type="button" disabled={busy || receipt.relayBaseUrl !== props.relay?.baseUrl}
                  onClick={() => void revoke(receipt)}>Revoke</button></>}
          </article>)}
      </details> : null}

    <footer className="ui ui-display-flex ui-background-panel ui-gap-10px ui-border-top-line ui-justify-content-flex-end ui-base-position-df0639 share-dialog-actions">
      <button type="button" onClick={props.onClose}>Cancel</button>
      <button type="button" disabled={busy || pending.length > 0} onClick={() => {
        invalidateApproval(); setPreviewRevision(value => value + 1);
      }}>Review a fresh snapshot</button>
      <button type="button" disabled={!artifact || busy || !owner || !custodyReady || pending.length > 0}
        onClick={() => void approve()}>Approve this exact scope</button>
      <button type="button" className="primary" disabled={!approval || !artifact || busy || !owner || !custodyReady || pending.length > 0}
        onClick={() => void create()}>{busy ? "Creating…" : "Create encrypted link"}</button>
    </footer>
  </ModalDialog>;
}
