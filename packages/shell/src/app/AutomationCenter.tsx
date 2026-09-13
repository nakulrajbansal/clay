import { useEffect, useMemo, useRef, useState } from "react";
import type { AutomationCommandPayloadV1, AutomationWorkspaceV1, TargetEvidenceV1 } from "@clay/schema/catalog";
import { beginPresentationIntent, readPresentationIntent, finishPresentationIntent, cancelPresentationIntent, type PresentationIntent } from "./presentation-intent";
import { clearAutomationWorkspace, editableAutomation, executeAutomationIntent, readAutomationWorkspace, writeAutomationWorkspace } from "./automation-presentation";
import type {
  AutomationDefinitionAny, AutomationDefinitionV2, AutomationDraftInputV2,
  AutomationLegacyDefinitionV1,
  AutomationRecipeCardV1, AutomationRecipeDraftRequestV1,
  AutomationRun, AutomationRuntimeOverviewV1, AutomationRuntimeStatusV1,
  AutomationSimulationProofV1,
  ClayNotification, RegColumn, RegTable, SemanticSchemaTraceV1,
  StableFieldRef, StableTableRef,
} from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { ModalDialog } from "./ModalDialog";
import "./Operations.css";

type TriggerKind = "record_created" | "record_updated" | "record_matches"
  | "date_due" | "schedule" | "manual";
type ActionKind = "notify" | "set_fields" | "create_related" | "create_record";
type Draft = {
  name: string; table: string; trigger: TriggerKind;
  conditionField: string; conditionValue: string; dateField: string; daysBefore: string;
  cadence: "daily" | "weekly"; localTime: string; weekday: string;
  action: ActionKind; actionField: string; actionValue: string;
  targetTable: string; relationField: string; targetField: string;
  noticeTitle: string; noticeBody: string;
  timeZone: string;
};

const DEFAULT_RUNTIME_STATUS: Omit<AutomationRuntimeStatusV1, "sessionActive" | "headline" | "detail"> & {
  sessionActive: boolean; headline: string; detail: string;
} = {
  v: 1,
  engine: "local_worker_session",
  sessionActive: false,
  backgroundExecution: false,
  offDeviceExecution: false,
  modelAccess: false,
  networkAccess: false,
  headline: "Checking local automation runtime…",
  detail: "Runtime availability has not been read. No background or off-device execution is promised.",
  enabledDefinitions: 0,
  disabledDefinitions: 0,
  needsRepairDefinitions: 0,
};
const DEFAULT_RUNTIME_OVERVIEW: AutomationRuntimeOverviewV1 = { v: 1, rules: [], runs: [] };

const humanize = (value: string): string => value.replace(/_/g, " ")
  .replace(/^./, character => character.toUpperCase());
const derived = (column: RegColumn): boolean =>
  column.type === "computed" || column.type === "lookup" || column.type === "rollup";
const writable = (table?: RegTable): RegColumn[] => (table?.columns ?? []).filter(column =>
  !column.hidden && !column.inactive && !derived(column)
    && column.type !== "attachment" && column.type !== "json" && column.type !== "relation");
const isV2 = (rule: AutomationDefinitionAny): rule is AutomationDefinitionV2 =>
  rule.v === 2 && !rule.needsRepair;

function scalar(column: RegColumn | undefined, value: string): string | number | boolean | null {
  if (value === "") return null;
  if (column?.type === "number" || column?.type === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Enter a finite numeric automation value");
    return number;
  }
  if (column?.type === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("Choose Yes or No for the automation value");
    return value === "true";
  }
  return value;
}

