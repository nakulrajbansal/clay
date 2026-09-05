// ClayStore: the trusted facade over user.db + system.db. Commits span
// DDL + backfills + registry update + version_log append in ONE
// transaction (doc 04 §4). Versioning is a linear chain (doc 04 §5):
// rollback applies inverses; roll-forward (pre-truncation) re-applies
// forward ops; truncation is the only destructive-ish operation (ADR-007).
import { ClayError } from "./errors";
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
import { nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
import {
  applyForwardOps, applyInverseOps, createTableSql, deriveInverse, validateMigrationPlan,
  type MigrationPlanT,
} from "./migrate";
import { rowMatchesConditions, runQuery, type QueryRow } from "./query";
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
  createFieldId, createRelationshipId, createTableId, semanticRegistryIssues,
  type FieldId, type FieldSemanticV1, type PreparedSemanticAssignmentsV1,
  type SemanticIdentityEventV1, type SemanticOperationBounds, type SemanticOrigin,
  type SemanticRelationshipRecordV1, type SemanticSchemaTraceV1,
  type TableId, type TableSemanticV1,
} from "./semantic";

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
export type BatchSource = "user" | "automation";
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

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class ClayStore {
  private reg: Registry = new Map();
  private batchContext: {
    id: string; source: BatchSource; pending: Map<string, string>;
  } | null = null;
  readonly observer: Observer;
  readonly privateMetrics: PrivateMetricsReducer;

  private constructor(private readonly driver: DbDriver) {
    this.observer = new Observer(driver);
    this.privateMetrics = new PrivateMetricsReducer(new SqlitePrivateMetricDriver(driver));
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
    const eventColumns = new Set(driver.select(`PRAGMA sys.table_info("record_events")`)
      .map(row => String(row.name)));
    if (!eventColumns.has("row_json"))
      driver.exec(`ALTER TABLE sys.record_events ADD COLUMN row_json TEXT`);
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
    const done = this.driver.select(
      "SELECT value_json FROM sys.settings WHERE key = 'layout_scheme'")[0];
    if (done && String(done.value_json) === "2") return;
    const rows = this.driver.select(
      "SELECT version, panel_id, placement_json FROM sys.panel_blobs");
    for (const r of rows) {
      let pl: { w?: number } & Record<string, unknown>;
      try { pl = JSON.parse(String(r.placement_json)); } catch { continue; }
      const remap = pl.w === 1 ? 2 : pl.w === 2 ? 4 : undefined;
      if (remap === undefined) continue;
      pl.w = remap;
      this.driver.exec(
        "UPDATE sys.panel_blobs SET placement_json = ? WHERE version = ? AND panel_id = ?",
        [JSON.stringify(pl), Number(r.version), String(r.panel_id)]);
    }
    this.driver.exec(
      "INSERT OR REPLACE INTO sys.settings(key, value_json) VALUES ('layout_scheme', '2')");
  }

  /** G6 ring cap; public so tests can lower it. */
  rowHistoryCap = 10_000;

  close(): void {
    this.driver.close();
  }

  // ---------- registry ----------
  private loadRegistry(): void {
    this.reg = new Map();
    for (const row of this.driver.select("SELECT spec_json FROM sys.tables_registry")) {
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
      ? 0 : this.headVersion() + 1;
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
        relationships.set(relationKey(relationship.kind, from, to), relationship.relationshipId);
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
    this.driver.exec("DELETE FROM sys.tables_registry");
    for (const t of this.reg.values()) {
      this.driver.exec(
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
    this.privateMetrics.record(event);
  }

  privateMetricsSummary(): PrivateMetricsSummary {
    return this.privateMetrics.summary();
  }

  setPrivateMetricsEnabled(enabled: boolean): void {
    this.privateMetrics.setCollectionEnabled(enabled);
  }

  clearPrivateMetrics(): void { this.privateMetrics.clear(); }

  // ---------- versions ----------
  headVersion(): number {
    const rows = this.driver.select("SELECT MAX(version) AS v FROM sys.version_log");
    return Number(rows[0]?.v ?? 0);
  }

  currentVersion(): number {
    const v = this.getSetting<number>("current_version");
    return v === undefined ? this.headVersion() : v;
  }

  private setCurrentVersion(v: number): void {
    this.setSetting("current_version", v);
  }

  // ---------- settings (doc 04 §3: mode, byo key, sample markers, …) ----------
  getSetting<T>(key: string): T | undefined {
    const rows = this.driver.select(
      "SELECT value_json FROM sys.settings WHERE key = ?", [key]);
    const raw = rows[0]?.value_json;
    return raw === undefined ? undefined : JSON.parse(String(raw)) as T;
  }

  setSetting(key: string, value: unknown): void {
    this.driver.exec(
      `INSERT INTO sys.settings(key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [key, JSON.stringify(value)]);
  }

  deleteSetting(key: string): void {
    this.driver.exec("DELETE FROM sys.settings WHERE key = ?", [key]);
  }

  scrubLegacyCredentialSettings(): void {
    this.driver.tx(() => {
      for (const key of LEGACY_CREDENTIAL_SETTING_KEYS) this.deleteSetting(key);
    });
  }

  getEntry(version: number): VersionEntry {
    const rows = this.driver.select(
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
    for (const row of this.driver.select(
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
    const head = this.headVersion();
    if (this.currentVersion() !== head)
      throw new ClayError("E_VALIDATION",
        "store is rolled back (scrub preview); roll forward or truncate first");
    const semanticOrigin = input.semanticOrigin ?? "system";
    const semanticAssignments = input.semanticAssignments
      ?? this.prepareSemanticAssignments(input.migration, semanticOrigin);
    try {
      return this.driver.tx(() => {
        // capture the pre-commit manifest for the G16 rename rewrite
        const preLive = this.livePanels();
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
          applyForwardOps(this.driver, this.reg, input.migration.operations);
        }
        this.assertAutomationsCompatible();
        this.assertRelationIntegrity();
        this.ensureSemanticMetadata(
          version,
          semanticOrigin,
          semanticAssignments,
        );
        this.persistRegistry(version);
        this.driver.exec(
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
          this.driver.exec(
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
              }, { registry: this.reg, livePanelIds: this.livePanels().map(panel => panel.panel_id) });
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
    this.driver.exec(
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
    const p = this.livePanels().find(x => x.panel_id === panelId);
    if (!p) throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    const next = title.trim().slice(0, 80);
    if (next.length === 0)
      throw new ClayError("E_VALIDATION", "panel title cannot be empty");
    if (next === p.title) return this.headVersion();
    return this.commit({
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
    const p = this.livePanels().find(x => x.panel_id === panelId);
    if (!p) throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    return this.commit({
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
    const v = at ?? this.currentVersion();
    const rows = this.driver.select(
      `SELECT b.panel_id, b.version, b.code, b.placement_json, b.declared_q_json
       FROM sys.panel_blobs b
       JOIN (SELECT panel_id, MAX(version) AS mv FROM sys.panel_blobs
             WHERE version <= ? GROUP BY panel_id) m
         ON b.panel_id = m.panel_id AND b.version = m.mv
       ORDER BY b.panel_id`, [v, ]);
    const out: LivePanel[] = [];
    for (const r of rows) {
      const tomb = this.driver.select(
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
    const removed = this.driver.select(
      `SELECT MAX(version) AS removed_version FROM sys.panel_tombstones
       WHERE panel_id = ? AND version <= ?`,
      [panelId, version],
    )[0]?.removed_version;
    const afterVersion = removed == null ? 0 : Number(removed);
    const row = this.driver.select(
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
    return this.driver.select(
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
      this.driver.exec("DELETE FROM sys.checkpoints WHERE version = ?", [version]);
      return;
    }
    this.driver.exec(
      `INSERT INTO sys.checkpoints(version, label, created_at) VALUES (?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET label = excluded.label`,
      [version, trimmed, nowIso()]);
  }

  /** Last n commit summaries, newest first (S1 context, doc 05 §1). */
  recentSummaries(n: number): string[] {
    return this.driver
      .select("SELECT summary FROM sys.version_log ORDER BY version DESC LIMIT ?", [n])
      .map(r => String(r.summary));
  }

  // ---------- attempts (S0/doc 05 §5 analytics) ----------
  beginAttempt(intent: string): string {
    const id = uuidv7();
    this.driver.exec(
      "INSERT INTO sys.attempts(id, at, intent_text, outcome, error_code) VALUES (?, ?, ?, 'pending', NULL)",
      [id, nowIso(), intent]);
    return id;
  }

  finishAttempt(id: string, outcome: string, errorCode: string | null = null): void {
    this.driver.exec(
      "UPDATE sys.attempts SET outcome = ?, error_code = ? WHERE id = ?",
      [outcome, errorCode, id]);
  }

  /** Independent full copy for the S4 shadow dry-run (doc 05 §1). */
  async shadowCopy(): Promise<ClayStore> {
    const copy = new ClayStore(await this.driver.snapshot());
    copy.loadRegistry();
    return copy;
  }

  /** Apply inverses current..K+1. With truncate, the chain above K is discarded. */
  rollbackTo(target: number, opts: { truncate?: boolean } = {}): void {
    const cur = this.currentVersion();
    if (target < 0 || target >= cur)
      throw new ClayError("E_VALIDATION", `cannot roll back from ${cur} to ${target}`);
    try {
      this.driver.tx(() => {
        for (let v = cur; v > target; v--) {
          const entry = this.getEntry(v);
          if (entry.migration)
            applyInverseOps(this.driver, this.reg, entry.migration.inverse);
        }
        this.alignSemanticLabelsToPhysicalShape();
        this.assertAutomationsCompatible();
        this.assertRelationIntegrity();
        this.persistRegistry(target);
        if (opts.truncate) {
          this.driver.exec("DELETE FROM sys.version_log WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.panel_blobs WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.panel_tombstones WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.checkpoints WHERE version > ?", [target]);
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
      this.driver.tx(() => {
        for (let v = cur + 1; v <= target; v++) {
          const entry = this.getEntry(v);
          if (entry.migration)
            applyForwardOps(this.driver, this.reg, entry.migration.operations);
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
        const found = this.driver.select(
          `SELECT "id" FROM ${qid(column.relation.target_table)}
           WHERE "deleted_at" IS NULL AND "id" IN (${batch.map(() => "?").join(", ")})`,
          batch,
        );
        if (found.length !== batch.length)
          throw new ClayError("E_VALIDATION",
            `'${table.name}.${field}' contains a missing linked record`);
      }
      if (!column.relation.unique_targets || uniqueIds.length === 0) continue;
      const others = this.driver.select(
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
        const rows = this.driver.select(
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
    const sources = this.driver.select(
      `SELECT "id", ${qid(input.sourceField)} FROM ${qid(input.sourceTable)}
       WHERE "deleted_at" IS NULL ORDER BY "id"`,
    );
    const targets = this.driver.select(
      `SELECT "id", ${qid(input.displayField)} FROM ${qid(input.targetTable)}
       WHERE "deleted_at" IS NULL ORDER BY "id"`,
    );
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
      source: sources.map(row => [row.id, row[input.sourceField]]),
      target: targets.map(row => [row.id, row[input.displayField]]),
    });
    return {
      preview: {
        ...input,
        atVersion: this.currentVersion(),
        fingerprint: stableFingerprint(signature),
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
      this.driver.tx(() => {
        version = this.commit({
          intent: `connect ${input.sourceTable}.${input.sourceField} to ${input.targetTable}`,
          summary: `Connects ${label} to ${input.targetTable} records without deleting the original text.`,
          migration,
          semanticOrigin: "direct",
          diff: [{ kind: "add_relation", detail: `${label} now links to ${input.targetTable}` }],
          panelFieldReplacements: [{
            table: input.sourceTable, from: input.sourceField, to: relationField,
          }],
        });
        for (const row of this.driver.select(
          `SELECT "id" FROM ${qid(input.sourceTable)} WHERE "deleted_at" IS NULL`)) {
          this.driver.exec(
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
    this.driver.exec(
      `INSERT INTO sys.record_events(
         id, at, table_name, row_id, kind, changed_fields_json, origin, row_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(), nowIso(), table, id, kind, JSON.stringify([...new Set(changedFields)].sort()),
       this.batchContext?.source === "automation" ? "automation" : "user",
       JSON.stringify(snapshot)]);
  }

  insert(table: string, row: Record<string, unknown>): QueryRow {
    const t = getTable(this.reg, table);
    this.validateRelationReferences(t, row);
    const { cols, vals } = validateInsert(t, row);
    const id = uuidv7();
    const now = nowIso();
    const allCols = ["id", "created_at", "updated_at", ...cols];
    const allVals: SqlValue[] = [id, now, now, ...vals];
    this.driver.tx(() => {
      this.driver.exec(
        `INSERT INTO ${qid(table)} (${allCols.map(qid).join(", ")})
         VALUES (${allCols.map(() => "?").join(", ")})`, allVals);
      for (const column of t.columns) {
        if (!column.inactive || isVirtualColumn(column)) continue;
        this.driver.exec(
          `INSERT OR IGNORE INTO sys.inactive_cells(table_name, column_name, row_id)
           VALUES (?, ?, ?)`, [table, column.name, id]);
      }
      this.recordRowEvent(table, id, "created", cols);
    });
    if (this.batchContext) {
      const after = this.driver.select(`SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id])[0];
      this.driver.exec(
        `INSERT INTO "row_history"(
           "id", "table", "row_id", "at", "before_json", "after_json", "batch_id", "change_kind", "sequence")
         VALUES (?, ?, ?, ?, ?, ?, ?, 'create',
           (SELECT COALESCE(MAX("sequence"), 0) + 1 FROM "row_history"))`,
        [uuidv7(), table, id, now, "null", JSON.stringify(after), this.batchContext.id]);
    }
    this.observer.record({ kind: "insert", subject: table });
    return this.rowById(table, id);
  }

  // ---------- Observer (doc 02 §1) ----------
  recordUsage(ev: UsageEvent): void { this.observer.record(ev); }
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
    return this.observer.suggestions(this.registrySnapshot(), viewed, boarded, flowed, charted);
  }
  markSuggestionShown(subject: string, kind: string): void {
    this.observer.markShown(subject, kind);
  }
  dismissSuggestion(subject: string, kind: string): void {
    this.observer.dismiss(subject, kind);
  }
  acceptSuggestion(subject: string, kind: string): void {
    this.observer.accept(subject, kind);
  }

  private attachmentColumn(table: string, field: string): RegColumn {
    const column = findColumn(getTable(this.reg, table), field);
    if (!column || column.type !== "attachment" || column.hidden || column.inactive)
      throw new ClayError("E_VALIDATION", `'${table}.${field}' is not an active file field`);
    return column;
  }

  private attachmentIds(table: string, rowId: string, field: string): string[] {
    this.attachmentColumn(table, field);
    const row = this.driver.select(
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
        for (const row of this.driver.select(
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
        for (const row of this.driver.select(
          `SELECT ${qid(column.name)} AS value FROM ${qid(table.name)}
           WHERE ${qid(column.name)} IS NOT NULL`)) {
          try {
            const ids = JSON.parse(String(row.value)) as unknown;
            if (Array.isArray(ids) && ids.includes(id)) return true;
          } catch { /* integrity checker owns malformed values */ }
        }
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
      const raw = this.driver.select(
        `SELECT ${qid(column.name)} AS value FROM ${qid(tableName)} WHERE id = ?`, [rowId])[0]?.value;
      if (typeof raw !== "string") continue;
      let ids: string[];
      try {
        const parsed = JSON.parse(raw) as unknown;
        ids = Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : [];
      } catch { ids = []; }
      const existing = ids.filter(id => this.driver.select(
        `SELECT id FROM "__clay_attachments" WHERE id = ?`, [id])[0] !== undefined);
      for (const id of existing)
        this.driver.exec(`UPDATE "__clay_attachments" SET deleted_at = NULL WHERE id = ?`, [id]);
      if (existing.length !== ids.length)
        this.driver.exec(`UPDATE ${qid(tableName)} SET ${qid(column.name)} = ? WHERE id = ?`,
          [JSON.stringify(existing), rowId]);
    }
    const now = nowIso();
    for (const id of previouslyReferenced)
      if (!this.attachmentActivelyReferenced(id))
        this.driver.exec(`UPDATE "__clay_attachments" SET deleted_at = ? WHERE id = ?`, [now, id]);
  }

  async addAttachment(input: AttachmentInput): Promise<AttachmentMetadata> {
    const identity = safeAttachmentIdentity(input.name, input.mime);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0)
      throw new ClayError("E_VALIDATION", "file is empty or unreadable");
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new ClayError("E_LIMIT", "each file is limited to 10 MB");
    validateAttachmentSignature(input.bytes, identity.mime);
    this.attachmentColumn(input.table, input.field);
    const id = `file_${uuidv7().replaceAll("-", "")}`;
    const createdAt = nowIso();
    const digest = await sha256(input.bytes);
    this.driver.tx(() => {
      const state = this.driver.select(
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
      this.driver.exec(
        `INSERT INTO "__clay_attachments"(
           id, name, mime, size, sha256, bytes, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [id, identity.name, identity.mime, input.bytes.byteLength,
         digest, input.bytes, createdAt]);
      this.writeRowHistory(input.table, input.rowId, "attachment_add");
      this.driver.exec(
        `UPDATE ${qid(input.table)} SET ${qid(input.field)} = ?, "updated_at" = ? WHERE "id" = ?`,
        [JSON.stringify([...ids, id]), createdAt, input.rowId]);
      this.recordRowEvent(input.table, input.rowId, "updated", [input.field]);
    });
    return { id, name: identity.name, mime: identity.mime,
      size: input.bytes.byteLength, sha256: digest, createdAt };
  }

  attachmentsForRecord(table: string, rowId: string, field: string): AttachmentMetadata[] {
    const ids = this.attachmentIds(table, rowId, field);
    if (ids.length === 0) return [];
    const rows = this.driver.select(
      `SELECT id, name, mime, size, sha256, created_at FROM "__clay_attachments"
       WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`, ids);
    const byId = new Map(rows.map(row => [String(row.id), this.attachmentMetadata(row)]));
    return ids.flatMap(id => byId.get(id) ?? []);
  }

  async readAttachment(id: string): Promise<AttachmentFile> {
    const row = this.driver.select(`SELECT * FROM "__clay_attachments"
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
    this.driver.tx(() => {
      this.writeRowHistory(table, rowId, "attachment_remove");
      this.driver.exec(
        `UPDATE ${qid(table)} SET ${qid(field)} = ?, "updated_at" = ? WHERE "id" = ?`,
        [JSON.stringify(ids.filter(candidate => candidate !== id)), now, rowId]);
      if (!this.attachmentActivelyReferenced(id))
        this.driver.exec(`UPDATE "__clay_attachments" SET deleted_at = ? WHERE id = ?`, [now, id]);
      this.recordRowEvent(table, rowId, "updated", [field]);
    });
  }

  attachmentStorage(): AttachmentStorageSummary {
    const rows = this.driver.select(
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
    const candidates = this.driver.select(
      `SELECT id, size FROM "__clay_attachments" WHERE deleted_at IS NOT NULL AND deleted_at <= ?`,
      [cutoff]).filter(row => !this.attachmentRecoverablyReferenced(String(row.id)));
    if (candidates.length > 0) this.driver.tx(() => {
      for (const candidate of candidates)
        this.driver.exec(`DELETE FROM "__clay_attachments" WHERE id = ?`, [String(candidate.id)]);
    });
    return { files: candidates.length,
      bytes: candidates.reduce((total, row) => total + Number(row.size), 0) };
  }

  private async attachmentIntegrityIssues(manifest?: ClayManifest): Promise<string[]> {
    const issues: string[] = [];
    const rows = this.driver.select(`SELECT * FROM "__clay_attachments"`);
    const active = new Set<string>();
    let activeBytes = 0;
    let retainedBytes = 0;
    for (const row of rows) {
      const id = String(row.id);
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
    const referenced = new Set<string>();
    for (const table of this.reg.values()) {
      for (const column of table.columns.filter(candidate =>
        candidate.type === "attachment")) {
        for (const row of this.driver.select(
          `SELECT ${qid(column.name)} AS value FROM ${qid(table.name)}
           WHERE ${qid(column.name)} IS NOT NULL`)) {
          try {
            const ids = JSON.parse(String(row.value)) as unknown;
            if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_FIELD
                || !ids.every(id => typeof id === "string")) throw new Error();
            for (const id of ids) {
              referenced.add(id);
              if (!active.has(id)) issues.push(`attachment field references missing file '${id}'`);
            }
          } catch { issues.push(`attachment field '${table.name}.${column.name}' is invalid`); }
        }
      }
    }
    for (const id of active) if (!referenced.has(id)) issues.push(`active attachment '${id}' is orphaned`);
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
    for (const row of this.driver.select(
      `SELECT id, definition_json, created_at, updated_at, last_event_seq FROM sys.automations`,
    )) {
      const id = String(row.id);
      try {
        const input = JSON.parse(String(row.definition_json)) as AutomationDefinitionInput;
        const normalized = validateAutomationDefinition(this.reg, input);
        if (normalized.id !== id)
          issues.push(`automation '${id}' identity does not match its definition`);
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

  listAutomations(): AutomationDefinition[] {
    return this.driver.select(
      `SELECT id, definition_json, created_at, updated_at FROM sys.automations
       ORDER BY created_at ASC, id ASC`).map(row => ({
      ...(JSON.parse(String(row.definition_json)) as AutomationDefinitionInput),
      id: String(row.id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  upsertAutomation(input: AutomationDefinitionInput): AutomationDefinition {
    const normalized = validateAutomationDefinition(this.reg, input);
    const current = normalized.id
      ? this.driver.select(`SELECT definition_json, created_at, updated_at, last_event_seq
          FROM sys.automations WHERE id = ?`, [normalized.id])[0] : undefined;
    if (normalized.id && !current)
      throw new ClayError("E_VALIDATION", "unknown automation");
    const wallClock = nowIso();
    const now = current && wallClock <= String(current.updated_at)
      ? new Date(Date.parse(String(current.updated_at)) + 1).toISOString() : wallClock;
    const id = normalized.id ?? `auto_${uuidv7().replaceAll("-", "")}`;
    const prior = current
      ? JSON.parse(String(current.definition_json)) as AutomationDefinitionInput : null;
    const maxSeq = Number(this.driver.select(
      `SELECT COALESCE(MAX(seq), 0) AS n FROM sys.record_events`)[0]?.n ?? 0);
    const cursor = !current || (prior && !prior.enabled && normalized.enabled)
      ? maxSeq : Number(current.last_event_seq);
    const stored: AutomationDefinitionInput = { ...normalized, id };
    this.driver.exec(
      `INSERT INTO sys.automations(id, definition_json, created_at, updated_at, last_event_seq)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET definition_json = excluded.definition_json,
         updated_at = excluded.updated_at, last_event_seq = excluded.last_event_seq`,
      [id, JSON.stringify(stored), current ? String(current.created_at) : now, now, cursor]);
    return { ...stored, id, createdAt: current ? String(current.created_at) : now, updatedAt: now };
  }

  deleteAutomation(id: string): void {
    const row = this.driver.select(`SELECT id FROM sys.automations WHERE id = ?`, [id])[0];
    if (!row) throw new ClayError("E_VALIDATION", "unknown automation");
    this.driver.tx(() => {
      this.driver.exec(`DELETE FROM sys.automation_matches WHERE automation_id = ?`, [id]);
      this.driver.exec(`DELETE FROM sys.automations WHERE id = ?`, [id]);
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
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
          const due = typeof raw === "string"
            ? new Date(`${raw.slice(0, 10)}T00:00:00`).getTime() : Number.NaN;
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

  simulateAutomation(id: string, now: Date = new Date()): AutomationSimulation {
    const definition = this.listAutomations().find(candidate => candidate.id === id);
    if (!definition) throw new ClayError("E_VALIDATION", "unknown automation");
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

  private automationRunFromRow(row: SqlRow): AutomationRun {
    return {
      id: String(row.id), automationId: String(row.automation_id), at: String(row.at),
      status: String(row.status) as "success" | "failed",
      matchedRecords: Number(row.matched_count), changed: Number(row.changed_count),
      batchId: row.batch_id === null ? null : String(row.batch_id),
      errorCode: row.error_code === null ? null : String(row.error_code),
      undone: row.undone_at !== null,
    };
  }

  private automationTriggerSucceeded(automationId: string, triggerKey: string): boolean {
    return this.driver.select(
      `SELECT id FROM sys.automation_runs WHERE automation_id = ? AND status = 'success'
       AND (trigger_key = ? OR trigger_key LIKE ?) LIMIT 1`,
      [automationId, triggerKey, `${triggerKey}:retry:%`],
    ).length > 0;
  }

  private executeAutomation(
    definition: AutomationDefinition,
    sources: QueryRow[],
    triggerKey: string,
    now: Date,
    onSuccess?: () => void,
  ): AutomationRun | null {
    if (this.automationTriggerSucceeded(definition.id, triggerKey)) return null;
    const priorFailures = Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM sys.automation_runs WHERE automation_id = ?
       AND (trigger_key = ? OR trigger_key LIKE ?)`,
      [definition.id, triggerKey, `${triggerKey}:retry:%`],
    )[0]?.n ?? 0);
    const persistedTriggerKey = priorFailures > 0
      ? `${triggerKey}:retry:${uuidv7()}` : triggerKey;
    const runId = uuidv7();
    const at = now.toISOString();
    try {
      return this.driver.tx(() => {
        const plan = this.automationPlan(definition, sources);
        const batch = plan.mutations.length > 0 ? this.applyBatch({
          source: "automation", summary: definition.name, mutations: plan.mutations,
        }) : null;
        for (const notice of plan.notifications) {
          const table = definition.trigger.kind === "schedule" ? null : definition.trigger.table;
          this.driver.exec(
            `INSERT INTO sys.notifications(
               id, at, automation_id, run_id, title, body, table_name, row_id, read_at, dismissed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
            [uuidv7(), at, definition.id, runId, notice.action.title, notice.action.body,
             table, notice.source ? String(notice.source.id) : null]);
        }
        const matched = definition.trigger.kind === "schedule" ? 1 : sources.length;
        this.driver.exec(
          `INSERT INTO sys.automation_runs(
             id, automation_id, at, trigger_key, status, matched_count,
             changed_count, batch_id, error_code, undone_at)
           VALUES (?, ?, ?, ?, 'success', ?, ?, ?, NULL, NULL)`,
          [runId, definition.id, at, persistedTriggerKey, matched,
           batch?.changed ?? 0, batch?.id ?? null]);
        onSuccess?.();
        return {
          id: runId, automationId: definition.id, at, status: "success" as const,
          matchedRecords: matched, changed: batch?.changed ?? 0,
          batchId: batch?.id ?? null, errorCode: null, undone: false,
        };
      });
    } catch (error) {
      const code = error instanceof ClayError ? error.code : "E_INTERNAL";
      this.driver.exec(
        `INSERT OR IGNORE INTO sys.automation_runs(
           id, automation_id, at, trigger_key, status, matched_count,
           changed_count, batch_id, error_code, undone_at)
         VALUES (?, ?, ?, ?, 'failed', ?, 0, NULL, ?, NULL)`,
        [runId, definition.id, at, persistedTriggerKey,
         definition.trigger.kind === "schedule" ? 1 : sources.length, code]);
      return {
        id: runId, automationId: definition.id, at, status: "failed",
        matchedRecords: definition.trigger.kind === "schedule" ? 1 : sources.length,
        changed: 0, batchId: null, errorCode: code, undone: false,
      };
    }
  }

  runAutomationNow(id: string, now: Date = new Date()): AutomationRun {
    const definition = this.listAutomations().find(candidate => candidate.id === id);
    if (!definition) throw new ClayError("E_VALIDATION", "unknown automation");
    const rows = this.automationRows(definition, now,
      { maxMatches: 100, truncate: false });
    return this.executeAutomation(definition, rows, `manual:${uuidv7()}`, now)!;
  }

  runDueAutomations(now: Date = new Date()): AutomationRun[] {
    const completed: AutomationRun[] = [];
    for (const definition of this.listAutomations().filter(candidate => candidate.enabled)) {
      const trigger = definition.trigger;
      if (trigger.kind === "record_created" || trigger.kind === "record_updated") {
        const stored = this.driver.select(
          `SELECT last_event_seq FROM sys.automations WHERE id = ?`, [definition.id])[0]!;
        const events = this.driver.select(
          `SELECT seq, row_id, kind, origin, row_json FROM sys.record_events
           WHERE table_name = ? AND seq > ? ORDER BY seq ASC LIMIT 500`,
          [trigger.table, Number(stored.last_event_seq)]);
        let cursor = Number(stored.last_event_seq);
        const eligible = new Map<number, QueryRow>();
        for (const event of events) {
          if (event.origin !== "user"
              || (trigger.kind === "record_created" && event.kind !== "created")
              || (trigger.kind === "record_updated" && event.kind !== "updated")) continue;
          let snapshot: QueryRow | null = null;
          if (typeof event.row_json === "string") {
            try { snapshot = JSON.parse(event.row_json) as QueryRow; }
            catch { snapshot = null; }
          }
          if (!snapshot) snapshot = this.query({
            from: trigger.table,
            where: [{ field: "id", op: "eq", value: String(event.row_id) }],
            limit: 1,
          }, now)[0] ?? null;
          if (snapshot && rowMatchesConditions(snapshot, trigger.conditions, now)) {
            eligible.set(Number(event.seq), snapshot);
            if (eligible.size > 100)
              throw new ClayError("E_LIMIT",
                "automation matches more than 100 queued event records; narrow its conditions");
          }
        }
        for (const event of events) {
          const sequence = Number(event.seq);
          if (event.origin !== "user"
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
          const run = this.executeAutomation(definition, [snapshot], key, now);
          if (run) completed.push(run);
          if (run?.status === "failed") break;
          if (run?.status === "success" || this.automationTriggerSucceeded(definition.id, key))
            cursor = sequence;
        }
        this.driver.exec(`UPDATE sys.automations SET last_event_seq = ? WHERE id = ?`,
          [cursor, definition.id]);
        continue;
      }
      if (trigger.kind === "record_matches") {
        const rows = this.automationRows(definition, now,
          { maxMatches: 100, truncate: false });
        const currentIds = new Set(rows.map(row => String(row.id)));
        for (const active of this.driver.select(
          `SELECT row_id FROM sys.automation_matches WHERE automation_id = ?`, [definition.id])) {
          if (!currentIds.has(String(active.row_id)))
            this.driver.exec(
              `DELETE FROM sys.automation_matches WHERE automation_id = ? AND row_id = ?`,
              [definition.id, String(active.row_id)]);
        }
        const active = new Set(this.driver.select(
          `SELECT row_id FROM sys.automation_matches WHERE automation_id = ?`, [definition.id])
          .map(row => String(row.row_id)));
        for (const row of rows.filter(candidate => !active.has(String(candidate.id)))) {
          const key = `match:${String(row.id)}:${String(row.updated_at)}:${definition.updatedAt}`;
          const rowId = String(row.id);
          const persistMatch = (): void => this.driver.exec(
            `INSERT OR IGNORE INTO sys.automation_matches(automation_id, row_id) VALUES (?, ?)`,
            [definition.id, rowId]);
          const run = this.executeAutomation(definition, [row], key, now, persistMatch);
          if (run) completed.push(run);
          if (!run && this.automationTriggerSucceeded(definition.id, key)) persistMatch();
        }
        continue;
      }
      if (trigger.kind === "date_due") {
        for (const row of this.automationRows(definition, now,
          { maxMatches: 100, truncate: false })) {
          const due = String(row[trigger.dateField] ?? "");
          const run = this.executeAutomation(definition, [row],
            `due:${String(row.id)}:${due}:${trigger.daysBefore}`, now);
          if (run) completed.push(run);
        }
        continue;
      }
      if (trigger.kind === "schedule") {
        const minutes = now.getHours() * 60 + now.getMinutes();
        const [hour, minute] = trigger.localTime.split(":").map(Number);
        if (minutes < hour! * 60 + minute!) continue;
        if (trigger.cadence === "weekly" && now.getDay() !== trigger.weekday) continue;
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const run = this.executeAutomation(definition, [], `schedule:${day}`, now);
        if (run) completed.push(run);
      }
    }
    return completed;
  }

  automationRuns(automationId?: string, limit = 100): AutomationRun[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = automationId
      ? this.driver.select(`SELECT * FROM sys.automation_runs WHERE automation_id = ?
          ORDER BY at DESC, id DESC LIMIT ?`, [automationId, bounded])
      : this.driver.select(`SELECT * FROM sys.automation_runs
          ORDER BY at DESC, id DESC LIMIT ?`, [bounded]);
    return rows.map(row => this.automationRunFromRow(row));
  }

  undoAutomationRun(id: string): AutomationRun {
    let original: SqlRow | undefined;
    this.driver.tx(() => {
      const row = this.driver.select(
        `SELECT * FROM sys.automation_runs WHERE id = ?`, [id])[0];
      if (!row) throw new ClayError("E_VALIDATION", "unknown automation run");
      if (row.undone_at !== null)
        throw new ClayError("E_CONFLICT", "automation run is already undone");
      if (row.status !== "success")
        throw new ClayError("E_CONFLICT", "failed automation has nothing to undo");
      original = row;
      if (row.batch_id !== null) this.undoBatch(String(row.batch_id));
      const at = nowIso();
      this.driver.exec(
        `UPDATE sys.automation_runs SET undone_at = ? WHERE id = ?`, [at, id]);
      this.driver.exec(
        `UPDATE sys.notifications SET dismissed_at = ? WHERE run_id = ?`, [at, id]);
    });
    return { ...this.automationRunFromRow(original!), undone: true };
  }

  listNotifications(limit = 100): ClayNotification[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.driver.select(
      `SELECT * FROM sys.notifications WHERE dismissed_at IS NULL
       ORDER BY at DESC, id DESC LIMIT ?`, [bounded]).map(row => ({
      id: String(row.id), at: String(row.at), automationId: String(row.automation_id),
      runId: String(row.run_id), title: String(row.title), body: String(row.body),
      table: row.table_name === null ? null : String(row.table_name),
      recordId: row.row_id === null ? null : String(row.row_id),
      read: row.read_at !== null,
    }));
  }

  markNotificationRead(id: string): void {
    const changed = this.driver.exec(
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
      return this.driver.tx(() => {
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
          const changed = Number(this.driver.select(
            `SELECT COUNT(*) AS count FROM "row_history" WHERE "batch_id" = ?`, [id],
          )[0]?.count ?? 0);
          this.driver.exec(
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
    return this.driver.select(
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
    const batch = this.driver.select(
      `SELECT id, at, source, summary, changed_count, created_json, undone_at
       FROM sys.operation_batches WHERE id = ?`, [id])[0];
    if (!batch) throw new ClayError("E_VALIDATION", "unknown operation batch");
    if (batch.undone_at !== null) throw new ClayError("E_CONFLICT", "operation batch is already undone");
    const entries = this.driver.select(
      `SELECT "table", "row_id", "before_json", "after_json", "change_kind"
       FROM "row_history" WHERE "batch_id" = ? ORDER BY "sequence" DESC`, [id]);
    if (entries.length !== Number(batch.changed_count))
      throw new ClayError("E_CONFLICT", "operation history is incomplete and cannot be undone safely");

    for (const entry of entries) {
      const table = String(entry.table);
      getTable(this.reg, table);
      const current = this.driver.select(
        `SELECT * FROM ${qid(table)} WHERE "id" = ?`, [String(entry.row_id)])[0];
      if (!current || JSON.stringify(current) !== String(entry.after_json))
        throw new ClayError("E_CONFLICT", "a record changed after this batch; undo was not applied");
    }

    this.driver.tx(() => {
      for (const entry of entries) {
        const table = String(entry.table);
        const rowId = String(entry.row_id);
        if (entry.change_kind === "create") {
          const at = nowIso();
          this.driver.exec(
            `UPDATE ${qid(table)} SET "deleted_at" = ?, "updated_at" = ? WHERE "id" = ?`,
            [at, at, rowId]);
          continue;
        }
        const before = JSON.parse(String(entry.before_json)) as Record<string, SqlValue>;
        const columns = Object.keys(before).filter(column => column !== "id");
        const priorAttachments = this.rowAttachmentIds(table, rowId);
        this.driver.exec(
          `UPDATE ${qid(table)} SET ${columns.map(column => `${qid(column)} = ?`).join(", ")}
           WHERE "id" = ?`, [...columns.map(column => before[column] ?? null), rowId]);
        this.reconcileRowAttachments(table, rowId, priorAttachments);
      }
      this.assertRelationIntegrity();
      this.driver.exec(`UPDATE sys.operation_batches SET undone_at = ? WHERE id = ?`,
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
    const rows = this.driver.select(
      `SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (!rows[0]) return null;
    const historyId = uuidv7();
    this.driver.exec(
      `INSERT INTO "row_history"(
         "id", "table", "row_id", "at", "before_json", "batch_id", "change_kind", "sequence")
       VALUES (?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX("sequence"), 0) + 1 FROM "row_history"))`,
      [historyId, table, id, nowIso(), JSON.stringify(rows[0]),
       this.batchContext?.id ?? null, changeKind]);
    if (this.batchContext)
      this.batchContext.pending.set(`${table}\u0000${id}`, historyId);
    const n = Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
    if (n > this.rowHistoryCap) {
      this.driver.exec(
        `DELETE FROM "row_history" WHERE "id" IN (
           SELECT "id" FROM "row_history" ORDER BY "sequence" ASC LIMIT ?)`,
        [n - this.rowHistoryCap]);
    }
    return historyId;
  }

  private finishBatchHistory(table: string, id: string): void {
    const historyId = this.batchContext?.pending.get(`${table}\u0000${id}`);
    if (!historyId) return;
    const row = this.driver.select(`SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id])[0];
    if (!row) throw new ClayError("E_INTERNAL", "batch result row vanished");
    this.driver.exec(`UPDATE "row_history" SET "after_json" = ? WHERE "id" = ?`,
      [JSON.stringify(row), historyId]);
    this.batchContext!.pending.delete(`${table}\u0000${id}`);
  }

  rowHistoryCount(): number {
    return Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
  }

  /** Local attempt stats for Settings (doc 05 §5). No network. */
  attemptStats(): { kept: number; discarded: number; failed: number; clarify: number } {
    const rows = this.driver.select(
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
    return this.driver.select(
      `SELECT DISTINCT "row_id" FROM "row_history" WHERE "table" = ? AND "at" >= ?`,
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
    return this.driver.select(
      `SELECT "at", "before_json" FROM "row_history"
       WHERE "table" = ? AND "row_id" = ? ORDER BY "sequence" DESC LIMIT ?`,
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
    const entry = this.driver.select(
      `SELECT "before_json" FROM "row_history"
       WHERE "table" = ? AND "row_id" = ? AND COALESCE("change_kind", '') != 'restore'
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
    const current = this.driver.select(`SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id])[0]!;
    if (cols.every(column => current[column] === (before[column] ?? null)))
      return this.rowById(table, id);
    const priorAttachments = this.rowAttachmentIds(table, id);
    if (cols.length > 0) this.driver.tx(() => {
      this.writeRowHistory(table, id, "restore");   // restoring is itself undoable
      this.driver.exec(
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
    const current = this.driver.select(
      `SELECT ${cols.map(qid).join(", ")} FROM ${qid(table)} WHERE "id" = ?`, [id],
    )[0]!;
    if (cols.every((column, index) => (current[column] ?? null) === (vals[index] ?? null)))
      return this.rowById(table, id);
    this.driver.tx(() => {
      this.writeRowHistory(table, id);
      this.driver.exec(
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
    this.driver.tx(() => {
      this.writeRowHistory(table, id, "soft_delete");
      this.driver.exec(
        `UPDATE ${qid(table)} SET "deleted_at" = ?, "updated_at" = ? WHERE "id" = ?`,
        [nowIso(), nowIso(), id]);
      if (!this.batchContext) this.assertRelationIntegrity();
      this.finishBatchHistory(table, id);
      this.recordRowEvent(table, id, "deleted", ["deleted_at"]);
    });
  }

  query(q: QueryT, now: Date = new Date()): QueryRow[] {
    return runQuery(this.driver, this.reg, q, now);
  }

  private mustExist(table: string, id: string): void {
    const rows = this.driver.select(
      `SELECT "id" FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (rows.length === 0)
      throw new ClayError("E_VALIDATION", `no row '${id}' in '${table}'`);
  }

  private rowById(table: string, id: string): QueryRow {
    const rows = runQuery(this.driver, this.reg,
      { from: table, where: [{ field: "id", op: "eq", value: id }], includeDeleted: true });
    const row = rows[0];
    if (!row) throw new ClayError("E_INTERNAL", "row vanished after write");
    return row;
  }

  /** Panel-scoped revert (doc 05 §7): restore the PREVIOUS blob of one
   * panel as a NEW commit — linear history preserved, nothing truncated. */
  revertPanel(panelId: string): number {
    const current = this.livePanels().find(p => p.panel_id === panelId);
    if (!current)
      throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    const rows = this.driver.select(
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
    return this.commit({
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
    return this.driver.select(`SELECT * FROM ${qid(table)} ORDER BY "id"`);
  }

  // ---------- .clay archives (doc 04 §7) ----------
  /** zip{ manifest.json, user.db, system.db } — the backup story and a
   * trust artifact: the whole app in one file. */
  async exportArchive(appName: string): Promise<Uint8Array> {
    this.scrubLegacyCredentialSettings();
    const attachmentIssues = await this.attachmentIntegrityIssues();
    if (attachmentIssues.length > 0)
      throw new ClayError("E_VALIDATION",
        `attachment integrity check failed: ${attachmentIssues.join("; ")}`);
    const { user, system } = await this.driver.exportDatabases();
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
    for (const row of this.driver.select(
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
        select: (sql: string, params?: SqlValue[]) => this.driver.select(sql, params),
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
    issues.push(...this.archiveTimelineIssues(manifest?.format === 4));
    const registryNames = new Set(this.reg.keys());
    const physicalTables = new Set(this.driver.select(
      `SELECT name FROM main.sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN ('row_history', '__clay_attachments')`,
    ).map(row => String(row.name)));
    for (const table of physicalTables)
      if (!registryNames.has(table)) issues.push(`physical table '${table}' is not registered`);
    for (const row of this.driver.select(
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
      const info = this.driver.select(`PRAGMA main.table_info(${qid(t.name)})`);
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
    const markers=this.driver.select("SELECT table_name,column_name,row_id FROM sys.inactive_cells");
    for(const m of markers){
      const t=this.reg.get(String(m.table_name));
      const c=t&&findStoredColumn(t,String(m.column_name));
      if(!t||!c?.inactive){issues.push("inactive-cell marker has no inactive column");continue;}
      const r=this.driver.select(`SELECT ${qid(c.name)} AS v FROM ${qid(t.name)} WHERE "id"=?`,[String(m.row_id)]);
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
    const indexes = this.driver.select(
      `SELECT name, tbl_name FROM main.sqlite_master
       WHERE type = 'index' AND sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'idx_row_history_%'
       ORDER BY name`,
    ).map(row => {
      const name = String(row.name);
      const table = String(row.tbl_name);
      const columns = this.driver.select(`PRAGMA main.index_info(${qid(name)})`);
      if (columns.length !== 1)
        throw new ClayError("E_VALIDATION", `archive index '${name}' is not canonical`);
      return { name, table, column: String(columns[0]!.name) };
    });
    return { tables, indexes };
  }

  async replaceFromArchive(bytes: Uint8Array): Promise<{
    store: ClayStore; manifest: ClayManifest; invalidPanels: string[];
  }> {
    return ClayStore.importArchive(bytes, async () => this.driver);
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
      const fresh = await openFresh();
      const shape = staging.archiveCopyShape();
      let installed: ClayStore | null = null;
      copyDatabase(staging.driver, fresh, shape, () => {
        installed = ClayStore.fromDriver(
          fresh, { requireSemanticRegistry: manifest.format >= 3 });
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
      });
      staging.close();
      return { store: installed!, manifest, invalidPanels };
    } catch (e) {
      staging.close();
      throw e;
    }
  }
}

export type ClayManifest = {
  /** v2 adds rollback tombstones; v3 requires semantics; v4 accounts for files. */
  format: 1 | 2 | 3 | 4;
  app: string;
  exported_at: string;
  tables: number;
  versions: number;
  attachments?: { count: number; bytes: number };
};
