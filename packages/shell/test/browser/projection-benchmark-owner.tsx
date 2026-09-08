import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ProjectionArtifactV1, ProjectionRequestV1 } from "@clay/kernel/projection";
import { ExportDialog } from "../../src/app/ExportDialog";
import { WorkerClient } from "../../src/app/worker-client";
import "../../src/app/styles.css";
import "../../src/app/Operations.css";

const query = new URLSearchParams(location.search);
const workerUrl = query.get("worker");
const rows = Number(query.get("rows"));
if (!workerUrl || new URL(workerUrl, location.href).origin !== location.origin)
  throw new Error("benchmark worker URL must use the page origin");
const resolvedWorkerUrl = workerUrl;
if (rows !== 1000 && rows !== 5000) throw new Error("benchmark row count is invalid");

let client: WorkerClient;
let request: ProjectionRequestV1;
let inputBytes = 0;
let lastArtifact: ProjectionArtifactV1 | null = null;
type ExportDialogState = "loading" | "success" | "error";
let nextDialogState: ExportDialogState = "success";
let openPreview: ((state: ExportDialogState) => void) | null = null;
let memoryTimer: ReturnType<typeof setInterval> | null = null;
let memoryBaseline = 0;
let memoryPeak = 0;
let printCalls = 0;

Object.assign(window, {
  __releaseFEventLoopYielded: false,
  __releaseFResponsiveAtPrint: false,
});
window.print = () => {
  printCalls++;
  window.__releaseFResponsiveAtPrint = window.__releaseFEventLoopYielded;
};

function heapBytes(): number {
  return Number((performance as Performance & { memory?: { usedJSHeapSize?: number } })
    .memory?.usedJSHeapSize ?? 0);
}

function beginMemorySample(): void {
  if (memoryTimer) clearInterval(memoryTimer);
  memoryBaseline = heapBytes();
  memoryPeak = memoryBaseline;
  memoryTimer = setInterval(() => { memoryPeak = Math.max(memoryPeak, heapBytes()); }, 2);
}

function endMemorySample(): { baseline: number; peak: number } {
  if (memoryTimer) clearInterval(memoryTimer);
  memoryTimer = null;
  memoryPeak = Math.max(memoryPeak, heapBytes());
  return { baseline: memoryBaseline, peak: memoryPeak };
}

async function initializeWorker(): Promise<void> {
  const worker = new Worker(resolvedWorkerUrl, { type: "module", name: `release-f-${rows}` });
  const initialized = await new Promise<{ request: ProjectionRequestV1; inputBytes: number }>(
    (resolve, reject) => {
      worker.onmessage = event => {
        const response = event.data as { ok?: boolean; result?: unknown; error?: { message?: string } };
        if (response.ok) resolve(response.result as { request: ProjectionRequestV1; inputBytes: number });
        else reject(new Error(response.error?.message ?? "benchmark worker initialization failed"));
      };
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ id: 0, op: "benchmarkInit", payload: { rows } });
    },
  );
  request = initialized.request;
  inputBytes = initialized.inputBytes;
  client = new WorkerClient(worker);
}

const exportWorker = {
  async projectExport(next: ProjectionRequestV1, signal?: AbortSignal): Promise<ProjectionArtifactV1> {
    if (nextDialogState === "loading") return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("induced loading closed")),
        { once: true });
    });
    const projectedRequest = nextDialogState === "error"
      ? { ...next, expectedSchemaVersion: next.expectedSchemaVersion + 1 }
      : next;
    const artifact = await client.projectExport(projectedRequest, signal);
    lastArtifact = artifact;
    return artifact;
  },
};

function App(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  openPreview = state => { nextDialogState = state; setOpen(true); };
  return <main>
    <button id="open-benchmark-preview" type="button" onClick={() => setOpen(true)}>
      Open benchmark preview
    </button>
    {open ? <ExportDialog
      worker={exportWorker}
      request={request}
      fieldChoices={request.fieldIds.map((fieldId, index) => ({
        fieldId, label: index === 0 ? "Title" : `Field ${index.toString().padStart(2, "0")}`,
      }))}
      onClose={() => setOpen(false)}
    /> : null}
  </main>;
}

const ready = initializeWorker().then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});

const api = {
  ready,
  rows,
  async project(): Promise<{ plaintextBytes: number; csvBytes: number }> {
    lastArtifact = await client.projectExport(request);
    return {
      plaintextBytes: lastArtifact.plaintext.byteLength,
      csvBytes: lastArtifact.csv.byteLength,
    };
  },
  async cancel(): Promise<void> {
    const controller = new AbortController();
    const pending = client.projectExport(request, controller.signal);
    controller.abort();
    try { await pending; }
    catch (error) {
      const detail = (error as { detail?: unknown }).detail;
      if ((error as { code?: unknown }).code === "E_CANCELLED"
          && typeof detail === "object" && detail !== null
          && (detail as { quiescent?: unknown }).quiescent === true
          && (detail as { outcome?: unknown }).outcome === "cancelled") return;
      throw error;
    }
    throw new Error("cancelled projection resolved unexpectedly");
  },
  open(): void {
    if (!openPreview) throw new Error("benchmark owner is not ready");
    lastArtifact = null;
    openPreview("success");
  },
  openState(state: ExportDialogState): void {
    if (!openPreview) throw new Error("benchmark owner is not ready");
    lastArtifact = null;
    openPreview(state);
  },
  artifactBytes(): { plaintextBytes: number; csvBytes: number } {
    if (!lastArtifact) throw new Error("benchmark preview artifact is unavailable");
    return {
      plaintextBytes: lastArtifact.plaintext.byteLength,
      csvBytes: lastArtifact.csv.byteLength,
    };
  },
  inputBytes: (): number => inputBytes,
  printCalls: (): number => printCalls,
  beginMemorySample,
  endMemorySample,
};

Object.assign(window, { __projectionBenchmark: api });

declare global {
  interface Window {
    __projectionBenchmark: typeof api;
    __releaseFEventLoopYielded: boolean;
    __releaseFResponsiveAtPrint: boolean;
  }
}
