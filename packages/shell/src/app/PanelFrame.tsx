// PanelHost (doc 02 §1): one sandboxed iframe per live panel. srcdoc +
// sandbox="allow-scripts" gives an opaque origin — no cookies, storage, or
// parent DOM; the CSP leaves no network path (doc 06 §2). The only channel
// is one transferred MessagePort speaking the Bridge protocol.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { portFromMessagePort, type Bridge, type LivePanel } from "@clay/kernel";
// The fixed bootstrap, built to a single file and inlined (doc 06 §2).
import runtimeBundle from "@clay/panel-runtime/iframe-bundle?raw";

const PANEL_CSS = `
  :root { color-scheme: light;
    --font: "Segoe UI Variable Text", "SF Pro Text", -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    --font-display: "Segoe UI Variable Display", "SF Pro Display", -apple-system, system-ui, "Segoe UI", sans-serif;
    --panel: #ffffff; --text: #2b2a33; --text-2: #6d6b78; --text-3: #a6a4b1;
    --border: #efeef3; --border-2: #e7e5ee; --bg-soft: #f8f7fb;
    --accent: #6a67e6; --accent-soft: #f1f0fc; --accent-text: #4b47c4;
    --chart-area: rgba(106,103,230,.12);
    /* categorical series palette (light steps) — validated order, never cycle
       or reorder without re-running the palette validator (dataviz ADR-023) */
    --series-1: #6a67e6; --series-2: #008300; --series-3: #e87ba4;
    --series-4: #eda100; --series-5: #1baf7a; --series-6: #eb6834; }
  body { margin: 0; font: 13px/1.55 var(--font); background: var(--panel);
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
  .clay-empty { color: var(--text-3); padding: 26px 12px; text-align: center;
    font-size: 12.5px; }
  .clay-empty::before { content: "◇"; display: block; font-size: 18px; color: var(--border-2);
    margin: 0 auto 8px; }
  .clay-stack > * + * { margin-top: 8px; }
  /* KPIs sit in one row when there's room, wrap cleanly otherwise */
  .clay-grid { display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); }
  .clay-grid { grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); }
  .clay-metric { position: relative; display: flex; flex-direction: column; gap: 6px;
    padding: 13px 13px 12px 15px; background: linear-gradient(180deg, var(--panel), var(--bg-soft));
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
  .clay-field-label { font-size: 11px; font-weight: 600; color: var(--text-2);
    letter-spacing: .01em; }
  .clay-input, .clay-select, .clay-form textarea {
    border: 1px solid var(--border-2); border-radius: 9px;
    padding: 9px 11px; font: inherit; background: var(--panel); color: var(--text);
    transition: border-color .12s, box-shadow .12s; }
  .clay-input:hover, .clay-select:hover, .clay-form textarea:hover { border-color: #d7d5e6; }
  .clay-input:focus, .clay-select:focus, .clay-form textarea:focus { outline: none;
    border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .clay-button { border: 0; border-radius: 10px; padding: 9px 15px; font: inherit;
    font-weight: 600; color: #fff; cursor: pointer;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 86%, #fff), var(--accent));
    box-shadow: 0 2px 9px color-mix(in srgb, var(--accent) 38%, transparent), inset 0 1px 0 rgba(255,255,255,.18);
    transition: transform .08s ease, box-shadow .12s ease, filter .12s ease; }
  .clay-button:hover { filter: brightness(1.06); box-shadow: 0 4px 15px color-mix(in srgb, var(--accent) 45%, transparent); }
  .clay-button:active { transform: translateY(1px); box-shadow: 0 1px 4px rgba(91,87,235,.35); }
  .clay-filterbar { display: flex; gap: 8px; }
  .clay-chart { position: relative; }
  .clay-chart svg { width: 100%; height: auto; display: block; overflow: visible;
    animation: clay-chart-in .42s ease both; }
  .clay-chart-grid { stroke: var(--border); stroke-width: .75; }
  .clay-chart-ylab { fill: var(--text-3); }
  .clay-chart-total { fill: var(--text); font-family: var(--font-display);
    letter-spacing: -.02em; }
  .clay-chart-bar:hover, .clay-chart-mbar:hover { filter: brightness(1.12); }
  .clay-chart-slice:hover { filter: brightness(1.07); }
  .clay-chart-tip { position: absolute; z-index: 5; pointer-events: none;
    background: var(--text); color: var(--panel); font-size: 11px; font-weight: 600;
    line-height: 1.35; padding: 4px 9px; border-radius: 7px; white-space: nowrap;
    opacity: 0; transform: translate(-50%, -100%) translateY(-6px);
    transition: opacity .1s; box-shadow: 0 3px 12px rgba(0,0,0,.18); }
  .clay-chart-tip.on { opacity: .97; }
  @keyframes clay-chart-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  @keyframes clay-bar-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @media (prefers-reduced-motion: reduce) {
    .clay-chart svg, .clay-chart-bar, .clay-chart-mbar { animation: none; } }
  .clay-chart-bar, .clay-chart-mbar { transform-box: fill-box; transform-origin: bottom;
    animation: clay-bar-grow .52s cubic-bezier(.2,.85,.3,1) both; }
  .clay-chart-bar { fill: var(--accent); }
  /* slice colour is set inline (per category); the 2px surface-colored
     stroke is the mandated gap between adjacent fills */
  .clay-chart-slice { stroke: var(--panel); stroke-width: 2; }
  .clay-chart-axis { stroke: var(--border-2); stroke-width: 1; }
  .clay-chart-line { fill: none; stroke: var(--accent); stroke-width: 2.25;
    stroke-linejoin: round; stroke-linecap: round; }
  .clay-chart-areafill { fill: var(--chart-area); stroke: none; }
  .clay-chart-dot { fill: var(--panel); stroke: var(--accent); stroke-width: 1.75; }
  .clay-chart-val { fill: var(--text-2); }
  .clay-chart-xtick { fill: var(--text-3); }
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
  .clay-bar-track { flex: 1; height: 14px; background: var(--bg-soft); border-radius: 999px; overflow: hidden; }
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
  .clay-board-count { background: var(--border-2); color: var(--text-2); border-radius: 999px;
    padding: 1px 8px; font-size: 11px; font-weight: 600; }
  .clay-board-cards { display: flex; flex-direction: column; gap: 7px; }
  .clay-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .clay-card { background: var(--panel); border: 1px solid var(--border-2); border-radius: 10px;
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

  /* Flow: staged process with one-click advance (ADR-024) */
  .clay-flow { display: flex; flex-direction: column; gap: 8px; }
  .clay-flow-rail { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding-bottom: 2px; }
  .clay-flow-step { display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 999px; background: var(--bg-soft);
    border: 1px solid var(--border-2); font-size: 11px; font-weight: 650;
    color: var(--text-2); letter-spacing: .01em; }
  .clay-flow-step-count { background: var(--border-2); color: var(--text-2);
    border-radius: 999px; padding: 0 7px; font-size: 10.5px; font-weight: 700; }
  .clay-flow-step-green, .clay-flow-step-success { border-color: #34c05f55; color: #15803d; }
  .clay-flow-step-amber, .clay-flow-step-warning { border-color: #f5a62355; color: #b45309; }
  .clay-flow-step-red, .clay-flow-step-danger { border-color: #ef535055; color: #c02626; }
  .clay-flow-step-accent { border-color: var(--accent); color: var(--accent-text); }
  .clay-flow-arrow { color: var(--text-3); font-size: 11px; }
  .clay-flow-progress { display: flex; align-items: center; gap: 10px; }
  .clay-flow-progress-track { flex: 1; height: 6px; border-radius: 999px;
    background: var(--bg-soft); overflow: hidden; }
  .clay-flow-progress-fill { height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #fff));
    transition: width .3s ease; }
  .clay-flow-progress-caption { font-size: 11px; color: var(--text-3);
    white-space: nowrap; font-weight: 600; }
  .clay-flow-group-head { font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .06em; color: var(--text-3); margin-top: 6px; }
  .clay-flow-item { display: flex; align-items: center; gap: 10px;
    padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px;
    background: var(--panel); box-shadow: 0 1px 2px rgba(16,24,40,.04);
    transition: border-color .1s, box-shadow .1s; }
  .clay-flow-item:hover { border-color: var(--border-2); box-shadow: 0 2px 8px rgba(16,24,40,.07); }
  .clay-flow-item-main { flex: 1; min-width: 0; }
  .clay-flow-item-title { font-weight: 600; font-size: 13px; line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clay-flow-item-sub { font-size: 11.5px; color: var(--text-2); margin-top: 1px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clay-flow-actions { display: flex; align-items: center; gap: 6px; flex: none; }
  .clay-flow-advance { border: 0; border-radius: 8px; padding: 5px 11px;
    font: inherit; font-size: 11.5px; font-weight: 650; cursor: pointer;
    background: var(--accent-soft); color: var(--accent-text);
    transition: filter .1s, transform .08s; white-space: nowrap; }
  .clay-flow-advance:hover { filter: brightness(1.05); }
  .clay-flow-advance:active { transform: translateY(1px); }
  .clay-flow-advance.clay-flow-armed { background: #fdf0d5; color: #b45309;
    box-shadow: 0 0 0 2px #f5a62366; }
  .clay-flow-back { border: 1px solid var(--border-2); border-radius: 8px;
    background: none; color: var(--text-3); font: inherit; font-size: 12px;
    width: 24px; height: 24px; line-height: 1; cursor: pointer; padding: 0; }
  .clay-flow-back:hover { color: var(--text); border-color: var(--text-3); }
  .clay-flow-done { color: #15803d; font-weight: 800; font-size: 13px; }

  /* timeline / gantt */
  .clay-timeline { display: flex; flex-direction: column; gap: 6px; }
  .clay-timeline-axis { display: flex; justify-content: space-between;
    font-size: 11px; color: #a8a29e; margin-left: 140px; }
  .clay-timeline-row { display: flex; align-items: center; gap: 8px; }
  .clay-timeline-label { width: 132px; flex: none; font-size: 12px; color: #57534e;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .clay-timeline-track { position: relative; flex: 1; height: 20px;
    background: var(--bg-soft); border-radius: 6px; }
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

function buildSrcdoc(themeCss: string): string {
  const script = runtimeBundle.replace(/<\/script>/g, "<\\/script>");
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>${PANEL_CSS}${themeCss}</style>
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
  onSetWidth?: (w: number) => void;
  onSetHeight?: (h: number) => void;
  onViewAs?: (view: string) => void;
  onEditData?: (table: string) => void;
  onRename?: (title: string) => void;
  onRemove?: () => void;
  onAskAbout?: () => void;
  themeCss?: string;
}): React.JSX.Element {
  const { panel, bridge, preview } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [headerH, setHeaderH] = useState(49);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  // Masonry (ADR-022a): the section spans exact 1px grid rows for its
  // measured height, so uneven panels pack without holes. Header height is
  // measured because titles can wrap.
  useLayoutEffect(() => {
    const h = headerRef.current?.offsetHeight;
    if (h && h !== headerH) setHeaderH(h);
  });
  const [viewsOpen, setViewsOpen] = useState(false);
  const [dragW, setDragW] = useState<number | null>(null);   // live width preview (cols 1–4)
  const [dragH, setDragH] = useState<number | null>(null);   // live height preview (px)
  // Edge/corner drag-resize (ADR-018). Width snaps to 1–4 columns from the
  // cursor's distance across the region; height is continuous. Pointer capture
  // keeps events flowing even over the sandboxed iframe.
  const startResize = (
    e: React.PointerEvent<HTMLDivElement>, dims: { width?: boolean; height?: boolean },
  ): void => {
    e.preventDefault(); e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const section = handle.closest(".panel-frame") as HTMLElement | null;
    const region = section?.parentElement ?? null;
    const rect = section?.getBoundingClientRect();
    const startLeft = rect?.left ?? 0; const startTop = rect?.top ?? 0;
    const spanFrom = (x: number): number => {
      const r = region?.getBoundingClientRect();
      if (!r) return 2;
      return Math.max(1, Math.min(4, Math.round((x - startLeft) / (r.width / 4))));
    };
    const hFrom = (y: number): number => Math.max(120, Math.min(1600, Math.round(y - startTop)));
    const apply = (ev: PointerEvent, commit: boolean): void => {
      const w = dims.width ? spanFrom(ev.clientX) : null;
      const h = dims.height ? hFrom(ev.clientY) : null;
      if (w !== null) setDragW(commit ? null : w);
      if (h !== null) setDragH(commit ? null : h);
      if (commit) {
        if (w !== null) props.onSetWidth?.(w);
        if (h !== null) props.onSetHeight?.(h);
      }
    };
    handle.onpointermove = (ev): void => apply(ev, false);
    handle.onpointerup = (ev): void => {
      handle.onpointermove = null; handle.onpointerup = null;
      try { handle.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      apply(ev, true);
    };
  };
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
    // Attach exactly once per iframe: the render key encodes panel version,
    // preview state, and theme, so any change that needs a re-boot remounts
    // the whole frame. Re-running on prop identity churn (refreshPanels)
    // would detachPanel and orphan the panel's watches — the iframe never
    // fires "load" again, so attachPanel would never re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live size: dragW/dragH preview, then the stored placement, then defaults.
  // Width (cols 1–4) applies in the top AND main grids (ADR-022a); default
  // is a full strip (4) in top, half (2) in main.
  // The panel's primary table (first declared read) — the one "Edit data" jumps to.
  const editTable = panel.declared_queries[0]?.from ?? null;
  const inGrid = panel.placement.region !== "side";
  const defaultW = panel.placement.region === "top" ? 4 : 2;
  const span = inGrid ? (dragW ?? panel.placement.w ?? defaultW) : null;
  const effHeight = dragH ?? panel.placement.h ?? height;
  const resizing = dragW !== null || dragH !== null;
  const sectionStyle: React.CSSProperties = {};
  if (span !== null) {
    // pinned to a start column (2D, ADR-019) or auto-flow
    const col = panel.placement.col;
    sectionStyle.gridColumn = col != null ? `${col + 1} / span ${span}` : `span ${span}`;
    // masonry row span (ADR-022a): header + iframe + borders + 16px gap,
    // in 1px implicit rows (see .region-top/.region-main in styles.css)
    sectionStyle.gridRow = `span ${(effHeight ?? 180) + headerH + 2 + 16}`;
  }
  return (
    <section
      className={`panel-frame${preview ? " panel-preview" : ""}${props.draggingSrc ? " panel-drag-src" : ""}${resizing ? " panel-resizing" : ""}`}
      style={sectionStyle}
    >
      <header className="panel-title" ref={headerRef}>
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
        {editTitle !== null ? (
          <input
            className="panel-title-edit"
            autoFocus
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const t = editTitle.trim();
                setEditTitle(null);
                if (t && t !== panel.title) props.onRename?.(t);
              } else if (e.key === "Escape") setEditTitle(null);
            }}
            onBlur={() => {
              const t = (editTitle ?? "").trim();
              setEditTitle(null);
              if (t && t !== panel.title) props.onRename?.(t);
            }}
          />
        ) : (
          <span
            className={props.onRename ? "panel-title-text panel-renamable" : "panel-title-text"}
            title={props.onRename ? "Double-click to rename" : undefined}
            onDoubleClick={props.onRename ? () => setEditTitle(panel.title) : undefined}
          >{panel.title}</span>
        )}
        {preview ? <span className="panel-proposed">proposed</span> : null}
        <span className="panel-tools">
          {props.onAskAbout ? (
            <button
              className="panel-tool"
              title="Reshape this panel — describe the change"
              onClick={props.onAskAbout}
            >✨</button>
          ) : null}
          {props.onEditData && editTable ? (
            <button
              className="panel-tool"
              title={`Edit the ${editTable} data`}
              onClick={() => props.onEditData!(editTable)}
            >✎</button>
          ) : null}
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
          {props.onRemove ? (
            <button
              className="panel-tool panel-tool-remove"
              title="Remove this panel — rewind the timeline to bring it back"
              onClick={props.onRemove}
            >✕</button>
          ) : null}
        </span>
      </header>
      <iframe
        ref={iframeRef}
        title={panel.panel_id}
        sandbox="allow-scripts"
        srcDoc={buildSrcdoc(props.themeCss ?? "")}
        style={effHeight !== null ? { height: `${effHeight}px` } : undefined}
      />
      {props.onSetWidth ? (
        <div className="panel-edge-resize e" title="Drag to resize width"
          onPointerDown={e => startResize(e, { width: true })}><span className="panel-edge-grip" /></div>
      ) : null}
      {props.onSetHeight ? (
        <div className="panel-edge-resize s" title="Drag to resize height"
          onPointerDown={e => startResize(e, { height: true })}><span className="panel-edge-grip" /></div>
      ) : null}
      {props.onSetWidth && props.onSetHeight ? (
        <div className="panel-corner-resize" title="Drag to resize"
          onPointerDown={e => startResize(e, { width: true, height: true })} />
      ) : null}
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
