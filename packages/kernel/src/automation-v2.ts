import type { Query } from "@clay/schema";
import { ClayError } from "./errors";
import {
  findColumn, getTable, isVirtualColumn,
  type RegColumn, type RegTable, type Registry,
} from "./registry";
import { isFieldId, isTableId, type FieldId, type TableId } from "./semantic";
import { sha256HexSync } from "./state-digest";
import {
  validateAutomationDefinition,
  type AutomationAction, type AutomationCondition, type AutomationDefinitionInput,
  type AutomationRun, type AutomationTrigger, type AutomationValue,
} from "./automation";

export const AUTOMATION_RECIPE_IDS = [
  "overdue_invoice_reminder",
  "weekly_checklist",
  "new_customer_follow_up",
] as const;
export type AutomationRecipeId = typeof AUTOMATION_RECIPE_IDS[number];
export type AutomationState = "draft" | "simulated" | "enabled" | "paused" | "error";
export type AutomationPurpose = "enable" | "run_now" | "proposal_review";
export type AutomationRuntimeMode = "local";

export type AutomationTargetIdentityV1 = Readonly<{
  v: 1;
  appInstanceId: string;
  activeGenerationId: string;
  lineageEpoch: string;
  stateRevision: string;
  stateDigest: string;
}>;

export type StableTableRef = Readonly<{
  tableId: TableId;
  lastKnownName: string;
}>;

export type StableFieldRef = Readonly<{
  tableId: TableId;
  fieldId: FieldId;
  lastKnownName: string;
}>;

type QueryCondition = NonNullable<Query["where"]>[number];
export type ClosedTypedConditionV2 = Omit<QueryCondition, "field"> & {
  field: StableFieldRef;
};

export type ClosedAutomationTriggerV2 =
  | {
      kind: "record_created" | "record_updated" | "record_matches" | "manual";
      table: StableTableRef;
      conditions: ClosedTypedConditionV2[];
    }
  | {
      kind: "date_due";
      table: StableTableRef;
      dateField: StableFieldRef;
      daysBefore: number;
      conditions: ClosedTypedConditionV2[];
    }
  | {
      kind: "schedule";
      cadence: "daily" | "weekly";
      localTime: string;
      weekday?: number;
    };

export type StableAutomationValueV2 = Readonly<{
  field: StableFieldRef;
  value: AutomationValue;
}>;

export type ClosedAutomationActionV2 =
  | { kind: "set_fields"; values: StableAutomationValueV2[] }
  | { kind: "create_record"; table: StableTableRef; values: StableAutomationValueV2[] }
  | {
      kind: "create_related";
      table: StableTableRef;
      relationField: StableFieldRef;
      values: StableAutomationValueV2[];
    }
  | { kind: "notify"; title: string; body: string };

export type AutomationDraftInputV2 = {
  v: 2;
  id?: string;
  name: string;
  recipe?: { id: AutomationRecipeId; version: number };
  trigger: ClosedAutomationTriggerV2;
  actions: ClosedAutomationActionV2[];
  runtime: {
    mode: AutomationRuntimeMode;
    timeZone?: string;
    missedPolicy?: "skip" | "run_once_when_available";
  };
};

export type AutomationEnableProofV1 = Readonly<{
  v: 1;
  id: string;
  target: AutomationTargetIdentityV1;
  automationId: string;
  simulationId: string;
  definitionRevision: number;
  definitionDigest: string;
  issuedAt: string;
}>;

