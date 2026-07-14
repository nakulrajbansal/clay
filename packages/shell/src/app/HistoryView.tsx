// The History surface — the moat's third pillar made tangible: an app's
// WHOLE evolution as a navigable timeline. Every version is a moment you can
// jump to (render the app as it was, read-only) or restore to (rewind the
// live app). No model call, no data risk — a trusted read over the version
// log (created_at / intent_text / summary per version, ADR-007 linear).
import { useState } from "react";
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
  const startEdit = (v: number, label: string): void => { setEditing(v); setDraft(label); };
  const save = (v: number): void => { props.onSetCheckpoint(v, draft); setEditing(null); };
  return (
    <div className="historyview" role="dialog" aria-label="App history">
      <div className="historyview-header">
        <div>
          <h2 className="historyview-title">History</h2>
          <p className="historyview-sub">
            {props.history.length} version{props.history.length === 1 ? "" : "s"} ·
            your app’s whole evolution — jump to any moment, or rewind to it
          </p>
        </div>
        <button className="link" onClick={props.onClose}>Close</button>
      </div>
      <div className="historyview-body">
        <ol className="timeline">
          {entries.map(e => {
            const isHead = e.version === props.head;
            const isCurrent = e.version === props.current;
            return (
              <li
                key={e.version}
                className={`tl-item${isHead ? " tl-head" : ""}${isCurrent ? " tl-current" : ""}`}
              >
                <span className="tl-dot" aria-hidden="true" />
                <div className="tl-card">
                  <div className="tl-meta">
                    <span className="tl-ver">v{e.version}</span>
                    {e.label ? <span className="tl-label">{e.label}</span> : null}
                    {isHead ? <span className="tl-now">now</span> : null}
                    {isCurrent && !isHead ? <span className="tl-viewing">viewing</span> : null}
                    <span className="tl-time">{relTime(e.created_at)}</span>
                  </div>
                  {e.intent_text ? (
                    <p className="tl-intent">“{e.intent_text}”</p>
                  ) : null}
                  <p className="tl-summary">{e.summary}</p>
                  {editing === e.version ? (
                    <div className="tl-name">
                      <input
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
                    <div className="tl-actions">
                      <button className="link" onClick={() => startEdit(e.version, e.label ?? "")}>
                        {e.label ? "Rename" : "Name this"}
                      </button>
                      {!isHead ? (
                        <>
                          <button className="link" onClick={() => props.onJump(e.version)}>
                            Jump here
                          </button>
                          <button className="link" onClick={() => props.onRestore(e.version)}>
                            Rewind to here
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
