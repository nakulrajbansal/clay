import { z } from "@clay/schema/validation-runtime";
import { AppInstanceId, Sha256 } from "@clay/schema";
import {
  ImportAcquisitionLimitsSchema,
  ImportParserChunkSchema,
  ImportSessionIdSchema,
  ImportSheetIdSchema,
  ImportSourceDescriptorSchema,
} from "./import-staging-contracts";
export * from "./import-staging-contracts";

// Pure factories include nested Zod construction, not just the outer call. Each
// worker can discard unused contract families without changing their validation.

export const ImportSheetChoiceSchema = /*#__PURE__*/ (() => (z.object({
  sheetId: ImportSheetIdSchema,
}).strict()))();

export const ImportRangeChoiceSchema = /*#__PURE__*/ (() => (z.object({
  sheetId: ImportSheetIdSchema,
  startRow: z.number().int().positive().max(5_001),
  endRow: z.number().int().positive().max(5_001),
  startColumn: z.number().int().positive().max(20),
  endColumn: z.number().int().positive().max(20),
}).strict().superRefine((range, ctx) => {
  if (range.endRow < range.startRow)
    ctx.addIssue({ code: "custom", message: "range rows must be ordered" });
  if (range.endColumn < range.startColumn)
    ctx.addIssue({ code: "custom", message: "range columns must be ordered" });
  if (range.endRow - range.startRow + 1 > 5_001)
    ctx.addIssue({ code: "custom", message: "range exceeds the source-row ceiling" });
  if (range.endColumn - range.startColumn + 1 > 20)
    ctx.addIssue({ code: "custom", message: "range exceeds the mapped-column ceiling" });
})))();

export const ImportHeaderChoiceSchema = /*#__PURE__*/ (() => (z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("header"),
    sourceRow: z.number().int().positive().max(5_001),
  }).strict(),
  z.object({ mode: z.literal("no_header") }).strict(),
])))();

export const ImportDateRuleSchema = /*#__PURE__*/ (() => (z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("iso") }).strict(),
  z.object({
    kind: z.literal("ordered"),
    order: z.enum(["mdy", "dmy"]),
    separator: z.enum(["/", "-"]),
  }).strict(),
])))();

export const ImportNumberRuleSchema = /*#__PURE__*/ (() => (z.object({
  grammar: z.enum([
    "ungrouped_dot_decimal",
    "comma_grouped_dot_decimal",
    "dot_grouped_comma_decimal",
  ]),
  affix: z.union([
    z.null(),
    z.object({
      symbol: z.enum(["$", "€", "£", "¥"]),
      position: z.enum(["prefix", "suffix"]),
    }).strict(),
  ]),
  percentScale: z.enum(["none", "zero_to_one", "zero_to_hundred"]),
}).strict()))();

export type ImportSheetChoice = z.infer<typeof ImportSheetChoiceSchema>;
export type ImportRangeChoice = z.infer<typeof ImportRangeChoiceSchema>;

export const HeaderCandidateReasonSchema = /*#__PURE__*/ (() => (z.enum([
  "no_non_blank_row",
  "first_non_blank_row",
  "all_labels_present",
  "contains_blank_label",
  "labels_unique",
  "duplicate_labels",
  "labels_textual",
  "contains_non_text_label",
  "data_shape_contrast",
  "no_data_shape_contrast",
  "no_following_data",
])))();
export const HeaderCandidateSchema = /*#__PURE__*/ (() => (z.object({
  recommendedRow: z.number().int().positive().max(10).nullable(),
  confidence: z.enum(["high", "low", "none"]),
  reasons: z.array(HeaderCandidateReasonSchema).min(1).max(5),
}).strict().superRefine((candidate, ctx) => {
  if ((candidate.recommendedRow === null) !== (candidate.confidence === "none"))
    ctx.addIssue({ code: "custom", message: "empty header candidates use none confidence" });
  if (new Set(candidate.reasons).size !== candidate.reasons.length)
    ctx.addIssue({ code: "custom", message: "header candidate reasons must be unique" });
})))();
export type HeaderCandidateReason = z.infer<typeof HeaderCandidateReasonSchema>;
export type HeaderCandidate = z.infer<typeof HeaderCandidateSchema>;

