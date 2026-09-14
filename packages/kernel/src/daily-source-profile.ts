import {
  DailySourceLibraryV1,
  type CompletionRuleV1,
  DailySourceProfileV1,
} from "@clay/schema/standalone/daily-home";
import type { RegColumn, RegTable, Registry } from "./registry";
import { sha256HexSync } from "./state-digest";

export const DAILY_SOURCE_LIBRARY_SETTING = "daily_source_library_v1";

export type DailySourceIssueReason =
  | "table_missing"
  | "table_ambiguous"
  | "table_inactive"
  | "label_field_unavailable"
  | "label_field_ambiguous"
  | "due_field_unavailable"
  | "due_field_ambiguous"
  | "due_field_not_date"
  | "completion_field_unavailable"
  | "completion_field_ambiguous"
  | "completion_field_incompatible"
  | "completion_values_stale";

export type ResolvedDailyCompletion =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "boolean"; fieldId: string; columnName: string; completeValue: true }>
  | Readonly<{
      kind: "enum";
      fieldId: string;
      columnName: string;
      completeValue: string;
      terminalValues: readonly string[];
    }>;

export type ResolvedDailySourceProfile = Readonly<{
  profileId: string;
  tableId: string;
  tableName: string;
  labelFieldId: string;
  labelColumnName: string;
  dueFieldId: string;
  dueColumnName: string;
  completion: ResolvedDailyCompletion;
}>;

export type DailySourceResolution = Readonly<{
  ready: readonly ResolvedDailySourceProfile[];
  issues: readonly Readonly<{ profileId: string; reason: DailySourceIssueReason }>[];
}>;

type Found<T> =
  | Readonly<{ kind: "one"; value: T }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "many" }>;

function exactlyOne<T>(values: readonly T[]): Found<T> {
  if (values.length === 0) return { kind: "none" };
  if (values.length > 1) return { kind: "many" };
  return { kind: "one", value: values[0]! };
}

function tableById(registry: Registry, tableId: string): Found<RegTable> {
  return exactlyOne([...registry.values()].filter(table => table.semantic?.tableId === tableId));
}

function fieldById(table: RegTable, fieldId: string): Found<RegColumn> {
  return exactlyOne(table.columns.filter(column => column.semantic?.fieldId === fieldId));
}

function unavailable(column: RegColumn): boolean {
  return column.inactive === true || column.hidden === true;
}

function completionFor(
  table: RegTable,
  completion: CompletionRuleV1,
): ResolvedDailyCompletion | DailySourceIssueReason {
  if (completion.kind === "none") return Object.freeze({ kind: "none" });
  const found = fieldById(table, completion.fieldId);
  if (found.kind === "none") return "completion_field_unavailable";
  if (found.kind === "many") return "completion_field_ambiguous";
  if (unavailable(found.value)) return "completion_field_unavailable";
  if (completion.kind === "boolean") {
    if (found.value.type !== "boolean") return "completion_field_incompatible";
    return Object.freeze({
      kind: "boolean",
      fieldId: completion.fieldId,
      columnName: found.value.name,
      completeValue: true,
    });
  }
  if (found.value.type !== "enum") return "completion_field_incompatible";
  const currentValues = new Set(found.value.values ?? []);
  if (!completion.terminalValues.every(value => currentValues.has(value))) {
    return "completion_values_stale";
  }
  return Object.freeze({
    kind: "enum",
    fieldId: completion.fieldId,
    columnName: found.value.name,
    completeValue: completion.completeValue,
    terminalValues: Object.freeze([...completion.terminalValues]),
  });
}

function resolveOne(
  registry: Registry,
  profile: DailySourceProfileV1,
): ResolvedDailySourceProfile | DailySourceIssueReason {
  const table = tableById(registry, profile.tableId);
  if (table.kind === "none") return "table_missing";
  if (table.kind === "many") return "table_ambiguous";
  if (table.value.inactive) return "table_inactive";

  const label = fieldById(table.value, profile.labelFieldId);
  if (label.kind === "none") return "label_field_unavailable";
  if (label.kind === "many") return "label_field_ambiguous";
  if (unavailable(label.value)) return "label_field_unavailable";

  const due = fieldById(table.value, profile.dueFieldId);
  if (due.kind === "none") return "due_field_unavailable";
  if (due.kind === "many") return "due_field_ambiguous";
  if (unavailable(due.value)) return "due_field_unavailable";
  if (due.value.type !== "date") return "due_field_not_date";

  const completion = completionFor(table.value, profile.completion);
  if (typeof completion === "string") return completion;
  return Object.freeze({
    profileId: profile.profileId,
    tableId: profile.tableId,
    tableName: table.value.name,
    labelFieldId: profile.labelFieldId,
    labelColumnName: label.value.name,
    dueFieldId: profile.dueFieldId,
    dueColumnName: due.value.name,
    completion,
  });
}

export function resolveDailySourceProfiles(
  registry: Registry,
  input: unknown,
): DailySourceResolution {
  const parsed = DailySourceLibraryV1.safeParse(input);
  if (!parsed.success) throw new TypeError("invalid Daily Home source library");
  const ready: ResolvedDailySourceProfile[] = [];
  const issues: { profileId: string; reason: DailySourceIssueReason }[] = [];
  for (const profile of parsed.data.profiles) {
    if (!profile.enabled) continue;
    const result = resolveOne(registry, profile);
    if (typeof result === "string") {
      issues.push(Object.freeze({ profileId: profile.profileId, reason: result }));
    } else {
      ready.push(result);
    }
  }
  return Object.freeze({ ready: Object.freeze(ready), issues: Object.freeze(issues) });
}

