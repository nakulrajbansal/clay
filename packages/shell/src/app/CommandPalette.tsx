import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AsyncStore, GlobalSearchResult, RegColumn, RegTable } from "@clay/kernel";
import type { WorkerClient, WorkerMutationContext } from "./worker-client";
import { ModalDialog } from "./ModalDialog";
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState<RegTable | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const submitting = useRef(false);
  const pendingCreate = useRef<{
    table: string;
    tableId: string;
    row: Record<string, unknown>;
    context: WorkerMutationContext;
  } | null>(null);
  const fields = useMemo(() => (creating?.columns ?? []).filter(column =>
    !column.hidden && !column.inactive && !isDerived(column)
      && column.type !== "relation" && column.type !== "attachment" && column.type !== "json"),
  [creating]);
  const quickTables = props.tables.slice(0, 6);
  const quickCount = quickTables.length + 1;

  useEffect(() => {
    if (!props.captureMode) return;
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
          const message = error instanceof Error ? error.message : String(error);
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
    if (!creating || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const tableId = creating.semantic?.tableId;
      if (props.captureMode && !tableId)
        throw new Error("Quick capture requires a stable record type identity");
      if (!pendingCreate.current) {
        const row: Record<string, unknown> = {};
        for (const column of fields) {
          const value = draft[column.name] ?? "";
          if (value !== "") row[column.name] = column.type === "date"
            ? await props.worker.resolveDailyHomeDate(value) : coerce(column, value);
        }
        pendingCreate.current = { table: creating.name, tableId: String(tableId), row,
          context: props.worker.createMutationContext() };
      }
      const intent = pendingCreate.current;
      const receipt = props.captureMode
        ? await props.worker.quickCapture(intent.table, intent.row, intent.tableId, intent.context)
        : await props.worker.applyBatch(`Create ${humanize(intent.table)} record`,
          [{ kind: "insert", table: intent.table, row: intent.row }], intent.context);
      const created = receipt.created[0];
      if (!created || created.table !== creating.name)
        throw new Error("Quick capture did not return its durable created-record receipt");
      props.onWrite(creating.name);
      const undoContext = props.worker.createMutationContext();
      props.onInfo(`Created in ${humanize(creating.name)} with a durable undo receipt.`, {
        label: "Undo",
        run: () => {
          const undo = props.captureMode
            ? props.worker.undoQuickCapture(receipt.id, undoContext)
            : props.worker.undoBatch(receipt.id, undoContext);
          void undo.then(() => {
            props.onWrite(creating.name);
            props.onInfo(`Undid quick capture in ${humanize(creating.name)}.`);
          }).catch(error => props.onError(
            `Could not undo quick capture: ${error instanceof Error ? error.message : String(error)}`,
          ));
        },
      });
      props.onClose();
      props.onOpenRecord(creating.name, created.id);
      pendingCreate.current = null;
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally { submitting.current = false; setBusy(false); }
  };

  return (
    <ModalDialog className="command-palette" backdropClassName="modal-backdrop command-backdrop"
      ariaLabel="Search and act" onClose={props.onClose}>
      <div className="command-search-row">
        <span aria-hidden="true">⌕</span>
        <input autoFocus type="search" value={query} disabled={!!pendingCreate.current || submitting.current} onChange={event => setQuery(event.target.value)}
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
          <div className="command-create-fields">
            {fields.map((column, index) => (
              <label key={column.name}>{column.label ?? humanize(column.name)}
                {column.type === "enum" ? (
                  <select autoFocus={index === 0} required={column.required} disabled={!!pendingCreate.current || submitting.current}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))}>
                    <option value="">Choose…</option>
                    {(column.values ?? []).map(value => <option key={value}>{value}</option>)}
                  </select>
                ) : column.type === "boolean" ? (
                  <select autoFocus={index === 0} required={column.required} disabled={!!pendingCreate.current || submitting.current}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))}>
                    <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
                  </select>
                ) : (
                  <input autoFocus={index === 0} required={column.required} disabled={!!pendingCreate.current || submitting.current}
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
            <button className="primary" disabled={busy} type="submit">{busy ? "Creating…" : pendingCreate.current ? "Retry capture" : "Create record"}</button></footer>
        </form>
      ) : (
        <div id="command-results" className="command-results">
          <section className="command-actions" aria-label="Quick actions">
            <div className="command-section-label">Quick actions</div>
            <div className="command-action-grid">
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
          <div className="command-section-label">{query ? "Records" : "Recently changed"}</div>
          {searchError ? <div className="command-empty command-error" role="alert">{searchError}</div>
            : busy && results.length === 0 ? <div className="command-empty">Searching…</div>
            : results.length === 0 ? <div className="command-empty">No records found. Try another word.</div>
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
                  <span className="command-record-icon" aria-hidden="true">{result.label.slice(0, 1).toUpperCase()}</span>
                  <span className="command-record-copy"><strong>{result.label}</strong>
                    <small>{result.secondary || `Updated ${result.updatedAt.slice(0, 10)}`}</small></span>
                  <span className="command-record-table">{humanize(result.table)}</span>
                </button>;
              })}
        </div>
      )}
    </ModalDialog>
  );
}