export const ImportSkipCodeSchema = /*#__PURE__*/ (() => (z.enum([
  "above_header",
  "blank_row",
  "user_skipped",
  "duplicate_combined",
  "duplicate_skipped",
  "no_change",
  "unmapped_row",
])))();
const SourceRowOrdinalSchema = /*#__PURE__*/ (() => (z.number().int().positive().max(5_001)))();
const ImportIssueIdSchema = /*#__PURE__*/ (() => (z.string().regex(/^issue_[a-zA-Z0-9_-]{1,64}$/)))();

export const SourceRowDispositionSchema = /*#__PURE__*/ (() => (z.discriminatedUnion("kind", [
  z.object({ sourceRow: SourceRowOrdinalSchema, kind: z.literal("create") }).strict(),
  z.object({ sourceRow: SourceRowOrdinalSchema, kind: z.literal("update") }).strict(),
  z.object({
    sourceRow: SourceRowOrdinalSchema,
    kind: z.literal("skip"),
    reasonCode: ImportSkipCodeSchema,
  }).strict(),
  z.object({
    sourceRow: SourceRowOrdinalSchema,
    kind: z.literal("blocked"),
    issueIds: z.array(ImportIssueIdSchema).min(1).max(100),
  }).strict(),
])))();

export const ImportSourceDispositionLedgerSchema = /*#__PURE__*/ (() => (z.array(SourceRowDispositionSchema)
  .max(5_000).superRefine((rows, ctx) => {
    if (new Set(rows.map(row => row.sourceRow)).size !== rows.length)
      ctx.addIssue({ code: "custom", message: "each source row needs exactly one disposition" });
  })))();

const BoundedImportCountSchema = /*#__PURE__*/ (() => (z.number().int().nonnegative().max(5_000)))();
export const ImportSkipReasonCountsSchema = /*#__PURE__*/ (() => (z.object({
  above_header: BoundedImportCountSchema,
  blank_row: BoundedImportCountSchema,
  user_skipped: BoundedImportCountSchema,
  duplicate_combined: BoundedImportCountSchema,
  duplicate_skipped: BoundedImportCountSchema,
  no_change: BoundedImportCountSchema,
  unmapped_row: BoundedImportCountSchema,
}).strict()))();

export const SourceDispositionTotalsSchema = /*#__PURE__*/ (() => (z.object({
  sourceRows: BoundedImportCountSchema,
  createRows: BoundedImportCountSchema,
  updateRows: BoundedImportCountSchema,
  skipRows: BoundedImportCountSchema,
  blockedRows: BoundedImportCountSchema,
  skipReasons: ImportSkipReasonCountsSchema,
}).strict().superRefine((totals, ctx) => {
  if (totals.sourceRows !== totals.createRows + totals.updateRows
      + totals.skipRows + totals.blockedRows)
    ctx.addIssue({ code: "custom", message: "source disposition totals do not balance" });
  const classifiedSkips = Object.values(totals.skipReasons)
    .reduce((sum, count) => sum + count, 0);
  if (classifiedSkips !== totals.skipRows)
    ctx.addIssue({ code: "custom", message: "skip reason totals do not balance" });
})))();

export const MutationTotalsSchema = /*#__PURE__*/ (() => (z.object({
  primaryTargetCreates: BoundedImportCountSchema,
  primaryTargetUpdates: BoundedImportCountSchema,
  auxiliaryRelatedCreates: BoundedImportCountSchema,
  changedCount: BoundedImportCountSchema,
}).strict().superRefine((totals, ctx) => {
  if (totals.changedCount !== totals.primaryTargetCreates
      + totals.primaryTargetUpdates + totals.auxiliaryRelatedCreates)
    ctx.addIssue({ code: "custom", message: "canonical mutation totals do not balance" });
})))();

