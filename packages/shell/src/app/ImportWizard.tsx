import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  CommitImportResult,
  ExistingTableImportMapping,
  ImportReceipt,
} from "@clay/kernel";
import type {
  ImportHeaderChoice,
  ImportParserChunk,
  ImportSourceDescriptor,
} from "@clay/kernel/import-contracts";
import type {
  ImportCoordinatorPreview,
  ImportStructure,
} from "../worker/release-c/import-session-coordinator";
import {
  ReleaseCParserWorkerClient,
} from "../worker/release-c/import-worker-client";
import type { WorkerClient } from "./worker-client";

export interface ImportParserClientLike {
  openImportSource(input: {
    appInstanceId: string;
    kind: "csv" | "paste" | "xlsx";
    bytes: ArrayBuffer;
  }): Promise<ImportSourceDescriptor>;
  readImportChunk(input: {
    appInstanceId: string;
    sessionId: string;
    sheetId?: string;
    cursor: number;
  }): Promise<ImportParserChunk>;
  closeImportSource(input: {
    appInstanceId: string;
    sessionId: string;
    reason: "cancel" | "commit" | "restart" | "app_switch" | "timeout";
  }): Promise<{ disposed: true }>;
  dispose(): void;
}

type ImportStep = "source" | "sheet" | "map" | "preview" | "result";

type Props = {
  appInstanceId: string;
  targetTable: string;
  worker: WorkerClient;
  parserFactory?: () => ImportParserClientLike;
  onClose(): void;
  onCommitted(table: string): void;
  onError(message: string): void;
};

const normalize = (value: string): string => value.trim().toLowerCase()
  .replaceAll(/[^\p{L}\p{N}]+/gu, "");

