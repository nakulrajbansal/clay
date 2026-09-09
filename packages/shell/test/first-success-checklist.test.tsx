/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { FirstSuccessChecklist } from "../src/app/FirstSuccessChecklist";
import { applyFirstSuccessEvent, emptyFirstSuccessState } from "../src/app/first-success-state";
import type { DeviceProtectionProjection } from "../src/worker/db-worker";

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
  onDoEveryday: () => undefined,
  onAskClay: () => undefined,
  onReviewPreview: () => undefined,
  onDismiss: () => undefined,
  onResume: () => undefined,
  onRetry: () => undefined,
};

const completedState = {
  version: 2 as const,
  revision: 5,
  dismissed: false,
  start: { state: "complete" as const, path: "recommended" as const, shellId: "tracker" as const },
  steps: {
    realRecord: { state: "complete" as const, source: "create" as const },
    everyday: { state: "complete" as const, action: "open" as const },
    reshapePreview: { state: "complete" as const, baseVersion: 2 },
    reshapeKept: { state: "complete" as const, version: 3 },
  },
};

const currentTarget = {
  appInstanceId: `app_${"a".repeat(26)}`,
  activeGenerationId: `gen_${"b".repeat(26)}`,
  lineageEpoch: "1",
  stateRevision: "9",
  stateDigest: `sha256:${"c".repeat(64)}`,
};

const protectionProps = (
  state: "temporary" | "needs_protection" | "checkpointing" | "protected_on_device",
  checkpointTarget: typeof currentTarget | null = currentTarget,
): { protection: DeviceProtectionProjection } => ({
  protection: {
    result: state === "needs_protection"
      ? { state, reasonCode: "checkpoint_stale" }
      : { state, reasonCode: null },
    target: currentTarget,
    checkpoint: checkpointTarget === null
      ? { state: "none", target: null }
      : { state: state === "checkpointing" ? "in_progress" : "valid", target: checkpointTarget },
  },
} as unknown as { protection: DeviceProtectionProjection });

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
      expect.stringContaining("Add your first real record: Next"),
      expect.stringContaining("Do one everyday action: Not started"),
      expect.stringContaining("Ask Clay for one small change: Not started"),
      expect.stringContaining("Review and Keep the Preview: Not started"),
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

  it.each([
    ["temporary", null, "Waiting for protection"],
    ["needs_protection", { ...currentTarget, stateRevision: "8" }, "Protection is out of date"],
    ["checkpointing", currentTarget, "Protecting the latest change"],
  ] as const)(
    "withholds overall completion while exact-current protection is %s",
    async (state, checkpointTarget, message) => {
      const unmount = await render(<FirstSuccessChecklist {...baseProps}
        {...protectionProps(state, checkpointTarget)}
        state={completedState} loading={false} error={null} persistent={state !== "temporary"} />);
      expect(document.body.textContent).toContain("4 of 4 activity steps complete");
      expect(document.body.textContent).toContain(message);
      expect(document.body.textContent).not.toContain("Setup complete — protected on this device");
      expect([...document.querySelectorAll("ol li strong")].map(node => node.textContent))
        .toEqual(["Complete", "Complete", "Complete", "Complete"]);
      await unmount();
    },
  );

  it("completes only for a protected_on_device result bound to the exact current tuple", async () => {
    let unmount = await render(<FirstSuccessChecklist {...baseProps}
      {...protectionProps("protected_on_device")}
      state={completedState} loading={false} error={null} persistent />);
    expect(document.body.textContent).toContain("Setup complete — protected on this device");
    await unmount();

    unmount = await render(<FirstSuccessChecklist {...baseProps}
      {...protectionProps("protected_on_device", { ...currentTarget, stateDigest: `sha256:${"d".repeat(64)}` })}
      state={completedState} loading={false} error={null} persistent />);
    expect(document.body.textContent).toContain("Protection is out of date");
    expect(document.body.textContent).not.toContain("Setup complete — protected on this device");
    await unmount();
  });
});
