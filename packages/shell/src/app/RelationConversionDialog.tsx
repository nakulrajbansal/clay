import { errorMessage } from "./error-message";
import { FocusSelect } from "./FocusControl";
import { useMemo, useRef, useState } from "react";
import type { RelationConversionPreview, RegTable } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { ModalDialog } from "./ModalDialog";
import { beginPresentationIntent, cancelPresentationIntent, finishPresentationIntent, readPresentationIntent, reconcilePresentation } from "./presentation-intent";

const label = (name: string): string => name.replace(/_/g, " ")
  .replace(/^./, character => character.toUpperCase());

export function RelationConversionDialog(props: {
  sourceTable: RegTable;
  appInstanceId: string | null;
  tables: RegTable[];
  worker: WorkerClient;
  runWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  onClose: () => void;
  onCommitted: (result: { relationField: string; convertedRows: number; historical?: boolean }) => void | Promise<void>;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [recovery] = useState(() => {
    try { return { keep: props.appInstanceId ? readPresentationIntent(sessionStorage, props.appInstanceId, "relation") : null,
      undo: props.appInstanceId ? readPresentationIntent(sessionStorage, props.appInstanceId, "conversionUndo") : null, error: "" }; }
    catch { return { keep: null, undo: null, error: "Stored connection request needs recovery. No new request can replace it." }; }
  });
  const [undoIntent, setUndoIntent] = useState(recovery.undo);
  const [completed, setCompleted] = useState(!!recovery.undo && !recovery.keep);
  const working = useRef(false);
  const sourceFields = useMemo(() => props.sourceTable.columns.filter(column =>
    !column.hidden && !column.inactive
      && (column.type === "text" || column.type === "enum" || column.type === "rich_text")),
  [props.sourceTable]);
  const targetTables = props.tables.filter(table => table.name !== props.sourceTable.name);
  const [sourceField, setSourceField] = useState(sourceFields[0]?.name ?? "");
  const [targetTable, setTargetTable] = useState(targetTables[0]?.name ?? "");
  const target = props.tables.find(table => table.name === targetTable);
  const displayFields = (target?.columns ?? []).filter(column => !column.hidden && !column.inactive
    && (column.type === "text" || column.type === "enum" || column.type === "rich_text"));
  const [displayField, setDisplayField] = useState("");
  const effectiveDisplay = displayFields.some(field => field.name === displayField)
    ? displayField : displayFields[0]?.name ?? "";
  const [preview, setPreview] = useState<RelationConversionPreview | null>(recovery.keep?.payload as unknown as RelationConversionPreview ?? null);
  const [busy, setBusy] = useState(false);
  const pendingKeep = useRef(recovery.keep);
  const [needsReconciliation, setNeedsReconciliation] = useState(!!recovery.keep);

  const analyze = async (): Promise<void> => {
    if (!sourceField || !targetTable || !effectiveDisplay || working.current || recovery.error || completed) return;
    working.current = true;
    setBusy(true);
    try {
      setPreview(await props.worker.previewRelationConversion({
        sourceTable: props.sourceTable.name,
        sourceField, targetTable, displayField: effectiveDisplay,
      }));
    } catch (error) {
      props.onError(errorMessage(error));
    } finally { working.current = false; setBusy(false); }
  };

  const connect = async (): Promise<void> => {
    if (!preview || !props.appInstanceId || working.current || recovery.error) return;
    working.current = true;
    setBusy(true);
    try {
      const intent = pendingKeep.current ?? beginPresentationIntent(sessionStorage, props.appInstanceId, "relation",
        "schema.convertTextToRelation", { ...preview, cardinality: "one" }, () => props.worker.createMutationContext());
      pendingKeep.current = intent;
      if (intent.appInstanceId !== props.appInstanceId) throw new Error("Return to the connection's original app");
      await props.runWrite(async () => {
        let historical = false;
        const result = await reconcilePresentation(props.worker, intent, () => props.worker.convertTextToRelation(
          intent.payload as unknown as RelationConversionPreview & { cardinality: "one" }, { requestId: intent.requestId }), current => { historical = !current; });
        let undo = readPresentationIntent(sessionStorage, intent.appInstanceId, "conversionUndo");
        if (undo && (undo.payload.conversionRequestId !== intent.requestId || undo.payload.beforeVersion !== intent.payload.atVersion))
          throw new Error("Previous conversion Undo needs reconciliation first");
        if (!undo) {
          const outcome = await props.worker.mutationOutcome(intent.route, intent.payload, { requestId: intent.requestId });
          if (outcome.status !== "recorded") throw new Error("Original conversion receipt needs recovery before presenting Undo");
          undo = beginPresentationIntent(sessionStorage, intent.appInstanceId, "conversionUndo", "schema.undoRelationConversion",
            { conversionRequestId: intent.requestId, beforeVersion: intent.payload.atVersion, authorityTarget: outcome.target }, () => props.worker.createMutationContext());
        }
        setUndoIntent(undo);
        await props.onCommitted({ ...result, historical });
        finishPresentationIntent(sessionStorage, intent.appInstanceId, "relation", intent.requestId);
        pendingKeep.current = null; setCompleted(true); setNeedsReconciliation(false);
      });
    } catch (error) {
      props.onError(errorMessage(error));
      setNeedsReconciliation(true);
    } finally { working.current = false; setBusy(false); }
  };
  const undo = async (): Promise<void> => {
    if (!undoIntent || working.current || undoIntent.appInstanceId !== props.appInstanceId) return;
    working.current = true; setBusy(true);
    try {
      let historical = false;
      await props.runWrite(() => reconcilePresentation(props.worker, undoIntent, () => props.worker.undoRelationConversion(
        String(undoIntent.payload.conversionRequestId), Number(undoIntent.payload.beforeVersion), { requestId: undoIntent.requestId },
        undoIntent.payload.authorityTarget as import("@clay/schema/catalog").TargetEvidenceV1 | undefined), current => { historical = !current; }));
      await props.onCommitted({ relationField: "", convertedRows: 0, historical });
      finishPresentationIntent(sessionStorage, undoIntent.appInstanceId, "conversionUndo", undoIntent.requestId);
      setUndoIntent(null); setCompleted(false); setPreview(null);
    } catch (error) { props.onError(error instanceof Error ? error.message : "Undo needs recovery"); }
    finally { working.current = false; setBusy(false); }
  };
  const cancelPending = async (): Promise<void> => {
    const intent = pendingKeep.current;
    if (!intent || working.current || intent.appInstanceId !== props.appInstanceId) return;
    working.current = true; setBusy(true);
    try {
      if (await cancelPresentationIntent(sessionStorage, props.worker, intent)) {
        pendingKeep.current = null; setNeedsReconciliation(false); setPreview(null);
      } else props.onError("Keep already committed. Retry Keep to read its exact result; it cannot be cancelled.");
    } catch (error) { props.onError(error instanceof Error ? error.message : "Cancellation needs recovery"); }
    finally { working.current = false; setBusy(false); }
  };
  const keepLinkedRecords = async (): Promise<void> => {
    if (!undoIntent || working.current || undoIntent.appInstanceId !== props.appInstanceId) return;
    working.current = true; setBusy(true);
    try {
      if (await cancelPresentationIntent(sessionStorage, props.worker, undoIntent)) {
        setUndoIntent(null); props.onClose();
      } else props.onError("Undo already committed. Retry Undo to acknowledge the result; the request was kept.");
    } catch (error) { props.onError(error instanceof Error ? error.message : "Undo needs recovery"); }
    finally { working.current = false; setBusy(false); }
  };

  return (
    <ModalDialog className="ui ui-background-panel ui-base-border-8f9f0d ui-base-border-radius-c431a0 relation-dialog" backdropClassName="ui ui-display-flex ui-align-items-center ui-position-fixed ui-inset-0 ui-overflow-auto ui-justify-content-center modal-backdrop relation-backdrop"
      ariaLabelledBy="relation-dialog-title" onClose={props.onClose}>
      <header className="ui ui-display-flex ui-justify-content-space-between ui-border-bottom-line ui-p-margin-9d8b39 ui-p-color-a3a3fb ui-base-padding-6fe44b relation-dialog-header">
        <div>
          <span className="ui ui-color-accent-text ui-text-transform-uppercase record-detail-kicker">Connected work</span>
          <h2 id="relation-dialog-title">Turn text into linked records</h2>
          <p>Clay keeps the original text hidden. Undo is available only while the exact converted state is unchanged.</p>
        </div>
        <button aria-label="Close linked-record setup" onClick={props.onClose}>✕</button>
      </header>

      <div className="ui ui-display-grid ui-gap-14px ui-label-display-b369c3 ui-select-color-8a3cd5 ui-select-font-d3b791 ui-label-gap-931d54 ui-select-border-f5f110 ui-select-width-96bdbe ui-select-background-25bcef relation-dialog-grid">
        {recovery.error ? <p role="alert">{recovery.error}</p> : null}
        <label>Text field
          <FocusSelect autoFocus value={sourceField} disabled={busy || needsReconciliation || completed}
            onChange={event => { setSourceField(event.target.value); setPreview(null); }}>
            {sourceFields.map(field => <option key={field.name} value={field.name}>
              {field.label ?? label(field.name)}
            </option>)}
          </FocusSelect>
        </label>
        <span className="ui ui-color-accent-text ui-text-align-center relation-arrow" aria-hidden="true">→</span>
        <label>Link to table
          <select value={targetTable} disabled={busy || needsReconciliation || completed}
            onChange={event => {
              setTargetTable(event.target.value); setDisplayField(""); setPreview(null);
            }}>
            {targetTables.map(table => <option key={table.name} value={table.name}>
              {label(table.name)}
            </option>)}
          </select>
        </label>
        <label>Match using
          <select value={effectiveDisplay} disabled={busy || needsReconciliation || completed}
            onChange={event => { setDisplayField(event.target.value); setPreview(null); }}>
            {displayFields.map(field => <option key={field.name} value={field.name}>
              {field.label ?? label(field.name)}
            </option>)}
          </select>
        </label>
      </div>

      {!preview ? (
        <div className="ui ui-display-grid ui-color-text-2 ui-text-align-center ui-gap-5px ui-base-border-radius-25b77c ui-base-border-9a0e96 relation-dialog-empty">
          <div className="ui ui-color-accent-text relation-preview-icon" aria-hidden="true">⌁</div>
          <strong>Preview every match first</strong>
          <span>Clay matches text case-insensitively and never guesses when target names are duplicated.</span>
        </div>
      ) : (
        <section className="ui ui-display-grid ui-gap-8px ui-p-color-a3a3fb ui-p-font-size-9ca3bf relation-preview" aria-live="polite">
          <div className="ui ui-display-grid ui-border-radius-10px ui-background-bg ui-span-color-e1f86b relation-stat good"><strong>{preview.matchedRows}</strong><span>matched</span></div>
          <div className="ui ui-display-grid ui-border-radius-10px ui-background-bg ui-span-color-e1f86b relation-stat"><strong>{preview.unmatchedRows}</strong><span>unmatched</span></div>
          <div className="ui ui-display-grid ui-border-radius-10px ui-background-bg ui-span-color-e1f86b relation-stat warn"><strong>{preview.ambiguousRows}</strong><span>ambiguous</span></div>
          <div className="ui ui-display-grid ui-border-radius-10px ui-background-bg ui-span-color-e1f86b relation-stat"><strong>{preview.duplicateSourceRows}</strong><span>repeated text</span></div>
          {preview.unmatchedSamples.length > 0 ? (
            <p><strong>Unmatched:</strong> {preview.unmatchedSamples.join(", ")}</p>
          ) : null}
          {preview.ambiguousSamples.length > 0 ? (
            <p><strong>Needs a unique target:</strong> {preview.ambiguousSamples.join(", ")}</p>
          ) : null}
          <p className="ui ui-border-radius-8px ui-background-bg relation-preview-note">
            Unmatched and ambiguous rows stay unlinked. Their original text remains recoverable.
          </p>
        </section>
      )}

      <footer className="ui ui-display-flex ui-gap-8px ui-button-font-590948 ui-border-top-line ui-justify-content-flex-end ui-button-background-9f7e57 ui-button-color-353ba8 ui-primary-background-1be894 ui-primary-border-color-f73659 relation-dialog-actions">
        {needsReconciliation ? <p role="status">The Keep outcome needs checking. Retry the same request, or close and inspect History. No changes are discarded by closing.</p> : null}
        {needsReconciliation ? <button disabled={busy || !!recovery.error} onClick={() => void cancelPending()}>Cancel pending Keep and re-preview</button> : null}
        <button disabled={busy} onClick={props.onClose}>{needsReconciliation ? "Close" : preview ? "Discard preview" : "Cancel"}</button>
        {completed && undoIntent ? <>
          <button disabled={busy} onClick={() => void undo()}>Undo this conversion</button>
          <button disabled={busy} onClick={() => void keepLinkedRecords()}>Keep linked records</button>
        </> : !preview ? (
          <button className="primary" disabled={busy || !!recovery.error || !props.appInstanceId || !sourceField || !targetTable || !effectiveDisplay}
            onClick={() => void analyze()}>{busy ? "Checking…" : "Preview matches"}</button>
        ) : (
          <button className="primary" disabled={busy || !!recovery.error || !props.appInstanceId}
            onClick={() => void connect()}>{busy ? "Connecting…" : needsReconciliation ? "Retry Keep" : `Keep — connect ${preview.matchedRows} rows`}</button>
        )}
      </footer>
    </ModalDialog>
  );
}
