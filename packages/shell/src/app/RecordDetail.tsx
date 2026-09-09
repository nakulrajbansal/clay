import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AsyncStore, AttachmentMetadata, QueryRow, QueryValue, RecordLink, RegColumn, RegTable,
} from "@clay/kernel";
import { createStoreMutationContext } from "@clay/kernel/shell-runtime";
import type { WorkerClient } from "./worker-client";
import type { FirstSuccessState } from "./first-success-state";
import { loadAllTableRows } from "./paged-query";
import { ModalDialog } from "./ModalDialog";

const MAX_BROWSER_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function attachmentSelectionError(
  file: Pick<File, "name" | "size" | "type">,
): string | null {
  if (file.size > MAX_BROWSER_ATTACHMENT_BYTES)
    return `“${file.name}” is larger than the 10 MB per-file limit.`;
  return null;
}

const isRecordLink = (value: unknown): value is RecordLink => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const link = value as Partial<RecordLink>;
  return typeof link.id === "string" && typeof link.label === "string"
    && typeof link.table === "string";
};

function relationIds(value: QueryValue | undefined): string[] {
  if (isRecordLink(value)) return [value.id];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordLink).map(link => link.id);
}

function displayValue(value: QueryValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (isRecordLink(value)) return value.label;
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fieldLabel(column: RegColumn): string {
  return column.label ?? column.name.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
}

function isDerived(column: RegColumn): boolean {
  return column.type === "computed" || column.type === "lookup" || column.type === "rollup";
}

function hasScalarDraft(column: RegColumn): boolean {
  return !isDerived(column) && column.type !== "relation" && column.type !== "attachment";
}

function coerce(column: RegColumn, value: string | boolean): unknown {
  if (typeof value === "boolean") return value;
  if (value === "") return null;
  if (column.type === "number" || column.type === "integer") return Number(value);
  return value;
}

function rowLabel(table: RegTable, row: QueryRow): string {
  const column = table.columns.find(candidate => !candidate.hidden && !candidate.inactive
    && (candidate.type === "text" || candidate.type === "rich_text" || candidate.type === "enum"));
  return column ? displayValue(row[column.name]) || "Untitled" : String(row.id).slice(0, 8);
}

type RelatedGroup = {
  table: RegTable;
  relation: RegColumn;
  rows: QueryRow[];
};

export type RichTextFieldIdentity = Readonly<{
  table: string;
  recordId: string;
  field: string;
}>;

export type RichTextDraftSnapshot = Readonly<{
  value: string;
  generation: number;
  dirty: boolean;
  pending: boolean;
}>;

export type RichTextSaveIntent = Readonly<{
  value: string | null;
  generation: number;
}>;

export type RichTextSaveCoordinator = {
  richTextDraft: (identity: RichTextFieldIdentity) => RichTextDraftSnapshot | null;
  updateRichTextDraft: (
    identity: RichTextFieldIdentity, value: string, dirty: boolean,
  ) => RichTextDraftSnapshot;
  reconcileRichTextDraft: (identity: RichTextFieldIdentity, canonicalValue: string) => string;
  hasPendingRichTextSave: (identity: RichTextFieldIdentity) => boolean;
  queueRichTextSave: (
    identity: RichTextFieldIdentity,
    operation: (intent: RichTextSaveIntent) => Promise<void>,
  ) => Promise<void> | null;
};

function inlineMarkdown(line: string): ReactNode[] {
  const parts = line.split(/(\*\*[^*]+\*\*|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^)]+\))/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("_") && part.endsWith("_"))
      return <em key={index}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return part;
  });
}

