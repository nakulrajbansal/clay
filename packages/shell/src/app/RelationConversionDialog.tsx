import { useMemo, useRef, useState } from "react";
import type { RelationConversionPreview, RegTable } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { ModalDialog } from "./ModalDialog";
import { beginPresentationIntent, finishPresentationIntent, readPresentationIntent, reconcilePresentation } from "./presentation-intent";

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
      props.onError(error instanceof Error ? error.message : String(error));
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
        const undo = beginPresentationIntent(sessionStorage, intent.appInstanceId, "conversionUndo", "schema.undoRelationConversion",
          { conversionRequestId: intent.requestId, beforeVersion: intent.payload.atVersion }, () => props.worker.createMutationContext());
        setUndoIntent(undo);
        await props.onCommitted({ ...result, historical });
        finishPresentationIntent(sessionStorage, intent.appInstanceId, "relation", intent.requestId);
        pendingKeep.current = null; setCompleted(true); setNeedsReconciliation(false);
      });
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
      setNeedsReconciliation(true);
    } finally { working.current = false; setBusy(false); }
  };
  const undo = async (): Promise<void> => {
    if (!undoIntent || working.current || undoIntent.appInstanceId !== props.appInstanceId) return;
    working.current = true; setBusy(true);
    try {
      let historical = false;
      await props.runWrite(() => reconcilePresentation(props.worker, undoIntent, () => props.worker.undoRelationConversion(
        String(undoIntent.payload.conversionRequestId), Number(undoIntent.payload.beforeVersion), { requestId: undoIntent.requestId }), current => { historical = !current; }));
      await props.onCommitted({ relationField: "", convertedRows: 0, historical });
      finishPresentationIntent(sessionStorage, undoIntent.appInstanceId, "conversionUndo", undoIntent.requestId);
      setUndoIntent(null); setCompleted(false); setPreview(null);
    } catch (error) { props.onError(error instanceof Error ? error.message : "Undo needs recovery"); }
    finally { working.current = false; setBusy(false); }
  };

  return (
    <ModalDialog className="relation-dialog" backdropClassName="modal-backdrop relation-backdrop"
      ariaLabelledBy="relation-dialog-title" onClose={props.onClose}>
      <header className="relation-dialog-header">
        <div>
          <span className="record-detail-kicker">Connected work</span>
          <h2 id="relation-dialog-title">Turn text into linked records</h2>
          <p>Clay keeps the original text hidden. Undo is available only while the exact converted state is unchanged.</p>
        </div>
        <button aria-label="Close linked-record setup" onClick={props.onClose}>✕</button>
      </header>

      <div className="relation-dialog-grid">
        {recovery.error ? <p role="alert">{recovery.error}</p> : null}
        <label>Text field
          <select autoFocus value={sourceField} disabled={busy || needsReconciliation || completed}
            onChange={event => { setSourceField(event.target.value); setPreview(null); }}>
            {sourceFields.map(field => <option key={field.name} value={field.name}>
              {field.label ?? label(field.name)}
            </option>)}
          </select>
        </label>
        <span className="relation-arrow" aria-hidden="true">→</span>
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
        <div className="relation-dialog-empty">
          <div className="relation-preview-icon" aria-hidden="true">⌁</div>
          <strong>Preview every match first</strong>
          <span>Clay matches text case-insensitively and never guesses when target names are duplicated.</span>
        </div>
      ) : (
        <section className="relation-preview" aria-live="polite">
          <div className="relation-stat good"><strong>{preview.matchedRows}</strong><span>matched</span></div>
          <div className="relation-stat"><strong>{preview.unmatchedRows}</strong><span>unmatched</span></div>
          <div className="relation-stat warn"><strong>{preview.ambiguousRows}</strong><span>ambiguous</span></div>
          <div className="relation-stat"><strong>{preview.duplicateSourceRows}</strong><span>repeated text</span></div>
          {preview.unmatchedSamples.length > 0 ? (
            <p><strong>Unmatched:</strong> {preview.unmatchedSamples.join(", ")}</p>
          ) : null}
          {preview.ambiguousSamples.length > 0 ? (
            <p><strong>Needs a unique target:</strong> {preview.ambiguousSamples.join(", ")}</p>
          ) : null}
          <p className="relation-preview-note">
            Unmatched and ambiguous rows stay unlinked. Their original text remains recoverable.
          </p>
        </section>
      )}

      <footer className="relation-dialog-actions">
        {needsReconciliation ? <p role="status">The Keep outcome needs checking. Retry the same request, or close and inspect History. No changes are discarded by closing.</p> : null}
        <button disabled={busy} onClick={props.onClose}>{needsReconciliation ? "Close" : preview ? "Discard preview" : "Cancel"}</button>
        {completed && undoIntent ? <>
          <button disabled={busy} onClick={() => void undo()}>Undo this conversion</button>
          <button disabled={busy} onClick={() => {
            try { finishPresentationIntent(sessionStorage, undoIntent.appInstanceId, "conversionUndo", undoIntent.requestId);
              setUndoIntent(null); props.onClose(); } catch (error) { props.onError(error instanceof Error ? error.message : "Cleanup needs retry"); }
          }}>Keep linked records</button>
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
