/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Onboarding } from "../src/app/Onboarding";
import { expectControlCensus } from "./helpers/control-census";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const buttons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>("button")];
const button = (text: string): HTMLButtonElement => {
  const found = buttons().find(item => item.textContent?.includes(text));
  if (!found) throw new Error(`missing button: ${text}\n${document.body.innerHTML}`);
  return found;
};

async function mount(props: Partial<React.ComponentProps<typeof Onboarding>> = {}): Promise<{
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => root.render(<Onboarding
    onPick={() => undefined}
    onImport={() => undefined}
    busy={false}
    {...props}
  />));
  return { unmount: async () => { await act(async () => root.unmount()); } };
}

describe("first-run onboarding", () => {
  it("shows exactly two equal-priority start actions before every secondary choice", async () => {
    const onPick = vi.fn();
    const { unmount } = await mount({ onPick });

    expectControlCensus("A.onboarding");

    const primary = document.querySelector<HTMLElement>('[aria-labelledby="start-heading"]')!;
    const primaryActions = [...primary.querySelectorAll<HTMLButtonElement>(
      'button[data-start-priority="primary"]',
    )];
    expect(primaryActions).toHaveLength(2);
    expect(primaryActions.map(item => item.textContent)).toEqual([
      expect.stringContaining("Import a spreadsheet"),
      expect.stringContaining("Use a recommended starter"),
    ]);
    expect(primaryActions.every(item => item.classList.contains("onboarding-hero"))).toBe(true);
    expect(primaryActions[0]!.className).toBe(primaryActions[1]!.className);
    expect(document.querySelectorAll('button[data-start-priority="primary"]')).toHaveLength(2);
    expect(button("Change recommendation").getAttribute("aria-expanded")).toBe("false");
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Import a spreadsheet")).toBeLessThan(text.indexOf("Advanced options"));
    expect(text.indexOf("Use a recommended starter")).toBeLessThan(text.indexOf("Advanced options"));
    expect(document.activeElement).toBe(document.querySelector("h1"));

    await act(async () => button("Use a recommended starter").click());
    expect(onPick).toHaveBeenCalledWith("tracker");
    await unmount();
  });

  it("updates the deterministic recommendation from concise goal choices", async () => {
    const onPick = vi.fn();
    const { unmount } = await mount({ onPick });
    await act(async () => button("Change recommendation").click());
    await act(async () => button("Manage sales and deals").click());
    expect(button("Manage sales and deals").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Sales CRM");
    await act(async () => button("Use a recommended starter").click());
    expect(onPick).toHaveBeenCalledWith("crm");
    await unmount();
  });

  it("keeps blank creation behind Advanced options so only the two start paths are immediate", async () => {
    const onPick = vi.fn();
    const { unmount } = await mount({ onPick });

    expect(buttons().some(item => item.textContent?.includes("Start from scratch"))).toBe(false);
    await act(async () => button("Advanced options").click());
    await act(async () => button("Start from scratch").click());
    expect(onPick).toHaveBeenCalledWith("blank");
    await unmount();
  });

  it("keeps import primary and blank secondary while both remain callback-owned", async () => {
    const onPick = vi.fn();
    const onImport = vi.fn();
    const { unmount } = await mount({ onPick, onImport });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.hidden).toBe(true);
    expect(input.tabIndex).toBe(-1);
    const nativeClick = vi.spyOn(input, "click");
    await act(async () => button("Import a spreadsheet").click());
    expect(nativeClick).toHaveBeenCalledTimes(1);
    const file = new File(["name\nMine"], "mine.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onImport).toHaveBeenCalledWith(file);
    await act(async () => button("Advanced options").click());
    await act(async () => button("Start from scratch").click());
    expect(onPick).toHaveBeenCalledWith("blank");
    await unmount();
  });

  it("announces loading and errors and lets an additional-app flow cancel by keyboard", async () => {
    const onCancel = vi.fn();
    const { unmount } = await mount({ busy: true, error: "Setup did not finish. Your other apps were not changed.", onCancel });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Setting up");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("not changed");
    expect(button("Use a recommended starter").disabled).toBe(true);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
