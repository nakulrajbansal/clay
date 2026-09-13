import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LatestRequestGate } from "./async-lifecycle";
import {
  DAILY_SOURCE_LIBRARY_SETTING,
  loadDailySourceLibrary,
  removeReviewedDailySource,
  resetDailySourceLibrary,
  resolveDailySourceProfiles,
  upsertReviewedDailySource,
  type DailySourceIssueReason,
  type ReviewedDailySourceProfile,
} from "@clay/kernel/daily-source-profile";
import type {
  DailyHomeItemV1 as DailyHomeItem,
  DailyHomeSnapshotV1 as DailyHomeSnapshot,
  DailySourceLibraryV1 as DailySourceLibrary,
} from "@clay/schema/daily-home";
import type { RegTable } from "@clay/kernel/registry";
import type { WorkerClient } from "./worker-client";
import type { DailyPresentationV1 } from "@clay/schema/catalog";
import { beginDailyCas, executeDailyCas, favoriteValue, reviewedSourceStorage, dailyCasReview, executeInboxIntent } from "./daily-intent";
import { beginPresentationIntent, cancelPresentationIntent, finishPresentationIntent, readPresentationIntent, type PresentationIntent } from "./presentation-intent";
import "./TodayView.css";

const SECTION_COPY = {
  needs_attention: { title: "Needs attention", empty: "No local reminders need attention." },
  due_today: { title: "Due today", empty: "Nothing else is due today." },
  continue: { title: "Continue where you left off", empty: "No recent changes yet." },
  pinned: { title: "Pinned", empty: "Favorite records and saved views appear here." },
  recently_opened: { title: "Recently opened", empty: "Records you open appear here." },
} as const;

type TodayViewProps = {
  worker: WorkerClient;
  tables: RegTable[];
  refreshToken?: number;
  onOpenRecord: (table: string, id: string) => void;
  onOpenAutomation: (id?: string) => void;
  onOpenSavedView: (id: string) => void;
  onQuickCapture: () => void;
  onSetup: () => void;
  onCreateRecurring: () => void;
  automationMutationsAvailable?: boolean;
  dailyHomeMutationsAvailable?: boolean;
  onError: (message: string) => void;
  onWrite?: (table: string) => void;
};

function minimum(count: DailyHomeSnapshot["aggregateCounts"]["renderedUnique"]): number {
  return count.kind === "exact" ? count.total : count.knownMinimum;
}

function countLabel(count: DailyHomeSnapshot["aggregateCounts"]["renderedUnique"]): string {
  const value = minimum(count);
  return count.kind === "exact" ? String(value) : `${value}+`;
}

function itemMeta(item: DailyHomeItem): string {
  if (item.kind === "due_record") {
    return item.severity === "high" ? "Overdue" : "Due today";
  }
  if (item.kind === "automation_notification") return item.summary ?? "Local automation reminder";
  if (item.kind === "saved_view_projection") return "Saved view";
  if ("sourceId" in item && item.sourceId === "favorite_record") return "Favorite record";
  if ("sourceId" in item && item.sourceId === "recently_opened_record") return "Recently opened";
  return "Recently changed";
}

function recordTarget(item: DailyHomeItem): string | null {
  return item.route.kind === "record" ? `${item.route.tableId}\u0000${item.route.rowId}` : null;
}

function profileFieldLabel(
  profile: ReviewedDailySourceProfile,
  fieldId: string,
  tables: readonly RegTable[],
): string {
  for (const table of tables) {
    const column = table.columns.find(candidate => String(candidate.semantic?.fieldId ?? "") === fieldId);
    if (column) return column.semantic?.label ?? column.label ?? column.name;
  }
  if (fieldId === profile.labelFieldId) return profile.labelSnapshot ?? fieldId;
  if (fieldId === profile.dueFieldId) return profile.dueLabelSnapshot ?? fieldId;
  return fieldId;
}

