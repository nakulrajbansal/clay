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
      <p className="onboarding-sub">
        Pick what you want to manage. Clay recommends a working starter locally, without a model call.
      </p>

      <section aria-labelledby="start-heading">
        <h2 id="start-heading">Choose how to start</h2>
        <div className="onboarding-primary">
          <button className="onboarding-hero" data-start-priority="primary"
            disabled={props.busy} onClick={() => fileRef.current?.click()}>
            <span className="onboarding-hero-spark" aria-hidden="true">+</span>
            <span className="onboarding-hero-text">
              <span className="onboarding-hero-title">Import a spreadsheet</span>
              <span className="onboarding-hero-sub">
                Choose a CSV or XLSX file, review every accepted, skipped, and limited row, then import.
              </span>
            </span>
            <span className="onboarding-hero-go" aria-hidden="true">Review</span>
          </button>
          <input ref={fileRef} hidden tabIndex={-1} aria-hidden="true" type="file"
            accept=".csv,.tsv,.txt,.xlsx" disabled={props.busy}
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) props.onImport(file);
              event.target.value = "";
            }} />
          <button className="onboarding-hero" data-start-priority="primary"
            disabled={props.busy} onClick={() => props.onPick(recommendation.shellId)}>
            <span className="onboarding-hero-spark" aria-hidden="true">
              {SHELL_ICONS[recommendation.shellId] ?? "*"}
            </span>
            <span className="onboarding-hero-text">
              <span className="onboarding-hero-title">Use a recommended starter</span>
              <span className="onboarding-hero-sub">
                <strong>{recommendation.name}.</strong> {recommendation.rationale} {recommendation.tagline}
              </span>
            </span>
            <span className="onboarding-hero-go" aria-hidden="true">Open</span>
          </button>
        </div>
      </section>

      {props.busy ? <p role="status" className="empty-canvas-busy">Setting up your app...</p> : null}
      {props.error ? <p role="alert" className="boot-error-msg">{props.error}</p> : null}

      <div className="onboarding-or">Other ways to start</div>
      <button className="shell-card onboarding-refine" disabled={props.busy}
        aria-expanded={showGoals} aria-controls="goal-refinement"
        onClick={() => setShowGoals(open => !open)}>
        <span className="shell-name">Change recommendation</span>
        <span className="shell-tagline">Answer one short question to choose a different starter.</span>
      </button>
      {showGoals ? (
        <section id="goal-refinement" aria-labelledby="goal-heading">
          <h2 id="goal-heading">What do you want to manage?</h2>
          <div className="onboarding-cards" role="group" aria-label="What do you want to manage?">
            {STARTER_GOALS.slice(0, 6).map(choice => (
              <button key={choice.id} className="shell-card"
                aria-pressed={goal === choice.id} disabled={props.busy}
                onClick={() => setGoal(choice.id)}>
                <span className="shell-name">{choice.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <div className="onboarding-cards onboarding-secondary">
        <button className="shell-card" disabled={props.busy}
          aria-expanded={showAll} aria-controls="starter-gallery"
          onClick={() => setShowAll(open => !open)}>
          <span className="shell-name">See all templates</span>
          <span className="shell-tagline">Choose a different ready-made starter.</span>
        </button>
        <button className="shell-card" disabled={props.busy}
          aria-expanded={showAdvanced} aria-controls="onboarding-advanced"
          onClick={() => setShowAdvanced(open => !open)}>
          <span className="shell-name">Advanced options</span>
          <span className="shell-tagline">Open an empty app when you want to build it yourself.</span>
        </button>
      </div>

      {showAdvanced ? (
        <section id="onboarding-advanced" aria-label="Advanced start options">
          <button className="shell-card" disabled={props.busy} onClick={() => props.onPick("blank")}>
            <span className="shell-name">Start from scratch</span>
            <span className="shell-tagline">Open an empty app and customize it when you are ready.</span>
          </button>
        </section>
      ) : null}

      {showAll ? (
        <section id="starter-gallery" aria-labelledby="gallery-heading">
          <h2 id="gallery-heading">All templates</h2>
          <div className="onboarding-cards">
            {templates.map(shell => (
              <button key={shell.id} className="shell-card" disabled={props.busy}
                onClick={() => props.onPick(shell.id)}>
                <span className="shell-card-icon" aria-hidden="true">
                  {SHELL_ICONS[shell.id] ?? "*"}
                </span>
                <span className="shell-name">{shell.name}</span>
                <span className="shell-tagline">{shell.tagline}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {props.onCancel ? (
        <button className="link onboarding-cancel" onClick={props.onCancel}>
          Back to my apps
        </button>
      ) : null}
    </main>
  );
}
