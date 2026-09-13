import { z } from "zod";
import {
  DAILY_HOME_SOURCE_IDS_V1,
  DailySourceLibraryV1,
  type DailyHomeItemV1,
  type DailyHomeProjectionAuthorityV1,
  type DailyHomeSnapshotV1,
  type DailyHomeSourceIdV1,
  type DailyHomeSourceSnapshotV1,
  type InboxDispositionV1,
} from "@clay/schema/daily-home";
import type { Query } from "@clay/schema";
import type { ClayNotification } from "./automation";
import { buildDailyHomeSnapshot, deriveDailyHomeSections, compareCanonicalItems } from "./daily-home-basis";
import { localCalendarContext, parseDailyTemporal, resolveLocalDateTime } from "./daily-calendar";
import {
  DAILY_SOURCE_LIBRARY_SETTING,
  resolveDailySourceProfiles,
} from "./daily-source-profile";
import {
  DAILY_NAVIGATION_SETTING,
  loadDailyNavigationState,
  type DailyFavoriteReference,
  type DailyNavigationState,
  type DailyRecentReference,
} from "./daily-navigation";
import type { QueryRow } from "./query";
import type { RegTable, Registry } from "./registry";
import { sha256HexSync } from "./state-digest";

export { DAILY_SOURCE_LIBRARY_SETTING };
export const OPERATIONAL_VIEWS_SETTING = "operational_views_v1";
export const SAMPLE_ROWS_SETTING = "sample_rows";
const PAGE_SIZE = 20;
const SCAN_PAGE_SIZE = 500;
const SCAN_LIMIT = 20_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const VIEW_ID = /^view_[0-9a-f]{32}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const TABLE_ID = /^tbl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELD_ID = /^fld_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTER_OPS = [
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null",
  "not_null", "within_days", "older_than_days",
] as const;
const OperationalCondition = z.object({
  field: z.string().regex(FIELD_NAME),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
}).strict().superRefine((value, context) => {
  const hasValue = Object.prototype.hasOwnProperty.call(value, "value");
  if (value.op === "is_null" || value.op === "not_null") {
    if (hasValue) context.addIssue({ code: "custom", message: "null filters have no value" });
    return;
  }
  const valid = value.op === "in"
    ? Array.isArray(value.value) && value.value.length <= 50
      && value.value.every(item => typeof item === "string" || typeof item === "number")
    : value.op === "within_days" || value.op === "older_than_days"
      ? typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0
      : value.op === "contains" ? typeof value.value === "string"
        : typeof value.value === "string" || typeof value.value === "number"
          || typeof value.value === "boolean";
  if (!hasValue || !valid) context.addIssue({ code: "custom", message: "invalid filter value" });
});
const OperationalView = z.object({
  id: z.string().regex(VIEW_ID),
  name: z.string().min(1).max(80),
  table: z.string().regex(FIELD_NAME),
  search: z.string().max(120),
  filters: z.array(OperationalCondition).max(8),
  orderBy: z.array(z.object({
    field: z.string().regex(FIELD_NAME), dir: z.enum(["asc", "desc"]),
  }).strict()).max(4),
  visibleFields: z.array(z.string().regex(FIELD_NAME)).max(64),
  identity: z.object({
    tableId: z.string().regex(TABLE_ID),
    filterFieldIds: z.array(z.string().regex(FIELD_ID)).max(8),
    orderFieldIds: z.array(z.string().regex(FIELD_ID)).max(4),
    visibleFieldIds: z.array(z.string().regex(FIELD_ID)).max(64),
  }).strict().optional(),
  createdAt: z.string().max(64).refine(value => Number.isFinite(Date.parse(value))),
  updatedAt: z.string().max(64).refine(value => Number.isFinite(Date.parse(value))),
}).strict().superRefine((value, context) => {
  if (value.identity && (value.identity.filterFieldIds.length !== value.filters.length
      || value.identity.orderFieldIds.length !== value.orderBy.length
      || value.identity.visibleFieldIds.length !== value.visibleFields.length)) {
    context.addIssue({ code: "custom", message: "saved view semantic bindings are incomplete" });
  }
});
const OperationalViewLibrary = z.object({
  format: z.literal(1), revision: z.number().int().nonnegative().safe(),
  views: z.array(OperationalView).max(50),
}).strict().superRefine((value, context) => {
  if (new Set(value.views.map(view => view.id)).size !== value.views.length)
    context.addIssue({ code: "custom", path: ["views"], message: "saved view ids must be unique" });
});

