// The time slider (doc 02 §6): scrubbing is a read-only render of the
// panel manifest at version K against CURRENT data — no inverses run.
// Only "Make this the latest" touches the schema, behind an explicit
// warning (ADR-007: truncation is the one destructive-ish operation).
import type { HistoryEntry } from "@clay/kernel";

export function TimeSlider(props: {
  history: HistoryEntry[];       // oldest first
  current: number;               // scrubbed version, or head
  scrubbed: boolean;
  disabled: boolean;
  onScrub: (version: number) => void;
  onMakeLatest: () => void;
}): React.JSX.Element | null {
  const { history } = props;
  if (history.length < 2) return null;
  const head = history[history.length - 1]!.version;
  const entry = history.find(h => h.version === props.current);

  return (
    <div className={`timeslider${props.scrubbed ? " timeslider-scrubbed" : ""}`}>
      <input
        type="range"
        min={history[0]!.version}
        max={head}
        step={1}
        value={props.current}
        disabled={props.disabled}
        aria-label="App history"
        onChange={e => props.onScrub(Number(e.target.value))}
      />
      <div className="timeslider-info">
        <span className="timeslider-version">
          v{props.current}{props.scrubbed ? ` of ${head}` : " · now"}
        </span>
        <span className="timeslider-summary">{entry?.summary}</span>
        {props.scrubbed ? (
          <span className="timeslider-actions">
            <button className="primary" onClick={props.onMakeLatest}>
              Make this the latest
            </button>
            <button onClick={() => props.onScrub(head)}>Back to now</button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
