import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  FieldProvenance, HistoryEntry, LivePanel, RegTable, SemanticSchemaTraceV1,
} from "@clay/kernel";
import { buildShapeMap, type ShapeLink } from "./shape-map";
import { relTime } from "./HistoryView";

const tableLabel = (name: string): string => name.replaceAll("_", " ");
const shortSemanticId = (id: string): string => `${id.slice(0, 3)}…${id.slice(-8)}`;
const modeLabel = (mode: ShapeLink["mode"]): string => {
  if (mode === "read_write") return "reads + writes";
  if (mode === "write") return "writes";
  return "reads";
};

export function ShapeMapView(props: {
  tables: RegTable[];
  panels: LivePanel[];
  history: HistoryEntry[];
  semanticTrace?: SemanticSchemaTraceV1 | null;
  fieldProvenance?: FieldProvenance[];
  persistent: boolean;
  onClose: () => void;
  onOpenData: (table: string) => void;
  onOpenHistory: () => void;
  onAskAbout: (panel: LivePanel) => void;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(props.onClose);
  const restoreFocusRef = useRef(true);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  onCloseRef.current = props.onClose;
  const map = useMemo(
    () => buildShapeMap(props.tables, props.panels, props.history.length,
      props.semanticTrace, props.fieldProvenance),
    [props.tables, props.panels, props.history.length,
      props.semanticTrace, props.fieldProvenance],
  );
  const panelById = useMemo(
    () => new Map(props.panels.map(panel => [panel.panel_id, panel])),
    [props.panels],
  );
  const fieldNameById = useMemo(() => new Map(map.tables.flatMap(table =>
    table.fields.flatMap(field => field.id
      ? [[field.id, `${table.name}.${field.name}`] as const] : []),
  )), [map.tables]);
  const connectedTables = map.tables.filter(table => table.connectedPanelIds.length > 0).length;
  const recent = [...props.history].reverse().slice(0, 6);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>(".app");
    const priorInert = app?.inert ?? false;
    const priorHidden = app?.getAttribute("aria-hidden") ?? null;
    if (app) { app.inert = true; app.setAttribute("aria-hidden", "true"); }

    const frame = requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>("button")?.focus());
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const nodes = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(node => node.getClientRects().length > 0);
      if (nodes.length === 0) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && (document.activeElement === first
          || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      if (app) {
        app.inert = priorInert;
        if (priorHidden === null) app.removeAttribute("aria-hidden");
        else app.setAttribute("aria-hidden", priorHidden);
      }
      if (restoreFocusRef.current) previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div className="shape-map-backdrop" onMouseDown={event => {
      if (event.currentTarget === event.target) props.onClose();
    }}>
      <section ref={dialogRef} className="shape-map" role="dialog" aria-modal="true"
        aria-label="Shape map" tabIndex={-1}>
        <header className="shape-map-header">
          <div className="shape-map-heading">
            <span className="shape-map-kicker">Your app, made legible</span>
            <h2>Shape map</h2>
            <p>
              See how permanent data becomes live views, and how every shape remains reversible.
            </p>
          </div>
          <button className="shape-map-close" aria-label="Close shape map" onClick={props.onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="shape-map-trust" aria-label="Clay trust guarantees">
          <div className={`shape-trust-item${props.persistent ? " shape-trust-ok" : " shape-trust-warn"}`}>
            <span className="shape-trust-mark" aria-hidden="true" />
            <span><b>{props.persistent ? "Stored on this device" : "Session-only storage"}</b>
              <small>{map.stats.tables} tables · {map.stats.fields} visible fields</small></span>
          </div>
          <div className="shape-trust-item shape-trust-ok">
            <span className="shape-trust-mark" aria-hidden="true" />
            <span><b>Views are sandboxed</b>
              <small>{map.stats.panels} live panels · trusted bridge only</small></span>
          </div>
          <div className="shape-trust-item shape-trust-ok">
            <span className="shape-trust-mark" aria-hidden="true" />
            <span><b>Every shape is reversible</b>
              <small>{map.stats.versions} versions in one timeline</small></span>
          </div>
        </div>

        <div className="shape-map-columns">
          <section className="shape-column shape-column-data" aria-labelledby="shape-data-title">
            <div className="shape-column-head">
              <div>
                <span className="shape-step">01 · substrate</span>
                <h3 id="shape-data-title">Permanent data</h3>
              </div>
              <span className="shape-column-count">{connectedTables}/{map.stats.tables} in view</span>
            </div>
            <p className="shape-column-copy">Your records survive every interface and every rewind.</p>
            <div className="shape-list">
              {map.tables.map(table => {
                const selected = table.fields.find(field => field.id === selectedFieldId);
                return (
                <article
                  key={table.id ?? table.name}
                  className={`shape-node shape-data-node${table.connectedPanelIds.length === 0 ? " shape-node-dim" : ""}`}
                >
                  <button className="shape-table-open"
                    aria-label={`Open ${table.name} data`}
                    onClick={() => {
                      restoreFocusRef.current = false;
                      props.onOpenData(table.name); props.onClose();
                    }}>
                    <span className="shape-node-topline">
                      <span className="shape-node-icon shape-node-icon-data" aria-hidden="true">▦</span>
                      <span className="shape-node-title">{tableLabel(table.name)}</span>
                      <span className="shape-node-meta">
                        {table.connectedPanelIds.length === 0
                          ? "not shown"
                          : `${table.connectedPanelIds.length} view${table.connectedPanelIds.length === 1 ? "" : "s"}`}
                      </span>
                    </span>
                  </button>
                  <span className="shape-fields">
                    {table.fields.map(field => field.provenance ? (
                      <button key={field.id ?? field.name}
                        className={`shape-field${field.computed ? " shape-field-computed" : ""}`}
                        aria-expanded={field.id === selectedFieldId}
                        aria-label={`Explain ${table.name}.${field.name}`}
                        onClick={() => setSelectedFieldId(current => current === field.id ? null : field.id ?? null)}>
                        {field.name}{field.computed ? " ƒ" : ""}
                      </button>
                    ) : (
                      <span key={field.name} className={`shape-field${field.computed ? " shape-field-computed" : ""}`}>
                        {field.name}{field.computed ? " ƒ" : ""}
                      </span>
                    ))}
                  </span>
                  {selected?.provenance ? (
                    <aside className="shape-field-provenance" aria-label={`${table.name}.${selected.name} provenance`}>
                      <b>Why this field exists</b>
                      <span>{selected.provenance.origin === "legacy_backfill" ? "Known since" : "Created"} v{selected.provenance.createdVersion} · last shaped v{selected.provenance.lastChangedVersion}</span>
                      <span>{selected.provenance.fieldType}{selected.required ? " · required" : " · optional"}</span>
                      <span>Field ID <code title={selected.provenance.fieldId}>
                        {shortSemanticId(selected.provenance.fieldId)}
                      </code></span>
                      {selected.provenance.aliases.length > 0
                        ? <span>Previously {selected.provenance.aliases.join(", ")}</span> : null}
                      {selected.provenance.derivation ? (
                        <>
                          <code>{selected.provenance.derivation.expression}</code>
                          <span className="shape-field-dependencies">Depends on{" "}
                            {selected.provenance.derivation.dependencyFieldIds.map((id, index) => (
                              <code key={id} title={id}>{index > 0 ? ", " : ""}
                                {fieldNameById.get(id) ?? "field"} · {shortSemanticId(id)}
                              </code>
                            ))}
                          </span>
                        </>
                      ) : null}
                    </aside>
                  ) : null}
                </article>
                );
              })}
            </div>
          </section>

          <section className="shape-column shape-column-views" aria-labelledby="shape-views-title">
            <div className="shape-column-head">
              <div>
                <span className="shape-step">02 · projections</span>
                <h3 id="shape-views-title">Live views</h3>
              </div>
              <span className="shape-column-count">{map.stats.connections} links</span>
            </div>
            <p className="shape-column-copy">Each panel is a replaceable lens, never the source of truth.</p>
            <div className="shape-list">
              {map.panels.map(view => {
                const panel = panelById.get(view.id);
                const links = map.links.filter(link => link.panelId === view.id);
                return (
                  <article key={view.id} className="shape-node shape-view-node">
                    <div className="shape-node-topline">
                      <span className="shape-node-icon shape-node-icon-view" aria-hidden="true">◇</span>
                      <span className="shape-node-title">{view.title}</span>
                      <span className="shape-node-meta">{view.region}</span>
                    </div>
                    <div className="shape-links">
                      {links.length > 0 ? links.map(link => (
                        <span key={`${link.table}:${link.mode}`} className={`shape-link shape-link-${link.mode}`}>
                          {tableLabel(link.table)} <small>{modeLabel(link.mode)}</small>
                        </span>
                      )) : <span className="shape-link shape-link-unbound">interface only</span>}
                    </div>
                    {panel ? (
                      <button className="shape-node-action" onClick={() => {
                        restoreFocusRef.current = false;
                        props.onAskAbout(panel);
                        props.onClose();
                      }}>Shape this view</button>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="shape-column shape-column-history" aria-labelledby="shape-history-title">
            <div className="shape-column-head">
              <div>
                <span className="shape-step">03 · memory</span>
                <h3 id="shape-history-title">Evolution</h3>
              </div>
              <span className="shape-column-count">v{props.history.at(-1)?.version ?? 0}</span>
            </div>
            <p className="shape-column-copy">The words, decisions, and checkpoints that made this app yours.</p>
            <div className="shape-evolution">
              {recent.map((entry, index) => (
                <article key={entry.version} className="shape-change">
                  <span className={`shape-change-dot${index === 0 ? " shape-change-dot-now" : ""}`} aria-hidden="true" />
                  <div className="shape-change-body">
                    <div className="shape-change-meta">
                      <b>v{entry.version}</b>
                      {entry.label ? <span>{entry.label}</span> : null}
                      <time>{relTime(entry.created_at)}</time>
                    </div>
                    <p>{entry.intent_text ? `“${entry.intent_text}”` : entry.summary}</p>
                  </div>
                </article>
              ))}
              {recent.length === 0 ? (
                <div className="shape-evolution-empty">Your first kept shape will appear here.</div>
              ) : null}
            </div>
            <button className="shape-history-open" onClick={() => {
              restoreFocusRef.current = false;
              props.onOpenHistory();
              props.onClose();
            }}>Open the full timeline</button>
          </section>
        </div>

        <footer className="shape-map-footer">
          <span><b>The Clay contract:</b> data stays permanent; views stay malleable.</span>
          {map.stats.computedFields > 0 ? (
            <span>{map.stats.computedFields} computed field{map.stats.computedFields === 1 ? "" : "s"} live in the substrate</span>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
