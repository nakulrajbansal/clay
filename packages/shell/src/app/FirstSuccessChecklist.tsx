import {
  FIRST_WRITE_STORAGE_COPY, TEMPORARY_FIRST_WRITE_COPY,
  firstSuccessCount, type FirstSuccessState,
} from "./first-success-state";
import { targetIdentityEquals } from "@clay/kernel/protection";
import type { DeviceProtectionProjection } from "../worker/db-worker";

const labels = {
  realRecord: "Add your first real record",
  everyday: "Do one everyday action",
  reshapePreview: "Ask Clay for one small change",
  reshapeKept: "Review and Keep the Preview",
} as const;

type StepName = keyof typeof labels;

export function FirstSuccessChecklist(props: {
  state: FirstSuccessState | null;
  loading: boolean;
  error: string | null;
  persistent?: boolean;
  protection?: DeviceProtectionProjection | null;
  onAddRecord: () => void;
  onDoEveryday: () => void;
  onAskClay: () => void;
  onReviewPreview: () => void;
  onDismiss: () => void;
  onResume: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  if (props.loading) {
    return <section className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-flex-none ui-gap-16px ui-color-warn banner" role="status">Loading setup checklist…</section>;
  }
  if (props.error || !props.state) {
    return (
      <section className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-flex-none ui-gap-16px ui-color-warn banner" role="alert" style={{ flexWrap: "wrap" }}>
        <span>{props.error ?? "Setup progress could not be loaded. Your records were not changed."}</span>
        <span className="ui ui-display-flex ui-flex-none ui-gap-14px banner-actions">
          <button className="link" onClick={props.onRetry}>Try again</button>
        </span>
      </section>
    );
  }

  const { state } = props;
  const count = firstSuccessCount(state);
  const exactProtected = props.protection?.result.state === "protected_on_device"
    && props.protection.checkpoint.state === "valid"
    && targetIdentityEquals(props.protection.target, props.protection.checkpoint.target);
  const activityComplete = count === 4;
  const protectionMessage = props.protection?.result.state === "checkpointing"
    ? "Protecting the latest change"
    : props.protection?.result.state === "needs_protection"
        || (props.protection?.result.state === "protected_on_device" && !exactProtected)
      ? "Protection is out of date"
      : "Waiting for protection";
  if (state.dismissed) {
    return (
      <section className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-flex-none ui-gap-16px ui-color-warn banner" aria-label="Setup checklist" style={{ flexWrap: "wrap" }}>
        <span>{count} of 4 activity steps complete{exactProtected ? " — protected on this device" : ""}</span>
        <span className="ui ui-display-flex ui-flex-none ui-gap-14px banner-actions">
          <button className="link" onClick={props.onResume}>Continue setup</button>
        </span>
      </section>
    );
  }

  const order: StepName[] = ["realRecord", "everyday", "reshapePreview", "reshapeKept"];
  const firstPending = order.find(step => state.steps[step].state === "pending") ?? null;
  const status = (step: StepName): string => state.steps[step].state === "complete"
    ? "Complete" : firstPending === step ? "Next" : "Not started";
  const nextAction = firstPending === "realRecord"
    ? { label: "Add a real record", run: props.onAddRecord }
    : firstPending === "everyday"
      ? { label: "Do an everyday action", run: props.onDoEveryday }
      : firstPending === "reshapePreview"
        ? { label: "Ask Clay", run: props.onAskClay }
        : firstPending === "reshapeKept"
          ? { label: "Review Preview", run: props.onReviewPreview } : null;

  return (
    <section className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-flex-none ui-gap-16px ui-color-warn banner" aria-labelledby="first-success-title"
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
        {activityComplete ? (
          exactProtected ? (
            <p style={{ margin: "7px 0 0", color: "var(--success)" }}>
              <strong>Setup complete — protected on this device</strong>
            </p>
          ) : (
            <p style={{ margin: "7px 0 0", color: "var(--text-2)" }} role="status">
              <strong>4 of 4 activity steps complete.</strong>{" "}{protectionMessage}.
            </p>
          )
        ) : null}
        {state.steps.realRecord.state === "pending" ? (
          <p style={{ margin: "7px 0 0", color: "var(--text-2)" }}>
            {props.persistent === false ? TEMPORARY_FIRST_WRITE_COPY : FIRST_WRITE_STORAGE_COPY}
          </p>
        ) : null}
      </div>
      <div className="ui ui-display-flex ui-flex-none ui-gap-14px banner-actions" style={{ alignItems: "center", minHeight: 44 }}>
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
