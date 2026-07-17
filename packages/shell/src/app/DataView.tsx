// The Data view (doc 01/W3): trusted, shell-rendered table editing —
// see every row, edit cells, add rows, soft-delete, and restore (G6:
// per-row snapshots from row_history; soft-deleted rows come back too).
// Designed as a spreadsheet the user already knows: tabs per table,
// click-any-cell editing, a search box, and a clear add-row.
import { useCallback, useEffect, useState } from "react";
import type { AsyncStore, QueryRow, RegTable } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";

type EditingCell = { rowId: string; col: string; draft: string };

function coerceDraft(type: string, draft: string): unknown {
  if (draft === "") return null;
  if (type === "number" || type === "integer") return Number(draft);
  if (type === "boolean") return draft === "true";
  return draft;
}

const TYPE_HINT: Record<string, string> = {
  number: "123", integer: "123", date: "date", enum: "pick",
  boolean: "y/n", computed: "auto",
};

export function DataView(props: {
  worker: WorkerClient;
  store: AsyncStore;
  initialTable?: string | null;
  onWrite: (table: string) => void;
  onImport: (file: File) => void;
  onClose: () => void;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
  onSchemaChange?: () => void;
}): React.JSX.Element {
  const { worker, store } = props;
  const [tables, setTables] = useState<RegTable[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [deleted, setDeleted] = useState<QueryRow[]>([]);
  const [restorable, setRestorable] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draftRow, setDraftRow] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [samples, setSamples] = useState(0);
  // ADR-027: per-record history + local schema edits (no model call)
  const [histFor, setHistFor] = useState<{ id: string;
    entries: { at: string; values: Record<string, unknown> }[] } | null>(null);
  const [addingCol, setAddingCol] = useState<{ name: string; type: string } | null>(null);
  const [renamingCol, setRenamingCol] = useState<{ from: string; value: string } | null>(null);

  const toggleHistory = async (id: string): Promise<void> => {
    if (histFor?.id === id) { setHistFor(null); return; }
    setHistFor({ id, entries: await worker.rowHistory(selected!, id) });
  };
  const commitAddColumn = async (): Promise<void> => {
    if (!addingCol || !selected || addingCol.name.trim() === "") return;
    try {
      setTables(await worker.addColumn(selected,
        { name: addingCol.name, type: addingCol.type }));
      setAddingCol(null);
      await reload(selected);
      props.onWrite(selected);
      props.onSchemaChange?.();
      props.onInfo(`Added “${addingCol.name}” — rewind the timeline to undo.`);
    } catch (e) { props.onError("Could not add column: " + (e as Error).message); }
  };
  const commitRenameColumn = async (): Promise<void> => {
    if (!renamingCol || !selected) return;
    const { from, value } = renamingCol;
    setRenamingCol(null);
    if (value.trim() === "" || value === from) return;
    try {
      setTables(await worker.renameColumn(selected, from, value));
      await reload(selected);
      props.onWrite(selected);
      props.onSchemaChange?.();
      props.onInfo(`Renamed “${from}” to “${value}” — panels updated too.`);
    } catch (e) { props.onError("Could not rename: " + (e as Error).message); }
  };

  const table = tables.find(t => t.name === selected) ?? null;
  const columns = table?.columns.filter(c => !c.hidden) ?? [];

  const reload = useCallback(async (name: string): Promise<void> => {
    setRows(await store.query({ from: name, limit: 500 }));
    setDeleted(await store.query({
      from: name, includeDeleted: true,
      where: [{ field: "deleted_at", op: "not_null" }],
    }));
    setRestorable(new Set(await worker.restorableRows(name)));
  }, [store, worker]);

  useEffect(() => {
    void (async () => {
      const t = await worker.registryTables();
      setTables(t);
      setSamples(await worker.sampleCount());
      if (t.length > 0) {
        const want = props.initialTable && t.some(x => x.name === props.initialTable)
          ? props.initialTable : t[0]!.name;
        setSelected(want);
        await reload(want);
      }
    })();
  }, [worker, reload, props.initialTable]);

  // Esc: cancel a cell edit first; a second Esc closes the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setEditing(ed => {
        if (ed) return null;
        props.onClose();
        return ed;
      });
    };
    window.addEventListener("keydown", onKey);
    return (): void => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (name: string): Promise<void> => {
    setSelected(name);
    setEditing(null);
    setDraftRow({});
    setSearch("");
    await reload(name);
  };

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (!selected) return;
    try {
      await fn();
      await reload(selected);
      props.onWrite(selected);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    }
  };

  const commitEdit = async (): Promise<void> => {
    if (!editing || !selected) return;
    const col = columns.find(c => c.name === editing.col);
    const cell = editing;
    setEditing(null);
    if (!col || col.type === "computed") return;
    await act(() => store.update(selected, cell.rowId,
      { [cell.col]: coerceDraft(col.type, cell.draft) }));
  };

  const addRow = async (): Promise<void> => {
    if (!selected) return;
    const row: Record<string, unknown> = {};
    for (const c of columns) {
      if (c.type === "computed") continue;
      const draft = draftRow[c.name] ?? "";
      if (draft === "") continue;
      row[c.name] = coerceDraft(c.type, draft);
    }
    await act(() => store.insert(selected, row));
    setDraftRow({});
  };

  const cellInput = (c: RegTable["columns"][number],
    value: string, onChange: (v: string) => void,
    commit?: () => void): React.JSX.Element => {
    if (c.type === "enum") {
      return (
        <select value={value} autoFocus={commit !== undefined} aria-label={c.name}
          onChange={e => { onChange(e.target.value); }} onBlur={commit}>
          <option value="">—</option>
          {(c.values ?? []).map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      );
    }
    return (
      <input
        type={c.type === "date" ? "date"
          : c.type === "number" || c.type === "integer" ? "number" : "text"}
        value={value}
        autoFocus={commit !== undefined}
        aria-label={c.name}
        onChange={e => onChange(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter" && commit) commit();
          if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
        }}
      />
    );
  };

  // Sample rows: generated in the trusted worker and tracked by id, so
  // clearing removes exactly those rows (soft-deleted, restorable) — never
  // anything the user typed or imported.
  const fillSamples = async (): Promise<void> => {
    try {
      const res = await worker.fillSamples();
      setSamples(await worker.sampleCount());
      if (selected) await reload(selected);
      for (const t of tables) props.onWrite(t.name);
      props.onInfo(`Added ${res.added} sample row${res.added === 1 ? "" : "s"} across ${res.tables} table${res.tables === 1 ? "" : "s"}.`);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    }
  };
  const clearSamples = async (): Promise<void> => {
    try {
      await worker.removeSamples();
      setSamples(0);
      if (selected) await reload(selected);
      for (const t of tables) props.onWrite(t.name);
      props.onInfo("Sample rows cleared. Only generated rows were removed — your own data is untouched, and the cleared rows sit under “deleted rows” if you want them back.");
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    }
  };

  const q = search.trim().toLowerCase();
  const visible = q === "" ? rows : rows.filter(r =>
    columns.some(c => String(r[c.name] ?? "").toLowerCase().includes(q)));

  return (
    <div className="dataview">
      <header className="dataview-header">
        <div className="dataview-title">
          <strong>Your data</strong>
          <span className="dataview-hint">click any cell to edit — every change is saved and reversible</span>
        </div>
        <div className="dataview-header-actions">
          {tables.length > 0 ? (
            <button className="dataview-sample" onClick={() => void fillSamples()}
              title="Fill every table with realistic sample rows so you can see the app working. Clearing later removes only these generated rows.">
              ✨ Sample data
            </button>
          ) : null}
          {samples > 0 ? (
            <button className="dataview-sample dataview-sample-clear" onClick={() => void clearSamples()}
              title="Removes only the generated sample rows — never your own data. Cleared rows stay under “deleted rows”, restorable.">
              Clear samples ({samples})
            </button>
          ) : null}
          <label className="dataview-import file-label" title="Add a CSV or JSON file as a new table">
            ⬆ Import file
            <input type="file" accept=".csv,.tsv,.txt,.json" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) props.onImport(f); e.target.value = ""; }} />
          </label>
          {table ? (
            <button
              className="dataview-import"
              title={`Download “${table.name}” as a spreadsheet — your data is always yours`}
              onClick={() => {
                const esc = (v: unknown): string => {
                  const s = String(v ?? "");
                  return /[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
                };
                const csv = [columns.map(c => esc(c.name)).join(",")]
                  .concat(rows.map(r => columns.map(c => esc(r[c.name])).join(",")))
                  .join("\n");
                const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                const a = document.createElement("a");
                a.href = url; a.download = `${table.name}.csv`; a.click();
                URL.revokeObjectURL(url);
                props.onInfo?.(`Downloaded ${rows.length} rows as ${table.name}.csv`);
              }}
            >⬇ CSV</button>
          ) : null}
          <button className="dataview-close" title="Close (Esc)" onClick={props.onClose}>✕</button>
        </div>
      </header>

      {tables.length > 0 ? (
        <div className="dataview-toolbar">
          <div className="dataview-tables">
            {tables.map(t => (
              <button key={t.name}
                className={`dataview-tab${t.name === selected ? " selected" : ""}`}
                onClick={() => void pick(t.name)}>{t.name}</button>
            ))}
          </div>
          <div className="dataview-toolbar-right">
            <input
              className="dataview-search"
              type="search"
              placeholder={`Search ${selected ?? ""}…`}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span className="dataview-count">
              {q !== "" ? `${visible.length} of ${rows.length}` : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>
      ) : null}

      {table ? (
        <div className="dataview-body">
          <table className="dataview-grid">
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c.name} title={`${c.type} — double-click to rename`}
                    onDoubleClick={() => {
                      if (c.type !== "computed") setRenamingCol({ from: c.name, value: c.name });
                    }}>
                    {renamingCol?.from === c.name ? (
                      <input
                        className="dataview-col-edit"
                        autoFocus
                        value={renamingCol.value}
                        onChange={e => setRenamingCol({ from: c.name, value: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === "Enter") void commitRenameColumn();
                          else if (e.key === "Escape") setRenamingCol(null);
                        }}
                        onBlur={() => void commitRenameColumn()}
                      />
                    ) : (
                      <>
                        {c.name}
                        {TYPE_HINT[c.type] ? <span className="dataview-type">{TYPE_HINT[c.type]}</span> : null}
                      </>
                    )}
                  </th>
                ))}
                <th className="dataview-addcol-th">
                  {addingCol ? (
                    <span className="dataview-addcol">
                      <input
                        className="dataview-col-edit"
                        autoFocus
                        aria-label="new column name"
                        placeholder="column name"
                        value={addingCol.name}
                        onChange={e => setAddingCol({ ...addingCol, name: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === "Enter") void commitAddColumn();
                          else if (e.key === "Escape") setAddingCol(null);
                        }}
                      />
                      <select
                        aria-label="new column type"
                        value={addingCol.type}
                        onChange={e => setAddingCol({ ...addingCol, type: e.target.value })}
                      >
                        <option value="text">text</option>
                        <option value="number">number</option>
                        <option value="date">date</option>
                        <option value="boolean">yes/no</option>
                      </select>
                      <button className="link" onClick={() => void commitAddColumn()}>✓</button>
                    </span>
                  ) : (
                    <button
                      className="link dataview-addcol-btn"
                      title="Add a column — instant, reversible on the timeline"
                      onClick={() => setAddingCol({ name: "", type: "text" })}
                    >＋ column</button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={String(r.id)}>
                  {columns.map(c => {
                    const isEditing = editing
                      && editing.rowId === String(r.id) && editing.col === c.name;
                    return (
                      <td key={c.name}
                        className={c.type === "computed" ? "cell-computed" : "cell-editable"}
                        onClick={() => {
                          if (c.type === "computed" || isEditing) return;
                          setEditing({ rowId: String(r.id), col: c.name,
                            draft: r[c.name] === null || r[c.name] === undefined
                              ? "" : String(r[c.name]) });
                        }}>
                        {isEditing
                          ? cellInput(c, editing.draft,
                              d => setEditing(e => e ? { ...e, draft: d } : e),
                              () => void commitEdit())
                          : r[c.name] === null || r[c.name] === undefined
                            ? "" : String(r[c.name])}
                      </td>
                    );
                  })}
                  <td className="cell-actions">
                    {restorable.has(String(r.id)) ? (
                      <button className="link"
                        title="This record has history — see and restore it"
                        onClick={() => void toggleHistory(String(r.id))}>
                        ⏱
                      </button>
                    ) : null}
                    <button className="link danger"
                      onClick={() => void act(() => store.softDelete(selected!, String(r.id)))}>
                      delete
                    </button>
                  </td>
                </tr>
              )).flatMap((tr, i) => {
                const r = visible[i]!;
                if (histFor?.id !== String(r.id)) return [tr];
                return [tr, (
                  <tr key={`${String(r.id)}-hist`} className="dataview-hist">
                    <td colSpan={columns.length + 2}>
                      <div className="dataview-hist-head">
                        This record’s history — newest first
                        <button className="link"
                          onClick={() => void act(async () => {
                            await worker.restoreRow(selected!, String(r.id));
                            setHistFor(null);
                          })}>
                          ↩ restore previous values
                        </button>
                      </div>
                      {histFor.entries.length === 0
                        ? <div className="dataview-hist-row">No snapshots in the last 30 days.</div>
                        : histFor.entries.map((e, j) => (
                          <div key={j} className="dataview-hist-row">
                            <span className="dataview-hist-at">{e.at.slice(0, 16).replace("T", " ")}</span>
                            <span>{columns.filter(c => e.values[c.name] !== undefined)
                              .slice(0, 4)
                              .map(c => `${c.name}: ${String(e.values[c.name] ?? "—")}`)
                              .join(" · ")}</span>
                          </div>
                        ))}
                    </td>
                  </tr>
                )];
              })}
              {visible.length === 0 && q !== "" ? (
                <tr><td className="dataview-nomatch" colSpan={columns.length + 1}>
                  No rows match “{search}”.
                </td></tr>
              ) : null}
              <tr className="dataview-new">
                {columns.map(c => (
                  <td key={c.name}>
                    {c.type === "computed" ? "" : cellInput(c, draftRow[c.name] ?? "",
                      v => setDraftRow(d => ({ ...d, [c.name]: v })))}
                  </td>
                ))}
                <td className="cell-actions">
                  <button className="primary" onClick={() => void addRow()}>+ Add</button>
                </td>
              </tr>
            </tbody>
          </table>

          {deleted.length > 0 ? (
            <details className="dataview-deleted">
              <summary>
                {deleted.length} deleted row{deleted.length === 1 ? "" : "s"} — kept, restore any time
              </summary>
              {deleted.map(r => (
                <div key={String(r.id)} className="dataview-deleted-row">
                  <span>{columns.slice(0, 3).map(c => String(r[c.name] ?? "")).join(" · ")}</span>
                  <button className="link"
                    onClick={() => void act(async () => worker.restoreRow(selected!, String(r.id)))}>
                    restore
                  </button>
                </div>
              ))}
            </details>
          ) : null}
        </div>
      ) : (
        <div className="dataview-empty">
          <p>No data yet.</p>
          <p className="dataview-empty-sub">Import a spreadsheet, or describe an app and Clay creates the tables for you.</p>
          <label className="empty-upload file-label">
            ⬆ Upload a spreadsheet (CSV or JSON)
            <input type="file" accept=".csv,.tsv,.txt,.json" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) props.onImport(f); e.target.value = ""; }} />
          </label>
        </div>
      )}
    </div>
  );
}