export type AutomationDefinitionV2 = AutomationDraftInputV2 & {
  id: string;
  definitionRevision: number;
  state: AutomationState;
  enabled: boolean;
  needsRepair: false;
  enableProof: AutomationEnableProofV1 | null;
  authorityTarget: AutomationTargetIdentityV1 | null;
  authorityDefinitionRevision: number | null;
  authorityDefinitionDigest: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationLegacyDefinitionV1 = AutomationDefinitionInput & {
  v: 1;
  id: string;
  enabled: false;
  persistedEnabled: boolean;
  definitionRevision: 0;
  state: "draft" | "paused";
  needsRepair: true;
  repairReason: "REVIEW_REQUIRED_AFTER_UPGRADE";
  createdAt: string;
  updatedAt: string;
};

export type AutomationDefinitionAny = AutomationDefinitionV2 | AutomationLegacyDefinitionV1;

export type ClosedPlannedEffectV1 = Readonly<{
  kind: ClosedAutomationActionV2["kind"];
  count: number;
  tableId?: TableId;
  fieldIds?: readonly FieldId[];
}>;

export type AutomationSimulationProofV1 = Readonly<{
  v: 1;
  id: string;
  target: AutomationTargetIdentityV1;
  purpose: AutomationPurpose;
  automationId: string;
  definitionRevision: number;
  definitionDigest: string;
  schemaRevision: number;
  referenceFingerprint: string;
  dataRevision: number;
  evaluatedAt: string;
  expiresAt: string;
  snapshotDigest: string;
  matchedRecords: number;
  matchedScope: Readonly<{
    kind: "records" | "schedule";
    recordIds: readonly string[];
  }>;
  plannedMutations: number;
  plannedNotifications: number;
  plannedEffects: readonly ClosedPlannedEffectV1[];
  sampleLabels: readonly string[];
  runtime: Readonly<{
    mode: "local";
    requiresAppOpen: true;
    timeZone: string | null;
  }>;
  undo: "available_after_commit" | "no_data_changes";
}>;

export type AutomationSimulationRequestV1 = Readonly<{
  id: string;
  target: AutomationTargetIdentityV1;
  expectedRevision: number;
  purpose: AutomationPurpose;
}>;

export type AutomationEnableRequestV1 = Readonly<{
  id: string;
  target: AutomationTargetIdentityV1;
  expectedRevision: number;
  simulation: AutomationSimulationProofV1;
}>;

export type AutomationPauseRequestV1 = Readonly<{
  id: string;
  expectedRevision: number;
}>;

export type AutomationRunNowRequestV1 = Readonly<{
  id: string;
  target: AutomationTargetIdentityV1;
  expectedRevision: number;
  simulation: AutomationSimulationProofV1;
}>;

export type AutomationNoOpResultV1 = Readonly<{
  v: 1;
  kind: "no_op";
  target: AutomationTargetIdentityV1;
  automationId: string;
  reasonCode: "NO_ACTUAL_RETAINED_MUTATION";
  evaluatedAt: string;
}>;

export type AutomationCommittedResultV1 = Readonly<{
  v: 1;
  kind: "committed";
  id: string;
  target: AutomationTargetIdentityV1;
  automationId: string;
  simulationId: string;
  definitionRevision: number;
  definitionDigest: string;
  committedAt: string;
  receipt: AutomationRun;
}>;

export type AutomationExecutionResultV1 =
  | AutomationNoOpResultV1
  | AutomationCommittedResultV1;

export type AutomationRuntimeStatusV1 = Readonly<{
  v: 1;
  engine: "local_worker_session";
  sessionActive: true;
  backgroundExecution: false;
  offDeviceExecution: false;
  modelAccess: false;
  networkAccess: false;
  headline: "Automations run on this device while Clay is open.";
  detail: "If Clay is closed or this device sleeps, scheduled work waits until a Clay session is available.";
  enabledDefinitions: number;
  disabledDefinitions: number;
  needsRepairDefinitions: number;
}>;

export type AutomationRunUndoReasonV1 = "AVAILABLE" | "RUN_FAILED" | "ALREADY_UNDONE"
  | "HISTORY_MISSING" | "RECORD_CHANGED" | "FOREIGN_TARGET";

export type AutomationRunRuntimeStateV1 = Readonly<{
  v: 1;
  runId: string;
  failure: Readonly<{ code: string; detail: string }> | null;
  undo: Readonly<{
    available: boolean;
    reason: AutomationRunUndoReasonV1;
    detail: string;
  }>;
}>;

export type AutomationRuleRuntimeStateV1 = Readonly<{
  v: 1;
  automationId: string;
  lastRunId: string | null;
  lastRun: AutomationRun | null;
  next: Readonly<{
    kind: "event" | "schedule" | "manual";
    detail: string;
  }>;
  skip: Readonly<{
    code: "REVIEW_REQUIRED_AFTER_UPGRADE" | "DRAFT_DISABLED" | "PAUSED" | "ERROR_DISABLED"
      | "MISSED_SCHEDULE_WINDOW";
    detail: string;
  }> | null;
}>;

export type AutomationRuntimeOverviewV1 = Readonly<{
  v: 1;
  rules: readonly AutomationRuleRuntimeStateV1[];
  runs: readonly AutomationRunRuntimeStateV1[];
}>;

export type AutomationRecipeOptionV1 =
  | Readonly<{
      kind: "overdue_invoice_reminder";
      source: StableTableRef;
      dateFields: readonly StableFieldRef[];
      conditionFields: readonly StableFieldRef[];
    }>
  | Readonly<{
      kind: "weekly_checklist";
      target: StableTableRef;
      writableFields: readonly StableFieldRef[];
    }>
  | Readonly<{
      kind: "new_customer_follow_up";
      source: StableTableRef;
      target: StableTableRef;
      relationField: StableFieldRef;
      writableFields: readonly StableFieldRef[];
    }>;

export type AutomationRecipeCardV1 = Readonly<{
  v: 1;
  id: AutomationRecipeId;
  version: 1;
  title: string;
  result: string;
  requiredMappings: readonly string[];
  runtimeFact: "Runs on this device while Clay is open.";
  undoFact: string;
  options: readonly AutomationRecipeOptionV1[];
}>;

export type AutomationRecipeDraftRequestV1 =
  | Readonly<{
      v: 1;
      recipeId: "overdue_invoice_reminder";
      recipeVersion: 1;
      mapping: Readonly<{
        sourceTableId: TableId;
        dateFieldId: FieldId;
        conditionFieldId: FieldId;
        conditionValue: string | number | boolean;
        daysBefore: number;
      }>;
    }>
  | Readonly<{
      v: 1;
      recipeId: "weekly_checklist";
      recipeVersion: 1;
      mapping: Readonly<{
        targetTableId: TableId;
        titleFieldId: FieldId;
        title: string;
        weekday: number;
        localTime: string;
        timeZone: string;
      }>;
    }>
  | Readonly<{
      v: 1;
      recipeId: "new_customer_follow_up";
      recipeVersion: 1;
      mapping: Readonly<{
        sourceTableId: TableId;
        targetTableId: TableId;
        relationFieldId: FieldId;
        titleFieldId: FieldId;
        title: string;
      }>;
    }>;

export type ResolvedAutomationV2 = Readonly<{
  stored: AutomationDraftInputV2;
  executable: AutomationDefinitionInput;
  referenceFingerprint: string;
}>;

function invalid(message: string): never {
  throw new ClayError("E_VALIDATION", message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (plainRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key]);
    return output;
  }
  return value;
}

