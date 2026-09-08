import { useEffect, useMemo, useState } from "react";
import type {
  IntakeAcceptanceReceipt, IntakeAutoAcceptSimulation, IntakeDeliveryFailure, IntakeInboxItem,
  RegColumn, RegTable, SemanticSchemaTraceV1,
} from "@clay/kernel";
import type {
  IntakeAutoAcceptDraftV1, LocalIntakeFormV1, PublicIntakeFormV1,
} from "@clay/schema/intake";
import type { WorkerClient } from "./worker-client";
import { ModalDialog } from "./ModalDialog";
import {
  buildPublicIntakeLink, createLocalIntakeForm, discardFailedIntakeDelivery,
  fetchAndStageIntake, publishIntakeForm, refreshPublishedIntakeForms,
  revokePublishedIntakeForm,
} from "../intake/client";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PreviewDraft = {
  title: string;
  description: string;
  target: PublicIntakeFormV1["target"];
  fields: PublicIntakeFormV1["fields"];
  fileRequests: PublicIntakeFormV1["fileRequests"];
};

const SCALAR_TYPES = new Set([
  "text", "rich_text", "number", "integer", "boolean", "date", "enum",
]);
const RECIPES = [
  ["customer_request", "Customer request"],
  ["job_intake", "Job intake"],
  ["expense_submission", "Expense submission"],
  ["application_form", "Application form"],
  ["approval_request", "Approval request"],
] as const;

function fieldIdFor(trace: SemanticSchemaTraceV1, table: string, field: string): string | null {
  return trace.fields.find(candidate => candidate.tableName === table
    && candidate.fieldName === field && candidate.state === "visible")?.fieldId ?? null;
}

function tableIdFor(trace: SemanticSchemaTraceV1, table: string): string | null {
  return trace.tables.find(candidate => candidate.name === table && candidate.state === "visible")?.tableId ?? null;
}

function publicField(column: RegColumn, fieldId: string): PublicIntakeFormV1["fields"][number] {
  return {
    fieldId,
    label: column.label ?? column.name.replaceAll("_", " "),
    type: column.type as PublicIntakeFormV1["fields"][number]["type"],
    required: column.required,
    maxLength: column.type === "rich_text" ? 20_000 : column.type === "text" ? 4_000 : null,
    options: column.type === "enum" ? [...(column.values ?? [])] : [],
  };
}

function requestIdFor(name: string): string {
  const safe = `file_${name}`.toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 41);
  return /^[a-z]/u.test(safe) ? safe : `file_${safe}`.slice(0, 41);
}

