// PanelHost (doc 02 §1): one sandboxed iframe per live panel. srcdoc +
// sandbox="allow-scripts" gives an opaque origin — no cookies, storage, or
// parent DOM; the CSP leaves no network path (doc 06 §2). The only channel
// is one transferred MessagePort speaking the Bridge protocol.
import { useEffect, useRef } from "react";
import { portFromMessagePort, type Bridge, type LivePanel } from "@clay/kernel";
// The fixed bootstrap, built to a single file and inlined (doc 06 §2).
import runtimeBundle from "@clay/panel-runtime/iframe-bundle?raw";

const PANEL_CSS = `
  :root { color-scheme: light; }
  body { margin: 0; font: 13px/1.45 system-ui, sans-serif; color: #1c1917; padding: 10px; }
  .clay-table { width: 100%; border-collapse: collapse; }
  .clay-table th { text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: .04em; color: #78716c; padding: 4px 8px; border-bottom: 1px solid #e7e5e4; }
  .clay-table td { padding: 6px 8px; border-bottom: 1px solid #f5f5f4; }
  .clay-badge { display: inline-block; padding: 1px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; background: #f5f5f4; }
  .clay-tone-green, .clay-tone-success { background: #dcfce7; color: #166534; }
  .clay-tone-amber, .clay-tone-warning { background: #fef3c7; color: #92400e; }
  .clay-tone-red, .clay-tone-danger { background: #fee2e2; color: #991b1b; }
  .clay-tone-gray, .clay-tone-default { background: #f5f5f4; color: #57534e; }
  .clay-tone-accent { background: #e0e7ff; color: #3730a3; }
  .clay-empty { color: #a8a29e; padding: 18px 6px; text-align: center; }
  .clay-stack > * + * { margin-top: 8px; }
  .clay-grid { display: flex; gap: 10px; flex-wrap: wrap; }
  .clay-metric { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px;
    border: 1px solid #e7e5e4; border-radius: 10px; min-width: 90px; }
  .clay-metric-label { font-size: 11px; color: #78716c; text-transform: uppercase; }
  .clay-metric-value { font-size: 20px; font-weight: 700; }
  .clay-form { display: flex; flex-direction: column; gap: 8px; }
  .clay-field { display: flex; flex-direction: column; gap: 3px; }
  .clay-field-label { font-size: 11px; color: #78716c; }
  .clay-input, .clay-select { border: 1px solid #d6d3d1; border-radius: 7px;
    padding: 6px 8px; font: inherit; }
  .clay-button { border: 0; border-radius: 8px; padding: 7px 12px; font: inherit;
    font-weight: 600; background: #1c1917; color: #fafaf9; cursor: pointer; }
  .clay-filterbar { display: flex; gap: 8px; }
  .clay-chart svg { width: 100%; height: auto; display: block; }
  .clay-chart-bar, .clay-chart-slice { fill: #6366f1; }
  .clay-chart-slice:nth-of-type(2n) { fill: #a5b4fc; }
  .clay-chart-slice:nth-of-type(3n) { fill: #4338ca; }
  .clay-chart-line { fill: none; stroke: #6366f1; stroke-width: 2; }
  .clay-chart-area { fill: #6366f155; stroke: #6366f1; }
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
  .clay-board { display: flex; gap: 10px; align-items: flex-start; overflow-x: auto; }
  .clay-board-col { flex: 1; min-width: 150px; background: #fafaf9;
    border: 1px solid #f0efed; border-radius: 10px; padding: 8px; }
  .clay-board-header { display: flex; justify-content: space-between; align-items: center;
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    color: #78716c; padding: 2px 4px 8px; }
  .clay-board-count { background: #e7e5e4; color: #57534e; border-radius: 999px;
    padding: 0 7px; font-size: 11px; }
  .clay-board-cards { display: flex; flex-direction: column; gap: 6px; }
  .clay-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .clay-card { background: #fff; border: 1px solid #e7e5e4; border-radius: 9px; padding: 8px 10px; }
  .clay-card-lg { padding: 12px 14px; }
  .clay-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
  .clay-card-title { font-weight: 600; font-size: 13px; }
  .clay-card-subtitle { font-size: 12px; color: #78716c; margin-top: 2px; }
  .clay-card-field { display: flex; justify-content: space-between; font-size: 12px; margin-top: 4px; }
  .clay-card-field-label { color: #a8a29e; }
  .clay-clickable { cursor: pointer; }
  .clay-clickable:hover { border-color: #a8a29e; background: #fafaf9; }

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

export function PanelFrame(props: {
  panel: LivePanel;
  bridge: Bridge;
  preview?: boolean;
  fault?: PanelFaultInfo;
  onRepair?: () => void;
  onRevert?: () => void;
  onDismiss?: () => void;
}): React.JSX.Element {
  const { panel, bridge, preview } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
    return (): void => {
      detached = true;
      iframe.removeEventListener("load", onLoad);
      bridge.detachPanel(panel.panel_id);
    };
  }, [panel, bridge]);

  return (
    <section className={`panel-frame${preview ? " panel-preview" : ""}`}>
      <header className="panel-title">
        {panel.title}
        {preview ? <span className="panel-proposed">proposed</span> : null}
      </header>
      <iframe
        ref={iframeRef}
        title={panel.panel_id}
        sandbox="allow-scripts"
        srcDoc={buildSrcdoc()}
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