export function stableAutomationJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function automationSha256(value: unknown): string {
  return `sha256:${sha256HexSync(new TextEncoder().encode(stableAutomationJson(value)))}`;
}

function withoutPresentationLabels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => withoutPresentationLabels(item));
  if (!plainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key !== "lastKnownName") output[key] = withoutPresentationLabels(value[key]);
  }
  return output;
}

function safePresentationName(value: unknown, kind: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 120)
    invalid(`${kind} last-known name is invalid`);
  return value;
}

export function resolveStableTable(registry: Registry, ref: StableTableRef): RegTable {
  if (!plainRecord(ref) || !isTableId(ref.tableId)) invalid("automation table ID is invalid");
  safePresentationName(ref.lastKnownName, "automation table");
  const matches = [...registry.values()].filter(table => table.semantic?.tableId === ref.tableId);
  if (matches.length !== 1 || matches[0]!.inactive)
    invalid("automation table ID is missing or inactive");
  return matches[0]!;
}

export function resolveStableField(
  registry: Registry,
  ref: StableFieldRef,
  expectedTable?: RegTable,
): { table: RegTable; column: RegColumn } {
  if (!plainRecord(ref) || !isTableId(ref.tableId) || !isFieldId(ref.fieldId))
    invalid("automation field ID is invalid");
  safePresentationName(ref.lastKnownName, "automation field");
  const table = [...registry.values()].find(candidate => candidate.semantic?.tableId === ref.tableId);
  if (!table || table.inactive || (expectedTable && table !== expectedTable))
    invalid("automation field belongs to another or inactive table");
  const matches = table.columns.filter(column => column.semantic?.fieldId === ref.fieldId);
  if (matches.length !== 1 || matches[0]!.inactive || matches[0]!.hidden)
    invalid("automation field ID is missing, hidden, or inactive");
  return { table, column: matches[0]! };
}

function currentTableRef(table: RegTable): StableTableRef {
  if (!table.semantic || !isTableId(table.semantic.tableId)) invalid("table semantic ID is unavailable");
  return Object.freeze({ tableId: table.semantic.tableId, lastKnownName: table.name });
}

function currentFieldRef(table: RegTable, column: RegColumn): StableFieldRef {
  if (!table.semantic || !column.semantic || !isFieldId(column.semantic.fieldId))
    invalid("field semantic ID is unavailable");
  return Object.freeze({
    tableId: table.semantic.tableId,
    fieldId: column.semantic.fieldId,
    lastKnownName: column.name,
  });
}

function resolveConditions(
  registry: Registry,
  table: RegTable,
  conditions: readonly ClosedTypedConditionV2[],
): { stable: ClosedTypedConditionV2[]; executable: AutomationCondition[] } {
  if (!Array.isArray(conditions)) invalid("automation conditions are invalid");
  const stable: ClosedTypedConditionV2[] = [];
  const executable: AutomationCondition[] = [];
  for (const condition of conditions) {
    if (!plainRecord(condition)) invalid("automation condition is invalid");
    const typed = condition as ClosedTypedConditionV2;
    const { column } = resolveStableField(registry, typed.field, table);
    const normalized = { ...typed, field: currentFieldRef(table, column) } as ClosedTypedConditionV2;
    stable.push(normalized);
    executable.push({ ...typed, field: column.name } as AutomationCondition);
  }
  return { stable, executable };
}

function resolveValues(
  registry: Registry,
  source: RegTable | null,
  target: RegTable,
  values: readonly StableAutomationValueV2[],
): { stable: StableAutomationValueV2[]; executable: Record<string, AutomationValue> } {
  if (!Array.isArray(values) || values.length > 20) invalid("automation values are invalid");
  const stable: StableAutomationValueV2[] = [];
  const executable: Record<string, AutomationValue> = {};
  const ids = new Set<string>();
  for (const entry of values) {
    if (!plainRecord(entry) || !plainRecord(entry.value)) invalid("automation value is invalid");
    const typed = entry as StableAutomationValueV2;
    const { column } = resolveStableField(registry, typed.field, target);
    if (ids.has(typed.field.fieldId)) invalid("automation values contain a duplicate field ID");
    ids.add(typed.field.fieldId);
    let value: AutomationValue;
    if (typed.value.source === "literal") {
      value = { source: "literal", value: typed.value.value };
    } else if (typed.value.source === "field") {
      const sourceFieldId = typed.value.field;
      if (!source || !isFieldId(sourceFieldId))
        invalid("automation copied value must use a stable source field ID");
      const sourceColumn = source.columns.find(candidate => candidate.semantic?.fieldId === sourceFieldId);
      if (!sourceColumn || sourceColumn.hidden || sourceColumn.inactive || isVirtualColumn(sourceColumn))
        invalid("automation copied source field ID is unavailable");
      value = { source: "field", field: sourceColumn.name };
    } else invalid("automation value source is invalid");
    stable.push(Object.freeze({ field: currentFieldRef(target, column), value: typed.value }));
    executable[column.name] = value;
  }
  return { stable, executable };
}

