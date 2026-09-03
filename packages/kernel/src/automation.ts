import { Query as QuerySchema, type Query } from "@clay/schema";
import { ClayError } from "./errors";
import { compileQuery } from "./query";
import {
  findColumn, getTable, isVirtualColumn, type RegColumn, type Registry,
} from "./registry";
import { coerceValue } from "./rows";

export type AutomationCondition = NonNullable<Query["where"]>[number];
export type AutomationValue =
  | { source: "literal"; value: string | number | boolean | null }
  | { source: "field"; field: string };

export type AutomationTrigger =
  | { kind: "record_created" | "record_updated" | "record_matches" | "manual";
      table: string; conditions: AutomationCondition[] }
  | { kind: "date_due"; table: string; dateField: string; daysBefore: number;
      conditions: AutomationCondition[] }
  | { kind: "schedule"; cadence: "daily" | "weekly"; localTime: string; weekday?: number };

export type AutomationAction =
  | { kind: "set_fields"; values: Record<string, AutomationValue> }
  | { kind: "create_record"; table: string; values: Record<string, AutomationValue> }
  | { kind: "create_related"; table: string; relationField: string;
      values: Record<string, AutomationValue> }
  | { kind: "notify"; title: string; body: string };

export type AutomationDefinitionInput = {
  id?: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
};

export type AutomationDefinition = AutomationDefinitionInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type AutomationSimulation = {
  automationId: string;
  matchedRecords: number;
  plannedMutations: number;
  plannedNotifications: number;
  sampleLabels: string[];
};

export type AutomationRun = {
  id: string;
  automationId: string;
  at: string;
  status: "success" | "failed";
  matchedRecords: number;
  changed: number;
  batchId: string | null;
  errorCode: string | null;
  undone: boolean;
};

export type ClayNotification = {
  id: string;
  at: string;
  automationId: string;
  runId: string;
  title: string;
  body: string;
  table: string | null;
  recordId: string | null;
  read: boolean;
};

const ID = /^[a-z][a-z0-9_]{0,40}$/;
const AUTO_ID = /^auto_[0-9a-f]{32}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_VALUE_BYTES = 4_096;
const MAX_CONDITION_BYTES = 8_192;
const MAX_DEFINITION_BYTES = 32 * 1_024;
const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function fail(message: string): never {
  throw new ClayError("E_VALIDATION", message);
}

function triggerTable(trigger: AutomationTrigger): string | null {
  return trigger.kind === "schedule" ? null : trigger.table;
}

function validateConditions(
  registry: Registry, table: string, conditions: unknown,
  requireOne = false,
): AutomationCondition[] {
  if (!Array.isArray(conditions) || conditions.length > 8 || (requireOne && conditions.length === 0))
    fail(requireOne ? "record-match trigger needs 1 to 8 conditions" : "trigger conditions are invalid");
  if (utf8Bytes(conditions) > MAX_CONDITION_BYTES)
    fail("automation conditions exceed the 8,192-byte size limit");
  for (const condition of conditions) {
    if (object(condition) && typeof condition.value === "string"
        && new TextEncoder().encode(condition.value).byteLength > MAX_VALUE_BYTES)
      fail("automation condition values must be at most 4,096 bytes");
  }
  const parsed = QuerySchema.parse({ from: table, where: conditions, limit: 1 });
  compileQuery(registry, parsed, new Date());
  return parsed.where ?? [];
}

function writable(column: RegColumn | undefined): column is RegColumn {
  return !!column && !column.hidden && !column.inactive && !isVirtualColumn(column)
    && column.type !== "attachment";
}

function validateValue(
  registry: Registry,
  sourceTable: string | null,
  targetTable: string,
  targetField: string,
  raw: unknown,
): AutomationValue {
  if (!object(raw) || (raw.source !== "literal" && raw.source !== "field"))
    fail(`automation value for '${targetTable}.${targetField}' is invalid`);
  const target = getTable(registry, targetTable);
  const column = findColumn(target, targetField);
  if (!writable(column)) fail(`automation cannot write '${targetTable}.${targetField}'`);
  if (raw.source === "literal") {
    const value = raw.value;
    if (value !== null && typeof value !== "string" && typeof value !== "number"
        && typeof value !== "boolean") fail("automation literals must be scalar");
    if (typeof value === "string" && new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES)
      fail("automation literal values must be at most 4,096 bytes");
    coerceValue(targetTable, column, value);
    return { source: "literal", value };
  }
  if (!sourceTable || typeof raw.field !== "string" || !ID.test(raw.field))
    fail("scheduled actions cannot copy a trigger field");
  const source = findColumn(getTable(registry, sourceTable), raw.field);
  if (!source || source.hidden || source.inactive || isVirtualColumn(source)
      || source.type === "attachment" || source.type === "json")
    fail(`automation source field '${sourceTable}.${raw.field}' is invalid`);
  return { source: "field", field: raw.field };
}

