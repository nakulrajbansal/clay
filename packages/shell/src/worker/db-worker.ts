// The DB worker (doc 02 §1/§3): exclusively owns SQLite over OPFS and hosts
// the trusted kernel — ClayStore, Validator, and the MutationPipeline all
// run here. The main thread gets: a command protocol (below) plus
// serveStore RPC ports for the Bridge's AsyncStore (live and shadow).
// Records never leave this worker except over those ports to the Bridge.
import {
  InProcessAsyncStore, portFromMessagePort, serveStore,
  type DebugEvent, type LivePanel, type PanelProvenance, type PreviewHandle,
} from "@clay/kernel";
import { ClayError } from "@clay/kernel/errors";
import {
  ProductionStoreAuthority,
  type ProductionStoreReader,
} from "@clay/kernel/worker-authority";
import { createStarterSeedBundle } from "../shells/seed";
import { createSampleFillBundle } from "./samples";
import { DB_WORKER_ROUTE_CENSUS } from "./mutation-route-census";

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

type Request = {
  id: number;
  requestId?: string;
  op: string;
  payload?: Record<string, unknown>;
};


let authority: ProductionStoreAuthority | null = null;
let authorityBoot: Promise<ProductionStoreAuthority> | null = null;
let store: ProductionStoreReader | null = null;
let persistent = false;
let pending: PreviewHandle | null = null;
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

function mustStore(): ProductionStoreReader {
  if (!store) throw new Error("worker not booted");
  return store;
}

function mustAuthority(): ProductionStoreAuthority {
  if (!authority) throw new ClayError("E_CATALOG_UNAVAILABLE", "worker authority is not booted");
  return authority;
}

function failClosedMutation(route: string): never {
  throw new ClayError("E_CATALOG_UNAVAILABLE",
    `production mutation '${route}' is unavailable until it is authority-routed`);
}

function enforceProductionMutationRoute(op: string): void {
  const classification = DB_WORKER_ROUTE_CENSUS[op as keyof typeof DB_WORKER_ROUTE_CENSUS];
  if (!classification)
    throw new ClayError("E_CATALOG_UNAVAILABLE", `unclassified worker route '${op}'`);
  if (classification.enforcement === "unavailable") failClosedMutation(op);
}

async function bootProductionAuthority(input: unknown): Promise<{
  persistent: true; seeded: boolean; shellId: string | null;
  selectedAppInstanceId: string; catalogGeneration: string;
  apps: Array<{ id: string; name: string; shellId: string }>;
}> {
  if (!authority) {
    authorityBoot ??= ProductionStoreAuthority.bootBrowser(input);
    authority = await authorityBoot;
    store = authority.readStore();
    persistent = true;
  }
  const info = authority.bootInfo();
  return {
    persistent: true,
    seeded: info.seeded,
    shellId: info.shellId,
    selectedAppInstanceId: info.selectedAppInstanceId,
    catalogGeneration: info.catalogGeneration,
    apps: info.apps,
  };
}

function authorityRequestId(req: Request): string {
  if (req.requestId === undefined) return mustAuthority().createRequestId();
  if (!/^req_[a-z2-7]{26}$/.test(req.requestId))
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "worker request identity is invalid");
  return req.requestId;
}

async function runAuthorityMutation(
  route: "seed" | "importTable" | "removeSamples" | "fillSamples"
    | "setSetting" | "deleteSetting" | "compareAndSetSetting" | "commitLayout",
  payload: Record<string, unknown>,
  req: Request,
): Promise<unknown> {
  const target = mustAuthority();
  const requestId = authorityRequestId(req);
  if (route === "seed") return (await target.executeMutation({
    requestId,
    route: "starter.seed",
    payload,
  })).result;
  if (route === "importTable") return (await target.executeMutation({
    requestId,
    route: "table.import",
    payload,
  })).result;
  if (route === "removeSamples") return (await target.executeMutation({
    requestId,
    route: "samples.remove",
    payload,
  })).result;
  if (route === "fillSamples") return (await target.executeMutation({
    requestId,
    route: "samples.fill",
    payload,
  })).result;
  if (route === "commitLayout") return (await target.executeMutation({
    requestId,
    route: "store.commit",
    payload: { plan: {
      intent: "layout change",
      summary: "Saved layout changes.",
      semanticOrigin: "direct",
      migration: null,
      panels: payload.layout,
      diff: [],
    } },
  })).result;
  if (route === "setSetting") return (await target.executeMutation({
    requestId, route: "setting.set", payload: { key: payload.key, value: payload.value },
  })).result;
  if (route === "deleteSetting") return (await target.executeMutation({
    requestId, route: "setting.delete", payload: { key: payload.key },
  })).result;
  return (await target.executeMutation({
    requestId,
    route: "setting.compareAndSet",
    payload: {
      key: payload.key,
      expectedRevision: payload.expectedRevision,
      value: payload.value,
    },
  })).result;
}

function serveProductionStore(target: "live" | "shadow", port: MessagePort): void {
  const endpoint = target === "shadow"
    ? pending?.shadow ? new InProcessAsyncStore(pending.shadow) : null
    : mustAuthority().asyncStore();
  if (!endpoint) throw new ClayError("E_CATALOG_UNAVAILABLE", "no shadow store is open");
  port.start?.();
  serveStore(endpoint, portFromMessagePort(port));
}

