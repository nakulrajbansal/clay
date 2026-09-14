/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RegTable } from "@clay/kernel";
import { RelationConversionDialog } from "../src/app/RelationConversionDialog";
import { createWorkerMutationContext, type WorkerClient } from "../src/app/worker-client";
import { beginPresentationIntent, readPresentationIntent } from "../src/app/presentation-intent";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => sessionStorage.clear());
const appInstanceId = `app_${"a".repeat(26)}`;
it("does not forget an ambiguous conversion Undo when Keep linked records is clicked", async () => {
  const intent = beginPresentationIntent(sessionStorage, appInstanceId, "conversionUndo", "schema.undoRelationConversion",
    { conversionRequestId: createWorkerMutationContext().requestId, beforeVersion: 1 }, createWorkerMutationContext);
  const worker = { cancelPresentation: vi.fn().mockResolvedValueOnce({ status: "uncertain" }).mockResolvedValue({ status: "cancelled" }) } as unknown as WorkerClient;
  const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<RelationConversionDialog appInstanceId={appInstanceId} sourceTable={{ name: "tasks", columns: [] } as unknown as RegTable}
      tables={[]} worker={worker} runWrite={fn => fn()} onCommitted={() => {}} onClose={() => {}} onError={() => {}} />));
    const click = async () => act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent === "Keep linked records")!.click(); });
    await click(); expect(readPresentationIntent(sessionStorage, appInstanceId, "conversionUndo")).toEqual(intent);
    await click(); expect(readPresentationIntent(sessionStorage, appInstanceId, "conversionUndo")).toBeNull();
    expect(worker.cancelPresentation).toHaveBeenCalledWith(intent.route, intent.payload, { requestId: intent.requestId });
  } finally { await act(async () => root.unmount()); }
});
it("requires terminal cancellation before a stale Keep can be re-previewed", async () => {
  const preview = { sourceTable: "tasks", sourceField: "person", targetTable: "people", displayField: "name",
    atVersion: 1, fingerprint: `sha256:${"b".repeat(64)}`, matchedRows: 1, unmatchedRows: 0, ambiguousRows: 0,
    duplicateSourceRows: 0, unmatchedSamples: [], ambiguousSamples: [], authorityTarget: { appInstanceId,
      activeGenerationId: `gen_${"c".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1,
      stateSha256: `sha256:${"d".repeat(64)}` } };
  const intent = beginPresentationIntent(sessionStorage, appInstanceId, "relation", "schema.convertTextToRelation",
    { ...preview, cardinality: "one" }, createWorkerMutationContext);
  const worker = { cancelPresentation: vi.fn().mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValue({ status: "cancelled" }) } as unknown as WorkerClient;
  const tables = [{ name: "tasks", columns: [{ name: "person", type: "text" }] }, { name: "people", columns: [{ name: "name", type: "text" }] }] as RegTable[];
  const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<RelationConversionDialog appInstanceId={appInstanceId} sourceTable={tables[0]!}
      tables={tables} worker={worker} runWrite={fn => fn()} onCommitted={() => {}} onClose={() => {}} onError={() => {}} />));
    const click = async () => act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent === "Cancel pending Keep and re-preview")!.click(); });
    await click(); expect(readPresentationIntent(sessionStorage, appInstanceId, "relation")).toEqual(intent);
    expect(document.querySelector("select")!.disabled).toBe(true);
    await click(); expect(readPresentationIntent(sessionStorage, appInstanceId, "relation")).toBeNull();
    expect(document.querySelector("select")!.disabled).toBe(false);
    expect(document.body.textContent).toContain("Preview matches");
  } finally { await act(async () => root.unmount()); }
});
it("reopens the exact Keep after presentation failure and exposes a persistent bounded Undo", async () => {
  const preview = { sourceTable: "tasks", sourceField: "person", targetTable: "people", displayField: "name",
    atVersion: 1, fingerprint: `sha256:${"b".repeat(64)}`, matchedRows: 1, unmatchedRows: 0, ambiguousRows: 0,
    duplicateSourceRows: 0, unmatchedSamples: [], ambiguousSamples: [], authorityTarget: { appInstanceId,
      activeGenerationId: `gen_${"c".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1,
      stateSha256: `sha256:${"d".repeat(64)}` } };
  const result = { version: 2, relationField: "person_link", sourceField: "person_source", convertedRows: 1 };
  let recorded = false; let undone = false;
  const worker = { createMutationContext: createWorkerMutationContext, previewRelationConversion: vi.fn(async () => preview),
    convertTextToRelation: vi.fn(async () => { recorded = true; return result; }),
    mutationOutcome: vi.fn(async (route: string) => recorded && route === "schema.convertTextToRelation"
      ? { status: "recorded", current: true, result, target: preview.authorityTarget }
      : undone && route === "schema.undoRelationConversion"
        ? { status: "recorded", current: false, result: { undone: true, version: 1 }, target: preview.authorityTarget }
        : { status: "not_invoked" }),
    undoRelationConversion: vi.fn(async () => { undone = true; return { undone: true, version: 1 }; }) };
  const tables = [{ name: "tasks", columns: [{ name: "person", type: "text" }] },
    { name: "people", columns: [{ name: "name", type: "text" }] }] as RegTable[];
  const committed = vi.fn(async () => {}); committed.mockRejectedValueOnce(new Error("panel refresh failed"));
  const host = document.createElement("div"); document.body.replaceChildren(host); let root = createRoot(host);
  const render = () => root.render(<RelationConversionDialog appInstanceId={appInstanceId} sourceTable={tables[0]!}
    tables={tables} worker={worker as unknown as WorkerClient} runWrite={fn => fn()} onCommitted={committed}
    onClose={() => {}} onError={() => {}} />);
  const click = async (text: string) => act(async () => {
    const button = [...document.querySelectorAll("button")].find(button => button.textContent?.includes(text));
    expect(button).toBeDefined(); button!.click();
  });
  try {
    await act(async () => render()); await click("Preview matches"); await click("Keep");
    await act(async () => root.unmount()); root = createRoot(host); await act(async () => render());
    await click("Retry Keep"); expect(worker.convertTextToRelation).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount()); root = createRoot(host); await act(async () => render());
    committed.mockRejectedValueOnce(new Error("Undo committed but presentation was interrupted"));
    await click("Undo this conversion"); expect(worker.undoRelationConversion).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount()); root = createRoot(host); await act(async () => render());
    await click("Undo this conversion"); expect(worker.undoRelationConversion).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenLastCalledWith({ relationField: "", convertedRows: 0, historical: true });
  } finally { await act(async () => root.unmount()); }
});
