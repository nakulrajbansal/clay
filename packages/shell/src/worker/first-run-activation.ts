import {
  ClayStore, deriveInverse,
  type BatchReceipt, type DbDriver, type MigrationPlanT,
} from "@clay/kernel";
import type { ImportReviewSummary } from "../app/importData";
import {
  FIRST_SUCCESS_SETTING_KEY, reconcileFirstSuccessAfterImportUndo,
  type FirstSuccessState,
} from "../app/first-success-state";
import {
  seedStarterShell,
  type StarterSeedStage,
  type StarterSeedResult,
  type StarterShellId,
} from "../shells/seed";
import {
  parseSampleCreatedResult, readSampleProvenance,
} from "../shells/sample-provenance";
import { starterShellMetadata } from "../shells/starter-catalog";
import { recordProvenanceSummary } from "./samples";

export const FIRST_RUN_PUBLICATION_SETTING_KEY = "first_run_publication_v1";
export const FIRST_RUN_PUBLICATION_STAGES = [
  "stage-opened",
  "structure-staged",
  "records-staged",
  "provenance-staged",
  "receipt-staged",
  "stage-validated",
  "before-publication",
  "during-publication",
  "after-publication",
] as const;

export type FirstRunPublicationFaultStage = typeof FIRST_RUN_PUBLICATION_STAGES[number];
export type ImportColumn = {
  name: string;
  type: "text" | "number" | "date" | "enum";
  values?: string[];
};
export type ImportPayload = { table?: unknown; columns?: unknown; rows?: unknown };
export type ImportResult = { table: string; imported: number; columns: number };
export type StarterActivationRequest = {
  operationId: string;
  appId: string;
  shellId: StarterShellId;
};
export type ImportActivationRequest = {
  operationId: string;
  appId: string;
  table: string;
  columns: unknown[];
  rows: unknown[];
  review: ImportReviewSummary;
};
export type FirstRunImportReceipt = {
  table: string;
  acceptedRows: number;
  rowIds: string[];
  batchIds: string[];
  review: ImportReviewSummary;
  structureRetainedOnUndo: true;
};
export type FirstRunPublicationReceipt = {
  version: 1;
  operationId: string;
  appId: string;
  kind: "starter" | "import";
  sourceFingerprint: string;
  revision: number;
  shellId: StarterShellId;
  undone: boolean;
  import: FirstRunImportReceipt | null;
  sampleCreation: StarterSeedResult | null;
};
export type FirstRunPublicationResult = {
  store: ClayStore;
  receipt: FirstRunPublicationReceipt;
};
export type FirstRunPublicationOptions = {
  fault?: (stage: FirstRunPublicationFaultStage) => void;
  /** Test-only coordination hook. Production leaves this undefined. */
  beforeExclusive?: () => Promise<void>;
  onPublishedStore?: (store: ClayStore) => void;
};
export type UndoFirstRunImportRequest = {
  operationId: string;
  appId: string;
  expectedRevision: number;
};

type ParsedImport = {
  table: string;
  columns: ImportColumn[];
  rows: Record<string, string | number | boolean | null>[];
};

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,39}$/;
const OPERATION_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IMPORT_TYPES = new Set<ImportColumn["type"]>(["text", "number", "date", "enum"]);
const REVIEW_KEYS = [
  "sourceRows", "acceptedRows", "skippedRows", "truncatedRows",
  "sourceColumns", "acceptedColumns", "truncatedColumns",
] as const;

const publicationLocks = new WeakMap<DbDriver, Promise<void>>();

async function withPublicationLock<T>(driver: DbDriver, work: () => Promise<T>): Promise<T> {
  const previous = publicationLocks.get(driver) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  publicationLocks.set(driver, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (publicationLocks.get(driver) === current) publicationLocks.delete(driver);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}

function boundedInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum)
    throw new Error(`${name} is invalid`);
  return Number(value);
}

