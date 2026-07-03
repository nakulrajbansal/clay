// First run (G9/US-01): pick one of three starter shells; seeding is local
// and instant — the model is never involved (doc 09 W4, G9).
import { STARTER_SHELLS, type StarterShellId } from "../shells/seed";

export function Onboarding(props: {
  onPick: (id: StarterShellId) => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <div className="onboarding">
      <h1>Clay</h1>
      <p className="onboarding-sub">
        One app that reshapes itself when you describe a change.
        Start from a shell — everything about it can change later,
        and your data survives every change.
      </p>
      <div className="onboarding-cards">
        {STARTER_SHELLS.map(shell => (
          <button
            key={shell.id}
            className="shell-card"
            disabled={props.busy}
            onClick={() => props.onPick(shell.id)}
          >
            <span className="shell-name">{shell.name}</span>
            <span className="shell-tagline">{shell.tagline}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
