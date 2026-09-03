// The DB worker (doc 02 §1/§3): exclusively owns SQLite over OPFS and hosts
// the trusted kernel — ClayStore, Validator, and the MutationPipeline all
// run here. The main thread gets: a command protocol (below) plus
// serveStore RPC ports for the Bridge's AsyncStore (live and shadow).
// Records never leave this worker except over those ports to the Bridge.
import {
  ClayStore, MutationPipeline, deleteAppStorage, deriveInverse, openBrowserDriver,
  portFromMessagePort, serveStore, wipeBrowserStorage,
  type DbDriver, type DebugEvent, type LivePanel, type MigrationPlanT,
  type PanelProvenance, type PreviewHandle, type PrivateMetricEvent,
} from "@clay/kernel";
import { MutationClient } from "@clay/mutation";
import { removeSampleRows, seedStarterShell, type StarterShellId } from "../shells/seed";
import { fillSampleRows, sampleRowCount } from "./samples";
import { addColumnCommit, renameColumnCommit } from "./schema-ops";

export type PreviewInfo = {
  summary: string;
  diff: { kind: string; detail: string }[];
  panels: LivePanel[];
  removePanels: string[];
  version: number;
  repaired: boolean;
};

export type IntentOutcome =
  | { status: "clarify"; question: string; repaired: boolean }
  | { status: "preview"; preview: PreviewInfo }
  | { status: "failed"; stage: string; reasons: string[]; repaired: boolean };

type Request = { id: number; op: string; payload?: Record<string, unknown> };

type ImportColumn = { name: string; type: string; values?: string[] };

/** A basic, always-valid table panel so imported data is visible immediately
 * (before any model reshape). Columns are formatted by inferred type. */
function importTablePanelCode(table: string, columns: ImportColumn[]): string {
  const cols = columns.map(c => {
    const fmt = c.type === "number" ? ', format: "number"'
      : c.type === "date" ? ', format: "date"' : "";
    return `{ field: ${JSON.stringify(c.name)}, label: ${JSON.stringify(c.name)}${fmt} }`;
  }).join(", ");
  return `export default function (clay) {
  clay.db.watch({ from: ${JSON.stringify(table)}, limit: 500 }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No rows yet" })
      : h(Table, { sortable: true, rows, columns: [${cols}] }));
  });
}`;
}

let store: ClayStore | null = null;
let persistent = false;
let persistRequested = false;
let pending: PreviewHandle | null = null;
let pipelineRun: Promise<IntentOutcome> | null = null;
let currentAppId: string | undefined;   // which app's OPFS files are open (G4)
// Device-global model access (B1): set by the main thread from localStorage,
// shared across every app, never persisted in an app DB.
type ModelProviderId = "clay" | "openai" | "anthropic" | "codex";
let modelAccess: {
  provider?: ModelProviderId; apiKey?: string; backendUrl?: string;
  session?: string; providerToken?: string;
} = {};

// A ring of recent pipeline traces the user can review/copy (the user
// asked for logs of inputs -> processing -> outputs). Also mirrored to the
// worker console (visible in DevTools).
type TraceEntry = { at: string; intent: string; events: DebugEvent[] };
const traceLog: TraceEntry[] = [];
const TRACE_CAP = 25;

function recordTrace(entry: TraceEntry): void {
  traceLog.unshift(entry);
  if (traceLog.length > TRACE_CAP) traceLog.length = TRACE_CAP;
}

function mustStore(): ClayStore {
  if (!store) throw new Error("worker not booted");
  return store;
}

function dropPending(): void {
  if (pending) { pending.discard(); pending = null; }
}

