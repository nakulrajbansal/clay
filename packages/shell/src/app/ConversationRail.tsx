// ConversationRail (doc 02 §1): intent input, attempt feed, the diff card
// with Keep/Discard (S5/S6), clarify and amber failure cards, and the
// minimal settings (BYO key, P3: stored locally, sent only to Anthropic).
import { useEffect, useRef, useState } from "react";
import type { Suggestion } from "@clay/kernel";
import type { PreviewInfo } from "../worker/db-worker";
import type { StatusInfo } from "./worker-client";
import type { Theme } from "./themes";
import { buildChangeContract } from "./change-contract";
import type { FeedItem } from "./feed";
export { pruneFeedAfterVersion, type FeedItem } from "./feed";
import { CODEX_BACKEND_URL, type ModelProviderId } from "./settings";

const MODEL_PROVIDERS: Array<{ id: ModelProviderId; name: string; detail: string }> = [
  { id: "clay", name: "Clay hosted", detail: "Managed backend and account" },
  { id: "openai", name: "OpenAI", detail: "Responses API through your backend" },
  { id: "codex", name: "Local Codex (Preview)", detail: "Use this computer’s Codex login" },
  { id: "anthropic", name: "Anthropic", detail: "Bring your browser API key" },
];

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
  onPurgeAttachments: () => Promise<void>;
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
    <aside className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-overflow-hidden ui-min-height-0 rail">
      <header className="ui ui-display-flex ui-justify-content-space-between ui-align-items-baseline rail-header">
        <span>Ask Clay</span>
        <span className="ui ui-display-flex ui-gap-14px rail-header-links">
          <button className="link" onClick={() => setShowSettings(s => !s)}>
            ⚙ Advanced
          </button>
        </span>
      </header>

      {showSettings ? (
        <div className="ui ui-flex-none ui-border-bottom-line ui-overflow-y-auto rail-settings">
          <fieldset className="ui ui-border-0 ui-margin-0 model-provider-picker">
            <legend>Model connection</legend>
            <div className="ui ui-display-grid ui-gap-6px model-provider-options">
              {MODEL_PROVIDERS.map(provider => (
                <button key={provider.id} type="button"
                  className={`ui ui-display-flex ui-background-panel ui-color-text ui-min-width-0 ui-flex-direction-column ui-base-border-8f9f0d ui-border-radius-10px ui-text-align-left ui-base-gap-2e0455 model-provider-option${props.modelProvider === provider.id ? " selected" : ""}`}
                  aria-pressed={props.modelProvider === provider.id}
                  onClick={() => props.onSelectModelProvider(provider.id)}>
                  <b>{provider.name}</b><span>{provider.detail}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {status ? (
            <div className={`ui ui-display-flex ui-align-items-center ui-gap-8px ui-border-radius-10px ui-base-border-f41cca ui-background-bg-soft model-connection-status${status.modelConnection.reachable ? " connected" : ""}`}>
              <span className="ui ui-flex-none ui-border-radius-50 model-status-dot" aria-hidden="true" />
              <span><b>{status.modelConnection.provider}</b>
                {status.modelConnection.model ? ` · ${status.modelConnection.model}` : ""}
                <small>{status.modelConnection.detail}</small></span>
            </div>
          ) : null}
          {props.modelProvider === "codex" ? (
            <div className="ui ui-display-grid ui-color-text-2 ui-border-radius-10px ui-background-accent-soft ui-font-size-11px ui-gap-4px model-provider-note">
              <b>Local connector</b>
              <span>Run <code>pnpm codex</code>, then Clay connects to {CODEX_BACKEND_URL}.</span>
              <span>Your Codex login stays on this computer.</span>
            </div>
          ) : null}
          <div className="theme-picker">
            <span className="ui ui-display-flex ui-color-text-2 ui-flex-direction-column ui-font-size-12px ui-inputfocus-outline-89c3b3 ui-gap-5px ui-inputfocus-box-shadow-0cf866 ui-inputfocus-border-color-a722a4 ui-input-font-648ad9 ui-input-border-58fb43 ui-input-border-radius-9af632 rail-label" style={{ marginBottom: 6 }}>Color scheme</span>
            <div className="ui ui-display-grid ui-gap-7px theme-swatches">
              {props.themes.map(t => (
                <button
                  key={t.id}
                  className={`ui ui-display-flex ui-align-items-center ui-color-text ui-base-border-8f9f0d ui-border-radius-10px ui-font-inherit ui-gap-7px theme-swatch${t.id === props.themeId ? " selected" : ""}`}
                  title={t.name}
                  onClick={() => props.onSelectTheme(t.id)}
                  style={{ background: t.vars.bg, color: t.vars.text, borderColor: t.vars.borderStrong }}
                >
                  <span className="ui ui-flex-none ui-border-radius-50 theme-dot" style={{ background: t.vars.accent }} />
                  <span className="ui ui-overflow-hidden ui-white-space-nowrap ui-text-overflow-ellipsis theme-name">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
          {status ? (
            <div className="ui ui-display-flex ui-color-text-2 ui-flex-direction-column ui-border-radius-10px ui-base-border-f41cca ui-font-size-12px ui-background-bg ui-gap-3px ui-padding-10px-12px ui-base-margin-bottom-38a7cc rail-status">
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
                Files: {status.attachments.activeFiles} · {mb(status.attachments.activeBytes)}
                {status.attachments.deletedFiles > 0
                  ? ` · ${status.attachments.deletedFiles} retained after removal` : ""}
              </div>
              {status.attachments.deletedFiles > 0 ? (
                <button className="link" onClick={() => void props.onPurgeAttachments()
                  .then(() => props.loadStatus()).then(setStatus)}>
                  Clean up files removed over 30 days ago
                </button>
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
            <div className={`ui ui-display-flex ui-color-text-2 ui-flex-direction-column ui-border-radius-10px ui-base-border-f41cca ui-background-bg-soft ui-gap-5px ui-padding-10px-12px ui-base-margin-bottom-38a7cc rail-meter${props.meter.used / props.meter.quota >= 0.5 ? " rail-meter-warm" : ""}`}>
              <span>Reshapes this period: {props.meter.used} of {props.meter.quota}</span>
              <span className="ui ui-overflow-hidden ui-border-radius-999px rail-meter-track">
                <span className="ui ui-border-radius-999px ui-base-display-4b026d ui-background-accent rail-meter-fill" style={{
                  width: `${Math.min(100, Math.round((props.meter.used / props.meter.quota) * 100))}%` }} />
              </span>
            </div>
          ) : null}
          {props.modelProvider === "clay" && props.account ? (
            <div className="ui ui-display-flex ui-align-items-center ui-color-text-2 ui-justify-content-space-between ui-border-radius-10px ui-base-border-f41cca ui-background-bg-soft ui-gap-10px ui-font-size-12-5px ui-base-margin-bottom-38a7cc rail-account">
              <span className="ui ui-b-color-a7ddc1 rail-account-who">Signed in as <b>{props.account.email}</b></span>
              <button className="link" onClick={props.onSignOut}>sign out</button>
            </div>
          ) : props.modelProvider === "clay" && props.onSignIn ? (
            <div className="ui ui-display-flex ui-align-items-center ui-color-text-2 ui-justify-content-space-between ui-border-radius-10px ui-base-border-f41cca ui-background-bg-soft ui-gap-10px ui-base-display-4b026d ui-font-size-12-5px ui-base-margin-bottom-38a7cc rail-account rail-account-signin">
              <label className="ui ui-display-flex ui-color-text-2 ui-flex-direction-column ui-font-size-12px ui-inputfocus-outline-89c3b3 ui-gap-5px ui-inputfocus-box-shadow-0cf866 ui-inputfocus-border-color-a722a4 ui-input-font-648ad9 ui-input-border-58fb43 ui-input-border-radius-9af632 rail-label">
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
              <div className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-12px rail-actions">
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
              <label className="ui ui-display-flex ui-color-text-2 ui-flex-direction-column ui-font-size-12px ui-inputfocus-outline-89c3b3 ui-gap-5px ui-inputfocus-box-shadow-0cf866 ui-inputfocus-border-color-a722a4 ui-input-font-648ad9 ui-input-border-58fb43 ui-input-border-radius-9af632 rail-label">
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
              <div className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-12px rail-actions">
                <button className="primary"
                  onClick={() => { props.onSaveBackend(backendDraft.trim()); setBackendDraft(""); }}>
                  Save backend
                </button>
              </div>
            </>
          ) : null}
          {props.modelProvider === "anthropic" ? (
            <>
              <label className="ui ui-display-flex ui-color-text-2 ui-flex-direction-column ui-font-size-12px ui-inputfocus-outline-89c3b3 ui-gap-5px ui-inputfocus-box-shadow-0cf866 ui-inputfocus-border-color-a722a4 ui-input-font-648ad9 ui-input-border-58fb43 ui-input-border-radius-9af632 rail-label">
                Anthropic API key (stored in this browser and sent only to Anthropic)
                <input type="password" value={keyDraft}
                  placeholder={props.hasKey ? "saved" : "sk-ant-…"}
                  onChange={e => setKeyDraft(e.target.value)} />
              </label>
              <div className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-12px rail-actions">
                <button className="primary" disabled={keyDraft.trim().length === 0}
                  onClick={() => { props.onSaveKey(keyDraft.trim()); setKeyDraft(""); }}>
                  Save Anthropic key
                </button>
              </div>
            </>
          ) : null}
          <div className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-12px rail-actions">
            <button className="link" onClick={props.onRemoveSamples}>
              Clear example data
            </button>
            <button className="link danger" onClick={props.onReset}>
              Start over…
            </button>
          </div>
          <div className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-12px rail-actions">
            <button className="link" onClick={props.onExport}>
              Export portable .clay copy
            </button>
          </div>
          <div className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-12px rail-actions">
            <button className="link" onClick={props.onCopyDiagnostics}>
              Copy diagnostics (last {25} reshapes)
            </button>
          </div>
        </div>
      ) : null}

      <div className="ui ui-display-flex ui-gap-9px ui-overflow-y-auto ui-min-height-0 rail-feed" tabIndex={0} role="log" aria-label="Recent changes">
        {props.feed.map((item, i) => {
          switch (item.kind) {
            case "intent":
              return <div key={i} className="ui ui-font-size-13px ui-line-height-1-45 ui-border-radius-11px ui-background-accent feed-item feed-intent">{item.text}</div>;
            case "clarify":
              return <div key={i} className="ui ui-font-size-13px ui-color-accent-text ui-background-accent-soft ui-line-height-1-45 ui-border-radius-11px feed-item feed-clarify">{item.question}</div>;
            case "failure":
              return (
                <div key={i} className="ui ui-font-size-13px ui-line-height-1-45 ui-border-radius-11px ui-color-warn feed-item feed-failure">
                  <strong>That didn’t work.</strong>
                  <ul>{item.reasons.map((r, j) => <li key={j}>{r}</li>)}</ul>
                </div>
              );
            case "committed":
              return (
                <details key={i} className="ui ui-font-size-13px ui-overflow-hidden ui-line-height-1-45 ui-border-radius-11px ui-base-background-e37a96 feed-item feed-committed trust-receipt"
                  onToggle={event => { if (event.currentTarget.open) props.onReceiptOpened(); }}>
                  <summary>
                    <span><b>Kept</b> {item.summary}</span>
                    <span className="feed-version">v{item.version}</span>
                  </summary>
                  {item.receipt ? (
                    <div className="ui ui-display-grid ui-gap-8px trust-receipt-body">
                      <div className="ui ui-display-flex ui-flex-wrap-wrap ui-gap-5px ui-span-border-radius-0b7e91 trust-receipt-proof">
                        <span>✓ Rows retained</span><span>✓ Reversible</span>
                        <span>✓ {item.receipt.affectedViews.length} view{item.receipt.affectedViews.length === 1 ? "" : "s"}</span>
                      </div>
                      <ul className="ui ui-color-text-2 ui-line-height-1-45 ui-margin-0 ui-font-size-11-5px trust-receipt-changes">
                        {item.receipt.changes.map((change, index) =>
                          <li key={index}>{change.detail}</li>)}
                      </ul>
                      {item.receipt.dataAccess.length > 0 ? (
                        <p className="ui ui-color-text-3 ui-margin-0 ui-font-size-10-5px trust-receipt-access">
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
              return <div key={i} className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 ui-border-radius-11px feed-item feed-discarded">Not kept: {item.summary}</div>;
            case "info":
              return <div key={i} className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 ui-border-radius-11px feed-item feed-info">{item.text}</div>;
          }
        })}
        {props.busy ? (
          <div className="ui ui-display-flex ui-align-items-center ui-color-text-2 ui-font-size-13px ui-line-height-1-45 ui-border-radius-11px feed-item feed-info reshaping">
            <span className="ui ui-display-inline-flex ui-gap-3px reshaping-dots"><i /><i /><i /></span>
            {RESHAPE_STAGES[stageIx]}
          </div>
        ) : null}
      </div>

      {props.suggestions.length > 0 && !props.preview ? (
        <div className="ui ui-display-flex ui-gap-8px ui-border-top-line ui-overflow-y-auto rail-suggestions">
          {props.suggestions.map(s => (
            <div key={s.id} className="ui ui-display-flex ui-font-size-13px ui-flex-direction-column ui-background-accent-soft ui-gap-7px ui-border-radius-11px ui-padding-10px-12px suggestion-chip">
              <span className="ui ui-color-accent-text suggestion-reason">{s.reason}</span>
              <span className="ui ui-display-flex ui-align-items-center ui-flex-wrap-wrap ui-gap-12px rail-actions">
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
        <div className="ui ui-background-panel ui-overflow-auto change-contract" role="region" aria-label="Proposed change">
          <header className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-gap-12px contract-header">
            <div>
              <span className="contract-eyebrow">Proposed change</span>
              <strong>Ready as v{contract.version}</strong>
            </div>
            <span className="ui ui-align-items-center ui-display-inline-flex ui-text-transform-uppercase ui-gap-5px contract-verified"><i aria-hidden="true">✓</i> verified</span>
          </header>

          <p className="ui ui-color-text ui-line-height-1-45 contract-summary">{contract.summary}</p>

          <div className="ui ui-display-grid ui-gap-6px contract-guarantees" aria-label="Safety guarantees">
            {contract.guarantees.map(guarantee => (
              <span key={guarantee.id} className="ui ui-min-width-0 ui-border-radius-10px ui-text-align-center ui-base-background-e37a96 contract-guarantee" title={guarantee.detail}>
                <i aria-hidden="true">✓</i>{guarantee.label}
              </span>
            ))}
          </div>

          <section className="ui ui-border-bottom-line contract-section">
            <span className="contract-label">What changes</span>
            <ul className="ui ui-font-size-13px ui-margin-0 diff-lines">
              {contract.changes.map((change, index) => (
                <li key={index} className={`diff-${change.kind}`}>{change.detail}</li>
              ))}
            </ul>
          </section>

          {contract.dataAccess.length > 0 ? (
            <section className="ui ui-border-bottom-line contract-section">
              <span className="contract-label">Panel data access</span>
              <div className="ui ui-display-flex ui-flex-wrap-wrap ui-gap-6px contract-chips">
                {contract.dataAccess.map(access => (
                  <span key={access.table} className={`ui ui-color-text ui-base-border-f41cca ui-display-inline-flex ui-overflow-hidden ui-background-bg-soft ui-border-radius-8px ui-gap-5px ui-white-space-nowrap ui-small-color-0803d9 ui-text-overflow-ellipsis ui-align-items-baseline contract-chip contract-chip-${access.mode}`}>
                    {access.table}<small>{access.mode === "read_write" ? "read + write" : access.mode}</small>
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {contract.changedViews.length > 0 || contract.removedPanelIds.length > 0 ? (
            <section className="ui ui-border-bottom-line contract-section">
              <span className="contract-label">Affected views</span>
              <div className="ui ui-display-flex ui-flex-wrap-wrap ui-gap-6px contract-chips">
                {contract.changedViews.map(view => (
                  <span key={view.id} className="ui ui-color-text ui-base-border-f41cca ui-display-inline-flex ui-overflow-hidden ui-background-bg-soft ui-border-radius-8px ui-gap-5px ui-white-space-nowrap ui-small-color-0803d9 ui-text-overflow-ellipsis ui-align-items-baseline contract-chip contract-view">
                    {view.title}<small>{view.access === "none" ? "presentation" : view.access.replace("_", " + ")}</small>
                  </span>
                ))}
                {contract.removedPanelIds.length > 0 ? (
                  <span className="ui ui-color-text ui-base-border-f41cca ui-display-inline-flex ui-overflow-hidden ui-background-bg-soft ui-border-radius-8px ui-gap-5px ui-white-space-nowrap ui-small-color-0803d9 ui-text-overflow-ellipsis ui-align-items-baseline contract-chip contract-remove">
                    {contract.removedPanelIds.length} removed<small>rewindable</small>
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}

          {contract.repaired ? (
            <p className="ui ui-border-radius-8px ui-font-size-10-5px contract-repair">One repair round was needed before this preview passed.</p>
          ) : null}
          <p className="ui ui-color-text-2 ui-text-align-center ui-font-size-11px contract-promise">Nothing is live until you keep it.</p>
          <div className="ui ui-display-grid ui-background-panel ui-gap-8px ui-base-position-df0639 contract-actions">
            <button className="primary" onClick={props.onKeep}>Keep this change</button>
            <button onClick={props.onDiscard}>Go back</button>
          </div>
        </div>
      ) : (
        <div className="ui ui-display-flex ui-gap-10px ui-border-top-line rail-input">
          <textarea
            ref={inputRef}
            value={text}
            placeholder='Ask Clay for a change… e.g. "add a priority field and show it as a colored badge"'
            maxLength={500}
            rows={3}
            disabled={props.busy}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          <button className="primary" disabled={props.busy || text.trim() === ""} onClick={submit}>
            Preview this change
          </button>
        </div>
      )}
    </aside>
  );
}
