// The DB worker (doc 02 §1/§3): exclusively owns SQLite over OPFS and hosts
// the trusted kernel — ClayStore, Validator, and the MutationPipeline all
// run here. The main thread gets: a command protocol (below) plus
// serveStore RPC ports for the Bridge's AsyncStore (live and shadow).
// Records never leave this worker except over those ports to the Bridge.
import type {
  DebugEvent, LivePanel, PanelProvenance,
  PreparedMutationCommand, PreparedMutationPreview,
} from "@clay/kernel";
import { portFromMessagePort, serveStore } from "@clay/kernel/worker-rpc";
import { ClayError } from "@clay/kernel/errors";
import type {
  ProductionStoreAuthority,
  ProductionStoreReader,
} from "@clay/kernel/worker-authority";
import { createStarterSeedBundle } from "../shells/seed";
import { sampleRowCount } from "./samples";
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
  payload?: unknown;
};


let authority: ProductionStoreAuthority | null = null;
let authorityBoot: Promise<ProductionStoreAuthority> | null = null;
let store: ProductionStoreReader | null = null;
let persistent = false;
type PendingPreview = {
  preview: PreparedMutationPreview;
  decision: "open" | "keeping" | "discarding";
};
type SettledDecision =
  | { kind: "keep"; requestId: string; command: PreparedMutationCommand; version: number }
  | { kind: "discard"; requestId: string; command: PreparedMutationCommand };
let pending: PendingPreview | null = null;
let settledDecision: SettledDecision | null = null;
let pipelineRun: Promise<IntentOutcome> | null = null;
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
    const { ProductionStoreAuthority } = await import("@clay/kernel/worker-authority");
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

const DIRECT_AUTHORITY_ROUTES = Object.freeze({
  setCheckpoint: { route: "timeline.setCheckpoint" },
  makeLatest: { route: "timeline.makeLatest" },
  revertPanel: { route: "panel.revert" },
  renamePanel: { route: "panel.rename" },
  removePanel: { route: "panel.remove" },
  addColumn: { route: "schema.addColumn" },
  addRelationColumn: { route: "schema.addRelationColumn" },
  renameColumn: { route: "schema.renameColumn" },
  setSetting: { route: "setting.set" },
  deleteSetting: { route: "setting.delete" },
  compareAndSetSetting: { route: "setting.compareAndSet" },
} as const);

type DirectAuthorityRoute = keyof typeof DIRECT_AUTHORITY_ROUTES;

