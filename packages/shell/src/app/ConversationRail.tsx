// ConversationRail (doc 02 §1): intent input, attempt feed, the diff card
// with Keep/Discard (S5/S6), clarify and amber failure cards, and the
// minimal settings (BYO key, P3: stored locally, sent only to Anthropic).
import { useState } from "react";
import type { PreviewInfo } from "../worker/db-worker";

export type FeedItem =
  | { kind: "intent"; text: string }
  | { kind: "clarify"; question: string }
  | { kind: "failure"; reasons: string[] }
  | { kind: "committed"; summary: string; version: number }
  | { kind: "discarded"; summary: string }
  | { kind: "info"; text: string };

export function ConversationRail(props: {
  feed: FeedItem[];
  preview: PreviewInfo | null;
  busy: boolean;
  hasKey: boolean;
  onIntent: (text: string) => void;
  onKeep: () => void;
  onDiscard: () => void;
  onSaveKey: (key: string) => void;
  onRemoveSamples: () => void;
  onReset: () => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showSettings, setShowSettings] = useState(!props.hasKey);

  const submit = (): void => {
    const t = text.trim();
    if (!t || props.busy || props.preview) return;
    setText("");
    props.onIntent(t);
  };

  return (
    <aside className="rail">
      <header className="rail-header">
        <span>Reshape</span>
        <button className="link" onClick={() => setShowSettings(s => !s)}>
          settings
        </button>
      </header>

      {showSettings ? (
        <div className="rail-settings">
          <label className="rail-label">
            Anthropic API key (BYO — stored in this browser, sent only to Anthropic)
            <input
              type="password"
              value={keyDraft}
              placeholder={props.hasKey ? "saved" : "sk-ant-…"}
              onChange={e => setKeyDraft(e.target.value)}
            />
          </label>
          <div className="rail-actions">
            <button
              className="primary"
              disabled={keyDraft.trim().length === 0}
              onClick={() => { props.onSaveKey(keyDraft.trim()); setKeyDraft(""); setShowSettings(false); }}
            >
              Save key
            </button>
            <button className="link" onClick={props.onRemoveSamples}>
              Remove sample rows
            </button>
            <button className="link danger" onClick={props.onReset}>
              Start over…
            </button>
          </div>
        </div>
      ) : null}

      <div className="rail-feed">
        {props.feed.map((item, i) => {
          switch (item.kind) {
            case "intent":
              return <div key={i} className="feed-item feed-intent">{item.text}</div>;
            case "clarify":
              return <div key={i} className="feed-item feed-clarify">{item.question}</div>;
            case "failure":
              return (
                <div key={i} className="feed-item feed-failure">
                  <strong>That didn’t work.</strong>
                  <ul>{item.reasons.map((r, j) => <li key={j}>{r}</li>)}</ul>
                </div>
              );
            case "committed":
              return (
                <div key={i} className="feed-item feed-committed">
                  {item.summary} <span className="feed-version">v{item.version}</span>
                </div>
              );
            case "discarded":
              return <div key={i} className="feed-item feed-discarded">Discarded: {item.summary}</div>;
            case "info":
              return <div key={i} className="feed-item feed-info">{item.text}</div>;
          }
        })}
        {props.busy ? <div className="feed-item feed-info">Reshaping…</div> : null}
      </div>

      {props.preview ? (
        <div className="diff-card">
          <p className="diff-summary">{props.preview.summary}</p>
          <ul className="diff-lines">
            {props.preview.diff.map((d, i) => (
              <li key={i} className={`diff-${d.kind}`}>{d.detail}</li>
            ))}
          </ul>
          {props.preview.repaired ? (
            <p className="diff-note">Took one repair round.</p>
          ) : null}
          <div className="rail-actions">
            <button className="primary" onClick={props.onKeep}>Keep</button>
            <button onClick={props.onDiscard}>Discard</button>
          </div>
        </div>
      ) : (
        <div className="rail-input">
          <textarea
            value={text}
            placeholder='Describe a change… e.g. "add a priority field and show it as a colored badge"'
            maxLength={500}
            rows={3}
            disabled={props.busy}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          <button className="primary" disabled={props.busy || text.trim() === ""} onClick={submit}>
            Reshape
          </button>
        </div>
      )}
    </aside>
  );
}
