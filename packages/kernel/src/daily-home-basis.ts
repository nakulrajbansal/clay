import {
  CanonicalUtcInstantV1,
  DAILY_HOME_SECTION_IDS_V1,
  DAILY_HOME_SOURCE_IDS_V1,
  DailyHomeCursorPayloadV1,
  DailyHomeCursorStateV1,
  DailyHomeCursorStringV1,
  DailyHomePageScopeV1,
  DailyHomeProjectionAuthorityV1,
  DailyHomeSnapshotV1,
  SnapshotBasisV1,
  type DailyHomeCursorPayloadV1 as DailyHomeCursorPayload,
  type DailyHomeCursorStateV1 as DailyHomeCursorState,
  type DailyHomePageScopeV1 as DailyHomePageScope,
  type DailyHomeProjectionAuthorityV1 as DailyHomeProjectionAuthority,
  type DailyHomeSnapshotV1 as DailyHomeSnapshot,
  type SnapshotBasisV1 as SnapshotBasis,
} from "@clay/schema/daily-home";
import { sha256HexSync } from "./state-digest";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CURSOR_DOMAIN = "clay.daily-home.cursor.v1\u0000";
const MAX_CAPTURE_DEPTH = 64;
const MAX_CAPTURE_NODES = 100_000;
const MAX_CAPTURE_PROPERTIES = 1_024;
const MAX_CAPTURE_BYTES = 2_000_000;

type CaptureBudget = { nodes: number; bytes: number };
type PartialCompleteness = Extract<
  DailyHomeSnapshot["aggregateCounts"]["sourceOccurrences"],
  { kind: "partial" }
>;
type Gap = PartialCompleteness["gaps"][number];

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new TypeError(`invalid Daily Home ${message}`);
}

function consumeBytes(budget: CaptureBudget, text: string): void {
  budget.bytes += ENCODER.encode(text).byteLength;
  if (budget.bytes > MAX_CAPTURE_BYTES) invalid("snapshot payload");
}

