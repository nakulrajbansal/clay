/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeProjectionPlaintextV1, type ProjectionArtifactV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
import { ExportDialog } from "../src/app/ExportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(
  process.cwd(), "../kernel/test/fixtures", name,
)));
const plaintext = fixture("projection-current-view-v1.plaintext.json");
const artifact: ProjectionArtifactV1 = {
  projection: decodeProjectionPlaintextV1(plaintext),
  plaintext,
  csv: fixture("projection-current-view-v1.csv"),
};
const request: ProjectionRequestV1 = {
  schema: 1,
  kind: "current_view",
  expectedSchemaVersion: 2,
  tableId: "tbl_018f0000-0000-7000-8000-000000000001",
  fieldIds: [
    "fld_018f0000-0000-7000-8000-000000000002",
    "fld_018f0000-0000-7000-8000-000000000003",
  ],
  view: {
    search: "", filter: null, sort: null, dateAnchor: "2026-09-06",
  },
  options: { includeRecordIds: false, redactedFieldIds: [] },
};

const runProjection = <T,>(operation: () => Promise<T>): Promise<T> => operation();

const flush = async (): Promise<void> => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > 3_000) throw new Error(document.body.innerHTML);
    await flush();
  }
};

const readBlob = (blob: Blob): Promise<Uint8Array> => new Promise((resolveBlob, rejectBlob) => {
  const reader = new FileReader();
  reader.onerror = () => rejectBlob(reader.error ?? new Error("could not read download Blob"));
  reader.onload = () => resolveBlob(new Uint8Array(reader.result as ArrayBuffer));
  reader.readAsArrayBuffer(blob);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("local export owner preview", () => {
  it("previews exact frozen values and policy before explicit, local-only CSV or print", async () => {
    const projectExport = vi.fn(async () => artifact);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    const print = vi.fn();
    Object.defineProperty(window, "print", { configurable: true, value: print });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:clay-local-export");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let closes = 0;
    await act(async () => root.render(<ExportDialog
      worker={{ projectExport }}
      runProjection={runProjection} request={request}
      fieldChoices={[
        { fieldId: request.fieldIds[0]!, label: "Title" },
        { fieldId: request.fieldIds[1]!, label: "Notes" },
      ]}
      onClose={() => { closes++; root.unmount(); }}
    />));
    await flush();

    const dialog = document.body.querySelector<HTMLElement>(
      '.export-dialog[role="dialog"][aria-modal="true"]',
    )!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector("tbody")).not.toBeNull();
    expect(dialog.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(projectExport).toHaveBeenCalledTimes(1);
    expect(dialog.textContent).toContain("2 rows × 6 fields");
    expect(dialog.textContent).toContain("Complete — no truncation");
    expect(dialog.textContent).toContain("Friendly labels; relation IDs excluded");
    expect(dialog.textContent).toContain("Customer → customers.Name");
    const redactionGroup = dialog.querySelector<HTMLElement>(
      '.export-redaction-options[role="group"][aria-labelledby]',
    );
    const redactionLabel = redactionGroup?.getAttribute("aria-labelledby");
    expect(redactionLabel && dialog.querySelector(`#${redactionLabel}`)?.textContent)
      .toBe("Redact values");
    expect([...redactionGroup!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .map(input => input.getAttribute("aria-label"))).toEqual([
        "Redact Title values, field 1", "Redact Notes values, field 2",
      ]);
    expect(dialog.textContent).toContain("Double amount → jobs.Amount");
    expect(dialog.textContent).toContain("Attachments excluded");
    expect(dialog.textContent).toContain("Hidden and unselected fields excluded");
    expect(dialog.textContent).toContain("No redactions");
    expect(dialog.textContent).toContain("123 B CSV");
    expect(dialog.textContent).not.toContain("NEVER_EXPORT");

    const headings = [...dialog.querySelectorAll("thead th")].map(node => node.textContent);
    expect(headings).toEqual(["Title", "Notes", "Amount", "Customer", "Double amount", "Empty"]);
    const rows = [...dialog.querySelectorAll("tbody tr")].map(row =>
      [...row.querySelectorAll(".projection-cell-value")].map(cell => cell.textContent));
    expect(rows).toEqual([
      ["Alpha", "plain", "10", "Beta", "20", ""],
      ["=2+3", "Line 1\r\n\"quoted\", yes", "7.5", "Acme", "15", ""],
    ]);
    expect(dialog.textContent).toContain("CSV: '=2+3");

    const printable = dialog.querySelector<HTMLElement>(".projection-print-document")!;
    expect(printable.querySelector("button, input, nav, a, [contenteditable]")).toBeNull();
    const printButton = [...dialog.querySelectorAll("button")]
      .find(button => button.textContent === "Print / Save as PDF")!;
    expect(printButton.textContent).toBe("Print / Save as PDF");
    expect(dialog.textContent).not.toContain("Download PDF");

    await act(async () => dialog.querySelector<HTMLButtonElement>("[data-export-csv]")!.click());
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    await act(async () => printButton.click());
    await waitFor(() => print.mock.calls.length === 1);
    expect(print).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    })));
    expect(closes).toBe(1);
  });

  it("prepares wide print output in bounded isolated sheets without expanding the React preview", async () => {
    const fields = Array.from({ length: 30 }, (_, index) => ({
      ...artifact.projection.manifest.fields[index % artifact.projection.manifest.fields.length]!,
      name: `field_${index.toString().padStart(2, "0")}`,
      label: `Field ${index.toString().padStart(2, "0")}`,
    }));
    const rows = Array.from({ length: 205 }, (_, rowIndex) =>
      fields.map((_field, fieldIndex) => `R${rowIndex.toString().padStart(3, "0")}F${fieldIndex.toString().padStart(2, "0")}`));
    const largeArtifact: ProjectionArtifactV1 = {
      ...artifact,
      projection: {
        ...artifact.projection,
        manifest: {
          ...artifact.projection.manifest,
          rowCount: rows.length,
          fieldCount: fields.length,
          fields,
        },
        rows,
      },
    };
    let yieldedToBrowser = false;
    let responsiveBeforePrint = false;
    const print = vi.fn(() => { responsiveBeforePrint = yieldedToBrowser; });
    Object.defineProperty(window, "print", { configurable: true, value: print });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ExportDialog
      worker={{ projectExport: async () => largeArtifact }}
      runProjection={runProjection} request={request}
      fieldChoices={[]}
      onClose={() => root.unmount()}
    />));
    await flush();
    const dialog = document.body.querySelector<HTMLElement>(".export-dialog")!;
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(100);
    expect(dialog.textContent).toContain("Rows 1–100 of 205");
    const next = [...dialog.querySelectorAll("button")]
      .find(button => button.textContent === "Next 100")!;
    await act(async () => next.click());
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(100);
    expect(dialog.textContent).toContain("Rows 101–200 of 205");
    await act(async () => next.click());
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(dialog.textContent).toContain("Rows 201–205 of 205");
    const printButton = [...dialog.querySelectorAll("button")]
      .find(button => button.textContent === "Print / Save as PDF")!;
    setTimeout(() => { yieldedToBrowser = true; }, 0);
    await act(async () => printButton.click());
    expect(print).not.toHaveBeenCalled();
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(dialog.textContent).toContain("Rows 201–205 of 205");
    await waitFor(() => print.mock.calls.length === 1);
    expect(print).toHaveBeenCalledTimes(1);
    expect(responsiveBeforePrint).toBe(true);
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(5);
    const printRoot = document.body.querySelector<HTMLElement>(":scope > .projection-print-root")!;
    expect(printRoot).not.toBeNull();
    expect(printRoot.dataset.printRows).toBe("205");
    expect(printRoot.dataset.printFields).toBe("30");
    expect(printRoot.querySelectorAll("td")).toHaveLength(205 * 30);
    expect(Math.max(...[...printRoot.querySelectorAll(".projection-print-sheet")]
      .map(sheet => sheet.querySelectorAll("td").length))).toBeLessThanOrEqual(600);
    await act(async () => window.dispatchEvent(new Event("afterprint")));
    expect(document.body.querySelector(".projection-print-root")).toBeNull();
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(5);
    await act(async () => root.unmount());
  });

  it("downloads only CSV bytes inside a non-zero-offset Uint8Array view", async () => {
    const backing = new Uint8Array(artifact.csv.byteLength + 5);
    backing.fill(0xa5);
    backing.set(artifact.csv, 2);
    const offsetArtifact: ProjectionArtifactV1 = {
      ...artifact,
      csv: backing.subarray(2, 2 + artifact.csv.byteLength),
    };
    let downloaded: Blob | null = null;
    Object.defineProperties(URL, {
      createObjectURL: {
        configurable: true,
        value: vi.fn((blob: Blob) => { downloaded = blob; return "blob:clay-offset-csv"; }),
      },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ExportDialog
      worker={{ projectExport: async () => offsetArtifact }}
      runProjection={runProjection} request={request}
      fieldChoices={[]}
      onClose={() => root.unmount()}
    />));
    await flush();
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-export-csv]")!.click());
    expect(downloaded).toBeInstanceOf(Blob);
    expect([...await readBlob(downloaded!)]).toEqual([...artifact.csv]);
    await act(async () => root.unmount());
  });

  it("links projection failures to the dialog and keeps progress in a polite live region", async () => {
    let rejectProjection!: (reason: Error) => void;
    const pending = new Promise<ProjectionArtifactV1>((_resolve, reject) => {
      rejectProjection = reject;
    });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ExportDialog
      worker={{ projectExport: () => pending }} runProjection={runProjection} request={request} fieldChoices={[]}
      onClose={() => root.unmount()} />));
    const status = document.body.querySelector<HTMLElement>('[role="status"]')!;
    expect(status).not.toBeNull();
    expect(document.body.querySelector(".export-dialog tbody")).toBeNull();
    expect(status.getAttribute("aria-live")).toBe("polite");
    await act(async () => { rejectProjection(new Error("bounded source failed")); await pending.catch(() => undefined); });
    const dialog = document.body.querySelector<HTMLElement>(".export-dialog")!;
    expect(dialog.querySelector('[role="status"]')).toBeNull();
    const alert = dialog.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert).not.toBeNull();
    expect(alert.id).toBe("export-dialog-error");
    expect(dialog.getAttribute("aria-describedby")?.split(/\s+/))
      .toContain("export-dialog-error");
    expect(alert.textContent).toContain("bounded source failed");
    await act(async () => root.unmount());
  });

  it("cancels a pending projection immediately without exporting late bytes", async () => {
    let resolve!: (value: ProjectionArtifactV1) => void;
    const pending = new Promise<ProjectionArtifactV1>(done => { resolve = done; });
    let projectionSignal: AbortSignal | undefined;
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    let closed = false;
    await act(async () => root.render(<ExportDialog
      worker={{ projectExport: (_request, signal) => {
        projectionSignal = signal;
        return pending;
      } }} runProjection={runProjection} request={request} fieldChoices={[]}
      onClose={() => { closed = true; root.unmount(); }} />));
    const dialog = document.body.querySelector<HTMLElement>(".export-dialog")!;
    const started = performance.now();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    })));
    expect(performance.now() - started).toBeLessThan(250);
    expect(closed).toBe(true);
    expect(projectionSignal?.aborted).toBe(true);
    expect(document.body.querySelector(".export-dialog")).toBeNull();
    await act(async () => { resolve(artifact); await pending; });
    expect(document.body.querySelector(".export-dialog")).toBeNull();
  });
});