type SourceSnapshot = DailyHomeSourceSnapshotV1;
type DailyItem = DailyHomeItemV1;
type Completeness = SourceSnapshot["page"]["counts"]["sourceOccurrences"];
type SourceStatus = SourceSnapshot["status"];

export type DailyHomeRecordRevisionSnapshot = Readonly<{
  watermark: number;
  truncated: boolean;
  entries: readonly Readonly<{ table: string; rowId: string; revision: number }>[];
}>;

export type DailyHomeProjectionReader = Readonly<{
  inboxDispositions?(): InboxDispositionV1[];
  registrySnapshot(): Registry;
  query(query: Query): QueryRow[];
  listNotifications(limit?: number): ClayNotification[];
  dailyHomeUnreadNotifications(limit?: number): Readonly<{
    notifications: readonly ClayNotification[];
    truncated: boolean;
  }>;
  headVersion(): number;
  getSetting<T>(key: string): T | undefined;
  dailyHomeRecordRevisions?(): DailyHomeRecordRevisionSnapshot;
  dailyHomeNotificationWatermark?(): string;
}>;

export type DailyHomeProjectionContext = Readonly<{
  appInstanceId: string;
  activeGenerationId: string;
  now: string;
  timeZone: string;
}>;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function opaqueSourceKey(domain: string): string {
  const digest = sha256HexSync(new TextEncoder().encode(`clay.daily-home.source.v1\u0000${domain}`));
  const value = BigInt(`0x${digest}`);
  let encoded = "";
  for (let index = 0; index < 26; index++) {
    const shift = BigInt(256 - ((index + 1) * 5));
    encoded += BASE32[Number((value >> shift) & 31n)]!;
  }
  return `inb_${encoded}`;
}

function opaqueSourceGeneration(domain: string): string {
  const digest = sha256HexSync(new TextEncoder().encode(
    `clay.daily-home.generation.v1\u0000${domain}`,
  ));
  const value = BigInt(`0x${digest}`);
  let encoded = "";
  for (let index = 0; index < 26; index++) {
    const shift = BigInt(256 - ((index + 1) * 5));
    encoded += BASE32[Number((value >> shift) & 31n)]!;
  }
  return `gen_${encoded}`;
}

type RecordRevisionIndex = Readonly<{
  native: boolean;
  watermark: string;
  truncated: boolean;
  byRecord: ReadonlyMap<string, number>;
}>;

function recordRevisionIndex(reader: DailyHomeProjectionReader): RecordRevisionIndex {
  const snapshot = reader.dailyHomeRecordRevisions?.();
  if (!snapshot) return {
    native: false,
    watermark: "record-times:0",
    truncated: false,
    byRecord: new Map(),
  };
  if (!Number.isSafeInteger(snapshot.watermark) || snapshot.watermark < 0
      || !Array.isArray(snapshot.entries))
    throw new TypeError("invalid Daily Home record revision snapshot");
  const byRecord = new Map<string, number>();
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.table !== "string" || typeof entry.rowId !== "string"
        || !Number.isSafeInteger(entry.revision) || entry.revision < 1)
      throw new TypeError("invalid Daily Home record revision snapshot");
    const key = `${entry.table}\u0000${entry.rowId}`;
    if (byRecord.has(key)) throw new TypeError("duplicate Daily Home record revision");
    byRecord.set(key, entry.revision);
  }
  return {
    native: true,
    watermark: `record-events:${snapshot.watermark}`,
    truncated: snapshot.truncated,
    byRecord,
  };
}

function recordOccurrenceGeneration(
  revisions: RecordRevisionIndex,
  table: string,
  rowId: string,
  updatedAt: string,
): Readonly<{ generation: string; nativeMissing: boolean }> {
  const revision = revisions.byRecord.get(`${table}\u0000${rowId}`);
  return {
    generation: opaqueSourceGeneration(
      `record\u0000${table}\u0000${rowId}\u0000${revision ?? `time:${updatedAt}`}`,
    ),
    nativeMissing: revisions.native && revision === undefined,
  };
}

type SampleProvenance = Readonly<{
  valid: boolean;
  identities: ReadonlySet<string>;
  watermark: string;
}>;