function capturePlain(
  input: unknown,
  depth = 0,
  budget: CaptureBudget = { nodes: 0, bytes: 0 },
  ancestors: WeakSet<object> = new WeakSet<object>(),
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_CAPTURE_NODES || depth > MAX_CAPTURE_DEPTH) invalid("snapshot payload");
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    consumeBytes(budget, input);
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) invalid("snapshot payload");
    return input;
  }
  if (typeof input !== "object") invalid("snapshot payload");
  if (ancestors.has(input)) invalid("snapshot payload");
  ancestors.add(input);
  try {
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length > MAX_CAPTURE_PROPERTIES) invalid("snapshot payload");
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) invalid("snapshot payload");
      const length = Reflect.getOwnPropertyDescriptor(input, "length");
      if (!length || "get" in length || "set" in length || typeof length.value !== "number")
        invalid("snapshot payload");
      if (ownKeys.length !== length.value + 1) invalid("snapshot payload");
      const output: unknown[] = new Array(length.value);
      for (let index = 0; index < length.value; index++) {
        const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || "get" in descriptor || "set" in descriptor || !descriptor.enumerable)
          invalid("snapshot payload");
        output[index] = capturePlain(descriptor.value, depth + 1, budget, ancestors);
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) invalid("snapshot payload");
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      if (typeof key !== "string") invalid("snapshot payload");
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      if (!descriptor || "get" in descriptor || "set" in descriptor || !descriptor.enumerable)
        invalid("snapshot payload");
      consumeBytes(budget, key);
      output[key] = capturePlain(descriptor.value, depth + 1, budget, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

function parseBasis(input: unknown): SnapshotBasis {
  const parsed = SnapshotBasisV1.safeParse(input);
  if (!parsed.success) invalid("snapshot basis");
  return parsed.data;
}

function parseTransport(input: unknown): unknown {
  if (typeof input !== "string" || input.length > MAX_CAPTURE_BYTES)
    invalid("snapshot transport");
  const bytes = ENCODER.encode(input);
  if (bytes.byteLength > MAX_CAPTURE_BYTES) invalid("snapshot transport");
  let parsed: unknown;
  try { parsed = JSON.parse(input) as unknown; }
  catch { invalid("snapshot transport"); }
  return capturePlain(parsed);
}

function canonicalBasis(basis: SnapshotBasis): string {
  return JSON.stringify({
    appInstanceId: basis.appInstanceId,
    activeGenerationId: basis.activeGenerationId,
    schemaHead: basis.schemaHead,
    profileRevision: basis.profileRevision,
    profileDigest: basis.profileDigest,
    profileResolution: {
      readyProfileIds: basis.profileResolution.readyProfileIds,
      issueProfileIds: basis.profileResolution.issueProfileIds,
    },
    libraryRevision: basis.libraryRevision,
    dispositionWatermark: basis.dispositionWatermark,
    sourceWatermarks: basis.sourceWatermarks.map(source => ({
      sourceId: source.sourceId,
      watermark: source.watermark,
      status: source.status,
      statusEpoch: source.statusEpoch,
    })),
    localDate: basis.localDate,
    timeZone: basis.timeZone,
    rankingVersion: basis.rankingVersion,
    projectionValidUntil: basis.projectionValidUntil,
  });
}

function digestBasis(basis: SnapshotBasis): `sha256:${string}` {
  return `sha256:${sha256HexSync(ENCODER.encode(canonicalBasis(basis)))}`;
}

function canonicalPageScope(scope: DailyHomePageScope): Record<string, unknown> {
  return scope.kind === "source"
    ? { kind: scope.kind, sourceId: scope.sourceId, pageSize: scope.pageSize }
    : { kind: scope.kind, sectionId: scope.sectionId, pageSize: scope.pageSize };
}

function canonicalCursorPayload(payload: DailyHomeCursorPayload): string {
  return JSON.stringify({
    schema: payload.schema,
    appInstanceId: payload.appInstanceId,
    activeGenerationId: payload.activeGenerationId,
    basisDigest: payload.basisDigest,
    adapterContinuations: payload.adapterContinuations.map(entry => ({
      sourceId: entry.sourceId,
      continuation: entry.continuation,
    })),
    pageScope: canonicalPageScope(payload.pageScope),
    rankingVersion: payload.rankingVersion,
    localDate: payload.localDate,
    timeZone: payload.timeZone,
    projectionValidUntil: payload.projectionValidUntil,
  });
}

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    output += BASE64URL[first >>> 2]!;
    output += BASE64URL[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]!;
    if (second !== undefined) {
      output += BASE64URL[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]!;
    }
    if (third !== undefined) output += BASE64URL[third & 0x3f]!;
  }
  return output;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) invalid("cursor encoding");
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const character of value) {
    const index = BASE64URL.indexOf(character);
    if (index < 0) invalid("cursor encoding");
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bits !== 0) invalid("cursor encoding");
  const decoded = Uint8Array.from(bytes);
  if (encodeBase64Url(decoded) !== value) invalid("cursor encoding");
  return decoded;
}

function cursorChecksum(canonical: string): string {
  return sha256HexSync(ENCODER.encode(`${CURSOR_DOMAIN}${canonical}`));
}

