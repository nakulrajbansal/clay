import type { QueryRow } from "./query";
import { canonicalJson, fnv32 } from "./canonical-json";
import type { RegColumn, RegTable } from "./registry";
import type {
  ExistingTableImportMapping, ExistingTableImportMode,
  ImportDateRule, ImportNumberRule, ImportSourceKind, ImportSkipCode,
  MutationTotals, SourceDispositionTotals, SourceRowDisposition,
} from "./import-contracts";
import { parseReleaseCDate, parseReleaseCNumber } from "./import-grammar";
import { sha256HexSync } from "./state-digest";
import { ClayError } from "./errors";

export type ImportWarningCode =
  | "trimmed_whitespace"
  | "leading_zero_identifier"
  | "enum_case_normalized";

export type ImportWarningTotals = {
  warnings: number;
  warningReasons: Record<ImportWarningCode, number>;
};

export type ImportIssue = {
  issueId: string;
  code: "invalid_value" | "required_value" | "duplicate_source_key"
    | "ambiguous_target_key" | "missing_match_value" | "unmapped_required_field";
  sourceRows: number[];
  sourceColumn?: number;
  message: string;
};

export type PreparedExistingImportMutation = {
  mutationId: string;
  role: "primary_target";
  kind: "create" | "update";
  table: string;
  rowId: string;
  originSourceRows: number[];
  payloadDigest: string;
  row?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  beforeDigest?: string;
};

export type ExistingTableImportPreview = {
  sessionId: string;
  previewId: string;
  previewDigest: string;
  sourceKind: Extract<ImportSourceKind, "csv" | "paste" | "xlsx">;
  target: { table: string; label: string };
  baseVersion: number;
  headers: string[];
  mappings: ExistingTableImportMapping[];
  sourceTotals: SourceDispositionTotals;
  mutationTotals: MutationTotals;
  warningTotals: ImportWarningTotals;
  warnings: Array<{ code: ImportWarningCode; sourceRow: number; sourceColumn: number }>;
  issues: ImportIssue[];
  completion: "commit" | "no_change";
  commitAllowed: boolean;
};

export type TrustedExistingImportEnvelope = {
  appInstanceId: string;
  sessionId: string;
  previewId: string;
  previewDigest: string;
  sourceKind: Extract<ImportSourceKind, "csv" | "paste" | "xlsx">;
  sourceDigest: string;
  baseVersion: number;
  target: { table: string; label: string };
  dispositions: SourceRowDisposition[];
  mutations: PreparedExistingImportMutation[];
  sourceTotals: SourceDispositionTotals;
  mutationTotals: MutationTotals;
  warningTotals: ImportWarningTotals;
};

export type CommitExistingImportInput = TrustedExistingImportEnvelope & {
  receiptId: string;
  summary: string;
};

export type ImportReceipt = {
  kind: "receipt";
  durable: true;
  id: string;
  at: string;
  source: "import";
  summary: string;
  changed: number;
  created: Array<{ table: string; id: string; role: "primary_target" }>;
  undone: boolean;
  previewDigest: string;
  sourceKind: Extract<ImportSourceKind, "csv" | "paste" | "xlsx">;
  target: { table: string; label: string };
  baseVersion: number;
  sourceTotals: SourceDispositionTotals;
  mutationTotals: MutationTotals;
  warningTotals: ImportWarningTotals;
  undo: { state: "available" | "undone" | "conflict" | "history_unavailable" };
};

export type ImportNoChangeResult = {
  kind: "no_change";
  durable: false;
  previewDigest: string;
  sourceTotals: SourceDispositionTotals;
  mutationTotals: MutationTotals;
  warningTotals: ImportWarningTotals;
};

export type CommitImportResult = ImportReceipt | ImportNoChangeResult;

export type PreparedExistingTableImport = {
  preview: ExistingTableImportPreview;
  envelope: TrustedExistingImportEnvelope;
};

