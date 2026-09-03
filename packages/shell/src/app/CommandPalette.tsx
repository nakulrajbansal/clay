import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import type { GlobalSearchResult, RegColumn, RegTable } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { ModalDialog } from "./ModalDialog";
import "./Operations.css";

const humanize = (name: string): string => name.replace(/_/g, " ")
  .replace(/^./, character => character.toUpperCase());
const isDerived = (column: RegColumn): boolean =>
  column.type === "computed" || column.type === "lookup" || column.type === "rollup";

function coerce(column: RegColumn, value: string): unknown {
  if (value === "") return null;
  if (column.type === "number" || column.type === "integer") return Number(value);
  if (column.type === "boolean") return value === "true";
  return value;
}

export function CommandPalette(props: {
  worker: WorkerClient;
  tables: RegTable[];
  onClose: () => void;
  onOpenRecord: (table: string, id: string) => void;
  onOpenData: (table?: string) => void;
  onWrite: (table: string) => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState<RegTable | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const fields = useMemo(() => (creating?.columns ?? []).filter(column =>
    !column.hidden && !column.inactive && !isDerived(column)
      && column.type !== "relation" && column.type !== "attachment" && column.type !== "json"),
  [creating]);
  const quickTables = props.tables.slice(0, 6);
  const quickCount = quickTables.length + 1;

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
    if (!creating) return;
    const row: Record<string, unknown> = {};
    for (const column of fields) {
      const value = draft[column.name] ?? "";
      if (value !== "") row[column.name] = coerce(column, value);
    }
    setBusy(true);
    try {
      const receipt = await props.worker.applyBatch(`Create ${humanize(creating.name)} record`, [{
        kind: "insert", table: creating.name, row,
      }]);
      const created = receipt.created[0];
      if (!created) throw new Error("Clay did not return the created record");
      props.onWrite(creating.name);
      props.onInfo(`Created in ${humanize(creating.name)}. Undo is available from the data view.`);
      props.onClose();
      props.onOpenRecord(created.table, created.id);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  return (
    <ModalDialog className="command-palette" backdropClassName="modal-backdrop command-backdrop"
      ariaLabel="Search and act" onClose={props.onClose}>
      <div className="command-search-row">
        <span aria-hidden="true">⌕</span>
        <input autoFocus type="search" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown} placeholder="Find any record or choose an action…"
          role="combobox" aria-expanded="true"
          aria-activedescendant={itemCount > 0 ? `command-item-${active}` : undefined}
          aria-label="Search all records" aria-controls="command-results" />
        <kbd>Esc</kbd>
      </div>

      {creating ? (
        <form className="command-create" onSubmit={event => void create(event)}>
          <header>
            <button type="button" className="link" onClick={() => { setCreating(null); setDraft({}); }}>← Back</button>
            <div><span>Quick create</span><h2>New {humanize(creating.name)}</h2></div>
          </header>
          <div className="command-create-fields">
            {fields.map((column, index) => (
              <label key={column.name}>{column.label ?? humanize(column.name)}
                {column.type === "enum" ? (
                  <select autoFocus={index === 0} required={column.required}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))}>
                    <option value="">Choose…</option>
                    {(column.values ?? []).map(value => <option key={value}>{value}</option>)}
                  </select>
                ) : column.type === "boolean" ? (
                  <select autoFocus={index === 0} required={column.required}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))}>
                    <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
                  </select>
                ) : (
                  <input autoFocus={index === 0} required={column.required}
                    type={column.type === "date" ? "date"
                      : column.type === "number" || column.type === "integer" ? "number" : "text"}
                    value={draft[column.name] ?? ""}
                    onChange={event => setDraft(value => ({ ...value, [column.name]: event.target.value }))} />
                )}
              </label>
            ))}
          </div>
          <footer><button type="button" onClick={() => setCreating(null)}>Cancel</button>
            <button className="primary" disabled={busy} type="submit">{busy ? "Creating…" : "Create record"}</button></footer>
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
