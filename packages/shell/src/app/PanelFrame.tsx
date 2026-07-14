// PanelHost (doc 02 §1): one sandboxed iframe per live panel. srcdoc +
// sandbox="allow-scripts" gives an opaque origin — no cookies, storage, or
// parent DOM; the CSP leaves no network path (doc 06 §2). The only channel
// is one transferred MessagePort speaking the Bridge protocol.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { portFromMessagePort, type Bridge, type LivePanel } from "@clay/kernel";
// The fixed bootstrap, built to a single file and inlined (doc 06 §2).
import runtimeBundle from "@clay/panel-runtime/iframe-bundle?raw";

const PANEL_CSS = `
  :root { color-scheme: light;
    --font: "Segoe UI Variable Text", "SF Pro Text", -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    --font-display: "Segoe UI Variable Display", "SF Pro Display", -apple-system, system-ui, "Segoe UI", sans-serif;
    --text: #2b2a33; --text-2: #6d6b78; --text-3: #a6a4b1;
    --border: #efeef3; --border-2: #e7e5ee; --bg-soft: #f8f7fb;
    --accent: #6a67e6; --accent-soft: #f1f0fc; --accent-text: #4b47c4; }
  body { margin: 0; font: 13px/1.55 var(--font);
    color: var(--text); padding: 12px; -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility; }
  .clay-table-wrap { width: 100%; overflow-x: auto; }
  .clay-table { width: 100%; border-collapse: collapse; }
  .clay-table th { text-align: left; font-size: 10.5px; text-transform: uppercase;
    letter-spacing: .05em; font-weight: 600; color: var(--text-3); white-space: nowrap;
    padding: 6px 9px; border-bottom: 1px solid var(--border-2); transition: color .1s; }
  .clay-th-sort { cursor: pointer; user-select: none; }
  .clay-th-sort:hover { color: var(--accent-text); }
  .clay-table td { padding: 8px 9px; border-bottom: 1px solid var(--border); }
  .clay-table tbody tr:last-child td { border-bottom: 0; }
  .clay-table tbody tr { transition: background .1s; }
  .clay-table tbody tr:hover td { background: var(--bg-soft); }
  .clay-badge { display: inline-block; padding: 2px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 600; background: #f0f0f3; color: var(--text-2); }
  .clay-tone-green, .clay-tone-success { background: #e7f6ec; color: #15803d; }
  .clay-tone-amber, .clay-tone-warning { background: #fdf0d5; color: #b45309; }
  .clay-tone-red, .clay-tone-danger { background: #fdeaea; color: #c02626; }
  .clay-tone-gray, .clay-tone-default { background: #f0f0f3; color: var(--text-2); }
  .clay-tone-accent { background: var(--accent-soft); color: var(--accent-text); }
  .clay-empty { color: var(--text-3); padding: 22px 6px; text-align: center; }
  .clay-stack > * + * { margin-top: 8px; }
  /* KPIs sit in one row when there's room, wrap cleanly otherwise */
  .clay-grid { display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); }
  .clay-grid { grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); }
  .clay-metric { position: relative; display: flex; flex-direction: column; gap: 6px;
    padding: 13px 13px 12px 15px; background: linear-gradient(180deg, #ffffff, #fbfaff);
    border: 1px solid var(--border); border-radius: 14px; min-width: 0; overflow: hidden;
    box-shadow: 0 1px 2px rgba(40,38,60,.04); transition: transform .16s ease, box-shadow .16s ease; }
  .clay-metric::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: linear-gradient(180deg, var(--accent), #a29ff5); }
  .clay-metric:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(40,38,60,.09); }
  .clay-metric-label { font-size: 10px; font-weight: 700; color: var(--text-3);
    text-transform: uppercase; letter-spacing: .06em; line-height: 1.35; }
  .clay-metric-value { font-family: var(--font-display); font-size: 22px; font-weight: 640;
    letter-spacing: -.02em; color: var(--text); line-height: 1.12;
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  .clay-form { display: flex; flex-direction: column; gap: 11px; }
  .clay-field { display: flex; flex-direction: column; gap: 4px; }
  .clay-field-label { font-size: 11px; font-weight: 500; color: var(--text-2); }
  .clay-input, .clay-select { border: 1px solid var(--border-2); border-radius: 8px;
    padding: 8px 10px; font: inherit; background: #fff; transition: border-color .1s, box-shadow .1s; }
  .clay-input:focus, .clay-select:focus { outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft); }
  .clay-button { border: 0; border-radius: 10px; padding: 9px 15px; font: inherit;
    font-weight: 600; background: linear-gradient(180deg, #7d7aec, #5f5cdf); color: #fff;
    cursor: pointer; box-shadow: 0 2px 8px rgba(91,87,235,.35), inset 0 1px 0 rgba(255,255,255,.18);
    transition: transform .08s ease, box-shadow .12s ease, filter .12s ease; }
  .clay-button:hover { filter: brightness(1.05); box-shadow: 0 4px 14px rgba(91,87,235,.42); }
  .clay-button:active { transform: translateY(1px); box-shadow: 0 1px 4px rgba(91,87,235,.35); }
  .clay-filterbar { display: flex; gap: 8px; }
  .clay-chart svg { width: 100%; height: auto; display: block; overflow: visible;
    animation: clay-chart-in .42s ease both; }
  @keyframes clay-chart-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  @keyframes clay-bar-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @media (prefers-reduced-motion: reduce) {
    .clay-chart svg, .clay-chart-bar, .clay-chart-mbar { animation: none; } }
  .clay-chart-bar, .clay-chart-mbar { transform-box: fill-box; transform-origin: bottom;
    animation: clay-bar-grow .52s cubic-bezier(.2,.85,.3,1) both; }
  .clay-chart-bar { fill: var(--accent); }
  /* slice colour is set inline (per category); CSS only draws separators */
  .clay-chart-slice { stroke: #fff; stroke-width: 1.5; }
  .clay-chart-axis { stroke: var(--border-2); stroke-width: 1; }
  .clay-chart-line { fill: none; stroke: var(--accent); stroke-width: 2.25;
    stroke-linejoin: round; stroke-linecap: round; }
  .clay-chart-areafill { fill: rgba(106,103,230,.12); stroke: none; }
  .clay-chart-dot { fill: #fff; stroke: var(--accent); stroke-width: 1.75; }
  .clay-chart-legend { display: flex; flex-wrap: wrap; gap: 6px 14px;
    margin-top: 9px; font-size: 11.5px; color: var(--text-2); }
  .clay-chart-legend .lg { display: inline-flex; align-items: center; gap: 6px; }
  .clay-chart-legend .sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  figure { margin: 0; }

  /* composable primitives (ADR-016) */
  .clay-box { display: flex; }
  .clay-box-col { flex-direction: column; }
  .clay-box-row { flex-direction: row; }
  .clay-box-wrap { flex-wrap: wrap; }
  .clay-box-grow { flex: 1; }
  .clay-gap-none { gap: 0; } .clay-gap-xs { gap: 3px; } .clay-gap-sm { gap: 6px; }
  .clay-gap-md { gap: 10px; } .clay-gap-lg { gap: 16px; } .clay-gap-xl { gap: 24px; }
  .clay-pad-none { padding: 0; } .clay-pad-xs { padding: 3px; } .clay-pad-sm { padding: 6px; }
  .clay-pad-md { padding: 10px; } .clay-pad-lg { padding: 16px; } .clay-pad-xl { padding: 24px; }
  .clay-align-start { align-items: flex-start; } .clay-align-center { align-items: center; }
  .clay-align-end { align-items: flex-end; } .clay-align-stretch { align-items: stretch; }
  .clay-justify-start { justify-content: flex-start; } .clay-justify-center { justify-content: center; }
  .clay-justify-end { justify-content: flex-end; } .clay-justify-between { justify-content: space-between; }
  .clay-box.clay-tone-green { background: #dcfce7; border-radius: 8px; }
  .clay-box.clay-tone-amber { background: #fef3c7; border-radius: 8px; }
  .clay-box.clay-tone-red { background: #fee2e2; border-radius: 8px; }
  .clay-box.clay-tone-gray, .clay-box.clay-tone-default { background: #f5f5f4; border-radius: 8px; }
  .clay-box.clay-tone-accent { background: #eef2ff; border-radius: 8px; }
  .clay-text-xs { font-size: 11px; } .clay-text-sm { font-size: 12px; }
  .clay-text-md { font-size: 14px; } .clay-text-lg { font-size: 18px; } .clay-text-xl { font-size: 24px; }
  .clay-text-bold { font-weight: 700; } .clay-text-muted { color: #a8a29e; }
  .clay-tone-fg-green { color: #166534; } .clay-tone-fg-amber { color: #92400e; }
  .clay-tone-fg-red { color: #991b1b; } .clay-tone-fg-accent { color: #3730a3; }
  .clay-tone-fg-gray { color: #78716c; }
  .clay-bar { display: flex; align-items: center; gap: 8px; }
  .clay-bar-label { font-size: 12px; min-width: 90px; color: #57534e; }
  .clay-bar-track { flex: 1; height: 14px; background: #f5f5f4; border-radius: 999px; overflow: hidden; }
  .clay-bar-fill { height: 100%; border-radius: 999px; background: #6366f1; }
  .clay-bar-fill.clay-tone-green { background: #22c55e; } .clay-bar-fill.clay-tone-amber { background: #f59e0b; }
  .clay-bar-fill.clay-tone-red { background: #ef4444; } .clay-bar-fill.clay-tone-accent { background: #6366f1; }
  .clay-bar-fill.clay-tone-gray { background: #a8a29e; }
  .clay-bar-caption { font-size: 11px; color: #78716c; }
  /* view components: kanban board + card grid */
  .clay-board { display: flex; gap: 10px; align-items: flex-start; overflow-x: auto;
    padding-bottom: 2px; }
  .clay-board-col { flex: 1 1 0; min-width: 112px; background: var(--bg-soft);
    border: 1px solid var(--border); border-radius: 12px; padding: 8px;
    border-top: 2.5px solid var(--border-2); }
  .clay-board-col.tcol-green, .clay-board-col.tcol-success { border-top-color: #34c05f; }
  .clay-board-col.tcol-amber, .clay-board-col.tcol-warning { border-top-color: #f5a623; }
  .clay-board-col.tcol-red, .clay-board-col.tcol-danger { border-top-color: #ef5350; }
  .clay-board-col.tcol-accent { border-top-color: var(--accent); }
  .clay-board-col.tcol-gray, .clay-board-col.tcol-default { border-top-color: #c8ccd4; }
  .clay-board-header { display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
    color: var(--text-2); padding: 3px 5px 9px; }
  .clay-board-count { background: #e6e7ec; color: var(--text-2); border-radius: 999px;
    padding: 1px 8px; font-size: 11px; font-weight: 600; }
  .clay-board-cards { display: flex; flex-direction: column; gap: 7px; }
  .clay-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .clay-card { background: #fff; border: 1px solid var(--border-2); border-radius: 10px;
    padding: 9px 11px; box-shadow: 0 1px 2px rgba(16,24,40,.04); transition: box-shadow .1s, border-color .1s; }
  .clay-card-lg { padding: 13px 15px; }
  /* title takes the full width and wraps cleanly; a value/badge drops onto its
     own line below rather than crushing the title in a narrow kanban card */
  .clay-card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; }
  .clay-card-title { flex: 1 1 100%; font-weight: 600; font-size: 13px;
    letter-spacing: -.005em; line-height: 1.32; }
  .clay-card-head .clay-badge { flex: none; }
  /* a neutral value (e.g. a money amount) reads better as plain bold text than
     a chunky pill; keep coloured tones as pills (they signal status) */
  .clay-card-head .clay-badge.clay-tone-gray, .clay-card-head .clay-badge.clay-tone-default {
    background: transparent; color: var(--text-2); font-weight: 700; padding: 0; font-size: 12px; }
  .clay-card-subtitle { font-size: 12px; color: var(--text-2); margin-top: 3px; }
  .clay-card-field { display: flex; justify-content: space-between; font-size: 12px; margin-top: 5px; }
  .clay-card-field-label { color: var(--text-3); }
  .clay-card-draggable { cursor: grab; }
  .clay-card-draggable:hover { box-shadow: 0 3px 10px rgba(16,24,40,.10); border-color: #cfd0f5; }
  .clay-card-draggable:active { cursor: grabbing; }
  .clay-board-col-over { background: var(--accent-soft); outline: 2px dashed #b8b5f5; outline-offset: -2px; }
  .clay-clickable { cursor: pointer; }
  .clay-clickable:hover { filter: brightness(0.98); }
  .clay-card.clay-clickable:hover { border-color: #cfd0f5; box-shadow: 0 2px 8px rgba(16,24,40,.08); }
  .clay-badge-clickable:hover { filter: brightness(0.94); }

  /* timeline / gantt */
  .clay-timeline { display: flex; flex-direction: column; gap: 6px; }
  .clay-timeline-axis { display: flex; justify-content: space-between;
    font-size: 11px; color: #a8a29e; margin-left: 140px; }
  .clay-timeline-row { display: flex; align-items: center; gap: 8px; }
  .clay-timeline-label { width: 132px; flex: none; font-size: 12px; color: #57534e;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .clay-timeline-track { position: relative; flex: 1; height: 20px;
    background: #f5f5f4; border-radius: 6px; }
  .clay-timeline-bar { position: absolute; top: 3px; height: 14px; border-radius: 5px;
    min-width: 4px; font-size: 10px; color: #fff; line-height: 14px;
    padding: 0 5px; overflow: hidden; white-space: nowrap; box-sizing: border-box;
    background: var(--accent); box-shadow: 0 1px 2px rgba(91,87,235,.28); }
  .clay-timeline-marker { position: absolute; top: 3px; width: 14px; height: 14px;
    border-radius: 50%; transform: translateX(-7px); border: 2px solid #fff; box-sizing: border-box;
    background: var(--accent); }
  /* The bar/marker are <div>s, so the clay-fill-* (SVG fill) tone classes do
     nothing — they need a real background. */
  .clay-timeline-bar.clay-fill-green, .clay-timeline-marker.clay-fill-green { background: #34c05f; }
  .clay-timeline-bar.clay-fill-amber, .clay-timeline-marker.clay-fill-amber { background: #f5a623; }
  .clay-timeline-bar.clay-fill-red, .clay-timeline-marker.clay-fill-red { background: #ef5350; }
  .clay-timeline-bar.clay-fill-gray, .clay-timeline-marker.clay-fill-gray { background: #b3b1c0; }
  .clay-timeline-caption { position: absolute; top: 2px; transform: translateX(10px);
    font-size: 11px; color: #57534e; white-space: nowrap; }

  .clay-scene svg { width: 100%; height: auto; display: block; }
  .clay-fill-default, .clay-fill-accent { fill: #6366f1; } .clay-fill-green { fill: #22c55e; }
  .clay-fill-amber { fill: #f59e0b; } .clay-fill-red { fill: #ef4444; } .clay-fill-gray { fill: #d6d3d1; }
  .clay-stroke-gray { stroke: #d6d3d1; fill: #78716c; } .clay-stroke-accent { stroke: #6366f1; fill: #6366f1; }
  .clay-stroke-green { stroke: #22c55e; fill: #166534; } .clay-stroke-amber { stroke: #f59e0b; fill: #92400e; }
  .clay-stroke-red { stroke: #ef4444; fill: #991b1b; }
  .clay-scene-text { font-size: 11px; stroke: none; }
`;

