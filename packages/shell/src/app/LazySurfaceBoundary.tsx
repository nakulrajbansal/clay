import { Component, createRef, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export class LazySurfaceBoundary extends Component<{
  label: string;
  modal?: boolean;
  children: ReactNode;
}, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  private readonly reloadRef = createRef<HTMLButtonElement>();
  private previousFocus: HTMLElement | null = null;
  private app: HTMLElement | null = null;
  private priorInert = false;
  private priorHidden: string | null = null;
  private focusFrame = 0;

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[clay lazy surface: ${this.props.label}]`, error, info.componentStack);
    this.previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    if (this.props.modal) {
      this.app = document.querySelector<HTMLElement>(".app");
      this.priorInert = this.app?.inert ?? false;
      this.priorHidden = this.app?.getAttribute("aria-hidden") ?? null;
      if (this.app) { this.app.inert = true; this.app.setAttribute("aria-hidden", "true"); }
    }
    this.focusFrame = requestAnimationFrame(() => this.reloadRef.current?.focus());
  }

  componentWillUnmount(): void {
    cancelAnimationFrame(this.focusFrame);
    if (this.app) {
      this.app.inert = this.priorInert;
      if (this.priorHidden === null) this.app.removeAttribute("aria-hidden");
      else this.app.setAttribute("aria-hidden", this.priorHidden);
    }
    this.previousFocus?.focus();
  }

  private trapModalFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!this.props.modal || event.key !== "Tab") return;
    event.preventDefault();
    this.reloadRef.current?.focus();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const card = (
      <section className="surface-error" role="alert" aria-label={`${this.props.label} failed to load`}>
        <span className="contract-eyebrow">Recoverable loading error</span>
        <h2>Couldn’t open {this.props.label}</h2>
        <p>Your records and app history are untouched. Reload Clay to fetch this surface again.</p>
        <button ref={this.reloadRef} autoFocus className="primary"
          onClick={() => window.location.reload()}>Reload Clay</button>
      </section>
    );
    return this.props.modal
      ? createPortal(<div className="surface-error-backdrop" onKeyDown={this.trapModalFocus}>
          {card}
        </div>, document.body)
      : card;
  }
}