export type ImportSkipCode = z.infer<typeof ImportSkipCodeSchema>;
export type SourceRowDisposition = z.infer<typeof SourceRowDispositionSchema>;
export type SourceDispositionTotals = z.infer<typeof SourceDispositionTotalsSchema>;
export type MutationTotals = z.infer<typeof MutationTotalsSchema>;

const ImportMutationIdSchema = /*#__PURE__*/ (() => (z.string().regex(/^mutation_[a-z2-7]{26}$/)))();
const ImportTableIdSchema = /*#__PURE__*/ (() => (z.string().regex(/^tbl_[a-z2-7]{26}$/)))();
const ImportRowIdSchema = /*#__PURE__*/ (() => (z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
)))();
const OriginSourceRowsSchema = /*#__PURE__*/ (() => (z.array(SourceRowOrdinalSchema).min(1).max(5_000)
  .superRefine((rows, ctx) => {
    if (new Set(rows).size !== rows.length)
      ctx.addIssue({ code: "custom", message: "mutation origins must be unique" });
    if (rows.some((row, index) => index > 0 && row <= rows[index - 1]!))
      ctx.addIssue({ code: "custom", message: "mutation origins must be ordered" });
  })))();
const PreparedMutationBase = /*#__PURE__*/ (() => ({
  mutationId: ImportMutationIdSchema,
  tableId: ImportTableIdSchema,
  rowId: ImportRowIdSchema,
  originSourceRows: OriginSourceRowsSchema,
  payloadDigest: Sha256,
}))();
export const PreparedImportMutationSchema = /*#__PURE__*/ (() => (z.discriminatedUnion("role", [
  z.object({
    ...PreparedMutationBase,
    role: z.literal("primary_target"),
    kind: z.enum(["create", "update"]),
  }).strict(),
  z.object({
    ...PreparedMutationBase,
    role: z.literal("auxiliary_related"),
    kind: z.literal("create"),
  }).strict(),
])))();
export const SourceRowMutationMapSchema = /*#__PURE__*/ (() => (z.object({
  sourceRow: SourceRowOrdinalSchema,
  primaryMutationId: ImportMutationIdSchema.nullable(),
  auxiliaryRelatedMutationIds: z.array(ImportMutationIdSchema).max(100),
}).strict().superRefine((mapping, ctx) => {
  if (new Set(mapping.auxiliaryRelatedMutationIds).size
      !== mapping.auxiliaryRelatedMutationIds.length)
    ctx.addIssue({ code: "custom", message: "auxiliary mutation references must be unique" });
})))();