export type PrepareExistingTableImportInput = {
  appInstanceId: string;
  sessionId: string;
  sourceKind: Extract<ImportSourceKind, "csv" | "paste" | "xlsx">;
  sourceDigest: string;
  baseVersion: number;
  sourceRows: readonly (readonly string[])[];
  header: { mode: "header"; sourceRow: number } | { mode: "no_header" };
  target: RegTable;
  existingRows: readonly QueryRow[];
  mode: ExistingTableImportMode;
  mappings: readonly ExistingTableImportMapping[];
};

type CoercedCell = {
  ok: true;
  value: unknown;
  warnings: ImportWarningCode[];
} | { ok: false; issue: "invalid_value" | "required_value" };

const DEFAULT_NUMBER_RULE: ImportNumberRule = {
  grammar: "ungrouped_dot_decimal", affix: null, percentScale: "none",
};
const DEFAULT_DATE_RULE: ImportDateRule = { kind: "iso" };
const WRITABLE_TYPES = new Set([
  "text", "rich_text", "integer", "number", "date", "boolean", "enum",
]);
const encoder = new TextEncoder();

export function importValueFingerprint(value: unknown): string {
  const canonical = canonicalJson(value);
  return `fp128:${["a", "b", "c", "d"].map(salt =>
    fnv32(`${salt}\u0000${canonical}`)).join("")}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${sha256HexSync(encoder.encode(canonicalJson(value)))}`;
}

function base32(hex: string, length = 26): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let result = "";
  for (let index = 0; index < hex.length && result.length < length; index += 2) {
    value = (value << 8) | Number.parseInt(hex.slice(index, index + 2), 16);
    bits += 8;
    while (bits >= 5 && result.length < length) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  return result;
}

function derivedId(prefix: "preview" | "mutation" | "issue", seed: unknown): string {
  return `${prefix}_${base32(digest(seed).slice(7))}`;
}

