import { inferImportColumns, recommendHeaderCandidate } from "@clay/kernel/import-review";
import type { ImportHeaderChoice, ImportSourceDescriptor } from "@clay/kernel/import-contracts";
import {
  ReleaseCParserWorkerClient,
  type ImportParserWorkerLike,
} from "../worker/release-c/import-worker-client";
import type { ReviewedImportFile } from "./ImportReview";

const MAX_SOURCE_ROWS = 5_001;
const MAX_COLUMNS = 20;
const IDENTIFIER_LENGTH = 40;
const MAX_PRODUCTION_PAYLOAD_BYTES = 2_000_000;

function safeIdentifier(label: string, fallback: string): string {
  const cleaned = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || fallback).replace(/^[0-9]/, "c_$&").slice(0, IDENTIFIER_LENGTH);
}

function uniqueIdentifiers(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((label, index) => {
    const base = safeIdentifier(label, `column_${index + 1}`);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    for (let suffix = 2; suffix <= MAX_COLUMNS + 1; suffix++) {
      const tail = `_${suffix}`;
      const candidate = `${base.slice(0, IDENTIFIER_LENGTH - tail.length)}${tail}`;
      if (used.has(candidate)) continue;
      used.add(candidate);
      return candidate;
    }
    throw new Error("The imported field names cannot be made unique safely.");
  });
}

function tableName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const identifier = safeIdentifier(stem, "imported_data");
  return identifier.replace(/^c_([0-9])/, "t_$1");
}

export function newAppImportDisplayName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return (stem || "Imported data").slice(0, 40).trimEnd() || "Imported data";
}

function copiedRows(input: readonly (readonly string[])[]): string[][] {
  if (input.length < 1) throw new Error("The import source is empty.");
  if (input.length > MAX_SOURCE_ROWS)
    throw new Error("The import source exceeds 5,000 data rows.");
  let width = 0;
  return input.map((source, rowIndex) => {
    if (!Array.isArray(source) || source.length < 1 || source.length > MAX_COLUMNS)
      throw new Error(`Import row ${rowIndex + 1} has an invalid number of fields.`);
    const row = source.map(value => {
      if (typeof value !== "string")
        throw new Error("Imported cells must be decoded text.");
      return value;
    });
    width = Math.max(width, row.length);
    return row;
  }).map(row => {
    while (row.length < width) row.push("");
    return row;
  });
}