function sameAscii(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function parseAuthority(input: unknown): DailyHomeProjectionAuthority {
  const parsed = DailyHomeProjectionAuthorityV1.safeParse(parseTransport(input));
  if (!parsed.success) invalid("projection authority");
  return parsed.data;
}

function profileDigest(authority: DailyHomeProjectionAuthority): `sha256:${string}` {
  const profiles = [...authority.sourceLibrary.profiles]
    .sort((left, right) => compareCanonicalStrings(left.profileId, right.profileId));
  const canonical = JSON.stringify({
    schema: authority.sourceLibrary.schema,
    revision: authority.sourceLibrary.revision,
    profiles,
  });
  return `sha256:${sha256HexSync(ENCODER.encode(canonical))}`;
}

function basisFromAuthority(authority: DailyHomeProjectionAuthority): SnapshotBasis {
  return SnapshotBasisV1.parse({
    appInstanceId: authority.appInstanceId,
    activeGenerationId: authority.activeGenerationId,
    schemaHead: authority.schemaHead,
    profileRevision: authority.sourceLibrary.revision,
    profileDigest: profileDigest(authority),
    profileResolution: authority.profileResolution,
    libraryRevision: authority.sourceLibrary.revision,
    dispositionWatermark: authority.dispositionWatermark,
    sourceWatermarks: authority.sourceWatermarks,
    localDate: authority.localDate,
    timeZone: authority.timeZone,
    rankingVersion: "daily-rank-v1",
    projectionValidUntil: authority.projectionValidUntil,
  });
}

function parseCursorState(input: unknown): DailyHomeCursorState {
  const parsed = DailyHomeCursorStateV1.safeParse(parseTransport(input));
  if (!parsed.success) invalid("cursor state");
  return parsed.data;
}

function parsePageScope(input: unknown): DailyHomePageScope {
  const parsed = DailyHomePageScopeV1.safeParse(parseTransport(input));
  if (!parsed.success) invalid("cursor scope");
  return parsed.data;
}

export function encodeDailyHomeCursor(input: unknown, authorityInput: unknown): string {
  const state = parseCursorState(input);
  const authority = parseAuthority(authorityInput);
  const basis = basisFromAuthority(authority);
  const payload = DailyHomeCursorPayloadV1.parse({
    schema: 1,
    appInstanceId: basis.appInstanceId,
    activeGenerationId: basis.activeGenerationId,
    basisDigest: digestBasis(basis),
    adapterContinuations: state.adapterContinuations,
    pageScope: state.pageScope,
    rankingVersion: basis.rankingVersion,
    localDate: basis.localDate,
    timeZone: basis.timeZone,
    projectionValidUntil: basis.projectionValidUntil,
  });
  const canonical = canonicalCursorPayload(payload);
  const cursor = `dcur_${encodeBase64Url(ENCODER.encode(canonical))}.${cursorChecksum(canonical)}`;
  if (!DailyHomeCursorStringV1.safeParse(cursor).success) invalid("cursor size");
  return cursor;
}

export function decodeDailyHomeCursor(input: unknown): DailyHomeCursorPayload {
  const parsedCursor = DailyHomeCursorStringV1.safeParse(input);
  if (!parsedCursor.success) invalid("cursor encoding");
  const separator = parsedCursor.data.lastIndexOf(".");
  const encoded = parsedCursor.data.slice("dcur_".length, separator);
  const checksum = parsedCursor.data.slice(separator + 1);
  let canonical: string;
  try {
    canonical = DECODER.decode(decodeBase64Url(encoded));
  } catch {
    invalid("cursor encoding");
  }
  if (!sameAscii(checksum, cursorChecksum(canonical))) invalid("cursor checksum");
  const payload = DailyHomeCursorPayloadV1.safeParse(parseTransport(canonical));
  if (!payload.success || canonicalCursorPayload(payload.data) !== canonical)
    invalid("cursor payload");
  return deepFreeze(payload.data);
}

function verifyCursorPayload(
  payload: DailyHomeCursorPayload,
  authority: DailyHomeProjectionAuthority,
  expectedScope: DailyHomePageScope,
  nowInput: unknown,
): DailyHomeCursorPayload {
  const basis = basisFromAuthority(authority);
  if (payload.appInstanceId !== basis.appInstanceId
      || payload.activeGenerationId !== basis.activeGenerationId
      || payload.basisDigest !== digestBasis(basis)
      || payload.rankingVersion !== basis.rankingVersion
      || payload.localDate !== basis.localDate
      || payload.timeZone !== basis.timeZone
      || payload.projectionValidUntil !== basis.projectionValidUntil)
    invalid("cursor basis");
  if (JSON.stringify(canonicalPageScope(payload.pageScope))
      !== JSON.stringify(canonicalPageScope(expectedScope))) invalid("cursor scope");
  const now = CanonicalUtcInstantV1.safeParse(nowInput);
  if (!now.success) invalid("cursor current instant");
  if (new Date(now.data).getTime() >= new Date(payload.projectionValidUntil).getTime())
    invalid("stale cursor");
  return payload;
}

export function verifyDailyHomeCursor(
  input: unknown,
  authorityInput: unknown,
  expectedScopeInput: unknown,
  nowInput: unknown,
): DailyHomeCursorPayload {
  return verifyCursorPayload(
    decodeDailyHomeCursor(input),
    parseAuthority(authorityInput),
    parsePageScope(expectedScopeInput),
    nowInput,
  );
}

function configurationFromAuthority(
  authority: DailyHomeProjectionAuthority,
): DailyHomeSnapshot["configurationStatus"] {
  if (authority.profileResolution.readyProfileIds.length === 0) return "needs_setup";
  return "partial";
}

export function canonicalDailyHomeBasis(input: unknown): string {
  return canonicalBasis(parseBasis(parseTransport(input)));
}

export function dailyHomeSnapshotDigest(input: unknown): `sha256:${string}` {
  return digestBasis(parseBasis(parseTransport(input)));
}

function occurrenceKey(item: DailyHomeSnapshot["sources"][number]["page"]["items"][number]): string {
  return `${item.sourceKey}\u0000${item.sourceGeneration}`;
}

function renderedKey(item: DailyHomeSnapshot["sources"][number]["page"]["items"][number]): string {
  if (item.kind === "record_projection") return `record:${item.tableId}:${item.rowId}`;
  if (item.kind === "saved_view_projection") return `view:${item.savedViewId}`;
  if (item.route.kind === "record") return `record:${item.route.tableId}:${item.route.rowId}`;
  if (item.route.kind === "automation") return `automation:${item.route.automationId}`;
  return `occurrence:${occurrenceKey(item)}`;
}

const SECTION_SOURCES: Readonly<Record<DailyHomeSnapshot["sections"][number]["sectionId"], readonly Gap["sourceId"][]>> = {
  needs_attention: ["automation_notification", "recovery_notice"],
  due_today: ["due_record"],
  continue: ["recently_changed_record"],
  pinned: ["favorite_record", "saved_view"],
  recently_opened: ["recently_opened_record"],
};

type DailyItem = DailyHomeSnapshot["sources"][number]["page"]["items"][number];
type Completeness = DailyHomeSnapshot["aggregateCounts"]["sourceOccurrences"];
type CountSet = DailyHomeSnapshot["aggregateCounts"];
type SectionId = DailyHomeSnapshot["sections"][number]["sectionId"];

function itemSourceId(item: DailyItem): Gap["sourceId"] {
  return item.kind === "record_projection" || item.kind === "saved_view_projection"
    ? item.sourceId : item.kind;
}

function sectionForSource(sourceId: Gap["sourceId"]): SectionId {
  for (const sectionId of DAILY_HOME_SECTION_IDS_V1) {
    if (SECTION_SOURCES[sectionId].includes(sourceId)) return sectionId;
  }
  invalid("snapshot section source registry");
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) invalid("snapshot count overflow");
  return result;
}

