import { z } from "./validation-runtime";
import { AppInstanceId, Sha256 } from "./index";

/**
 * Runtime contracts required by both the parser worker and the DB worker.
 * Keep this staging boundary independent from the larger import contract
 * facade so ordinary database-worker validation does not evaluate unrelated
 * workbook, mapping, and receipt schemas.
 */
export const ImportAcquisitionLimitsSchema = /*#__PURE__*/ (() => (z.object({
  maxDataRows: z.literal(5_000),
  maxMappedColumns: z.literal(20),
  maxDecodedCellBytes: z.literal(16 * 1024),
  maxDecodedCellsBytes: z.literal(32 * 1024 * 1024),
  maxDelimitedSourceBytes: z.literal(16 * 1024 * 1024),
  maxPasteSourceBytes: z.literal(8 * 1024 * 1024),
  maxCompressedXlsxBytes: z.literal(25 * 1024 * 1024),
  maxExpandedXlsxBytes: z.literal(100 * 1024 * 1024),
  maxXlsxEntries: z.literal(2_000),
  maxParseMilliseconds: z.literal(8_000),
  maxChunkRows: z.literal(250),
  maxChunkBytes: z.literal(1024 * 1024),
}).strict()))();

export type ImportAcquisitionLimits = z.infer<typeof ImportAcquisitionLimitsSchema>;

export const IMPORT_ACQUISITION_LIMITS: ImportAcquisitionLimits = /*#__PURE__*/ Object.freeze({
  maxDataRows: 5_000,
  maxMappedColumns: 20,
  maxDecodedCellBytes: 16 * 1024,
  maxDecodedCellsBytes: 32 * 1024 * 1024,
  maxDelimitedSourceBytes: 16 * 1024 * 1024,
  maxPasteSourceBytes: 8 * 1024 * 1024,
  maxCompressedXlsxBytes: 25 * 1024 * 1024,
  maxExpandedXlsxBytes: 100 * 1024 * 1024,
  maxXlsxEntries: 2_000,
  maxParseMilliseconds: 8_000,
  maxChunkRows: 250,
  maxChunkBytes: 1024 * 1024,
});

export const ImportSessionIdSchema = /*#__PURE__*/ (() => (z.string().regex(/^import_[a-z2-7]{26}$/)))();
export const ImportSheetIdSchema = /*#__PURE__*/ (() => (z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)))();
export const ImportSourceKindSchema = /*#__PURE__*/ (() => (z.enum([
  "csv", "xlsx", "paste", "tsv_compat", "json_compat",
])))();

export const ImportSourceRangeSchema = /*#__PURE__*/ (() => (z.object({
  rows: z.number().int().nonnegative().max(5_001),
  columns: z.number().int().nonnegative().max(20),
}).strict()))();

export const ImportSheetDescriptorSchema = /*#__PURE__*/ (() => (z.object({
  sheetId: ImportSheetIdSchema,
  label: z.string().min(1).max(120),
  visibility: z.enum(["visible", "hidden", "very_hidden"]),
  range: ImportSourceRangeSchema,
}).strict()))();

export const ImportSourceDescriptorSchema = /*#__PURE__*/ (() => (z.object({
  version: z.literal(1),
  sessionId: ImportSessionIdSchema,
  appInstanceId: AppInstanceId,
  kind: ImportSourceKindSchema,
  sourceDigest: Sha256,
  sheets: z.array(ImportSheetDescriptorSchema).min(1).max(2_000),
  limits: ImportAcquisitionLimitsSchema,
}).strict().superRefine((source, ctx) => {
  if ((source.kind === "csv" || source.kind === "paste") && source.sheets.length !== 1)
    ctx.addIssue({ code: "custom", message: "delimited sources expose one synthetic range" });
  if ((source.kind === "csv" || source.kind === "paste")
      && source.sheets[0]?.visibility !== "visible")
    ctx.addIssue({ code: "custom", message: "a synthetic range must be visible" });
  if (new Set(source.sheets.map(sheet => sheet.sheetId)).size !== source.sheets.length)
    ctx.addIssue({ code: "custom", message: "sheet identifiers must be unique" });
})))();

export type ImportHeaderChoice =
  | { mode: "header"; sourceRow: number }
  | { mode: "no_header" };
export type ImportDateRule =
  | { kind: "iso" }
  | { kind: "ordered"; order: "mdy" | "dmy"; separator: "/" | "-" };
export type ImportNumberRule = {
  grammar: "ungrouped_dot_decimal" | "comma_grouped_dot_decimal" | "dot_grouped_comma_decimal";
  affix: null | { symbol: "$" | "€" | "£" | "¥"; position: "prefix" | "suffix" };
  percentScale: "none" | "zero_to_one" | "zero_to_hundred";
};
export type ExistingTableImportMapping = {
  sourceColumn: number;
  targetField: string;
  blankMode?: "leave" | "clear" | "empty_text";
  numberRule?: ImportNumberRule;
  dateRule?: ImportDateRule;
};
export type ExistingTableImportMode =
  | { kind: "append" }
  | { kind: "upsert"; matchField: string };
export type ConfigureExistingTableImport = {
  sessionId: string;
  header: ImportHeaderChoice;
  mode: ExistingTableImportMode;
  mappings: ExistingTableImportMapping[];
};

const ImportRawCellSchema = /*#__PURE__*/ (() => (z.string().max(16 * 1024)))();
export const ImportParserChunkSchema = /*#__PURE__*/ (() => (z.object({
  sessionId: ImportSessionIdSchema,
  cursor: z.number().int().nonnegative().max(5_000),
  startRow: z.number().int().positive().max(5_001),
  rows: z.array(z.array(ImportRawCellSchema).min(1).max(20)).min(1).max(250),
  nextCursor: z.number().int().positive().max(5_000).nullable(),
  serializedBytes: z.number().int().positive().max(1024 * 1024),
}).strict()))();

const ImportWarningCountSchema = /*#__PURE__*/ (() => (z.number().int().nonnegative().max(5_000)))();
export const ImportWarningTotalsSchema = /*#__PURE__*/ (() => (z.object({
  warnings: ImportWarningCountSchema,
  warningReasons: z.object({
    trimmed_whitespace: ImportWarningCountSchema,
    leading_zero_identifier: ImportWarningCountSchema,
    enum_case_normalized: ImportWarningCountSchema,
  }).strict(),
}).strict().superRefine((totals, ctx) => {
  const classified = Object.values(totals.warningReasons)
    .reduce((sum, count) => sum + count, 0);
  if (classified !== totals.warnings)
    ctx.addIssue({ code: "custom", message: "warning reason totals do not balance" });
})))();

export type ImportSessionId = z.infer<typeof ImportSessionIdSchema>;
export type ImportSourceKind = z.infer<typeof ImportSourceKindSchema>;
export type ImportSourceDescriptor = z.infer<typeof ImportSourceDescriptorSchema>;
export type ImportParserChunk = z.infer<typeof ImportParserChunkSchema>;
