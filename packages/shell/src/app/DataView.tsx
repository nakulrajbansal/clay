// The Data view (doc 01/W3): trusted, shell-rendered table editing —
// see every row, edit cells, add rows, soft-delete, and restore (G6:
// per-row snapshots from row_history; soft-deleted rows come back too).
// Designed as a spreadsheet the user already knows: tabs per table,
// click-any-cell editing, a search box, and a clear add-row.
import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type RefObject,
} from "react";
import type {
  AsyncStore, BatchReceipt, Query, QueryRow, QueryValue, RecordLink, RegTable,
  SemanticSchemaTraceV1,
} from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import { loadAllTableRows } from "./paged-query";
import { ModalDialog } from "./ModalDialog";
export { loadAllTableRows } from "./paged-query";
import {
  createOperationalView, deleteOperationalView, loadOperationalViews,
  reconcileOperationalViews, saveOperationalView,
  type OperationalViewLibrary,
} from "./operational-views";
import "./Operations.css";

const RecordDetail = lazy(() => import("./RecordDetail").then(module => ({
  default: module.RecordDetail,
})));
const RelationConversionDialog = lazy(() => import("./RelationConversionDialog").then(module => ({
  default: module.RelationConversionDialog,
})));

type EditingCell = { rowId: string; col: string; draft: string };
type ActiveFilter = NonNullable<Query["where"]>[number];
type SortOrder = NonNullable<Query["orderBy"]>[number];

function coerceDraft(type: string, draft: string): unknown {
  if (draft === "") return null;
  if (type === "number" || type === "integer") return Number(draft);
  if (type === "boolean") return draft === "true";
  return draft;
}

const TYPE_HINT: Record<string, string> = {
  number: "123", integer: "123", date: "date", enum: "pick",
  boolean: "y/n", computed: "auto", relation: "link", lookup: "live",
  rollup: "rollup", rich_text: "notes", attachment: "files",
};