function countMinimum(count: Completeness): number {
  return count.kind === "exact" ? count.total : count.knownMinimum;
}

function addGap(gaps: Map<Gap["sourceId"], Gap>, gap: Gap, context: string): void {
  const existing = gaps.get(gap.sourceId);
  if (existing && (existing.reason !== gap.reason || existing.retryable !== gap.retryable))
    invalid(`${context} completeness contradiction`);
  if (!existing) gaps.set(gap.sourceId, { ...gap });
}

function orderedGaps(gaps: Map<Gap["sourceId"], Gap>): Gap[] {
  return [...gaps.values()]
    .sort((left, right) => compareCanonicalStrings(left.sourceId, right.sourceId));
}

function completeness(minimum: number, gaps: Map<Gap["sourceId"], Gap>): Completeness {
  const ordered = orderedGaps(gaps);
  return ordered.length === 0
    ? { kind: "exact", total: minimum }
    : { kind: "partial", knownMinimum: minimum, gaps: ordered };
}

function aggregateCounts(sources: DailyHomeSnapshot["sources"]): CountSet {
  let occurrenceMinimum = 0;
  const occurrenceGaps = new Map<Gap["sourceId"], Gap>();
  const renderedGaps = new Map<Gap["sourceId"], Gap>();
  for (const source of sources) {
    const occurrence = source.page.counts.sourceOccurrences;
    occurrenceMinimum = safeAdd(occurrenceMinimum, countMinimum(occurrence));
    if (occurrence.kind === "partial") {
      for (const gap of occurrence.gaps) addGap(occurrenceGaps, gap, "snapshot");
    }
    const rendered = source.page.counts.renderedUnique;
    if (rendered.kind === "partial") {
      for (const gap of rendered.gaps) addGap(renderedGaps, gap, "snapshot");
    }
    if (source.page.continuation.kind === "cursor" && !renderedGaps.has(source.sourceId)) {
      addGap(renderedGaps, {
        sourceId: source.sourceId, reason: "limit", retryable: true,
      }, "snapshot");
    }
  }
  const renderedMinimum = new Set(sources.flatMap(source => source.page.items.map(renderedKey))).size;
  return {
    sourceOccurrences: completeness(occurrenceMinimum, occurrenceGaps),
    renderedUnique: completeness(renderedMinimum, renderedGaps),
  };
}

const SEVERITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 } as const;

function compareDescending(left: string, right: string): number {
  return compareCanonicalStrings(right, left);
}

export function compareCanonicalItems(left: DailyItem, right: DailyItem): number {
  const leftSection = sectionForSource(itemSourceId(left));
  const rightSection = sectionForSource(itemSourceId(right));
  const sectionOrder = DAILY_HOME_SECTION_IDS_V1.indexOf(leftSection)
    - DAILY_HOME_SECTION_IDS_V1.indexOf(rightSection);
  if (sectionOrder !== 0) return sectionOrder;

  let rank = 0;
  if (leftSection === "needs_attention" && rightSection === "needs_attention") {
    if ((left.kind === "automation_notification" || left.kind === "due_record")
        && (right.kind === "automation_notification" || right.kind === "due_record")) {
      rank = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
      if (rank === 0) rank = compareCanonicalStrings(left.attentionAt, right.attentionAt);
    }
  } else if (leftSection === "due_today" && rightSection === "due_today") {
    if (left.kind === "due_record" && right.kind === "due_record") {
      rank = compareCanonicalStrings(left.dueAt ?? left.attentionAt, right.dueAt ?? right.attentionAt);
      if (rank === 0) rank = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    }
  } else if (leftSection === "continue" && rightSection === "continue") {
    if (left.kind === "record_projection" && right.kind === "record_projection")
      rank = compareDescending(left.updatedAt, right.updatedAt);
  } else if (leftSection === "pinned" && rightSection === "pinned") {
    const sourceOrder = DAILY_HOME_SOURCE_IDS_V1.indexOf(itemSourceId(left))
      - DAILY_HOME_SOURCE_IDS_V1.indexOf(itemSourceId(right));
    if (sourceOrder !== 0) return sourceOrder;
    if (left.kind === "record_projection" && right.kind === "record_projection")
      rank = (left.favoriteOrder ?? 0) - (right.favoriteOrder ?? 0);
  } else if (leftSection === "recently_opened" && rightSection === "recently_opened") {
    if (left.kind === "record_projection" && right.kind === "record_projection")
      rank = compareDescending(left.openedAt ?? left.updatedAt, right.openedAt ?? right.updatedAt);
  }
  if (rank !== 0) return rank;
  const sourceOrder = DAILY_HOME_SOURCE_IDS_V1.indexOf(itemSourceId(left))
    - DAILY_HOME_SOURCE_IDS_V1.indexOf(itemSourceId(right));
  if (sourceOrder !== 0) return sourceOrder;
  const renderedOrder = compareCanonicalStrings(renderedKey(left), renderedKey(right));
  return renderedOrder !== 0
    ? renderedOrder : compareCanonicalStrings(occurrenceKey(left), occurrenceKey(right));
}

