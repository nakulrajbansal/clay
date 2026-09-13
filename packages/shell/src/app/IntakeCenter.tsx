import { useEffect, useMemo, useRef, useState } from "react";
import type {
  IntakeAcceptanceReceipt, IntakeAutoAcceptSimulation, IntakeDeliveryFailure, IntakeInboxItem,
  RegColumn, RegTable, SemanticSchemaTraceV1,
} from "@clay/kernel";
import type {
  IntakeAutoAcceptDraftV1, LocalIntakeFormV2, PublicIntakeFormV1,
} from "@clay/schema/intake";
import type { WorkerClient } from "./worker-client";
import { ModalDialog } from "./ModalDialog";
import { IntakeSession, type IntakeRead } from "../intake/session";
import { IntakePublication } from "../intake/publication";
import { IntakeOwnerClient } from "../intake/owner-client";
import { IndexedDbIntakeOwnerVault } from "../intake/owner-custody.browser";
import type { IntakeOwnerVault } from "../intake/owner-custody";
import { ownerIntakeFetch } from "../intake/relay-owner-configuration";
import { IndexedDbIntakeWorkflows, IntakeWorkflowSlot, UnfencedIntakeWorkflowError, type IntakeWorkflows } from "../intake/workflows";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PreviewDraft = {
  authorityTarget: IntakeRead["authorityTarget"];
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

function AutoAcceptControls({ form, worker, authorityTarget, enabled, disabled, onInfo, onError, onChange }: {
  form: LocalIntakeFormV2;
  worker: IntakeSession;
  authorityTarget: IntakeRead["authorityTarget"];
  enabled: boolean;
  disabled: boolean;
  onChange: () => Promise<void>;
  onInfo: (message: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [fieldId, setFieldId] = useState(form.publicForm.fields[0]?.fieldId ?? "");
  const [operator, setOperator] = useState<"equals" | "is_present">("is_present");
  const [value, setValue] = useState("");
  const [simulation, setSimulation] = useState<{ result: IntakeAutoAcceptSimulation; target: IntakeRead["authorityTarget"]; draft: IntakeAutoAcceptDraftV1 } | null>(null);
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
    try {
      const reviewedDraft = draft();
      const outcome = await worker.commandOutcome<IntakeAutoAcceptSimulation>("intake.simulateAutoAccept", { draft: reviewedDraft }, authorityTarget);
      // A newer presentation read must not rebase the reviewed simulation.
      setSimulation({ ...outcome, draft: reviewedDraft }); await onChange();
    }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const enable = async (): Promise<void> => {
    if (!simulation) return;
    setBusy(true);
    try {
      await worker.command("intake.enableAutoAccept", { draft: simulation.draft, simulationFingerprint: simulation.result.fingerprint }, simulation.target);
      await onChange();
      onInfo("Automatic acceptance enabled for this exact previewed rule.");
      setSimulation(null);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <details className="intake-rule">
    <summary>Optional automatic acceptance</summary>
    <p>{enabled ? "Enabled while this app is open on this device." : "Off. Preview an exact rule before enabling."} Files always require owner review.</p>
    <fieldset disabled={disabled || busy}><div className="intake-rule-grid">
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
      <b>{simulation.result.matchedSubmissionIds.length} of {simulation.result.pendingCount}</b> pending submissions match.
      <p>No changes have been made. Review this result before enabling.</p>
      <button disabled={busy} onClick={() => void enable()}>Enable this exact rule</button>
    </div> : null}
    <button className="link-button" onClick={() => void worker.command("intake.disableAutoAccept", { formId: form.publicForm.formId }, authorityTarget)
      .then(async () => { await onChange(); onInfo("Automatic acceptance disabled."); })
      .catch(cause => onError(cause instanceof Error ? cause.message : String(cause)))}>
      Disable automatic acceptance
    </button></fieldset>
  </details>;
}

export function IntakeCenter(props: {
  worker: WorkerClient;
  appInstanceId: string;
  ownerVault?: IntakeOwnerVault;
  workflows?: IntakeWorkflows;
  tables: RegTable[];
  semanticTrace: SemanticSchemaTraceV1;
  relayBaseUrl: string | null;
  publicBaseUrl: string;
  fetchImpl?: FetchLike;
  onClose: () => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onWrite?: () => void;
}): React.JSX.Element {
  const session = useMemo(() => new IntakeSession(sessionStorage, props.worker, props.appInstanceId), [props.worker, props.appInstanceId]);
  const vault = useMemo(() => props.ownerVault ?? new IndexedDbIntakeOwnerVault(), [props.ownerVault]);
  const workflows = useMemo(() => props.workflows ?? new IndexedDbIntakeWorkflows(), [props.workflows]);
  const configured = useMemo(() => {
    try {
      const configuration = { shellOrigin: location.origin, relayBaseUrl: props.relayBaseUrl, publicBaseUrl: props.publicBaseUrl };
      const fetchImpl = props.fetchImpl ?? (props.relayBaseUrl ? ownerIntakeFetch(props.relayBaseUrl) : undefined);
      return { publication: new IntakePublication(session, vault, configuration, fetchImpl, workflows), owner: new IntakeOwnerClient(session, vault, configuration, fetchImpl, workflows), error: null };
    } catch { return { publication: null, owner: null, error: "Secure relay configuration is unavailable for this origin. Local review remains available." }; }
  }, [session, vault, workflows, props.relayBaseUrl, props.publicBaseUrl, props.fetchImpl]);
  const [read, setRead] = useState<IntakeRead | null>(null);
  const trace = read?.trace ?? props.semanticTrace;
  const eligibleTables = useMemo(() => (read?.tables ?? props.tables).filter(table =>
    !table.inactive && tableIdFor(trace, table.name)
    && table.columns.some(column => !column.hidden && !column.inactive
      && SCALAR_TYPES.has(column.type) && fieldIdFor(trace, table.name, column.name))),
  [read, props.tables, trace]);
  const [tab, setTab] = useState<"forms" | "inbox">("forms");
  const [forms, setForms] = useState<LocalIntakeFormV2[]>([]);
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
  const [retained, setRetained] = useState(false);
  const [retainedPublication, setRetainedPublication] = useState(false);
  const [retainedRevocation, setRetainedRevocation] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const workflowRecoveryError = useRef<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [confirmClosePublication, setConfirmClosePublication] = useState(false);
  const [closingPublication, setClosingPublication] = useState(false);
  const [closureRenewable, setClosureRenewable] = useState(false);
  const [closureReview, setClosureReview] = useState<{ target: IntakeRead["authorityTarget"]; requestId: string } | null>(null);
  const [legacyPublication, setLegacyPublication] = useState(false);
  const [legacyRevocation, setLegacyRevocation] = useState(false);
  const [revocationId, setRevocationId] = useState<string | null>(null);
  const [renewalReview, setRenewalReview] = useState<{ target: IntakeRead["authorityTarget"]; mode: "adopt" | "renew" } | null>(null);
  const ownsForm = (form: LocalIntakeFormV2 | undefined): boolean => !!form && !!read
    && form.ownerSource.appInstanceId === read.authorityTarget.appInstanceId
    && form.ownerSource.activeGenerationId === read.authorityTarget.activeGenerationId
    && form.ownerSource.lineageEpoch === read.authorityTarget.lineageEpoch;
  const updateRecovery = (): void => {
    if (workflowRecoveryError.current) { setRecoveryError(workflowRecoveryError.current); return; }
    try {
      setRetained(session.pending() !== null);
      // Configuration may disappear while an invocation is still ambiguous.
      // Detect presence without parsing or rebinding the original work.
      if ((!configured.publication && sessionStorage.getItem(`clay_intake_publication_v1:${props.appInstanceId}`) !== null)
          || (!configured.owner && sessionStorage.getItem(`clay_intake_revocation_v1:${props.appInstanceId}`) !== null)) throw new Error();
      setRetainedPublication(configured.publication?.pending() != null);
      setClosingPublication(configured.publication?.pending()?.termination != null);
      const publication = configured.publication?.pending(), source = session.reviewed?.authorityTarget;
      setClosureRenewable(!!publication?.termination?.authorityClosure && !publication.termination.complete && !publication.termination.closureReceipt
        && (publication.termination.renewals?.length ?? 0) < 8 && publication.source.appInstanceId === source?.appInstanceId
        && publication.source.activeGenerationId === source.activeGenerationId && publication.source.lineageEpoch === source.lineageEpoch);
      setRetainedRevocation(configured.owner?.pendingRevocation() != null);
      setRevocationId(configured.owner?.pendingRevocation()?.form.publicForm.formId ?? null);
      setRecoveryError(null);
    } catch { setRecoveryError("Retained intake work needs its original source and configuration. It has not been discarded."); }
  };
  const blocked = busy || !read || retained || retainedPublication || retainedRevocation || recoveryError !== null;

  const refresh = async (): Promise<void> => {
    let cacheOnlyPublication = false, cacheOnlyRevocation = false;
    try {
      if (configured.publication && configured.owner) {
        try { await configured.publication.recover(); }
        catch (cause) { if (!(cause instanceof UnfencedIntakeWorkflowError) || !configured.publication.pending()) throw cause; cacheOnlyPublication = true; }
        try { await configured.owner.recover(); }
        catch (cause) { if (!(cause instanceof UnfencedIntakeWorkflowError) || !configured.owner.pendingRevocation()) throw cause; cacheOnlyRevocation = true; }
      }
      else for (const kind of ["publication", "revocation"] as const) await new IntakeWorkflowSlot(workflows, sessionStorage, location.origin, props.appInstanceId, kind).recover();
      workflowRecoveryError.current = null;
      setLegacyPublication(cacheOnlyPublication); setLegacyRevocation(cacheOnlyRevocation);
    } catch (cause) {
      workflowRecoveryError.current = cause instanceof UnfencedIntakeWorkflowError ? cause.message
        : "Retained intake work needs its original source and configuration. It has not been discarded.";
      setRecoveryError(workflowRecoveryError.current); throw new Error("Intake workflow recovery is incomplete; new publication remains closed");
    }
    const next = await session.read(); setRead(next);
    setForms(next.forms); setInbox(next.inbox); setReceipts(next.receipts);
    setDeliveryFailures(next.deliveryFailures);
    if (cacheOnlyPublication || cacheOnlyRevocation) {
      // The cache can supply a review, never a late-client invocation fence.
      workflowRecoveryError.current = "Legacy intake work needs original-owner recovery. Active forms remain active until exact local and relay terminal proof succeed.";
      setRecoveryError(workflowRecoveryError.current); setRetained(session.pending() !== null);
      setRetainedPublication(configured.publication?.pending() != null); setClosingPublication(configured.publication?.pending()?.termination != null);
      setRetainedRevocation(configured.owner?.pendingRevocation() != null);
      setRevocationId(configured.owner?.pendingRevocation()?.form.publicForm.formId ?? null);
    } else updateRecovery();
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
    if (!read || blocked) return;
    const tableId = tableIdFor(trace, selectedTable.name);
    if (!tableId) return props.onError("This table does not have stable local identity yet.");
    const fields = scalarColumns.filter(column => selectedFields.includes(
      fieldIdFor(trace, selectedTable.name, column.name) ?? ""))
      .map(column => publicField(column,
        fieldIdFor(trace, selectedTable.name, column.name)!));
    if (fields.length === 0) return props.onError("Choose at least one field.");
    const fileRequests = fileColumns.filter(column => selectedFiles.includes(
      fieldIdFor(trace, selectedTable.name, column.name) ?? ""))
      .map(column => ({
        requestId: requestIdFor(column.name),
        fieldId: fieldIdFor(trace, selectedTable.name, column.name)!,
        label: column.label ?? column.name.replaceAll("_", " "),
        required: column.required,
        maxFiles: 1,
        maxBytes: 200_000,
        allowedMimeTypes: ["image/png", "image/jpeg", "text/plain"] as const,
      }));
    setPreview({
      authorityTarget: read.authorityTarget,
      title: title.trim(), description: description.trim(),
      target: { tableId, expectedSchemaVersion: trace.atVersion },
      fields, fileRequests: fileRequests.map(request => ({
        ...request, allowedMimeTypes: [...request.allowedMimeTypes],
      })),
    });
  };

  const publish = async (): Promise<void> => {
    if (busy || !configured.publication) return;
    setBusy(true);
    try {
      if (!configured.publication.pending()) {
        if (!preview || JSON.stringify(preview.authorityTarget) !== JSON.stringify(session.reviewed?.authorityTarget)) throw new Error("Review the changed intake source before publication");
        const { authorityTarget: _source, ...proposal } = preview;
        await configured.publication.begin({ ...proposal, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
      }
      const published = await configured.publication.resume();
      setShareLink(published.link); setPreview(null);
      await refresh();
      await configured.publication.finish();
      props.onInfo("Secure form published. Only the submit capability is in the public link.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); updateRecovery(); }
  };

  const refreshRelay = async (): Promise<void> => {
    setBusy(true);
    try {
      if (!configured.owner) throw new Error("Secure relay configuration is unavailable");
      const result = { staged: [] as IntakeInboxItem[], errors: [] as string[] };
      for (const form of forms.filter(form => ownsForm(form) && form.publishedAt !== null && form.revokedAt === null)) {
        try {
          result.staged.push(...await configured.owner.fetch(form));
          if (session.reviewed?.rules.some(rule => rule.formId === form.publicForm.formId && rule.enabled))
            await session.processIntakeAutoAccept(form.publicForm.formId);
        } catch {
          result.errors.push(form.publicForm.formId);
          if (session.pending()) break; // An uncertain writer must reconcile before another ID.
        }
      }
      await refresh(); props.onWrite?.();
      props.onInfo(result.staged.length
        ? `${result.staged.length} encrypted submission(s) staged for review.` : "Inbox is up to date.");
      if (result.errors.length > 0) props.onError(
        `${result.errors.length} form(s) could not be refreshed. Other active forms were still checked.`,
      );
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); updateRecovery(); }
  };

  const accept = async (item: IntakeInboxItem): Promise<void> => {
    setBusy(true);
    try {
      const fileIds = item.files.filter(file => approved[file.uploadId]).map(file => file.uploadId);
      await session.command("intake.acceptSubmission", { submissionId: item.submissionId, approvedFileIds: fileIds, mode: "manual" }, read?.authorityTarget);
      await refresh(); props.onWrite?.(); props.onInfo("Submission accepted with an undoable local receipt.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); updateRecovery(); }
  };

  const revoke = async (form?: LocalIntakeFormV2): Promise<void> => {
    setBusy(true);
    try {
      if (!configured.owner) throw new Error("Original relay configuration is required for revocation");
      await configured.owner.revoke(form); setPendingRevoke(null);
      await refresh(); props.onInfo("Form revoked. Its public link no longer accepts submissions.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); updateRecovery(); }
  };
  const closePublication = async (): Promise<void> => {
    if (!configured.publication || busy) return;
    setBusy(true);
    try {
      if (legacyPublication) await configured.publication.terminalizeLegacy(); else await configured.publication.terminalize();
      setConfirmClosePublication(false); setPreview(null); setShareLink("");
      await refresh(); props.onInfo("Original publication closed. Data and custody are kept. Review a fresh source before creating another form.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : "Original intake closure needs recovery"); }
    finally { await refresh().catch(() => {}); setBusy(false); updateRecovery(); }
  };
  const reviewClosure = async (): Promise<void> => {
    setBusy(true); setClosureReview(null);
    try {
      await refresh(); const job = configured.publication?.pending();
      const intent = job?.termination?.renewals?.at(-1)?.intent ?? job?.termination?.authorityClosure;
      if (!intent || !session.reviewed) throw new Error();
      setClosureReview({ target: session.reviewed.authorityTarget, requestId: intent.requestId });
    } catch { props.onError("Original publication closure is unavailable; retained work was kept."); }
    finally { setBusy(false); }
  };
  const renewClosure = async (): Promise<void> => {
    if (!configured.publication || !closureReview || busy) return;
    setBusy(true);
    try {
      await configured.publication.renewClosure(closureReview.target, closureReview.requestId); setClosureReview(null);
      await configured.publication.terminalize(); setConfirmClosePublication(false); setPreview(null); setShareLink("");
      props.onInfo("Original publication closure recovered. Prior requests, receipts and custody were kept; review a fresh source before another form.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : "Original closure recovery is incomplete"); }
    finally { await refresh().catch(() => {}); setBusy(false); updateRecovery(); }
  };
  const reviewRevocation = async (mode: "adopt" | "renew"): Promise<void> => {
    setBusy(true); setRenewalReview(null);
    try { await refresh(); setRenewalReview({ target: session.reviewed!.authorityTarget, mode }); }
    catch { props.onError("Original revocation source is unavailable; retained work was kept."); }
    finally { setBusy(false); }
  };
  const renewRevocation = async (): Promise<void> => {
    if (!configured.owner || !renewalReview) return;
    setBusy(true);
    try {
      if (renewalReview.mode === "adopt") {
        await configured.owner.adoptLegacyRevocation(renewalReview.target); setRenewalReview(null); await refresh();
        props.onInfo("Original owner custody verified and legacy revocation retained. Resume its outcome or explicitly review renewal; an active form has not been closed.");
      } else {
        await configured.owner.renewRevocation(renewalReview.target); setRenewalReview(null);
        await configured.owner.revoke(); await refresh();
        props.onInfo("Original invocation terminalized and reviewed local revocation completed. All request identities were kept.");
      }
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : "Revocation recovery remains incomplete"); }
    finally { await refresh().catch(() => {}); setBusy(false); updateRecovery(); }
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
      if (!configured.owner) throw new Error("Original relay configuration is required for delivery");
      const staged = await configured.owner.fetch(form, [failure.submissionId]);
      const unresolved = (await session.intakeDeliveryFailures()).some(item =>
        item.formId === failure.formId && item.submissionId === failure.submissionId);
      await refresh();
      if (staged.length > 0) props.onWrite?.();
      if (unresolved) props.onError("The delivery still could not be decrypted. You can retry or discard it.");
      else props.onInfo("Encrypted delivery recovered and staged for review.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); updateRecovery(); }
  };

  const discardDelivery = async (failure: IntakeDeliveryFailure): Promise<void> => {
    const form = forms.find(candidate => candidate.publicForm.formId === failure.formId);
    if (!form) {
      props.onError("The local form authority for this delivery is unavailable.");
      return;
    }
    setBusy(true);
    try {
      if (!configured.owner) throw new Error("Original relay configuration is required for discard");
      await configured.owner.discard(form, failure.submissionId);
      setPendingDiscard(null);
      await refresh();
      props.onInfo("Encrypted delivery permanently discarded after durable owner authorization.");
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); updateRecovery(); }
  };
  const localAction = async (action: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true);
    try { await action(); await refresh(); props.onWrite?.(); props.onInfo(message); }
    catch (cause) { props.onError(cause instanceof Error ? cause.message : "Intake action needs recovery"); }
    finally { setBusy(false); updateRecovery(); }
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
      {configured.error ? <p role="status">{configured.error}</p> : null}
      {read?.legacyCustody === "quarantined" ? <p role="alert">Legacy intake custody is quarantined. Original forms, private material and historical receipts are untouched. Archive export remains blocked until safe custody adoption.</p> : null}
      {recoveryError ? <p role="alert">{recoveryError}</p> : null}
      {retainedPublication ? <p role="status">Publication has a retained original form and request.
        {!closingPublication && !legacyPublication ? <button disabled={busy} onClick={() => void publish()}>Resume original publication</button> : null}
        {confirmClosePublication || closingPublication ? <span>Close this original publication before reviewing a new source? Original data and custody will be kept.
          <button disabled={busy} onClick={() => void closePublication()}>Confirm close original publication</button>
          {!closingPublication ? <button onClick={() => setConfirmClosePublication(false)}>Keep original publication</button> : null}</span>
          : <button disabled={busy} onClick={() => setConfirmClosePublication(true)}>Close original publication</button>}
        {closingPublication && closureRenewable ? <span>
          <button disabled={busy} onClick={() => void reviewClosure()}>Review closure recovery</button>
          {closureReview ? <span>Terminalize the reviewed original request and relay identity, then close this same publication against the reviewed source? All prior identities remain kept.
            <button disabled={busy} onClick={() => void renewClosure()}>Confirm renewed publication closure</button>
            <button disabled={busy} onClick={() => setClosureReview(null)}>Keep original closure</button></span> : null}</span> : null}</p> : null}
      {retainedRevocation ? <div role="status">Original revocation is retained. Local and relay outcomes still need reconciliation.
        {!legacyRevocation ? <button disabled={busy} onClick={() => void revoke()}>Resume original revocation</button> : null}
        <button disabled={busy || !read || !configured.owner || !forms.some(form => form.publicForm.formId === revocationId && ownsForm(form)
          && form.relayBaseUrl === configured.owner!.configuration.relayBaseUrl && form.publishedAt !== null && (legacyRevocation || form.revokedAt === null))}
          onClick={() => void reviewRevocation(legacyRevocation ? "adopt" : "renew")}>{legacyRevocation ? "Review legacy revocation recovery" : "Review revocation recovery"}</button>
        {renewalReview ? <p>{renewalReview.mode === "adopt" ? "Verify original owner custody and retain this exact legacy revocation for reconciliation? This does not close an active form."
          : "Close the original invocation and relay identity, then revoke this same form against the reviewed source?"} Prior requests and custody will be kept.
          <button disabled={busy} onClick={() => void renewRevocation()}>{renewalReview.mode === "adopt" ? "Confirm original-owner recovery" : "Confirm renewed local revocation"}</button>
          <button disabled={busy} onClick={() => setRenewalReview(null)}>Keep original revocation</button></p> : null}</div> : null}
      {retained && !retainedRevocation ? <p role="status">An original intake request needs reconciliation.
        <button disabled={busy} onClick={() => void localAction(() => session.retry(), "Original intake outcome recovered.")}>Retry original intake request</button>
        <button disabled={busy} onClick={() => void localAction(async () => {
          if (!await session.cancel()) throw new Error("The original request committed. Retry it to read the result before another action.");
        }, "Request terminalized without another effect.")}>Cancel uncommitted request</button></p> : null}

      {tab === "forms" ? <div className="intake-content">
        <section className="intake-author"><h3>Create a public form</h3><fieldset disabled={blocked || !configured.publication || read?.legacyCustody === "quarantined"}>
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
            const fieldId = fieldIdFor(trace, selectedTable!.name, column.name)!;
            return <label key={fieldId}><input type="checkbox" value={fieldId}
              checked={selectedFields.includes(fieldId)} onChange={event => {
                setSelectedFields(current => event.target.checked
                  ? [...current, fieldId] : current.filter(id => id !== fieldId)); setPreview(null);
              }} />{column.label ?? column.name}</label>;
          })}</fieldset>
          {fileColumns.length > 0 ? <fieldset><legend>Secure file requests (optional)</legend>
            {fileColumns.map(column => {
              const fieldId = fieldIdFor(trace, selectedTable!.name, column.name)!;
              return <label key={fieldId}><input type="checkbox" value={fieldId}
                checked={selectedFiles.includes(fieldId)} onChange={event => {
                  setSelectedFiles(current => event.target.checked
                    ? [...current, fieldId] : current.filter(id => id !== fieldId)); setPreview(null);
                }} />{column.label ?? column.name} · passive files only · 200,000 bytes</label>;
            })}</fieldset> : null}
          <button className="primary" disabled={!title.trim()} onClick={makePreview}>Review form</button>
          <p>At most five files. The complete local intake command remains bounded to 2,000,000 UTF-8 bytes.</p></fieldset></section>
        {preview ? <section className="intake-preview" aria-label="Form publication preview"><h3>Review before publishing</h3>
          <p><b>{preview.title}</b></p><p>{preview.fields.length} answer field(s) · {preview.fileRequests.length} file request(s)</p>
          <ul>{preview.fields.map(field => <li key={field.fieldId}>{field.label}{field.required ? " · required" : ""}</li>)}</ul>
          <p>Nothing has been published yet. The relay will receive capabilities and ciphertext, never answers or file names.</p>
          <button className="primary" disabled={blocked || !configured.publication} onClick={() => void publish()}>{busy ? "Publishing…" : "Publish secure form"}</button>
          <button disabled={busy} onClick={() => setPreview(null)}>Discard preview</button>
        </section> : null}
        {shareLink ? <section className="intake-share"><h3>Public link</h3>
          <input readOnly value={shareLink} aria-label="Public intake link" />
          <button onClick={() => void navigator.clipboard?.writeText(shareLink)
            .then(() => props.onInfo("Link copied."))}>Copy link</button></section> : null}
        <section className="intake-existing"><h3>Published forms</h3>
          {forms.length === 0 ? <p>No forms yet.</p> : forms.map(form => <article key={form.publicForm.formId}>
            <div><b>{form.publicForm.title}</b><small>{form.terminalReason === "expired"
              ? "Expired" : form.revokedAt ? "Revoked" : form.publishedAt ? "Published" : "Draft"}</small></div>
            {!ownsForm(form) ? <p>Copied form metadata is read-only. Delivery and review authority remain with the original app and generation.</p> : null}
            {ownsForm(form) && form.publishedAt && !form.revokedAt ? <>
              <button disabled={blocked || !configured.owner} onClick={() => void localAction(async () => {
                setShareLink(await configured.owner!.link(form));
              }, "Original public link recovered from trusted-shell custody.")}>Show public link</button>
              {pendingRevoke === form.publicForm.formId ? <span>Stop accepting new submissions? Existing local records are kept.
                <button disabled={busy || retained || retainedRevocation || recoveryError !== null || (!closingPublication && blocked) || !configured.owner} onClick={() => void revoke(form)}>Confirm revocation</button>
                <button onClick={() => setPendingRevoke(null)}>Keep form active</button></span>
                : <button disabled={busy || retained || retainedRevocation || recoveryError !== null || (!closingPublication && blocked) || !configured.owner} onClick={() => setPendingRevoke(form.publicForm.formId)}>Revoke</button>}
              {read ? <AutoAcceptControls form={form} worker={session} authorityTarget={read.authorityTarget} disabled={blocked}
                enabled={read?.rules.some(rule => rule.formId === form.publicForm.formId) ?? false} onChange={refresh}
                onInfo={props.onInfo} onError={message => { updateRecovery(); props.onError(message); }} /> : null}
            </> : null}
          </article>)}</section>
      </div> : <div className="intake-content intake-inbox">
        <div className="intake-inbox-actions"><p>Submissions stay untrusted here until you accept one.</p>
          <button disabled={blocked || !configured.owner} onClick={() => void refreshRelay()}>{busy ? "Refreshing…" : "Refresh encrypted inbox"}</button></div>
        {deliveryFailures.length > 0 ? <section className="intake-failures"
          aria-labelledby="intake-delivery-recovery-title">
          <h3 id="intake-delivery-recovery-title">Encrypted delivery recovery</h3>
          <p>These relay items could not be decrypted. Only an opaque fingerprint is retained locally.</p>
          {deliveryFailures.map(failure => {
            const form = forms.find(candidate => candidate.publicForm.formId === failure.formId);
            const key = `${failure.formId}/${failure.submissionId}`;
            const retryable = ownsForm(form) && failure.status === "failed" && form?.publishedAt !== null
              && form?.revokedAt === null
              && Date.parse(form?.publicForm.delivery.expiresAt ?? "") > Date.now();
            return <article className="intake-failure" key={key}>
              <div><b>{form?.publicForm.title ?? "Unavailable local form"}</b>
                <small>{failure.status === "discard_authorized"
                  ? "Discard authorized; relay acknowledgement pending" : "Decryption failed"}</small></div>
              <code>{failure.submissionId}</code>
              <small>Envelope fingerprint {failure.envelopeSha256.slice(0, 12)}… · {failure.failedAt}</small>
              <div className="intake-card-actions">
                {retryable ? <button disabled={blocked || !configured.owner}
                  onClick={() => void retryDelivery(failure)}>Retry delivery</button> : null}
                {failure.status === "discard_authorized" ? <button disabled={blocked || !configured.owner || !ownsForm(form)}
                  onClick={() => void discardDelivery(failure)}>Finish authorized discard</button>
                  : pendingDiscard === key ? <div className="intake-discard-confirm" role="group"
                    aria-label={`Confirm discard ${failure.submissionId}`}>
                    <span>This permanently deletes the encrypted relay item.</span>
                    <button className="danger" disabled={blocked || !configured.owner || !ownsForm(form)}
                      onClick={() => void discardDelivery(failure)}>Confirm permanent discard</button>
                    <button disabled={busy} onClick={() => setPendingDiscard(null)}>Keep delivery</button>
                  </div> : <button disabled={blocked || !configured.owner || !ownsForm(form)}
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
              <input type="checkbox" disabled={blocked || !ownsForm(form) || file.status !== "quarantined" || item.status !== "pending"}
                checked={approved[file.uploadId] === true} onChange={event =>
                  setApproved(current => ({ ...current, [file.uploadId]: event.target.checked }))} />
              <span><b>{file.name}</b><small>{file.mime} · {file.size} bytes · SHA-256 {file.sha256}</small>
                <em>{file.status}{file.reason ? `: ${file.reason}` : ""}</em></span>
            </label>)}
            {item.status === "pending" || item.status === "blocked" ? <div className="intake-card-actions">
              {item.status === "pending" ? <button className="primary" disabled={blocked || !ownsForm(form)} onClick={() => void accept(item)}>Accept selected files & create record</button> : null}
              <button disabled={blocked || !ownsForm(form)} onClick={() => void localAction(() => session.command("intake.rejectSubmission", { submissionId: item.submissionId }, read?.authorityTarget), "Submission rejected.")}>Reject</button>
            </div> : null}
          </article>;
        })}
        {receipts.length > 0 ? <section className="intake-receipts"><h3>Acceptance receipts</h3>{receipts.map(receipt =>
          <article key={receipt.id}><span>{receipt.mode === "auto" ? "Automatically" : "Manually"} accepted · {receipt.acceptedAt}</span>
            {receipt.undoneAt ? <em>Undone</em> : <button disabled={blocked || !ownsForm(forms.find(form => form.publicForm.formId === receipt.formId))} onClick={() => void localAction(() => session.command("intake.undoReceipt", { receiptId: receipt.id }, read?.authorityTarget), "Acceptance undone.")}>Undo acceptance</button>}</article>)}</section> : null}
      </div>}
  </ModalDialog>;
}
