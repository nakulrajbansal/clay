import {
  IMPORT_ACQUISITION_LIMITS,
  type ImportSourceKind,
} from "@clay/kernel/import-contracts";

export type ImportParserErrorCode =
  | "E_IMPORT_SOURCE_LIMIT"
  | "E_IMPORT_UTF8"
  | "E_IMPORT_CONTROL_CHARACTER"
  | "E_IMPORT_CSV_SYNTAX"
  | "E_IMPORT_RAGGED_ROW"
  | "E_IMPORT_ROW_LIMIT"
  | "E_IMPORT_COLUMN_LIMIT"
  | "E_IMPORT_CELL_LIMIT"
  | "E_IMPORT_DECODED_LIMIT"
  | "E_IMPORT_TIME_LIMIT"
  | "E_IMPORT_EMPTY_SOURCE"
  | "E_IMPORT_XLSX_UNAVAILABLE"
  | "E_IMPORT_XLSX_INVALID"
  | "E_IMPORT_XLSX_UNSAFE"
  | "E_IMPORT_XLSX_UNSUPPORTED"
  | "E_IMPORT_XLSX_FORMULA"
  | "E_IMPORT_CHUNK_LIMIT"
  | "E_IMPORT_SESSION_UNKNOWN"
  | "E_IMPORT_PROTOCOL";

export type ImportParserStage =
  | "acquire" | "decode" | "parse" | "chunk" | "session" | "protocol";

export class ImportParserError extends Error {
  readonly name = "ImportParserError";

  constructor(
    readonly code: ImportParserErrorCode,
    readonly stage: ImportParserStage,
    detail: {
      row?: number;
      column?: number;
      limit?: number;
      actual?: number;
    } = {},
  ) {
    super("The import source could not be read safely.");
    this.row = detail.row;
    this.column = detail.column;
    this.limit = detail.limit;
    this.actual = detail.actual;
  }

  readonly row: number | undefined;
  readonly column: number | undefined;
  readonly limit: number | undefined;
  readonly actual: number | undefined;
}

export type ParsedDelimitedSource = {
  kind: Extract<ImportSourceKind, "csv" | "paste">;
  delimiter: "," | "\t";
  rows: string[][];
  columns: number;
  decodedCellBytes: number;
  sourceDigest: `sha256:${string}`;
};

export type ParseDelimitedSourceInput = {
  kind: Extract<ImportSourceKind, "csv" | "paste">;
  bytes: Uint8Array;
};

export type ParseDelimitedEnvironment = {
  now?: () => number;
  /** Narrows the production ceiling in deterministic boundary tests only. */
  decodedCellsByteLimitForTest?: number;
};

const encoder = new TextEncoder();

async function sourceDigest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function pasteDelimiter(text: string): "," | "\t" {
  let commas = 0;
  let tabs = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && (char === "\r" || char === "\n")) {
      break;
    } else if (!quoted && char === ",") commas++;
    else if (!quoted && char === "\t") tabs++;
  }
  return tabs > 0 && tabs >= commas ? "\t" : ",";
}

