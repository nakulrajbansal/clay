import {
  DailySourceLibraryV1,
  type CompletionRuleV1,
  type DailySourceProfileV1,
} from "@clay/schema/daily-home";
import type { RegColumn, RegTable, Registry } from "./registry";

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