async function runPipelineTextOnce(text: string): Promise<IntentOutcome> {
  const s = mustStore();
  const backendUrl = modelAccess.backendUrl;
  const apiKey = modelAccess.apiKey;
  // Hosted first (ADR-011): if a backend is configured, use it and no
  // browser key is needed. Otherwise fall back to BYO.
  const client = backendUrl
    ? new MutationClient({ mode: "hosted", endpoint: backendUrl.replace(/\/$/, ""),
        session: modelAccess.provider === "clay" ? modelAccess.session
          : modelAccess.provider === "codex" ? modelAccess.providerToken : undefined })
    : apiKey
      ? new MutationClient({ mode: "byo", apiKey })
      : null;
  if (!client) {
    return { status: "failed", stage: "plan", reasons: [
      "No model access configured. In Settings, either add a Clay backend URL "
      + "(hosted) or your own Anthropic API key (BYO).",
    ], repaired: false };
  }
  const events: DebugEvent[] = [];
  const pipeline = new MutationPipeline(s, client, {
    onDebug: (ev) => {
      events.push(ev);
      // Console (DevTools): raw model output truncated, everything else full.
      const printable = ev.stage === "plan" && ev.raw
        ? { ...ev, raw: ev.raw.slice(0, 2000) } : ev;
      console.log(`[clay pipeline] ${ev.stage}`, printable);
    },
  });
  const result = await pipeline.run(text);
  recordTrace({ at: new Date().toISOString(), intent: text, events });
  if (result.status === "clarify")
    return { status: "clarify", question: result.question, repaired: result.repaired };
  if (result.status === "failed")
    return {
      status: "failed", stage: result.stage, reasons: result.reasons,
      repaired: result.repaired,
    };
  pending = result.preview;
  return {
    status: "preview",
    preview: {
      summary: result.preview.plan.summary,
      diff: result.preview.plan.user_facing_diff,
      panels: result.preview.plan.panels.map(pa => ({
        panel_id: pa.panel_id, title: pa.title, placement: pa.placement,
        code: pa.code, declared_queries: pa.declared_queries,
        declared_writes: pa.declared_writes, version: result.preview.version,
      })),
      removePanels: result.preview.plan.remove_panels,
      version: result.preview.version,
      repaired: result.repaired,
    },
  };
}

function runPipelineText(text: string): Promise<IntentOutcome> {
  if (pending || pipelineRun)
    return Promise.resolve({ status: "failed", stage: "plan",
      reasons: ["Finish the current reshape before starting another."], repaired: false });
  pipelineRun = runPipelineTextOnce(text).finally(() => { pipelineRun = null; });
  return pipelineRun;
}

