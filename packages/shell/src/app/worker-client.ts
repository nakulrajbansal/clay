// Typed promise wrapper over the DB worker's command protocol.
import type {
  DebugEvent, HistoryEntry, LivePanel, RegTable, Suggestion,
} from "@clay/kernel";
import type { IntentOutcome } from "../worker/db-worker";

export type TraceEntry = { at: string; intent: string; events: DebugEvent[] };

export type BootInfo = { persistent: boolean; seeded: boolean; shellId: string | null };
export type StatusInfo = {
  persistent: boolean; persisted: boolean;
  usageBytes: number | null; quotaBytes: number | null;
  versions: number;
  stats: { kept: number; discarded: number; failed: number; clarify: number };
};

export class WorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: Error) => void;
  }>();

  constructor(private readonly worker: Worker) {
    worker.onmessage = (ev): void => {
      const msg = ev.data as { id: number; ok: boolean; result?: unknown; error?: string };
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error ?? "worker error"));
    };
  }

  private call<T>(op: string, payload?: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, payload }, transfer ?? []);
    });
  }

  /** Terminate the worker, releasing its OPFS access handles. Call before a
   * reload so the next worker can acquire the pool without contention. */
  terminate(): void { try { this.worker.terminate(); } catch { /* already gone */ } }

  boot(appId?: string): Promise<BootInfo> { return this.call("boot", { appId }); }
  setModelAccess(apiKey: string | null, backendUrl: string | null): Promise<null> {
    return this.call("setModelAccess",
      { apiKey: apiKey ?? undefined, backendUrl: backendUrl ?? undefined });
  }
  deleteApp(appId: string): Promise<null> { return this.call("deleteApp", { appId }); }
  forkApp(newAppId: string): Promise<null> { return this.call("forkApp", { newAppId }); }
  status(): Promise<StatusInfo> { return this.call("status"); }
  seed(shellId: string): Promise<null> { return this.call("seed", { shellId }); }
  importTable(payload: { table: string; columns: unknown[]; rows: unknown[] }):
    Promise<{ table: string; imported: number; columns: number }> {
    return this.call("importTable", payload);
  }
  panels(): Promise<LivePanel[]> { return this.call("panels"); }
  commitLayout(placements: { panel_id: string; region: "top" | "main" | "side"; order: number; w?: number; h?: number; col?: number | null }[]): Promise<LivePanel[]> {
    return this.call("commitLayout", { placements });
  }
  renamePanel(panelId: string, title: string): Promise<LivePanel[]> {
    return this.call("renamePanel", { panelId, title });
  }
  rowHistory(table: string, id: string):
    Promise<{ at: string; values: Record<string, unknown> }[]> {
    return this.call("rowHistory", { table, id });
  }
  addColumn(table: string, column: { name: string; type: string; values?: string[] }):
    Promise<RegTable[]> {
    return this.call("addColumn", { table, column });
  }
  renameColumn(table: string, from: string, to: string): Promise<RegTable[]> {
    return this.call("renameColumn", { table, from, to });
  }
  removePanel(panelId: string): Promise<LivePanel[]> {
    return this.call("removePanel", { panelId });
  }
  history(): Promise<HistoryEntry[]> { return this.call("history"); }
  setCheckpoint(version: number, label: string): Promise<HistoryEntry[]> {
    return this.call("setCheckpoint", { version, label });
  }
  panelsAt(version: number): Promise<LivePanel[]> { return this.call("panelsAt", { version }); }
  makeLatest(version: number): Promise<LivePanel[]> { return this.call("makeLatest", { version }); }
  intent(text: string): Promise<IntentOutcome> { return this.call("intent", { text }); }
  repairPanel(panelId: string, error: string): Promise<IntentOutcome> {
    return this.call("repairPanel", { panelId, error });
  }
  revertPanel(panelId: string): Promise<LivePanel[]> {
    return this.call("revertPanel", { panelId });
  }
  keep(): Promise<{ version: number }> { return this.call("keep"); }
  discard(): Promise<null> { return this.call("discard"); }
  removeSamples(): Promise<null> { return this.call("removeSamples"); }
  fillSamples(): Promise<{ added: number; tables: number }> { return this.call("fillSamples"); }
  sampleCount(): Promise<number> { return this.call("sampleCount"); }
  reset(): Promise<null> { return this.call("reset"); }
  registryTables(): Promise<RegTable[]> { return this.call("registryTables"); }
  restoreRow(table: string, id: string): Promise<null> {
    return this.call("restoreRow", { table, id });
  }
  restorableRows(table: string): Promise<string[]> {
    return this.call("restorableRows", { table });
  }
  suggestions(): Promise<Suggestion[]> { return this.call("suggestions"); }
  debugLog(): Promise<TraceEntry[]> { return this.call("debugLog"); }
  recordFilter(name: string, payload: unknown): Promise<null> {
    return this.call("recordFilter", { name, payload });
  }
  dismissSuggestion(subject: string, kind: string): Promise<null> {
    return this.call("dismissSuggestion", { subject, kind });
  }
  acceptSuggestion(subject: string, kind: string): Promise<null> {
    return this.call("acceptSuggestion", { subject, kind });
  }
  exportArchive(): Promise<{ bytes: ArrayBuffer; filename: string }> {
    return this.call("exportArchive");
  }
  importArchive(bytes: ArrayBuffer): Promise<{
    manifest: { app: string; versions: number }; invalidPanels: string[];
  }> {
    return this.call("importArchive", { bytes }, [bytes]);
  }
  getSetting<T>(key: string): Promise<T | null> { return this.call("getSetting", { key }); }
  setSetting(key: string, value: unknown): Promise<null> {
    return this.call("setSetting", { key, value });
  }

  /** Open a serveStore RPC port on the worker for the Bridge's AsyncStore. */
  openStorePort(target: "live" | "shadow"): MessagePort {
    const channel = new MessageChannel();
    void this.call("storePort", { target }, [channel.port2]);
    channel.port1.start();
    return channel.port1;
  }
}