function defaultParser(): ImportParserClientLike {
  return new ReleaseCParserWorkerClient(() => new Worker(
    new URL("../worker/release-c/import-worker.ts", import.meta.url),
    { type: "module" },
  ));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ImportWizard(props: Props): React.JSX.Element {
  const [step, setStep] = useState<ImportStep>("source");
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [workbook, setWorkbook] = useState<ImportSourceDescriptor | null>(null);
  const [selectedSheetId, setSelectedSheetId] = useState("");
  const [structure, setStructure] = useState<ImportStructure | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [header, setHeader] = useState<ImportHeaderChoice>({ mode: "header", sourceRow: 1 });
  const [destinations, setDestinations] = useState<Record<number, string>>({});
  const [blankModes, setBlankModes] = useState<Record<number, "leave" | "clear" | "empty_text">>({});
  const [behavior, setBehavior] = useState<"append" | "upsert">("append");
  const [matchField, setMatchField] = useState("");
  const [preview, setPreview] = useState<ImportCoordinatorPreview | null>(null);
  const [result, setResult] = useState<CommitImportResult | null>(null);
  const [undone, setUndone] = useState(false);
  const parserRef = useRef<ImportParserClientLike | null>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => () => {
    parserRef.current?.dispose();
    const active = sessionRef.current;
    if (active) void props.worker.cancelImport(active).catch(() => undefined);
  }, [props.worker]);

  const mappedFields = useMemo(() => Object.values(destinations).filter(Boolean), [destinations]);

  const initializeMappings = (next: ImportStructure): void => {
    const chosen: Record<number, string> = {};
    const blanks: Record<number, "leave" | "clear" | "empty_text"> = {};
    const unused = new Set(next.targetColumns.map(column => column.name));
    for (const source of next.inferredColumns) {
      blanks[source.sourceColumn] = "leave";
      const destination = next.targetColumns.find(column => unused.has(column.name)
        && (normalize(column.label ?? column.name) === normalize(source.label)
          || normalize(column.name) === normalize(source.label)));
      if (destination) {
        chosen[source.sourceColumn] = destination.name;
        unused.delete(destination.name);
      } else chosen[source.sourceColumn] = "";
    }
    setDestinations(chosen);
    setBlankModes(blanks);
    const first = Object.values(chosen).find(Boolean) ?? "";
    setMatchField(first);
  };

  const stageOpened = async (
    opened: ImportSourceDescriptor,
    parser: ImportParserClientLike,
    sheetId: string,
  ): Promise<void> => {
    await props.worker.beginImport(opened, props.targetTable, sheetId);
    let cursor: number | null = 0;
    let next: ImportStructure | null = null;
    while (cursor !== null) {
      const chunk = await parser.readImportChunk({
        appInstanceId: props.appInstanceId, sessionId: opened.sessionId, sheetId, cursor,
      });
      next = await props.worker.stageImportChunk(props.appInstanceId, chunk);
      cursor = chunk.nextCursor;
    }
    await parser.closeImportSource({
      appInstanceId: props.appInstanceId, sessionId: opened.sessionId, reason: "commit",
    });
    parserRef.current = null;
    parser.dispose();
    if (!next?.complete) throw new Error("The import source did not finish reading.");
    setStructure(next);
    const recommended = next.headerCandidate.recommendedRow;
    setHeader(recommended === null ? { mode: "no_header" }
      : { mode: "header", sourceRow: recommended });
    initializeMappings(next);
    setPaste("");
    setWorkbook(null);
    setSelectedSheetId("");
    setStep("map");
  };

  const acquire = async (
    kind: "csv" | "paste" | "xlsx",
    bytes: ArrayBuffer,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    let parser: ImportParserClientLike | null = null;
    let opened: ImportSourceDescriptor | null = null;
    try {
      parser = (props.parserFactory ?? defaultParser)();
      parserRef.current?.dispose();
      parserRef.current = parser;
      opened = await parser.openImportSource({ appInstanceId: props.appInstanceId, kind, bytes });
      sessionRef.current = opened.sessionId;
      setSessionId(opened.sessionId);
      if (kind === "xlsx") {
        setWorkbook(opened);
        setSelectedSheetId(opened.sheets.find(sheet => sheet.visibility === "visible")?.sheetId ?? "");
        setStep("sheet");
        return;
      }
      await stageOpened(opened, parser, opened.sheets[0]!.sheetId);
    } catch (error) {
      parser?.dispose();
      parserRef.current = null;
      if (opened) {
        await props.worker.cancelImport(opened.sessionId).catch(() => undefined);
        sessionRef.current = null;
      }
      props.onError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const useWorkbookSheet = async (): Promise<void> => {
    const parser = parserRef.current;
    if (!workbook || !parser || !selectedSheetId || busy) return;
    setBusy(true);
    try {
      await stageOpened(workbook, parser, selectedSheetId);
    } catch (error) {
      parser.dispose();
      parserRef.current = null;
      await props.worker.cancelImport(workbook.sessionId).catch(() => undefined);
      sessionRef.current = null;
      setWorkbook(null);
      props.onError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".xlsx")) {
      await acquire("xlsx", await file.arrayBuffer());
      return;
    }
    if (!lower.endsWith(".csv") && !lower.endsWith(".tsv")
        && file.type !== "text/csv" && file.type !== "text/tab-separated-values") {
      props.onError("Choose a CSV, TSV, or .xlsx file.");
      return;
    }
    await acquire("csv", await file.arrayBuffer());
  };

  const selectHeader = async (nextHeader: ImportHeaderChoice): Promise<void> => {
    setHeader(nextHeader);
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      const next = await props.worker.importStructure(sessionId, nextHeader);
      setStructure(next);
      initializeMappings(next);
    } catch (error) {
      props.onError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const review = async (): Promise<void> => {
    if (!sessionId || !structure || busy) return;
    const mappings: ExistingTableImportMapping[] = structure.inferredColumns
      .map(column => ({ sourceColumn: column.sourceColumn,
        targetField: destinations[column.sourceColumn] ?? "",
        blankMode: blankModes[column.sourceColumn] ?? "leave" }))
      .filter(mapping => mapping.targetField !== "");
    if (mappings.length === 0) {
      props.onError("Map at least one source column before review.");
      return;
    }
    if (behavior === "upsert" && !matchField) {
      props.onError("Choose the field that identifies records to update.");
      return;
    }
    setBusy(true);
    try {
      await props.worker.configureImport({
        sessionId,
        header,
        mode: behavior === "append" ? { kind: "append" }
          : { kind: "upsert", matchField },
        mappings,
      });
      const next = await props.worker.previewImport(sessionId);
      setPreview(next);
      setStep("preview");
    } catch (error) {
      props.onError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (!sessionId || !preview || busy || !preview.commitAllowed) return;
    setBusy(true);
    try {
      const next = await props.worker.commitImport({
        sessionId, previewId: preview.previewId,
        previewDigest: preview.previewDigest, idempotencyKey: preview.idempotencyKey,
      });
      sessionRef.current = null;
      setStructure(null);
      setDestinations({});
      setBlankModes({});
      setPreview(null);
      setResult(next);
      setStep("result");
      props.onCommitted(props.targetTable);
    } catch (error) {
      props.onError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    if (!result || result.kind !== "receipt" || busy || undone) return;
    setBusy(true);
    try {
      const receipt = await props.worker.undoImport(result.id);
      setResult(receipt);
      setUndone(true);
      props.onCommitted(props.targetTable);
    } catch (error) {
      props.onError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    const active = sessionRef.current;
    sessionRef.current = null;
    if (active) void props.worker.cancelImport(active).catch(() => undefined);
    parserRef.current?.dispose();
    parserRef.current = null;
    props.onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return (): void => window.removeEventListener("keydown", onKey, true);
  });

  return <div className="modal-backdrop relation-backdrop" role="presentation">
    <section className="relation-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <header className="relation-dialog-header">
        <div>
          <p className="record-detail-kicker">Guided import</p>
          <h2 id="import-title">Import data into {props.targetTable}</h2>
        </div>
        <button type="button" aria-label="Close import" onClick={close}>✕</button>
      </header>

      {step === "source" ? <div className="automation-builder">
        <h3>Choose a source</h3>
        <p>Your source is read locally in a dedicated worker. Nothing is sent to a model.</p>
        <div className="automation-inline">
          <label className="record-field">
            <strong>CSV file or Excel workbook</strong>
            <span>CSV, tab-separated text, or .xlsx; parsed locally with hard size limits.</span>
            <input type="file" accept=".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy} onChange={event => void chooseFile(event.target.files?.[0])} />
          </label>
          <div className="record-field">
            <strong>Paste cells</strong>
            <span>Copy a range from a spreadsheet and paste it below.</span>
            <textarea aria-label="Pasted spreadsheet cells" value={paste}
              onChange={event => setPaste(event.target.value)} rows={6}
              placeholder={'Email\tName\nhello@example.com\tHello'} />
            <button type="button" className="dataview-import" disabled={busy || paste.length === 0}
              onClick={() => void acquire("paste", new TextEncoder().encode(paste).buffer)}>
              Use pasted cells
            </button>
          </div>
        </div>
      </div> : null}

      {step === "sheet" && workbook ? <div className="automation-builder">
        <h3>Choose a worksheet</h3>
        <p>Hidden worksheets are marked and are never selected automatically. Saved formula results are shown; formulas are never run.</p>
        <label className="record-field">Worksheet
          <select aria-label="Worksheet" value={selectedSheetId} disabled={busy}
            onChange={event => setSelectedSheetId(event.target.value)}>
            <option value="">Choose a worksheet</option>
            {workbook.sheets.map(sheet => <option key={sheet.sheetId} value={sheet.sheetId}>
              {sheet.label} · {sheet.visibility.replace("_", " ")} · {sheet.range.rows} rows × {sheet.range.columns} columns
            </option>)}
          </select>
        </label>
        <div className="relation-dialog-actions">
          <button type="button" disabled={busy} onClick={() => {
            parserRef.current?.dispose();
            parserRef.current = null;
            sessionRef.current = null;
            setWorkbook(null);
            setStep("source");
          }}>Back</button>
          <button type="button" className="primary" disabled={busy || !selectedSheetId}
            onClick={() => void useWorkbookSheet()}>Use worksheet</button>
        </div>
      </div> : null}

      {step === "map" && structure ? <div className="automation-builder">
        <h3>Map columns</h3>
        <label className="record-field">Header row
          <select aria-label="Header row" disabled={busy}
            value={header.mode === "no_header" ? "none" : String(header.sourceRow)}
            onChange={event => void selectHeader(event.target.value === "none" ? { mode: "no_header" }
              : { mode: "header", sourceRow: Number(event.target.value) })}>
            <option value="none">No header row</option>
            {structure.sample.map((_row, index) => <option key={index} value={index + 1}>
              Row {index + 1}{index + 1 === structure.headerCandidate.recommendedRow ? " (recommended)" : ""}
            </option>)}
          </select>
        </label>
        <div className="record-fields">
          {structure.inferredColumns.map(column => <label key={column.sourceColumn} className="record-field">
            <span><strong>{column.label}</strong> · {column.inferredType}</span>
            <span aria-hidden="true">→</span>
            <select aria-label={`Map ${column.label}`} value={destinations[column.sourceColumn] ?? ""}
              onChange={event => setDestinations(current => ({
                ...current, [column.sourceColumn]: event.target.value,
              }))}>
              <option value="">Skip this column</option>
              {structure.targetColumns.map(target => <option key={target.name} value={target.name}>
                {target.label ?? target.name} · {target.type}{target.required ? " · required" : ""}
              </option>)}
            </select>
            {destinations[column.sourceColumn] ? <select
              aria-label={`Blanks in ${column.label}`}
              value={blankModes[column.sourceColumn] ?? "leave"}
              onChange={event => setBlankModes(current => ({ ...current,
                [column.sourceColumn]: event.target.value as "leave" | "clear" | "empty_text",
              }))}>
              <option value="leave">Blank: leave existing value</option>
              <option value="clear">Blank: clear value</option>
              {["text", "rich_text"].includes(structure.targetColumns.find(target =>
                target.name === destinations[column.sourceColumn])?.type ?? "")
                ? <option value="empty_text">Blank: use empty text</option> : null}
            </select> : null}
          </label>)}
        </div>
        <label className="record-field">Import behavior
          <select aria-label="Import behavior" value={behavior}
            onChange={event => setBehavior(event.target.value as "append" | "upsert")}>
            <option value="append">Create new records</option>
            <option value="upsert">Create or update matching records</option>
          </select>
        </label>
        {behavior === "upsert" ? <label className="record-field">Records match by
          <select aria-label="Update match field" value={matchField}
            onChange={event => setMatchField(event.target.value)}>
            <option value="">Choose a mapped field</option>
            {structure.targetColumns.filter(column => mappedFields.includes(column.name))
              .map(column => <option key={column.name} value={column.name}>
                {column.label ?? column.name}
              </option>)}
          </select>
        </label> : null}
        <div className="relation-dialog-actions">
          <button type="button" onClick={() => setStep("source")} disabled={busy}>Back</button>
          <button type="button" className="primary" onClick={() => void review()} disabled={busy}>Review import</button>
        </div>
      </div> : null}

      {step === "preview" && preview ? <div className="automation-builder">
        <h3>Exact preview</h3>
        <div className="automation-inline" aria-label="Exact import totals">
          <strong>{preview.sourceTotals.createRows} create</strong>
          <strong>{preview.sourceTotals.updateRows} update</strong>
          <strong>{preview.sourceTotals.skipRows} skip</strong>
          <strong>{preview.sourceTotals.blockedRows} blocked</strong>
        </div>
        <p>{preview.mutationTotals.changedCount} canonical changes will be saved in one atomic receipt.</p>
        <details open={preview.warningTotals.warnings > 0}>
          <summary>Review warnings ({preview.warningTotals.warnings})</summary>
          {Object.entries(preview.warningTotals.warningReasons).map(([reason, count]) =>
            <p key={reason}>{count} · {reason.replaceAll("_", " ")}</p>)}
          {preview.warningTotals.warnings === 0 ? <p>No warnings.</p> : null}
        </details>
        {preview.issues.length > 0 ? <div role="alert" className="automation-simulation">
          {preview.issues.map(issue => <p key={issue.issueId}>{issue.message}</p>)}
        </div> : null}
        <div className="relation-dialog-actions">
          <button type="button" onClick={() => setStep("map")} disabled={busy}>Back to mapping</button>
          <button type="button" className="primary" disabled={busy || !preview.commitAllowed}
            onClick={() => void commit()}>Confirm import</button>
        </div>
      </div> : null}

      {step === "result" && result ? <div className="automation-builder">
        {result.kind === "no_change" ? <>
          <h3>No changes needed</h3>
          <p>Every selected row was skipped. No receipt or history was created.</p>
        </> : <>
          <h3>{undone ? "Import undone" : "Import complete"}</h3>
          <p>{result.changed} changes saved in one receipt.</p>
          <div className="automation-inline">
            <strong>{result.sourceTotals.createRows} created</strong>
            <strong>{result.sourceTotals.updateRows} updated</strong>
            <strong>{result.sourceTotals.skipRows} skipped</strong>
          </div>
        </>}
        <div className="relation-dialog-actions">
          {result.kind === "receipt" && !undone
            ? <button type="button" onClick={() => void undo()} disabled={busy}>Undo import</button>
            : null}
          <button type="button" className="primary" onClick={close}>Done</button>
        </div>
      </div> : null}
    </section>
  </div>;
}
