import { Suspense, type ReactNode } from "react";
import { LazySurfaceBoundary } from "./LazySurfaceBoundary";

/** One boundary per surface. Callers keep their literal lazy imports and keys. */
export function SurfaceBoundary({ label, modal = false, children }: {
  label: string; modal?: boolean; children: ReactNode;
}): React.JSX.Element {
  const status = <div className="ui ui-color-text-2 ui-background-panel ui-base-border-f41cca ui-base-border-radius-25b77c surface-loading"
    role="status">Opening {label}…</div>;
  const fallback = modal ? <div className="ui ui-display-grid ui-place-items-center ui-position-fixed surface-loading-backdrop">{status}</div> : status;
  return <LazySurfaceBoundary label={label} modal={modal}>
    <Suspense fallback={fallback}>{children}</Suspense>
  </LazySurfaceBoundary>;
}
