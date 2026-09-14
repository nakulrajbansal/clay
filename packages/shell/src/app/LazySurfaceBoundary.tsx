import { FocusButton } from "./FocusControl";
import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { ModalDialog } from "./ModalDialog";

function SurfaceFailure(props: { label: string; modal?: boolean }): React.JSX.Element {
  const reloadRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.modal) return; // ModalDialog owns all modal focus/layer/scroll state.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => reloadRef.current?.focus());
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, [props.modal]);
  const content = <>
    <span className="contract-eyebrow">Recoverable loading error</span>
    <h2>Couldn’t open {props.label}</h2>
    <p>Your records and app history are untouched. Reload Clay to fetch this surface again.</p>
    <FocusButton ref={reloadRef} autoFocus className="primary"
      onClick={() => window.location.reload()}>Reload Clay</FocusButton>
  </>;
  const label = `${props.label} failed to load`;
  return props.modal
    ? <ModalDialog className="ui ui-display-grid ui-background-panel ui-min-width-0 ui-gap-10px ui-flex-1 ui-base-padding-6fe44b surface-error" backdropClassName="ui ui-display-grid ui-place-items-center ui-position-fixed surface-error-backdrop"
        role="alertdialog" ariaLabel={label} dismissible={false} onClose={() => undefined}>
        {content}
      </ModalDialog>
    : <section className="ui ui-display-grid ui-background-panel ui-min-width-0 ui-gap-10px ui-flex-1 ui-base-padding-6fe44b surface-error" role="alert" aria-label={label}>{content}</section>;
}

export class LazySurfaceBoundary extends Component<{
  label: string;
  modal?: boolean;
  children: ReactNode;
}, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[clay lazy surface: ${this.props.label}]`, error, info.componentStack);
  }
  render(): ReactNode {
    return this.state.error
      ? <SurfaceFailure label={this.props.label} modal={this.props.modal} />
      : this.props.children;
  }
}