function requiredString(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function parseReview(value: unknown): ImportReviewSummary {
  if (!record(value) || !exactKeys(value, REVIEW_KEYS))
    throw new Error("import review totals are invalid");
  const result: ImportReviewSummary = {
    sourceRows: boundedInteger(value.sourceRows, "source row count"),
    acceptedRows: boundedInteger(value.acceptedRows, "accepted row count", 5_000),
    skippedRows: boundedInteger(value.skippedRows, "skipped row count"),
    truncatedRows: boundedInteger(value.truncatedRows, "truncated row count"),
    sourceColumns: boundedInteger(value.sourceColumns, "source field count"),
    acceptedColumns: boundedInteger(value.acceptedColumns, "accepted field count", 20),
    truncatedColumns: boundedInteger(value.truncatedColumns, "truncated field count"),
  };
  if (result.acceptedRows < 1
      || result.sourceRows !== result.acceptedRows + result.skippedRows + result.truncatedRows
      || result.acceptedColumns < 1
      || result.sourceColumns !== result.acceptedColumns + result.truncatedColumns)
    throw new Error("import review totals do not reconcile");
  return result;
}

function parseColumns(value: unknown): ImportColumn[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    throw new Error("import needs 1 to 20 reviewed fields");
  const columns: ImportColumn[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!record(raw) || !exactKeys(raw,
      raw.values === undefined ? ["name", "type"] : ["name", "type", "values"]))
      throw new Error("import field is invalid");
    const name = requiredString(raw.name, "import field name", IDENTIFIER);
    if (names.has(name)) throw new Error("import field names must be unique");
    names.add(name);
    if (typeof raw.type !== "string" || !IMPORT_TYPES.has(raw.type as ImportColumn["type"]))
      throw new Error("import field type is invalid");
    const type = raw.type as ImportColumn["type"];
    let values: string[] | undefined;
    if (raw.values !== undefined) {
      if (type !== "enum" || !Array.isArray(raw.values) || raw.values.length < 1
          || raw.values.length > 100 || raw.values.some(item => typeof item !== "string")
          || new Set(raw.values).size !== raw.values.length)
        throw new Error("import enum values are invalid");
      values = raw.values.map(item => String(item));
    }
    columns.push(values ? { name, type, values } : { name, type });
  }
  return columns;
}

function parseRows(
  value: unknown,
  columns: readonly ImportColumn[],
): Record<string, string | number | boolean | null>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5_000)
    throw new Error("import needs 1 to 5,000 reviewed rows");
  const allowed = new Set(columns.map(column => column.name));
  const rows: Record<string, string | number | boolean | null>[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!record(raw)) throw new Error("import row is invalid");
    const row: Record<string, string | number | boolean | null> = {};
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new Error("import row contains an unreviewed field");
      const cell = raw[key];
      if (cell !== null && typeof cell !== "string" && typeof cell !== "number"
          && typeof cell !== "boolean")
        throw new Error("import row contains an unsupported value");
      if (typeof cell === "number" && !Number.isFinite(cell))
        throw new Error("import row contains a non-finite number");
      row[key] = cell;
    }
    if (Object.keys(row).length === 0) throw new Error("import row is empty");
    rows.push(row);
  }
  return rows;
}

function parseImport(value: unknown): ParsedImport {
  if (!record(value)) throw new Error("import request is invalid");
  const table = requiredString(value.table, "import table", IDENTIFIER);
  const columns = parseColumns(value.columns);
  const rows = parseRows(value.rows, columns);
  return { table, columns, rows };
}

function parseStarterRequest(value: unknown): StarterActivationRequest {
  if (!record(value) || !exactKeys(value, ["operationId", "appId", "shellId"]))
    throw new Error("starter activation request is invalid");
  const operationId = requiredString(value.operationId, "operation id", OPERATION_ID);
  const appId = requiredString(value.appId, "app binding", /^default$/);
  const shellId = requiredString(value.shellId, "starter id", /^[a-z_]+$/) as StarterShellId;
  starterShellMetadata(shellId);
  return { operationId, appId, shellId };
}

function parseImportRequest(value: unknown): ImportActivationRequest & ParsedImport {
  if (!record(value) || !exactKeys(value,
    ["operationId", "appId", "table", "columns", "rows", "review"]))
    throw new Error("import activation request is invalid");
  const operationId = requiredString(value.operationId, "operation id", OPERATION_ID);
  const appId = requiredString(value.appId, "app binding", /^default$/);
  const parsed = parseImport(value);
  const review = parseReview(value.review);
  if (review.acceptedRows !== parsed.rows.length
      || review.acceptedColumns !== parsed.columns.length)
    throw new Error("reviewed import does not match the accepted subset");
  return { operationId, appId, ...parsed, review };
}