async function runAuthorityMutation(
  route:
    | "seed" | "setSetting" | "deleteSetting" | "compareAndSetSetting" | "commitLayout"
    | "addAttachment" | "removeAttachment" | "purgeDeletedAttachments"
    | "applyBatch" | "undoBatch" | "restoreRow" | "removeColumn"
    | "upsertAutomation" | "deleteAutomation" | "runAutomations" | "runAutomationNow"
    | "undoAutomationRun" | "markNotificationRead" | "recordPrivateMetric"
    | "setPrivateMetricsEnabled" | "clearPrivateMetrics" | "recordFilter"
    | "acceptSuggestion" | "dismissSuggestion"
    | "setCheckpoint" | "makeLatest" | "revertPanel" | "renamePanel" | "removePanel"
    | "addColumn" | "addRelationColumn" | "renameColumn",
  payload: unknown,
  req: Request,
): Promise<unknown> {
  const target = mustAuthority();
  const requestId = authorityRequestId(req);
  if (route === "seed") return (await target.executeMutation({
    requestId, route: "starter.seed", payload,
  })).result;
  if (route === "commitLayout") return (await target.executeMutation({
    requestId,
    route: "store.commit",
    payload: { plan: {
      intent: "layout change",
      summary: "Saved layout changes.",
      semanticOrigin: "direct",
      migration: null,
      panels: (payload as Record<string, unknown>).layout,
      diff: [],
    } },
  })).result;
  if (route === "addAttachment") return (await target.executeMutation({
    requestId, route: "attachment.add", payload,
  })).result;
  if (route === "removeAttachment") return (await target.executeMutation({
    requestId, route: "attachment.remove", payload,
  })).result;
  if (route === "purgeDeletedAttachments") return (await target.executeMutation({
    requestId, route: "attachment.purge", payload,
  })).result;
  if (route === "applyBatch") return (await target.executeMutation({
    requestId, route: "batch.apply", payload,
  })).result;
  if (route === "undoBatch") return (await target.executeMutation({
    requestId, route: "batch.undo", payload,
  })).result;
  if (route === "restoreRow") return (await target.executeMutation({
    requestId, route: "row.restore", payload,
  })).result;
  if (route === "removeColumn") return (await target.executeMutation({
    requestId, route: "schema.removeColumn", payload,
  })).result;

  const authorityRoute = DIRECT_AUTHORITY_ROUTES[route as DirectAuthorityRoute];
  if (authorityRoute) return (await target.executeMutation({
    requestId,
    route: authorityRoute.route,
    payload,
  })).result;

  if (route === "runAutomations") return (await target.executeMutation({
    requestId, route: "runDueAutomations", payload: {},
  })).result;
  const fields = payload as Record<string, unknown>;
  if (route === "recordFilter") {
    const detail = fields.payload;
    const event = typeof detail === "object" && detail !== null && !Array.isArray(detail)
      ? { kind: "filter", subject: fields.name, detail }
      : { kind: "filter", subject: fields.name };
    return (await target.executeMutation({ requestId, route: "recordUsage", payload: { event } })).result;
  }
  if (route === "clearPrivateMetrics") return (await target.executeOperationalMetricMutation({
    requestId, route, payload: {},
  })).result;
  if (route === "upsertAutomation") return (await target.executeMutation({
    requestId, route, payload: { input: fields.input },
  })).result;
  if (route === "setPrivateMetricsEnabled") return (await target.executeOperationalMetricMutation({
    requestId, route, payload: { enabled: fields.enabled },
  })).result;
  if (route === "recordPrivateMetric") return (await target.executeOperationalMetricMutation({
    requestId, route, payload: { event: fields.event },
  })).result;
  if (route === "acceptSuggestion" || route === "dismissSuggestion")
    return (await target.executeMutation({
      requestId, route, payload: { subject: fields.subject, kind: fields.kind },
    })).result;
  return (await target.executeMutation({
    requestId, route, payload: { id: fields.id },
  })).result;
}

async function executePipelineText(text: string): Promise<IntentOutcome> {
  if (pending)
    throw new ClayError("E_CONFLICT", "Finish the current preview before reshaping again");
  if (!text.trim() || text.length > 500)
    throw new ClayError("E_VALIDATION", "reshape intent must be 1–500 characters");
  const apiKey = modelAccess.apiKey;
  const endpoint = modelAccess.backendUrl;
  if (!apiKey && !endpoint) {
    return {
      status: "failed",
      stage: "plan",
      reasons: ["No model connection. Add an API key or connect a backend in Settings."],
      repaired: false,
    };
  }

  // The planner and prompt corpus stay outside the worker's boot closure.
  // Vite emits this cold reshaping path as separate worker chunks.
  const [{ MutationPipeline }, { MutationClient }] = await Promise.all([
    import("@clay/kernel/planner-pipeline"),
    import("@clay/mutation/client"),
  ]);
  const transport = apiKey
    ? { mode: "byo" as const, apiKey }
    : {
      mode: "hosted" as const,
      endpoint: (() => {
        if (!endpoint) throw new ClayError("E_INTERNAL", "model endpoint disappeared");
        return endpoint;
      })(),
      ...(modelAccess.session ? { session: modelAccess.session } : {}),
    };
  const client = new MutationClient(transport, { modelRepair: true });
  const events: DebugEvent[] = [];
  const result = await new MutationPipeline(
    mustAuthority().plannerMutations(),
    client,
    { onDebug: event => events.push(event) },
  ).run(text);
  recordTrace({ at: new Date().toISOString(), intent: text, events });

  if (result.status === "clarify") {
    return {
      status: "clarify",
      question: result.question,
      repaired: result.repaired,
    };
  }
  if (result.status === "failed") {
    return {
      status: "failed",
      stage: result.stage,
      reasons: result.reasons,
      repaired: result.repaired,
    };
  }
  pending = { preview: result.preview, decision: "open" };
  settledDecision = null;
  return {
    status: "preview",
    preview: {
      summary: result.preview.plan.summary,
      diff: result.preview.plan.user_facing_diff,
      panels: result.preview.plan.panels.map(panel => ({
        panel_id: panel.panel_id,
        version: result.preview.version,
        title: panel.title,
        placement: panel.placement,
        code: panel.code,
        declared_queries: panel.declared_queries,
        declared_writes: panel.declared_writes,
      })),
      removePanels: result.preview.plan.remove_panels,
      version: result.preview.version,
      repaired: result.repaired,
    },
  };
}

