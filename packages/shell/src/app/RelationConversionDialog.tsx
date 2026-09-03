import { useMemo, useState } from "react";
import type { RelationConversionPreview, RegTable } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { ModalDialog } from "./ModalDialog";

const label = (name: string): string => name.replace(/_/g, " ")
  .replace(/^./, character => character.toUpperCase());

export function RelationConversionDialog(props: {
  sourceTable: RegTable;
  tables: RegTable[];
  worker: WorkerClient;
  onClose: () => void;
  onCommitted: (result: { relationField: string; convertedRows: number }) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
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
  const [preview, setPreview] = useState<RelationConversionPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const analyze = async (): Promise<void> => {
    if (!sourceField || !targetTable || !effectiveDisplay) return;
    setBusy(true);
    try {
      setPreview(await props.worker.previewRelationConversion({
        sourceTable: props.sourceTable.name,
        sourceField, targetTable, displayField: effectiveDisplay,
      }));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const connect = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await props.worker.convertTextToRelation({ ...preview, cardinality: "one" });
      props.onCommitted(result);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
      setPreview(null);
    } finally { setBusy(false); }
  };

  return (
    <ModalDialog className="relation-dialog" backdropClassName="modal-backdrop relation-backdrop"
      ariaLabelledBy="relation-dialog-title" onClose={props.onClose}>
      <header className="relation-dialog-header">
        <div>
          <span className="record-detail-kicker">Connected work</span>
          <h2 id="relation-dialog-title">Turn text into linked records</h2>
          <p>Clay keeps the original text hidden, so rewind and redo stay exact.</p>
        </div>
        <button aria-label="Close linked-record setup" onClick={props.onClose}>✕</button>
      </header>

      <div className="relation-dialog-grid">
        <label>Text field
          <select autoFocus value={sourceField}
            onChange={event => { setSourceField(event.target.value); setPreview(null); }}>
            {sourceFields.map(field => <option key={field.name} value={field.name}>
              {field.label ?? label(field.name)}
            </option>)}
          </select>
        </label>
        <span className="relation-arrow" aria-hidden="true">→</span>
        <label>Link to table
          <select value={targetTable}
            onChange={event => {
              setTargetTable(event.target.value); setDisplayField(""); setPreview(null);
            }}>
            {targetTables.map(table => <option key={table.name} value={table.name}>
              {label(table.name)}
            </option>)}
          </select>
        </label>
        <label>Match using
          <select value={effectiveDisplay}
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
        <button onClick={props.onClose}>Cancel</button>
        {!preview ? (
          <button className="primary" disabled={busy || !sourceField || !targetTable || !effectiveDisplay}
            onClick={() => void analyze()}>{busy ? "Checking…" : "Preview matches"}</button>
        ) : (
          <button className="primary" disabled={busy}
            onClick={() => void connect()}>{busy ? "Connecting…" : `Connect ${preview.matchedRows} rows`}</button>
        )}
      </footer>
    </ModalDialog>
  );
}