function parseUndoRequest(value: unknown): UndoFirstRunImportRequest {
  if (!record(value) || !exactKeys(value, ["operationId", "appId", "expectedRevision"]))
    throw new Error("Undo import request is invalid");
  return {
    operationId: requiredString(value.operationId, "operation id", OPERATION_ID),
    appId: requiredString(value.appId, "app binding", /^default$/),
    expectedRevision: boundedInteger(value.expectedRevision, "expected revision"),
  };
}

function parseStringArray(
  value: unknown,
  name: string,
  pattern: RegExp,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximum
      || value.some(item => typeof item !== "string" || !pattern.test(item))
      || new Set(value).size !== value.length)
    throw new Error(`${name} is invalid`);
  return value.map(item => String(item));
}

function parseImportReceipt(value: unknown): FirstRunImportReceipt {
  if (!record(value) || !exactKeys(value, [
    "table", "acceptedRows", "rowIds", "batchIds", "review", "structureRetainedOnUndo",
  ])) throw new Error("import publication receipt is invalid");
  const review = parseReview(value.review);
  const acceptedRows = boundedInteger(value.acceptedRows, "receipt accepted rows", 5_000);
  const rowIds = parseStringArray(value.rowIds, "receipt row ids", ROW_ID, 5_000);
  const batchIds = parseStringArray(value.batchIds, "receipt batch ids", ROW_ID, 10);
  if (acceptedRows < 1 || acceptedRows !== rowIds.length
      || acceptedRows !== review.acceptedRows || batchIds.length < 1
      || value.structureRetainedOnUndo !== true)
    throw new Error("import publication receipt does not reconcile");
  return {
    table: requiredString(value.table, "receipt table", IDENTIFIER),
    acceptedRows, rowIds, batchIds, review, structureRetainedOnUndo: true,
  };
}

function parsePublicationReceipt(value: unknown): FirstRunPublicationReceipt {
  if (!record(value) || !exactKeys(value, [
    "version", "operationId", "appId", "kind", "sourceFingerprint", "revision",
    "shellId", "undone", "import", "sampleCreation",
  ])) throw new Error("first-run publication receipt is invalid");
  if (value.version !== 1 || (value.kind !== "starter" && value.kind !== "import")
      || typeof value.undone !== "boolean")
    throw new Error("first-run publication receipt is invalid");
  const operationId = requiredString(value.operationId, "receipt operation id", OPERATION_ID);
  const appId = requiredString(value.appId, "receipt app binding", /^default$/);
  const sourceFingerprint = requiredString(value.sourceFingerprint, "receipt source fingerprint", SHA256);
  const revision = boundedInteger(value.revision, "receipt revision");
  if (revision < 1) throw new Error("receipt revision is invalid");
  const shellId = requiredString(value.shellId, "receipt starter id", /^[a-z_]+$/) as StarterShellId;
  starterShellMetadata(shellId);
  const imported = value.import === null ? null : parseImportReceipt(value.import);
  const sampleCreation = value.sampleCreation === null
    ? null : parseSampleCreatedResult(value.sampleCreation);
  if ((value.kind === "import") !== (imported !== null)
      || (value.kind === "starter") !== (sampleCreation?.route === "starter.seed")
      || (value.kind === "starter" && value.undone))
    throw new Error("first-run publication receipt kind is invalid");
  return {
    version: 1, operationId, appId, kind: value.kind, sourceFingerprint,
    revision, shellId, undone: value.undone, import: imported,
    sampleCreation: sampleCreation as StarterSeedResult | null,
  };
}

export function readFirstRunPublication(
  store: ClayStore,
  appIdValue: unknown,
): FirstRunPublicationReceipt | null {
  const appId = requiredString(appIdValue, "app binding", /^default$/);
  let value: unknown;
  try { value = store.getSetting<unknown>(FIRST_RUN_PUBLICATION_SETTING_KEY); }
  catch { throw new Error("first-run publication receipt is invalid"); }
  if (value === undefined) return null;
  const receipt = parsePublicationReceipt(value);
  if (receipt.appId !== appId) throw new Error("first-run publication app binding does not match");
  return receipt;
}