function assertRequiredCreateValues(
  table: RegTable,
  values: readonly StableAutomationValueV2[],
  suppliedSeparately: readonly RegColumn[] = [],
): void {
  const supplied = new Set([
    ...values.map(entry => entry.field.fieldId),
    ...suppliedSeparately.flatMap(column => column.semantic ? [column.semantic.fieldId] : []),
  ]);
  const missing = table.columns.find(column => column.required && !column.hidden && !column.inactive
    && !isVirtualColumn(column) && (!column.semantic || !supplied.has(column.semantic.fieldId)));
  if (missing) invalid(`automation create action must provide required field '${table.name}.${missing.name}'`);
}

function normalizeRecipe(value: AutomationDraftInputV2["recipe"]): AutomationDraftInputV2["recipe"] {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || !(AUTOMATION_RECIPE_IDS as readonly unknown[]).includes(value.id)
      || !Number.isSafeInteger(value.version) || value.version !== 1)
    invalid("automation recipe provenance is invalid");
  return { id: value.id as AutomationRecipeId, version: value.version as number };
}

function normalizeRuntime(value: AutomationDraftInputV2["runtime"]): AutomationDraftInputV2["runtime"] {
  if (!plainRecord(value) || value.mode !== "local")
    invalid("only the local automation runtime is available");
  if (value.timeZone !== undefined && (typeof value.timeZone !== "string"
      || value.timeZone.length < 1 || value.timeZone.length > 80))
    invalid("automation timezone is invalid");
  if (typeof value.timeZone === "string") {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(0); }
    catch { invalid("automation timezone is invalid or unavailable"); }
  }
  if (value.missedPolicy !== undefined && value.missedPolicy !== "skip"
      && value.missedPolicy !== "run_once_when_available")
    invalid("automation missed-run policy is invalid");
  return {
    mode: "local",
    ...(value.timeZone === undefined ? {} : { timeZone: value.timeZone }),
    ...(value.missedPolicy === undefined ? {} : { missedPolicy: value.missedPolicy }),
  };
}

export function resolveAutomationDraftV2(
  registry: Registry,
  raw: AutomationDraftInputV2,
): ResolvedAutomationV2 {
  if (!plainRecord(raw) || raw.v !== 2 || typeof raw.name !== "string")
    invalid("automation V2 draft is invalid");
  if (raw.id !== undefined && (typeof raw.id !== "string" || !/^auto_[0-9a-f]{32}$/.test(raw.id)))
    invalid("automation id is invalid");
  const runtime = normalizeRuntime(raw.runtime);
  const recipe = normalizeRecipe(raw.recipe);
  if (!plainRecord(raw.trigger) || typeof raw.trigger.kind !== "string")
    invalid("automation trigger is invalid");
  let source: RegTable | null = null;
  let trigger: ClosedAutomationTriggerV2;
  let executableTrigger: AutomationTrigger;
  if (raw.trigger.kind === "schedule") {
    trigger = {
      kind: "schedule",
      cadence: raw.trigger.cadence,
      localTime: raw.trigger.localTime,
      ...(raw.trigger.cadence === "weekly" ? { weekday: raw.trigger.weekday } : {}),
    };
    executableTrigger = trigger;
  } else {
    source = resolveStableTable(registry, raw.trigger.table);
    const table = currentTableRef(source);
    const conditions = resolveConditions(registry, source, raw.trigger.conditions);
    if (raw.trigger.kind === "date_due") {
      const { column } = resolveStableField(registry, raw.trigger.dateField, source);
      trigger = {
        kind: "date_due",
        table,
        dateField: currentFieldRef(source, column),
        daysBefore: raw.trigger.daysBefore,
        conditions: conditions.stable,
      };
      executableTrigger = {
        kind: "date_due",
        table: source.name,
        dateField: column.name,
        daysBefore: raw.trigger.daysBefore,
        conditions: conditions.executable,
      };
    } else if (["record_created", "record_updated", "record_matches", "manual"]
      .includes(raw.trigger.kind)) {
      const kind = raw.trigger.kind as "record_created" | "record_updated" | "record_matches" | "manual";
      trigger = { kind, table, conditions: conditions.stable };
      executableTrigger = { kind, table: source.name, conditions: conditions.executable };
    } else invalid("automation trigger kind is not allowed");
  }

  if (!Array.isArray(raw.actions)) invalid("automation actions are invalid");
  const actions: ClosedAutomationActionV2[] = [];
  const executableActions: AutomationAction[] = [];
  for (const action of raw.actions) {
    if (!plainRecord(action) || typeof action.kind !== "string")
      invalid("automation action is invalid");
    if (action.kind === "notify") {
      actions.push({ kind: "notify", title: action.title, body: action.body });
      executableActions.push({ kind: "notify", title: action.title, body: action.body });
      continue;
    }
    if (action.kind === "set_fields") {
      if (!source) invalid("scheduled automation cannot update a trigger record");
      const values = resolveValues(registry, source, source, action.values);
      actions.push({ kind: "set_fields", values: values.stable });
      executableActions.push({ kind: "set_fields", values: values.executable });
      continue;
    }
    if (action.kind === "create_record" || action.kind === "create_related") {
      const target = resolveStableTable(registry, action.table);
      if (action.kind === "create_record") {
        const values = resolveValues(registry, source, target, action.values);
        assertRequiredCreateValues(target, values.stable);
        actions.push({ kind: "create_record", table: currentTableRef(target), values: values.stable });
        executableActions.push({ kind: "create_record", table: target.name, values: values.executable });
      } else {
        if (!source) invalid("create-related action needs a trigger table");
        const { column } = resolveStableField(registry, action.relationField, target);
        const values = resolveValues(registry, source, target, action.values);
        assertRequiredCreateValues(target, values.stable, [column]);
        actions.push({
          kind: "create_related",
          table: currentTableRef(target),
          relationField: currentFieldRef(target, column),
          values: values.stable,
        });
        executableActions.push({
          kind: "create_related",
          table: target.name,
          relationField: column.name,
          values: values.executable,
        });
      }
      continue;
    }
    invalid("automation action kind is not allowed");
  }

  const executable = validateAutomationDefinition(registry, {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    name: raw.name,
    enabled: false,
    trigger: executableTrigger,
    actions: executableActions,
  });
  const stored: AutomationDraftInputV2 = {
    v: 2,
    ...(raw.id === undefined ? {} : { id: raw.id }),
    name: executable.name,
    ...(recipe === undefined ? {} : { recipe }),
    trigger,
    actions,
    runtime,
  };
  return {
    stored,
    executable,
    referenceFingerprint: automationSha256(withoutPresentationLabels({
      v: 1,
      trigger: stored.trigger,
      actions: stored.actions,
    })),
  };
}

