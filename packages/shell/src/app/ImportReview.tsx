import { ModalDialog } from "./ModalDialog";
import type { ImportHeaderChoice } from "@clay/kernel/import-contracts";

export type ImportReviewSummary = {
  sourceRows: number;
  acceptedRows: number;
  skippedRows: number;
  truncatedRows: number;
  sourceColumns: number;
  acceptedColumns: number;
  truncatedColumns: number;
};

export type ImportReviewColumn = {
  name: string;
  type: "text" | "number" | "date" | "enum";
  values?: string[];
};

export type ReviewedImportFile = {
  table: string;
  columns: ImportReviewColumn[];
  rows: Record<string, unknown>[];
  review: ImportReviewSummary;
  headerReview?: {
    sourceRows: string[][];
    choice: ImportHeaderChoice;
    confidence: "high" | "low" | "none";
  };
};

export function ImportReview(props: {
  fileName: string;
  parsed: ReviewedImportFile;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onHeaderChange?: (choice: ImportHeaderChoice) => void;
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
      <p>{props.busy || props.error
        ? "Review the proposed fields and rows below. The status message shows whether a submitted request still needs reconciliation."
        : "No records have changed. No additional app has been created for this import."}</p>
      {props.error ? <p role="alert">{props.error}</p> : null}
      {props.parsed.headerReview && props.onHeaderChange ? (
        <fieldset disabled={props.busy}>
          <legend>Does this spreadsheet have field names?</legend>
          <label><input type="radio" name="import-header" checked={props.parsed.headerReview.choice.mode === "no_header"}
            onChange={() => props.onHeaderChange?.({ mode: "no_header" })} />No header — keep the first row as data</label>
          <label><input type="radio" name="import-header" checked={props.parsed.headerReview.choice.mode === "header"}
            onChange={() => props.onHeaderChange?.({ mode: "header", sourceRow: 1 })} />Use a row as field names</label>
          {props.parsed.headerReview.choice.mode === "header" ? <label>Header row
            <input type="number" min={1} max={props.parsed.headerReview.sourceRows.length - 1}
              value={props.parsed.headerReview.choice.sourceRow}
              onChange={event => props.onHeaderChange?.({ mode: "header", sourceRow: Number(event.target.value) })} />
          </label> : null}
          <p>{props.parsed.headerReview.confidence === "high" ? "Suggested from the file shape. Review this choice."
            : "The header is uncertain. No rows are removed unless you choose a header."}
            {props.parsed.headerReview.choice.mode === "header" ? " Rows before the chosen header are excluded." : ""}</p>
          <ol aria-label="Source rows" style={{ maxHeight: 120, overflow: "auto" }}>
            {props.parsed.headerReview.sourceRows.slice(0, 5).map((row, index) =>
              <li key={index}>{row.join(" | ")}</li>)}
          </ol>
        </fieldset>
      ) : null}
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
            <li key={column.name}><strong>{column.name}</strong> - {column.type}</li>
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
            ? "Importing accepted rows..."
            : `Import accepted rows (${review.acceptedRows})`}
        </button>
      </div>
    </ModalDialog>
  );
}
