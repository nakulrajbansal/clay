// The Data view (doc 01/W3): trusted, shell-rendered table editing —
// see every row, edit cells, add rows, soft-delete, and restore (G6:
// per-row snapshots from row_history; soft-deleted rows come back too).
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

export function DataView(props: {
  worker: WorkerClient;
  store: AsyncStore;
  onWrite: (table: string) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}): React.JSX.Element {
  const { worker, store } = props;
  const [tables, setTables] = useState<RegTable[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [deleted, setDeleted] = useState<QueryRow[]>([]);
  const [restorable, setRestorable] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draftRow, setDraftRow] = useState<Record<string, string>>({});

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
      if (t.length > 0) {
        setSelected(t[0]!.name);
        await reload(t[0]!.name);
      }
    })();
  }, [worker, reload]);

  const pick = async (name: string): Promise<void> => {
    setSelected(name);
    setEditing(null);
    setDraftRow({});
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
        <select value={value} onChange={e => { onChange(e.target.value); }} onBlur={commit}>
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
        onChange={e => onChange(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter" && commit) commit(); }}
      />
    );
  };

  return (
    <div className="dataview">
      <header className="dataview-header">
        <strong>Data</strong>
        <div className="dataview-tables">
          {tables.map(t => (
            <button key={t.name}
              className={t.name === selected ? "primary" : ""}
              onClick={() => void pick(t.name)}>{t.name}</button>
          ))}
        </div>
        <button className="link" onClick={props.onClose}>close</button>
      </header>

      {table ? (
        <div className="dataview-body">
          <table className="dataview-grid">
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c.name}>{c.name}{c.type === "computed" ? " ⨍" : ""}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
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
                        onClick={() => void act(async () => worker.restoreRow(selected!, String(r.id)))}>
                        undo
                      </button>
                    ) : null}
                    <button className="link danger"
                      onClick={() => void act(() => store.softDelete(selected!, String(r.id)))}>
                      delete
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="dataview-new">
                {columns.map(c => (
                  <td key={c.name}>
                    {c.type === "computed" ? "" : cellInput(c, draftRow[c.name] ?? "",
                      v => setDraftRow(d => ({ ...d, [c.name]: v })))}
                  </td>
                ))}
                <td className="cell-actions">
                  <button className="primary" onClick={() => void addRow()}>Add</button>
                </td>
              </tr>
            </tbody>
          </table>

          {deleted.length > 0 ? (
            <div className="dataview-deleted">
              <strong>Deleted rows</strong> (kept — restore any time)
              {deleted.map(r => (
                <div key={String(r.id)} className="dataview-deleted-row">
                  <span>{columns.slice(0, 3).map(c => String(r[c.name] ?? "")).join(" · ")}</span>
                  <button className="link"
                    onClick={() => void act(async () => worker.restoreRow(selected!, String(r.id)))}>
                    restore
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : <p className="dataview-empty">No tables yet.</p>}
    </div>
  );
}
