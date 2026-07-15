// First run (G9/US-01): the empty-slate "Blank canvas" is featured first —
// the moat, front and center (nothing → describe → it becomes an app) —
// then the ready-made templates. Seeding is local and instant.
import { STARTER_SHELLS, type StarterShellId } from "../shells/seed";

// A quiet icon per template — enough to make the choices inviting, not loud.
const SHELL_ICONS: Record<string, string> = {
  tracker: "🎯", log: "📆", dashboard: "📊",
  small_business: "🏪", crm: "🤝", financials: "💰", staff: "🗓️", habits: "🔥", inventory: "📦",
  approvals: "✅", jobs: "💼", content: "📝",
};

export function Onboarding(props: {
  onPick: (id: StarterShellId) => void;
  busy: boolean;
  onCancel?: () => void;
}): React.JSX.Element {
  const blank = STARTER_SHELLS.find(s => s.id === "blank")!;
  const templates = STARTER_SHELLS.filter(s => s.id !== "blank");
  return (
    <div className="onboarding">
      <h1>{props.onCancel ? "New app" : "Clay"}</h1>
      <p className="onboarding-sub">
        {props.onCancel
          ? "Start blank and describe it, or begin from a template. Your other apps are untouched."
          : "One app that becomes whatever you describe — in plain language — while your "
            + "data outlives every version of it. Start from nothing, or a template."}
      </p>

      <button
        className="onboarding-hero"
        disabled={props.busy}
        onClick={() => props.onPick("blank")}
      >
        <span className="onboarding-hero-spark">✦</span>
        <span className="onboarding-hero-text">
          <span className="onboarding-hero-title">Start from scratch</span>
          <span className="onboarding-hero-sub">{blank.tagline}</span>
        </span>
        <span className="onboarding-hero-go">Build →</span>
      </button>

      <div className="onboarding-or">or begin from a template</div>
      <div className="onboarding-cards">
        {templates.map(shell => (
          <button
            key={shell.id}
            className="shell-card"
            disabled={props.busy}
            onClick={() => props.onPick(shell.id)}
          >
            <span className="shell-card-icon" aria-hidden="true">{SHELL_ICONS[shell.id] ?? "✦"}</span>
            <span className="shell-name">{shell.name}</span>
            <span className="shell-tagline">{shell.tagline}</span>
          </button>
        ))}
      </div>
      {props.onCancel ? (
        <button className="link onboarding-cancel" onClick={props.onCancel}>
          ← Back to my apps
        </button>
      ) : null}
    </div>
  );
}