export const ImportPreparedLedgerSchema = /*#__PURE__*/ (() => (z.object({
  dispositions: ImportSourceDispositionLedgerSchema,
  rowMutationMap: z.array(SourceRowMutationMapSchema).max(5_000),
  mutations: z.array(PreparedImportMutationSchema).max(5_000),
  mutationTotals: MutationTotalsSchema,
}).strict().superRefine((ledger, ctx) => {
  const fail = (message: string): void => ctx.addIssue({ code: "custom", message });
  const mutationById = new Map(ledger.mutations.map(mutation => [mutation.mutationId, mutation]));
  if (mutationById.size !== ledger.mutations.length) fail("mutation identifiers must be unique");
  if (new Set(ledger.mutations.map(mutation => `${mutation.tableId}\u0000${mutation.rowId}`)).size
      !== ledger.mutations.length) fail("canonical table/row transitions must be unique");

  const mappingByRow = new Map(ledger.rowMutationMap.map(mapping => [mapping.sourceRow, mapping]));
  if (mappingByRow.size !== ledger.rowMutationMap.length) fail("row mappings must be unique");
  if (mappingByRow.size !== ledger.dispositions.length) fail("every disposition needs one row map");
  const referencedOrigins = new Map<string, number[]>();
  const noteReference = (mutationId: string, sourceRow: number): void => {
    const origins = referencedOrigins.get(mutationId) ?? [];
    origins.push(sourceRow);
    referencedOrigins.set(mutationId, origins);
  };
  for (const disposition of ledger.dispositions) {
    const mapping = mappingByRow.get(disposition.sourceRow);
    if (!mapping) { fail("every disposition needs one row map"); continue; }
    if (disposition.kind === "create" || disposition.kind === "update") {
      if (mapping.primaryMutationId === null) {
        fail("create/update dispositions require a primary mutation");
      } else {
        const primary = mutationById.get(mapping.primaryMutationId);
        if (!primary || primary.role !== "primary_target" || primary.kind !== disposition.kind)
          fail("primary mutation role/kind must match its disposition");
        noteReference(mapping.primaryMutationId, disposition.sourceRow);
      }
      for (const mutationId of mapping.auxiliaryRelatedMutationIds) {
        const auxiliary = mutationById.get(mutationId);
        if (!auxiliary || auxiliary.role !== "auxiliary_related")
          fail("auxiliary references require auxiliary creates");
        noteReference(mutationId, disposition.sourceRow);
      }
    } else if (mapping.primaryMutationId !== null
        || mapping.auxiliaryRelatedMutationIds.length !== 0) {
      fail("skip/blocked dispositions cannot map mutations");
    }
  }
  for (const mutation of ledger.mutations) {
    const origins = referencedOrigins.get(mutation.mutationId) ?? [];
    if (origins.length === 0) fail("unreferenced mutations are forbidden");
    const orderedOrigins = [...origins].sort((left, right) => left - right);
    if (orderedOrigins.length !== mutation.originSourceRows.length
        || orderedOrigins.some((row, index) => row !== mutation.originSourceRows[index]))
      fail("mutation origins must equal row-map references");
  }
  const actualTotals = {
    primaryTargetCreates: ledger.mutations.filter(mutation =>
      mutation.role === "primary_target" && mutation.kind === "create").length,
    primaryTargetUpdates: ledger.mutations.filter(mutation =>
      mutation.role === "primary_target" && mutation.kind === "update").length,
    auxiliaryRelatedCreates: ledger.mutations.filter(mutation =>
      mutation.role === "auxiliary_related").length,
  };
  if (actualTotals.primaryTargetCreates !== ledger.mutationTotals.primaryTargetCreates
      || actualTotals.primaryTargetUpdates !== ledger.mutationTotals.primaryTargetUpdates
      || actualTotals.auxiliaryRelatedCreates !== ledger.mutationTotals.auxiliaryRelatedCreates)
    fail("mutation totals must count the unique canonical ledger");
})))();

export type PreparedImportMutation = z.infer<typeof PreparedImportMutationSchema>;
export type SourceRowMutationMap = z.infer<typeof SourceRowMutationMapSchema>;
export type ImportPreparedLedger = z.infer<typeof ImportPreparedLedgerSchema>;

