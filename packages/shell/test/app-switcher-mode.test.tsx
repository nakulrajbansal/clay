/** @vitest-environment jsdom */
import { act, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { AppSwitcher } from "../src/app/AppSwitcher";
import { THEMES } from "../src/app/themes";
import type { WorkspaceMode } from "../src/app/workspace-mode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(): React.JSX.Element {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("work");
  const props: ComponentProps<typeof AppSwitcher> = {
    apps: [{ id: "default", name: "Field Service", shellId: "starter-field-service" }],
    currentId: "default", onSwitch: () => undefined, onNew: () => undefined,
    onFork: () => undefined, onRename: () => undefined, onDelete: () => undefined,
    onOpenSearch: () => undefined, onOpenAutomations: () => undefined,
    unreadNotifications: 0, onOpenData: () => undefined, onOpenShapeMap: () => undefined,
    railOpen: false, onToggleRail: () => undefined, version: 2, persistent: true,
    themes: [THEMES[0]!], themeId: THEMES[0]!.id, onSelectTheme: () => undefined,
    lenses: [
      { id: "all", name: "Workspace", description: "Your complete workspace", panelIds: [] },
      { id: "saved:550e8400-e29b-41d4-a716-446655440000", name: "My focus",
        description: "Saved view and layout", panelIds: [] },
    ],
    lensId: "all", lensReady: true, onSelectLens: () => undefined,
    onSaveLens: async () => undefined, onDeleteLens: async () => undefined,
    workspaceMode, onWorkspaceModeChange: setWorkspaceMode,
  };
  return <AppSwitcher {...props} />;
}

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.trim() === name || item.getAttribute("aria-label") === name);

describe("AppSwitcher workspace mode", () => {
  it("defaults to Work and reveals builder actions only after Customize is chosen", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));

    expect(button("Work")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Customize")?.getAttribute("aria-pressed")).toBe("false");
    expect(document.body.textContent).toContain("Stored on this device");
    expect(document.body.textContent).not.toContain("Protected on this device");
    expect(button("Search and act")).toBeDefined();
    expect(button("Open automations")).toBeUndefined();
    expect(button("Open data")).toBeUndefined();
    expect(button("Open shape map")).toBeUndefined();
    expect(button("Choose color scheme")).toBeUndefined();
    expect(button("Show reshape")).toBeUndefined();
    await act(async () => button("Choose situational lens. Current: Workspace")!.click());
    expect(button("+ Save current view")).toBeUndefined();
    expect(button("Delete lens My focus")).toBeUndefined();
    await act(async () => button("Choose situational lens. Current: Workspace")!.click());

    await act(async () => button("Customize")!.click());
    expect(button("Customize")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Open automations")).toBeDefined();
    expect(button("Open data")).toBeDefined();
    expect(button("Open shape map")).toBeDefined();
    expect(button("Choose color scheme")).toBeDefined();
    expect(button("Show reshape")).toBeDefined();
    await act(async () => button("Choose situational lens. Current: Workspace")!.click());
    expect(button("+ Save current view")).toBeDefined();
    expect(button("Delete lens My focus")).toBeDefined();

    await act(async () => root.unmount());
  });
});