export function automationDefinitionDigest(definition: AutomationDraftInputV2): string {
  return automationSha256(withoutPresentationLabels({
    v: 2,
    recipe: definition.recipe ?? null,
    trigger: definition.trigger,
    actions: definition.actions,
    runtime: definition.runtime,
  }));
}

export function validateAutomationTargetIdentity(
  value: AutomationTargetIdentityV1,
): AutomationTargetIdentityV1 {
  if (!plainRecord(value)
      || Object.keys(value).sort().join("\0") !== [
        "activeGenerationId", "appInstanceId", "lineageEpoch", "stateDigest", "stateRevision", "v",
      ].join("\0")
      || value.v !== 1
      || typeof value.appInstanceId !== "string" || !/^app_[a-z2-7]{26}$/.test(value.appInstanceId)
      || typeof value.activeGenerationId !== "string" || !/^gen_[a-z2-7]{26}$/.test(value.activeGenerationId)
      || typeof value.lineageEpoch !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value.lineageEpoch)
      || typeof value.stateRevision !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value.stateRevision)
      || typeof value.stateDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.stateDigest))
    invalid("automation target identity is invalid");
  return Object.freeze({
    v: 1,
    appInstanceId: value.appInstanceId,
    activeGenerationId: value.activeGenerationId,
    lineageEpoch: value.lineageEpoch,
    stateRevision: value.stateRevision,
    stateDigest: value.stateDigest,
  });
}

export function validateAutomationEnableProof(
  value: unknown,
  expected: Readonly<{
    automationId: string;
    definitionRevision: number;
    definitionDigest: string;
  }>,
): AutomationEnableProofV1 {
  if (!plainRecord(value)) invalid("automation enable proof is invalid");
  const expectedKeys = [
    "automationId", "definitionDigest", "definitionRevision", "id", "issuedAt",
    "simulationId", "target", "v",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")
      || value.v !== 1
      || typeof value.id !== "string" || !/^aep_[0-9a-f]{64}$/.test(value.id)
      || typeof value.automationId !== "string" || !/^auto_[0-9a-f]{32}$/.test(value.automationId)
      || value.automationId !== expected.automationId
      || typeof value.simulationId !== "string" || !/^asim_[0-9a-f]{64}$/.test(value.simulationId)
      || !Number.isSafeInteger(value.definitionRevision) || Number(value.definitionRevision) < 1
      || value.definitionRevision !== expected.definitionRevision
      || typeof value.definitionDigest !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(value.definitionDigest)
      || value.definitionDigest !== expected.definitionDigest
      || typeof value.issuedAt !== "string" || !Number.isFinite(Date.parse(value.issuedAt))
      || new Date(Date.parse(value.issuedAt)).toISOString() !== value.issuedAt)
    invalid("automation enable proof is invalid or stale");
  const target = validateAutomationTargetIdentity(value.target as AutomationTargetIdentityV1);
  const proofCore = {
    v: 1 as const,
    target,
    automationId: value.automationId,
    simulationId: value.simulationId,
    definitionRevision: value.definitionRevision,
    definitionDigest: value.definitionDigest,
    issuedAt: value.issuedAt,
  };
  if (value.id !== `aep_${automationSha256(proofCore).slice("sha256:".length)}`)
    invalid("automation enable proof digest is invalid");
  return Object.freeze({ ...proofCore, id: value.id });
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function densePlainArray(value: unknown, maxLength: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maxLength) return false;
  const keys = Object.keys(value);
  return keys.length === value.length && keys.every((key, index) => key === String(index));
}

function simulationProofInvalid(): never {
  return invalid("automation simulation proof is invalid");
}