function defaultDraft(tables: RegTable[]): Draft {
  const table = tables[0];
  const fields = writable(table);
  const date = table?.columns.find(column => column.type === "date");
  const target = tables[1] ?? table;
  return {
    name: "", table: table?.name ?? "", trigger: "record_matches",
    conditionField: fields[0]?.name ?? "", conditionValue: "",
    dateField: date?.name ?? "", daysBefore: "1", cadence: "daily",
    localTime: "09:00", weekday: "1", action: "notify",
    actionField: fields[0]?.name ?? "", actionValue: "",
    targetTable: target?.name ?? "", relationField: "", targetField: writable(target)[0]?.name ?? "",
    noticeTitle: "Reminder", noticeBody: "A record needs your attention.",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function recurringRecordDraft(tables: RegTable[]): Draft {
  const base = defaultDraft(tables);
  const target = tables[0];
  return {
    ...base,
    name: target ? `Create recurring ${humanize(target.name)}` : "Create recurring record",
    trigger: "schedule",
    action: "create_record",
    targetTable: target?.name ?? "",
    targetField: writable(target)[0]?.name ?? "",
  };
}

function legacyValueText(value: { source: string; value?: unknown }): string | null {
  if (value.source !== "literal") return null;
  if (value.value === null || value.value === undefined) return "";
  return String(value.value);
}

function legacyRepairDraft(rule: AutomationLegacyDefinitionV1, tables: RegTable[]): Draft | null {
  const next = defaultDraft(tables);
  const trigger = rule.trigger;
  if (trigger.kind === "schedule") {
    next.trigger = "schedule";
    next.cadence = trigger.cadence;
    next.localTime = trigger.localTime;
    next.weekday = String(trigger.weekday ?? 1);
  } else {
    if (!tables.some(table => table.name === trigger.table)) return null;
    next.trigger = trigger.kind;
    next.table = trigger.table;
    const conditions = trigger.conditions.filter(condition => ![
      "id", "created_at", "updated_at", "deleted_at",
    ].includes(condition.field));
    if (conditions.length > 1 || conditions.some(condition => condition.op !== "eq")) return null;
    const condition = conditions[0];
    next.conditionField = condition?.field ?? "";
    next.conditionValue = condition?.value === null || condition?.value === undefined
      ? "" : String(condition.value);
    if (trigger.kind === "date_due") {
      next.dateField = trigger.dateField;
      next.daysBefore = String(trigger.daysBefore);
    }
  }
  if (rule.actions.length !== 1) return null;
  const action = rule.actions[0]!;
  next.name = rule.name;
  next.action = action.kind;
  if (action.kind === "notify") {
    next.noticeTitle = action.title;
    next.noticeBody = action.body;
    return next;
  }
  const entries = Object.entries(action.values);
  if (entries.length !== 1) return null;
  const [field, value] = entries[0]!;
  const literal = legacyValueText(value);
  if (literal === null) return null;
  next.actionValue = literal;
  if (action.kind === "set_fields") {
    next.actionField = field;
    return next;
  }
  next.targetTable = action.table;
  next.targetField = field;
  if (action.kind === "create_related")
    next.relationField = `${action.table}.${action.relationField}`;
  return next;
}

function draftSentence(draft: Draft): string {
  let when: string;
  if (draft.trigger === "manual") when = `I press Run in ${draft.table}`;
  else if (draft.trigger === "schedule") when = draft.cadence === "daily"
    ? `it is ${draft.localTime} each day`
    : `it is ${draft.localTime} on ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(draft.weekday)] ?? "the chosen day"}`;
  else if (draft.trigger === "record_created") when = `a record is created in ${draft.table}`;
  else if (draft.trigger === "record_updated") when = `a record is updated in ${draft.table}`;
  else if (draft.trigger === "date_due") when = `${draft.table}.${draft.dateField} reaches ${draft.daysBefore} days before due`;
  else when = `a record in ${draft.table} newly matches${draft.conditionValue
    ? ` ${draft.conditionField} = ${draft.conditionValue}` : ""}`;

  let then: string;
  if (draft.action === "notify") then = `show a reminder named “${draft.noticeTitle || "Reminder"}”`;
  else if (draft.action === "set_fields")
    then = `set ${draft.actionField} to ${draft.actionValue || "the chosen value"}`;
  else if (draft.action === "create_related")
    then = `create a related record in ${draft.relationField.split(".")[0] || "the chosen table"}`;
  else then = `create a record in ${draft.targetTable}`;
  return `When ${when}, then ${then} while Clay is open.`;
}

function RecipeSetup(props: {
  recipe: AutomationRecipeCardV1;
  busy: boolean;
  mutationsAvailable: boolean;
  fields: Record<string, string>;
  onField: (name: string, value: string) => void;
  onCancel: () => void;
  onSave: (request: AutomationRecipeDraftRequestV1) => Promise<void>;
}): React.JSX.Element {
  const field = (name: string, fallback = ""): [string, (value: string) => void] => [props.fields[name] ?? fallback, value => props.onField(name, value)];
  const [optionValue, setOptionValue] = field("optionIndex", "0"); const optionIndex = Number(optionValue);
  const setOptionIndex = (value: number) => { setOptionValue(String(value)); setDateFieldId(""); setConditionFieldId(""); setTitleFieldId(""); };
  const [dateFieldId, setDateFieldId] = field("dateFieldId");
  const [conditionFieldId, setConditionFieldId] = field("conditionFieldId");
  const [conditionValue, setConditionValue] = field("conditionValue");
  const [daysBefore, setDaysBefore] = field("daysBefore", "0");
  const [titleFieldId, setTitleFieldId] = field("titleFieldId");
  const [title, setTitle] = field("title");
  const [weekday, setWeekday] = field("weekday", "1");
  const [localTime, setLocalTime] = field("localTime", "09:00");
  const [timeZone, setTimeZone] = field("timeZone", "UTC");
  const optionKey = (option: AutomationRecipeCardV1["options"][number]): string => JSON.stringify([option.kind,
    "source" in option ? option.source.tableId : null, "target" in option ? option.target.tableId : null,
    "relationField" in option ? option.relationField.fieldId : null]);
  const selectedKey = props.fields.optionKey;
  const option = selectedKey ? props.recipe.options.find(candidate => optionKey(candidate) === selectedKey)
    : props.recipe.options[Math.min(optionIndex, props.recipe.options.length - 1)];

  useEffect(() => {
    if (!option) return;
    if (!selectedKey) props.onField("optionKey", optionKey(option));
    if (option.kind === "overdue_invoice_reminder") {
      if (!dateFieldId) setDateFieldId(option.dateFields[0]?.fieldId ?? "");
      if (!conditionFieldId) setConditionFieldId(option.conditionFields[0]?.fieldId ?? "");
    } else {
      if (!titleFieldId) setTitleFieldId(option.writableFields[0]?.fieldId ?? "");
    }
  }, [option, dateFieldId, conditionFieldId, titleFieldId]);

  const save = async (): Promise<void> => {
    if (!option) return;
    if (option.kind === "overdue_invoice_reminder") {
      await props.onSave({
        v: 1, recipeId: option.kind, recipeVersion: 1,
        mapping: {
          sourceTableId: option.source.tableId,
          dateFieldId: dateFieldId as typeof option.dateFields[number]["fieldId"],
          conditionFieldId: conditionFieldId as typeof option.conditionFields[number]["fieldId"],
          conditionValue,
          daysBefore: Number(daysBefore),
          timeZone,
        },
      });
    } else if (option.kind === "weekly_checklist") {
      await props.onSave({
        v: 1, recipeId: option.kind, recipeVersion: 1,
        mapping: {
          targetTableId: option.target.tableId,
          titleFieldId: titleFieldId as typeof option.writableFields[number]["fieldId"],
          title,
          weekday: Number(weekday),
          localTime,
          timeZone,
        },
      });
    } else {
      await props.onSave({
        v: 1, recipeId: option.kind, recipeVersion: 1,
        mapping: {
          sourceTableId: option.source.tableId,
          targetTableId: option.target.tableId,
          relationFieldId: option.relationField.fieldId,
          titleFieldId: titleFieldId as typeof option.writableFields[number]["fieldId"],
          title,
          timeZone,
        },
      });
    }
  };

  const canSave = option?.kind === "overdue_invoice_reminder"
    ? Boolean(dateFieldId && conditionFieldId && conditionValue.trim())
    : Boolean(titleFieldId && title.trim());
  return <section className="automation-recipe-setup" aria-labelledby="recipe-setup-title">
    <label>Rule timezone<input value={timeZone} disabled={props.busy} onChange={event => setTimeZone(event.target.value)} /></label>
    <div className="automation-builder-title">
      <button className="link" onClick={props.onCancel}>← Recipes</button>
      <div><strong id="recipe-setup-title">{props.recipe.title}</strong>
        <span>This first saves a disabled draft. Nothing runs yet.</span></div>
    </div>
    <label>Use with<select value={option ? props.recipe.options.indexOf(option) : ""} disabled={props.busy}
      onChange={event => { const next = props.recipe.options[Number(event.target.value)]; if (next) props.onField("optionKey", optionKey(next)); setOptionIndex(Number(event.target.value)); }}>
      {!option ? <option value="">The original semantic source is unavailable</option> : null}
      {props.recipe.options.map((candidate, index) => <option value={index} key={`${candidate.kind}-${index}`}>
        {candidate.kind === "weekly_checklist" ? candidate.target.lastKnownName
          : candidate.kind === "overdue_invoice_reminder" ? candidate.source.lastKnownName
            : `${candidate.source.lastKnownName} → ${candidate.target.lastKnownName}`}
      </option>)}
    </select></label>
    {option?.kind === "overdue_invoice_reminder" ? <div className="automation-inline">
      <label>Date field<select value={dateFieldId} onChange={event => setDateFieldId(event.target.value)}>
        {option.dateFields.map(field => <option key={field.fieldId} value={field.fieldId}>{field.lastKnownName}</option>)}
      </select></label>
      <label>Open/paid field<select value={conditionFieldId} onChange={event => setConditionFieldId(event.target.value)}>
        {option.conditionFields.map(field => <option key={field.fieldId} value={field.fieldId}>{field.lastKnownName}</option>)}
      </select></label>
      <label>Value that still needs attention<input value={conditionValue}
        onChange={event => setConditionValue(event.target.value)} /></label>
      <label>Days before<input type="number" min="-365" max="365" value={daysBefore}
        onChange={event => setDaysBefore(event.target.value)} /></label>
    </div> : option ? <div className="automation-inline">
      <label>Title field<select value={titleFieldId} onChange={event => setTitleFieldId(event.target.value)}>
        {option.writableFields.map(field => <option key={field.fieldId} value={field.fieldId}>{field.lastKnownName}</option>)}
      </select></label>
      <label>Text<input value={title} onChange={event => setTitle(event.target.value)}
        placeholder={option.kind === "weekly_checklist" ? "Review this week" : "Prepare follow-up"} /></label>
      {option.kind === "weekly_checklist" ? <><label>Day<select value={weekday}
        onChange={event => setWeekday(event.target.value)}>
        {[[1,"Monday"],[2,"Tuesday"],[3,"Wednesday"],[4,"Thursday"],[5,"Friday"],[6,"Saturday"],[0,"Sunday"]]
          .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label><label>At<input type="time" value={localTime}
        onChange={event => setLocalTime(event.target.value)} /></label></> : null}
    </div> : null}
    <div className="automation-recipe-facts">
      <span>{props.recipe.runtimeFact}</span><span>{props.recipe.undoFact}</span>
    </div>
    <footer className="automation-builder-actions"><button onClick={props.onCancel}>Cancel</button>
      <button className="primary" disabled={props.busy || !props.mutationsAvailable || !canSave} onClick={() => void save()}>
        {props.busy ? "Saving…" : "Save disabled draft"}</button></footer>
  </section>;
}

export function AutomationCenter(props: {
  worker: WorkerClient;
  appInstanceId?: string | null;
  tables: RegTable[];
  notifications: ClayNotification[];
  initialRecipe?: "recurring_record";
  initialAutomationId?: string;
  mutationsAvailable?: boolean;
  schedulerWaitReason?: string | null;
  onNotifications: (notifications: ClayNotification[]) => void;
  onClose: () => void;
  onOpenRecord: (table: string, id: string) => void;
  onWrite: (table: string) => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onConfirm?: (message: string) => Promise<boolean>;
}): React.JSX.Element {
  const [reviewed, setReviewed] = useState<Awaited<ReturnType<WorkerClient["automationPresentation"]>> | null>(null);
  const [pending, setPending] = useState<PresentationIntent | null>(null);
  const pendingRef = useRef<PresentationIntent | null>(null);
  const workspaceRef = useRef<AutomationWorkspaceV1 | null>(null);
  const [workspace, setWorkspace] = useState<AutomationWorkspaceV1 | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const mutationsAvailable = props.mutationsAvailable !== false && reviewed?.availability.available === true && !pending && !recoveryError;
  const [tab, setTab] = useState<"rules" | "inbox" | "history">("rules");
  const [rules, setRules] = useState<AutomationDefinitionAny[]>([]);
  const [recipes, setRecipes] = useState<AutomationRecipeCardV1[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState(DEFAULT_RUNTIME_STATUS);
  const [runtimeOverview, setRuntimeOverview] = useState(DEFAULT_RUNTIME_OVERVIEW);
  const [trace, setTrace] = useState<SemanticSchemaTraceV1 | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [draft, setDraftState] = useState<Draft>(() => props.initialRecipe === "recurring_record"
    ? recurringRecordDraft(props.tables) : defaultDraft(props.tables));
  const [building, setBuilding] = useState(
    props.initialRecipe === "recurring_record" && mutationsAvailable,
  );
  const [repairing, setRepairing] = useState<{ id: string; revision: number } | null>(null);
  const [recipeSetup, setRecipeSetup] = useState<AutomationRecipeCardV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<AutomationSimulationProofV1 | null>(null);
  const [simulatedRule, setSimulatedRule] = useState<AutomationDefinitionV2 | null>(null);
  const [simulatedDraft, setSimulatedDraft] = useState<string | null>(null);
  const [pendingEnable, setPendingEnable] = useState<{
    rule: AutomationDefinitionV2; simulation: AutomationSimulationProofV1;
  } | null>(null);
  const [pendingRun, setPendingRun] = useState<{
    rule: AutomationDefinitionV2; simulation: AutomationSimulationProofV1;
  } | null>(null);
  const persistWorkspace = (next: AutomationWorkspaceV1): void => {
    writeAutomationWorkspace(sessionStorage, next); workspaceRef.current = next; setWorkspace(next);
  };
  const setDraft = (update: Draft | ((value: Draft) => Draft)): void => {
    try {
      const next = typeof update === "function" ? update(draft) : update;
      if (workspaceRef.current) persistWorkspace({ ...workspaceRef.current, fields: { ...next } });
      setDraftState(next); setSimulation(null); setSimulatedRule(null); setSimulatedDraft(null);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };
  const beginWorkspace = (kind: AutomationWorkspaceV1["kind"], fields: Record<string, string>,
    definition: AutomationDraftInputV2 | null = null, expectedRevision: number | null = null,
    recipeId: AutomationWorkspaceV1["recipeId"] = null): void => {
    if (!reviewed || pendingRef.current || workspaceRef.current) throw new Error("Resume or discard the retained draft first");
    persistWorkspace({ schema: 1, draftId: props.worker.createMutationContext().requestId, authorityTarget: reviewed.authorityTarget,
      kind, fields, definition: definition ? JSON.parse(JSON.stringify(definition)) : null, expectedRevision, recipeId });
  };
  const finishCommand = (): void => {
    const intent = pendingRef.current; if (!intent) return;
    finishPresentationIntent(sessionStorage, intent.appInstanceId, intent.slot, intent.requestId);
    pendingRef.current = null; setPending(null);
  };
  const runCommand = async <T,>(route: AutomationCommandPayloadV1["command"]["route"], payload: unknown,
    source: TargetEvidenceV1 | undefined = reviewed?.authorityTarget): Promise<T> => {
    if (!source || (props.appInstanceId && props.appInstanceId !== source.appInstanceId)) throw new Error("Original automation source is unavailable");
    const intent = beginPresentationIntent(sessionStorage, source.appInstanceId, "automation", "automation.command",
      { authorityTarget: source, command: { route, payload } }, () => props.worker.createMutationContext());
    pendingRef.current = intent; setPending(intent); setLastRequestId(intent.requestId);
    return executeAutomationIntent<T>(props.worker, intent);
  };
  const source = props.tables.find(table => table.name === draft.table);
  const sourceFields = writable(source);
  const dateFields = (source?.columns ?? []).filter(column => column.type === "date");
  const target = props.tables.find(table => table.name === draft.targetTable);
  const targetFields = writable(target);
  const relatedOptions = useMemo(() => props.tables.flatMap(table => table.columns
    .filter(column => column.type === "relation" && column.relation?.target_table === draft.table)
    .map(column => ({ table, column }))), [props.tables, draft.table]);
  const relatedTarget = relatedOptions.find(option =>
    `${option.table.name}.${option.column.name}` === draft.relationField)?.table;

  const valueEditor = (
    column: RegColumn | undefined, value: string, change: (value: string) => void,
  ): React.JSX.Element => column?.type === "enum" ? (
    <select value={value} onChange={event => change(event.target.value)}>
      <option value="">Choose…</option>{(column.values ?? []).map(option => <option key={option}>{option}</option>)}
    </select>
  ) : column?.type === "boolean" ? (
    <select value={value} onChange={event => change(event.target.value)}>
      <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
    </select>
  ) : <input type={column?.type === "date" ? "date"
      : column?.type === "number" || column?.type === "integer" ? "number" : "text"}
    value={value} onChange={event => change(event.target.value)} />;

  const refresh = async () => {
    const read = await props.worker.automationPresentation();
    if (props.appInstanceId && read.authorityTarget.appInstanceId !== props.appInstanceId) throw new Error("Automation view belongs to another app");
    setReviewed(read); setRules(read.rules); setRuns(read.runs); props.onNotifications(read.notifications);
    setRecipes(read.recipes); setRuntimeStatus(read.runtime); setRuntimeOverview(read.overview);
    setTrace(read.trace); setLoaded(true); return read;
  };
  useEffect(() => { void (async () => {
    const read = await refresh(); const app = read.authorityTarget.appInstanceId;
    const retry = readPresentationIntent(sessionStorage, app, "automation"); pendingRef.current = retry; setPending(retry);
    const saved = readAutomationWorkspace(sessionStorage, app);
    workspaceRef.current = saved; setWorkspace(saved);
    if (saved) {
      if (saved.kind === "custom" || saved.kind === "legacy") {
        setDraftState({ ...defaultDraft(props.tables), ...saved.fields } as Draft); setBuilding(true);
        if (saved.definition?.id) setRepairing({ id: String(saved.definition.id), revision: saved.expectedRevision ?? 0 });
      } else if (saved.kind === "edit") setBuilding(true);
      else setRecipeSetup(read.recipes.find(recipe => recipe.id === saved.recipeId) ?? null);
    } else if (props.initialRecipe === "recurring_record") {
      const fields = recurringRecordDraft(props.tables);
      const next: AutomationWorkspaceV1 = { schema: 1, draftId: props.worker.createMutationContext().requestId,
        authorityTarget: read.authorityTarget, kind: "custom", fields, definition: null, expectedRevision: null, recipeId: null };
      persistWorkspace(next); setDraftState(fields); setBuilding(true);
    }
  })().catch(error => {
    setLoaded(true);
    const message = error instanceof Error ? error.message : String(error); setRecoveryError(message); props.onError(message);
  });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stableTable = (name: string): StableTableRef => {
    const table = trace?.tables.find(candidate => candidate.name === name && candidate.state === "visible");
    if (!table) throw new Error(`The selected table “${name}” no longer has a stable identity.`);
    return { tableId: table.tableId, lastKnownName: table.name };
  };
  const stableField = (tableName: string, fieldName: string): StableFieldRef => {
    const table = stableTable(tableName);
    const field = trace?.fields.find(candidate => candidate.tableId === table.tableId
      && candidate.fieldName === fieldName && candidate.state === "visible");
    if (!field) throw new Error(`The selected field “${fieldName}” no longer has a stable identity.`);
    return { tableId: table.tableId, fieldId: field.fieldId, lastKnownName: field.fieldName };
  };

  const definition = (): AutomationDraftInputV2 => {
    if (workspaceRef.current?.kind === "edit") {
      const parsed = JSON.parse(workspaceRef.current.fields.document ?? "null");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.id !== workspaceRef.current.definition?.id
          || parsed.v !== 2 || !Array.isArray(parsed.actions) || !parsed.actions.length)
        throw new Error("Keep the original V2 rule identity and at least one explicit action");
      return parsed as AutomationDraftInputV2;
    }
    const conditionColumn = source?.columns.find(column => column.name === draft.conditionField);
    const conditions = draft.conditionField && draft.conditionValue !== ""
      ? [{ field: stableField(draft.table, draft.conditionField), op: "eq" as const,
          value: scalar(conditionColumn, draft.conditionValue) ?? "" }] : [];
    let trigger: AutomationDraftInputV2["trigger"];
    if (draft.trigger === "schedule") trigger = {
      kind: "schedule", cadence: draft.cadence, localTime: draft.localTime,
      ...(draft.cadence === "weekly" ? { weekday: Number(draft.weekday) } : {}),
    };
    else if (draft.trigger === "date_due") trigger = {
      kind: "date_due", table: stableTable(draft.table),
      dateField: stableField(draft.table, draft.dateField),
      daysBefore: Number(draft.daysBefore), conditions,
    };
    else trigger = { kind: draft.trigger, table: stableTable(draft.table), conditions };

    let action: AutomationDraftInputV2["actions"][number];
    if (draft.action === "notify") action = {
      kind: "notify", title: draft.noticeTitle, body: draft.noticeBody,
    };
    else if (draft.action === "set_fields") {
      const field = source?.columns.find(column => column.name === draft.actionField);
      action = { kind: "set_fields", values: [{
        field: stableField(draft.table, draft.actionField),
        value: { source: "literal", value: scalar(field, draft.actionValue) },
      }] };
    } else if (draft.action === "create_related") {
      const option = relatedOptions.find(candidate =>
        `${candidate.table.name}.${candidate.column.name}` === draft.relationField);
      if (!option) throw new Error("Choose a related table");
      const field = option.table.columns.find(column => column.name === draft.targetField);
      action = { kind: "create_related", table: stableTable(option.table.name),
        relationField: stableField(option.table.name, option.column.name), values: [{
          field: stableField(option.table.name, draft.targetField),
          value: { source: "literal", value: scalar(field, draft.actionValue) },
        }] };
    } else {
      const field = target?.columns.find(column => column.name === draft.targetField);
      action = { kind: "create_record", table: stableTable(draft.targetTable), values: [{
        field: stableField(draft.targetTable, draft.targetField),
        value: { source: "literal", value: scalar(field, draft.actionValue) },
      }] };
    }
    const timeZone = draft.timeZone;
    return { v: 2, ...(repairing ? { id: repairing.id } : {}), name: draft.name, trigger, actions: [action],
      runtime: { mode: "local", timeZone, missedPolicy: "run_once_when_available" } };
  };

  const saveAndSimulate = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await runCommand<AutomationDefinitionV2>("saveAutomationDraft", { input: definition(),
        expectedRevision: workspaceRef.current?.expectedRevision ?? repairing?.revision ?? null }, workspaceRef.current?.authorityTarget);
      const nextSimulation = await props.worker.simulateAutomation(
        saved.id, saved.definitionRevision, "enable");
      setSimulation(nextSimulation); setSimulatedRule(saved);
      setSimulatedDraft(JSON.stringify(draft));
      const read = await refresh(); finishCommand();
      const current = workspaceRef.current;
      if (current) persistWorkspace({ ...current, authorityTarget: read.authorityTarget,
        definition: JSON.parse(JSON.stringify(editableAutomation(saved))), expectedRevision: saved.definitionRevision });
      setRepairing({ id: saved.id, revision: saved.definitionRevision });
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const saveRecipe = async (request: AutomationRecipeDraftRequestV1): Promise<void> => {
    setBusy(true);
    try {
      const saved = await runCommand<AutomationDefinitionV2>("saveAutomationRecipeDraft", { request }, workspaceRef.current?.authorityTarget);
      props.onInfo(`Saved “${saved.name}” as a disabled draft. Review and simulate it before enabling.`);
      setRecipeSetup(null);
      await refresh();
      finishCommand();
      if (workspaceRef.current) clearAutomationWorkspace(sessionStorage, workspaceRef.current);
      workspaceRef.current = null; setWorkspace(null);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const enableSimulated = async (): Promise<void> => {
    if (!simulatedRule || !simulation) return;
    if (simulatedDraft !== JSON.stringify(draft)) {
      setSimulation(null); setSimulatedRule(null); setSimulatedDraft(null);
      props.onError("This rule changed after simulation. Simulate the current draft again before enabling.");
      return;
    }
    setBusy(true);
    try {
      await runCommand("enableAutomation", { id: simulatedRule.id, expectedRevision: simulatedRule.definitionRevision, simulation });
      props.onInfo(`Enabled “${simulatedRule.name}”. It runs on this device while Clay is open.`);
      setBuilding(false); setRepairing(null); setSimulation(null); setSimulatedRule(null); setSimulatedDraft(null);
      await refresh();
      finishCommand();
      if (workspaceRef.current) clearAutomationWorkspace(sessionStorage, workspaceRef.current);
      workspaceRef.current = null; setWorkspace(null); setDraftState(defaultDraft(props.tables));
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const toggle = async (rule: AutomationDefinitionAny): Promise<void> => {
    if (!isV2(rule)) {
      props.onError("This older rule is disabled and needs review. Rebuild it with stable fields before enabling.");
      return;
    }
    setBusy(true);
    try {
      if (!rule.enabled) {
        const preview = await props.worker.simulateAutomation(rule.id, rule.definitionRevision, "enable");
        setPendingEnable({ rule, simulation: preview });
        return;
      }
      await runCommand("pauseAutomation", { id: rule.id, expectedRevision: rule.definitionRevision });
      props.onInfo(`Paused “${rule.name}”.`);
      await refresh();
      finishCommand();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const confirmPendingEnable = async (): Promise<void> => {
    if (!pendingEnable) return;
    setBusy(true);
    try {
      await runCommand("enableAutomation", { id: pendingEnable.rule.id, expectedRevision: pendingEnable.rule.definitionRevision,
        simulation: pendingEnable.simulation });
      props.onInfo(`Enabled “${pendingEnable.rule.name}”. It runs on this device while Clay is open.`);
      setPendingEnable(null);
      await refresh();
      finishCommand();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const previewRun = async (rule: AutomationDefinitionAny): Promise<void> => {
    if (!isV2(rule)) {
      props.onError("This older rule needs review before it can run.");
      return;
    }
    setBusy(true);
    try {
      const preview = await props.worker.simulateAutomation(rule.id, rule.definitionRevision, "run_now");
      setPendingRun({ rule, simulation: preview });
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const confirmPendingRun = async (): Promise<void> => {
    if (!pendingRun) return;
    setBusy(true);
    try {
      const result = await runCommand<import("@clay/kernel").AutomationExecutionResultV1>("runAutomationNow", {
        id: pendingRun.rule.id, expectedRevision: pendingRun.rule.definitionRevision, simulation: pendingRun.simulation });
      if (result.kind === "committed") {
        const affected = new Set<string>();
        const trigger = pendingRun.rule.trigger;
        if (trigger.kind !== "schedule") affected.add(trigger.table.lastKnownName);
        for (const action of pendingRun.rule.actions)
          if (action.kind === "create_record" || action.kind === "create_related")
            affected.add(action.table.lastKnownName);
        for (const table of affected) props.onWrite(table);
        props.onInfo(`Ran “${pendingRun.rule.name}”. ${result.receipt.changed} record changes were committed.`);
      } else props.onInfo(`“${pendingRun.rule.name}” was already up to date. Nothing was written.`);
      setPendingRun(null);
      await refresh(); setTab("history"); finishCommand();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const undoRun = async (run: AutomationRun): Promise<void> => {
    setBusy(true);
    try {
      await runCommand("undoAutomationRun", { id: run.id });
      props.onInfo("Automation changes were undone.");
      await refresh();
      for (const table of props.tables) props.onWrite(table.name);
      finishCommand();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const setTable = (name: string): void => {
    const table = props.tables.find(candidate => candidate.name === name);
    const fields = writable(table);
    setDraft(current => ({ ...current, table: name,
      conditionField: fields[0]?.name ?? "", actionField: fields[0]?.name ?? "",
      dateField: table?.columns.find(column => column.type === "date")?.name ?? "",
      relationField: "",
    }));
    setSimulation(null); setSimulatedRule(null); setSimulatedDraft(null);
  };

  const recoverCommand = async (cancel: boolean): Promise<void> => {
    const intent = pendingRef.current; if (!intent || busy) return;
    setBusy(true);
    try {
      if (cancel) {
        if (!await cancelPresentationIntent(sessionStorage, props.worker, intent))
          throw new Error("This automation change is already recorded. Retry it to acknowledge the result.");
        pendingRef.current = null; setPending(null);
      } else {
        await executeAutomationIntent(props.worker, intent);
        await refresh(); for (const table of props.tables) props.onWrite(table.name);
        props.onInfo("The original automation result is recorded. The list shows the current state; no effect was repeated.");
        finishCommand();
        if (workspaceRef.current) clearAutomationWorkspace(sessionStorage, workspaceRef.current);
        workspaceRef.current = null; setWorkspace(null); setBuilding(false); setRecipeSetup(null); setRepairing(null);
      }
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const closeDraft = (): void => {
    try {
      if (workspaceRef.current) clearAutomationWorkspace(sessionStorage, workspaceRef.current);
      workspaceRef.current = null; setWorkspace(null); setBuilding(false); setRecipeSetup(null); setRepairing(null); setSimulation(null);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };
  const reviewDraftSource = async (): Promise<void> => {
    if (!workspaceRef.current || pendingRef.current) return;
    setBusy(true);
    try {
      const original = workspaceRef.current; const read = await refresh();
      if (original.authorityTarget.appInstanceId !== read.authorityTarget.appInstanceId
          || original.authorityTarget.activeGenerationId !== read.authorityTarget.activeGenerationId
          || original.authorityTarget.lineageEpoch !== read.authorityTarget.lineageEpoch)
        throw new Error("This draft belongs to a different original app or generation. It cannot be rebound.");
      persistWorkspace({ ...original, authorityTarget: read.authorityTarget });
      setSimulation(null); setSimulatedRule(null); setPendingEnable(null); setPendingRun(null);
      props.onInfo("Review every field against this source before saving. The old request was not reused.");
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const startCustom = (): void => {
    try { const next = defaultDraft(props.tables); beginWorkspace("custom", next);
      setRepairing(null); setDraftState(next); setBuilding(true);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };
  const editRule = (rule: AutomationDefinitionV2): void => {
    try {
      const input = editableAutomation(rule);
      beginWorkspace("edit", { document: JSON.stringify(input, null, 2) }, input, rule.definitionRevision);
      setRepairing(null); setBuilding(true); setSimulation(null);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };
  const updateDocument = (raw: string): void => {
    try { if (!workspaceRef.current) return;
      persistWorkspace({ ...workspaceRef.current, fields: { document: raw } }); setSimulation(null); setSimulatedRule(null);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };
  const documentField = (key: "name" | "timeZone"): string => {
    try { const value = JSON.parse(workspace?.fields.document ?? "{}"); return key === "name" ? String(value.name ?? "") : String(value.runtime?.timeZone ?? ""); }
    catch { return ""; }
  };
  const setDocumentField = (key: "name" | "timeZone", value: string): void => {
    try { const input = definition(); if (key === "name") input.name = value; else input.runtime.timeZone = value;
      updateDocument(JSON.stringify(input, null, 2));
    } catch { props.onError("Correct the full rule definition before editing its name or timezone."); }
  };
  const runDue = async (): Promise<void> => {
    setBusy(true);
    try {
      const results = await runCommand<AutomationRun[]>("runDueAutomations", {});
      await refresh(); for (const table of props.tables) props.onWrite(table.name);
      props.onInfo(`Checked due schedules on this device. ${results.length} run receipts returned.`); setTab("history"); finishCommand();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const markRead = async (id: string): Promise<void> => {
    setBusy(true);
    try { await runCommand("markNotificationRead", { id }); await refresh(); finishCommand(); }
    catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const deleteRule = async (rule: AutomationDefinitionAny): Promise<void> => {
    const source = reviewed?.authorityTarget; setBusy(true);
    try {
      if (!props.onConfirm || !await props.onConfirm(`Delete “${rule.name}”? Existing run history remains visible.`)) return;
      await runCommand("deleteAutomation", { id: rule.id }, source); await refresh(); finishCommand();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const v2Editor = <section className="automation-builder">
    <h3>Edit the complete V2 rule</h3>
    <p>All conditions and actions are retained. Saving pauses the rule as a disabled draft; inspect the simulation before enabling.</p>
    <label>Rule name<input disabled={busy || !!pending} value={documentField("name")} onChange={event => setDocumentField("name", event.target.value)} /></label>
    <label>Rule timezone<input disabled={busy || !!pending} value={documentField("timeZone")} onChange={event => setDocumentField("timeZone", event.target.value)} placeholder="America/New_York" /></label>
    <label>Full rule definition<textarea rows={20} disabled={busy || !!pending} spellCheck={false}
      value={workspace?.fields.document ?? ""} onChange={event => updateDocument(event.target.value)} /></label>
    <p>Structured data only. The worker validates every stable field, trigger, value, action and bound before committing.</p>
    {simulation ? <p>{simulation.matchedRecords} matches · {simulation.plannedMutations} changes · {simulation.plannedNotifications} notices. Local execution only.</p> : null}
    <button disabled={busy || !!pending} onClick={closeDraft}>Close draft</button>
    <button className="primary" disabled={busy || !mutationsAvailable} onClick={() => void (simulation ? enableSimulated() : saveAndSimulate())}>
      {simulation ? "Enable rule" : "Save and simulate"}</button>
  </section>;

  const customBuilder = <section className="automation-builder">
    <label>Rule timezone<input value={draft.timeZone} disabled={busy || !!pending}
      onChange={event => setDraft(current => ({ ...current, timeZone: event.target.value }))} placeholder="America/New_York" /></label>
    <div className="automation-builder-title"><button className="link"
      onClick={() => { setBuilding(false); setRepairing(null); setSimulation(null); }}>← Automations</button>
      <div><strong>{repairing ? "Repair this older rule in place" : props.initialRecipe === "recurring_record" ? "Create a recurring record" : "Build a custom local rule"}</strong>
        <span>{repairing
          ? "Review every sentence field. Saving replaces the older rule with a disabled stable-ID draft."
          : "Choose exact fields, save disabled, inspect a target-bound simulation, then enable."}</span></div></div>
    <div className="automation-sentence" aria-live="polite">
      <span>Rule sentence</span><strong>{draftSentence(draft)}</strong>
    </div>
    <div className="automation-step"><span className="automation-step-number">1</span><div>
      <label>Rule name<input autoFocus value={draft.name}
        onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
        placeholder="Create kickoff task for new deals" /></label>
    </div></div>
    <div className="automation-step"><span className="automation-step-number">2</span><div>
      <div className="automation-inline">
        <label>When<select value={draft.trigger}
          onChange={event => setDraft(current => ({ ...current, trigger: event.target.value as TriggerKind }))}>
          <option value="record_created">a record is created</option>
          <option value="record_updated">a record is updated</option>
          <option value="record_matches">a record matches</option>
          <option value="date_due">a date becomes due</option>
          <option value="schedule">on a schedule</option>
          <option value="manual">I press Run</option>
        </select></label>
        {draft.trigger !== "schedule" ? <label>In table<select value={draft.table}
          onChange={event => setTable(event.target.value)}>
          {props.tables.map(table => <option key={table.name}>{table.name}</option>)}
        </select></label> : null}
      </div>
      {draft.trigger === "schedule" ? <div className="automation-inline">
        <label>Cadence<select value={draft.cadence}
          onChange={event => setDraft(current => ({ ...current,
            cadence: event.target.value as "daily" | "weekly" }))}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option>
        </select></label>
        {draft.cadence === "weekly" ? <label>Day<select value={draft.weekday}
          onChange={event => setDraft(current => ({ ...current, weekday: event.target.value }))}>
          {[[1,"Monday"],[2,"Tuesday"],[3,"Wednesday"],[4,"Thursday"],[5,"Friday"],[6,"Saturday"],[0,"Sunday"]]
            .map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select></label> : null}
        <label>At<input type="time" value={draft.localTime}
          onChange={event => setDraft(current => ({ ...current, localTime: event.target.value }))} /></label>
      </div> : draft.trigger === "date_due" ? <div className="automation-inline">
        <label>Date field<select value={draft.dateField}
          onChange={event => setDraft(current => ({ ...current, dateField: event.target.value }))}>
          {dateFields.map(field => <option key={field.name}>{field.name}</option>)}
        </select></label><label>Days before<input type="number" min="-365" max="365"
          value={draft.daysBefore} onChange={event => setDraft(current => ({ ...current,
            daysBefore: event.target.value }))} /></label>
      </div> : null}
      {draft.trigger !== "schedule" && draft.trigger !== "record_created" ? (
        <div className="automation-inline"><label>Field<select value={draft.conditionField}
          onChange={event => setDraft(current => ({ ...current, conditionField: event.target.value }))}>
          {sourceFields.map(field => <option key={field.name}>{field.name}</option>)}
        </select></label><label>Equals{valueEditor(
          source?.columns.find(column => column.name === draft.conditionField),
          draft.conditionValue,
          value => setDraft(current => ({ ...current, conditionValue: value })),
        )}</label></div>
      ) : null}
    </div></div>
    <div className="automation-step"><span className="automation-step-number">3</span><div>
      <label>Then<select value={draft.action}
        onChange={event => setDraft(current => ({ ...current, action: event.target.value as ActionKind }))}>
        <option value="notify">show a reminder</option>
        {draft.trigger !== "schedule" ? <option value="set_fields">update the matching record</option> : null}
        {draft.trigger !== "schedule" && relatedOptions.length > 0
          ? <option value="create_related">create a related record</option> : null}
        <option value="create_record">create a record</option>
      </select></label>
      {draft.action === "notify" ? <div className="automation-inline">
        <label>Title<input value={draft.noticeTitle}
          onChange={event => setDraft(current => ({ ...current, noticeTitle: event.target.value }))} /></label>
        <label>Message<input value={draft.noticeBody}
          onChange={event => setDraft(current => ({ ...current, noticeBody: event.target.value }))} /></label>
      </div> : draft.action === "set_fields" ? <div className="automation-inline">
        <label>Field<select value={draft.actionField}
          onChange={event => setDraft(current => ({ ...current, actionField: event.target.value }))}>
          {sourceFields.map(field => <option key={field.name}>{field.name}</option>)}
        </select></label><label>New value{valueEditor(
          source?.columns.find(column => column.name === draft.actionField),
          draft.actionValue,
          value => setDraft(current => ({ ...current, actionValue: value })),
        )}</label>
      </div> : draft.action === "create_related" ? <div className="automation-inline">
        <label>Related table<select value={draft.relationField}
          onChange={event => {
            const option = relatedOptions.find(candidate =>
              `${candidate.table.name}.${candidate.column.name}` === event.target.value);
            setDraft(current => ({ ...current, relationField: event.target.value,
              targetField: writable(option?.table)[0]?.name ?? "" }));
          }}><option value="">Choose…</option>{relatedOptions.map(option => (
            <option key={`${option.table.name}.${option.column.name}`}
              value={`${option.table.name}.${option.column.name}`}>{option.table.name}</option>
          ))}</select></label><label>First value{valueEditor(
            relatedTarget?.columns.find(column => column.name === draft.targetField),
            draft.actionValue,
            value => setDraft(current => ({ ...current, actionValue: value })),
          )}</label>
      </div> : <div className="automation-inline">
        <label>Table<select value={draft.targetTable}
          onChange={event => {
            const next = props.tables.find(table => table.name === event.target.value);
            setDraft(current => ({ ...current, targetTable: event.target.value,
              targetField: writable(next)[0]?.name ?? "" }));
          }}>{props.tables.map(table => <option key={table.name}>{table.name}</option>)}</select></label>
        <label>Field<select value={draft.targetField}
          onChange={event => setDraft(current => ({ ...current, targetField: event.target.value }))}>
          {targetFields.map(field => <option key={field.name}>{field.name}</option>)}</select></label>
        <label>Value{valueEditor(
          target?.columns.find(column => column.name === draft.targetField),
          draft.actionValue,
          value => setDraft(current => ({ ...current, actionValue: value })),
        )}</label>
      </div>}
    </div></div>
    {simulation ? <div className="automation-simulation" aria-live="polite">
      <span>Target-bound simulation</span><strong>{simulation.matchedRecords} records match</strong>
      <p>{simulation.plannedMutations} data changes · {simulation.plannedNotifications} reminders</p>
      <small>Revision {simulation.target.stateRevision} · proof expires {simulation.expiresAt.slice(11, 16)}</small>
      {simulation.sampleLabels.length ? <small>{simulation.sampleLabels.join(" · ")}</small> : null}
    </div> : null}
    <footer className="automation-builder-actions"><button onClick={() => {
      setBuilding(false); setRepairing(null);
    }}>Cancel</button>
      {!simulation ? <button className="primary" disabled={busy || !mutationsAvailable || !draft.name.trim() || !trace}
        onClick={() => void saveAndSimulate()}>{busy ? "Simulating…"
          : repairing ? "Save repair and simulate" : "Save and simulate"}</button>
        : <button className="primary" disabled={busy || !mutationsAvailable} onClick={() => void enableSimulated()}>
          {busy ? "Enabling…" : "Enable rule"}</button>}</footer>
  </section>;

  return (
    <ModalDialog className="automation-center" backdropClassName="modal-backdrop automation-backdrop"
      ariaLabelledBy="automation-title" onClose={props.onClose}>
      <header className="automation-header">
        <div><span className="record-detail-kicker">Local workflows</span>
          <h2 id="automation-title">Automations</h2>
          <p>Start from a trusted recipe, inspect exact effects, then decide whether to enable it.</p></div>
        <button aria-label="Close automations" onClick={props.onClose}>✕</button>
      </header>
      <div className="automation-runtime-fact" role="status">
        <strong>{runtimeStatus.headline}</strong><span>{runtimeStatus.detail}</span>
        <small>No cloud runner · no model access · no network access</small>
        {lastRequestId ? <small data-automation-request-id={lastRequestId}>
          Last durable request: <code>{lastRequestId}</code>
        </small> : null}
      </div>
      <nav className="automation-tabs" aria-label="Automation sections">
        <button className={tab === "rules" ? "active" : ""} aria-pressed={tab === "rules"}
          onClick={() => setTab("rules")}>Rules <span>{rules.length}</span></button>
        <button className={tab === "inbox" ? "active" : ""} aria-pressed={tab === "inbox"}
          onClick={() => setTab("inbox")}>
          Inbox <span>{props.notifications.filter(notification => !notification.read).length}</span></button>
        <button className={tab === "history" ? "active" : ""} aria-pressed={tab === "history"}
          onClick={() => setTab("history")}>Run history <span>{runs.length}</span></button>
      </nav>

      {reviewed && !reviewed.availability.available ? <div className="automation-unavailable" role="status">
        <strong>Automation changes are unavailable.</strong>
        <span>This storage adapter lacks the required physical-transaction certificate. Draft preparation and readback are available; durable automation actions stay closed. No off-device runtime is implied.</span>
      </div> : null}
      {recoveryError ? <p role="alert">Automation recovery is unavailable: {recoveryError}. The retained state was kept.</p> : null}
      {props.schedulerWaitReason && props.schedulerWaitReason !== "physical_transaction_uncertified" ?
        <p role="status">Scheduled checks are waiting for a retained review, draft, or Undo to be reconciled. Nothing runs off-device.</p> : null}
      {pending ? <section className="automation-unavailable" role="status"><strong>An immutable automation request needs reconciliation.</strong>
        <small>Request {pending.requestId}</small>
        <button disabled={busy} onClick={() => void recoverCommand(false)}>Retry original automation change</button>
        <button disabled={busy} onClick={() => void recoverCommand(true)}>Cancel original automation change</button>
      </section> : null}
      {workspace ? <section className="automation-unavailable"><span>Draft retained on this tab across reload. Closing this window does not discard it.</span>
        <button disabled={busy || !!pending} onClick={() => { if (workspace.kind === "recipe") setRecipeSetup(recipes.find(recipe => recipe.id === workspace.recipeId) ?? null); else setBuilding(true); }}>Resume draft</button>
        <button disabled={busy || !!pending} onClick={closeDraft}>Discard retained draft</button>
        {JSON.stringify(workspace.authorityTarget) !== JSON.stringify(reviewed?.authorityTarget) ?
          <button disabled={busy || !!pending} onClick={() => void reviewDraftSource()}>Review current source for this draft</button> : null}
      </section> : null}

      <div className="automation-body">
        {tab === "rules" ? building ? workspace?.kind === "edit" ? v2Editor : customBuilder : recipeSetup ? (
          <RecipeSetup recipe={recipeSetup} busy={busy} mutationsAvailable={mutationsAvailable} fields={workspace?.fields ?? {}}
            onField={(name, value) => {
              try { if (workspaceRef.current) persistWorkspace({ ...workspaceRef.current, fields: { ...workspaceRef.current.fields, [name]: value } }); }
              catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
            }} onCancel={() => setRecipeSetup(null)}
            onSave={saveRecipe} />
        ) : <section className="automation-rule-list">
          <section className="automation-recipes" aria-labelledby="automation-recipes-title">
            <div className="automation-list-head"><div><strong id="automation-recipes-title">Start with a recipe</strong>
              <span>Only recipes your current tables can support are shown.</span></div></div>
            <div className="automation-recipe-grid">
              {recipes.map(recipe => <article className="automation-recipe" key={recipe.id}>
                <span className="automation-recipe-badge">Verified recipe · v{recipe.version}</span>
                <h3>{recipe.title}</h3><p>{recipe.result}</p>
                <ul>{recipe.requiredMappings.map(mapping => <li key={mapping}>{mapping}</li>)}</ul>
                <small>{recipe.runtimeFact}</small>
                <button className="primary" disabled={!reviewed || !!workspace || !!pending || !!recoveryError} onClick={() => {
                  try { beginWorkspace("recipe", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }, null, null, recipe.id); setRecipeSetup(recipe); }
                  catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
                }}>Set up recipe</button>
              </article>)}
            </div>
          </section>
          <div className="automation-custom-entry">
            <div><strong>Need something different?</strong>
              <span>The custom builder uses exact table and field identities.</span></div>
            <button disabled={!reviewed || !!workspace || !!pending || !!recoveryError} onClick={startCustom}>
              Build a custom rule</button>
          </div>
          <div className="automation-list-head"><div><strong>Your rules</strong>
            <span>{runtimeStatus.enabledDefinitions} enabled · {runtimeStatus.needsRepairDefinitions} need review</span></div></div>
          <button disabled={busy || !mutationsAvailable} onClick={() => void runDue()}>Run due schedules now</button>
          {pendingEnable ? <div className="automation-enable-preview" aria-live="polite">
            <div><span>Target-bound simulation</span><strong>{pendingEnable.rule.name}</strong>
              <p>{pendingEnable.simulation.matchedRecords} match · {pendingEnable.simulation.plannedMutations} data changes · {pendingEnable.simulation.plannedNotifications} reminders</p>
              <small>Bound to target revision {pendingEnable.simulation.target.stateRevision}</small></div>
            <button onClick={() => setPendingEnable(null)}>Cancel</button>
            <button className="primary" disabled={busy || !mutationsAvailable} onClick={() => void confirmPendingEnable()}>Enable rule</button>
          </div> : null}
          {pendingRun ? <div className="automation-enable-preview" aria-live="polite">
            <div><span>Run preview</span><strong>{pendingRun.rule.name}</strong>
              <p>{pendingRun.simulation.matchedRecords} match · {pendingRun.simulation.plannedMutations} data changes · {pendingRun.simulation.plannedNotifications} reminders</p>
              <small>{pendingRun.simulation.undo === "available_after_commit" ? "This run can be undone after commit." : "No data changes are planned."}</small></div>
            <button onClick={() => setPendingRun(null)}>Cancel</button>
            <button className="primary" disabled={busy || !mutationsAvailable} onClick={() => void confirmPendingRun()}>Confirm run</button>
          </div> : null}
          {!loaded ? <div className="automation-empty" role="status"><span aria-hidden="true">◷</span>
            <strong>Loading rules…</strong></div>
            : rules.length === 0 ? <div className="automation-empty"><span aria-hidden="true">↻</span>
            <strong>No saved rules yet</strong><p>Choose a recipe above. It will save disabled first.</p></div>
            : rules.map(rule => {
              const ruleRuntime = runtimeOverview.rules.find(state => state.automationId === rule.id);
              const lastRun = ruleRuntime?.lastRun
                ?? (ruleRuntime?.lastRunId
                  ? runs.find(run => run.id === ruleRuntime.lastRunId) ?? null : null);
              const lastRuntime = lastRun
                ? runtimeOverview.runs.find(state => state.runId === lastRun.id) : undefined;
              return <article className={`automation-rule${rule.needsRepair ? " needs-repair" : ""}`}
                key={rule.id} data-automation-id={rule.id}
                aria-current={rule.id === props.initialAutomationId ? "true" : undefined}>
                <button className={`automation-toggle${rule.enabled ? " on" : ""}`}
                  role="switch" aria-checked={rule.enabled}
                  aria-label={rule.needsRepair ? `${rule.name} needs review`
                    : `${rule.enabled ? "Pause" : "Enable"} ${rule.name}`}
                  disabled={busy || !mutationsAvailable || rule.needsRepair}
                  onClick={() => void toggle(rule)}><span /></button>
                <div><strong>{rule.name}</strong><span>{humanize(rule.trigger.kind)} · {rule.actions.map(action => humanize(action.kind)).join(", ")}</span>
                  {rule.needsRepair ? <small className="automation-repair-copy">Needs review after upgrade · disabled</small>
                    : <small>{humanize(rule.state)} · definition r{rule.definitionRevision}</small>}
                  <div className="automation-rule-runtime">
                    <small>Last run: {lastRun
                      ? `${humanize(lastRun.status)} · ${lastRun.at.slice(0, 16).replace("T", " ")}`
                      : "Never"}</small>
                    {ruleRuntime ? <small>Next: {ruleRuntime.next.detail}</small> : null}
                    {ruleRuntime?.skip ? <small>Skipped: {ruleRuntime.skip.detail}</small> : null}
                    {lastRuntime?.failure ? <small className="automation-run-failure">
                      Failure: {lastRuntime.failure.code} · {lastRuntime.failure.detail}</small> : null}
                    {lastRuntime ? <small>Undo: {lastRuntime.undo.detail}</small> : null}
                  </div>
                </div>
                {rule.needsRepair ? <button disabled={busy || !!workspace || !!pending || !!recoveryError} onClick={() => {
                  const repairDraft = legacyRepairDraft(rule, props.tables);
                  if (!repairDraft) {
                    props.onError("This older rule has multiple or unsupported steps. Rebuild it as a new rule so no behavior is silently dropped.");
                    return;
                  }
                  try {
                    beginWorkspace("legacy", repairDraft, { ...editableAutomation(rule as unknown as AutomationDefinitionV2), id: rule.id }, 0);
                    setDraftState(repairDraft); setRepairing({ id: rule.id, revision: 0 }); setBuilding(true);
                  } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
                }}>Review &amp; rebuild</button>
                  : <><button disabled={busy || !!workspace || !!pending || !!recoveryError} onClick={() => editRule(rule)}>Edit rule</button>
                    <button onClick={() => void previewRun(rule)} disabled={busy || !mutationsAvailable}>Preview run</button></>}
                <button className="link danger" aria-label={`Delete ${rule.name}`}
                  disabled={busy || !mutationsAvailable || !props.onConfirm}
                  onClick={() => void deleteRule(rule)}>Delete</button>
              </article>;
            })}
        </section> : tab === "inbox" ? <section className="automation-inbox">
          {props.notifications.length === 0 ? <div className="automation-empty"><span aria-hidden="true">✓</span>
            <strong>You’re caught up</strong><p>Local reminders from rules appear here.</p></div>
            : props.notifications.map(notification => <article key={notification.id}
              className={notification.read ? "read" : ""}>
              <div><strong>{notification.title}</strong><p>{notification.body}</p>
                <small>{notification.at.slice(0,16).replace("T"," ")}</small></div>
              {notification.table && notification.recordId ? <button onClick={() => {
                props.onClose(); props.onOpenRecord(notification.table!, notification.recordId!);
              }}>Open record</button> : null}
              {!notification.read ? <button disabled={busy || !mutationsAvailable}
                title={!mutationsAvailable ? "Unavailable until notification authority is certified" : undefined}
                onClick={() => void markRead(notification.id)}>
                Mark read</button> : null}
            </article>)}
        </section> : <section className="automation-history">
          {runs.length === 0 ? <div className="automation-empty"><span aria-hidden="true">◷</span>
            <strong>No runs yet</strong><p>Committed results and safe failures appear here.</p></div>
            : runs.map(run => {
              const rule = rules.find(candidate => candidate.id === run.automationId);
              const runRuntime = runtimeOverview.runs.find(state => state.runId === run.id);
              return <article key={run.id}><span className={`run-status ${run.status}`} />
                <div><strong>{rule?.name ?? "Deleted rule"}</strong><span>{run.matchedRecords} matched · {run.changed} changed · {run.at.slice(0,16).replace("T"," ")}</span></div>
                {run.status === "failed" ? <div className="automation-run-detail"><code>{run.errorCode}</code>
                  {runRuntime?.failure ? <small>{runRuntime.failure.detail}</small> : null}</div>
                  : run.undone ? <span className="run-undone">Undone</span>
: runRuntime?.undo.available ? <button disabled={busy || !mutationsAvailable}
                      title={!mutationsAvailable ? "Unavailable until automation authority is certified" : undefined}
                      onClick={() => void undoRun(run)}>Undo run</button>
                      : <small className="automation-undo-unavailable">
                        {runRuntime?.undo.detail ?? "Undo availability could not be verified."}</small>}</article>;
            })}
        </section>}
      </div>
    </ModalDialog>
  );
}
