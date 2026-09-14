// ClayStore: the trusted facade over user.db + system.db. Commits span
// DDL + backfills + registry update + version_log append in ONE
// transaction (doc 04 §4). Versioning is a linear chain (doc 04 §5):
// rollback applies inverses; roll-forward (pre-truncation) re-applies
// forward ops; truncation is the only destructive-ish operation (ADR-007).
import { ClayError } from "./errors";
import { readInboxDispositions, writeInboxDisposition } from "./inbox-dispositions";
import { LEGACY_CREDENTIAL_SETTING_KEYS } from "./credential-policy";
import { userIndexAuthorities } from "./index-authority";
import {
  copyDatabase, createSystemTables, openDriverFromBytes, openMemoryDriver,
  type DatabaseCopyShape, type DbDriver, type SqlRow, type SqlValue,
} from "./db";
import { renamePanelFieldReferences } from "./panel-rewrite";
import { zipRead, zipWrite } from "./zip";
import { validateMutationPlan } from "./validate";
import {
  cloneActiveRegistry, cloneFieldSemantic, cloneRegistry, cloneTableSemantic,
  findColumn, findStoredColumn, getTable, isVirtualColumn,
  type Registry, type RegColumn, type RegTable,
} from "./registry";
import { isUuidV7, nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
import {
  applyForwardOps, applyInverseOps, createTableSql, deriveInverse, validateMigrationPlan,
  type MigrationPlanT,
} from "./migrate";
import {
  rowMatchesConditions, runQuery, type QueryByteBudget, type QueryRow,
} from "./query";
import { exprFields, parseExpr } from "./expr";
import { Observer, type Suggestion, type UsageEvent } from "./observe";
import {
  PrivateMetricsReducer, type PrivateMetricEvent, type PrivateMetricsSummary,
} from "./private-metrics";
import { SqlitePrivateMetricDriver } from "./private-metrics-sqlite";
import {
  validateAutomationDefinition,
  type AutomationAction, type AutomationDefinition, type AutomationDefinitionInput,
  type AutomationRun, type AutomationSimulation, type AutomationValue, type ClayNotification,
} from "./automation";
import {
  importValueFingerprint,
  type CommitExistingImportInput,
  type CommitImportResult,
  type ImportReceipt,
  type PreparedExistingImportMutation,
} from "./import-journey";
import type { MutationTotals, SourceDispositionTotals } from "./import-contracts";
import { ImportWarningTotalsSchema } from "./import-staging-contracts";
import {
  automationDefinitionDigest, automationRecipeCatalog, automationSha256,
  compileAutomationRecipeDraft, plannedEffectsFor, resolveAutomationDraftV2,
  stableAutomationJson, validateAutomationEnableProof, validateAutomationSimulationProof,
  validateAutomationTargetIdentity,
  type AutomationDefinitionAny, type AutomationDefinitionV2, type AutomationDraftInputV2,
  type AutomationEnableRequestV1, type AutomationExecutionResultV1,
  type AutomationLegacyDefinitionV1, type AutomationPauseRequestV1,
  type AutomationRecipeCardV1,
  type AutomationRecipeDraftRequestV1, type AutomationRuleRuntimeStateV1,
  type AutomationRunNowRequestV1, type AutomationRunRuntimeStateV1,
  type AutomationRuntimeOverviewV1, type AutomationRuntimeStatusV1,
  type AutomationSimulationProofV1, type AutomationSimulationRequestV1,
  type AutomationTargetIdentityV1,
} from "./automation-v2";
import {
  createFieldId, createRelationshipId, createTableId, isTableId, semanticRegistryIssues,
  type FieldId, type FieldSemanticV1, type PreparedSemanticAssignmentsV1,
  type SemanticIdentityEventV1, type SemanticOperationBounds, type SemanticOrigin,
  type SemanticRelationshipRecordV1, type SemanticSchemaTraceV1,
  type TableId, type TableSemanticV1,
} from "./semantic";
import { sha256HexSync } from "./state-digest";
import type {
  IntakeAutoAcceptDraftV1,
  IntakeSubmissionPlaintextV1,
  LocalIntakeFormV2,
} from "@clay/schema/intake";
import { IntakePublicationClosureV1 } from "@clay/schema/standalone/intake";
import { IntakeAutoAcceptRuleV1 } from "@clay/schema/standalone/intake";
import { assertNoLegacyIntakeArchive } from "./intake-archive-boundary";
import {
  autoAcceptFingerprint, encodeIntakeFileBytes, hydrateStoredIntakeSubmission,
  intakeInboxItem, mintIntakeReceiptId,
  parseAutoAcceptDraft, parseIntakeState, parseIntakeSubmission, parseLocalIntakeForm,
  resolveIntakeForm, splitIntakeSubmissionForStorage,
  submissionMatchesAutoRule, validateSubmissionForForm,
  type IntakeAcceptanceReceipt, type IntakeAutoAcceptSimulation,
  type IntakeDeliveryFailure, type IntakeDeliveryFailureStatus,
  type IntakeInboxItem, type IntakeLocalStateV2,
} from "./intake";

type QueryT = import("@clay/schema").Query;

export type PanelBlobInput = {
  panel_id: string;
  title: string;
  placement: { region: "top" | "main" | "side"; order: number; w?: number; h?: number; col?: number };
  code: string;
  declared_queries: QueryT[];
  declared_writes: string[];
};

export type LivePanel = PanelBlobInput & { version: number };

export type PanelProvenance = {
  panel_id: string;
  createdVersion: number;
  lastChangedVersion: number;
  createdAt: string;
  lastChangedAt: string;
  createdIntent: string;
  lastChangedIntent: string;
  createdSummary: string;
  lastChangedSummary: string;
};

export type FieldProvenance = {
  tableId: TableId;
  fieldId: FieldId;
  tableName: string;
  fieldName: string;
  fieldType: string;
  aliases: string[];
  origin: SemanticOrigin;
  state: "visible" | "hidden" | "inactive";
  createdVersion: number;
  lastChangedVersion: number;
  derivation?: { expression: string; dependencyFieldIds: FieldId[] };
};

export type SampleRowProvenanceEntry = Readonly<{
  tableId: TableId;
  rowId: string;
  operationId: string;
}>;

export type SampleRowProvenanceState = SampleRowProvenanceEntry & Readonly<{
  tableName: string;
  tableActive: boolean;
  rowState: "active" | "deleted";
}>;

export type CommitInput = {
  intent: string;
  summary: string;
  migration: MigrationPlanT | null;
  semanticOrigin?: SemanticOrigin;
  semanticAssignments?: PreparedSemanticAssignmentsV1;
  panels?: PanelBlobInput[];
  removePanels?: string[];
  diff?: unknown;
  /** Trusted direct manipulation may redirect an existing panel field to a
   * replacement (text-to-link conversion). Model plans never set this. */
  panelFieldReplacements?: { table: string; from: string; to: string }[];
};

/** G16/I4: rewrite field references in a declared query after a rename. */
function renameQueryFields(q: QueryT, table: string, from: string, to: string): QueryT {
  if (q.from !== table) return q;
  const field = (f: string): string => (f === from ? to : f);
  const out: QueryT = { ...q };
  if (out.select) out.select = out.select.map(field);
  if (out.where) out.where = out.where.map(c => ({ ...c, field: field(c.field) }));
  if (out.orWhere) out.orWhere = out.orWhere.map(g => g.map(c => ({ ...c, field: field(c.field) })));
  if (out.orderBy) out.orderBy = out.orderBy.map(o => ({ ...o, field: field(o.field) }));
  if (out.groupBy) out.groupBy = out.groupBy.map(field);
  if (out.aggregate) out.aggregate = out.aggregate.map(a => ({ ...a, field: field(a.field) }));
  return out;
}

export type VersionEntry = {
  version: number;
  parent: number;
  created_at: string;
  intent_text: string;
  summary: string;
  migration: MigrationPlanT | null;
};

export type HistoryEntry = Omit<VersionEntry, "migration"> & {
  label?: string;
  diff?: { kind: string; detail: string }[];   // what changed at this version
};

const SAFE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const qid = (name: string): string => {
  if (!SAFE_SQL_IDENTIFIER.test(name))
    throw new ClayError("E_VALIDATION", `unsafe SQL identifier '${name}'`);
  return `"${name}"`;
};

type AutomationClock = Readonly<{
  year: number; month: number; day: number; weekday: number; hour: number; minute: number;
}>;

function automationClock(now: Date, timeZone?: string): AutomationClock {
  if (!timeZone) return {
    year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
    weekday: now.getDay(), hour: now.getHours(), minute: now.getMinutes(),
  };
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now)
    .filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  const clock = {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday, hour: Number(parts.hour), minute: Number(parts.minute),
  };
  if (weekday < 0 || Object.entries(clock).some(([key, value]) => key !== "weekday"
      && !Number.isInteger(value)))
    throw new ClayError("E_VALIDATION", "automation timezone clock could not be resolved");
  return clock;
}

function sameAutomationTarget(
  left: AutomationTargetIdentityV1 | null,
  right: AutomationTargetIdentityV1 | null,
): boolean {
  return left !== null && right !== null
    && left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.stateRevision === right.stateRevision
    && left.stateDigest === right.stateDigest;
}

function sameAutomationLineage(
  left: AutomationTargetIdentityV1 | null,
  right: AutomationTargetIdentityV1 | null,
): boolean {
  return left !== null && right !== null
    && left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch;
}

function automationTargetJson(target: AutomationTargetIdentityV1): string {
  return stableAutomationJson(validateAutomationTargetIdentity(target));
}

function automationTargetFromJson(value: unknown): AutomationTargetIdentityV1 | null {
  if (typeof value !== "string") return null;
  try {
    return validateAutomationTargetIdentity(JSON.parse(value) as AutomationTargetIdentityV1);
  } catch { return null; }
}

/** Parse a stored diff_json into user-facing {kind, detail} lines, tolerantly. */
function parseDiff(json: string): { kind: string; detail: string }[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((d): d is { kind?: unknown; detail?: unknown } => !!d && typeof d === "object")
      .map(d => ({ kind: String(d.kind ?? "change"), detail: String(d.detail ?? "") }))
      .filter(d => d.detail !== "");
  } catch { return []; }
}

export type AttachmentInput = {
  table: string;
  rowId: string;
  field: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
};
export type AttachmentMetadata = {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
};
export type AttachmentFile = AttachmentMetadata & { bytes: Uint8Array };
export type AttachmentStorageSummary = {
  activeFiles: number; activeBytes: number; deletedFiles: number; deletedBytes: number;
};

export type GlobalSearchResult = {
  table: string;
  id: string;
  label: string;
  secondary: string;
  matchedFields: string[];
  score: number;
  updatedAt: string;
};

export type BatchMutation =
  | { kind: "update"; table: string; id: string; patch: Record<string, unknown> }
  | { kind: "insert"; table: string; row: Record<string, unknown> }
  | { kind: "soft_delete"; table: string; id: string }
  | { kind: "restore"; table: string; id: string };
export type BatchSource = "user" | "automation" | "import";
export type BatchReceipt = {
  id: string;
  at: string;
  source: BatchSource;
  summary: string;
  changed: number;
  created: { table: string; id: string }[];
  undone: boolean;
};

export type RelationConversionRequest = {
  sourceTable: string;
  sourceField: string;
  targetTable: string;
  displayField: string;
};
export type RelationConversionPreview = RelationConversionRequest & {
  /** Required by production Keep; absent only on isolated legacy Store previews. */
  authorityTarget?: import("@clay/schema/catalog").TargetEvidenceV1;
  atVersion: number;
  fingerprint: string;
  matchedRows: number;
  unmatchedRows: number;
  ambiguousRows: number;
  duplicateSourceRows: number;
  unmatchedSamples: string[];
  ambiguousSamples: string[];
};
export type RelationConversionResult = {
  version: number;
  convertedRows: number;
  sourceField: string;
  relationField: string;
};

function normalizedLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_APP_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const MAX_RETAINED_ATTACHMENT_BYTES = 250 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_FIELD = 20;
const ATTACHMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
  json: "application/json", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});
const SAFE_ATTACHMENT_MIMES = new Set(Object.values(ATTACHMENT_MIME_BY_EXTENSION));