export function validateAutomationSimulationProof(value: unknown): AutomationSimulationProofV1 {
  const keys = [
    "automationId", "dataRevision", "definitionDigest", "definitionRevision",
    "evaluatedAt", "expiresAt", "id", "matchedRecords", "matchedScope",
    "plannedEffects", "plannedMutations", "plannedNotifications", "purpose",
    "referenceFingerprint", "runtime", "sampleLabels", "schemaRevision",
    "snapshotDigest", "target", "undo", "v",
  ] as const;
  if (!plainRecord(value) || !exactObjectKeys(value, keys) || value.v !== 1
      || typeof value.id !== "string" || !/^asim_[0-9a-f]{64}$/.test(value.id)
      || typeof value.automationId !== "string" || !/^auto_[0-9a-f]{32}$/.test(value.automationId)
      || !Number.isSafeInteger(value.definitionRevision) || Number(value.definitionRevision) < 1
      || typeof value.definitionDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.definitionDigest)
      || !Number.isSafeInteger(value.schemaRevision) || Number(value.schemaRevision) < 0
      || typeof value.referenceFingerprint !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(value.referenceFingerprint)
      || !Number.isSafeInteger(value.dataRevision) || Number(value.dataRevision) < 0
      || typeof value.snapshotDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.snapshotDigest)
      || (value.purpose !== "enable" && value.purpose !== "run_now"
        && value.purpose !== "proposal_review")
      || !Number.isSafeInteger(value.matchedRecords) || Number(value.matchedRecords) < 0
      || Number(value.matchedRecords) > 100
      || !Number.isSafeInteger(value.plannedMutations) || Number(value.plannedMutations) < 0
      || Number(value.plannedMutations) > 300
      || !Number.isSafeInteger(value.plannedNotifications) || Number(value.plannedNotifications) < 0
      || Number(value.plannedNotifications) > 300
      || (value.undo !== "available_after_commit" && value.undo !== "no_data_changes"))
    simulationProofInvalid();

  const evaluatedMs = Date.parse(String(value.evaluatedAt));
  const expiresMs = Date.parse(String(value.expiresAt));
  if (typeof value.evaluatedAt !== "string" || typeof value.expiresAt !== "string"
      || !Number.isFinite(evaluatedMs) || !Number.isFinite(expiresMs)
      || new Date(evaluatedMs).toISOString() !== value.evaluatedAt
      || new Date(expiresMs).toISOString() !== value.expiresAt
      || expiresMs - evaluatedMs !== 300_000)
    simulationProofInvalid();

  const target = validateAutomationTargetIdentity(value.target as AutomationTargetIdentityV1);
  if (!plainRecord(value.matchedScope)
      || !exactObjectKeys(value.matchedScope, ["kind", "recordIds"])
      || (value.matchedScope.kind !== "records" && value.matchedScope.kind !== "schedule")
      || !densePlainArray(value.matchedScope.recordIds, 100)
      || value.matchedScope.recordIds.some(id => typeof id !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      || new Set(value.matchedScope.recordIds).size !== value.matchedScope.recordIds.length
      || (value.matchedScope.kind === "records"
        && value.matchedScope.recordIds.length !== Number(value.matchedRecords))
      || (value.matchedScope.kind === "schedule"
        && (value.matchedScope.recordIds.length !== 0 || Number(value.matchedRecords) !== 1)))
    simulationProofInvalid();

  if (!densePlainArray(value.plannedEffects, 3) || value.plannedEffects.length < 1)
    simulationProofInvalid();
  const plannedEffects: ClosedPlannedEffectV1[] = value.plannedEffects.map(raw => {
    if (!plainRecord(raw) || typeof raw.kind !== "string"
        || !Number.isSafeInteger(raw.count) || Number(raw.count) < 0 || Number(raw.count) > 100)
      simulationProofInvalid();
    if (raw.kind === "notify") {
      if (!exactObjectKeys(raw, ["kind", "count"])) simulationProofInvalid();
      return Object.freeze({ kind: "notify" as const, count: Number(raw.count) });
    }
    if (raw.kind !== "set_fields" && raw.kind !== "create_record" && raw.kind !== "create_related")
      simulationProofInvalid();
    if (!exactObjectKeys(raw, ["kind", "count", "tableId", "fieldIds"])
        || !isTableId(raw.tableId) || !densePlainArray(raw.fieldIds, 20)
        || raw.fieldIds.some(fieldId => !isFieldId(fieldId))
        || new Set(raw.fieldIds).size !== raw.fieldIds.length)
      simulationProofInvalid();
    return Object.freeze({
      kind: raw.kind,
      count: Number(raw.count),
      tableId: raw.tableId,
      fieldIds: Object.freeze([...raw.fieldIds] as FieldId[]),
    });
  });

  if (!densePlainArray(value.sampleLabels, 5)
      || value.sampleLabels.some(label => typeof label !== "string" || label.length > 10_000))
    simulationProofInvalid();
  if (!plainRecord(value.runtime)
      || !exactObjectKeys(value.runtime, ["mode", "requiresAppOpen", "timeZone"])
      || value.runtime.mode !== "local" || value.runtime.requiresAppOpen !== true
      || (value.runtime.timeZone !== null && (typeof value.runtime.timeZone !== "string"
        || value.runtime.timeZone.length < 1 || value.runtime.timeZone.length > 80)))
    simulationProofInvalid();
  if (typeof value.runtime.timeZone === "string") {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value.runtime.timeZone }).format(0); }
    catch { simulationProofInvalid(); }
  }
  if ((Number(value.plannedMutations) > 0) !== (value.undo === "available_after_commit"))
    simulationProofInvalid();

  const proofCore = {
    v: 1 as const,
    target,
    purpose: value.purpose as AutomationPurpose,
    automationId: value.automationId,
    definitionRevision: Number(value.definitionRevision),
    definitionDigest: value.definitionDigest,
    schemaRevision: Number(value.schemaRevision),
    referenceFingerprint: value.referenceFingerprint,
    dataRevision: Number(value.dataRevision),
    evaluatedAt: value.evaluatedAt,
    expiresAt: value.expiresAt,
    snapshotDigest: value.snapshotDigest,
    matchedRecords: Number(value.matchedRecords),
    matchedScope: Object.freeze({
      kind: value.matchedScope.kind,
      recordIds: Object.freeze([...value.matchedScope.recordIds] as string[]),
    }),
    plannedMutations: Number(value.plannedMutations),
    plannedNotifications: Number(value.plannedNotifications),
    plannedEffects: Object.freeze(plannedEffects),
    sampleLabels: Object.freeze([...value.sampleLabels] as string[]),
    runtime: Object.freeze({
      mode: "local" as const,
      requiresAppOpen: true as const,
      timeZone: value.runtime.timeZone as string | null,
    }),
    undo: value.undo as AutomationSimulationProofV1["undo"],
  };
  if (value.id !== `asim_${automationSha256(proofCore).slice("sha256:".length)}`)
    invalid("automation simulation proof digest is invalid");
  return Object.freeze({ ...proofCore, id: value.id });
}

