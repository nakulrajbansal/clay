import { useMemo, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
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
  const restoreFocusRef = useRef(true);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
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

  return (
    <ModalDialog backdropClassName="ui ui-display-grid ui-place-items-center ui-position-fixed ui-inset-0 ui-base-padding-6fe44b shape-map-backdrop"
      className="ui ui-display-grid ui-background-panel ui-color-text ui-base-border-8f9f0d ui-overflow-hidden ui-min-height-0 shape-map"
      ariaLabel="Shape map" onClose={props.onClose} shouldRestoreFocus={() => restoreFocusRef.current}>
        <header className="ui ui-display-flex ui-background-panel ui-justify-content-space-between ui-border-bottom-line ui-align-items-flex-start shape-map-header">
          <div className="ui ui-min-width-0 ui-p-margin-9d8b39 ui-p-color-a3a3fb shape-map-heading">
            <span className="ui ui-color-accent-text ui-text-transform-uppercase ui-base-display-4b026d shape-map-kicker">Your app, made legible</span>
            <h2>Shape map</h2>
            <p>
              See how permanent data becomes live views, and how every shape remains reversible.
            </p>
          </div>
          <button className="ui ui-display-grid ui-color-text-2 ui-base-border-f41cca ui-flex-none ui-place-items-center ui-background-bg-soft ui-hover-color-caf367 ui-base-border-radius-25b77c shape-map-close" aria-label="Close shape map" onClick={props.onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="ui ui-display-grid ui-border-bottom-line ui-background-bg-soft shape-map-trust" aria-label="Clay trust guarantees">
          <div className={`ui ui-display-flex ui-align-items-center ui-min-width-0 ui-small-color-0803d9 shape-trust-item${props.persistent ? " shape-trust-ok" : " shape-trust-warn"}`}>
            <span className="ui ui-flex-none ui-border-radius-50 shape-trust-mark" aria-hidden="true" />
            <span><b>{props.persistent ? "Stored on this device" : "Session-only storage"}</b>
              <small>{map.stats.tables} tables · {map.stats.fields} visible fields</small></span>
          </div>
          <div className="ui ui-display-flex ui-align-items-center ui-min-width-0 ui-small-color-0803d9 shape-trust-item shape-trust-ok">
            <span className="ui ui-flex-none ui-border-radius-50 shape-trust-mark" aria-hidden="true" />
            <span><b>Views are sandboxed</b>
              <small>{map.stats.panels} live panels · trusted bridge only</small></span>
          </div>
          <div className="ui ui-display-flex ui-align-items-center ui-min-width-0 ui-small-color-0803d9 shape-trust-item shape-trust-ok">
            <span className="ui ui-flex-none ui-border-radius-50 shape-trust-mark" aria-hidden="true" />
            <span><b>Every shape is reversible</b>
              <small>{map.stats.versions} versions in one timeline</small></span>
          </div>
        </div>

        <div className="ui ui-display-grid ui-background-panel ui-min-height-0 shape-map-columns">
          <section className="ui ui-min-width-0 ui-overflow-y-auto ui-min-height-0 shape-column shape-column-data" aria-labelledby="shape-data-title">
            <div className="ui ui-display-flex ui-justify-content-space-between ui-gap-12px shape-column-head">
              <div>
                <span className="ui ui-color-accent-text ui-text-transform-uppercase ui-base-display-4b026d shape-step">01 · substrate</span>
                <h3 id="shape-data-title">Permanent data</h3>
              </div>
              <span className="ui ui-color-text-2 ui-flex-none ui-background-bg-soft ui-border-radius-999px shape-column-count">{connectedTables}/{map.stats.tables} in view</span>
            </div>
            <p className="ui ui-color-text-3 ui-font-size-12px ui-line-height-1-45 shape-column-copy">Your records survive every interface and every rewind.</p>
            <div className="ui ui-display-flex ui-flex-direction-column ui-gap-9px shape-list">
              {map.tables.map(table => {
                const selected = table.fields.find(field => field.id === selectedFieldId);
                return (
                <article
                  key={table.id ?? table.name}
                  className={`ui ui-background-panel ui-color-text ui-min-width-0 ui-base-border-f41cca ui-text-align-left ui-width-100 shape-node shape-data-node${table.connectedPanelIds.length === 0 ? " shape-node-dim" : ""}`}
                >
                  <button className="ui ui-border-0 ui-text-align-left ui-background-transparent ui-width-100 ui-padding-0 shape-table-open"
                    aria-label={`Open ${table.name} data`}
                    onClick={() => {
                      restoreFocusRef.current = false;
                      props.onOpenData(table.name); props.onClose();
                    }}>
                    <span className="ui ui-display-flex ui-align-items-center ui-min-width-0 ui-gap-8px shape-node-topline">
                      <span className="ui ui-display-grid ui-flex-none ui-place-items-center ui-border-radius-8px shape-node-icon shape-node-icon-data" aria-hidden="true">▦</span>
                      <span className="ui ui-min-width-0 ui-overflow-hidden ui-white-space-nowrap ui-flex-1 ui-text-overflow-ellipsis shape-node-title">{tableLabel(table.name)}</span>
                      <span className="ui ui-color-text-3 ui-white-space-nowrap ui-font-size-10-5px shape-node-meta">
                        {table.connectedPanelIds.length === 0
                          ? "not shown"
                          : `${table.connectedPanelIds.length} view${table.connectedPanelIds.length === 1 ? "" : "s"}`}
                      </span>
                    </span>
                  </button>
                  <span className="ui ui-display-flex ui-flex-wrap-wrap ui-gap-5px ui-base-margin-top-48251f shape-fields">
                    {table.fields.map(field => field.provenance ? (
                      <button key={field.id ?? field.name}
                        className={`ui ui-color-text-2 ui-base-border-f41cca ui-background-bg-soft shape-field${field.computed ? " shape-field-computed" : ""}`}
                        aria-expanded={field.id === selectedFieldId}
                        aria-label={`Explain ${table.name}.${field.name}`}
                        onClick={() => setSelectedFieldId(current => current === field.id ? null : field.id ?? null)}>
                        {field.name}{field.computed ? " ƒ" : ""}
                      </button>
                    ) : (
                      <span key={field.name} className={`ui ui-color-text-2 ui-base-border-f41cca ui-background-bg-soft shape-field${field.computed ? " shape-field-computed" : ""}`}>
                        {field.name}{field.computed ? " ƒ" : ""}
                      </span>
                    ))}
                  </span>
                  {selected?.provenance ? (
                    <aside className="ui ui-display-grid ui-color-text-2 ui-background-accent-soft ui-border-radius-8px ui-font-size-10-5px ui-gap-4px ui-base-margin-top-48251f shape-field-provenance" aria-label={`${table.name}.${selected.name} provenance`}>
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

          <section className="ui ui-min-width-0 ui-overflow-y-auto ui-min-height-0 shape-column shape-column-views" aria-labelledby="shape-views-title">
            <div className="ui ui-display-flex ui-justify-content-space-between ui-gap-12px shape-column-head">
              <div>
                <span className="ui ui-color-accent-text ui-text-transform-uppercase ui-base-display-4b026d shape-step">02 · projections</span>
                <h3 id="shape-views-title">Live views</h3>
              </div>
              <span className="ui ui-color-text-2 ui-flex-none ui-background-bg-soft ui-border-radius-999px shape-column-count">{map.stats.connections} links</span>
            </div>
            <p className="ui ui-color-text-3 ui-font-size-12px ui-line-height-1-45 shape-column-copy">Each panel is a replaceable lens, never the source of truth.</p>
            <div className="ui ui-display-flex ui-flex-direction-column ui-gap-9px shape-list">
              {map.panels.map(view => {
                const panel = panelById.get(view.id);
                const links = map.links.filter(link => link.panelId === view.id);
                return (
                  <article key={view.id} className="ui ui-background-panel ui-color-text ui-min-width-0 ui-base-border-f41cca ui-text-align-left ui-width-100 shape-node shape-view-node">
                    <div className="ui ui-display-flex ui-align-items-center ui-min-width-0 ui-gap-8px shape-node-topline">
                      <span className="ui ui-display-grid ui-color-accent-text ui-flex-none ui-place-items-center ui-background-accent-soft ui-border-radius-8px shape-node-icon shape-node-icon-view" aria-hidden="true">◇</span>
                      <span className="ui ui-min-width-0 ui-overflow-hidden ui-white-space-nowrap ui-flex-1 ui-text-overflow-ellipsis shape-node-title">{view.title}</span>
                      <span className="ui ui-color-text-3 ui-white-space-nowrap ui-font-size-10-5px shape-node-meta">{view.region}</span>
                    </div>
                    <div className="ui ui-display-flex ui-flex-wrap-wrap ui-gap-5px ui-base-margin-top-48251f shape-links">
                      {links.length > 0 ? links.map(link => (
                        <span key={`${link.table}:${link.mode}`} className={`ui ui-color-text-2 ui-display-inline-flex ui-background-bg-soft ui-gap-5px ui-small-color-0803d9 ui-border-radius-7px ui-align-items-baseline shape-link shape-link-${link.mode}`}>
                          {tableLabel(link.table)} <small>{modeLabel(link.mode)}</small>
                        </span>
                      )) : <span className="ui ui-color-text-2 ui-color-text-3 ui-display-inline-flex ui-background-bg-soft ui-gap-5px ui-small-color-0803d9 ui-border-radius-7px ui-align-items-baseline ui-base-border-9a0e96 shape-link shape-link-unbound">interface only</span>}
                    </div>
                    {panel ? (
                      <button className="ui ui-color-accent-text ui-border-0 ui-background-transparent ui-padding-0 ui-base-margin-top-48251f shape-node-action" onClick={() => {
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

          <section className="ui ui-min-width-0 ui-overflow-y-auto ui-min-height-0 shape-column shape-column-history" aria-labelledby="shape-history-title">
            <div className="ui ui-display-flex ui-justify-content-space-between ui-gap-12px shape-column-head">
              <div>
                <span className="ui ui-color-accent-text ui-text-transform-uppercase ui-base-display-4b026d shape-step">03 · memory</span>
                <h3 id="shape-history-title">Evolution</h3>
              </div>
              <span className="ui ui-color-text-2 ui-flex-none ui-background-bg-soft ui-border-radius-999px shape-column-count">v{props.history.at(-1)?.version ?? 0}</span>
            </div>
            <p className="ui ui-color-text-3 ui-font-size-12px ui-line-height-1-45 shape-column-copy">The words, decisions, and checkpoints that made this app yours.</p>
            <div className="ui ui-display-flex ui-flex-direction-column ui-position-relative shape-evolution">
              {recent.map((entry, index) => (
                <article key={entry.version} className="ui ui-display-grid ui-gap-8px ui-p-color-a3a3fb ui-position-relative shape-change">
                  <span className={`ui ui-background-panel ui-border-radius-50 shape-change-dot${index === 0 ? " shape-change-dot-now" : ""}`} aria-hidden="true" />
                  <div className="ui ui-min-width-0 shape-change-body">
                    <div className="ui ui-display-flex ui-align-items-center ui-min-width-0 ui-gap-6px ui-span-border-radius-0b7e91 shape-change-meta">
                      <b>v{entry.version}</b>
                      {entry.label ? <span>{entry.label}</span> : null}
                      <time>{relTime(entry.created_at)}</time>
                    </div>
                    <p>{entry.intent_text ? `“${entry.intent_text}”` : entry.summary}</p>
                  </div>
                </article>
              ))}
              {recent.length === 0 ? (
                <div className="ui ui-color-text-3 ui-font-size-12px ui-text-align-center shape-evolution-empty">Your first kept shape will appear here.</div>
              ) : null}
            </div>
            <button className="ui ui-color-text ui-base-border-8f9f0d ui-border-radius-10px ui-background-bg-soft ui-width-100 ui-hover-border-color-2b372d ui-hover-color-92c640 shape-history-open" onClick={() => {
              restoreFocusRef.current = false;
              props.onOpenHistory();
              props.onClose();
            }}>Open the full timeline</button>
          </section>
        </div>

        <footer className="ui ui-display-flex ui-align-items-center ui-color-text-2 ui-justify-content-space-between ui-background-bg-soft ui-border-top-line ui-b-color-a7ddc1 ui-font-size-11-5px shape-map-footer">
          <span><b>The Clay contract:</b> data stays permanent; views stay malleable.</span>
          {map.stats.computedFields > 0 ? (
            <span>{map.stats.computedFields} computed field{map.stats.computedFields === 1 ? "" : "s"} live in the substrate</span>
          ) : null}
        </footer>
    </ModalDialog>
  );
}
