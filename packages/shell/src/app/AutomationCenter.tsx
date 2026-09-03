import { useEffect, useMemo, useState } from "react";
import type {
  AutomationDefinition, AutomationDefinitionInput, AutomationRun, AutomationSimulation,
  ClayNotification, RegColumn, RegTable,
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
};

const humanize = (value: string): string => value.replace(/_/g, " ")
  .replace(/^./, character => character.toUpperCase());
const derived = (column: RegColumn): boolean =>
  column.type === "computed" || column.type === "lookup" || column.type === "rollup";
const writable = (table?: RegTable): RegColumn[] => (table?.columns ?? []).filter(column =>
  !column.hidden && !column.inactive && !derived(column)
    && column.type !== "attachment" && column.type !== "json" && column.type !== "relation");

function scalar(column: RegColumn | undefined, value: string): string | number | boolean | null {
  if (value === "") return null;
  if (column?.type === "number" || column?.type === "integer") return Number(value);
  if (column?.type === "boolean") return value === "true";
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
  };
}

export function AutomationCenter(props: {
  worker: WorkerClient;
  tables: RegTable[];
  notifications: ClayNotification[];
  onNotifications: (notifications: ClayNotification[]) => void;
  onClose: () => void;
  onOpenRecord: (table: string, id: string) => void;
  onWrite: (table: string) => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onConfirm?: (message: string) => Promise<boolean>;
}): React.JSX.Element {
  const [tab, setTab] = useState<"rules" | "inbox" | "history">("rules");
  const [rules, setRules] = useState<AutomationDefinition[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [draft, setDraft] = useState<Draft>(() => defaultDraft(props.tables));
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [simulation, setSimulation] = useState<AutomationSimulation | null>(null);
  const [simulatedRule, setSimulatedRule] = useState<AutomationDefinition | null>(null);
  const [simulatedDraft, setSimulatedDraft] = useState<string | null>(null);
  const [pendingEnable, setPendingEnable] = useState<{
    rule: AutomationDefinition; simulation: AutomationSimulation;
  } | null>(null);
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

  const refresh = async (): Promise<void> => {
    const [nextRules, nextRuns, nextNotifications] = await Promise.all([
      props.worker.listAutomations(), props.worker.automationRuns(undefined, 100),
      props.worker.notifications(),
    ]);
    setRules(nextRules); setRuns(nextRuns); props.onNotifications(nextNotifications); setLoaded(true);
  };
  useEffect(() => { void refresh().catch(error => {
    setLoaded(true);
    props.onError(error instanceof Error ? error.message : String(error));
  });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const definition = (): AutomationDefinitionInput => {
    const conditionColumn = source?.columns.find(column => column.name === draft.conditionField);
    const conditions = draft.conditionField && draft.conditionValue !== ""
      ? [{ field: draft.conditionField, op: "eq" as const,
          value: scalar(conditionColumn, draft.conditionValue) ?? "" }] : [];
    let trigger: AutomationDefinitionInput["trigger"];
    if (draft.trigger === "schedule") trigger = {
      kind: "schedule", cadence: draft.cadence, localTime: draft.localTime,
      ...(draft.cadence === "weekly" ? { weekday: Number(draft.weekday) } : {}),
    };
    else if (draft.trigger === "date_due") trigger = {
      kind: "date_due", table: draft.table, dateField: draft.dateField,
      daysBefore: Number(draft.daysBefore), conditions,
    };
    else trigger = { kind: draft.trigger, table: draft.table,
      conditions: draft.trigger === "record_matches" ? conditions : conditions };

    let action: AutomationDefinitionInput["actions"][number];
    if (draft.action === "notify") action = {
      kind: "notify", title: draft.noticeTitle, body: draft.noticeBody,
    };
    else if (draft.action === "set_fields") {
      const field = source?.columns.find(column => column.name === draft.actionField);
      action = { kind: "set_fields", values: {
        [draft.actionField]: { source: "literal", value: scalar(field, draft.actionValue) },
      } };
    } else if (draft.action === "create_related") {
      const option = relatedOptions.find(candidate =>
        `${candidate.table.name}.${candidate.column.name}` === draft.relationField);
      if (!option) throw new Error("Choose a related table");
      const field = option.table.columns.find(column => column.name === draft.targetField);
      action = { kind: "create_related", table: option.table.name,
        relationField: option.column.name, values: {
          [draft.targetField]: { source: "literal", value: scalar(field, draft.actionValue) },
        } };
    } else {
      const field = target?.columns.find(column => column.name === draft.targetField);
      action = { kind: "create_record", table: draft.targetTable, values: {
        [draft.targetField]: { source: "literal", value: scalar(field, draft.actionValue) },
      } };
    }
    return { name: draft.name, enabled: false, trigger, actions: [action] };
  };

  const saveAndSimulate = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await props.worker.upsertAutomation(definition());
      const nextSimulation = await props.worker.simulateAutomation(saved.id);
      setSimulation(nextSimulation); setSimulatedRule(saved);
      setSimulatedDraft(JSON.stringify(draft));
      await refresh();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const enableSimulated = async (): Promise<void> => {
    if (!simulatedRule) return;
    if (simulatedDraft !== JSON.stringify(draft)) {
      setSimulation(null); setSimulatedRule(null); setSimulatedDraft(null);
      props.onError("This rule changed after simulation. Simulate the current draft again before enabling.");
      return;
    }
    setBusy(true);
    try {
      await props.worker.upsertAutomation({ ...simulatedRule, enabled: true });
      props.onInfo(`Enabled “${simulatedRule.name}”. It runs locally while Clay is open.`);
      setBuilding(false); setSimulation(null); setSimulatedRule(null); setSimulatedDraft(null);
      setDraft(defaultDraft(props.tables));
      await refresh();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const toggle = async (rule: AutomationDefinition): Promise<void> => {
    setBusy(true);
    try {
      if (!rule.enabled) {
        const preview = await props.worker.simulateAutomation(rule.id);
        setPendingEnable({ rule, simulation: preview });
        return;
      }
      await props.worker.upsertAutomation({ ...rule, enabled: false });
      await refresh();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const confirmPendingEnable = async (): Promise<void> => {
    if (!pendingEnable) return;
    setBusy(true);
    try {
      await props.worker.upsertAutomation({ ...pendingEnable.rule, enabled: true });
      props.onInfo(`Enabled “${pendingEnable.rule.name}”. It runs locally while Clay is open.`);
      setPendingEnable(null);
      await refresh();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const runNow = async (rule: AutomationDefinition): Promise<void> => {
    setBusy(true);
    try {
      const preview = await props.worker.simulateAutomation(rule.id);
      if (preview.plannedMutations > 100)
        throw new Error("This run would change more than 100 records. Narrow the rule first.");
      const run = await props.worker.runAutomationNow(rule.id);
      const affected = new Set<string>();
      if (rule.trigger.kind !== "schedule") affected.add(rule.trigger.table);
      for (const action of rule.actions)
        if (action.kind === "create_record" || action.kind === "create_related")
          affected.add(action.table);
      for (const table of affected) props.onWrite(table);
      props.onInfo(run.status === "success" ? `Ran “${rule.name}”.` : `“${rule.name}” failed safely.`);
      await refresh(); setTab("history");
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const undoRun = async (run: AutomationRun): Promise<void> => {
    setBusy(true);
    try {
      await props.worker.undoAutomationRun(run.id);
      props.onInfo("Automation changes were undone.");
      await refresh();
      for (const table of props.tables) props.onWrite(table.name);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return (
    <ModalDialog className="automation-center" backdropClassName="modal-backdrop automation-backdrop"
      ariaLabelledBy="automation-title" onClose={props.onClose}>
      <header className="automation-header">
        <div><span className="record-detail-kicker">Local workflows</span>
          <h2 id="automation-title">Automations</h2>
          <p>Repeatable work with previews, receipts, and undo.</p></div>
        <button aria-label="Close automations" onClick={props.onClose}>✕</button>
      </header>
      <nav className="automation-tabs" aria-label="Automation sections">
        <button className={tab === "rules" ? "active" : ""} aria-pressed={tab === "rules"}
          onClick={() => setTab("rules")}>
          Rules <span>{rules.length}</span></button>
        <button className={tab === "inbox" ? "active" : ""} aria-pressed={tab === "inbox"}
          onClick={() => setTab("inbox")}>
          Inbox <span>{props.notifications.filter(notification => !notification.read).length}</span></button>
        <button className={tab === "history" ? "active" : ""} aria-pressed={tab === "history"}
          onClick={() => setTab("history")}>
          Run history <span>{runs.length}</span></button>
      </nav>

      <div className="automation-body">
        {tab === "rules" ? (
          building ? (
            <section className="automation-builder">
              <div className="automation-builder-title"><button className="link"
                onClick={() => { setBuilding(false); setSimulation(null); }}>← Rules</button>
                <div><strong>Build a local rule</strong><span>Save disabled, inspect a simulation, then enable.</span></div></div>
              <div className="automation-step"><span className="automation-step-number">1</span><div>
                <label>Rule name<input autoFocus value={draft.name}
                  onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
                  placeholder="Create kickoff task for new deals" /></label>
              </div></div>
              <div className="automation-step"><span className="automation-step-number">2</span><div>
                <div className="automation-inline">
                  <label>When<select value={draft.trigger}
                    onChange={event => setDraft(current => ({ ...current,
                      trigger: event.target.value as TriggerKind }))}>
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
                <span>Simulation</span><strong>{simulation.matchedRecords} records match</strong>
                <p>{simulation.plannedMutations} data changes · {simulation.plannedNotifications} reminders</p>
                {simulation.sampleLabels.length ? <small>{simulation.sampleLabels.join(" · ")}</small> : null}
              </div> : null}
              <footer className="automation-builder-actions"><button onClick={() => setBuilding(false)}>Cancel</button>
                {!simulation ? <button className="primary" disabled={busy || !draft.name.trim()}
                  onClick={() => void saveAndSimulate()}>{busy ? "Simulating…" : "Save and simulate"}</button>
                  : <button className="primary" disabled={busy} onClick={() => void enableSimulated()}>
                    {busy ? "Enabling…" : "Enable rule"}</button>}</footer>
            </section>
          ) : <section className="automation-rule-list">
            <div className="automation-list-head"><div><strong>Your rules</strong>
              <span>Runs only on this device while Clay is open.</span></div>
              <button className="primary" onClick={() => { setDraft(defaultDraft(props.tables)); setBuilding(true); }}>＋ New rule</button></div>
            {pendingEnable ? <div className="automation-enable-preview" aria-live="polite">
              <div><span>Simulation</span><strong>{pendingEnable.rule.name}</strong>
                <p>{pendingEnable.simulation.matchedRecords} match · {pendingEnable.simulation.plannedMutations} data changes · {pendingEnable.simulation.plannedNotifications} reminders</p></div>
              <button onClick={() => setPendingEnable(null)}>Cancel</button>
              <button className="primary" disabled={busy}
                onClick={() => void confirmPendingEnable()}>Enable rule</button>
            </div> : null}
            {!loaded ? <div className="automation-empty" role="status"><span aria-hidden="true">◷</span>
              <strong>Loading rules…</strong></div>
              : rules.length === 0 ? <div className="automation-empty"><span aria-hidden="true">↻</span>
              <strong>Turn repeat work into a rule</strong><p>Start with a reminder or a safe field update.</p></div>
              : rules.map(rule => <article className="automation-rule" key={rule.id}>
                <button className={`automation-toggle${rule.enabled ? " on" : ""}`}
                  role="switch" aria-checked={rule.enabled}
                  aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`} disabled={busy}
                  onClick={() => void toggle(rule)}><span /></button>
                <div><strong>{rule.name}</strong><span>{humanize(rule.trigger.kind)} · {rule.actions.map(action => humanize(action.kind)).join(", ")}</span></div>
                <button onClick={() => void runNow(rule)} disabled={busy}>Run now</button>
                <button className="link danger" aria-label={`Delete ${rule.name}`}
                  onClick={() => void (async () => {
                    if (props.onConfirm && !await props.onConfirm(
                      `Delete “${rule.name}”? Existing run history remains visible.`)) return;
                    await props.worker.deleteAutomation(rule.id); await refresh();
                  })()}>Delete</button>
              </article>)}
          </section>
        ) : tab === "inbox" ? <section className="automation-inbox">
          {props.notifications.length === 0 ? <div className="automation-empty"><span aria-hidden="true">✓</span>
            <strong>You’re caught up</strong><p>Local reminders from rules appear here.</p></div>
            : props.notifications.map(notification => <article key={notification.id}
              className={notification.read ? "read" : ""}>
              <div><strong>{notification.title}</strong><p>{notification.body}</p>
                <small>{notification.at.slice(0,16).replace("T"," ")}</small></div>
              {notification.table && notification.recordId ? <button onClick={() => {
                void props.worker.markNotificationRead(notification.id).then(refresh);
                props.onClose(); props.onOpenRecord(notification.table!, notification.recordId!);
              }}>Open record</button> : <button onClick={() => void props.worker.markNotificationRead(notification.id).then(refresh)}>
                Mark read</button>}
            </article>)}
        </section> : <section className="automation-history">
          {runs.length === 0 ? <div className="automation-empty"><span aria-hidden="true">◷</span>
            <strong>No runs yet</strong><p>Every result and failure will be visible here.</p></div>
            : runs.map(run => {
              const rule = rules.find(candidate => candidate.id === run.automationId);
              return <article key={run.id}><span className={`run-status ${run.status}`} />
                <div><strong>{rule?.name ?? "Deleted rule"}</strong><span>{run.matchedRecords} matched · {run.changed} changed · {run.at.slice(0,16).replace("T"," ")}</span></div>
                {run.status === "failed" ? <code>{run.errorCode}</code>
                  : run.undone ? <span className="run-undone">Undone</span>
                    : <button disabled={busy} onClick={() => void undoRun(run)}>Undo run</button>}</article>;
            })}
        </section>}
      </div>
    </ModalDialog>
  );
}