function sampleProvenance(reader: DailyHomeProjectionReader, registry: Registry): SampleProvenance {
  const raw = reader.getSetting<unknown>(SAMPLE_ROWS_SETTING);
  if (raw === undefined || raw === null) return {
    valid: false, identities: new Set(), watermark: "samples:missing",
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)
      || (Reflect.getPrototypeOf(raw) !== Object.prototype
        && Reflect.getPrototypeOf(raw) !== null)) return {
    valid: false, identities: new Set(), watermark: "samples:invalid",
  };
  const rootKeys = Reflect.ownKeys(raw);
  const format = Reflect.getOwnPropertyDescriptor(raw, "format");
  const tables = Reflect.getOwnPropertyDescriptor(raw, "tables");
  if (rootKeys.length !== 2 || !rootKeys.includes("format") || !rootKeys.includes("tables")
      || !format || !("value" in format) || format.value !== 1
      || !tables || !("value" in tables)
      || typeof tables.value !== "object" || tables.value === null || Array.isArray(tables.value)
      || (Reflect.getPrototypeOf(tables.value) !== Object.prototype
        && Reflect.getPrototypeOf(tables.value) !== null)) return {
    valid: false, identities: new Set(), watermark: "samples:invalid",
  };
  const identities = new Set<string>();
  let valid = true;
  let total = 0;
  const keys = Reflect.ownKeys(tables.value);
  if (keys.length > 256 || keys.some(key => typeof key !== "string")) valid = false;
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(tables.value, key);
    if (!descriptor || !("value" in descriptor) || !FIELD_NAME.test(key)
        || !registry.has(key) || !Array.isArray(descriptor.value)
        || Reflect.getPrototypeOf(descriptor.value) !== Array.prototype
        || descriptor.value.length > 20_000) {
      valid = false;
      continue;
    }
    total += descriptor.value.length;
    if (total > 100_000 || new Set(descriptor.value).size !== descriptor.value.length) valid = false;
    for (const rowId of descriptor.value) {
      if (typeof rowId !== "string" || !ROW_ID.test(rowId)) {
        valid = false;
        continue;
      }
      identities.add(`${key}\u0000${rowId}`);
    }
  }
  const canonical = [...identities].sort(compare).join("\u0001");
  const digest = sha256HexSync(new TextEncoder().encode(
    `clay.daily-home.samples.v1\u0000${valid ? "valid" : "invalid"}\u0000${canonical}`,
  ));
  return { valid, identities, watermark: `samples:${digest.slice(0, 32)}` };
}

function isSample(provenance: SampleProvenance, table: string, rowId: string): boolean {
  return provenance.identities.has(`${table}\u0000${rowId}`);
}

function exactCompleteness(total: number): Completeness {
  return { kind: "exact", total };
}

function partialCompleteness(
  sourceId: DailyHomeSourceIdV1,
  knownMinimum: number,
  reason: "unavailable" | "invalid_source" | "limit",
  retryable: boolean,
): Completeness {
  return { kind: "partial", knownMinimum, gaps: [{ sourceId, reason, retryable }] };
}

function sourceSnapshot(
  sourceId: DailyHomeSourceIdV1,
  items: DailyItem[],
  options: Readonly<{
    watermark: string | null;
    status?: SourceStatus;
    reason?: "unavailable" | "invalid_source" | "limit";
    retryable?: boolean;
    knownMinimum?: number;
  }>,
): SourceSnapshot {
  const status = options.status ?? "ready";
  const partial = status !== "ready";
  const counts = partial
    ? partialCompleteness(
        sourceId,
        options.knownMinimum ?? items.length,
        options.reason ?? "unavailable",
        options.retryable ?? true,
      )
    : exactCompleteness(items.length);
  return {
    sourceId,
    watermark: options.watermark,
    status,
    statusEpoch: `daily-home:${status}:1`,
    page: {
      items,
      returned: items.length,
      counts: { sourceOccurrences: counts, renderedUnique: counts },
      continuation: { kind: "end" },
    },
  };
}

function readSourceLibrary(reader: DailyHomeProjectionReader) {
  const parsed = DailySourceLibraryV1.safeParse(
    reader.getSetting<unknown>(DAILY_SOURCE_LIBRARY_SETTING),
  );
  return parsed.success ? parsed.data : { schema: 1 as const, revision: 0, profiles: [] };
}

