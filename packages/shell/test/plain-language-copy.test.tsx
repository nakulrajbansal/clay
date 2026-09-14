/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ConversationRail } from "../src/app/ConversationRail";
import { HistoryView } from "../src/app/HistoryView";
import { TimeSlider } from "../src/app/TimeSlider";
import { THEMES } from "../src/app/themes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(node: React.ReactNode): Promise<() => Promise<void>> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return async () => { await act(async () => root.unmount()); };
}

const noop = (): void => undefined;

describe("Release A plain-language surfaces", () => {
  it("describes a proposed change with outcome-first Keep and Go back actions", async () => {
    const unmount = await render(<ConversationRail
      feed={[]}
      preview={{
        summary: "Add a useful summary", diff: [{ kind: "add", detail: "Adds a summary" }],
        panels: [], removePanels: [], version: 1, repaired: false,
      }}
      busy={false}
      hasKey
      onIntent={noop}
      onKeep={noop}
      onDiscard={noop}
      onRewind={noop}
      onReceiptOpened={noop}
      onSaveKey={noop}
      onSaveBackend={noop}
      onRemoveSamples={noop}
      onReset={noop}
      onExport={noop}
      onPurgeAttachments={async () => undefined}
      suggestions={[]}
      onAcceptSuggestion={noop}
      onDismissSuggestion={noop}
      loadStatus={async () => { throw new Error("status unavailable"); }}
      onCopyDiagnostics={noop}
      onOpenPrivateMetrics={noop}
      themes={[THEMES[0]!]}
      themeId={THEMES[0]!.id}
      onSelectTheme={noop}
      modelProvider="clay"
      onSelectModelProvider={noop}
    />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Proposed change");
    expect(text).not.toContain("Change contract");
    expect([...document.querySelectorAll("button")].map(button => button.textContent?.trim()))
      .toEqual(expect.arrayContaining(["Keep this change", "Go back"]));
    expect(text).not.toContain("Discard");
    expect(text).toContain("Ask Clay");
    expect(text).toContain("Advanced");
    expect(text).not.toContain("Reshape");

    const advanced = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Advanced"));
    await act(async () => advanced?.click());
    expect(document.body.textContent).toContain("Export portable .clay copy");
    expect(document.body.textContent).not.toContain("Export .clay backup");
    await unmount();
  });

  it("uses plain language inside the recent-changes detail view", async () => {
    const history = [
      { version: 1, parent: 0, created_at: "2026-01-01T00:00:00.000Z", summary: "Started", intent_text: "", diff: [] },
      { version: 2, parent: 1, created_at: "2026-01-02T00:00:00.000Z", summary: "Added a view", intent_text: "", diff: [] },
    ];
    const unmount = await render(<HistoryView
      history={history}
      head={2}
      current={2}
      onJump={noop}
      onRestore={noop}
      onSetCheckpoint={noop}
      onClose={noop}
    />);
    expect(document.querySelector("h2")?.textContent).toBe("Recent changes");
    const firstEarlier = [...document.querySelectorAll("button")]
      .find(button => button.textContent?.includes("Go back to this point"));
    expect(firstEarlier).toBeDefined();
    expect(document.body.textContent).not.toContain("Rewind to here");
    await unmount();
  });

  it("calls the timeline Recent changes and offers Go back to this point", async () => {
    const history = [
      { version: 1, parent: 0, created_at: "2026-01-01T00:00:00.000Z", summary: "Started", intent_text: "", diff: [] },
      { version: 2, parent: 1, created_at: "2026-01-02T00:00:00.000Z", summary: "Added a view", intent_text: "", diff: [] },
    ];
    const unmount = await render(<TimeSlider
      history={history}
      current={1}
      scrubbed
      disabled={false}
      onScrub={noop}
      onMakeLatest={noop}
      onOpenHistory={noop}
    />);
    expect(document.querySelector('input[type="range"]')?.getAttribute("aria-label"))
      .toBe("Recent changes");
    expect(document.body.textContent).toContain("Go back to this point");
    expect(document.body.textContent).not.toContain("Make this the latest");
    await unmount();
  });
});