async function handle(req: Request, ports: readonly MessagePort[]): Promise<unknown> {
  const p = req.payload ?? {};
  switch (req.op) {
    case "boot": {
      const appId = p.appId === undefined ? undefined : String(p.appId);
      if (!store) {
        const opened = await openBrowserDriver(appId);
        persistent = opened.persistent;
        currentAppId = appId;
        store = ClayStore.fromDriver(opened.driver);
      }
      return {
        persistent,
        seeded: store.headVersion() > 0,
        shellId: store.getSetting<string>("shell_id") ?? null,
      };
    }
    case "setModelAccess": {
      const provider = p.provider;
      if (provider !== "clay" && provider !== "openai"
          && provider !== "anthropic" && provider !== "codex")
        throw new Error("invalid model provider");
      modelAccess = {
        provider,
        apiKey: p.apiKey ? String(p.apiKey) : undefined,
        backendUrl: p.backendUrl ? String(p.backendUrl) : undefined,
        session: provider === "clay" && p.session ? String(p.session) : undefined,
        providerToken: provider === "codex" && p.providerToken
          ? String(p.providerToken) : undefined,
      };
      return null;
    }
    case "forkApp": {
      // B5 fork-and-explore: copy the CURRENT app (schema + data + history +
      // panels) into a brand-new app's OPFS files, via the same validated
      // .clay export/import path. The current app is left untouched — the
      // client boots the fork after a reload.
      const newId = String(p.newAppId);
      const s = mustStore();
      const bytes = await s.exportArchive(s.getSetting<string>("shell_id") ?? "clay");
      const openNew = async (): Promise<DbDriver> => (await openBrowserDriver(newId)).driver;
      const result = await ClayStore.importArchive(bytes, openNew);
      result.store.close();          // populated on disk; not the live store
      return null;
    }
    case "deleteApp": {
      // G4: delete one app's files. If it's the open one, close first.
      const appId = String(p.appId);
      if (appId === currentAppId || (appId === "default" && currentAppId === undefined)) {
        dropPending();
        store?.close();
        store = null;
        currentAppId = undefined;
      }
      await deleteAppStorage(appId);
      return null;
    }
    case "seed":
      seedStarterShell(mustStore(), p.shellId as StarterShellId);
      return null;
    case "importTable": {
      // Bring-your-own-data: create the table + a starter view and insert the
      // parsed rows as ONE reversible commit (data outlives interface). The
      // model builds the richer dashboard afterwards.
      const s = mustStore();
      const columns = p.columns as ImportColumn[];
      const rows = p.rows as Record<string, unknown>[];
      const reg = s.registrySnapshot();
      let table = String(p.table);
      let n = 2;
      while (reg.has(table)) table = `${String(p.table)}_${n++}`;   // avoid collision
      const ops: MigrationPlanT["operations"] = [{
        op: "create_table", table,
        columns: columns.map(c => ({
          name: c.name, type: c.type as "text", required: false,
          ...(c.values ? { values: c.values } : {}),
        })),
      }];
      const panelId = `${table}_view`.slice(0, 40).replace(/^[^a-z]/, "t");
      s.commit({
        intent: `Import data (${table})`,
        summary: `Imported ${rows.length} row${rows.length === 1 ? "" : "s"} into ${table}.`,
        migration: { operations: ops, inverse: deriveInverse(ops, reg) },
        panels: [{
          panel_id: panelId, title: table, placement: { region: "main", order: 0, w: 4 },
          code: importTablePanelCode(table, columns),
          declared_queries: [{ from: table, limit: 500 }], declared_writes: [],
        }],
      });
      let imported = 0;
      for (const row of rows) { try { s.insert(table, row); imported++; } catch { /* skip bad row */ } }
      return { table, imported, columns: columns.length };
    }
    case "panels":
      return mustStore().livePanels();
    case "panelProvenance":
      return mustStore().livePanels()
        .map(panel => mustStore().panelProvenance(panel.panel_id))
        .filter((item): item is PanelProvenance => item !== null);
    case "semanticTrace":
      return mustStore().semanticSchemaTrace();
    case "fieldProvenance":
      return mustStore().fieldProvenance();
    case "recordPrivateMetric":
      mustStore().recordPrivateMetric(p.event as PrivateMetricEvent);
      return null;
    case "privateMetricsSummary":
      return mustStore().privateMetricsSummary();
    case "setPrivateMetricsEnabled":
      mustStore().setPrivateMetricsEnabled(Boolean(p.enabled));
      return mustStore().privateMetricsSummary();
    case "clearPrivateMetrics":
      mustStore().clearPrivateMetrics();
      return mustStore().privateMetricsSummary();
    case "commitLayout":
      mustStore().commitLayout(
        p.placements as { panel_id: string; region: "top" | "main" | "side"; order: number; w?: number }[]);
      return mustStore().livePanels();
    case "history":
      return mustStore().history();
    case "setCheckpoint":
      mustStore().setCheckpoint(Number(p.version), String(p.label ?? ""));
      return mustStore().history();
    case "panelsAt":
      return mustStore().livePanels(Number(p.version));
    case "makeLatest": {
      // ADR-007: the one destructive-ish operation; the shell warns first.
      dropPending();
      mustStore().rollbackTo(Number(p.version), { truncate: true });
      return mustStore().livePanels();
    }
    case "registryTables":
      return [...mustStore().registrySnapshot().values()];
    case "storePort": {
      const port = ports[0];
      if (!port) throw new Error("storePort needs a transferred port");
      const target = p.target === "shadow" ? pending?.shadow : mustStore();
      if (!target) throw new Error("no shadow store open");
      port.start?.();
      serveStore(target, portFromMessagePort(port));
      return null;
    }
    case "intent":
      return runPipelineText(String(p.text ?? ""));
    case "repairPanel": {
      // doc 05 §7 Repair: one-round fix with the runtime error; the result
      // arrives as a NORMAL preview and never auto-commits.
      const panelId = String(p.panelId);
      const error = String(p.error ?? "unknown error").slice(0, 200);
      const text = (`The ${panelId} panel crashed at runtime with this error: ${error}. `
        + `Fix that panel. Keep its purpose and layout; change only what is `
        + `needed to stop the error.`).slice(0, 500);
      return runPipelineText(text);
    }
    case "revertPanel": {
      dropPending();
      mustStore().revertPanel(String(p.panelId));
      return mustStore().livePanels();
    }
    case "renamePanel": {
      mustStore().renamePanel(String(p.panelId), String(p.title));
      return mustStore().livePanels();
    }
    case "addAttachment":
      return mustStore().addAttachment({
        table: String(p.table), rowId: String(p.rowId), field: String(p.field),
        name: String(p.name), mime: String(p.mime ?? ""),
        bytes: new Uint8Array(p.bytes as ArrayBuffer),
      });
    case "attachmentsForRecord":
      return mustStore().attachmentsForRecord(
        String(p.table), String(p.rowId), String(p.field));
    case "readAttachment":
      return mustStore().readAttachment(String(p.id));
    case "removeAttachment":
      mustStore().removeAttachment(
        String(p.table), String(p.rowId), String(p.field), String(p.id)); return null;
    case "attachmentStorage":
      return mustStore().attachmentStorage();
    case "purgeDeletedAttachments":
      return mustStore().purgeDeletedAttachments();
    case "listAutomations":
      return mustStore().listAutomations();
    case "upsertAutomation":
      return mustStore().upsertAutomation(p.input as never);
    case "deleteAutomation":
      mustStore().deleteAutomation(String(p.id)); return null;
    case "simulateAutomation":
      return mustStore().simulateAutomation(String(p.id));
    case "runAutomations":
      return mustStore().runDueAutomations();
    case "runAutomationNow":
      return mustStore().runAutomationNow(String(p.id));
    case "automationRuns":
      return mustStore().automationRuns(
        p.automationId === null || p.automationId === undefined ? undefined : String(p.automationId),
        Number(p.limit ?? 100));
    case "undoAutomationRun":
      return mustStore().undoAutomationRun(String(p.id));
    case "notifications":
      return mustStore().listNotifications(Number(p.limit ?? 100));
    case "markNotificationRead":
      mustStore().markNotificationRead(String(p.id)); return null;
    case "globalSearch":
      return mustStore().globalSearch(String(p.term ?? ""), Number(p.limit ?? 20));
    case "applyBatch":
      return mustStore().applyBatch({
        source: "user", summary: String(p.summary ?? ""), mutations: p.mutations as never,
      });
    case "operationBatches":
      return mustStore().operationBatches(Number(p.limit ?? 50));
    case "undoBatch":
      return mustStore().undoBatch(String(p.id));
    case "rowHistory":
      return mustStore().rowHistory(String(p.table), String(p.id));
    case "previewRelationConversion":
      return mustStore().previewRelationConversion({
        sourceTable: String(p.sourceTable), sourceField: String(p.sourceField),
        targetTable: String(p.targetTable), displayField: String(p.displayField),
      });
    case "convertTextToRelation":
      return mustStore().convertTextToRelation({ ...p, cardinality: "one" } as never);
    case "addColumn": {
      addColumnCommit(mustStore(), String(p.table), p.column as never);
      return [...mustStore().registrySnapshot().values()];
    }
    case "renameColumn": {
      renameColumnCommit(mustStore(), String(p.table), String(p.from), String(p.to));
      return [...mustStore().registrySnapshot().values()];
    }
    case "removePanel": {
      mustStore().removePanel(String(p.panelId));
      return mustStore().livePanels();
    }
    case "keep": {
      if (!pending) throw new Error("no preview open");
      const version = pending.keep();
      pending = null;
      // doc 04 §8: request durable storage at the first kept mutation.
      if (!persistRequested && persistent
          && typeof navigator !== "undefined" && navigator.storage?.persist) {
        persistRequested = true;
        try { await navigator.storage.persist(); } catch { /* best effort */ }
      }
      return { version };
    }
    case "discard":
      dropPending();
      return null;
    case "removeSamples":
      removeSampleRows(mustStore());
      return null;
    case "fillSamples":
      return fillSampleRows(mustStore());
    case "sampleCount":
      return sampleRowCount(mustStore());
    case "restoreRow":
      mustStore().restoreRow(String(p.table), String(p.id));
      return null;
    case "restorableRows":
      return mustStore().restorableRows(String(p.table));
    case "suggestions":
      return mustStore().suggestions();
    case "recordFilter":
      mustStore().recordUsage({ kind: "filter",
        subject: String(p.name), detail: p.payload as Record<string, unknown> });
      return null;
    case "dismissSuggestion":
      mustStore().dismissSuggestion(String(p.subject), String(p.kind));
      return null;
    case "acceptSuggestion":
      mustStore().acceptSuggestion(String(p.subject), String(p.kind));
      return null;
    case "reset": {
      // P4: deleting the local databases removes all local data.
      dropPending();
      store?.close();
      store = null;
      await wipeBrowserStorage();
      return null;
    }
    case "exportArchive": {
      const s = mustStore();
      const bytes = await s.exportArchive(s.getSetting<string>("shell_id") ?? "clay");
      return {
        bytes: bytes.buffer,
        filename: `clay-${new Date().toISOString().slice(0, 10)}.clay`,
      };
    }
    case "importArchive": {
      dropPending();
      const bytes = new Uint8Array(p.bytes as ArrayBuffer);
      const result = await mustStore().replaceFromArchive(bytes);
      store = result.store;
      return { manifest: result.manifest, invalidPanels: result.invalidPanels };
    }
    case "status": {
      // navigator.storage.persist() requested at first commit (doc 04 §8),
      // status + usage estimate surfaced here.
      let persisted = persistent;
      let usageBytes: number | null = null;
      let quotaBytes: number | null = null;
      try {
        if (persistent && typeof navigator !== "undefined" && navigator.storage) {
          persisted = await navigator.storage.persisted();
          const est = await navigator.storage.estimate();
          usageBytes = est.usage ?? null;
          quotaBytes = est.quota ?? null;
        }
      } catch { /* estimate unavailable */ }
      let modelConnection = {
        provider: "none", model: null as string | null,
        configured: false, reachable: false, detail: "No model connection selected",
      };
      if (modelAccess.apiKey) {
        modelConnection = { provider: "anthropic", model: null,
          configured: true, reachable: true, detail: "API key stored on this device" };
      } else if (modelAccess.backendUrl) {
        try {
          const healthUrl = `${modelAccess.backendUrl.replace(/\/$/, "")}/healthz`;
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) });
          const health = await response.json() as {
            model?: boolean; provider?: string; model_id?: string;
            reachable?: boolean; detail?: string;
          };
          modelConnection = {
            provider: health.provider ?? "hosted", model: health.model_id ?? null,
            configured: health.model === true,
            reachable: health.reachable ?? response.ok,
            detail: health.detail ?? (health.model
              ? "Connected" : "Backend reachable; model not configured"),
          };
        } catch {
          modelConnection = { provider: "hosted", model: null,
            configured: true, reachable: false, detail: "Backend is not reachable" };
        }
      }
      return {
        persistent, persisted, usageBytes, quotaBytes,
        attachments: mustStore().attachmentStorage(),
        versions: mustStore().headVersion(),
        stats: mustStore().attemptStats(),
        modelConnection,
      };
    }
    case "requestPersist": {
      if (typeof navigator !== "undefined" && navigator.storage?.persist)
        return { persisted: await navigator.storage.persist() };
      return { persisted: false };
    }
    case "debugLog":
      return traceLog;
    case "getSetting":
      return mustStore().getSetting(String(p.key)) ?? null;
    case "setSetting":
      mustStore().setSetting(String(p.key), p.value);
      return null;
    case "deleteSetting":
      mustStore().deleteSetting(String(p.key));
      return null;
    case "compareAndSetSetting": {
      const key = String(p.key);
      const current = mustStore().getSetting<unknown>(key);
      const revision = current && typeof current === "object"
        && Number.isSafeInteger((current as { revision?: unknown }).revision)
        ? Number((current as { revision: number }).revision) : 0;
      if (revision !== Number(p.expectedRevision)) return { ok: false, current };
      mustStore().setSetting(key, p.value);
      return { ok: true, current: p.value };
    }
    default:
      throw new Error(`unknown op '${req.op}'`);
  }
}

self.onmessage = (ev: MessageEvent): void => {
  const req = ev.data as Request;
  void (async () => {
    try {
      const result = await handle(req, ev.ports);
      const transfer: Transferable[] = [];
      if (result && typeof result === "object" && "bytes" in result) {
        const bytes = (result as { bytes?: unknown }).bytes;
        if (bytes instanceof ArrayBuffer) transfer.push(bytes);
        else if (bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer)
          transfer.push(bytes.buffer);
      }
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, result }, transfer);
    } catch (e) {
      (self as unknown as Worker).postMessage({
        id: req.id, ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
};