async function handle(req: Request, ports: readonly MessagePort[]): Promise<unknown> {
  enforceProductionMutationRoute(req.op);
  const p = req.payload ?? {};
  switch (req.op) {
    case "boot":
      // appId/localStorage is presentation-only. Durable selection and any
      // legacy adoption are derived by trusted worker inventory + catalog.
      return bootProductionAuthority(p);
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
    case "forkApp":
    case "deleteApp":
      return failClosedMutation(req.op);
    case "importTable":
      return runAuthorityMutation("importTable", p, req);
    case "seed":
      return runAuthorityMutation("seed", createStarterSeedBundle(p.shellId), req);
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
    case "commitLayout":
      return runAuthorityMutation("commitLayout", p, req);
    case "recordPrivateMetric":
    case "setPrivateMetricsEnabled":
    case "clearPrivateMetrics":
      return failClosedMutation(req.op);
    case "privateMetricsSummary":
      return mustStore().privateMetricsSummary();
    case "history":
      return mustStore().history();
    case "setCheckpoint":
      return failClosedMutation(req.op);
    case "panelsAt":
      return mustStore().livePanels(Number(p.version));
    case "makeLatest":
      return failClosedMutation(req.op);
    case "registryTables":
      return [...mustStore().registrySnapshot().values()];
    case "storePort": {
      const port = ports[0];
      if (!port) throw new Error("storePort needs a transferred port");
      serveProductionStore(p.target === "shadow" ? "shadow" : "live", port);
      return null;
    }
    case "intent":
    case "repairPanel":
    case "revertPanel":
    case "renamePanel":
      return failClosedMutation(req.op);
    case "addAttachment":
      return failClosedMutation(req.op);
    case "attachmentsForRecord":
      return mustStore().attachmentsForRecord(
        String(p.table), String(p.rowId), String(p.field));
    case "readAttachment":
      return mustStore().readAttachment(String(p.id));
    case "removeAttachment":
      return failClosedMutation(req.op);
    case "attachmentStorage":
      return mustStore().attachmentStorage();
    case "purgeDeletedAttachments":
      return failClosedMutation(req.op);
    case "listAutomations":
      return mustStore().listAutomations();
    case "upsertAutomation":
      return failClosedMutation(req.op);
    case "deleteAutomation":
      return failClosedMutation(req.op);
    case "simulateAutomation":
      return mustStore().simulateAutomation(String(p.id));
    case "runAutomations":
      return failClosedMutation(req.op);
    case "runAutomationNow":
      return failClosedMutation(req.op);
    case "automationRuns":
      return mustStore().automationRuns(
        p.automationId === null || p.automationId === undefined ? undefined : String(p.automationId),
        Number(p.limit ?? 100));
    case "undoAutomationRun":
      return failClosedMutation(req.op);
    case "notifications":
      return mustStore().listNotifications(Number(p.limit ?? 100));
    case "markNotificationRead":
      return failClosedMutation(req.op);
    case "globalSearch":
      return mustStore().globalSearch(String(p.term ?? ""), Number(p.limit ?? 20));
    case "applyBatch":
      return failClosedMutation(req.op);
    case "operationBatches":
      return mustStore().operationBatches(Number(p.limit ?? 50));
    case "undoBatch":
      return failClosedMutation(req.op);
    case "rowHistory":
      return mustStore().rowHistory(String(p.table), String(p.id));
    case "previewRelationConversion":
      return mustStore().previewRelationConversion({
        sourceTable: String(p.sourceTable), sourceField: String(p.sourceField),
        targetTable: String(p.targetTable), displayField: String(p.displayField),
      });
    case "convertTextToRelation":
    case "addColumn":
    case "renameColumn":
    case "removePanel":
      return failClosedMutation(req.op);
    case "keep":
      return failClosedMutation(req.op);
    case "discard":
      return failClosedMutation(req.op);
    case "removeSamples":
      return runAuthorityMutation("removeSamples", p, req);
    case "fillSamples":
      return runAuthorityMutation("fillSamples", createSampleFillBundle(mustStore()), req);
    case "sampleCount":
      return mustAuthority().sampleRowCount();
    case "restoreRow":
      return failClosedMutation(req.op);
    case "restorableRows":
      return mustStore().restorableRows(String(p.table));
    case "suggestions":
      return mustStore().suggestions();
    case "recordFilter":
      return failClosedMutation(req.op);
    case "dismissSuggestion":
      return failClosedMutation(req.op);
    case "acceptSuggestion":
      return failClosedMutation(req.op);
    case "reset":
    case "exportArchive":
    case "importArchive":
      return failClosedMutation(req.op);
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
      return runAuthorityMutation("setSetting", p, req);
    case "deleteSetting":
      return runAuthorityMutation("deleteSetting", p, req);
    case "compareAndSetSetting":
      return runAuthorityMutation("compareAndSetSetting", p, req);
    default:
      throw new ClayError("E_CATALOG_UNAVAILABLE", `unclassified worker route '${req.op}'`);
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
        error: {
          code: e instanceof ClayError ? e.code : "E_INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  })();
};