function safeAttachmentIdentity(name: string, mime: string): { name: string; mime: string } {
  const base = name.replaceAll("\\", "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  if (!base || base.length > 120) throw new ClayError("E_VALIDATION", "file name must be 1 to 120 characters");
  const extension = base.includes(".") ? base.split(".").at(-1)!.toLocaleLowerCase() : "";
  const expected = ATTACHMENT_MIME_BY_EXTENSION[extension];
  if (!expected || !SAFE_ATTACHMENT_MIMES.has(mime || expected)
      || (mime && mime !== expected && !(extension === "jpg" && mime === "image/jpeg")))
    throw new ClayError("E_VALIDATION", "file type is not allowed");
  return { name: base, mime: mime || expected };
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function validateAttachmentSignature(bytes: Uint8Array, mime: string): void {
  const ascii = (value: string, offset = 0): boolean =>
    [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  let valid = true;
  if (mime === "image/png") valid = hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
  else if (mime === "image/jpeg") valid = hasPrefix(bytes, [255, 216, 255]);
  else if (mime === "image/gif") valid = ascii("GIF87a") || ascii("GIF89a");
  else if (mime === "image/webp") valid = ascii("RIFF") && ascii("WEBP", 8);
  else if (mime === "application/pdf") valid = ascii("%PDF");
  else if (mime.includes("openxmlformats")) valid = hasPrefix(bytes, [80, 75, 3, 4]);
  else if (mime === "application/msword" || mime === "application/vnd.ms-excel")
    valid = hasPrefix(bytes, [208, 207, 17, 224, 161, 177, 26, 225]);
  else if (mime === "application/json") {
    try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { valid = false; }
  }
  if (!valid) throw new ClayError("E_VALIDATION", "file content does not match its declared signature");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

const MAX_ARCHIVE_BYTES = 384 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ARCHIVE_FILES = new Set(["manifest.json", "user.db", "system.db"]);
const USER_IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/;
const STORAGE_TYPE: Record<string, string> = {
  text: "TEXT", number: "REAL", integer: "INTEGER", boolean: "INTEGER",
  date: "TEXT", enum: "TEXT", json: "TEXT", relation: "TEXT",
  rich_text: "TEXT", attachment: "TEXT",
};

function canonicalUserTableIssues(driver: DbDriver, table: RegTable, sql: string): string[] {
  const issues: string[] = [];
  if (/\b(CHECK|REFERENCES|FOREIGN\s+KEY|GENERATED|COLLATE|DEFAULT|WITHOUT\s+ROWID|STRICT)\b/i.test(sql))
    issues.push(`noncanonical constraint in table '${table.name}'`);
  const expected = [
    { name: "id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "deleted_at", type: "TEXT", notnull: 0, pk: 0 },
    ...table.columns.filter(column => !isVirtualColumn(column)).map(column => ({
      name: column.name, type: STORAGE_TYPE[column.type] ?? "", notnull: 0, pk: 0,
    })),
  ];
  const actual = driver.select(`PRAGMA main.table_xinfo(${qid(table.name)})`);
  if (actual.length !== expected.length) return [...issues, `noncanonical columns in table '${table.name}'`];
  for (let index = 0; index < expected.length; index++) {
    const want = expected[index]!;
    const got = actual[index]!;
    if (String(got.name) !== want.name || String(got.type).toUpperCase() !== want.type
        || Number(got.notnull) !== want.notnull || Number(got.pk) !== want.pk
        || got.dflt_value !== null || Number(got.hidden ?? 0) !== 0) {
      issues.push(`noncanonical column '${table.name}.${want.name}'`);
    }
  }
  return issues;
}

type CanonicalColumn = { name: string; type: string; notnull: number; pk: number };
const INTERNAL_TABLE_COLUMNS: Record<string, CanonicalColumn[]> = {
  row_history: [
    { name: "id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "table", type: "TEXT", notnull: 1, pk: 0 },
    { name: "row_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "before_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "after_json", type: "TEXT", notnull: 0, pk: 0 },
    { name: "batch_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "change_kind", type: "TEXT", notnull: 0, pk: 0 },
    { name: "sequence", type: "INTEGER", notnull: 0, pk: 0 },
  ],
  __clay_attachments: [
    { name: "id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "mime", type: "TEXT", notnull: 1, pk: 0 },
    { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "sha256", type: "TEXT", notnull: 1, pk: 0 },
    { name: "bytes", type: "BLOB", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "deleted_at", type: "TEXT", notnull: 0, pk: 0 },
  ],
};

function canonicalInternalTableIssues(
  driver: DbDriver, name: string, sql: string,
): string[] {
  const issues: string[] = [];
  if (/\b(CHECK|REFERENCES|FOREIGN\s+KEY|GENERATED|COLLATE|DEFAULT|WITHOUT\s+ROWID|STRICT)\b/i.test(sql))
    issues.push(`noncanonical constraint in internal table '${name}'`);
  const expected = INTERNAL_TABLE_COLUMNS[name];
  if (!expected) return [`unknown internal table '${name}'`];
  const actual = driver.select(`PRAGMA main.table_xinfo(${qid(name)})`);
  if (actual.length !== expected.length)
    return [...issues, `noncanonical columns in internal table '${name}'`];
  expected.forEach((want, index) => {
    const got = actual[index]!;
    if (String(got.name) !== want.name || String(got.type).toUpperCase() !== want.type
        || Number(got.notnull) !== want.notnull || Number(got.pk) !== want.pk
        || got.dflt_value !== null || Number(got.hidden ?? 0) !== 0)
      issues.push(`noncanonical internal column '${name}.${want.name}'`);
  });
  return issues;
}

function activeRegistryShape(registry: Registry): string {
  return JSON.stringify([...registry.values()]
    .filter(table => !table.inactive)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(table => {
      const { semantic: _semantic, inactive: _inactive, columns, ...rest } = table;
      return { ...rest, columns: columns.filter(column => !column.inactive).map(column => {
        const { semantic: _columnSemantic, inactive: _columnInactive, ...columnRest } = column;
        return columnRest;
      }) };
    }));
}

function rawArchiveSchemaIssues(driver: DbDriver, format: number): string[] {
  const issues: string[] = [];
  const seenTables = new Set<string>();
  const seenIndexes = new Set<string>();
  const registered = new Set<string>();
  const specs = new Map<string, RegTable>();
  for (const row of driver.select(`SELECT table_name, spec_json FROM sys.tables_registry`)) {
    const name = String(row.table_name);
    if (!USER_IDENTIFIER.test(name)) issues.push(`invalid registered table name '${name}'`);
    else {
      registered.add(name);
      try {
        const spec = JSON.parse(String(row.spec_json)) as RegTable;
        if (spec.name !== name || !Array.isArray(spec.columns)) throw new Error("bad registry spec");
        specs.set(name, spec);
      } catch { issues.push(`invalid registry definition '${name}'`); }
    }
  }
  const allowedTables = new Set([...registered, "row_history", "__clay_attachments"]);
  const allowedIndexes = new Map<string, {
    table?: string; column?: string; unique: number; tableId?: string; fieldId?: string;
    active?: boolean;
  }>([
    ["idx_row_history_batch", { table: "row_history", column: "batch_id", unique: 0 }],
    ["idx_row_history_sequence", { table: "row_history", column: "sequence", unique: 1 }],
  ]);
  const currentVersionRaw = driver.select(
    `SELECT value_json FROM sys.settings WHERE key = 'current_version'`)[0]?.value_json;
  if (format >= 4 && currentVersionRaw === undefined)
    issues.push("current_version is required in format 4 archives");
  let currentVersion = 0;
  try {
    const parsed = currentVersionRaw === undefined ? 0 : JSON.parse(String(currentVersionRaw));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("bad version cursor");
    currentVersion = parsed;
  } catch { issues.push("current_version is not a non-negative safe integer"); }
  const headVersion = Number(driver.select(
    `SELECT COALESCE(MAX(version), 0) AS version FROM sys.version_log`,
  )[0]?.version ?? 0);
  if (currentVersion > headVersion)
    issues.push(`current_version ${currentVersion} exceeds head version ${headVersion}`);
  if (format >= 4) {
    try {
      for (const [name, binding] of userIndexAuthorities(driver, specs))
        allowedIndexes.set(name, {
          unique: 0, tableId: binding.tableId, fieldId: binding.fieldId,
          active: binding.active,
        });
    } catch {
      issues.push("invalid semantic migration history while validating indexes");
    }
  } else {
    for (const row of driver.select(
      `SELECT migration_json FROM sys.version_log ORDER BY version`,
    )) {
      try {
        for (const operation of JSON.parse(String(row.migration_json ?? "[]")) as MigrationPlanT["operations"])
          if (operation.op === "add_index")
            allowedIndexes.set(`idx_${operation.table}_${operation.column}`,
              { table: operation.table, column: operation.column, unique: 0 });
      } catch { issues.push("invalid migration history while validating indexes"); }
    }
  }
  for (const row of driver.select(
    `SELECT type, name, tbl_name, sql FROM main.sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
  )) {
    const type = String(row.type);
    const name = String(row.name);
    const sql = String(row.sql ?? "");
    if (type === "table") {
      seenTables.add(name);
      if (!allowedTables.has(name)) issues.push(`unexpected table '${name}'`);
      if (!/^CREATE\s+TABLE\b/i.test(sql) || /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql))
        issues.push(`unsafe table definition '${name}'`);
      const spec = specs.get(name);
      if (spec) issues.push(...canonicalUserTableIssues(driver, spec, sql));
      else if (name === "row_history" || name === "__clay_attachments")
        issues.push(...canonicalInternalTableIssues(driver, name, sql));
    } else if (type === "index") {
      seenIndexes.add(name);
      const expected = allowedIndexes.get(name);
      if (!expected) issues.push(`unexpected index '${name}'`);
      else {
        const table = String(row.tbl_name);
        const columns = driver.select(`PRAGMA main.index_info(${qid(name)})`);
        const columnName = columns[0]?.name;
        let identityMatches = false;
        let expectedColumn = expected.column;
        if (expected.table !== undefined) {
          identityMatches = table === expected.table && columnName === expected.column;
        } else if (USER_IDENTIFIER.test(table) && typeof columnName === "string") {
          const spec = specs.get(table);
          const column = spec?.columns.find(candidate =>
            candidate.name === columnName && !isVirtualColumn(candidate));
          identityMatches = spec?.semantic?.tableId === expected.tableId
            && column?.semantic?.fieldId === expected.fieldId;
          expectedColumn = column?.name;
        }
        const metadata = USER_IDENTIFIER.test(table) || table === "row_history"
          ? driver.select(`PRAGMA main.index_list(${qid(table)})`)
            .find(candidate => String(candidate.name) === name)
          : undefined;
        const canonicalSql = expected.table === undefined
          ? typeof expectedColumn === "string"
            && sql === `CREATE INDEX "${name}" ON "${table}"("${expectedColumn}")`
          : expected.unique === 1
            ? /^CREATE\s+UNIQUE\s+INDEX\b/i.test(sql)
            : /^CREATE\s+INDEX\b/i.test(sql) && !/\bUNIQUE\b/i.test(sql);
        if (!identityMatches || columns.length !== 1
            || Number(metadata?.unique ?? -1) !== expected.unique
            || Number(metadata?.partial ?? -1) !== 0
            || String(metadata?.origin ?? "") !== "c" || !canonicalSql)
          issues.push(`noncanonical index '${name}'`);
      }
    } else {
      issues.push(`executable schema object '${type}:${name}' is not allowed`);
    }
  }
  if (format >= 4) {
    for (const name of ["row_history", "__clay_attachments"])
      if (!seenTables.has(name)) issues.push(`missing internal table '${name}'`);
    for (const [name, descriptor] of allowedIndexes)
      if ((descriptor.table !== undefined || descriptor.active) && !seenIndexes.has(name))
        issues.push(`missing active index '${name}'`);
  }
  return issues;
}

type FieldRename = { table: string; from: string; to: string };

const IMPORT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMPORT_SHA256 = /^sha256:[0-9a-f]{64}$/;
const INVALID_IMPORT_TOTALS = "import totals are invalid";
const UNBALANCED_IMPORT_TOTALS = "import totals do not balance";
const STALE_IMPORT_TARGET = "an import target changed after preview";

function boundedImportCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5_000)
    throw new ClayError("E_VALIDATION", INVALID_IMPORT_TOTALS);
  return value;
}

function exactImportRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ClayError("E_VALIDATION", INVALID_IMPORT_TOTALS);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key)))
    throw new ClayError("E_VALIDATION", INVALID_IMPORT_TOTALS);
  return record;
}

function validatedSourceTotals(value: unknown): SourceDispositionTotals {
  const keys = ["sourceRows", "createRows", "updateRows", "skipRows", "blockedRows", "skipReasons"] as const;
  const record = exactImportRecord(value, keys);
  const reasonKeys = ["above_header", "blank_row", "user_skipped", "duplicate_combined",
    "duplicate_skipped", "no_change", "unmapped_row"] as const;
  const reasons = exactImportRecord(record.skipReasons, reasonKeys);
  const skipReasons = Object.fromEntries(
    reasonKeys.map(key => [key, boundedImportCount(reasons[key])]),
  ) as SourceDispositionTotals["skipReasons"];
  const result: SourceDispositionTotals = {
    sourceRows: boundedImportCount(record.sourceRows),
    createRows: boundedImportCount(record.createRows),
    updateRows: boundedImportCount(record.updateRows),
    skipRows: boundedImportCount(record.skipRows),
    blockedRows: boundedImportCount(record.blockedRows),
    skipReasons,
  };
  if (result.sourceRows !== result.createRows + result.updateRows
      + result.skipRows + result.blockedRows
      || Object.values(result.skipReasons).reduce((sum, count) => sum + count, 0)
        !== result.skipRows)
    throw new ClayError("E_VALIDATION", UNBALANCED_IMPORT_TOTALS);
  return result;
}

function validatedMutationTotals(value: unknown): MutationTotals {
  const keys = ["primaryTargetCreates", "primaryTargetUpdates",
    "auxiliaryRelatedCreates", "changedCount"] as const;
  const record = exactImportRecord(value, keys);
  const result: MutationTotals = {
    primaryTargetCreates: boundedImportCount(record.primaryTargetCreates),
    primaryTargetUpdates: boundedImportCount(record.primaryTargetUpdates),
    auxiliaryRelatedCreates: boundedImportCount(record.auxiliaryRelatedCreates),
    changedCount: boundedImportCount(record.changedCount),
  };
  if (result.changedCount !== result.primaryTargetCreates
      + result.primaryTargetUpdates + result.auxiliaryRelatedCreates)
    throw new ClayError("E_VALIDATION", UNBALANCED_IMPORT_TOTALS);
  return result;
}

type CapturedAttachmentWriter = (
  input: AttachmentInput,
  sha256: string,
) => AttachmentMetadata;
const CAPTURED_ATTACHMENT_WRITERS = new WeakMap<object, CapturedAttachmentWriter>();

/** Source-private authority seam; intentionally absent from the package index. */
export function executeCapturedAttachmentAdd(
  store: ClayStore,
  input: AttachmentInput,
  sha256: string,
): AttachmentMetadata {
  const writer = CAPTURED_ATTACHMENT_WRITERS.get(store);
  if (!writer) throw new ClayError("E_INTERNAL", "attachment writer is unavailable");
  return writer(input, sha256);
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const PHYSICAL_ROLLBACK_REFRESH = new WeakMap<ClayStore, () => void>();
const AUTHORITY_ARCHIVE_READERS = new WeakMap<ClayStore, (name: string) => Promise<Uint8Array>>();

/** Worker-private read capability; no credential scrubbing or live writes. */
export function exportStoreArchiveReadOnly(store: ClayStore, name: string): Promise<Uint8Array> {
  const read = AUTHORITY_ARCHIVE_READERS.get(store);
  if (!read) throw new ClayError("E_VALIDATION", "archive read capability is unavailable");
  return read(name);
}

/** Source-private recovery hook; intentionally absent from the public index. */
export function refreshStoreAfterPhysicalRollback(store: ClayStore): void {
  const refresh = PHYSICAL_ROLLBACK_REFRESH.get(store);
  if (!refresh) throw new ClayError("E_INTERNAL", "store rollback recovery is unavailable");
  refresh();
}

export class ClayStore {
  readonly #driver: DbDriver;
  private reg: Registry = new Map();
  private batchContext: {
    id: string; source: BatchSource; pending: Map<string, string>;
  } | null = null;
  readonly #observer: Observer;
  readonly #privateMetrics: PrivateMetricsReducer;

  private constructor(driver: DbDriver) {
    this.#driver = driver;
    this.#observer = new Observer(driver);
    this.#privateMetrics = new PrivateMetricsReducer(new SqlitePrivateMetricDriver(driver));
    CAPTURED_ATTACHMENT_WRITERS.set(
      this,
      (input, digest) => this.#addCapturedAttachment(input, digest),
    );
    PHYSICAL_ROLLBACK_REFRESH.set(this, () => this.loadRegistry());
    AUTHORITY_ARCHIVE_READERS.set(this, name => this.#exportArchiveReadOnly(name));
  }

  static async openMemory(): Promise<ClayStore> {
    return ClayStore.fromDriver(await openMemoryDriver());
  }

  /** Bind a store to an already-open driver (browser worker, imports). */
  static fromDriver(
    driver: DbDriver,
    options: { requireSemanticRegistry?: boolean } = {},
  ): ClayStore {
    createSystemTables(driver);
    const ensureSystemColumns = (table: string, declarations: readonly string[]): void => {
      const existing = new Set(driver.select(`PRAGMA sys.table_info("${table}")`)
        .map(row => String(row.name)));
      for (const declaration of declarations) {
        const name = declaration.split(/\s+/, 1)[0]!;
        if (!existing.has(name)) driver.exec(`ALTER TABLE sys."${table}" ADD COLUMN ${declaration}`);
      }
    };
    ensureSystemColumns("record_events", [
      "row_json TEXT", "table_id TEXT", "schema_revision INTEGER", "snapshot_digest TEXT",
      "changed_field_ids_json TEXT",
    ]);
    ensureSystemColumns("automations", [
      "authority_target_json TEXT", "authority_definition_revision INTEGER",
      "authority_definition_digest TEXT", "cursor_target_json TEXT",
      "cursor_definition_revision INTEGER", "cursor_definition_digest TEXT",
      "last_schedule_period TEXT", "schedule_target_json TEXT",
      "schedule_definition_revision INTEGER", "schedule_definition_digest TEXT",
      "legacy_definition_json TEXT", "storage_version INTEGER NOT NULL DEFAULT 2",
    ]);
    ensureSystemColumns("automation_runs", [
      "target_json TEXT", "definition_revision INTEGER", "definition_digest TEXT",
      "trigger_kind TEXT",
    ]);
    ensureSystemColumns("automation_matches", [
      "target_json TEXT", "definition_revision INTEGER", "definition_digest TEXT",
      "snapshot_digest TEXT", "run_id TEXT", "baseline INTEGER NOT NULL DEFAULT 0",
    ]);
    ensureSystemColumns("automation_trigger_ledger", [
      "disposition TEXT NOT NULL DEFAULT 'success'",
    ]);
    ensureSystemColumns("operation_batches", [
      "automation_target_json TEXT", "automation_definition_revision INTEGER",
      "automation_definition_digest TEXT", "automation_run_id TEXT",
    ]);
    ensureSystemColumns("notifications", [
      "target_json TEXT", "definition_revision INTEGER", "definition_digest TEXT",
    ]);
    // G6: row-level undo lives in user.db so it travels with exports.
    driver.exec(`CREATE TABLE IF NOT EXISTS "row_history"(
      "id" TEXT PRIMARY KEY, "table" TEXT NOT NULL, "row_id" TEXT NOT NULL,
      "at" TEXT NOT NULL, "before_json" TEXT NOT NULL,
      "after_json" TEXT, "batch_id" TEXT, "change_kind" TEXT, "sequence" INTEGER)`);
    const historyColumns = new Set(driver.select(`PRAGMA main.table_info("row_history")`)
      .map(row => String(row.name)));
    if (!historyColumns.has("after_json"))
      driver.exec(`ALTER TABLE "row_history" ADD COLUMN "after_json" TEXT`);
    if (!historyColumns.has("batch_id"))
      driver.exec(`ALTER TABLE "row_history" ADD COLUMN "batch_id" TEXT`);
    if (!historyColumns.has("change_kind"))
      driver.exec(`ALTER TABLE "row_history" ADD COLUMN "change_kind" TEXT`);
    if (!historyColumns.has("sequence"))
      driver.exec(`ALTER TABLE "row_history" ADD COLUMN "sequence" INTEGER`);
    driver.exec(`UPDATE "row_history" SET "sequence" = rowid WHERE "sequence" IS NULL`);
    driver.exec(`CREATE INDEX IF NOT EXISTS "idx_row_history_batch" ON "row_history"("batch_id")`);
    driver.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_row_history_sequence"
      ON "row_history"("sequence")`);
    driver.exec(`CREATE TABLE IF NOT EXISTS "__clay_attachments"(
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "mime" TEXT NOT NULL,
      "size" INTEGER NOT NULL, "sha256" TEXT NOT NULL, "bytes" BLOB NOT NULL,
      "created_at" TEXT NOT NULL, "deleted_at" TEXT)`);
    const store = new ClayStore(driver);
    try {
      store.migrateLayoutScheme();
      store.loadRegistry();
      const current = store.currentVersion();
      const guard = driver.select(
        "SELECT value_json FROM sys.settings WHERE key = 'semantic_registry_v1'",
      )[0];
      if (options.requireSemanticRegistry || guard) {
        const semanticIssues = semanticRegistryIssues(
          store.reg, store.headVersion(), store.semanticOperationBounds(),
        );
        if (semanticIssues.length > 0)
          throw new ClayError("E_VALIDATION",
            `semantic registry failed integrity checks: ${semanticIssues.join("; ")}`,
            semanticIssues);
        if (!guard) driver.tx(() => {
          driver.exec(`INSERT OR REPLACE INTO sys.settings(key, value_json)
            VALUES ('semantic_registry_v1', 'true')`);
        });
      } else {
        driver.tx(() => {
          const prepared = store.prepareSemanticAssignments(null, "legacy_backfill");
          if (store.ensureSemanticMetadata(prepared.version, "legacy_backfill", prepared))
            store.persistRegistry(current);
          driver.exec(`INSERT OR REPLACE INTO sys.settings(key, value_json)
            VALUES ('semantic_registry_v1', 'true')`);
        });
      }
      return store;
    } catch (error) {
      driver.close();
      throw error;
    }
  }

  /**
   * ADR-018: the main region went from a 2-column to a 4-column grid, so a
   * stored width means a different fraction. Remap every panel blob's width
   * ONCE (old half w:1 -> w:2, old full w:2 -> w:4) so existing layouts keep
   * their proportions. Guarded by a settings flag; new apps skip it.
   */
  private migrateLayoutScheme(): void {
    const done = this.#driver.select(
      "SELECT value_json FROM sys.settings WHERE key = 'layout_scheme'")[0];
    if (done && String(done.value_json) === "2") return;
    const rows = this.#driver.select(
      "SELECT version, panel_id, placement_json FROM sys.panel_blobs");
    for (const r of rows) {
      let pl: { w?: number } & Record<string, unknown>;
      try { pl = JSON.parse(String(r.placement_json)); } catch { continue; }
      const remap = pl.w === 1 ? 2 : pl.w === 2 ? 4 : undefined;
      if (remap === undefined) continue;
      pl.w = remap;
      this.#driver.exec(
        "UPDATE sys.panel_blobs SET placement_json = ? WHERE version = ? AND panel_id = ?",
        [JSON.stringify(pl), Number(r.version), String(r.panel_id)]);
    }
    this.#driver.exec(
      "INSERT OR REPLACE INTO sys.settings(key, value_json) VALUES ('layout_scheme', '2')");
  }

  /** G6 ring cap; public so tests can lower it. */
  rowHistoryCap = 10_000;

  close(): void {
    PHYSICAL_ROLLBACK_REFRESH.delete(this);
    AUTHORITY_ARCHIVE_READERS.delete(this);
    this.#driver.close();
  }

  // ---------- registry ----------
  private loadRegistry(): void {
    this.reg = new Map();
    for (const row of this.#driver.select("SELECT spec_json FROM sys.tables_registry")) {
      const spec = JSON.parse(String(row.spec_json)) as RegTable;
      this.reg.set(spec.name, spec);
    }
  }

  private ensureSemanticMetadata(
    version: number,
    origin: SemanticOrigin,
    prepared?: PreparedSemanticAssignmentsV1,
  ): boolean {
    if (prepared) {
      if (prepared.origin !== origin || prepared.version !== version)
        throw new ClayError("E_VALIDATION", "semantic assignment does not match this commit");
      let changed = false;
      for (const table of this.reg.values()) {
        const tableSemantic = prepared.tableSemantics.get(table.name);
        if (!tableSemantic)
          throw new ClayError("E_VALIDATION", `semantic assignment is missing table '${table.name}'`);
        table.semantic = cloneTableSemantic(tableSemantic);
        for (const column of table.columns) {
          const fieldSemantic = prepared.fieldSemantics.get(`${table.name}\u0000${column.name}`);
          if (!fieldSemantic)
            throw new ClayError("E_VALIDATION",
              `semantic assignment is missing field '${table.name}.${column.name}'`);
          column.semantic = cloneFieldSemantic(fieldSemantic);
        }
        changed = true;
      }
      return changed;
    }

    // Legacy-only fallback. New commits prepare exact operation bindings before
    // either shadow or live execution; this path upgrades pre-semantic stores.
    let changed = false;
    for (const table of this.reg.values()) {
      if (!table.semantic) {
        table.semantic = {
          v: 1, tableId: createTableId(), label: table.name, aliases: [],
          origin: "legacy_backfill",
          events: [{ v: 1, version, operationIndex: 0,
            disposition: "legacy_unknown", origin: "legacy_backfill" }],
          relationships: [],
        };
        changed = true;
      }
      table.columns.forEach((column, columnIndex) => {
        if (!column.semantic) {
          column.semantic = {
            v: 1, fieldId: createFieldId(), label: column.name, aliases: [],
            origin: "legacy_backfill",
            events: [{ v: 1, version, operationIndex: 0, columnIndex,
              disposition: "legacy_unknown", origin: "legacy_backfill" }],
          };
          changed = true;
        }
        const fieldId = column.semantic.fieldId;
        if (!table.semantic!.relationships.some(relationship =>
          relationship.kind === "contains" && relationship.toFieldId === fieldId)) {
          table.semantic!.relationships.push({
            v: 1, kind: "contains", relationshipId: createRelationshipId(),
            origin: "legacy_backfill", fromTableId: table.semantic!.tableId,
            toFieldId: fieldId, baselineActive: !column.inactive,
            events: [{ v: 1, version, operationIndex: 0, columnIndex,
              action: "activate" }],
          });
          changed = true;
        }
      });
    }
    return changed;
  }

  prepareSemanticAssignments(
    migration: MigrationPlanT | null,
    origin: SemanticOrigin,
  ): PreparedSemanticAssignmentsV1 {
    if (migration) validateMigrationPlan(migration, this.reg);
    const version = origin === "legacy_backfill" && migration === null
      ? 0 : PRODUCTION_STORE_PRIMITIVES.headVersion.call(this) + 1;
    const sim = cloneRegistry(this.reg);
    const ref = (operationIndex: number, columnIndex?: number) => ({
      version, operationIndex, ...(columnIndex === undefined ? {} : { columnIndex }),
    });
    const fieldKey = (table: string, field: string): string => `${table}\u0000${field}`;
    const relationKey = (kind: string, from: string, to: string): string =>
      `${kind}\u0000${from}\u0000${to}`;
    const addAlias = (aliases: string[], label: string): void => {
      if (!aliases.includes(label)) aliases.push(label);
      if (aliases.length > 64) aliases.splice(0, aliases.length - 64);
    };
    const columnFrom = (column: {
      name: string; label?: string; type: RegColumn["type"]; required?: boolean;
      values?: string[]; expr?: string;
      relation?: RegColumn["relation"];
      lookup?: RegColumn["lookup"];
      rollup?: RegColumn["rollup"];
    }): RegColumn => ({
      name: column.name, label: column.label, type: column.type,
      required: column.required ?? false,
      ...(column.values ? { values: [...column.values] } : {}),
      ...(column.expr !== undefined ? { expr: column.expr } : {}),
      ...(column.relation ? { relation: { ...column.relation } } : {}),
      ...(column.lookup ? { lookup: { ...column.lookup } } : {}),
      ...(column.rollup ? { rollup: { ...column.rollup } } : {}),
    });
    const newTableSemantic = (
      name: string, operationIndex: number,
      disposition: SemanticIdentityEventV1["disposition"],
    ): TableSemanticV1 => ({
      v: 1, tableId: createTableId(), label: name, aliases: [], origin,
      events: [{ v: 1, ...ref(operationIndex), disposition, origin }],
      relationships: [],
    });
    const newFieldSemantic = (
      name: string, operationIndex: number,
      disposition: SemanticIdentityEventV1["disposition"],
      columnIndex?: number,
    ): FieldSemanticV1 => ({
      v: 1, fieldId: createFieldId(), label: name, aliases: [], origin,
      events: [{ v: 1, ...ref(operationIndex, columnIndex), disposition, origin }],
    });
    const pushFieldEvent = (
      column: RegColumn, operationIndex: number,
      disposition: SemanticIdentityEventV1["disposition"] = "modify",
      columnIndex?: number,
    ): void => {
      column.semantic!.events.push({
        v: 1, ...ref(operationIndex, columnIndex), disposition, origin,
      });
    };
    const lastAction = (relationship: SemanticRelationshipRecordV1): "activate" | "retire" | null =>
      relationship.events.at(-1)?.action ?? (relationship.baselineActive ? "activate" : null);
    const activateContains = (
      table: RegTable, column: RegColumn, operationIndex: number,
      columnIndex?: number, force = false,
    ): void => {
      const semantic = table.semantic!;
      const fieldId = column.semantic!.fieldId;
      let relationship = semantic.relationships.find(candidate =>
        candidate.kind === "contains" && candidate.toFieldId === fieldId);
      if (!relationship) {
        relationship = {
          v: 1, kind: "contains", relationshipId: createRelationshipId(), origin,
          fromTableId: semantic.tableId, toFieldId: fieldId,
          events: [{ v: 1, ...ref(operationIndex, columnIndex), action: "activate" }],
        };
        semantic.relationships.push(relationship);
      } else if (force || lastAction(relationship) !== "activate") {
        relationship.events.push({
          v: 1, ...ref(operationIndex, columnIndex), action: "activate",
        });
      }
    };
    const syncDerived = (
      table: RegTable, computed: RegColumn, expression: string,
      operationIndex: number, force = false,
    ): void => {
      const fromFieldId = computed.semantic!.fieldId;
      const desired = new Set([...exprFields(parseExpr(expression))].map(name =>
        table.columns.find(column => column.name === name)?.semantic?.fieldId
      ).filter((id): id is FieldId => id !== undefined));
      const existing = table.semantic!.relationships.filter(
        (relationship): relationship is Extract<SemanticRelationshipRecordV1,
          { kind: "derived_from" }> =>
          relationship.kind === "derived_from" && relationship.fromFieldId === fromFieldId,
      );
      for (const relationship of existing) {
        if (!desired.has(relationship.toFieldId) && lastAction(relationship) !== "retire") {
          relationship.events.push({ v: 1, ...ref(operationIndex), action: "retire" });
        }
      }
      for (const toFieldId of desired) {
        let relationship = existing.find(candidate => candidate.toFieldId === toFieldId);
        if (!relationship) {
          relationship = {
            v: 1, kind: "derived_from", relationshipId: createRelationshipId(), origin,
            fromFieldId, toFieldId,
            events: [{ v: 1, ...ref(operationIndex), action: "activate" }],
          };
          table.semantic!.relationships.push(relationship);
        } else if (force || lastAction(relationship) !== "activate") {
          relationship.events.push({ v: 1, ...ref(operationIndex), action: "activate" });
        }
      }
    };

    const syncReference = (
      table: RegTable, column: RegColumn, operationIndex: number, force = false,
    ): void => {
      if (column.type !== "relation" || !column.relation) return;
      const target = getTable(sim, column.relation.target_table);
      const viaFieldId = column.semantic!.fieldId;
      const desiredCardinality = column.relation.cardinality === "many"
        ? (column.relation.unique_targets ? "one_to_many" : "many_to_many")
        : (column.relation.unique_targets ? "one_to_one" : "many_to_one");
      const existing = table.semantic!.relationships.filter(
        (relationship): relationship is Extract<SemanticRelationshipRecordV1,
          { kind: "references" }> =>
          relationship.kind === "references" && relationship.viaFieldId === viaFieldId,
      );
      for (const relationship of existing) {
        if (relationship.toTableId !== target.semantic!.tableId
            && lastAction(relationship) !== "retire")
          relationship.events.push({ v: 1, ...ref(operationIndex), action: "retire" });
      }
      let relationship = existing.find(candidate =>
        candidate.toTableId === target.semantic!.tableId);
      if (!relationship) {
        relationship = {
          v: 1, kind: "references", relationshipId: createRelationshipId(), origin,
          fromTableId: table.semantic!.tableId, toTableId: target.semantic!.tableId,
          viaFieldId, cardinality: desiredCardinality,
          integrity: "semantic_only", reviewed: true,
          events: [{ v: 1, ...ref(operationIndex), action: "activate" }],
        };
        table.semantic!.relationships.push(relationship);
      } else {
        relationship.cardinality = desiredCardinality;
        if (force || lastAction(relationship) !== "activate")
          relationship.events.push({ v: 1, ...ref(operationIndex), action: "activate" });
      }
    };

    // A store created before semantic metadata is upgraded without pretending
    // that its true introduction coordinates are known.
    for (const table of sim.values()) {
      if (!table.semantic) {
        table.semantic = {
          v: 1, tableId: createTableId(), label: table.name, aliases: [],
          origin: "legacy_backfill",
          events: [{ v: 1, version, operationIndex: 0,
            disposition: "legacy_unknown", origin: "legacy_backfill" }],
          relationships: [],
        };
      }
      table.columns.forEach((column, columnIndex) => {
        if (!column.semantic) column.semantic = {
          v: 1, fieldId: createFieldId(), label: column.name, aliases: [],
          origin: "legacy_backfill",
          events: [{ v: 1, version, operationIndex: 0,
            columnIndex, disposition: "legacy_unknown", origin: "legacy_backfill" }],
        };
        if (!table.inactive && !column.inactive)
          activateContains(table, column, 0, columnIndex);
      });
      for (const column of table.columns) {
        if (!table.inactive && !column.inactive && column.type === "computed" && column.expr)
          syncDerived(table, column, column.expr, 0);
      }
    }
    for (const table of sim.values()) {
      for (const column of table.columns)
        if (!table.inactive && !column.inactive) syncReference(table, column, 0);
    }

    for (const [operationIndex, op] of (migration?.operations ?? []).entries()) {
      switch (op.op) {
        case "create_table": {
          const preserved = sim.get(op.table);
          let table: RegTable;
          const reactivated = preserved?.inactive === true;
          if (reactivated) {
            table = preserved;
            delete table.inactive;
            table.semantic!.events.push({
              v: 1, ...ref(operationIndex), disposition: "reactivate", origin,
            });
            for (const column of table.columns) column.inactive = true;
          } else {
            table = { name: op.table, columns: [],
              semantic: newTableSemantic(op.table, operationIndex, "introduce") };
            sim.set(op.table, table);
          }
          op.columns.forEach((spec, columnIndex) => {
            let column = table.columns.find(candidate => candidate.name === spec.name);
            const disposition = column?.inactive ? "reactivate" as const : "introduce" as const;
            if (column) {
              delete column.inactive;
              pushFieldEvent(column, operationIndex, disposition, columnIndex);
            } else {
              column = columnFrom(spec as Parameters<typeof columnFrom>[0]);
              column.semantic = newFieldSemantic(spec.name, operationIndex, disposition, columnIndex);
              table.columns.push(column);
            }
            activateContains(table, column, operationIndex, columnIndex, disposition === "reactivate");
            syncReference(table, column, operationIndex, disposition === "reactivate");
          });
          for (const spec of op.columns) {
            const column = table.columns.find(candidate => candidate.name === spec.name)!;
            if (column.type === "computed" && column.expr)
              syncDerived(table, column, column.expr, operationIndex, reactivated);
          }
          break;
        }
        case "add_column": {
          const table = getTable(sim, op.table);
          let column = findStoredColumn(table, op.column.name);
          const disposition = column?.inactive ? "reactivate" as const : "introduce" as const;
          if (column) {
            delete column.inactive;
            pushFieldEvent(column, operationIndex, disposition);
          } else {
            column = columnFrom(op.column as Parameters<typeof columnFrom>[0]);
            column.semantic = newFieldSemantic(column.name, operationIndex, disposition);
            table.columns.push(column);
          }
          activateContains(table, column, operationIndex, undefined, disposition === "reactivate");
          syncReference(table, column, operationIndex, disposition === "reactivate");
          if (column.type === "computed" && column.expr)
            syncDerived(table, column, column.expr, operationIndex, disposition === "reactivate");
          break;
        }
        case "create_computed": {
          const table = getTable(sim, op.table);
          let column = findStoredColumn(table, op.column);
          const disposition = column?.inactive ? "reactivate" as const : "introduce" as const;
          if (column) {
            delete column.inactive;
            pushFieldEvent(column, operationIndex, disposition);
          } else {
            column = { name: op.column, type: "computed", required: false, expr: op.expr,
              semantic: newFieldSemantic(op.column, operationIndex, disposition) };
            table.columns.push(column);
          }
          activateContains(table, column, operationIndex, undefined, disposition === "reactivate");
          syncDerived(table, column, op.expr, operationIndex, disposition === "reactivate");
          break;
        }
        case "rename_column": {
          const table = getTable(sim, op.table);
          const column = table.columns.find(candidate => candidate.name === op.from)!;
          pushFieldEvent(column, operationIndex);
          addAlias(column.semantic!.aliases, column.semantic!.label);
          column.name = op.to;
          column.semantic!.label = op.to;
          break;
        }
        case "update_computed": {
          const table = getTable(sim, op.table);
          const column = table.columns.find(candidate => candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex);
          column.expr = op.expr;
          syncDerived(table, column, op.expr, operationIndex);
          break;
        }
        case "add_enum_value": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex);
          column.values = [...(column.values ?? []), op.value];
          break;
        }
        case "hide_column": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex); column.hidden = true;
          break;
        }
        case "set_required": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex); column.required = true;
          break;
        }
        case "add_index":
        case "backfill": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex);
          break;
        }
      }
    }

    const tables = new Map<string, TableId>();
    const fields = new Map<string, FieldId>();
    const relationships = new Map<string, ReturnType<typeof createRelationshipId>>();
    const tableSemantics = new Map<string, TableSemanticV1>();
    const fieldSemantics = new Map<string, FieldSemanticV1>();
    for (const table of sim.values()) {
      const semantic = table.semantic!;
      tables.set(table.name, semantic.tableId);
      tableSemantics.set(table.name, cloneTableSemantic(semantic));
      for (const column of table.columns) {
        fields.set(fieldKey(table.name, column.name), column.semantic!.fieldId);
        fieldSemantics.set(fieldKey(table.name, column.name),
          cloneFieldSemantic(column.semantic!));
      }
      for (const relationship of semantic.relationships) {
        const from = relationship.kind === "derived_from"
          ? relationship.fromFieldId : relationship.fromTableId;
        const to = relationship.kind === "contains"
          ? relationship.toFieldId
          : relationship.kind === "derived_from" ? relationship.toFieldId : relationship.toTableId;
        const via = relationship.kind === "references"
          ? `\u0000${relationship.viaFieldId}` : "";
        relationships.set(
          `${relationKey(relationship.kind, from, to)}${via}`,
          relationship.relationshipId,
        );
      }
    }
    return {
      v: 1, version, origin, tables, fields, relationships,
      tableSemantics, fieldSemantics,
    };
  }

  private pruneSemanticAfter(version: number): void {
    for (const table of this.reg.values()) {
      if (!table.semantic) continue;
      table.semantic.events = table.semantic.events.filter(event => event.version <= version);
      for (const relationship of table.semantic.relationships)
        relationship.events = relationship.events.filter(event => event.version <= version);
      for (const column of table.columns) {
        if (column.semantic)
          column.semantic.events = column.semantic.events.filter(event => event.version <= version);
      }
    }
  }

  private alignSemanticLabelsToPhysicalShape(): void {
    for (const table of this.reg.values()) {
      if (table.semantic && table.semantic.label !== table.name) {
        if (!table.semantic.aliases.includes(table.semantic.label))
          table.semantic.aliases.push(table.semantic.label);
        table.semantic.label = table.name;
      }
      for (const column of table.columns) {
        if (!column.semantic || column.semantic.label === column.name) continue;
        if (!column.semantic.aliases.includes(column.semantic.label))
          column.semantic.aliases.push(column.semantic.label);
        column.semantic.label = column.name;
      }
    }
  }

  private persistRegistry(version: number): void {
    this.#driver.exec("DELETE FROM sys.tables_registry");
    for (const t of this.reg.values()) {
      this.#driver.exec(
        `INSERT INTO sys.tables_registry(table_name, version, spec_json, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [t.name, version, JSON.stringify(t), "kernel", nowIso()]);
    }
  }

  registrySnapshot(): Registry {
    return cloneActiveRegistry(this.reg);
  }

  /** Validator view includes inactive tombstones so a new plan cannot
   * collide with preserved physical data. Query resolution still treats
   * those tables and columns as unknown. */
  validationRegistrySnapshot(): Registry {
    return cloneRegistry(this.reg);
  }

  semanticSchemaTrace(): SemanticSchemaTraceV1 {
    const atVersion = this.currentVersion();
    this.ensureSemanticMetadata(atVersion, "legacy_backfill");
    const tables: Array<SemanticSchemaTraceV1["tables"][number]> = [];
    const fields: Array<SemanticSchemaTraceV1["fields"][number]> = [];
    const relationships: Array<SemanticSchemaTraceV1["relationships"][number]> = [];
    const opBindings: Array<SemanticSchemaTraceV1["opBindings"][number]> = [];
    for (const table of this.reg.values()) {
      const semantic = table.semantic!;
      tables.push({ tableId: semantic.tableId, conceptId: semantic.conceptId,
        name: table.name, label: semantic.label, aliases: [...semantic.aliases],
        state: table.inactive ? "inactive" : "visible" });
      semantic.events.filter(event => event.version <= atVersion)
        .forEach(event => opBindings.push({ ref: event,
        tableId: semantic.tableId, disposition: event.disposition, origin: event.origin }));
      for (const column of table.columns) {
        const field = column.semantic!;
        fields.push({ tableId: semantic.tableId, fieldId: field.fieldId,
          conceptId: field.conceptId, tableName: table.name, fieldName: column.name,
          label: field.label, aliases: [...field.aliases],
          state: table.inactive || column.inactive
            ? "inactive" : column.hidden ? "hidden" : "visible" });
        field.events.filter(event => event.version <= atVersion)
          .forEach(event => opBindings.push({ ref: event,
          tableId: semantic.tableId, fieldId: field.fieldId,
          disposition: event.disposition, origin: event.origin }));
      }
      for (const rel of semantic.relationships) {
        const target = rel.kind === "contains"
          ? table.columns.find(column => column.semantic?.fieldId === rel.toFieldId) : undefined;
        const fromField = rel.kind === "derived_from"
          ? table.columns.find(column => column.semantic?.fieldId === rel.fromFieldId)
          : rel.kind === "references"
            ? table.columns.find(column => column.semantic?.fieldId === rel.viaFieldId)
            : undefined;
        const toField = rel.kind === "derived_from"
          ? table.columns.find(column => column.semantic?.fieldId === rel.toFieldId) : undefined;
        const lifecycle = [...rel.events]
          .filter(event => event.version <= atVersion)
          .sort((left, right) => left.version - right.version
            || left.operationIndex - right.operationIndex
            || (left.columnIndex ?? -1) - (right.columnIndex ?? -1))
          .at(-1)?.action ?? (rel.baselineActive ? "activate" : "retire");
        const endpointInactive = target?.inactive || fromField?.inactive || toField?.inactive;
        const endpointHidden = target?.hidden || fromField?.hidden || toField?.hidden;
        relationships.push({ relationshipId: rel.relationshipId, kind: rel.kind,
          state: lifecycle === "retire" ? "retired"
            : table.inactive || endpointInactive ? "inactive"
              : endpointHidden ? "hidden" : "active",
          from: rel.kind === "derived_from" ? rel.fromFieldId : rel.fromTableId,
          to: rel.kind === "contains" ? rel.toFieldId
            : rel.kind === "derived_from" ? rel.toFieldId : rel.toTableId,
          ...(rel.kind === "references" ? { via: rel.viaFieldId } : {}),
        });
      }
    }
    return { v: 1, atVersion,
      tables: [...tables].sort((a, b) => a.name.localeCompare(b.name)),
      fields: [...fields].sort((a, b) => a.tableName.localeCompare(b.tableName)
        || a.fieldName.localeCompare(b.fieldName)),
      relationships: [...relationships], opBindings: [...opBindings] };
  }

  fieldProvenance(): FieldProvenance[] {
    this.ensureSemanticMetadata(this.currentVersion(), "legacy_backfill");
    const out: FieldProvenance[] = [];
    for (const table of this.reg.values()) {
      const tableId = table.semantic!.tableId;
      for (const column of table.columns) {
        const semantic = column.semantic!;
        const events = [...semantic.events].sort((a, b) =>
          a.version - b.version || a.operationIndex - b.operationIndex
          || (a.columnIndex ?? -1) - (b.columnIndex ?? -1));
        let derivation: FieldProvenance["derivation"];
        if (column.type === "computed" && column.expr) {
          const dependencies = [...exprFields(parseExpr(column.expr))]
            .map(name => table.columns.find(candidate => candidate.name === name)?.semantic?.fieldId)
            .filter((id): id is FieldId => id !== undefined);
          derivation = { expression: column.expr, dependencyFieldIds: dependencies };
        }
        out.push({ tableId, fieldId: semantic.fieldId,
          tableName: table.name, fieldName: column.name, fieldType: column.type,
          aliases: [...semantic.aliases], origin: semantic.origin,
          state: table.inactive || column.inactive
            ? "inactive" : column.hidden ? "hidden" : "visible",
          createdVersion: events[0]?.version ?? 0,
          lastChangedVersion: events.at(-1)?.version ?? 0,
          ...(derivation ? { derivation } : {}),
        });
      }
    }
    return out.sort((a, b) => a.tableName.localeCompare(b.tableName)
      || a.fieldName.localeCompare(b.fieldName));
  }

  recordPrivateMetric(event: PrivateMetricEvent): void {
    this.#privateMetrics.record(event);
  }

  privateMetricsSummary(): PrivateMetricsSummary {
    return this.#privateMetrics.summary();
  }

  setPrivateMetricsEnabled(enabled: boolean): void {
    this.#privateMetrics.setCollectionEnabled(enabled);
  }

  clearPrivateMetrics(): void { this.#privateMetrics.clear(); }

  // ---------- versions ----------
  headVersion(): number {
    const rows = this.#driver.select("SELECT MAX(version) AS v FROM sys.version_log");
    return Number(rows[0]?.v ?? 0);
  }

  currentVersion(): number {
    const v = PRODUCTION_STORE_PRIMITIVES.getSetting.call(
      this, "current_version",
    ) as number | undefined;
    return v === undefined ? PRODUCTION_STORE_PRIMITIVES.headVersion.call(this) : v;
  }

  private setCurrentVersion(v: number): void {
    PRODUCTION_STORE_PRIMITIVES.setSetting.call(this, "current_version", v);
  }

  // ---------- settings (doc 04 §3: mode, byo key, sample markers, …) ----------
  getSetting<T>(key: string): T | undefined {
    const rows = this.#driver.select(
      "SELECT value_json FROM sys.settings WHERE key = ?", [key]);
    const raw = rows[0]?.value_json;
    return raw === undefined ? undefined : JSON.parse(String(raw)) as T;
  }

  setSetting(key: string, value: unknown): void {
    this.#driver.exec(
      `INSERT INTO sys.settings(key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [key, JSON.stringify(value)]);
  }

  deleteSetting(key: string): void {
    this.#driver.exec("DELETE FROM sys.settings WHERE key = ?", [key]);
  }

  sampleRowProvenance(): SampleRowProvenanceEntry[] {
    return this.#sampleRowProvenance();
  }

  #sampleRowProvenance(): SampleRowProvenanceEntry[] {
    const rows = this.#driver.select(
      "SELECT value_json FROM sys.settings WHERE key = 'sample_provenance_v1'",
    );
    if (rows.length === 0) return [];
    if (rows.length !== 1 || typeof rows[0]!.value_json !== "string")
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger is invalid");
    let parsed: unknown;
    try { parsed = JSON.parse(rows[0]!.value_json); }
    catch { throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger is invalid"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger is invalid");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.schema !== 1 || !Array.isArray(record.entries)
        || record.entries.length > 100_000)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger is invalid");
    const result: SampleRowProvenanceEntry[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < record.entries.length; index++) {
      const raw = record.entries[index];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger is invalid");
      const entry = raw as Record<string, unknown>;
      if (Object.keys(entry).length !== 3 || !isTableId(entry.tableId)
          || !isUuidV7(entry.rowId)
          || typeof entry.operationId !== "string" || !/^op_[a-z2-7]{26}$/.test(entry.operationId))
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger is invalid");
      const coordinate = `${entry.tableId}\u0000${entry.rowId}`;
      if (seen.has(coordinate))
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger is duplicated");
      seen.add(coordinate);
      result.push(Object.freeze({
        tableId: entry.tableId,
        rowId: entry.rowId,
        operationId: entry.operationId,
      }));
    }
    return result;
  }

  sampleRowProvenanceState(entry: SampleRowProvenanceEntry): SampleRowProvenanceState {
    return this.#sampleRowProvenanceState(entry);
  }

  #sampleRowProvenanceState(entry: SampleRowProvenanceEntry): SampleRowProvenanceState {
    const matches = [...this.reg.values()].filter(table =>
      table.semantic?.tableId === entry.tableId);
    if (matches.length !== 1)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance table identity is unavailable");
    const table = matches[0]!;
    const rows = this.#driver.select(
      `SELECT deleted_at FROM ${qid(table.name)} WHERE id = ?`, [entry.rowId],
    );
    if (rows.length !== 1)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance references a missing row");
    return Object.freeze({
      ...entry,
      tableName: table.name,
      tableActive: !table.inactive,
      rowState: rows[0]!.deleted_at == null ? "active" : "deleted",
    });
  }

  recordSampleRowProvenance(entries: readonly SampleRowProvenanceEntry[]): void {
    const existing = this.#sampleRowProvenance();
    if (existing.length + entries.length > 100_000)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance ledger exceeds its limit");
    const coordinates = new Set(existing.map(entry => `${entry.tableId}\u0000${entry.rowId}`));
    const additions: SampleRowProvenanceEntry[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (!isTableId(entry.tableId) || !isUuidV7(entry.rowId)
          || !/^op_[a-z2-7]{26}$/.test(entry.operationId))
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance entry is invalid");
      const coordinate = `${entry.tableId}\u0000${entry.rowId}`;
      if (coordinates.has(coordinate))
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample provenance entry is duplicated");
      coordinates.add(coordinate);
      const state = this.#sampleRowProvenanceState(entry);
      if (!state.tableActive || state.rowState !== "active")
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "new sample provenance must reference an active row");
      additions.push(Object.freeze({ ...entry }));
    }
    if (additions.length === 0) return;
    const merged = [...existing, ...additions].sort((left, right) =>
      left.tableId < right.tableId ? -1
        : left.tableId > right.tableId ? 1
          : left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0);
    this.#driver.exec(
      `INSERT INTO sys.settings(key, value_json) VALUES ('sample_provenance_v1', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [JSON.stringify({ schema: 1, entries: merged })],
    );
  }

  scrubLegacyCredentialSettings(): void {
    this.#driver.tx(() => {
      for (const key of LEGACY_CREDENTIAL_SETTING_KEYS) this.deleteSetting(key);
    });
  }

  getEntry(version: number): VersionEntry {
    const rows = this.#driver.select(
      "SELECT * FROM sys.version_log WHERE version = ?", [version]);
    const r = rows[0];
    if (!r) throw new ClayError("E_VALIDATION", `no version ${version}`);
    const migration = r.migration_json === null
      ? null
      : {
          operations: JSON.parse(String(r.migration_json)) as MigrationPlanT["operations"],
          inverse: JSON.parse(String(r.inverse_json)) as MigrationPlanT["inverse"],
        };
    return {
      version: Number(r.version), parent: Number(r.parent),
      created_at: String(r.created_at), intent_text: String(r.intent_text),
      summary: String(r.summary), migration,
    };
  }

  private semanticOperationBounds(): SemanticOperationBounds {
    const bounds = new Map<number, readonly (number | null)[]>();
    for (const row of this.#driver.select(
      "SELECT version, migration_json FROM sys.version_log WHERE migration_json IS NOT NULL",
    )) {
      let operations: MigrationPlanT["operations"];
      try {
        operations = JSON.parse(String(row.migration_json)) as MigrationPlanT["operations"];
      } catch {
        bounds.set(Number(row.version), []);
        continue;
      }
      bounds.set(Number(row.version), operations.map(operation =>
        operation.op === "create_table" ? operation.columns.length : null));
    }
    return bounds;
  }

  /** Commit a mutation: validate, migrate, write panel blobs/tombstones,
   * persist registry, append log — one transaction (doc 04 §4). */
  commit(input: CommitInput): number {
    const head = PRODUCTION_STORE_PRIMITIVES.headVersion.call(this);
    if (PRODUCTION_STORE_PRIMITIVES.currentVersion.call(this) !== head)
      throw new ClayError("E_VALIDATION",
        "store is rolled back (scrub preview); roll forward or truncate first");
    const semanticOrigin = input.semanticOrigin ?? "system";
    const semanticAssignments = input.semanticAssignments
      ?? PRODUCTION_STORE_PRIMITIVES.prepareSemanticAssignments.call(
        this, input.migration, semanticOrigin,
      );
    try {
      return this.#driver.tx(() => {
        // capture the pre-commit manifest for the G16 rename rewrite
        const preLive = PRODUCTION_STORE_PRIMITIVES.livePanels.call(this);
        const untouched = preLive.filter(p =>
          !(input.panels ?? []).some(np => np.panel_id === p.panel_id)
          && !(input.removePanels ?? []).includes(p.panel_id));
        // Layout size (ADR-017/018) is a direct-manipulation concern; a model
        // reshape re-emits placement WITHOUT w/h, so preserve the panel's
        // existing span AND height unless the plan explicitly sets one.
        const priorSize = new Map(preLive.map(p =>
          [p.panel_id, { w: p.placement.w, h: p.placement.h, col: p.placement.col }]));

        const version = head + 1;
        const fieldRenames: FieldRename[] = input.panelFieldReplacements
          ?? (input.migration?.operations ?? []).flatMap(operation =>
            operation.op === "rename_column"
              ? [{ table: operation.table, from: operation.from, to: operation.to }] : []);
        if (input.migration) {
          validateMigrationPlan(input.migration, this.reg);
          applyForwardOps(this.#driver, this.reg, input.migration.operations);
        }
        this.assertAutomationsCompatible();
        this.assertRelationIntegrity();
        this.ensureSemanticMetadata(
          version,
          semanticOrigin,
          semanticAssignments,
        );
        this.persistRegistry(version);
        this.#driver.exec(
          `INSERT INTO sys.version_log(version, parent, created_at, intent_text,
             summary, diff_json, migration_json, inverse_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [version, head, nowIso(), input.intent, input.summary,
           JSON.stringify(input.diff ?? []),
           input.migration ? JSON.stringify(input.migration.operations) : null,
           input.migration ? JSON.stringify(input.migration.inverse) : null]);

        for (const p of input.panels ?? []) {
          const prior = priorSize.get(p.panel_id);
          const w = p.placement.w ?? prior?.w;   // undefined = default (half)
          const h = p.placement.h ?? prior?.h;
          const col = p.placement.col ?? prior?.col;
          const placement = { ...p.placement };
          if (w) placement.w = w; else delete placement.w;
          if (h) placement.h = h; else delete placement.h;
          if (col !== undefined) placement.col = col; else delete placement.col;
          this.writePanelBlob(version, { ...p, placement });
        }
        for (const id of input.removePanels ?? [])
          this.#driver.exec(
            "INSERT INTO sys.panel_tombstones(version, panel_id) VALUES (?, ?)",
            [version, id]);

        // G16: untouched panels whose declared queries or code reference renamed
        // fields receive a validated replacement blob at this version. Trusted
        // direct conversions may redirect the old presentation field to a
        // different physical relation column.
        if (fieldRenames.length > 0) {
          for (const lp of untouched) {
            let queries = lp.declared_queries;
            let code = lp.code;
            for (const r of fieldRenames) {
              queries = queries.map(q => renameQueryFields(q, r.table, r.from, r.to));
              if (lp.declared_queries.some(query => query.from === r.table)
                  || lp.declared_writes.includes(r.table))
                code = renamePanelFieldReferences(code, r.from, r.to);
            }
            if (code !== lp.code || JSON.stringify(queries) !== JSON.stringify(lp.declared_queries)) {
              const transformed = { ...lp, code, declared_queries: queries };
              const problems = validateMutationPlan({
                api: 1, summary: "Rewrite panel field references.",
                user_facing_diff: [{ kind: "change_panel", detail: lp.panel_id }],
                clarifying_question: null, assumptions: [], migration: null,
                panels: [transformed], remove_panels: [], semantic_hints: [], confidence: 1,
              }, { registry: this.reg,
                livePanelIds: PRODUCTION_STORE_PRIMITIVES.livePanels.call(this)
                  .map(panel => panel.panel_id) });
              if (problems.length > 0)
                throw new ClayError("E_VALIDATION",
                  `renamed panel '${lp.panel_id}' is invalid: ${problems.map(problem => problem.message).join("; ")}`);
              this.writePanelBlob(version, transformed);
            }
          }
        }

        this.setCurrentVersion(version);
        return version;
      });
    } catch (e) {
      this.loadRegistry();   // in-memory registry may be ahead of the rolled-back tx
      throw e;
    }
  }

  private writePanelBlob(version: number, p: PanelBlobInput): void {
    this.#driver.exec(
      `INSERT OR REPLACE INTO sys.panel_blobs(version, panel_id, code,
         placement_json, declared_q_json) VALUES (?, ?, ?, ?, ?)`,
      [version, p.panel_id, p.code, JSON.stringify(p.placement),
       JSON.stringify({
         title: p.title,
         declared_queries: p.declared_queries,
         declared_writes: p.declared_writes,   // ADR-014 rides in the manifest json
       })]);
  }

  /**
   * Direct manipulation (B4/doc 13): apply new panel placements as a
   * reversible commit — no model, no migration. Only the moved panels are
   * re-committed (code and queries unchanged), so it's a normal version in
   * the log and fully rewindable via the time slider. Reshape by touch and
   * reshape by language share one history.
   */
  commitLayout(
    placements: { panel_id: string; region: "top" | "main" | "side"; order: number;
      w?: number; h?: number; col?: number | null }[],
  ): number {
    const live = new Map(this.livePanels().map(p => [p.panel_id, p]));
    const moved: PanelBlobInput[] = [];
    for (const pl of placements) {
      const p = live.get(pl.panel_id);
      if (!p) continue;
      // width/height/col default to current (preserved across reorder);
      // undefined width = default half (ADR-018). col:null clears the pin.
      const w = pl.w ?? p.placement.w;
      const h = pl.h ?? p.placement.h;
      const col = pl.col === null ? undefined : (pl.col ?? p.placement.col);
      if (p.placement.region === pl.region && p.placement.order === pl.order
        && p.placement.w === w && p.placement.h === h && p.placement.col === col) continue;
      const placement: PanelBlobInput["placement"] = { region: pl.region, order: pl.order };
      if (w) placement.w = w;
      if (h) placement.h = h;
      if (col !== undefined) placement.col = col;
      moved.push({
        panel_id: p.panel_id, title: p.title, placement,
        code: p.code, declared_queries: p.declared_queries, declared_writes: p.declared_writes,
      });
    }
    if (moved.length === 0) return this.headVersion();
    return this.commit({
      intent: "rearrange layout",
      summary: "Rearranged the layout by hand.",
      migration: null, semanticOrigin: "direct", panels: moved,
      diff: moved.map(p => ({
        kind: "change_panel",
        detail: `Moved ${p.title} to ${p.placement.region}`,
      })),
    });
  }

  /** Direct manipulation (ADR-022c): rename one panel's title as a
   * reversible commit — no model. Small changes must never need a prompt
   * round-trip. Same commit vocabulary as a plan's change_panel. */
  renamePanel(panelId: string, title: string): number {
    const p = PRODUCTION_STORE_PRIMITIVES.livePanels.call(this)
      .find(x => x.panel_id === panelId);
    if (!p) throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    const next = title.trim().slice(0, 80);
    if (next.length === 0)
      throw new ClayError("E_VALIDATION", "panel title cannot be empty");
    if (next === p.title) return PRODUCTION_STORE_PRIMITIVES.headVersion.call(this);
    return PRODUCTION_STORE_PRIMITIVES.commit.call(this, {
      intent: `rename the ${p.title} panel`,
      summary: `Renamed “${p.title}” to “${next}”.`,
      migration: null, semanticOrigin: "direct",
      panels: [{
        panel_id: p.panel_id, title: next, placement: p.placement,
        code: p.code, declared_queries: p.declared_queries, declared_writes: p.declared_writes,
      }],
      diff: [{ kind: "change_panel", detail: `Renamed ${p.title} to ${next}` }],
    });
  }

  /** Direct manipulation (ADR-022c): remove one panel as a reversible
   * commit (tombstone). Data rows are untouched — rewind the timeline to
   * bring the panel back. Same vocabulary as a plan's remove_panels. */
  removePanel(panelId: string): number {
    const p = PRODUCTION_STORE_PRIMITIVES.livePanels.call(this)
      .find(x => x.panel_id === panelId);
    if (!p) throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    return PRODUCTION_STORE_PRIMITIVES.commit.call(this, {
      intent: `remove the ${p.title} panel`,
      summary: `Removed the “${p.title}” panel.`,
      migration: null, semanticOrigin: "direct", removePanels: [panelId],
      diff: [{ kind: "remove_panel", detail: `Removed ${p.title}` }],
    });
  }

  /** Live panels at a version (default: current): latest blob per id, minus
   * panels whose latest tombstone is newer than their latest blob
   * (doc 04 §5). Passing an older version powers scrub-preview — panels AT
   * K rendered against CURRENT data, no inverses run (doc 02 §6). */
  livePanels(at?: number): LivePanel[] {
    const v = at ?? PRODUCTION_STORE_PRIMITIVES.currentVersion.call(this);
    const rows = this.#driver.select(
      `SELECT b.panel_id, b.version, b.code, b.placement_json, b.declared_q_json
       FROM sys.panel_blobs b
       JOIN (SELECT panel_id, MAX(version) AS mv FROM sys.panel_blobs
             WHERE version <= ? GROUP BY panel_id) m
         ON b.panel_id = m.panel_id AND b.version = m.mv
       ORDER BY b.panel_id`, [v, ]);
    const out: LivePanel[] = [];
    for (const r of rows) {
      const tomb = this.#driver.select(
        `SELECT MAX(version) AS tv FROM sys.panel_tombstones
         WHERE panel_id = ? AND version <= ?`, [String(r.panel_id), v]);
      const tv = tomb[0]?.tv;
      if (tv !== null && tv !== undefined && Number(tv) >= Number(r.version)) continue;
      const manifest = JSON.parse(String(r.declared_q_json)) as {
        title: string; declared_queries: QueryT[]; declared_writes: string[];
      };
      out.push({
        panel_id: String(r.panel_id), version: Number(r.version),
        code: String(r.code),
        placement: JSON.parse(String(r.placement_json)) as LivePanel["placement"],
        title: manifest.title,
        declared_queries: manifest.declared_queries,
        declared_writes: manifest.declared_writes ?? [],
      });
    }
    return out;
  }

  /** Read-only provenance for a panel, derived from the existing blob and
   * version logs. Old apps gain it immediately without a new metadata table. */
  panelProvenance(panelId: string, at?: number): PanelProvenance | null {
    const version = at ?? this.currentVersion();
    const removed = this.#driver.select(
      `SELECT MAX(version) AS removed_version FROM sys.panel_tombstones
       WHERE panel_id = ? AND version <= ?`,
      [panelId, version],
    )[0]?.removed_version;
    const afterVersion = removed == null ? 0 : Number(removed);
    const row = this.#driver.select(
      `SELECT MIN(version) AS created_version, MAX(version) AS changed_version
       FROM sys.panel_blobs WHERE panel_id = ? AND version > ? AND version <= ?`,
      [panelId, afterVersion, version],
    )[0];
    if (row?.created_version == null || row.changed_version == null) return null;
    const createdVersion = Number(row.created_version);
    const lastChangedVersion = Number(row.changed_version);
    const created = this.getEntry(createdVersion);
    const changed = this.getEntry(lastChangedVersion);
    return {
      panel_id: panelId,
      createdVersion,
      lastChangedVersion,
      createdAt: created.created_at,
      lastChangedAt: changed.created_at,
      createdIntent: created.intent_text,
      lastChangedIntent: changed.intent_text,
      createdSummary: created.summary,
      lastChangedSummary: changed.summary,
    };
  }

  /** The full linear chain, oldest first (history view / time slider).
   * Joins any user-set checkpoint label (named moments on the timeline). */
  history(): HistoryEntry[] {
    return this.#driver.select(
      `SELECT v.version, v.parent, v.created_at, v.intent_text, v.summary, v.diff_json, c.label
       FROM sys.version_log v
       LEFT JOIN sys.checkpoints c ON c.version = v.version
       ORDER BY v.version`).map(r => ({
      version: Number(r.version), parent: Number(r.parent),
      created_at: String(r.created_at), intent_text: String(r.intent_text),
      summary: String(r.summary),
      ...(r.label != null ? { label: String(r.label) } : {}),
      ...(r.diff_json != null ? { diff: parseDiff(String(r.diff_json)) } : {}),
    }));
  }

  /** Name a moment on the timeline (checkpoint). Empty label clears it.
   * Labels live in sys, never in the data substrate (P1). */
  setCheckpoint(version: number, label: string): void {
    const trimmed = label.trim().slice(0, 60);
    if (trimmed === "") {
      this.#driver.exec("DELETE FROM sys.checkpoints WHERE version = ?", [version]);
      return;
    }
    this.#driver.exec(
      `INSERT INTO sys.checkpoints(version, label, created_at) VALUES (?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET label = excluded.label`,
      [version, trimmed, nowIso()]);
  }

  /** Last n commit summaries, newest first (S1 context, doc 05 §1). */
  recentSummaries(n: number): string[] {
    return this.#driver
      .select("SELECT summary FROM sys.version_log ORDER BY version DESC LIMIT ?", [n])
      .map(r => String(r.summary));
  }

  // ---------- attempts (S0/doc 05 §5 analytics) ----------
  beginAttempt(intent: string): string {
    const id = uuidv7();
    this.#driver.exec(
      "INSERT INTO sys.attempts(id, at, intent_text, outcome, error_code) VALUES (?, ?, ?, 'pending', NULL)",
      [id, nowIso(), intent]);
    return id;
  }

  pendingPlannerAttempts(): ReadonlyArray<Readonly<{ id: string; intent: string }>> {
    return this.#driver.select(
      "SELECT id, intent_text FROM sys.attempts WHERE outcome = 'pending' ORDER BY at, id",
    ).map(row => Object.freeze({ id: String(row.id), intent: String(row.intent_text) }));
  }

  #assertPendingAttempt(id: string, expectedIntent?: string): void {
    const rows = this.#driver.select(
      "SELECT intent_text, outcome FROM sys.attempts WHERE id = ?",
      [id],
    );
    const row = rows[0];
    if (rows.length !== 1 || !row || row.outcome !== "pending")
      throw new ClayError("E_CONFLICT", "planner attempt is missing or already finalized");
    if (expectedIntent !== undefined && row.intent_text !== expectedIntent)
      throw new ClayError("E_CONFLICT", "planner attempt does not match the prepared intent");
  }

  #finishAttempt(
    id: string,
    outcome: string,
    errorCode: string | null = null,
    expectedIntent?: string,
  ): void {
    this.#assertPendingAttempt(id, expectedIntent);
    this.#driver.exec(
      "UPDATE sys.attempts SET outcome = ?, error_code = ? WHERE id = ? AND outcome = 'pending'",
      [outcome, errorCode, id]);
    const rows = this.#driver.select(
      "SELECT outcome, error_code FROM sys.attempts WHERE id = ?",
      [id],
    );
    const row = rows[0];
    if (rows.length !== 1 || !row || row.outcome !== outcome
        || (row.error_code ?? null) !== errorCode)
      throw new ClayError("E_INTERNAL", "planner attempt finalization failed read-back");
  }

  finishAttempt(
    id: string,
    outcome: string,
    errorCode: string | null = null,
    expectedIntent?: string,
  ): void {
    this.#finishAttempt(id, outcome, errorCode, expectedIntent);
  }

  /** Commit shape and mark its planner attempt kept inside one Store transaction.
   * Production authority wraps this in the same physical publication transaction. */
  commitPreparedMutation(input: CommitInput, attemptId: string): number {
    try {
      return this.#driver.tx(() => {
        this.#assertPendingAttempt(attemptId, input.intent);
        const version = PRODUCTION_STORE_PRIMITIVES.commit.call(this, input);
        this.#finishAttempt(attemptId, "kept", null, input.intent);
        return version;
      });
    } catch (error) {
      this.loadRegistry();
      throw error;
    }
  }

  /** Rehydrate the registry after an enclosing physical transaction rolls back
   * after a nested Store operation had already updated its in-memory projection. */
  reloadRegistryAfterRollback(): void {
    this.loadRegistry();
  }

  /** Independent full copy for the S4 shadow dry-run (doc 05 §1). */
  async shadowCopy(): Promise<ClayStore> {
    const copy = new ClayStore(await this.#driver.snapshot());
    copy.loadRegistry();
    return copy;
  }

  /** Apply inverses current..K+1. With truncate, the chain above K is discarded. */
  rollbackTo(target: number, opts: { truncate?: boolean } = {}): void {
    const cur = PRODUCTION_STORE_PRIMITIVES.currentVersion.call(this);
    if (target < 0 || target >= cur)
      throw new ClayError("E_VALIDATION", `cannot roll back from ${cur} to ${target}`);
    try {
      this.#driver.tx(() => {
        for (let v = cur; v > target; v--) {
          const entry = PRODUCTION_STORE_PRIMITIVES.getEntry.call(this, v);
          if (entry.migration)
            applyInverseOps(this.#driver, this.reg, entry.migration.inverse);
        }
        this.alignSemanticLabelsToPhysicalShape();
        this.assertAutomationsCompatible();
        this.assertRelationIntegrity();
        this.persistRegistry(target);
        if (opts.truncate) {
          this.#driver.exec("DELETE FROM sys.version_log WHERE version > ?", [target]);
          this.#driver.exec("DELETE FROM sys.panel_blobs WHERE version > ?", [target]);
          this.#driver.exec("DELETE FROM sys.panel_tombstones WHERE version > ?", [target]);
          this.#driver.exec("DELETE FROM sys.checkpoints WHERE version > ?", [target]);
          this.pruneSemanticAfter(target);
          this.persistRegistry(target);
        }
        this.setCurrentVersion(target);
      });
    } catch (e) {
      this.loadRegistry();
      throw e;
    }
  }

  /** Re-apply forward ops current+1..N (only meaningful before truncation). */
  rollForwardTo(target: number): void {
    const cur = this.currentVersion();
    const head = this.headVersion();
    if (target <= cur || target > head)
      throw new ClayError("E_VALIDATION", `cannot roll forward from ${cur} to ${target} (head ${head})`);
    try {
      this.#driver.tx(() => {
        for (let v = cur + 1; v <= target; v++) {
          const entry = this.getEntry(v);
          if (entry.migration)
            applyForwardOps(this.#driver, this.reg, entry.migration.operations);
        }
        this.alignSemanticLabelsToPhysicalShape();
        this.assertAutomationsCompatible();
        this.assertRelationIntegrity();
        this.persistRegistry(target);
        this.setCurrentVersion(target);
      });
    } catch (e) {
      this.loadRegistry();
      throw e;
    }
  }

  // ---------- rows ----------
  private relationIdsForInput(column: RegColumn, value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (column.relation?.cardinality === "one")
      return typeof value === "string" ? [value] : [];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string") : [];
  }

  private validateRelationReferences(
    table: RegTable,
    values: Record<string, unknown>,
    excludeRowId?: string,
  ): void {
    for (const [field, value] of Object.entries(values)) {
      const column = findColumn(table, field);
      if (column?.type !== "relation" || !column.relation || value === null) continue;
      const ids = this.relationIdsForInput(column, value);
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length !== ids.length && column.relation.cardinality === "one")
        throw new ClayError("E_VALIDATION", `'${table.name}.${field}' has duplicate links`);
      for (let offset = 0; offset < uniqueIds.length; offset += 400) {
        const batch = uniqueIds.slice(offset, offset + 400);
        if (batch.length === 0) continue;
        const found = this.#driver.select(
          `SELECT "id" FROM ${qid(column.relation.target_table)}
           WHERE "deleted_at" IS NULL AND "id" IN (${batch.map(() => "?").join(", ")})`,
          batch,
        );
        if (found.length !== batch.length)
          throw new ClayError("E_VALIDATION",
            `'${table.name}.${field}' contains a missing linked record`);
      }
      if (!column.relation.unique_targets || uniqueIds.length === 0) continue;
      const others = this.#driver.select(
        `SELECT "id", ${qid(field)} FROM ${qid(table.name)} WHERE "deleted_at" IS NULL`
          + (excludeRowId ? ` AND "id" != ?` : ""),
        excludeRowId ? [excludeRowId] : [],
      );
      const wanted = new Set(uniqueIds);
      for (const other of others) {
        const raw = other[field];
        let linked: unknown = raw;
        if (column.relation.cardinality === "many" && typeof raw === "string") {
          try { linked = JSON.parse(raw); } catch { linked = []; }
        }
        const overlap = this.relationIdsForInput(column, linked).some(id => wanted.has(id));
        if (overlap)
          throw new ClayError("E_VALIDATION",
            `'${table.name}.${field}' requires each target to be linked only once`);
      }
    }
  }

  private decodeStoredRelation(column: RegColumn, raw: SqlValue): unknown {
    if (raw === null) return null;
    if (column.relation?.cardinality === "one") {
      if (typeof raw !== "string")
        throw new ClayError("E_VALIDATION", `'${column.name}' has an invalid linked record`);
      return raw;
    }
    if (typeof raw !== "string")
      throw new ClayError("E_VALIDATION", `'${column.name}' has an invalid linked record list`);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new ClayError("E_VALIDATION", `'${column.name}' has an invalid linked record list`); }
    if (!Array.isArray(parsed) || !parsed.every(id => typeof id === "string")
        || new Set(parsed).size !== parsed.length)
      throw new ClayError("E_VALIDATION", `'${column.name}' has an invalid linked record list`);
    return parsed;
  }

  private assertRelationIntegrity(): void {
    for (const table of this.reg.values()) {
      if (table.inactive) continue;
      for (const column of table.columns) {
        if (column.inactive || column.type !== "relation" || !column.relation) continue;
        const rows = this.#driver.select(
          `SELECT "id", ${qid(column.name)} AS value FROM ${qid(table.name)}
           WHERE "deleted_at" IS NULL AND ${qid(column.name)} IS NOT NULL`);
        for (const row of rows) {
          const value = this.decodeStoredRelation(column, row.value ?? null);
          this.validateRelationReferences(table, { [column.name]: value }, String(row.id));
        }
      }
    }
  }

  private freshColumnName(table: RegTable, preferred: string): string {
    const taken = new Set([
      ...table.columns.map(column => column.name),
      ...(table.reservedColumnNames ?? []),
    ]);
    const root = preferred.slice(0, 38).replace(/_+$/g, "") || "linked";
    for (let index = 1; index < 100; index++) {
      const candidate = index === 1 ? root : `${root.slice(0, 38 - String(index).length)}_${index}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new ClayError("E_LIMIT", "could not allocate a reversible linked-field name");
  }

  private analyzeRelationConversion(input: RelationConversionRequest): {
    preview: RelationConversionPreview;
    matches: Map<string, string>;
  } {
    const source = getTable(this.reg, input.sourceTable);
    const target = getTable(this.reg, input.targetTable);
    const sourceColumn = findColumn(source, input.sourceField);
    const displayColumn = findColumn(target, input.displayField);
    if (!sourceColumn || sourceColumn.hidden
        || !["text", "enum", "rich_text"].includes(sourceColumn.type))
      throw new ClayError("E_VALIDATION", "source must be a visible text field");
    if (!displayColumn || displayColumn.hidden || isVirtualColumn(displayColumn)
        || !["text", "enum", "rich_text"].includes(displayColumn.type))
      throw new ClayError("E_VALIDATION", "display field must be visible text");
    const sources = this.#driver.select(
      `SELECT "id", ${qid(input.sourceField)} FROM ${qid(input.sourceTable)}
       WHERE "deleted_at" IS NULL ORDER BY "id" LIMIT 5001`,
    );
    const targets = this.#driver.select(
      `SELECT "id", ${qid(input.displayField)} FROM ${qid(input.targetTable)}
       WHERE "deleted_at" IS NULL ORDER BY "id" LIMIT 5001`,
    );
    if (sources.length > 5_000 || targets.length > 5_000)
      throw new ClayError("E_LIMIT", "text conversion is limited to 5,000 source and target rows");
    const targetsByLabel = new Map<string, string[]>();
    for (const row of targets) {
      const label = normalizedLabel(row[input.displayField]);
      if (!label) continue;
      const ids = targetsByLabel.get(label) ?? [];
      ids.push(String(row.id));
      targetsByLabel.set(label, ids);
    }
    const sourceFrequency = new Map<string, number>();
    const matches = new Map<string, string>();
    const unmatched = new Set<string>();
    const ambiguous = new Set<string>();
    let matchedRows = 0;
    let unmatchedRows = 0;
    let ambiguousRows = 0;
    for (const row of sources) {
      const raw = row[input.sourceField];
      const label = normalizedLabel(raw);
      if (!label) continue;
      sourceFrequency.set(label, (sourceFrequency.get(label) ?? 0) + 1);
      const candidates = targetsByLabel.get(label) ?? [];
      if (candidates.length === 1) {
        matches.set(String(row.id), candidates[0]!); matchedRows++;
      } else if (candidates.length === 0) {
        unmatchedRows++; unmatched.add(String(raw));
      } else {
        ambiguousRows++; ambiguous.add(String(raw));
      }
    }
    const signature = JSON.stringify({
      version: this.currentVersion(),
      sourceTable: input.sourceTable, sourceField: input.sourceField,
      targetTable: input.targetTable, displayField: input.displayField,
      sourceIdentity: source.semantic, targetIdentity: target.semantic,
      source: sources.map(row => [row.id, row[input.sourceField]]),
      target: targets.map(row => [row.id, row[input.displayField]]),
    });
    return {
      preview: {
        ...input,
        atVersion: this.currentVersion(),
        fingerprint: `sha256:${sha256HexSync(new TextEncoder().encode(signature))}`,
        matchedRows, unmatchedRows, ambiguousRows,
        duplicateSourceRows: [...sourceFrequency.values()]
          .reduce((total, count) => total + Math.max(0, count - 1), 0),
        unmatchedSamples: [...unmatched].slice(0, 5),
        ambiguousSamples: [...ambiguous].slice(0, 5),
      },
      matches,
    };
  }

  previewRelationConversion(input: RelationConversionRequest): RelationConversionPreview {
    return this.analyzeRelationConversion(input).preview;
  }

  convertTextToRelation(
    input: RelationConversionPreview & { cardinality: "one" },
  ): RelationConversionResult {
    if (input.cardinality !== "one")
      throw new ClayError("E_VALIDATION", "text conversion creates one link per source row");
    const analyzed = this.analyzeRelationConversion(input);
    if (analyzed.preview.atVersion !== input.atVersion
        || analyzed.preview.fingerprint !== input.fingerprint)
      throw new ClayError("E_CONFLICT", "records changed after the conversion preview");
    const table = getTable(this.reg, input.sourceTable);
    const original = findColumn(table, input.sourceField)!;
    const sourceField = this.freshColumnName(table, `${input.sourceField}_source`);
    const relationField = this.freshColumnName(table, `${input.sourceField}_link`);
    const label = original.label ?? input.sourceField.replace(/_/g, " ")
      .replace(/^./, char => char.toUpperCase());
    const operations: MigrationPlanT["operations"] = [
      { op: "rename_column", table: input.sourceTable, from: input.sourceField, to: sourceField },
      { op: "hide_column", table: input.sourceTable, column: sourceField },
      { op: "add_column", table: input.sourceTable, column: {
        name: relationField, label, type: "relation", required: false,
        relation: {
          target_table: input.targetTable, cardinality: "one",
          unique_targets: false, display_field: input.displayField,
        },
      } },
    ];
    const migration: MigrationPlanT = {
      operations,
      inverse: deriveInverse(operations, this.reg),
    };
    let version = 0;
    try {
      this.#driver.tx(() => {
        version = PRODUCTION_STORE_PRIMITIVES.commit.call(this, {
          intent: `connect ${input.sourceTable}.${input.sourceField} to ${input.targetTable}`,
          summary: `Connects ${label} to ${input.targetTable} records without deleting the original text.`,
          migration,
          semanticOrigin: "direct",
          diff: [{ kind: "add_relation", detail: `${label} now links to ${input.targetTable}` }],
          panelFieldReplacements: [{
            table: input.sourceTable, from: input.sourceField, to: relationField,
          }],
        });
        for (const row of this.#driver.select(
          `SELECT "id" FROM ${qid(input.sourceTable)} WHERE "deleted_at" IS NULL`)) {
          this.#driver.exec(
            `UPDATE ${qid(input.sourceTable)} SET ${qid(relationField)} = ? WHERE "id" = ?`,
            [analyzed.matches.get(String(row.id)) ?? null, String(row.id)],
          );
        }
      });
    } catch (error) {
      this.loadRegistry();
      throw error;
    }
    return { version, convertedRows: analyzed.matches.size, sourceField, relationField };
  }

  private recordRowEvent(
    table: string, id: string, kind: "created" | "updated" | "deleted" | "restored",
    changedFields: string[],
  ): void {
    const snapshot = this.rowById(table, id);
    const registered = getTable(this.reg, table);
    if (!registered.semantic)
      throw new ClayError("E_VALIDATION", "record event table semantic identity is missing");
    const fields = registered.columns
      .filter(column => !column.inactive && column.semantic)
      .map(column => ({ fieldId: column.semantic!.fieldId, value: snapshot?.[column.name] ?? null }))
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
    const core = {
      v: 1 as const,
      tableId: registered.semantic.tableId,
      tableNameAtEvent: table,
      rowId: id,
      schemaRevision: this.currentVersion(),
      kernel: snapshot === null ? null : {
        id: snapshot.id ?? id,
        created_at: snapshot.created_at ?? null,
        updated_at: snapshot.updated_at ?? null,
        deleted_at: snapshot.deleted_at ?? null,
      },
      fields,
    };
    const snapshotDigest = automationSha256(core);
    const changedFieldIds = [...new Set(changedFields.map(name => {
      const column = findColumn(registered, name);
      return column?.semantic?.fieldId ?? `kernel:${name}`;
    }))].sort();
    this.#driver.exec(
      `INSERT INTO sys.record_events(
         id, at, table_name, row_id, kind, changed_fields_json, origin, row_json,
         table_id, schema_revision, snapshot_digest, changed_field_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(), nowIso(), table, id, kind, JSON.stringify([...new Set(changedFields)].sort()),
       this.batchContext?.source === "automation" ? "automation"
         : this.batchContext?.source === "import" ? "import" : "user",
       JSON.stringify({ ...core, snapshotDigest }), registered.semantic.tableId,
       core.schemaRevision, snapshotDigest, JSON.stringify(changedFieldIds)]);
  }

  #insertWithId(table: string, row: Record<string, unknown>, id: string): QueryRow {
    const t = getTable(this.reg, table);
    this.validateRelationReferences(t, row);
    const { cols, vals } = validateInsert(t, row);
    if (!IMPORT_UUID.test(id))
      throw new ClayError("E_VALIDATION", "prepared row identity is invalid");
    const now = nowIso();
    const allCols = ["id", "created_at", "updated_at", ...cols];
    const allVals: SqlValue[] = [id, now, now, ...vals];
    this.#driver.tx(() => {
      this.#driver.exec(
        `INSERT INTO ${qid(table)} (${allCols.map(qid).join(", ")})
         VALUES (${allCols.map(() => "?").join(", ")})`, allVals);
      for (const column of t.columns) {
        if (!column.inactive || isVirtualColumn(column)) continue;
        this.#driver.exec(
          `INSERT OR IGNORE INTO sys.inactive_cells(table_name, column_name, row_id)
           VALUES (?, ?, ?)`, [table, column.name, id]);
      }
      this.recordRowEvent(table, id, "created", cols);
    });
    if (this.batchContext) {
      const after = this.#driver.select(`SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id])[0];
      this.#driver.exec(
        `INSERT INTO "row_history"(
           "id", "table", "row_id", "at", "before_json", "after_json", "batch_id", "change_kind", "sequence")
         VALUES (?, ?, ?, ?, ?, ?, ?, 'create',
           (SELECT COALESCE(MAX("sequence"), 0) + 1 FROM "row_history"))`,
        [uuidv7(), table, id, now, "null", JSON.stringify(after), this.batchContext.id]);
    }
    this.#observer.record({ kind: "insert", subject: table });
    return this.rowById(table, id);
  }

  insert(table: string, row: Record<string, unknown>): QueryRow {
    return this.#driver.tx(() => this.#insertWithId(table, row, uuidv7()));
  }

  // ---------- Observer (doc 02 §1) ----------
  recordUsage(ev: UsageEvent): void { this.#observer.record(ev); }
  suggestions(): Suggestion[] {
    // tables that already have at least one panel — so "table with data but
    // no view" can be offered (ambient reshaping, B3).
    const viewed = new Set<string>();
    const boarded = new Set<string>();          // tables already shown as a board
    const flowed = new Set<string>();           // ... or as a workflow (ADR-027)
    const charted = new Set<string>();          // ... or summarised in a chart
    for (const p of this.livePanels()) {
      const code = p.code ?? "";
      const isBoard = /\bBoard\b/.test(code);
      const isFlow = /\bFlow\b/.test(code);
      const isChart = /\bChart\b/.test(code);
      for (const q of p.declared_queries) {
        viewed.add(q.from);
        if (isBoard) boarded.add(q.from);
        if (isFlow) flowed.add(q.from);
        if (isChart) charted.add(q.from);
      }
    }
    return this.#observer.suggestions(this.registrySnapshot(), viewed, boarded, flowed, charted);
  }
  markSuggestionShown(subject: string, kind: string): void {
    this.#observer.markShown(subject, kind);
  }
  dismissSuggestion(subject: string, kind: string): void {
    this.#observer.dismiss(subject, kind);
  }
  acceptSuggestion(subject: string, kind: string): void {
    this.#observer.accept(subject, kind);
  }

  private attachmentColumn(table: string, field: string): RegColumn {
    const column = findColumn(getTable(this.reg, table), field);
    if (!column || column.type !== "attachment" || column.hidden || column.inactive)
      throw new ClayError("E_VALIDATION", `'${table}.${field}' is not an active file field`);
    return column;
  }

  private attachmentIds(table: string, rowId: string, field: string): string[] {
    this.attachmentColumn(table, field);
    const row = this.#driver.select(
      `SELECT ${qid(field)} AS value FROM ${qid(table)} WHERE "id" = ?`, [rowId])[0];
    if (!row) throw new ClayError("E_VALIDATION", `record '${table}/${rowId}' does not exist`);
    if (row.value === null) return [];
    if (typeof row.value !== "string")
      throw new ClayError("E_INTERNAL", "file field is not valid JSON");
    try {
      const ids = JSON.parse(row.value) as unknown;
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) throw new Error();
      return [...new Set(ids)];
    } catch { throw new ClayError("E_INTERNAL", "file field is not valid JSON"); }
  }

  private attachmentMetadata(row: SqlRow): AttachmentMetadata {
    return {
      id: String(row.id), name: String(row.name), mime: String(row.mime),
      size: Number(row.size), sha256: String(row.sha256), createdAt: String(row.created_at),
    };
  }

  private attachmentActivelyReferenced(id: string): boolean {
    for (const table of this.reg.values()) {
      for (const column of table.columns.filter(candidate =>
        candidate.type === "attachment")) {
        for (const row of this.#driver.select(
          `SELECT ${qid(column.name)} AS value FROM ${qid(table.name)}
           WHERE "deleted_at" IS NULL AND ${qid(column.name)} IS NOT NULL`)) {
          if (typeof row.value !== "string") continue;
          try {
            const ids = JSON.parse(row.value) as unknown;
            if (Array.isArray(ids) && ids.includes(id)) return true;
          } catch { /* integrity checker reports malformed fields */ }
        }
      }
    }
    return false;
  }

  private attachmentRecoverablyReferenced(id: string): boolean {
    if (this.attachmentActivelyReferenced(id)) return true;
    for (const table of this.reg.values()) {
      for (const column of table.columns.filter(candidate => candidate.type === "attachment")) {
        for (const row of this.#driver.select(
          `SELECT ${qid(column.name)} AS value FROM ${qid(table.name)}
           WHERE ${qid(column.name)} IS NOT NULL`)) {
          try {
            const ids = JSON.parse(String(row.value)) as unknown;
            if (Array.isArray(ids) && ids.includes(id)) return true;
          } catch { /* integrity checker owns malformed values */ }
        }
      }
    }
    for (const history of this.#driver.select(
      `SELECT "table", "before_json", "change_kind" FROM "row_history"`)) {
      const table = this.reg.get(String(history.table));
      if (!table) continue;
      let before: Record<string, unknown>;
      try {
        const parsed = JSON.parse(String(history.before_json)) as unknown;
        if (parsed === null && history.change_kind === "create") continue;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
        before = parsed as Record<string, unknown>;
      } catch { return true; }
      for (const column of table.columns.filter(candidate => candidate.type === "attachment")) {
        const raw = before[column.name];
        if (raw === null || raw === undefined) continue;
        try {
          const ids = JSON.parse(String(raw)) as unknown;
          if (!Array.isArray(ids)) return true;
          if (ids.includes(id)) return true;
        } catch { return true; }
      }
    }
    return false;
  }

  private rowAttachmentIds(tableName: string, rowId: string): string[] {
    const table = this.reg.get(tableName);
    return table ? [...new Set(table.columns
      .filter(column => column.type === "attachment")
      .flatMap(column => this.attachmentIds(tableName, rowId, column.name)))] : [];
  }

  private reconcileRowAttachments(
    tableName: string, rowId: string, previouslyReferenced: string[] = [],
  ): void {
    const table = this.reg.get(tableName);
    if (!table) return;
    for (const column of table.columns.filter(candidate => candidate.type === "attachment")) {
      const raw = this.#driver.select(
        `SELECT ${qid(column.name)} AS value FROM ${qid(tableName)} WHERE id = ?`, [rowId])[0]?.value;
      if (typeof raw !== "string") continue;
      let ids: string[];
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed) || parsed.length > MAX_ATTACHMENTS_PER_FIELD
            || !parsed.every(id => typeof id === "string" && /^file_[0-9a-f]{32}$/.test(id))
            || new Set(parsed).size !== parsed.length)
          throw new Error();
        ids = parsed;
      } catch {
        throw new ClayError("E_CONFLICT", "attachment references are not recoverable");
      }
      for (const id of ids) {
        if (this.#driver.select(
          `SELECT id FROM "__clay_attachments" WHERE id = ?`, [id])[0] === undefined)
          throw new ClayError("E_CONFLICT", `recoverable attachment '${id}' is missing`);
        this.#driver.exec(`UPDATE "__clay_attachments" SET deleted_at = NULL WHERE id = ?`, [id]);
      }
    }
    const now = nowIso();
    for (const id of previouslyReferenced)
      if (!this.attachmentActivelyReferenced(id))
        this.#driver.exec(`UPDATE "__clay_attachments" SET deleted_at = ? WHERE id = ?`, [now, id]);
  }

  async addAttachment(input: AttachmentInput): Promise<AttachmentMetadata> {
    const table = input.table;
    const rowId = input.rowId;
    const field = input.field;
    const name = input.name;
    const mime = input.mime;
    const source = input.bytes;
    if (!(source instanceof Uint8Array))
      throw new ClayError("E_VALIDATION", "file is empty or unreadable");
    const bytes = new Uint8Array(source);
    const captured = { table, rowId, field, name, mime, bytes };
    return this.#addCapturedAttachment(captured, await sha256(bytes));
  }

  #addCapturedAttachment(input: AttachmentInput, digest: string): AttachmentMetadata {
    const identity = safeAttachmentIdentity(input.name, input.mime);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0)
      throw new ClayError("E_VALIDATION", "file is empty or unreadable");
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new ClayError("E_LIMIT", "each file is limited to 10 MB");
    validateAttachmentSignature(input.bytes, identity.mime);
    if (!/^[0-9a-f]{64}$/.test(digest) || sha256HexSync(input.bytes) !== digest)
      throw new ClayError("E_VALIDATION", "attachment capture digest is invalid");
    this.attachmentColumn(input.table, input.field);
    const id = `file_${uuidv7().replaceAll("-", "")}`;
    const createdAt = nowIso();
    return this.#driver.tx(() => {
      const state = this.#driver.select(
        `SELECT "deleted_at" FROM ${qid(input.table)} WHERE "id" = ?`, [input.rowId])[0];
      if (!state || state.deleted_at !== null)
        throw new ClayError("E_VALIDATION", "files can only be added to an active record");
      const ids = this.attachmentIds(input.table, input.rowId, input.field);
      if (ids.length >= MAX_ATTACHMENTS_PER_FIELD)
        throw new ClayError("E_LIMIT", "a file field can hold at most 20 files");
      const storage = this.attachmentStorage();
      if (storage.activeBytes + input.bytes.byteLength > MAX_APP_ATTACHMENT_BYTES)
        throw new ClayError("E_LIMIT", "this app is limited to 200 MB of active files");
      if (storage.activeBytes + storage.deletedBytes + input.bytes.byteLength
          > MAX_RETAINED_ATTACHMENT_BYTES)
        throw new ClayError("E_LIMIT",
          "this app is limited to 250 MB of retained files; clean up old removed files first");
      this.#driver.exec(
        `INSERT INTO "__clay_attachments"(
           id, name, mime, size, sha256, bytes, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [id, identity.name, identity.mime, input.bytes.byteLength,
         digest, input.bytes, createdAt]);
      this.writeRowHistory(input.table, input.rowId, "attachment_add");
      this.#driver.exec(
        `UPDATE ${qid(input.table)} SET ${qid(input.field)} = ?, "updated_at" = ? WHERE "id" = ?`,
        [JSON.stringify([...ids, id]), createdAt, input.rowId]);
      this.recordRowEvent(input.table, input.rowId, "updated", [input.field]);
      const inserted = this.#driver.select(
        `SELECT id, name, mime, size, sha256, bytes, created_at, deleted_at
         FROM "__clay_attachments" WHERE id = ?`, [id],
      )[0];
      const attached = this.attachmentIds(input.table, input.rowId, input.field);
      if (!inserted || inserted.deleted_at !== null || !attached.includes(id)
          || inserted.name !== identity.name || inserted.mime !== identity.mime
          || Number(inserted.size) !== input.bytes.byteLength || inserted.sha256 !== digest
          || !(inserted.bytes instanceof Uint8Array)
          || inserted.bytes.byteLength !== input.bytes.byteLength
          || sha256HexSync(inserted.bytes) !== digest)
        throw new ClayError("E_INTERNAL", "attachment write failed atomic read-back");
      return this.attachmentMetadata(inserted);
    });
  }

  attachmentsForRecord(table: string, rowId: string, field: string): AttachmentMetadata[] {
    const ids = this.attachmentIds(table, rowId, field);
    if (ids.length === 0) return [];
    const rows = this.#driver.select(
      `SELECT id, name, mime, size, sha256, created_at FROM "__clay_attachments"
       WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`, ids);
    const byId = new Map(rows.map(row => [String(row.id), this.attachmentMetadata(row)]));
    return ids.flatMap(id => byId.get(id) ?? []);
  }

  async readAttachment(id: string): Promise<AttachmentFile> {
    const row = this.#driver.select(`SELECT * FROM "__clay_attachments"
      WHERE id = ? AND deleted_at IS NULL`, [id])[0];
    if (!row) throw new ClayError("E_VALIDATION", "file not found");
    if (!(row.bytes instanceof Uint8Array) || row.bytes.byteLength !== Number(row.size)
        || await sha256(row.bytes) !== String(row.sha256))
      throw new ClayError("E_VALIDATION", "attachment integrity check failed");
    return { ...this.attachmentMetadata(row), bytes: new Uint8Array(row.bytes) };
  }

  removeAttachment(table: string, rowId: string, field: string, id: string): void {
    const ids = this.attachmentIds(table, rowId, field);
    if (!ids.includes(id)) throw new ClayError("E_VALIDATION", "file is not attached to this record");
    const now = nowIso();
    this.#driver.tx(() => {
      this.writeRowHistory(table, rowId, "attachment_remove");
      this.#driver.exec(
        `UPDATE ${qid(table)} SET ${qid(field)} = ?, "updated_at" = ? WHERE "id" = ?`,
        [JSON.stringify(ids.filter(candidate => candidate !== id)), now, rowId]);
      if (!this.attachmentActivelyReferenced(id))
        this.#driver.exec(`UPDATE "__clay_attachments" SET deleted_at = ? WHERE id = ?`, [now, id]);
      this.recordRowEvent(table, rowId, "updated", [field]);
      const attached = this.attachmentIds(table, rowId, field);
      const stored = this.#driver.select(
        `SELECT deleted_at FROM "__clay_attachments" WHERE id = ?`, [id],
      )[0];
      const activeElsewhere = this.attachmentActivelyReferenced(id);
      if (attached.includes(id) || !stored
          || (activeElsewhere ? stored.deleted_at !== null : stored.deleted_at === null))
        throw new ClayError("E_INTERNAL", "attachment removal failed atomic read-back");
    });
  }

  attachmentStorage(): AttachmentStorageSummary {
    const rows = this.#driver.select(
      `SELECT deleted_at IS NULL AS active, COUNT(*) AS files,
         COALESCE(SUM(size), 0) AS bytes FROM "__clay_attachments"
       GROUP BY deleted_at IS NULL`);
    const active = rows.find(row => Number(row.active) === 1);
    const deleted = rows.find(row => Number(row.active) === 0);
    return {
      activeFiles: Number(active?.files ?? 0), activeBytes: Number(active?.bytes ?? 0),
      deletedFiles: Number(deleted?.files ?? 0), deletedBytes: Number(deleted?.bytes ?? 0),
    };
  }

  purgeDeletedAttachments(now = new Date(), minAgeDays = 30): { files: number; bytes: number } {
    if (!Number.isFinite(minAgeDays) || minAgeDays < 30)
      throw new ClayError("E_VALIDATION", "deleted files must be retained for at least 30 days");
    const cutoff = new Date(now.getTime() - minAgeDays * 86_400_000).toISOString();
    return this.#driver.tx(() => {
      const candidates = this.#driver.select(
        `SELECT id, size FROM "__clay_attachments" WHERE deleted_at IS NOT NULL AND deleted_at <= ?`,
        [cutoff]).filter(row => !this.attachmentRecoverablyReferenced(String(row.id)));
      for (const candidate of candidates)
        this.#driver.exec(`DELETE FROM "__clay_attachments" WHERE id = ?`, [String(candidate.id)]);
      if (candidates.some(candidate => this.#driver.select(
        `SELECT id FROM "__clay_attachments" WHERE id = ?`, [String(candidate.id)],
      ).length !== 0))
        throw new ClayError("E_INTERNAL", "attachment purge failed atomic read-back");
      return {
        files: candidates.length,
        bytes: candidates.reduce((total, row) => total + Number(row.size), 0),
      };
    });
  }

  // ---------- Release F public intake: untrusted staging -> trusted receipt ----------
  private intakeState(newV2Form = false): IntakeLocalStateV2 {
    const active = this.getSetting<unknown>("intake_v2");
    // Separate V2 state is not adoption of V1. New forms remain usable while
    // original legacy bytes stay quarantined and excluded from archives.
    if (!newV2Form && active === undefined && this.#driver.select("SELECT key FROM sys.settings WHERE key='intake_v1'").length)
      throw new ClayError("E_CONFLICT", "Legacy intake state remains quarantined; create a separate V2 form or review original custody in Recovery Center");
    return parseIntakeState(active);
  }

  private writeIntakeState(state: IntakeLocalStateV2): void {
    const live = state.submissions.filter(item =>
      item.status === "pending" || item.status === "blocked");
    const terminal = state.submissions.filter(item =>
      item.status === "accepted" || item.status === "rejected")
      .sort((left, right) => (right.terminalAt ?? "").localeCompare(left.terminalAt ?? "")
        || left.submission.submissionId.localeCompare(right.submission.submissionId))
      .slice(0, 200);
    state.submissions = [...live, ...terminal];
    const retainedSubmissionIds = new Set(state.submissions.map(item => item.submission.submissionId));
    const activeReceiptIds = new Set(terminal.flatMap(item => item.receiptId === null ? [] : [item.receiptId]));
    // Undo moves its submission back to pending. Keep the bounded historical
    // receipt instead of erasing the only explanation of that inverse on write.
    const activeReceipts = state.receipts.filter(receipt => activeReceiptIds.has(receipt.id));
    const historicalReceipts = state.receipts.filter(receipt => receipt.undone && retainedSubmissionIds.has(receipt.submissionId))
      .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt) || right.id.localeCompare(left.id)).slice(0, 200);
    state.receipts = [...activeReceipts, ...historicalReceipts];
    const activeFailures = state.deliveryFailures.filter(item =>
      item.status === "failed" || item.status === "discard_authorized");
    const terminalFailures = state.deliveryFailures.filter(item =>
      item.status === "staged" || item.status === "discarded")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 200);
    state.deliveryFailures = [...activeFailures, ...terminalFailures];
    this.setSetting("intake_v2", parseIntakeState(state));
  }

  listIntakeForms(): LocalIntakeFormV2[] {
    return this.intakeState().forms.map(form => parseLocalIntakeForm(form));
  }
  listIntakeAutoAcceptRules(): IntakeAutoAcceptRuleV1[] {
    return this.intakeState().rules.map(rule => IntakeAutoAcceptRuleV1.parse(rule));
  }

  saveIntakeForm(input: LocalIntakeFormV2): LocalIntakeFormV2 {
    const form = parseLocalIntakeForm(input);
    resolveIntakeForm(form.publicForm, this.validationRegistrySnapshot(), this.currentVersion());
    const state = this.intakeState(true);
    if (state.publicationClosures?.some(row => row.form.publicForm.formId === form.publicForm.formId))
      throw new ClayError("E_CONFLICT", "intake publication identity is terminally closed");
    const index = state.forms.findIndex(candidate =>
      candidate.publicForm.formId === form.publicForm.formId);
    if (index >= 0) {
      const prior = state.forms[index]!;
      if (JSON.stringify(prior) === JSON.stringify(form)) return parseLocalIntakeForm(prior);
      if (prior.revokedAt !== null)
        throw new ClayError("E_CONFLICT", "revoked intake metadata is terminal; review a new form identity");
      if (form.publicForm.revision <= prior.publicForm.revision
          || JSON.stringify(form.ownerSource) !== JSON.stringify(prior.ownerSource)
          || form.publicForm.encryption.ownerPublicKey !== prior.publicForm.encryption.ownerPublicKey
          || form.relayBaseUrl !== prior.relayBaseUrl)
        throw new ClayError("E_CONFLICT", "intake form revision or owner authority is stale");
      state.forms[index] = form;
      state.rules = state.rules.filter(rule => rule.formId !== form.publicForm.formId);
      state.simulations = state.simulations.filter(item => item.formId !== form.publicForm.formId);
    } else {
      if (state.forms.length >= 100)
        throw new ClayError("E_LIMIT", "an app can keep at most 100 intake forms");
      state.forms.push(form);
    }
    this.writeIntakeState(state);
    return parseLocalIntakeForm(form);
  }

  markIntakeFormPublished(formId: string, publishedAt = nowIso()): LocalIntakeFormV2 {
    const state = this.intakeState();
    if (state.publicationClosures?.some(row => row.form.publicForm.formId === formId))
      throw new ClayError("E_CONFLICT", "intake publication identity is terminally closed");
    const form = state.forms.find(candidate => candidate.publicForm.formId === formId);
    if (!form) throw new ClayError("E_VALIDATION", "unknown intake form");
    if (form.revokedAt !== null) throw new ClayError("E_CONFLICT", "revoked intake form cannot be published");
    const next = parseLocalIntakeForm({ ...form, publishedAt });
    state.forms[state.forms.indexOf(form)] = next;
    this.writeIntakeState(state);
    return parseLocalIntakeForm(next);
  }

  closeIntakePublication(input: LocalIntakeFormV2, closedAt = nowIso()): IntakePublicationClosureV1 {
    const form = parseLocalIntakeForm(input), state = this.intakeState();
    const identity = (value: LocalIntakeFormV2) => JSON.stringify([value.ownerSource, value.publicForm, value.relayBaseUrl]);
    const current = state.forms.find(row => row.publicForm.formId === form.publicForm.formId);
    const prior = state.publicationClosures?.find(row => row.form.publicForm.formId === form.publicForm.formId);
    if ((current && identity(current) !== identity(form)) || (prior && identity(prior.form) !== identity(form))
        || (!current && form.publishedAt !== null))
      throw new ClayError("E_CONFLICT", "original intake publication definition or identity differs");
    if (prior) return IntakePublicationClosureV1.parse(prior);
    if ((state.publicationClosures?.length ?? 0) >= 100)
      throw new ClayError("E_LIMIT", "intake publication closure capacity reached; originals were kept");
    const closure = IntakePublicationClosureV1.parse({ schema: 1, form, closedAt, terminal: true });
    state.publicationClosures = [...(state.publicationClosures ?? []), closure];
    this.writeIntakeState(state);
    return closure;
  }

  revokeIntakeForm(formId: string, revokedAt = nowIso()): LocalIntakeFormV2 {
    const state = this.intakeState();
    const form = state.forms.find(candidate => candidate.publicForm.formId === formId);
    if (!form) throw new ClayError("E_VALIDATION", "unknown intake form");
    if (form.publishedAt === null) throw new ClayError("E_CONFLICT", "unpublished intake form cannot be revoked");
    // Permanent terminal metadata excludes even an old client's unknown future
    // request ID. A retry must not rewrite the first revocation/expiry receipt.
    if (form.revokedAt !== null) return parseLocalIntakeForm(form);
    const next = parseLocalIntakeForm({ ...form, revokedAt, terminalReason: "revoked" });
    state.forms[state.forms.indexOf(form)] = next;
    state.rules = state.rules.filter(rule => rule.formId !== formId);
    state.simulations = state.simulations.filter(item => item.formId !== formId);
    this.writeIntakeState(state);
    return parseLocalIntakeForm(next);
  }

  markIntakeFormExpired(formId: string, expiredAt = nowIso()): LocalIntakeFormV2 {
    const state = this.intakeState();
    const form = state.forms.find(candidate => candidate.publicForm.formId === formId);
    if (!form) throw new ClayError("E_VALIDATION", "unknown intake form");
    if (form.publishedAt === null)
      throw new ClayError("E_CONFLICT", "unpublished intake form cannot expire");
    if (form.revokedAt !== null) return parseLocalIntakeForm(form);
    if (Date.parse(expiredAt) < Date.parse(form.publicForm.delivery.expiresAt))
      throw new ClayError("E_CONFLICT", "intake form has not expired");
    const next = parseLocalIntakeForm({ ...form, revokedAt: expiredAt, terminalReason: "expired" });
    state.forms[state.forms.indexOf(form)] = next;
    state.rules = state.rules.filter(rule => rule.formId !== formId);
    state.simulations = state.simulations.filter(item => item.formId !== formId);
    this.writeIntakeState(state);
    return parseLocalIntakeForm(next);
  }

  intakeDeliveryFailures(): IntakeDeliveryFailure[] {
    return this.intakeState().deliveryFailures
      .filter(item => item.status === "failed" || item.status === "discard_authorized")
      .map(item => ({ ...item }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  recordIntakeDeliveryFailure(input: Readonly<{
    formId: string;
    submissionId: string;
    envelopeSha256: string;
    failedAt?: string;
  }>): IntakeDeliveryFailure {
    if (typeof input !== "object" || input === null || Array.isArray(input)
        || !/^form_[a-z2-7]{26}$/.test(input.formId)
        || !/^sub_[a-z2-7]{26}$/.test(input.submissionId)
        || !/^[0-9a-f]{64}$/.test(input.envelopeSha256)
        || (input.failedAt !== undefined && (!Number.isFinite(Date.parse(input.failedAt))
          || new Date(input.failedAt).toISOString() !== input.failedAt)))
      throw new ClayError("E_VALIDATION", "failed intake delivery evidence is invalid");
    const state = this.intakeState();
    if (!state.forms.some(form => form.publicForm.formId === input.formId))
      throw new ClayError("E_VALIDATION", "failed intake delivery has no local form");
    const at = input.failedAt ?? nowIso();
    const existing = state.deliveryFailures.find(item =>
      item.formId === input.formId && item.submissionId === input.submissionId);
    if (existing) {
      if (existing.envelopeSha256 !== input.envelopeSha256)
        throw new ClayError("E_CONFLICT", "failed intake delivery identity changed");
      if (existing.status === "failed") existing.updatedAt = at;
      this.writeIntakeState(state);
      return { ...existing };
    }
    if (state.deliveryFailures.length >= 500) {
      state.deliveryFailures = state.deliveryFailures
        .filter(item => item.status === "failed" || item.status === "discard_authorized");
      if (state.deliveryFailures.length >= 500)
        throw new ClayError("E_LIMIT", "failed intake delivery evidence is full");
    }
    const failure: IntakeDeliveryFailure = {
      formId: input.formId,
      submissionId: input.submissionId,
      envelopeSha256: input.envelopeSha256,
      status: "failed", failedAt: at, updatedAt: at,
    };
    state.deliveryFailures.push(failure);
    this.writeIntakeState(state);
    return { ...failure };
  }

  authorizeIntakeDeliveryDiscard(
    formId: string,
    submissionId: string,
    authorizedAt = nowIso(),
  ): IntakeDeliveryFailure {
    if (!Number.isFinite(Date.parse(authorizedAt))
        || new Date(authorizedAt).toISOString() !== authorizedAt)
      throw new ClayError("E_VALIDATION", "discard authorization time is invalid");
    const state = this.intakeState();
    const failure = state.deliveryFailures.find(item =>
      item.formId === formId && item.submissionId === submissionId);
    if (!failure || failure.status !== "failed")
      throw new ClayError("E_CONFLICT", "failed intake delivery is not awaiting owner action");
    failure.status = "discard_authorized";
    failure.updatedAt = authorizedAt;
    this.writeIntakeState(state);
    return { ...failure };
  }

  resolveIntakeDeliveryFailure(
    formId: string,
    submissionId: string,
    resolution: Extract<IntakeDeliveryFailureStatus, "staged" | "discarded">,
    resolvedAt = nowIso(),
  ): IntakeDeliveryFailure | null {
    if (resolution !== "staged" && resolution !== "discarded")
      throw new ClayError("E_VALIDATION", "failed intake delivery resolution is invalid");
    if (!Number.isFinite(Date.parse(resolvedAt))
        || new Date(resolvedAt).toISOString() !== resolvedAt)
      throw new ClayError("E_VALIDATION", "failed intake delivery resolution time is invalid");
    const state = this.intakeState();
    const failure = state.deliveryFailures.find(item =>
      item.formId === formId && item.submissionId === submissionId);
    if (!failure) return null;
    if (resolution === "discarded" && failure.status !== "discard_authorized")
      throw new ClayError("E_CONFLICT", "delivery discard was not durably authorized");
    failure.status = resolution;
    failure.updatedAt = resolvedAt;
    this.writeIntakeState(state);
    return { ...failure };
  }

  stageIntakeSubmission(input: IntakeSubmissionPlaintextV1): IntakeInboxItem {
    const submission = parseIntakeSubmission(input);
    const state = this.intakeState();
    const form = state.forms.find(candidate => candidate.publicForm.formId === submission.formId);
    if (!form || form.publishedAt === null || form.revokedAt !== null)
      throw new ClayError("E_CONFLICT", "intake form is not published and active");
    const resolved = resolveIntakeForm(
      form.publicForm, this.validationRegistrySnapshot(), this.currentVersion(),
    );
    const validation = validateSubmissionForForm(form.publicForm, submission, resolved);
    const storagePayload = splitIntakeSubmissionForStorage(submission, validation.files);
    const existing = state.submissions.find(candidate =>
      candidate.submission.submissionId === submission.submissionId);
    if (existing) {
      if (JSON.stringify(existing.submission) !== JSON.stringify(storagePayload.submission))
        throw new ClayError("E_CONFLICT", "submission identity was reused with different content");
      return intakeInboxItem(existing, form);
    }
    const pending = state.submissions.filter(candidate =>
      candidate.submission.formId === submission.formId
      && (candidate.status === "pending" || candidate.status === "blocked")).length;
    if (pending >= 100) throw new ClayError("E_LIMIT", "local intake inbox is full for this form");
    const liveCount = state.submissions.filter(candidate =>
      candidate.status === "pending" || candidate.status === "blocked").length;
    if (liveCount >= 300) throw new ClayError("E_LIMIT", "local intake inbox is full");
    const localBytes = state.submissions.reduce((sum, candidate) => sum
      + candidate.submission.files.reduce((fileSum, file) => fileSum
        + (candidate.quarantinedFiles.some(bytes => bytes.uploadId === file.uploadId)
          ? file.size : 0), 0), 0);
    const incomingBytes = storagePayload.submission.files.reduce((sum, file) => sum
      + (storagePayload.quarantinedFiles.some(bytes => bytes.uploadId === file.uploadId)
        ? file.size : 0), 0);
    if (!Number.isSafeInteger(localBytes + incomingBytes)
        || localBytes + incomingBytes > 50 * 1024 * 1024)
      throw new ClayError("E_LIMIT", "local intake quarantine is limited to 50 MB");
    const stored = {
      ...storagePayload,
      stagedAt: nowIso(),
      terminalAt: null,
      status: validation.validationErrors.length > 0 ? "blocked" as const : "pending" as const,
      validationErrors: validation.validationErrors,
      files: validation.files,
      receiptId: null,
    };
    state.submissions.push(stored);
    this.writeIntakeState(state);
    return intakeInboxItem(stored, form);
  }

  intakeInbox(): IntakeInboxItem[] {
    const state = this.intakeState();
    const forms = new Map(state.forms.map(form => [form.publicForm.formId, form]));
    return state.submissions
      .map(submission => {
        const form = forms.get(submission.submission.formId);
        if (!form) throw new ClayError("E_VALIDATION", "intake submission has no local form");
        return intakeInboxItem(submission, form);
      })
      .sort((left, right) => right.stagedAt.localeCompare(left.stagedAt)
        || left.submissionId.localeCompare(right.submissionId));
  }

  rejectIntakeSubmission(submissionId: string): IntakeInboxItem {
    const state = this.intakeState();
    const stored = state.submissions.find(item => item.submission.submissionId === submissionId);
    if (!stored) throw new ClayError("E_VALIDATION", "unknown intake submission");
    if (stored.status === "accepted")
      throw new ClayError("E_CONFLICT", "accepted intake must be undone before rejection");
    stored.status = "rejected";
    stored.terminalAt = nowIso();
    stored.quarantinedFiles = [];
    stored.validationErrors = [];
    for (const file of stored.files) {
      if (file.status === "quarantined") {
        file.status = "rejected";
        file.reason = "submission rejected by owner";
      }
    }
    this.writeIntakeState(state);
    const form = state.forms.find(candidate => candidate.publicForm.formId === stored.submission.formId)!;
    return intakeInboxItem(stored, form);
  }

  simulateIntakeAutoAccept(input: IntakeAutoAcceptDraftV1): IntakeAutoAcceptSimulation {
    const draft = parseAutoAcceptDraft(input);
    const state = this.intakeState();
    const form = state.forms.find(candidate => candidate.publicForm.formId === draft.formId);
    if (!form || form.revokedAt !== null || form.publishedAt === null)
      throw new ClayError("E_CONFLICT", "intake form is not published and active");
    if (form.publicForm.fileRequests.length > 0)
      throw new ClayError("E_VALIDATION", "forms with file requests always require owner review");
    if (draft.formRevision !== form.publicForm.revision
        || draft.expectedSchemaVersion !== form.publicForm.target.expectedSchemaVersion)
      throw new ClayError("E_CONFLICT", "auto-accept draft targets another form or schema revision");
    resolveIntakeForm(form.publicForm, this.validationRegistrySnapshot(), this.currentVersion());
    const allowed = new Set(form.publicForm.fields.map(field => field.fieldId));
    if (draft.conditions.some(condition => !allowed.has(condition.fieldId)))
      throw new ClayError("E_VALIDATION", "auto-accept can only inspect published scalar fields");
    const pending = state.submissions.filter(item =>
      item.submission.formId === draft.formId && item.status === "pending");
    const simulation: IntakeAutoAcceptSimulation = {
      formId: draft.formId,
      fingerprint: autoAcceptFingerprint(form.publicForm, draft),
      simulatedAt: nowIso(),
      pendingCount: pending.length,
      matchedSubmissionIds: pending
        .filter(item => submissionMatchesAutoRule(item.submission, draft))
        .map(item => item.submission.submissionId)
        .sort(),
    };
    state.simulations = state.simulations.filter(item => item.formId !== draft.formId);
    state.simulations.push(simulation);
    this.writeIntakeState(state);
    return { ...simulation, matchedSubmissionIds: [...simulation.matchedSubmissionIds] };
  }

  enableIntakeAutoAccept(input: {
    draft: IntakeAutoAcceptDraftV1;
    simulationFingerprint: string;
  }): IntakeLocalStateV2["rules"][number] {
    if (typeof input !== "object" || input === null || Array.isArray(input)
        || Reflect.getPrototypeOf(input) !== Object.prototype
        || Reflect.ownKeys(input).length !== 2
        || typeof input.simulationFingerprint !== "string"
        || !/^[0-9a-f]{64}$/.test(input.simulationFingerprint))
      throw new ClayError("E_VALIDATION", "auto-accept enablement request is invalid");
    const draft = parseAutoAcceptDraft(input.draft);
    const state = this.intakeState();
    const form = state.forms.find(candidate => candidate.publicForm.formId === draft.formId);
    if (!form || form.revokedAt !== null || form.publishedAt === null)
      throw new ClayError("E_CONFLICT", "intake form is not published and active");
    if (form.publicForm.fileRequests.length > 0)
      throw new ClayError("E_VALIDATION", "forms with file requests always require owner review");
    if (draft.formRevision !== form.publicForm.revision
        || draft.expectedSchemaVersion !== form.publicForm.target.expectedSchemaVersion)
      throw new ClayError("E_CONFLICT", "auto-accept draft targets another form or schema revision");
    resolveIntakeForm(form.publicForm, this.validationRegistrySnapshot(), this.currentVersion());
    const fingerprint = autoAcceptFingerprint(form.publicForm, draft);
    const simulation = state.simulations.find(candidate => candidate.formId === draft.formId);
    if (!simulation || simulation.fingerprint !== fingerprint
        || input.simulationFingerprint !== fingerprint)
      throw new ClayError("E_CONFLICT", "run and review this exact auto-accept simulation first");
    const enabledAt = nowIso();
    const rule: IntakeLocalStateV2["rules"][number] = {
      ...draft,
      enabled: true,
      simulationFingerprint: fingerprint,
      simulatedAt: simulation.simulatedAt,
      enabledAt,
    };
    state.rules = state.rules.filter(candidate => candidate.formId !== draft.formId);
    state.rules.push(rule);
    this.writeIntakeState(state);
    return { ...rule, conditions: rule.conditions.map(condition => ({ ...condition })) };
  }

  disableIntakeAutoAccept(formId: string): void {
    const state = this.intakeState();
    if (!state.rules.some(rule => rule.formId === formId)) return;
    state.rules = state.rules.filter(rule => rule.formId !== formId);
    this.writeIntakeState(state);
  }

  processIntakeAutoAccept(formId: string): IntakeAcceptanceReceipt[] {
    const state = this.intakeState();
    const form = state.forms.find(candidate => candidate.publicForm.formId === formId);
    const rule = state.rules.find(candidate => candidate.formId === formId);
    if (!form || !rule || !rule.enabled)
      throw new ClayError("E_CONFLICT", "automatic acceptance is not enabled for this form");
    if (form.publicForm.fileRequests.length > 0)
      throw new ClayError("E_VALIDATION", "forms with file requests always require owner review");
    if (rule.formRevision !== form.publicForm.revision
        || rule.expectedSchemaVersion !== form.publicForm.target.expectedSchemaVersion
        || rule.simulationFingerprint !== autoAcceptFingerprint(form.publicForm, {
          schema: rule.schema,
          formId: rule.formId,
          formRevision: rule.formRevision,
          expectedSchemaVersion: rule.expectedSchemaVersion,
          conditions: rule.conditions,
        }))
      throw new ClayError("E_CONFLICT", "auto-accept rule is stale");
    resolveIntakeForm(form.publicForm, this.validationRegistrySnapshot(), this.currentVersion());
    const matches = state.submissions.filter(item => item.submission.formId === formId
      && item.status === "pending" && submissionMatchesAutoRule(item.submission, rule))
      .map(item => item.submission.submissionId).sort();
    return this.#driver.tx(() => matches.map(submissionId => this.acceptIntakeSubmission({
      submissionId, mode: "auto", approvedFileIds: [],
    })));
  }

  acceptIntakeSubmission(input: {
    submissionId: string;
    mode: "manual" | "auto";
    approvedFileIds: string[];
  }): IntakeAcceptanceReceipt {
    if (typeof input !== "object" || input === null || Array.isArray(input)
        || Reflect.getPrototypeOf(input) !== Object.prototype
        || Reflect.ownKeys(input).length !== 3
        || typeof input.submissionId !== "string"
        || (input.mode !== "manual" && input.mode !== "auto")
        || !Array.isArray(input.approvedFileIds)
        || input.approvedFileIds.length > 15
        || input.approvedFileIds.some(id => typeof id !== "string" || !/^upl_[a-z2-7]{26}$/.test(id))
        || new Set(input.approvedFileIds).size !== input.approvedFileIds.length)
      throw new ClayError("E_VALIDATION", "intake acceptance request is invalid");

    const state = this.intakeState();
    const stored = state.submissions.find(item => item.submission.submissionId === input.submissionId);
    if (!stored) throw new ClayError("E_VALIDATION", "unknown intake submission");
    if (stored.status !== "pending")
      throw new ClayError("E_CONFLICT", "only a pending validated submission can be accepted");
    const form = state.forms.find(candidate => candidate.publicForm.formId === stored.submission.formId);
    if (!form || form.revokedAt !== null)
      throw new ClayError("E_CONFLICT", "intake form is not active");
    if (input.mode === "auto") {
      const rule = state.rules.find(candidate => candidate.formId === form.publicForm.formId);
      if (input.approvedFileIds.length !== 0 || form.publicForm.fileRequests.length !== 0
          || !rule || !rule.enabled
          || rule.formRevision !== form.publicForm.revision
          || rule.expectedSchemaVersion !== form.publicForm.target.expectedSchemaVersion
          || !submissionMatchesAutoRule(stored.submission, rule)
          || rule.simulationFingerprint !== autoAcceptFingerprint(form.publicForm, {
            schema: rule.schema,
            formId: rule.formId,
            formRevision: rule.formRevision,
            expectedSchemaVersion: rule.expectedSchemaVersion,
            conditions: rule.conditions,
          }))
        throw new ClayError("E_CONFLICT", "automatic acceptance is not enabled for this submission");
    }
    const resolved = resolveIntakeForm(
      form.publicForm, this.validationRegistrySnapshot(), this.currentVersion(),
    );
    const hydrated = hydrateStoredIntakeSubmission(stored);
    const validation = validateSubmissionForForm(form.publicForm, hydrated, resolved);
    if (validation.validationErrors.length > 0)
      throw new ClayError("E_VALIDATION", "quarantined files failed local validation",
        validation.validationErrors);
    const approved = new Set(input.approvedFileIds);
    if ([...approved].some(id => !validation.fileBytes.has(id)))
      throw new ClayError("E_VALIDATION", "only locally validated quarantined files can be approved");
    for (const request of form.publicForm.fileRequests) {
      if (request.required && !hydrated.files.some(file =>
        file.requestId === request.requestId && approved.has(file.uploadId)))
        throw new ClayError("E_VALIDATION", `review and approve a file for '${request.label}'`);
    }

    const selectedUploads = hydrated.files.filter(file => approved.has(file.uploadId));
    const storage = this.attachmentStorage();
    const selectedBytes = selectedUploads.reduce((sum, upload) => sum + upload.size, 0);
    if (storage.activeBytes + selectedBytes > MAX_APP_ATTACHMENT_BYTES)
      throw new ClayError("E_LIMIT", "this app is limited to 200 MB of active files");
    if (storage.activeBytes + storage.deletedBytes + selectedBytes > MAX_RETAINED_ATTACHMENT_BYTES)
      throw new ClayError("E_LIMIT", "this app is limited to 250 MB of retained files");

    return this.#driver.tx(() => {
      const batch = this.applyBatch({
        source: "user",
        summary: `Accepted ${form.publicForm.title} submission`,
        mutations: [{ kind: "insert", table: resolved.table.name, row: validation.row }],
      });
      const rowId = batch.created[0]?.id;
      if (!rowId) throw new ClayError("E_INTERNAL", "intake acceptance did not create its target record");
      const acceptedAt = nowIso();
      const attachmentByUpload = new Map<string, string>();
      const grouped = new Map<string, string[]>();
      for (const upload of selectedUploads) {
        const request = form.publicForm.fileRequests.find(candidate =>
          candidate.requestId === upload.requestId)!;
        const column = resolved.fileFields.get(request.requestId)!;
        const bytes = validation.fileBytes.get(upload.uploadId)!;
        const identity = safeAttachmentIdentity(upload.name, upload.mime);
        validateAttachmentSignature(bytes, identity.mime);
        const id = `file_${uuidv7().replaceAll("-", "")}`;
        this.#driver.exec(
          `INSERT INTO "__clay_attachments"(
             id, name, mime, size, sha256, bytes, created_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          [id, identity.name, identity.mime, bytes.byteLength, upload.sha256, bytes, acceptedAt]);
        attachmentByUpload.set(upload.uploadId, id);
        grouped.set(column.name, [...(grouped.get(column.name) ?? []), id]);
      }
      for (const [field, ids] of grouped) this.#driver.exec(
        `UPDATE ${qid(resolved.table.name)} SET ${qid(field)} = ?, "updated_at" = ? WHERE "id" = ?`,
        [JSON.stringify(ids), acceptedAt, rowId],
      );
      if (grouped.size > 0)
        this.recordRowEvent(resolved.table.name, rowId, "updated", [...grouped.keys()]);
      const finalRow = this.#driver.select(
        `SELECT * FROM ${qid(resolved.table.name)} WHERE "id" = ?`, [rowId],
      )[0];
      if (!finalRow) throw new ClayError("E_INTERNAL", "accepted intake record disappeared");
      this.#driver.exec(
        `UPDATE "row_history" SET "after_json" = ?
         WHERE "batch_id" = ? AND "row_id" = ? AND "change_kind" = 'create'`,
        [JSON.stringify(finalRow), batch.id, rowId],
      );
      const receipt: IntakeAcceptanceReceipt = {
        id: mintIntakeReceiptId(),
        submissionId: stored.submission.submissionId,
        formId: form.publicForm.formId,
        mode: input.mode,
        batchId: batch.id,
        table: resolved.table.name,
        rowId,
        attachmentIds: [...attachmentByUpload.values()],
        acceptedAt,
        undoneAt: null,
        undone: false,
      };
      for (const file of stored.files) {
        const attachmentId = attachmentByUpload.get(file.uploadId);
        if (attachmentId) {
          file.status = "activated";
          file.reason = null;
          file.attachmentId = attachmentId;
        } else if (file.status === "quarantined") {
          file.status = "rejected";
          file.reason = "file was not approved by the owner";
        }
      }
      stored.status = "accepted";
      stored.terminalAt = acceptedAt;
      stored.receiptId = receipt.id;
      stored.validationErrors = [];
      stored.quarantinedFiles = [];
      const selectedIds = new Set(selectedUploads.map(upload => upload.uploadId));
      stored.submission.files = stored.submission.files.filter(file => selectedIds.has(file.uploadId));
      state.receipts.push(receipt);
      this.writeIntakeState(state);
      return { ...receipt, attachmentIds: [...receipt.attachmentIds] };
    });
  }

  intakeReceipts(): IntakeAcceptanceReceipt[] {
    return this.intakeState().receipts.map(receipt => ({
      ...receipt, attachmentIds: [...receipt.attachmentIds],
    })).sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt));
  }

  undoIntakeReceipt(receiptId: string): IntakeAcceptanceReceipt {
    const state = this.intakeState();
    const receipt = state.receipts.find(candidate => candidate.id === receiptId);
    if (!receipt) throw new ClayError("E_VALIDATION", "unknown intake receipt");
    if (receipt.undone) throw new ClayError("E_CONFLICT", "intake receipt is already undone");
    const stored = state.submissions.find(candidate =>
      candidate.submission.submissionId === receipt.submissionId);
    if (!stored || stored.receiptId !== receipt.id || stored.status !== "accepted")
      throw new ClayError("E_CONFLICT", "intake receipt and inbox state do not agree");
    return this.#driver.tx(() => {
      const restoredQuarantine: Array<{ uploadId: string; bytes: string }> = [];
      for (const file of stored.files) {
        if (file.attachmentId === null || !receipt.attachmentIds.includes(file.attachmentId)) continue;
        const row = this.#driver.select(
          `SELECT bytes, size, sha256, mime FROM "__clay_attachments" WHERE "id" = ?`,
          [file.attachmentId],
        )[0];
        if (!row || !(row.bytes instanceof Uint8Array)
            || Number(row.size) !== file.size || String(row.sha256) !== file.sha256
            || String(row.mime) !== file.mime)
          throw new ClayError("E_CONFLICT", "accepted attachment is unavailable for intake undo");
        validateAttachmentSignature(row.bytes, file.mime);
        restoredQuarantine.push({ uploadId: file.uploadId, bytes: encodeIntakeFileBytes(row.bytes) });
      }
      this.undoBatch(receipt.batchId);
      const undoneAt = nowIso();
      for (const attachmentId of receipt.attachmentIds)
        this.#driver.exec(
          `UPDATE "__clay_attachments" SET "deleted_at" = ?
           WHERE "id" = ? AND "deleted_at" IS NULL`, [undoneAt, attachmentId],
        );
      for (const file of stored.files) {
        if (file.attachmentId !== null && receipt.attachmentIds.includes(file.attachmentId)) {
          file.status = "quarantined";
          file.reason = null;
          file.attachmentId = null;
        }
      }
      receipt.undone = true;
      receipt.undoneAt = undoneAt;
      stored.status = "pending";
      stored.terminalAt = null;
      stored.quarantinedFiles = restoredQuarantine;
      stored.receiptId = null;
      this.writeIntakeState(state);
      return { ...receipt, attachmentIds: [...receipt.attachmentIds] };
    });
  }

  private async attachmentIntegrityIssues(manifest?: ClayManifest): Promise<string[]> {
    const issues: string[] = [];
    const rows = this.#driver.select(`SELECT * FROM "__clay_attachments"`);
    const retained = new Set<string>();
    const active = new Set<string>();
    let activeBytes = 0;
    let retainedBytes = 0;
    for (const row of rows) {
      const id = String(row.id);
      retained.add(id);
      const size = Number(row.size);
      retainedBytes += Number.isFinite(size) ? size : 0;
      try {
        const identity = safeAttachmentIdentity(String(row.name), String(row.mime));
        if (row.bytes instanceof Uint8Array) validateAttachmentSignature(row.bytes, identity.mime);
      } catch { issues.push(`attachment metadata or signature is invalid for '${id}'`); }
      if (!/^file_[0-9a-f]{32}$/.test(id)
          || !Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES
          || !(row.bytes instanceof Uint8Array) || row.bytes.byteLength !== size
          || !/^[0-9a-f]{64}$/.test(String(row.sha256))
          || (row.bytes instanceof Uint8Array && await sha256(row.bytes) !== String(row.sha256))) {
        issues.push(`attachment integrity failed for '${id}'`);
      }
      if (!Number.isFinite(Date.parse(String(row.created_at)))
          || (row.deleted_at !== null && !Number.isFinite(Date.parse(String(row.deleted_at)))))
        issues.push(`attachment timestamps are invalid for '${id}'`);
      if (row.deleted_at === null) { active.add(id); activeBytes += size; }
    }
    const activeReferenced = new Set<string>();
    const recoverableReferenced = new Set<string>();
    for (const table of this.reg.values()) {
      for (const column of table.columns.filter(candidate =>
        candidate.type === "attachment")) {
        for (const row of this.#driver.select(
          `SELECT ${qid(column.name)} AS value, "deleted_at" FROM ${qid(table.name)}
           WHERE ${qid(column.name)} IS NOT NULL`)) {
          try {
            const ids = JSON.parse(String(row.value)) as unknown;
            if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_FIELD
                || !ids.every(id => typeof id === "string" && /^file_[0-9a-f]{32}$/.test(id))
                || new Set(ids).size !== ids.length) throw new Error();
            for (const id of ids) {
              recoverableReferenced.add(id);
              if (row.deleted_at === null) {
                activeReferenced.add(id);
                if (!active.has(id)) issues.push(`active attachment field references deleted file '${id}'`);
              }
            }
          } catch { issues.push(`attachment field '${table.name}.${column.name}' is invalid`); }
        }
      }
    }
    for (const history of this.#driver.select(
      `SELECT "table", "before_json", "change_kind" FROM "row_history"`)) {
      const table = this.reg.get(String(history.table));
      if (!table) continue;
      try {
        const before = JSON.parse(String(history.before_json)) as unknown;
        if (before === null && history.change_kind === "create") continue;
        if (typeof before !== "object" || before === null || Array.isArray(before)) throw new Error();
        for (const column of table.columns.filter(candidate => candidate.type === "attachment")) {
          const raw = (before as Record<string, unknown>)[column.name];
          if (raw === null || raw === undefined) continue;
          const ids = JSON.parse(String(raw)) as unknown;
          if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_FIELD
              || !ids.every(id => typeof id === "string" && /^file_[0-9a-f]{32}$/.test(id)))
            throw new Error();
          for (const id of ids) {
            recoverableReferenced.add(id);
          }
        }
      } catch { issues.push(`attachment history for '${String(history.table)}' is invalid`); }
    }
    for (const id of recoverableReferenced) if (!retained.has(id))
      issues.push(`recoverable attachment references missing file '${id}'`);
    for (const id of active) if (!activeReferenced.has(id))
      issues.push(`active attachment '${id}' is orphaned`);
    if (activeBytes > MAX_APP_ATTACHMENT_BYTES)
      issues.push("active attachment bytes exceed the 200 MB app limit");
    if (retainedBytes > MAX_RETAINED_ATTACHMENT_BYTES)
      issues.push("retained attachment bytes exceed the 250 MB app limit");
    if (manifest?.attachments
        && (manifest.attachments.count !== active.size || manifest.attachments.bytes !== activeBytes))
      issues.push("attachment manifest counts do not match stored files");
    return issues;
  }

  private automationIntegrityIssues(): string[] {
    const issues: string[] = [];
    for (const row of this.#driver.select(
      `SELECT id, definition_json, created_at, updated_at, last_event_seq FROM sys.automations`,
    )) {
      const id = String(row.id);
      try {
        const input = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
        if (input.v === 2) {
          const definition = this.automationDefinitionV2FromRow(row);
          if (definition.id !== id) throw new Error("identity mismatch");
        } else {
          if (input.id !== id) throw new Error("legacy identity mismatch");
          validateAutomationDefinition(this.reg, input as unknown as AutomationDefinitionInput);
        }
        if (!Number.isSafeInteger(Number(row.last_event_seq)) || Number(row.last_event_seq) < 0
            || !Number.isFinite(Date.parse(String(row.created_at)))
            || !Number.isFinite(Date.parse(String(row.updated_at))))
          issues.push(`automation '${id}' metadata is invalid`);
      } catch {
        issues.push(`automation '${id}' definition is invalid`);
      }
    }
    return issues;
  }

  private assertAutomationsCompatible(): void {
    const issues = this.automationIntegrityIssues();
    if (issues.length > 0)
      throw new ClayError("E_VALIDATION",
        `schema change would invalidate an automation rule: ${issues.join("; ")}`, issues);
  }

  private automationDefinitionV2FromRow(row: SqlRow): AutomationDefinitionV2 {
    const raw = JSON.parse(String(row.definition_json)) as AutomationDraftInputV2 & {
      definitionRevision?: unknown;
      state?: unknown;
      enableProof?: unknown;
      authorityTarget?: unknown;
      authorityDefinitionRevision?: unknown;
      authorityDefinitionDigest?: unknown;
    };
    if (typeof raw.id !== "string" || raw.id !== String(row.id))
      throw new ClayError("E_VALIDATION", "stored automation identity does not match its row");
    if (raw.v !== 2 || !Number.isSafeInteger(raw.definitionRevision)
        || Number(raw.definitionRevision) < 1
        || (raw.state !== "draft" && raw.state !== "simulated" && raw.state !== "enabled"
          && raw.state !== "paused" && raw.state !== "error"))
      throw new ClayError("E_VALIDATION", "stored automation V2 metadata is invalid");
    const resolved = resolveAutomationDraftV2(this.reg, raw);
    const revision = Number(raw.definitionRevision);
    const digest = automationDefinitionDigest(resolved.stored);
    const rawAuthorityTarget = raw.authorityTarget ?? automationTargetFromJson(row.authority_target_json);
    const authorityTarget = rawAuthorityTarget === null || rawAuthorityTarget === undefined
      ? null : validateAutomationTargetIdentity(rawAuthorityTarget as AutomationTargetIdentityV1);
    const authorityDefinitionRevision = raw.authorityDefinitionRevision === null
      || raw.authorityDefinitionRevision === undefined
      ? (row.authority_definition_revision === null || row.authority_definition_revision === undefined
        ? null : Number(row.authority_definition_revision))
      : Number(raw.authorityDefinitionRevision);
    const authorityDefinitionDigest = raw.authorityDefinitionDigest === null
      || raw.authorityDefinitionDigest === undefined
      ? (typeof row.authority_definition_digest === "string" ? row.authority_definition_digest : null)
      : String(raw.authorityDefinitionDigest);
    const enableProof = raw.state === "enabled" || raw.state === "error"
      ? validateAutomationEnableProof(raw.enableProof, {
        automationId: raw.id,
        definitionRevision: revision,
        definitionDigest: digest,
      })
      : null;
    if (raw.state === "enabled" && (!enableProof || !authorityTarget
        || authorityDefinitionRevision !== revision || authorityDefinitionDigest !== digest
        || !sameAutomationTarget(enableProof.target, authorityTarget)))
      throw new ClayError("E_VALIDATION", "enabled automation authority binding is missing or stale");
    if (raw.state !== "enabled" && raw.state !== "error" && raw.enableProof !== null)
      throw new ClayError("E_VALIDATION", "disabled automation must not retain an enable proof");
    return {
      ...resolved.stored,
      id: String(row.id),
      definitionRevision: revision,
      state: raw.state,
      enabled: raw.state === "enabled",
      needsRepair: false,
      enableProof,
      authorityTarget,
      authorityDefinitionRevision,
      authorityDefinitionDigest,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  automationRecipes(): AutomationRecipeCardV1[] {
    return automationRecipeCatalog(this.reg);
  }

  automationRuntimeStatus(target: AutomationTargetIdentityV1): AutomationRuntimeStatusV1 {
    const definitions = this.listAutomations(validateAutomationTargetIdentity(target));
    const enabledDefinitions = definitions.filter(definition => definition.enabled).length;
    return Object.freeze({
      v: 1,
      engine: "local_worker_session",
      sessionActive: true,
      backgroundExecution: false,
      offDeviceExecution: false,
      modelAccess: false,
      networkAccess: false,
      headline: "Automations run on this device while Clay is open.",
      detail: "If Clay is closed or this device sleeps, scheduled work waits until a Clay session is available.",
      enabledDefinitions,
      disabledDefinitions: definitions.length - enabledDefinitions,
      needsRepairDefinitions: definitions.filter(definition => definition.needsRepair).length,
    });
  }

  private automationNextState(definition: AutomationDefinitionAny):
  AutomationRuleRuntimeStateV1["next"] {
    const trigger = definition.trigger;
    if (trigger.kind === "manual") return Object.freeze({
      kind: "manual" as const,
      detail: "When you preview and confirm Run while Clay is open.",
    });
    if (trigger.kind === "schedule") {
      const weekday = trigger.cadence === "weekly"
        ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
          [trigger.weekday ?? 0] : null;
      const timeZone = definition.v === 2 ? definition.runtime.timeZone : undefined;
      return Object.freeze({
        kind: "schedule" as const,
        detail: `${trigger.cadence === "daily" ? "Daily" : weekday} at ${trigger.localTime}`
          + `${timeZone ? ` (${timeZone})` : ""}, when Clay is open.`,
      });
    }
    const table = typeof trigger.table === "string" ? trigger.table : trigger.table.lastKnownName;
    if (trigger.kind === "record_created") return Object.freeze({
      kind: "event" as const,
      detail: `When a new ${table} record is created while Clay is open.`,
    });
    if (trigger.kind === "record_updated") return Object.freeze({
      kind: "event" as const,
      detail: `When a ${table} record is updated while Clay is open.`,
    });
    if (trigger.kind === "record_matches") return Object.freeze({
      kind: "event" as const,
      detail: `When a ${table} record newly matches while Clay is open.`,
    });
    if (!("dateField" in trigger) || !("daysBefore" in trigger))
      throw new ClayError("E_INTERNAL", "automation trigger projection is incomplete");
    const dateField = typeof trigger.dateField === "string"
      ? trigger.dateField : trigger.dateField.lastKnownName;
    return Object.freeze({
      kind: "event" as const,
      detail: `When ${table}.${dateField} reaches ${trigger.daysBefore} day${trigger.daysBefore === 1 ? "" : "s"} before due while Clay is open.`,
    });
  }

  private automationSkipState(
    definition: AutomationDefinitionAny,
    target: AutomationTargetIdentityV1,
    now: Date,
  ):
  AutomationRuleRuntimeStateV1["skip"] {
    if (definition.needsRepair) return Object.freeze({
      code: "REVIEW_REQUIRED_AFTER_UPGRADE" as const,
      detail: "Skipped because this older rule needs review after upgrade and is disabled.",
    });
    if (definition.enabled) {
      if (definition.v === 2 && definition.trigger.kind === "schedule"
          && definition.runtime.missedPolicy === "skip") {
        const clock = automationClock(now, definition.runtime.timeZone);
        const [hour, minute] = definition.trigger.localTime.split(":").map(Number);
        const scheduleMinutes = hour! * 60 + minute!;
        const appliesToday = definition.trigger.cadence === "daily"
          || clock.weekday === definition.trigger.weekday;
        const day = `${clock.year}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
        if (appliesToday && clock.hour * 60 + clock.minute > scheduleMinutes
            && !this.automationTriggerSucceeded(definition, target, `schedule:${day}`)) return Object.freeze({
          code: "MISSED_SCHEDULE_WINDOW" as const,
          detail: `Skipped because the ${definition.trigger.localTime} local schedule window passed and this rule is set to skip missed runs.`,
        });
      }
      return null;
    }
    if (definition.state === "paused") return Object.freeze({
      code: "PAUSED" as const,
      detail: "Skipped because this rule is paused; resume it only after a fresh simulation.",
    });
    if (definition.state === "error") return Object.freeze({
      code: "ERROR_DISABLED" as const,
      detail: "Skipped because this rule is disabled after an error and needs review.",
    });
    return Object.freeze({
      code: "DRAFT_DISABLED" as const,
      detail: "Skipped because this draft is disabled until its current simulation is approved.",
    });
  }

  private automationRunRuntimeState(
    run: AutomationRun,
    target: AutomationTargetIdentityV1,
  ): AutomationRunRuntimeStateV1 {
    if (!sameAutomationLineage(run.target, target)) return Object.freeze({
      v: 1 as const,
      runId: run.id,
      failure: null,
      undo: Object.freeze({
        available: false,
        reason: "FOREIGN_TARGET" as const,
        detail: "This receipt belongs to another target and is available for audit only.",
      }),
    });
    if (run.status === "failed") return Object.freeze({
      v: 1 as const,
      runId: run.id,
      failure: Object.freeze({
        code: run.errorCode ?? "E_INTERNAL",
        detail: "The run failed safely; no partial changes were kept.",
      }),
      undo: Object.freeze({
        available: false,
        reason: "RUN_FAILED" as const,
        detail: "A failed run has no retained changes to undo.",
      }),
    });
    if (run.undone) return Object.freeze({
      v: 1 as const,
      runId: run.id,
      failure: null,
      undo: Object.freeze({
        available: false,
        reason: "ALREADY_UNDONE" as const,
        detail: "This run was already undone.",
      }),
    });
    if (run.batchId !== null) {
      const batch = this.#driver.select(
        `SELECT changed_count, undone_at FROM sys.operation_batches WHERE id = ?`, [run.batchId],
      )[0];
      const entries = this.#driver.select(
        `SELECT "table", "row_id", "after_json" FROM "row_history"
         WHERE "batch_id" = ? ORDER BY "sequence" DESC`, [run.batchId]);
      if (!batch || batch.undone_at !== null || entries.length !== Number(batch.changed_count))
        return Object.freeze({
          v: 1 as const, runId: run.id, failure: null,
          undo: Object.freeze({
            available: false,
            reason: "HISTORY_MISSING" as const,
            detail: "Undo is unavailable because the exact retained history is no longer complete.",
          }),
        });
      for (const entry of entries) {
        let current: SqlRow | undefined;
        try {
          getTable(this.reg, String(entry.table));
          current = this.#driver.select(
            `SELECT * FROM ${qid(String(entry.table))} WHERE "id" = ?`, [String(entry.row_id)],
          )[0];
        } catch { current = undefined; }
        if (!current || JSON.stringify(current) !== String(entry.after_json)) return Object.freeze({
          v: 1 as const, runId: run.id, failure: null,
          undo: Object.freeze({
            available: false,
            reason: "RECORD_CHANGED" as const,
            detail: "Undo is unavailable because a record changed after this run.",
          }),
        });
      }
    }
    return Object.freeze({
      v: 1 as const,
      runId: run.id,
      failure: null,
      undo: Object.freeze({
        available: true,
        reason: "AVAILABLE" as const,
        detail: run.batchId === null
          ? "Undo will dismiss reminders created by this run."
          : "Undo is available while the affected records remain unchanged.",
      }),
    });
  }

  automationRuntimeOverview(
    target: AutomationTargetIdentityV1,
    limit = 100,
    now: Date = new Date(),
  ): AutomationRuntimeOverviewV1 {
    const currentTarget = validateAutomationTargetIdentity(target);
    if (!Number.isFinite(now.getTime()))
      throw new ClayError("E_VALIDATION", "automation runtime status time is invalid");
    const definitions = this.listAutomations(currentTarget);
    const runs = this.automationRuns(currentTarget, undefined, limit);
    const latestRuns = new Map(definitions.map(definition => [
      definition.id, this.automationRuns(currentTarget, definition.id, 1)[0] ?? null,
    ]));
    const runtimeRuns = [...latestRuns.values(), ...runs]
      .filter((run): run is AutomationRun => run !== null)
      .filter((run, index, all) => all.findIndex(candidate => candidate.id === run.id) === index);
    return Object.freeze({
      v: 1 as const,
      rules: Object.freeze(definitions.map(definition => {
        const last = latestRuns.get(definition.id) ?? null;
        return Object.freeze({
          v: 1 as const,
          automationId: definition.id,
          lastRunId: last?.id ?? null,
          lastRun: last,
          next: this.automationNextState(definition),
          skip: this.automationSkipState(definition, currentTarget, now),
        });
      })),
      runs: Object.freeze(runtimeRuns.map(run => this.automationRunRuntimeState(run, currentTarget))),
    });
  }

  saveAutomationRecipeDraft(
    request: AutomationRecipeDraftRequestV1,
    now: Date = new Date(),
  ): AutomationDefinitionV2 {
    return this.saveAutomationDraft(compileAutomationRecipeDraft(this.reg, request), undefined, now);
  }

  saveAutomationDraft(
    input: AutomationDraftInputV2,
    expectedRevision?: number,
    now: Date = new Date(),
  ): AutomationDefinitionV2 {
    const resolved = resolveAutomationDraftV2(this.reg, input);
    const current = resolved.stored.id
      ? this.#driver.select(
        `SELECT id, definition_json, created_at, updated_at, last_event_seq
         FROM sys.automations WHERE id = ?`, [resolved.stored.id],
      )[0]
      : undefined;
    if (resolved.stored.id && !current)
      throw new ClayError("E_VALIDATION", "unknown automation");
    let revision = 1;
    if (current) {
      const rawCurrent = JSON.parse(String(current.definition_json)) as Record<string, unknown>;
      if (rawCurrent.v === 2) {
        const prior = this.automationDefinitionV2FromRow(current);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== prior.definitionRevision)
          throw new ClayError("E_CONFLICT", "automation definition revision changed");
        revision = prior.definitionRevision + 1;
      } else {
        if (rawCurrent.id !== String(current.id))
          throw new ClayError("E_VALIDATION", "legacy automation identity does not match its row");
        validateAutomationDefinition(this.reg, rawCurrent as unknown as AutomationDefinitionInput);
        if (expectedRevision !== 0)
          throw new ClayError("E_CONFLICT", "legacy automation repair requires expected revision 0");
      }
    } else if (expectedRevision !== undefined) {
      throw new ClayError("E_CONFLICT", "new automation cannot have an expected revision");
    }
    if (!Number.isFinite(now.getTime()))
      throw new ClayError("E_VALIDATION", "automation draft time is invalid");
    const wallClock = now.toISOString();
    const at = current && wallClock <= String(current.updated_at)
      ? new Date(Date.parse(String(current.updated_at)) + 1).toISOString() : wallClock;
    const id = resolved.stored.id ?? `auto_${uuidv7().replaceAll("-", "")}`;
    const maxSeq = Number(this.#driver.select(
      `SELECT COALESCE(MAX(seq), 0) AS n FROM sys.record_events`,
    )[0]?.n ?? 0);
    const cursor = current ? Number(current.last_event_seq) : maxSeq;
    const stored = {
      ...resolved.stored,
      id,
      definitionRevision: revision,
      state: "draft" as const,
      enableProof: null,
      authorityTarget: null,
      authorityDefinitionRevision: null,
      authorityDefinitionDigest: null,
    };
    this.#driver.exec(
      `INSERT INTO sys.automations(
         id, definition_json, created_at, updated_at, last_event_seq,
         authority_target_json, authority_definition_revision, authority_definition_digest,
         cursor_target_json, cursor_definition_revision, cursor_definition_digest,
         storage_version)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 2)
       ON CONFLICT(id) DO UPDATE SET definition_json = excluded.definition_json,
         updated_at = excluded.updated_at, last_event_seq = excluded.last_event_seq,
         authority_target_json = NULL, authority_definition_revision = NULL,
         authority_definition_digest = NULL, cursor_target_json = NULL,
         cursor_definition_revision = NULL, cursor_definition_digest = NULL,
         last_schedule_period = NULL, schedule_target_json = NULL,
         schedule_definition_revision = NULL, schedule_definition_digest = NULL,
         storage_version = 2`,
      [id, JSON.stringify(stored), current ? String(current.created_at) : at, at, cursor],
    );
    return {
      ...resolved.stored,
      id,
      definitionRevision: revision,
      state: "draft",
      enabled: false,
      needsRepair: false,
      enableProof: null,
      authorityTarget: null,
      authorityDefinitionRevision: null,
      authorityDefinitionDigest: null,
      createdAt: current ? String(current.created_at) : at,
      updatedAt: at,
    };
  }

  enableAutomation(
    request: AutomationEnableRequestV1,
    now: Date = new Date(),
  ): AutomationDefinitionV2 {
    if (!Number.isFinite(now.getTime()))
      throw new ClayError("E_VALIDATION", "automation enable time is invalid");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
        || typeof request.id !== "string" || !request.simulation)
      throw new ClayError("E_VALIDATION", "automation enable request is invalid");
    const simulation = validateAutomationSimulationProof(request.simulation);
    if (simulation.purpose !== "enable")
      throw new ClayError("E_VALIDATION", "automation enable request is invalid");
    const target = validateAutomationTargetIdentity(request.target);
    const evaluatedMs = Date.parse(simulation.evaluatedAt);
    const expiryMs = Date.parse(simulation.expiresAt);
    if (!Number.isFinite(evaluatedMs) || !Number.isFinite(expiryMs)
        || evaluatedMs > now.getTime() || expiryMs < now.getTime())
      throw new ClayError("E_CONFLICT", "automation simulation proof expired or has invalid time");
    if (stableAutomationJson(simulation.target) !== stableAutomationJson(target)
        || simulation.automationId !== request.id
        || simulation.definitionRevision !== request.expectedRevision)
      throw new ClayError("E_CONFLICT", "automation simulation proof target or revision is stale");

    return this.#driver.tx(() => {
      const row = this.#driver.select(
        `SELECT id, definition_json, created_at, updated_at, last_event_seq
         FROM sys.automations WHERE id = ?`, [request.id],
      )[0];
      if (!row) throw new ClayError("E_VALIDATION", "unknown automation");
      const current = this.automationDefinitionV2FromRow(row);
      if (current.definitionRevision !== request.expectedRevision || current.state === "enabled")
        throw new ClayError("E_CONFLICT", "automation definition state or revision changed");
      const exact = this.simulateAutomation({
        id: request.id,
        target,
        expectedRevision: request.expectedRevision,
        purpose: "enable",
      }, new Date(evaluatedMs));
      if (stableAutomationJson(exact) !== stableAutomationJson(simulation))
        throw new ClayError("E_CONFLICT",
          "automation simulation is stale after definition, schema, target, data, or limit drift");
      const baselineRows = current.trigger.kind === "record_matches"
        ? this.automationRows(this.executableAutomationV2(current), new Date(evaluatedMs), {
            maxMatches: 100,
            truncate: false,
          })
        : [];
      if (current.trigger.kind === "record_matches"
          && stableAutomationJson(baselineRows.map(candidate => String(candidate.id)))
            !== stableAutomationJson(exact.matchedScope.recordIds))
        throw new ClayError("E_CONFLICT", "automation activation baseline is stale");
      const issuedAt = now.toISOString();
      const proofCore = {
        v: 1 as const,
        target,
        automationId: request.id,
        simulationId: exact.id,
        definitionRevision: current.definitionRevision,
        definitionDigest: exact.definitionDigest,
        issuedAt,
      };
      const enableProof = Object.freeze({
        ...proofCore,
        id: `aep_${automationSha256(proofCore).slice("sha256:".length)}`,
      });
      const raw = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
      const stored = {
        ...raw,
        state: "enabled",
        enableProof,
        authorityTarget: target,
        authorityDefinitionRevision: current.definitionRevision,
        authorityDefinitionDigest: exact.definitionDigest,
      };
      const nextAt = issuedAt <= String(row.updated_at)
        ? new Date(Date.parse(String(row.updated_at)) + 1).toISOString() : issuedAt;
      const targetJson = automationTargetJson(target);
      this.#driver.exec(
        `UPDATE sys.automations SET definition_json = ?, updated_at = ?, last_event_seq = ?,
           authority_target_json = ?, authority_definition_revision = ?,
           authority_definition_digest = ?, cursor_target_json = ?,
           cursor_definition_revision = ?, cursor_definition_digest = ?, storage_version = 2
         WHERE id = ?`,
        [JSON.stringify(stored), nextAt, Number(row.last_event_seq), targetJson,
         current.definitionRevision, exact.definitionDigest, targetJson,
         current.definitionRevision, exact.definitionDigest, request.id],
      );
      if (current.trigger.kind === "record_matches") {
        this.#driver.exec(
          `DELETE FROM sys.automation_matches WHERE automation_id = ? AND target_json = ?
             AND definition_revision = ? AND definition_digest = ?`,
          [request.id, targetJson, current.definitionRevision, exact.definitionDigest],
        );
        for (const baseline of baselineRows) this.#driver.exec(
          `INSERT INTO sys.automation_matches(
             automation_id, row_id, target_json, definition_revision,
             definition_digest, snapshot_digest, run_id, baseline)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 1)`,
          [request.id, String(baseline.id), targetJson, current.definitionRevision,
           exact.definitionDigest, automationSha256(baseline)],
        );
      }
      const after = this.#driver.select(
        `SELECT id, definition_json, created_at, updated_at, last_event_seq
         FROM sys.automations WHERE id = ?`, [request.id],
      )[0];
      if (!after) throw new ClayError("E_INTERNAL", "enabled automation read-back is missing");
      const enabled = this.automationDefinitionV2FromRow(after);
      if (enabled.state !== "enabled" || stableAutomationJson(enabled.enableProof) !== stableAutomationJson(enableProof))
        throw new ClayError("E_INTERNAL", "enabled automation proof failed read-back");
      return enabled;
    });
  }

  pauseAutomation(
    request: AutomationPauseRequestV1,
    now: Date = new Date(),
  ): AutomationDefinitionV2 {
    if (!Number.isFinite(now.getTime()) || typeof request.id !== "string"
        || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1)
      throw new ClayError("E_VALIDATION", "automation pause request is invalid");
    return this.#driver.tx(() => {
      const row = this.#driver.select(
        `SELECT id, definition_json, created_at, updated_at, last_event_seq
         FROM sys.automations WHERE id = ?`, [request.id],
      )[0];
      if (!row) throw new ClayError("E_VALIDATION", "unknown automation");
      const current = this.automationDefinitionV2FromRow(row);
      if (current.definitionRevision !== request.expectedRevision)
        throw new ClayError("E_CONFLICT", "automation definition revision changed");
      if (current.state !== "enabled") return current;
      const raw = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
      const at = now.toISOString() <= String(row.updated_at)
        ? new Date(Date.parse(String(row.updated_at)) + 1).toISOString() : now.toISOString();
      this.#driver.exec(
        `UPDATE sys.automations SET definition_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify({ ...raw, state: "paused", enableProof: null }), at, request.id],
      );
      const after = this.#driver.select(
        `SELECT id, definition_json, created_at, updated_at, last_event_seq
         FROM sys.automations WHERE id = ?`, [request.id],
      )[0];
      if (!after) throw new ClayError("E_INTERNAL", "paused automation read-back is missing");
      return this.automationDefinitionV2FromRow(after);
    });
  }

  private executableAutomationV2(definition: AutomationDefinitionV2): AutomationDefinition {
    const resolved = resolveAutomationDraftV2(this.reg, definition);
    return {
      ...resolved.executable,
      id: definition.id,
      enabled: definition.state === "enabled",
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
      runtime: definition.runtime,
    };
  }

  private automationForSimulation(id: string): AutomationDefinition {
    const row = this.#driver.select(
      `SELECT id, definition_json, created_at, updated_at FROM sys.automations WHERE id = ?`, [id],
    )[0];
    if (!row) throw new ClayError("E_VALIDATION", "unknown automation");
    const raw = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
    if (raw.v === 2) return this.executableAutomationV2(this.automationDefinitionV2FromRow(row));
    const normalized = validateAutomationDefinition(
      this.reg,
      { ...(raw as AutomationDefinitionInput), enabled: false },
    );
    return {
      ...normalized,
      id,
      enabled: false,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private foreignAutomationView(
    definition: AutomationDefinitionV2,
    target: AutomationTargetIdentityV1,
  ): AutomationDefinitionV2 {
    if (definition.state !== "enabled" || sameAutomationLineage(definition.authorityTarget, target))
      return definition;
    return Object.freeze({
      ...definition,
      state: "paused",
      enabled: false,
      enableProof: null,
      authorityTarget: target,
      authorityDefinitionRevision: definition.definitionRevision,
    });
  }

  private runnableAutomations(target: AutomationTargetIdentityV1): AutomationDefinitionV2[] {
    return this.listAutomations(target)
      .filter((definition): definition is AutomationDefinitionV2 =>
        definition.v === 2 && !definition.needsRepair && definition.state === "enabled")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id));
  }

  listAutomations(target?: AutomationTargetIdentityV1): AutomationDefinitionAny[] {
    const currentTarget = target === undefined ? null : validateAutomationTargetIdentity(target);
    const rows = this.#driver.select(
      `SELECT * FROM sys.automations ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(row => {
      const raw = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
      if (raw.v === 2) {
        const definition = this.automationDefinitionV2FromRow(row);
        return currentTarget ? this.foreignAutomationView(definition, currentTarget) : definition;
      }
      if (raw.id !== String(row.id))
        throw new ClayError("E_VALIDATION", "stored legacy automation identity does not match its row");
      const legacy = validateAutomationDefinition(
        this.reg, raw as unknown as AutomationDefinitionInput,
      );
      let persistedEnabled = legacy.enabled;
      if (typeof row.legacy_definition_json === "string") {
        try {
          const audit = JSON.parse(row.legacy_definition_json) as { enabled?: unknown };
          persistedEnabled = audit.enabled === true;
        } catch { throw new ClayError("E_VALIDATION", "legacy automation audit copy is invalid"); }
      }
      return {
        ...legacy,
        v: 1,
        id: String(row.id),
        enabled: false,
        persistedEnabled,
        definitionRevision: 0,
        state: persistedEnabled ? "paused" : "draft",
        needsRepair: true,
        repairReason: "REVIEW_REQUIRED_AFTER_UPGRADE",
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      } satisfies AutomationLegacyDefinitionV1;
    });
  }

  upsertAutomation(input: AutomationDefinitionInput): AutomationDefinition {
    if (input.enabled)
      throw new ClayError("E_VALIDATION",
        "enabled=true requires a current simulation proof and the separate enable operation");
    const normalized = validateAutomationDefinition(this.reg, input);
    const current = normalized.id
      ? this.#driver.select(`SELECT definition_json, created_at, updated_at, last_event_seq
          FROM sys.automations WHERE id = ?`, [normalized.id])[0] : undefined;
    if (normalized.id && !current)
      throw new ClayError("E_VALIDATION", "unknown automation");
    const wallClock = nowIso();
    const now = current && wallClock <= String(current.updated_at)
      ? new Date(Date.parse(String(current.updated_at)) + 1).toISOString() : wallClock;
    const id = normalized.id ?? `auto_${uuidv7().replaceAll("-", "")}`;
    const prior = current
      ? JSON.parse(String(current.definition_json)) as AutomationDefinitionInput : null;
    const maxSeq = Number(this.#driver.select(
      `SELECT COALESCE(MAX(seq), 0) AS n FROM sys.record_events`)[0]?.n ?? 0);
    const cursor = !current || (prior && !prior.enabled && normalized.enabled)
      ? maxSeq : Number(current.last_event_seq);
    const stored: AutomationDefinitionInput = { ...normalized, id };
    this.#driver.exec(
      `INSERT INTO sys.automations(id, definition_json, created_at, updated_at, last_event_seq)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET definition_json = excluded.definition_json,
         updated_at = excluded.updated_at, last_event_seq = excluded.last_event_seq`,
      [id, JSON.stringify(stored), current ? String(current.created_at) : now, now, cursor]);
    return { ...stored, id, createdAt: current ? String(current.created_at) : now, updatedAt: now };
  }

  deleteAutomation(id: string): void {
    const row = this.#driver.select(`SELECT id FROM sys.automations WHERE id = ?`, [id])[0];
    if (!row) throw new ClayError("E_VALIDATION", "unknown automation");
    this.#driver.tx(() => {
      this.#driver.exec(`DELETE FROM sys.automation_matches WHERE automation_id = ?`, [id]);
      this.#driver.exec(`DELETE FROM sys.automations WHERE id = ?`, [id]);
    });
  }

  private automationRows(
    definition: AutomationDefinition,
    now: Date,
    options: { maxMatches?: number; truncate?: boolean } = {},
  ): QueryRow[] {
    const trigger = definition.trigger;
    if (trigger.kind === "schedule") return [];
    const maxMatches = options.maxMatches ?? 100;
    const rows: QueryRow[] = [];
    let afterId: string | null = null;
    for (;;) {
      const page = this.query({
        from: trigger.table,
        where: [
          ...trigger.conditions,
          ...(afterId ? [{ field: "id", op: "gt" as const, value: afterId }] : []),
        ],
        orderBy: [{ field: "id", dir: "asc" }],
        limit: 200,
      }, now);
      for (const row of page) {
        let matches = true;
        if (trigger.kind === "date_due") {
          const raw = row[trigger.dateField];
          const clock = automationClock(now, definition.runtime?.timeZone);
          const today = Date.UTC(clock.year, clock.month - 1, clock.day);
          const due = typeof raw === "string"
            ? Date.parse(`${raw.slice(0, 10)}T00:00:00.000Z`) : Number.NaN;
          matches = Number.isFinite(due)
            && today >= due - trigger.daysBefore * 86_400_000;
        }
        if (!matches) continue;
        if (rows.length >= maxMatches) {
          if (options.truncate !== false) return rows;
          throw new ClayError("E_LIMIT",
            `automation matches more than ${maxMatches} records; narrow its conditions`);
        }
        rows.push(row);
      }
      if (page.length < 200) break;
      afterId = String(page.at(-1)!.id);
    }
    return rows;
  }

  private queuedAutomationEventScope(
    definition: AutomationDefinitionV2,
    now: Date,
  ): Readonly<{
    cursor: number;
    watermark: number;
    sources: ReadonlyArray<{ sequence: number; row: QueryRow; snapshotDigest: string }>;
  }> {
    if (definition.trigger.kind !== "record_created"
        && definition.trigger.kind !== "record_updated")
      return { cursor: 0, watermark: 0, sources: [] };
    const cursor = Number(this.#driver.select(
      `SELECT last_event_seq FROM sys.automations WHERE id = ?`, [definition.id],
    )[0]?.last_event_seq ?? 0);
    const executable = this.executableAutomationV2(definition);
    if ((executable.trigger.kind !== "record_created"
        && executable.trigger.kind !== "record_updated")
        || executable.trigger.kind !== definition.trigger.kind)
      throw new ClayError("E_INTERNAL", "queued automation trigger resolution changed kind");
    const executableTrigger = executable.trigger;
    const events = this.#driver.select(
      `SELECT * FROM sys.record_events
       WHERE (table_id = ? OR (table_id IS NULL AND table_name = ?))
         AND seq > ? ORDER BY seq ASC`,
      [definition.trigger.table.tableId, executableTrigger.table, cursor],
    );
    const sources: Array<{ sequence: number; row: QueryRow; snapshotDigest: string }> = [];
    let watermark = cursor;
    for (const event of events) {
      const sequence = Number(event.seq);
      watermark = Math.max(watermark, sequence);
      if ((event.origin !== "user" && event.origin !== "import")
          || (definition.trigger.kind === "record_created" && event.kind !== "created")
          || (definition.trigger.kind === "record_updated" && event.kind !== "updated")) continue;
      const row = this.automationEventSnapshot(event, definition);
      if (!rowMatchesConditions(row, executableTrigger.conditions, now)) continue;
      sources.push({ sequence, row, snapshotDigest: String(event.snapshot_digest) });
      if (sources.length > 100)
        throw new ClayError("E_LIMIT",
          "automation matches more than 100 queued event records; narrow its conditions");
    }
    return Object.freeze({ cursor, watermark, sources: Object.freeze(sources) });
  }

  private automationLabel(definition: AutomationDefinition, row: QueryRow): string {
    if (definition.trigger.kind === "schedule") return definition.name;
    const table = getTable(this.reg, definition.trigger.table);
    const label = table.columns.find(column => !column.hidden && !column.inactive
      && (column.type === "text" || column.type === "rich_text" || column.type === "enum"));
    return label ? String(row[label.name] ?? "Untitled") : String(row.id).slice(0, 8);
  }

  private resolveAutomationValue(value: AutomationValue, source: QueryRow | null): unknown {
    if (value.source === "literal") return value.value;
    const raw = source?.[value.field] ?? null;
    if (Array.isArray(raw)) return raw.map(item =>
      item && typeof item === "object" && "id" in item ? String(item.id) : item);
    if (raw && typeof raw === "object" && "id" in raw) return String(raw.id);
    return raw;
  }

  private automationPlan(
    definition: AutomationDefinition,
    sources: QueryRow[],
  ): { mutations: BatchMutation[]; notifications: {
    action: Extract<AutomationAction, { kind: "notify" }>; source: QueryRow | null;
  }[] } {
    const records: (QueryRow | null)[] = definition.trigger.kind === "schedule" ? [null] : sources;
    const mutations: BatchMutation[] = [];
    const notifications: {
      action: Extract<AutomationAction, { kind: "notify" }>; source: QueryRow | null;
    }[] = [];
    let plannedBytes = 0;
    for (const source of records) {
      const updateValues: Record<string, unknown> = {};
      for (const action of definition.actions) {
        if (action.kind === "notify") { notifications.push({ action, source }); continue; }
        const values = Object.fromEntries(Object.entries(action.values)
          .map(([field, value]) => {
            const resolved = this.resolveAutomationValue(value, source);
            const bytes = new TextEncoder().encode(JSON.stringify(resolved) ?? "null").byteLength;
            if (bytes > 16 * 1_024)
              throw new ClayError("E_LIMIT", "automation output value exceeds 16 KiB");
            plannedBytes += bytes;
            if (plannedBytes > 1_024 * 1_024)
              throw new ClayError("E_LIMIT", "automation output exceeds the 1 MiB plan limit");
            return [field, resolved];
          }));
        if (action.kind === "set_fields") {
          Object.assign(updateValues, values);
        } else if (action.kind === "create_record") {
          mutations.push({ kind: "insert", table: action.table, row: values });
        } else {
          if (!source) throw new ClayError("E_VALIDATION", "related action has no trigger record");
          const relation = findColumn(getTable(this.reg, action.table), action.relationField)!;
          values[action.relationField] = relation.relation?.cardinality === "many"
            ? [String(source.id)] : String(source.id);
          mutations.push({ kind: "insert", table: action.table, row: values });
        }
      }
      if (source && Object.keys(updateValues).length > 0) {
        const table = definition.trigger.kind === "schedule" ? "" : definition.trigger.table;
        mutations.unshift({ kind: "update", table, id: String(source.id), patch: updateValues });
      }
    }
    if (mutations.length > 500) throw new ClayError("E_LIMIT", "automation would change more than 500 records");
    return { mutations, notifications };
  }

  private retainedAutomationMutations(mutations: BatchMutation[]): BatchMutation[] {
    return mutations.filter(mutation => {
      if (mutation.kind !== "update") return true;
      const table = getTable(this.reg, mutation.table);
      const { cols, vals } = validatePatch(table, mutation.patch);
      const current = this.#driver.select(
        `SELECT ${cols.map(qid).join(", ")} FROM ${qid(mutation.table)} WHERE "id" = ?`,
        [mutation.id],
      )[0];
      if (!current) throw new ClayError("E_VALIDATION", "automation target record is missing");
      return !cols.every((column, index) =>
        (current[column] ?? null) === (vals[index] ?? null));
    });
  }

  simulateAutomation(id: string, now?: Date): AutomationSimulation;
  simulateAutomation(
    request: AutomationSimulationRequestV1,
    now?: Date,
  ): AutomationSimulationProofV1;
  simulateAutomation(
    idOrRequest: string | AutomationSimulationRequestV1,
    now: Date = new Date(),
  ): AutomationSimulation | AutomationSimulationProofV1 {
    if (typeof idOrRequest !== "string") {
      if (!Number.isFinite(now.getTime()))
        throw new ClayError("E_VALIDATION", "automation simulation time is invalid");
      const request = idOrRequest;
      const target = validateAutomationTargetIdentity(request.target);
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
          || (request.purpose !== "enable" && request.purpose !== "run_now"
            && request.purpose !== "proposal_review"))
        throw new ClayError("E_VALIDATION", "automation simulation request is invalid");
      const row = this.#driver.select(
        `SELECT id, definition_json, created_at, updated_at FROM sys.automations WHERE id = ?`,
        [request.id],
      )[0];
      if (!row) throw new ClayError("E_VALIDATION", "unknown automation");
      const definition = this.automationDefinitionV2FromRow(row);
      if (definition.definitionRevision !== request.expectedRevision)
        throw new ClayError("E_CONFLICT", "automation definition revision changed");
      const resolved = resolveAutomationDraftV2(this.reg, definition);
      const executable: AutomationDefinition = {
        ...resolved.executable,
        id: definition.id,
        createdAt: definition.createdAt,
        updatedAt: definition.updatedAt,
        runtime: definition.runtime,
      };
      const queuedScope = request.purpose !== "run_now"
        && (definition.trigger.kind === "record_created"
          || definition.trigger.kind === "record_updated")
        ? this.queuedAutomationEventScope(definition, now) : null;
      const rows = queuedScope
        ? queuedScope.sources.map(source => source.row)
        : this.automationRows(executable, now, { maxMatches: 100, truncate: false });
      const rawPlan = this.automationPlan(executable, rows);
      const plan = {
        mutations: this.retainedAutomationMutations(rawPlan.mutations),
        notifications: rawPlan.notifications,
      };
      if (plan.mutations.length > 0) this.validateBatchMutations(plan.mutations);
      const matchedRecords = executable.trigger.kind === "schedule" ? 1 : rows.length;
      const definitionDigest = automationDefinitionDigest(resolved.stored);
      const plannedEffects = plannedEffectsFor(resolved.stored, matchedRecords).map((effect, index) => {
        if (effect.kind === "set_fields") return Object.freeze({
          ...effect,
          count: plan.mutations.filter(mutation => mutation.kind === "update").length,
        });
        if (effect.kind === "create_record" || effect.kind === "create_related") {
          const action = executable.actions[index];
          const table = action && (action.kind === "create_record" || action.kind === "create_related")
            ? action.table : null;
          return Object.freeze({
            ...effect,
            count: table === null ? 0 : plan.mutations.filter(mutation =>
              mutation.kind === "insert" && mutation.table === table).length,
          });
        }
        return Object.freeze({ ...effect, count: plan.notifications.length });
      });
      const evaluatedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      const matchedScope = Object.freeze({
        kind: executable.trigger.kind === "schedule" ? "schedule" as const : "records" as const,
        recordIds: Object.freeze(rows.map(source => String(source.id))),
      });
      const snapshotDigest = automationSha256({
        v: 1,
        target,
        definitionDigest,
        matchedScope,
        sources: rows,
        plannedEffects,
        plannedMutations: plan.mutations,
        plannedNotifications: plan.notifications.map(item => ({
          title: item.action.title,
          body: item.action.body,
          sourceId: item.source ? String(item.source.id) : null,
        })),
      });
      const dataRevision = Number(this.#driver.select(
        `SELECT COALESCE(MAX(seq), 0) AS n FROM sys.record_events`,
      )[0]?.n ?? 0);
      const core = {
        v: 1 as const,
        target,
        purpose: request.purpose,
        automationId: definition.id,
        definitionRevision: definition.definitionRevision,
        definitionDigest,
        schemaRevision: this.currentVersion(),
        referenceFingerprint: resolved.referenceFingerprint,
        dataRevision,
        evaluatedAt,
        expiresAt,
        snapshotDigest,
        matchedRecords,
        matchedScope,
        plannedMutations: plan.mutations.length,
        plannedNotifications: plan.notifications.length,
        plannedEffects: Object.freeze(plannedEffects),
        sampleLabels: Object.freeze(rows.slice(0, 5)
          .map(source => this.automationLabel(executable, source))),
        runtime: Object.freeze({
          mode: "local" as const,
          requiresAppOpen: true as const,
          timeZone: resolved.stored.runtime.timeZone ?? null,
        }),
        undo: plan.mutations.length > 0
          ? "available_after_commit" as const : "no_data_changes" as const,
      };
      return Object.freeze({
        ...core,
        id: `asim_${automationSha256(core).slice("sha256:".length)}`,
      });
    }
    const id = idOrRequest;
    const definition = this.automationForSimulation(id);
    const rows = this.automationRows(definition, now,
      { maxMatches: 100, truncate: false });
    const plan = this.automationPlan(definition, rows);
    if (plan.mutations.length > 0) this.validateBatchMutations(plan.mutations);
    return {
      automationId: id,
      matchedRecords: definition.trigger.kind === "schedule" ? 1 : rows.length,
      plannedMutations: plan.mutations.length,
      plannedNotifications: plan.notifications.length,
      sampleLabels: rows.slice(0, 5).map(row => this.automationLabel(definition, row)),
    };
  }

  private automationRunFromRow(
    row: SqlRow,
    currentTarget: AutomationTargetIdentityV1 | null = null,
  ): AutomationRun {
    const target = automationTargetFromJson(row.target_json);
    return {
      id: String(row.id), automationId: String(row.automation_id), at: String(row.at),
      status: String(row.status) as "success" | "failed",
      matchedRecords: Number(row.matched_count), changed: Number(row.changed_count),
      batchId: row.batch_id === null ? null : String(row.batch_id),
      errorCode: row.error_code === null ? null : String(row.error_code),
      undone: row.undone_at !== null,
      target,
      definitionRevision: row.definition_revision === null
        || row.definition_revision === undefined ? null : Number(row.definition_revision),
      definitionDigest: typeof row.definition_digest === "string" ? row.definition_digest : null,
      logicalTriggerKey: String(row.trigger_key),
      triggerKind: typeof row.trigger_kind === "string"
        ? row.trigger_kind as AutomationDefinition["trigger"]["kind"] : null,
      auditOnly: currentTarget !== null && !sameAutomationLineage(target, currentTarget),
    };
  }

  private automationRuntimeBindingTarget(
    definition: AutomationDefinitionV2,
    currentTarget: AutomationTargetIdentityV1,
  ): AutomationTargetIdentityV1 {
    if (definition.state !== "enabled") return currentTarget;
    if (!sameAutomationLineage(definition.authorityTarget, currentTarget))
      throw new ClayError("E_CONFLICT", "automation authority belongs to another target lineage");
    return definition.authorityTarget!;
  }

  private automationTriggerSucceeded(
    definition: AutomationDefinitionV2,
    target: AutomationTargetIdentityV1,
    triggerKey: string,
  ): boolean {
    const definitionDigest = automationDefinitionDigest(definition);
    const bindingTarget = this.automationRuntimeBindingTarget(definition, target);
    return this.#driver.select(
      `SELECT run_id FROM sys.automation_trigger_ledger
       WHERE automation_id = ? AND trigger_key = ? AND target_json = ?
         AND definition_revision = ? AND definition_digest = ?
         AND disposition = 'success' LIMIT 1`,
      [definition.id, triggerKey, automationTargetJson(bindingTarget),
       definition.definitionRevision, definitionDigest],
    ).length > 0;
  }

  private executeAutomation(
    storedDefinition: AutomationDefinitionV2,
    sources: QueryRow[],
    triggerKey: string,
    now: Date,
    target: AutomationTargetIdentityV1,
    onSuccess?: (runId: string) => void,
  ): AutomationRun | null {
    const definition = this.executableAutomationV2(storedDefinition);
    const definitionDigest = automationDefinitionDigest(storedDefinition);
    const targetJson = automationTargetJson(target);
    const bindingTargetJson = automationTargetJson(
      this.automationRuntimeBindingTarget(storedDefinition, target),
    );
    if (this.automationTriggerSucceeded(storedDefinition, target, triggerKey)) return null;
    const runId = uuidv7();
    const at = now.toISOString();
    try {
      return this.#driver.tx(() => {
        const rawPlan = this.automationPlan(definition, sources);
        const plan = {
          mutations: this.retainedAutomationMutations(rawPlan.mutations),
          notifications: rawPlan.notifications,
        };
        if (plan.mutations.length === 0 && plan.notifications.length === 0) return null;
        const batch = plan.mutations.length > 0 ? this.applyBatch({
          source: "automation", summary: definition.name, mutations: plan.mutations,
        }) : null;
        if (batch) this.#driver.exec(
          `UPDATE sys.operation_batches SET automation_target_json = ?,
             automation_definition_revision = ?, automation_definition_digest = ?,
             automation_run_id = ? WHERE id = ?`,
          [targetJson, storedDefinition.definitionRevision, definitionDigest, runId, batch.id],
        );
        for (const notice of plan.notifications) {
          const table = definition.trigger.kind === "schedule" ? null : definition.trigger.table;
          this.#driver.exec(
            `INSERT INTO sys.notifications(
               id, at, automation_id, run_id, title, body, table_name, row_id,
               read_at, dismissed_at, target_json, definition_revision, definition_digest)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
            [uuidv7(), at, definition.id, runId, notice.action.title, notice.action.body,
             table, notice.source ? String(notice.source.id) : null, targetJson,
             storedDefinition.definitionRevision, definitionDigest]);
        }
        const matched = definition.trigger.kind === "schedule" ? 1 : sources.length;
        this.#driver.exec(
          `INSERT INTO sys.automation_runs(
             id, automation_id, at, trigger_key, status, matched_count,
             changed_count, batch_id, error_code, undone_at, target_json,
             definition_revision, definition_digest, trigger_kind)
           VALUES (?, ?, ?, ?, 'success', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
          [runId, definition.id, at, triggerKey, matched,
           batch?.changed ?? 0, batch?.id ?? null, targetJson,
           storedDefinition.definitionRevision, definitionDigest, definition.trigger.kind]);
        this.#driver.exec(
          `INSERT INTO sys.automation_trigger_ledger(
             automation_id, trigger_key, target_json, definition_revision,
             definition_digest, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [definition.id, triggerKey, bindingTargetJson, storedDefinition.definitionRevision,
           definitionDigest, runId, at],
        );
        onSuccess?.(runId);
        return {
          id: runId, automationId: definition.id, at, status: "success" as const,
          matchedRecords: matched, changed: batch?.changed ?? 0,
          batchId: batch?.id ?? null, errorCode: null, undone: false,
          target, definitionRevision: storedDefinition.definitionRevision,
          definitionDigest, logicalTriggerKey: triggerKey,
          triggerKind: definition.trigger.kind, auditOnly: false,
        };
      });
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_LIMIT") throw error;
      const code = error instanceof ClayError ? error.code : "E_INTERNAL";
      const failed = {
        id: runId, automationId: definition.id, at, status: "failed",
        matchedRecords: definition.trigger.kind === "schedule" ? 1 : sources.length,
        changed: 0, batchId: null, errorCode: code, undone: false,
        target, definitionRevision: storedDefinition.definitionRevision,
        definitionDigest, logicalTriggerKey: triggerKey,
        triggerKind: definition.trigger.kind, auditOnly: false,
      } satisfies AutomationRun;
      this.#driver.exec(
        `INSERT INTO sys.automation_runs(
           id, automation_id, at, trigger_key, status, matched_count,
           changed_count, batch_id, error_code, undone_at, target_json,
           definition_revision, definition_digest, trigger_kind)
         VALUES (?, ?, ?, ?, 'failed', ?, 0, NULL, ?, NULL, ?, ?, ?, ?)`,
        [runId, definition.id, at, triggerKey, failed.matchedRecords, code, targetJson,
         storedDefinition.definitionRevision, definitionDigest, definition.trigger.kind],
      );
      return failed;
    }
  }

  runAutomationNow(id: string, now?: Date): AutomationRun;
  runAutomationNow(request: AutomationRunNowRequestV1, now?: Date): AutomationExecutionResultV1;
  runAutomationNow(
    idOrRequest: string | AutomationRunNowRequestV1,
    now: Date = new Date(),
  ): AutomationRun | AutomationExecutionResultV1 {
    if (typeof idOrRequest === "string") {
      throw new ClayError("E_VALIDATION",
        "automation Run now requires a current target-bound simulation proof");
    }
    const request = idOrRequest;
    if (!Number.isFinite(now.getTime()))
      throw new ClayError("E_VALIDATION", "automation run time is invalid");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
        || typeof request.id !== "string" || !request.simulation)
      throw new ClayError("E_VALIDATION", "automation run requires a run-now simulation proof");
    const simulation = validateAutomationSimulationProof(request.simulation);
    if (simulation.purpose !== "run_now")
      throw new ClayError("E_VALIDATION", "automation run requires a run-now simulation proof");
    const target = validateAutomationTargetIdentity(request.target);
    const evaluatedMs = Date.parse(simulation.evaluatedAt);
    const expiryMs = Date.parse(simulation.expiresAt);
    if (!Number.isFinite(evaluatedMs) || !Number.isFinite(expiryMs)
        || evaluatedMs > now.getTime() || expiryMs < now.getTime())
      throw new ClayError("E_CONFLICT", "automation run simulation expired or has invalid time");
    if (stableAutomationJson(simulation.target) !== stableAutomationJson(target)
        || simulation.automationId !== request.id
        || simulation.definitionRevision !== request.expectedRevision)
      throw new ClayError("E_CONFLICT", "automation run simulation target or revision is stale");
    const row = this.#driver.select(
      `SELECT id, definition_json, created_at, updated_at FROM sys.automations WHERE id = ?`,
      [request.id],
    )[0];
    if (!row) throw new ClayError("E_VALIDATION", "unknown automation");
    const current = this.automationDefinitionV2FromRow(row);
    if (current.definitionRevision !== request.expectedRevision)
      throw new ClayError("E_CONFLICT", "automation definition revision changed");
    const exact = this.simulateAutomation({
      id: request.id,
      target,
      expectedRevision: request.expectedRevision,
      purpose: "run_now",
    }, new Date(evaluatedMs));
    if (stableAutomationJson(exact) !== stableAutomationJson(simulation))
      throw new ClayError("E_CONFLICT",
        "automation run simulation is stale after definition, schema, target, data, or limit drift");
    const definition = this.executableAutomationV2(current);
    const rows = this.automationRows(definition, new Date(evaluatedMs),
      { maxMatches: 100, truncate: false });
    const run = this.executeAutomation(current, rows, `manual:${exact.id}`, now, target);
    if (!run) return Object.freeze({
      v: 1,
      kind: "no_op",
      target,
      automationId: request.id,
      reasonCode: "NO_ACTUAL_RETAINED_MUTATION",
      evaluatedAt: now.toISOString(),
    });
    const core = {
      v: 1 as const,
      kind: "committed" as const,
      target,
      automationId: request.id,
      simulationId: exact.id,
      definitionRevision: current.definitionRevision,
      definitionDigest: exact.definitionDigest,
      committedAt: now.toISOString(),
      receipt: run,
    };
    return Object.freeze({
      ...core,
      id: `aer_${automationSha256(core).slice("sha256:".length)}`,
    });
   }

  private automationEventSnapshot(
    event: SqlRow,
    definition: AutomationDefinitionV2,
  ): QueryRow {
    const fail = (detail: string): never => {
      throw new ClayError("E_VALIDATION", `automation event-time snapshot is invalid: ${detail}`);
    };
    if (typeof event.row_json !== "string" || typeof event.snapshot_digest !== "string"
        || typeof event.table_id !== "string" || !Number.isSafeInteger(Number(event.schema_revision)))
      return fail("required identity or digest is missing");
    let value: unknown;
    try { value = JSON.parse(event.row_json); }
    catch { return fail("snapshot JSON is malformed"); }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return fail("snapshot is not an object");
    const snapshot = value as Record<string, unknown>;
    const allowed = new Set([
      "v", "tableId", "tableNameAtEvent", "rowId", "schemaRevision", "kernel", "fields",
      "snapshotDigest",
    ]);
    if (Object.keys(snapshot).some(key => !allowed.has(key)) || snapshot.v !== 1
        || snapshot.tableId !== event.table_id || snapshot.rowId !== event.row_id
        || snapshot.schemaRevision !== Number(event.schema_revision)
        || snapshot.snapshotDigest !== event.snapshot_digest)
      return fail("snapshot identity does not match its event envelope");
    const { snapshotDigest: _digest, ...core } = snapshot;
    if (automationSha256(core) !== event.snapshot_digest)
      return fail("snapshot digest does not verify");
    if (definition.trigger.kind === "schedule" || definition.trigger.table.tableId !== event.table_id)
      return fail("snapshot table identity does not match the automation trigger");
    const table = [...this.reg.values()].find(candidate =>
      candidate.semantic?.tableId === event.table_id);
    if (!table || !table.semantic || table.inactive)
      return fail("snapshot table semantic identity cannot be resolved");
    if (!Array.isArray(snapshot.fields)) return fail("snapshot field map is missing");
    const values = new Map<string, unknown>();
    for (const entry of snapshot.fields) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return fail("snapshot field entry is malformed");
      const field = entry as Record<string, unknown>;
      if (Object.keys(field).some(key => key !== "fieldId" && key !== "value")
          || typeof field.fieldId !== "string" || values.has(field.fieldId))
        return fail("snapshot field identity is malformed or duplicated");
      values.set(field.fieldId, field.value);
    }
    const kernel = snapshot.kernel;
    if (kernel === null || typeof kernel !== "object" || Array.isArray(kernel))
      return fail("snapshot kernel row is missing");
    const output: QueryRow = { ...(kernel as QueryRow) };
    if (String(output.id) !== String(event.row_id)) return fail("snapshot row identity is foreign");
    for (const column of table.columns) {
      if (column.inactive || !column.semantic) continue;
      if (values.has(column.semantic.fieldId))
        output[column.name] = values.get(column.semantic.fieldId) as never;
    }
    const requiredFieldIds = new Set<string>();
    for (const condition of definition.trigger.conditions) requiredFieldIds.add(condition.field.fieldId);
    for (const action of definition.actions) {
      if (action.kind === "set_fields" || action.kind === "create_record"
          || action.kind === "create_related") {
        for (const mapping of action.values) {
          if (mapping.value.source === "field")
            requiredFieldIds.add(mapping.value.field);
        }
      }
    }
    for (const fieldId of requiredFieldIds) if (!values.has(fieldId))
      return fail(`referenced field ${fieldId} is absent`);
    return output;
  }

  private transitionAutomationToError(
    definition: AutomationDefinitionV2,
    target: AutomationTargetIdentityV1,
    phase: string,
    reasonCode: string,
    detail: string,
    now: Date,
  ): void {
    const row = this.#driver.select(
      `SELECT definition_json, updated_at FROM sys.automations WHERE id = ?`, [definition.id],
    )[0];
    if (!row) return;
    const raw = JSON.parse(String(row.definition_json)) as Record<string, unknown>;
    const at = now.toISOString();
    this.#driver.exec(
      `UPDATE sys.automations SET definition_json = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify({
        ...raw,
        state: "error",
        authorityTarget: target,
        error: { phase, reasonCode, detail, failedAt: at, retryable: false },
      }), at, definition.id],
    );
  }

  runDueAutomations(
    target: AutomationTargetIdentityV1,
    now: Date = new Date(),
  ): AutomationRun[] {
    const currentTarget = validateAutomationTargetIdentity(target);
    if (!Number.isFinite(now.getTime()))
      throw new ClayError("E_VALIDATION", "automation scheduler time is invalid");
    return this.#driver.tx(() => {
      const completed: AutomationRun[] = [];
      let matchedRecords = 0;
      const consumeMatch = (): void => {
        matchedRecords += 1;
        if (matchedRecords > 100)
          throw new ClayError("E_LIMIT",
            "automation run request matches more than 100 records; narrow its rules");
      };
      for (const storedDefinition of this.runnableAutomations(currentTarget)) {
        const definition = this.executableAutomationV2(storedDefinition);
        const trigger = definition.trigger;
        if (trigger.kind === "record_created" || trigger.kind === "record_updated") {
          const stableTrigger = storedDefinition.trigger;
          if ((stableTrigger.kind !== "record_created" && stableTrigger.kind !== "record_updated")
              || stableTrigger.kind !== trigger.kind)
            throw new ClayError("E_INTERNAL", "queued automation trigger resolution changed kind");
          const stored = this.#driver.select(
            `SELECT last_event_seq, cursor_target_json, cursor_definition_revision,
                    cursor_definition_digest
               FROM sys.automations WHERE id = ?`, [definition.id],
          )[0]!;
          let cursor = Number(stored.last_event_seq);
          const bindingTarget = this.automationRuntimeBindingTarget(
            storedDefinition, currentTarget,
          );
          if (!sameAutomationTarget(
            automationTargetFromJson(stored.cursor_target_json), bindingTarget,
          ) || Number(stored.cursor_definition_revision) !== storedDefinition.definitionRevision
            || stored.cursor_definition_digest !== automationDefinitionDigest(storedDefinition)) {
            this.transitionAutomationToError(
              storedDefinition, currentTarget, "cursor", "E_CONFLICT",
              "event cursor authority does not belong to the current target", now,
            );
            continue;
          }
          const events = this.#driver.select(
            `SELECT * FROM sys.record_events
             WHERE (table_id = ? OR (table_id IS NULL AND table_name = ?))
               AND seq > ? ORDER BY seq ASC`,
            [stableTrigger.table.tableId, trigger.table, cursor],
          );
          const eligible = new Map<number, QueryRow>();
          let blocked = false;
          for (const event of events) {
            if ((event.origin !== "user" && event.origin !== "import")
                || (trigger.kind === "record_created" && event.kind !== "created")
                || (trigger.kind === "record_updated" && event.kind !== "updated")) continue;
            try {
              const snapshot = this.automationEventSnapshot(event, storedDefinition);
              if (rowMatchesConditions(snapshot, trigger.conditions, now)) {
                eligible.set(Number(event.seq), snapshot);
                if (eligible.size > 100)
                  throw new ClayError("E_LIMIT",
                    "automation matches more than 100 queued event records; narrow its conditions");
              }
            } catch (error) {
              if (error instanceof ClayError && error.code === "E_LIMIT") throw error;
              this.transitionAutomationToError(
                storedDefinition, currentTarget, "source_snapshot",
                error instanceof ClayError ? error.code : "E_INTERNAL",
                error instanceof Error ? error.message : String(error), now,
              );
              blocked = true;
              break;
            }
          }
          if (blocked) continue;
          for (const event of events) {
            const sequence = Number(event.seq);
            if ((event.origin !== "user" && event.origin !== "import")
                || (trigger.kind === "record_created" && event.kind !== "created")
                || (trigger.kind === "record_updated" && event.kind !== "updated")) {
              cursor = sequence;
              continue;
            }
            const snapshot = eligible.get(sequence);
            if (!snapshot) {
              cursor = sequence;
              continue;
            }
            const key = `event:${sequence}`;
            if (this.automationTriggerSucceeded(storedDefinition, currentTarget, key)) {
              cursor = sequence;
              continue;
            }
            consumeMatch();
            const run = this.executeAutomation(
              storedDefinition, [snapshot], key, now, currentTarget,
            );
            if (run) completed.push(run);
            if (run?.status === "failed") { blocked = true; break; }
            if (run?.status === "success" || this.automationTriggerSucceeded(storedDefinition, currentTarget, key))
              cursor = sequence;
          }
          if (!blocked) this.#driver.exec(
            `UPDATE sys.automations SET last_event_seq = ?, cursor_target_json = ?,
               cursor_definition_revision = ?, cursor_definition_digest = ? WHERE id = ?`,
            [cursor, automationTargetJson(bindingTarget), storedDefinition.definitionRevision,
             automationDefinitionDigest(storedDefinition), definition.id],
          );
          continue;
        }
        if (trigger.kind === "record_matches") {
          const rows = this.automationRows(definition, now,
            { maxMatches: 100, truncate: false });
          const currentIds = new Set(rows.map(row => String(row.id)));
          const bindingTarget = this.automationRuntimeBindingTarget(
            storedDefinition, currentTarget,
          );
          const matchBinding = [automationTargetJson(bindingTarget),
            storedDefinition.definitionRevision, automationDefinitionDigest(storedDefinition)] as const;
          for (const active of this.#driver.select(
            `SELECT row_id FROM sys.automation_matches WHERE automation_id = ?
               AND target_json = ? AND definition_revision = ? AND definition_digest = ?`,
            [definition.id, ...matchBinding])) {
            if (!currentIds.has(String(active.row_id)))
              this.#driver.exec(
                `DELETE FROM sys.automation_matches WHERE automation_id = ? AND row_id = ?
                   AND target_json = ? AND definition_revision = ? AND definition_digest = ?`,
                [definition.id, String(active.row_id), ...matchBinding]);
          }
          const active = new Set(this.#driver.select(
            `SELECT row_id FROM sys.automation_matches WHERE automation_id = ?
               AND target_json = ? AND definition_revision = ? AND definition_digest = ?`,
            [definition.id, ...matchBinding])
            .map(row => String(row.row_id)));
          for (const row of rows.filter(candidate => !active.has(String(candidate.id)))) {
            const key = `match:${String(row.id)}:${String(row.updated_at)}:${definition.updatedAt}`;
            const rowId = String(row.id);
            const persistMatch = (runId = ""): void => this.#driver.exec(
              `INSERT OR IGNORE INTO sys.automation_matches(
                 automation_id, row_id, target_json, definition_revision,
                 definition_digest, snapshot_digest, run_id, baseline)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
              [definition.id, rowId, automationTargetJson(bindingTarget),
               storedDefinition.definitionRevision, automationDefinitionDigest(storedDefinition),
               automationSha256(row), runId || null]);
            if (this.automationTriggerSucceeded(storedDefinition, currentTarget, key)) {
              persistMatch();
              continue;
            }
            consumeMatch();
            const run = this.executeAutomation(
              storedDefinition, [row], key, now, currentTarget, persistMatch,
            );
            if (run) completed.push(run);
            if (!run && this.automationTriggerSucceeded(storedDefinition, currentTarget, key)) persistMatch();
          }
          continue;
        }
        if (trigger.kind === "date_due") {
          for (const row of this.automationRows(definition, now,
            { maxMatches: 100, truncate: false })) {
            const due = String(row[trigger.dateField] ?? "");
            const key = `due:${String(row.id)}:${due}:${trigger.daysBefore}`;
            if (this.automationTriggerSucceeded(storedDefinition, currentTarget, key)) continue;
            consumeMatch();
            const run = this.executeAutomation(storedDefinition, [row], key, now, currentTarget);
            if (run) completed.push(run);
          }
          continue;
        }
        if (trigger.kind === "schedule") {
          const clock = automationClock(now, definition.runtime?.timeZone);
          const minutes = clock.hour * 60 + clock.minute;
          const [hour, minute] = trigger.localTime.split(":").map(Number);
          const scheduleMinutes = hour! * 60 + minute!;
          if (minutes < scheduleMinutes) continue;
          if (trigger.cadence === "weekly" && clock.weekday !== trigger.weekday) continue;
          if (definition.runtime?.missedPolicy === "skip" && minutes > scheduleMinutes) continue;
          const day = `${clock.year}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
          const key = `schedule:${day}`;
          if (this.automationTriggerSucceeded(storedDefinition, currentTarget, key)) continue;
          consumeMatch();
          const run = this.executeAutomation(storedDefinition, [], key, now, currentTarget);
          if (run) completed.push(run);
        }
      }
      return completed;
    });
  }

  automationRuns(
    target: AutomationTargetIdentityV1,
    automationId?: string,
    limit = 100,
  ): AutomationRun[] {
    const currentTarget = validateAutomationTargetIdentity(target);
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = automationId
      ? this.#driver.select(`SELECT * FROM sys.automation_runs WHERE automation_id = ?
          ORDER BY at DESC, id DESC LIMIT ?`, [automationId, bounded])
      : this.#driver.select(`SELECT * FROM sys.automation_runs
          ORDER BY at DESC, id DESC LIMIT ?`, [bounded]);
    return rows.map(row => this.automationRunFromRow(row, currentTarget));
  }

  undoAutomationRun(request: {
    id: string;
    target: AutomationTargetIdentityV1;
  }): AutomationRun {
    const id = request.id;
    const target = validateAutomationTargetIdentity(request.target);
    let original: SqlRow | undefined;
    this.#driver.tx(() => {
      const row = this.#driver.select(
        `SELECT * FROM sys.automation_runs WHERE id = ?`, [id])[0];
      if (!row) throw new ClayError("E_VALIDATION", "unknown automation run");
      const runTarget = automationTargetFromJson(row.target_json);
      if (!sameAutomationLineage(runTarget, target))
        throw new ClayError("E_CONFLICT", "automation run belongs to another target and is audit-only");
      if (row.undone_at !== null)
        throw new ClayError("E_CONFLICT", "automation run is already undone");
      if (row.status !== "success")
        throw new ClayError("E_CONFLICT", "failed automation has nothing to undo");
      original = row;
      if (row.batch_id !== null) {
        const batch = this.#driver.select(
          `SELECT automation_target_json, automation_definition_revision,
                  automation_definition_digest, automation_run_id
             FROM sys.operation_batches WHERE id = ?`, [String(row.batch_id)],
        )[0];
        if (!batch || !sameAutomationTarget(
          automationTargetFromJson(batch.automation_target_json), runTarget,
        ) || Number(batch.automation_definition_revision) !== Number(row.definition_revision)
          || batch.automation_definition_digest !== row.definition_digest
          || batch.automation_run_id !== row.id)
          throw new ClayError("E_CONFLICT", "automation batch receipt lineage is foreign or incomplete");
        this.undoBatch(String(row.batch_id));
      }
      const at = nowIso();
      this.#driver.exec(
        `UPDATE sys.automation_runs SET undone_at = ? WHERE id = ?`, [at, id]);
      this.#driver.exec(
        `UPDATE sys.notifications SET dismissed_at = ? WHERE run_id = ?
           AND target_json = ? AND definition_revision = ? AND definition_digest = ?`,
        [at, id, automationTargetJson(runTarget!), Number(row.definition_revision),
         String(row.definition_digest)]);
    });
    return { ...this.automationRunFromRow(original!, target), undone: true };
  }

  inboxDispositions() { return readInboxDispositions(this.#driver); }

  writeInboxDisposition(input: unknown) { return writeInboxDisposition(this.#driver, input); }

  dailyHomeRecordRevisions(): Readonly<{
    watermark: number;
    truncated: boolean;
    entries: readonly Readonly<{ table: string; rowId: string; revision: number }>[];
  }> {
    const limit = 100_000;
    const rows = this.#driver.select(
      `SELECT table_name, row_id, MAX(seq) AS revision
       FROM sys.record_events
       GROUP BY table_name, row_id
       ORDER BY table_name ASC, row_id ASC
       LIMIT ?`, [limit + 1]);
    const watermark = Number(this.#driver.select(
      `SELECT COALESCE(MAX(seq), 0) AS revision FROM sys.record_events`,
    )[0]?.revision ?? 0);
    if (!Number.isSafeInteger(watermark) || watermark < 0)
      throw new ClayError("E_INTERNAL", "record-event watermark is invalid");
    const entries = rows.slice(0, limit).map(row => {
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new ClayError("E_INTERNAL", "record-event revision is invalid");
      return Object.freeze({
        table: String(row.table_name), rowId: String(row.row_id), revision,
      });
    });
    return Object.freeze({
      watermark,
      truncated: rows.length > limit,
      entries: Object.freeze(entries),
    });
  }

  dailyHomeNotificationWatermark(): string {
    const row = this.#driver.select(
      `SELECT COUNT(*) AS count,
              COALESCE(MAX(COALESCE(dismissed_at, read_at, at)), '') AS changed_at,
              COALESCE(MAX(id), '') AS max_id
       FROM sys.notifications`,
    )[0];
    const count = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new ClayError("E_INTERNAL", "notification watermark is invalid");
    return `notifications:${String(row?.changed_at ?? "")}:${String(row?.max_id ?? "")}:${count}`;
  }

  listNotifications(limit = 100): ClayNotification[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.#driver.select(
      `SELECT * FROM sys.notifications WHERE dismissed_at IS NULL
       ORDER BY at DESC, id DESC LIMIT ?`, [bounded]).map(row => ({
      id: String(row.id), at: String(row.at), automationId: String(row.automation_id),
      runId: String(row.run_id), title: String(row.title), body: String(row.body),
      table: row.table_name === null ? null : String(row.table_name),
      recordId: row.row_id === null ? null : String(row.row_id),
      read: row.read_at !== null,
    }));
  }

  dailyHomeUnreadNotifications(limit = 500): Readonly<{
    notifications: readonly ClayNotification[];
    truncated: boolean;
  }> {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.#driver.select(
      `SELECT * FROM sys.notifications
       WHERE dismissed_at IS NULL AND read_at IS NULL
       ORDER BY at DESC, id DESC LIMIT ?`, [bounded + 1]);
    const notifications = rows.slice(0, bounded).map(row => ({
      id: String(row.id), at: String(row.at), automationId: String(row.automation_id),
      runId: String(row.run_id), title: String(row.title), body: String(row.body),
      table: row.table_name === null ? null : String(row.table_name),
      recordId: row.row_id === null ? null : String(row.row_id),
      read: false,
    }));
    return Object.freeze({
      notifications: Object.freeze(notifications),
      truncated: rows.length > bounded,
    });
  }

  markNotificationRead(id: string): void {
    const changed = this.#driver.exec(
      `UPDATE sys.notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND dismissed_at IS NULL`,
      [nowIso(), id]);
    void changed;
  }

  globalSearch(term: string, limit = 20): GlobalSearchResult[] {
    const needle = term.trim().toLocaleLowerCase();
    if (term.length > 120) throw new ClayError("E_LIMIT", "global search is limited to 120 characters");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ClayError("E_LIMIT", "global search limit must be between 1 and 100");
    const results: GlobalSearchResult[] = [];
    const text = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      if (Array.isArray(value)) return value.map(text).join(", ");
      if (typeof value === "object") {
        const label = (value as { label?: unknown }).label;
        return typeof label === "string" ? label : "";
      }
      return String(value);
    };
    for (const table of this.reg.values()) {
      if (table.inactive) continue;
      const columns = table.columns.filter(column => !column.hidden && !column.inactive
        && column.type !== "attachment" && column.type !== "json");
      const labelColumn = columns.find(column =>
        column.type === "text" || column.type === "rich_text" || column.type === "enum")
        ?? columns[0];
      let afterId: string | null = null;
      let scanned = 0;
      while (true) {
        const pageQuery: QueryT = {
          from: table.name, orderBy: [{ field: "id", dir: "asc" }], limit: 500,
          ...(afterId ? { where: [{ field: "id", op: "gt", value: afterId }] } : {}),
        };
        const page = this.query(pageQuery);
        for (const row of page) {
          const matchedFields = needle === "" ? [] : columns
            .filter(column => text(row[column.name]).toLocaleLowerCase().includes(needle))
            .map(column => column.name).slice(0, 3);
          if (needle !== "" && matchedFields.length === 0) continue;
          const label = labelColumn ? text(row[labelColumn.name]) || "Untitled" : "Untitled";
          const lowerLabel = label.toLocaleLowerCase();
          const score = needle === "" ? 0
            : lowerLabel === needle ? 100
              : lowerLabel.startsWith(needle) ? 80
                : lowerLabel.includes(needle) ? 60 : 40;
          const secondary = columns.filter(column => column.name !== labelColumn?.name)
            .map(column => text(row[column.name])).filter(Boolean).slice(0, 2).join(" · ");
          results.push({
            table: table.name, id: String(row.id), label, secondary,
            matchedFields, score, updatedAt: String(row.updated_at ?? ""),
          });
        }
        scanned += page.length;
        if (page.length < 500) break;
        afterId = String(page.at(-1)!.id);
        if (scanned >= 20_000) {
          const overflow = this.query({ from: table.name,
            where: [{ field: "id", op: "gt", value: afterId }], limit: 1 });
          if (overflow.length > 0)
            throw new ClayError("E_LIMIT",
              `global search supports up to 20,000 active records in '${table.name}'`);
          break;
        }
      }
    }
    return results.sort((left, right) => right.score - left.score
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.table.localeCompare(right.table)
      || left.label.localeCompare(right.label)).slice(0, limit);
  }

  private validateBatchMutations(mutations: BatchMutation[]): void {
    if (mutations.length < 1 || mutations.length > 500)
      throw new ClayError("E_LIMIT", "a batch must contain 1 to 500 mutations");
    const targets = new Set<string>();
    for (const mutation of mutations) {
      const table = getTable(this.reg, mutation.table);
      if (mutation.kind === "insert") {
        this.validateRelationReferences(table, mutation.row);
        validateInsert(table, mutation.row);
        continue;
      }
      const key = `${mutation.table}\u0000${mutation.id}`;
      if (targets.has(key))
        throw new ClayError("E_VALIDATION", "a batch may touch each existing record only once");
      targets.add(key);
      this.mustExist(mutation.table, mutation.id);
      if (mutation.kind === "update") {
        this.validateRelationReferences(table, mutation.patch, mutation.id);
        validatePatch(table, mutation.patch);
      }
    }
  }

  #importReceiptKey(id: string): string {
    return `operation_receipt_import_v1:${id}`;
  }

  importReceipt(id: string): ImportReceipt | null {
    if (!IMPORT_UUID.test(id))
      throw new ClayError("E_VALIDATION", "import receipt identity is invalid");
    return this.getSetting<ImportReceipt>(this.#importReceiptKey(id)) ?? null;
  }

  #activeImportRow(table: string, id: string): QueryRow {
    const row = runQuery(this.#driver, this.reg, {
      from: table, where: [{ field: "id", op: "eq", value: id }],
    })[0];
    if (!row) throw new ClayError("E_CONFLICT", STALE_IMPORT_TARGET);
    return row;
  }

  #validatePreparedImportMutation(
    input: CommitExistingImportInput,
    mutation: PreparedExistingImportMutation,
    referencedRows: Set<number>,
  ): void {
    if (!/^mutation_[a-z2-7]{26}$/.test(mutation.mutationId)
        || mutation.role !== "primary_target" || mutation.table !== input.target.table
        || !IMPORT_UUID.test(mutation.rowId)
        || mutation.originSourceRows.length < 1)
      throw new ClayError("E_VALIDATION", "prepared import mutation is invalid");
    for (const sourceRow of mutation.originSourceRows) {
      if (referencedRows.has(sourceRow))
        throw new ClayError("E_VALIDATION", "a source row maps to more than one primary mutation");
      const disposition = input.dispositions.find(candidate => candidate.sourceRow === sourceRow);
      if (!disposition || disposition.kind !== mutation.kind)
        throw new ClayError("E_VALIDATION", "prepared mutation does not match its source disposition");
      referencedRows.add(sourceRow);
    }
    const table = getTable(this.reg, mutation.table);
    if (mutation.kind === "create") {
      if (!mutation.row || mutation.patch !== undefined || mutation.beforeDigest !== undefined
          || importValueFingerprint(mutation.row) !== mutation.payloadDigest)
        throw new ClayError("E_VALIDATION", "prepared create payload is invalid");
      this.validateRelationReferences(table, mutation.row);
      validateInsert(table, mutation.row);
      if (this.#driver.select(`SELECT "id" FROM ${qid(mutation.table)} WHERE "id" = ?`,
        [mutation.rowId]).length > 0)
        throw new ClayError("E_CONFLICT", "a prepared import row identity already exists");
      return;
    }
    if (!mutation.patch || mutation.row !== undefined || !mutation.beforeDigest
        || importValueFingerprint(mutation.patch) !== mutation.payloadDigest)
      throw new ClayError("E_VALIDATION", "prepared update payload is invalid");
    this.validateRelationReferences(table, mutation.patch, mutation.rowId);
    validatePatch(table, mutation.patch);
    const current = this.#activeImportRow(mutation.table, mutation.rowId);
    if (importValueFingerprint(current) !== mutation.beforeDigest)
      throw new ClayError("E_CONFLICT", STALE_IMPORT_TARGET);
  }

  commitImport(input: CommitExistingImportInput): CommitImportResult {
    const existing = this.importReceipt(input.receiptId);
    if (existing) {
      if (existing.previewDigest !== input.previewDigest)
        throw new ClayError("E_CONFLICT", "an import receipt identity was reused");
      return existing;
    }
    if (!/^import_[a-z2-7]{26}$/.test(input.sessionId)
        || !/^preview_[a-z2-7]{26}$/.test(input.previewId)
        || !IMPORT_SHA256.test(input.previewDigest)
        || !IMPORT_SHA256.test(input.sourceDigest)
        || (input.sourceKind !== "csv" && input.sourceKind !== "paste" && input.sourceKind !== "xlsx")
        || !input.summary.trim() || input.summary.length > 200)
      throw new ClayError("E_VALIDATION", "import commit envelope is invalid");
    if (input.baseVersion !== this.headVersion() || this.currentVersion() !== this.headVersion())
      throw new ClayError("E_CONFLICT", "the app shape changed after import preview");
    const table = getTable(this.reg, input.target.table);
    if ((table.semantic?.label ?? table.name) !== input.target.label)
      throw new ClayError("E_CONFLICT", "the import target changed after preview");
    const sourceTotals = validatedSourceTotals(input.sourceTotals);
    const mutationTotals = validatedMutationTotals(input.mutationTotals);
    const warnings = ImportWarningTotalsSchema.safeParse(input.warningTotals);
    if (!warnings.success)
      throw new ClayError("E_VALIDATION", "import warning totals are invalid");
    const warningTotals = warnings.data;
    if (sourceTotals.blockedRows !== 0 || sourceTotals.sourceRows !== input.dispositions.length
        || mutationTotals.changedCount !== input.mutations.length
        || input.mutations.length > 5_000
        || this.rowHistoryCap < input.mutations.length)
      throw new ClayError("E_VALIDATION", "the import preview is not committable or exceeds limits");
    const dispositionRows = new Set(input.dispositions.map(item => item.sourceRow));
    if (dispositionRows.size !== input.dispositions.length)
      throw new ClayError("E_VALIDATION", "import source dispositions are not unique");
    const mutationIds = new Set<string>();
    const mutationRows = new Set<string>();
    const referencedRows = new Set<number>();
    for (const mutation of input.mutations) {
      if (mutationIds.has(mutation.mutationId)
          || mutationRows.has(`${mutation.table}\u0000${mutation.rowId}`))
        throw new ClayError("E_VALIDATION", "prepared import mutations are not unique");
      mutationIds.add(mutation.mutationId);
      mutationRows.add(`${mutation.table}\u0000${mutation.rowId}`);
      this.#validatePreparedImportMutation(input, mutation, referencedRows);
    }
    const expectedDispositionRows = input.dispositions.filter(item =>
      item.kind === "create" || item.kind === "update").map(item => item.sourceRow);
    if (expectedDispositionRows.some(sourceRow => !referencedRows.has(sourceRow)))
      throw new ClayError("E_VALIDATION", "an import source mutation is missing");
    if (input.mutations.length === 0) {
      return {
        kind: "no_change",
        durable: false,
        previewDigest: input.previewDigest,
        sourceTotals,
        mutationTotals,
        warningTotals,
      };
    }

    const id = input.receiptId;
    const at = nowIso();
    const created = input.mutations.filter(mutation => mutation.kind === "create")
      .map(mutation => ({ table: mutation.table, id: mutation.rowId,
        role: "primary_target" as const }));
    const previous = this.batchContext;
    try {
      return this.#driver.tx(() => {
        if (input.baseVersion !== this.headVersion())
          throw new ClayError("E_CONFLICT", "the app shape changed after import preview");
        for (const mutation of input.mutations) {
          if (mutation.kind !== "update") continue;
          const current = this.#activeImportRow(mutation.table, mutation.rowId);
          if (importValueFingerprint(current) !== mutation.beforeDigest)
            throw new ClayError("E_CONFLICT", STALE_IMPORT_TARGET);
        }
        this.batchContext = { id, source: "import", pending: new Map() };
        try {
          for (const mutation of input.mutations) {
            if (mutation.kind === "create")
              this.#insertWithId(mutation.table, mutation.row!, mutation.rowId);
            else this.update(mutation.table, mutation.rowId, mutation.patch!);
          }
          this.assertRelationIntegrity();
          if (this.batchContext.pending.size !== 0)
            throw new ClayError("E_INTERNAL", "import history was not finalized");
          const changed = Number(this.#driver.select(
            `SELECT COUNT(*) AS count FROM "row_history" WHERE "batch_id" = ?`, [id],
          )[0]?.count ?? 0);
          if (changed !== mutationTotals.changedCount)
            throw new ClayError("E_CONFLICT", "import preview no longer matches actual history");
          const historyRows = new Set(this.#driver.select(
            `SELECT "table", "row_id" FROM "row_history" WHERE "batch_id" = ?`, [id],
          ).map(row => `${String(row.table)}\u0000${String(row.row_id)}`));
          if (historyRows.size !== input.mutations.length
              || input.mutations.some(mutation =>
                !historyRows.has(`${mutation.table}\u0000${mutation.rowId}`)))
            throw new ClayError("E_CONFLICT", "import history does not match the prepared mutations");
          this.#driver.exec(
            `INSERT INTO sys.operation_batches(
               id, at, source, summary, changed_count, created_json, undone_at)
             VALUES (?, ?, 'import', ?, ?, ?, NULL)`,
            [id, at, input.summary.trim(), changed,
             JSON.stringify(created.map(item => ({ table: item.table, id: item.id })))]);
          const receipt: ImportReceipt = {
            kind: "receipt", durable: true, id, at, source: "import",
            summary: input.summary.trim(), changed, created, undone: false,
            previewDigest: input.previewDigest, sourceKind: input.sourceKind,
            target: { ...input.target }, baseVersion: input.baseVersion,
            sourceTotals, mutationTotals, warningTotals,
            undo: { state: "available" },
          };
          this.setSetting(this.#importReceiptKey(id), receipt);
          const readBack = this.importReceipt(id);
          if (!readBack || JSON.stringify(readBack) !== JSON.stringify(receipt))
            throw new ClayError("E_INTERNAL", "import receipt failed authoritative read-back");
          return readBack;
        } finally { this.batchContext = previous; }
      });
    } catch (error) {
      this.batchContext = previous;
      throw error;
    }
  }

  undoImport(id: string): ImportReceipt {
    const receipt = this.importReceipt(id);
    if (!receipt) throw new ClayError("E_VALIDATION", "unknown import receipt");
    if (receipt.undone) throw new ClayError("E_CONFLICT", "import is already undone");
    return this.#driver.tx(() => {
      const batch = this.undoBatch(id);
      const undone: ImportReceipt = {
        ...receipt,
        changed: batch.changed,
        created: receipt.created.map(item => ({ ...item })),
        undone: true,
        undo: { state: "undone" },
      };
      this.setSetting(this.#importReceiptKey(id), undone);
      const readBack = this.importReceipt(id);
      if (!readBack || JSON.stringify(readBack) !== JSON.stringify(undone))
        throw new ClayError("E_INTERNAL", "import undo receipt failed authoritative read-back");
      return readBack;
    });
  }

  applyBatch(input: {
    source: BatchSource; summary: string; mutations: BatchMutation[];
  }): BatchReceipt {
    if (this.batchContext) throw new ClayError("E_CONFLICT", "nested batches are not allowed");
    if (!input.summary.trim() || input.summary.length > 200)
      throw new ClayError("E_VALIDATION", "batch summary must be 1 to 200 characters");
    this.validateBatchMutations(input.mutations);

    const id = uuidv7();
    const at = nowIso();
    const created: { table: string; id: string }[] = [];
    const previous = this.batchContext;
    try {
      return this.#driver.tx(() => {
        this.batchContext = { id, source: input.source, pending: new Map() };
        try {
          for (const mutation of input.mutations) {
            switch (mutation.kind) {
              case "insert": {
                const row = this.insert(mutation.table, mutation.row);
                created.push({ table: mutation.table, id: String(row.id) });
                break;
              }
              case "update":
                this.update(mutation.table, mutation.id, mutation.patch);
                break;
              case "soft_delete":
                this.softDelete(mutation.table, mutation.id);
                break;
              case "restore":
                this.restoreRow(mutation.table, mutation.id);
                break;
            }
          }
          this.assertRelationIntegrity();
          if (this.batchContext.pending.size !== 0)
            throw new ClayError("E_INTERNAL", "batch history was not finalized");
          const changed = Number(this.#driver.select(
            `SELECT COUNT(*) AS count FROM "row_history" WHERE "batch_id" = ?`, [id],
          )[0]?.count ?? 0);
          if (changed === 0) {
            return {
              id, at, source: input.source, summary: input.summary.trim(),
              changed: 0, created: [], undone: true,
            };
          }
          this.#driver.exec(
            `INSERT INTO sys.operation_batches(
               id, at, source, summary, changed_count, created_json, undone_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)`,
            [id, at, input.source, input.summary.trim(), changed,
             JSON.stringify(created)]);
          return {
            id, at, source: input.source, summary: input.summary.trim(),
            changed, created, undone: false,
          };
        } finally { this.batchContext = previous; }
      });
    } catch (error) {
      this.batchContext = previous;
      throw error;
    }
  }

  operationBatches(limit = 50): BatchReceipt[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    return this.#driver.select(
      `SELECT id, at, source, summary, changed_count, created_json, undone_at
       FROM sys.operation_batches ORDER BY at DESC, id DESC LIMIT ?`, [bounded])
      .map(row => ({
        id: String(row.id), at: String(row.at), source: String(row.source) as BatchSource,
        summary: String(row.summary), changed: Number(row.changed_count),
        created: JSON.parse(String(row.created_json)) as { table: string; id: string }[],
        undone: row.undone_at !== null,
      }));
  }

  undoBatch(id: string): BatchReceipt {
    const batch = this.#driver.select(
      `SELECT id, at, source, summary, changed_count, created_json, undone_at
       FROM sys.operation_batches WHERE id = ?`, [id])[0];
    if (!batch) throw new ClayError("E_VALIDATION", "unknown operation batch");
    if (batch.undone_at !== null) throw new ClayError("E_CONFLICT", "operation batch is already undone");
    const entries = this.#driver.select(
      `SELECT "table", "row_id", "before_json", "after_json", "change_kind"
       FROM "row_history" WHERE "batch_id" = ? ORDER BY "sequence" DESC`, [id]);
    if (entries.length !== Number(batch.changed_count))
      throw new ClayError("E_CONFLICT", "operation history is incomplete and cannot be undone safely");

    for (const entry of entries) {
      const table = String(entry.table);
      getTable(this.reg, table);
      const current = this.#driver.select(
        `SELECT * FROM ${qid(table)} WHERE "id" = ?`, [String(entry.row_id)])[0];
      if (!current || JSON.stringify(current) !== String(entry.after_json))
        throw new ClayError("E_CONFLICT", "a record changed after this batch; undo was not applied");
    }

    this.#driver.tx(() => {
      for (const entry of entries) {
        const table = String(entry.table);
        const rowId = String(entry.row_id);
        if (entry.change_kind === "create") {
          const at = nowIso();
          this.#driver.exec(
            `UPDATE ${qid(table)} SET "deleted_at" = ?, "updated_at" = ? WHERE "id" = ?`,
            [at, at, rowId]);
          this.recordRowEvent(table, rowId, "deleted", ["deleted_at"]);
          continue;
        }
        const before = JSON.parse(String(entry.before_json)) as Record<string, SqlValue>;
        const after = JSON.parse(String(entry.after_json)) as Record<string, SqlValue>;
        const columns = Object.keys(before).filter(column => column !== "id");
        const changedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter(column => !["id", "created_at", "updated_at"].includes(column)
            && (before[column] ?? null) !== (after[column] ?? null));
        const eventKind = before.deleted_at !== null && after.deleted_at === null
          ? "deleted" : before.deleted_at === null && after.deleted_at !== null
            ? "restored" : "updated";
        const priorAttachments = this.rowAttachmentIds(table, rowId);
        this.#driver.exec(
          `UPDATE ${qid(table)} SET ${columns.map(column => `${qid(column)} = ?`).join(", ")}
           WHERE "id" = ?`, [...columns.map(column => before[column] ?? null), rowId]);
        this.reconcileRowAttachments(table, rowId, priorAttachments);
        this.recordRowEvent(table, rowId, eventKind, changedFields);
      }
      this.assertRelationIntegrity();
      this.#driver.exec(`UPDATE sys.operation_batches SET undone_at = ? WHERE id = ?`,
        [nowIso(), id]);
    });
    return {
      id: String(batch.id), at: String(batch.at), source: String(batch.source) as BatchSource,
      summary: String(batch.summary), changed: Number(batch.changed_count),
      created: JSON.parse(String(batch.created_json)) as { table: string; id: string }[],
      undone: true,
    };
  }

  /** G6: snapshot the raw row before every update/softDelete. */
  private writeRowHistory(
    table: string, id: string, changeKind = "update",
  ): string | null {
    const rows = this.#driver.select(
      `SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (!rows[0]) return null;
    const historyId = uuidv7();
    this.#driver.exec(
      `INSERT INTO "row_history"(
         "id", "table", "row_id", "at", "before_json", "batch_id", "change_kind", "sequence")
       VALUES (?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX("sequence"), 0) + 1 FROM "row_history"))`,
      [historyId, table, id, nowIso(), JSON.stringify(rows[0]),
       this.batchContext?.id ?? null, changeKind]);
    if (this.batchContext)
      this.batchContext.pending.set(`${table}\u0000${id}`, historyId);
    const n = Number(this.#driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
    if (n > this.rowHistoryCap) {
      this.#driver.exec(
        `DELETE FROM "row_history" WHERE "id" IN (
           SELECT "id" FROM "row_history" ORDER BY "sequence" ASC LIMIT ?)`,
        [n - this.rowHistoryCap]);
    }
    return historyId;
  }

  private finishBatchHistory(table: string, id: string): void {
    const historyId = this.batchContext?.pending.get(`${table}\u0000${id}`);
    if (!historyId) return;
    const row = this.#driver.select(`SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id])[0];
    if (!row) throw new ClayError("E_INTERNAL", "batch result row vanished");
    this.#driver.exec(`UPDATE "row_history" SET "after_json" = ? WHERE "id" = ?`,
      [JSON.stringify(row), historyId]);
    this.batchContext!.pending.delete(`${table}\u0000${id}`);
  }

  rowHistoryCount(): number {
    return Number(this.#driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
  }

  /** Local attempt stats for Settings (doc 05 §5). No network. */
  attemptStats(): { kept: number; discarded: number; failed: number; clarify: number } {
    const rows = this.#driver.select(
      `SELECT outcome, COUNT(*) AS n FROM sys.attempts GROUP BY outcome`);
    const by = (o: string): number =>
      Number(rows.find(r => r.outcome === o)?.n ?? 0);
    return { kept: by("kept"), discarded: by("discarded"),
      failed: by("failed"), clarify: by("clarify") };
  }

  /** Rows with a snapshot in the restore window (G6: last 30 days). */
  restorableRows(table: string, sinceDays = 30): string[] {
    getTable(this.reg, table);
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    return this.#driver.select(
      `SELECT DISTINCT "row_id" FROM "row_history" WHERE "table" = ? AND "at" >= ?
       AND NOT (COALESCE("change_kind", '') = 'create' AND "before_json" = 'null')`,
      [table, cutoff]).map(r => String(r.row_id));
  }

  /** A row's snapshots, newest first (ADR-027: the Data view shows each
   * record's own history). Read-only; values are the row AS IT WAS before
   * each change, projected onto columns that still exist. Trusted-shell
   * surface only — never exposed to panel queries (row_history stays a
   * reserved table name). */
  rowHistory(table: string, id: string, limit = 20):
    { at: string; values: Record<string, unknown> }[] {
    const t = getTable(this.reg, table);
    const live = new Set(t.columns.filter(c => !c.inactive).map(c => c.name));
    return this.#driver.select(
      `SELECT "at", "before_json" FROM "row_history"
       WHERE "table" = ? AND "row_id" = ?
       AND NOT (COALESCE("change_kind", '') = 'create' AND "before_json" = 'null')
       ORDER BY "sequence" DESC LIMIT ?`,
      [table, id, limit]).map(r => {
      const raw = JSON.parse(String(r.before_json)) as Record<string, unknown>;
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) if (live.has(k)) values[k] = v;
      return { at: String(r.at), values };
    });
  }

  /** Restore the most recent snapshot of a row (also undeletes, since the
   * snapshot carries deleted_at). Columns that no longer exist are skipped
   * — a projection, not a loss (doc 04 §5 spirit). */
  restoreRow(table: string, id: string): QueryRow {
    const t = getTable(this.reg, table);
    const entry = this.#driver.select(
      `SELECT "before_json" FROM "row_history"
       WHERE "table" = ? AND "row_id" = ? AND COALESCE("change_kind", '') != 'restore'
       AND NOT (COALESCE("change_kind", '') = 'create' AND "before_json" = 'null')
       ORDER BY "sequence" DESC LIMIT 1`,
      [table, id])[0];
    if (!entry)
      throw new ClayError("E_VALIDATION", `no history for '${table}/${id}'`);
    this.mustExist(table, id);
    const before = JSON.parse(String(entry.before_json)) as Record<string, SqlValue>;
    const settable = new Set([
      ...t.columns.filter(c => !isVirtualColumn(c) && !c.inactive).map(c => c.name),
      "deleted_at",
    ]);
    const cols = Object.keys(before).filter(k => settable.has(k));
    const current = this.#driver.select(`SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id])[0]!;
    if (cols.every(column => current[column] === (before[column] ?? null)))
      return this.rowById(table, id);
    const priorAttachments = this.rowAttachmentIds(table, id);
    if (cols.length > 0) this.#driver.tx(() => {
      this.writeRowHistory(table, id, "restore");   // restoring is itself undoable
      this.#driver.exec(
        `UPDATE ${qid(table)} SET ${cols.map(c => `${qid(c)} = ?`).join(", ")},
           "updated_at" = ? WHERE "id" = ?`,
        [...cols.map(c => before[c] ?? null), nowIso(), id]);
      this.reconcileRowAttachments(table, id, priorAttachments);
      if (!this.batchContext) this.assertRelationIntegrity();
      this.finishBatchHistory(table, id);
      this.recordRowEvent(table, id, "restored", cols);
    });
    return this.rowById(table, id);
  }

  update(table: string, id: string, patch: Record<string, unknown>): QueryRow {
    const t = getTable(this.reg, table);
    this.mustExist(table, id);
    this.validateRelationReferences(t, patch, id);
    const { cols, vals } = validatePatch(t, patch);
    const current = this.#driver.select(
      `SELECT ${cols.map(qid).join(", ")} FROM ${qid(table)} WHERE "id" = ?`, [id],
    )[0]!;
    if (cols.every((column, index) => (current[column] ?? null) === (vals[index] ?? null)))
      return this.rowById(table, id);
    this.#driver.tx(() => {
      this.writeRowHistory(table, id);
      this.#driver.exec(
        `UPDATE ${qid(table)} SET ${cols.map(c => `${qid(c)} = ?`).join(", ")},
           "updated_at" = ? WHERE "id" = ?`,
        [...vals, nowIso(), id]);
      this.finishBatchHistory(table, id);
      this.recordRowEvent(table, id, "updated", cols);
    });
    return this.rowById(table, id);
  }

  softDelete(table: string, id: string): void {
    getTable(this.reg, table);
    this.mustExist(table, id);
    const priorAttachments = this.rowAttachmentIds(table, id);
    this.#driver.tx(() => {
      this.writeRowHistory(table, id, "soft_delete");
      const deletedAt = nowIso();
      this.#driver.exec(
        `UPDATE ${qid(table)} SET "deleted_at" = ?, "updated_at" = ? WHERE "id" = ?`,
        [deletedAt, deletedAt, id]);
      for (const attachmentId of priorAttachments)
        if (!this.attachmentActivelyReferenced(attachmentId))
          this.#driver.exec(
            `UPDATE "__clay_attachments" SET "deleted_at" = ? WHERE "id" = ?`,
            [deletedAt, attachmentId],
          );
      if (!this.batchContext) this.assertRelationIntegrity();
      this.finishBatchHistory(table, id);
      this.recordRowEvent(table, id, "deleted", ["deleted_at"]);
    });
  }

  query(q: QueryT, now: Date = new Date()): QueryRow[] {
    return runQuery(this.#driver, this.reg, q, now);
  }

  /** Trusted projection read with SQL-side byte preflight before JS materialization. */
  queryBounded(q: QueryT, budget: QueryByteBudget, now: Date = new Date()): QueryRow[] {
    return runQuery(this.#driver, this.reg, q, now, budget);
  }

  private mustExist(table: string, id: string): void {
    const rows = this.#driver.select(
      `SELECT "id" FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (rows.length === 0)
      throw new ClayError("E_VALIDATION", `no row '${id}' in '${table}'`);
  }

  private rowById(table: string, id: string): QueryRow {
    const rows = runQuery(this.#driver, this.reg,
      { from: table, where: [{ field: "id", op: "eq", value: id }], includeDeleted: true });
    const row = rows[0];
    if (!row) throw new ClayError("E_INTERNAL", "row vanished after write");
    return row;
  }

  /** Panel-scoped revert (doc 05 §7): restore the PREVIOUS blob of one
   * panel as a NEW commit — linear history preserved, nothing truncated. */
  revertPanel(panelId: string): number {
    const current = PRODUCTION_STORE_PRIMITIVES.livePanels.call(this)
      .find(p => p.panel_id === panelId);
    if (!current)
      throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    const rows = this.#driver.select(
      `SELECT version, code, placement_json, declared_q_json FROM sys.panel_blobs
       WHERE panel_id = ? AND version < ? ORDER BY version DESC LIMIT 1`,
      [panelId, current.version]);
    const prev = rows[0];
    if (!prev)
      throw new ClayError("E_VALIDATION",
        `'${panelId}' has no earlier version to roll back to`);
    const manifest = JSON.parse(String(prev.declared_q_json)) as {
      title: string; declared_queries: QueryT[]; declared_writes?: string[];
    };
    return PRODUCTION_STORE_PRIMITIVES.commit.call(this, {
      intent: `roll back panel ${panelId}`,
      summary: `Rolls back the ${manifest.title} panel to its previous version.`,
      migration: null,
      panels: [{
        panel_id: panelId, title: manifest.title,
        placement: JSON.parse(String(prev.placement_json)) as LivePanel["placement"],
        code: String(prev.code),
        declared_queries: manifest.declared_queries,
        declared_writes: manifest.declared_writes ?? [],
      }],
      diff: [{ kind: "change_panel", detail: `${manifest.title} rolled back` }],
    });
  }

  /** Raw physical dump, ordered by id — bit-equality checks (PB1, spine). */
  dumpTable(table: string): SqlRow[] {
    getTable(this.reg, table);
    return this.#driver.select(`SELECT * FROM ${qid(table)} ORDER BY "id"`);
  }

  // ---------- .clay archives (doc 04 §7) ----------
  /** zip{ manifest.json, user.db, system.db } — the backup story and a
   * trust artifact: the whole app in one file. */
  async exportArchive(appName: string): Promise<Uint8Array> {
    assertNoLegacyIntakeArchive(this.#driver);
    this.scrubLegacyCredentialSettings();
    return this.#buildArchive(appName);
  }

  async #exportArchiveReadOnly(appName: string): Promise<Uint8Array> {
    for (const key of LEGACY_CREDENTIAL_SETTING_KEYS)
      if (this.#driver.select("SELECT key FROM sys.settings WHERE key = ?", [key]).length)
        throw new ClayError("E_VALIDATION", "archive refused unsanitized legacy credential settings");
    return this.#buildArchive(appName);
  }

  async #buildArchive(appName: string): Promise<Uint8Array> {
    assertNoLegacyIntakeArchive(this.#driver);
    const attachmentIssues = await this.attachmentIntegrityIssues();
    if (attachmentIssues.length > 0)
      throw new ClayError("E_VALIDATION",
        `attachment integrity check failed: ${attachmentIssues.join("; ")}`);
    const { user, system } = await this.#driver.exportDatabases();
    const attachmentStorage = this.attachmentStorage();
    const manifest: ClayManifest = {
      format: 4, app: appName, exported_at: nowIso(),
      tables: this.reg.size, versions: this.headVersion(),
      attachments: { count: attachmentStorage.activeFiles, bytes: attachmentStorage.activeBytes },
    };
    return zipWrite([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
      { name: "user.db", data: user },
      { name: "system.db", data: system },
    ]);
  }

  static parseArchive(bytes: Uint8Array): {
    manifest: ClayManifest; user: Uint8Array; system: Uint8Array;
  } {
    if (bytes.byteLength > MAX_ARCHIVE_BYTES)
      throw new ClayError("E_LIMIT", "archive exceeds the 384 MB import limit");
    const entries = zipRead(bytes);
    const names = entries.map(entry => entry.name);
    if (entries.length !== ARCHIVE_FILES.size || new Set(names).size !== names.length)
      throw new ClayError("E_VALIDATION", "archive must contain exactly three unique entries");
    const unexpected = names.filter(name => !ARCHIVE_FILES.has(name));
    if (unexpected.length > 0)
      throw new ClayError("E_VALIDATION", `archive contains unexpected entries: ${unexpected.join(", ")}`);
    const get = (name: string): Uint8Array => {
      const e = entries.find(x => x.name === name);
      if (!e) throw new ClayError("E_VALIDATION", `archive is missing ${name}`);
      return e.data;
    };
    let manifest: ClayManifest;
    const manifestBytes = get("manifest.json");
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES)
      throw new ClayError("E_LIMIT", "archive manifest exceeds the 64 KiB import limit");
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ClayManifest;
    } catch {
      throw new ClayError("E_VALIDATION", "archive manifest is not valid JSON");
    }
    if (manifest.format !== 1 && manifest.format !== 2
        && manifest.format !== 3 && manifest.format !== 4)
      throw new ClayError("E_VALIDATION",
        `unsupported archive format ${String(manifest.format)}`);
    if (!manifest || typeof manifest !== "object"
        || typeof manifest.app !== "string" || manifest.app.length < 1 || manifest.app.length > 120
        || typeof manifest.exported_at !== "string" || !Number.isFinite(Date.parse(manifest.exported_at))
        || !Number.isSafeInteger(manifest.tables) || manifest.tables < 0 || manifest.tables > 1_000
        || !Number.isSafeInteger(manifest.versions) || manifest.versions < 0 || manifest.versions > 100_000)
      throw new ClayError("E_VALIDATION", "archive manifest fields are invalid");
    if (manifest.format === 4 && (!manifest.attachments
        || !Number.isSafeInteger(manifest.attachments.count) || manifest.attachments.count < 0
        || !Number.isSafeInteger(manifest.attachments.bytes) || manifest.attachments.bytes < 0))
      throw new ClayError("E_VALIDATION", "attachment manifest is missing or invalid");
    const user = get("user.db");
    const system = get("system.db");
    if (user.byteLength + system.byteLength > MAX_ARCHIVE_BYTES)
      throw new ClayError("E_LIMIT", "archive database payload exceeds the import limit");
    return { manifest, user, system };
  }

  /** Integrity checks run on an import staging store (doc 04 §7). */
  private archiveTimelineIssues(requireCursorConsistency = false): string[] {
    const issues: string[] = [];
    let replay: Registry = new Map();
    let timelineValid = true;
    const plans: Array<{ version: number; plan: MigrationPlanT }> = [];
    const registries = new Map<number, Registry>([[0, cloneRegistry(replay)]]);
    for (const row of this.#driver.select(
      `SELECT version, migration_json, inverse_json FROM sys.version_log ORDER BY version`,
    )) {
      const version = Number(row.version);
      if (row.migration_json === null || row.inverse_json === null) {
        if (row.migration_json !== row.inverse_json) {
          timelineValid = false;
          issues.push(`timeline migration at v${version} is only partially present`);
        }
      } else {
        try {
          const plan: MigrationPlanT = {
            operations: JSON.parse(String(row.migration_json)) as MigrationPlanT["operations"],
            inverse: JSON.parse(String(row.inverse_json)) as MigrationPlanT["inverse"],
          };
          replay = validateMigrationPlan(plan, replay);
          plans.push({ version, plan });
        } catch (error) {
          timelineValid = false;
          issues.push(`timeline migration at v${version} is invalid: ${
            error instanceof Error ? error.message : String(error)}`);
        }
      }
      registries.set(version, cloneRegistry(replay));
    }
    if (requireCursorConsistency && timelineValid) {
      const expected = cloneRegistry(replay);
      const readOnlyDriver = {
        exec: () => undefined,
        select: (sql: string, params?: SqlValue[]) => this.#driver.select(sql, params),
        tx: <T>(fn: () => T) => fn(),
      } as unknown as DbDriver;
      const current = this.currentVersion();
      for (const entry of [...plans].reverse()) {
        if (entry.version > current)
          applyInverseOps(readOnlyDriver, expected, entry.plan.inverse);
      }
      if (activeRegistryShape(expected) !== activeRegistryShape(this.reg))
        issues.push(`current_version ${current} does not match the active registry shape`);
    }
    for (const [version, registry] of registries) {
      let panels: LivePanel[];
      try { panels = this.livePanels(version); }
      catch (error) {
        issues.push(`panel history at v${version} is unreadable: ${
          error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const panel of panels) {
        const problems = validateMutationPlan({
          api: 1, summary: "Validate archived panel history.",
          user_facing_diff: [{ kind: "add_panel", detail: panel.panel_id }],
          clarifying_question: null, assumptions: [], migration: null,
          panels: [{
            panel_id: panel.panel_id, title: panel.title, placement: panel.placement,
            code: panel.code, declared_queries: panel.declared_queries,
            declared_writes: panel.declared_writes,
          }],
          remove_panels: [], confidence: 1,
        }, { registry, livePanelIds: [] });
        if (problems.length > 0)
          issues.push(`invalid panel history '${panel.panel_id}' at v${version}: ${
            problems.map(problem => problem.message).join(", ")}`);
      }
    }
    return issues;
  }

  /** Integrity checks run on an import staging store (doc 04 §7). */
  verifyIntegrity(manifest?: ClayManifest): string[] {
    const issues: string[] = [...semanticRegistryIssues(
      this.reg, this.headVersion(), this.semanticOperationBounds(),
    )];
    try { readInboxDispositions(this.#driver); }
    catch { issues.push("Inbox disposition storage is invalid"); }
    issues.push(...this.archiveTimelineIssues(manifest?.format === 4));
    const registryNames = new Set(this.reg.keys());
    const physicalTables = new Set(this.#driver.select(
      `SELECT name FROM main.sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN ('row_history', '__clay_attachments')`,
    ).map(row => String(row.name)));
    for (const table of physicalTables)
      if (!registryNames.has(table)) issues.push(`physical table '${table}' is not registered`);
    for (const row of this.#driver.select(
      "SELECT table_name, spec_json FROM sys.tables_registry",
    )) {
      try {
        const spec = JSON.parse(String(row.spec_json)) as { name?: unknown };
        if (spec.name !== row.table_name)
          issues.push(`registry key '${String(row.table_name)}' does not match its spec name`);
      } catch { issues.push(`registry row '${String(row.table_name)}' is not valid JSON`); }
    }
    if (manifest) {
      const expectedTables = manifest.format >= 4
        ? this.reg.size : cloneActiveRegistry(this.reg).size;
      if (manifest.tables !== expectedTables)
        issues.push(`manifest table count ${manifest.tables} does not match registry ${expectedTables}`);
      if (manifest.versions !== this.headVersion())
        issues.push(`manifest version count ${manifest.versions} does not match head ${this.headVersion()}`);
    }
    for (const t of this.reg.values()) {
      const info = this.#driver.select(`PRAGMA main.table_info(${qid(t.name)})`);
      const physical = new Set(info.map(r => String(r.name)));
      if (physical.size === 0) { issues.push(`table '${t.name}' is missing`); continue; }
      for (const col of ["id", "created_at", "updated_at", "deleted_at"])
        if (!physical.has(col)) issues.push(`'${t.name}' lacks kernel column '${col}'`);
      for (const c of t.columns)
        if (!isVirtualColumn(c) && !physical.has(c.name))
          issues.push(`'${t.name}' lacks registered column '${c.name}'`);
      const registered = new Set([
        "id", "created_at", "updated_at", "deleted_at",
        ...t.columns.filter(c => !isVirtualColumn(c)).map(c => c.name),
      ]);
      for (const column of physical)
        if (!registered.has(column))
          issues.push(`'${t.name}' has unregistered physical column '${column}'`);
    }
    const markers=this.#driver.select("SELECT table_name,column_name,row_id FROM sys.inactive_cells");
    for(const m of markers){
      const t=this.reg.get(String(m.table_name));
      const c=t&&findStoredColumn(t,String(m.column_name));
      if(!t||!c?.inactive){issues.push("inactive-cell marker has no inactive column");continue;}
      const r=this.#driver.select(`SELECT ${qid(c.name)} AS v FROM ${qid(t.name)} WHERE "id"=?`,[String(m.row_id)]);
      if(r.length!==1||r[0]?.v!==null)issues.push("inactive-cell marker does not point to a NULL cell");
    }
    const chain = this.history();
    chain.forEach((e, i) => {
      if (e.version !== i + 1 || e.parent !== i)
        issues.push(`version chain broken at v${e.version}`);
    });
    try { this.livePanels(); }
    catch (e) { issues.push(`panel manifest unreadable: ${String(e)}`); }
    return issues;
  }

  private archiveCopyShape(): DatabaseCopyShape {
    const tables = [...this.reg.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(table => ({
        name: table.name,
        sql: createTableSql(table, { includeInactive: true }),
      }));
    const indexes = this.#driver.select(
      `SELECT name, tbl_name FROM main.sqlite_master
       WHERE type = 'index' AND sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'idx_row_history_%'
       ORDER BY name`,
    ).map(row => {
      const name = String(row.name);
      const table = String(row.tbl_name);
      const columns = this.#driver.select(`PRAGMA main.index_info(${qid(name)})`);
      if (columns.length !== 1)
        throw new ClayError("E_VALIDATION", `archive index '${name}' is not canonical`);
      return { name, table, column: String(columns[0]!.name) };
    });
    return { tables, indexes };
  }

  async replaceFromArchive(bytes: Uint8Array): Promise<{
    store: ClayStore; manifest: ClayManifest; invalidPanels: string[];
  }> {
    return ClayStore.importArchive(bytes, async () => this.#driver);
  }

  /**
   * Import an archive: stage in memory, run integrity checks (abort on
   * failure — the live app is untouched), re-validate every live panel
   * blob (G15: never execute unvalidated blobs, regardless of provenance),
   * then swap. With `openFresh` the staged content is copied into a fresh
   * (persistent) driver; without it the staging store IS the result.
   */
  static async importArchive(
    bytes: Uint8Array,
    openFresh?: () => Promise<DbDriver>,
    installHooks?: Readonly<{
      wrapFreshDriver?: (driver: DbDriver) => DbDriver;
      runFreshInstall?: (install: () => void) => void;
      afterReadBack?: (store: ClayStore, driver: DbDriver) => void;
    }>,
  ): Promise<{ store: ClayStore; manifest: ClayManifest; invalidPanels: string[] }> {
    const { manifest, user, system } = ClayStore.parseArchive(bytes);
    const archiveDriver = await openDriverFromBytes(user, system);
    const rawIssues = rawArchiveSchemaIssues(archiveDriver, manifest.format);
    if (rawIssues.length > 0) {
      archiveDriver.close();
      throw new ClayError("E_VALIDATION",
        `archive contains unsafe schema objects: ${rawIssues.join("; ")}`, rawIssues);
    }
    let staging: ClayStore;
    try {
      staging = ClayStore.fromDriver(
        archiveDriver, { requireSemanticRegistry: manifest.format >= 3 });
    } catch (error) {
      archiveDriver.close();
      throw error;
    }
    try {
      staging.scrubLegacyCredentialSettings();
      const issues = staging.verifyIntegrity(manifest.format >= 3 ? manifest : undefined);
      try { staging.assertRelationIntegrity(); }
      catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
      issues.push(...staging.automationIntegrityIssues());
      issues.push(...await staging.attachmentIntegrityIssues(
        manifest.format >= 4 ? manifest : undefined));
      if (issues.length > 0)
        throw new ClayError("E_VALIDATION",
          `archive failed integrity checks: ${issues.join("; ")}`, issues);

      const invalidPanels: string[] = [];
      for (const panel of staging.livePanels()) {
        const problems = validateMutationPlan({
          api: 1, summary: "Imported panel.",
          user_facing_diff: [{ kind: "add_panel", detail: panel.panel_id }],
          clarifying_question: null, assumptions: [], migration: null,
          panels: [{
            panel_id: panel.panel_id, title: panel.title,
            placement: panel.placement, code: panel.code,
            declared_queries: panel.declared_queries,
            declared_writes: panel.declared_writes,
          }],
          remove_panels: [], confidence: 1,
        }, { registry: staging.registrySnapshot(), livePanelIds: [] });
        if (problems.length > 0) invalidPanels.push(panel.panel_id);
      }
      if (invalidPanels.length > 0)
        throw new ClayError("E_VALIDATION",
          `archive contains invalid panel blobs: ${invalidPanels.join(", ")}`,
          invalidPanels);

      if (!openFresh) return { store: staging, manifest, invalidPanels };
      const physicalFresh = await openFresh();
      const fresh = installHooks?.wrapFreshDriver?.(physicalFresh) ?? physicalFresh;
      const shape = staging.archiveCopyShape();
      const installedHolder: { store: ClayStore | null } = { store: null };
      const install = (): void => copyDatabase(staging.#driver, fresh, shape, () => {
        const installed = ClayStore.fromDriver(
          fresh, { requireSemanticRegistry: manifest.format >= 3 });
        installedHolder.store = installed;
        const readBackIssues = installed.verifyIntegrity(
          manifest.format >= 3 ? manifest : undefined);
        try { installed.assertRelationIntegrity(); }
        catch (error) {
          readBackIssues.push(error instanceof Error ? error.message : String(error));
        }
        readBackIssues.push(...installed.automationIntegrityIssues());
        if (readBackIssues.length > 0)
          throw new ClayError("E_VALIDATION",
            `installed archive failed read-back: ${readBackIssues.join("; ")}`, readBackIssues);
        installHooks?.afterReadBack?.(installed, fresh);
      });
      if (installHooks?.runFreshInstall) installHooks.runFreshInstall(install);
      else install();
      const installed = installedHolder.store;
      if (!installed)
        throw new ClayError("E_VALIDATION", "installed archive was not readable");
      const attachmentReadBackIssues = await installed.attachmentIntegrityIssues(
        manifest.format >= 4 ? manifest : undefined,
      );
      if (attachmentReadBackIssues.length > 0) {
        installed.close();
        throw new ClayError("E_VALIDATION",
          `installed archive attachment read-back failed: ${attachmentReadBackIssues.join("; ")}`,
          attachmentReadBackIssues);
      }
      staging.close();
      return { store: installed, manifest, invalidPanels };
    } catch (e) {
      staging.close();
      throw e;
    }
  }
}

