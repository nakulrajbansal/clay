import { FocusInput } from "./FocusControl";
// The History surface — the moat's third pillar made tangible: an app's
// WHOLE evolution as a navigable timeline. Every version is a moment you can
// jump to (render the app as it was, read-only) or restore to (rewind the
// live app). No model call, no data risk — a trusted read over the version
// log (created_at / intent_text / summary per version, ADR-007 linear).
import { useEffect, useRef, useState } from "react";
import type { HistoryEntry } from "@clay/kernel";

export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HistoryView(props: {
  history: HistoryEntry[];       // oldest first
  head: number;
  current: number;               // scrubbed version, or head
  onJump: (version: number) => void;
  onRestore: (version: number) => void;
  onSetCheckpoint: (version: number, label: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const entries = [...props.history].reverse();   // newest first
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>("button")?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const startEdit = (v: number, label: string): void => { setEditing(v); setDraft(label); };
  const save = (v: number): void => { props.onSetCheckpoint(v, draft); setEditing(null); };
  return (
    <div ref={dialogRef} className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-overflow-hidden ui-position-fixed ui-box-shadow-shadow-lg historyview" role="dialog" aria-label="Recent changes"
      tabIndex={-1} onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation();
        if (editing !== null) setEditing(null);
        else props.onClose();
      }}>
      <div className="ui ui-display-flex ui-justify-content-space-between ui-border-bottom-line ui-align-items-flex-start historyview-header">
        <div>
          <h2 className="ui ui-margin-0 historyview-title">Recent changes</h2>
          <p className="ui ui-color-text-2 ui-font-size-13px historyview-sub">
            {props.history.length} saved point{props.history.length === 1 ? "" : "s"} ·
            preview an earlier point or go back to it
          </p>
        </div>
        <button className="link" onClick={props.onClose}>Close</button>
      </div>
      <div className="ui ui-overflow-y-auto historyview-body">
        <ol className="ui ui-position-relative ui-margin-0 ui-padding-0 timeline">
          {entries.map(e => {
            const isHead = e.version === props.head;
            const isCurrent = e.version === props.current;
            return (
              <li
                key={e.version}
                className={`ui ui-position-relative tl-item${isHead ? " tl-head" : ""}${isCurrent ? " tl-current" : ""}`}
              >
                <span className="ui ui-border-radius-50 ui-position-absolute tl-dot" aria-hidden="true" />
                <div className="ui ui-background-panel ui-base-border-f41cca ui-base-border-radius-25b77c tl-card">
                  <div className="ui ui-display-flex ui-align-items-center ui-gap-8px tl-meta">
                    <span className="ui ui-color-accent-text tl-ver">v{e.version}</span>
                    {e.label ? <span className="ui ui-color-accent-text ui-background-accent-soft ui-border-radius-999px tl-label">{e.label}</span> : null}
                    {isHead ? <span className="ui ui-text-transform-uppercase ui-border-radius-999px ui-base-background-e37a96 tl-now">now</span> : null}
                    {isCurrent && !isHead ? <span className="ui ui-color-accent-text ui-background-accent-soft ui-text-transform-uppercase ui-border-radius-999px tl-viewing">viewing</span> : null}
                    <span className="ui ui-color-text-3 ui-font-size-12px tl-time">{relTime(e.created_at)}</span>
                  </div>
                  {e.intent_text ? (
                    <p className="ui ui-color-text tl-intent">“{e.intent_text}”</p>
                  ) : null}
                  <p className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 ui-margin-0 tl-summary">{e.summary}</p>
                  {e.diff && e.diff.length > 0 ? (
                    <ul className="ui ui-display-flex ui-flex-direction-column ui-gap-3px ui-padding-0 tl-diff">
                      {e.diff.slice(0, 6).map((d, i) => (
                        <li key={i} className={`tl-diff-${d.kind}`}>{d.detail}</li>
                      ))}
                    </ul>
                  ) : null}
                  {editing === e.version ? (
                    <div className="ui ui-display-flex ui-align-items-center ui-inputfocus-outline-89c3b3 ui-inputfocus-box-shadow-0cf866 ui-gap-10px ui-input-font-648ad9 ui-input-border-radius-9af632 ui-input-min-width-39910f tl-name">
                      <FocusInput
                        autoFocus
                        value={draft}
                        maxLength={60}
                        placeholder="Name this moment…"
                        onChange={ev => setDraft(ev.target.value)}
                        onKeyDown={ev => {
                          if (ev.key === "Enter") save(e.version);
                          if (ev.key === "Escape") setEditing(null);
                        }}
                      />
                      <button className="link" onClick={() => save(e.version)}>Save</button>
                      <button className="link" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="ui ui-display-flex ui-gap-14px tl-actions">
                      <button className="link" onClick={() => startEdit(e.version, e.label ?? "")}>
                        {e.label ? "Rename" : "Name this"}
                      </button>
                      {!isHead ? (
                        <>
                          <button className="link" onClick={() => props.onJump(e.version)}>
                            Preview this point
                          </button>
                          <button className="link" onClick={() => props.onRestore(e.version)}>
                            Go back to this point
                          </button>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