export const ImportParserErrorCodeSchema = /*#__PURE__*/ (() => (z.enum([
  "E_IMPORT_SOURCE_LIMIT",
  "E_IMPORT_UTF8",
  "E_IMPORT_CONTROL_CHARACTER",
  "E_IMPORT_CSV_SYNTAX",
  "E_IMPORT_RAGGED_ROW",
  "E_IMPORT_ROW_LIMIT",
  "E_IMPORT_COLUMN_LIMIT",
  "E_IMPORT_CELL_LIMIT",
  "E_IMPORT_DECODED_LIMIT",
  "E_IMPORT_TIME_LIMIT",
  "E_IMPORT_EMPTY_SOURCE",
  "E_IMPORT_XLSX_UNAVAILABLE",
  "E_IMPORT_XLSX_INVALID",
  "E_IMPORT_XLSX_UNSAFE",
  "E_IMPORT_XLSX_UNSUPPORTED",
  "E_IMPORT_XLSX_FORMULA",
  "E_IMPORT_CHUNK_LIMIT",
  "E_IMPORT_SESSION_UNKNOWN",
  "E_IMPORT_PROTOCOL",
])))();
export const ImportParserStageSchema = /*#__PURE__*/ (() => (z.enum([
  "acquire", "decode", "parse", "chunk", "session", "protocol",
])))();
const ImportParserRpcIdSchema = /*#__PURE__*/ (() => (z.number().int().positive().safe()))();
const ArrayBufferSchema = /*#__PURE__*/ (() => (z.custom<ArrayBuffer>(value =>
  Object.prototype.toString.call(value) === "[object ArrayBuffer]", "ArrayBuffer required")))();

export const OpenImportSourceRequestSchema = /*#__PURE__*/ (() => (z.object({
  version: z.literal(1),
  id: ImportParserRpcIdSchema,
  op: z.literal("openImportSource"),
  payload: z.object({
    appInstanceId: AppInstanceId,
    kind: z.enum(["csv", "paste", "xlsx"]),
    bytes: ArrayBufferSchema,
  }).strict(),
}).strict()))();
export const ReadImportChunkRequestSchema = /*#__PURE__*/ (() => (z.object({
  version: z.literal(1),
  id: ImportParserRpcIdSchema,
  op: z.literal("readImportChunk"),
  payload: z.object({
    appInstanceId: AppInstanceId,
    sessionId: ImportSessionIdSchema,
    sheetId: ImportSheetIdSchema.optional(),
    cursor: z.number().int().nonnegative().max(5_000),
  }).strict(),
}).strict()))();
export const CloseImportSourceRequestSchema = /*#__PURE__*/ (() => (z.object({
  version: z.literal(1),
  id: ImportParserRpcIdSchema,
  op: z.literal("closeImportSource"),
  payload: z.object({
    appInstanceId: AppInstanceId,
    sessionId: ImportSessionIdSchema,
    reason: z.enum(["cancel", "commit", "restart", "app_switch", "timeout"]),
  }).strict(),
}).strict()))();
export const ImportParserRequestSchema = /*#__PURE__*/ (() => (z.discriminatedUnion("op", [
  OpenImportSourceRequestSchema,
  ReadImportChunkRequestSchema,
  CloseImportSourceRequestSchema,
])))();

export const CloseImportSourceResultSchema = /*#__PURE__*/ (() => (z.object({ disposed: z.literal(true) }).strict()))();

export const ImportParserSafeErrorSchema = /*#__PURE__*/ (() => (z.object({
  code: ImportParserErrorCodeSchema,
  stage: ImportParserStageSchema,
  message: z.literal("The import source could not be read safely."),
  row: z.number().int().positive().max(5_001).optional(),
  column: z.number().int().positive().max(20).optional(),
  limit: z.number().int().nonnegative().safe().optional(),
  actual: z.number().int().nonnegative().safe().optional(),
}).strict()))();

export const ImportParserResponseSchema = /*#__PURE__*/ (() => (z.union([
  z.object({
    version: z.literal(1),
    id: ImportParserRpcIdSchema,
    ok: z.literal(true),
    result: z.union([
      ImportSourceDescriptorSchema,
      ImportParserChunkSchema,
      CloseImportSourceResultSchema,
    ]),
  }).strict(),
  z.object({
    version: z.literal(1),
    id: ImportParserRpcIdSchema,
    ok: z.literal(false),
    error: ImportParserSafeErrorSchema,
  }).strict(),
])))();

export type ImportParserRequest = z.infer<typeof ImportParserRequestSchema>;
export type ImportParserSafeError = z.infer<typeof ImportParserSafeErrorSchema>;
export type ImportParserResponse = z.infer<typeof ImportParserResponseSchema>;