function RichNoteEditor(props: {
  label: string; value: string; canonicalValue: string; disabled: boolean;
  isSavePending: () => boolean;
  onChange: (value: string, dirty: boolean) => void;
  onSave: (value: string | null) => void | Promise<void>;
}): React.JSX.Element {
  const [preview, setPreview] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const formattingDisabled = props.disabled || props.isSavePending();
  const wrap = (before: string, after = before): void => {
    if (props.disabled || props.isSavePending()) return;
    const input = ref.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = props.value.slice(start, end) || "text";
    const next = `${props.value.slice(0, start)}${before}${selected}${after}${props.value.slice(end)}`;
    props.onChange(next, true);
    void props.onSave(next || null);
    requestAnimationFrame(() => {
      if (props.isSavePending()) return;
      input.focus(); input.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };
  return <div className="rich-note-editor">
    <div className="rich-note-toolbar" role="toolbar" aria-label="Note formatting">
      <button type="button" title="Bold" disabled={formattingDisabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("**")}>B</button>
      <button type="button" title="Italic" disabled={formattingDisabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("_")}><em>I</em></button>
      <button type="button" title="Bulleted line" disabled={formattingDisabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("- ", "")}>• List</button>
      <button type="button" title="Link" disabled={formattingDisabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("[", "](https://)")}>Link</button>
      <button type="button" className={preview ? "active" : ""}
        onClick={() => setPreview(value => !value)}>{preview ? "Edit" : "Preview"}</button>
    </div>
    {preview ? <div className="rich-note-preview">
      {props.value.split("\n").map((line, index) => line.startsWith("- ")
        ? <div className="rich-note-bullet" key={index}>• {inlineMarkdown(line.slice(2))}</div>
        : <p key={index}>{line ? inlineMarkdown(line) : " "}</p>)}
    </div> : <textarea ref={ref} rows={8} value={props.value} disabled={props.disabled}
      aria-label={`${props.label} rich note`}
      onChange={event => {
        props.onChange(event.target.value, true);
      }}
      onBlur={() => {
        if (!props.disabled && props.value !== props.canonicalValue)
          void props.onSave(props.value || null);
      }}
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation();
        props.onChange(props.canonicalValue, false);
      }} />}
  </div>;
}