function firstSuccess(
  shellId: StarterShellId,
  path: "recommended" | "blank" | "import",
  imported: boolean,
): FirstSuccessState {
  return {
    version: 1,
    revision: imported ? 2 : 1,
    dismissed: false,
    steps: {
      app: { state: "complete", path, shellId },
      realRecord: imported ? { state: "complete", source: "import" } : { state: "pending" },
      work: { state: "pending" },
      customization: { state: "pending" },
    },
  };
}

function importTablePanelCode(table: string, columns: ImportColumn[]): string {
  const cols = columns.map(column => {
    const format = column.type === "number" ? ', format: "number"'
      : column.type === "date" ? ', format: "date"' : "";
    return `{ field: ${JSON.stringify(column.name)}, label: ${JSON.stringify(column.name)}${format} }`;
  }).join(", ");
  return `export default function (clay) {
  clay.db.watch({ from: ${JSON.stringify(table)}, limit: 500 }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No rows yet" })
      : h(Table, { sortable: true, rows, columns: [${cols}] }));
  });
}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

function importTableIntoStore(
  store: ClayStore,
  parsed: ParsedImport,
  afterStructure?: () => void,
): { result: ImportResult; batches: BatchReceipt[] } {
  const registry = store.registrySnapshot();
  let table = parsed.table;
  let suffix = 2;
  while (registry.has(table)) table = `${parsed.table}_${suffix++}`;
  if (!IDENTIFIER.test(table)) throw new Error("import table collision limit was reached");
  const operations: MigrationPlanT["operations"] = [{
    op: "create_table", table,
    columns: parsed.columns.map(column => ({
      name: column.name, type: column.type, required: false,
      ...(column.values ? { values: column.values } : {}),
    })),
  }];
  const panelId = `${table}_view`.slice(0, 40).replace(/^[^a-z]/, "t");
  store.commit({
    intent: `Import data (${table})`,
    summary: `Imports ${parsed.rows.length} accepted row${parsed.rows.length === 1 ? "" : "s"} into ${table}.`,
    migration: { operations, inverse: deriveInverse(operations, registry) },
    panels: [{
      panel_id: panelId, title: table, placement: { region: "main", order: 0, w: 4 },
      code: importTablePanelCode(table, parsed.columns),
      declared_queries: [{ from: table, limit: 500 }], declared_writes: [],
    }],
  });
  afterStructure?.();
  const batches = chunk(parsed.rows, 500).map((rows, index) => store.applyBatch({
    source: "user",
    summary: parsed.rows.length <= 500
      ? `Import accepted rows into ${table}`
      : `Import accepted rows into ${table} (${index + 1} of ${Math.ceil(parsed.rows.length / 500)})`,
    mutations: rows.map(row => ({ kind: "insert" as const, table, row })),
  }));
  const imported = batches.reduce((total, batch) => total + batch.changed, 0);
  if (imported !== parsed.rows.length
      || batches.some(batch => batch.changed !== batch.created.length))
    throw new Error("reviewed import was not written exactly");
  return { result: { table, imported, columns: parsed.columns.length }, batches };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function assertStageReceipt(
  store: ClayStore,
  receipt: FirstRunPublicationReceipt,
): void {
  const issues = store.verifyIntegrity();
  if (issues.length > 0) throw new Error(`first-run stage failed integrity checks: ${issues.join("; ")}`);
  if (store.headVersion() !== receipt.revision)
    throw new Error("first-run receipt revision does not match staged state");
  const persisted = readFirstRunPublication(store, receipt.appId);
  if (JSON.stringify(persisted) !== JSON.stringify(receipt))
    throw new Error("first-run receipt read-back does not match staged state");
  if (receipt.sampleCreation) {
    const retained = readSampleProvenance(store).map(
      ({ tableId, rowId, operationId }) => ({ tableId, rowId, operationId }),
    );
    if (JSON.stringify(retained) !== JSON.stringify(receipt.sampleCreation.created))
      throw new Error("starter seed result does not match staged sample provenance");
  }
  if (receipt.import) {
    const batches = new Map(store.operationBatches(50).map(batch => [batch.id, batch]));
    const created = receipt.import.batchIds.flatMap(id => batches.get(id)?.created ?? []);
    if (created.length !== receipt.import.acceptedRows
        || created.some((row, index) => row.table !== receipt.import!.table
          || row.id !== receipt.import!.rowIds[index]))
      throw new Error("first-run import receipt rows do not match staged state");
  }
}

async function publishStage(
  canonical: ClayStore,
  stage: ClayStore,
  receipt: FirstRunPublicationReceipt,
  options: FirstRunPublicationOptions,
): Promise<FirstRunPublicationResult> {
  stage.setSetting(FIRST_RUN_PUBLICATION_SETTING_KEY, receipt);
  options.fault?.("receipt-staged");
  assertStageReceipt(stage, receipt);
  options.fault?.("stage-validated");
  const archive = await stage.exportArchive("First run publication");
  options.fault?.("before-publication");
  const published = await canonical.replaceFromArchive(archive, installed => {
    const installedReceipt = readFirstRunPublication(installed, receipt.appId);
    if (JSON.stringify(installedReceipt) !== JSON.stringify(receipt))
      throw new Error("published first-run receipt failed canonical read-back");
    options.fault?.("during-publication");
  });
  const installedReceipt = readFirstRunPublication(published.store, receipt.appId);
  if (!installedReceipt) throw new Error("published first-run receipt is missing");
  options.onPublishedStore?.(published.store);
  options.fault?.("after-publication");
  return { store: published.store, receipt: installedReceipt };
}

function assertFreshTarget(store: ClayStore): void {
  if (store.headVersion() !== 0 || store.registrySnapshot().size !== 0)
    throw new Error("first-run publication target is not empty");
}

async function priorPublication(
  store: ClayStore,
  appId: string,
  operationId: string,
  sourceFingerprint: string,
): Promise<FirstRunPublicationResult | null> {
  const prior = readFirstRunPublication(store, appId);
  if (!prior) return null;
  if (prior.operationId !== operationId)
    throw new Error("first-run target was published by a different operation");
  if (prior.sourceFingerprint !== sourceFingerprint)
    throw new Error("operation is bound to a different source");
  if (store.headVersion() !== prior.revision)
    throw new Error("published receipt revision no longer matches the canonical app");
  return { store, receipt: prior };
}

export async function activateStarterAtomically(
  driver: DbDriver,
  canonical: ClayStore,
  requestValue: unknown,
  options: FirstRunPublicationOptions = {},
): Promise<FirstRunPublicationResult> {
  const request = parseStarterRequest(requestValue);
  const sourceFingerprint = await sha256({
    version: 1, kind: "starter", appId: request.appId, shellId: request.shellId,
  });
  await options.beforeExclusive?.();
  return withPublicationLock(driver, async () => {
    const prior = await priorPublication(
      canonical, request.appId, request.operationId, sourceFingerprint,
    );
    if (prior) return prior;
    assertFreshTarget(canonical);

    const stage = await ClayStore.openMemory();
    try {
      options.fault?.("stage-opened");
      const sampleCreation = seedStarterShell(stage, request.shellId, (seedStage: StarterSeedStage) => {
        if (seedStage === "provenance-staged") {
          stage.setSetting(FIRST_SUCCESS_SETTING_KEY, firstSuccess(
            request.shellId,
            request.shellId === "blank" ? "blank" : "recommended",
            false,
          ));
        }
        options.fault?.(seedStage);
      });
      const receipt: FirstRunPublicationReceipt = {
        version: 1,
        operationId: request.operationId,
        appId: request.appId,
        kind: "starter",
        sourceFingerprint,
        revision: stage.headVersion(),
        shellId: request.shellId,
        undone: false,
        import: null,
        sampleCreation,
      };
      return await publishStage(canonical, stage, receipt, options);
    } finally {
      stage.close();
    }
  });
}

export async function activateImportedAppAtomically(
  driver: DbDriver,
  canonical: ClayStore,
  requestValue: unknown,
  options: FirstRunPublicationOptions = {},
): Promise<FirstRunPublicationResult> {
  const request = parseImportRequest(requestValue);
  const sourceFingerprint = await sha256({
    version: 1,
    kind: "import",
    appId: request.appId,
    table: request.table,
    columns: request.columns,
    rows: request.rows,
    review: request.review,
  });
  await options.beforeExclusive?.();
  return withPublicationLock(driver, async () => {
    const prior = await priorPublication(
      canonical, request.appId, request.operationId, sourceFingerprint,
    );
    if (prior) return prior;
    assertFreshTarget(canonical);

    const stage = await ClayStore.openMemory();
    try {
      options.fault?.("stage-opened");
      const imported = importTableIntoStore(
        stage, request, () => options.fault?.("structure-staged"),
      );
      options.fault?.("records-staged");
      stage.setSetting("shell_id", "blank");
      stage.setSetting(FIRST_SUCCESS_SETTING_KEY, firstSuccess("blank", "import", true));
      options.fault?.("provenance-staged");
      const rowIds = imported.batches.flatMap(batch => batch.created.map(row => row.id));
      const receipt: FirstRunPublicationReceipt = {
        version: 1,
        operationId: request.operationId,
        appId: request.appId,
        kind: "import",
        sourceFingerprint,
        revision: stage.headVersion(),
        shellId: "blank",
        undone: false,
        import: {
          table: imported.result.table,
          acceptedRows: imported.result.imported,
          rowIds,
          batchIds: imported.batches.map(batch => batch.id),
          review: request.review,
          structureRetainedOnUndo: true,
        },
        sampleCreation: null,
      };
      return await publishStage(canonical, stage, receipt, options);
    } finally {
      stage.close();
    }
  });
}

/** Existing-app import remains a single synchronous SQLite transaction. That
 * avoids replacing a snapshot over intervening writes while still rolling back
 * structure and every accepted row together. */
export async function importTableAtomically(
  driver: DbDriver,
  canonical: ClayStore,
  payload: ImportPayload,
  onPublishedStore?: (store: ClayStore) => void,
): Promise<{ store: ClayStore; result: ImportResult }> {
  const parsed = parseImport(payload);
  try {
    const result = driver.tx(() => importTableIntoStore(canonical, parsed).result);
    return { store: canonical, result };
  } catch (error) {
    // A failed outer transaction can leave ClayStore's in-memory registry at
    // its staged shape even though SQLite rolled back. Rebind the worker facade
    // to canonical read-back before surfacing the original failure.
    const rebound = ClayStore.fromDriver(driver);
    onPublishedStore?.(rebound);
    throw error;
  }
}

export function undoFirstRunImportAtomically(
  driver: DbDriver,
  store: ClayStore,
  requestValue: unknown,
): FirstRunPublicationReceipt {
  const request = parseUndoRequest(requestValue);
  const receipt = readFirstRunPublication(store, request.appId);
  if (!receipt || receipt.operationId !== request.operationId)
    throw new Error("Undo import operation does not match the canonical receipt");
  if (receipt.kind !== "import" || !receipt.import)
    throw new Error("this first-run publication has no import to undo");
  if (receipt.undone) throw new Error("import is already undone");
  if (request.expectedRevision !== receipt.revision || store.headVersion() !== receipt.revision)
    throw new Error("import revision changed; Undo was not applied");

  return driver.tx(() => {
    for (const batchId of [...receipt.import!.batchIds].reverse()) store.undoBatch(batchId);
    const provenance = recordProvenanceSummary(store);
    if (!provenance.provenanceValid)
      throw new Error("record provenance is invalid; Undo was not applied");
    const progress = store.getSetting<unknown>(FIRST_SUCCESS_SETTING_KEY);
    if (progress === undefined)
      throw new Error("first-success progress is missing; Undo was not applied");
    store.setSetting(FIRST_SUCCESS_SETTING_KEY,
      reconcileFirstSuccessAfterImportUndo(progress, provenance.realRecordCount > 0));
    const undone: FirstRunPublicationReceipt = { ...receipt, undone: true };
    store.setSetting(FIRST_RUN_PUBLICATION_SETTING_KEY, undone);
    const readBack = readFirstRunPublication(store, request.appId);
    if (!readBack || !readBack.undone)
      throw new Error("Undo import receipt did not read back");
    return readBack;
  });
}
