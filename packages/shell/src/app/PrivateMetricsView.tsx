import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PrivateMetricsSummary, Rate } from "@clay/kernel";
import "./PrivateMetricsView.css";

const pct = (rate: Rate): string => rate.value == null
  ? "Not enough activity" : `${Math.round(rate.value * 100)}%`;
const ratio = (rate: Rate): string => `${rate.numerator} of ${rate.denominator}`;
const duration = (value: string | null): string => value == null ? "Not yet"
  : ({ under_3m: "Under 3 min", "3_to_10m": "3–10 min",
      "10_to_30m": "10–30 min", over_30m: "Over 30 min" }[value] ?? value);
const cohort = (value: string): string => ({
  not_eligible: "Not eligible yet", retained: "Returned", not_retained: "No return observed",
}[value] ?? value);
const method = (value: string): string => ({
  panel_repair: "Panel repair", panel_revert: "Panel revert",
  row_restore: "Row restore", history_rewind: "History rewind",
}[value] ?? value);

function Metric(props: { label: string; value: string | number; detail: string }): React.JSX.Element {
  return <article><span>{props.label}</span><b>{props.value}</b><small>{props.detail}</small></article>;
}

export function PrivateMetricsView(props: {
  summary: PrivateMetricsSummary;
  persistent: boolean;
  onToggle: (enabled: boolean) => Promise<boolean>;
  onClear: () => Promise<boolean>;
  onCopy: () => Promise<boolean>;
  onClose: () => void;
}): React.JSX.Element {
  const s = props.summary;
  const [confirmClear, setConfirmClear] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>(".app");
    const priorInert = app?.inert ?? false;
    const priorHidden = app?.getAttribute("aria-hidden") ?? null;
    if (app) { app.inert = true; app.setAttribute("aria-hidden", "true"); }
    const frame = requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>("button")?.focus());
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault(); onCloseRef.current(); return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const nodes = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(node => node.getClientRects().length > 0);
      if (nodes.length === 0) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && (document.activeElement === first
          || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      if (app) {
        app.inert = priorInert;
        if (priorHidden === null) app.removeAttribute("aria-hidden");
        else app.setAttribute("aria-hidden", priorHidden);
      }
      previousFocus?.focus();
    };
  }, []);
  return createPortal(
    <div className="private-metrics-backdrop" onMouseDown={event => {
      if (event.currentTarget === event.target) props.onClose();
    }}>
      <section ref={dialogRef} className="private-metrics" role="dialog" aria-modal="true"
        aria-labelledby="private-metrics-title" tabIndex={-1}>
        <header className="private-metrics-header">
          <div><span className="contract-eyebrow">Current app · last 30 days</span>
            <h2 id="private-metrics-title">Private activity & trust</h2></div>
          <button className="link" onClick={props.onClose}>Close</button>
        </header>
        <p className="private-metrics-privacy">
          Daily counts only. No records, names, prompts, or exact times. Never sent anywhere.
        </p>

        <section className="private-metrics-section" aria-labelledby="metrics-activation">
          <h3 id="metrics-activation">Activation</h3>
          <div className="private-metrics-grid">
            <Metric label="First useful reshape" value={s.activation.activated ? "Complete" : "Not yet"}
              detail={duration(s.activation.firstKeepElapsed)} />
            <Metric label="Full proof loop" value={s.activation.proofLoopComplete ? "Complete" : "Not yet"}
              detail={duration(s.activation.proofLoopElapsed)} />
            <Metric label="Day 14" value={cohort(s.activation.d14Strict)}
              detail={`Return window: ${cohort(s.activation.d14Window)}`} />
            <Metric label="Context actions" value={s.activation.situationalLensUses}
              detail="situational lens switches" />
          </div>
        </section>

        <section className="private-metrics-section" aria-labelledby="metrics-reshape">
          <h3 id="metrics-reshape">Reshape decisions</h3>
          <div className="private-metrics-grid">
            <Metric label="Attempts" value={s.reshape.started} detail="reshapes started" />
            <Metric label="Preview reach" value={pct(s.reshape.previewRate)}
              detail={ratio(s.reshape.previewRate)} />
            <Metric label="First-pass preview" value={pct(s.reshape.firstPassPreviewRate)}
              detail={ratio(s.reshape.firstPassPreviewRate)} />
            <Metric label="Keep rate" value={pct(s.reshape.keepRate)} detail={ratio(s.reshape.keepRate)} />
            <Metric label="Repair to preview" value={pct(s.reshape.repairSaveRate)}
              detail={ratio(s.reshape.repairSaveRate)} />
          </div>
          {s.reshape.discardByDiff.length > 0 ? (
            <div className="private-metrics-breakdown" aria-label="Discard decisions by change kind">
              {s.reshape.discardByDiff.map(item => <span key={item.diff}>
                {item.diff.replaceAll("_", " ")}: {item.discarded}/{item.decisions} discarded
              </span>)}
            </div>
          ) : null}
        </section>

        <section className="private-metrics-section" aria-labelledby="metrics-trust">
          <h3 id="metrics-trust">Trust actions</h3>
          <div className="private-metrics-grid">
            <Metric label="Verified previews" value={s.trust.previewsShown} detail="contracts shown" />
            <Metric label="Receipts" value={s.trust.receiptsOpened} detail="opened intentionally" />
            <Metric label="Shape map" value={s.trust.shapeMapOpened} detail="opens" />
            <Metric label="History" value={s.trust.historyOpened} detail="opens" />
            <Metric label="Safe rewind" value={pct(s.trust.rewindSuccessRate)}
              detail={`${s.trust.rewindSucceeded} of ${s.trust.rewindAttempted} attempts`} />
            <Metric label="Backups" value={s.trust.exportsSucceeded} detail="successful exports" />
          </div>
        </section>

        <section className="private-metrics-section" aria-labelledby="metrics-recovery">
          <h3 id="metrics-recovery">Recovery</h3>
          <div className="private-metrics-grid">
            <Metric label="Faults seen" value={s.recovery.faultsSeen} detail="fixed fault classes" />
            <Metric label="Recoveries" value={s.recovery.completed} detail="completed actions" />
            <Metric label="Recovery rate" value={pct(s.recovery.successRate)}
              detail={ratio(s.recovery.successRate)} />
          </div>
          {s.recovery.byMethod.length > 0 ? (
            <div className="private-metrics-breakdown" aria-label="Recovery by method">
              {s.recovery.byMethod.map(item => <span key={item.method}>
                {method(item.method)}: {item.succeeded}/{item.completed}
              </span>)}
            </div>
          ) : null}
        </section>

        <footer className="private-metrics-footer">
          <span>{props.persistent ? "Stored only in this app’s local system database" : "Session-only storage"}</span>
          <label><input type="checkbox" checked={s.collectionEnabled}
            onChange={event => void props.onToggle(event.target.checked).then(ok =>
              setActionStatus(ok ? "Private count preference updated." : "Could not update the preference."))} /> Keep private counts on this device</label>
          <button className="link" onClick={() => void props.onCopy().then(ok =>
            setActionStatus(ok ? "Content-free summary copied." : "Clipboard access was blocked."))}>
            Copy content-free summary
          </button>
          <button ref={clearButtonRef} className="link danger"
            onClick={() => setConfirmClear(true)}>
            Clear private metrics…
          </button>
          {confirmClear ? (
            <div className="private-metrics-confirm" role="group"
              aria-label="Confirm clear private metrics"
              onKeyDown={event => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                setConfirmClear(false);
                clearButtonRef.current?.focus();
              }}>
              <span>Clear only these local counts?</span>
              <button autoFocus className="danger" onClick={() => void props.onClear().then(ok => {
                setConfirmClear(false);
                setActionStatus(ok ? "Private activity metrics cleared." : "Could not clear private metrics.");
                clearButtonRef.current?.focus();
              })}>Clear counts</button>
              <button className="link" onClick={() => {
                setConfirmClear(false);
                clearButtonRef.current?.focus();
              }}>Cancel</button>
            </div>
          ) : null}
          <span className="private-metrics-status" role="status" aria-live="polite">
            {actionStatus}
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
