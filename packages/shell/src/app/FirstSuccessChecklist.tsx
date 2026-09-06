import {
  FIRST_WRITE_STORAGE_COPY, TEMPORARY_FIRST_WRITE_COPY,
  firstSuccessCount, type FirstSuccessState,
} from "./first-success-state";

const labels = {
  app: "Start with a working app",
  realRecord: "Add your first real record",
  work: "Review your Work view",
  customization: "Keep your first customization",
} as const;

type StepName = keyof typeof labels;

export function FirstSuccessChecklist(props: {
  state: FirstSuccessState | null;
  loading: boolean;
  error: string | null;
  persistent?: boolean;
  onAddRecord: () => void;
  onReviewWork: () => void;
  onCustomize: () => void;
  onDismiss: () => void;
  onResume: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  if (props.loading) {
    return <section className="banner" role="status">Loading setup checklist…</section>;
  }
  if (props.error || !props.state) {
    return (
      <section className="banner" role="alert" style={{ flexWrap: "wrap" }}>
        <span>{props.error ?? "Setup progress could not be loaded. Your records were not changed."}</span>
        <span className="banner-actions">
          <button className="link" onClick={props.onRetry}>Try again</button>
        </span>
      </section>
    );
  }

  const { state } = props;
  const count = firstSuccessCount(state);
  if (state.dismissed) {
    return (
      <section className="banner" aria-label="Setup checklist" style={{ flexWrap: "wrap" }}>
        <span>{count} of 4 setup steps complete</span>
        <span className="banner-actions">
          <button className="link" onClick={props.onResume}>Continue setup</button>
        </span>
      </section>
    );
  }

  const order: StepName[] = ["app", "realRecord", "work", "customization"];
  const firstPending = order.find(step => state.steps[step].state === "pending") ?? null;
  const status = (step: StepName): string => state.steps[step].state === "complete"
    ? "Complete" : firstPending === step ? "Next" : "Not started";
  const nextAction = firstPending === "realRecord"
    ? { label: "Add a real record", run: props.onAddRecord }
    : firstPending === "work"
      ? { label: "Review Work", run: props.onReviewWork }
      : firstPending === "customization"
        ? { label: "Customize", run: props.onCustomize } : null;

  return (
    <section className="banner" aria-labelledby="first-success-title"
      style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 520px", minWidth: 0 }}>
        <h2 id="first-success-title" style={{ fontSize: 14, margin: "0 0 6px" }}>
          Make this app yours
        </h2>
        <ol style={{ display: "grid", gap: 3, margin: 0, paddingLeft: 22 }}>
          {order.map(step => (
            <li key={step} aria-current={firstPending === step ? "step" : undefined}>
              <span>{labels[step]}: </span><strong>{status(step)}</strong>
            </li>
          ))}
        </ol>
        {state.steps.realRecord.state === "pending" ? (
          <p style={{ margin: "7px 0 0", color: "var(--text-2)" }}>
            {props.persistent === false ? TEMPORARY_FIRST_WRITE_COPY : FIRST_WRITE_STORAGE_COPY}
          </p>
        ) : null}
      </div>
      <div className="banner-actions" style={{ alignItems: "center", minHeight: 44 }}>
        {nextAction ? (
          <button className="link" style={{ minHeight: 44 }} onClick={nextAction.run}>
            {nextAction.label}
          </button>
        ) : null}
        <button className="link" style={{ minHeight: 44 }} onClick={props.onDismiss}>Dismiss</button>
      </div>
    </section>
  );
}