function buildSrcdoc(): string {
  const script = runtimeBundle.replace(/<\/script>/g, "<\\/script>");
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>${PANEL_CSS}</style>
</head><body><div id="root"></div><script>${script}</script></body></html>`;
}

export type PanelFaultInfo = { code: string; message: string };

// View-switcher options (moat pillar 4: one dataset, many lenses). Picking one
// fires a targeted reshape of just this panel via the normal preview→keep flow.
const VIEW_OPTIONS: { key: string; label: string; icon: string }[] = [
  { key: "table", label: "Table", icon: "▤" },
  { key: "board", label: "Board", icon: "▦" },
  { key: "cards", label: "Cards", icon: "▢" },
  { key: "chart", label: "Chart", icon: "▮" },
  { key: "timeline", label: "Timeline", icon: "▬" },
];

export function PanelFrame(props: {
  panel: LivePanel;
  bridge: Bridge;
  preview?: boolean;
  fault?: PanelFaultInfo;
  onRepair?: () => void;
  onRevert?: () => void;
  onDismiss?: () => void;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  draggingSrc?: boolean;
  wide?: boolean;
  onResize?: () => void;
  onViewAs?: (view: string) => void;
}): React.JSX.Element {
  const { panel, bridge, preview } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [viewsPos, setViewsPos] = useState<{ top: number; left: number } | null>(null);
  const viewsBtnRef = useRef<HTMLButtonElement>(null);
  const openViews = (): void => {
    const r = viewsBtnRef.current?.getBoundingClientRect();
    if (r) {
      const w = 152; const h = 224;
      const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      const top = Math.min(r.bottom + 6, window.innerHeight - h - 8);
      setViewsPos({ top, left });
    }
    setViewsOpen(o => !o);
  };

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let detached = false;
    const onLoad = (): void => {
      if (detached || !iframe.contentWindow) return;
      const channel = new MessageChannel();
      iframe.contentWindow.postMessage({ type: "clay_boot_port" }, "*", [channel.port2]);
      channel.port1.start();
      void bridge.attachPanel({
        panelId: panel.panel_id, title: panel.title, placement: panel.placement,
        code: panel.code, declaredQueries: panel.declared_queries,
        declaredWrites: panel.declared_writes,
      }, portFromMessagePort(channel.port1));
    };
    iframe.addEventListener("load", onLoad);

    // Auto-height: size the iframe to its content (no scrollbars, no
    // wasted space). The panel posts clay_resize from inside the sandbox.
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== iframe.contentWindow) return;
      const d = e.data as { kind?: string; height?: number } | null;
      if (d && d.kind === "clay_resize" && typeof d.height === "number") {
        setHeight(Math.max(48, Math.min(4000, Math.ceil(d.height))));
      }
    };
    window.addEventListener("message", onMessage);

    return (): void => {
      detached = true;
      iframe.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
      bridge.detachPanel(panel.panel_id);
    };
  }, [panel, bridge]);

  return (
    <section className={`panel-frame${preview ? " panel-preview" : ""}${props.draggingSrc ? " panel-drag-src" : ""}${props.wide ? " panel-wide" : ""}`}>
      <header className="panel-title">
        {props.onDragStart ? (
          <span
            className="panel-grip"
            draggable
            title="Drag to rearrange"
            onDragStart={e => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", panel.panel_id);
              const section = e.currentTarget.closest(".panel-frame");
              if (section) e.dataTransfer.setDragImage(section as Element, 24, 16);
              props.onDragStart!(panel.panel_id);
            }}
            onDragEnd={() => props.onDragEnd?.()}
          >⠿</span>
        ) : null}
        {panel.title}
        {preview ? <span className="panel-proposed">proposed</span> : null}
        <span className="panel-tools">
          {props.onViewAs ? (
            <span className="panel-views">
              <button
                ref={viewsBtnRef}
                className="panel-tool"
                title="Show this data another way"
                onClick={openViews}
              >⇄</button>
              {viewsOpen && viewsPos ? createPortal(
                <>
                  <div className="panel-views-backdrop" onClick={() => setViewsOpen(false)} />
                  <div className="panel-views-menu"
                    style={{ position: "fixed", top: viewsPos.top, left: viewsPos.left }}>
                    <span className="panel-views-head">View as</span>
                    {VIEW_OPTIONS.map(v => (
                      <button
                        key={v.key}
                        className="panel-views-item"
                        onClick={() => { setViewsOpen(false); props.onViewAs!(v.key); }}
                      >{v.icon} {v.label}</button>
                    ))}
                  </div>
                </>,
                document.body,
              ) : null}
            </span>
          ) : null}
          {props.onResize ? (
            <button
              className="panel-resize panel-tool"
              title={props.wide ? "Make narrow" : "Make wide"}
              onClick={props.onResize}
            >{props.wide ? "◨" : "▭"}</button>
          ) : null}
        </span>
      </header>
      <iframe
        ref={iframeRef}
        title={panel.panel_id}
        sandbox="allow-scripts"
        srcDoc={buildSrcdoc()}
        style={height !== null ? { height: `${height}px` } : undefined}
      />
      {props.fault ? (
        <div className="panel-boundary">
          <p className="panel-boundary-title">This panel hit a problem.</p>
          <p className="panel-boundary-msg">
            {props.fault.code}: {props.fault.message}
          </p>
          <div className="rail-actions">
            {props.onRepair ? (
              <button className="primary" onClick={props.onRepair}>Repair</button>
            ) : null}
            {props.onRevert ? (
              <button onClick={props.onRevert}>Roll back this panel</button>
            ) : null}
            <button className="link" onClick={props.onDismiss}>Dismiss</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
