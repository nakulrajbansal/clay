import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AsyncStore, AttachmentMetadata, QueryRow, QueryValue, RecordLink, RegColumn, RegTable,
} from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
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
  label: string; value: string; disabled: boolean;
  onSave: (value: string | null) => void | Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(props.value);
  const [preview, setPreview] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(props.value), [props.value]);
  const wrap = (before: string, after = before): void => {
    const input = ref.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = draft.slice(start, end) || "text";
    const next = `${draft.slice(0, start)}${before}${selected}${after}${draft.slice(end)}`;
    setDraft(next);
    void props.onSave(next || null);
    requestAnimationFrame(() => {
      input.focus(); input.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };
  return <div className="rich-note-editor">
    <div className="rich-note-toolbar" role="toolbar" aria-label="Note formatting">
      <button type="button" title="Bold" onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("**")}>B</button>
      <button type="button" title="Italic" onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("_")}><em>I</em></button>
      <button type="button" title="Bulleted line" onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("- ", "")}>• List</button>
      <button type="button" title="Link" onMouseDown={event => event.preventDefault()}
        onClick={() => wrap("[", "](https://)")}>Link</button>
      <button type="button" className={preview ? "active" : ""}
        onClick={() => setPreview(value => !value)}>{preview ? "Edit" : "Preview"}</button>
    </div>
    {preview ? <div className="rich-note-preview">
      {draft.split("\n").map((line, index) => line.startsWith("- ")
        ? <div className="rich-note-bullet" key={index}>• {inlineMarkdown(line.slice(2))}</div>
        : <p key={index}>{line ? inlineMarkdown(line) : " "}</p>)}
    </div> : <textarea ref={ref} rows={8} value={draft} disabled={props.disabled}
      aria-label={`${props.label} rich note`}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { if (draft !== props.value) props.onSave(draft || null); }}
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation(); setDraft(props.value);
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
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onConfirm?: (message: string) => Promise<boolean>;
}): React.JSX.Element {
  const [row, setRow] = useState<QueryRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [relationOptions, setRelationOptions] = useState<Record<string, QueryRow[]>>({});
  const [attachments, setAttachments] = useState<Record<string, AttachmentMetadata[]>>({});
  const [scalarDrafts, setScalarDrafts] = useState<Record<string, string>>({});
  const [related, setRelated] = useState<RelatedGroup[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState<{
    table: RegTable; relation: RegColumn; draft: Record<string, string>;
  } | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const columns = useMemo(() => props.table.columns
    .filter(column => !column.hidden && !column.inactive), [props.table]);

  const reload = async (): Promise<void> => {
    const found = await props.store.query({
      from: props.table.name,
      where: [{ field: "id", op: "eq", value: props.recordId }],
      includeDeleted: true,
      limit: 1,
    });
    const canonical = found[0] ?? null;
    setRow(canonical);
    setScalarDrafts(Object.fromEntries(columns
      .filter(column => !isDerived(column) && column.type !== "relation"
        && column.type !== "attachment" && column.type !== "rich_text")
      .map(column => [column.name, canonical ? displayValue(canonical[column.name]) : ""])));

    const options: Record<string, QueryRow[]> = {};
    for (const column of columns) {
      if (column.type !== "relation" || !column.relation) continue;
      options[column.name] = await loadAllTableRows(
        props.store, column.relation.target_table);
    }
    setRelationOptions(options);

    const files: Record<string, AttachmentMetadata[]> = {};
    if (props.worker) {
      for (const column of columns.filter(candidate => candidate.type === "attachment"))
        files[column.name] = await props.worker.attachmentsForRecord(
          props.table.name, props.recordId, column.name);
    }
    setAttachments(files);

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
    setRelated(groups);
    setLoaded(true);
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
    return () => { live = false; cancelAnimationFrame(frame); };
    // recordId and schema identity deliberately reload the whole projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.table.name, props.recordId, props.tables]);

  const save = async (column: RegColumn, value: unknown): Promise<void> => {
    if (!row || isDerived(column) || column.type === "attachment") return;
    setSaving(column.name);
    try {
      await props.store.update(props.table.name, props.recordId, { [column.name]: value });
      await reload();
      props.onWrite(props.table.name);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
      await reload().catch(() => undefined);
    } finally { setSaving(null); }
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
    try {
      const copy = await props.store.insert(props.table.name, values);
      props.onWrite(props.table.name);
      props.onInfo("Record duplicated. You can edit the copy now.");
      props.onNavigate(props.table.name, String(copy.id));
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const archive = async (): Promise<void> => {
    if (props.onConfirm && !await props.onConfirm(
      "Archive this record? Its links and history remain recoverable.")) return;
    try {
      await props.store.softDelete(props.table.name, props.recordId);
      props.onWrite(props.table.name);
      props.onInfo("Record archived. Its history and links are preserved.");
      props.onClose();
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
    try {
      const created = await props.store.insert(creating.table.name, values);
      props.onWrite(creating.table.name);
      props.onInfo(`Created a related ${creating.table.name.replace(/_/g, " ")} record.`);
      setCreating(null);
      await reload();
      props.onNavigate(creating.table.name, String(created.id));
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  };

  const upload = async (column: RegColumn, file: File): Promise<void> => {
    if (!props.worker) return;
    const selectionError = attachmentSelectionError(file);
    if (selectionError) { props.onError(selectionError); return; }
    setSaving(column.name);
    try {
      await props.worker.addAttachment({
        table: props.table.name, rowId: props.recordId, field: column.name,
        name: file.name, mime: file.type, bytes: await file.arrayBuffer(),
      });
      await reload(); props.onWrite(props.table.name);
      props.onInfo(`Added ${file.name}. It is included in Clay backups.`);
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(null); }
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
    try {
      await props.worker.removeAttachment(
        props.table.name, props.recordId, column.name, file.id);
      await reload(); props.onWrite(props.table.name);
      props.onInfo(`${file.name} removed. Bytes remain recoverable for 30 days.`);
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
                      disabled={saving === column.name}
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
                    disabled={saving === column.name}
                    onChange={event => void save(column, event.target.value || null)}>
                    <option value="">—</option>
                    {(column.values ?? []).map(option => <option key={option}>{option}</option>)}
                  </select>
                </div>
              );
              if (column.type === "boolean") return (
                <label className="record-field record-field-check" key={column.name}>
                  <span>{label}</span>
                  <input type="checkbox" checked={value === true} disabled={saving === column.name}
                    onChange={event => void save(column, event.target.checked)} />
                </label>
              );
              if (column.type === "rich_text") return (
                <div className="record-field" key={column.name}>
                  <span>{label}</span>
                  <RichNoteEditor label={label} value={displayValue(value)} disabled={saving === column.name}
                    onSave={next => save(column, next)} />
                </div>
              );
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
                    <span>{saving === column.name ? "Adding…" : "＋ Add file"}</span>
                    <input type="file" aria-label={`Add file to ${label}`}
                      disabled={!props.worker || saving === column.name}
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
                    value={scalarDrafts[column.name] ?? ""} disabled={saving === column.name}
                    onChange={event => setScalarDrafts(current => ({
                      ...current, [column.name]: event.target.value,
                    }))}
                    onKeyDown={event => {
                      if (event.key !== "Escape") return;
                      event.preventDefault(); event.stopPropagation();
                      setScalarDrafts(current => ({
                        ...current, [column.name]: displayValue(row[column.name]),
                      }));
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
