// ConversationRail (doc 02 §1): intent input, attempt feed, the diff card
// with Keep/Discard (S5/S6), clarify and amber failure cards, and the
// minimal settings (BYO key, P3: stored locally, sent only to Anthropic).
import { useEffect, useRef, useState } from "react";
import type { Suggestion } from "@clay/kernel";
import type { PreviewInfo } from "../worker/db-worker";
import type { StatusInfo } from "./worker-client";
import type { Theme } from "./themes";

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
  onSaveBackend: (url: string) => void;
  onRemoveSamples: () => void;
  onReset: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  suggestions: Suggestion[];
  onAcceptSuggestion: (s: Suggestion) => void;
  onDismissSuggestion: (s: Suggestion) => void;
  loadStatus: () => Promise<StatusInfo>;
  onCopyDiagnostics: () => void;
  seed?: { text: string; n: number };
  /** hosted-mode usage meter from /me (Phase 1.2); null quota = unlimited */
  meter?: { used: number; quota: number | null } | null;
  themes: Theme[];
  themeId: string;
  onSelectTheme: (id: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [backendDraft, setBackendDraft] = useState("");
  const [showSettings, setShowSettings] = useState(!props.hasKey);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Empty-canvas example chips seed the input (and focus it) so the user can
  // send or edit — the moat, one click away.
  const seedN = props.seed?.n ?? 0;
  useEffect(() => {
    if (props.seed && props.seed.text) {
      setText(props.seed.text);
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedN]);

  useEffect(() => {
    if (showSettings) void props.loadStatus().then(setStatus).catch(() => setStatus(null));
  }, [showSettings, props]);

  const mb = (n: number | null): string =>
    n == null ? "—" : n < 1e6 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1e6).toFixed(1)} MB`;

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
        <span className="rail-header-links">
          <button className="link" onClick={() => setShowSettings(s => !s)}>
            ⚙ settings
          </button>
        </span>
      </header>

      {showSettings ? (
        <div className="rail-settings">
          <div className="theme-picker">
            <span className="rail-label" style={{ marginBottom: 6 }}>Color scheme</span>
            <div className="theme-swatches">
              {props.themes.map(t => (
                <button
                  key={t.id}
                  className={`theme-swatch${t.id === props.themeId ? " selected" : ""}`}
                  title={t.name}
                  onClick={() => props.onSelectTheme(t.id)}
                  style={{ background: t.vars.bg, color: t.vars.text, borderColor: t.vars.borderStrong }}
                >
                  <span className="theme-dot" style={{ background: t.vars.accent }} />
                  <span className="theme-name">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
          {status ? (
            <div className="rail-status">
              <div>
                Storage:{" "}
                {status.persistent
                  ? (status.persisted ? "persistent ✓" : "on this device (not yet pinned)")
                  : "in-memory — will not persist"}
              </div>
              {status.persistent ? (
                <div>Using {mb(status.usageBytes)} of {mb(status.quotaBytes)}</div>
              ) : null}
              <div>
                {status.versions} change{status.versions === 1 ? "" : "s"} ·{" "}
                {status.stats.kept} kept · {status.stats.discarded} discarded ·{" "}
                {status.stats.clarify} clarified
              </div>
            </div>
          ) : null}
          {props.meter && props.meter.quota !== null ? (
            <div className={`rail-meter${props.meter.used / props.meter.quota >= 0.5 ? " rail-meter-warm" : ""}`}>
              <span>Reshapes this period: {props.meter.used} of {props.meter.quota}</span>
              <span className="rail-meter-track">
                <span className="rail-meter-fill" style={{
                  width: `${Math.min(100, Math.round((props.meter.used / props.meter.quota) * 100))}%` }} />
              </span>
            </div>
          ) : null}
          <label className="rail-label">
            Clay backend URL (hosted — no key needed in the browser)
            <input
              type="text"
              value={backendDraft}
              placeholder="http://localhost:8787"
              onChange={e => setBackendDraft(e.target.value)}
            />
          </label>
          <div className="rail-actions">
            <button
              className="primary"
              onClick={() => { props.onSaveBackend(backendDraft.trim()); setBackendDraft(""); setShowSettings(false); }}
            >
              Use hosted backend
            </button>
          </div>
          <label className="rail-label">
            or your own Anthropic API key (BYO — stored in this browser, sent only to Anthropic)
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
          <div className="rail-actions">
            <button className="link" onClick={props.onExport}>
              Export .clay backup
            </button>
            <label className="link file-label">
              Import backup…
              <input
                type="file"
                accept=".clay,.zip"
                style={{ display: "none" }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) props.onImport(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <div className="rail-actions">
            <button className="link" onClick={props.onCopyDiagnostics}>
              Copy diagnostics (last {25} reshapes)
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
        {props.busy ? (
          <div className="feed-item feed-info reshaping">
            <span className="reshaping-dots"><i /><i /><i /></span>Reshaping…
          </div>
        ) : null}
      </div>

      {props.suggestions.length > 0 && !props.preview ? (
        <div className="rail-suggestions">
          {props.suggestions.map(s => (
            <div key={s.id} className="suggestion-chip">
              <span className="suggestion-reason">{s.reason}</span>
              <span className="rail-actions">
                <button className="primary" onClick={() => props.onAcceptSuggestion(s)}>
                  Do it
                </button>
                <button className="link" onClick={() => props.onDismissSuggestion(s)}>
                  no thanks
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

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
            ref={inputRef}
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
