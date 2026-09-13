/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { handleImportParserWorkerRequest } from
  "../src/worker/release-c/import-worker-runtime";
import { ImportParserSessionStore } from "../src/worker/release-c/parser-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = {
  id: number;
  requestId?: string;
  op: string;
  payload?: Record<string, unknown>;
};

class FirstRunImportWorker {
  static latest: FirstRunImportWorker | null = null;
  static persistent = false;
  static failBoot = false;
  static fault: "post-import" | "post-seed" | null = null;
  static committedShell: string | null = null;
  static appName = "Untitled";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly posted: Posted[] = [];
  private readonly parserSessions: ImportParserSessionStore | null;

  constructor(url?: string | URL) {
    const parser = String(url ?? "").includes("import-worker");
    this.parserSessions = parser
      ? new ImportParserSessionStore({ sessionId: () => `import_${"b".repeat(26)}` })
      : null;
    if (!parser) FirstRunImportWorker.latest = this;
  }

  postMessage(message: Posted | unknown): void {
    if (this.parserSessions) {
      queueMicrotask(() => {
        void handleImportParserWorkerRequest(message, this.parserSessions!)
          .then(result => this.onmessage?.({ data: result }));
      });
      return;
    }
    const posted = message as Posted;
    this.posted.push(posted);
    if (posted.op === "boot" && FirstRunImportWorker.failBoot) {
      queueMicrotask(() => this.onmessage?.({ data: { id: posted.id, ok: false, error: "catalog unavailable" } }));
      return;
    }
    const appId = `app_${"a".repeat(26)}`;
    if (posted.op === "renameApp") FirstRunImportWorker.appName = String(posted.payload?.displayName);
    if (posted.op === "seed") FirstRunImportWorker.committedShell = String(posted.payload?.shellId);
    if (posted.op === "importNewApp") FirstRunImportWorker.committedShell = "blank";
    if (posted.op === "panels" && FirstRunImportWorker.fault) {
      queueMicrotask(() => this.onmessage?.({ data: { id: posted.id, ok: false, error: "injected post-commit presentation failure" } }));
      return;
    }
    const result = posted.op === "boot" || posted.op === "renameApp"
      ? {
          persistent: FirstRunImportWorker.persistent,
          seeded: FirstRunImportWorker.committedShell !== null,
          shellId: FirstRunImportWorker.committedShell,
          selectedAppInstanceId: appId,
          catalogGeneration: "0",
          apps: [{ id: appId, name: FirstRunImportWorker.appName, shellId: "blank" }],
        }
      : posted.op === "getSetting"
        ? posted.payload?.key === "shell_id" ? FirstRunImportWorker.committedShell : null
        : posted.op === "requestPersist"
          ? { persisted: FirstRunImportWorker.fault !== null }
          : posted.op === "history" ? FirstRunImportWorker.committedShell ? [{ version: 1 }] : []
          : posted.op === "firstRunEvidence" ? { provenanceValid: true, realRecordCount: 0 }
          : posted.op === "deviceProtection" ? { target: { appInstanceId: appId,
            activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", stateRevision: "0", stateDigest: `sha256:${"c".repeat(64)}` } }
          : posted.op === "importNewApp" ? { appInstanceId: appId, table: "expenses", imported: 1, columns: 2, version: 1 }
          : null;
    queueMicrotask(() => this.onmessage?.({
      data: { id: posted.id, ok: true, result },
    }));
  }

  terminate(): void { this.parserSessions?.restart(); }
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
    FirstRunImportWorker.failBoot = false;
    FirstRunImportWorker.fault = null;
    FirstRunImportWorker.committedShell = null;
    FirstRunImportWorker.appName = "Untitled";
    vi.stubGlobal("Worker", FirstRunImportWorker);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("does not offer authority-dependent switching or reset after authority boot fails", async () => {
    FirstRunImportWorker.failBoot = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitForButton("Try again");
    expect([...container.querySelectorAll("button")].map(button => button.textContent))
      .toEqual(["Try again"]);
    await act(async () => root.unmount());
  });

  it("retains a committed/ambiguous first-run import and replays the same request after presentation failure", async () => {
    FirstRunImportWorker.persistent = true;
    FirstRunImportWorker.fault = "post-import";
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitForButton("Import a spreadsheet");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const text = "Item,Amount\nCoffee,4\n";
    const file = new File([text], "expenses.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const button = await waitForButton("Import accepted rows");
    await act(async () => button.click());
    await waitFor(() => container.textContent?.includes("No app was deleted") ?? false);
    expect(document.querySelector(".import-review")!.textContent).not.toContain("No records have changed");
    await act(async () => button.click());
    await waitFor(() => FirstRunImportWorker.latest!.posted.filter(request => request.op === "importNewApp").length === 2);
    const posted = FirstRunImportWorker.latest!.posted;
    expect(posted.some(request => request.op === "deleteApp" || request.op === "createApp")).toBe(false);
    const imports = posted.filter(request => request.op === "importNewApp");
    expect(imports[1]!.requestId).toBe(imports[0]!.requestId);
    expect(imports[1]!.payload).toEqual(imports[0]!.payload);
    expect(sessionStorage.getItem("clay_pending_app_setup_v1")).toContain(imports[0]!.requestId!);
    await act(async () => root.unmount());
  });

  it("resumes the committed starter instead of relabeling it when another template is clicked after a presentation failure", async () => {
    FirstRunImportWorker.persistent = true;
    FirstRunImportWorker.fault = "post-seed";
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App />));
    const start = await waitForButton("Use a recommended starter");
    await act(async () => start.click());
    await waitFor(() => container.textContent?.includes("injected post-commit") ?? false);
    const gallery = await waitForButton("See all templates");
    await act(async () => gallery.click());
    const inventory = [...container.querySelectorAll<HTMLButtonElement>("button.shell-card")]
      .find(button => button.textContent?.includes("Inventory"))!;
    await act(async () => inventory.click());
    await waitFor(() => FirstRunImportWorker.latest!.posted.filter(request => request.op === "panels").length === 2);
    expect(FirstRunImportWorker.committedShell).toBe("tracker");
    expect(FirstRunImportWorker.latest!.posted.filter(request => request.op === "seed")).toHaveLength(1);
    expect(FirstRunImportWorker.latest!.posted.filter(request => request.op === "renameApp")).toHaveLength(1);
    await act(async () => root.unmount());
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
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("name\nMine").buffer,
    });
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