function validateValues(
  registry: Registry,
  sourceTable: string | null,
  targetTable: string,
  raw: unknown,
): Record<string, AutomationValue> {
  if (!object(raw) || Object.keys(raw).length > 20) fail("automation values must have at most 20 fields");
  const values: Record<string, AutomationValue> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!ID.test(field)) fail("automation field name is invalid");
    values[field] = validateValue(registry, sourceTable, targetTable, field, value);
  }
  return values;
}

export function validateAutomationDefinition(
  registry: Registry,
  raw: AutomationDefinitionInput,
): AutomationDefinitionInput {
  if (!object(raw) || typeof raw.name !== "string" || raw.name.trim().length < 1
      || raw.name.trim().length > 80 || typeof raw.enabled !== "boolean")
    fail("automation name must be 1 to 80 characters");
  if (raw.id !== undefined && (typeof raw.id !== "string" || !AUTO_ID.test(raw.id)))
    fail("automation id is invalid");
  if (!object(raw.trigger) || typeof raw.trigger.kind !== "string") fail("automation trigger is invalid");
  let trigger: AutomationTrigger;
  const kind = raw.trigger.kind;
  if (kind === "schedule") {
    if ((raw.trigger.cadence !== "daily" && raw.trigger.cadence !== "weekly")
        || typeof raw.trigger.localTime !== "string" || !TIME.test(raw.trigger.localTime)
        || (raw.trigger.cadence === "weekly"
          && (!Number.isInteger(raw.trigger.weekday) || Number(raw.trigger.weekday) < 0
            || Number(raw.trigger.weekday) > 6))) fail("schedule trigger is invalid");
    trigger = {
      kind: "schedule", cadence: raw.trigger.cadence, localTime: raw.trigger.localTime,
      ...(raw.trigger.cadence === "weekly" ? { weekday: Number(raw.trigger.weekday) } : {}),
    };
  } else if (["record_created", "record_updated", "record_matches", "manual", "date_due"].includes(kind)) {
    if (typeof raw.trigger.table !== "string") fail("automation trigger table is invalid");
    const table = raw.trigger.table;
    getTable(registry, table);
    const conditions = validateConditions(
      registry, table, raw.trigger.conditions, kind === "record_matches");
    if (kind === "date_due") {
      if (typeof raw.trigger.dateField !== "string" || !Number.isInteger(raw.trigger.daysBefore)
          || Number(raw.trigger.daysBefore) < -365 || Number(raw.trigger.daysBefore) > 365)
        fail("due-date trigger is invalid");
      const date = findColumn(getTable(registry, table), raw.trigger.dateField);
      if (!date || date.type !== "date") fail("due-date trigger needs a date field");
      trigger = { kind, table, dateField: raw.trigger.dateField,
        daysBefore: Number(raw.trigger.daysBefore), conditions };
    } else {
      trigger = { kind: kind as "record_created" | "record_updated" | "record_matches" | "manual",
        table, conditions };
    }
  } else fail("automation action or trigger kind is not allowed");

  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > 5)
    fail("automation needs 1 to 5 actions");
  const sourceTable = triggerTable(trigger);
  const actions: AutomationAction[] = raw.actions.map(action => {
    if (!object(action) || typeof action.kind !== "string") fail("automation action is invalid");
    if (action.kind === "notify") {
      if (typeof action.title !== "string" || action.title.trim().length < 1
          || action.title.length > 80 || typeof action.body !== "string" || action.body.length > 240)
        fail("notification text is invalid");
      return { kind: "notify", title: action.title.trim(), body: action.body };
    }
    if (action.kind === "set_fields") {
      if (!sourceTable) fail("scheduled automation cannot update a trigger record");
      return { kind: "set_fields",
        values: validateValues(registry, sourceTable, sourceTable, action.values) };
    }
    if (action.kind === "create_record") {
      if (typeof action.table !== "string") fail("create-record table is invalid");
      getTable(registry, action.table);
      return { kind: "create_record", table: action.table,
        values: validateValues(registry, sourceTable, action.table, action.values) };
    }
    if (action.kind === "create_related") {
      if (!sourceTable || typeof action.table !== "string" || typeof action.relationField !== "string")
        fail("create-related action needs a trigger and relation field");
      const table = getTable(registry, action.table);
      const relation = findColumn(table, action.relationField);
      if (!relation?.relation || relation.type !== "relation"
          || relation.relation.target_table !== sourceTable)
        fail("create-related action relation does not target the trigger table");
      return { kind: "create_related", table: action.table,
        relationField: action.relationField,
        values: validateValues(registry, sourceTable, action.table, action.values) };
    }
    fail("automation action or trigger kind is not allowed");
  });
  if ((trigger.kind === "record_matches" || trigger.kind === "date_due")
      && actions.some(action => (action.kind === "create_record" || action.kind === "create_related")
        && action.table === trigger.table))
    fail("automation cannot recursively create records in its own matched table");
  const normalized = { ...(raw.id ? { id: raw.id } : {}), name: raw.name.trim(), enabled: raw.enabled,
    trigger, actions };
  if (utf8Bytes(normalized) > MAX_DEFINITION_BYTES)
    fail("automation definition exceeds the 32 KiB size limit");
  return normalized;
}