async function runPipelineText(text: string): Promise<IntentOutcome> {
  if (pipelineRun)
    throw new ClayError("E_CONFLICT", "A reshape is already being prepared");
  const current = executePipelineText(text);
  pipelineRun = current;
  try {
    return await current;
  } finally {
    if (pipelineRun === current) pipelineRun = null;
  }
}

function openPendingPreview(decision: "keeping" | "discarding"): PendingPreview {
  const current = pending;
  if (!current) throw new ClayError("E_CONFLICT", "no preview is open");
  if (current.decision !== "open")
    throw new ClayError("E_CONFLICT", "a preview decision is already in progress");
  current.decision = decision;
  return current;
}

async function keepPendingPreview(req: Request): Promise<{ version: number }> {
  const planner = mustAuthority().plannerMutations();
  if (!pending && req.requestId && settledDecision?.kind === "keep"
      && settledDecision.requestId === req.requestId) {
    const version = await planner.keep(req.requestId, settledDecision.command);
    return { version };
  }
  const current = openPendingPreview("keeping");
  const requestId = authorityRequestId(req);
  try {
    const version = await planner.keep(requestId, current.preview.command);
    current.preview.shadow.close();
    if (pending === current) pending = null;
    settledDecision = {
      kind: "keep", requestId, command: current.preview.command, version,
    };
    try {
      if (typeof navigator !== "undefined" && navigator.storage?.persist)
        persistent = await navigator.storage.persist();
    } catch { /* persistence request is best-effort */ }
    return { version };
  } catch (error) {
    if (pending === current) current.decision = "open";
    throw error;
  }
}

async function discardPendingPreview(req: Request): Promise<null> {
  const planner = mustAuthority().plannerMutations();
  if (!pending && req.requestId && settledDecision?.kind === "discard"
      && settledDecision.requestId === req.requestId) {
    await planner.discard(req.requestId, settledDecision.command);
    return null;
  }
  const current = openPendingPreview("discarding");
  const requestId = authorityRequestId(req);
  try {
    await planner.discard(requestId, current.preview.command);
    settledDecision = {
      kind: "discard", requestId, command: current.preview.command,
    };
    current.preview.shadow.close();
    if (pending === current) pending = null;
    return null;
  } catch (error) {
    if (pending === current) current.decision = "open";
    throw error;
  }
}

function serveProductionStore(target: "live" | "shadow", port: MessagePort): void {
  const endpoint = target === "shadow"
    ? pending?.preview.shadow.asyncStore() ?? null
    : mustAuthority().asyncStore();
  if (!endpoint) throw new ClayError("E_CATALOG_UNAVAILABLE", "no shadow store is open");
  port.start?.();
  serveStore(endpoint, portFromMessagePort(port));
}

