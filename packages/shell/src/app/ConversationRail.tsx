// ConversationRail (doc 02 §1): intent input, attempt feed, the diff card
// with Keep/Discard (S5/S6), clarify and amber failure cards, and the
// minimal settings (BYO key, P3: stored locally, sent only to Anthropic).
import { useEffect, useRef, useState } from "react";
import type { Suggestion } from "@clay/kernel";
import type { PreviewInfo } from "../worker/db-worker";
import type { StatusInfo } from "./worker-client";
import type { Theme } from "./themes";
import { buildChangeContract, type TrustReceipt } from "./change-contract";
import { CODEX_BACKEND_URL, type ModelProviderId } from "./settings";

const MODEL_PROVIDERS: Array<{ id: ModelProviderId; name: string; detail: string }> = [
  { id: "clay", name: "Clay hosted", detail: "Managed backend and account" },
  { id: "openai", name: "OpenAI", detail: "Responses API through your backend" },
  { id: "codex", name: "Local Codex (Preview)", detail: "Use this computer’s Codex login" },
  { id: "anthropic", name: "Anthropic", detail: "Bring your browser API key" },
];

export type FeedItem =
  | { kind: "intent"; text: string }
  | { kind: "clarify"; question: string }
  | { kind: "failure"; reasons: string[] }
  | { kind: "committed"; summary: string; version: number; receipt?: TrustReceipt }
  | { kind: "discarded"; summary: string }
  | { kind: "info"; text: string };

export function pruneFeedAfterVersion(feed: FeedItem[], version: number): FeedItem[] {
  return feed.filter(item => item.kind !== "committed" || item.version <= version);
}

// Reshapes take 10–40s; a wait that TALKS reads as working, a spinner
// reads as stuck. Purely cosmetic pacing — real stages live in the worker.
const RESHAPE_STAGES = [
  "Reading your app's shape…",
  "Planning the change…",
  "Writing the panels…",
  "Checking it's safe and reversible…",
  "Almost done…",
];

