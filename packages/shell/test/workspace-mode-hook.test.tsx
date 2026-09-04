/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceMode } from "../src/app/workspace-mode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ModeHarness(props: { appId: string | null }): React.JSX.Element {
  const [mode, chooseMode] = useWorkspaceMode(props.appId);
  return <><output>{mode}</output><button onClick={() => chooseMode("customize")}>Choose</button></>;
}

async function render(root: Root, appId: string): Promise<void> {
  await act(async () => root.render(<ModeHarness appId={appId} />));
}

describe("useWorkspaceMode", () => {
  beforeEach(() => localStorage.clear());

  it("switches app preferences without leaking Customize between apps", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    await render(root, "app-a");
    expect(container.querySelector("output")?.textContent).toBe("work");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("output")?.textContent).toBe("customize");
    await render(root, "app-b");
    expect(container.querySelector("output")?.textContent).toBe("work");
    await render(root, "app-a");
    expect(container.querySelector("output")?.textContent).toBe("customize");
    await act(async () => root.unmount());
  });
});