async function handle(req: Request, ports: readonly MessagePort[]): Promise<unknown> {
  enforceProductionMutationRoute(req.op);
  const payloadDescriptor = Reflect.getOwnPropertyDescriptor(req, "payload");
  const rawPayload = payloadDescriptor && "value" in payloadDescriptor
    ? payloadDescriptor.value : undefined;
  const p = (rawPayload ?? {}) as Record<string, unknown>;
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
    case "importTable":
      return failClosedMutation(req.op);
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
      return runAuthorityMutation("recordPrivateMetric", p, req);
    case "setPrivateMetricsEnabled":
      return runAuthorityMutation("setPrivateMetricsEnabled", p, req);
    case "clearPrivateMetrics":
      return runAuthorityMutation("clearPrivateMetrics", p, req);
    case "privateMetricsSummary":
      return mustStore().privateMetricsSummary();
    case "history":
      return mustStore().history();
    case "setCheckpoint":
      return runAuthorityMutation("setCheckpoint", rawPayload, req);
    case "panelsAt":
      return mustStore().livePanels(Number(p.version));
    case "makeLatest":
      return runAuthorityMutation("makeLatest", rawPayload, req);
    case "registryTables":
      return [...mustStore().registrySnapshot().values()];
    case "storePort": {
      const port = ports[0];
      if (!port) throw new Error("storePort needs a transferred port");
      serveProductionStore(p.target === "shadow" ? "shadow" : "live", port);
      return null;
    }
    case "intent":
      return runPipelineText(String(p.text ?? ""));
    case "repairPanel": {
      const panelId = String(p.panelId ?? "");
      const panel = mustStore().livePanels().find(candidate => candidate.panel_id === panelId);
      if (!panel) throw new ClayError("E_VALIDATION", `unknown panel '${panelId}'`);
      const error = String(p.error ?? "").slice(0, 300);
      return runPipelineText(
        `Repair panel "${panel.title}" (${panel.panel_id}) after this runtime error: ${error}`
          .slice(0, 500),
      );
    }
    case "revertPanel":
      return runAuthorityMutation("revertPanel", rawPayload, req);
    case "renamePanel":
      return runAuthorityMutation("renamePanel", rawPayload, req);
    case "addAttachment":
      return runAuthorityMutation("addAttachment", p, req);
    case "attachmentsForRecord":
      return mustStore().attachmentsForRecord(
        String(p.table), String(p.rowId), String(p.field));
    case "readAttachment":
      return mustStore().readAttachment(String(p.id));
    case "removeAttachment":
      return runAuthorityMutation("removeAttachment", p, req);
    case "attachmentStorage":
      return mustStore().attachmentStorage();
    case "purgeDeletedAttachments":
      return runAuthorityMutation("purgeDeletedAttachments", p, req);
    case "listAutomations":
      return mustStore().listAutomations();
    case "upsertAutomation":
      return runAuthorityMutation("upsertAutomation", p, req);
    case "deleteAutomation":
      return runAuthorityMutation("deleteAutomation", p, req);
    case "simulateAutomation":
      return mustStore().simulateAutomation(String(p.id));
    case "runAutomations":
      return runAuthorityMutation("runAutomations", p, req);
    case "runAutomationNow":
      return runAuthorityMutation("runAutomationNow", p, req);
    case "automationRuns":
      return mustStore().automationRuns(
        p.automationId === null || p.automationId === undefined ? undefined : String(p.automationId),
        Number(p.limit ?? 100));
    case "undoAutomationRun":
      return runAuthorityMutation("undoAutomationRun", p, req);
    case "notifications":
      return mustStore().listNotifications(Number(p.limit ?? 100));
    case "markNotificationRead":
      return runAuthorityMutation("markNotificationRead", p, req);
    case "globalSearch":
      return mustStore().globalSearch(String(p.term ?? ""), Number(p.limit ?? 20));
    case "applyBatch":
      return runAuthorityMutation("applyBatch", p, req);
    case "operationBatches":
      return mustStore().operationBatches(Number(p.limit ?? 50));
    case "undoBatch":
      return runAuthorityMutation("undoBatch", p, req);
    case "rowHistory":
      return mustStore().rowHistory(String(p.table), String(p.id));
    case "previewRelationConversion":
      return mustStore().previewRelationConversion({
        sourceTable: String(p.sourceTable), sourceField: String(p.sourceField),
        targetTable: String(p.targetTable), displayField: String(p.displayField),
      });
    case "convertTextToRelation":
      return failClosedMutation(req.op);
    case "removeColumn":
      return runAuthorityMutation("removeColumn", p, req);
    case "addColumn":
      return runAuthorityMutation("addColumn", rawPayload, req);
    case "addRelationColumn":
      return runAuthorityMutation("addRelationColumn", rawPayload, req);
    case "renameColumn":
      return runAuthorityMutation("renameColumn", rawPayload, req);
    case "removePanel":
      return runAuthorityMutation("removePanel", rawPayload, req);
    case "keep":
      return keepPendingPreview(req);
    case "discard":
      return discardPendingPreview(req);
    case "removeSamples":
      return failClosedMutation(req.op);
    case "fillSamples":
      return failClosedMutation(req.op);
    case "sampleCount":
      return sampleRowCount(mustStore());
    case "restoreRow":
      return runAuthorityMutation("restoreRow", p, req);
    case "restorableRows":
      return mustStore().restorableRows(String(p.table));
    case "suggestions":
      return mustStore().suggestions();
    case "recordFilter":
      return runAuthorityMutation("recordFilter", p, req);
    case "dismissSuggestion":
      return runAuthorityMutation("dismissSuggestion", p, req);
    case "acceptSuggestion":
      return runAuthorityMutation("acceptSuggestion", p, req);
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
      return runAuthorityMutation("setSetting", rawPayload, req);
    case "deleteSetting":
      return runAuthorityMutation("deleteSetting", rawPayload, req);
    case "compareAndSetSetting":
      return runAuthorityMutation("compareAndSetSetting", rawPayload, req);
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