function sameItem(left: DailyItem, right: DailyItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalidRepresentative(item: DailyItem): never {
  invalid(renderedKey(item).startsWith("record:")
    ? "snapshot duplicate rendered record representative"
    : "snapshot section representative");
}

function sameCompleteness(left: Completeness, right: Completeness): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedSectionCounts(
  sources: DailyHomeSnapshot["sources"],
  sectionId: SectionId,
  renderedMinimum: number,
): CountSet {
  let occurrenceMinimum = 0;
  const occurrenceGaps = new Map<Gap["sourceId"], Gap>();
  const renderedGaps = new Map<Gap["sourceId"], Gap>();
  for (const sourceId of SECTION_SOURCES[sectionId]) {
    const source = sources.find(candidate => candidate.sourceId === sourceId);
    if (!source) invalid("snapshot section source");
    const occurrence = source.page.counts.sourceOccurrences;
    occurrenceMinimum = safeAdd(occurrenceMinimum, countMinimum(occurrence));
    if (occurrence.kind === "partial") {
      for (const gap of occurrence.gaps) addGap(occurrenceGaps, gap, "snapshot section");
    }
    const rendered = source.page.counts.renderedUnique;
    if (rendered.kind === "partial") {
      for (const gap of rendered.gaps) addGap(renderedGaps, gap, "snapshot section");
    }
    if (source.page.continuation.kind === "cursor" && !renderedGaps.has(sourceId)) {
      addGap(renderedGaps, { sourceId, reason: "limit", retryable: true }, "snapshot section");
    }
  }
  return {
    sourceOccurrences: completeness(occurrenceMinimum, occurrenceGaps),
    renderedUnique: completeness(renderedMinimum, renderedGaps),
  };
}

/**
 * Derive the five rendered section pages from canonical source occurrences.
 * The helper intentionally has no continuation policy: callers with a source
 * cursor must create a matching, basis-bound section cursor themselves.
 */
export function deriveDailyHomeSections(
  sources: DailyHomeSnapshot["sources"],
): DailyHomeSnapshot["sections"] {
  if (sources.some(source => source.page.continuation.kind === "cursor"))
    invalid("snapshot projection section cursor required");
  const occurrenceSeen = new Set<string>();
  const candidates: DailyItem[] = [];
  for (const source of sources) {
    for (const item of source.page.items) {
      const key = occurrenceKey(item);
      if (occurrenceSeen.has(key)) continue;
      occurrenceSeen.add(key);
      candidates.push(item);
    }
  }
  const renderedSeen = new Set<string>();
  const bySection = new Map<SectionId, DailyItem[]>(
    DAILY_HOME_SECTION_IDS_V1.map(sectionId => [sectionId, []]),
  );
  for (const item of candidates.sort(compareCanonicalItems)) {
    const key = renderedKey(item);
    if (renderedSeen.has(key)) continue;
    renderedSeen.add(key);
    bySection.get(sectionForSource(itemSourceId(item)))!.push(item);
  }
  return DAILY_HOME_SECTION_IDS_V1.map(sectionId => {
    const items = bySection.get(sectionId)!;
    return {
      sectionId,
      page: {
        items,
        returned: items.length,
        counts: expectedSectionCounts(sources, sectionId, items.length),
        continuation: { kind: "end" as const },
      },
    };
  });
}

function verifiedPageSize(
  cursor: string,
  authority: DailyHomeProjectionAuthority,
  now: string,
  expected: Readonly<{ kind: "source"; sourceId: Gap["sourceId"] }>
    | Readonly<{ kind: "section"; sectionId: SectionId }>,
): number {
  const payload = decodeDailyHomeCursor(cursor);
  const scope = payload.pageScope;
  if (scope.kind !== expected.kind
      || (scope.kind === "source" && expected.kind === "source" && scope.sourceId !== expected.sourceId)
      || (scope.kind === "section" && expected.kind === "section" && scope.sectionId !== expected.sectionId))
    invalid("cursor scope");
  verifyCursorPayload(payload, authority, scope, now);
  return scope.pageSize;
}

function verifySections(
  snapshot: DailyHomeSnapshot,
  authority: DailyHomeProjectionAuthority,
): void {
  const sourceItems = new Map<string, DailyItem>();
  const candidates: DailyItem[] = [];
  for (const source of snapshot.sources) {
    if (source.page.continuation.kind === "cursor") {
      const pageSize = verifiedPageSize(source.page.continuation.cursor, authority, snapshot.generatedAt, {
        kind: "source", sourceId: source.sourceId,
      });
      if (source.page.returned > pageSize) invalid("snapshot source cursor page size");
    }
    for (let index = 0; index < source.page.items.length; index++) {
      const item = source.page.items[index]!;
      if (itemSourceId(item) !== source.sourceId) invalid("snapshot source identity");
      if (index > 0 && compareCanonicalItems(source.page.items[index - 1]!, item) > 0)
        invalid("snapshot source item order");
      const key = occurrenceKey(item);
      const prior = sourceItems.get(key);
      if (prior !== undefined && !sameItem(prior, item)) invalid("snapshot duplicate source occurrence");
      if (prior === undefined) {
        sourceItems.set(key, item);
        candidates.push(item);
      }
    }
  }

  const representativeByRendered = new Map<string, DailyItem>();
  const expectedBySection = new Map<SectionId, DailyItem[]>(
    DAILY_HOME_SECTION_IDS_V1.map(sectionId => [sectionId, []]),
  );
  for (const item of [...candidates].sort(compareCanonicalItems)) {
    const rendered = renderedKey(item);
    if (representativeByRendered.has(rendered)) continue;
    representativeByRendered.set(rendered, item);
    expectedBySection.get(sectionForSource(itemSourceId(item)))!.push(item);
  }

  for (const section of snapshot.sections) {
    const allowedSources = SECTION_SOURCES[section.sectionId];
    for (const item of section.page.items) {
      if (!allowedSources.includes(itemSourceId(item))) invalid("snapshot section source");
    }
  }

  for (const section of snapshot.sections) {
    const allowedSources = SECTION_SOURCES[section.sectionId];
    for (const item of section.page.items) {
      if (!allowedSources.includes(itemSourceId(item))) invalid("snapshot section source");
      const sourceItem = sourceItems.get(occurrenceKey(item));
      if (!sourceItem || !sameItem(sourceItem, item)) invalid("snapshot section source identity");
      const representative = representativeByRendered.get(renderedKey(item));
      if (!representative || !sameItem(representative, item)) invalidRepresentative(item);
    }

    const allExpected = expectedBySection.get(section.sectionId)!;
    const contributingSources = snapshot.sources.filter(source =>
      allowedSources.includes(source.sourceId));
    const contributorHasCursor = contributingSources.some(source =>
      source.page.continuation.kind === "cursor");
    let expectedItems = allExpected;
    if (section.page.continuation.kind === "cursor") {
      const pageSize = verifiedPageSize(section.page.continuation.cursor, authority, snapshot.generatedAt, {
        kind: "section", sectionId: section.sectionId,
      });
      if (!contributorHasCursor && allExpected.length <= pageSize)
        invalid("snapshot section cursor coverage");
      expectedItems = allExpected.slice(0, pageSize);
    } else if (contributorHasCursor) {
      invalid("snapshot section coverage");
    }

    if (section.page.items.length !== expectedItems.length)
      invalid("snapshot section coverage");
    const sameSet = section.page.items.length === expectedItems.length
      && section.page.items.every(item => expectedItems.some(expected => sameItem(item, expected)));
    for (let index = 0; index < expectedItems.length; index++) {
      if (sameItem(section.page.items[index]!, expectedItems[index]!)) continue;
      if (sameSet) invalid("snapshot section item order");
      if (renderedKey(section.page.items[index]!) === renderedKey(expectedItems[index]!))
        invalidRepresentative(section.page.items[index]!);
      invalid("snapshot section coverage");
    }

    const expectedCounts = expectedSectionCounts(snapshot.sources, section.sectionId, allExpected.length);
    if (!sameCompleteness(section.page.counts.sourceOccurrences, expectedCounts.sourceOccurrences)
        || !sameCompleteness(section.page.counts.renderedUnique, expectedCounts.renderedUnique)) {
      const partial = section.page.counts.sourceOccurrences.kind === "partial"
        || section.page.counts.renderedUnique.kind === "partial"
        || expectedCounts.sourceOccurrences.kind === "partial"
        || expectedCounts.renderedUnique.kind === "partial";
      invalid(partial ? "snapshot section completeness" : "snapshot section counts");
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function verifyDailyHomeSnapshot(input: unknown, authorityInput: unknown): DailyHomeSnapshot {
  const authority = parseAuthority(authorityInput);
  const captured = parseTransport(input);
  const parsed = DailyHomeSnapshotV1.safeParse(captured);
  if (!parsed.success) invalid("snapshot shape");
  const expectedBasis = basisFromAuthority(authority);
  if (canonicalBasis(parsed.data.basis) !== canonicalBasis(expectedBasis))
    invalid("snapshot authority basis");
  if (parsed.data.configurationStatus !== configurationFromAuthority(authority))
    invalid("snapshot authority configuration");
  const expectedDigest = digestBasis(parsed.data.basis);
  if (parsed.data.snapshotDigest !== expectedDigest) invalid("snapshot digest");
  const expectedCounts = aggregateCounts(parsed.data.sources);
  if (JSON.stringify(parsed.data.aggregateCounts) !== JSON.stringify(expectedCounts))
    invalid("snapshot aggregate counts");
  verifySections(parsed.data, authority);
  return deepFreeze(parsed.data);
}

export function buildDailyHomeSnapshot(input: unknown, authorityInput: unknown): DailyHomeSnapshot {
  const authority = parseAuthority(authorityInput);
  const captured = parseTransport(input);
  if (!captured || typeof captured !== "object" || Array.isArray(captured))
    invalid("snapshot draft");
  const draft = captured as Record<string, unknown>;
  if (Object.hasOwn(draft, "basis") || Object.hasOwn(draft, "configurationStatus")
      || Object.hasOwn(draft, "snapshotDigest") || Object.hasOwn(draft, "aggregateCounts"))
    invalid("snapshot draft");
  const basis = basisFromAuthority(authority);
  const placeholder = {
    sourceOccurrences: { kind: "exact" as const, total: 0 },
    renderedUnique: { kind: "exact" as const, total: 0 },
  };
  const shape = DailyHomeSnapshotV1.safeParse({
    ...draft,
    basis,
    configurationStatus: configurationFromAuthority(authority),
    snapshotDigest: digestBasis(basis),
    aggregateCounts: placeholder,
  });
  if (!shape.success) invalid("snapshot draft");
  return verifyDailyHomeSnapshot(JSON.stringify({
    ...shape.data,
    aggregateCounts: aggregateCounts(shape.data.sources),
  }), authorityInput);
}