export type DailySourceProfileStorage = {
  getSetting<T>(key: string): Promise<T | null | undefined>;
  compareAndSetDailySource<T>(
    expectedRevision: number, value: T,
  ): Promise<{ ok: boolean; current: unknown }>;
};

export type ReviewedDailySourceProfile = Pick<
  DailySourceProfileV1,
  "tableId" | "labelFieldId" | "dueFieldId" | "completion" | "labelSnapshot" | "dueLabelSnapshot"
>;

function profileIdFor(tableId: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const digest = sha256HexSync(new TextEncoder().encode(
    `clay.daily-source-profile.v1\u0000${tableId}`,
  ));
  const value = BigInt(`0x${digest}`);
  let encoded = "";
  for (let index = 0; index < 26; index++) {
    const shift = BigInt(256 - ((index + 1) * 5));
    encoded += alphabet[Number((value >> shift) & 31n)]!;
  }
  return `dsp_${encoded}`;
}

export function loadDailySourceLibrary(raw: unknown): DailySourceLibraryV1 {
  if (raw === null || raw === undefined) return { schema: 1, revision: 0, profiles: [] };
  const parsed = DailySourceLibraryV1.safeParse(raw);
  if (!parsed.success) throw new TypeError("invalid Daily Home source library");
  return parsed.data;
}

export async function upsertReviewedDailySource(
  storage: DailySourceProfileStorage,
  input: ReviewedDailySourceProfile,
): Promise<DailySourceLibraryV1> {
  input = structuredClone(input);
  let raw: unknown = await storage.getSetting<unknown>(DAILY_SOURCE_LIBRARY_SETTING);
  const originalProfile = JSON.stringify(loadDailySourceLibrary(raw).profiles.find(profile => profile.tableId === input.tableId) ?? null);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = loadDailySourceLibrary(raw);
    const profile = DailySourceProfileV1.parse({
      schema: 1,
      profileId: profileIdFor(input.tableId),
      tableId: input.tableId,
      labelFieldId: input.labelFieldId,
      dueFieldId: input.dueFieldId,
      completion: input.completion,
      enabled: true,
      ...(input.labelSnapshot ? { labelSnapshot: input.labelSnapshot } : {}),
      ...(input.dueLabelSnapshot ? { dueLabelSnapshot: input.dueLabelSnapshot } : {}),
    });
    const observed = JSON.stringify(current.profiles.find(candidate => candidate.tableId === input.tableId) ?? null);
    if (observed === JSON.stringify(profile)) return current;
    if (observed !== originalProfile) throw new Error("This source binding changed in another window; review its fields again");
    const existing = current.profiles.findIndex(candidate => candidate.tableId === input.tableId);
    const profiles = existing === -1
      ? [...current.profiles, profile]
      : current.profiles.map((candidate, index) => index === existing ? profile : candidate);
    const candidate = DailySourceLibraryV1.safeParse({
      schema: 1,
      revision: current.revision + 1,
      profiles,
    });
    if (!candidate.success) throw new TypeError("invalid reviewed Daily Home source");
    const result = await storage.compareAndSetDailySource(
      current.revision, candidate.data,
    );
    if (result.ok) return candidate.data;
    raw = result.current;
  }
  throw new Error("Today setup changed in another window; try again");
}

export async function removeReviewedDailySource(
  storage: DailySourceProfileStorage,
  profileId: string,
): Promise<DailySourceLibraryV1> {
  let raw: unknown = await storage.getSetting<unknown>(DAILY_SOURCE_LIBRARY_SETTING);
  const originalProfile = JSON.stringify(loadDailySourceLibrary(raw).profiles.find(profile => profile.profileId === profileId) ?? null);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = loadDailySourceLibrary(raw);
    const observed = current.profiles.find(profile => profile.profileId === profileId);
    if (!observed) return current;
    if (JSON.stringify(observed) !== originalProfile) throw new Error("This source changed in another window; review before removing it");
    const candidate = DailySourceLibraryV1.parse({
      schema: 1,
      revision: current.revision + 1,
      profiles: current.profiles.filter(profile => profile.profileId !== profileId),
    });
    const result = await storage.compareAndSetDailySource(current.revision, candidate);
    if (result.ok) return candidate;
    raw = result.current;
  }
  throw new Error("Today setup changed in another window; try again");
}

export function recoverableDailySourceRevision(raw: unknown): number {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return 0;
  const descriptor = Reflect.getOwnPropertyDescriptor(raw, "revision");
  const value = descriptor && "value" in descriptor ? descriptor.value : 0;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

export async function resetDailySourceLibrary(
  storage: DailySourceProfileStorage,
): Promise<DailySourceLibraryV1> {
  const raw: unknown = await storage.getSetting<unknown>(DAILY_SOURCE_LIBRARY_SETTING);
  const parsed = DailySourceLibraryV1.safeParse(raw);
  const expectedRevision = parsed.success ? parsed.data.revision : recoverableDailySourceRevision(raw);
  if (expectedRevision >= Number.MAX_SAFE_INTEGER)
    throw new Error("Today setup revision cannot be advanced safely");
  const candidate = DailySourceLibraryV1.parse({ schema: 1, revision: expectedRevision + 1, profiles: [] });
  const result = await storage.compareAndSetDailySource(expectedRevision, candidate);
  if (result.ok) return candidate;
  throw new Error("Today setup changed in another window; review before resetting it");
}