export function ConversationRail(props: {
  feed: FeedItem[];
  preview: PreviewInfo | null;
  busy: boolean;
  hasKey: boolean;
  onIntent: (text: string) => void;
  onKeep: () => void;
  onDiscard: () => void;
  onRewind: (version: number) => void;
  onReceiptOpened: () => void;
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
  onOpenPrivateMetrics: () => void;
  seed?: { text: string; n: number };
  /** hosted-mode usage meter from /me (Phase 1.2); null quota = unlimited */
  meter?: { used: number; quota: number | null } | null;
  account?: { email: string } | null;
  onSignIn?: (email: string) => void;
  onSignOut?: () => void;
  themes: Theme[];
  themeId: string;
  onSelectTheme: (id: string) => void;
  modelProvider: ModelProviderId;
  onSelectModelProvider: (provider: ModelProviderId) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [backendDraft, setBackendDraft] = useState("");
  const [showSettings, setShowSettings] = useState(!props.hasKey);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Empty-canvas example chips seed the input (and focus it) so the user can
  // send or edit — the moat, one click away.
  const [emailDraft, setEmailDraft] = useState("");
  const [stageIx, setStageIx] = useState(0);
  useEffect(() => {
    if (!props.busy) { setStageIx(0); return; }
    const id = setInterval(() =>
      setStageIx(i => Math.min(i + 1, RESHAPE_STAGES.length - 1)), 8000);
    return () => clearInterval(id);
  }, [props.busy]);

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
  const contract = props.preview ? buildChangeContract(props.preview) : null;

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
          <fieldset className="model-provider-picker">
            <legend>Model connection</legend>
            <div className="model-provider-options">
              {MODEL_PROVIDERS.map(provider => (
                <button key={provider.id} type="button"
                  className={`model-provider-option${props.modelProvider === provider.id ? " selected" : ""}`}
                  aria-pressed={props.modelProvider === provider.id}
                  onClick={() => props.onSelectModelProvider(provider.id)}>
                  <b>{provider.name}</b><span>{provider.detail}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {status ? (
            <div className={`model-connection-status${status.modelConnection.reachable ? " connected" : ""}`}>
              <span className="model-status-dot" aria-hidden="true" />
              <span><b>{status.modelConnection.provider}</b>
                {status.modelConnection.model ? ` · ${status.modelConnection.model}` : ""}
                <small>{status.modelConnection.detail}</small></span>
            </div>
          ) : null}
          {props.modelProvider === "codex" ? (
            <div className="model-provider-note">
              <b>Local connector</b>
              <span>Run <code>pnpm codex</code>, then Clay connects to {CODEX_BACKEND_URL}.</span>
              <span>Your Codex login stays on this computer.</span>
            </div>
          ) : null}
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
              <button className="link" onClick={props.onOpenPrivateMetrics}>
                Private activity & trust
              </button>
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
          {props.modelProvider === "clay" && props.account ? (
            <div className="rail-account">
              <span className="rail-account-who">Signed in as <b>{props.account.email}</b></span>
              <button className="link" onClick={props.onSignOut}>sign out</button>
            </div>
          ) : props.modelProvider === "clay" && props.onSignIn ? (
            <div className="rail-account rail-account-signin">
              <label className="rail-label">
                Sign in (hosted mode) — we email you a link, no password
                <input
                  type="email"
                  value={emailDraft}
                  placeholder="you@example.com"
                  onChange={e => setEmailDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && emailDraft.trim() !== "") {
                      props.onSignIn!(emailDraft.trim()); setEmailDraft("");
                    }
                  }}
                />
              </label>
              <div className="rail-actions">
                <button
                  className="primary"
                  disabled={emailDraft.trim() === ""}
                  onClick={() => { props.onSignIn!(emailDraft.trim()); setEmailDraft(""); }}
                >Email me a sign-in link</button>
              </div>
            </div>
          ) : null}
          {props.modelProvider === "clay" || props.modelProvider === "openai" ? (
            <>
              <label className="rail-label">
                {props.modelProvider === "openai"
                  ? "OpenAI backend URL (the API key stays on that server)"
                  : "Clay backend URL (hosted — no key needed in the browser)"}
                <input
                  type="text"
                  value={backendDraft}
                  placeholder="http://localhost:8787"
                  onChange={e => setBackendDraft(e.target.value)}
                />
              </label>
              <div className="rail-actions">
                <button className="primary"
                  onClick={() => { props.onSaveBackend(backendDraft.trim()); setBackendDraft(""); }}>
                  Save backend
                </button>
              </div>
            </>
          ) : null}
          {props.modelProvider === "anthropic" ? (
            <>
              <label className="rail-label">
                Anthropic API key (stored in this browser and sent only to Anthropic)
                <input type="password" value={keyDraft}
                  placeholder={props.hasKey ? "saved" : "sk-ant-…"}
                  onChange={e => setKeyDraft(e.target.value)} />
              </label>
              <div className="rail-actions">
                <button className="primary" disabled={keyDraft.trim().length === 0}
                  onClick={() => { props.onSaveKey(keyDraft.trim()); setKeyDraft(""); }}>
                  Save Anthropic key
                </button>
              </div>
            </>
          ) : null}
          <div className="rail-actions">
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

      <div className="rail-feed" tabIndex={0} role="log" aria-label="Reshape history">
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
                <details key={i} className="feed-item feed-committed trust-receipt"
                  onToggle={event => { if (event.currentTarget.open) props.onReceiptOpened(); }}>
                  <summary>
                    <span><b>Kept</b> {item.summary}</span>
                    <span className="feed-version">v{item.version}</span>
                  </summary>
                  {item.receipt ? (
                    <div className="trust-receipt-body">
                      <div className="trust-receipt-proof">
                        <span>✓ Rows retained</span><span>✓ Reversible</span>
                        <span>✓ {item.receipt.affectedViews.length} view{item.receipt.affectedViews.length === 1 ? "" : "s"}</span>
                      </div>
                      <ul className="trust-receipt-changes">
                        {item.receipt.changes.map((change, index) =>
                          <li key={index}>{change.detail}</li>)}
                      </ul>
                      {item.receipt.dataAccess.length > 0 ? (
                        <p className="trust-receipt-access">
                          Data: {item.receipt.dataAccess.map(access => access.table).join(", ")}
                        </p>
                      ) : null}
                      <button className="link" disabled={props.busy || props.preview !== null}
                        onClick={() => props.onRewind(item.receipt!.rewindTo)}>
                        Rewind to v{item.receipt.rewindTo}
                      </button>
                    </div>
                  ) : null}
                </details>
              );
            case "discarded":
              return <div key={i} className="feed-item feed-discarded">Discarded: {item.summary}</div>;
            case "info":
              return <div key={i} className="feed-item feed-info">{item.text}</div>;
          }
        })}
        {props.busy ? (
          <div className="feed-item feed-info reshaping">
            <span className="reshaping-dots"><i /><i /><i /></span>
            {RESHAPE_STAGES[stageIx]}
          </div>
        ) : null}
      </div>

      {props.suggestions.length > 0 && !props.preview ? (
        <div className="rail-suggestions">
          {props.suggestions.map(s => (
            <div key={s.id} className="suggestion-chip">
              <span className="suggestion-reason">{s.reason}</span>
              <span className="rail-actions">
                <button className="primary" disabled={props.busy}
                  onClick={() => props.onAcceptSuggestion(s)}>
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

      {contract ? (
        <div className="change-contract" role="region" aria-label="Change contract">
          <header className="contract-header">
            <div>
              <span className="contract-eyebrow">Change contract</span>
              <strong>Ready as v{contract.version}</strong>
            </div>
            <span className="contract-verified"><i aria-hidden="true">✓</i> verified</span>
          </header>

          <p className="contract-summary">{contract.summary}</p>

          <div className="contract-guarantees" aria-label="Safety guarantees">
            {contract.guarantees.map(guarantee => (
              <span key={guarantee.id} className="contract-guarantee" title={guarantee.detail}>
                <i aria-hidden="true">✓</i>{guarantee.label}
              </span>
            ))}
          </div>

          <section className="contract-section">
            <span className="contract-label">What changes</span>
            <ul className="diff-lines">
              {contract.changes.map((change, index) => (
                <li key={index} className={`diff-${change.kind}`}>{change.detail}</li>
              ))}
            </ul>
          </section>

          {contract.dataAccess.length > 0 ? (
            <section className="contract-section">
              <span className="contract-label">Panel data access</span>
              <div className="contract-chips">
                {contract.dataAccess.map(access => (
                  <span key={access.table} className={`contract-chip contract-chip-${access.mode}`}>
                    {access.table}<small>{access.mode === "read_write" ? "read + write" : access.mode}</small>
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {contract.changedViews.length > 0 || contract.removedPanelIds.length > 0 ? (
            <section className="contract-section">
              <span className="contract-label">Affected views</span>
              <div className="contract-chips">
                {contract.changedViews.map(view => (
                  <span key={view.id} className="contract-chip contract-view">
                    {view.title}<small>{view.access === "none" ? "presentation" : view.access.replace("_", " + ")}</small>
                  </span>
                ))}
                {contract.removedPanelIds.length > 0 ? (
                  <span className="contract-chip contract-remove">
                    {contract.removedPanelIds.length} removed<small>rewindable</small>
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}

          {contract.repaired ? (
            <p className="contract-repair">One repair round was needed before this preview passed.</p>
          ) : null}
          <p className="contract-promise">Nothing is live until you keep it.</p>
          <div className="contract-actions">
            <button className="primary" onClick={props.onKeep}>Keep change</button>
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