/**
 * Module-captured Store implementations used by the production authority.
 * This module finishes evaluation before callers can replace public prototype
 * methods, so these references remain stable across the worker's later dynamic
 * authority import. This is intentionally not re-exported from the public
 * kernel entrypoint.
 */
export const PRODUCTION_STORE_PRIMITIVES = Object.freeze({
  inboxDispositions: ClayStore.prototype.inboxDispositions,
  writeInboxDisposition: ClayStore.prototype.writeInboxDisposition,
  applyBatch: ClayStore.prototype.applyBatch,
  undoBatch: ClayStore.prototype.undoBatch,
  query: ClayStore.prototype.query,
  validationRegistrySnapshot: ClayStore.prototype.validationRegistrySnapshot,
  commit: ClayStore.prototype.commit,
  convertTextToRelation: ClayStore.prototype.convertTextToRelation,
  previewRelationConversion: ClayStore.prototype.previewRelationConversion,
  currentVersion: ClayStore.prototype.currentVersion,
  getEntry: ClayStore.prototype.getEntry,
  getSetting: ClayStore.prototype.getSetting,
  headVersion: ClayStore.prototype.headVersion,
  history: ClayStore.prototype.history,
  livePanels: ClayStore.prototype.livePanels,
  prepareSemanticAssignments: ClayStore.prototype.prepareSemanticAssignments,
  registrySnapshot: ClayStore.prototype.registrySnapshot,
  removePanel: ClayStore.prototype.removePanel,
  renamePanel: ClayStore.prototype.renamePanel,
  revertPanel: ClayStore.prototype.revertPanel,
  rollbackTo: ClayStore.prototype.rollbackTo,
  setCheckpoint: ClayStore.prototype.setCheckpoint,
  setSetting: ClayStore.prototype.setSetting,
});

export type ClayManifest = {
  /** v2 adds rollback tombstones; v3 requires semantics; v4 accounts for files. */
  format: 1 | 2 | 3 | 4;
  app: string;
  exported_at: string;
  tables: number;
  versions: number;
  attachments?: { count: number; bytes: number };
};