function parseRecords(
  text: string,
  delimiter: "," | "\t",
  assertWithinDeadline: () => void,
  decodedCellsByteLimit: number,
): { rows: string[][]; decodedCellBytes: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let fieldStart = true;
  let decodedCellBytes = 0;
  let endedWithRecordBreak = false;

  const finishField = (): void => {
    const cellBytes = encoder.encode(field).byteLength;
    if (cellBytes > IMPORT_ACQUISITION_LIMITS.maxDecodedCellBytes) {
      throw new ImportParserError("E_IMPORT_CELL_LIMIT", "parse", {
        row: rows.length + 1,
        column: row.length + 1,
        limit: IMPORT_ACQUISITION_LIMITS.maxDecodedCellBytes,
        actual: cellBytes,
      });
    }
    const nextDecodedTotal = decodedCellBytes + cellBytes;
    if (nextDecodedTotal > decodedCellsByteLimit) {
      throw new ImportParserError("E_IMPORT_DECODED_LIMIT", "parse", {
        row: rows.length + 1,
        column: row.length + 1,
        limit: decodedCellsByteLimit,
        actual: nextDecodedTotal,
      });
    }
    row.push(field);
    decodedCellBytes = nextDecodedTotal;
    field = "";
    fieldStart = true;
    afterQuote = false;
  };
  const finishRow = (): void => {
    finishField();
    if (row.length > IMPORT_ACQUISITION_LIMITS.maxMappedColumns) {
      throw new ImportParserError("E_IMPORT_COLUMN_LIMIT", "parse", {
        row: rows.length + 1,
        limit: IMPORT_ACQUISITION_LIMITS.maxMappedColumns,
        actual: row.length,
      });
    }
    const expectedColumns = rows[0]?.length;
    if (expectedColumns !== undefined && row.length !== expectedColumns) {
      throw new ImportParserError("E_IMPORT_RAGGED_ROW", "parse", {
        row: rows.length + 1,
        limit: expectedColumns,
        actual: row.length,
      });
    }
    const maxSourceRows = IMPORT_ACQUISITION_LIMITS.maxDataRows + 1;
    if (rows.length + 1 > maxSourceRows) {
      throw new ImportParserError("E_IMPORT_ROW_LIMIT", "parse", {
        limit: maxSourceRows,
        actual: rows.length + 1,
      });
    }
    rows.push(row);
    row = [];
    endedWithRecordBreak = true;
  };

  for (let index = 0; index < text.length; index++) {
    if ((index & 0xfff) === 0) assertWithinDeadline();
    const char = text[index]!;
    const codePoint = text.charCodeAt(index);
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
        || codePoint === 0x7f) {
      throw new ImportParserError("E_IMPORT_CONTROL_CHARACTER", "parse", {
        row: rows.length + 1,
        column: row.length + 1,
      });
    }
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
      endedWithRecordBreak = false;
      continue;
    }
    if (afterQuote) {
      if (char === delimiter) {
        finishField();
      } else if (char === "\r" || char === "\n") {
        if (char === "\r" && text[index + 1] === "\n") index++;
        finishRow();
      } else {
        throw new ImportParserError("E_IMPORT_CSV_SYNTAX", "parse", {
          row: rows.length + 1,
          column: row.length + 1,
        });
      }
      continue;
    }
    if (char === '"') {
      if (!fieldStart) {
        throw new ImportParserError("E_IMPORT_CSV_SYNTAX", "parse", {
          row: rows.length + 1,
          column: row.length + 1,
        });
      }
      quoted = true;
      fieldStart = false;
      endedWithRecordBreak = false;
    } else if (char === delimiter) {
      finishField();
      endedWithRecordBreak = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      finishRow();
    } else {
      field += char;
      fieldStart = false;
      endedWithRecordBreak = false;
    }
  }
  if (quoted) {
    throw new ImportParserError("E_IMPORT_CSV_SYNTAX", "parse", {
      row: rows.length + 1,
      column: row.length + 1,
    });
  }
  if (!endedWithRecordBreak || row.length > 0 || field.length > 0 || afterQuote) finishRow();
  return { rows, decodedCellBytes };
}

/** Pure worker-side parser. It returns every record or fails; it never slices. */
export async function parseDelimitedSource(
  input: ParseDelimitedSourceInput,
  environment: ParseDelimitedEnvironment = {},
): Promise<ParsedDelimitedSource> {
  const now = environment.now ?? (() => performance.now());
  const startedAt = now();
  const assertWithinDeadline = (): void => {
    const elapsed = Math.max(0, Math.ceil(now() - startedAt));
    if (elapsed > IMPORT_ACQUISITION_LIMITS.maxParseMilliseconds) {
      throw new ImportParserError("E_IMPORT_TIME_LIMIT", "parse", {
        limit: IMPORT_ACQUISITION_LIMITS.maxParseMilliseconds,
        actual: elapsed,
      });
    }
  };
  const sourceLimit = input.kind === "paste"
    ? IMPORT_ACQUISITION_LIMITS.maxPasteSourceBytes
    : IMPORT_ACQUISITION_LIMITS.maxDelimitedSourceBytes;
  if (input.bytes.byteLength > sourceLimit) {
    throw new ImportParserError("E_IMPORT_SOURCE_LIMIT", "acquire", {
      limit: sourceLimit,
      actual: input.bytes.byteLength,
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw new ImportParserError("E_IMPORT_UTF8", "decode");
  }
  assertWithinDeadline();
  text = text.replace(/^\uFEFF/, "");
  if (text.length === 0) throw new ImportParserError("E_IMPORT_EMPTY_SOURCE", "parse");
  const delimiter = input.kind === "csv" ? "," : pasteDelimiter(text);
  const requestedDecodedLimit = environment.decodedCellsByteLimitForTest;
  const decodedCellsByteLimit = requestedDecodedLimit !== undefined
    && Number.isSafeInteger(requestedDecodedLimit) && requestedDecodedLimit >= 0
    ? Math.min(requestedDecodedLimit, IMPORT_ACQUISITION_LIMITS.maxDecodedCellsBytes)
    : IMPORT_ACQUISITION_LIMITS.maxDecodedCellsBytes;
  const parsed = parseRecords(
    text,
    delimiter,
    assertWithinDeadline,
    decodedCellsByteLimit,
  );
  assertWithinDeadline();
  const digest = await sourceDigest(input.bytes);
  assertWithinDeadline();
  return {
    kind: input.kind,
    delimiter,
    rows: parsed.rows,
    columns: parsed.rows[0]?.length ?? 0,
    decodedCellBytes: parsed.decodedCellBytes,
    sourceDigest: digest,
  };
}