function scanTable(reader: DailyHomeProjectionReader, table: string): {
  rows: QueryRow[];
  truncated: boolean;
} {
  const rows: QueryRow[] = [];
  let afterId: string | null = null;
  while (rows.length < SCAN_LIMIT) {
    const page = reader.query({
      from: table,
      orderBy: [{ field: "id", dir: "asc" }],
      limit: Math.min(SCAN_PAGE_SIZE, SCAN_LIMIT - rows.length),
      ...(afterId === null ? {} : { where: [{ field: "id", op: "gt", value: afterId }] }),
    });
    rows.push(...page);
    if (page.length < SCAN_PAGE_SIZE) return { rows, truncated: false };
    afterId = String(page.at(-1)!.id);
  }
  const overflow = reader.query({
    from: table,
    where: [{ field: "id", op: "gt", value: afterId! }],
    orderBy: [{ field: "id", dir: "asc" }],
    limit: 1,
  });
  return { rows, truncated: overflow.length > 0 };
}

function complete(
  row: QueryRow,
  completion: ReturnType<typeof resolveDailySourceProfiles>["ready"][number]["completion"],
): boolean {
  if (completion.kind === "none") return false;
  if (completion.kind === "boolean") return row[completion.columnName] === true;
  const value = row[completion.columnName];
  return typeof value === "string" && completion.terminalValues.includes(value);
}

function applyDispositions(items: DailyItem[], dispositions: readonly InboxDispositionV1[], now: string): void {
  const byKey = new Map(dispositions.map(row => [row.sourceKey, row]));
  if (byKey.size !== dispositions.length) throw new TypeError("Duplicate Inbox disposition identity");
  let visible = 0;
  for (const item of items) {
    if (item.kind !== "due_record" && item.kind !== "automation_notification") throw new TypeError("Invalid Inbox source item");
    const disposition = byKey.get(item.sourceKey);
    if (disposition?.sourceGeneration === item.sourceGeneration && (disposition.state === "dismissed"
        || (disposition.state === "snoozed" && disposition.until! > now))) continue;
    items[visible++] = { ...item, dispositionRevision: disposition?.revision ?? 0 };
  }
  items.length = visible;
}

function dueSource(
  reader: DailyHomeProjectionReader,
  resolution: ReturnType<typeof resolveDailySourceProfiles>,
  context: DailyHomeProjectionContext,
  localDate: string,
  revisions: RecordRevisionIndex,
  samples: SampleProvenance,
  dispositions: readonly InboxDispositionV1[],
): SourceSnapshot {
  const items: DailyItem[] = [];
  let truncated = false;
  let invalidSource = revisions.truncated || !samples.valid;
  let watermark = `${revisions.watermark}:${samples.watermark}`;
  if (!samples.valid) return sourceSnapshot("due_record", [], {
    watermark,
    status: "partial",
    reason: "invalid_source",
    retryable: false,
  });
  for (const profile of resolution.ready) {
    const scanned = scanTable(reader, profile.tableName);
    truncated ||= scanned.truncated;
    for (const row of scanned.rows) {
      const rowId = String(row.id);
      if (isSample(samples, profile.tableName, rowId)) continue;
      if (complete(row, profile.completion)) continue;
      const rawDue = row[profile.dueColumnName];
      if (typeof rawDue !== "string") continue;
      const temporal = parseDailyTemporal(rawDue, context.timeZone);
      if (!temporal || temporal.localDate > localDate) continue;
      const dueAt = temporal.instant
        ?? resolveLocalDateTime(`${temporal.localDate}T00:00`, context.timeZone).instant;
      const rawTitle = row[profile.labelColumnName];
      const title = String(rawTitle ?? "").trim().slice(0, 240) || "Untitled record";
      const updatedAt = String(row.updated_at ?? "");
      const occurrence = recordOccurrenceGeneration(
        revisions, profile.tableName, rowId, updatedAt,
      );
      invalidSource ||= occurrence.nativeMissing;
      if (!revisions.native) {
        const candidate = `record-times:${updatedAt}:${rowId}:${samples.watermark}`;
        if (candidate > watermark) watermark = candidate.slice(0, 256);
      }
      items.push({
        sourceKey: opaqueSourceKey(`due\u0000${profile.profileId}\u0000${rowId}`),
        sourceGeneration: occurrence.generation,
        kind: "due_record",
        title,
        severity: temporal.localDate < localDate ? "high" : "normal",
        attentionAt: dueAt,
        dueAt,
        dispositionRevision: 0,
        route: { kind: "record", tableId: profile.tableId, rowId },
        actions: profile.completion.kind === "none" ? ["open", "snooze", "dismiss"] : ["open", "complete", "snooze", "dismiss"],
      });
    }
  }
  applyDispositions(items, dispositions, context.now);

  if (resolution.ready.length === 0) {
    return sourceSnapshot("due_record", [], {
      watermark: null,
      status: "unavailable",
      reason: "invalid_source",
      retryable: false,
    });
  }
  items.sort(compareCanonicalItems);
  const limited = items.length > PAGE_SIZE;
  const visible = items.slice(0, PAGE_SIZE);
  if (resolution.issues.length > 0 || invalidSource || truncated || limited) {
    return sourceSnapshot("due_record", visible, {
      watermark,
      status: "partial",
      reason: resolution.issues.length > 0 || invalidSource ? "invalid_source" : "limit",
      retryable: resolution.issues.length === 0 && !invalidSource,
      knownMinimum: items.length,
    });
  }
  return sourceSnapshot("due_record", visible, { watermark });
}

