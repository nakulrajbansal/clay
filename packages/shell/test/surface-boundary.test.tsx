/** @vitest-environment jsdom */
import { lazy } from "react";
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SurfaceBoundary } from "../src/app/SurfaceBoundary";

it("keeps lazy status, success and recoverable error isolated per named surface", async () => {
  let finish!: (module: { default: () => React.JSX.Element }) => void;
  const First = lazy(() => new Promise<{ default: () => React.JSX.Element }>(resolve => { finish = resolve; }));
  let fail!: (cause: Error) => void;
  const Second = lazy(() => new Promise<{ default: () => React.JSX.Element }>((_, reject) => { fail = reject; }));
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host); const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => root.render(<>
      <SurfaceBoundary label="records"><First /></SurfaceBoundary>
      <SurfaceBoundary label="history"><Second /></SurfaceBoundary>
    </>));
    expect([...host.querySelectorAll('[role="status"]')].map(e => e.textContent)).toEqual(["Opening records…", "Opening history…"]);
    await act(async () => { finish({ default: () => <button>Record action</button> }); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.querySelector("button")?.textContent).toBe("Record action");
    await act(async () => { fail(new Error("synthetic chunk failure")); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t open history");
    expect([...host.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Record action", "Reload Clay"]);
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally { await act(async () => root.unmount()); errors.mockRestore(); }
});
