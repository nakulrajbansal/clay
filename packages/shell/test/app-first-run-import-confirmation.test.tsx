/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { App } from "../src/app/App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = {
  id: number;
  op: string;
  payload?: Record<string, unknown>;
};

class FirstRunImportWorker {
  static latest: FirstRunImportWorker | null = null;
  static persistent = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly posted: Posted[] = [];

  constructor() { FirstRunImportWorker.latest = this; }

  postMessage(message: Posted): void {
    this.posted.push(message);
    const appId = `app_${"a".repeat(26)}`;
    const result = message.op === "boot"
      ? {
          persistent: FirstRunImportWorker.persistent,
          seeded: false,
          shellId: null,
          selectedAppInstanceId: appId,
          catalogGeneration: "0",
          apps: [{ id: appId, name: "Untitled", shellId: "generic" }],
        }
      : message.op === "getSetting"
        ? null
        : message.op === "requestPersist"
          ? { persisted: false }
          : null;
    queueMicrotask(() => this.onmessage?.({
      data: { id: message.id, ok: true, result },
    }));
  }

  terminate(): void {}
}

async function waitForButton(label: string): Promise<HTMLButtonElement> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes(label));
    if (found) return found;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  throw new Error(`missing button: ${label}\n${document.body.innerHTML}`);
}

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 2_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

describe("first-run import loss-boundary confirmation", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    FirstRunImportWorker.latest = null;
    FirstRunImportWorker.persistent = false;
    vi.stubGlobal("Worker", FirstRunImportWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each([
    { persistent: false, warning: "Continue with temporary storage?" },
    { persistent: true, warning: "Continue anyway?" },
  ])("renders the $warning loss boundary while import remains in onboarding", async ({
    persistent, warning,
  }) => {
    FirstRunImportWorker.persistent = persistent;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App />));

    await waitForButton("Import a spreadsheet");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["name\nMine"], "mine.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => "name\nMine" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    const importButton = await waitForButton("Import accepted rows");
    await act(async () => importButton.click());

    await waitFor(() => document.querySelector('[role="alertdialog"]')?.textContent
      ?.includes(warning) ?? false);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>(
      '[role="alertdialog"] button',
    )].find(button => button.textContent === "Cancel")!;
    await act(async () => cancel.click());
    await waitFor(() => document.querySelector('[role="alertdialog"]') === null
      && !importButton.disabled);
    await act(async () => root.unmount());
  });
});