function currentRecord(reader: DailyHomeProjectionReader, table: RegTable, rowId: string): QueryRow | null {
  return reader.query({ from: table.name, where: [{ field: "id", op: "eq", value: rowId }], limit: 1 })[0] ?? null;
}

function recordTitle(table: RegTable, row: QueryRow): string {
  const column = table.columns.find(candidate => !candidate.hidden && !candidate.inactive
    && (candidate.type === "text" || candidate.type === "rich_text" || candidate.type === "enum"))
    ?? table.columns.find(candidate => !candidate.hidden && !candidate.inactive);
  const value = column ? row[column.name] : null;
  const title = (typeof value === "string" || typeof value === "number")
    ? String(value).trim() : "";
  return (title || "Untitled record").slice(0, 240);
}

function navigationState(reader: DailyHomeProjectionReader): DailyNavigationState | null {
  try { return loadDailyNavigationState(reader.getSetting<unknown>(DAILY_NAVIGATION_SETTING)); }
  catch { return null; }
}

function navigationRecordSource(
  sourceId: "favorite_record" | "recently_opened_record",
  references: readonly (DailyFavoriteReference | DailyRecentReference)[],
  revision: number,
  reader: DailyHomeProjectionReader,
  revisions: RecordRevisionIndex,
  samples: SampleProvenance,
): SourceSnapshot {
  const watermark = `navigation:${revision}:${revisions.watermark}:${samples.watermark}`;
  if (!samples.valid) return sourceSnapshot(sourceId, [], {
    watermark,
    status: "partial",
    reason: "invalid_source",
    retryable: false,
  });
  const registry = reader.registrySnapshot();
  const tablesById = new Map([...registry.values()]
    .filter(table => table.semantic?.tableId)
    .map(table => [String(table.semantic!.tableId), table] as const));
  let invalidSource = revisions.truncated || !samples.valid;
  const items: DailyItem[] = [];
  for (const [favoriteOrder, reference] of references.entries()) {
    const table = tablesById.get(reference.tableId);
    if (!table || table.inactive) { invalidSource = true; continue; }
    if (isSample(samples, table.name, reference.rowId)) continue;
    const row = currentRecord(reader, table, reference.rowId);
    if (!row || typeof row.updated_at !== "string") { invalidSource = true; continue; }
    let updatedAt: string;
    try { updatedAt = new Date(row.updated_at).toISOString(); }
    catch { invalidSource = true; continue; }
    if (updatedAt !== row.updated_at) { invalidSource = true; continue; }
    const occurrence = recordOccurrenceGeneration(
      revisions, table.name, reference.rowId, updatedAt,
    );
    invalidSource ||= occurrence.nativeMissing;
    items.push({
      sourceId,
      sourceKey: opaqueSourceKey(`${sourceId}\u0000${reference.tableId}\u0000${reference.rowId}`),
      sourceGeneration: occurrence.generation,
      kind: "record_projection",
      tableId: reference.tableId,
      rowId: reference.rowId,
      title: recordTitle(table, row),
      updatedAt,
      ...(sourceId === "favorite_record" ? { favoriteOrder }
        : { openedAt: (reference as DailyRecentReference).openedAt }),
      route: { kind: "record", tableId: reference.tableId, rowId: reference.rowId },
    });
  }
  items.sort(compareCanonicalItems);
  const limited = items.length > PAGE_SIZE;
  const visible = items.slice(0, PAGE_SIZE);
  if (invalidSource || limited) {
    return sourceSnapshot(sourceId, visible, {
      watermark,
      status: "partial",
      reason: invalidSource ? "invalid_source" : "limit",
      retryable: !invalidSource,
      knownMinimum: items.length,
    });
  }
  return sourceSnapshot(sourceId, visible, {
    watermark,
  });
}