export function RecordDetail(props: {
  table: RegTable;
  recordId: string;
  tables: RegTable[];
  store: AsyncStore;
  worker?: WorkerClient;
  onNavigate: (table: string, id: string) => void;
  onClose: () => void;
  onWrite: (table: string) => void;
  onEverydayAction?: (state: FirstSuccessState) => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onExport?: () => void;
  exportPending?: boolean;
  runWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  onShare?: () => void;
  richTextCoordinator?: RichTextSaveCoordinator;
  richTextRevision?: number;
  onConfirm?: (message: string) => Promise<boolean>;
}): React.JSX.Element {
  const [row, setRow] = useState<QueryRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [relationOptions, setRelationOptions] = useState<Record<string, QueryRow[]>>({});
  const [attachments, setAttachments] = useState<Record<string, AttachmentMetadata[]>>({});
  const [scalarDrafts, setScalarDrafts] = useState<Record<string, string>>({});
  const scalarDraftMetaRef = useRef<Record<string, { generation: number; dirty: boolean }>>({});
  const recordIdentity = `${props.table.name}\u0000${props.recordId}`;
  const recordIdentityRef = useRef(recordIdentity);
  const reloadTokenRef = useRef(0);
  useLayoutEffect(() => {
    if (recordIdentityRef.current === recordIdentity) return;
    recordIdentityRef.current = recordIdentity;
    reloadTokenRef.current++;
    scalarDraftMetaRef.current = {};
  }, [recordIdentity]);
  const [related, setRelated] = useState<RelatedGroup[]>([]);
  const savingFieldsRef = useRef(new Set<string>());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<{
    table: RegTable; relation: RegColumn; draft: Record<string, string>;
  } | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const reportedEverydayRecord = useRef<string | null>(null);
  const columns = useMemo(() => props.table.columns
    .filter(column => !column.hidden && !column.inactive), [props.table]);

  const setFieldSaving = (field: string, active: boolean): void => setSaving(current => {
    const next = new Set(current);
    if (active) next.add(field); else next.delete(field);
    return next;
  });
  const updateScalarDraft = (field: string, value: string, dirty: boolean): void => {
    const current = scalarDraftMetaRef.current[field];
    scalarDraftMetaRef.current[field] = {
      generation: (current?.generation ?? 0) + 1,
      dirty,
    };
    setScalarDrafts(drafts => ({ ...drafts, [field]: value }));
  };
  const richTextIdentity = (field: string): RichTextFieldIdentity => ({
    table: props.table.name, recordId: props.recordId, field,
  });
  const updateRichTextDraft = (field: string, value: string, dirty: boolean): void => {
    if (props.richTextCoordinator) {
      props.richTextCoordinator.updateRichTextDraft(richTextIdentity(field), value, dirty);
      setScalarDrafts(drafts => ({ ...drafts, [field]: value }));
    } else updateScalarDraft(field, value, dirty);
  };

  const reload = async (settled?: { field: string; generation: number }): Promise<void> => {
    const identity = recordIdentity;
    if (identity !== recordIdentityRef.current) return;
    const token = ++reloadTokenRef.current;
    const found = await props.store.query({
      from: props.table.name,
      where: [{ field: "id", op: "eq", value: props.recordId }],
      includeDeleted: true,
      limit: 1,
    });
    const canonical = found[0] ?? null;
    const canonicalDrafts = Object.fromEntries(columns
      .filter(hasScalarDraft)
      .map(column => [column.name, canonical ? displayValue(canonical[column.name]) : ""]));

    const options: Record<string, QueryRow[]> = {};
    for (const column of columns) {
      if (column.type !== "relation" || !column.relation) continue;
      options[column.name] = await loadAllTableRows(
        props.store, column.relation.target_table);
    }

    const files: Record<string, AttachmentMetadata[]> = {};
    if (props.worker) {
      for (const column of columns.filter(candidate => candidate.type === "attachment"))
        files[column.name] = await props.worker.attachmentsForRecord(
          props.table.name, props.recordId, column.name);
    }

    const groups: RelatedGroup[] = [];
    for (const candidate of props.tables) {
      for (const relation of candidate.columns) {
        if (relation.type !== "relation" || relation.hidden || relation.inactive
            || relation.relation?.target_table !== props.table.name) continue;
        const rows = await loadAllTableRows(props.store, candidate.name, { where: [{
          field: relation.name,
          op: relation.relation.cardinality === "one" ? "eq" : "contains",
          value: props.recordId,
        }] });
        groups.push({ table: candidate, relation, rows });
      }
    }
    if (token !== reloadTokenRef.current || identity !== recordIdentityRef.current) return;
    const coordinatedRichTextDrafts = new Map<string, string>();
    if (props.richTextCoordinator) {
      for (const column of columns.filter(candidate => candidate.type === "rich_text")) {
        coordinatedRichTextDrafts.set(column.name,
          props.richTextCoordinator.reconcileRichTextDraft(
            richTextIdentity(column.name), canonicalDrafts[column.name] ?? ""));
      }
    }
    setRow(canonical);
    setScalarDrafts(current => {
      const next = { ...current };
      for (const [field, value] of Object.entries(canonicalDrafts)) {
        if (coordinatedRichTextDrafts.has(field)) {
          next[field] = coordinatedRichTextDrafts.get(field)!;
          continue;
        }
        const meta = scalarDraftMetaRef.current[field];
        const settlesCurrentDraft = settled?.field === field
          && meta?.generation === settled.generation;
        if (meta?.dirty && !settlesCurrentDraft) continue;
        next[field] = value;
        scalarDraftMetaRef.current[field] = {
          generation: meta?.generation ?? 0,
          dirty: false,
        };
      }
      return next;
    });
    setRelationOptions(options);
    setAttachments(files);
    setRelated(groups);
    setLoaded(true);
    const everydayKey = `${props.table.name}\u0000${props.recordId}`;
    if (canonical && props.worker?.completeEverydayAction
        && reportedEverydayRecord.current !== everydayKey) {
      try {
        const progress = await props.worker.completeEverydayAction({
          action: "open", table: props.table.name, rowId: props.recordId,
        }, props.worker.createMutationContext());
        props.onEverydayAction?.(progress);
        if (progress.steps.everyday.state === "complete")
          reportedEverydayRecord.current = everydayKey;
      } catch (error) {
        props.onError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  useEffect(() => {
    let live = true;
    setLoaded(false);
    void reload().catch(error => {
      if (live) {
        setLoaded(true);
        props.onError(error instanceof Error ? error.message : String(error));
      }
    });
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => {
      live = false;
      reloadTokenRef.current++;
      cancelAnimationFrame(frame);
    };
    // recordId and schema identity deliberately reload the whole projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.table.name, props.recordId, props.tables]);

  const richTextRevisionRef = useRef(props.richTextRevision);
  useEffect(() => {
    if (!props.richTextCoordinator || props.richTextRevision === undefined
        || richTextRevisionRef.current === props.richTextRevision) return;
    richTextRevisionRef.current = props.richTextRevision;
    void reload().catch(error => {
      props.onError(error instanceof Error ? error.message : String(error));
    });
    // A coordinator settlement is the reload trigger; reload deliberately remains render-local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.richTextCoordinator, props.richTextRevision]);

  const save = async (column: RegColumn, value: unknown): Promise<void> => {
    if (!row || isDerived(column) || column.type === "attachment") return;
    const richTextCoordinator = column.type === "rich_text"
      ? props.richTextCoordinator : undefined;
    if (richTextCoordinator) {
      const identity = richTextIdentity(column.name);
      const context = createStoreMutationContext();
      const pending = richTextCoordinator.queueRichTextSave(identity, async intent => {
        await props.store.update(props.table.name, props.recordId, {
          [column.name]: intent.value,
        }, context);
        await reload();
        props.onWrite(props.table.name);
      });
      if (!pending) return;
      setFieldSaving(column.name, true);
      try { await pending; }
      catch (error) {
        props.onError(error instanceof Error ? error.message : String(error));
        await reload().catch(() => undefined);
      } finally {
        setFieldSaving(column.name, false);
      }
      return;
    }
    if (savingFieldsRef.current.has(column.name)) return;
    savingFieldsRef.current.add(column.name);
    const draftGeneration = hasScalarDraft(column)
      ? scalarDraftMetaRef.current[column.name]?.generation ?? 0 : null;
    const settled = draftGeneration === null ? undefined
      : { field: column.name, generation: draftGeneration };
    const context = createStoreMutationContext();
    setFieldSaving(column.name, true);
    try {
      const write = async (): Promise<void> => {
        await props.store.update(props.table.name, props.recordId, { [column.name]: value }, context);
        await reload(settled);
        props.onWrite(props.table.name);
      };
      await props.runWrite(write);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
      await reload(settled).catch(() => undefined);
    } finally {
      savingFieldsRef.current.delete(column.name);
      setFieldSaving(column.name, false);
    }
  };

  const duplicate = async (): Promise<void> => {
    if (!row) return;
    const values: Record<string, unknown> = {};
    for (const column of columns) {
      if (isDerived(column) || column.type === "attachment") continue;
      const value = row[column.name];
      if (value === null || value === undefined) continue;
      if (column.type === "relation") {
        const ids = relationIds(value);
        values[column.name] = column.relation?.cardinality === "one" ? ids[0] ?? null : ids;
      } else values[column.name] = value;
    }
    const context = createStoreMutationContext();
    try {
      await props.runWrite(async () => {
        const copy = await props.store.insert(props.table.name, values, context);
        props.onWrite(props.table.name);
        props.onInfo("Record duplicated. You can edit the copy now.");
        props.onNavigate(props.table.name, String(copy.id));
      });
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const archive = async (): Promise<void> => {
    if (props.onConfirm && !await props.onConfirm(
      "Archive this record? Its links and history remain recoverable.")) return;
    const context = createStoreMutationContext();
    try {
      await props.runWrite(async () => {
        await props.store.softDelete(props.table.name, props.recordId, context);
        props.onWrite(props.table.name);
        props.onInfo("Record archived. Its history and links are preserved.");
        props.onClose();
      });
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };


  const createRelated = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!creating) return;
    const values: Record<string, unknown> = {
      [creating.relation.name]: creating.relation.relation?.cardinality === "many"
        ? [props.recordId] : props.recordId,
    };
    for (const column of creating.table.columns) {
      if (column.hidden || column.inactive || isDerived(column)
          || column.type === "relation" || column.type === "attachment") continue;
      const value = creating.draft[column.name] ?? "";
      if (value !== "") values[column.name] = coerce(column, value);
    }
    const context = createStoreMutationContext();
    try {
      await props.runWrite(async () => {
        const created = await props.store.insert(creating.table.name, values, context);
        props.onWrite(creating.table.name);
        props.onInfo(`Created a related ${creating.table.name.replace(/_/g, " ")} record.`);
        setCreating(null);
        await reload();
        props.onNavigate(creating.table.name, String(created.id));
      });
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const upload = async (column: RegColumn, file: File): Promise<void> => {
    if (!props.worker) return;
    const selectionError = attachmentSelectionError(file);
    if (selectionError) { props.onError(selectionError); return; }
    const context = props.worker.createMutationContext();
    setFieldSaving(column.name, true);
    try {
      await props.runWrite(async () => {
        await props.worker!.addAttachment({
          table: props.table.name, rowId: props.recordId, field: column.name,
          name: file.name, mime: file.type, bytes: await file.arrayBuffer(),
        }, context);
        await reload(); props.onWrite(props.table.name);
        props.onInfo(`Added ${file.name}. It is included in Clay backups.`);
      });
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setFieldSaving(column.name, false); }
  };

  const download = async (file: AttachmentMetadata): Promise<void> => {
    if (!props.worker) return;
    try {
      const stored = await props.worker.readAttachment(file.id);
      const bytes = stored.bytes.slice().buffer as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes], { type: stored.mime }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = stored.name; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const removeFile = async (column: RegColumn, file: AttachmentMetadata): Promise<void> => {
    if (!props.worker) return;
    if (props.onConfirm && !await props.onConfirm(
      `Remove ${file.name}? Its bytes remain recoverable for 30 days.`)) return;
    const context = props.worker.createMutationContext();
    try {
      await props.runWrite(async () => {
        await props.worker!.removeAttachment(
          props.table.name, props.recordId, column.name, file.id, context);
        await reload(); props.onWrite(props.table.name);
        props.onInfo(`${file.name} removed. Bytes remain recoverable for 30 days.`);
      });
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const formatBytes = (bytes: number): string => bytes < 1024
    ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  return (
    <ModalDialog className="record-detail" backdropClassName="modal-backdrop record-detail-backdrop"
      ariaLabel={`${props.table.name} record details`} onClose={props.onClose}>
      <header className="record-detail-header">
        <div>
          <span className="record-detail-kicker">{props.table.name.replace(/_/g, " ")}</span>
          <h2 ref={titleRef} tabIndex={-1}>{row ? rowLabel(props.table, row) : "Record"}</h2>
        </div>
        <button className="record-detail-close" aria-label="Close record details"
          title="Close record details" onClick={props.onClose}>✕</button>
      </header>

      {!loaded ? <div className="record-detail-empty" role="status">Loading record…</div>
        : !row ? <div className="record-detail-empty">This record is no longer available.</div> : (
        <>
          <div className="record-detail-actions" aria-label="Record actions">
            {props.onExport ? <button type="button"
              aria-label="Preview Print / CSV for this record"
              disabled={props.exportPending || saving.size > 0}
              onClick={props.onExport}>Print / CSV</button> : null}
            {props.onShare ? <button type="button"
              aria-label="Create read-only share for this record"
              onClick={props.onShare}>Share link</button> : null}
            <button onClick={() => void duplicate()}>Duplicate</button>
            <button className="danger" onClick={() => void archive()}>Archive</button>
          </div>
          <section className="record-fields" aria-label="Fields">
            {columns.map(column => {
              const value = row[column.name];
              const label = fieldLabel(column);
              if (column.type === "relation" && column.relation) {
                const options = relationOptions[column.name] ?? [];
                const target = props.tables.find(table => table.name === column.relation!.target_table);
                const selected = relationIds(value);
                return (
                  <div className="record-field" key={column.name}>
                    <label htmlFor={`record-${column.name}`}>{label}</label>
                    <select id={`record-${column.name}`}
                      multiple={column.relation.cardinality === "many"}
                      value={column.relation.cardinality === "many" ? selected : selected[0] ?? ""}
                      disabled={saving.has(column.name)}
                      onChange={event => {
                        const next = column.relation!.cardinality === "many"
                          ? [...event.currentTarget.selectedOptions].map(option => option.value)
                          : event.currentTarget.value || null;
                        void save(column, next);
                      }}>
                      {column.relation.cardinality === "one" ? <option value="">Not linked</option> : null}
                      {options.map(option => (
                        <option key={String(option.id)} value={String(option.id)}>
                          {target ? rowLabel(target, option) : String(option.id).slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    <div className="record-link-chips">
                      {(Array.isArray(value) ? value.filter(isRecordLink)
                        : isRecordLink(value) ? [value] : []).map(link => (
                        <button key={link.id} className="record-link-chip"
                          onClick={() => props.onNavigate(link.table, link.id)}>
                          {link.label}<span aria-hidden="true"> ↗</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              if (isDerived(column)) return (
                <div className="record-field record-field-derived" key={column.name}>
                  <span>{label}</span><output>{displayValue(value) || "—"}</output>
                </div>
              );
              if (column.type === "enum") return (
                <div className="record-field" key={column.name}>
                  <label htmlFor={`record-${column.name}`}>{label}</label>
                  <select id={`record-${column.name}`} value={displayValue(value)}
                    disabled={saving.has(column.name)}
                    onChange={event => void save(column, event.target.value || null)}>
                    <option value="">—</option>
                    {(column.values ?? []).map(option => <option key={option}>{option}</option>)}
                  </select>
                </div>
              );
              if (column.type === "boolean") return (
                <label className="record-field record-field-check" key={column.name}>
                  <span>{label}</span>
                  <input type="checkbox" checked={value === true} disabled={saving.has(column.name)}
                    onChange={event => void save(column, event.target.checked)} />
                </label>
              );
              if (column.type === "rich_text") {
                const identity = richTextIdentity(column.name);
                const coordinatedDraft = props.richTextCoordinator?.richTextDraft(identity);
                return (
                  <div className="record-field" key={column.name}>
                    <span>{label}</span>
                    <RichNoteEditor label={label}
                      value={coordinatedDraft?.value
                        ?? scalarDrafts[column.name] ?? displayValue(value)}
                      canonicalValue={displayValue(value)} disabled={saving.has(column.name)}
                      isSavePending={() => props.richTextCoordinator
                        ?.hasPendingRichTextSave(identity)
                        ?? savingFieldsRef.current.has(column.name)}
                      onChange={(next, dirty) => updateRichTextDraft(column.name, next, dirty)}
                      onSave={next => save(column, next)} />
                  </div>
                );
              }
              if (column.type === "attachment") return (
                <div className="record-field record-file-field" key={column.name}>
                  <span>{label}</span>
                  <div className="record-files">
                    {(attachments[column.name] ?? []).map(file => (
                      <article key={file.id}>
                        <span className="record-file-icon" aria-hidden="true">
                          {file.mime.startsWith("image/") ? "▧" : "▤"}
                        </span>
                        <button className="record-file-name" onClick={() => void download(file)}>
                          <strong>{file.name}</strong><small>{formatBytes(file.size)}</small>
                        </button>
                        <button className="record-file-remove" aria-label={`Remove ${file.name}`}
                          onClick={() => void removeFile(column, file)}>×</button>
                      </article>
                    ))}
                    {(attachments[column.name] ?? []).length === 0
                      ? <span className="record-files-empty">No files attached</span> : null}
                  </div>
                  <label className="record-file-upload">
                    <span>{saving.has(column.name) ? "Adding…" : "＋ Add file"}</span>
                    <input type="file" aria-label={`Add file to ${label}`}
                      disabled={!props.worker || saving.has(column.name)}
                      accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.json,.doc,.docx,.xls,.xlsx"
                      onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) void upload(column, file);
                        event.currentTarget.value = "";
                      }} />
                  </label>
                  <small className="record-file-limit">Up to 10 MB each · included in .clay backups</small>
                </div>
              );
              return (
                <div className="record-field" key={column.name}>
                  <label htmlFor={`record-${column.name}`}>{label}</label>
                  <input id={`record-${column.name}`}
                    type={column.type === "date" ? "date"
                      : column.type === "number" || column.type === "integer" ? "number" : "text"}
                    value={scalarDrafts[column.name] ?? ""} disabled={saving.has(column.name)}
                    onChange={event => updateScalarDraft(column.name, event.target.value, true)}
                    onKeyDown={event => {
                      if (event.key !== "Escape") return;
                      event.preventDefault(); event.stopPropagation();
                      updateScalarDraft(column.name, displayValue(row[column.name]), false);
                    }}
                    onBlur={event => void save(column, coerce(column, event.target.value))} />
                </div>
              );
            })}
          </section>

          <section className="related-records" aria-labelledby="related-title">
            <div className="related-records-heading">
              <h3 id="related-title">Related records</h3>
              <span>{related.reduce((sum, group) => sum + group.rows.length, 0)}</span>
            </div>
            {related.length === 0 ? (
              <p className="record-detail-empty">No tables link to this record yet.</p>
            ) : related.map(group => (
              <div className="related-group" key={`${group.table.name}.${group.relation.name}`}>
                <div className="related-group-heading">
                  <strong>{group.table.name.replace(/_/g, " ")}</strong>
                  <button className="link" onClick={() => setCreating({
                    table: group.table, relation: group.relation, draft: {},
                  })}>＋ Add related</button>
                </div>
                {group.rows.length === 0 ? <span className="related-empty">None yet</span>
                  : group.rows.map(relatedRow => (
                    <button key={String(relatedRow.id)} className="related-row"
                      onClick={() => props.onNavigate(group.table.name, String(relatedRow.id))}>
                      <span>{rowLabel(group.table, relatedRow)}</span><span aria-hidden="true">→</span>
                    </button>
                  ))}
              </div>
            ))}
          </section>
        </>
      )}

      {creating ? (
        <form className="related-create" onSubmit={event => void createRelated(event)}>
          <div className="related-create-head">
            <strong>New {creating.table.name.replace(/_/g, " ")}</strong>
            <button type="button" className="link" onClick={() => setCreating(null)}>Cancel</button>
          </div>
          {creating.table.columns.filter(column => !column.hidden && !column.inactive
            && !isDerived(column) && column.type !== "relation" && column.type !== "attachment")
            .map(column => (
              <label key={column.name}>{fieldLabel(column)}
                {column.type === "enum" ? <select required={column.required}
                  value={creating.draft[column.name] ?? ""}
                  onChange={event => setCreating(current => current ? {
                    ...current, draft: { ...current.draft, [column.name]: event.target.value },
                  } : current)}><option value="">Choose…</option>
                  {(column.values ?? []).map(option => <option key={option}>{option}</option>)}</select>
                  : column.type === "boolean" ? <select value={creating.draft[column.name] ?? ""}
                    onChange={event => setCreating(current => current ? {
                      ...current, draft: { ...current.draft, [column.name]: event.target.value },
                    } : current)}><option value="">—</option><option value="true">Yes</option>
                    <option value="false">No</option></select>
                    : <input required={column.required}
                      type={column.type === "date" ? "date"
                        : column.type === "number" || column.type === "integer" ? "number" : "text"}
                      value={creating.draft[column.name] ?? ""}
                      onChange={event => setCreating(current => current ? {
                        ...current, draft: { ...current.draft, [column.name]: event.target.value },
                      } : current)} />}
              </label>
            ))}
          <button className="primary" type="submit">Create related record</button>
        </form>
      ) : null}
    </ModalDialog>
  );
}