function sourceIssueMessage(
  profile: ReviewedDailySourceProfile,
  reason: DailySourceIssueReason,
  tables: readonly RegTable[],
): string {
  const tableLabel = profile.labelSnapshot || profile.tableId;
  const label = profileFieldLabel(profile, profile.labelFieldId, tables);
  const due = profileFieldLabel(profile, profile.dueFieldId, tables);
  const completion = profile.completion.kind === "none" ? "completion"
    : profileFieldLabel(profile, profile.completion.fieldId, tables);
  switch (reason) {
    case "table_missing": return `Record type “${tableLabel}” is missing.`;
    case "table_inactive": return `Record type “${tableLabel}” is retired.`;
    case "table_ambiguous": return `Record type “${tableLabel}” has an ambiguous identity.`;
    case "label_field_unavailable": return `Title field “${label}” is missing, hidden, or retired.`;
    case "label_field_ambiguous": return `Title field “${label}” has an ambiguous identity.`;
    case "due_field_unavailable": return `Due field “${due}” is missing, hidden, or retired.`;
    case "due_field_ambiguous": return `Due field “${due}” has an ambiguous identity.`;
    case "due_field_not_date": return `Due field “${due}” is no longer a date.`;
    case "completion_field_unavailable":
      return `Completion field “${completion}” is missing, hidden, or retired.`;
    case "completion_field_ambiguous":
      return `Completion field “${completion}” has an ambiguous identity.`;
    case "completion_field_incompatible":
      return `Completion rule for “${completion}” no longer matches its field type.`;
    case "completion_values_stale": {
      const values = profile.completion.kind === "enum"
        ? profile.completion.terminalValues.join(", ") : "configured values";
      return `Completion terminal set “${values}” is stale.`;
    }
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function TodayView(props: TodayViewProps): React.JSX.Element {
  const projectionGate = useRef(new LatestRequestGate());
  const setupGate = useRef(new LatestRequestGate());
  const mutationsAvailable = props.dailyHomeMutationsAvailable === true;
  const [snapshot, setSnapshot] = useState<DailyHomeSnapshot | null>(null);
  const [reviewed, setReviewed] = useState<DailyPresentationV1 | null>(null);
  const [setupReviewed, setSetupReviewed] = useState<DailyPresentationV1 | null>(null);
  const [pending, setPending] = useState<PresentationIntent[]>([]);
  const [recoveryError, setRecoveryError] = useState("");
  const [inbox, setInbox] = useState(false);
  const [snoozeDates, setSnoozeDates] = useState<Record<string, string>>({});
  const working = useRef(false);
  const pendingChange = useRef<PresentationIntent | null>(null);
  const loadPending = (app: string): void => {
    try { setPending([readPresentationIntent(sessionStorage, app, "dailySource"), readPresentationIntent(sessionStorage, app, "dailyNavigation"),
      readPresentationIntent(sessionStorage, app, "dailyInbox"), readPresentationIntent(sessionStorage, app, "dailyInboxUndo")]
      .filter((intent): intent is PresentationIntent => intent !== null)); setRecoveryError(""); }
    catch { setRecoveryError("Stored Daily request needs recovery; no new change can replace it."); }
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const setupOptions = useMemo(() => props.tables.flatMap(table => {
    if (table.inactive || !table.semantic?.tableId) return [];
    const labels = table.columns.filter(column => !column.hidden && !column.inactive
      && !!column.semantic?.fieldId
      && (column.type === "text" || column.type === "rich_text" || column.type === "enum"));
    const dates = table.columns.filter(column => !column.hidden && !column.inactive
      && !!column.semantic?.fieldId && column.type === "date");
    const completions = table.columns.filter(column => !column.hidden && !column.inactive
      && !!column.semantic?.fieldId && (column.type === "boolean" || column.type === "enum"));
    return labels.length && dates.length ? [{ table, labels, dates, completions }] : [];
  }), [props.tables]);
  const [setupTableId, setSetupTableId] = useState("");
  const [setupLabelId, setSetupLabelId] = useState("");
  const [setupDueId, setSetupDueId] = useState("");
  const [setupCompletion, setSetupCompletion] = useState("none");
  const [setupEnumValue, setSetupEnumValue] = useState("");
  const [sourceLibrary, setSourceLibrary] = useState<DailySourceLibrary | null>(null);
  const [sourceMalformed, setSourceMalformed] = useState(false);
  const tableNames = useMemo(() => new Map(props.tables.flatMap(table => {
    const tableId = table.semantic?.tableId;
    return tableId ? [[String(tableId), table.name] as const] : [];
  })), [props.tables]);
  const sourceIssues = useMemo(() => {
    if (!sourceLibrary) return new Map<string, DailySourceIssueReason>();
    const registry = new Map(props.tables.map(table => [table.name, table]));
    return new Map(resolveDailySourceProfiles(registry, sourceLibrary).issues
      .map(issue => [issue.profileId, issue.reason]));
  }, [props.tables, sourceLibrary]);

  const selectSetupTable = useCallback((tableId: string): void => {
    const option = setupOptions.find(candidate => String(candidate.table.semantic?.tableId) === tableId);
    const configured = sourceLibrary?.profiles.find(profile => profile.tableId === tableId);
    const configuredLabel = option?.labels.find(column =>
      String(column.semantic?.fieldId ?? "") === configured?.labelFieldId);
    const configuredDue = option?.dates.find(column =>
      String(column.semantic?.fieldId ?? "") === configured?.dueFieldId);
    setSetupTableId(tableId);
    setSetupLabelId(String(configuredLabel?.semantic?.fieldId
      ?? option?.labels[0]?.semantic?.fieldId ?? ""));
    setSetupDueId(String(configuredDue?.semantic?.fieldId
      ?? option?.dates[0]?.semantic?.fieldId ?? ""));
    const configuredCompletion = configured?.completion;
    if (!configuredCompletion || configuredCompletion.kind === "none") {
      setSetupCompletion("none"); setSetupEnumValue("");
    } else if (configuredCompletion.kind === "boolean") {
      const field = option?.completions.find(column => column.type === "boolean"
        && String(column.semantic?.fieldId ?? "") === configuredCompletion.fieldId);
      setSetupCompletion(field ? `boolean:${configuredCompletion.fieldId}` : "none");
      setSetupEnumValue("");
    } else {
      const field = option?.completions.find(column => column.type === "enum"
        && String(column.semantic?.fieldId ?? "") === configuredCompletion.fieldId
        && column.values?.includes(configuredCompletion.completeValue));
      setSetupCompletion(field ? `enum:${configuredCompletion.fieldId}` : "none");
      setSetupEnumValue(field ? configuredCompletion.completeValue : "");
    }
  }, [setupOptions, sourceLibrary]);
  useEffect(() => {
    if (!setupOptions.length) return;
    const tableId = setupOptions.some(option =>
      String(option.table.semantic?.tableId) === setupTableId)
      ? setupTableId : String(setupOptions[0]!.table.semantic!.tableId);
    selectSetupTable(tableId);
  }, [selectSetupTable, setupOptions, setupTableId]);

  const refresh = useCallback(async (): Promise<void> => {
    const request = projectionGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const next = await props.worker.dailyPresentation();
      if (projectionGate.current.isCurrent(request)) {
        setSnapshot(next.snapshot); setReviewed(next); loadPending(next.authorityTarget.appInstanceId);
      }
    } catch (cause) {
      if (!projectionGate.current.isCurrent(request)) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      props.onError(message);
    } finally {
      if (projectionGate.current.isCurrent(request)) setLoading(false);
    }
  }, [props.worker, props.onError]);

  const loadSetup = useCallback(async (): Promise<void> => {
    const request = setupGate.current.begin();
    try {
      const read = await props.worker.dailyPresentation();
      const raw = read.sourceLibrary;
      if (!setupGate.current.isCurrent(request)) return;
      if (snapshot && read.authorityTarget.appInstanceId !== snapshot.basis.appInstanceId) throw new Error("Today source changed; reopen setup in the original app");
      setSetupReviewed(read);
      try {
        const library = loadDailySourceLibrary(raw);
        setSourceLibrary(library);
        setSourceMalformed(false);
      } catch {
        setSourceLibrary(null);
        setSourceMalformed(true);
      }
    } catch (cause) {
      if (!setupGate.current.isCurrent(request)) return;
      props.onError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [props.worker, props.onError, snapshot?.basis.appInstanceId]);

  const openSetup = (): void => {
    if (!setupTableId && setupOptions[0]) {
      selectSetupTable(String(setupOptions[0].table.semantic!.tableId));
    }
    setShowSetup(true);
    void loadSetup();
  };

  const saveSetup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (working.current || savingSetup || !mutationsAvailable || !setupReviewed || pending.length || recoveryError) return;
    const option = setupOptions.find(candidate =>
      String(candidate.table.semantic?.tableId) === setupTableId);
    const label = option?.labels.find(candidate =>
      String(candidate.semantic?.fieldId) === setupLabelId);
    const due = option?.dates.find(candidate =>
      String(candidate.semantic?.fieldId) === setupDueId);
    if (!option || !label || !due) {
      props.onError("Choose a record type, title field, and due date field.");
      return;
    }
    let completion: Parameters<typeof upsertReviewedDailySource>[1]["completion"] = { kind: "none" };
    if (setupCompletion.startsWith("boolean:")) {
      const fieldId = setupCompletion.slice("boolean:".length);
      const field = option.completions.find(candidate =>
        candidate.type === "boolean" && String(candidate.semantic?.fieldId) === fieldId);
      if (!field) { props.onError("Choose a valid boolean completion rule."); return; }
      completion = { kind: "boolean", fieldId, completeValue: true };
    } else if (setupCompletion.startsWith("enum:")) {
      const fieldId = setupCompletion.slice("enum:".length);
      const field = option.completions.find(candidate =>
        candidate.type === "enum" && String(candidate.semantic?.fieldId) === fieldId);
      if (!field || !field.values?.includes(setupEnumValue)) {
        props.onError("Choose a reviewed terminal completion value."); return;
      }
      completion = {
        kind: "enum", fieldId, completeValue: setupEnumValue, terminalValues: [setupEnumValue],
      };
    }
    working.current = true; setSavingSetup(true);
    try {
      const library = await upsertReviewedDailySource(reviewedSourceStorage(sessionStorage, props.worker, setupReviewed, intent => {
        pendingChange.current = intent; loadPending(intent.appInstanceId);
      }), {
        tableId: setupTableId,
        labelFieldId: setupLabelId,
        dueFieldId: setupDueId,
        completion,
        labelSnapshot: option.table.semantic?.label ?? option.table.name,
        dueLabelSnapshot: due.label ?? due.semantic?.label ?? due.name,
      });
      setSourceLibrary(library);
      setSourceMalformed(false);
      setShowSetup(false);
      await refresh();
      finishChange();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.current = false; setSavingSetup(false);
    }
  };

  const removeSource = async (profileId: string): Promise<void> => {
    if (working.current || savingSetup || !mutationsAvailable || !setupReviewed || pending.length || recoveryError) return;
    working.current = true; setSavingSetup(true);
    try {
      const library = await removeReviewedDailySource(reviewedSourceStorage(sessionStorage, props.worker, setupReviewed, intent => {
        pendingChange.current = intent; loadPending(intent.appInstanceId);
      }), profileId);
      setSourceLibrary(library);
      await refresh();
      await loadSetup(); finishChange();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally { working.current = false; setSavingSetup(false); }
  };

  const resetSources = async (): Promise<void> => {
    if (working.current || savingSetup || !mutationsAvailable || !setupReviewed || pending.length || recoveryError) return;
    working.current = true; setSavingSetup(true);
    try {
      const library = await resetDailySourceLibrary(reviewedSourceStorage(sessionStorage, props.worker, setupReviewed, intent => {
        pendingChange.current = intent; loadPending(intent.appInstanceId);
      }));
      setSourceLibrary(library);
      setSourceMalformed(false);
      await refresh();
      await loadSetup(); finishChange();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally { working.current = false; setSavingSetup(false); }
  };

  const finishChange = (): void => {
    const intent = pendingChange.current;
    if (intent) {
      finishPresentationIntent(sessionStorage, intent.appInstanceId, intent.slot, intent.requestId);
      pendingChange.current = null; loadPending(intent.appInstanceId);
    }
  };
  const recoverChange = async (intent: PresentationIntent, cancel: boolean): Promise<void> => {
    if (working.current || intent.appInstanceId !== snapshot?.basis.appInstanceId) return;
    working.current = true; setSavingSetup(true);
    try {
      if (cancel) {
        if (!await cancelPresentationIntent(sessionStorage, props.worker, intent))
          throw new Error("Change already recorded. Retry the original change to read its outcome.");
        if (pendingChange.current?.requestId === intent.requestId) pendingChange.current = null;
      } else {
        if (intent.slot === "dailyInbox" || intent.slot === "dailyInboxUndo") {
          await executeInboxIntent(sessionStorage, props.worker, intent);
          reportInboxWrite(intent);
        } else await executeDailyCas(props.worker, intent);
        pendingChange.current = intent;
      }
      await refresh(); if (showSetup) await loadSetup();
      if (!cancel) finishChange();
      loadPending(intent.appInstanceId);
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { working.current = false; setSavingSetup(false); }
  };

  const reportInboxWrite = (intent: PresentationIntent): void => {
    const payload = intent.slot === "dailyInboxUndo" ? intent.payload.actionPayload as Record<string, unknown> : intent.payload;
    const item = payload.item as DailyHomeItem;
    if (item.route.kind === "record") {
      const table = tableNames.get(item.route.tableId);
      if (table) props.onWrite?.(table);
    }
  };
  const actOnInbox = async (item: DailyHomeItem, action: "complete" | "snooze" | "dismiss"): Promise<void> => {
    if (!reviewed || working.current || pending.length || recoveryError || !mutationsAvailable) return;
    working.current = true; setSavingSetup(true);
    try {
      const tomorrow = new Date(Date.parse(`${reviewed.snapshot.basis.localDate}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
      const intent = beginPresentationIntent(sessionStorage, reviewed.authorityTarget.appInstanceId, "dailyInbox", "daily.inbox",
        { review: dailyCasReview(reviewed), item, action, ...(action === "snooze" ? { untilLocalDate: snoozeDates[item.sourceKey] ?? tomorrow } : {}) },
        () => props.worker.createMutationContext());
      pendingChange.current = intent; loadPending(intent.appInstanceId);
      await executeInboxIntent(sessionStorage, props.worker, intent);
      loadPending(intent.appInstanceId); reportInboxWrite(intent);
      await refresh(); finishChange();
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { working.current = false; setSavingSetup(false); }
  };

  useEffect(() => {
    void refresh();
    return () => { projectionGate.current.invalidate(); setupGate.current.invalidate(); };
  }, [refresh, props.refreshToken]);
  useEffect(() => {
    if (!snapshot) return;
    const validUntil = Date.parse(snapshot.basis.projectionValidUntil);
    const delay = Number.isFinite(validUntil)
      ? Math.max(0, Math.min(2_147_483_647, validUntil - Date.now())) : 0;
    const timer = window.setTimeout(() => { void refresh(); }, delay);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, snapshot?.basis.projectionValidUntil, snapshot?.snapshotDigest]);

  const open = (item: DailyHomeItem): void => {
    if (item.route.kind === "record") {
      const table = tableNames.get(item.route.tableId);
      if (!table) {
        props.onError("This record’s table is no longer available. Review Today setup.");
        return;
      }
      props.onOpenRecord(table, item.route.rowId);
      return;
    }
    if (item.route.kind === "automation") {
      props.onOpenAutomation(item.route.automationId);
      return;
    }
    if (item.route.kind === "saved_view") {
      props.onOpenSavedView(item.route.savedViewId);
      return;
    }
    if (item.route.kind === "setup") {
      openSetup();
      return;
    }
    props.onOpenAutomation();
  };

  if (loading && !snapshot) {
    return <main className="today-home" aria-label="Today"><div className="today-loading" role="status">
      Preparing Today from your local records…
    </div></main>;
  }
  if (!snapshot) {
    return <main className="today-home" aria-label="Today"><div className="today-error" role="alert">
      <strong>Today could not be prepared.</strong><span>{error}</span>
      <button onClick={() => void refresh()}>Try again</button>
    </div></main>;
  }

  const due = snapshot.sections.find(section => section.sectionId === "due_today")!;
  const sections = snapshot.sections.filter(section => section.sectionId !== "due_today");
  const sourceTargets = (sourceId: "favorite_record" | "recently_opened_record"): Set<string> =>
    new Set(snapshot.sources.find(source => source.sourceId === sourceId)?.page.items
      .map(recordTarget).filter((target): target is string => target !== null) ?? []);
  const favoriteTargets = sourceTargets("favorite_record");
  const recentTargets = sourceTargets("recently_opened_record");
  const activeSetupOption = setupOptions.find(option =>
    String(option.table.semantic?.tableId) === setupTableId);
  const selectedEnumCompletion = setupCompletion.startsWith("enum:")
    ? activeSetupOption?.completions.find(column =>
      column.type === "enum"
      && String(column.semantic?.fieldId) === setupCompletion.slice("enum:".length))
    : undefined;

  const toggleFavorite = async (item: DailyHomeItem): Promise<void> => {
    if (item.route.kind !== "record" || !reviewed || !mutationsAvailable || working.current || pending.length || recoveryError) return;
    working.current = true; setSavingSetup(true);
    try {
      const value = favoriteValue(reviewed, item.route.tableId, item.route.rowId, !favoriteTargets.has(recordTarget(item)!));
      const intent = beginDailyCas(sessionStorage, props.worker, reviewed, "dailyNavigation", value.revision - 1, value);
      pendingChange.current = intent; loadPending(intent.appInstanceId);
      const result = await executeDailyCas(props.worker, intent);
      if (!result.ok) throw new Error("Reviewed navigation CAS did not win; recover its original request");
      await refresh();
      finishChange();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally { working.current = false; setSavingSetup(false); }
  };
  const cards = (items: DailyHomeItem[]): React.JSX.Element[] => items.map(item => {
    const target = recordTarget(item);
    const favorite = target !== null && favoriteTargets.has(target);
    const recent = target !== null && recentTargets.has(target);
    return <article className={`today-item today-item-${item.kind}`}
      key={`${item.sourceKey}:${item.sourceGeneration}`}>
      <button className="today-item-main" onClick={() => open(item)}>
        <span className="today-item-mark" aria-hidden="true" />
        <span className="today-item-copy"><strong>{item.title}</strong><small>{itemMeta(item)}</small>
          <span className="today-item-badges">
            {favorite ? <span>Favorite</span> : null}
            {recent ? <span>Opened recently</span> : null}
          </span>
        </span>
        <span className="today-item-open" aria-hidden="true">›</span>
      </button>
      {item.route.kind === "record" && mutationsAvailable ? <button className="today-pin" disabled={savingSetup || !!pending.length || !!recoveryError}
        aria-label={`${favorite ? "Unpin" : "Pin"} ${item.title}`}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={() => void toggleFavorite(item)}>{favorite ? "★" : "☆"}</button> : null}
      {(item.kind === "due_record" || item.kind === "automation_notification") && mutationsAvailable ? <div className="today-inbox-actions">
        {item.actions.includes("complete") ? <button disabled={savingSetup || !!pending.length || !!recoveryError} onClick={() => void actOnInbox(item, "complete")}>Complete</button> : null}
        {item.actions.includes("snooze") ? <>
          <input type="date" aria-label={`Snooze ${item.title} until local date`} disabled={savingSetup || !!pending.length || !!recoveryError}
            value={snoozeDates[item.sourceKey] ?? new Date(Date.parse(`${snapshot.basis.localDate}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)}
            onChange={event => setSnoozeDates(value => ({ ...value, [item.sourceKey]: event.target.value }))} />
          <button disabled={savingSetup || !!pending.length || !!recoveryError} onClick={() => void actOnInbox(item, "snooze")}>Snooze</button>
        </> : null}
        {item.actions.includes("dismiss") ? <button disabled={savingSetup || !!pending.length || !!recoveryError} onClick={() => void actOnInbox(item, "dismiss")}>Dismiss</button> : null}
      </div> : null}
    </article>;
  });

  return <main className="today-home" aria-labelledby="today-title">
    {recoveryError ? <p role="alert">{recoveryError}</p> : null}
    {pending.map(intent => intent.slot === "dailyInboxUndo" ? <section key={intent.requestId} aria-label="Inbox Undo recovery">
      <p>Undo this Inbox change while its original app is unchanged. Keep closes the pending Undo without reverting the change.</p>
      <button disabled={savingSetup || pending.some(row => row.slot === "dailyInbox")} onClick={() => void recoverChange(intent, false)}>Undo Inbox change</button>
      <button disabled={savingSetup || pending.some(row => row.slot === "dailyInbox")} onClick={() => void recoverChange(intent, true)}>Keep Inbox change</button>
    </section> : <section key={intent.requestId} aria-label="Daily change recovery">
      <p>A {intent.slot === "dailySource" ? "source setup" : "navigation"} change needs reconciliation. Its original app, projection and desired value were kept.</p>
      <button disabled={savingSetup} onClick={() => void recoverChange(intent, false)}>Retry original Daily change</button>
      <button disabled={savingSetup} onClick={() => void recoverChange(intent, true)}>Cancel original Daily change</button>
    </section>)}
    <header className="today-hero">
      <div><span className="today-kicker">Your local daily view</span><h1 id="today-title">{inbox ? "Inbox" : "Today"}</h1>
        <p>{snapshot.basis.localDate} · projected live from canonical records</p></div>
      <div className="today-actions">
        <button aria-pressed={!inbox} onClick={() => setInbox(false)}>Today</button>
        <button aria-pressed={inbox} onClick={() => setInbox(true)}>Inbox</button>
        <button className="today-secondary" onClick={props.onCreateRecurring}
          disabled={props.automationMutationsAvailable === false}
          title={props.automationMutationsAvailable === false
            ? "Unavailable until automation authority is certified" : undefined}>↻ Recurring record</button>
        <button className="today-primary" onClick={props.onQuickCapture}
          disabled={!mutationsAvailable}
          title={!mutationsAvailable ? "Unavailable until Daily Home changes are certified" : undefined}>
          ＋ Quick capture
        </button>
      </div>
    </header>

    {snapshot.configurationStatus === "needs_setup" ? <section className="today-setup">
      <div><strong>Choose what can be due</strong>
        <p>Connect a date field once. Clay will never guess which record date is authoritative.</p></div>
      <button onClick={openSetup}>Set up Today</button>
    </section> : snapshot.configurationStatus === "partial" ? <div className="today-partial" role="status">
      Today is showing verified local results. Some sources are unavailable or need attention.
      <button className="link" onClick={openSetup}>Review setup</button>
    </div> : null}

    {showSetup ? <section className="today-source-setup" aria-labelledby="today-source-title">
      <header><div><span className="today-kicker">Reviewed local source</span>
        <h2 id="today-source-title">Choose records for Today</h2></div>
        <button type="button" className="link" onClick={() => setShowSetup(false)}
          disabled={savingSetup}>Close</button>
      </header>
      {sourceMalformed ? <div className="today-source-warning" role="alert">
        <strong>Today source settings are malformed.</strong>
        <p>Reset only the Today source list; canonical records are not changed.</p>
        <button type="button" aria-label="Reset Today sources"
          disabled={savingSetup || !mutationsAvailable || !!pending.length || !!recoveryError}
          onClick={() => void resetSources()}>Reset Today sources</button>
      </div> : null}
      {sourceLibrary && sourceLibrary.profiles.length > 0 ? <section className="today-configured-sources"
        aria-label="Configured Today sources">
        <h3>Configured sources</h3>
        {sourceLibrary.profiles.map(profile => {
          const configuredTable = props.tables.find(table =>
            String(table.semantic?.tableId ?? "") === profile.tableId);
          const label = configuredTable?.semantic?.label ?? profile.labelSnapshot ?? profile.tableId;
          const issue = sourceIssues.get(profile.profileId);
          const ambiguous = issue === "table_ambiguous" || issue === "label_field_ambiguous"
            || issue === "due_field_ambiguous" || issue === "completion_field_ambiguous";
          return <article key={profile.profileId}>
            <div><strong>{label}</strong>{issue
              ? <span className="today-source-issue" role="status" data-reason={issue}>
                {sourceIssueMessage(profile, issue, props.tables)}
              </span>
              : <span>{profile.completion.kind === "none"
                ? "No completion rule" : "Completion reviewed"}</span>}</div>
            <div className="today-source-recovery">
              {issue && configuredTable && !configuredTable.inactive && !ambiguous
                ? <button type="button" className="link"
                  aria-label={`Review binding for ${label}`}
                  onClick={() => selectSetupTable(profile.tableId)}>Review binding</button> : null}
              {issue ? <button type="button" className="link"
                aria-label={`Repair schema for ${label}`}
                onClick={props.onSetup}>Open Data to repair schema</button> : null}
              <button type="button" className="link danger"
                aria-label={`Remove source ${label}`} disabled={savingSetup || !mutationsAvailable || !!pending.length || !!recoveryError}
                title={!mutationsAvailable
                  ? "Unavailable until Daily Home changes are certified" : undefined}
                onClick={() => void removeSource(profile.profileId)}>Remove</button>
            </div>
          </article>;
        })}
      </section> : null}
      {setupOptions.length ? <form className="today-source-form" onSubmit={event => void saveSetup(event)}>
        <label>Record type
          <select aria-label="Record type" value={setupTableId}
            onChange={event => selectSetupTable(event.currentTarget.value)} disabled={savingSetup}>
            {setupOptions.map(option => {
              const id = String(option.table.semantic!.tableId);
              return <option key={id} value={id}>
                {option.table.semantic?.label ?? option.table.name}
              </option>;
            })}
          </select>
        </label>
        <label>Title field
          <select aria-label="Title field" value={setupLabelId}
            onChange={event => setSetupLabelId(event.currentTarget.value)} disabled={savingSetup}>
            {(setupOptions.find(option => String(option.table.semantic?.tableId) === setupTableId)?.labels ?? [])
              .map(column => {
                const id = String(column.semantic!.fieldId);
                return <option key={id} value={id}>{column.label ?? column.semantic?.label ?? column.name}</option>;
              })}
          </select>
        </label>
        <label>Due date field
          <select aria-label="Due date field" value={setupDueId}
            onChange={event => setSetupDueId(event.currentTarget.value)} disabled={savingSetup}>
            {(setupOptions.find(option => String(option.table.semantic?.tableId) === setupTableId)?.dates ?? [])
              .map(column => {
                const id = String(column.semantic!.fieldId);
                return <option key={id} value={id}>{column.label ?? column.semantic?.label ?? column.name}</option>;
              })}
          </select>
        </label>
        <label>Completion rule
          <select aria-label="Completion rule" value={setupCompletion} disabled={savingSetup}
            onChange={event => {
              const value = event.currentTarget.value;
              setSetupCompletion(value);
              if (value.startsWith("enum:")) {
                const fieldId = value.slice("enum:".length);
                const field = activeSetupOption?.completions.find(candidate =>
                  candidate.type === "enum" && String(candidate.semantic?.fieldId) === fieldId);
                setSetupEnumValue(field?.values?.[0] ?? "");
              } else setSetupEnumValue("");
            }}>
            <option value="none">No completion rule (include every due record)</option>
            {(activeSetupOption?.completions ?? []).map(column => {
              const fieldId = String(column.semantic!.fieldId);
              const label = column.label ?? column.semantic?.label ?? column.name;
              return <option key={fieldId} value={`${column.type}:${fieldId}`}>
                {column.type === "boolean" ? `${label} = yes` : `${label} reaches a terminal value`}
              </option>;
            })}
          </select>
        </label>
        {selectedEnumCompletion ? <label>Completed value
          <select aria-label="Completed value" value={setupEnumValue} disabled={savingSetup}
            onChange={event => setSetupEnumValue(event.currentTarget.value)}>
            {(selectedEnumCompletion.values ?? []).map(value =>
              <option key={value} value={value}>{value}</option>)}
          </select>
        </label> : null}
        <p>Clay includes records due today or earlier and excludes only the completion rule reviewed here.</p>
        <div className="today-source-actions">
          <button className="today-primary" type="submit"
            disabled={savingSetup || !mutationsAvailable || !setupReviewed || !!pending.length || !!recoveryError}>
            {savingSetup ? "Saving…" : mutationsAvailable ? "Use this source" : "Changes unavailable"}
          </button>
          <button className="today-secondary" type="button" disabled={savingSetup}
            onClick={() => setShowSetup(false)}>Cancel</button>
        </div>
      </form> : <div className="today-source-empty">
        <p>Add a record type with a text title and date field, then return to Today.</p>
        <button className="today-secondary" type="button" onClick={props.onSetup}>Open Data</button>
      </div>}
    </section> : null}

    <div className="today-grid">
      {inbox ? <section className="today-section" aria-label="Local Inbox">
        <header><h2>Local Inbox</h2></header>
        <p>Due work and local automation notices. Snooze uses this app’s calendar; no off-device reminder delivery is implied.</p>
        {snapshot.sources.filter(source => source.sourceId === "due_record" || source.sourceId === "automation_notification").map(source => <section key={source.sourceId}>
          <h3>{source.sourceId === "due_record" ? "Due records" : "Automation notices"} · {countLabel(source.page.counts.renderedUnique)}</h3>
          <div className="today-list">{cards(source.page.items)}</div>
          {!source.page.items.length ? <p>{source.page.counts.renderedUnique.kind === "exact" ? "No current items in this source." : "This source is partial or unavailable; more work may exist."}</p> : null}
        </section>)}
      </section> : <>
      <section className="today-section today-section-due_today" aria-labelledby="today-due">
        <header><h2 id="today-due">Due today &amp; overdue</h2>
          <span>{countLabel(due.page.counts.renderedUnique)}</span></header>
        <div className="today-list">{due.page.items.length ? cards(due.page.items)
          : <p className="today-empty">{due.page.counts.renderedUnique.kind === "exact"
            ? "Nothing is due today or overdue."
            : "Due results are partial; more work may exist."}</p>}</div>
      </section>
      {sections.map(section => {
        const copy = SECTION_COPY[section.sectionId];
        return <section className={`today-section today-section-${section.sectionId}`}
          key={section.sectionId} aria-labelledby={`today-${section.sectionId}`}>
          <header><h2 id={`today-${section.sectionId}`}>{copy.title}</h2>
            <span>{countLabel(section.page.counts.renderedUnique)}</span></header>
          <div className="today-list">{section.page.items.length
            ? cards(section.page.items)
            : <p className="today-empty">{section.page.counts.renderedUnique.kind === "exact"
              ? copy.empty : `${copy.title} results are partial; more work may exist.`}</p>}</div>
        </section>;
      })}
      </>}
    </div>
    {snapshot.aggregateCounts.renderedUnique.kind === "partial" ? <p className="today-completeness">
      Counts ending in + are partial. Clay never calls a loaded page “all”.
    </p> : null}
  </main>;
}
