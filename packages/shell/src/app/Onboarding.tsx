import { useEffect, useRef, useState } from "react";
import { STARTER_SHELL_CATALOG, type StarterShellId } from "../shells/starter-catalog";
import {
  DEFAULT_STARTER_GOAL, STARTER_GOALS, recommendStarter, type StarterGoalId,
} from "./starter-recommendation";

const SHELL_ICONS: Record<string, string> = {
  tracker: "T", log: "L", dashboard: "D", small_business: "S", crm: "C",
  financials: "$", staff: "P", habits: "H", inventory: "I", approvals: "A",
  jobs: "J", content: "P", okrs: "O", events: "E", library: "B",
};

export function Onboarding(props: {
  onPick: (id: StarterShellId) => void;
  onImport: (file: File) => void;
  busy: boolean;
  error?: string | null;
  onCancel?: () => void;
}): React.JSX.Element {
  const [goal, setGoal] = useState<StarterGoalId>(DEFAULT_STARTER_GOAL);
  const [showGoals, setShowGoals] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recommendation = recommendStarter(goal);
  const templates = STARTER_SHELL_CATALOG.filter(shell => shell.id !== "blank");

  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => {
    if (!props.onCancel) return;
    const cancel = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onCancel?.();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [props.onCancel]);

  return (
    <main className="onboarding" aria-busy={props.busy}>
      <h1 ref={headingRef} tabIndex={-1}>{props.onCancel ? "Create another app" : "Welcome to Clay"}</h1>
      <p className="ui ui-color-text-2 onboarding-sub">
        Pick what you want to manage. Clay recommends a working starter locally, without a model call.
      </p>

      <section aria-labelledby="start-heading">
        <h2 id="start-heading">Choose how to start</h2>
        <div className="onboarding-primary">
          <button className="ui ui-display-flex ui-align-items-center ui-background-panel ui-color-text ui-base-border-8f9f0d ui-text-align-left ui-base-border-radius-c431a0 ui-box-shadow-shadow ui-width-100 ui-gap-16px onboarding-hero" data-start-priority="primary"
            disabled={props.busy} onClick={() => fileRef.current?.click()}>
            <span className="ui ui-display-grid ui-flex-none ui-place-items-center ui-background-accent-soft ui-color-accent onboarding-hero-spark" aria-hidden="true">+</span>
            <span className="ui ui-display-flex ui-gap-3px onboarding-hero-text">
              <span className="onboarding-hero-title">Import a spreadsheet</span>
              <span className="ui ui-color-text-2 ui-font-size-13px onboarding-hero-sub">
                Choose a CSV or XLSX file, review every accepted, skipped, and limited row, then import.
              </span>
            </span>
            <span className="ui ui-white-space-nowrap ui-color-accent onboarding-hero-go" aria-hidden="true">Review</span>
          </button>
          <input ref={fileRef} hidden tabIndex={-1} aria-hidden="true" type="file"
            accept=".csv,.tsv,.txt,.xlsx" disabled={props.busy}
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) props.onImport(file);
              event.target.value = "";
            }} />
          <button className="ui ui-display-flex ui-align-items-center ui-background-panel ui-color-text ui-base-border-8f9f0d ui-text-align-left ui-base-border-radius-c431a0 ui-box-shadow-shadow ui-width-100 ui-gap-16px onboarding-hero" data-start-priority="primary"
            disabled={props.busy} onClick={() => props.onPick(recommendation.shellId)}>
            <span className="ui ui-display-grid ui-flex-none ui-place-items-center ui-background-accent-soft ui-color-accent onboarding-hero-spark" aria-hidden="true">
              {SHELL_ICONS[recommendation.shellId] ?? "*"}
            </span>
            <span className="ui ui-display-flex ui-gap-3px onboarding-hero-text">
              <span className="onboarding-hero-title">Use a recommended starter</span>
              <span className="ui ui-color-text-2 ui-font-size-13px onboarding-hero-sub">
                <strong>{recommendation.name}.</strong> {recommendation.rationale} {recommendation.tagline}
              </span>
            </span>
            <span className="ui ui-white-space-nowrap ui-color-accent onboarding-hero-go" aria-hidden="true">Open</span>
          </button>
        </div>
      </section>

      {props.busy ? <p role="status" className="ui ui-color-accent-text empty-canvas-busy">Setting up your app...</p> : null}
      {props.error ? <p role="alert" className="boot-error-msg">{props.error}</p> : null}

      <div className="ui ui-display-flex ui-align-items-center ui-color-text-3 ui-gap-12px ui-font-size-12px ui-text-transform-uppercase onboarding-or">Other ways to start</div>
      <button className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-f41cca ui-text-align-left ui-gap-7px ui-box-shadow-shadow shell-card onboarding-refine" disabled={props.busy}
        aria-expanded={showGoals} aria-controls="goal-refinement"
        onClick={() => setShowGoals(open => !open)}>
        <span className="shell-name">Change recommendation</span>
        <span className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 shell-tagline">Answer one short question to choose a different starter.</span>
      </button>
      {showGoals ? (
        <section id="goal-refinement" aria-labelledby="goal-heading">
          <h2 id="goal-heading">What do you want to manage?</h2>
          <div className="ui ui-display-grid ui-gap-14px onboarding-cards" role="group" aria-label="What do you want to manage?">
            {STARTER_GOALS.slice(0, 6).map(choice => (
              <button key={choice.id} className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-f41cca ui-text-align-left ui-gap-7px ui-box-shadow-shadow shell-card"
                aria-pressed={goal === choice.id} disabled={props.busy}
                onClick={() => setGoal(choice.id)}>
                <span className="shell-name">{choice.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <div className="ui ui-display-grid ui-gap-14px onboarding-cards onboarding-secondary">
        <button className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-f41cca ui-text-align-left ui-gap-7px ui-box-shadow-shadow shell-card" disabled={props.busy}
          aria-expanded={showAll} aria-controls="starter-gallery"
          onClick={() => setShowAll(open => !open)}>
          <span className="shell-name">See all templates</span>
          <span className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 shell-tagline">Choose a different ready-made starter.</span>
        </button>
        <button className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-f41cca ui-text-align-left ui-gap-7px ui-box-shadow-shadow shell-card" disabled={props.busy}
          aria-expanded={showAdvanced} aria-controls="onboarding-advanced"
          onClick={() => setShowAdvanced(open => !open)}>
          <span className="shell-name">Advanced options</span>
          <span className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 shell-tagline">Open an empty app when you want to build it yourself.</span>
        </button>
      </div>

      {showAdvanced ? (
        <section id="onboarding-advanced" aria-label="Advanced start options">
          <button className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-f41cca ui-text-align-left ui-gap-7px ui-box-shadow-shadow shell-card" disabled={props.busy} onClick={() => props.onPick("blank")}>
            <span className="shell-name">Start from scratch</span>
            <span className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 shell-tagline">Open an empty app and customize it when you are ready.</span>
          </button>
        </section>
      ) : null}

      {showAll ? (
        <section id="starter-gallery" aria-labelledby="gallery-heading">
          <h2 id="gallery-heading">All templates</h2>
          <div className="ui ui-display-grid ui-gap-14px onboarding-cards">
            {templates.map(shell => (
              <button key={shell.id} className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-f41cca ui-text-align-left ui-gap-7px ui-box-shadow-shadow shell-card" disabled={props.busy}
                onClick={() => props.onPick(shell.id)}>
                <span className="ui ui-display-grid ui-place-items-center ui-background-accent-soft ui-border-radius-11px shell-card-icon" aria-hidden="true">
                  {SHELL_ICONS[shell.id] ?? "*"}
                </span>
                <span className="shell-name">{shell.name}</span>
                <span className="ui ui-color-text-2 ui-font-size-13px ui-line-height-1-45 shell-tagline">{shell.tagline}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {props.onCancel ? (
        <button className="ui ui-font-size-13px link onboarding-cancel" onClick={props.onCancel}>
          Back to my apps
        </button>
      ) : null}
    </main>
  );
}