function AutoAcceptControls({ form, worker, onInfo, onError }: {
  form: LocalIntakeFormV1;
  worker: WorkerClient;
  onInfo: (message: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [fieldId, setFieldId] = useState(form.publicForm.fields[0]?.fieldId ?? "");
  const [operator, setOperator] = useState<"equals" | "is_present">("is_present");
  const [value, setValue] = useState("");
  const [simulation, setSimulation] = useState<IntakeAutoAcceptSimulation | null>(null);
  const [busy, setBusy] = useState(false);
  if (form.publicForm.fileRequests.length > 0) return (
    <p className="intake-rule-note">Automatic acceptance is unavailable: requested files always need owner review.</p>
  );
  const draft = (): IntakeAutoAcceptDraftV1 => ({
    schema: 1,
    formId: form.publicForm.formId,
    formRevision: form.publicForm.revision,
    expectedSchemaVersion: form.publicForm.target.expectedSchemaVersion,
    conditions: [{ fieldId, op: operator, value: operator === "equals" ? value : null }],
  });
  const preview = async (): Promise<void> => {
    setBusy(true); setSimulation(null);
    try { setSimulation(await worker.simulateIntakeAutoAccept(draft())); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const enable = async (): Promise<void> => {
    if (!simulation) return;
    setBusy(true);
    try {
      await worker.enableIntakeAutoAccept(draft(), simulation.fingerprint);
      onInfo("Automatic acceptance enabled for this exact previewed rule.");
      setSimulation(null);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <details className="intake-rule">
    <summary>Optional automatic acceptance</summary>
    <p>Off by default. Only this deterministic rule can accept matching submissions.</p>
    <div className="intake-rule-grid">
      <select aria-label="Auto-accept field" value={fieldId}
        onChange={event => { setFieldId(event.target.value); setSimulation(null); }}>
        {form.publicForm.fields.map(field => <option key={field.fieldId} value={field.fieldId}>{field.label}</option>)}
      </select>
      <select aria-label="Auto-accept operator" value={operator}
        onChange={event => { setOperator(event.target.value as typeof operator); setSimulation(null); }}>
        <option value="is_present">is present</option><option value="equals">equals</option>
      </select>
      {operator === "equals" ? <input aria-label="Auto-accept value" value={value}
        onChange={event => { setValue(event.target.value); setSimulation(null); }} /> : null}
      <button disabled={busy || !fieldId || (operator === "equals" && !value)}
        onClick={() => void preview()}>Preview auto-accept</button>
    </div>
    {simulation ? <div className="intake-rule-preview" role="status">
      <b>{simulation.matchedSubmissionIds.length} of {simulation.pendingCount}</b> pending submissions match.
      <p>No changes have been made. Review this result before enabling.</p>
      <button disabled={busy} onClick={() => void enable()}>Enable this exact rule</button>
    </div> : null}
    <button className="link-button" onClick={() => void worker.disableIntakeAutoAccept(form.publicForm.formId)
      .then(() => onInfo("Automatic acceptance disabled."))
      .catch(cause => onError(cause instanceof Error ? cause.message : String(cause)))}>
      Disable automatic acceptance
    </button>
  </details>;
}

export function IntakeCenter(props: {
  worker: WorkerClient;
  tables: RegTable[];
  semanticTrace: SemanticSchemaTraceV1;
  relayBaseUrl: string;
  publicBaseUrl: string;
  fetchImpl?: FetchLike;
  onClose: () => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onWrite?: () => void;
}): React.JSX.Element {
  const eligibleTables = useMemo(() => props.tables.filter(table =>
    !table.inactive && tableIdFor(props.semanticTrace, table.name)
    && table.columns.some(column => !column.hidden && !column.inactive
      && SCALAR_TYPES.has(column.type) && fieldIdFor(props.semanticTrace, table.name, column.name))),
  [props.tables, props.semanticTrace]);
  const [tab, setTab] = useState<"forms" | "inbox">("forms");
  const [forms, setForms] = useState<LocalIntakeFormV1[]>([]);
  const [inbox, setInbox] = useState<IntakeInboxItem[]>([]);
  const [receipts, setReceipts] = useState<IntakeAcceptanceReceipt[]>([]);
  const [deliveryFailures, setDeliveryFailures] = useState<IntakeDeliveryFailure[]>([]);
  const [tableName, setTableName] = useState(eligibleTables[0]?.name ?? "");
  const [recipe, setRecipe] = useState<typeof RECIPES[number][0]>("customer_request");
  const [title, setTitle] = useState("Customer request");
  const [description, setDescription] = useState("Tell us what you need and we will review it securely.");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewDraft | null>(null);
  const [shareLink, setShareLink] = useState("");
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [pendingDiscard, setPendingDiscard] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const [nextForms, nextInbox, nextReceipts, nextDeliveryFailures] = await Promise.all([
      props.worker.listIntakeForms(), props.worker.intakeInbox(), props.worker.intakeReceipts(),
      props.worker.intakeDeliveryFailures(),
    ]);
    setForms(nextForms); setInbox(nextInbox); setReceipts(nextReceipts);
    setDeliveryFailures(nextDeliveryFailures);
  };
  useEffect(() => { void refresh().catch(cause =>
    props.onError(cause instanceof Error ? cause.message : String(cause))); }, []);

  const selectedTable = eligibleTables.find(table => table.name === tableName) ?? eligibleTables[0];
  const scalarColumns = (selectedTable?.columns ?? []).filter(column =>
    !column.hidden && !column.inactive && SCALAR_TYPES.has(column.type)
    && (column.type !== "enum" || (column.values?.length ?? 0) > 0));
  const fileColumns = (selectedTable?.columns ?? []).filter(column =>
    column.type === "attachment" && !column.hidden && !column.inactive);

  const makePreview = (): void => {
    if (!selectedTable) return props.onError("Create a table before publishing an intake form.");
    const tableId = tableIdFor(props.semanticTrace, selectedTable.name);
    if (!tableId) return props.onError("This table does not have stable local identity yet.");
    const fields = scalarColumns.filter(column => selectedFields.includes(
      fieldIdFor(props.semanticTrace, selectedTable.name, column.name) ?? ""))
      .map(column => publicField(column,
        fieldIdFor(props.semanticTrace, selectedTable.name, column.name)!));
    if (fields.length === 0) return props.onError("Choose at least one field.");
    const fileRequests = fileColumns.filter(column => selectedFiles.includes(
      fieldIdFor(props.semanticTrace, selectedTable.name, column.name) ?? ""))
      .map(column => ({
        requestId: requestIdFor(column.name),
        fieldId: fieldIdFor(props.semanticTrace, selectedTable.name, column.name)!,
        label: column.label ?? column.name.replaceAll("_", " "),
        required: column.required,
        maxFiles: 1,
        maxBytes: 5 * 1024 * 1024,
        allowedMimeTypes: ["image/png", "image/jpeg", "text/plain"] as const,
      }));
    setPreview({
      title: title.trim(), description: description.trim(),
      target: { tableId, expectedSchemaVersion: props.semanticTrace.atVersion },
      fields, fileRequests: fileRequests.map(request => ({
        ...request, allowedMimeTypes: [...request.allowedMimeTypes],
      })),
    });
  };

  const publish = async (): Promise<void> => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const expiry = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const localForm = await createLocalIntakeForm({
        ...preview, relayBaseUrl: props.relayBaseUrl, expiresAt: expiry,
      });
      const published = await publishIntakeForm({
        worker: props.worker, localForm, publicBaseUrl: props.publicBaseUrl,
        fetchImpl: props.fetchImpl,
      });
      setShareLink(published.link); setPreview(null);
      await refresh();
      props.onInfo("Secure form published. Only the submit capability is in the public link.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const refreshRelay = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await refreshPublishedIntakeForms(
        props.worker, forms, props.fetchImpl,
      );
      const activeForms = forms.filter(candidate => candidate.publishedAt !== null
        && candidate.revokedAt === null
        && Date.parse(candidate.publicForm.delivery.expiresAt) > Date.now());
      for (const form of activeForms.filter(candidate =>
        candidate.publicForm.fileRequests.length === 0)) {
        try { await props.worker.processIntakeAutoAccept(form.publicForm.formId); }
        catch { /* rule is opt-in and normally absent */ }
      }
      await refresh(); props.onWrite?.();
      props.onInfo(result.staged.length
        ? `${result.staged.length} encrypted submission(s) staged for review.` : "Inbox is up to date.");
      if (result.errors.length > 0) props.onError(
        `${result.errors.length} form(s) could not be refreshed. Other active forms were still checked.`,
      );
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const accept = async (item: IntakeInboxItem): Promise<void> => {
    setBusy(true);
    try {
      const fileIds = item.files.filter(file => approved[file.uploadId]).map(file => file.uploadId);
      await props.worker.acceptIntakeSubmission(item.submissionId, fileIds);
      await refresh(); props.onWrite?.(); props.onInfo("Submission accepted with an undoable local receipt.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const revoke = async (form: LocalIntakeFormV1): Promise<void> => {
    setBusy(true);
    try {
      await revokePublishedIntakeForm(props.worker, form, props.fetchImpl);
      await refresh(); props.onInfo("Form revoked. Its public link no longer accepts submissions.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const retryDelivery = async (failure: IntakeDeliveryFailure): Promise<void> => {
    const form = forms.find(candidate => candidate.publicForm.formId === failure.formId);
    if (!form || form.publishedAt === null || form.revokedAt !== null
        || Date.parse(form.publicForm.delivery.expiresAt) <= Date.now()) {
      props.onError("This form is no longer active, so the encrypted delivery cannot be retried.");
      return;
    }
    setBusy(true);
    try {
      const staged = await fetchAndStageIntake(props.worker, form, props.fetchImpl, {
        retrySubmissionIds: [failure.submissionId],
      });
      const unresolved = (await props.worker.intakeDeliveryFailures()).some(item =>
        item.formId === failure.formId && item.submissionId === failure.submissionId);
      await refresh();
      if (staged.length > 0) props.onWrite?.();
      if (unresolved) props.onError("The delivery still could not be decrypted. You can retry or discard it.");
      else props.onInfo("Encrypted delivery recovered and staged for review.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const discardDelivery = async (failure: IntakeDeliveryFailure): Promise<void> => {
    const form = forms.find(candidate => candidate.publicForm.formId === failure.formId);
    if (!form) {
      props.onError("The local form authority for this delivery is unavailable.");
      return;
    }
    setBusy(true);
    try {
      await discardFailedIntakeDelivery(
        props.worker, form, failure.submissionId, props.fetchImpl,
      );
      setPendingDiscard(null);
      await refresh();
      props.onInfo("Encrypted delivery permanently discarded after durable owner authorization.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <ModalDialog className="intake-center" backdropClassName="intake-backdrop"
    ariaLabelledBy="intake-title" onClose={props.onClose}>
      <header className="intake-center-header"><div><span className="eyebrow">Secure intake</span>
        <h2 id="intake-title">Forms & review inbox</h2></div>
        <button aria-label="Close intake" onClick={props.onClose}>×</button></header>
      <nav className="intake-tabs" aria-label="Intake sections">
        <button aria-pressed={tab === "forms"} onClick={() => setTab("forms")}>Forms</button>
        <button aria-pressed={tab === "inbox"} onClick={() => setTab("inbox")}>Review inbox
          {inbox.filter(item => item.status === "pending" || item.status === "blocked").length > 0
            ? ` (${inbox.filter(item => item.status === "pending" || item.status === "blocked").length})` : ""}</button>
      </nav>

      {tab === "forms" ? <div className="intake-content">
        <section className="intake-author"><h3>Create a public form</h3>
          <label>Recipe<select value={recipe} onChange={event => {
            const id = event.target.value as typeof recipe;
            setRecipe(id); setTitle(RECIPES.find(item => item[0] === id)![1]); setPreview(null);
          }}>{RECIPES.map(item => <option key={item[0]} value={item[0]}>{item[1]}</option>)}</select></label>
          <label>Save accepted answers in<select value={tableName} onChange={event => {
            setTableName(event.target.value); setSelectedFields([]); setSelectedFiles([]); setPreview(null);
          }}>{eligibleTables.map(table => <option key={table.name} value={table.name}>{table.name}</option>)}</select></label>
          <label>Form title<input value={title} maxLength={100}
            onChange={event => { setTitle(event.target.value); setPreview(null); }} /></label>
          <label>Description<textarea value={description} maxLength={1_000}
            onChange={event => { setDescription(event.target.value); setPreview(null); }} /></label>
          <fieldset><legend>Allowed answer fields</legend>{scalarColumns.map(column => {
            const fieldId = fieldIdFor(props.semanticTrace, selectedTable!.name, column.name)!;
            return <label key={fieldId}><input type="checkbox" value={fieldId}
              checked={selectedFields.includes(fieldId)} onChange={event => {
                setSelectedFields(current => event.target.checked
                  ? [...current, fieldId] : current.filter(id => id !== fieldId)); setPreview(null);
              }} />{column.label ?? column.name}</label>;
          })}</fieldset>
          {fileColumns.length > 0 ? <fieldset><legend>Secure file requests (optional)</legend>
            {fileColumns.map(column => {
              const fieldId = fieldIdFor(props.semanticTrace, selectedTable!.name, column.name)!;
              return <label key={fieldId}><input type="checkbox" value={fieldId}
                checked={selectedFiles.includes(fieldId)} onChange={event => {
                  setSelectedFiles(current => event.target.checked
                    ? [...current, fieldId] : current.filter(id => id !== fieldId)); setPreview(null);
                }} />{column.label ?? column.name} · passive files only · 5 MB</label>;
            })}</fieldset> : null}
          <button className="primary" disabled={!title.trim()} onClick={makePreview}>Review form</button>
        </section>
        {preview ? <section className="intake-preview" aria-label="Form publication preview"><h3>Review before publishing</h3>
          <p><b>{preview.title}</b></p><p>{preview.fields.length} answer field(s) · {preview.fileRequests.length} file request(s)</p>
          <ul>{preview.fields.map(field => <li key={field.fieldId}>{field.label}{field.required ? " · required" : ""}</li>)}</ul>
          <p>Nothing has been published yet. The relay will receive capabilities and ciphertext, never answers or file names.</p>
          <button className="primary" disabled={busy} onClick={() => void publish()}>{busy ? "Publishing…" : "Publish secure form"}</button>
        </section> : null}
        {shareLink ? <section className="intake-share"><h3>Public link</h3>
          <input readOnly value={shareLink} aria-label="Public intake link" />
          <button onClick={() => void navigator.clipboard?.writeText(shareLink)
            .then(() => props.onInfo("Link copied."))}>Copy link</button></section> : null}
        <section className="intake-existing"><h3>Published forms</h3>
          {forms.length === 0 ? <p>No forms yet.</p> : forms.map(form => <article key={form.publicForm.formId}>
            <div><b>{form.publicForm.title}</b><small>{form.terminalReason === "expired"
              ? "Expired" : form.revokedAt ? "Revoked" : form.publishedAt ? "Published" : "Draft"}</small></div>
            {form.publishedAt && !form.revokedAt ? <>
              <input readOnly aria-label={`Link for ${form.publicForm.title}`}
                value={buildPublicIntakeLink(props.publicBaseUrl, form.relayBaseUrl, form.publicForm)} />
              <button disabled={busy} onClick={() => void revoke(form)}>Revoke</button>
              <AutoAcceptControls form={form} worker={props.worker}
                onInfo={props.onInfo} onError={props.onError} />
            </> : null}
          </article>)}</section>
      </div> : <div className="intake-content intake-inbox">
        <div className="intake-inbox-actions"><p>Submissions stay untrusted here until you accept one.</p>
          <button disabled={busy} onClick={() => void refreshRelay()}>{busy ? "Refreshing…" : "Refresh encrypted inbox"}</button></div>
        {deliveryFailures.length > 0 ? <section className="intake-failures"
          aria-labelledby="intake-delivery-recovery-title">
          <h3 id="intake-delivery-recovery-title">Encrypted delivery recovery</h3>
          <p>These relay items could not be decrypted. Only an opaque fingerprint is retained locally.</p>
          {deliveryFailures.map(failure => {
            const form = forms.find(candidate => candidate.publicForm.formId === failure.formId);
            const key = `${failure.formId}/${failure.submissionId}`;
            const retryable = failure.status === "failed" && form?.publishedAt !== null
              && form?.revokedAt === null
              && Date.parse(form?.publicForm.delivery.expiresAt ?? "") > Date.now();
            return <article className="intake-failure" key={key}>
              <div><b>{form?.publicForm.title ?? "Unavailable local form"}</b>
                <small>{failure.status === "discard_authorized"
                  ? "Discard authorized; relay acknowledgement pending" : "Decryption failed"}</small></div>
              <code>{failure.submissionId}</code>
              <small>Envelope fingerprint {failure.envelopeSha256.slice(0, 12)}… · {failure.failedAt}</small>
              <div className="intake-card-actions">
                {retryable ? <button disabled={busy}
                  onClick={() => void retryDelivery(failure)}>Retry delivery</button> : null}
                {failure.status === "discard_authorized" ? <button disabled={busy}
                  onClick={() => void discardDelivery(failure)}>Finish authorized discard</button>
                  : pendingDiscard === key ? <div className="intake-discard-confirm" role="group"
                    aria-label={`Confirm discard ${failure.submissionId}`}>
                    <span>This permanently deletes the encrypted relay item.</span>
                    <button className="danger" disabled={busy}
                      onClick={() => void discardDelivery(failure)}>Confirm permanent discard</button>
                    <button disabled={busy} onClick={() => setPendingDiscard(null)}>Keep delivery</button>
                  </div> : <button disabled={busy}
                    onClick={() => setPendingDiscard(key)}>Discard delivery…</button>}
              </div>
            </article>;
          })}
        </section> : null}
        {inbox.length === 0 ? <p>No submissions waiting.</p> : inbox.map(item => {
          const form = forms.find(candidate => candidate.publicForm.formId === item.formId);
          const labels = new Map(form?.publicForm.fields.map(field => [field.fieldId, field.label]) ?? []);
          return <article className={`intake-card ${item.status}`} key={item.submissionId}>
            <header><b>{item.formTitle}</b><span>{item.status}</span></header>
            <dl>{item.values.map(value => <div key={value.fieldId}><dt>{labels.get(value.fieldId) ?? "Answer"}</dt>
              <dd>{String(value.value)}</dd></div>)}</dl>
            {item.validationErrors.length ? <div role="alert" className="intake-alert">
              {item.validationErrors.join(" · ")}</div> : null}
            {item.files.map(file => <label className={`intake-file-review ${file.status}`} key={file.uploadId}>
              <input type="checkbox" disabled={file.status !== "quarantined" || item.status !== "pending"}
                checked={approved[file.uploadId] === true} onChange={event =>
                  setApproved(current => ({ ...current, [file.uploadId]: event.target.checked }))} />
              <span><b>{file.name}</b><small>{file.mime} · {file.size} bytes · SHA-256 {file.sha256}</small>
                <em>{file.status}{file.reason ? `: ${file.reason}` : ""}</em></span>
            </label>)}
            {item.status === "pending" ? <div className="intake-card-actions">
              <button className="primary" disabled={busy} onClick={() => void accept(item)}>Accept selected files & create record</button>
              <button disabled={busy} onClick={() => void props.worker.rejectIntakeSubmission(item.submissionId)
                .then(refresh).catch(cause => props.onError(cause instanceof Error ? cause.message : String(cause)))}>Reject</button>
            </div> : null}
          </article>;
        })}
        {receipts.length > 0 ? <section className="intake-receipts"><h3>Acceptance receipts</h3>{receipts.map(receipt =>
          <article key={receipt.id}><span>{receipt.mode === "auto" ? "Automatically" : "Manually"} accepted · {receipt.acceptedAt}</span>
            {receipt.undoneAt ? <em>Undone</em> : <button disabled={busy} onClick={() => void props.worker.undoIntakeReceipt(receipt.id)
              .then(async () => { await refresh(); props.onWrite?.(); props.onInfo("Acceptance undone."); })
              .catch(cause => props.onError(cause instanceof Error ? cause.message : String(cause)))}>Undo acceptance</button>}</article>)}</section> : null}
      </div>}
  </ModalDialog>;
}