function recentlyChangedSource(
  reader: DailyHomeProjectionReader,
  revisions: RecordRevisionIndex,
  samples: SampleProvenance,
): SourceSnapshot {
  const tables = [...reader.registrySnapshot().values()]
    .filter(table => !table.inactive)
    .sort((left, right) => compare(String(left.semantic?.tableId ?? left.name),
      String(right.semantic?.tableId ?? right.name)));
  const items: DailyItem[] = [];
  let invalidSource = revisions.truncated || !samples.valid;
  let truncated = false;
  let watermark = `${revisions.watermark}:${samples.watermark}`;
  if (!samples.valid) return sourceSnapshot("recently_changed_record", [], {
    watermark,
    status: "partial",
    reason: "invalid_source",
    retryable: false,
  });
  for (const table of tables) {
    const tableId = table.semantic?.tableId;
    if (!tableId) { invalidSource = true; continue; }
    const scanned = scanTable(reader, table.name);
    truncated ||= scanned.truncated;
    for (const row of scanned.rows) {
      if (typeof row.id !== "string" || typeof row.updated_at !== "string") {
        invalidSource = true;
        continue;
      }
      if (isSample(samples, table.name, row.id)) continue;
      let updatedAt: string;
      try { updatedAt = new Date(row.updated_at).toISOString(); }
      catch { invalidSource = true; continue; }
      if (updatedAt !== row.updated_at) { invalidSource = true; continue; }
      const occurrence = recordOccurrenceGeneration(
        revisions, table.name, row.id, updatedAt,
      );
      invalidSource ||= occurrence.nativeMissing;
      items.push({
        sourceId: "recently_changed_record",
        sourceKey: opaqueSourceKey(`recently_changed_record\u0000${tableId}\u0000${row.id}`),
        sourceGeneration: occurrence.generation,
        kind: "record_projection",
        tableId,
        rowId: row.id,
        title: recordTitle(table, row),
        updatedAt,
        route: { kind: "record", tableId, rowId: row.id },
      });
      if (!revisions.native) {
        const candidate = `record-times:${updatedAt}:${row.id}:${samples.watermark}`;
        if (candidate > watermark) watermark = candidate.slice(0, 256);
      }
    }
  }
  items.sort(compareCanonicalItems);
  const limited = items.length > PAGE_SIZE;
  const visible = items.slice(0, PAGE_SIZE);
  if (invalidSource || truncated || limited) {
    return sourceSnapshot("recently_changed_record", visible, {
      watermark,
      status: "partial",
      reason: invalidSource ? "invalid_source" : "limit",
      retryable: !invalidSource,
      knownMinimum: items.length,
    });
  }
  return sourceSnapshot("recently_changed_record", visible, { watermark });
}

