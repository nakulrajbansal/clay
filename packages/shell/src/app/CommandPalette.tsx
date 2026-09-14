import { errorMessage } from "./error-message";
import { FocusInput, FocusSelect } from "./FocusControl";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AsyncStore, GlobalSearchResult, RegColumn, RegTable } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { DailyCaptureUndoPayloadV1 } from "@clay/schema/standalone/catalog";
import { ModalDialog } from "./ModalDialog";
import { beginPresentationIntent, cancelPresentationIntent, finishPresentationIntent, readPresentationIntent, reconcilePresentation, retainCaptureUndo, type PresentationIntent } from "./presentation-intent";
import "./Operations.css";

const humanize = (name: string): string => name.replace(/_/g, " ")
  .replace(/^./, character => character.toUpperCase());
const isDerived = (column: RegColumn): boolean =>
  column.type === "computed" || column.type === "lookup" || column.type === "rollup";

export const QUICK_CAPTURE_LAST_TABLE_SETTING = "quick_capture_last_table_v1";

function coerce(column: RegColumn, value: string): unknown {
  if (value === "") return null;
  if (column.type === "number" || column.type === "integer") return Number(value);
  if (column.type === "boolean") return value === "true";
  return value;
}

export function CommandPalette(props: {
  worker: WorkerClient;
  appInstanceId: string | null;
  store?: AsyncStore;
  tables: RegTable[];
  captureMode?: boolean;
  onClose: () => void;
  onOpenRecord: (table: string, id: string) => void;
  onOpenData: (table?: string) => void;
  onWrite: (table: string) => void;
  onError: (message: string) => void;
  onInfo: (message: string, action?: { label: string; run: () => void }) => void;
}): React.JSX.Element {
  const [recovery] = useState(() => {
    try { return { pending: props.appInstanceId ? readPresentationIntent(sessionStorage, props.appInstanceId, "capture") : null,
      undo: props.appInstanceId ? readPresentationIntent(sessionStorage, props.appInstanceId, "captureUndo") : null, error: "" }; }
    catch { return { pending: null, undo: null, error: "The stored capture request needs recovery; no new capture can replace it." }; }
  });
  const [undoIntent, setUndoIntent] = useState(recovery.undo);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState<RegTable | null>(recovery.pending
    ? props.tables.find(table => table.name === recovery.pending!.payload.table && table.semantic?.tableId === recovery.pending!.payload.tableId) ?? null : null);
  const [draft, setDraft] = useState<Record<string, string>>(() => recovery.pending
    ? Object.fromEntries(Object.entries(recovery.pending.payload.row as Record<string, unknown>).map(([key, value]) => [key, value == null ? "" : String(value)])) : {});
  const submitting = useRef(false);
  const pendingCreate = useRef(recovery.pending);
  const fields = useMemo(() => (creating?.columns ?? []).filter(column =>
    !column.hidden && !column.inactive && !isDerived(column)
      && column.type !== "relation" && column.type !== "attachment" && column.type !== "json"),
  [creating]);
  const quickTables = props.tables.slice(0, 6);
  const quickCount = quickTables.length + 1;

  useEffect(() => {
    if (!props.captureMode || pendingCreate.current) return;
    let live = true;
    void props.worker.getSetting<string>(QUICK_CAPTURE_LAST_TABLE_SETTING)
      .then(saved => {
        if (!live) return;
        const selected = props.tables.find(table =>
          table.name === saved || String(table.semantic?.tableId ?? "") === saved)
          ?? props.tables[0] ?? null;
        setCreating(selected);
      })
      .catch(() => { if (live) setCreating(props.tables[0] ?? null); });
    return () => { live = false; };
  }, [props.captureMode, props.tables, props.worker]);

  useEffect(() => {
    let live = true;
    setSearchError(null);
    const timer = window.setTimeout(() => {
      setBusy(true);
      void props.worker.globalSearch(query, 30).then(found => {
        if (!live) return;
        setResults(found);
        setActive(query.trim() !== "" && found.length > 0 ? quickCount : 0);
      }).catch(error => {
        if (live) {
          const message = errorMessage(error);
          setResults([]); setActive(0); setSearchError(message); props.onError(message);
        }
      }).finally(() => { if (live) setBusy(false); });
    }, query === "" ? 0 : 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [props.worker, query, quickCount]);

  const open = (result: GlobalSearchResult): void => {
    props.onClose();
    props.onOpenRecord(result.table, result.id);
  };

  const itemCount = quickCount + results.length;
  const focusItem = (index: number): void => {
    const next = Math.max(0, Math.min(itemCount - 1, index));
    setActive(next);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-command-index="${next}"]`)?.focus());
  };
  const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowDown") { event.preventDefault(); focusItem(index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusItem(index - 1); }
    else if (event.key.length === 1) {
      document.querySelector<HTMLInputElement>('.command-search-row input')?.focus();
    }
  };
  const activate = (index: number): void => {
    if (index < quickTables.length) { setCreating(quickTables[index]!); return; }
    if (index === quickTables.length) {
      props.onClose(); props.onOpenData(); return;
    }
    const result = results[index - quickCount];
    if (result) open(result);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault(); focusItem(active);
    } else if (event.key === "ArrowUp") {
      event.preventDefault(); focusItem(itemCount - 1);
    } else if (event.key === "Enter" && itemCount > 0) {
      event.preventDefault(); activate(active);
    }
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!creating || submitting.current || recovery.error || !props.appInstanceId) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (!pendingCreate.current && readPresentationIntent(sessionStorage, props.appInstanceId, "captureUndo"))
        throw new Error("Undo or explicitly Keep the previous capture before creating another record; its request was kept.");
      const tableId = creating.semantic?.tableId;
      if (!tableId)
        throw new Error("Quick capture requires a stable record type identity");
      if (!pendingCreate.current) {
        const row: Record<string, unknown> = {};
        for (const column of fields) {
          const value = draft[column.name] ?? "";
          if (value !== "") row[column.name] = column.type === "date"
            ? await props.worker.resolveDailyHomeDate(value) : coerce(column, value);
        }
        pendingCreate.current = beginPresentationIntent(sessionStorage, props.appInstanceId, "capture", "daily.capture",
          { appInstanceId: props.appInstanceId, table: creating.name, tableId: String(tableId), row }, () => props.worker.createMutationContext());
      }
      const intent = pendingCreate.current;
      if (intent.appInstanceId !== props.appInstanceId) throw new Error("Return to this capture's original app");
      const receipt = await reconcilePresentation(props.worker, intent, () => props.worker.quickCapture(
        String(intent.payload.table), intent.payload.row as Record<string, unknown>, String(intent.payload.tableId),
        { requestId: intent.requestId }, intent.appInstanceId));
      const created = receipt.created[0];
      if (!created || created.table !== creating.name)
        throw new Error("Quick capture did not return its durable created-record receipt");
      const undo = await retainCaptureUndo(sessionStorage, props.worker, intent, receipt.id);
      setUndoIntent(undo); // Persisted before any callback, toast, navigation or teardown.
      props.onWrite(creating.name);
      props.onInfo(`Capture recorded in ${humanize(creating.name)}. Reopen Quick Capture for Undo while the app is unchanged.`,
        { label: "Undo", run: () => { void undoCapture(undo); } });
      props.onClose();
      props.onOpenRecord(creating.name, created.id);
      finishPresentationIntent(sessionStorage, intent.appInstanceId, "capture", intent.requestId);
      pendingCreate.current = null;
    } catch (error) {
      props.onError(errorMessage(error));
    } finally { submitting.current = false; setBusy(false); }
  };

  const undoCapture = async (intent: PresentationIntent): Promise<void> => {
    if (submitting.current || intent.appInstanceId !== props.appInstanceId) return;
    submitting.current = true; setBusy(true);
    try {
      const payload = DailyCaptureUndoPayloadV1.parse(intent.payload);
      let historical = false;
      await reconcilePresentation(props.worker, intent, () => props.worker.undoQuickCapture(payload, { requestId: intent.requestId }),
        current => { historical = !current; });
      props.onWrite(payload.capturePayload.table);
      props.onInfo(historical ? "Capture Undo was already recorded; later edits were kept." : `Undid quick capture in ${humanize(payload.capturePayload.table)}.`);
      finishPresentationIntent(sessionStorage, intent.appInstanceId, "captureUndo", intent.requestId);
      setUndoIntent(null);
    } catch (error) { props.onError(`Could not undo quick capture: ${errorMessage(error)}`); }
    finally { submitting.current = false; setBusy(false); }
  };
  const keepCapture = async (): Promise<void> => {
    if (!undoIntent || submitting.current || undoIntent.appInstanceId !== props.appInstanceId) return;
    submitting.current = true; setBusy(true);
    try {
      if (await cancelPresentationIntent(sessionStorage, props.worker, undoIntent)) {
        setUndoIntent(null); props.onInfo("Previous capture kept; its pending Undo can no longer execute.");
      } else props.onError("Undo already committed. Retry Undo to acknowledge its result before creating another capture.");
    } catch (error) { props.onError(error instanceof Error ? error.message : "Undo outcome needs recovery"); }
    finally { submitting.current = false; setBusy(false); }
  };

  const cancelPending = async (): Promise<void> => {
    const intent = pendingCreate.current;
    if (!intent || submitting.current || intent.appInstanceId !== props.appInstanceId) return;
    submitting.current = true; setBusy(true);
    try {
      if (await cancelPresentationIntent(sessionStorage, props.worker, intent)) {
        pendingCreate.current = null; setCreating(props.tables.find(table => table.semantic?.tableId === intent.payload.tableId) ?? null);
        props.onInfo("Pending capture cancelled without effects. You can correct the draft.");
      } else props.onError("Capture already committed. Retry capture to read its result; it cannot be cancelled.");
    } catch (error) { props.onError(error instanceof Error ? error.message : "Cancellation needs recovery"); }
    finally { submitting.current = false; setBusy(false); }
  };

  return (
    <ModalDialog className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-8f9f0d ui-overflow-hidden command-palette" backdropClassName="ui ui-display-flex ui-align-items-center ui-position-fixed ui-inset-0 ui-overflow-auto ui-justify-content-center modal-backdrop command-backdrop"
      ariaLabel="Search and act" onClose={props.onClose}>
      <div className="ui ui-display-grid ui-align-items-center ui-border-bottom-line ui-gap-10px ui-input-font-648ad9 ui-input-color-64eb43 command-search-row">
        {recovery.error ? <p role="alert">{recovery.error}</p> : null}
        {undoIntent && !pendingCreate.current ? <section aria-label="Previous capture recovery">
          <p>Undo is bounded to the original app with no intervening writes. Keep closes this Undo request without removing the record.</p>
          <button disabled={busy || !!recovery.error} onClick={() => void undoCapture(undoIntent)}>Undo previous capture</button>
          <button disabled={busy || !!recovery.error} onClick={() => void keepCapture()}>Keep previous capture</button>
        </section> : null}
        {pendingCreate.current ? <button disabled={busy || !!recovery.error} onClick={() => void cancelPending()}>Cancel pending capture and edit</button> : null}
        {pendingCreate.current && !creating ? <p role="alert">The captured record type changed. Return to its original app and inspect Recovery Center; the request was kept.</p> : null}
        <span aria-hidden="true">⌕</span>
        <FocusInput autoFocus type="search" value={query} disabled={!!pendingCreate.current || submitting.current} onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown} placeholder="Find any record or choose an action…"
          role="combobox" aria-expanded="true"
          aria-activedescendant={itemCount > 0 ? `command-item-${active}` : undefined}
          aria-label="Search all records" aria-controls="command-results" />
        <kbd>Esc</kbd>
      </div>

      {creating ? (
        <form className="command-create" onSubmit={event => void create(event)}>
          <header>
            <button type="button" className="link" disabled={!!pendingCreate.current || submitting.current} onClick={() => { setCreating(null); setDraft({}); }}>← Back</button>
            <div><span>Quick create</span><h2>New {humanize(creating.name)}</h2></div>
          </header>
          <div className="ui ui-display-grid ui-input-font-648ad9 ui-input-border-58fb43 ui-label-display-b369c3 ui-input-color-64eb43 ui-select-color-8a3cd5 ui-select-font-d3b791 ui-select-border-f5f110 ui-select-background-25bcef ui-input-background-904d66 command-create-fields">
            {fields.map((column, index) => (
              <label key={column.name}>{column.label ?? humanize(column.name)}
                {column.type === "enum" ? (
                  <FocusSelect autoFocus={index === 0} required={column.required} disabled={!!pendingCreate.current || submitting.current}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))}>
                    <option value="">Choose…</option>
                    {(column.values ?? []).map(value => <option key={value}>{value}</option>)}
                  </FocusSelect>
                ) : column.type === "boolean" ? (
                  <FocusSelect autoFocus={index === 0} required={column.required} disabled={!!pendingCreate.current || submitting.current}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))}>
                    <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
                  </FocusSelect>
                ) : (
                  <FocusInput autoFocus={index === 0} required={column.required} disabled={!!pendingCreate.current || submitting.current}
                    aria-label={column.label ?? humanize(column.name)}
                    type={column.type === "number" || column.type === "integer" ? "number" : "text"}
                    placeholder={column.type === "date" ? "today, tomorrow, or YYYY-MM-DD" : undefined}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))} />
                )}
              </label>
            ))}
          </div>
          {pendingCreate.current && !busy && <p role="status">The outcome is not yet reconciled. Retry the same capture; closing does not cancel a committed record.</p>}
          <footer><button type="button" disabled={submitting.current}
            onClick={() => pendingCreate.current ? props.onClose() : setCreating(null)}>{pendingCreate.current ? "Close" : "Cancel"}</button>
            <button className="primary" disabled={busy || !!recovery.error || !props.appInstanceId || (!!undoIntent && !pendingCreate.current)} type="submit">{busy ? "Creating…" : pendingCreate.current ? "Retry capture" : "Create record"}</button></footer>
        </form>
      ) : (
        <div id="command-results" className="ui ui-overflow-auto command-results">
          <section className="command-actions" aria-label="Quick actions">
            <div className="ui ui-color-text-3 ui-text-transform-uppercase command-section-label">Quick actions</div>
            <div className="ui ui-display-grid ui-gap-6px ui-button-font-590948 ui-button-color-353ba8 command-action-grid">
              {quickTables.map((table, index) => (
                <button key={table.name} className={active === index ? "active" : ""}
                  id={`command-item-${index}`} data-command-index={index}
                  tabIndex={active === index ? 0 : -1}
                  aria-current={active === index ? "true" : undefined}
                  onFocus={() => setActive(index)} onKeyDown={event => onItemKeyDown(event, index)}
                  onMouseEnter={() => setActive(index)} onClick={() => activate(index)}>
                  <span aria-hidden="true">＋</span><span>New {humanize(table.name)}</span>
                </button>
              ))}
              <button className={active === quickTables.length ? "active" : ""}
                id={`command-item-${quickTables.length}`} data-command-index={quickTables.length}
                tabIndex={active === quickTables.length ? 0 : -1}
                aria-current={active === quickTables.length ? "true" : undefined}
                onFocus={() => setActive(quickTables.length)}
                onKeyDown={event => onItemKeyDown(event, quickTables.length)}
                onMouseEnter={() => setActive(quickTables.length)}
                onClick={() => activate(quickTables.length)}>
                <span aria-hidden="true">▦</span><span>Open all data</span>
              </button>
            </div>
          </section>
          <div className="ui ui-color-text-3 ui-text-transform-uppercase command-section-label">{query ? "Records" : "Recently changed"}</div>
          {searchError ? <div className="ui ui-color-text-3 ui-font-size-13px ui-text-align-center command-empty command-error" role="alert">{searchError}</div>
            : busy && results.length === 0 ? <div className="ui ui-color-text-3 ui-font-size-13px ui-text-align-center command-empty">Searching…</div>
            : results.length === 0 ? <div className="ui ui-color-text-3 ui-font-size-13px ui-text-align-center command-empty">No records found. Try another word.</div>
              : results.map((result, index) => {
                const itemIndex = quickCount + index;
                return <button key={`${result.table}:${result.id}`}
                  id={`command-item-${itemIndex}`} data-command-index={itemIndex}
                  tabIndex={active === itemIndex ? 0 : -1}
                  aria-current={itemIndex === active ? "true" : undefined}
                  className={itemIndex === active ? "active" : ""}
                  onFocus={() => setActive(itemIndex)}
                  onKeyDown={event => onItemKeyDown(event, itemIndex)}
                  onMouseEnter={() => setActive(itemIndex)} onClick={() => activate(itemIndex)}>
                  <span className="ui ui-display-grid ui-color-accent-text ui-place-items-center ui-border-radius-8px ui-background-bg command-record-icon" aria-hidden="true">{result.label.slice(0, 1).toUpperCase()}</span>
                  <span className="ui ui-display-grid ui-min-width-0 ui-small-color-0803d9 command-record-copy"><strong>{result.label}</strong>
                    <small>{result.secondary || `Updated ${result.updatedAt.slice(0, 10)}`}</small></span>
                  <span className="ui ui-color-text-3 ui-font-size-10-5px command-record-table">{humanize(result.table)}</span>
                </button>;
              })}
        </div>
      )}
    </ModalDialog>
  );
}
