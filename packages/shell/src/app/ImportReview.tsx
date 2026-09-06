import type { ParsedFile } from "./importData";
import { ModalDialog } from "./ModalDialog";

export function ImportReview(props: {
  fileName: string;
  parsed: ParsedFile;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const { review } = props.parsed;
  return (
    <ModalDialog
      className="surface-error import-review"
      backdropClassName="surface-error-backdrop"
      ariaLabelledBy="import-review-title"
      onClose={props.onCancel}
    >
      <span className="contract-eyebrow">Review before import</span>
      <h2 id="import-review-title">Bring in {props.fileName}</h2>
      <p>Clay has not created an app or changed any records yet.</p>
      {props.error ? <p role="alert">{props.error}</p> : null}
      <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 18px", margin: 0 }}>
        <dt>Proposed table</dt><dd style={{ margin: 0 }}>{props.parsed.table}</dd>
        <dt>Rows in file</dt><dd style={{ margin: 0 }}>{review.sourceRows}</dd>
        <dt>Rows accepted</dt><dd style={{ margin: 0 }}>{review.acceptedRows}</dd>
        <dt>Rows skipped</dt><dd style={{ margin: 0 }}>{review.skippedRows}</dd>
        <dt>Rows truncated</dt><dd style={{ margin: 0 }}>{review.truncatedRows}</dd>
        <dt>Fields in file</dt><dd style={{ margin: 0 }}>{review.sourceColumns}</dd>
        <dt>Fields accepted</dt><dd style={{ margin: 0 }}>{review.acceptedColumns}</dd>
        <dt>Fields truncated</dt><dd style={{ margin: 0 }}>{review.truncatedColumns}</dd>
      </dl>
      <section aria-labelledby="import-schema-title" style={{ width: "100%" }}>
        <h3 id="import-schema-title" style={{ margin: "8px 0 4px", fontSize: 14 }}>Proposed fields</h3>
        <ul aria-labelledby="import-schema-title" tabIndex={0}
          style={{ margin: 0, paddingLeft: 20, maxHeight: 180, overflow: "auto" }}>
          {props.parsed.columns.map(column => (
            <li key={column.name}><strong>{column.name}</strong> · {column.type}</li>
          ))}
        </ul>
      </section>
      {review.truncatedRows > 0 || review.truncatedColumns > 0 ? (
        <p role="status">
          Only this reviewed subset will be imported: at most 5,000 accepted rows and 20 fields.
        </p>
      ) : null}
      <div className="rail-actions" style={{ display: "flex", gap: 10, justifyContent: "flex-end", width: "100%" }}>
        <button disabled={props.busy} onClick={props.onCancel}>Go back</button>
        <button className="primary" disabled={props.busy || review.acceptedRows === 0}
          onClick={props.onConfirm}>
          {props.busy
            ? "Importing accepted rows…"
            : `Import accepted rows (${review.acceptedRows})`}
        </button>
      </div>
    </ModalDialog>
  );
}