/** Convert an already isolated parser range into the exact payload shown in review. */
export function reviewParsedNewAppRows(
  fileName: string,
  input: readonly (readonly string[])[],
  choice?: ImportHeaderChoice,
): ReviewedImportFile {
  const rows = copiedRows(input);
  const candidate = recommendHeaderCandidate(rows);
  if (candidate.recommendedRow === null) throw new Error("The import source is empty.");
  const header = choice ?? (candidate.confidence === "high"
    ? { mode: "header" as const, sourceRow: candidate.recommendedRow }
    : { mode: "no_header" as const });
  if (header.mode === "header" && (!Number.isSafeInteger(header.sourceRow) || header.sourceRow < 1
      || header.sourceRow >= rows.length)) throw new Error("Choose a header row before the final data row.");
  const inferred = inferImportColumns(rows, header);
  const names = uniqueIdentifiers(inferred.map(column => column.label));
  const columns: ReviewedImportFile["columns"] = inferred.map((column, index) => {
    const type = column.inferredType === "number" || column.inferredType === "integer"
      ? "number" as const
      : column.inferredType === "date" ? "date" as const
        : column.inferredType === "enum" ? "enum" as const : "text" as const;
    return {
      name: names[index]!,
      type,
      ...(type === "enum" ? { values: [...column.enumValues!] } : {}),
    };
  });
  const headerIndex = header.mode === "header" ? header.sourceRow - 1 : -1;
  const accepted: Record<string, unknown>[] = [];
  let skippedRows = Math.max(headerIndex, 0);
  let truncatedRows = 0;
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
    const source = rows[rowIndex]!;
    if (source.every(value => value.trim().length === 0)) {
      skippedRows++;
      continue;
    }
    if (accepted.length === 5_000) { truncatedRows++; continue; }
    const record: Record<string, unknown> = {};
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex]!;
      const raw = source[columnIndex] ?? "";
      const trimmed = raw.trim();
      if (trimmed.length === 0 && column.type !== "text") record[column.name] = null;
      else if (column.type === "number") record[column.name] = Number(trimmed);
      else if (column.type === "date" || column.type === "enum") record[column.name] = trimmed;
      else record[column.name] = raw;
    }
    accepted.push(record);
  }
  if (accepted.length === 0) throw new Error("The import source has no data rows to import.");
  const reviewed: ReviewedImportFile = {
    table: tableName(fileName),
    columns,
    rows: accepted,
    headerReview: { sourceRows: rows, choice: header, confidence: candidate.confidence },
    review: {
      sourceRows: rows.length - (header.mode === "header" ? 1 : 0),
      acceptedRows: accepted.length,
      skippedRows,
      truncatedRows,
      sourceColumns: inferred.length,
      acceptedColumns: inferred.length,
      truncatedColumns: 0,
    },
  };
  const commitPayload = {
    table: reviewed.table,
    columns: reviewed.columns,
    rows: reviewed.rows,
  };
  if (new TextEncoder().encode(JSON.stringify(commitPayload)).byteLength
      > MAX_PRODUCTION_PAYLOAD_BYTES)
    throw new Error("The reviewed import exceeds 2,000,000 UTF-8 bytes.");
  return reviewed;
}

function sourceKind(fileName: string): "csv" | "paste" | "xlsx" {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  if (extension === "csv") return "csv";
  if (extension === "tsv") return "paste";
  if (extension === "xlsx") return "xlsx";
  throw new Error("Choose a CSV, TSV, or XLSX spreadsheet.");
}

function defaultWorkerFactory(): ImportParserWorkerLike {
  return new Worker(new URL("../worker/release-c/import-worker.ts", import.meta.url), {
    type: "module",
  });
}

/** Parse in the isolated, bounded Release C worker before creating any app. */
export async function parseNewAppImportFile(
  file: File,
  appInstanceId: string,
  workerFactory: () => ImportParserWorkerLike = defaultWorkerFactory,
): Promise<ReviewedImportFile> {
  const parser = new ReleaseCParserWorkerClient(workerFactory);
  let descriptor: ImportSourceDescriptor | null = null;
  let closed = false;
  try {
    descriptor = await parser.openImportSource({
      appInstanceId,
      kind: sourceKind(file.name),
      bytes: await file.arrayBuffer(),
    });
    const sheet = descriptor.sheets.find(candidate => candidate.visibility === "visible");
    if (!sheet || sheet.range.rows < 1)
      throw new Error("The spreadsheet has no visible data range.");
    const rows: string[][] = [];
    let cursor = 0;
    for (;;) {
      const chunk = await parser.readImportChunk({
        appInstanceId,
        sessionId: descriptor.sessionId,
        sheetId: sheet.sheetId,
        cursor,
      });
      rows.push(...chunk.rows.map(row => [...row]));
      if (chunk.nextCursor === null) break;
      cursor = chunk.nextCursor;
    }
    if (rows.length !== sheet.range.rows)
      throw new Error("The reviewed spreadsheet range changed while it was read.");
    await parser.closeImportSource({
      appInstanceId, sessionId: descriptor.sessionId, reason: "commit",
    });
    closed = true;
    return reviewParsedNewAppRows(file.name, rows);
  } finally {
    if (descriptor && !closed) {
      try {
        await parser.closeImportSource({
          appInstanceId, sessionId: descriptor.sessionId, reason: "cancel",
        });
      } catch { /* The primary parser failure remains authoritative. */ }
    }
    parser.dispose();
  }
}