function derivedRowId(seed: unknown): string {
  const hex = digest(seed).slice(7, 39).split("");
  hex[12] = "7";
  const variant = Number.parseInt(hex[16]!, 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function writableColumn(table: RegTable, name: string): RegColumn {
  const column = table.columns.find(candidate => candidate.name === name
    && !candidate.hidden && !candidate.inactive && WRITABLE_TYPES.has(candidate.type));
  if (!column) throw new ClayError("E_VALIDATION", `field '${name}' is not an import destination`);
  return column;
}

function coerceCell(raw: string, column: RegColumn,
  mapping: ExistingTableImportMapping): CoercedCell {
  if (raw.length === 0) {
    if (mapping.blankMode === "empty_text"
        && (column.type === "text" || column.type === "rich_text"))
      return { ok: true, value: "", warnings: [] };
    return column.required
      ? { ok: false, issue: "required_value" }
      : { ok: true, value: null, warnings: [] };
  }
  const trimmed = raw.trim();
  const warnings: ImportWarningCode[] = trimmed === raw ? [] : ["trimmed_whitespace"];
  if (trimmed.length === 0) {
    if (mapping.blankMode === "empty_text"
        && (column.type === "text" || column.type === "rich_text"))
      return { ok: true, value: "", warnings };
    return column.required
      ? { ok: false, issue: "required_value" }
      : { ok: true, value: null, warnings };
  }
  if (column.type === "text" || column.type === "rich_text")
    return { ok: true, value: trimmed, warnings };
  if (column.type === "integer") {
    if (!/^[+-]?(?:0|[1-9][0-9]*)$/.test(trimmed)) return { ok: false, issue: "invalid_value" };
    const unsigned = trimmed.replace(/^[+-]/, "");
    if (unsigned.length > 1 && unsigned.startsWith("0")) warnings.push("leading_zero_identifier");
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? { ok: true, value, warnings }
      : { ok: false, issue: "invalid_value" };
  }
  if (column.type === "number") {
    const parsed = parseReleaseCNumber(trimmed, mapping.numberRule ?? DEFAULT_NUMBER_RULE);
    if (!parsed.ok) return { ok: false, issue: "invalid_value" };
    if (parsed.warning) warnings.push(parsed.warning);
    return { ok: true, value: parsed.value, warnings };
  }
  if (column.type === "date") {
    const parsed = parseReleaseCDate(trimmed, mapping.dateRule ?? DEFAULT_DATE_RULE);
    return parsed.ok ? { ok: true, value: parsed.canonical, warnings }
      : { ok: false, issue: "invalid_value" };
  }
  if (column.type === "boolean") {
    const normalized = trimmed.toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return { ok: true, value: true, warnings };
    if (["false", "no", "n"].includes(normalized)) return { ok: true, value: false, warnings };
    return { ok: false, issue: "invalid_value" };
  }
  if (column.type === "enum") {
    const exact = column.values?.find(value => value === trimmed);
    if (exact !== undefined) return { ok: true, value: exact, warnings };
    const folded = column.values?.filter(value => value.toLowerCase() === trimmed.toLowerCase()) ?? [];
    if (folded.length === 1) {
      warnings.push("enum_case_normalized");
      return { ok: true, value: folded[0], warnings };
    }
  }
  return { ok: false, issue: "invalid_value" };
}

function sourceTotals(dispositions: readonly SourceRowDisposition[]): SourceDispositionTotals {
  const skipReasons: Record<ImportSkipCode, number> = {
    above_header: 0, blank_row: 0, user_skipped: 0, duplicate_combined: 0,
    duplicate_skipped: 0, no_change: 0, unmapped_row: 0,
  };
  let createRows = 0;
  let updateRows = 0;
  let skipRows = 0;
  let blockedRows = 0;
  for (const disposition of dispositions) {
    if (disposition.kind === "create") createRows++;
    else if (disposition.kind === "update") updateRows++;
    else if (disposition.kind === "blocked") blockedRows++;
    else { skipRows++; skipReasons[disposition.reasonCode]++; }
  }
  if (dispositions.length > 5_000)
    throw new ClayError("E_LIMIT", "an import range cannot exceed 5,000 data rows");
  return {
    sourceRows: dispositions.length, createRows, updateRows, skipRows, blockedRows, skipReasons,
  };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

export type InferredImportColumn = {
  sourceColumn: number;
  label: string;
  inferredType: "text" | "integer" | "number" | "date" | "boolean" | "enum";
  confidence: "high" | "low";
  reasons: string[];
  samples: string[];
  enumValues?: string[];
};

/** C-FR-007/C-FR-010: deterministic inference over the complete bounded range. */
export function inferImportColumns(
  rows: readonly (readonly string[])[],
  header: PrepareExistingTableImportInput["header"],
): InferredImportColumn[] {
  if (rows.length < 1 || rows.length > 5_001)
    throw new ClayError("E_LIMIT", "an import range must contain 1 to 5,001 source rows");
  const headerIndex = header.mode === "header" ? header.sourceRow - 1 : -1;
  if (headerIndex >= rows.length || headerIndex < -1)
    throw new ClayError("E_VALIDATION", "the selected header row is outside the source");
  const width = Math.max(...rows.map(row => row.length));
  if (width < 1 || width > 20)
    throw new ClayError("E_LIMIT", "an import range must contain 1 to 20 columns");
  return Array.from({ length: width }, (_, index): InferredImportColumn => {
    const label = header.mode === "header"
      ? (rows[headerIndex]?.[index]?.trim() || `Column ${index + 1}`)
      : `Column ${index + 1}`;
    const values = rows
      .filter((_row, rowIndex) => rowIndex !== headerIndex && rowIndex > headerIndex)
      .map(row => row[index] ?? "").filter(value => value.trim().length > 0)
      .map(value => value.trim());
    const samples = values.slice(0, 3);
    const folded = values.map(value => value.toLowerCase());
    const booleanValues = new Set(folded);
    if (values.length >= 2
        && (["true", "false"].every(value => booleanValues.has(value))
          || ["yes", "no"].every(value => booleanValues.has(value))
          || ["y", "n"].every(value => booleanValues.has(value)))
        && folded.every(value => ["true", "false", "yes", "no", "y", "n"].includes(value))) {
      return { sourceColumn: index + 1, label, inferredType: "boolean", confidence: "high",
        reasons: ["complete_boolean_pair"], samples };
    }
    if (values.length > 0 && values.every(value => /^[+-]?(?:0|[1-9][0-9]*)$/.test(value)
        && Number.isSafeInteger(Number(value)))) {
      return { sourceColumn: index + 1, label, inferredType: "integer", confidence: "high",
        reasons: ["all_values_are_integers"], samples };
    }
    if (values.length > 0 && values.every(value => {
      const parsed = parseReleaseCNumber(value, DEFAULT_NUMBER_RULE);
      return parsed.ok && parsed.warning === null;
    })) {
      return { sourceColumn: index + 1, label, inferredType: "number", confidence: "high",
        reasons: ["all_values_are_numbers"], samples };
    }
    if (values.length > 0 && values.every(value =>
      parseReleaseCDate(value, DEFAULT_DATE_RULE).ok)) {
      return { sourceColumn: index + 1, label, inferredType: "date", confidence: "high",
        reasons: ["all_values_are_iso_dates"], samples };
    }
    const enumValues = [...new Set(values)];
    if (values.length >= 6 && enumValues.length >= 2 && enumValues.length <= 8
        && enumValues.length / values.length <= 0.5
        && enumValues.every(value => value.length <= 40)) {
      return { sourceColumn: index + 1, label, inferredType: "enum", confidence: "high",
        reasons: ["bounded_values", "low_distinct_ratio"], samples, enumValues };
    }
    return { sourceColumn: index + 1, label, inferredType: "text", confidence: "low",
      reasons: values.some(value => /^0[0-9]+$/.test(value))
        ? ["leading_zero_identifier"] : ["mixed_or_text_values"], samples };
  });
}

export function prepareExistingTableImport(
  input: PrepareExistingTableImportInput,
): PreparedExistingTableImport {
  if (input.sourceRows.length < 1 || input.sourceRows.length > 5_001)
    throw new ClayError("E_LIMIT", "an import range must contain 1 to 5,001 source rows");
  if (input.mappings.length < 1 || input.mappings.length > 20)
    throw new ClayError("E_VALIDATION", "map at least one and at most 20 source columns");
  const sourceColumns = new Set<number>();
  const targetFields = new Set<string>();
  const mappings = input.mappings.map(mapping => {
    if (!Number.isInteger(mapping.sourceColumn) || mapping.sourceColumn < 1
        || mapping.sourceColumn > 20 || sourceColumns.has(mapping.sourceColumn)
        || targetFields.has(mapping.targetField))
      throw new ClayError("E_VALIDATION", "import mappings must use unique bounded columns and fields");
    sourceColumns.add(mapping.sourceColumn);
    targetFields.add(mapping.targetField);
    const column = writableColumn(input.target, mapping.targetField);
    const blankMode = mapping.blankMode ?? "leave";
    if (!["leave", "clear", "empty_text"].includes(blankMode)
        || (blankMode === "empty_text"
          && column.type !== "text" && column.type !== "rich_text"))
      throw new ClayError("E_VALIDATION", "the selected blank-cell behavior is not valid for this field");
    return { ...mapping, blankMode };
  }).sort((left, right) => left.sourceColumn - right.sourceColumn);
  if (input.mode.kind === "upsert" && !targetFields.has(input.mode.matchField))
    throw new ClayError("E_VALIDATION", "the update match field must be mapped");

  const headerIndex = input.header.mode === "header" ? input.header.sourceRow - 1 : -1;
  if (headerIndex >= input.sourceRows.length || headerIndex < -1 || headerIndex > 5_000)
    throw new ClayError("E_VALIDATION", "the selected header row is outside the source");
  const width = Math.max(...input.sourceRows.map(row => row.length));
  const headers = input.header.mode === "header"
    ? [...input.sourceRows[headerIndex]!]
    : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const existingByMatch = new Map<string, QueryRow[]>();
  const duplicateSourceKeys = new Map<number, number[]>();
  if (input.mode.kind === "upsert") {
    const matchField = input.mode.matchField;
    for (const row of input.existingRows) {
      const key = canonicalJson(row[matchField] ?? null);
      const bucket = existingByMatch.get(key) ?? [];
      bucket.push(row);
      existingByMatch.set(key, bucket);
    }
    const matchMapping = mappings.find(mapping => mapping.targetField === matchField)!;
    const matchColumn = writableColumn(input.target, matchField);
    const sourceByKey = new Map<string, number[]>();
    for (let rowIndex = headerIndex + 1; rowIndex < input.sourceRows.length; rowIndex++) {
      const rawRow = input.sourceRows[rowIndex]!;
      if (rawRow.every(cell => cell.trim().length === 0)) continue;
      const match = coerceCell(rawRow[matchMapping.sourceColumn - 1] ?? "", matchColumn, matchMapping);
      if (!match.ok || match.value === null || match.value === "") continue;
      const key = canonicalJson(match.value);
      const bucket = sourceByKey.get(key) ?? [];
      bucket.push(rowIndex + 1);
      sourceByKey.set(key, bucket);
    }
    for (const rowsForKey of sourceByKey.values()) {
      if (rowsForKey.length < 2) continue;
      for (const sourceRow of rowsForKey) duplicateSourceKeys.set(sourceRow, rowsForKey);
    }
  }

  const dispositions: SourceRowDisposition[] = [];
  const mutations: PreparedExistingImportMutation[] = [];
  const warnings: ExistingTableImportPreview["warnings"] = [];
  const issues: ImportIssue[] = [];
  const candidateRows: Array<{ sourceRow: number; values: Record<string, unknown>;
    warningCells: ExistingTableImportPreview["warnings"]; matchKey?: string }> = [];
  const mappedTargets = new Set(mappings.map(mapping => mapping.targetField));
  const unmappedRequiredFields = input.target.columns.filter(column =>
    column.required && !column.inactive && !["computed", "lookup", "rollup"].includes(column.type)
      && !mappedTargets.has(column.name)).map(column => column.name);
  const blockUnmappedRequiredCreate = (row: typeof candidateRows[number]): boolean => {
    if (unmappedRequiredFields.length === 0) return false;
    const issueId = derivedId("issue", [input.sessionId, row.sourceRow,
      "unmapped_required", unmappedRequiredFields]);
    issues.push({
      issueId,
      code: "unmapped_required_field",
      sourceRows: [row.sourceRow],
      message: `Required destination field${unmappedRequiredFields.length === 1 ? "" : "s"} ${unmappedRequiredFields.join(", ")} must be mapped for new records.`,
    });
    dispositions.push({ sourceRow: row.sourceRow, kind: "blocked", issueIds: [issueId] });
    warnings.push(...row.warningCells);
    return true;
  };

  for (let rowIndex = 0; rowIndex < input.sourceRows.length; rowIndex++) {
    if (rowIndex === headerIndex) continue;
    const sourceRow = rowIndex + 1;
    const rawRow = input.sourceRows[rowIndex]!;
    if (rowIndex < headerIndex) {
      dispositions.push({ sourceRow, kind: "skip", reasonCode: "above_header" });
      continue;
    }
    if (rawRow.every(cell => cell.trim().length === 0)) {
      dispositions.push({ sourceRow, kind: "skip", reasonCode: "blank_row" });
      continue;
    }
    const values: Record<string, unknown> = {};
    const rowIssueIds: string[] = [];
    const warningCells: ExistingTableImportPreview["warnings"] = [];
    for (const mapping of mappings) {
      const column = writableColumn(input.target, mapping.targetField);
      const raw = rawRow[mapping.sourceColumn - 1] ?? "";
      const coerced = coerceCell(raw, column, mapping);
      if (!coerced.ok) {
        const issueId = derivedId("issue", [input.sessionId, sourceRow, mapping.sourceColumn,
          coerced.issue]);
        rowIssueIds.push(issueId);
        issues.push({
          issueId,
          code: coerced.issue,
          sourceRows: [sourceRow],
          sourceColumn: mapping.sourceColumn,
          message: coerced.issue === "required_value"
            ? "A required destination field is blank."
            : "A value does not match the selected destination type.",
        });
        continue;
      }
      values[mapping.targetField] = coerced.value;
      for (const code of coerced.warnings)
        warningCells.push({ code, sourceRow, sourceColumn: mapping.sourceColumn });
    }
    const duplicateRows = duplicateSourceKeys.get(sourceRow);
    if (duplicateRows) {
      const issueId = derivedId("issue", [input.sessionId, duplicateRows, "duplicate_source"]);
      rowIssueIds.push(issueId);
      if (!issues.some(issue => issue.issueId === issueId)) issues.push({
        issueId,
        code: "duplicate_source_key",
        sourceRows: duplicateRows,
        message: "More than one source row uses the same confirmed update value.",
      });
    }
    if (rowIssueIds.length > 0) {
      dispositions.push({ sourceRow, kind: "blocked", issueIds: rowIssueIds });
      warnings.push(...warningCells);
      continue;
    }
    const matchKey = input.mode.kind === "upsert"
      ? canonicalJson(values[input.mode.matchField] ?? null) : undefined;
    candidateRows.push({ sourceRow, values, warningCells, ...(matchKey ? { matchKey } : {}) });
  }

  if (input.mode.kind === "upsert") {
    const bySourceKey = new Map<string, number[]>();
    for (const row of candidateRows) {
      const matchValue = row.values[input.mode.matchField];
      if (matchValue === null || matchValue === undefined || matchValue === "") continue;
      const bucket = bySourceKey.get(row.matchKey!) ?? [];
      bucket.push(row.sourceRow);
      bySourceKey.set(row.matchKey!, bucket);
    }
    for (const row of candidateRows) {
      const matchValue = row.values[input.mode.matchField];
      let rowIssue: ImportIssue | null = null;
      if (matchValue === null || matchValue === undefined || matchValue === "") {
        rowIssue = {
          issueId: derivedId("issue", [input.sessionId, row.sourceRow, "missing_match"]),
          code: "missing_match_value", sourceRows: [row.sourceRow],
          message: "The confirmed update field is blank.",
        };
      } else if ((bySourceKey.get(row.matchKey!)?.length ?? 0) > 1) {
        const sourceRows = bySourceKey.get(row.matchKey!)!;
        rowIssue = {
          issueId: derivedId("issue", [input.sessionId, sourceRows, "duplicate_source"]),
          code: "duplicate_source_key", sourceRows,
          message: "More than one source row uses the same confirmed update value.",
        };
      } else if ((existingByMatch.get(row.matchKey!)?.length ?? 0) > 1) {
        rowIssue = {
          issueId: derivedId("issue", [input.sessionId, row.sourceRow, "ambiguous_target"]),
          code: "ambiguous_target_key", sourceRows: [row.sourceRow],
          message: "More than one existing record matches this update value.",
        };
      }
      if (rowIssue) {
        if (!issues.some(issue => issue.issueId === rowIssue!.issueId)) issues.push(rowIssue);
        dispositions.push({ sourceRow: row.sourceRow, kind: "blocked", issueIds: [rowIssue.issueId] });
        warnings.push(...row.warningCells);
        continue;
      }
      const target = existingByMatch.get(row.matchKey!)?.[0];
      if (target) {
        const patch: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(row.values)) {
          const blankMode = mappings.find(mapping => mapping.targetField === field)?.blankMode ?? "leave";
          if (value === null && blankMode !== "clear") continue;
          if (!valuesEqual(target[field], value)) patch[field] = value;
        }
        if (Object.keys(patch).length === 0) {
          dispositions.push({ sourceRow: row.sourceRow, kind: "skip", reasonCode: "no_change" });
          warnings.push(...row.warningCells);
          continue;
        }
        const mutationId = derivedId("mutation", [input.sessionId, row.sourceRow, target.id]);
        mutations.push({
          mutationId, role: "primary_target", kind: "update", table: input.target.name,
          rowId: String(target.id), originSourceRows: [row.sourceRow], patch,
          payloadDigest: importValueFingerprint(patch), beforeDigest: importValueFingerprint(target),
        });
        dispositions.push({ sourceRow: row.sourceRow, kind: "update" });
        warnings.push(...row.warningCells);
        continue;
      }
      if (blockUnmappedRequiredCreate(row)) continue;
      const mutationId = derivedId("mutation", [input.sessionId, row.sourceRow, "create"]);
      mutations.push({
        mutationId, role: "primary_target", kind: "create", table: input.target.name,
        rowId: derivedRowId([input.sessionId, row.sourceRow, "row"]),
        originSourceRows: [row.sourceRow], row: row.values,
        payloadDigest: importValueFingerprint(row.values),
      });
      dispositions.push({ sourceRow: row.sourceRow, kind: "create" });
      warnings.push(...row.warningCells);
    }
  } else {
    for (const row of candidateRows) {
      if (blockUnmappedRequiredCreate(row)) continue;
      const mutationId = derivedId("mutation", [input.sessionId, row.sourceRow, "create"]);
      mutations.push({
        mutationId, role: "primary_target", kind: "create", table: input.target.name,
        rowId: derivedRowId([input.sessionId, row.sourceRow, "row"]),
        originSourceRows: [row.sourceRow], row: row.values,
        payloadDigest: importValueFingerprint(row.values),
      });
      dispositions.push({ sourceRow: row.sourceRow, kind: "create" });
      warnings.push(...row.warningCells);
    }
  }

  dispositions.sort((left, right) => left.sourceRow - right.sourceRow);
  const totals = sourceTotals(dispositions);
  const mutationTotals: MutationTotals = {
    primaryTargetCreates: mutations.filter(mutation => mutation.kind === "create").length,
    primaryTargetUpdates: mutations.filter(mutation => mutation.kind === "update").length,
    auxiliaryRelatedCreates: 0,
    changedCount: mutations.length,
  };
  const warningReasons: ImportWarningTotals["warningReasons"] = {
    trimmed_whitespace: 0, leading_zero_identifier: 0, enum_case_normalized: 0,
  };
  for (const warning of warnings) warningReasons[warning.code]++;
  const warningTotals = { warnings: warnings.length, warningReasons };
  const target = { table: input.target.name, label: input.target.semantic?.label ?? input.target.name };
  const seed = {
    version: 1, appInstanceId: input.appInstanceId, sessionId: input.sessionId,
    sourceKind: input.sourceKind, sourceDigest: input.sourceDigest, baseVersion: input.baseVersion,
    target, header: input.header, mappings, dispositions, mutations, warningTotals,
  };
  const previewId = derivedId("preview", seed);
  const previewDigest = digest({ ...seed, previewId });
  const commitAllowed = totals.blockedRows === 0;
  const completion = mutations.length === 0 ? "no_change" as const : "commit" as const;
  return {
    preview: {
      sessionId: input.sessionId, previewId, previewDigest, sourceKind: input.sourceKind,
      target, baseVersion: input.baseVersion, headers, mappings,
      sourceTotals: totals, mutationTotals, warningTotals, warnings, issues,
      completion, commitAllowed,
    },
    envelope: {
      appInstanceId: input.appInstanceId, sessionId: input.sessionId, previewId, previewDigest,
      sourceKind: input.sourceKind, sourceDigest: input.sourceDigest, baseVersion: input.baseVersion,
      target, dispositions, mutations, sourceTotals: totals, mutationTotals, warningTotals,
    },
  };
}