export function plannedEffectsFor(
  definition: AutomationDraftInputV2,
  matchedRecords: number,
): ClosedPlannedEffectV1[] {
  const multiplier = definition.trigger.kind === "schedule" ? 1 : matchedRecords;
  return definition.actions.map(action => {
    if (action.kind === "set_fields") return Object.freeze({
      kind: action.kind,
      count: multiplier,
      tableId: definition.trigger.kind === "schedule" ? undefined : definition.trigger.table.tableId,
      fieldIds: action.values.map(value => value.field.fieldId),
    });
    if (action.kind === "create_record" || action.kind === "create_related") return Object.freeze({
      kind: action.kind,
      count: multiplier,
      tableId: action.table.tableId,
      fieldIds: action.values.map(value => value.field.fieldId),
    });
    return Object.freeze({ kind: action.kind, count: multiplier });
  });
}

function recipeWritable(column: RegColumn): boolean {
  return !column.hidden && !column.inactive && !isVirtualColumn(column)
    && column.type !== "attachment" && column.type !== "json" && column.type !== "relation";
}

function recipeConditionField(column: RegColumn): boolean {
  return recipeWritable(column) && column.type !== "rich_text";
}

function activeRecipeTables(registry: Registry): RegTable[] {
  return [...registry.values()]
    .filter(table => !table.inactive && table.semantic && isTableId(table.semantic.tableId))
    .sort((left, right) => left.semantic!.tableId < right.semantic!.tableId ? -1 : 1);
}

function sortedFieldRefs(table: RegTable, predicate: (column: RegColumn) => boolean): StableFieldRef[] {
  return table.columns.filter(predicate)
    .filter(column => column.semantic && isFieldId(column.semantic.fieldId))
    .sort((left, right) => left.semantic!.fieldId < right.semantic!.fieldId ? -1 : 1)
    .map(column => currentFieldRef(table, column));
}

function singleCreateValueFields(table: RegTable, supplied?: RegColumn): StableFieldRef[] {
  const missingRequired = table.columns.filter(column => column.required && !column.hidden
    && !column.inactive && !isVirtualColumn(column) && column !== supplied);
  if (missingRequired.length > 1 || missingRequired.some(column => !recipeWritable(column))) return [];
  const writableFields = sortedFieldRefs(table, recipeWritable);
  if (missingRequired.length === 0) return writableFields;
  const requiredId = missingRequired[0]!.semantic?.fieldId;
  return requiredId ? writableFields.filter(field => field.fieldId === requiredId) : [];
}

export function automationRecipeCatalog(registry: Registry): AutomationRecipeCardV1[] {
  const tables = activeRecipeTables(registry);
  const overdueOptions: AutomationRecipeOptionV1[] = [];
  const weeklyOptions: AutomationRecipeOptionV1[] = [];
  const followUpOptions: AutomationRecipeOptionV1[] = [];
  for (const table of tables) {
    const dateFields = sortedFieldRefs(table, column =>
      !column.hidden && !column.inactive && column.type === "date");
    const conditionFields = sortedFieldRefs(table, recipeConditionField);
    if (dateFields.length > 0 && conditionFields.length > 0) overdueOptions.push(Object.freeze({
      kind: "overdue_invoice_reminder",
      source: currentTableRef(table),
      dateFields: Object.freeze(dateFields),
      conditionFields: Object.freeze(conditionFields),
    }));
    const writableFields = singleCreateValueFields(table);
    if (writableFields.length > 0) weeklyOptions.push(Object.freeze({
      kind: "weekly_checklist",
      target: currentTableRef(table),
      writableFields: Object.freeze(writableFields),
    }));
    for (const relation of table.columns.filter(column => !column.hidden && !column.inactive
      && column.type === "relation" && column.relation)) {
      const source = registry.get(relation.relation!.target_table);
      const relatedWritableFields = singleCreateValueFields(table, relation);
      if (!source || source.inactive || !relation.semantic || !isFieldId(relation.semantic.fieldId)
          || relatedWritableFields.length === 0) continue;
      followUpOptions.push(Object.freeze({
        kind: "new_customer_follow_up",
        source: currentTableRef(source),
        target: currentTableRef(table),
        relationField: currentFieldRef(table, relation),
        writableFields: Object.freeze(relatedWritableFields),
      }));
    }
  }
  const runtimeFact = "Runs on this device while Clay is open." as const;
  const cards: AutomationRecipeCardV1[] = [
    {
      v: 1,
      id: "overdue_invoice_reminder",
      version: 1,
      title: "Remind me about overdue invoices",
      result: "Shows a local reminder when a chosen date is reached and the chosen status matches.",
      requiredMappings: Object.freeze(["records", "date", "open status"]),
      runtimeFact,
      undoFact: "Reminders can be dismissed; this recipe does not change records.",
      options: Object.freeze(overdueOptions),
    },
    {
      v: 1,
      id: "weekly_checklist",
      version: 1,
      title: "Create next week’s checklist",
      result: "Creates one local checklist item at the chosen weekly time.",
      requiredMappings: Object.freeze(["destination", "title", "day and time"]),
      runtimeFact,
      undoFact: "Created records are grouped in one undoable run.",
      options: Object.freeze(weeklyOptions),
    },
    {
      v: 1,
      id: "new_customer_follow_up",
      version: 1,
      title: "Create a follow-up after a customer is added",
      result: "Creates a related follow-up when a record is added.",
      requiredMappings: Object.freeze(["new records", "related destination", "title"]),
      runtimeFact,
      undoFact: "Created records are grouped in one undoable run.",
      options: Object.freeze(followUpOptions),
    },
  ];
  return cards.filter(card => card.options.length > 0).map(card => Object.freeze(card));
}