function attachmentCount(value: QueryValue | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

export function reconcileVisibleFieldNames(
  current: ReadonlySet<string>, previous: readonly string[], next: readonly string[],
): Set<string> {
  const previousNames = new Set(previous);
  const nextNames = new Set(next);
  const reconciled = new Set([...current].filter(name => nextNames.has(name)));
  for (const name of next) if (!previousNames.has(name)) reconciled.add(name);
  if (reconciled.size === 0) for (const name of next) reconciled.add(name);
  return reconciled;
}

function displayValue(value: QueryValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  if (typeof value === "object") {
    const link = value as Partial<RecordLink>;
    if (typeof link.label === "string") return link.label;
    return JSON.stringify(value);
  }
  return String(value);
}

function accessibleRowLabel(table: RegTable, row: QueryRow): string {
  const column = table.columns.find(candidate => !candidate.hidden && !candidate.inactive
    && ["text", "rich_text", "enum"].includes(candidate.type));
  const human = column ? displayValue(row[column.name]) || "Untitled" : "Untitled";
  return `${human} (${String(row.id).slice(-6)})`;
}

const isDerived = (type: string): boolean =>
  type === "computed" || type === "lookup" || type === "rollup";

function matchesFilter(row: QueryRow, filter: ActiveFilter): boolean {
  const value = row[filter.field];
  if (filter.op === "is_null") return value === null || value === undefined;
  if (filter.op === "not_null") return value !== null && value !== undefined;
  if (filter.op === "contains") return displayValue(value).toLocaleLowerCase()
    .includes(String(filter.value ?? "").toLocaleLowerCase());
  if (filter.op === "eq" || filter.op === "neq") {
    const matches = displayValue(value) === String(filter.value ?? "");
    return filter.op === "eq" ? matches : !matches;
  }
  if (filter.op === "within_days" || filter.op === "older_than_days") {
    const date = displayValue(value).slice(0, 10);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return filter.op === "within_days" ? date === today : date !== "" && date < today;
  }
  return true;
}

export function DataView(props: {
  worker: WorkerClient;
  store: AsyncStore;
  initialTable?: string | null;
  initialRecordId?: string | null;
  onWrite: (table: string) => void;
  onImport: (file: File) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
  onConfirm?: (message: string) => Promise<boolean>;
  onSchemaChange?: () => void;
  onRecovery?: (result: "success" | "failed") => void;
}): React.JSX.Element {
  const { worker, store } = props;
  const [tables, setTables] = useState<RegTable[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [deleted, setDeleted] = useState<QueryRow[]>([]);
  const [restorable, setRestorable] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const cancelEditRef = useRef(false);
  const cancelRenameRef = useRef(false);
  const addRowPendingRef = useRef(false);
  const reloadTokenRef = useRef(0);
  const [addingRow, setAddingRow] = useState(false);
  const [draftRow, setDraftRow] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ActiveFilter | null>(null);
  const [sort, setSort] = useState<SortOrder | null>(null);
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set());
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [gridFocus, setGridFocus] = useState<{ row: number; column: number } | null>(null);
  const [bulkField, setBulkField] = useState("");
  const [bulkValue, setBulkValue] = useState("");
  const [lastBatch, setLastBatch] = useState<BatchReceipt | null>(null);
  const [viewLibrary, setViewLibrary] = useState<OperationalViewLibrary>({
    format: 1, revision: 0, views: [],
  });
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [semanticTrace, setSemanticTrace] = useState<SemanticSchemaTraceV1 | null>(null);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState("");
  const [detailStack, setDetailStack] = useState<{ table: string; id: string }[]>([]);
  const [showRelationDialog, setShowRelationDialog] = useState(false);
  const [samples, setSamples] = useState(0);
  // ADR-027: per-record history + local schema edits (no model call)
  const [histFor, setHistFor] = useState<{ id: string;
    entries: { at: string; values: Record<string, unknown> }[] } | null>(null);
  const [addingCol, setAddingCol] = useState<{
    name: string; type: string; targetTable?: string; cardinality?: "one" | "many";
  } | null>(null);
  const [renamingCol, setRenamingCol] = useState<{ from: string; value: string } | null>(null);

  useEffect(() => { setSelectedRows(new Set()); }, [selected, search, filter, activeViewId]);

  const toggleHistory = async (id: string): Promise<void> => {
    if (histFor?.id === id) { setHistFor(null); return; }
    setHistFor({ id, entries: await worker.rowHistory(selected!, id) });
  };
  const acceptRegistry = (
    nextTables: RegTable[], nextTrace: SemanticSchemaTraceV1,
  ): void => {
    const previous = tables.find(candidate => candidate.name === selected)?.columns
      .filter(column => !column.hidden && !column.inactive).map(column => column.name) ?? [];
    const next = nextTables.find(candidate => candidate.name === selected)?.columns
      .filter(column => !column.hidden && !column.inactive).map(column => column.name) ?? [];
    setVisibleFields(current => reconcileVisibleFieldNames(current, previous, next));
    setSemanticTrace(nextTrace);
    setViewLibrary(current => reconcileOperationalViews(current, nextTables, {}, nextTrace));
    setTables(nextTables);
  };
  const commitAddColumn = async (): Promise<void> => {
    if (!addingCol || !selected || addingCol.name.trim() === "") return;
    try {
      const column: Record<string, unknown> = {
        name: addingCol.name, type: addingCol.type, required: false,
      };
      if (addingCol.type === "relation") {
        const targetTable = addingCol.targetTable
          ?? tables.find(candidate => candidate.name !== selected)?.name;
        const target = tables.find(candidate => candidate.name === targetTable);
        if (!target) throw new Error("Choose a table to link");
        const display = target.columns.find(candidate => !candidate.hidden && !candidate.inactive
          && ["text", "enum", "rich_text"].includes(candidate.type));
        column.relation = {
          target_table: target.name, cardinality: addingCol.cardinality ?? "one",
          unique_targets: false, ...(display ? { display_field: display.name } : {}),
        };
      }
      const nextTables = await worker.addColumn(selected, column as never);
      acceptRegistry(nextTables, await worker.semanticTrace());
      setAddingCol(null);
      await reload(selected);
      props.onWrite(selected);
      props.onSchemaChange?.();
      props.onInfo(`Added “${addingCol.name}” — rewind the timeline to undo.`);
    } catch (e) { props.onError("Could not add column: " + (e as Error).message); }
  };

  const cancelAddingColumn = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setAddingCol(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".dataview-addcol-btn")?.focus());
  };

  const commitRenameColumn = async (): Promise<void> => {
    if (cancelRenameRef.current) { cancelRenameRef.current = false; return; }
    if (!renamingCol || !selected) return;
    const { from, value } = renamingCol;
    setRenamingCol(null);
    if (value.trim() === "" || value === from) return;
    try {
      const nextTables = await worker.renameColumn(selected, from, value);
      acceptRegistry(nextTables, await worker.semanticTrace());
      await reload(selected);
      props.onWrite(selected);
      props.onSchemaChange?.();
      props.onInfo(`Renamed “${from}” to “${value}” — panels updated too.`);
    } catch (e) { props.onError("Could not rename: " + (e as Error).message); }
  };

  const table = tables.find(t => t.name === selected) ?? null;
  const allColumns = table?.columns.filter(c => !c.hidden && !c.inactive) ?? [];
  const columns = visibleFields.size === 0 ? allColumns
    : allColumns.filter(column => visibleFields.has(column.name));
  const detail = detailStack.at(-1) ?? null;
  const detailTable = detail ? tables.find(candidate => candidate.name === detail.table) ?? null : null;

  const reload = useCallback(async (name: string): Promise<void> => {
    const token = ++reloadTokenRef.current;
    const [activeRows, deletedRows, restorableRows] = await Promise.all([
      loadAllTableRows(store, name),
      loadAllTableRows(store, name, { deleted: true }),
      worker.restorableRows(name),
    ]);
    if (token !== reloadTokenRef.current) return;
    setRows(activeRows);
    setDeleted(deletedRows);
    setRestorable(new Set(restorableRows));
  }, [store, worker]);

  useEffect(() => () => { reloadTokenRef.current++; }, []);

  useEffect(() => {
    void (async () => {
      const [t, trace, rawViews] = await Promise.all([
        worker.registryTables(), worker.semanticTrace(),
        worker.getSetting("operational_views_v1"),
      ]);
      setTables(t);
      setSemanticTrace(trace);
      setViewLibrary(reconcileOperationalViews(loadOperationalViews(rawViews), t, {}, trace));
      setSamples(await worker.sampleCount());
      const recentBatches = await worker.operationBatches(1);
      setLastBatch(recentBatches[0] && !recentBatches[0].undone ? recentBatches[0] : null);
      if (t.length > 0) {
        const want = props.initialTable && t.some(x => x.name === props.initialTable)
          ? props.initialTable : t[0]!.name;
        setSelected(want);
        setVisibleFields(new Set(t.find(candidate => candidate.name === want)!
          .columns.filter(column => !column.hidden && !column.inactive).map(column => column.name)));
        await reload(want);
        if (props.initialRecordId)
          setDetailStack([{ table: want, id: props.initialRecordId }]);
      }
    })();
  }, [worker, reload, props.initialTable, props.initialRecordId]);

  // Esc pops the deepest trusted surface first, then cancels a cell edit,
  // then closes the data workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || showRelationDialog) return;
      if (detailStack.length > 0) {
        setDetailStack(stack => stack.slice(0, -1)); return;
      }
      if (editing) { setEditing(null); return; }
      props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return (): void => window.removeEventListener("keydown", onKey);
  }, [detailStack.length, editing, props.onClose, showRelationDialog]);

  const pick = async (name: string): Promise<void> => {
    setSelected(name);
    setEditing(null);
    setDraftRow({});
    setSearch("");
    setFilter(null);
    setSort(null);
    setSelectedRows(new Set());
    const next = tables.find(table => table.name === name);
    setVisibleFields(new Set(next?.columns.filter(column => !column.hidden && !column.inactive)
      .map(column => column.name) ?? []));
    setDetailStack([]);
    await reload(name);
  };

  const act = async (
    fn: () => Promise<unknown>,
    recovery = false,
  ): Promise<boolean> => {
    if (!selected) return false;
    try {
      await fn();
      await reload(selected);
      props.onWrite(selected);
      if (recovery) props.onRecovery?.("success");
      return true;
    } catch (e) {
      if (recovery) props.onRecovery?.("failed");
      props.onError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const cancelEdit = (): void => {
    cancelEditRef.current = true;
    setEditing(null);
  };

  const commitEdit = async (): Promise<void> => {
    if (cancelEditRef.current) { cancelEditRef.current = false; return; }
    if (!editing || !selected) return;
    cancelEditRef.current = false;
    const col = columns.find(c => c.name === editing.col);
    const cell = editing;
    setEditing(null);
    if (!col || isDerived(col.type) || col.type === "relation"
        || col.type === "rich_text" || col.type === "attachment") return;
    const saved = await act(() => store.update(selected, cell.rowId,
      { [cell.col]: coerceDraft(col.type, cell.draft) }));
    if (!saved) setEditing(cell);
  };

  const addRow = async (): Promise<void> => {
    if (!selected || addRowPendingRef.current) return;
    addRowPendingRef.current = true;
    setAddingRow(true);
    const row: Record<string, unknown> = {};
    for (const c of columns) {
      if (isDerived(c.type) || c.type === "relation" || c.type === "attachment") continue;
      const draft = draftRow[c.name] ?? "";
      if (draft === "") continue;
      row[c.name] = coerceDraft(c.type, draft);
    }
    try {
      if (await act(() => store.insert(selected, row))) setDraftRow({});
    } finally {
      addRowPendingRef.current = false;
      setAddingRow(false);
    }
  };

  const cellInput = (c: RegTable["columns"][number],
    value: string, onChange: (v: string) => void,
    commit?: () => void): React.JSX.Element => {
    if (c.type === "boolean") {
      return (
        <select value={value} autoFocus={commit !== undefined} aria-label={c.name}
          onChange={e => onChange(e.target.value)} onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter" && commit) commit();
            if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
          }}>
          <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
        </select>
      );
    }
    if (c.type === "enum") {
      return (
        <select value={value} autoFocus={commit !== undefined} aria-label={c.name}
          onChange={e => { onChange(e.target.value); }} onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter" && commit) commit();
            if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
          }}>
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
          if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
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
    if (props.onConfirm && !await props.onConfirm(
      "Clear all generated sample rows? Your own records stay untouched, and samples remain restorable.")) return;
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

  const applyOperationalView = (view: OperationalViewLibrary["views"][number]): void => {
    if (view.table !== selected) void pick(view.table);
    setSearch(view.search);
    setFilter(view.filters[0] ?? null);
    setSort(view.orderBy[0] ?? null);
    setVisibleFields(new Set(view.visibleFields));
    setSelectedRows(new Set());
    setActiveViewId(view.id);
  };

  const saveCurrentView = async (): Promise<void> => {
    if (!table || !viewName.trim()) return;
    try {
      const tableSemantic = semanticTrace?.tables.find(candidate =>
        candidate.name === table.name && candidate.state === "visible");
      if (!tableSemantic) throw new Error("Stable table identity is not ready. Reopen Data and try again.");
      const fieldId = (name: string): string => {
        const field = semanticTrace?.fields.find(candidate =>
          candidate.tableId === tableSemantic.tableId && candidate.fieldName === name
            && candidate.state === "visible");
        if (!field) throw new Error(`Stable identity for “${name}” is not ready`);
        return field.fieldId;
      };
      const view = createOperationalView({
        name: viewName, table: table.name, search,
        filters: filter ? [filter] : [], orderBy: sort ? [sort] : [],
        visibleFields: columns.map(column => column.name),
        identity: {
          tableId: tableSemantic.tableId,
          filterFieldIds: filter ? [fieldId(filter.field)] : [],
          orderFieldIds: sort ? [fieldId(sort.field)] : [],
          visibleFieldIds: columns.map(column => fieldId(column.name)),
        },
      });
      setViewLibrary(await saveOperationalView(worker, view));
      setActiveViewId(view.id);
      setViewName(""); setSavingView(false);
      props.onInfo(`Saved “${view.name}” for daily use.`);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const removeView = async (id: string): Promise<void> => {
    try { setViewLibrary(await deleteOperationalView(worker, id)); }
    catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const runBulkUpdate = async (): Promise<void> => {
    if (!selected || !bulkField || selectedRows.size === 0) return;
    const column = allColumns.find(candidate => candidate.name === bulkField);
    if (!column) return;
    try {
      const receipt = await worker.applyBatch(
        `Update ${selectedRows.size} ${selected.replace(/_/g, " ")} records`,
        [...selectedRows].map(id => ({
          kind: "update" as const, table: selected, id,
          patch: { [bulkField]: coerceDraft(column.type, bulkValue) },
        })),
      );
      setLastBatch(receipt); setSelectedRows(new Set()); setBulkValue("");
      await reload(selected); props.onWrite(selected);
      props.onInfo(`Updated ${receipt.changed} records. Undo is available here.`);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const runBulkArchive = async (): Promise<void> => {
    if (!selected || selectedRows.size === 0) return;
    if (props.onConfirm && !await props.onConfirm(
      `Archive ${selectedRows.size} selected record${selectedRows.size === 1 ? "" : "s"}? You can undo this batch.`)) return;
    try {
      const receipt = await worker.applyBatch(
        `Archive ${selectedRows.size} selected ${selected.replace(/_/g, " ")}`,
        [...selectedRows].map(id => ({ kind: "soft_delete" as const, table: selected, id })),
      );
      setLastBatch(receipt); setSelectedRows(new Set());
      await reload(selected); props.onWrite(selected);
      props.onInfo(`Archived ${receipt.changed} records. Undo is available here.`);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const undoLastBatch = async (): Promise<void> => {
    if (!lastBatch || lastBatch.undone) return;
    try {
      const undone = await worker.undoBatch(lastBatch.id);
      setLastBatch(undone);
      if (selected) { await reload(selected); props.onWrite(selected); }
      props.onInfo(`Undid “${undone.summary}”.`);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const q = search.trim().toLowerCase();
  let visible = q === "" ? [...rows] : rows.filter(r =>
    allColumns.some(c => displayValue(r[c.name]).toLowerCase().includes(q)));
  if (filter) visible = visible.filter(row => matchesFilter(row, filter));
  if (sort) {
    visible.sort((left, right) => {
      const a = displayValue(left[sort.field]);
      const b = displayValue(right[sort.field]);
      return (a.localeCompare(b, undefined, { numeric: true }) || 0)
        * (sort.dir === "asc" ? 1 : -1);
    });
  }

  const focusedGridCell = gridFocus && gridFocus.row < visible.length
      && gridFocus.column < columns.length ? gridFocus : { row: 0, column: 0 };
  const focusGridCell = (row: number, column: number): void => {
    const next = {
      row: Math.max(0, Math.min(visible.length - 1, row)),
      column: Math.max(0, Math.min(columns.length - 1, column)),
    };
    setGridFocus(next);
    requestAnimationFrame(() => {
      [...document.querySelectorAll<HTMLElement>("td[data-grid-cell]")]
        .find(cell => Number(cell.dataset.gridRow) === next.row
          && Number(cell.dataset.gridColumn) === next.column)?.focus();
    });
  };

  return (
    <ModalDialog className="dataview" backdropClassName="modal-backdrop dataview-backdrop"
      ariaLabel="Your data" onClose={props.onClose} returnFocusRef={props.returnFocusRef}>
      <header className="dataview-header">
        <div className="dataview-title">
          <strong>Your data</strong>
          <span className="dataview-hint">click any cell to edit — every change is saved and reversible</span>
        </div>
        <div className="dataview-header-actions">
          {table && tables.length > 1 && table.columns.some(column =>
            !column.hidden && !column.inactive
              && ["text", "enum", "rich_text"].includes(column.type)) ? (
            <button className="dataview-connect" onClick={() => setShowRelationDialog(true)}
              title="Turn an existing text field into safe linked records">
              ⛓ Connect records
            </button>
          ) : null}
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
            <input className="visually-hidden-file" type="file" aria-label="Import CSV or JSON"
              accept=".csv,.tsv,.txt,.json"
              onChange={e => { const f = e.target.files?.[0]; if (f) props.onImport(f); e.target.value = ""; }} />
          </label>
          {table ? (
            <button
              className="dataview-import"
              title={`Download “${table.name}” as a spreadsheet — your data is always yours`}
              onClick={() => {
                const esc = (v: unknown): string => {
                  const s = typeof v === "object" && v !== null
                    ? displayValue(v as QueryValue) : String(v ?? "");
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
          <button className="dataview-close" aria-label="Close data view"
            title="Close (Esc)" onClick={props.onClose}>✕</button>
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
              onChange={e => { setSearch(e.target.value); setActiveViewId(null); }}
            />
            <span className="dataview-count">
              {q !== "" || filter ? `${visible.length} of ${rows.length}` : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>
      ) : null}

      {table ? (
        <div className="workbench-bar" aria-label="Operational views and filters">
          <div className="workbench-views">
            <button className={!filter && !search && !sort && !activeViewId ? "selected" : ""}
              onClick={() => { setSearch(""); setFilter(null); setSort(null); setActiveViewId(null); }}>All</button>
            {allColumns.find(column => column.type === "date") ? (
              <>
                <button className={filter?.op === "within_days" ? "selected" : ""}
                  onClick={() => {
                    const date = allColumns.find(column => column.type === "date")!;
                    setFilter({ field: date.name, op: "within_days", value: 0 });
                    setSort({ field: date.name, dir: "asc" });
                  }}>Today</button>
                <button className={filter?.op === "older_than_days" ? "selected" : ""}
                  onClick={() => {
                    const date = allColumns.find(column => column.type === "date")!;
                    setFilter({ field: date.name, op: "older_than_days", value: 0 });
                    setSort({ field: date.name, dir: "asc" });
                  }}>Overdue</button>
              </>
            ) : null}
            {viewLibrary.views.filter(view => view.table === table.name).map(view => (
              <span className="saved-work-view" key={view.id}>
                <button className={activeViewId === view.id ? "selected" : ""}
                  aria-pressed={activeViewId === view.id}
                  onClick={() => applyOperationalView(view)}>{view.name}</button>
                <button aria-label={`Delete ${view.name} view`}
                  onClick={() => void removeView(view.id)}>×</button>
              </span>
            ))}
          </div>
          <div className="workbench-tools">
            {allColumns.some(column => column.type === "enum") ? (
              <select aria-label="Filter records"
                value={filter?.op === "eq" ? `${filter.field}\u0000${String(filter.value ?? "")}` : ""}
                onChange={event => {
                  setActiveViewId(null);
                  if (!event.target.value) { setFilter(null); return; }
                  const [field, value] = event.target.value.split("\u0000");
                  if (field && value) setFilter({ field, op: "eq", value });
                }}>
                <option value="">Filter…</option>
                {allColumns.filter(column => column.type === "enum").flatMap(column =>
                  (column.values ?? []).map(value => (
                    <option key={`${column.name}:${value}`} value={`${column.name}\u0000${value}`}>
                      {column.label ?? column.name}: {value}
                    </option>
                  )))}
              </select>
            ) : null}
            <details className="field-picker">
              <summary>Fields {columns.length}/{allColumns.length}</summary>
              <div>
                {allColumns.map(column => (
                  <label key={column.name}>
                    <input type="checkbox" checked={visibleFields.has(column.name)}
                      onChange={event => setVisibleFields(current => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(column.name);
                        else if (next.size > 1) next.delete(column.name);
                        return next;
                      })} />
                    {column.label ?? column.name.replace(/_/g, " ")}
                  </label>
                ))}
              </div>
            </details>
            {savingView ? (
              <span className="save-work-view">
                <input autoFocus value={viewName} placeholder="View name"
                  onChange={event => setViewName(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter") void saveCurrentView();
                    if (event.key === "Escape") {
                      event.preventDefault(); event.stopPropagation(); setSavingView(false);
                      requestAnimationFrame(() => document.querySelector<HTMLElement>(".save-view-button")?.focus());
                    }
                  }} />
                <button onClick={() => void saveCurrentView()}>Save</button>
              </span>
            ) : <button className="save-view-button" onClick={() => setSavingView(true)}>＋ Save view</button>}
            {lastBatch && !lastBatch.undone ? (
              <button className="workbench-undo" onClick={() => void undoLastBatch()}>
                ↩ Undo {lastBatch.changed}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {selectedRows.size > 0 && table ? (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <strong>{selectedRows.size} selected</strong>
          <select aria-label="Field to update" value={bulkField}
            onChange={event => { setBulkField(event.target.value); setBulkValue(""); }}>
            <option value="">Choose field…</option>
            {allColumns.filter(column => !isDerived(column.type)
              && column.type !== "relation" && column.type !== "attachment"
              && column.type !== "json" && column.type !== "rich_text").map(column => (
              <option key={column.name} value={column.name}>{column.label ?? column.name}</option>
            ))}
          </select>
          {bulkField ? cellInput(allColumns.find(column => column.name === bulkField)!, bulkValue,
            setBulkValue) : null}
          <button className="primary" disabled={!bulkField} onClick={() => void runBulkUpdate()}>
            Apply to {selectedRows.size}
          </button>
          <button className="danger" onClick={() => void runBulkArchive()}>Archive</button>
          <button className="link" onClick={() => setSelectedRows(new Set())}>Clear</button>
        </div>
      ) : null}

      {table ? (
        <div className="dataview-body">
          <table className="dataview-grid" role="grid" aria-rowcount={visible.length + 1}>
            <thead>
              <tr>
                <th className="dataview-select-cell">
                  <input type="checkbox" aria-label="Select all visible records"
                    checked={visible.length > 0 && visible.every(row => selectedRows.has(String(row.id)))}
                    onChange={event => setSelectedRows(current => {
                      const next = new Set(current);
                      for (const row of visible) {
                        const id = String(row.id);
                        if (event.target.checked) next.add(id); else next.delete(id);
                      }
                      return next;
                    })} />
                </th>
                {columns.map(c => (
                  <th key={c.name} title={`${c.type} column`}>
                    {renamingCol?.from === c.name ? (
                      <input
                        className="dataview-col-edit"
                        autoFocus
                        value={renamingCol.value}
                        onChange={e => setRenamingCol({ from: c.name, value: e.target.value })}
                        onClick={event => event.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === "Enter") void commitRenameColumn();
                          else if (e.key === "Escape") {
                            e.preventDefault(); e.stopPropagation(); cancelRenameRef.current = true;
                            setRenamingCol(null);
                            requestAnimationFrame(() => document.querySelector<HTMLElement>(
                              `button[aria-label="Rename ${c.label ?? c.name} column"]`)?.focus());
                          }
                        }}
                        onBlur={() => void commitRenameColumn()}
                      />
                    ) : (
                      <span className="dataview-column-controls">
                        <button className="dataview-sort-button"
                          aria-label={`Sort by ${c.label ?? c.name}`}
                          onClick={() => { setActiveViewId(null); setSort(current => current?.field === c.name
                            ? { field: c.name, dir: current.dir === "asc" ? "desc" : "asc" }
                            : { field: c.name, dir: "asc" }); }}>
                          {c.label ?? c.name.replace(/_/g, " ")}
                          {TYPE_HINT[c.type] ? <span className="dataview-type">{TYPE_HINT[c.type]}</span> : null}
                          {sort?.field === c.name ? <span className="dataview-sort" aria-hidden="true">
                            {sort.dir === "asc" ? " ↑" : " ↓"}
                          </span> : null}
                        </button>
                        {!isDerived(c.type) ? <button className="dataview-rename-button"
                          aria-label={`Rename ${c.label ?? c.name} column`}
                          onClick={() => { cancelRenameRef.current = false;
                            setRenamingCol({ from: c.name, value: c.name }); }}>✎</button> : null}
                      </span>
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
                          else cancelAddingColumn(e);
                        }}
                      />
                      <select
                        aria-label="new column type"
                        value={addingCol.type}
                        onChange={e => setAddingCol({ ...addingCol, type: e.target.value })}
                        onKeyDown={cancelAddingColumn}
                      >
                        <option value="text">text</option>
                        <option value="number">number</option>
                        <option value="date">date</option>
                        <option value="boolean">yes/no</option>
                        <option value="rich_text">rich notes</option>
                        <option value="attachment">files</option>
                        {tables.length > 1 ? <option value="relation">linked record</option> : null}
                      </select>
                      {addingCol.type === "relation" ? (
                        <>
                          <select aria-label="linked table"
                            value={addingCol.targetTable ?? tables.find(candidate => candidate.name !== selected)?.name ?? ""}
                            onChange={event => setAddingCol({ ...addingCol, targetTable: event.target.value })}
                            onKeyDown={cancelAddingColumn}>
                            {tables.filter(candidate => candidate.name !== selected).map(candidate => (
                              <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
                            ))}
                          </select>
                          <select aria-label="linked record cardinality"
                            value={addingCol.cardinality ?? "one"}
                            onChange={event => setAddingCol({ ...addingCol,
                              cardinality: event.target.value as "one" | "many" })}
                            onKeyDown={cancelAddingColumn}>
                            <option value="one">one record</option>
                            <option value="many">many records</option>
                          </select>
                        </>
                      ) : null}
                      <button className="link" onClick={() => void commitAddColumn()}>✓</button>
                    </span>
                  ) : (
                    <button
                      className="link dataview-addcol-btn"
                      title="Add a column — instant, reversible on the timeline"
                      onClick={() => setAddingCol({ name: "", type: "text",
                        targetTable: tables.find(candidate => candidate.name !== selected)?.name })}>
                      ＋ column</button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, rowIndex) => (
                <tr key={String(r.id)}>
                  <td className="dataview-select-cell">
                    <input type="checkbox" aria-label={`Select ${accessibleRowLabel(table, r)}`}
                      checked={selectedRows.has(String(r.id))}
                      onChange={event => setSelectedRows(current => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(String(r.id)); else next.delete(String(r.id));
                        return next;
                      })} />
                  </td>
                  {columns.map((c, columnIndex) => {
                    const isEditing = editing
                      && editing.rowId === String(r.id) && editing.col === c.name;
                    const activateCell = (): void => {
                      if (isDerived(c.type) || c.type === "relation"
                          || c.type === "rich_text" || c.type === "attachment") {
                        setDetailStack([{ table: selected!, id: String(r.id) }]);
                        return;
                      }
                      if (!isEditing) setEditing({ rowId: String(r.id), col: c.name,
                        draft: displayValue(r[c.name]) });
                    };
                    return (
                      <td key={c.name}
                        className={isDerived(c.type) ? "cell-computed"
                          : c.type === "relation" ? "cell-relation"
                            : c.type === "rich_text" || c.type === "attachment"
                              ? "cell-detail" : "cell-editable"}
                        data-grid-cell="" data-grid-row={rowIndex} data-grid-column={columnIndex}
                        tabIndex={isEditing ? -1
                          : focusedGridCell.row === rowIndex && focusedGridCell.column === columnIndex ? 0 : -1}
                        aria-label={`${c.label ?? c.name} for ${accessibleRowLabel(table, r)}`}
                        onFocus={() => setGridFocus({ row: rowIndex, column: columnIndex })}
                        onKeyDown={event => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === "F2") {
                            event.preventDefault(); activateCell(); return;
                          }
                          let nextRow = rowIndex;
                          let nextColumn = columnIndex;
                          if (event.key === "ArrowDown") nextRow++;
                          else if (event.key === "ArrowUp") nextRow--;
                          else if (event.key === "ArrowRight") nextColumn++;
                          else if (event.key === "ArrowLeft") nextColumn--;
                          else if (event.key === "Home") nextColumn = 0;
                          else if (event.key === "End") nextColumn = columns.length - 1;
                          else if (event.key === "PageDown") nextRow += 10;
                          else if (event.key === "PageUp") nextRow -= 10;
                          else return;
                          event.preventDefault(); focusGridCell(nextRow, nextColumn);
                        }}
                        onClick={activateCell}>
                        {isEditing
                          ? cellInput(c, editing.draft,
                              d => setEditing(e => e ? { ...e, draft: d } : e),
                              () => void commitEdit())
                          : c.type === "attachment" ? (
                            <span className="dataview-file-count">
                              {attachmentCount(r[c.name])} file{attachmentCount(r[c.name]) === 1 ? "" : "s"}
                            </span>
                          ) : c.type === "relation" && displayValue(r[c.name]) ? (
                            <span className="dataview-link-value">
                              {displayValue(r[c.name])}<span aria-hidden="true"> ↗</span>
                            </span>
                          ) : displayValue(r[c.name])}
                      </td>
                    );
                  })}
                  <td className="cell-actions">
                    <button className="link" title="Open record details"
                      aria-label={`Open ${accessibleRowLabel(table, r)} record details`}
                      onClick={() => setDetailStack([{ table: selected!, id: String(r.id) }])}>
                      open
                    </button>
                    {restorable.has(String(r.id)) ? (
                      <button className="link"
                        aria-label={`Show history for ${accessibleRowLabel(table, r)}`}
                        title="This record has history — see and restore it"
                        onClick={() => void toggleHistory(String(r.id))}>
                        ⏱
                      </button>
                    ) : null}
                    <button className="link danger"
                      aria-label={`Archive ${accessibleRowLabel(table, r)}`}
                      onClick={() => void (async () => {
                        if (props.onConfirm && !await props.onConfirm(
                          "Archive this record? Its history remains recoverable.")) return;
                        await act(() => store.softDelete(selected!, String(r.id)));
                      })()}>
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
                          }, true)}>
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
              {visible.length === 0 && (q !== "" || filter) ? (
                <tr><td className="dataview-nomatch" colSpan={columns.length + 2}>
                  No records match this view.
                </td></tr>
              ) : null}
              <tr className="dataview-new">
                <td className="dataview-select-cell" />
                {columns.map(c => (
                  <td key={c.name}>
                    {isDerived(c.type) || c.type === "relation" || c.type === "attachment"
                      ? "" : cellInput(c, draftRow[c.name] ?? "",
                      v => setDraftRow(d => ({ ...d, [c.name]: v })))}
                  </td>
                ))}
                <td className="cell-actions">
                  <button className="primary" disabled={addingRow}
                    onClick={() => void addRow()}>{addingRow ? "Adding…" : "+ Add"}</button>
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
                  <span>{columns.slice(0, 3).map(c => displayValue(r[c.name])).join(" · ")}</span>
                  <button className="link"
                    onClick={() => void act(async () => worker.restoreRow(selected!, String(r.id)), true)}>
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
            <input className="visually-hidden-file" type="file"
              aria-label="Upload a CSV or JSON spreadsheet" accept=".csv,.tsv,.txt,.json"
              onChange={e => { const f = e.target.files?.[0]; if (f) props.onImport(f); e.target.value = ""; }} />
          </label>
        </div>
      )}
      {detail && detailTable ? (
        <Suspense fallback={<div className="record-detail-loading" role="status">Loading record…</div>}>
        <RecordDetail
          table={detailTable}
          recordId={detail.id}
          tables={tables}
          store={store}
          worker={worker}
          onNavigate={(nextTable, id) => setDetailStack(stack => [
            ...stack, { table: nextTable, id },
          ])}
          onClose={() => setDetailStack(stack => stack.slice(0, -1))}
          onWrite={changedTable => {
            props.onWrite(changedTable);
            if (changedTable === selected) void reload(changedTable);
          }}
          onError={props.onError}
          onInfo={props.onInfo}
          onConfirm={props.onConfirm}
        />
        </Suspense>
      ) : null}
      {showRelationDialog && table ? (
        <Suspense fallback={<div className="relation-dialog-loading" role="status">Preparing connection preview…</div>}>
        <RelationConversionDialog
          sourceTable={table}
          tables={tables}
          worker={worker}
          onClose={() => setShowRelationDialog(false)}
          onError={props.onError}
          onCommitted={result => {
            void (async () => {
              setShowRelationDialog(false);
              const [nextTables, nextTrace] = await Promise.all([
                worker.registryTables(), worker.semanticTrace(),
              ]);
              acceptRegistry(nextTables, nextTrace);
              await reload(table.name);
              props.onWrite(table.name);
              props.onSchemaChange?.();
              props.onInfo(`Connected ${result.convertedRows} rows. Rewind the timeline to undo.`);
            })();
          }}
        />
        </Suspense>
      ) : null}
    </ModalDialog>
  );
}