function automationNotificationSource(
  reader: DailyHomeProjectionReader,
  dispositions: readonly InboxDispositionV1[], now: string,
): SourceSnapshot {
  const unreadPage = reader.dailyHomeUnreadNotifications(500);
  const notifications = unreadPage.notifications;
  const items: DailyItem[] = [];
  let invalidSource = false;
  const nativeWatermark = reader.dailyHomeNotificationWatermark?.();
  if (nativeWatermark !== undefined
      && (typeof nativeWatermark !== "string" || nativeWatermark.length < 1
        || nativeWatermark.length > 256))
    throw new TypeError("invalid Daily Home notification watermark");
  let watermark = nativeWatermark ?? "notifications:0";
  for (const notification of notifications) {
    let attentionAt: string;
    try { attentionAt = new Date(notification.at).toISOString(); }
    catch { invalidSource = true; continue; }
    if (attentionAt !== notification.at
        || !/^auto_[0-9a-f]{32}$/.test(notification.automationId)) {
      invalidSource = true;
      continue;
    }
    const title = notification.title.trim().slice(0, 240);
    if (!title) { invalidSource = true; continue; }
    const summary = notification.body.trim().slice(0, 500);
    const sourceKey = opaqueSourceKey(`automation\u0000${notification.id}`);
    items.push({
      sourceKey,
      sourceGeneration: opaqueSourceGeneration(
        `notification\u0000${notification.id}\u0000${attentionAt}`,
      ),
      kind: "automation_notification",
      title,
      ...(summary ? { summary } : {}),
      severity: "normal",
      attentionAt,
      dispositionRevision: 0,
      route: { kind: "automation", automationId: notification.automationId },
      actions: ["open", "snooze", "dismiss"],
    });
    if (nativeWatermark === undefined) {
      const candidateWatermark = `notifications:${attentionAt}:${notification.id}`;
      if (candidateWatermark > watermark) watermark = candidateWatermark.slice(0, 256);
    }
  }
  applyDispositions(items, dispositions, now);
  items.sort(compareCanonicalItems);
  const limited = items.length > PAGE_SIZE;
  const visible = items.slice(0, PAGE_SIZE);
  if (invalidSource || unreadPage.truncated || limited) {
    return sourceSnapshot("automation_notification", visible, {
      watermark,
      status: "partial",
      reason: invalidSource ? "invalid_source" : "limit",
      retryable: !invalidSource,
      knownMinimum: items.length,
    });
  }
  return sourceSnapshot("automation_notification", visible, { watermark });
}

type OperationalViewValue = z.infer<typeof OperationalView>;

function savedViewSemanticsAreCurrent(view: OperationalViewValue, registry: Registry): boolean {
  if (!view.identity) return false;
  if (view.filters.length > 1 || view.orderBy.length > 1) return false;
  const restorableOperators = new Set(["eq", "neq", "contains", "is_null", "not_null"]);
  if (view.filters.some(condition => !restorableOperators.has(condition.op))) return false;
  const table = [...registry.values()].find(candidate =>
    String(candidate.semantic?.tableId ?? "") === view.identity!.tableId);
  if (!table || table.inactive) return false;
  const fields = new Map(table.columns
    .filter(column => !column.hidden && !column.inactive && column.semantic?.fieldId)
    .map(column => [String(column.semantic!.fieldId), column] as const));
  const resolve = (ids: readonly string[]): boolean =>
    new Set(ids).size === ids.length && ids.every(id => fields.has(id));
  if (!resolve(view.identity.filterFieldIds)
      || !resolve(view.identity.orderFieldIds)
      || !resolve(view.identity.visibleFieldIds)) return false;
  for (const [index, condition] of view.filters.entries()) {
    const column = fields.get(view.identity.filterFieldIds[index]!);
    if (!column) return false;
    if ((condition.op === "within_days" || condition.op === "older_than_days")
        && column.type !== "date") return false;
    if (condition.op === "contains"
        && column.type !== "text" && column.type !== "rich_text" && column.type !== "enum")
      return false;
  }
  return true;
}

function savedViewSource(
  reader: DailyHomeProjectionReader,
): SourceSnapshot {
  const raw = reader.getSetting<unknown>(OPERATIONAL_VIEWS_SETTING);
  if (raw === undefined || raw === null)
    return sourceSnapshot("saved_view", [], { watermark: "views:0" });
  const parsed = OperationalViewLibrary.safeParse(raw);
  if (!parsed.success) {
    return sourceSnapshot("saved_view", [], {
      watermark: null, status: "partial", reason: "invalid_source", retryable: false,
    });
  }
  const registry = reader.registrySnapshot();
  const validViews = parsed.data.views.filter(view => savedViewSemanticsAreCurrent(view, registry));
  const invalidViews = parsed.data.views.length - validViews.length;
  const watermark = `views:${parsed.data.revision}:schema:${reader.headVersion()}`;
  const items: DailyItem[] = [...validViews]
    .sort((left, right) => compare(left.id, right.id))
    .map(view => ({
      kind: "saved_view_projection",
      sourceId: "saved_view",
      sourceKey: opaqueSourceKey(`saved_view\u0000${view.id}`),
      sourceGeneration: opaqueSourceGeneration(
        `saved_view\u0000${view.id}\u0000${parsed.data.revision}\u0000${view.updatedAt}`,
      ),
      savedViewId: view.id,
      title: view.name,
      route: { kind: "saved_view", savedViewId: view.id },
    }));
  items.sort(compareCanonicalItems);
  const limited = items.length > PAGE_SIZE;
  const visible = items.slice(0, PAGE_SIZE);
  if (invalidViews > 0 || limited) {
    return sourceSnapshot("saved_view", visible, {
      watermark,
      status: "partial",
      reason: invalidViews > 0 ? "invalid_source" : "limit",
      retryable: invalidViews === 0,
      knownMinimum: items.length,
    });
  }
  return sourceSnapshot("saved_view", visible, { watermark });
}

