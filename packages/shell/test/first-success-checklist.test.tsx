/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { FirstSuccessChecklist } from "../src/app/FirstSuccessChecklist";
import { applyFirstSuccessEvent, emptyFirstSuccessState } from "../src/app/first-success-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(node: React.ReactNode): Promise<() => Promise<void>> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return async () => { await act(async () => root.unmount()); };
}

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.includes(name));
  if (!found) throw new Error(`missing ${name}: ${document.body.innerHTML}`);
  return found;
};

const baseProps = {
  onAddRecord: () => undefined,
  onReviewWork: () => undefined,
  onCustomize: () => undefined,
  onDismiss: () => undefined,
  onResume: () => undefined,
  onRetry: () => undefined,
};

describe("FirstSuccessChecklist", () => {
  it("renders four evidence steps and only offers the next available action", async () => {
    let state = applyFirstSuccessEvent(emptyFirstSuccessState(), {
      type: "app_created", path: "recommended", shellId: "tracker",
    });
    const onAddRecord = vi.fn();
    const unmount = await render(<FirstSuccessChecklist {...baseProps}
      state={state} loading={false} error={null} persistent={false}
      onAddRecord={onAddRecord} />);

    const items = [...document.querySelectorAll("ol li")];
    expect(items.map(item => item.textContent)).toEqual([
      expect.stringContaining("Start with a working app: Complete"),
      expect.stringContaining("Add your first real record: Next"),
      expect.stringContaining("Review your Work view: Not started"),
      expect.stringContaining("Keep your first customization: Not started"),
    ]);
    expect(document.body.textContent).toContain(
      "This is a temporary session. Records can disappear when this tab closes.",
    );
    expect(button("Add a real record").disabled).toBe(false);
    expect(document.querySelectorAll("button")).toHaveLength(2); // next action + dismiss
    await act(async () => button("Add a real record").click());
    expect(onAddRecord).toHaveBeenCalledTimes(1);

    state = applyFirstSuccessEvent(state, {
      type: "real_record", source: "create", changed: 1, sample: false,
    });
    await unmount();
  });

  it("resumes after dismissal and exposes loading and retryable errors", async () => {
    const onResume = vi.fn();
    let state = { ...emptyFirstSuccessState(), dismissed: true };
    let unmount = await render(<FirstSuccessChecklist {...baseProps}
      state={state} loading={false} error={null} onResume={onResume} />);
    expect(document.querySelector("ol")).toBeNull();
    await act(async () => button("Continue setup").click());
    expect(onResume).toHaveBeenCalledTimes(1);
    await unmount();

    unmount = await render(<FirstSuccessChecklist {...baseProps}
      state={null} loading error={null} />);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading setup checklist");
    await unmount();

    const onRetry = vi.fn();
    unmount = await render(<FirstSuccessChecklist {...baseProps}
      state={null} loading={false} error="Progress could not be loaded. Your records were not changed."
      onRetry={onRetry} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("records were not changed");
    await act(async () => button("Try again").click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("uses real controls and a wrapping layout at a 390px viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const onDismiss = vi.fn();
    const unmount = await render(<FirstSuccessChecklist {...baseProps}
      state={emptyFirstSuccessState()} loading={false} error={null} onDismiss={onDismiss} />);
    const section = document.querySelector<HTMLElement>('section[aria-labelledby="first-success-title"]')!;
    expect(section.style.flexWrap).toBe("wrap");
    expect(button("Dismiss").tagName).toBe("BUTTON");
    await act(async () => button("Dismiss").click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
