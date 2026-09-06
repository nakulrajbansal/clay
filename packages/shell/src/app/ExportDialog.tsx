import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  projectionCsvTextV1,
  type ProjectionArtifactV1, type ProjectionPlaintextV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
import { ModalDialog } from "./ModalDialog";
import type { WorkerClient } from "./worker-client";
import "./ExportDialog.css";

export type ProjectionFieldChoiceV1 = Readonly<{
  fieldId: ProjectionRequestV1["fieldIds"][number];
  label: string;
}>;

type ExportWorker = Pick<WorkerClient, "projectExport">;

const FILTER_LABELS: Record<string, string> = {
  eq: "equals", neq: "does not equal", gt: "is greater than", gte: "is at least",
  lt: "is less than", lte: "is at most", contains: "contains", in: "is one of",
  is_null: "is empty", not_null: "is not empty", within_days: "is within days",
  older_than_days: "is older than days",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readableFilter(
  filter: NonNullable<ProjectionPlaintextV1["manifest"]["view"]>["filter"],
): string {
  if (!filter) return "No filter";
  const value = filter.value === undefined ? "" : Array.isArray(filter.value)
    ? filter.value.join(", ") : String(filter.value);
  return `${filter.label} ${FILTER_LABELS[filter.op] ?? filter.op}${value ? ` “${value}”` : ""}`;
}

function readableScope(plaintext: ProjectionPlaintextV1): string {
  const view = plaintext.manifest.view;
  if (!view) return "One record in canonical field order";
  const parts = [
    view.search ? `Search “${view.search}”` : "No search",
    readableFilter(view.filter),
    view.sort ? `Sort ${view.sort.label} ${view.sort.dir === "asc" ? "ascending" : "descending"}`
      : "Canonical record order",
  ];
  return parts.join(" · ");
}

function readableDependencies(plaintext: ProjectionPlaintextV1): string {
  const { manifest } = plaintext;
  if (manifest.dependencies.length === 0) return "None";
  return manifest.dependencies.map(dependency => {
    const output = manifest.fields.find(field => field.name === dependency.output)?.label
      ?? dependency.output;
    const inputs = dependency.fields.map(field => `${field.table}.${field.label}`).join(", ");
    return `${output} → ${inputs || "constant"}`;
  }).join("; ");
}

function safeFilename(table: string, kind: ProjectionRequestV1["kind"]): string {
  return `${table}-${kind === "record" ? "record" : "current-view"}.csv`;
}

export function ExportDialog(props: {
  worker: ExportWorker;
  request: ProjectionRequestV1;
  fieldChoices: readonly ProjectionFieldChoiceV1[];
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [includeRecordIds, setIncludeRecordIds] = useState(
    props.request.options.includeRecordIds,
  );
  const [redactedFieldIds, setRedactedFieldIds] = useState<readonly string[]>(
    props.request.options.redactedFieldIds,
  );
  const [artifact, setArtifact] = useState<ProjectionArtifactV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const redactionKey = redactedFieldIds.join("\u0000");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setArtifact(null);
    setError(null);
    const request = {
      ...props.request,
      options: { includeRecordIds, redactedFieldIds: [...redactedFieldIds] },
    } as ProjectionRequestV1;
    void props.worker.projectExport(request, controller.signal).then(result => {
      if (!active) return;
      setArtifact(result);
    }).catch(reason => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "The local export preview failed.");
    });
    return () => { active = false; controller.abort(); };
  }, [props.worker, props.request, includeRecordIds, redactionKey, retry]);

  const redacted = useMemo(() => new Set(redactedFieldIds), [redactionKey]);
  const plaintext = artifact?.projection ?? null;
  const manifest = plaintext?.manifest ?? null;

  const toggleRedaction = (fieldId: string): void => {
    setRedactedFieldIds(current => current.includes(fieldId)
      ? current.filter(id => id !== fieldId) : [...current, fieldId]);
  };

  const downloadCsv = (): void => {
    if (!artifact || !plaintext) return;
    const csvBytes = artifact.csv.buffer.slice(
      artifact.csv.byteOffset,
      artifact.csv.byteOffset + artifact.csv.byteLength,
    ) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([csvBytes],
      { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFilename(plaintext.manifest.table, props.request.kind);
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    queueMicrotask(() => URL.revokeObjectURL(url));
  };

  return <ModalDialog
    className="relation-dialog export-dialog"
    backdropClassName="modal-backdrop relation-backdrop export-dialog-backdrop"
    ariaLabelledBy="export-dialog-title"
    ariaDescribedBy={error
      ? "export-dialog-description export-dialog-error" : "export-dialog-description"}
    onClose={props.onClose}
    returnFocusRef={props.returnFocusRef}
  >
    <header className="relation-dialog-header export-dialog-header">
      <div>
        <span className="record-detail-kicker export-local-badge">Local only</span>
        <h2 id="export-dialog-title">Preview Print / CSV</h2>
        <p id="export-dialog-description">
          Review the exact frozen projection. Nothing leaves this device until you choose an action.
        </p>
      </div>
      <button type="button" className="icon-button" aria-label="Close export preview"
        onClick={props.onClose}>×</button>
    </header>

    <fieldset className="record-fields export-options">
      <legend>Advanced export policy</legend>
      <label>
        <input type="checkbox" checked={includeRecordIds}
          onChange={event => setIncludeRecordIds(event.currentTarget.checked)} />
        Include Clay record IDs and relation ID columns
      </label>
      {props.fieldChoices.length > 0 ? <div className="workbench-tools export-redaction-options">
        <span>Redact values</span>
        {props.fieldChoices.map(field => <label key={field.fieldId}>
          <input type="checkbox" checked={redacted.has(field.fieldId)}
            onChange={() => toggleRedaction(field.fieldId)} />
          {field.label}
        </label>)}
      </div> : null}
    </fieldset>

    {!manifest && !error ? <div className="relation-preview-note export-loading" role="status" aria-live="polite">
      Building a complete local preview…
    </div> : null}
    {error ? <div id="export-dialog-error" className="relation-preview-note export-error" role="alert">
      <strong>Export preview unavailable.</strong>
      <span>{error}</span>
      <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button>
    </div> : null}

    {manifest && plaintext ? <>
      <section className="export-manifest" aria-label="Export manifest">
        <dl className="relation-preview">
          <div><dt>Scope</dt><dd>{manifest.rowCount} rows × {manifest.fieldCount} fields</dd></div>
          <div><dt>Order</dt><dd>{readableScope(plaintext)}</dd></div>
          <div><dt>Relations</dt><dd>{manifest.policies.relations === "friendly_labels"
            ? "Friendly labels; relation IDs excluded"
            : "Friendly labels plus explicit relation ID columns"}</dd></div>
          <div><dt>Clay IDs</dt><dd>{manifest.policies.recordIds === "included"
            ? "Explicitly included" : "Excluded"}</dd></div>
          <div><dt>Attachments</dt><dd>Attachments excluded</dd></div>
          <div><dt>Other fields</dt><dd>Hidden and unselected fields excluded</dd></div>
          <div><dt>Dependencies</dt><dd>{readableDependencies(plaintext)}</dd></div>
          <div><dt>Redactions</dt><dd>{manifest.redactions.length
            ? manifest.redactions.join(", ") : "No redactions"}</dd></div>
          <div><dt>Completeness</dt><dd>Complete — no truncation</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(artifact!.plaintext.byteLength)} projection · {formatBytes(
            manifest.csv.byteCount,
          )} CSV</dd></div>
        </dl>
        <p className="export-policy-note">
          Dates use stored values with no timezone conversion. Blank values export as empty cells.
          {manifest.csv.formulaNeutralizedCells > 0
            ? ` ${manifest.csv.formulaNeutralizedCells} CSV cell${manifest.csv.formulaNeutralizedCells === 1 ? "" : "s"} receive a visible leading apostrophe for spreadsheet safety.`
            : " No spreadsheet-formula changes are needed."}
        </p>
      </section>

      <article className="record-fields projection-print-document" data-renderer={
        `${manifest.renderer.id}@${manifest.renderer.version}`
      }>
        <header className="projection-print-header">
          <h1>{manifest.title}</h1>
          <p>{manifest.rowCount} rows × {manifest.fieldCount} fields · Complete, no truncation</p>
        </header>
        <div
          className="dataview-body projection-table-scroll"
          role="region"
          aria-label={`${readableScope(plaintext)} preview table`}
          tabIndex={0}
        >
          <table className="dataview-grid">
            <caption>{readableScope(plaintext)}</caption>
            <thead><tr>{manifest.fields.map((field, index) => {
              const csvLabel = projectionCsvTextV1(field.label);
              return <th scope="col" key={`${field.name}-${index}`}>
                <span className="projection-field-label">{field.label}</span>
                {csvLabel !== field.label
                  ? <><br /><small className="projection-csv-safety-note">CSV: {csvLabel}</small></> : null}
              </th>;
            })}</tr></thead>
            <tbody>{plaintext.rows.map((row, rowIndex) => <tr key={rowIndex}>
              {row.map((value, fieldIndex) => {
                const csv = projectionCsvTextV1(value);
                return <td key={fieldIndex}>
                  <span className="projection-cell-value">{value}</span>
                  {value === "" ? <small className="projection-empty-marker" aria-label="Empty value">Empty</small> : null}
                  {csv !== value ? <><br /><small className="projection-csv-safety-note">CSV: {csv}</small></> : null}
                </td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
      </article>
    </> : null}

    <footer className="relation-dialog-actions export-dialog-actions" style={{ flexWrap: "wrap" }}>
      <button type="button" onClick={props.onClose}>Cancel</button>
      <button type="button" data-export-csv disabled={!artifact || !plaintext}
        onClick={downloadCsv}>Download CSV</button>
      <button type="button" className="primary" disabled={!artifact || !plaintext}
        style={{ minHeight: 44 }} onClick={() => window.print()}>Print / Save as PDF</button>
    </footer>
  </ModalDialog>;
}