function emptyReadySource(sourceId: DailyHomeSourceIdV1, version: number): SourceSnapshot {
  return sourceSnapshot(sourceId, [], { watermark: `version:${version}` });
}

export function projectDailyHome(
  reader: DailyHomeProjectionReader,
  context: DailyHomeProjectionContext,
): DailyHomeSnapshotV1 {
  const calendar = localCalendarContext(context.now, context.timeZone);
  const registry = reader.registrySnapshot();
  const sourceLibrary = readSourceLibrary(reader);
  const resolution = resolveDailySourceProfiles(registry, sourceLibrary);
  const revisions = recordRevisionIndex(reader);
  const samples = sampleProvenance(reader, registry);
  const dispositions = reader.inboxDispositions?.() ?? [];
  const due = dueSource(reader, resolution, context, calendar.localDate, revisions, samples, dispositions);
  const notifications = automationNotificationSource(reader, dispositions, context.now);
  const changed = recentlyChangedSource(reader, revisions, samples);
  const savedViews = savedViewSource(reader);
  const navigation = navigationState(reader);
  const favorites = navigation
    ? navigationRecordSource(
        "favorite_record", navigation.favorites, navigation.revision, reader, revisions, samples,
      )
    : sourceSnapshot("favorite_record", [], {
        watermark: null, status: "partial", reason: "invalid_source", retryable: false,
      });
  const recents = navigation
    ? navigationRecordSource(
        "recently_opened_record", navigation.recents, navigation.revision, reader, revisions, samples,
      )
    : sourceSnapshot("recently_opened_record", [], {
        watermark: null, status: "partial", reason: "invalid_source", retryable: false,
      });
  const version = reader.headVersion();
  const recovery = sourceSnapshot("recovery_notice", [], {
    watermark: null,
    status: "unavailable",
    reason: "unavailable",
    retryable: true,
  });
  const sources: SourceSnapshot[] = DAILY_HOME_SOURCE_IDS_V1.map(sourceId => {
    if (sourceId === "automation_notification") return notifications;
    if (sourceId === "due_record") return due;
    if (sourceId === "favorite_record") return favorites;
    if (sourceId === "recently_changed_record") return changed;
    if (sourceId === "recently_opened_record") return recents;
    if (sourceId === "recovery_notice") return recovery;
    if (sourceId === "saved_view") return savedViews;
    return emptyReadySource(sourceId, version);
  });
  const authority: DailyHomeProjectionAuthorityV1 = {
    schema: 1,
    appInstanceId: context.appInstanceId,
    activeGenerationId: context.activeGenerationId,
    schemaHead: `version:${version}`,
    sourceLibrary,
    profileResolution: {
      readyProfileIds: resolution.ready.map(profile => profile.profileId).sort(compare),
      issueProfileIds: resolution.issues.map(issue => issue.profileId).sort(compare),
    },
    dispositionWatermark: String(Math.max(0, ...dispositions.map(row => row.revision))),
    sourceWatermarks: sources.map(source => ({
      sourceId: source.sourceId,
      watermark: source.watermark,
      status: source.status,
      statusEpoch: source.statusEpoch,
    })),
    localDate: calendar.localDate,
    timeZone: context.timeZone,
    projectionValidUntil: dispositions.reduce((next, row) => row.state === "snoozed" && row.until! > context.now && row.until! < next
      ? row.until! : next, calendar.nextLocalMidnight),
  };
  const draft = {
    generatedAt: context.now,
    sources,
    sections: deriveDailyHomeSections(sources),
  };
  return buildDailyHomeSnapshot(JSON.stringify(draft), JSON.stringify(authority));
}