function recipeTable(registry: Registry, tableId: TableId): RegTable {
  if (!isTableId(tableId)) invalid("recipe table ID is invalid");
  const table = activeRecipeTables(registry).find(candidate => candidate.semantic!.tableId === tableId);
  if (!table) invalid("recipe table ID is unavailable");
  return table;
}

function recipeField(
  registry: Registry,
  table: RegTable,
  fieldId: FieldId,
  predicate: (column: RegColumn) => boolean,
): RegColumn {
  if (!isFieldId(fieldId)) invalid("recipe field ID is invalid");
  const column = table.columns.find(candidate => candidate.semantic?.fieldId === fieldId);
  if (!column || !predicate(column)) invalid("recipe field ID is unavailable or incompatible");
  return column;
}

export function compileAutomationRecipeDraft(
  registry: Registry,
  request: AutomationRecipeDraftRequestV1,
): AutomationDraftInputV2 {
  if (!plainRecord(request) || request.v !== 1 || request.recipeVersion !== 1
      || !plainRecord(request.mapping)) invalid("automation recipe mapping is invalid");
  if (request.recipeId === "overdue_invoice_reminder") {
    const source = recipeTable(registry, request.mapping.sourceTableId);
    const date = recipeField(registry, source, request.mapping.dateFieldId,
      column => !column.hidden && !column.inactive && column.type === "date");
    const condition = recipeField(registry, source, request.mapping.conditionFieldId,
      recipeConditionField);
    return resolveAutomationDraftV2(registry, {
      v: 2,
      name: "Remind me about overdue invoices",
      recipe: { id: request.recipeId, version: 1 },
      trigger: {
        kind: "date_due",
        table: currentTableRef(source),
        dateField: currentFieldRef(source, date),
        daysBefore: request.mapping.daysBefore,
        conditions: [{
          field: currentFieldRef(source, condition),
          op: "eq",
          value: request.mapping.conditionValue,
        }],
      },
      actions: [{
        kind: "notify",
        title: "Invoice needs attention",
        body: "An invoice reached its chosen due date.",
      }],
      runtime: { mode: "local" },
    }).stored;
  }
  if (request.recipeId === "weekly_checklist") {
    const target = recipeTable(registry, request.mapping.targetTableId);
    const title = recipeField(registry, target, request.mapping.titleFieldId, recipeWritable);
    return resolveAutomationDraftV2(registry, {
      v: 2,
      name: "Create next week’s checklist",
      recipe: { id: request.recipeId, version: 1 },
      trigger: {
        kind: "schedule",
        cadence: "weekly",
        weekday: request.mapping.weekday,
        localTime: request.mapping.localTime,
      },
      actions: [{
        kind: "create_record",
        table: currentTableRef(target),
        values: [{
          field: currentFieldRef(target, title),
          value: { source: "literal", value: request.mapping.title },
        }],
      }],
      runtime: {
        mode: "local",
        timeZone: request.mapping.timeZone,
        missedPolicy: "skip",
      },
    }).stored;
  }
  if (request.recipeId === "new_customer_follow_up") {
    const source = recipeTable(registry, request.mapping.sourceTableId);
    const target = recipeTable(registry, request.mapping.targetTableId);
    const relation = recipeField(registry, target, request.mapping.relationFieldId,
      column => !column.hidden && !column.inactive && column.type === "relation"
        && column.relation?.target_table === source.name);
    const title = recipeField(registry, target, request.mapping.titleFieldId, recipeWritable);
    return resolveAutomationDraftV2(registry, {
      v: 2,
      name: "Create a follow-up after a customer is added",
      recipe: { id: request.recipeId, version: 1 },
      trigger: {
        kind: "record_created",
        table: currentTableRef(source),
        conditions: [],
      },
      actions: [{
        kind: "create_related",
        table: currentTableRef(target),
        relationField: currentFieldRef(target, relation),
        values: [{
          field: currentFieldRef(target, title),
          value: { source: "literal", value: request.mapping.title },
        }],
      }],
      runtime: { mode: "local" },
    }).stored;
  }
  return invalid("automation recipe is unsupported");
}
